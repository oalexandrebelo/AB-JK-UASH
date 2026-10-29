import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const MAX_RESPONSE_BYTES = 256 * 1024;
export const MAX_REQUEST_BYTES = 64 * 1024;
export const DEFAULT_TIMEOUT_MS = 10_000;

export class FiscalTransportError extends Error {
  constructor(code) {
    super('A comunicação fiscal não pôde ser confirmada.');
    this.name = 'FiscalTransportError';
    this.code = code;
  }
}

const fail = (code) => { throw new FiscalTransportError(code); };

// Fail closed for special-use IPv4 and IPv6. IPv6 is restricted to currently
// allocated global unicast, excluding documentation, transition and protocol ranges.
export function isGlobalAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6 || address.includes('%')) return false;
  const segments = address.toLowerCase().split(':');
  const first = parseInt(segments[0], 16);
  if (!Number.isInteger(first) || first < 0x2000 || first > 0x3fff) return false;
  if (first === 0x2002 || first === 0x3fff) return false;
  if (first === 0x2001) {
    const second = parseInt(segments[1] || '0', 16);
    if (second < 0x200 || second === 0xdb8) return false;
  }
  return true;
}

export function validateFiscalOrigin(origin, allowedHosts) {
  let url;
  try { url = new URL(origin); } catch { fail('FISCAL_ENDPOINT_INVALID'); }
  if (url.protocol !== 'https:' || (url.port && url.port !== '443')
    || url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || isIP(url.hostname) || !allowedHosts.includes(url.hostname)
    || !/^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/u.test(url.hostname)
    || url.hostname.endsWith('.')) fail('FISCAL_ENDPOINT_REJECTED');
  return url.origin;
}

/**
 * Native HTTPS; no global fetch, redirects, proxy environment or connection reuse.
 * lookup/request are explicit test seams, never configurable through HTTP or env.
 * The only production entry point constructs this with native dependencies.
 */
export function createPinnedHttpsTransport({ origin, allowedHosts, authorization, timeoutMs = DEFAULT_TIMEOUT_MS, lookup = dnsLookup, request = httpsRequest }) {
  const safeOrigin = validateFiscalOrigin(origin, allowedHosts);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) fail('FISCAL_TIMEOUT_INVALID');
  if (typeof authorization !== 'string' || !authorization || /[\r\n]/u.test(authorization)) fail('FISCAL_AUTH_INVALID');
  const hostname = new URL(safeOrigin).hostname;
  return async function transport({ method, path, body }) {
    if (!['POST', 'GET'].includes(method)
      || !/^\/v2\/nfsen(?:\?ref=[a-zA-Z0-9_-]{8,80}|\/[a-zA-Z0-9_-]{8,80})$/u.test(path)
      || (method === 'POST' && !path.includes('?ref='))
      || (method === 'GET' && path.includes('?'))) fail('FISCAL_REQUEST_INVALID');
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    if (bytes && bytes.length > MAX_REQUEST_BYTES) fail('FISCAL_REQUEST_TOO_LARGE');
    return new Promise((resolve, reject) => {
      let settled = false;
      let activeRequest;
      let activeResponse;
      // Timer starts before DNS; slow DNS cannot escape the total deadline.
      const timer = setTimeout(() => finish(new FiscalTransportError('FISCAL_TIMEOUT')), timeoutMs);
      function finish(error, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          activeResponse?.destroy();
          activeRequest?.destroy();
          reject(error instanceof FiscalTransportError ? error : new FiscalTransportError('FISCAL_NETWORK_ERROR'));
        } else resolve(value);
      }
      Promise.resolve().then(() => lookup(hostname, { all: true, verbatim: true })).then((addresses) => {
        if (settled) return;
        if (!Array.isArray(addresses) || !addresses.length
          || addresses.some(({ address, family }) => !isGlobalAddress(address) || isIP(address) !== family)) {
          return finish(new FiscalTransportError('FISCAL_DNS_REJECTED'));
        }
        const pinned = addresses[0];
        // SNI/certificate validation still use the hostname. The socket resolver
        // returns only the address already validated, preventing DNS rebinding.
        const pinnedLookup = (_host, options, callback) => {
          if (typeof options === 'function') { callback = options; options = {}; }
          callback(null, options?.all ? [pinned] : pinned.address, pinned.family);
        };
        activeRequest = request(`${safeOrigin}${path}`, {
          method, agent: false, lookup: pinnedLookup, family: pinned.family,
          servername: hostname, rejectUnauthorized: true,
          headers: {
            authorization, accept: 'application/json', 'accept-encoding': 'identity',
            ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}),
          },
        }, (response) => {
          activeResponse = response;
          if (settled) { response.destroy(); return; }
          const statusCode = response.statusCode || 0;
          if (statusCode >= 300 && statusCode < 400) return finish(new FiscalTransportError('FISCAL_REDIRECT_REJECTED'));
          if (!/^application\/json(?:\s*;|$)/iu.test(response.headers['content-type'] || '')
            || !['', 'identity'].includes(response.headers['content-encoding'] || '')) {
            return finish(new FiscalTransportError('FISCAL_RESPONSE_INVALID'));
          }
          const declared = Number(response.headers['content-length']);
          if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) return finish(new FiscalTransportError('FISCAL_RESPONSE_TOO_LARGE'));
          const chunks = [];
          let size = 0;
          response.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) return finish(new FiscalTransportError('FISCAL_RESPONSE_TOO_LARGE'));
            chunks.push(chunk);
          });
          response.on('error', () => finish(new FiscalTransportError('FISCAL_NETWORK_ERROR')));
          response.on('aborted', () => finish(new FiscalTransportError('FISCAL_NETWORK_ERROR')));
          response.on('end', () => {
            if (settled) return;
            let json;
            try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return finish(new FiscalTransportError('FISCAL_RESPONSE_INVALID')); }
            if (!json || Array.isArray(json) || typeof json !== 'object') return finish(new FiscalTransportError('FISCAL_RESPONSE_INVALID'));
            finish(null, { statusCode, body: json });
          });
        });
        activeRequest.on('error', () => finish(new FiscalTransportError('FISCAL_NETWORK_ERROR')));
        activeRequest.end(bytes);
      }).catch(() => finish(new FiscalTransportError('FISCAL_NETWORK_ERROR')));
    });
  };
}
