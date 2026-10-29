// Reused from AB-UASH main: server/connectors/banking/validation.ts. See integrations/jk/PROVENANCE.md.
export class PixConnectorError extends Error {
    code;
    state;
    httpStatus;
    constructor(code, state = 'UNKNOWN', httpStatus){
        super(code);
        this.name = 'PixConnectorError';
        this.code = code;
        this.state = state;
        this.httpStatus = httpStatus;
    }
}
export function invalidInput() {
    throw new PixConnectorError('INVALID_INPUT', 'REJECTED');
}
export function record(value, code = 'INVALID_RESPONSE') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PixConnectorError(code, code === 'INVALID_INPUT' ? 'REJECTED' : 'UNKNOWN');
    return value;
}
export function text(value, maximum) {
    return typeof value === 'string' && value.length > 0 && value.length <= maximum && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}
export function validTxid(value) {
    return typeof value === 'string' && /^[A-Za-z0-9]{26,35}$/.test(value);
}
export function validCents(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 999_999_999_999;
}
export function centsToDecimal(value) {
    return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`;
}
export function decimalToCents(value) {
    if (typeof value !== 'string' || !/^\d{1,10}\.\d{2}$/.test(value)) throw new PixConnectorError('INVALID_RESPONSE');
    const [whole, decimal] = value.split('.');
    const cents = Number(whole) * 100 + Number(decimal);
    if (!validCents(cents)) throw new PixConnectorError('INVALID_RESPONSE');
    return cents;
}
export function validTaxId(value, kind) {
    if (typeof value !== 'string' || !(kind === 'cpf' ? /^\d{11}$/ : /^\d{14}$/).test(value) || /^(\d)\1+$/.test(value)) return false;
    const digits = [
        ...value
    ].map(Number);
    const size = kind === 'cpf' ? 9 : 12;
    for(let pass = 0; pass < 2; pass++){
        let sum = 0;
        for(let i = 0; i < size + pass; i++){
            const weight = kind === 'cpf' ? size + pass + 1 - i : (size + pass - 1 - i) % 8 + 2;
            sum += digits[i] * weight;
        }
        const remainder = sum % 11;
        if (digits[size + pass] !== (remainder < 2 ? 0 : 11 - remainder)) return false;
    }
    return true;
}
export function validPixKey(value) {
    if (!text(value, 77)) return false;
    if (/^\d+$/.test(value)) return validTaxId(value, value.length === 11 ? 'cpf' : 'cnpj');
    return /^\+[1-9]\d{1,14}$/.test(value) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
}
export function timestamp(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new PixConnectorError('INVALID_RESPONSE');
    const result = Date.parse(value);
    const date = value.slice(0, 10);
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(5, 7));
    const day = Number(date.slice(8, 10));
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (!Number.isFinite(result) || month < 1 || month > 12 || day < 1 || day > daysInMonth || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) throw new PixConnectorError('INVALID_RESPONSE');
    return result;
}
export function validatePixInput(operation, input) {
    try {
        const allowed = {
            'create-charge': [
                'txid',
                'amountCents',
                'orderId',
                'expiresInSeconds',
                'debtor',
                'description'
            ],
            'get-charge': [
                'txid',
                'amountCents',
                'orderId'
            ],
            reconcile: [
                'txid',
                'amountCents',
                'orderId',
                'start',
                'end'
            ]
        };
        if (!Object.hasOwn(allowed, operation)) return false;
        const value = record(input, 'INVALID_INPUT');
        if (Object.keys(value).some((key)=>!allowed[operation].includes(key))) return false;
        if (!validCents(value.amountCents) || (value.txid !== undefined ? !validTxid(value.txid) : operation !== 'create-charge')) return false;
        if (value.orderId !== undefined && !text(value.orderId, 200)) return false;
        if (operation === 'create-charge') {
            if (value.expiresInSeconds !== undefined && (typeof value.expiresInSeconds !== 'number' || !Number.isSafeInteger(value.expiresInSeconds) || value.expiresInSeconds < 1 || value.expiresInSeconds > 2_147_483_647)) return false;
            if (value.description !== undefined && !text(value.description, 140)) return false;
            if (value.debtor !== undefined) {
                const debtor = record(value.debtor, 'INVALID_INPUT');
                if (Object.keys(debtor).some((key)=>![
                        'cpf',
                        'cnpj',
                        'name'
                    ].includes(key)) || !text(debtor.name, 200) || debtor.cpf !== undefined === (debtor.cnpj !== undefined)) return false;
                const kind = debtor.cpf !== undefined ? 'cpf' : 'cnpj';
                if (!validTaxId(debtor[kind], kind)) return false;
            }
        }
        if (operation === 'reconcile') {
            const from = timestamp(value.start);
            const until = timestamp(value.end);
            if (until < from || until - from > 31 * 86400_000) return false;
        }
        return true;
    } catch  {
        return false;
    }
}
