import { randomUUID } from 'node:crypto';
import { ApiError, assert } from './errors.mjs';
import * as v from './validation.mjs';
import { audit, idempotentWrite } from './db.mjs';
import { requireRole, requireLiveRole } from './security.mjs';
import { readJson } from './http.mjs';

export const OPERATORS = ['admin', 'manager', 'operator'];
export const MANAGERS = ['admin', 'manager'];
export const READERS = ['admin', 'manager', 'operator', 'viewer'];
export const METHODS = ['cash', 'pix', 'credit', 'debit', 'transfer'];
export const now = () => new Date().toISOString();
export const id = () => randomUUID();
export const money = (value, field, min = 0) => v.integer(value, field, { min, max: 1_000_000_000 });
export const quantity = (value, field, min = 0) => v.integer(value, field, { min, max: 1_000_000_000 });
export const memo = (value, field = 'notes') => v.text(value ?? '', field, { max: 2000 });
export const roundRatio = (amount, numerator, denominator) => Number((BigInt(amount) * BigInt(numerator) + BigInt(Math.floor(denominator / 2))) / BigInt(denominator));
export const floorRatio = (amount, numerator, denominator) => Number(BigInt(amount) * BigInt(numerator) / BigInt(denominator));
const snake = (key) => key.replace(/[A-Z]/gu, (character) => `_${character.toLowerCase()}`);
const camel = (key) => key.replace(/_([a-z])/gu, (_, character) => character.toUpperCase());
const BOOLS = new Set(['active', 'postpaid', 'reversed']);

export function publicRecord(row) {
  if (!row) return null;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [camel(key), BOOLS.has(key) ? Boolean(value) : value]));
}

export async function record(db, table, recordId, active = false) {
  const found = (await db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(v.identifier(recordId)));
  assert(found, 404, 'NOT_FOUND', 'Registro não encontrado.');
  if (active) assert(found.active === 1, 409, 'INACTIVE_RECORD', 'O cadastro está inativo.');
  return found;
}

export function version(row, input) {
  v.integer(input, 'version', { min: 1 });
  assert(row.version === input, 409, 'VERSION_CONFLICT', 'O registro foi atualizado. Recarregue os dados antes de tentar novamente.', { currentVersion: row.version });
}

export async function insert(db, table, fields) {
  const stamp = now();
  const values = { id: id(), ...fields, version: 1, createdAt: stamp, updatedAt: stamp };
  const keys = Object.keys(values);
  (await db.prepare(`INSERT INTO ${table}(${keys.map(snake).join(',')}) VALUES(${keys.map(() => '?').join(',')})`)
    .run(...keys.map((key) => typeof values[key] === 'boolean' ? Number(values[key]) : values[key])));
  return (await record(db, table, values.id));
}

export async function update(db, table, row, fields) {
  const values = { ...fields, updatedAt: now() };
  const keys = Object.keys(values);
  const result = (await db.prepare(`UPDATE ${table} SET ${keys.map((key) => `${snake(key)}=?`).join(',')},version=version+1 WHERE id=? AND version=?`)
    .run(...keys.map((key) => typeof values[key] === 'boolean' ? Number(values[key]) : values[key]), row.id, row.version));
  assert(result.changes === 1, 409, 'VERSION_CONFLICT', 'O registro foi atualizado. Recarregue os dados.');
  return (await record(db, table, row.id));
}

export async function changed(ctx, action, type, recordId, metadata = {}) {
  (await audit(ctx.db, { actorId: ctx.session.user.id, action, resourceType: type, resourceId: recordId, metadata }));
}

export async function mutate(ctx, roles, operation, status = 200) {
  const actor = requireRole(ctx.session, roles);
  const body = v.object(await readJson(ctx.request));
  const response = (await idempotentWrite(ctx.db, { actorId: actor.id, key: ctx.request.headers['idempotency-key'], method: ctx.method, path: ctx.pathname, body, authorize: async () => (await requireLiveRole(ctx.db, ctx.session, roles)) }, async () => {
    (await requireLiveRole(ctx.db, ctx.session, roles));
    return { status, data: { item: (await operation(body)) } };
  }));
  if (response.replayed) response.headers = { 'Idempotency-Replayed': 'true' };
  return response;
}

export function limit(url) {
  return v.integer(Number(url.searchParams.get('limit') ?? 200), 'limit', { min: 1, max: 500 });
}

export async function paginate(db, url, sql, params = []) {
  const count = limit(url);
  const offset = v.integer(Number(url.searchParams.get('offset') ?? 0), 'offset', { min: 0, max: 1_000_000_000 });
  const total = (await db.prepare(`SELECT COUNT(*) AS count FROM (${sql}) AS counted`).get(...params)).count;
  const statement = db.prepare(`${sql} LIMIT ? OFFSET ?`);
  statement.setReadBigInts(true);
  const rows = (await statement.all(...params, count, offset)).map((row) => Object.fromEntries(Object.entries(row).map(([key,value]) => {
    if (typeof value !== 'bigint') return [key,value];
    assert(value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER), 422, 'AMOUNT_LIMIT', 'O total excede o limite numérico permitido.');
    return [key,Number(value)];
  })));
  return { rows, page: { limit: count, offset, total, hasMore: offset + rows.length < total } };
}

export function sumSafe(values) {
  const total = values.reduce((accumulator, value) => accumulator + BigInt(value), 0n);
  assert(total >= 0n && total <= BigInt(Number.MAX_SAFE_INTEGER), 422, 'AMOUNT_LIMIT', 'O total excede o limite de cálculo permitido.');
  return Number(total);
}

export function iso(value, field, optional = false) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  const raw = v.text(value, field, { min: 20, max: 40 });
  v.date(raw.slice(0, 10), field);
  assert(/T.+(?:Z|[+-]\d{2}:\d{2})$/u.test(raw) && Number.isFinite(Date.parse(raw)), 422, 'VALIDATION_ERROR', 'Informe data e hora com fuso horário.', { [field]: 'Use ISO 8601 com Z ou deslocamento explícito.' });
  return new Date(raw).toISOString();
}

export async function settings(db) {
  const stored = (await db.prepare("SELECT value_json FROM app_settings WHERE key='business'").get());
  return stored ? JSON.parse(stored.value_json) : { businessName: 'AB-UASH', phone: '', address: '', currency: 'BRL', timezone: 'America/Sao_Paulo', receiptFooter: 'Recibo NÃO FISCAL. Pagamento registrado localmente.', version: 1 };
}

export function businessDate(value = now(), zone = 'America/Sao_Paulo') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function addDays(date, count) {
  const parsed = new Date(`${date}T12:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + count);
  return parsed.toISOString().slice(0, 10);
}

export function localMidnight(date, zone = 'America/Sao_Paulo') {
  const [year, month, day] = date.split('-').map(Number);
  const desired = Date.UTC(year, month - 1, day);
  let candidate = desired;
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const p = Object.fromEntries(formatter.formatToParts(new Date(candidate)).map((part) => [part.type, part.value]));
    const seen = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
    const correction = desired - seen;
    candidate += correction;
    if (correction === 0) break;
  }
  return new Date(candidate).toISOString();
}

export async function dateRange(db, url) {
  const zone = (await settings(db)).timezone;
  const today = businessDate(now(), zone);
  const from = v.date(url.searchParams.get('from') || `${today.slice(0, 7)}-01`, 'from');
  const to = v.date(url.searchParams.get('to') || today, 'to');
  assert(from <= to, 422, 'VALIDATION_ERROR', 'A data inicial deve anteceder a data final.');
  assert(Date.parse(to) - Date.parse(from) <= 366 * 5 * 86400_000, 422, 'VALIDATION_ERROR', 'Selecione um período de até cinco anos.');
  return { from, to, start: localMidnight(from, zone), end: localMidnight(addDays(to, 1), zone) };
}

const nameField = (value) => v.text(value, 'name', { min: 2, max: 120 });
const activeField = (value) => v.boolean(value, 'active');
const optionalEmail = (value) => value === '' || value === null ? '' : v.email(value);
export const MASTERS = {
  customers: { roles: OPERATORS, search: ['name', 'phone', 'email'], defaults: { phone: '', email: '', kind: 'individual', postpaid: false, notes: '', active: true }, fields: {
    name: nameField, phone: (x) => v.text(x, 'phone', { max: 30 }), email: optionalEmail, kind: (x) => v.choice(x, 'kind', ['individual', 'company']), postpaid: (x) => v.boolean(x, 'postpaid'), notes: memo, active: activeField,
  } },
  vehicles: { roles: OPERATORS, search: ['plate', 'model', 'color'], defaults: { color: '', category: 'small', active: true }, fields: {
    customerId: (x) => v.identifier(x, 'customerId'), plate: (x) => { const plate = v.text(x, 'plate', { min: 4, max: 16 }).toUpperCase().replace(/[\s-]/gu, ''); assert(/^[A-Z0-9]{4,12}$/u.test(plate), 422, 'VALIDATION_ERROR', 'Informe uma placa com letras e números.'); return plate; },
    model: (x) => v.text(x, 'model', { min: 1, max: 100 }), color: (x) => v.text(x, 'color', { max: 60 }), category: (x) => v.choice(x, 'category', ['small', 'medium', 'large', 'motorcycle']), active: activeField,
  } },
  services: { roles: MANAGERS, search: ['name'], defaults: { durationMinutes: 30, commissionBps: 0, active: true }, fields: {
    name: nameField, priceCents: (x) => money(x, 'priceCents'), durationMinutes: (x) => v.integer(x, 'durationMinutes', { min: 1, max: 1440 }), commissionBps: (x) => v.integer(x, 'commissionBps', { max: 10000 }), active: activeField,
  } },
  employees: { roles: MANAGERS, search: ['name', 'role_label'], defaults: { roleLabel: '', baseSalaryCents: 0, commissionBps: 0, active: true }, fields: {
    name: nameField, roleLabel: (x) => v.text(x, 'roleLabel', { max: 80 }), baseSalaryCents: (x) => money(x, 'baseSalaryCents'), commissionBps: (x) => v.integer(x, 'commissionBps', { max: 10000 }), active: activeField,
  } },
  products: { roles: MANAGERS, search: ['name', 'sku'], defaults: { unit: 'un', quantityMilli: 0, minQuantityMilli: 0, costCents: 0, active: true }, fields: {
    name: nameField, sku: (x) => v.text(x, 'sku', { min: 1, max: 60 }).toUpperCase(), unit: (x) => v.text(x, 'unit', { min: 1, max: 16 }), quantityMilli: (x) => quantity(x, 'quantityMilli'), minQuantityMilli: (x) => quantity(x, 'minQuantityMilli'), costCents: (x) => money(x, 'costCents'), active: activeField,
  } },
  packages: { roles: MANAGERS, search: ['name'], defaults: { validDays: 365, active: true }, fields: {
    name: nameField, serviceId: (x) => v.identifier(x, 'serviceId'), credits: (x) => v.integer(x, 'credits', { min: 1, max: 10000 }), priceCents: (x) => money(x, 'priceCents', 1), validDays: (x) => v.integer(x, 'validDays', { min: 1, max: 3650 }), active: activeField,
  } },
};

async function decorateMaster(db, collection, row, role) {
  const item = publicRecord(row);
  if (collection === 'products') item.lowStock = item.quantityMilli <= item.minQuantityMilli;
  if (collection === 'vehicles') item.customerName = (await record(db, 'customers', row.customer_id)).name;
  if (collection === 'packages') item.serviceName = (await record(db, 'services', row.service_id)).name;
  if (collection === 'employees' && !MANAGERS.includes(role)) { delete item.baseSalaryCents; delete item.commissionBps; }
  return item;
}

export async function stockChange(db, { product, amount, kind, orderId = null, notes = '', reverseOf = null }) {
  const next = product.quantity_milli + amount;
  assert(Number.isSafeInteger(next) && next >= 0 && next <= 1_000_000_000, 409, 'INSUFFICIENT_STOCK', 'Estoque insuficiente ou saldo acima do limite permitido.');
  const movementId = id();
  (await db.prepare('INSERT INTO stock_movements(id,product_id,order_id,kind,quantity_milli,reverse_of,notes,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(movementId, product.id, orderId, kind, amount, reverseOf, notes, now()));
  (await update(db, 'products', product, { quantityMilli: next }));
  return movementId;
}

export async function masterRoutes(ctx) {
  const match = ctx.pathname.match(/^\/api\/(customers|vehicles|services|employees|products|packages)(?:\/([\w-]+))?$/u);
  if (!match) return null;
  const [, collection, recordId] = match;
  const spec = MASTERS[collection];
  const role = requireRole(ctx.session, READERS).role;
  if (ctx.method === 'GET') {
    if (recordId) return { data: { item: (await decorateMaster(ctx.db, collection, (await record(ctx.db, collection, recordId)), role)) } };
    const q = v.text(ctx.url.searchParams.get('q') || '', 'q', { max: 120 });
    const conditions = [];
    const params = [];
    if (q) { conditions.push(`(${spec.search.map((field) => `${field} LIKE ?`).join(' OR ')})`); params.push(...spec.search.map(() => `%${q}%`)); }
    const active = ctx.url.searchParams.get('active');
    if (active !== null) { v.choice(active, 'active', ['true', 'false']); conditions.push('active=?'); params.push(Number(active === 'true')); }
    const postpaid = ctx.url.searchParams.get('postpaid');
    if (collection === 'customers' && postpaid !== null) { v.choice(postpaid, 'postpaid', ['true', 'false']); conditions.push('postpaid=?'); params.push(Number(postpaid === 'true')); }
    if (collection === 'vehicles' && ctx.url.searchParams.get('customerId')) { conditions.push('customer_id=?'); params.push(ctx.url.searchParams.get('customerId')); }
    const { rows, page } = (await paginate(ctx.db, ctx.url, `SELECT * FROM ${collection}${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY updated_at DESC,id`, params));
    return { data: { items: (await Promise.all(rows.map(async (row) => (await decorateMaster(ctx.db, collection, row, role))))), page } };
  }
  if ((ctx.method === 'POST' && !recordId) || (ctx.method === 'PATCH' && recordId)) return (await mutate(ctx, spec.roles, async (body) => {
    const before = recordId ? (await record(ctx.db, collection, recordId)) : null;
    const allowed = Object.keys(spec.fields).filter((key) => !(before && collection === 'products' && key === 'quantityMilli'));
    v.onlyKeys(body, before ? [...allowed, 'version'] : allowed);
    if (before) version(before, body.version);
    const source = before ? body : { ...spec.defaults, ...body };
    const fields = {};
    for (const [key, validator] of Object.entries(spec.fields)) {
      if (before && source[key] === undefined) continue;
      fields[key] = validator(source[key]);
    }
    assert(Object.keys(fields).length > 0, 422, 'VALIDATION_ERROR', 'Informe ao menos um campo para atualizar.');
    if (collection === 'vehicles') {
      if (fields.customerId) (await record(ctx.db, 'customers', fields.customerId, true));
      if (fields.plate) assert(!(await ctx.db.prepare('SELECT id FROM vehicles WHERE plate=? AND id!=?').get(fields.plate, recordId || '')), 409, 'PLATE_EXISTS', 'Já existe um veículo com esta placa.');
      if (before && fields.customerId && fields.customerId !== before.customer_id) assert(!(await ctx.db.prepare("SELECT id FROM orders WHERE vehicle_id=? AND status NOT IN ('delivered','cancelled')").get(before.id)), 409, 'VEHICLE_IN_USE', 'Conclua as ordens do veículo antes de transferir seu cliente.');
    }
    if (collection === 'products' && fields.sku) assert(!(await ctx.db.prepare('SELECT id FROM products WHERE sku=? AND id!=?').get(fields.sku, recordId || '')), 409, 'SKU_EXISTS', 'Já existe um produto com este SKU.');
    if (collection === 'packages' && fields.serviceId) (await record(ctx.db, 'services', fields.serviceId, true));
    if (collection === 'customers' && before?.postpaid && fields.postpaid === false) {
      const unpaid = (await Promise.all((await ctx.db.prepare("SELECT id FROM orders WHERE customer_id=? AND status='delivered'").all(before.id)).map(async (order) => (await orderBalance(ctx.db, order.id)).balanceCents > 0))).some(Boolean);
      assert(!unpaid, 409, 'OPEN_POSTPAID_BALANCE', 'Quite os saldos pós-pagos antes de desativar esta condição.');
    }
    const result = before ? (await update(ctx.db, collection, before, fields)) : (await insert(ctx.db, collection, fields));
    if (!before && collection === 'products' && result.quantity_milli > 0) {
      (await ctx.db.prepare("INSERT INTO stock_movements(id,product_id,kind,quantity_milli,notes,created_at) VALUES(?,?,'opening',?,'Estoque inicial',?)").run(id(), result.id, result.quantity_milli, now()));
    }
    (await changed(ctx, `${collection}.${before ? 'updated' : 'created'}`, collection, result.id, { fields: Object.keys(fields) }));
    return (await decorateMaster(ctx.db, collection, result, role));
  }, recordId ? 200 : 201));
  return null;
}

export async function orderBalance(db, orderId) {
  const row = (await record(db, 'orders', orderId));
  const paidCents = (await db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS amount FROM payment_allocations WHERE order_id=?').get(orderId)).amount;
  const creditCents = (await db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS amount FROM package_redemptions WHERE order_id=? AND reversed=0').get(orderId)).amount;
  return { paidCents, creditCents, balanceCents: row.total_cents - paidCents - creditCents };
}

export async function touchOrder(db, orderId, fields = {}) {
  const row = (await record(db, 'orders', orderId));
  const balance = (await orderBalance(db, orderId));
  assert(balance.balanceCents >= 0, 409, 'OVERPAYMENT', 'O valor excede o saldo da ordem.');
  return (await update(db, 'orders', row, { ...fields, settledAt: balance.balanceCents === 0 ? row.settled_at || now() : null }));
}

export async function cashMovement(db, { type, amountCents, method, source, resourceId, category = '', notes = '' }) {
  const session = (await db.prepare("SELECT * FROM cash_sessions WHERE status='open'").get());
  if (method === 'cash') {
    assert(session, 409, 'CASH_CLOSED', 'Abra o caixa antes de registrar uma movimentação em dinheiro.');
    if (type === 'out') assert((await cashExpected(db, session)) >= amountCents, 409, 'INSUFFICIENT_CASH', 'O caixa não tem saldo em dinheiro suficiente.');
    if (type === 'in') assert((await cashExpected(db, session)) + amountCents <= 1_000_000_000, 409, 'CASH_LIMIT', 'O caixa atingiu o limite de saldo permitido. Encerre a sessão antes de continuar.');
  }
  (await db.prepare('INSERT INTO cash_movements(id,cash_session_id,type,amount_cents,method,source,resource_id,category,notes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id(), session?.id || null, type, amountCents, method, source, resourceId, category, notes, now()));
  if (session) (await update(db, 'cash_sessions', session, {}));
}

export async function cashExpected(db, session) {
  const movements = (await db.prepare("SELECT COALESCE(SUM(CASE WHEN type='in' THEN amount_cents ELSE -amount_cents END),0) AS amount FROM cash_movements WHERE cash_session_id=? AND method='cash'").get(session.id)).amount;
  return session.opening_cents + movements;
}

export async function receive(db, { source, sourceId, customerId, amountCents, method, reference = '' }) {
  const paymentId = id();
  (await db.prepare('INSERT INTO payments(id,source,source_id,customer_id,amount_cents,method,reference,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(paymentId, source, sourceId, customerId, amountCents, method, reference, now()));
  (await cashMovement(db, { type: 'in', amountCents, method, source, resourceId: paymentId, category: 'recebimento' }));
  return paymentId;
}
