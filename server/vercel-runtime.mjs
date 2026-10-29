import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { createApplication } from './application.mjs';
import { ApiError, toPublicError } from './errors.mjs';
import { securityHeaders, sendJson } from './http.mjs';

function configurationError() {
  return new ApiError(503, 'CONFIGURATION_REQUIRED', 'A aplicação foi publicada, mas o banco de dados ainda não está configurado. O administrador precisa concluir a conexão com o Supabase e a configuração segura do servidor.');
}
function httpsOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw configurationError(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !url.hostname.includes('.') || url.port) throw configurationError();
  return url.origin;
}
/** A request header can never add a trusted host or select a database. */
export function deploymentConfiguration(env) {
  if (!env.DATABASE_URL || !/^[A-Za-z0-9_-]{32,256}$/u.test(env.AB_UASH_SETUP_TOKEN || '') || env.NODEJS_HELPERS !== '0') throw configurationError();
  let url;
  try { url = new URL(env.DATABASE_URL); } catch { throw configurationError(); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password || url.hash) throw configurationError();
  if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname === '[::1]' || /^127\./u.test(url.hostname) || url.hostname === '0.0.0.0') throw configurationError();
  const origins = new Set();
  if (env.PUBLIC_ORIGIN) origins.add(httpsOrigin(env.PUBLIC_ORIGIN));
  for (const key of ['VERCEL_URL', 'VERCEL_BRANCH_URL', 'VERCEL_PROJECT_PRODUCTION_URL']) {
    if (env[key]) origins.add(httpsOrigin(`https://${env[key]}`));
  }
  if (!origins.size) throw configurationError();
  const schema = env.DATABASE_SCHEMA || 'ab_uash';
  if (!/^ab_uash(?:_[a-z0-9_]+)?$/u.test(schema) || schema.length > 63) throw configurationError();
  return {
    databaseUrl: env.DATABASE_URL, databaseSchema: schema, databasePoolSize: 1,
    ...(env.DATABASE_CA_CERT ? {databaseCa: env.DATABASE_CA_CERT.replaceAll('\\n', '\n')} : {}),
    publicOrigin: [...origins], secureCookies: true, setupToken: env.AB_UASH_SETUP_TOKEN,
  };
}
export function vercelClientAddress(request) {
  const value = request.headers['x-vercel-forwarded-for'];
  // Only the edge-overwritten Vercel header is used. Missing or ambiguous
  // addresses share one restrictive rate-limit bucket.
  return typeof value === 'string' && isIP(value) ? value : 'unknown';
}
export function createVercelHandler({env = process.env, applicationFactory = createApplication, logger = console, now = Date.now} = {}) {
  let pending, retryAfter = 0;
  async function application() {
    if (now() < retryAfter) throw new ApiError(503, 'DATABASE_UNAVAILABLE', 'O banco de dados está temporariamente indisponível. Tente novamente em alguns segundos.');
    if (!pending) {
      const config = deploymentConfiguration(env);
      pending = Promise.resolve().then(() => applicationFactory({...config, fiscalEnv: env, clientAddress: vercelClientAddress, logger})).catch(() => {
        pending = undefined;
        retryAfter = now() + 5000;
        // Never log raw connection errors, SQL, tokens or database URLs.
        logger.error?.({code: 'DATABASE_INITIALIZATION_FAILED'});
        throw new ApiError(503, 'DATABASE_UNAVAILABLE', 'O banco de dados está temporariamente indisponível. Tente novamente em alguns segundos.');
      });
    }
    return pending;
  }
  return async function handler(request, response) {
    const requestId = randomUUID();
    securityHeaders(response, requestId);
    try {
      const app = await application();
      await app.handler(request, response);
    } catch (cause) {
      const error = cause instanceof ApiError ? cause : new ApiError(503, 'SERVICE_UNAVAILABLE', 'O servidor não conseguiu concluir a solicitação.');
      const exposed = toPublicError(error, requestId);
      if (!response.headersSent) sendJson(response, exposed.status, exposed.body, {'Retry-After': '5'});
      else response.destroy();
    }
  };
}
