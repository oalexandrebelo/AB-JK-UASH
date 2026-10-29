import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../../server/db.mjs';
import {maintenanceConfiguration, runMaintenance, checkMaintenanceHealth, pruneBackups} from '../../scripts/jk-maintenance.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ab-jk-maintenance-test-'));
  const config = maintenanceConfiguration({DB_PATH: join(directory, 'app.sqlite'), JK_BACKUP_KEEP: '2', JK_BACKUP_INTERVAL_SECONDS: '60'});
  const db = openDatabase(config.dbPath);
  db.exec("INSERT INTO users(id,name,email,password_hash,role,created_at,updated_at) VALUES('fixture','Operador de teste','fixture@example.invalid','not-a-login-secret','admin','2026-10-28','2026-10-28')");
  db.exec("INSERT INTO sessions VALUES('fixture-session','fixture','fixture-csrf',1,9999999999999,1)");
  t.after(async () => { db.close(); await rm(directory, {recursive: true, force: true}); });
  return {directory, config, db};
}

test('online maintenance proves restore, preserves live sessions and writes private evidence', async t => {
  const {config, db} = await fixture(t);
  const status = await runMaintenance(config);
  const file = join(config.backupDir, status.backup);
  const proof = JSON.parse(await readFile(`${file}.restore-check.json`, 'utf8'));
  assert.equal(status.restoreVerified, true);
  assert.equal(proof.backupSha256, status.sha256);
  assert.equal(proof.sessionsRevoked, true);
  assert.equal(proof.restoreEventPresent, true);
  assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 1);
  const copy = new DatabaseSync(file, {readOnly: true});
  try { assert.equal(copy.prepare('SELECT count(*) AS n FROM sessions').get().n, 1); }
  finally { copy.close(); }
  assert.equal((await checkMaintenanceHealth(config)).ok, true);
  if (process.platform !== 'win32') {
    for (const path of [file, `${file}.manifest.json`, `${file}.restore-check.json`, join(config.stateDir, 'status.json')]) assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
  assert.equal((await readdir(config.backupDir)).some(name => name.startsWith('.restore-check-')), false);
  await assert.rejects(checkMaintenanceHealth(config, Date.parse(status.finishedAt) + config.intervalMs + 15 * 60 * 1000 + 1), /recente/u);
});

test('retention removes only verified older triplets and preserves unrelated or incomplete files', async t => {
  const {config} = await fixture(t);
  const first = await runMaintenance(config);
  const unrelated = join(config.backupDir, 'operator-backup.sqlite');
  const incomplete = join(config.backupDir, 'ab-jk-uash-20200101T000000000Z-00000000.sqlite');
  await writeFile(unrelated, 'preserve operator file');
  await writeFile(incomplete, 'preserve incomplete backup');
  await runMaintenance(config);
  const last = await runMaintenance(config);
  assert.equal(last.retention.removed, 1);
  await assert.rejects(stat(join(config.backupDir, first.backup)), {code: 'ENOENT'});
  await assert.rejects(stat(join(config.backupDir, `${first.backup}.manifest.json`)), {code: 'ENOENT'});
  await assert.rejects(stat(join(config.backupDir, `${first.backup}.restore-check.json`)), {code: 'ENOENT'});
  assert.equal(await readFile(unrelated, 'utf8'), 'preserve operator file');
  assert.equal(await readFile(incomplete, 'utf8'), 'preserve incomplete backup');
  assert.equal((await readdir(config.backupDir)).filter(name => name.endsWith('.restore-check.json')).length, 2);
  await assert.rejects(pruneBackups(config.backupDir, 0), /intervalo/u);
});

test('corrupted copies fail offline health and never count toward valid retention', async t => {
  const {config} = await fixture(t);
  const first = await runMaintenance(config);
  const damaged = join(config.backupDir, first.backup);
  await writeFile(damaged, 'damaged backup');
  await assert.rejects(checkMaintenanceHealth(config), /prova/u);
  const second = await runMaintenance(config);
  const third = await runMaintenance(config);
  assert.equal(third.retention.retained, 2);
  assert.equal(third.retention.removed, 0);
  await stat(join(config.backupDir, second.backup));
  assert.equal(await readFile(damaged, 'utf8'), 'damaged backup');
  assert.equal((await checkMaintenanceHealth(config)).ok, true);
});

test('failed restore makes maintenance unhealthy and preserves previous good backups', async t => {
  const {config, db} = await fixture(t);
  const good = await runMaintenance(config);
  db.exec('PRAGMA user_version=3');
  await assert.rejects(runMaintenance(config), /compatível/u);
  const status = JSON.parse(await readFile(join(config.stateDir, 'status.json'), 'utf8'));
  assert.equal(status.ok, false);
  assert.equal(status.error, 'backup_or_restore_failed');
  await assert.rejects(checkMaintenanceHealth(config), /recente/u);
  await stat(join(config.backupDir, good.backup));
  assert.equal((await readdir(config.backupDir)).some(name => name.startsWith('.restore-check-')), false);
});
