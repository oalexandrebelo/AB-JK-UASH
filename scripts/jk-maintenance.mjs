import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {chmod, lstat, mkdir, mkdtemp, open, readdir, rename, rm, statfs, writeFile} from 'node:fs/promises';
import {basename, dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createSnapshot, fileHash, inspectDatabase} from './storage.mjs';

const BACKUP_NAME = /^ab-jk-uash-\d{8}T\d{9}Z-[a-f0-9]{8}\.sqlite$/u;
const STATUS_FORMAT = 'ab-jk-maintenance-v1';
const PROOF_FORMAT = 'ab-jk-restore-check-v1';
const GRACE_MS = 15 * 60 * 1000;

function integer(value, fallback, min, max, name) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} fora do intervalo permitido.`);
  return parsed;
}

export function maintenanceConfiguration(env = process.env) {
  const dbPath = resolve(env.DB_PATH || '/data/ab-jk-uash.sqlite');
  return {
    dbPath,
    backupDir: join(dirname(dbPath), 'backups'),
    stateDir: join(dirname(dbPath), 'maintenance'),
    intervalMs: integer(env.JK_BACKUP_INTERVAL_SECONDS, 21_600, 60, 604_800, 'JK_BACKUP_INTERVAL_SECONDS') * 1000,
    keep: integer(env.JK_BACKUP_KEEP, 28, 2, 10_000, 'JK_BACKUP_KEEP'),
  };
}

async function privateDirectory(path) {
  await mkdir(path, {recursive: true, mode: 0o700});
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('O diretório de manutenção deve ser local e regular.');
  await chmod(path, 0o700);
}

async function readJson(path) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 65_536) throw new Error('Metadados de manutenção inválidos.');
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}

async function writeStatus(config, value) {
  await privateDirectory(config.stateDir);
  const temporary = join(config.stateDir, `.status-${randomUUID()}.json`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {flag: 'wx', mode: 0o600});
    await rename(temporary, join(config.stateDir, 'status.json'));
  } finally { await rm(temporary, {force: true}); }
}

function openReadOnly(path) {
  return new DatabaseSync(path, {readOnly: true, timeout: 5000});
}

/** A real restore into an isolated disposable database; the live DB is untouched. */
export async function proveRestore(snapshot, backupDir) {
  const temporary = await mkdtemp(join(backupDir, '.restore-check-'));
  let database;
  try {
    await chmod(temporary, 0o700);
    const restored = await createSnapshot(snapshot.file, join(temporary, 'restored.sqlite'), {restore: true});
    database = openReadOnly(restored.file);
    const metadata = inspectDatabase(database);
    const sessions = database.prepare('SELECT count(*) AS count FROM sessions').get().count;
    const restoreEvents = database.prepare("SELECT count(*) AS count FROM audit_events WHERE action='system.restored'").get().count;
    if (sessions !== 0 || restoreEvents < 1 || restored.sessionsRevoked !== true) throw new Error('A restauração não revogou as sessões ou não registrou auditoria.');
    const proof = {
      format: PROOF_FORMAT,
      checkedAt: new Date().toISOString(),
      backup: basename(snapshot.file),
      backupSha256: snapshot.sha256,
      restoredSha256: restored.sha256,
      schemaVersion: metadata.schemaVersion,
      integrity: 'ok',
      foreignKeys: 'ok',
      sessionsRevoked: true,
      restoreEventPresent: true,
    };
    await writeFile(`${snapshot.file}.restore-check.json`, `${JSON.stringify(proof, null, 2)}\n`, {flag: 'wx', mode: 0o600});
    return proof;
  } finally {
    try { database?.close(); } finally { await rm(temporary, {recursive: true, force: true}); }
  }
}

/** Remove only this script's old, verified triplets. Unknown files stay intact. */
export async function pruneBackups(backupDir, keep) {
  integer(keep, undefined, 2, 10_000, 'JK_BACKUP_KEEP');
  const verified = [];
  for (const name of (await readdir(backupDir)).filter(name => BACKUP_NAME.test(name)).sort().reverse()) {
    const file = join(backupDir, name);
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      const [manifest, proof] = await Promise.all([readJson(`${file}.manifest.json`), readJson(`${file}.restore-check.json`)]);
      if (manifest.format !== 'ab-uash-sqlite-backup-v1' || proof.format !== PROOF_FORMAT || proof.backup !== name || proof.backupSha256 !== manifest.sha256 || proof.sessionsRevoked !== true || proof.restoreEventPresent !== true || proof.integrity !== 'ok' || proof.foreignKeys !== 'ok' || await fileHash(file) !== manifest.sha256) continue;
      verified.push({file, sha256: manifest.sha256});
    } catch { /* Never delete an incomplete, unrecognized or unreadable backup. */ }
  }
  let removed = 0;
  for (const candidate of verified.slice(keep)) {
    // Verify bytes before deletion too; corrupt archives remain for inspection.
    if (await fileHash(candidate.file) !== candidate.sha256) continue;
    await rm(candidate.file);
    await rm(`${candidate.file}.manifest.json`);
    await rm(`${candidate.file}.restore-check.json`);
    removed++;
  }
  return {retained: verified.length - removed, removed};
}

export async function runMaintenance(config = maintenanceConfiguration()) {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Manutenção requer Node.js 24.');
  await privateDirectory(config.backupDir);
  await privateDirectory(config.stateDir);
  const startedAt = new Date().toISOString();
  try {
    const liveInfo = await lstat(config.dbPath);
    if (!liveInfo.isFile() || liveInfo.isSymbolicLink()) throw new Error('O banco ativo deve ser um arquivo regular.');
    const free = await statfs(config.backupDir);
    // A snapshot and its temporary restore coexist; keep a modest reserve.
    if (free.bavail * free.bsize < liveInfo.size * 3 + 64 * 1024 * 1024) throw new Error('Espaço insuficiente para backup e restauração de prova.');
    const stamp = startedAt.replaceAll(/[-:.]/gu, '');
    const destination = join(config.backupDir, `ab-jk-uash-${stamp}-${randomUUID().slice(0, 8)}.sqlite`);
    const snapshot = await createSnapshot(config.dbPath, destination);
    const proof = await proveRestore(snapshot, config.backupDir);
    // Retention starts only after the new snapshot has passed actual restore.
    const retention = await pruneBackups(config.backupDir, config.keep);
    const finishedAt = new Date().toISOString();
    const status = {
      format: STATUS_FORMAT, ok: true, startedAt, finishedAt,
      nextRunAt: new Date(Date.parse(finishedAt) + config.intervalMs).toISOString(),
      backup: basename(snapshot.file), sha256: snapshot.sha256,
      restoreCheckedAt: proof.checkedAt, restoreVerified: true,
      intervalMs: config.intervalMs, keep: config.keep, retention,
    };
    await writeStatus(config, status);
    return status;
  } catch (error) {
    // Keep secrets, database values and arbitrary error messages out of status.
    await writeStatus(config, {format: STATUS_FORMAT, ok: false, startedAt, finishedAt: new Date().toISOString(), error: 'backup_or_restore_failed'});
    throw error;
  }
}

/** Offline liveness: recent successful backup, proof, bytes and SQLite integrity. */
export async function checkMaintenanceHealth(config = maintenanceConfiguration(), now = Date.now()) {
  const status = await readJson(join(config.stateDir, 'status.json'));
  const finished = Date.parse(status.finishedAt);
  if (status.format !== STATUS_FORMAT || status.ok !== true || status.restoreVerified !== true || !BACKUP_NAME.test(status.backup || '') || !Number.isFinite(finished) || finished > now + GRACE_MS || now - finished > config.intervalMs + GRACE_MS) {
    throw new Error('Manutenção sem backup restaurável recente.');
  }
  const file = join(config.backupDir, status.backup);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Backup recente indisponível.');
  const [manifest, proof] = await Promise.all([readJson(`${file}.manifest.json`), readJson(`${file}.restore-check.json`)]);
  if (manifest.sha256 !== status.sha256 || proof.format !== PROOF_FORMAT || proof.backup !== status.backup || proof.backupSha256 !== status.sha256 || proof.sessionsRevoked !== true || proof.restoreEventPresent !== true || proof.integrity !== 'ok' || proof.foreignKeys !== 'ok' || await fileHash(file) !== status.sha256) throw new Error('Backup recente não corresponde à prova.');
  const db = openReadOnly(file);
  try { inspectDatabase(db); } finally { db.close(); }
  return {ok: true, backup: status.backup, restoreVerified: true};
}

async function watch(config) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    while (!controller.signal.aborted) {
      let waitMs = config.intervalMs;
      try {
        const result = await runMaintenance(config);
        console.log(JSON.stringify({ok: true, operation: 'backup_and_restore_check', backup: result.backup, retention: result.retention}));
      } catch {
        console.error('AB-JK-UASH: manutenção falhou; verifique armazenamento e restauração.');
        waitMs = Math.min(config.intervalMs, 300_000);
      }
      try { await delay(waitMs, undefined, {signal: controller.signal}); }
      catch (error) { if (error.name !== 'AbortError') throw error; }
    }
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !['once', 'watch', 'health'].includes(args[0])) throw new Error('Uso: node scripts/jk-maintenance.mjs once|watch|health');
    const config = maintenanceConfiguration();
    if (args[0] === 'watch') await watch(config);
    else console.log(JSON.stringify(args[0] === 'health' ? await checkMaintenanceHealth(config) : await runMaintenance(config)));
  } catch {
    console.error('AB-JK-UASH: manutenção não concluída. Consulte docs/operations-jk.md.');
    process.exitCode = 1;
  }
}
