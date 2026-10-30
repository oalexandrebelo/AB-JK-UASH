import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createApplication} from '../../server/application.mjs';
import {probeRuntime} from '../../scripts/jk-runtime-probe.mjs';
import {oficinaCompose} from '../../scripts/jk-oficina-compose.mjs';

function probeCli(args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../scripts/jk-runtime-probe.mjs', import.meta.url)), ...args], {stdio: ['ignore', 'pipe', 'pipe'], shell: false});
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', value => {stdout += value;});
    child.stderr.on('data', value => {stderr += value;});
    child.once('error', reject);
    child.once('close', code => resolveResult({code, stdout, stderr}));
  });
}

test('runtime probe verifies HTTP, private routes and Host policy without creating users', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'jk-runtime-probe-'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><html><body>Fixture</body></html>');
  const publicOrigin = 'https://probe.example.invalid';
  const app = await createApplication({dbPath: join(dir, 'db.sqlite'), distDir: dir, publicOrigin, setupToken: 'p'.repeat(64), fiscalEnv: {}, jkIntegrationsEnv: {}});
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true}); });
  const {port} = await app.listen({port: 0});
  const result = await probeRuntime({port, publicOrigin});
  assert.equal(result.ok, true);
  assert.equal(result.setupRequired, true);
  assert.equal(result.setupTokenRequired, true);
  assert.equal(result.authenticationEnforced, true);
  assert.equal(result.hostEnforced, true);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 0);
  assert.equal(JSON.stringify(result).includes('p'.repeat(64)), false);
  await assert.rejects(probeRuntime({port, publicOrigin: 'https://wrong.example.invalid'}), /HTTP 403/u);
  await rm(join(dir, 'index.html'));
  await assert.rejects(probeRuntime({port, publicOrigin}), /HTTP 503/u);
});

test('deployment generator pins public source and preserves runtime isolation without private mounts for verification', async () => {
  const base = await readFile(new URL('../../compose.yaml', import.meta.url), 'utf8');
  const sha = '1234567890abcdef1234567890abcdef12345678';
  const generated = oficinaCompose(base, sha);
  assert.ok(generated.includes(`context: https://github.com/oalexandrebelo/AB-JK-UASH.git#${sha}`));
  assert.ok(generated.includes('"127.0.0.1:${AB_PORTA:-9220}:4173"'));
  assert.ok(generated.includes('source: ../dados'));
  assert.ok(generated.includes('network_mode: none'));
  const verification = generated.split('\n  verification:')[1];
  assert.ok(verification.includes('condition: service_healthy'));
  assert.ok(verification.includes('restart: "no"'));
  assert.ok(!verification.includes('volumes:'));
  assert.ok(!verification.includes('ports:'));
  for (const invalid of ['main', '1234567', `${sha}; command`, `https://other.invalid/${sha}`]) assert.throws(() => oficinaCompose(base, invalid));
  assert.throws(() => oficinaCompose(base.replace('    context: .\n', '    context: other\n'), sha));
});

test('probe API and CLI never disclose malformed response bodies or supplied credentials', async t => {
  const confidential = 'SYNTHETIC_CONFIDENTIAL_BODY_20261030';
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.host === 'invalid.ab-jk.invalid') {
      res.writeHead(403); res.end(JSON.stringify({ok: false, error: {code: 'HOST_REJECTED'}}));
    } else if (req.url.startsWith('/api/customers')) {
      res.writeHead(401); res.end(JSON.stringify({ok: false, error: {code: 'AUTH_REQUIRED'}}));
    } else if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Content-Security-Policy', "default-src 'self'"); res.end();
    } else if (req.url === '/api/ready') res.end(JSON.stringify({ok: true, data: {status: 'ready', database: 'ok'}}));
    else res.end(confidential);
  });
  await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
  t.after(() => new Promise(resolveClosed => server.close(resolveClosed)));
  const {port} = server.address();
  await assert.rejects(probeRuntime({port}), error => {
    assert.equal(error.message, 'Verificação /api/status: resposta JSON inválida.');
    assert.ok(!error.message.includes(confidential)); return true;
  });
  const malformed = await probeCli(['--port', String(port)]);
  assert.equal(malformed.code, 1); assert.equal(malformed.stdout, '');
  assert.equal(JSON.parse(malformed.stderr).message, 'Verificação /api/status: resposta JSON inválida.');
  assert.ok(!malformed.stderr.includes(confidential));
  const credential = 'synthetic-private-password-20261030';
  for (const args of [
    ['--origin', `https://synthetic-user:${credential}@probe.example.invalid`],
    ['--origin', `invalid-url-${credential}`],
    [`--unknown-${credential}`],
  ]) {
    const invalid = await probeCli(args);
    assert.equal(invalid.code, 1); assert.equal(invalid.stdout, '');
    assert.equal(JSON.parse(invalid.stderr).ok, false);
    assert.ok(!invalid.stderr.includes(credential));
    assert.ok(!invalid.stderr.includes('synthetic-user'));
  }
});
