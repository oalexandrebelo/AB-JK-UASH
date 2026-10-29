import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createClient, ApiError, TransportError, MemoryCookieJar, validateBaseUrl } from '../sdk/dist/index.js';
import { fixture, administrator, seedOrder } from './sdk-helpers.mjs';

test('SDK validates HTTPS/loopback origins, rejects credential URLs and unknown parameters before fetch', async () => {
  for (const url of ['https://api.example.test', 'http://127.0.0.1:4173', 'http://localhost:4173', 'http://[::1]:4173', 'http://127.1.2.3']) assert.equal(validateBaseUrl(url), new URL(url).origin);
  for (const url of ['http://example.test', 'file:///tmp/app', 'https://user:secret@host.test', 'https://host.test/path', 'https://host.test?secret=x', 'https://host.test#secret', '//host.test', 'http://127.0.0.1.attacker.test']) assert.throws(() => validateBaseUrl(url), TypeError);
  let calls = 0;
  const client = createClient({ baseUrl: 'https://api.example.test', fetch: async () => { calls++; throw new Error('should not fetch'); } });
  assert.throws(() => client.api.getCustomer({ path: { id: '../users' } }), TypeError);
  assert.throws(() => client.api.listUsers({ query: { offset: 1 } }), TypeError);
  assert.throws(() => client.prepare('login', { body: { email: 'test@test.test', password: 'secret' } }), TypeError);
  await assert.rejects(client.api.login({ body: { email: 'test@test.test', password: 'secret' } }, { idempotencyKey: 'unsafe-key' }), TypeError);
  await assert.rejects(client.api.getHealth({}, { timeoutMs: -1 }), TypeError);
  assert.equal(calls, 0);
});

test('memory cookie jar enforces host, port, Path, Secure, SameSite, expiry, deletion and prefixes', () => {
  const jar = new MemoryCookieJar('https://api.example.test');
  const headers = new Headers();
  for (const cookie of [
    'host=one; Path=/; HttpOnly; Secure; SameSite=Strict',
    'scoped=two; Path=/api; Secure; SameSite=Lax',
    'domain=three; Domain=api.example.test; Path=/; Secure; SameSite=None',
    'parent=bad; Domain=example.test; Path=/; Secure',
    'unrelated=bad; Domain=attacker.test; Path=/; Secure',
    'publicSuffix=bad; Domain=test; Path=/; Secure',
    'noneInsecure=bad; Path=/; SameSite=None',
    '__Host-valid=four; Path=/; Secure',
    '__Host-invalid=bad; Domain=api.example.test; Path=/; Secure',
    '__Secure-invalid=bad; Path=/',
  ]) headers.append('Set-Cookie', cookie);
  jar.store('https://api.example.test/api/login', headers, 1000);
  assert.equal(jar.header('https://api.example.test/api/orders', {}, 1001), 'scoped=two; host=one; domain=three; __Host-valid=four');
  assert.equal(jar.header('https://api.example.test/apix', {}, 1001), 'host=one; domain=three; __Host-valid=four');
  assert.equal(jar.header('https://api.example.test/api/orders', { sameSite: false }, 1001), 'domain=three');
  assert.equal(jar.header('https://api.example.test/api/orders', { sameSite: false, topLevelNavigation: true }, 1001), 'scoped=two; domain=three; __Host-valid=four');
  assert.equal(jar.header('https://api.example.test/api/orders', { sameSite: false, topLevelNavigation: true, method: 'POST' }, 1001), 'domain=three');
  for (const url of ['http://api.example.test/api/orders', 'https://api.example.test:8443/api/orders', 'https://sub.api.example.test/api/orders', 'https://attacker.test']) assert.equal(jar.header(url), '');
  jar.store('https://attacker.test', new Headers({ 'Set-Cookie': 'host=attacker; Path=/' }), 1001);
  jar.store('https://api.example.test/api/login', new Headers({ 'Set-Cookie': 'temporary=x; Path=/; Max-Age=1; Expires=Wed, 21 Oct 2099 07:28:00 GMT' }), 1000);
  assert.match(jar.header('https://api.example.test', {}, 1999), /temporary=x/);
  assert.doesNotMatch(jar.header('https://api.example.test', {}, 2000), /temporary=/);
  jar.store('https://api.example.test/api/login', new Headers({ 'Set-Cookie': 'host=; Path=/; Max-Age=0' }), 2001);
  assert.doesNotMatch(jar.header('https://api.example.test', {}, 2002), /host=/);
  assert.doesNotMatch(JSON.stringify(jar), /one|two|three|four/);
  const local = new MemoryCookieJar('http://127.0.0.1:4173');
  local.store('http://127.0.0.1:4173/api/login', new Headers({ 'Set-Cookie': 'secret=bad; Secure; Path=/' }));
  assert.equal(local.header('http://127.0.0.1:4173'), '');
  jar.clear();
  assert.equal(jar.header('https://api.example.test'), '');
});

test('browser mode uses credentials and session CSRF, without reading or forging HttpOnly cookies', async () => {
  const requests = [];
  const csrf = 'c'.repeat(43);
  const client = createClient({
    baseUrl: 'https://api.example.test', mode: 'browser',
    fetch: async (url, init) => {
      requests.push({ url, init });
      return Response.json({ ok: true, data: url.endsWith('/auth/session') ? { user: { id: 'u' }, csrfToken: csrf } : { user: { id: 'new' } } }, { headers: { 'set-cookie': 'ab_uash_session=opaque; HttpOnly; Secure; SameSite=Strict' } });
    },
  });
  await client.api.getSession();
  await client.api.createUser({ body: { name: 'Browser User', email: 'user@test.test', password: 'not-a-real-password', role: 'viewer' } });
  assert.equal(requests[1].init.credentials, 'include');
  assert.equal(requests[1].init.redirect, 'manual');
  assert.equal(requests[1].init.headers.get('X-CSRF-Token'), csrf);
  assert.equal(requests[1].init.headers.get('Cookie'), null);
  assert.equal(requests[1].init.headers.get('Idempotency-Key'), null);
  assert.doesNotMatch(JSON.stringify(client), new RegExp(csrf));
});

test('real HTTP SDK login, role restrictions, limited fields and revoked session handling', async (t) => {
  const { client, baseUrl } = await fixture(t);
  const setup = await client.api.setup({ body: administrator });
  assert.equal(setup.user.role, 'admin');
  assert.equal((await client.api.getStatus()).storageMode, 'local');
  const employee = (await client.api.createEmployee({ body: { name: 'Equipe SDK', baseSalaryCents: 200000, commissionBps: 1200 } })).item;
  assert.equal(employee.baseSalaryCents, 200000);
  const users = {};
  for (const role of ['manager', 'operator', 'viewer']) {
    const input = { name: `SDK ${role}`, email: `sdk-${role}@example.test`, password: `sdk-${role}-test-password`, role };
    const { user } = await client.api.createUser({ body: input });
    const actor = createClient({ baseUrl });
    await actor.api.login({ body: { email: input.email, password: input.password } });
    users[role] = { actor, user };
  }
  for (const role of ['operator', 'viewer']) {
    const actor = users[role].actor;
    assert.equal('baseSalaryCents' in (await actor.api.getEmployee({ path: { id: employee.id } })).item, false);
    assert.equal('commissionBps' in (await actor.api.listEmployees()).items[0], false);
    const dashboard = (await actor.api.getDashboard()).item;
    assert.equal('receivedTodayCents' in dashboard, false);
    assert.equal('receivableCents' in dashboard, false);
    await assert.rejects(actor.api.listPayments(), (error) => error instanceof ApiError && error.status === 403 && error.code === 'FORBIDDEN' && !!error.requestId);
    await assert.rejects(actor.api.listCashSessions(), { code: 'FORBIDDEN' });
  }
  assert.equal((await users.operator.actor.api.getCurrentCash()).item, null);
  await assert.rejects(users.viewer.actor.api.getCurrentCash(), { code: 'FORBIDDEN' });
  await assert.rejects(users.viewer.actor.api.createCustomer({ body: { name: 'Forbidden' } }), { code: 'FORBIDDEN' });
  await assert.rejects(users.manager.actor.api.listUsers(), { code: 'FORBIDDEN' });
  assert.ok((await users.manager.actor.api.getEmployee({ path: { id: employee.id } })).item.baseSalaryCents);
  await users.manager.actor.api.listAudit();
  await client.api.updateUser({ path: { userId: users.operator.user.id }, body: { active: false } });
  await assert.rejects(users.operator.actor.api.listCustomers(), { code: 'AUTH_REQUIRED' });
  assert.equal((await users.operator.actor.api.getSession()).user, null);
  await client.api.logout({ body: {} });
  assert.equal((await client.api.getSession()).user, null);
});

test('setup token is a scoped header; password rotation revokes other real HTTP sessions', async (t) => {
  const setupToken = 'sdk-test-setup-token-0000000000000000';
  const { client, baseUrl } = await fixture(t, { setupToken });
  assert.equal((await client.api.getStatus()).setupTokenRequired, true);
  await assert.rejects(client.api.setup({ body: administrator }), { code: 'SETUP_TOKEN_REQUIRED', status: 403 });
  const setup = await client.api.setup({ body: administrator }, { setupToken });
  assert.equal(setup.setupTokenRequired, false);
  const other = createClient({ baseUrl });
  await other.api.login({ body: { email: administrator.email, password: administrator.password } });
  await client.api.changePassword({ body: { currentPassword: administrator.password, newPassword: 'new-sdk-password-2026' } });
  await assert.rejects(other.api.listUsers(), { code: 'AUTH_REQUIRED' });
  assert.equal((await client.api.listUsers()).items.length, 1);
});

test('stable prepared payment survives a lost real HTTP response without duplicate receipts', async (t) => {
  const { client: admin, baseUrl, app } = await fixture(t);
  await admin.api.setup({ body: administrator });
  const { order } = await seedOrder(admin);
  let paymentDispatches = 0;
  let loseNextPaymentResponse = true;
  const client = createClient({
    baseUrl,
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (url.endsWith('/payments') && init.method === 'POST') {
        paymentDispatches++;
        if (loseNextPaymentResponse) {
          loseNextPaymentResponse = false;
          await response.arrayBuffer();
          throw new Error('simulated connection loss containing private data');
        }
      }
      return response;
    },
  });
  await client.api.login({ body: { email: administrator.email, password: administrator.password } });
  const input = { path: { orderId: order.id }, body: { version: order.version, amountCents: 1000, method: 'pix' } };
  const prepared = client.prepare('recordOrderPayment', input);
  input.body.amountCents = 2000;
  await assert.rejects(prepared.execute(), (error) => {
    assert.ok(error instanceof TransportError);
    assert.equal(error.kind, 'network');
    assert.equal(error.outcome, 'unknown');
    assert.equal(error.replaySafe, true);
    assert.equal(error.idempotencyKey, prepared.idempotencyKey);
    assert.doesNotMatch(JSON.stringify(error), /private data|password|cookie/i);
    return true;
  });
  assert.equal(paymentDispatches, 1, 'SDK must not retry payments automatically');
  await admin.api.createUser({ body: { name: 'Other SDK User', email: 'other-sdk@example.test', password: 'other-sdk-test-password', role: 'manager' } });
  await client.api.login({ body: { email: 'other-sdk@example.test', password: 'other-sdk-test-password' } });
  await assert.rejects(prepared.execute(), TypeError);
  assert.equal(paymentDispatches, 1, 'Prepared payment must not switch its actor');
  await client.api.login({ body: { email: administrator.email, password: administrator.password } });
  const { item: paid } = await prepared.execute();
  assert.equal(paid.paidCents, 1000);
  assert.equal(paid.balanceCents, 1500);
  assert.equal(paymentDispatches, 2);
  assert.equal((await app.db.prepare('SELECT COUNT(*) AS count FROM payments').get()).count, 1);
  await assert.rejects(client.api.recordOrderPayment({ path: { orderId: order.id }, body: { version: order.version, amountCents: 2000, method: 'pix' } }, { idempotencyKey: prepared.idempotencyKey }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('HTTP cancellation and deadlines stop waiting through headers/body and never auto-follow redirects', async (t) => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url === '/api/health') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': 'slow-body-id' });
      response.write('{"ok":true,"data":');
      return;
    }
    response.writeHead(302, { Location: '/capture' });
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = createClient({ baseUrl, timeoutMs: 60 });
  const start = Date.now();
  await assert.rejects(client.api.getHealth(), (error) => error instanceof TransportError && error.kind === 'timeout' && error.requestId === 'slow-body-id');
  assert.ok(Date.now() - start < 1000);
  const abort = new AbortController();
  const request = client.api.getHealth({}, { signal: abort.signal, timeoutMs: 5000 });
  setTimeout(() => abort.abort(), 30);
  await assert.rejects(request, { kind: 'aborted' });
  const before = requests.length;
  const already = new AbortController();
  already.abort();
  await assert.rejects(client.api.getHealth({}, { signal: already.signal }), { kind: 'aborted', outcome: 'not_sent' });
  assert.equal(requests.length, before);
  await assert.rejects(client.api.login({ body: { email: administrator.email, password: administrator.password } }), { kind: 'redirect', outcome: 'unknown' });
  assert.equal(requests.includes('/capture'), false);
  const ignored = createClient({ baseUrl, timeoutMs: 20, fetch: () => new Promise(() => {}) });
  await assert.rejects(ignored.api.getHealth(), { kind: 'timeout' });
});

test('real HTTP mutation cancellation exposes ambiguous outcome and replay uses same key', async (t) => {
  const { client: admin, baseUrl } = await fixture(t);
  await admin.api.setup({ body: administrator });
  let held = false;
  const client = createClient({
    baseUrl,
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (url.endsWith('/customers') && init.method === 'POST' && !held) {
        held = true;
        await response.arrayBuffer();
        await delay(100);
      }
      return response;
    },
  });
  await client.api.login({ body: { email: administrator.email, password: administrator.password } });
  const operation = client.prepare('createCustomer', { body: { name: 'Timeout Customer' } });
  await assert.rejects(operation.execute({ timeoutMs: 20 }), { kind: 'timeout', outcome: 'unknown', replaySafe: true });
  const result = await operation.execute();
  assert.equal(result.item.name, 'Timeout Customer');
  assert.equal((await client.api.listCustomers()).items.length, 1);
});

test('documented Node example logs in against real HTTP and emits no credentials or tokens', async (t) => {
  const { client, baseUrl } = await fixture(t);
  await client.api.setup({ body: administrator });
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['sdk/examples/node.mjs'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, AB_UASH_URL: baseUrl, AB_UASH_EMAIL: administrator.email, AB_UASH_PASSWORD: administrator.password },
    timeout: 10000,
  });
  assert.match(stdout, /returnedCustomers/);
  assert.equal(stderr, '');
  assert.doesNotMatch(stdout, /csrfToken|ab_uash_session|password|admin@example|sdk-admin@example/);
  assert.equal((await client.api.getSession()).user.role, 'admin', 'CLI logout revokes only its own session');
});
