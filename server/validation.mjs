import { ApiError } from './errors.mjs';

function invalid(field, message) {
  throw new ApiError(422, 'VALIDATION_ERROR', 'Confira os campos informados.', { [field]: message });
}

export function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('body', 'Informe um objeto JSON.');
  return value;
}

export function text(value, field, { min = 0, max = 200, optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string') invalid(field, 'Informe um texto.');
  const result = value.trim();
  if (result.length < min || result.length > max) invalid(field, `Use entre ${min} e ${max} caracteres.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(result)) invalid(field, 'O texto contém caracteres inválidos.');
  return result;
}

export function email(value, field = 'email') {
  const result = text(value, field, { min: 3, max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(result)) invalid(field, 'Informe um e-mail válido.');
  return result;
}

export function password(value, field = 'password') {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) invalid(field, 'Use uma senha de 12 a 128 caracteres.');
  return value;
}

export function integer(value, field, { min = 0, max = 100_000_000_000, optional = false } = {}) {
  if (optional && (value === undefined || value === null)) return undefined;
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(field, `Informe um inteiro entre ${min} e ${max}.`);
  return value;
}

export function choice(value, field, values) {
  if (!values.includes(value)) invalid(field, `Valor permitido: ${values.join(', ')}.`);
  return value;
}

export function boolean(value, field) {
  if (typeof value !== 'boolean') invalid(field, 'Informe verdadeiro ou falso.');
  return value;
}

export function identifier(value, field = 'id') {
  const result = text(value, field, { min: 1, max: 100 });
  if (!/^[a-zA-Z0-9_-]+$/u.test(result)) invalid(field, 'Identificador inválido.');
  return result;
}

export function date(value, field) {
  const result = text(value, field, { min: 10, max: 10 });
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(result) || !Number.isFinite(Date.parse(`${result}T00:00:00.000Z`)) || new Date(`${result}T00:00:00.000Z`).toISOString().slice(0, 10) !== result) invalid(field, 'Informe uma data válida (AAAA-MM-DD).');
  return result;
}

export function onlyKeys(body, keys) {
  const unexpected = Object.keys(body).filter((key) => !keys.includes(key));
  if (unexpected.length) invalid('body', `Campos não reconhecidos: ${unexpected.join(', ')}.`);
}
