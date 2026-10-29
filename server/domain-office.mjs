import { assert } from './errors.mjs';
import * as v from './validation.mjs';
import { requireRole } from './security.mjs';
import { OPERATORS, MANAGERS, READERS, METHODS, now, id, money, memo, publicRecord, record, version, insert, update, changed, mutate, paginate, settings, businessDate, localMidnight, cashMovement, sumSafe } from './domain-core.mjs';

export async function payrollView(db, payrollId) {
  const row = (await record(db, 'payroll', payrollId));
  const lines = (await Promise.all((await db.prepare('SELECT * FROM payroll_lines WHERE payroll_id=? ORDER BY employee_name,employee_id').all(payrollId)).map(async (line) => ({ ...publicRecord(line), orderIds: (await db.prepare('SELECT order_id FROM commission_claims WHERE payroll_line_id=? ORDER BY order_id').all(line.id)).map((claim) => claim.order_id) }))));
  return { ...publicRecord(row), lines, ...Object.fromEntries(['baseCents','commissionCents','extrasCents','deductionsCents','totalCents'].map((field) => [field, sumSafe(lines.map((line) => line[field]))])) };
}

function validateAdjustments(value = []) {
  assert(Array.isArray(value) && value.length <= 500, 422, 'VALIDATION_ERROR', 'Informe no máximo 500 ajustes.');
  const map = new Map();
  for (const adjustment of value) {
    v.object(adjustment); v.onlyKeys(adjustment, ['employeeId','extrasCents','deductionsCents']);
    const employeeId = v.identifier(adjustment.employeeId, 'employeeId');
    assert(!map.has(employeeId), 422, 'DUPLICATE_EMPLOYEE', 'Um funcionário tem mais de um ajuste.');
    map.set(employeeId, { extrasCents: money(adjustment.extrasCents ?? 0, 'extrasCents'), deductionsCents: money(adjustment.deductionsCents ?? 0, 'deductionsCents') });
  }
  return map;
}

function payrollPeriod(period, zone) {
  assert(typeof period === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/u.test(period), 422, 'VALIDATION_ERROR', 'Use um período no formato AAAA-MM.');
  v.date(`${period}-01`, 'period');
  const next = new Date(`${period}-01T12:00:00.000Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return { start: localMidnight(`${period}-01`, zone), end: localMidnight(`${next.toISOString().slice(0, 7)}-01`, zone) };
}

async function calculatePayroll(db, row, adjustments) {
  const range = payrollPeriod(row.period, (await settings(db)).timezone);
  // The caller holds the write transaction lock. Only this draft's claims are released.
  (await db.prepare('DELETE FROM commission_claims WHERE payroll_line_id IN (SELECT id FROM payroll_lines WHERE payroll_id=?)').run(row.id));
  (await db.prepare('DELETE FROM payroll_lines WHERE payroll_id=?').run(row.id));
  const eligible = (await db.prepare(`SELECT o.id,o.employee_id,COALESCE(SUM(i.commission_cents),0) AS commission_cents
    FROM orders o JOIN order_items i ON i.order_id=o.id
    WHERE o.status='delivered' AND o.employee_id IS NOT NULL AND o.settled_at IS NOT NULL
      AND (CASE WHEN o.delivered_at>o.settled_at THEN o.delivered_at ELSE o.settled_at END)>=? AND (CASE WHEN o.delivered_at>o.settled_at THEN o.delivered_at ELSE o.settled_at END)<?
      AND NOT EXISTS(SELECT 1 FROM commission_claims c WHERE c.order_id=o.id)
    GROUP BY o.id,o.employee_id ORDER BY o.id`).all(range.start, range.end));
  const eligibleIds = new Set(eligible.map((order) => order.employee_id));
  const employees = (await db.prepare('SELECT * FROM employees ORDER BY name,id').all()).filter((employee) => employee.active || eligibleIds.has(employee.id));
  for (const employeeId of adjustments.keys()) assert(employees.some((employee) => employee.id === employeeId), 422, 'EMPLOYEE_NOT_IN_PAYROLL', 'Um ajuste referencia funcionário fora desta folha.');
  assert(employees.length > 0, 409, 'NO_PAYROLL_EMPLOYEES', 'Cadastre um funcionário ativo antes de gerar a folha.');
  for (const employee of employees) {
    const orders = eligible.filter((order) => order.employee_id === employee.id);
    const commission = sumSafe(orders.map((order) => order.commission_cents));
    const { extrasCents, deductionsCents } = adjustments.get(employee.id) || { extrasCents: 0, deductionsCents: 0 };
    const base = employee.active ? employee.base_salary_cents : 0;
    const gross = sumSafe([base, commission, extrasCents]);
    assert(deductionsCents <= gross, 422, 'PAYROLL_NEGATIVE', 'Os descontos não podem ultrapassar a remuneração do funcionário.');
    const lineId = id();
    (await db.prepare('INSERT INTO payroll_lines(id,payroll_id,employee_id,employee_name,base_cents,commission_cents,extras_cents,deductions_cents,total_cents) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(lineId, row.id, employee.id, employee.name, base, commission, extrasCents, deductionsCents, gross - deductionsCents));
    for (const order of orders) (await db.prepare('INSERT INTO commission_claims(order_id,payroll_line_id,commission_cents) VALUES(?,?,?)').run(order.id, lineId, order.commission_cents));
  }
  money((await payrollView(db, row.id)).totalCents, 'totalCents');
}

export async function payrollRoutes(ctx) {
  const match = ctx.pathname.match(/^\/api\/payroll(?:\/([\w-]+))?(?:\/(approve|pay|recalculate))?$/u);
  if (!match) return null;
  requireRole(ctx.session, MANAGERS);
  const [, payrollId, action] = match;
  if (ctx.method === 'GET' && !action) {
    if (payrollId) return { data: { item: (await payrollView(ctx.db, payrollId)) } };
    const status = ctx.url.searchParams.get('status');
    const params = status ? [v.choice(status, 'status', ['draft','approved','paid'])] : [];
    const { rows, page } = (await paginate(ctx.db, ctx.url, `SELECT id FROM payroll${status ? ' WHERE status=?' : ''} ORDER BY period DESC,id`, params));
    return { data: { items: (await Promise.all(rows.map(async (row) => (await payrollView(ctx.db, row.id))))), page } };
  }
  if (ctx.method === 'POST' && !payrollId) return (await mutate(ctx, MANAGERS, async (body) => {
    v.onlyKeys(body, ['period','adjustments','notes']);
    payrollPeriod(body.period, (await settings(ctx.db)).timezone);
    assert(!(await ctx.db.prepare('SELECT id FROM payroll WHERE period=?').get(body.period)), 409, 'PAYROLL_EXISTS', 'Já existe uma folha para este período.');
    const adjustments = validateAdjustments(body.adjustments);
    const row = (await insert(ctx.db, 'payroll', { period: body.period, status: 'draft', notes: memo(body.notes), paidAt: null, paymentMethod: null }));
    (await calculatePayroll(ctx.db, row, adjustments));
    (await changed(ctx, 'payroll.created', 'payroll', row.id, { period: row.period }));
    return (await payrollView(ctx.db, row.id));
  }, 201));
  if (ctx.method === 'PATCH' && payrollId && !action) return (await mutate(ctx, MANAGERS, async (body) => {
    v.onlyKeys(body, ['version','adjustments','notes']);
    const row = (await record(ctx.db, 'payroll', payrollId)); version(row, body.version);
    assert(row.status === 'draft', 409, 'PAYROLL_LOCKED', 'Somente folhas em rascunho podem ser alteradas.');
    const adjustments = validateAdjustments(body.adjustments);
    const lines = (await ctx.db.prepare('SELECT * FROM payroll_lines WHERE payroll_id=?').all(payrollId));
    for (const employeeId of adjustments.keys()) assert(lines.some((line) => line.employee_id === employeeId), 422, 'EMPLOYEE_NOT_IN_PAYROLL', 'Um ajuste referencia funcionário fora desta folha.');
    for (const line of lines) {
      const adjustment = adjustments.get(line.employee_id);
      if (!adjustment) continue;
      const gross = sumSafe([line.base_cents, line.commission_cents, adjustment.extrasCents]);
      assert(adjustment.deductionsCents <= gross, 422, 'PAYROLL_NEGATIVE', 'Os descontos não podem ultrapassar a remuneração.');
      (await ctx.db.prepare('UPDATE payroll_lines SET extras_cents=?,deductions_cents=?,total_cents=? WHERE id=?').run(adjustment.extrasCents, adjustment.deductionsCents, gross - adjustment.deductionsCents, line.id));
    }
    money((await payrollView(ctx.db, payrollId)).totalCents, 'totalCents');
    (await update(ctx.db, 'payroll', row, { notes: body.notes === undefined ? row.notes : memo(body.notes) }));
    (await changed(ctx, 'payroll.updated', 'payroll', payrollId));
    return (await payrollView(ctx.db, payrollId));
  }));
  if (ctx.method === 'POST' && payrollId && action) return (await mutate(ctx, MANAGERS, async (body) => {
    v.onlyKeys(body, action === 'pay' ? ['version','method'] : ['version']);
    const row = (await record(ctx.db, 'payroll', payrollId)); version(row, body.version);
    if (action === 'recalculate') {
      assert(row.status === 'draft', 409, 'PAYROLL_LOCKED', 'Somente rascunhos podem ser recalculados.');
      const before = (await payrollView(ctx.db, payrollId));
      const adjustments = new Map(before.lines.map((line) => [line.employeeId, { extrasCents: line.extrasCents, deductionsCents: line.deductionsCents }]));
      (await calculatePayroll(ctx.db, row, adjustments));
      (await update(ctx.db, 'payroll', row, {}));
    } else if (action === 'approve') {
      assert(row.status === 'draft', 409, 'PAYROLL_LOCKED', 'Esta folha não está em rascunho.');
      (await update(ctx.db, 'payroll', row, { status: 'approved' }));
    } else {
      assert(row.status === 'approved', 409, 'PAYROLL_NOT_APPROVED', 'Aprove a folha antes de registrar o pagamento.');
      const method = v.choice(body.method, 'method', METHODS);
      const total = (await payrollView(ctx.db, payrollId)).totalCents;
      if (total > 0) (await cashMovement(ctx.db, { type: 'out', amountCents: total, method, source: 'payroll', resourceId: payrollId, category: 'folha_local' }));
      (await update(ctx.db, 'payroll', row, { status: 'paid', paidAt: now(), paymentMethod: method }));
    }
    (await changed(ctx, `payroll.${action}`, 'payroll', payrollId));
    return (await payrollView(ctx.db, payrollId));
  }));
  return null;
}

async function messageView(db, messageId) {
  const row = (await record(db, 'messages', messageId));
  return { ...publicRecord(row), customerName: (await record(db, 'customers', row.customer_id)).name, channel: 'whatsapp', deliveryMode: 'local_only', sentAt: null };
}

export async function messageRoutes(ctx) {
  const match = ctx.pathname.match(/^\/api\/messages(?:\/([\w-]+))?(?:\/(queue|cancel))?$/u);
  if (!match) return null;
  requireRole(ctx.session, READERS);
  const [, messageId, action] = match;
  if (ctx.method === 'GET' && !action) {
    if (messageId) return { data: { item: (await messageView(ctx.db, messageId)) } };
    const clauses = [], params = [];
    const status = ctx.url.searchParams.get('status');
    if (status) { clauses.push('m.status=?'); params.push(v.choice(status, 'status', ['draft','queued','cancelled'])); }
    const q = v.text(ctx.url.searchParams.get('q') || '', 'q', { max: 120 });
    if (q) { clauses.push('(c.name LIKE ? OR m.body LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
    const { rows, page } = (await paginate(ctx.db, ctx.url, `SELECT m.id FROM messages m JOIN customers c ON c.id=m.customer_id${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY m.created_at DESC,m.id`, params));
    return { data: { items: (await Promise.all(rows.map(async (row) => (await messageView(ctx.db, row.id))))), page } };
  }
  if (ctx.method === 'POST' && !messageId) return (await mutate(ctx, OPERATORS, async (body) => {
    v.onlyKeys(body, ['customerId','template','body','orderId','appointmentId']);
    const customer = (await record(ctx.db, 'customers', v.identifier(body.customerId, 'customerId'), true));
    const template = v.choice(body.template || 'custom', 'template', ['custom','after_service','appointment']);
    let orderId = null, appointmentId = null;
    if (body.orderId) { const order = (await record(ctx.db, 'orders', v.identifier(body.orderId, 'orderId'))); assert(order.customer_id === customer.id, 422, 'CUSTOMER_MISMATCH', 'A ordem não pertence ao cliente.'); orderId = order.id; }
    if (body.appointmentId) { const appointment = (await record(ctx.db, 'appointments', v.identifier(body.appointmentId, 'appointmentId'))); assert(appointment.customer_id === customer.id, 422, 'CUSTOMER_MISMATCH', 'O agendamento não pertence ao cliente.'); appointmentId = appointment.id; }
    const business = (await settings(ctx.db)).businessName;
    let text = body.body;
    if (text === undefined && template === 'after_service') text = `Olá, ${customer.name}! Obrigado por escolher ${business}. Como foi sua experiência com nosso atendimento?`;
    if (text === undefined && template === 'appointment') text = `Olá, ${customer.name}! A equipe ${business} confirma seu agendamento. Se precisar alterar o horário, entre em contato conosco.`;
    text = v.text(text, 'body', { min: 1, max: 4000 });
    const row = (await insert(ctx.db, 'messages', { customerId: customer.id, template, body: text, status: 'draft', orderId, appointmentId }));
    (await changed(ctx, 'message.drafted', 'message', row.id, { template, deliveryMode: 'local_only' }));
    return (await messageView(ctx.db, row.id));
  }, 201));
  if ((ctx.method === 'PATCH' && messageId && !action) || (ctx.method === 'POST' && messageId && action)) return (await mutate(ctx, OPERATORS, async (body) => {
    v.onlyKeys(body, action ? ['version'] : ['version','body']);
    const row = (await record(ctx.db, 'messages', messageId)); version(row, body.version);
    assert(row.status !== 'cancelled', 409, 'MESSAGE_CLOSED', 'O rascunho foi cancelado.');
    if (!action) {
      assert(row.status === 'draft', 409, 'MESSAGE_QUEUED', 'Edite a mensagem antes de colocá-la na fila.');
      (await update(ctx.db, 'messages', row, { body: v.text(body.body, 'body', { min: 1, max: 4000 }) }));
    } else if (action === 'queue') {
      assert(row.status === 'draft', 409, 'MESSAGE_QUEUED', 'Esta mensagem já está na fila local.');
      (await update(ctx.db, 'messages', row, { status: 'queued' }));
    } else (await update(ctx.db, 'messages', row, { status: 'cancelled' }));
    (await changed(ctx, `message.${action || 'updated'}`, 'message', messageId, { deliveryMode: 'local_only' }));
    return (await messageView(ctx.db, messageId));
  }));
  return null;
}

export async function settingsRoutes(ctx) {
  if (ctx.pathname !== '/api/settings') return null;
  requireRole(ctx.session, READERS);
  if (ctx.method === 'GET') return { data: { item: (await settings(ctx.db)) } };
  if (ctx.method === 'PATCH') return (await mutate(ctx, MANAGERS, async (body) => {
    v.onlyKeys(body, ['version','businessName','phone','address','receiptFooter']);
    const before = (await settings(ctx.db)); version(before, body.version);
    const fields = {};
    for (const [key, maximum] of [['businessName',120],['phone',30],['address',300],['receiptFooter',1000]]) if (body[key] !== undefined) fields[key] = v.text(body[key], key, { min: key === 'businessName' ? 2 : 0, max: maximum });
    assert(Object.keys(fields).length > 0, 422, 'VALIDATION_ERROR', 'Informe ao menos um campo.');
    const item = { ...before, ...fields, version: before.version + 1 };
    (await ctx.db.prepare("INSERT INTO app_settings(key,value_json,updated_at) VALUES('business',?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at").run(JSON.stringify(item), now()));
    (await changed(ctx, 'settings.updated', 'settings', 'business', { fields: Object.keys(fields) }));
    return item;
  }));
  return null;
}
