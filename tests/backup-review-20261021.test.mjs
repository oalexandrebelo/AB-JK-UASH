import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises, {mkdtemp, rm, readFile, writeFile, lstat, readdir, symlink} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../server/db.mjs';
import {createSnapshot, fileHash} from '../scripts/storage.mjs';

const execute = promisify(execFile);
const root = new URL('../', import.meta.url);
const VALUE = 'verified-backup-value';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ab-uash-backup-review-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const source = join(dir, 'source.sqlite'), copy = join(dir, 'backup.sqlite');
  const db = openDatabase(source);
  try {
    db.exec("INSERT INTO users(id,name,email,password_hash,role,created_at,updated_at) VALUES('fixture-user','Backup fixture','backup@example.invalid','fixture-password-never-log','admin','2026-10-21','2026-10-21')");
    db.exec("INSERT INTO sessions VALUES('fixture-session-never-log','fixture-user','fixture-csrf-never-log',1,9999999999999,1)");
    db.prepare('INSERT INTO app_settings VALUES(?,?,?)').run('integrity-fixture', JSON.stringify(VALUE), '2026-10-21');
    await createSnapshot(source, copy);
  } finally { db.close(); }
  return {dir, copy, restored: join(dir, 'restored.sqlite')};
}

function storedValue(path) {
  const db = new DatabaseSync(path, {readOnly: true});
  try { return JSON.parse(db.prepare("SELECT value_json FROM app_settings WHERE key='integrity-fixture'").get().value_json); }
  finally { db.close(); }
}

async function noStagingFiles(dir) {
  assert.deepEqual((await readdir(dir)).filter(name => name.startsWith('.ab-uash-snapshot-')), []);
}

async function assertAbsent(path) { await assert.rejects(lstat(path), {code: 'ENOENT'}); }

// The child hooks the boundary that used to separate hash verification from
// reopening the original path, without adding a test hook to production code.
async function restoreWithRace(copy, restored, mode) {
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import fsPromises from 'node:fs/promises';
    import {dirname, basename} from 'node:path';
    import {syncBuiltinESMExports} from 'node:module';
    import {DatabaseSync} from 'node:sqlite';
    const [copy, restored, mode] = process.argv.slice(1);
    let raced = false;
    function mutate(path) {
      const db = new DatabaseSync(path);
      try { db.exec(\"UPDATE app_settings SET value_json='\\\"changed-after-hash\\\"' WHERE key='integrity-fixture'\"); }
      finally { db.close(); }
    }
    if (mode === 'after-open') {
      const originalOpen = fsPromises.open;
      fsPromises.open = async function(path, ...args) {
        const file = await originalOpen.call(this, path, ...args);
        if (!raced && path === copy) {
          raced = true;
          fs.renameSync(copy, copy + '.original');
          fs.copyFileSync(copy + '.original', copy);
          mutate(copy);
        }
        return file;
      };
    } else {
      const originalStream = fs.createReadStream;
      fs.createReadStream = function(path, ...args) {
        const stream = originalStream.call(this, path, ...args);
        if (!raced) stream.once('end', () => {
          raced = true;
          assert.equal(basename(path), 'source.sqlite');
          if (process.platform !== 'win32') {
            assert.equal(fs.statSync(dirname(path)).mode & 0o777, 0o700);
            assert.equal(fs.statSync(path).mode & 0o777, 0o400);
          }
          if (mode === 'replace-after-hash') {
            fs.renameSync(copy, copy + '.original');
            fs.copyFileSync(copy + '.original', copy);
          }
          mutate(copy);
        });
        return stream;
      };
    }
    syncBuiltinESMExports();
    process.argv = [process.execPath, 'scripts/restore.mjs', '--from', copy, '--to', restored];
    await import('./scripts/restore.mjs');
    assert.equal(raced, true, 'the deterministic race must run');
  `;
  return execute(process.execPath, ['--input-type=module', '-e', script, copy, restored, mode], {cwd: root});
}

for (const mode of ['modify-after-hash', 'replace-after-hash', 'after-open']) {
  test(`restauração usa os bytes verificados mesmo com troca concorrente: ${mode}`, async t => {
    const {dir, copy, restored} = await fixture(t);
    const manifest = JSON.parse(await readFile(`${copy}.manifest.json`, 'utf8'));
    const {stdout, stderr} = await restoreWithRace(copy, restored, mode);
    assert.equal(JSON.parse(stdout).ok, true);
    assert.equal(storedValue(copy), 'changed-after-hash');
    assert.notEqual(await fileHash(copy), manifest.sha256);
    assert.equal(storedValue(restored), VALUE);
    const result = JSON.parse(stdout);
    assert.equal(result.sha256, await fileHash(restored));
    assert.equal(result.sessionsRevoked, true);
    const db = new DatabaseSync(restored, {readOnly: true});
    try {
      assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
      const audit = db.prepare("SELECT actor_id,metadata_json FROM audit_events WHERE action='system.restored'").all();
      assert.equal(audit.length, 1);
      assert.equal(audit[0].actor_id, null);
      assert.deepEqual(JSON.parse(audit[0].metadata_json), {sessionsRevoked: true});
    } finally { db.close(); }
    assert.doesNotMatch(stdout + stderr, /fixture-(?:password|session|csrf)-never-log/u);
    if (process.platform !== 'win32') {
      assert.equal((await lstat(restored)).mode & 0o777, 0o600);
      assert.equal((await lstat(`${restored}.manifest.json`)).mode & 0o777, 0o600);
    }
    await noStagingFiles(dir);
  });
}

test('restauração ignora WAL e outros sidecars não cobertos pelo manifesto', async t => {
  const {dir, copy, restored} = await fixture(t);
  const writer = new DatabaseSync(copy);
  try {
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE);');
    const manifest = JSON.parse(await readFile(`${copy}.manifest.json`, 'utf8'));
    manifest.sha256 = await fileHash(copy);
    await writeFile(`${copy}.manifest.json`, JSON.stringify(manifest));
    writer.prepare("UPDATE app_settings SET value_json=? WHERE key='integrity-fixture'").run(JSON.stringify('unverified-wal-value'));
    assert.equal(storedValue(copy), 'unverified-wal-value');
    assert.equal(await fileHash(copy), manifest.sha256, 'the main file still matches, but the live WAL does not belong to the manifest');
    const journal = Buffer.from('unverified journal fixture');
    await writeFile(`${copy}-journal`, journal);
    const walHash = await fileHash(`${copy}-wal`);
    // Also introduce a valid, unverified WAL beside the private copy exactly
    // after hashing. This proves SQLite honors immutable=1 rather than silently
    // dropping the URI parameters and reading adjacent WAL pages.
    let sidecarsIntroduced = false;
    const originalStream = fs.createReadStream;
    const mock = t.mock.method(fs, 'createReadStream', function(path, ...args) {
      const stream = originalStream.call(this, path, ...args);
      if (!sidecarsIntroduced && path.endsWith('source.sqlite')) stream.once('end', () => {
        sidecarsIntroduced = true;
        for (const suffix of ['-wal', '-shm']) fs.copyFileSync(copy + suffix, path + suffix);
      });
      return stream;
    });
    syncBuiltinESMExports();
    try { await createSnapshot(copy, restored, {restore: true}); }
    finally { mock.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(sidecarsIntroduced, true);
    assert.equal(storedValue(restored), VALUE);
    assert.equal(await fileHash(copy), manifest.sha256);
    assert.equal(await fileHash(`${copy}-wal`), walHash);
    assert.deepEqual(await readFile(`${copy}-journal`), journal);
    for (const suffix of ['-wal', '-shm', '-journal']) await assertAbsent(restored + suffix);
    await noStagingFiles(dir);
  } finally { writer.close(); }
});

test('restauração rejeita manifesto inválido ou hash divergente sem publicar nem deixar cópia temporária', async t => {
  const {dir, copy, restored} = await fixture(t);
  const manifest = JSON.parse(await readFile(`${copy}.manifest.json`, 'utf8'));
  await writeFile(`${copy}.manifest.json`, JSON.stringify({...manifest, sha256: '0'.repeat(64)}));
  await assert.rejects(createSnapshot(copy, restored, {restore: true}), /não corresponde ao manifesto/u);
  await assertAbsent(restored);
  await assertAbsent(`${restored}.manifest.json`);
  await noStagingFiles(dir);
  const secret = 'manifest-secret-never-log';
  await writeFile(`${copy}.manifest.json`, secret);
  await assert.rejects(execute(process.execPath, ['scripts/restore.mjs', '--from', copy, '--to', restored], {cwd: root}), error => {
    assert.equal(error.stdout, '');
    assert.match(error.stderr, /manifesto do backup é inválido/u);
    assert.equal(error.stderr.includes(secret), false);
    return true;
  });
  await assertAbsent(restored);
  await noStagingFiles(dir);
});

test('restauração preserva destino, manifesto e sidecars existentes', async t => {
  const {dir, copy} = await fixture(t);
  let index = 0;
  for (const suffix of ['', '.manifest.json', '-wal', '-shm', '-journal']) {
    const destination = join(dir, `existing-${index++}.sqlite`), existing = destination + suffix;
    const preserved = Buffer.from(`must remain unchanged: ${suffix}`);
    await writeFile(existing, preserved);
    await assert.rejects(createSnapshot(copy, destination, {restore: true}), /destino já existe/u);
    assert.deepEqual(await readFile(existing), preserved);
    if (suffix) await assertAbsent(destination);
    if (suffix !== '.manifest.json') await assertAbsent(`${destination}.manifest.json`);
  }
  await noStagingFiles(dir);
});

test('origem e manifesto simbólicos são rejeitados e destino simbólico é preservado', {skip: process.platform === 'win32'}, async t => {
  const {dir, copy, restored} = await fixture(t);
  const alias = join(dir, 'alias.sqlite');
  await symlink(copy, alias);
  await assert.rejects(createSnapshot(alias, restored, {restore: true}), /arquivo regular/u);
  const manifestPath = `${copy}.manifest.json`, realManifest = join(dir, 'original-manifest.json');
  await fsPromises.rename(manifestPath, realManifest);
  await symlink(realManifest, manifestPath);
  await assert.rejects(createSnapshot(copy, restored, {restore: true}), /arquivo regular/u);
  await fsPromises.unlink(manifestPath);
  await fsPromises.rename(realManifest, manifestPath);
  const hash = await fileHash(copy);
  await symlink(copy, restored);
  await assert.rejects(createSnapshot(copy, restored, {restore: true}), /destino já existe/u);
  assert.equal((await lstat(restored)).isSymbolicLink(), true);
  assert.equal(await fileHash(copy), hash);
  await noStagingFiles(dir);
});

for (const suffix of ['', '.manifest.json']) {
  test(`publicação exclusiva preserva criação concorrente de ${suffix || 'banco'}`, async t => {
    const {dir, copy, restored} = await fixture(t);
    const collision = restored + suffix, preserved = 'concurrent-file-must-survive';
    let raced = false;
    const originalLink = fsPromises.link;
    const mock = t.mock.method(fsPromises, 'link', async function(source, target) {
      if (target === collision) {
        raced = true;
        await writeFile(collision, preserved, {flag: 'wx', mode: 0o600});
      }
      return originalLink.call(this, source, target);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(createSnapshot(copy, restored, {restore: true}), error => {
        assert.equal(error.code, 'EEXIST');
        if (suffix) assert.match(error.message, /banco foi preservado/u);
        return true;
      });
    } finally { mock.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(raced, true);
    assert.equal(await readFile(collision, 'utf8'), preserved);
    if (suffix) assert.equal(storedValue(restored), VALUE);
    else await assertAbsent(`${restored}.manifest.json`);
    await noStagingFiles(dir);
  });
}

test('troca por symlink entre lstat e open é recusada sem ler a origem substituta', {skip: process.platform === 'win32'}, async t => {
  const {dir, copy, restored} = await fixture(t);
  const alternate = join(dir, 'alternate.sqlite');
  await fsPromises.copyFile(copy, alternate);
  const originalOpen = fsPromises.open;
  let raced = false;
  const mock = t.mock.method(fsPromises, 'open', async function(path, ...args) {
    if (!raced && path === copy) {
      raced = true;
      await fsPromises.rename(copy, `${copy}.original`);
      await symlink(alternate, copy);
    }
    return originalOpen.call(this, path, ...args);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(createSnapshot(copy, restored, {restore: true})); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(raced, true);
  await assertAbsent(restored);
  await assertAbsent(`${restored}.manifest.json`);
  assert.equal(storedValue(alternate), VALUE);
  await noStagingFiles(dir);
});
