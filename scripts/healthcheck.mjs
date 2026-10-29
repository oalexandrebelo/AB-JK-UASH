import {request} from 'node:http';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

function get(path, {port, origin, maxBytes = 16_384, method = 'GET'}) {
  return new Promise((resolveResponse, reject) => {
    const req = request({hostname: '127.0.0.1', port, path, method, headers: {Host: new URL(origin).host, Origin: origin}, timeout: 3_000}, response => {
      let bytes = 0;
      const chunks = [];
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) response.destroy(new Error('Resposta de saúde inválida.'));
        else chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('end', () => {
        if (response.statusCode !== 200) return reject(new Error('O serviço não está pronto.'));
        resolveResponse({body: Buffer.concat(chunks).toString('utf8'), headers: response.headers});
      });
    });
    req.once('timeout', () => req.destroy(new Error('O serviço não respondeu no prazo.')));
    req.once('error', reject);
    req.end();
  });
}

/** Checks the API, database-backed setup status, and built frontend locally. */
export async function checkHealth({port = Number(process.env.PORT || 4173), publicOrigin = process.env.PUBLIC_ORIGIN} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Porta de saúde inválida.');
  const origin = new URL(publicOrigin?.split(',')[0]?.trim() || `http://127.0.0.1:${port}`).origin;
  const [health, status, page] = await Promise.all([
    get('/api/health', {port, origin}),
    get('/api/status', {port, origin}),
    get('/', {port, origin, method: 'HEAD'}),
  ]);
  const healthBody = JSON.parse(health.body), statusBody = JSON.parse(status.body);
  if (healthBody.ok !== true || healthBody.data?.status !== 'ok' || statusBody.ok !== true || typeof statusBody.data?.setupRequired !== 'boolean' || !['local', 'postgres'].includes(statusBody.data?.storageMode) || !/^text\/html(?:;|$)/u.test(page.headers['content-type'] || '')) {
    throw new Error('A interface ou a API não está pronta.');
  }
  return true;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try { await checkHealth(); }
  catch { console.error('AB-UASH: verificação de saúde falhou.'); process.exitCode = 1; }
}
