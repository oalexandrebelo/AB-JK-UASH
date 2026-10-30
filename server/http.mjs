import { readFile, stat, realpath } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { ApiError } from './errors.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm', '.gz': 'application/gzip',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
};

export function securityHeaders(response, requestId) {
  response.setHeader('X-Request-Id', requestId);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}

export function normalizePublicOrigins(value) {
  if (value === undefined || value === null) return [];
  const values = Array.isArray(value) ? value : [value];
  if (!values.length || values.length > 20) throw new Error('Configure de uma a vinte origens públicas exatas.');
  return [...new Set(values.map(origin => {
    if (typeof origin !== 'string') throw new Error('PUBLIC_ORIGIN deve conter URLs exatas.');
    const url = new URL(origin);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.origin === 'null' || url.hostname.includes('*')) throw new Error('PUBLIC_ORIGIN deve conter somente protocolo, host e porta.');
    return url.origin;
  }))];
}

export function validateRequestOrigin(request, server, configuredOrigin) {
  const origins = Array.isArray(configuredOrigin) ? configuredOrigin : normalizePublicOrigins(configuredOrigin);
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 4173;
  const allowed = origins.length ? origins : [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`].map(value => new URL(value).origin);
  const host = request.headers.host;
  if (typeof host !== 'string') throw new ApiError(403, 'HOST_REJECTED', 'Endereço do servidor não autorizado.');
  if (request.rawHeaders && request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === 'host').length !== 1) throw new ApiError(403, 'HOST_REJECTED', 'Endereço do servidor não autorizado.');
  const matching = allowed.filter(origin => new URL(origin).host === host.toLowerCase());
  if (!matching.length) throw new ApiError(403, 'HOST_REJECTED', 'Endereço do servidor não autorizado.');
  const origin = request.headers.origin;
  const publicNavigation = ['GET', 'HEAD'].includes(request.method) && origin === undefined
    && request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document'
    && ['/', '/app', '/app/', '/agendar', '/agendar/', '/privacidade', '/privacidade/', '/condicoes-de-agendamento', '/condicoes-de-agendamento/'].includes((request.url || '').split('?')[0]);
  if ((origin !== undefined && (typeof origin !== 'string' || !matching.includes(origin))) || (request.headers['sec-fetch-site'] === 'cross-site' && !publicNavigation)) throw new ApiError(403, 'ORIGIN_REJECTED', 'Origem da solicitação não autorizada.');
}

export async function readJson(request, maxBytes = 64 * 1024) {
  if (!/^application\/json(?:\s*;|$)/iu.test(request.headers['content-type'] || '')) throw new ApiError(415, 'JSON_REQUIRED', 'Envie o conteúdo como application/json.');
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) throw new ApiError(413, 'BODY_TOO_LARGE', 'O conteúdo enviado é muito grande.');
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new ApiError(413, 'BODY_TOO_LARGE', 'O conteúdo enviado é muito grande.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'O conteúdo JSON é inválido.');
  }
}

export function sendJson(response, status, data, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  response.end(JSON.stringify(data));
}

export async function serveStatic(request, response, pathname, distDir) {
  if (!['GET', 'HEAD'].includes(request.method)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Método não permitido.');
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { throw new ApiError(400, 'INVALID_PATH', 'Caminho inválido.'); }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some((part) => part.startsWith('.'))) throw new ApiError(404, 'NOT_FOUND', 'Página não encontrada.');
  const root = resolve(distDir);
  let path = resolve(root, `.${decoded}`);
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new ApiError(404, 'NOT_FOUND', 'Página não encontrada.');
  try {
    const info = await stat(path);
    if (info.isDirectory()) path = resolve(path, 'index.html');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (extname(decoded)) throw new ApiError(404, 'NOT_FOUND', 'Arquivo não encontrado.');
    path = resolve(root, 'index.html');
  }
  try {
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(path)]);
    if (!realFile.startsWith(`${realRoot}${sep}`)) throw new ApiError(404, 'NOT_FOUND', 'Arquivo não encontrado.');
    const content = await readFile(realFile);
    response.writeHead(200, {
      'Content-Type': MIME[extname(realFile)] || 'application/octet-stream',
      'Content-Length': content.length,
      'Cache-Control': extname(realFile) === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch (error) {
    if (error.code === 'ENOENT') throw new ApiError(503, 'FRONTEND_NOT_BUILT', 'A interface precisa ser compilada. Execute npm run build e reinicie.');
    throw error;
  }
}
