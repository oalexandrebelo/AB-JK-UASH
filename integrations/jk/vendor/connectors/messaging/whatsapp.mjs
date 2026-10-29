// Reused from AB-UASH main: server/connectors/messaging/whatsapp.ts. See integrations/jk/PROVENANCE.md.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { TransportError } from '../transport.mjs';
import { readPrivateText } from '../../integrations/secrets.mjs';
import { boundedText, object, secret, timeout } from './validation.mjs';
function recipient(value) {
    return typeof value === 'string' && /^\+?[1-9]\d{7,14}$/.test(value);
}
export function validateWhatsAppInput(operation, input) {
    if (operation === 'send-text') {
        const item = object(input, [
            'to',
            'text',
            'previewUrl'
        ]);
        return !!item && recipient(item.to) && boundedText(item.text, 4096) && (item.previewUrl === undefined || typeof item.previewUrl === 'boolean');
    }
    if (operation === 'send-template') {
        const item = object(input, [
            'to',
            'templateName',
            'languageCode',
            'bodyParameters'
        ]);
        return !!item && recipient(item.to) && typeof item.templateName === 'string' && /^[a-z0-9_]{1,128}$/.test(item.templateName) && typeof item.languageCode === 'string' && /^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(item.languageCode) && (item.bodyParameters === undefined || Array.isArray(item.bodyParameters) && item.bodyParameters.length <= 30 && item.bodyParameters.every((value)=>boundedText(value, 1024)));
    }
    return false;
}
export class WhatsAppCloudAdapter {
    id = 'whatsapp-cloud';
    operations = [
        'send-text',
        'send-template'
    ];
    #token;
    #url;
    #timeoutMs;
    #transport;
    constructor(config, transport){
        if (!/^[1-9]\d{4,29}$/.test(config.phoneNumberId) || !/^v[1-9]\d{1,2}\.\d{1,2}$/.test(config.graphVersion) || !secret(config.accessToken)) throw new TypeError('INVALID_WHATSAPP_CONFIG');
        this.#token = config.accessToken;
        this.#url = `https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`;
        this.#timeoutMs = timeout(config.timeoutMs);
        this.#transport = transport;
    }
    async execute(operation, input, context) {
        if (!validateWhatsAppInput(operation, input)) return {
            state: 'REJECTED',
            data: {
                code: 'INVALID_MESSAGE_INPUT'
            }
        };
        if (context.signal.aborted) throw new TransportError('ABORTED', 'NOT_SENT');
        let payload;
        if (operation === 'send-text') {
            const message = input;
            payload = {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: message.to.replace(/^\+/, ''),
                type: 'text',
                text: {
                    body: message.text,
                    preview_url: message.previewUrl ?? false
                }
            };
        } else {
            const message = input;
            const template = {
                name: message.templateName,
                language: {
                    code: message.languageCode
                }
            };
            if (message.bodyParameters?.length) template.components = [
                {
                    type: 'body',
                    parameters: message.bodyParameters.map((text)=>({
                            type: 'text',
                            text
                        }))
                }
            ];
            payload = {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: message.to.replace(/^\+/, ''),
                type: 'template',
                template
            };
        }
        const response = await this.#transport.request({
            url: this.#url,
            method: 'POST',
            headers: {
                authorization: `Bearer ${this.#token}`,
                'content-type': 'application/json',
                accept: 'application/json'
            },
            body: Buffer.from(JSON.stringify(payload)),
            signal: context.signal,
            timeoutMs: this.#timeoutMs,
            retry: 'never'
        });
        let body;
        try {
            body = JSON.parse(new TextDecoder('utf-8', {
                fatal: true
            }).decode(response.body));
        } catch  {
            body = null;
        }
        const record = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
        if (response.status >= 200 && response.status < 300) {
            const messages = record?.messages;
            const message = Array.isArray(messages) && messages.length === 1 ? messages[0] : null;
            const reference = message && typeof message === 'object' && !Array.isArray(message) ? message.id : null;
            if (record?.messaging_product !== 'whatsapp' || typeof reference !== 'string' || !/^wamid\.[A-Za-z0-9_+/=-]{1,512}$/.test(reference)) return {
                state: 'UNKNOWN',
                data: {
                    code: 'INVALID_PROVIDER_RESPONSE',
                    channel: 'whatsapp'
                }
            };
            return {
                state: 'SUCCEEDED',
                providerReference: reference,
                data: {
                    channel: 'whatsapp',
                    acceptance: 'provider-accepted',
                    delivery: 'unconfirmed'
                }
            };
        }
        const providerError = record?.error;
        const providerCode = providerError && typeof providerError === 'object' && !Array.isArray(providerError) ? providerError.code : undefined;
        const data = {
            code: 'WHATSAPP_HTTP_ERROR',
            channel: 'whatsapp',
            httpStatus: response.status
        };
        if (typeof providerCode === 'number' && Number.isSafeInteger(providerCode)) data.providerCode = providerCode;
        return {
            state: response.status >= 400 && response.status < 500 && response.status !== 408 ? 'REJECTED' : 'UNKNOWN',
            data
        };
    }
}
export async function loadWhatsAppCloudAdapter(root, config, transport) {
    const { accessTokenFile, ...settings } = config;
    return new WhatsAppCloudAdapter({
        ...settings,
        accessToken: await readPrivateText(root, accessTokenFile)
    }, transport);
}
export function verifyWhatsAppSignature(rawBody, signature, appSecret) {
    if (!secret(appSecret) || !(rawBody instanceof Uint8Array) || rawBody.byteLength > 1024 * 1024 || typeof signature !== 'string' || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) return false;
    const expected = createHmac('sha256', appSecret).update(rawBody).digest();
    return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}
export function verifyWhatsAppChallenge(parameters, expectedToken) {
    if (!secret(expectedToken) || [
        'hub.mode',
        'hub.verify_token',
        'hub.challenge'
    ].some((key)=>parameters.getAll(key).length !== 1)) return null;
    const candidate = parameters.get('hub.verify_token');
    const challenge = parameters.get('hub.challenge');
    if (parameters.get('hub.mode') !== 'subscribe' || !secret(candidate) || !challenge || !/^\d{1,256}$/.test(challenge)) return null;
    return timingSafeEqual(createHash('sha256').update(candidate).digest(), createHash('sha256').update(expectedToken).digest()) ? challenge : null;
}
