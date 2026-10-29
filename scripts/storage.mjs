import {DatabaseSync, backup} from 'node:sqlite';
import {createHash, randomUUID} from 'node:crypto';
import {constants, createReadStream} from 'node:fs';
import {mkdir, mkdtemp, link, chmod, lstat, open, rm, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const SQLITE_SIDECARS = ['-wal', '-shm', '-journal'];
const MANIFEST_FORMAT = 'ab-uash-sqlite-backup-v1';

export function parseOptions(args, allowed) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!allowed.includes(key) || !args[i + 1] || args[i + 1].startsWith('--') || options[key] !== undefined) {
      throw new Error(`Argumento inválido: ${key}. Permitidos: ${allowed.join(', ')}.`);
    }
    options[key] = args[++i];
  }
  return options;
}

export async function ensureNewFile(path) {
  try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error(`O destino já existe e será preservado: ${path}`);
}

export function inspectDatabase(db) {
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;');
  const integrity = db.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('Falha na verificação de integridade SQLite.');
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('O banco tem referências inválidas.');
  const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name));
  for (const name of ['users', 'sessions', 'audit_events', 'app_settings']) if (!tables.has(name)) throw new Error('Arquivo não reconhecido como banco AB-UASH.');
  return {schemaVersion: db.prepare('PRAGMA user_version').get().user_version, tables: [...tables].filter(name => !name.startsWith('sqlite_')).sort()};
}

export async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function openRegularFile(path, expected) {
  const before = expected || await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('A origem deve ser um arquivo regular de banco de dados.');
  // Keep the opened inode for the entire copy. O_NONBLOCK also prevents a FIFO
  // substituted after lstat from hanging the command before fstat can reject it.
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('A origem mudou durante a leitura. Tente novamente com um backup estável.');
    }
    return file;
  } catch (error) { await file.close(); throw error; }
}

async function readManifest(source) {
  const file = await openRegularFile(`${source}.manifest.json`);
  try {
    if ((await file.stat()).size > 64 * 1024) throw new Error('O manifesto do backup é inválido.');
    let manifest;
    try { manifest = JSON.parse(await file.readFile('utf8')); }
    catch { throw new Error('O manifesto do backup é inválido.'); }
    if (manifest?.format !== MANIFEST_FORMAT || typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(manifest.sha256)) {
      throw new Error('O backup não corresponde ao manifesto SHA-256.');
    }
    return manifest;
  } finally { await file.close(); }
}

async function stageVerifiedSource(source, staged, sourceInfo, manifest) {
  const input = await openRegularFile(source, sourceInfo);
  let output;
  try {
    output = await open(staged, 'wx', 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    // Copy only from this descriptor, never by reopening the public source path.
    // Hash the finished copy so concurrent edits either match the manifest's
    // exact bytes or fail verification; no source sidecars are copied.
    while (true) {
      const {bytesRead} = await input.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      let written = 0;
      while (written < bytesRead) {
        const {bytesWritten} = await output.write(buffer, written, bytesRead - written, position + written);
        if (!bytesWritten) throw new Error('Não foi possível copiar o backup completo.');
        written += bytesWritten;
      }
      position += bytesRead;
    }
    await output.chmod(0o400);
  } finally { try { await output?.close(); } finally { await input.close(); } }
  if (await fileHash(staged) !== manifest.sha256) throw new Error('O backup não corresponde ao manifesto SHA-256.');
  const uri = pathToFileURL(staged);
  uri.searchParams.set('mode', 'ro');
  uri.searchParams.set('immutable', '1');
  // Pass a URI string: a URL object is converted to a filesystem path by Node
  // and loses these SQLite parameters. The private copy stays unchanged.
  return uri.href;
}

async function ensureNewDestination(path) {
  for (const candidate of [path, `${path}.manifest.json`, ...SQLITE_SIDECARS.map(suffix => path + suffix)]) {
    await ensureNewFile(candidate);
  }
}

export async function createSnapshot(source, destination, {restore = false} = {}) {
  const from = resolve(source), to = resolve(destination);
  if (from === to) throw new Error('Origem e destino devem ser diferentes.');
  const sourceInfo = await lstat(from);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error('A origem deve ser um arquivo regular de banco de dados.');
  await ensureNewDestination(to);
  const sourceManifest = restore ? await readManifest(from) : null;
  await mkdir(dirname(to), {recursive: true, mode: 0o700});
  const staging = await mkdtemp(join(dirname(to), '.ab-uash-snapshot-'));
  const temporary = join(staging, 'snapshot.sqlite');
  let sourceDb, targetDb;
  let published = false;
  try {
    await chmod(staging, 0o700);
    await writeFile(temporary, '', {flag: 'wx', mode: 0o600});
    const sourcePath = restore ? await stageVerifiedSource(from, join(staging, 'source.sqlite'), sourceInfo, sourceManifest) : from;
    sourceDb = new DatabaseSync(sourcePath, {readOnly: true, timeout: 5000});
    inspectDatabase(sourceDb);
    const pages = await backup(sourceDb, temporary);
    sourceDb.close(); sourceDb = null;
    targetDb = new DatabaseSync(temporary, {timeout: 5000});
    targetDb.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;');
    if (restore) {
      if (![1, 2].includes(inspectDatabase(targetDb).schemaVersion)) {
        throw new Error('A versão do banco não é compatível com este aplicativo. Use a mesma versão do aplicativo que criou o backup ou uma versão compatível.');
      }
      targetDb.exec('BEGIN IMMEDIATE');
      try {
        targetDb.exec('DELETE FROM sessions');
        targetDb.prepare('INSERT INTO audit_events(id,actor_id,action,resource_type,resource_id,metadata_json,created_at) VALUES(?,NULL,?,?,NULL,?,?)')
          .run(randomUUID(), 'system.restored', 'database', JSON.stringify({sessionsRevoked: true}), new Date().toISOString());
        targetDb.exec('COMMIT');
      } catch (error) { targetDb.exec('ROLLBACK'); throw error; }
    }
    const metadata = inspectDatabase(targetDb);
    targetDb.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
    targetDb.close(); targetDb = null;
    await chmod(temporary, 0o600);
    const manifest = {format: MANIFEST_FORMAT, createdAt: new Date().toISOString(), sha256: await fileHash(temporary), pages, ...metadata, sessionsRevoked: restore};
    const stagedManifest = join(staging, 'snapshot.manifest.json');
    await writeFile(stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`, {flag: 'wx', mode: 0o600});
    await ensureNewDestination(to);
    // Hard-link creation is exclusive: an existing destination can never be replaced.
    await link(temporary, to);
    published = true;
    await link(stagedManifest, `${to}.manifest.json`);
    return {file: to, manifest: `${to}.manifest.json`, ...manifest};
  } catch (error) {
    if (published) error.message = `${error.message} O banco foi preservado em ${to}; não sobrescreva esse arquivo.`;
    throw error;
  } finally {
    try { sourceDb?.close(); } finally {
      try { targetDb?.close(); } finally { await rm(staging, {recursive: true, force: true}); }
    }
  }
}
