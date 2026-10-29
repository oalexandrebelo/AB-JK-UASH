import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { ApiError } from './errors.mjs';
import { transaction } from './db.mjs';

const scrypt = promisify(scryptCallback);
const COST = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_LIFETIME = 8 * 60 * 60 * 1000;
export const COOKIE_NAME = 'ab_uash_session';
export const ROLES = ['admin', 'manager', 'operator', 'viewer'];

export async function hashPassword(password) {
  const salt = randomBytes(32).toString('base64url');
  const key = await scrypt(password, salt, 64, COST);
  return `scrypt$${COST.N}$${COST.r}$${COST.p}$${salt}$${key.toString('base64url')}`;
}

export async function verifyPassword(password, encoded) {
  const [algorithm, n, r, p, salt, digest] = String(encoded || '').split('$');
  if (algorithm !== 'scrypt' || Number(n) !== COST.N || Number(r) !== COST.r || Number(p) !== COST.p || !salt || !digest) return false;
  const expected = Buffer.from(digest, 'base64url');
  if (expected.length !== 64) return false;
  const actual = await scrypt(password, salt, expected.length, COST);
  return timingSafeEqual(actual, expected);
}

export function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function publicUser(row) {
  return { id: row.id, name: row.name, email: row.email, role: row.role, active: Boolean(row.active), createdAt: row.created_at };
}

export async function createSession(db, userId, now = Date.now()) {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  (await db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now));
  (await db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?,?)')
    .run(tokenHash(token), userId, csrfToken, now, now + SESSION_LIFETIME, now));
  return { token, csrfToken, expiresAt: now + SESSION_LIFETIME };
}

export function sessionCookie(token, { secure = false, clear = false } = {}) {
  return `${COOKIE_NAME}=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_LIFETIME / 1000}${secure ? '; Secure' : ''}`;
}

export async function readSession(db, request, now = Date.now()) {
  const cookie = (request.headers.cookie || '').split(';').map((item) => item.trim()).find((item) => item.startsWith(`${COOKIE_NAME}=`));
  const token = cookie?.slice(COOKIE_NAME.length + 1);
  if (!token || !/^[a-zA-Z0-9_-]{43}$/u.test(token)) return null;
  const hash = tokenHash(token);
  const session = (await db.prepare(`SELECT s.token_hash,s.csrf_token,s.expires_at,s.last_seen_at,u.*
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`).get(hash, now));
  if (!session) return null;
  // Session expiry is absolute; reads remain side-effect free for consistent snapshots.
  return { user: publicUser(session), tokenHash: hash, csrfToken: session.csrf_token, expiresAt: session.expires_at };
}

export function requireAuth(session) {
  if (!session) throw new ApiError(401, 'AUTH_REQUIRED', 'Entre na sua conta para continuar.');
  return session.user;
}

export function requireRole(session, roles) {
  const user = requireAuth(session);
  if (!roles.includes(user.role)) throw new ApiError(403, 'FORBIDDEN', 'Seu perfil não permite esta operação.');
  return user;
}

export function verifyCsrf(request, session) {
  requireAuth(session);
  const supplied = request.headers['x-csrf-token'];
  if (typeof supplied !== 'string' || !/^[a-zA-Z0-9_-]{43}$/u.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(session.csrfToken))) {
    throw new ApiError(403, 'CSRF_INVALID', 'A sessão precisa ser atualizada antes desta operação.');
  }
}

export async function requireLiveRole(db, session, roles = ROLES) {
  requireAuth(session);
  const row = (await db.prepare(`SELECT u.role FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.user_id=? AND s.expires_at>? AND u.active=1`).get(session.tokenHash, session.user.id, Date.now()));
  if (!row) throw new ApiError(401, 'AUTH_REQUIRED', 'Entre na sua conta para continuar.');
  if (!roles.includes(row.role)) throw new ApiError(403, 'FORBIDDEN', 'Seu perfil não permite esta operação.');
}

export function createRateLimiter(db, { maximum = 12, windowMs = 15 * 60 * 1000 } = {}) {
  return {
    async reserve(keys) {
      return transaction(db, async () => {
        const now = Date.now();
        await db.prepare('DELETE FROM auth_attempts WHERE expires_at<=?').run(now);
        const reservations = [];
        for (const key of [...new Set(keys)]) {
          const row = await db.prepare('SELECT attempts,expires_at FROM auth_attempts WHERE key=?').get(key);
          if ((row?.attempts || 0) >= maximum) throw new ApiError(429, 'TOO_MANY_ATTEMPTS', 'Muitas tentativas. Aguarde 15 minutos e tente novamente.');
          const until = row?.expires_at || now + windowMs;
          await db.prepare('INSERT INTO auth_attempts(key,attempts,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET attempts=excluded.attempts,expires_at=excluded.expires_at').run(key, (row?.attempts || 0) + 1, until);
          reservations.push({key, until});
        }
        return reservations;
      });
    },
    async succeed(reservations) {
      await transaction(db, async () => {
        for (const {key, until} of reservations) {
          await db.prepare('UPDATE auth_attempts SET attempts=attempts-1 WHERE key=? AND expires_at=? AND attempts>0').run(key, until);
          await db.prepare('DELETE FROM auth_attempts WHERE key=? AND expires_at=? AND attempts=0').run(key, until);
        }
      });
    },
  };
}
