import {request} from 'node:http';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

const HOSTS = new Set(['127.0.0.1', 'localhost', '::1', 'app']);
class ProbeError extends Error {}
const failure = message => new ProbeError(message);

function parseResponse(response, path) {
  try {
    const value = JSON.parse(response.body);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    // JSON.parse SyntaxErrors can contain fragments of the input. Never let
    // that exception cross the probe boundary or reach deployment logs.
    throw failure(`Verificação ${path}: resposta JSON inválida.`);
  }
}

function readRoute({hostname, port, origin, path, method = 'GET', expected = 200, rejectedHost = false}) {
  return new Promise((resolveResult, reject) => {
    const headers = {Host: rejectedHost ? 'invalid.ab-jk.invalid' : new URL(origin).host, Origin: origin};
    let timer;
    const req = request({hostname, port, path, method, headers}, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 64 * 1024) response.destroy(failure(`Verificação ${path}: resposta excedeu 64 KiB.`));
        else chunks.push(chunk);
      });
      response.once('error', fail);
      response.once('end', () => {
        clearTimeout(timer);
        if (response.statusCode !== expected) return reject(failure(`Verificação ${path}: HTTP ${response.statusCode}, esperado ${expected}.`));
        resolveResult({headers: response.headers, body: Buffer.concat(chunks).toString('utf8')});
      });
    });
    function fail(error) {
      clearTimeout(timer);
      reject(error instanceof ProbeError ? error : failure(`Verificação ${path}: não foi possível obter a resposta HTTP.`));
    }
    timer = setTimeout(() => req.destroy(failure(`Verificação ${path}: tempo excedido.`)), 3000);
    req.once('error', fail);
    req.end();
  });
}

/** Anonymous, read-only checks. Never reads tokens, credentials or business rows. */
export async function probeRuntime({hostname = '127.0.0.1', port = 4173, publicOrigin} = {}) {
  if (!HOSTS.has(hostname) || !Number.isInteger(port) || port < 1 || port > 65535) throw failure('Destino local da verificação inválido.');
  let url;
  try { url = new URL(publicOrigin || `http://127.0.0.1:${port}`); }
  catch { throw failure('Origem da verificação inválida.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw failure('Origem da verificação inválida.');
  const base = {hostname, port, origin: url.origin};
  const [ready, status, page, protectedRoute, hostRejected] = await Promise.all([
    readRoute({...base, path: '/api/ready'}),
    readRoute({...base, path: '/api/status'}),
    readRoute({...base, path: '/', method: 'HEAD'}),
    readRoute({...base, path: '/api/customers?limit=1', expected: 401}),
    readRoute({...base, path: '/api/ready', expected: 403, rejectedHost: true}),
  ]);
  const health = parseResponse(ready, '/api/ready'), session = parseResponse(status, '/api/status');
  const denied = parseResponse(protectedRoute, '/api/customers?limit=1'), host = parseResponse(hostRejected, '/api/ready');
  if (health.ok !== true || health.data?.status !== 'ready' || health.data.database !== 'ok') throw failure('Banco ou API não confirmou prontidão.');
  if (session.ok !== true || session.data?.user !== null || typeof session.data.setupRequired !== 'boolean' || typeof session.data.setupTokenRequired !== 'boolean' || !['local', 'postgres'].includes(session.data.storageMode)) throw failure('Estado anônimo da instalação inválido.');
  if (!/^text\/html(?:;|$)/u.test(page.headers['content-type'] || '') || page.headers['x-frame-options'] !== 'DENY' || !page.headers['content-security-policy']) throw failure('Interface ou headers de proteção ausentes.');
  if (denied.error?.code !== 'AUTH_REQUIRED' || host.error?.code !== 'HOST_REJECTED') throw failure('Controle de acesso não confirmado.');
  return {
    ok: true, operation: 'runtime_readonly_probe', api: 'ready', database: 'ok', frontend: 'html',
    authenticationEnforced: true, hostEnforced: true, storageMode: session.data.storageMode,
    setupRequired: session.data.setupRequired, setupTokenRequired: session.data.setupTokenRequired,
    scope: 'container-network; external HTTPS, real login and providers are not tested',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const {values, positionals} = parseArgs({options: {hostname: {type: 'string'}, port: {type: 'string'}, origin: {type: 'string'}}, allowPositionals: true});
    if (positionals.length) throw failure('Use --hostname, --port e --origin.');
    const result = await probeRuntime({hostname: values.hostname, port: values.port === undefined ? undefined : Number(values.port), publicOrigin: values.origin || process.env.PUBLIC_ORIGIN});
    console.log(JSON.stringify(result));
  } catch (error) {
    // Only errors constructed from fixed probe diagnostics may be printed.
    // Parser, CLI and transport exceptions can contain inputs or other details.
    const message = error instanceof ProbeError ? error.message : 'Não foi possível executar a verificação. Confira --hostname, --port e --origin.';
    console.error(JSON.stringify({ok: false, operation: 'runtime_readonly_probe', message}));
    process.exitCode = 1;
  }
}
