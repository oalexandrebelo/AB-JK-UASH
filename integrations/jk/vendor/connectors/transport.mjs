// Reused from AB-UASH main: server/connectors/transport.ts. See integrations/jk/PROVENANCE.md.
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
export class TransportError extends Error {
    code;
    outcome;
    constructor(code, outcome){
        super(code);
        this.name = 'TransportError';
        this.code = code;
        this.outcome = outcome;
    }
}
const privateAddresses = new BlockList();
for (const [address, prefix] of [
    [
        '0.0.0.0',
        8
    ],
    [
        '10.0.0.0',
        8
    ],
    [
        '100.64.0.0',
        10
    ],
    [
        '127.0.0.0',
        8
    ],
    [
        '169.254.0.0',
        16
    ],
    [
        '172.16.0.0',
        12
    ],
    [
        '192.0.0.0',
        24
    ],
    [
        '192.0.2.0',
        24
    ],
    [
        '192.168.0.0',
        16
    ],
    [
        '198.18.0.0',
        15
    ],
    [
        '198.51.100.0',
        24
    ],
    [
        '203.0.113.0',
        24
    ],
    [
        '224.0.0.0',
        4
    ],
    [
        '240.0.0.0',
        4
    ]
])privateAddresses.addSubnet(address, prefix, 'ipv4');
function bounded(value, fallback, min, max) {
    const result = value ?? fallback;
    if (!Number.isSafeInteger(result) || result < min || result > max) throw new TransportError('INVALID_REQUEST', 'NOT_SENT');
    return result;
}
function retryAfter(response) {
    const value = response.headers['retry-after'];
    if (typeof value !== 'string') return null;
    const milliseconds = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
    return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : null;
}
export class SecureHttpTransport {
    allowedHosts;
    timeoutMs;
    maxResponseBytes;
    maxRequestBytes;
    maxConcurrent;
    failureThreshold;
    circuitResetMs;
    maxReadAttempts;
    ca;
    allowLoopback;
    active = 0;
    circuits = new Map();
    constructor(options){
        if (!options.allowedHosts.length || options.allowedHosts.length > 128) throw new TransportError('INVALID_REQUEST', 'NOT_SENT');
        this.allowedHosts = new Set(options.allowedHosts.map((host)=>{
            const normalized = host.toLowerCase();
            if (normalized !== host || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || host.length > 253 || host.includes('..')) throw new TransportError('INVALID_REQUEST', 'NOT_SENT');
            return normalized;
        }));
        this.timeoutMs = bounded(options.timeoutMs, 20_000, 10, 120_000);
        this.maxResponseBytes = bounded(options.maxResponseBytes, 2 * 1024 * 1024, 1, 16 * 1024 * 1024);
        this.maxRequestBytes = bounded(options.maxRequestBytes, 2 * 1024 * 1024, 1, 16 * 1024 * 1024);
        this.maxConcurrent = bounded(options.maxConcurrent, 8, 1, 64);
        this.failureThreshold = bounded(options.failureThreshold, 5, 1, 100);
        this.circuitResetMs = bounded(options.circuitResetMs, 30_000, 10, 300_000);
        this.maxReadAttempts = bounded(options.maxReadAttempts, 3, 1, 5);
        this.ca = options.ca ? Buffer.from(options.ca) : undefined;
        this.allowLoopback = options.allowLoopbackForTests === true;
        if (this.allowLoopback && [
            ...this.allowedHosts
        ].some((host)=>![
                'localhost',
                '127.0.0.1'
            ].includes(host))) throw new TransportError('INVALID_REQUEST', 'NOT_SENT');
    }
    async request(input) {
        let url;
        try {
            url = new URL(input.url);
        } catch  {
            throw new TransportError('INVALID_REQUEST', 'NOT_SENT');
        }
        if (url.protocol !== 'https:' || url.username || url.password || url.hash || !this.allowedHosts.has(url.hostname) || !this.allowLoopback && url.port && url.port !== '443') throw new TransportError('DESTINATION_FORBIDDEN', 'NOT_SENT');
        if (![
            'GET',
            'HEAD',
            'POST',
            'PUT',
            'PATCH',
            'DELETE'
        ].includes(input.method) || (input.body?.byteLength ?? 0) > this.maxRequestBytes) throw new TransportError('INVALID_REQUEST', 'NOT_SENT');
        const safeRead = input.retry === 'safe-read';
        if (safeRead && ![
            'GET',
            'HEAD'
        ].includes(input.method)) throw new TransportError('INVALID_REQUEST', 'NOT_SENT');
        if (input.body && [
            'GET',
            'HEAD'
        ].includes(input.method)) throw new TransportError('INVALID_REQUEST', 'NOT_SENT');
        const deadline = bounded(input.timeoutMs, this.timeoutMs, 10, 120_000);
        const headers = {};
        for (const [name, value] of Object.entries(input.headers ?? {})){
            const key = name.toLowerCase();
            if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(key) || /[\r\n\0]/.test(value) || [
                'host',
                'content-length',
                'transfer-encoding',
                'connection',
                'accept-encoding',
                'proxy-authorization'
            ].includes(key) || key in headers) throw new TransportError('INVALID_REQUEST', 'NOT_SENT');
            headers[key] = value;
        }
        if (input.signal?.aborted) throw new TransportError('ABORTED', 'NOT_SENT');
        if (this.active >= this.maxConcurrent) throw new TransportError('TRANSPORT_BUSY', 'NOT_SENT');
        const circuit = this.circuits.get(url.origin) ?? {
            failures: 0,
            openedAt: 0,
            probing: false
        };
        this.circuits.set(url.origin, circuit);
        if (circuit.openedAt) {
            if (circuit.probing || Date.now() - circuit.openedAt < this.circuitResetMs) throw new TransportError('CIRCUIT_OPEN', 'NOT_SENT');
            circuit.probing = true;
        }
        this.active++;
        const controller = new AbortController();
        const abort = ()=>controller.abort(new TransportError('ABORTED', 'NOT_SENT'));
        input.signal?.addEventListener('abort', abort, {
            once: true
        });
        const expiresAt = Date.now() + deadline;
        const timer = setTimeout(()=>controller.abort(new TransportError('DEADLINE_EXCEEDED', 'UNKNOWN')), deadline);
        let circuitFailure = false;
        try {
            for(let attempt = 0;; attempt++){
                let response;
                try {
                    response = await this.once(url, input, headers, controller.signal);
                } catch (error) {
                    const transportError = error instanceof TransportError ? error : new TransportError('NETWORK_ERROR', 'UNKNOWN');
                    const transient = [
                        'NETWORK_ERROR',
                        'DEADLINE_EXCEEDED'
                    ].includes(transportError.code);
                    circuitFailure = transient;
                    if (!safeRead || !transient || controller.signal.aborted || attempt + 1 >= this.maxReadAttempts) throw transportError;
                    await this.pause(randomInt(0, Math.min(2000, 200 * 2 ** attempt) + 1), expiresAt, controller.signal);
                    continue;
                }
                circuitFailure = response.status === 429 || response.status >= 500;
                if (!safeRead || !circuitFailure || attempt + 1 >= this.maxReadAttempts) return response;
                const pause = Math.max(retryAfter(response) ?? 0, randomInt(0, Math.min(2000, 200 * 2 ** attempt) + 1));
                if (Date.now() + pause >= expiresAt) return response;
                await this.pause(pause, expiresAt, controller.signal);
            }
        } finally{
            clearTimeout(timer);
            input.signal?.removeEventListener('abort', abort);
            this.active--;
            if (circuitFailure) {
                circuit.failures++;
                if (circuit.failures >= this.failureThreshold) circuit.openedAt = Date.now();
            } else {
                circuit.failures = 0;
                circuit.openedAt = 0;
            }
            circuit.probing = false;
        }
    }
    async pause(ms, expiresAt, signal) {
        if (Date.now() + ms >= expiresAt) throw new TransportError('DEADLINE_EXCEEDED', 'UNKNOWN');
        try {
            await delay(ms, undefined, {
                signal
            });
        } catch  {
            throw new TransportError('ABORTED', 'UNKNOWN');
        }
    }
    async once(url, input, headers, signal) {
        let addresses;
        const resolving = isIP(url.hostname) ? Promise.resolve([
            {
                address: url.hostname,
                family: isIP(url.hostname)
            }
        ]) : lookup(url.hostname, {
            all: true,
            family: 4,
            verbatim: true
        });
        let onAbort;
        try {
            addresses = await Promise.race([
                resolving,
                new Promise((_, reject)=>{
                    onAbort = ()=>reject(new TransportError(signal.reason instanceof TransportError ? signal.reason.code : 'ABORTED', 'NOT_SENT'));
                    if (signal.aborted) onAbort();
                    else signal.addEventListener('abort', onAbort, {
                        once: true
                    });
                })
            ]);
        } catch (error) {
            throw error instanceof TransportError ? error : new TransportError('NETWORK_ERROR', 'NOT_SENT');
        } finally{
            if (onAbort) signal.removeEventListener('abort', onAbort);
        }
        if (!addresses.length || addresses.some((item)=>item.family !== 4 || (this.allowLoopback ? item.address !== '127.0.0.1' : privateAddresses.check(item.address, 'ipv4')))) throw new TransportError('DESTINATION_FORBIDDEN', 'NOT_SENT');
        if (signal.aborted) throw new TransportError(signal.reason instanceof TransportError ? signal.reason.code : 'ABORTED', 'NOT_SENT');
        const address = addresses[0].address;
        const credentials = input.mtls ? 'pfx' in input.mtls ? {
            pfx: Buffer.from(input.mtls.pfx),
            passphrase: input.mtls.passphrase
        } : {
            cert: Buffer.from(input.mtls.cert),
            key: Buffer.from(input.mtls.key),
            passphrase: input.mtls.passphrase
        } : {};
        return new Promise((resolveResponse, reject)=>{
            let completed = false;
            let sent = false;
            const finish = (error, response)=>{
                if (completed) return;
                completed = true;
                if (error) reject(error);
                else resolveResponse(response);
            };
            const req = httpsRequest(url, {
                method: input.method,
                headers: {
                    ...headers,
                    'accept-encoding': 'identity',
                    'content-length': input.body?.byteLength ?? 0
                },
                agent: false,
                ca: this.ca,
                ...credentials,
                rejectUnauthorized: true,
                minVersion: 'TLSv1.2',
                signal,
                family: 4,
                lookup: (_host, _options, callback)=>callback(null, address, 4)
            }, (response)=>{
                const status = response.statusCode ?? 0;
                const outcome = sent ? 'UNKNOWN' : 'NOT_SENT';
                if (status >= 300 && status < 400) {
                    finish(new TransportError('REDIRECT_REFUSED', outcome));
                    response.destroy();
                    req.destroy();
                    return;
                }
                if (!Number.isInteger(status) || status < 100 || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
                    finish(new TransportError('INVALID_RESPONSE', outcome));
                    response.destroy();
                    req.destroy();
                    return;
                }
                const declared = Number(response.headers['content-length']);
                if (Number.isFinite(declared) && declared > this.maxResponseBytes) {
                    finish(new TransportError('RESPONSE_TOO_LARGE', outcome));
                    response.destroy();
                    req.destroy();
                    return;
                }
                const chunks = [];
                let length = 0;
                response.on('data', (chunk)=>{
                    if (completed) return;
                    length += chunk.length;
                    if (length > this.maxResponseBytes) {
                        chunks.length = 0;
                        finish(new TransportError('RESPONSE_TOO_LARGE', outcome));
                        response.destroy();
                        req.destroy();
                    } else chunks.push(chunk);
                });
                response.once('end', ()=>{
                    if (!completed) finish(undefined, {
                        status,
                        headers: response.headers,
                        body: Buffer.concat(chunks, length)
                    });
                });
                response.once('error', ()=>finish(new TransportError('NETWORK_ERROR', outcome)));
                response.once('aborted', ()=>finish(new TransportError('NETWORK_ERROR', outcome)));
            });
            req.once('socket', (socket)=>{
                socket.once('secureConnect', ()=>{
                    sent = true;
                });
            });
            req.once('finish', ()=>{
                sent = true;
            });
            req.once('error', ()=>finish(new TransportError(signal.aborted && signal.reason instanceof TransportError ? signal.reason.code : 'NETWORK_ERROR', sent ? 'UNKNOWN' : 'NOT_SENT')));
            req.end(input.body);
        });
    }
}
