// Reused from AB-UASH main: server/connectors/banking/index.ts. See integrations/jk/PROVENANCE.md.
import { createHash } from 'node:crypto';
import { TransportError } from '../transport.mjs';
import { getPixProviderProfile } from './profiles.mjs';
import { PixConnectorError, invalidInput, record, text, validTxid, validCents, validTaxId, validPixKey, centsToDecimal, decimalToCents, timestamp, validatePixInput } from './validation.mjs';
export { getPixProviderProfile, pixAllowedHosts } from './profiles.mjs';
export { validatePixInput } from './validation.mjs';
function json(response, code = 'INVALID_RESPONSE') {
    const type = response.headers['content-type'];
    if (typeof type !== 'string' || !/^application\/json(?:\s*;|$)/i.test(type) || response.body.byteLength > 2 * 1024 * 1024) throw new PixConnectorError(code);
    try {
        return record(JSON.parse(new TextDecoder('utf-8', {
            fatal: true
        }).decode(response.body)), code);
    } catch  {
        throw new PixConnectorError(code);
    }
}
function integer(value, minimum, maximum) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function parseCharge(data, expected, pixKey) {
    const value = record(data.valor);
    const amountCents = decimalToCents(value.original);
    if (value.modalidadeAlteracao !== undefined && value.modalidadeAlteracao !== 0) throw new PixConnectorError('RESPONSE_MISMATCH');
    if (data.txid !== expected.txid || amountCents !== expected.amountCents || data.chave !== pixKey) throw new PixConnectorError('RESPONSE_MISMATCH');
    if (typeof data.status !== 'string' || ![
        'ATIVA',
        'CONCLUIDA',
        'REMOVIDA_PELO_USUARIO_RECEBEDOR',
        'REMOVIDA_PELO_PSP'
    ].includes(data.status) || !integer(data.revisao, 0, Number.MAX_SAFE_INTEGER)) throw new PixConnectorError('INVALID_RESPONSE');
    const calendar = record(data.calendario);
    timestamp(calendar.criacao);
    if (!integer(calendar.expiracao, 1, 2_147_483_647)) throw new PixConnectorError('INVALID_RESPONSE');
    if (data.pixCopiaECola !== undefined && !text(data.pixCopiaECola, 10_000)) throw new PixConnectorError('INVALID_RESPONSE');
    return {
        txid: expected.txid,
        amountCents,
        chargeStatus: data.status,
        revision: data.revisao,
        ...typeof data.pixCopiaECola === 'string' ? {
            pixCopiaECola: data.pixCopiaECola
        } : {}
    };
}
function parseReceipt(input, expected, pixKey, start, end) {
    const value = record(input);
    if (value.txid !== expected.txid || value.chave !== undefined && value.chave !== pixKey) throw new PixConnectorError('RESPONSE_MISMATCH');
    if (typeof value.endToEndId !== 'string' || !/^E[a-zA-Z0-9]{31}$/.test(value.endToEndId) || typeof value.horario !== 'string') throw new PixConnectorError('INVALID_RESPONSE');
    const received = timestamp(value.horario);
    if (received < start || received > end) throw new PixConnectorError('RESPONSE_MISMATCH');
    const amountCents = decimalToCents(value.valor);
    let refundedCents = 0;
    let refundPending = false;
    if (value.devolucoes !== undefined) {
        if (!Array.isArray(value.devolucoes) || value.devolucoes.length > 1000) throw new PixConnectorError('INVALID_RESPONSE');
        const ids = new Set();
        for (const item of value.devolucoes){
            const refund = record(item);
            if (typeof refund.id !== 'string' || !/^[A-Za-z0-9]{1,35}$/.test(refund.id) || ids.has(refund.id) || ![
                'DEVOLVIDO',
                'EM_PROCESSAMENTO',
                'NAO_REALIZADO'
            ].includes(String(refund.status))) throw new PixConnectorError('INVALID_RESPONSE');
            ids.add(refund.id);
            const refundCents = decimalToCents(refund.valor);
            if (refundCents > amountCents) throw new PixConnectorError('INVALID_RESPONSE');
            if (refund.status === 'DEVOLVIDO') refundedCents += refundCents;
            if (refund.status === 'EM_PROCESSAMENTO') refundPending = true;
        }
    }
    if (refundedCents > amountCents) throw new PixConnectorError('INVALID_RESPONSE');
    return {
        endToEndId: value.endToEndId,
        amountCents,
        receivedAt: value.horario,
        refundedCents,
        refundPending
    };
}
export class PixBankingAdapter {
    id;
    operations = Object.freeze([
        'create-charge',
        'get-charge',
        'reconcile'
    ]);
    #config;
    #profile;
    #transport;
    #journal;
    #scope;
    #token;
    #pendingToken;
    constructor(config, transport, journal){
        if (!config || ![
            'efi',
            'inter'
        ].includes(config.provider) || ![
            'homologation',
            'production'
        ].includes(config.environment) || !text(config.clientId, 4096) || config.clientId.includes(':') || !text(config.clientSecret, 4096) || !validPixKey(config.pixKey)) throw new PixConnectorError('INVALID_CONFIGURATION', 'REJECTED');
        if (config.accountNumber !== undefined && (config.provider !== 'inter' || !/^\d{1,20}$/.test(config.accountNumber))) throw new PixConnectorError('INVALID_CONFIGURATION', 'REJECTED');
        const mtls = config.mtls;
        if (!mtls || !('pfx' in mtls ? mtls.pfx instanceof Uint8Array && mtls.pfx.byteLength > 0 : mtls.cert instanceof Uint8Array && mtls.cert.byteLength > 0 && mtls.key instanceof Uint8Array && mtls.key.byteLength > 0)) throw new PixConnectorError('INVALID_CONFIGURATION', 'REJECTED');
        const copy = 'pfx' in mtls ? {
            pfx: Buffer.from(mtls.pfx),
            passphrase: mtls.passphrase
        } : {
            cert: Buffer.from(mtls.cert),
            key: Buffer.from(mtls.key),
            passphrase: mtls.passphrase
        };
        this.#config = {
            ...config,
            mtls: copy
        };
        this.#profile = getPixProviderProfile(config.provider, config.environment);
        this.#transport = transport;
        this.#journal = journal;
        this.#scope = `${config.provider}:${config.environment}:${createHash('sha256').update(config.pixKey).digest('hex')}`;
        this.id = `pix-${config.provider}`;
    }
    async execute(operation, input, context) {
        let reference;
        try {
            if (!this.operations.includes(operation)) throw new PixConnectorError('UNSUPPORTED_OPERATION', 'REJECTED');
            if (!validatePixInput(operation, input)) invalidInput();
            if (!text(context.idempotencyKey, 200)) invalidInput();
            if (context.signal.aborted) throw new PixConnectorError('ABORTED', 'REJECTED');
            const request = record(input, 'INVALID_INPUT');
            const txid = request.txid ?? (operation === 'create-charge' ? createHash('sha256').update(`${this.id}\0${this.#profile.environment}\0${context.idempotencyKey}`).digest('hex').slice(0, 32) : undefined);
            if (!validTxid(txid) || !validCents(request.amountCents)) invalidInput();
            reference = txid;
            const expected = {
                txid,
                amountCents: request.amountCents
            };
            if (request.orderId !== undefined && !text(request.orderId, 200)) invalidInput();
            const orderId = typeof request.orderId === 'string' ? request.orderId : null;
            if (operation === 'create-charge') {
                const expiration = request.expiresInSeconds ?? 3600;
                if (!integer(expiration, 1, 2_147_483_647) || request.description !== undefined && !text(request.description, 140)) invalidInput();
                const body = {
                    calendario: {
                        expiracao: expiration
                    },
                    valor: {
                        original: centsToDecimal(expected.amountCents),
                        modalidadeAlteracao: 0
                    },
                    chave: this.#config.pixKey
                };
                if (request.debtor !== undefined) {
                    const debtor = record(request.debtor, 'INVALID_INPUT');
                    if (!text(debtor.name, 200) || debtor.cpf !== undefined === (debtor.cnpj !== undefined)) invalidInput();
                    const kind = debtor.cpf !== undefined ? 'cpf' : 'cnpj';
                    if (!validTaxId(debtor[kind], kind)) invalidInput();
                    body.devedor = {
                        [kind]: debtor[kind],
                        nome: debtor.name
                    };
                }
                if (request.description !== undefined) body.solicitacaoPagador = request.description;
                const fingerprint = createHash('sha256').update(JSON.stringify({
                    body,
                    orderId
                })).digest('hex');
                const reservation = await this.#journal.reserve({
                    scope: this.#scope,
                    txid,
                    fingerprint,
                    amountCents: expected.amountCents,
                    orderId
                });
                if (reservation === 'CONFLICT') throw new PixConnectorError('IDEMPOTENCY_CONFLICT', 'REJECTED');
                const replayed = reservation === 'EXISTING';
                const result = await this.#api(replayed ? 'GET' : 'PUT', `/cob/${txid}`, context.signal, replayed ? undefined : body);
                const charge = parseCharge(result, expected, this.#config.pixKey);
                if (record(result.calendario).expiracao !== expiration) throw new PixConnectorError('RESPONSE_MISMATCH');
                if (body.devedor) {
                    const expectedDebtor = record(body.devedor);
                    const returnedDebtor = record(result.devedor);
                    if (returnedDebtor.cpf !== expectedDebtor.cpf || returnedDebtor.cnpj !== expectedDebtor.cnpj || returnedDebtor.nome !== expectedDebtor.nome) throw new PixConnectorError('RESPONSE_MISMATCH');
                }
                return {
                    state: 'SUCCEEDED',
                    providerReference: txid,
                    data: {
                        ...charge,
                        orderId,
                        replayed,
                        journalLinked: true,
                        paymentConfirmed: false,
                        environment: this.#profile.environment
                    }
                };
            }
            const reservation = await this.#journal.find(this.#scope, txid);
            if (reservation && (reservation.amountCents !== expected.amountCents || orderId !== null && reservation.orderId !== orderId)) throw new PixConnectorError('IDEMPOTENCY_CONFLICT', 'REJECTED');
            let period;
            if (operation === 'reconcile') {
                try {
                    const from = timestamp(request.start);
                    const until = timestamp(request.end);
                    if (typeof request.start !== 'string' || typeof request.end !== 'string' || until < from || until - from > 31 * 86400_000) invalidInput();
                    period = {
                        start: request.start,
                        end: request.end,
                        from,
                        until
                    };
                } catch  {
                    invalidInput();
                }
            }
            const charge = parseCharge(await this.#api('GET', `/cob/${txid}`, context.signal), expected, this.#config.pixKey);
            if (!period) return {
                state: 'SUCCEEDED',
                providerReference: txid,
                data: {
                    ...charge,
                    orderId: reservation?.orderId ?? null,
                    journalLinked: !!reservation,
                    paymentConfirmed: false,
                    environment: this.#profile.environment
                }
            };
            const receipts = await this.#receipts(expected, period, context.signal);
            const grossCents = receipts.reduce((sum, item)=>sum + item.amountCents, 0);
            const refundedCents = receipts.reduce((sum, item)=>sum + item.refundedCents, 0);
            if (!Number.isSafeInteger(grossCents) || !Number.isSafeInteger(refundedCents)) throw new PixConnectorError('INVALID_RESPONSE');
            const receivedCents = grossCents - refundedCents;
            const refundPending = receipts.some((item)=>item.refundPending);
            const paymentConfirmed = !!reservation && receipts.length > 0 && receivedCents === expected.amountCents && charge.chargeStatus === 'CONCLUIDA' && refundedCents === 0 && !refundPending;
            const receiptStatus = paymentConfirmed ? 'CONFIRMED' : !reservation || refundedCents > 0 || refundPending || receivedCents > expected.amountCents || charge.chargeStatus === 'CONCLUIDA' && receivedCents === 0 || receivedCents === expected.amountCents && charge.chargeStatus !== 'CONCLUIDA' ? 'REVIEW' : receivedCents > 0 ? 'PARTIAL' : 'PENDING';
            return {
                state: 'SUCCEEDED',
                providerReference: txid,
                data: {
                    ...charge,
                    orderId: reservation?.orderId ?? null,
                    journalLinked: !!reservation,
                    paymentConfirmed,
                    receiptStatus,
                    receivedCents,
                    refundedCents,
                    outstandingCents: Math.max(0, expected.amountCents - receivedCents),
                    receipts,
                    evidenceSource: 'authenticated-polling',
                    observedAt: new Date().toISOString(),
                    environment: this.#profile.environment
                }
            };
        } catch (error) {
            const safe = error instanceof PixConnectorError ? error : error instanceof TransportError ? new PixConnectorError('TRANSPORT_ERROR', error.outcome === 'NOT_SENT' ? 'REJECTED' : 'UNKNOWN') : new PixConnectorError('INVALID_RESPONSE');
            return {
                state: safe.state,
                ...reference ? {
                    providerReference: reference
                } : {},
                data: {
                    errorCode: safe.code,
                    ...safe.httpStatus ? {
                        httpStatus: safe.httpStatus
                    } : {},
                    paymentConfirmed: false,
                    environment: this.#profile.environment
                }
            };
        }
    }
    async #api(method, path, signal, body) {
        for(let attempt = 0;; attempt++){
            const token = await this.#accessToken(signal);
            const response = await this.#transport.request({
                url: this.#profile.apiBaseUrl + path,
                method,
                headers: {
                    authorization: `Bearer ${token}`,
                    accept: 'application/json',
                    ...body ? {
                        'content-type': 'application/json'
                    } : {},
                    ...this.#config.accountNumber ? {
                        'x-conta-corrente': this.#config.accountNumber
                    } : {}
                },
                ...body ? {
                    body: Buffer.from(JSON.stringify(body))
                } : {},
                mtls: this.#config.mtls,
                signal,
                retry: method === 'GET' ? 'safe-read' : 'never'
            });
            if (response.status === 401) {
                if (this.#token?.value === token) this.#token = undefined;
                if (method === 'GET' && attempt === 0) continue;
            }
            if (method === 'GET' && response.status !== 200 || method === 'PUT' && response.status !== 201) {
                const ambiguous = response.status >= 500 || response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 200 && response.status < 400;
                throw new PixConnectorError(ambiguous ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_REJECTED', ambiguous ? 'UNKNOWN' : 'REJECTED', response.status);
            }
            return json(response);
        }
    }
    async #accessToken(signal) {
        if (signal.aborted) throw new PixConnectorError('ABORTED', 'REJECTED');
        if (this.#token && this.#token.expiresAt > Date.now()) return this.#token.value;
        if (!this.#pendingToken) this.#pendingToken = this.#authenticate().finally(()=>{
            this.#pendingToken = undefined;
        });
        const pending = this.#pendingToken;
        return new Promise((resolve, reject)=>{
            const abort = ()=>{
                cleanup();
                reject(new PixConnectorError('ABORTED', 'REJECTED'));
            };
            const cleanup = ()=>signal.removeEventListener('abort', abort);
            signal.addEventListener('abort', abort, {
                once: true
            });
            pending.then((value)=>{
                cleanup();
                resolve(value);
            }, (error)=>{
                cleanup();
                reject(error);
            });
            if (signal.aborted) abort();
        });
    }
    async #authenticate() {
        const startedAt = Date.now();
        const basic = this.#profile.authentication === 'basic-json';
        let response;
        try {
            response = await this.#transport.request({
                url: this.#profile.tokenUrl,
                method: 'POST',
                headers: {
                    accept: 'application/json',
                    'content-type': basic ? 'application/json' : 'application/x-www-form-urlencoded',
                    ...basic ? {
                        authorization: `Basic ${Buffer.from(`${this.#config.clientId}:${this.#config.clientSecret}`).toString('base64')}`
                    } : {}
                },
                body: Buffer.from(basic ? JSON.stringify({
                    grant_type: 'client_credentials'
                }) : new URLSearchParams({
                    grant_type: 'client_credentials',
                    client_id: this.#config.clientId,
                    client_secret: this.#config.clientSecret,
                    scope: this.#profile.scopes.join(' ')
                }).toString()),
                mtls: this.#config.mtls,
                timeoutMs: 20_000,
                retry: 'never'
            });
        } catch  {
            throw new PixConnectorError('AUTH_UNAVAILABLE', 'REJECTED');
        }
        if (response.status !== 200) throw new PixConnectorError(response.status >= 400 && response.status < 500 ? 'AUTH_REJECTED' : 'AUTH_UNAVAILABLE', 'REJECTED', response.status);
        const result = json(response, 'AUTH_RESPONSE_INVALID');
        if (typeof result.access_token !== 'string' || result.access_token.length > 8192 || !/^[A-Za-z0-9._~+\/-]+={0,2}$/.test(result.access_token) || typeof result.token_type !== 'string' || result.token_type.toLowerCase() !== 'bearer' || !integer(result.expires_in, 1, 86_400)) throw new PixConnectorError('AUTH_RESPONSE_INVALID', 'REJECTED');
        if (result.scope !== undefined && (typeof result.scope !== 'string' || !this.#profile.scopes.every((scope)=>result.scope.split(' ').includes(scope)))) throw new PixConnectorError('AUTH_REJECTED', 'REJECTED');
        const ttl = result.expires_in * 1000;
        const expiresAt = startedAt + ttl - Math.min(30_000, ttl / 10);
        if (expiresAt <= Date.now()) throw new PixConnectorError('AUTH_RESPONSE_INVALID', 'REJECTED');
        this.#token = {
            value: result.access_token,
            expiresAt
        };
        return result.access_token;
    }
    async #receipts(expected, period, signal) {
        const receipts = [];
        const ids = new Set();
        let totalPages = 1;
        let totalItems;
        let observedItems = 0;
        for(let page = 0; page < totalPages; page++){
            const query = new URLSearchParams({
                inicio: period.start,
                fim: period.end,
                [this.#profile.txidQuery]: expected.txid,
                'paginacao.paginaAtual': String(page),
                'paginacao.itensPorPagina': '100'
            });
            const data = await this.#api('GET', `/pix?${query}`, signal);
            const parameters = record(data.parametros);
            const pagination = record(parameters.paginacao);
            if (timestamp(parameters.inicio) !== period.from || timestamp(parameters.fim) !== period.until) throw new PixConnectorError('RESPONSE_MISMATCH');
            if (pagination.paginaAtual !== page || !integer(pagination.itensPorPagina, 1, 100) || !integer(pagination.quantidadeDePaginas, 0, 100) || !integer(pagination.quantidadeTotalDeItens, 0, 10_000) || !Array.isArray(data.pix) || data.pix.length > pagination.itensPorPagina) throw new PixConnectorError('INCOMPLETE_RECONCILIATION');
            const pages = Math.max(1, pagination.quantidadeDePaginas);
            if (page > 0 && (pages !== totalPages || pagination.quantidadeTotalDeItens !== totalItems)) throw new PixConnectorError('INCOMPLETE_RECONCILIATION');
            totalPages = pages;
            totalItems = pagination.quantidadeTotalDeItens;
            if (totalItems > 0 && pages !== Math.ceil(totalItems / pagination.itensPorPagina)) throw new PixConnectorError('INCOMPLETE_RECONCILIATION');
            observedItems += data.pix.length;
            for (const item of data.pix){
                const receipt = parseReceipt(item, expected, this.#config.pixKey, period.from, period.until);
                if (ids.has(receipt.endToEndId)) throw new PixConnectorError('DUPLICATE_RECEIPT');
                ids.add(receipt.endToEndId);
                receipts.push(receipt);
            }
        }
        if (observedItems !== totalItems) throw new PixConnectorError('INCOMPLETE_RECONCILIATION');
        return receipts;
    }
}
