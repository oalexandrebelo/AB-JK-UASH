import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, realpathSync, openSync, closeSync, fchmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { ApiError } from './errors.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
const rawPaths = new WeakMap();
const sqliteQueues = new Map();

export function openDatabase(path) {
  const file = path === ':memory:' ? path : resolve(path);
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    // SQLite derives WAL/SHM permissions from the database when opening them.
    // Restrict the file before any schema or customer data reaches those files.
    const descriptor = openSync(file, 'a', 0o600);
    try { fchmodSync(descriptor, 0o600); } finally { closeSync(descriptor); }
    const actual = realpathSync(file);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try { chmodSync(actual + suffix, 0o600); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  const db = new DatabaseSync(file, { timeout: 5000 });
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA trusted_schema = OFF;');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > 2) {
      throw new Error('O banco foi criado por uma versão mais recente do aplicativo.');
    }
    if (version === 0) transaction(db, () => {
      db.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL CHECK(length(name) BETWEEN 2 AND 80),
          email TEXT NOT NULL COLLATE NOCASE UNIQUE,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('admin','manager','operator','viewer')),
          active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE sessions (
          token_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          csrf_token TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX sessions_user ON sessions(user_id);
        CREATE INDEX sessions_expiry ON sessions(expires_at);
        CREATE TABLE audit_events (
          id TEXT PRIMARY KEY,
          actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          action TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          resource_id TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX audit_created ON audit_events(created_at DESC);
        CREATE TABLE app_settings (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE idempotency_keys (
          actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          idempotency_key TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          response_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(actor_id, idempotency_key)
        ) STRICT;
        PRAGMA user_version = 1;
      `);
    });
    rawPaths.set(db, file === ':memory:' ? db : realpathSync(file));
    return db;
  } catch (error) { db.close(); throw error; }
}

// Maintenance callers with a raw SQLite connection remain synchronous.
// Application stores delegate to the queued asynchronous transaction implementation.
export function transaction(db, operation) {
  if (db.isAsyncStore) return db.transaction(operation);
  if (db.isTransaction) throw new Error('Transações aninhadas não são permitidas.');
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    if (result && typeof result.then === 'function') throw new Error('A transação deve ser síncrona.');
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

// Callers pass identifiers and a small allowlisted metadata object, never raw request bodies.
export function audit(db, { actorId = null, action, resourceType, resourceId = null, metadata = {} }) {
  return db.prepare('INSERT INTO audit_events(id, actor_id, action, resource_type, resource_id, metadata_json, created_at) VALUES(?,?,?,?,?,?,?)')
    .run(randomUUID(), actorId, action, resourceType, resourceId, JSON.stringify(metadata), new Date().toISOString());
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

// The mutation, audit entry, and replay response commit together.
export function idempotentWrite(db, options, operation) {
  if (db.isAsyncStore) return idempotentWriteAsync(db, options, operation);
  const { actorId, key, method, path, body, authorize } = options;
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/u.test(key)) {
    throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Envie Idempotency-Key com 8 a 128 letras, números, hífens ou sublinhados.');
  }
  const hash = createHash('sha256').update(JSON.stringify({ method, path, body: canonical(body) })).digest('hex');
  return transaction(db, () => {
    // Replays must satisfy current session and role authorization too. The body
    // may have arrived after a concurrent logout, role change, or deactivation.
    if (authorize) authorize();
    const prior = db.prepare('SELECT request_hash, response_json FROM idempotency_keys WHERE actor_id = ? AND idempotency_key = ?').get(actorId, key);
    if (prior) {
      if (prior.request_hash !== hash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Esta chave já foi usada com outro conteúdo.');
      return { ...JSON.parse(prior.response_json), replayed: true };
    }
    const result = operation();
    db.prepare('INSERT INTO idempotency_keys(actor_id,idempotency_key,request_hash,response_json,created_at) VALUES(?,?,?,?,?)')
      .run(actorId, key, hash, JSON.stringify(result), new Date().toISOString());
    return result;
  });
}

async function idempotentWriteAsync(db, { actorId, key, method, path, body, authorize }, operation) {
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/u.test(key)) throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Envie Idempotency-Key com 8 a 128 letras, números, hífens ou sublinhados.');
  const hash = createHash('sha256').update(JSON.stringify({ method, path, body: canonical(body) })).digest('hex');
  return db.transaction(async () => {
    if (authorize) await authorize();
    const prior = await db.prepare('SELECT request_hash,response_json FROM idempotency_keys WHERE actor_id=? AND idempotency_key=?').get(actorId, key);
    if (prior) {
      if (prior.request_hash !== hash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Esta chave já foi usada com outro conteúdo.');
      return { ...JSON.parse(prior.response_json), replayed: true };
    }
    const result = await operation();
    await db.prepare('INSERT INTO idempotency_keys(actor_id,idempotency_key,request_hash,response_json,created_at) VALUES(?,?,?,?,?)').run(actorId, key, hash, JSON.stringify(result), new Date().toISOString());
    return result;
  });
}

const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER), MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
function safeInteger(value, big = false) {
  const integer = BigInt(value);
  if (big) return integer;
  if (integer < MIN_SAFE || integer > MAX_SAFE) throw new ApiError(422, 'AMOUNT_LIMIT', 'O total excede o limite numérico permitido.');
  return Number(integer);
}
function normalizeRow(row, big) {
  return row && Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? safeInteger(value, big) : typeof value === 'boolean' ? Number(value) : value]));
}
function parameters(values) {
  return values.map(value => {
    if (typeof value === 'number' && (!Number.isSafeInteger(value))) throw new ApiError(422, 'AMOUNT_LIMIT', 'O valor excede o limite numérico permitido.');
    if (typeof value === 'boolean') return Number(value);
    if (value instanceof Uint8Array) return Buffer.from(value);
    return value;
  });
}

// Scan SQL rather than replacing question marks in strings, identifiers, comments,
// or dollar-quoted literals. No statement names are used with transaction poolers.
export function postgresSql(sql, expectedParameters) {
  let result = '', i = 0, count = 0;
  while (i < sql.length) {
    const rest = sql.slice(i), char = sql[i];
    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', i + 2); const until = end < 0 ? sql.length : end + 1;
      result += sql.slice(i, until); i = until; continue;
    }
    if (rest.startsWith('/*')) {
      const start = i; i += 2; let depth = 1;
      while (i < sql.length && depth) { if (sql.startsWith('/*', i)) { depth++; i += 2; } else if (sql.startsWith('*/', i)) { depth--; i += 2; } else i++; }
      if (depth) throw new Error('Comentário SQL não encerrado.');
      result += sql.slice(start, i); continue;
    }
    const dollar = rest.match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/u)?.[0];
    if (dollar) {
      const end = sql.indexOf(dollar, i + dollar.length);
      if (end < 0) throw new Error('Literal SQL não encerrado.');
      const until = end + dollar.length; result += sql.slice(i, until); i = until; continue;
    }
    if (char === "'" || char === '"') {
      const start = i++, escaped = char === "'" && /(?:^|[^\w])e$/iu.test(sql.slice(0, start)); let ended = false;
      while (i < sql.length) {
        if (escaped && sql[i] === '\\') { i += 2; continue; }
        if (sql[i++] === char) { if (sql[i] === char) { i++; continue; } ended = true; break; }
      }
      if (!ended) throw new Error('Literal SQL não encerrado.');
      result += sql.slice(start, i); continue;
    }
    if (char === '?') { result += `$${++count}`; i++; continue; }
    const word = rest.match(/^[A-Za-z_][A-Za-z_0-9]*/u)?.[0];
    if (word) { result += word.toUpperCase() === 'LIKE' ? 'ILIKE' : word; i += word.length; continue; }
    result += char; i++;
  }
  if (expectedParameters !== undefined && count !== expectedParameters) throw new Error('Quantidade de parâmetros SQL incompatível.');
  return result;
}

function queue() {
  let tail = Promise.resolve();
  return {
    add(operation) { const result = tail.then(operation); tail = result.catch(() => {}); return result; },
    drain() { return tail; },
  };
}

export function sqliteStore(raw) { return new AsyncStore({ raw }); }

class AsyncStore {
  isAsyncStore = true;
  constructor({ raw, pool, pg, schema }) {
    this.raw = raw; this.pool = pool; this.pg = pg; this.schema = schema;
    this.mode = raw ? 'local' : 'postgres';
    this.context = new AsyncLocalStorage(); this.closed = false; this.closing = false;
    if (raw) {
      this.queueKey = rawPaths.get(raw) || raw;
      const shared = sqliteQueues.get(this.queueKey) || {queue: queue(), users: 0};
      shared.users++; sqliteQueues.set(this.queueKey, shared); this.serial = shared.queue;
    }
    this.pending = new Set();
    if (schema) this.lockKey = createHash('sha256').update(`ab-uash:${schema}`).digest().readBigInt64BE().toString();
  }
  initialize(operation) {
    if (!this.raw) return Promise.reject(new Error('Migrações PostgreSQL não são executadas pelo runtime.'));
    if (this.closed || this.closing) return Promise.reject(new Error('O armazenamento está encerrado.'));
    return this.track(this.serial.add(operation));
  }
  prepare(sql) {
    let big = false;
    return {
      setReadBigInts(value) { big = Boolean(value); },
      get: (...values) => this.query(sql, values, 'get', big),
      all: (...values) => this.query(sql, values, 'all', big),
      run: (...values) => this.query(sql, values, 'run', big),
    };
  }
  exec(sql) {
    if (!this.raw) return Promise.reject(new Error('DDL de PostgreSQL deve ser aplicado por migrações, fora do runtime.'));
    return this.query(sql, [], 'exec');
  }
  async query(sql, values, method, big = false) {
    const ctx = this.context.getStore();
    if (ctx && !ctx.accepting) throw new Error('O contexto da transação já foi encerrado.');
    if (this.closed || (this.closing && !ctx)) throw new Error('O armazenamento está encerrado.');
    if (!ctx) return this.inTransaction(() => this.query(sql, values, method, big), { readOnly: method === 'get' || method === 'all' });
    return ctx.queue.add(async () => {
      if (ctx.failed) throw ctx.failed;
      try {
        // Validation failures belong to the same transaction as SQL failures.
        // Catching one in a caller must not commit earlier queued mutations.
        const params = parameters(values);
        if (ctx.readOnly && (method === 'run' || method === 'exec')) throw new Error('Escritas não são permitidas em snapshot de leitura.');
        if (this.raw) {
          if (method === 'exec') return this.raw.exec(sql);
          const stmt = this.raw.prepare(sql); stmt.setReadBigInts(true);
          const result = stmt[method](...params);
          if (method === 'run') return { ...result, changes: safeInteger(result.changes), lastInsertRowid: safeInteger(result.lastInsertRowid) };
          return method === 'all' ? result.map(row => normalizeRow(row, big)) : normalizeRow(result, big);
        }
        const types = { getTypeParser: (oid, format) => [20,21,23,1700].includes(oid) && format !== 'binary'
          ? value => safeInteger(value, big) : oid === 16 ? value => Number(value === 't') : this.pg.types.getTypeParser(oid, format) };
        const result = await ctx.client.query({ text: postgresSql(sql, params.length), values: params, types });
        return method === 'run' ? { changes: result.rowCount } : method === 'all' ? result.rows : result.rows[0];
      } catch (error) { ctx.failed ||= error; throw error; }
    });
  }
  transaction(operation) { return this.inTransaction(operation, { readOnly: false }); }
  read(operation) { return this.inTransaction(operation, { readOnly: true }); }
  inTransaction(operation, { readOnly }) {
    const current = this.context.getStore();
    if (current) return Promise.reject(new Error(current.accepting ? 'Transações aninhadas não são permitidas.' : 'O contexto da transação já foi encerrado.'));
    if (this.closed || this.closing) return Promise.reject(new Error('O armazenamento está encerrado.'));
    const operationPromise = this.raw ? this.serial.add(() => this.performTransaction(operation, readOnly)) : this.performTransaction(operation, readOnly);
    return this.track(operationPromise);
  }
  track(operationPromise) {
    this.pending.add(operationPromise); operationPromise.then(() => this.pending.delete(operationPromise), () => this.pending.delete(operationPromise));
    return operationPromise;
  }
  async performTransaction(operation, readOnly) {
    const ctx = { accepting: true, readOnly, queue: queue(), client: null, failed: null };
    let begun = false;
    try {
      if (this.raw) {
        if (readOnly) this.raw.exec('PRAGMA query_only=ON');
        this.raw.exec(readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE'); begun = true;
      }
      else {
        ctx.client = await this.pool.connect();
        await ctx.client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN'); begun = true;
        await ctx.client.query("SELECT set_config('search_path',$1,true),set_config('lock_timeout','5000',true),set_config('statement_timeout','15000',true)", [`"${this.schema}",pg_catalog`]);
        if (!readOnly) await ctx.client.query('SELECT pg_advisory_xact_lock($1::bigint)', [this.lockKey]);
      }
      const value = await this.context.run(ctx, operation);
      ctx.accepting = false;
      await ctx.queue.drain();
      if (ctx.failed) throw ctx.failed;
      if (this.raw) this.raw.exec('COMMIT'); else await ctx.client.query('COMMIT');
      begun = false;
      return value;
    } catch (error) {
      ctx.accepting = false;
      await ctx.queue.drain();
      if (begun) {
        try { if (this.raw) this.raw.exec('ROLLBACK'); else await ctx.client.query('ROLLBACK'); } catch { ctx.broken = true; }
      }
      throw error;
    } finally {
      ctx.accepting = false;
      if (this.raw && readOnly) this.raw.exec('PRAGMA query_only=OFF');
      ctx.client?.release(ctx.broken);
    }
  }
  close() {
    if (this.context.getStore()?.accepting) return Promise.reject(new Error('Não é possível encerrar o armazenamento durante uma transação.'));
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      await Promise.allSettled([...this.pending]);
      if (this.raw) this.raw.close(); else await this.pool.end();
      if (this.raw) { const shared = sqliteQueues.get(this.queueKey); if (--shared.users === 0) sqliteQueues.delete(this.queueKey); }
      this.closed = true;
    })();
    return this.closePromise;
  }
}

export function postgresConnectionOptions({ databaseUrl, databaseCa, databasePoolSize = 1 }) {
  if (!Number.isInteger(databasePoolSize) || databasePoolSize < 1 || databasePoolSize > 20) throw new Error('DATABASE_POOL_SIZE deve estar entre 1 e 20.');
  let url;
  try { url = new URL(databaseUrl); } catch { throw new Error('DATABASE_URL deve ser uma conexão PostgreSQL válida.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL deve ser uma conexão PostgreSQL.');
  if (!url.hostname || url.hash || /[%/\s\\]/u.test(url.hostname)) throw new Error('DATABASE_URL deve conter um host explícito válido.');
  // pg reparses connectionString after merging options. Query parameters can
  // override its host, credentials, TLS configuration and certificate authority.
  // Pass only decoded, explicit connection fields to avoid that second parser.
  for (const key of ['host','hostaddr','port','user','password','database']) {
    if (url.searchParams.has(key)) throw new Error('DATABASE_URL não permite substituir a conexão por parâmetros da URL.');
  }
  const host = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  const local = ['localhost','127.0.0.1','::1'].includes(host);
  let user, password, database;
  try {
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.slice(1));
  } catch { throw new Error('DATABASE_URL contém uma codificação inválida.'); }
  const negotiation = url.searchParams.get('sslnegotiation');
  if (negotiation !== null && !['postgres','direct'].includes(negotiation)) throw new Error('DATABASE_URL contém uma negociação TLS inválida.');
  return {
    host, port: Number(url.port || 5432), user, password, database,
    max: databasePoolSize, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 10_000,
    application_name: 'ab-uash',
    ssl: local && !databaseCa ? false : { rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(databaseCa ? { ca: databaseCa } : {}) },
    ...(negotiation ? {sslnegotiation: negotiation} : {}),
  };
}

export async function openPostgresStore({ databaseUrl, databaseSchema = 'ab_uash', databaseCa, databasePoolSize = 1 }) {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(databaseSchema) || ['public','information_schema'].includes(databaseSchema) || databaseSchema.startsWith('pg_')) throw new Error('DATABASE_SCHEMA deve indicar um esquema privado válido.');
  const options = postgresConnectionOptions({databaseUrl,databaseCa,databasePoolSize});
  const pg = await import('pg');
  const pool = new pg.Pool(options);
  // Idle connection failures must not become unhandled EventEmitter errors.
  // pg removes that client; request failures still propagate normally.
  pool.on('error', () => {});
  const store = new AsyncStore({ pool, pg, schema: databaseSchema });
  try {
    const role = await store.prepare(`SELECT current_user AS name,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,
      has_schema_privilege(current_user,?,'CREATE') AS schema_create,
      EXISTS(SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid) AS memberships
      FROM pg_roles WHERE rolname=current_user`).get(databaseSchema);
    if (role?.name !== 'ab_uash_app' || Object.entries(role).some(([key, value]) => key !== 'name' && value)) {
      throw new Error('O runtime PostgreSQL requer a conta ab_uash_app sem privilégios administrativos ou associação a outros papéis.');
    }
    const version = await store.prepare('SELECT version FROM app_schema_version WHERE singleton=1').get();
    if (version?.version !== 1) throw new Error('Aplique as migrações PostgreSQL compatíveis antes de iniciar o aplicativo.');
    return store;
  } catch (error) { await store.close(); throw error; }
}
