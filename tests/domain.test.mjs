import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestApplication as createApplication } from './database-fixture.mjs';
import { businessDate } from '../server/domain-core.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ab-uash-domain-'));
  const errors = [];
  const app = await createApplication({ dbPath: join(directory, 'test.sqlite'), logger: { error(value) { errors.push(value); } } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); assert.deepEqual(errors, [], 'No unexpected server errors'); });
  const address = await app.listen({ port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  let cookie = '', csrf = '';
  async function call(path, { method = 'GET', body, status = 200, key = randomUUID(), headers = {} } = {}) {
    const response = await fetch(`${base}/api${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), cookie, 'x-csrf-token': csrf, 'idempotency-key': key, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    if (status !== null) assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`);
    return { status: response.status, response, ...result };
  }
  const setup = await call('/setup', { method: 'POST', body: { name: 'Admin Teste', email: 'admin@example.test', password: 'test-only-password-2026' }, status: 201 });
  cookie = setup.response.headers.get('set-cookie').split(';')[0]; csrf = setup.data.csrfToken;
  const post = async (path, body, status = 200, key) => (await call(path, { method: 'POST', body, status, key })).data?.item;
  const create = (path, body) => post(path, body, 201);
  const get = async (path) => (await call(path)).data.item;
  const patch = async (path, body, status = 200) => (await call(path, { method: 'PATCH', body, status })).data?.item;
  const customer = await create('/customers', { name: 'Cliente de Teste', postpaid: false });
  const vehicle = await create('/vehicles', { customerId: customer.id, plate: 'ABC-1D23', model: 'Hatch de teste' });
  const employee = await create('/employees', { name: 'Funcionário Teste', baseSalaryCents: 10000, commissionBps: 750 });
  const service = await create('/services', { name: 'Lavagem de Teste', priceCents: 1000, durationMinutes: 30, commissionBps: 1000 });
  const order = (overrides = {}) => create('/orders', { customerId: customer.id, vehicleId: vehicle.id, employeeId: employee.id, items: [{ serviceId: service.id, quantity: 1 }], ...overrides });
  async function transition(item, status) { return post(`/orders/${item.id}/transition`, { version: item.version, status }); }
  async function ready(item) { for (const status of ['in_progress','quality_check','ready']) item = await transition(item, status); return item; }
  return { app, call, post, create, patch, get, customer, vehicle, employee, service, order, ready, transition };
}

test('master records enforce uniqueness, versions, real pagination, and role boundaries', async (t) => {
  const f = await fixture(t);
  assert.equal(f.vehicle.plate, 'ABC1D23');
  await f.call('/vehicles', { method: 'POST', body: { customerId: f.customer.id, plate: 'abc1d23', model: 'Outra' }, status: 409 });
  const updated = await f.patch(`/customers/${f.customer.id}`, { version: 1, name: 'Cliente Alterado' });
  assert.equal(updated.version, 2);
  await f.call(`/customers/${f.customer.id}`, { method: 'PATCH', body: { version: 1, name: 'Perda de atualização' }, status: 409 });
  await f.create('/customers', { name: 'Cliente Segundo' });
  await f.create('/customers', { name: 'Cliente Terceiro' });
  const first = await f.call('/customers?q=Cliente&limit=2&offset=0');
  const second = await f.call('/customers?q=Cliente&limit=2&offset=2');
  assert.deepEqual(first.data.page, { limit: 2, offset: 0, total: 3, hasMore: true });
  assert.equal(second.data.items.length, 1);
  assert.equal(second.data.page.hasMore, false);
  assert.ok(!first.data.items.some((item) => item.id === second.data.items[0].id));
  await f.call('/customers?offset=-1', { status: 422 });
  const postpaidA = await f.create('/customers', { name: 'Conveniado A', postpaid: true });
  const postpaidB = await f.create('/customers', { name: 'Conveniado B', postpaid: true });
  const eligible = await f.call('/customers?postpaid=true&limit=1&offset=0');
  const eligibleNext = await f.call('/customers?postpaid=true&limit=1&offset=1');
  assert.equal(eligible.data.page.total, 2);
  assert.equal(eligible.data.page.hasMore, true);
  assert.deepEqual(new Set([eligible.data.items[0].id, eligibleNext.data.items[0].id]), new Set([postpaidA.id, postpaidB.id]));
  assert.equal((await f.call('/customers?postpaid=false')).data.page.total, 3);
  await f.call('/customers?postpaid=invalid', {status: 422});
  const user = await f.call('/users', { method: 'POST', body: { name: 'Leitor Teste', email: 'reader@example.test', password: 'test-reader-password', role: 'viewer' }, status: 201 });
  assert.equal(user.data.user.role, 'viewer');
  const login = await f.call('/auth/login', { method: 'POST', body: { email: 'reader@example.test', password: 'test-reader-password' } });
  const headers = { cookie: login.response.headers.get('set-cookie').split(';')[0], 'x-csrf-token': login.data.csrfToken };
  await f.call('/orders', { method: 'POST', body: {}, headers, status: 403 });
  await f.call('/payroll', { headers, status: 403 });
  const employee = await f.call('/employees', { headers });
  assert.equal(employee.data.items[0].baseSalaryCents, undefined);
});

test('order snapshots, exact cents, idempotent creation, and unpaid delivery are enforced', async (t) => {
  const f = await fixture(t);
  const wash = await f.patch(`/services/${f.service.id}`, { version: f.service.version, priceCents: 1001, commissionBps: 333 });
  const wax = await f.create('/services', { name: 'Polimento Teste', priceCents: 5000, commissionBps: 0 });
  const body = { customerId: f.customer.id, vehicleId: f.vehicle.id, employeeId: f.employee.id, items: [{ serviceId: wash.id, quantity: 2 }, { serviceId: wax.id, quantity: 1 }], discountCents: 1003 };
  const key = randomUUID();
  const responses = await Promise.all([f.call('/orders', { method: 'POST', body, status: 201, key }),f.call('/orders', { method: 'POST', body, status: 201, key })]);
  let order = responses[0].data.item;
  assert.equal(order.id, responses[1].data.item.id);
  assert.equal((await f.app.store.prepare('SELECT COUNT(*) AS count FROM orders').get()).count, 1);
  assert.equal(order.totalCents, 5999);
  assert.equal(order.items.reduce((sum, item) => sum + item.discountCents, 0), 1003);
  assert.equal(order.items.reduce((sum, item) => sum + item.netCents, 0), 5999);
  assert.equal(order.items[1].commissionBps, 750);
  await f.patch(`/services/${wash.id}`, { version: wash.version, priceCents: 9000 });
  order = await f.patch(`/orders/${order.id}`, { version: order.version, notes: 'Preço preservado' });
  assert.equal(order.items[0].unitPriceCents, 1001);
  assert.equal(order.totalCents, 5999);
  await f.call('/orders', { method: 'POST', body: { ...body, discountCents: 1004 }, key, status: 409 });
  order = await f.ready(order);
  await f.call(`/orders/${order.id}/transition`, { method: 'POST', body: { version: order.version, status: 'delivered' }, status: 409 });
  await f.call(`/orders/${order.id}/transition`, { method: 'POST', body: { version: order.version, status: 'waiting' }, status: 409 });
  await f.call(`/orders/${order.id}`, { method: 'PATCH', body: { version: order.version, notes: 'Edição tardia' }, status: 409 });
  order = await f.post(`/orders/${order.id}/payments`, { version: order.version, amountCents: 5999, method: 'pix' });
  order = await f.transition(order, 'delivered');
  assert.equal(order.balanceCents, 0);
  assert.ok(order.deliveredAt && order.settledAt);
});

test('cash payments roll back on failure, concurrent versions serialize, and closing reconciles physical cash', async (t) => {
  const f = await fixture(t);
  let order = await f.order();
  await f.call(`/orders/${order.id}/payments`, { method: 'POST', body: { version: order.version, amountCents: 1000, method: 'cash' }, status: 409 });
  assert.equal((await f.app.store.prepare('SELECT COUNT(*) AS count FROM payments').get()).count, 0);
  let cash = await f.create('/cash/open', { openingCents: 500 });
  const payments = await Promise.all(Array.from({ length: 2 }, () => f.call(`/orders/${order.id}/payments`, { method: 'POST', body: { version: order.version, amountCents: 500, method: 'cash' }, status: null })));
  assert.deepEqual(payments.map((result) => result.status).sort(), [200,409]);
  order = await f.get(`/orders/${order.id}`);
  assert.equal(order.paidCents, 500);
  await f.call(`/orders/${order.id}/payments`, { method: 'POST', body: { version: order.version, amountCents: 501, method: 'cash' }, status: 409 });
  const key = randomUUID();
  const body = { version: order.version, amountCents: 500, method: 'pix' };
  await f.call(`/orders/${order.id}/payments`, { method: 'POST', body, key });
  await f.call(`/orders/${order.id}/payments`, { method: 'POST', body, key });
  cash = await f.get('/cash/current');
  assert.equal(cash.expectedCents, 1000);
  assert.equal(cash.movements.length, 2);
  await f.call(`/cash/${cash.id}/movements`, { method: 'POST', body: { version: cash.version, type: 'out', amountCents: 1001, category: 'Retirada' }, status: 409 });
  cash = await f.post(`/cash/${cash.id}/close`, { version: cash.version, countedCents: 990 });
  assert.equal(cash.expectedCents, 1000);
  assert.equal(cash.differenceCents, -10);
  assert.equal(cash.status, 'closed');
  assert.equal(await f.get('/cash/current'), null);
});

test('stock movements cannot go negative, consumed orders cannot cancel, and reversal happens once', async (t) => {
  const f = await fixture(t);
  const product = await f.create('/products', { name: 'Shampoo Teste', sku: 'SHAM-01', unit: 'L', quantityMilli: 2500, minQuantityMilli: 1000, costCents: 5000 });
  let order = await f.order();
  order = await f.post(`/orders/${order.id}/consumptions`, { version: order.version, productId: product.id, quantityMilli: 1800 });
  assert.equal((await f.get(`/products/${product.id}`)).quantityMilli, 700);
  assert.equal((await f.get(`/products/${product.id}`)).lowStock, true);
  await f.call(`/orders/${order.id}/consumptions`, { method: 'POST', body: { version: order.version, productId: product.id, quantityMilli: 701 }, status: 409 });
  await f.call(`/orders/${order.id}/transition`, { method: 'POST', body: { version: order.version, status: 'cancelled' }, status: 409 });
  const movementId = order.consumptions[0].id;
  order = await f.post(`/orders/${order.id}/consumptions/${movementId}/reverse`, { version: order.version });
  assert.equal((await f.get(`/products/${product.id}`)).quantityMilli, 2500);
  await f.call(`/orders/${order.id}/consumptions/${movementId}/reverse`, { method: 'POST', body: { version: order.version }, status: 409 });
  order = await f.transition(order, 'cancelled');
  assert.equal(order.status, 'cancelled');
  await f.call(`/products/${product.id}`, { method: 'PATCH', body: { version: 3, quantityMilli: 9999 }, status: 422 });
  const movements = await f.call(`/products/${product.id}/movements`);
  assert.equal(movements.data.items.length, 3);
});

test('appointments reject overlaps, permit adjacent slots, and convert into only one order', async (t) => {
  const f = await fixture(t);
  const body = { customerId: f.customer.id, vehicleId: f.vehicle.id, employeeId: f.employee.id, items: [{ serviceId: f.service.id, quantity: 1 }], startsAt: '2026-10-21T10:00:00-03:00' };
  const appointment = await f.create('/appointments', body);
  assert.equal(appointment.startsAt, '2026-10-21T13:00:00.000Z');
  assert.equal(appointment.endsAt, '2026-10-21T13:30:00.000Z');
  await f.call('/appointments', { method: 'POST', body: { ...body, startsAt: '2026-10-21T10:15:00-03:00' }, status: 409 });
  const adjacent = await f.create('/appointments', { ...body, startsAt: '2026-10-21T10:30:00-03:00' });
  assert.equal(adjacent.startsAt, appointment.endsAt);
  const key = randomUUID(), input = { version: appointment.version };
  const converted = await f.call(`/appointments/${appointment.id}/convert`, { method: 'POST', body: input, status: 201, key });
  const replay = await f.call(`/appointments/${appointment.id}/convert`, { method: 'POST', body: input, status: 201, key });
  assert.equal(converted.data.item.id, replay.data.item.id);
  assert.equal((await f.get(`/appointments/${appointment.id}`)).orderId, converted.data.item.id);
  await f.call(`/appointments/${appointment.id}/convert`, { method: 'POST', body: input, status: 409 });
  await f.call('/appointments', { method: 'POST', body: { ...body, startsAt: '2026-10-21T10:10:00-03:00' }, status: 409 });
  assert.equal((await f.app.store.prepare('SELECT COUNT(*) AS count FROM orders').get()).count, 1);
});

test('postpaid invoices group once and allocate partial receipts atomically without overpayment', async (t) => {
  const f = await fixture(t);
  await f.patch(`/customers/${f.customer.id}`, { version: f.customer.version, postpaid: true });
  let first = await f.ready(await f.order()); first = await f.transition(first, 'delivered');
  const second = await f.ready(await f.order({ items: [{ serviceId: f.service.id, quantity: 2 }] }));
  let invoice = await f.create('/invoices', { customerId: f.customer.id, orderIds: [first.id,second.id], dueDate: '2026-11-01' });
  assert.equal(invoice.totalCents, 3000);
  await f.call('/invoices', { method: 'POST', body: { customerId: f.customer.id, orderIds: [first.id], dueDate: '2026-11-02' }, status: 409 });
  const orderNow = await f.get(`/orders/${second.id}`);
  await f.call(`/orders/${second.id}/payments`, { method: 'POST', body: { version: orderNow.version, amountCents: 100, method: 'pix' }, status: 409 });
  invoice = await f.post(`/invoices/${invoice.id}/payments`, { version: invoice.version, amountCents: 1500, method: 'transfer' });
  assert.equal(invoice.status, 'partial');
  assert.equal((await f.get(`/orders/${first.id}`)).balanceCents, 0);
  assert.equal((await f.get(`/orders/${second.id}`)).balanceCents, 1500);
  await f.call(`/invoices/${invoice.id}/cancel`, { method: 'POST', body: { version: invoice.version }, status: 409 });
  await f.call(`/invoices/${invoice.id}/payments`, { method: 'POST', body: { version: invoice.version, amountCents: 1501, method: 'pix' }, status: 409 });
  invoice = await f.post(`/invoices/${invoice.id}/payments`, { version: invoice.version, amountCents: 1500, method: 'pix' });
  assert.equal(invoice.status, 'paid');
  assert.equal(invoice.balanceCents, 0);
  assert.equal((await f.app.store.prepare('SELECT SUM(amount_cents) AS total FROM payments').get()).total, 3000);
  assert.equal((await f.app.store.prepare('SELECT SUM(amount_cents) AS total FROM payment_allocations').get()).total, 3000);
});

test('package sales create one receipt, credits respect service quantities, and reversals preserve rounding cents', async (t) => {
  const f = await fixture(t);
  const plan = await f.create('/packages', { name: 'Pacote Teste', serviceId: f.service.id, credits: 3, priceCents: 2400 });
  const purchased = await f.create(`/packages/${plan.id}/sales`, { customerId: f.customer.id, method: 'pix' });
  let order = await f.order({ items: [{ serviceId: f.service.id, quantity: 3 }], discountCents: 101 });
  const use = async () => { order = await f.post(`/orders/${order.id}/package-redemptions`, { version: order.version, packageSaleId: purchased.id, quantity: 1 }); };
  await use(); await use(); await use();
  assert.equal(order.creditCents, 2899);
  assert.equal(order.balanceCents, 0);
  assert.equal((await f.get(`/package-sales/${purchased.id}`)).remainingCredits, 0);
  const firstId = order.packageRedemptions[0].id;
  order = await f.post(`/orders/${order.id}/package-redemptions/${firstId}/reverse`, { version: order.version });
  assert.ok(order.balanceCents > 0);
  await use();
  assert.equal(order.creditCents, 2899);
  assert.equal(order.balanceCents, 0);
  await f.call(`/orders/${order.id}/package-redemptions`, { method: 'POST', body: { version: order.version, packageSaleId: purchased.id, quantity: 1 }, status: 409 });
  assert.equal((await f.app.store.prepare('SELECT COUNT(*) AS count FROM payments').get()).count, 1);
  assert.equal((await f.app.store.prepare('SELECT SUM(amount_cents) AS amount FROM payments').get()).amount, 2400);
  order = await f.ready(order); order = await f.transition(order, 'delivered');
  await f.call(`/orders/${order.id}/package-redemptions/${firstId}/reverse`, { method: 'POST', body: { version: order.version }, status: 409 });
});

test('payroll snapshots local salary and earned commissions, recalculates drafts, and pays only once', async (t) => {
  const f = await fixture(t);
  let order = await f.order();
  order = await f.post(`/orders/${order.id}/payments`, { version: order.version, amountCents: 1000, method: 'pix' });
  order = await f.ready(order); await f.transition(order, 'delivered');
  const period = businessDate().slice(0,7);
  let payroll = await f.create('/payroll', { period, adjustments: [{ employeeId: f.employee.id, extrasCents: 200, deductionsCents: 50 }] });
  assert.equal(payroll.baseCents, 10000);
  assert.equal(payroll.commissionCents, 100);
  assert.equal(payroll.totalCents, 10250);
  payroll = await f.post(`/payroll/${payroll.id}/recalculate`, { version: payroll.version });
  assert.equal(payroll.totalCents, 10250);
  assert.equal((await f.app.store.prepare('SELECT COUNT(*) AS count FROM commission_claims').get()).count, 1);
  await f.call('/payroll', { method: 'POST', body: { period }, status: 409 });
  await f.call(`/payroll/${payroll.id}`, { method: 'PATCH', body: { version: payroll.version, adjustments: [{ employeeId: f.employee.id, deductionsCents: 20000 }] }, status: 422 });
  assert.equal((await f.get(`/payroll/${payroll.id}`)).totalCents, 10250);
  payroll = await f.post(`/payroll/${payroll.id}/approve`, { version: payroll.version });
  const body = { version: payroll.version, method: 'transfer' }, key = randomUUID();
  await f.call(`/payroll/${payroll.id}/pay`, { method: 'POST', body, key });
  await f.call(`/payroll/${payroll.id}/pay`, { method: 'POST', body, key });
  assert.equal((await f.get(`/payroll/${payroll.id}`)).status, 'paid');
  assert.equal((await f.app.store.prepare("SELECT COUNT(*) AS count FROM cash_movements WHERE source='payroll'").get()).count, 1);
});

test('messages remain local, report dates respect business timezone, and exports disclose pagination', async (t) => {
  const f = await fixture(t);
  const initial = await f.get('/dashboard');
  assert.equal(initial.openOrders, 0); assert.equal(initial.receivedTodayCents, 0);
  const settings = await f.get('/settings');
  assert.equal(settings.timezone, 'America/Sao_Paulo');
  await f.patch('/settings', { version: settings.version, businessName: 'Lavagem Local de Teste' });
  let message = await f.create('/messages', { customerId: f.customer.id, template: 'after_service' });
  assert.ok(message.body.includes('Lavagem Local de Teste'));
  message = await f.post(`/messages/${message.id}/queue`, { version: message.version });
  assert.equal(message.status, 'queued'); assert.equal(message.deliveryMode, 'local_only'); assert.equal(message.sentAt, null);
  for (const time of ['2026-01-02T02:59:59.000Z','2026-01-02T03:00:00.000Z']) {
    const order = await f.order();
    const paid = await f.post(`/orders/${order.id}/payments`, { version: order.version, amountCents: 1000, method: 'pix' });
    (await f.app.store.prepare('UPDATE payments SET created_at=? WHERE id=?').run(time, paid.payments[0].id));
  }
  const firstDay = await f.call('/reports?type=sales&from=2026-01-01&to=2026-01-01');
  assert.equal(firstDay.data.items.length, 1);
  assert.equal(firstDay.data.summary.receivedCents, 1000);
  const both = await f.call('/reports?type=sales&from=2026-01-01&to=2026-01-02&limit=1');
  assert.equal(both.data.summary.receivedCents, 2000);
  assert.equal(both.data.page.total, 2); assert.equal(both.data.page.hasMore, true);
  const summary = await f.call('/reports?type=summary&from=2026-01-01&to=2026-01-02');
  assert.equal(summary.data.items.length, 4);
  assert.equal(summary.data.period.timezone, 'America/Sao_Paulo');
  for (const type of ['services','employees','stock','cash']) await f.call(`/reports?type=${type}`);
  const audit = JSON.stringify((await f.app.store.prepare("SELECT metadata_json FROM audit_events WHERE resource_type='message'").all()));
  assert.ok(!audit.includes(message.body));
});

test('receivable aggregation subtracts direct, invoice, and package allocations once per order', async (t) => {
  const f = await fixture(t);
  await f.patch(`/customers/${f.customer.id}`, { version: f.customer.version, postpaid: true });
  let invoiceOrder = await f.order({ items: [{ serviceId: f.service.id, quantity: 2 }] });
  invoiceOrder = await f.post(`/orders/${invoiceOrder.id}/payments`, { version: invoiceOrder.version, amountCents: 200, method: 'pix' });
  invoiceOrder = await f.ready(invoiceOrder);
  const invoice = await f.create('/invoices', { customerId: f.customer.id, orderIds: [invoiceOrder.id], dueDate: '2026-12-01' });
  await f.post(`/invoices/${invoice.id}/payments`, { version: invoice.version, amountCents: 300, method: 'transfer' });
  const plan = await f.create('/packages', { name: 'Pacote Saldo Teste', serviceId: f.service.id, credits: 3, priceCents: 2000 });
  const sale = await f.create(`/packages/${plan.id}/sales`, { customerId: f.customer.id, method: 'pix' });
  let mixed = await f.order({ items: [{ serviceId: f.service.id, quantity: 3 }] });
  mixed = await f.post(`/orders/${mixed.id}/package-redemptions`, { version: mixed.version, packageSaleId: sale.id, quantity: 1 });
  mixed = await f.post(`/orders/${mixed.id}/package-redemptions`, { version: mixed.version, packageSaleId: sale.id, quantity: 1 });
  mixed = await f.post(`/orders/${mixed.id}/payments`, { version: mixed.version, amountCents: 100, method: 'pix' });
  mixed = await f.post(`/orders/${mixed.id}/payments`, { version: mixed.version, amountCents: 200, method: 'pix' });
  await f.order({ status: 'quote' });
  const cancelled = await f.order(); await f.transition(cancelled, 'cancelled');
  assert.equal(mixed.balanceCents, 700);
  assert.equal((await f.get(`/orders/${invoiceOrder.id}`)).balanceCents, 1500);
  assert.equal((await f.get('/dashboard')).receivableCents, 2200);
  assert.equal((await f.call('/reports')).data.summary.openReceivableCents, 2200);
});
