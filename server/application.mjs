import { createServer } from 'node:http';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, sqliteStore, openPostgresStore, transaction, audit } from './db.mjs';
import { ApiError, assert, toPublicError } from './errors.mjs';
import * as validate from './validation.mjs';
import { hashPassword, verifyPassword, publicUser, createSession, sessionCookie, readSession, requireAuth, requireRole, requireLiveRole, verifyCsrf, createRateLimiter, tokenHash, ROLES } from './security.mjs';
import { securityHeaders, normalizePublicOrigins, validateRequestOrigin, readJson, sendJson, serveStatic } from './http.mjs';
import { migrateDomain, migrateStorage } from './domain-schema.mjs';
import { handleDomain } from './domain.mjs';
import { initializeMedia, handleMedia } from './media.mjs';
import { initializeFiscal, handleFiscal } from './fiscal.mjs';
import { publicJkProfile } from './jk-public.mjs';
import { initializeJkMigration, handleJkMigration } from './jk-migration.mjs';
import { migrateJkIntegrations, initializeJkIntegrations, handleJkIntegrations } from './jk-integrations.mjs';
import { initializeJkDeliveries, handleJkDeliveries } from './jk-deliveries.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function createApplication({
  dbPath = resolve(PROJECT_ROOT, 'data/ab-uash.sqlite'),
  distDir = resolve(PROJECT_ROOT, 'dist'),
  publicOrigin,
  databaseUrl, databaseSchema = 'ab_uash', databaseCa, databasePoolSize = 1,
  setupToken, clientAddress, fiscalEnv = process.env, fiscalTransport,
  jkIntegrationsEnv = process.env,
  secureCookies = false,
  logger = console,
  domainHandler,
} = {}) {
  publicOrigin = normalizePublicOrigins(publicOrigin);
  if (setupToken !== undefined && (typeof setupToken !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/u.test(setupToken))) throw new Error('SETUP_TOKEN deve ter 32 a 256 caracteres base64url.');
  const setupDigest = setupToken ? createHash('sha256').update(setupToken).digest() : null;
  setupToken = undefined;
  const raw = databaseUrl ? null : openDatabase(dbPath);
  const db = databaseUrl ? await openPostgresStore({databaseUrl,databaseSchema,databaseCa,databasePoolSize}) : sqliteStore(raw);
  if (raw) {
    try { await db.initialize(() => { migrateDomain(raw); initializeMedia(raw); migrateStorage(raw); initializeJkMigration(raw); migrateJkIntegrations(raw); initializeJkDeliveries(raw); }); }
    catch (error) { await db.close(); throw error; }
  }
  let fiscal;
  try { fiscal = await initializeFiscal(db, {env: fiscalEnv, transport: fiscalTransport}); } catch (error) { await db.close(); throw error; }
  let jkIntegrations;
  try { jkIntegrations = await initializeJkIntegrations(db, {env: jkIntegrationsEnv}); } catch (error) { await db.close(); throw error; }
  // A valid dummy hash keeps missing-user checks on the same costly password path.
  const dummyHash = await hashPassword(randomUUID());
  const attempts = createRateLimiter(db);
  const sessionFlags = {storageMode: db.mode, setupTokenRequired: false};
  const peer = request => tokenHash(String(clientAddress ? clientAddress(request) : request.socket?.remoteAddress || 'unknown'));
  let closing = false, closePromise;
  const requests = new Set();

  async function status(session) {
    const setupRequired = (await db.prepare('SELECT COUNT(*) AS count FROM users').get()).count === 0;
    return {
      ...sessionFlags, setupRequired, setupTokenRequired: setupRequired && Boolean(setupDigest),
      user: session?.user || null,
      ...(session ? { csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() } : {}),
    };
  }

  async function handleApi(request, pathname, url, session) {
    const method = request.method;
    if (method === 'GET' && pathname === '/api/health') return { data: { status: 'ok' } };
    if (method === 'GET' && pathname === '/api/ready') {
      await db.prepare('SELECT 1 AS ready').get();
      return { data: { status: 'ready', database: 'ok' } };
    }
    if (method === 'GET' && pathname === '/api/public/profile') return { data: await publicJkProfile(db) };
    if (method === 'GET' && ['/api/status', '/api/auth/session'].includes(pathname)) return { data: (await status(session)) };

    if (method === 'POST' && pathname === '/api/setup') {
      assert((await status(null)).setupRequired, 409, 'ALREADY_CONFIGURED', 'A configuração inicial já foi concluída.');
      const rateKey = `setup:${peer(request)}`;
      await attempts.reserve([rateKey]);
      if (setupDigest) {
        const supplied = request.headers['x-setup-token'];
        const digest = createHash('sha256').update(typeof supplied === 'string' ? supplied : '').digest();
        assert(typeof supplied === 'string' && /^[A-Za-z0-9_-]{32,256}$/u.test(supplied) && timingSafeEqual(digest, setupDigest), 403, 'SETUP_TOKEN_REQUIRED', 'Informe o token de configuração fornecido pelo administrador.');
      }
      const body = validate.object(await readJson(request));
      validate.onlyKeys(body, ['name', 'email', 'password']);
      const name = validate.text(body.name, 'name', { min: 2, max: 80 });
      const email = validate.email(body.email);
      const passwordHash = await hashPassword(validate.password(body.password));
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const sessionData = (await transaction(db, async () => {
        assert((await status(null)).setupRequired, 409, 'ALREADY_CONFIGURED', 'A configuração inicial já foi concluída.');
        (await db.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
          .run(id, name, email, passwordHash, 'admin', createdAt, createdAt));
        (await audit(db, { actorId: id, action: 'setup.completed', resourceType: 'user', resourceId: id }));
        return (await createSession(db, id));
      }));
      const user = publicUser((await db.prepare('SELECT * FROM users WHERE id=?').get(id)));
      return { status: 201, data: { ...sessionFlags, setupRequired: false, user, csrfToken: sessionData.csrfToken, expiresAt: new Date(sessionData.expiresAt).toISOString() }, headers: { 'Set-Cookie': sessionCookie(sessionData.token, { secure: secureCookies }) } };
    }

    if (method === 'POST' && pathname === '/api/auth/login') {
      assert(!(await status(null)).setupRequired, 409, 'SETUP_REQUIRED', 'Conclua a configuração inicial.');
      const body = validate.object(await readJson(request));
      validate.onlyKeys(body, ['email', 'password']);
      const email = validate.email(body.email);
      assert(typeof body.password === 'string' && body.password.length >= 1 && body.password.length <= 128, 401, 'INVALID_CREDENTIALS', 'E-mail ou senha inválidos.');
      const peerKey = `login:${peer(request)}`;
      const accountKey = `account:${tokenHash(email)}`;
      // Reserve in the shared database before awaiting scrypt.
      const reservation = await attempts.reserve([peerKey, accountKey]);
      const row = (await db.prepare('SELECT * FROM users WHERE email=?').get(email));
      const valid = await verifyPassword(body.password, row?.password_hash || dummyHash);
      if (!valid || !row?.active) {
        (await audit(db, { action: 'auth.login_failed', resourceType: 'session' }));
        throw new ApiError(401, 'INVALID_CREDENTIALS', 'E-mail ou senha inválidos.');
      }
      // Recheck after the async scrypt call in case an administrator disabled the user.
      const sessionData = (await transaction(db, async () => {
        const current = (await db.prepare('SELECT * FROM users WHERE id=?').get(row.id));
        assert(current?.active && current.password_hash === row.password_hash, 401, 'INVALID_CREDENTIALS', 'E-mail ou senha inválidos.');
        const next = (await createSession(db, row.id));
        (await audit(db, { actorId: row.id, action: 'auth.login', resourceType: 'session' }));
        return { ...next, user: publicUser(current) };
      }));
      await attempts.succeed(reservation);
      return { data: { ...sessionFlags, setupRequired: false, user: sessionData.user, csrfToken: sessionData.csrfToken, expiresAt: new Date(sessionData.expiresAt).toISOString() }, headers: { 'Set-Cookie': sessionCookie(sessionData.token, { secure: secureCookies }) } };
    }

    if (MUTATIONS.has(method)) verifyCsrf(request, session);

    if (method === 'POST' && pathname === '/api/auth/logout') {
      validate.object(await readJson(request));
      (await transaction(db, async () => {
        (await db.prepare('DELETE FROM sessions WHERE token_hash=?').run(session.tokenHash));
        (await audit(db, { actorId: session.user.id, action: 'auth.logout', resourceType: 'session' }));
      }));
      return { data: { ...sessionFlags, loggedOut: true }, headers: { 'Set-Cookie': sessionCookie('', { secure: secureCookies, clear: true }) } };
    }

    if (method === 'POST' && pathname === '/api/auth/password') {
      const user = requireAuth(session);
      const body = validate.object(await readJson(request));
      validate.onlyKeys(body, ['currentPassword', 'newPassword']);
      assert(typeof body.currentPassword === 'string' && body.currentPassword.length > 0 && body.currentPassword.length <= 128, 401, 'INVALID_CREDENTIALS', 'Senha atual inválida.');
      const currentPassword = body.currentPassword;
      const newPassword = validate.password(body.newPassword, 'newPassword');
      // A stolen session must not enable unlimited current-password guesses or
      // unbounded scrypt work. Password changes consume their own durable budget.
      await attempts.reserve([`password:${peer(request)}`, `password-account:${tokenHash(user.id)}`]);
      await requireLiveRole(db, session);
      const row = (await db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id));
      assert(await verifyPassword(currentPassword, row.password_hash), 401, 'INVALID_CREDENTIALS', 'Senha atual inválida.');
      const nextHash = await hashPassword(newPassword);
      const nextSession = (await transaction(db, async () => {
        (await requireLiveRole(db, session));
        assert((await db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id))?.password_hash === row.password_hash, 409, 'CONCURRENT_CHANGE', 'A conta foi atualizada. Entre novamente.');
        (await db.prepare('UPDATE users SET password_hash=?,updated_at=? WHERE id=?').run(nextHash, new Date().toISOString(), user.id));
        (await db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id));
        (await audit(db, { actorId: user.id, action: 'auth.password_changed', resourceType: 'user', resourceId: user.id }));
        return (await createSession(db, user.id));
      }));
      return { data: { ...sessionFlags, user, csrfToken: nextSession.csrfToken, expiresAt: new Date(nextSession.expiresAt).toISOString() }, headers: { 'Set-Cookie': sessionCookie(nextSession.token, { secure: secureCookies }) } };
    }

    if (method === 'GET' && pathname === '/api/users') {
      requireRole(session, ['admin']);
      return { data: { items: (await db.prepare('SELECT * FROM users ORDER BY created_at,id').all()).map(publicUser) } };
    }
    if (method === 'POST' && pathname === '/api/users') {
      const actor = requireRole(session, ['admin']);
      const body = validate.object(await readJson(request));
      validate.onlyKeys(body, ['name', 'email', 'password', 'role']);
      const name = validate.text(body.name, 'name', { min: 2, max: 80 });
      const email = validate.email(body.email);
      const role = validate.choice(body.role, 'role', ROLES);
      const passwordHash = await hashPassword(validate.password(body.password));
      const id = randomUUID();
      const now = new Date().toISOString();
      (await transaction(db, async () => {
        (await requireLiveRole(db, session, ['admin']));
        assert(!(await db.prepare('SELECT id FROM users WHERE email=?').get(email)), 409, 'EMAIL_EXISTS', 'Já existe uma conta com este e-mail.');
        (await db.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id, name, email, passwordHash, role, now, now));
        (await audit(db, { actorId: actor.id, action: 'user.created', resourceType: 'user', resourceId: id, metadata: { role } }));
      }));
      return { status: 201, data: { user: publicUser((await db.prepare('SELECT * FROM users WHERE id=?').get(id))) } };
    }
    const userMatch = pathname.match(/^\/api\/users\/([a-zA-Z0-9_-]+)$/u);
    if (method === 'PATCH' && userMatch) {
      const actor = requireRole(session, ['admin']);
      const id = userMatch[1];
      const body = validate.object(await readJson(request));
      validate.onlyKeys(body, ['name', 'role', 'active']);
      assert(Object.keys(body).length > 0, 422, 'VALIDATION_ERROR', 'Informe ao menos um campo.');
      const name = body.name === undefined ? undefined : validate.text(body.name, 'name', { min: 2, max: 80 });
      const role = body.role === undefined ? undefined : validate.choice(body.role, 'role', ROLES);
      const active = body.active === undefined ? undefined : validate.boolean(body.active, 'active');
      (await transaction(db, async () => {
        (await requireLiveRole(db, session, ['admin']));
        const before = (await db.prepare('SELECT * FROM users WHERE id=?').get(id));
        assert(before, 404, 'NOT_FOUND', 'Conta não encontrada.');
        const nextRole = role ?? before.role;
        const nextActive = active === undefined ? before.active : Number(active);
        if (before.active && before.role === 'admin' && (!nextActive || nextRole !== 'admin')) {
          assert((await db.prepare("SELECT COUNT(*) AS count FROM users WHERE active=1 AND role='admin'").get()).count > 1, 409, 'LAST_ADMIN', 'Mantenha ao menos um administrador ativo.');
        }
        (await db.prepare('UPDATE users SET name=?,role=?,active=?,updated_at=? WHERE id=?').run(name ?? before.name, nextRole, nextActive, new Date().toISOString(), id));
        if (!nextActive || nextRole !== before.role) (await db.prepare('DELETE FROM sessions WHERE user_id=?').run(id));
        (await audit(db, { actorId: actor.id, action: 'user.updated', resourceType: 'user', resourceId: id, metadata: { fields: Object.keys(body), role: nextRole, active: Boolean(nextActive) } }));
      }));
      return { data: { user: publicUser((await db.prepare('SELECT * FROM users WHERE id=?').get(id))) } };
    }
    if (method === 'GET' && pathname === '/api/audit') {
      requireRole(session, ['admin', 'manager']);
      const rawLimit = url.searchParams.get('limit') || '100';
      const limit = validate.integer(Number(rawLimit), 'limit', { min: 1, max: 500 });
      const items = (await db.prepare('SELECT * FROM audit_events ORDER BY created_at DESC,id DESC LIMIT ?').all(limit)).map((row) => ({ id: row.id, actorId: row.actor_id, action: row.action, resourceType: row.resource_type, resourceId: row.resource_id, metadata: JSON.parse(row.metadata_json), createdAt: row.created_at }));
      return { data: { items } };
    }
    const context = { request, method, pathname, url, session, db, fiscal, jkIntegrations };
    for (const handler of [handleJkMigration, handleJkIntegrations, handleJkDeliveries, handleFiscal, handleMedia, handleDomain, ...(domainHandler ? [domainHandler] : [])]) {
      const response = await handler(context);
      if (response) return response;
    }
    throw new ApiError(404, 'NOT_FOUND', 'Recurso não encontrado.');
  }

  const handleRequest = async (request, response) => {
    const requestId = randomUUID();
    securityHeaders(response, requestId);
    try {
      assert(!closing, 503, 'SHUTTING_DOWN', 'O servidor está encerrando.');
      validateRequestOrigin(request, server, publicOrigin);
      const url = new URL(request.url, 'http://local.invalid');
      if (url.pathname.startsWith('/api/')) {
        const operation = async () => handleApi(request, url.pathname, url, await readSession(db, request));
        const result = request.method === 'GET' ? await db.read(operation) : await operation();
        sendJson(response, result.status || 200, { ok: true, data: result.data }, result.headers);
      } else await serveStatic(request, response, url.pathname, distDir);
    } catch (error) {
      const exposed = toPublicError(error, requestId);
      // Driver messages can include SQL values, file paths or connection details.
      // The request ID correlates failures without persisting that raw content.
      if (exposed.status === 500) logger.error?.({ requestId, code: 'INTERNAL_ERROR' });
      if (!response.headersSent) sendJson(response, exposed.status, exposed.body);
      else response.destroy();
    }
  };
  const handler = (request, response) => {
    const pending = handleRequest(request, response);
    requests.add(pending);
    pending.then(() => requests.delete(pending), () => requests.delete(pending));
    return pending;
  };
  const server = createServer(handler);
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 60;

  return {
    server, handler,
    db: raw || db, store: db,
    async listen({ port = 4173, host = '127.0.0.1' } = {}) {
      if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
        if (!publicOrigin.length) throw new Error('Para expor o servidor fora do computador local, configure PUBLIC_ORIGIN explicitamente.');
        if (!setupDigest && (await status(null)).setupRequired) throw new Error('Configure SETUP_TOKEN antes de disponibilizar a configuração inicial fora do computador local.');
      }
      await new Promise((resolvePromise, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.removeListener('error', reject); resolvePromise(); });
      });
      return server.address();
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        if (server.listening) await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
        // Direct serverless handler calls do not pass through server.listen().
        // Drain complete requests, including body reads and password hashing.
        await Promise.allSettled([...requests]);
        await db.close();
      })();
      return closePromise;
    },
  };
}
