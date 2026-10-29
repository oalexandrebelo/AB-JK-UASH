import { operations } from './operations.js';
import type { OperationMap } from './models.js';
import { MemoryCookieJar } from './cookies.js';
import { ApiError, TransportError } from './errors.js';

export type OperationId = keyof OperationMap;
export type OperationInput<K extends OperationId> = OperationMap[K]['input'];
export type OperationOutput<K extends OperationId> = OperationMap[K]['output'];
export type ProtectedOperationId = { [K in OperationId]: OperationMap[K]['protectedWrite'] extends true ? K : never }[OperationId];
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface RequestOptions {
  signal?: AbortSignal;
  /** Includes receiving and reading the entire response. 0 disables the timer. */
  timeoutMs?: number;
}
export type OperationOptions<K extends OperationId> = RequestOptions
  & (OperationMap[K]['protectedWrite'] extends true ? { idempotencyKey?: string } : { idempotencyKey?: never })
  & (OperationMap[K]['setupToken'] extends true ? { setupToken?: string } : { setupToken?: never });
type OptionalInput<K extends OperationId> = {} extends OperationInput<K> ? true : false;
export type OperationArguments<K extends OperationId> = OptionalInput<K> extends true
  ? [input?: OperationInput<K>, options?: OperationOptions<K>]
  : [input: OperationInput<K>, options?: OperationOptions<K>];
export type ApiMethods = { [K in OperationId]: (...args: OperationArguments<K>) => Promise<OperationOutput<K>> };

export interface ClientOptions {
  /** API origin, e.g. http://127.0.0.1:4173 or https://your-app.example. */
  baseUrl: string;
  fetch?: FetchLike;
  /** browser delegates cookie storage to fetch; server keeps an isolated jar. */
  mode?: 'browser' | 'server';
  credentials?: RequestCredentials;
  timeoutMs?: number;
  cookieJar?: MemoryCookieJar;
}

export interface PreparedOperation<K extends ProtectedOperationId> {
  readonly operationId: K;
  readonly idempotencyKey: string;
  /** Each execution sends the same JSON/path/query snapshot and key. */
  execute(options?: RequestOptions): Promise<OperationOutput<K>>;
}

interface Snapshot {
  url: string;
  serializedBody?: string;
}
interface InternalOptions extends RequestOptions {
  idempotencyKey?: string;
  setupToken?: string;
}

const SESSION_RESPONSES = new Set<OperationId>(['getSession', 'getStatus', 'setup', 'login', 'changePassword']);
const idPattern = /^[a-zA-Z0-9_-]{1,100}$/;
const keyPattern = /^[a-zA-Z0-9_-]{8,128}$/;

export class AbUashClient {
  readonly api: ApiMethods;
  readonly baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #mode: 'browser' | 'server';
  readonly #credentials: RequestCredentials;
  readonly #jar: MemoryCookieJar | undefined;
  readonly #timeoutMs: number;
  #csrfToken = '';
  #userId: string | undefined;

  constructor(options: ClientOptions) {
    this.baseUrl = validateBaseUrl(options.baseUrl);
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    if (typeof this.#fetch !== 'function') throw new TypeError('Forneça fetch compatível com a API Web.');
    this.#mode = options.mode ?? (typeof window === 'undefined' ? 'server' : 'browser');
    this.#credentials = options.credentials ?? 'include';
    this.#timeoutMs = validateTimeout(options.timeoutMs ?? 15_000);
    if (this.#mode === 'browser' && options.cookieJar) throw new TypeError('cookieJar só é permitido em mode: server.');
    this.#jar = this.#mode === 'server' ? options.cookieJar ?? new MemoryCookieJar(this.baseUrl) : undefined;
    this.api = Object.freeze(Object.fromEntries(Object.keys(operations).map((id) => [
      id,
      (input: unknown = {}, callOptions: InternalOptions = {}) => this.#execute(id as OperationId, this.#snapshot(id as OperationId, input), callOptions),
    ]))) as ApiMethods;
  }

  /** Equivalent to api[operationId]; responses are the exact envelope's data. */
  request<K extends OperationId>(operationId: K, ...args: OperationArguments<K>): Promise<OperationOutput<K>> {
    return this.#execute(operationId, this.#snapshot(operationId, args[0] ?? {}), args[1] ?? {}) as Promise<OperationOutput<K>>;
  }

  /**
   * Prepare only server-protected writes. No network call occurs until execute().
   * Input is serialized now; later caller mutations cannot change a replay.
   * Nothing is retried automatically, including payments.
   */
  prepare<K extends ProtectedOperationId>(
    operationId: K,
    input: OperationInput<K>,
    options: { idempotencyKey?: string } = {},
  ): PreparedOperation<K> {
    if (!operations[operationId]?.protectedWrite) throw new TypeError('Esta operação não oferece repetição idempotente no servidor.');
    const idempotencyKey = validateKey(options.idempotencyKey ?? createIdempotencyKey());
    const snapshot = this.#snapshot(operationId, input);
    const owner = this;
    // Server idempotency records are scoped to the actor. Never let a prepared
    // payment silently become a fresh mutation after switching accounts.
    let actorId = this.#userId;
    return Object.freeze({
      operationId,
      idempotencyKey,
      execute(callOptions: RequestOptions = {}) {
        if (!owner.#userId) return Promise.reject(new TypeError('Restaure a sessão antes de executar uma operação preparada.'));
        if (actorId && owner.#userId !== actorId) return Promise.reject(new TypeError('Uma operação preparada não pode ser executada por outro usuário.'));
        actorId = owner.#userId;
        return owner.#execute(operationId, snapshot, { ...callOptions, idempotencyKey }) as Promise<OperationOutput<K>>;
      },
    });
  }

  /** Remove local session data (does not revoke the server session; use logout). */
  clearSession(): void {
    this.#csrfToken = '';
    this.#userId = undefined;
    this.#jar?.clear();
  }

  toJSON(): { baseUrl: string; mode: string; session: '[redacted]' } {
    return { baseUrl: this.baseUrl, mode: this.#mode, session: '[redacted]' };
  }

  #snapshot(operationId: OperationId, raw: unknown): Snapshot {
    const definition = operations[operationId];
    if (!definition) throw new TypeError('Operação desconhecida.');
    if (!isObject(raw)) throw new TypeError('Os argumentos da operação devem ser um objeto.');
    for (const key of Object.keys(raw)) if (!['path', 'query', 'body'].includes(key)) throw new TypeError(`Argumento desconhecido: ${key}.`);
    const path = raw.path ?? {};
    const query = raw.query ?? {};
    if (!isObject(path) || !isObject(query)) throw new TypeError('path e query devem ser objetos.');
    const allowedPaths: readonly string[] = definition.pathKeys;
    const allowedQuery: readonly string[] = definition.queryKeys;
    for (const key of Object.keys(path)) if (!allowedPaths.includes(key)) throw new TypeError(`Parâmetro de caminho desconhecido: ${key}.`);
    for (const key of Object.keys(query)) if (!allowedQuery.includes(key)) throw new TypeError(`Parâmetro de consulta desconhecido: ${key}.`);
    let pathname: string = definition.path;
    for (const key of allowedPaths) {
      const value = path[key];
      if (typeof value !== 'string' || !idPattern.test(value)) throw new TypeError(`Identificador inválido: ${key}.`);
      pathname = pathname.replace(`{${key}}`, encodeURIComponent(value));
    }
    const url = new URL(pathname, this.baseUrl);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) throw new TypeError(`Valor de consulta inválido: ${key}.`);
      url.searchParams.set(key, String(value));
    }
    if (definition.method === 'GET') {
      if (raw.body !== undefined) throw new TypeError('Operações GET não aceitam body.');
      return { url: url.href };
    }
    if (!isObject(raw.body)) throw new TypeError('Esta operação exige body JSON.');
    const serializedBody = JSON.stringify(raw.body);
    if (!serializedBody) throw new TypeError('Corpo JSON inválido.');
    return { url: url.href, serializedBody };
  }

  async #execute(operationId: OperationId, snapshot: Snapshot, options: InternalOptions): Promise<unknown> {
    const definition = operations[operationId];
    const timeoutMs = validateTimeout(options.timeoutMs ?? this.#timeoutMs);
    if (!definition.protectedWrite && options.idempotencyKey !== undefined) throw new TypeError('Esta operação não aceita Idempotency-Key.');
    if (!definition.setupToken && options.setupToken !== undefined) throw new TypeError('X-Setup-Token só pode ser usado em setup.');
    const key = definition.protectedWrite ? validateKey(options.idempotencyKey ?? createIdempotencyKey()) : undefined;
    if (options.setupToken !== undefined && (typeof options.setupToken !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(options.setupToken))) throw new TypeError('setupToken exige 32 a 256 caracteres URL-safe.');
    const controller = new AbortController();
    let timedOut = false;
    let dispatched = false;
    let requestId: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => controller.abort();
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    const outcome = () => dispatched ? 'unknown' as const : 'not_sent' as const;
    const abortedError = () => new TransportError({
      kind: timedOut ? 'timeout' : 'aborted',
      outcome: outcome(),
      message: timedOut ? 'O prazo da solicitação expirou. Uma mutação enviada pode ter sido concluída.' : 'A solicitação foi cancelada. Uma mutação enviada pode ter sido concluída.',
      requestId, idempotencyKey: key, replaySafe: definition.protectedWrite,
    });
    try {
      if (controller.signal.aborted) throw abortedError();
      if (timeoutMs > 0) timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      const headers = new Headers({ Accept: 'application/json' });
      if (snapshot.serializedBody !== undefined) headers.set('Content-Type', 'application/json');
      if (definition.requiresSession && definition.method !== 'GET' && this.#csrfToken) headers.set('X-CSRF-Token', this.#csrfToken);
      if (key) headers.set('Idempotency-Key', key);
      if (options.setupToken) headers.set('X-Setup-Token', options.setupToken);
      const cookie = this.#jar?.header(snapshot.url);
      if (cookie) headers.set('Cookie', cookie);
      dispatched = true;
      const response = await raceAbort(this.#fetch(snapshot.url, {
        method: definition.method,
        headers,
        credentials: this.#credentials,
        redirect: 'manual',
        signal: controller.signal,
        cache: 'no-store',
        ...(snapshot.serializedBody === undefined ? {} : { body: snapshot.serializedBody }),
      }), controller.signal);
      requestId = response.headers.get('X-Request-Id') || undefined;
      if (response.type === 'opaqueredirect' || response.redirected || (response.status >= 300 && response.status < 400) || (response.url && new URL(response.url).origin !== this.baseUrl)) {
        throw new TransportError({ kind: 'redirect', outcome: outcome(), message: 'Redirecionamento bloqueado. Use a origem final da API; a solicitação não será reenviada.', requestId, idempotencyKey: key, replaySafe: definition.protectedWrite });
      }
      // Cookie rotation must be honored even if a subsequent response body is lost.
      this.#jar?.store(snapshot.url, response.headers);
      let payload: unknown;
      try {
        payload = await raceAbort(response.json(), controller.signal);
      } catch {
        if (controller.signal.aborted) throw abortedError();
        throw new TransportError({ kind: 'protocol', outcome: outcome(), message: 'A resposta da API não contém um envelope JSON válido.', requestId, idempotencyKey: key, replaySafe: definition.protectedWrite });
      }
      if (controller.signal.aborted) throw abortedError();
      if (!isObject(payload) || typeof payload.ok !== 'boolean') {
        throw new TransportError({ kind: 'protocol', outcome: outcome(), message: 'Envelope de resposta incompatível com a API.', requestId, idempotencyKey: key, replaySafe: definition.protectedWrite });
      }
      if (payload.ok !== response.ok) {
        throw new TransportError({ kind: 'protocol', outcome: outcome(), message: 'Status HTTP e envelope de resposta são incompatíveis.', requestId, idempotencyKey: key, replaySafe: definition.protectedWrite });
      }
      if (payload.ok === false) {
        const error = payload.error;
        if (!isObject(error) || typeof error.code !== 'string' || typeof error.message !== 'string') {
          throw new TransportError({ kind: 'protocol', outcome: outcome(), message: 'Envelope de erro incompatível com a API.', requestId, idempotencyKey: key, replaySafe: definition.protectedWrite });
        }
        if (error.code === 'AUTH_REQUIRED') this.clearSession();
        throw new ApiError({ status: response.status, code: error.code, message: error.message, details: error.details, requestId: typeof error.requestId === 'string' ? error.requestId : requestId, idempotencyKey: key });
      }
      if (!response.ok || !('data' in payload)) {
        throw new TransportError({ kind: 'protocol', outcome: outcome(), message: 'Status HTTP e envelope de resposta são incompatíveis.', requestId, idempotencyKey: key, replaySafe: definition.protectedWrite });
      }
      if (SESSION_RESPONSES.has(operationId) && isObject(payload.data)) {
        if (typeof payload.data.csrfToken === 'string' && /^[a-zA-Z0-9_-]{43}$/.test(payload.data.csrfToken)) this.#csrfToken = payload.data.csrfToken;
        else this.#csrfToken = '';
        this.#userId = isObject(payload.data.user) && typeof payload.data.user.id === 'string' ? payload.data.user.id : undefined;
      }
      if (operationId === 'logout') this.clearSession();
      return payload.data;
    } catch (error) {
      if (error instanceof ApiError || error instanceof TransportError) throw error;
      if (controller.signal.aborted) throw abortedError();
      // Do not retain injected fetch errors: they can contain credentials/URLs.
      throw new TransportError({ kind: 'network', outcome: outcome(), message: 'Não foi possível obter a resposta da API. Verifique o resultado de mutações antes de repetir.', requestId, idempotencyKey: key, replaySafe: definition.protectedWrite });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }
  }
}

export function createClient(options: ClientOptions): AbUashClient {
  return new AbUashClient(options);
}

export function createIdempotencyKey(): string {
  if (!globalThis.crypto?.randomUUID) throw new Error('crypto.randomUUID é obrigatório para gerar uma chave; forneça idempotencyKey explicitamente.');
  return globalThis.crypto.randomUUID();
}

export function validateBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new TypeError('baseUrl deve ser uma URL absoluta HTTPS ou HTTP de loopback.'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new TypeError('baseUrl deve conter somente a origem, sem credenciais, caminho, consulta ou fragmento.');
  const host = url.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new TypeError('baseUrl exige HTTPS; HTTP só é permitido em loopback.');
  return url.origin;
}

function validateTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 2_147_483_647) throw new TypeError('timeoutMs deve ser inteiro entre 0 e 2147483647.');
  return value;
}

function validateKey(value: string): string {
  if (typeof value !== 'string' || !keyPattern.test(value)) throw new TypeError('Idempotency-Key exige 8 a 128 letras, números, hífens ou sublinhados.');
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Enforces cancellation even when an injected fetch ignores AbortSignal. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // A caller may already have started fetch/body reading before cancellation.
    // Observe any eventual rejection so it cannot become an unhandled promise.
    void promise.catch(() => {});
    return Promise.reject(new Error('aborted'));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}
