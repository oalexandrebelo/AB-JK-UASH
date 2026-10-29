import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createTestApplication as createApplication } from './database-fixture.mjs';
import { idempotentWrite, audit } from '../server/db.mjs';

const admin = { name: 'Administrador de teste', email: 'admin@example.test', password: 'test-only-password-2026' };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ab-uash-backend-'));
  const distDir = join(directory, 'dist');
  await mkdir(distDir);
  await writeFile(join(distDir, 'index.html'), '<!doctype html><title>AB-UASH teste</title>');
  const options = { dbPath: join(directory, 'local.sqlite'), distDir, logger: { error(value) { throw new Error(`Unexpected server error: ${JSON.stringify(value)}`); } } };
  let app = await createApplication(options);
  let address = await app.listen({ port: 0 });
  let base = `http://127.0.0.1:${address.port}`;
  const client = { cookie: '', csrf: '' };
  async function request(path, { method = 'GET', body, authenticated = true, headers = {}, raw } = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(authenticated && client.cookie ? { cookie: client.cookie } : {}),
        ...(authenticated && client.csrf ? { 'x-csrf-token': client.csrf } : {}),
        ...headers,
      },
      ...(body === undefined && raw === undefined ? {} : { body: raw ?? JSON.stringify(body) }),
    });
    const content = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
    return { response, status: response.status, body: content };
  }
  function remember(result) {
    client.cookie = result.response.headers.get('set-cookie')?.split(';')[0] || client.cookie;
    client.csrf = result.body.data.csrfToken || client.csrf;
    return result;
  }
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    get app() { return app; }, get base() { return base; }, directory, options, request, remember, client,
    async setup() { return remember(await request('/api/setup', { method: 'POST', body: admin })); },
    async restart() { await app.close(); app = await createApplication(options); address = await app.listen({ port: 0 }); base = `http://127.0.0.1:${address.port}`; },
  };
}

test('first-run setup is atomic, hashes secrets, and survives a database restart', async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.request('/api/status')).body.data, { setupRequired: true, setupTokenRequired: false, storageMode: process.env.AB_UASH_TEST_DATABASE_URL ? 'postgres' : 'local', user: null });
  const outcomes = await Promise.all([
    f.request('/api/setup', { method: 'POST', body: admin }),
    f.request('/api/setup', { method: 'POST', body: { ...admin, email: 'other@example.test' } }),
  ]);
  assert.deepEqual(outcomes.map((x) => x.status).sort(), [201, 409]);
  const created = f.remember(outcomes.find((x) => x.status === 201));
  assert.equal(created.body.data.user.role, 'admin');
  assert.match(created.response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/u);
  assert.equal((await f.app.store.prepare('SELECT COUNT(*) AS total FROM users').get()).total, 1);
  const row = (await f.app.store.prepare('SELECT * FROM users').get());
  assert.match(row.password_hash, /^scrypt\$32768\$8\$1\$/u);
  assert.ok(!row.password_hash.includes(admin.password));
  assert.ok(!JSON.stringify(created.body).includes('password_hash'));
  assert.equal((await f.app.store.prepare("SELECT COUNT(*) AS total FROM audit_events WHERE action='setup.completed'").get()).total, 1);
  await f.restart();
  const persisted = await f.request('/api/status');
  assert.equal(persisted.body.data.setupRequired, false);
  assert.equal(persisted.body.data.user.id, created.body.data.user.id);
  assert.equal((await f.request('/api/setup', { method: 'POST', body: admin })).status, 409);
});

test('authenticated writes enforce CSRF, origin, JSON, roles, and final administrator protection', async (t) => {
  const f = await fixture(t);
  const setup = await f.setup();
  const userBody = { name: 'Leitor Teste', email: 'viewer@example.test', password: 'viewer-password-test', role: 'viewer' };
  assert.equal((await f.request('/api/users', { method: 'POST', body: userBody, headers: { 'x-csrf-token': '' } })).status, 403);
  assert.equal((await f.request('/api/users', { method: 'POST', body: userBody, headers: { 'x-csrf-token': 'é'.repeat(43) } })).status, 403);
  assert.equal((await f.request('/api/users', { method: 'POST', body: userBody, headers: { origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await f.request('/api/users', { method: 'POST', body: userBody, headers: { 'content-type': 'text/plain' } })).status, 415);
  const created = await f.request('/api/users', { method: 'POST', body: userBody });
  assert.equal(created.status, 201);
  assert.equal((await f.request('/api/users', { method: 'POST', body: userBody })).status, 409);
  assert.equal((await f.request(`/api/users/${setup.body.data.user.id}`, { method: 'PATCH', body: { active: false } })).body.error.code, 'LAST_ADMIN');
  assert.equal((await f.request(`/api/users/${setup.body.data.user.id}`, { method: 'PATCH', body: { role: 'viewer' } })).body.error.code, 'LAST_ADMIN');
  assert.equal((await f.request('/api/users', { authenticated: false })).status, 401);
  const login = f.remember(await f.request('/api/auth/login', { method: 'POST', body: { email: userBody.email, password: userBody.password } }));
  assert.equal(login.status, 200);
  assert.equal((await f.request('/api/users')).status, 403);
  assert.equal((await f.request('/api/users', { method: 'POST', body: { ...userBody, email: 'extra@example.test' } })).status, 403);
  assert.equal((await f.request('/api/audit')).status, 403);
  assert.equal((await f.request('/api/auth/logout', { method: 'POST', body: {} })).status, 200);
  assert.equal((await f.request('/api/status')).body.data.user, null);
});

test('password change revokes old sessions and accepts passwords without changing whitespace', async (t) => {
  const f = await fixture(t);
  const setup = await f.setup();
  const previousCookie = f.client.cookie;
  const nextPassword = '  password with spaces  ';
  const changed = f.remember(await f.request('/api/auth/password', { method: 'POST', body: { currentPassword: admin.password, newPassword: nextPassword } }));
  assert.equal(changed.status, 200);
  assert.notEqual(changed.body.data.csrfToken, setup.body.data.csrfToken);
  assert.equal((await f.request('/api/status', { headers: { cookie: previousCookie } })).body.data.user, null);
  assert.equal((await f.request('/api/auth/login', { method: 'POST', body: { email: admin.email, password: admin.password } })).status, 401);
  assert.equal((await f.request('/api/auth/login', { method: 'POST', body: { email: admin.email, password: nextPassword } })).status, 200);
  assert.equal((await f.request('/api/auth/password', { method: 'POST', body: { currentPassword: nextPassword, newPassword: admin.password } })).status, 200);
});

test('current-password guesses reserve a durable limit before hashing and survive restart', async t => {
  const f=await fixture(t);await f.setup();
  const before=await f.app.store.prepare('SELECT password_hash FROM users').get();
  const results=await Promise.all(Array.from({length:13},()=>f.request('/api/auth/password',{
    method:'POST',body:{currentPassword:'invalid-current-password',newPassword:'unused-next-password-2026'},
  })));
  assert.equal(results.filter(result=>result.status===401).length,12);
  assert.equal(results.filter(result=>result.status===429).length,1);
  assert.deepEqual(await f.app.store.prepare('SELECT password_hash FROM users').get(),before);
  assert.equal((await f.app.store.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='auth.password_changed'").get()).n,0);
  await f.restart();
  assert.equal((await f.request('/api/auth/password',{method:'POST',body:{currentPassword:admin.password,newPassword:'unused-next-password-2026'}})).status,429);
  assert.equal((await f.request('/api/auth/session')).body.data.user.role,'admin');
});

test('malformed input, oversized body, injection strings, and unsupported routes fail safely', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/setup', { method: 'POST', raw: '{bad' })).status, 400);
  assert.equal((await f.request('/api/setup', { method: 'POST', body: { ...admin, password: 'short' } })).status, 422);
  assert.equal((await f.request('/api/setup', { method: 'POST', body: { ...admin, name: 'x'.repeat(70_000) } })).status, 413);
  await f.setup();
  assert.equal((await f.request('/api/auth/login', { method: 'POST', body: { email: "x' OR 1=1 --@example.test", password: admin.password } })).status, 422);
  assert.equal((await f.app.store.prepare('SELECT COUNT(*) AS total FROM users').get()).total, 1);
  assert.equal((await f.request('/api/not-a-route')).status, 404);
  const invalidHost = await new Promise((resolve, reject) => {
    const request = httpRequest(`${f.base}/api/status`, { headers: { host: 'attacker.example' } }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(invalidHost.body.error.code, 'HOST_REJECTED');
  const html = await f.request('/dashboard');
  assert.equal(html.status, 200);
  assert.match(html.response.headers.get('content-security-policy'), /frame-ancestors 'none'/u);
  assert.equal((await f.request('/.env')).status, 404);
  assert.equal((await f.request('/missing.js')).status, 404);
});

test('idempotent writes commit once, reject changed payloads, and roll back the mutation and audit together', async (t) => {
  const f = await fixture(t);
  const userId = (await f.setup()).body.data.user.id;
  const db = f.app.store;
  const options = { actorId: userId, key: 'test-financial-001', method: 'POST', path: '/api/test', body: { cents: 1000, label: 'test' } };
  const perform = async () => {
    (await db.prepare('INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,?)').run('balance', '1000', new Date().toISOString()));
    (await audit(db, { actorId: userId, action: 'test.created', resourceType: 'test' }));
    return { status: 201, data: { cents: 1000 } };
  };
  assert.equal((await idempotentWrite(db, options, perform)).status, 201);
  assert.equal((await idempotentWrite(db, { ...options, body: { label: 'test', cents: 1000 } }, perform)).replayed, true);
  assert.equal((await db.prepare("SELECT COUNT(*) AS total FROM audit_events WHERE action='test.created'").get()).total, 1);
  await assert.rejects(async () => (await idempotentWrite(db, { ...options, body: { cents: 1001 } }, perform)), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(async () => (await idempotentWrite(db, { ...options, key: 'test-financial-002' }, async () => {
    (await db.prepare("UPDATE app_settings SET value_json='2000' WHERE key='balance'").run());
    (await audit(db, { actorId: userId, action: 'test.rollback', resourceType: 'test' }));
    throw new Error('simulated failure');
  })), /simulated failure/u);
  assert.equal((await db.prepare("SELECT value_json FROM app_settings WHERE key='balance'").get()).value_json, '1000');
  assert.equal((await db.prepare("SELECT COUNT(*) AS total FROM audit_events WHERE action='test.rollback'").get()).total, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM idempotency_keys').get()).total, 1);
  const auditRows = JSON.stringify((await db.prepare('SELECT * FROM audit_events').all()));
  assert.ok(!auditRows.includes(admin.email));
  assert.ok(!auditRows.includes(admin.password));
});

test('parallel failed logins cannot bypass the rate limit and disabled users lose all sessions', async (t) => {
  const f = await fixture(t);
  await f.setup();
  const manager = { name: 'Gestor Teste', email: 'manager@example.test', password: 'manager-password-test', role: 'manager' };
  const created = await f.request('/api/users', { method: 'POST', body: manager });
  const managerSession = await f.request('/api/auth/login', { method: 'POST', body: { email: manager.email, password: manager.password } });
  const managerCookie = managerSession.response.headers.get('set-cookie').split(';')[0];
  assert.equal((await f.request('/api/audit', { headers: { cookie: managerCookie } })).status, 200);
  assert.equal((await f.request(`/api/users/${created.body.data.user.id}`, { method: 'PATCH', body: { active: false } })).status, 200);
  assert.equal((await f.request('/api/audit', { headers: { cookie: managerCookie } })).status, 401);
  const attempts = await Promise.all(Array.from({ length: 13 }, () => f.request('/api/auth/login', { method: 'POST', body: { email: admin.email, password: 'wrong-password' } })));
  assert.equal(attempts.filter((result) => result.status === 401).length, 12);
  assert.equal(attempts.filter((result) => result.status === 429).length, 1);
});
