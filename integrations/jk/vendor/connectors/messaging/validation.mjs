// Reused from AB-UASH main: server/connectors/messaging/validation.ts. See integrations/jk/PROVENANCE.md.
export function object(value, allowed) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value;
    return Object.keys(record).every((key)=>allowed.includes(key)) ? record : null;
}
export function boundedText(value, max) {
    return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}
export function secret(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 16_384 && !/[\u0000-\u0020\u007f]/.test(value);
}
export function timeout(value) {
    const result = value ?? 30_000;
    if (!Number.isSafeInteger(result) || result < 10 || result > 120_000) throw new TypeError('INVALID_MESSAGING_TIMEOUT');
    return result;
}
export function domain(value) {
    return typeof value === 'string' && value.length <= 253 && value === value.toLowerCase() && value.includes('.') && value.split('.').every((label)=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}
export function mailbox(value) {
    if (typeof value !== 'string' || value.length > 254) return false;
    const parts = value.split('@');
    return parts.length === 2 && parts[0].length <= 64 && parts[0].split('.').every((part)=>/^[a-zA-Z0-9!#$%&'*+\/=?^_`{|}~-]+$/.test(part)) && domain(parts[1]);
}
