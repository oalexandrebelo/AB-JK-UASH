import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, cp, mkdir, rm, access, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';

const source = fileURLToPath(new URL('../', import.meta.url));
const runtimePlatform = {'linux:x64': 'linux-x64', 'darwin:arm64': 'darwin-arm64', 'darwin:x64': 'darwin-x64'}[`${process.platform}:${process.arch}`];
const runtimePath = runtimePlatform ? join(source, 'runtime', runtimePlatform, 'node') : undefined;
let runtimeAvailable = false;
if (runtimePath) {
  try { await access(runtimePath); runtimeAvailable = true; }
  catch { /* A source checkout does not contain the optional distribution runtime. */ }
}
async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise(resolve => child.once('close', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await closed;
  clearTimeout(timer);
}

test('distribuição isolada inicia sem node_modules com seu runtime, serve assets locais e preserva dados após reiniciar',
  {skip: !runtimePlatform ? 'A prova nativa suporta Linux x64 e macOS arm64/x64.' : !runtimeAvailable ? `Checkout de código: runtime/${runtimePlatform}/node não está presente. A distribuição completa exige o runtime oficial e deve executar esta prova.` : false, timeout: 30_000}, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'ab-uash-distribution-'));
    let child;
    try {
      await mkdir(join(directory, 'runtime', runtimePlatform), {recursive: true});
      await Promise.all(['dist', 'server', 'scripts', 'integrations'].map(name => cp(join(source, name), join(directory, name), {recursive: true})));
      const executable = join(directory, 'runtime', runtimePlatform, 'node');
      await cp(runtimePath, executable);
      await chmod(executable, 0o755);
      await assert.rejects(access(join(directory, 'node_modules')));
      const port = await availablePort(), origin = `http://127.0.0.1:${port}`;
      const start = async () => {
        let output = '';
        child = spawn(executable, ['scripts/start.mjs'], {cwd: directory, env: {
          PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', PORT: String(port), HOST: '127.0.0.1',
          DB_PATH: join(directory, 'data/ab-uash.sqlite'),
        }, stdio: ['ignore', 'pipe', 'pipe']});
        child.stdout.on('data', chunk => {output += chunk;});
        child.stderr.on('data', chunk => {output += chunk;});
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Servidor não iniciou: ${output}`)), 8000);
          const onData = () => {if (output.includes(origin)) {clearTimeout(timer); child.stdout.off('data', onData); resolve();}};
          child.stdout.on('data', onData);
          child.once('error', error => {clearTimeout(timer); reject(error);});
          child.once('exit', code => {clearTimeout(timer); reject(new Error(`Servidor encerrou (${code}): ${output}`));});
        });
      };
      let cookie = '', csrf = '';
      const api = async (path, body) => {
        const response = await fetch(`${origin}/api${path}`, {method: body ? 'POST' : 'GET', headers: {
          ...(cookie ? {Cookie: cookie} : {}), ...(body ? {'Content-Type': 'application/json', Origin: origin, 'X-CSRF-Token': csrf, 'Idempotency-Key': randomUUID()} : {}),
        }, body: body ? JSON.stringify(body) : undefined});
        const result = await response.json();
        assert.equal(response.ok, true, `${path}: ${JSON.stringify(result)}`);
        if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
        if (result.data.csrfToken) csrf = result.data.csrfToken;
        return result.data;
      };
      await start();
      assert.equal((await api('/health')).status, 'ok');
      assert.equal((await api('/status')).setupRequired, true);
      const page = await fetch(origin), html = await page.text();
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/u);
      const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/gu)].map(match => match[1]).filter(path => path.startsWith('/assets/'));
      assert(assets.some(path => path.endsWith('.js')));
      assert(assets.some(path => path.endsWith('.css')));
      for (const path of assets) {
        const asset = await fetch(`${origin}${path}`);
        assert.equal(asset.status, 200, path);
        const text = await asset.text();
        assert.doesNotMatch(text, /(?:use\.typekit\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)/u, path);
      }
      for (const path of ['/ocr/worker.min.js', '/ocr/lang/eng.traineddata.gz']) {
        const asset = await fetch(`${origin}${path}`);
        assert.equal(asset.status, 200, path);
        if (path.endsWith('.gz')) {assert.equal(asset.headers.get('content-type'), 'application/gzip'); assert.equal(asset.headers.get('content-encoding'), null);}
        await asset.arrayBuffer();
      }
      const credentials = {name: 'Administrador sintético', email: 'distribution@example.invalid', password: 'Distribution-fixture-2026'};
      await api('/setup', credentials);
      assert.equal((await api('/customers')).items.length, 0);
      const customer = (await api('/customers', {name: 'Cliente da prova de distribuição'})).item;
      const vehicle = (await api('/vehicles', {customerId: customer.id, plate: 'DST1A23', model: 'Veículo sintético'})).item;
      const service = (await api('/services', {name: 'Lavagem sintética', priceCents: 12345})).item;
      const order = (await api('/orders', {customerId: customer.id, vehicleId: vehicle.id, items: [{serviceId: service.id, quantity: 1}], status: 'waiting'})).item;
      assert.equal(order.totalCents, 12345);
      await stop(child); child = null;
      await start();
      cookie = ''; csrf = '';
      assert.equal((await api('/status')).setupRequired, false);
      await api('/auth/login', {email: credentials.email, password: credentials.password});
      const persisted = (await api(`/orders/${order.id}`)).item;
      assert.equal(persisted.totalCents, 12345);
      assert.equal(persisted.vehiclePlate, 'DST1A23');
      assert.equal((await api('/customers')).items.length, 1);
      await access(join(directory, 'data/ab-uash.sqlite'));
      t.diagnostic(`Processo filho usa somente dist/, server/, scripts/, integrations/ e o executável oficial ${runtimePlatform} distribuído. Nenhum npm ou node_modules foi copiado. Teste de API e distribuição; não é teste de navegador.`);
    } finally {if (child) await stop(child); await rm(directory, {recursive: true, force: true});}
  });
