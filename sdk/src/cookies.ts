/** Cookie storage for a single API origin. Values never leave memory. */
export interface CookieContext {
  /** Defaults to true for server-to-server calls to this API origin. */
  sameSite?: boolean;
  /** Only used for Lax cookies; API fetches are not top-level navigations. */
  topLevelNavigation?: boolean;
  method?: string;
}

interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  sameSite: 'strict' | 'lax' | 'none';
  expiresAt: number;
  created: number;
}

/**
 * A deliberately origin-confined cookie jar, not a general web browser jar.
 * Domain cookies are accepted only when Domain equals this origin's hostname.
 * Parent-domain cookies are rejected because a dependency-free jar has no PSL.
 * Different ports are also isolated, more restrictive than browser cookies.
 */
export class MemoryCookieJar {
  readonly #origin: string;
  readonly #cookies = new Map<string, StoredCookie>();
  #sequence = 0;

  constructor(origin: string) {
    this.#origin = new URL(origin).origin;
  }

  clear(): void {
    this.#cookies.clear();
  }

  toJSON(): { type: string; cookies: '[redacted]' } {
    return { type: 'MemoryCookieJar', cookies: '[redacted]' };
  }

  /** Consume response headers only for the configured API origin. */
  store(url: string | URL, headers: Headers, now = Date.now()): void {
    const target = new URL(url);
    if (target.origin !== this.#origin) return;
    const withAccessor = headers as Headers & { getSetCookie?: () => string[] };
    const lines = withAccessor.getSetCookie?.() ?? splitSetCookie(headers.get('set-cookie'));
    for (const line of lines) this.#storeOne(target, line, now);
  }

  #storeOne(target: URL, line: string, now: number): void {
    const parts = line.split(';');
    const first = parts.shift() || '';
    const separator = first.indexOf('=');
    if (separator <= 0) return;
    const name = first.slice(0, separator).trim();
    const value = first.slice(separator + 1).trim();
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || !/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/.test(value)) return;
    const attributes = new Map<string, string>();
    for (const part of parts) {
      const index = part.indexOf('=');
      const key = (index < 0 ? part : part.slice(0, index)).trim().toLowerCase();
      attributes.set(key, index < 0 ? '' : part.slice(index + 1).trim());
    }
    const hostname = target.hostname.toLowerCase();
    const domainAttribute = attributes.get('domain');
    const domain = domainAttribute?.replace(/^\./, '').toLowerCase() || hostname;
    // Restrict rather than guess public suffixes or registrable domains.
    if (domain !== hostname || (domainAttribute !== undefined && (!domainAttribute || domainAttribute.endsWith('.')))) return;
    const secure = attributes.has('secure');
    if (secure && target.protocol !== 'https:') return;
    const suppliedPath = attributes.get('path');
    const path = suppliedPath?.startsWith('/') ? suppliedPath : defaultPath(target.pathname);
    if (name.startsWith('__Secure-') && (!secure || target.protocol !== 'https:')) return;
    if (name.startsWith('__Host-') && (!secure || target.protocol !== 'https:' || domainAttribute !== undefined || suppliedPath !== '/')) return;
    const rawSameSite = attributes.get('samesite')?.toLowerCase();
    const sameSite = rawSameSite === 'none' || rawSameSite === 'strict' ? rawSameSite : 'lax';
    if (sameSite === 'none' && !secure) return;
    let expiresAt = Number.POSITIVE_INFINITY;
    const maxAge = attributes.get('max-age');
    if (maxAge !== undefined && /^-?\d+$/.test(maxAge)) {
      const seconds = Number(maxAge);
      expiresAt = seconds <= 0 ? 0 : now + Math.min(seconds, Number.MAX_SAFE_INTEGER / 1000) * 1000;
    } else if (attributes.has('expires')) {
      const stamp = Date.parse(attributes.get('expires')!);
      if (Number.isFinite(stamp)) expiresAt = stamp;
    }
    const key = `${name}\n${domain}\n${path}`;
    const previous = this.#cookies.get(key);
    // An insecure response must not overwrite a secure cookie.
    if (previous?.secure && target.protocol !== 'https:') return;
    if (expiresAt <= now) {
      this.#cookies.delete(key);
      return;
    }
    if (!previous && this.#cookies.size >= 100) return;
    this.#cookies.set(key, { name, value, domain, path, secure, sameSite, expiresAt, created: previous?.created ?? this.#sequence++ });
  }

  /** Never returns cookies for a different origin, even on a subdomain/redirect. */
  header(url: string | URL, context: CookieContext = {}, now = Date.now()): string {
    const target = new URL(url);
    if (target.origin !== this.#origin) return '';
    const sameSite = context.sameSite !== false;
    const safeNavigation = context.topLevelNavigation === true && ['GET', 'HEAD', 'OPTIONS', 'TRACE'].includes((context.method || 'GET').toUpperCase());
    const matches: StoredCookie[] = [];
    for (const [key, cookie] of this.#cookies) {
      if (cookie.expiresAt <= now) { this.#cookies.delete(key); continue; }
      if (cookie.domain !== target.hostname.toLowerCase() || (cookie.secure && target.protocol !== 'https:')) continue;
      if (!pathMatches(target.pathname, cookie.path)) continue;
      if (!sameSite && (cookie.sameSite === 'strict' || (cookie.sameSite === 'lax' && !safeNavigation))) continue;
      matches.push(cookie);
    }
    return matches.sort((a, b) => b.path.length - a.path.length || a.created - b.created).map(({ name, value }) => `${name}=${value}`).join('; ');
  }
}

function defaultPath(pathname: string): string {
  const slash = pathname.lastIndexOf('/');
  return slash <= 0 ? '/' : pathname.slice(0, slash);
}

function pathMatches(pathname: string, cookiePath: string): boolean {
  return pathname === cookiePath || (pathname.startsWith(cookiePath) && (cookiePath.endsWith('/') || pathname[cookiePath.length] === '/'));
}

function splitSetCookie(value: string | null): string[] {
  if (!value) return [];
  return value.split(/,(?=\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/);
}
