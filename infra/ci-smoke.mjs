import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes, randomUUID} from 'node:crypto';
import {chown, lstat, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {basename, join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const runnerTemp = resolve(process.env.RUNNER_TEMP || tmpdir());
const stateFile = resolve(process.env.JK_CI_SMOKE_STATE || join(runnerTemp, 'ab-jk-ci-smoke-state.json'));
const email = 'release-smoke@example.invalid';

function execute(program, args, {capture = false, input, env = process.env, timeout = 600_000} = {}) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(program, args, {cwd: root, env, shell: false, stdio: ['pipe', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit']});
    let stdout = '', stderr = '', bytes = 0, failure;
    const timer = setTimeout(() => { failure = new Error(`${program}: limite de execução excedido.`); child.kill('SIGKILL'); }, timeout);
    if (capture) {
      for (const [stream, kind] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) stream.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { failure = new Error(`${program}: saída excedeu o limite.`); child.kill('SIGKILL'); return; }
        if (kind === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
      });
    }
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${program} terminou com código ${code}. ${capture ? stderr.slice(-4000) : ''}`));
      else resolveCommand(stdout.trim());
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function compose(state, args, options = {}) {
  return execute('docker', ['compose', '--project-name', state.project, '-f', join(root, 'compose.yaml'), '-f', state.override, ...args], {...options, env: {...process.env, AB_PORTA: String(state.port)}});
}

async function freeLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  const port = server.address().port;
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

async function containerInfo(state, service) {
  const id = await compose(state, ['ps', '--quiet', service], {capture: true, timeout: 15_000});
  assert.match(id, /^[a-f0-9]{12,64}$/u, `Container ${service} ausente.`);
  return JSON.parse(await execute('docker', ['inspect', id], {capture: true, timeout: 15_000}))[0];
}

async function waitHealthy(state) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const app = await containerInfo(state, 'app');
    const maintenance = await containerInfo(state, 'maintenance');
    if (app.State.Health?.Status === 'healthy' && maintenance.State.Health?.Status === 'healthy') return {app, maintenance};
    assert.equal(app.State.Running, true, 'Aplicação parou antes de ficar saudável.');
    assert.equal(maintenance.State.Running, true, 'Manutenção parou antes de ficar saudável.');
    await delay(1000);
  }
  throw new Error('Os dois serviços não ficaram saudáveis no prazo.');
}

const probeRuntime = `
  import assert from 'node:assert/strict';
  import {lstat, access} from 'node:fs/promises';
  import {DatabaseSync} from 'node:sqlite';
  import {checkHealth} from './scripts/healthcheck.mjs';
  assert.equal(process.versions.node.split('.')[0], '24');
  assert.equal(process.getuid(), 1001);
  assert.equal(process.getgid(), 1001);
  assert.equal(process.env.DB_PATH, '/data/ab-jk-uash.sqlite');
  assert.equal(process.env.PUBLIC_ORIGIN, 'https://ci.ab-jk-uash.invalid');
  assert.equal(process.env.COOKIE_SECURE, 'true');
  await assert.rejects(access('/app/node_modules'), {code: 'ENOENT'});
  const token = await lstat('/data/setup-token');
  assert.equal(token.uid, 1001);
  assert.equal(token.mode & 0o777, 0o600);
  assert.equal(token.isFile(), true);
  await checkHealth();
  const db = new DatabaseSync(process.env.DB_PATH, {readOnly: true});
  const user = db.prepare('SELECT id, email, role FROM users WHERE email=?').get('release-smoke@example.invalid');
  assert.equal(user?.role, 'admin');
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 1);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  db.close();
  console.log(JSON.stringify({id:user.id, email:user.email, role:user.role}));
`;

const probeBackup = `
  import assert from 'node:assert/strict';
  import {readFile} from 'node:fs/promises';
  import {DatabaseSync} from 'node:sqlite';
  import {checkMaintenanceHealth} from './scripts/jk-maintenance.mjs';
  await checkMaintenanceHealth();
  const status = JSON.parse(await readFile('/data/maintenance/status.json', 'utf8'));
  assert.equal(status.restoreVerified, true);
  const db = new DatabaseSync('/data/backups/' + status.backup, {readOnly: true});
  const user = db.prepare('SELECT id, email, role FROM users WHERE email=?').get('release-smoke@example.invalid');
  db.close();
  assert.equal(user?.role, 'admin');
  console.log(JSON.stringify({id:user.id, backup:status.backup, restoreVerified:true}));
`;

async function nodeIn(state, service, source) {
  return JSON.parse(await compose(state, ['exec', '-T', service, 'node', '--input-type=module', '-e', source], {capture: true, timeout: 30_000}));
}

async function run() {
  // The state is written before Docker work, so the workflow's always() step
  // can clean this exact private fixture even if build or startup fails.
  const directory = await mkdtemp(join(runnerTemp, 'ab-jk-ci-smoke-'));
  const state = {directory, data: join(directory, 'dados'), override: join(directory, 'compose.override.json'), project: `ab-jk-ci-${randomUUID().slice(0, 8)}`, port: await freeLoopbackPort()};
  state.image = `ab-jk-uash:${state.project}`;
  await writeFile(stateFile, JSON.stringify(state), {flag: 'wx', mode: 0o600});
  try {
    await mkdir(state.data, {mode: 0o700});
    try { await chown(state.data, 1001, 1001); }
    catch (error) {
      if (error.code !== 'EPERM') throw error;
      await execute('sudo', ['chown', '1001:1001', state.data], {timeout: 10_000});
    }
    const volume = {type: 'bind', source: state.data, target: '/data', bind: {create_host_path: false}};
    const health = {interval: '2s', timeout: '10s', start_period: '5s', retries: 60};
    await writeFile(state.override, JSON.stringify({
      services: {
        app: {image: state.image, environment: {PUBLIC_ORIGIN: 'https://ci.ab-jk-uash.invalid', AB_UASH_FISCAL_ENABLED: 'false'}, volumes: [volume], networks: ['ci-offline'], healthcheck: health},
        maintenance: {image: state.image, volumes: [volume], healthcheck: health},
      },
      networks: {'ci-offline': {internal: true}},
    }, null, 2), {mode: 0o600});
    await compose(state, ['config', '--quiet'], {timeout: 30_000});
    await compose(state, ['build', 'app']);
    await compose(state, ['up', '--detach', '--no-build', '--wait', '--wait-timeout', '180'], {timeout: 210_000});
    const healthy = await waitHealthy(state);
    for (const info of [healthy.app, healthy.maintenance]) {
      assert.equal(info.Config.User, '1001:1001');
      assert.equal(info.HostConfig.ReadonlyRootfs, true);
      assert.ok(info.Mounts.some(mount => mount.Destination === '/data' && mount.Type === 'bind' && mount.Source === state.data));
    }
    assert.equal(healthy.maintenance.HostConfig.NetworkMode, 'none');
    const networks = Object.values(healthy.app.NetworkSettings.Networks);
    assert.equal(networks.length, 1);
    const network = JSON.parse(await execute('docker', ['network', 'inspect', networks[0].NetworkID], {capture: true}))[0];
    assert.equal(network.Internal, true);
    assert.deepEqual(healthy.app.HostConfig.PortBindings['4173/tcp'], [{HostIp: '127.0.0.1', HostPort: String(state.port)}]);
    // A disposable administrator exercises the real private-stdin bootstrap.
    // Its generated password never enters environment, arguments, logs or files.
    const input = JSON.stringify({name: 'CI release smoke', email, password: `CI-${randomBytes(24).toString('base64url')}`});
    await compose(state, ['exec', '-T', 'app', 'node', 'scripts/jk-bootstrap-admin.mjs', '--db', '/data/ab-jk-uash.sqlite'], {input, capture: true, timeout: 30_000});
    const before = await nodeIn(state, 'app', probeRuntime);
    await compose(state, ['exec', '-T', 'maintenance', 'node', 'scripts/jk-maintenance.mjs', 'once'], {capture: true, timeout: 60_000});
    const backup = await nodeIn(state, 'maintenance', probeBackup);
    assert.equal(backup.id, before.id);
    await compose(state, ['restart', '--timeout', '30', 'app', 'maintenance'], {timeout: 90_000});
    const restarted = await waitHealthy(state);
    assert.notEqual(restarted.app.State.StartedAt, healthy.app.State.StartedAt);
    const after = await nodeIn(state, 'app', probeRuntime);
    assert.deepEqual(after, before, 'O administrador sintético não persistiu após restart.');
    assert.equal((await nodeIn(state, 'maintenance', probeBackup)).id, before.id);
    console.log(JSON.stringify({ok: true, imageBuilt: true, applicationHealthy: true, offlineMaintenanceHealthy: true, restoreVerified: true, sqlitePersistedAfterRestart: true, syntheticDataOnly: true}));
  } catch (error) {
    await compose(state, ['ps']).catch(() => {});
    await compose(state, ['logs', '--no-color', '--tail', '50', 'app', 'maintenance']).catch(() => {});
    throw error;
  }
}

async function cleanup() {
  let state;
  try { state = JSON.parse(await readFile(stateFile, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  assert.ok(resolve(state.directory).startsWith(`${runnerTemp}${sep}`));
  assert.ok(basename(state.directory).startsWith('ab-jk-ci-smoke-'));
  assert.match(state.project, /^ab-jk-ci-[a-f0-9]{8}$/u);
  assert.equal(state.image, `ab-jk-uash:${state.project}`);
  assert.equal(state.override, join(state.directory, 'compose.override.json'));
  const errors = [];
  try {
    // If creation failed before the override was written, no Docker command
    // has launched a container. Otherwise remove only this unique project.
    try { await lstat(state.override); await compose(state, ['down', '--volumes', '--remove-orphans', '--timeout', '15'], {timeout: 60_000}); }
    catch (error) { if (error.code !== 'ENOENT') errors.push(error); }
    await execute('docker', ['image', 'rm', '--force', state.image], {capture: true, timeout: 30_000}).catch(error => {
      if (!/No such image/u.test(error.message)) errors.push(error);
    });
  } finally {
    try { await rm(state.directory, {recursive: true, force: true}); }
    catch (error) {
      if (!['EACCES', 'EPERM'].includes(error.code)) throw error;
      await execute('sudo', ['rm', '-rf', '--', state.directory], {timeout: 15_000});
    }
    await rm(stateFile, {force: true});
  }
  if (errors.length) throw new AggregateError(errors, `A limpeza da CI não terminou completamente: ${errors.map(error => error.message).join('; ')}`);
  console.log('Limpeza dos recursos e dados sintéticos da CI concluída.');
}

try {
  if (process.argv.length !== 3 || !['run', 'cleanup'].includes(process.argv[2])) throw new Error('Use node infra/ci-smoke.mjs run|cleanup.');
  if (process.argv[2] === 'cleanup') await cleanup(); else await run();
} catch (error) { console.error(error.message); process.exitCode = 1; }
