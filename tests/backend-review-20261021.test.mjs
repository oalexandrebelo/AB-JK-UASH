import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, chmod, stat, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../server/db.mjs';
import {createTestApplication as createApplication} from './database-fixture.mjs';

test('SQLite creates private database, WAL and shared-memory files even with an open umask', {skip:process.platform === 'win32'}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ab-uash-private-files-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  await chmod(directory, 0o755);
  const file = join(directory, 'local.sqlite');
  // The synchronous constructor must not depend on the caller's process umask.
  const previous = process.umask(0);
  let db;
  try { db = openDatabase(file); } finally { process.umask(previous); }
  t.after(() => db.close());
  db.prepare('INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,?)').run('preserved', 'private-value', 'now');
  for (const suffix of ['', '-wal', '-shm']) {
    assert.equal((await stat(file + suffix)).mode & 0o777, 0o600, suffix || 'database');
  }
});

test('SQLite repairs permissions of existing live sidecars without replacing data', {skip:process.platform === 'win32'}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ab-uash-repair-files-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const file = join(directory, 'local.sqlite');
  const original = openDatabase(file);
  t.after(() => original.close());
  original.prepare('INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,?)').run('preserved', 'private-value', 'now');
  const before = await stat(file);
  for (const suffix of ['', '-wal', '-shm']) await chmod(file + suffix, 0o644);
  const reopened = openDatabase(file);
  t.after(() => reopened.close());
  assert.equal((await stat(file)).ino, before.ino);
  for (const suffix of ['', '-wal', '-shm']) {
    assert.equal((await stat(file + suffix)).mode & 0o777, 0o600, suffix || 'database');
  }
  assert.equal(reopened.prepare("SELECT value_json FROM app_settings WHERE key='preserved'").get().value_json, 'private-value');
  assert.equal(original.prepare("SELECT value_json FROM app_settings WHERE key='preserved'").get().value_json, 'private-value');
});

test('application blocks unprotected first-run bootstrap on a non-loopback listener', async t => {
  const apps = [];
  t.after(async () => { for (const app of apps) await app.close(); });
  async function application(options = {}) {
    const app = await createApplication({dbPath:':memory:', ...options});
    apps.push(app);
    return app;
  }
  const unconfigured = await application();
  await assert.rejects(unconfigured.listen({host:'0.0.0.0', port:0}), /PUBLIC_ORIGIN/);
  const untokened = await application({publicOrigin:'http://workstation.example.invalid'});
  await assert.rejects(untokened.listen({host:'0.0.0.0', port:0}), /SETUP_TOKEN/);
  assert.equal(untokened.server.listening, false);
  assert.equal((await untokened.store.prepare('SELECT COUNT(*) AS n FROM users').get()).n, 0);
  const tokened = await application({publicOrigin:'http://workstation.example.invalid', setupToken:'s'.repeat(43)});
  assert.equal(typeof (await tokened.listen({host:'0.0.0.0', port:0})).port, 'number');
  const local = await application();
  assert.equal(typeof (await local.listen({host:'127.0.0.1', port:0})).port, 'number');
});

test('an initialized non-loopback application may restart without the bootstrap token', async t => {
  const app = await createApplication({dbPath:':memory:', publicOrigin:'http://workstation.example.invalid'});
  t.after(() => app.close());
  await app.store.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run('existing-admin', 'Existing administrator', 'existing@example.invalid', 'unused-fixture-hash', 'admin', 'now', 'now');
  assert.equal(typeof (await app.listen({host:'0.0.0.0', port:0})).port, 'number');
});
