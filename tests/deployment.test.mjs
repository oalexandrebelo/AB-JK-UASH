import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, stat, chmod, symlink, cp, rm, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {request as httpRequest} from 'node:http';
import {createApplication} from '../server/application.mjs';
import {createSetupToken, readSetupToken} from '../scripts/bootstrap-token.mjs';
import {startupConfiguration} from '../scripts/start.mjs';
import {checkHealth} from '../scripts/healthcheck.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const publicOrigin = 'https://ab-srv.tail6bac78.ts.net:8455';

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ab-uash-deploy-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return directory;
}

function requestApi(base, path, {headers, body, method = 'GET'}) {
  return new Promise((resolveResponse, reject) => {
    const request = httpRequest(`${base}${path}`, {method, headers}, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => {
        try { resolveResponse({status: response.statusCode, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8'))}); }
        catch (error) { reject(error); }
      });
    });
    request.once('error', reject);
    request.end(body);
  });
}

test('bootstrap creates one private CSPRNG token, preserves it, and never prints it', async t => {
  const directory = await temporary(t), path = join(directory, 'setup-token');
  const first = await createSetupToken(path);
  assert.deepEqual(first, {path, created: true});
  const token = await readSetupToken({setupTokenFile: path});
  assert.match(token, /^[A-Za-z0-9_-]{64}$/u);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o7777, 0o600);
  const second = await createSetupToken(path);
  assert.deepEqual(second, {path, created: false});
  assert.equal(await readSetupToken({setupTokenFile: path}), token);
  const result = await execute(process.execPath, [join(root, 'scripts/bootstrap-token.mjs'), '--file', path]);
  assert.match(result.stdout, /preservado/u);
  assert.ok(!(result.stdout + result.stderr + JSON.stringify(first)).includes(token));
  assert.equal(await readSetupToken({setupTokenFile: path}), token);
  const another = join(directory, 'another-token');
  const created = await execute(process.execPath, [join(root, 'scripts/bootstrap-token.mjs'), '--file', another]);
  const anotherToken = await readSetupToken({setupTokenFile: another});
  assert.notEqual(anotherToken, token);
  assert.ok(!(created.stdout + created.stderr).includes(anotherToken));
});

test('bootstrap rejects ambiguous, unsafe and malformed secret files without replacing them', async t => {
  const directory = await temporary(t), path = join(directory, 'setup-token');
  await createSetupToken(path);
  const original = await readFile(path, 'utf8');
  await assert.rejects(readSetupToken({setupToken: original.trim(), setupTokenFile: path}), /somente/u);
  await assert.rejects(readSetupToken({setupToken: 'invalid-secret-value'}), /32 a 256/u);
  if (process.platform !== 'win32') {
    await chmod(path, 0o644);
    await assert.rejects(createSetupToken(path), /0600/u);
    assert.equal(await readFile(path, 'utf8'), original);
    await chmod(path, 0o600);
    const link = join(directory, 'linked-token');
    await symlink(path, link);
    await assert.rejects(readSetupToken({setupTokenFile: link}));
    await assert.rejects(createSetupToken(link));
  }
  await assert.rejects(readSetupToken({setupTokenFile: directory}), /arquivo regular/u);
  await writeFile(path, 'not a valid token\n');
  await assert.rejects(createSetupToken(path));
  assert.equal(await readFile(path, 'utf8'), 'not a valid token\n');
  await assert.rejects(createSetupToken(join(directory, 'missing', 'setup-token')), {code: 'ENOENT'});
});

test('network launch requires an exact public origin and an explicit bootstrap-secret source', async t => {
  const directory = await temporary(t);
  await assert.rejects(startupConfiguration({HOST: '0.0.0.0'}, directory), /PUBLIC_ORIGIN/u);
  await assert.rejects(startupConfiguration({HOST: '0.0.0.0', PUBLIC_ORIGIN: publicOrigin}, directory), /SETUP_TOKEN_FILE/u);
  await assert.rejects(startupConfiguration({HOST: '::', PUBLIC_ORIGIN: publicOrigin}, directory), /SETUP_TOKEN_FILE/u);
  await assert.rejects(startupConfiguration({HOST: '0.0.0.0', PUBLIC_ORIGIN: 'https://bad.example/path', SETUP_TOKEN_FILE: join(directory, 'never-created')}, directory));
  await assert.rejects(access(join(directory, 'never-created')));
  await assert.rejects(access(join(directory, 'data')));
  const local = await startupConfiguration({}, directory);
  assert.equal(local.host, '127.0.0.1');
  assert.equal(local.options.setupToken, undefined);
  assert.equal(local.options.publicOrigin, undefined);
  const path = join(directory, 'setup-token');
  const remote = await startupConfiguration({HOST: '0.0.0.0', PUBLIC_ORIGIN: publicOrigin, SETUP_TOKEN_FILE: path, COOKIE_SECURE: 'true'}, directory);
  assert.equal(remote.options.setupToken, await readSetupToken({setupTokenFile: path}));
  assert.deepEqual(remote.options.publicOrigin, [publicOrigin]);
  assert.equal(remote.options.secureCookies, true);
  assert.equal((await startupConfiguration({HOST: '0.0.0.0', PUBLIC_ORIGIN: publicOrigin, SETUP_TOKEN_FILE: path}, directory)).options.setupToken, remote.options.setupToken);
});

test('healthcheck reaches the configured origin locally and checks API, database status and frontend', async t => {
  const directory = await temporary(t), distDir = join(directory, 'dist');
  await mkdir(distDir);
  await writeFile(join(distDir, 'index.html'), '<!doctype html><html><body>AB-UASH</body></html>');
  const tokenPath = join(directory, 'setup-token');
  const {options} = await startupConfiguration({HOST: '0.0.0.0', PUBLIC_ORIGIN: publicOrigin, SETUP_TOKEN_FILE: tokenPath, DB_PATH: join(directory, 'app.sqlite'), DIST_DIR: distDir, COOKIE_SECURE: 'true'}, directory);
  const app = await createApplication({...options, fiscalEnv: {}});
  t.after(() => app.close());
  const address = await app.listen({port: 0, host: '127.0.0.1'});
  assert.equal(await checkHealth({port: address.port, publicOrigin}), true);
  const base = `http://127.0.0.1:${address.port}`;
  const headers = {Host: new URL(publicOrigin).host, Origin: publicOrigin, 'Content-Type': 'application/json'};
  const status = await requestApi(base, '/api/status', {headers});
  assert.equal(status.status, 200);
  assert.equal(status.body.data.setupTokenRequired, true);
  const body = JSON.stringify({name: 'Admin de implantação', email: 'deployment@example.invalid', password: 'Deployment-fixture-2026'});
  const denied = await requestApi(base, '/api/setup', {method: 'POST', headers, body});
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'SETUP_TOKEN_REQUIRED');
  const setup = await requestApi(base, '/api/setup', {method: 'POST', headers: {...headers, 'X-Setup-Token': options.setupToken}, body});
  assert.equal(setup.status, 201);
  assert.match(setup.headers['set-cookie'][0], /; Secure/u);
  assert.equal(setup.body.data.setupTokenRequired, false);
  assert.equal(await checkHealth({port: address.port, publicOrigin}), true);
  await assert.rejects(checkHealth({port: address.port, publicOrigin: 'https://untrusted.example'}));
  await rm(join(distDir, 'index.html'));
  await assert.rejects(checkHealth({port: address.port, publicOrigin}));
});

test('launcher prefers its runtime, then NODE_BIN, then an installed Node 24 without downloading', {skip: process.platform === 'win32'}, async t => {
  const directory = await temporary(t);
  await cp(join(root, 'start.sh'), join(directory, 'start.sh'));
  const platform = {linux: 'linux', darwin: 'darwin'}[process.platform];
  const architecture = {x64: 'x64', arm64: 'arm64'}[process.arch];
  if (!platform || !architecture) return t.skip('A seleção de runtime desta prova requer Linux/macOS x64/arm64.');
  const runtime = join(directory, 'runtime', `${platform}-${architecture}`, 'node');
  const explicit = join(directory, 'explicit-node');
  const bin = join(directory, 'bin');
  await mkdir(join(directory, 'runtime', `${platform}-${architecture}`), {recursive: true});
  await mkdir(bin);
  const fake = async (path, version, label) => {
    await writeFile(path, `#!/bin/sh\nif [ "$1" = "-p" ]; then printf '%s\\n' '${version}'; else printf '%s\\n' '${label}'; fi\n`, {mode: 0o755});
  };
  await fake(runtime, 24, 'bundled');
  await fake(explicit, 24, 'explicit');
  await fake(join(bin, 'node24'), 24, 'installed-24');
  await fake(join(bin, 'node'), 25, 'unsupported-25');
  const env = {PATH: `${bin}:/usr/bin:/bin`, NODE_BIN: explicit};
  const launch = overrides => execute('/bin/sh', [join(directory, 'start.sh'), '--version'], {env: {...env, ...overrides}});
  assert.equal((await launch()).stdout.trim(), 'bundled');
  await rm(runtime);
  assert.equal((await launch()).stdout.trim(), 'explicit');
  assert.equal((await launch({NODE_BIN: ''})).stdout.trim(), 'installed-24');
  await fake(explicit, 25, 'unsupported-explicit');
  await assert.rejects(launch(), error => error.code === 1 && /NODE_BIN/u.test(error.stderr));
});
