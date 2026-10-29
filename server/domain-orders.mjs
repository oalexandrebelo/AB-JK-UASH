import { assert } from './errors.mjs';
import * as v from './validation.mjs';
import { requireRole } from './security.mjs';
import { checkJkDeliveryAvailability } from './jk-deliveries.mjs';
import { OPERATORS, READERS, METHODS, now, id, money, quantity, memo, publicRecord, record, version, insert, update, changed, mutate, paginate, iso, orderBalance, touchOrder, stockChange, receive, roundRatio, sumSafe } from './domain-core.mjs';

export const ORDER_STATUSES = ['quote', 'scheduled', 'waiting', 'in_progress', 'quality_check', 'ready', 'delivered', 'cancelled'];
const TRANSITIONS = {
  quote: ['scheduled', 'waiting', 'cancelled'], scheduled: ['waiting', 'cancelled'], waiting: ['in_progress', 'cancelled'],
  in_progress: ['quality_check', 'cancelled'], quality_check: ['in_progress', 'ready', 'cancelled'], ready: ['in_progress', 'delivered', 'cancelled'], delivered: [], cancelled: [],
};
const EDITABLE = ['quote', 'scheduled', 'waiting'];
const ORDER_FIELDS = ['customerId', 'vehicleId', 'employeeId', 'items', 'discountCents', 'status', 'scheduledAt', 'promisedAt', 'notes'];
const APPOINTMENT_FIELDS = ['customerId', 'vehicleId', 'employeeId', 'items', 'startsAt', 'endsAt', 'notes', 'status'];

export async function association(db, customerId, vehicleId, employeeId) {
  const customer = (await record(db, 'customers', v.identifier(customerId, 'customerId'), true));
  const vehicle = (await record(db, 'vehicles', v.identifier(vehicleId, 'vehicleId'), true));
  assert(vehicle.customer_id === customer.id, 422, 'CUSTOMER_VEHICLE_MISMATCH', 'O veículo não pertence ao cliente selecionado.');
  const employee = employeeId ? (await record(db, 'employees', v.identifier(employeeId, 'employeeId'), true)) : null;
  return { customer, vehicle, employee };
}

export async function serviceItems(db, items, employee) {
  assert(Array.isArray(items) && items.length >= 1 && items.length <= 100, 422, 'VALIDATION_ERROR', 'Informe de 1 a 100 serviços.');
  const seen = new Set();
  return (await Promise.all(items.map(async (item, index) => {
    v.object(item); v.onlyKeys(item, ['serviceId', 'quantity']);
    const serviceId = v.identifier(item.serviceId, `items.${index}.serviceId`);
    assert(!seen.has(serviceId), 422, 'DUPLICATE_SERVICE', 'Cada serviço deve aparecer uma única vez.');
    seen.add(serviceId);
    const service = (await record(db, 'services', serviceId, true));
    const count = v.integer(item.quantity, `items.${index}.quantity`, { min: 1, max: 1000 });
    return { serviceId, name: service.name, quantity: count, unitPriceCents: service.price_cents, durationMinutes: service.duration_minutes, commissionBps: service.commission_bps || employee?.commission_bps || 0, lineTotalCents: service.price_cents * count };
  })));
}

function priceItems(items, discountCents) {
  const subtotalCents = sumSafe(items.map((item) => item.lineTotalCents));
  assert(subtotalCents <= 1_000_000_000, 422, 'AMOUNT_LIMIT', 'O total da ordem excede o limite permitido.');
  money(discountCents, 'discountCents');
  assert(discountCents <= subtotalCents, 422, 'DISCOUNT_EXCEEDS_TOTAL', 'O desconto excede o valor dos serviços.');
  let prior = 0;
  let allocated = 0;
  const priced = items.map((item) => {
    prior += item.lineTotalCents;
    const cumulative = subtotalCents === 0 ? 0 : roundRatio(discountCents, prior, subtotalCents);
    const discount = cumulative - allocated;
    allocated = cumulative;
    const netCents = item.lineTotalCents - discount;
    return { ...item, discountCents: discount, netCents, commissionCents: roundRatio(netCents, item.commissionBps, 10000) };
  });
  return { items: priced, subtotalCents, discountCents, totalCents: subtotalCents - discountCents };
}

async function writeItems(db, orderId, items) {
  (await db.prepare('DELETE FROM order_items WHERE order_id=?').run(orderId));
  const statement = db.prepare('INSERT INTO order_items(id,order_id,service_id,name,quantity,unit_price_cents,duration_minutes,commission_bps,line_total_cents,discount_cents,net_cents,commission_cents,position) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const [position, item] of items.entries()) (await statement.run(id(), orderId, item.serviceId, item.name, item.quantity, item.unitPriceCents, item.durationMinutes, item.commissionBps, item.lineTotalCents, item.discountCents, item.netCents, item.commissionCents, position));
}

export async function checkAvailability(db, employeeId, startsAt, endsAt, { appointmentId = '', orderId = '' } = {}) {
  if (!employeeId || !startsAt || !endsAt) return;
  assert(endsAt > startsAt, 422, 'INVALID_INTERVAL', 'O término deve ser posterior ao início.');
  await checkJkDeliveryAvailability(db, employeeId, startsAt, endsAt);
  const appointment = (await db.prepare("SELECT id FROM appointments WHERE employee_id=? AND id!=? AND status NOT IN ('cancelled','converted') AND starts_at<? AND ends_at>?").get(employeeId, appointmentId, endsAt, startsAt));
  const order = (await db.prepare("SELECT id FROM orders WHERE employee_id=? AND id!=? AND status NOT IN ('cancelled','delivered','quote') AND scheduled_at<? AND promised_at>?").get(employeeId, orderId, endsAt, startsAt));
  assert(!appointment && !order, 409, 'SCHEDULE_CONFLICT', 'O funcionário já tem atendimento nesse intervalo.');
}

export async function orderView(db, orderId) {
  const row = (await record(db, 'orders', orderId));
  const result = publicRecord(row);
  delete result.checklistJson;
  const customer = (await record(db, 'customers', row.customer_id));
  const vehicle = (await record(db, 'vehicles', row.vehicle_id));
  return {
    ...result, ...(await orderBalance(db, orderId)), customerName: customer.name, customerPostpaid: Boolean(customer.postpaid), vehiclePlate: vehicle.plate, vehicleModel: vehicle.model,
    employeeName: row.employee_id ? (await record(db, 'employees', row.employee_id)).name : '',
    items: (await db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY position,id').all(orderId)).map(publicRecord),
    checklist: JSON.parse(row.checklist_json),
    payments: (await db.prepare('SELECT p.id,a.amount_cents,p.method,p.reference,p.source,p.created_at FROM payment_allocations a JOIN payments p ON p.id=a.payment_id WHERE a.order_id=? ORDER BY p.created_at,p.id').all(orderId)).map(publicRecord),
    consumptions: (await db.prepare("SELECT m.*,p.name AS product_name,EXISTS(SELECT 1 FROM stock_movements r WHERE r.reverse_of=m.id) AS reversed FROM stock_movements m JOIN products p ON p.id=m.product_id WHERE m.order_id=? AND m.kind='consumption' ORDER BY m.created_at,m.id").all(orderId)).map(publicRecord),
    packageRedemptions: (await db.prepare('SELECT r.*,s.package_name FROM package_redemptions r JOIN package_sales s ON s.id=r.package_sale_id WHERE r.order_id=? ORDER BY r.created_at,r.id').all(orderId)).map(publicRecord),
  };
}

export async function createOrder(ctx, body, { excludeAppointment = '' } = {}) {
  const { customer, vehicle, employee } = (await association(ctx.db, body.customerId, body.vehicleId, body.employeeId));
  const prices = priceItems((await serviceItems(ctx.db, body.items, employee)), body.discountCents ?? 0);
  const status = v.choice(body.status ?? 'waiting', 'status', ['quote', 'scheduled', 'waiting']);
  const scheduledAt = iso(body.scheduledAt, 'scheduledAt', true);
  let promisedAt = iso(body.promisedAt, 'promisedAt', true);
  if (scheduledAt && !promisedAt) promisedAt = new Date(Date.parse(scheduledAt) + prices.items.reduce((sum, item) => sum + item.durationMinutes * item.quantity, 0) * 60000).toISOString();
  assert(status !== 'scheduled' || scheduledAt, 422, 'SCHEDULE_REQUIRED', 'Informe o horário da ordem agendada.');
  if (scheduledAt && promisedAt) assert(promisedAt > scheduledAt, 422, 'INVALID_INTERVAL', 'A previsão deve ser posterior ao início.');
  if (status !== 'quote') (await checkAvailability(ctx.db, employee?.id, scheduledAt, promisedAt, { appointmentId: excludeAppointment }));
  const number = (await ctx.db.prepare('SELECT COALESCE(MAX(number),0)+1 AS value FROM orders').get()).value;
  const row = (await insert(ctx.db, 'orders', {
    number, customerId: customer.id, vehicleId: vehicle.id, employeeId: employee?.id || null, status,
    subtotalCents: prices.subtotalCents, discountCents: prices.discountCents, totalCents: prices.totalCents,
    scheduledAt, promisedAt, notes: memo(body.notes), checklistJson: '[]', invoiceId: null, deliveredAt: null, settledAt: prices.totalCents === 0 ? now() : null,
  }));
  (await writeItems(ctx.db, row.id, prices.items));
  (await changed(ctx, 'order.created', 'order', row.id, { number, totalCents: row.total_cents }));
  return (await orderView(ctx.db, row.id));
}

function requireOpen(row) {
  assert(!['cancelled', 'delivered'].includes(row.status), 409, 'ORDER_CLOSED', 'A ordem já foi encerrada.');
}

async function hasConsumption(db, orderId) {
  return Boolean((await db.prepare("SELECT m.id FROM stock_movements m WHERE m.order_id=? AND m.kind='consumption' AND NOT EXISTS(SELECT 1 FROM stock_movements r WHERE r.reverse_of=m.id)").get(orderId)));
}

async function hasRedemption(db, orderId) {
  return Boolean((await db.prepare('SELECT id FROM package_redemptions WHERE order_id=? AND reversed=0').get(orderId)));
}

export async function orderRoutes(ctx) {
  const match = ctx.pathname.match(/^\/api\/orders(?:\/([\w-]+))?(?:\/(transition|payments|checklist|consumptions)(?:\/([\w-]+)\/(reverse))?)?$/u);
  if (!match) return null;
  requireRole(ctx.session, READERS);
  const [, orderId, action, movementId] = match;
  if (movementId && action !== 'consumptions') return null;
  if (ctx.method === 'GET' && !action) {
    if (orderId) return { data: { item: (await orderView(ctx.db, orderId)) } };
    const clauses = [], params = [];
    const status = ctx.url.searchParams.get('status');
    if (status) { v.choice(status, 'status', ORDER_STATUSES); clauses.push('o.status=?'); params.push(status); }
    for (const [key, column] of [['customerId','o.customer_id'], ['vehicleId','o.vehicle_id'], ['employeeId','o.employee_id']]) if (ctx.url.searchParams.has(key)) { clauses.push(`${column}=?`); params.push(v.identifier(ctx.url.searchParams.get(key), key)); }
    const q = v.text(ctx.url.searchParams.get('q') || '', 'q', { max: 120 });
    if (q) { clauses.push('(c.name LIKE ? OR v.plate LIKE ? OR CAST(o.number AS TEXT) LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    const { rows, page } = (await paginate(ctx.db, ctx.url, `SELECT o.id FROM orders o JOIN customers c ON c.id=o.customer_id JOIN vehicles v ON v.id=o.vehicle_id${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY o.created_at DESC,o.number DESC`, params));
    return { data: { items: (await Promise.all(rows.map(async (row) => (await orderView(ctx.db, row.id))))), page } };
  }
  if (ctx.method === 'POST' && !orderId) return (await mutate(ctx, OPERATORS, async (body) => { v.onlyKeys(body, ORDER_FIELDS); return (await createOrder(ctx, body)); }, 201));
  if (ctx.method === 'PATCH' && orderId && !action) return (await mutate(ctx, OPERATORS, async (body) => {
    v.onlyKeys(body, ['version', ...ORDER_FIELDS]);
    const row = (await record(ctx.db, 'orders', orderId)); version(row, body.version);
    assert(EDITABLE.includes(row.status), 409, 'ORDER_NOT_EDITABLE', 'Edite a ordem antes de iniciar o serviço.');
    const balance = (await orderBalance(ctx.db, orderId));
    assert(!row.invoice_id && balance.paidCents === 0 && !(await hasRedemption(ctx.db, orderId)) && !(await hasConsumption(ctx.db, orderId)), 409, 'ORDER_HAS_MOVEMENTS', 'A ordem já tem movimentações e não pode ser reescrita.');
    const merged = { ...publicRecord(row), ...body };
    const { employee } = (await association(ctx.db, merged.customerId, merged.vehicleId, merged.employeeId));
    const oldItems = (await ctx.db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY position,id').all(orderId)).map(publicRecord);
    const changedItems = body.items !== undefined;
    const itemInput = body.items ?? oldItems.map((item) => ({ serviceId: item.serviceId, quantity: item.quantity }));
    const prices = priceItems(changedItems ? (await serviceItems(ctx.db, itemInput, employee)) : oldItems, merged.discountCents);
    const status = v.choice(merged.status, 'status', EDITABLE);
    const scheduledAt = iso(merged.scheduledAt, 'scheduledAt', true);
    let promisedAt = iso(merged.promisedAt, 'promisedAt', true);
    if (scheduledAt && !promisedAt) promisedAt = new Date(Date.parse(scheduledAt) + prices.items.reduce((sum, item) => sum + item.durationMinutes * item.quantity, 0) * 60000).toISOString();
    assert(status !== 'scheduled' || scheduledAt, 422, 'SCHEDULE_REQUIRED', 'Informe o horário da ordem agendada.');
    if (scheduledAt && promisedAt) assert(promisedAt > scheduledAt, 422, 'INVALID_INTERVAL', 'A previsão deve ser posterior ao início.');
    if (status !== 'quote') (await checkAvailability(ctx.db, employee?.id, scheduledAt, promisedAt, { orderId }));
    (await update(ctx.db, 'orders', row, { customerId: merged.customerId, vehicleId: merged.vehicleId, employeeId: employee?.id || null, status, subtotalCents: prices.subtotalCents, discountCents: prices.discountCents, totalCents: prices.totalCents, scheduledAt, promisedAt, notes: memo(merged.notes), settledAt: prices.totalCents === 0 ? row.settled_at || now() : null }));
    (await writeItems(ctx.db, orderId, prices.items));
    (await changed(ctx, 'order.updated', 'order', orderId, { fields: Object.keys(body).filter((key) => key !== 'version') }));
    return (await orderView(ctx.db, orderId));
  }));
  if (ctx.method === 'POST' && orderId && action) return (await mutate(ctx, OPERATORS, async (body) => {
    const row = (await record(ctx.db, 'orders', orderId)); version(row, body.version);
    if (action === 'transition') {
      v.onlyKeys(body, ['version', 'status']);
      const next = v.choice(body.status, 'status', ORDER_STATUSES);
      assert(TRANSITIONS[row.status].includes(next), 409, 'INVALID_TRANSITION', 'Esta mudança de etapa não é permitida.');
      if (next === 'cancelled') {
        const balance = (await orderBalance(ctx.db, orderId));
        assert(!row.invoice_id && balance.paidCents === 0 && !(await hasRedemption(ctx.db, orderId)) && !(await hasConsumption(ctx.db, orderId)), 409, 'ORDER_HAS_MOVEMENTS', 'Reverta os consumos/créditos e resolva os recebimentos antes de cancelar.');
      }
      if (next === 'scheduled') assert(row.scheduled_at, 422, 'SCHEDULE_REQUIRED', 'Informe um horário antes de agendar.');
      if (next === 'scheduled' || (row.status === 'quote' && next === 'waiting')) (await checkAvailability(ctx.db, row.employee_id, row.scheduled_at, row.promised_at, { orderId }));
      if (next === 'delivered') assert((await orderBalance(ctx.db, orderId)).balanceCents === 0 || (await record(ctx.db, 'customers', row.customer_id)).postpaid, 409, 'PAYMENT_REQUIRED', 'Quite a ordem antes da entrega ou habilite o cliente como pós-pago.');
      (await touchOrder(ctx.db, orderId, { status: next, ...(next === 'delivered' ? { deliveredAt: now() } : {}) }));
      (await changed(ctx, 'order.transitioned', 'order', orderId, { from: row.status, to: next }));
    } else if (action === 'payments') {
      v.onlyKeys(body, ['version', 'amountCents', 'method', 'reference']);
      assert(!['quote', 'cancelled'].includes(row.status), 409, 'ORDER_NOT_PAYABLE', 'Esta ordem não aceita recebimentos.');
      assert(!row.invoice_id, 409, 'INVOICE_PAYMENT_REQUIRED', 'Registre o recebimento pela fatura desta ordem.');
      const amount = money(body.amountCents, 'amountCents', 1);
      assert(amount <= (await orderBalance(ctx.db, orderId)).balanceCents, 409, 'OVERPAYMENT', 'O recebimento excede o saldo da ordem.');
      const method = v.choice(body.method, 'method', METHODS);
      const paymentId = (await receive(ctx.db, { source: 'order', sourceId: orderId, customerId: row.customer_id, amountCents: amount, method, reference: v.text(body.reference ?? '', 'reference', { max: 120 }) }));
      (await ctx.db.prepare('INSERT INTO payment_allocations(payment_id,order_id,amount_cents) VALUES(?,?,?)').run(paymentId, orderId, amount));
      (await touchOrder(ctx.db, orderId));
      (await changed(ctx, 'order.payment_recorded', 'order', orderId, { amountCents: amount, method, paymentId }));
    } else if (action === 'checklist') {
      v.onlyKeys(body, ['version', 'items']); requireOpen(row);
      assert(Array.isArray(body.items) && body.items.length <= 100, 422, 'VALIDATION_ERROR', 'Informe no máximo 100 itens de vistoria.');
      const checklist = body.items.map((item) => { v.object(item); v.onlyKeys(item, ['zone','condition','notes']); return { zone: v.text(item.zone, 'zone', { min: 1, max: 100 }), condition: v.choice(item.condition, 'condition', ['ok','attention','damage','not_applicable']), notes: memo(item.notes) }; });
      (await update(ctx.db, 'orders', row, { checklistJson: JSON.stringify(checklist) }));
      (await changed(ctx, 'order.checklist_updated', 'order', orderId, { count: checklist.length }));
    } else if (action === 'consumptions') {
      requireOpen(row);
      if (movementId) {
        v.onlyKeys(body, ['version','notes']);
        const movement = (await record(ctx.db, 'stock_movements', movementId));
        assert(movement.order_id === orderId && movement.kind === 'consumption', 422, 'INVALID_CONSUMPTION', 'O consumo não pertence à ordem.');
        assert(!(await ctx.db.prepare('SELECT id FROM stock_movements WHERE reverse_of=?').get(movementId)), 409, 'ALREADY_REVERSED', 'Este consumo já foi revertido.');
        (await stockChange(ctx.db, { product: (await record(ctx.db, 'products', movement.product_id)), amount: -movement.quantity_milli, kind: 'reversal', orderId, reverseOf: movementId, notes: memo(body.notes) }));
        (await changed(ctx, 'order.consumption_reversed', 'order', orderId, { movementId }));
      } else {
        v.onlyKeys(body, ['version','productId','quantityMilli','notes']);
        assert(row.status !== 'quote', 409, 'ORDER_NOT_STARTED', 'O orçamento ainda não aceita consumo de estoque.');
        const product = (await record(ctx.db, 'products', v.identifier(body.productId, 'productId'), true));
        const amount = quantity(body.quantityMilli, 'quantityMilli', 1);
        const movement = (await stockChange(ctx.db, { product, amount: -amount, kind: 'consumption', orderId, notes: memo(body.notes) }));
        (await changed(ctx, 'order.stock_consumed', 'order', orderId, { movementId: movement, productId: product.id, quantityMilli: amount }));
      }
      (await touchOrder(ctx.db, orderId));
    }
    return (await orderView(ctx.db, orderId));
  }));
  return null;
}

export async function appointmentView(db, appointmentId) {
  const row = (await record(db, 'appointments', appointmentId));
  const item = publicRecord(row); delete item.itemsJson;
  return { ...item, items: JSON.parse(row.items_json), customerName: (await record(db, 'customers', row.customer_id)).name, vehiclePlate: (await record(db, 'vehicles', row.vehicle_id)).plate, employeeName: row.employee_id ? (await record(db, 'employees', row.employee_id)).name : '' };
}

export async function appointmentRoutes(ctx) {
  const match = ctx.pathname.match(/^\/api\/appointments(?:\/([\w-]+))?(?:\/(convert))?$/u);
  if (!match) return null;
  requireRole(ctx.session, READERS);
  const [, appointmentId, action] = match;
  if (ctx.method === 'GET' && !action) {
    if (appointmentId) return { data: { item: (await appointmentView(ctx.db, appointmentId)) } };
    const clauses = [], params = [];
    const status = ctx.url.searchParams.get('status');
    if (status) { clauses.push('a.status=?'); params.push(v.choice(status, 'status', ['scheduled','confirmed','arrived','converted','cancelled'])); }
    for (const [key, column] of [['customerId','a.customer_id'], ['employeeId','a.employee_id']]) if (ctx.url.searchParams.has(key)) { clauses.push(`${column}=?`); params.push(v.identifier(ctx.url.searchParams.get(key), key)); }
    const q = v.text(ctx.url.searchParams.get('q') || '', 'q', { max: 120 });
    if (q) { clauses.push('(c.name LIKE ? OR v.plate LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
    const { rows, page } = (await paginate(ctx.db, ctx.url, `SELECT a.id FROM appointments a JOIN customers c ON c.id=a.customer_id JOIN vehicles v ON v.id=a.vehicle_id${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY a.starts_at DESC,a.id`, params));
    return { data: { items: (await Promise.all(rows.map(async (row) => (await appointmentView(ctx.db, row.id))))), page } };
  }
  if ((ctx.method === 'POST' && !appointmentId) || (ctx.method === 'PATCH' && appointmentId && !action)) return (await mutate(ctx, OPERATORS, async (body) => {
    const before = appointmentId ? (await record(ctx.db, 'appointments', appointmentId)) : null;
    v.onlyKeys(body, before ? ['version', ...APPOINTMENT_FIELDS] : APPOINTMENT_FIELDS);
    if (before) { version(before, body.version); assert(!['converted','cancelled'].includes(before.status), 409, 'APPOINTMENT_CLOSED', 'O agendamento já foi encerrado.'); }
    const merged = { ...(before ? (await appointmentView(ctx.db, appointmentId)) : {}), ...body };
    const { customer, vehicle, employee } = (await association(ctx.db, merged.customerId, merged.vehicleId, merged.employeeId));
    const items = (await serviceItems(ctx.db, merged.items, employee));
    const startsAt = iso(merged.startsAt, 'startsAt');
    const endsAt = iso(merged.endsAt, 'endsAt', true) || new Date(Date.parse(startsAt) + items.reduce((sum, item) => sum + item.durationMinutes * item.quantity, 0) * 60000).toISOString();
    assert(endsAt > startsAt && Date.parse(endsAt) - Date.parse(startsAt) <= 7 * 86400_000, 422, 'INVALID_INTERVAL', 'Selecione um intervalo válido de até sete dias.');
    const status = v.choice(merged.status || 'scheduled', 'status', ['scheduled','confirmed','arrived','cancelled']);
    if (status !== 'cancelled') (await checkAvailability(ctx.db, employee?.id, startsAt, endsAt, { appointmentId }));
    const fields = { customerId: customer.id, vehicleId: vehicle.id, employeeId: employee?.id || null, startsAt, endsAt, itemsJson: JSON.stringify(items.map(({ serviceId, quantity }) => ({ serviceId, quantity }))), status, notes: memo(merged.notes) };
    const row = before ? (await update(ctx.db, 'appointments', before, fields)) : (await insert(ctx.db, 'appointments', { ...fields, orderId: null }));
    (await changed(ctx, `appointment.${before ? 'updated' : 'created'}`, 'appointment', row.id, { status }));
    return (await appointmentView(ctx.db, row.id));
  }, appointmentId ? 200 : 201));
  if (ctx.method === 'POST' && action === 'convert') return (await mutate(ctx, OPERATORS, async (body) => {
    v.onlyKeys(body, ['version']);
    const row = (await record(ctx.db, 'appointments', appointmentId)); version(row, body.version);
    assert(!row.order_id && !['cancelled','converted'].includes(row.status), 409, 'APPOINTMENT_CLOSED', 'O agendamento já foi convertido ou cancelado.');
    const order = (await createOrder(ctx, { customerId: row.customer_id, vehicleId: row.vehicle_id, employeeId: row.employee_id, items: JSON.parse(row.items_json), status: 'waiting', scheduledAt: row.starts_at, promisedAt: row.ends_at, notes: row.notes }, { excludeAppointment: appointmentId }));
    (await update(ctx.db, 'appointments', row, { status: 'converted', orderId: order.id }));
    (await changed(ctx, 'appointment.converted', 'appointment', appointmentId, { orderId: order.id }));
    return order;
  }, 201));
  return null;
}
