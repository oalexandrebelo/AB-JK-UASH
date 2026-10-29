import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, ApiError, TransportError } from '../sdk/dist/index.js';
import { schemas } from '../scripts/sdk-contract.mjs';
import { fixture, administrator, checkSchema, seedOrder } from './sdk-helpers.mjs';

test('SDK rejects contradictory HTTP envelopes without clearing a valid local session', async () => {
  let requests = 0;
  const client = createClient({
    baseUrl: 'https://sdk.example.test',
    fetch: async () => {
      requests++;
      if (requests === 1) return Response.json({ ok: true, data: { user: { id: 'review-user' }, csrfToken: 'c'.repeat(43) } });
      if (requests === 2) return Response.json({ ok: false, error: { code: 'AUTH_REQUIRED', message: 'Contradictory success response' } });
      return Response.json({ ok: true, data: { item: { id: 'customer-review' } } });
    },
  });
  await client.api.getSession();
  await assert.rejects(client.api.listCustomers(), (error) => error instanceof TransportError && error.kind === 'protocol');
  const prepared = client.prepare('createCustomer', { body: { name: 'Cliente Revisão' } });
  assert.equal((await prepared.execute()).item.id, 'customer-review');
  assert.equal(requests, 3);

  const failed = createClient({ baseUrl: 'https://sdk.example.test', fetch: async () => Response.json({ ok: true, data: {} }, { status: 500 }) });
  await assert.rejects(failed.api.getHealth(), (error) => error instanceof TransportError && error.kind === 'protocol');
  const denied = createClient({ baseUrl: 'https://sdk.example.test', fetch: async () => Response.json({ ok: false, error: { code: 'FORBIDDEN', message: 'Sem acesso.' } }, { status: 403 }) });
  await assert.rejects(denied.api.getHealth(), (error) => error instanceof ApiError && error.status === 403 && error.code === 'FORBIDDEN');
});

test('JavaScript callers cannot use coercible keys or setup tokens that change after prepare', async () => {
  let requests = 0;
  const client = createClient({ baseUrl: 'https://sdk.example.test', fetch: async () => { requests++; return Response.json({ ok: true, data: {} }); } });
  for (const idempotencyKey of [12345678, { toString: () => 'mutable-key-review' }]) {
    assert.throws(() => client.prepare('createCustomer', { body: { name: 'Cliente Revisão' } }, { idempotencyKey }), TypeError);
    await assert.rejects(client.api.createCustomer({ body: { name: 'Cliente Revisão' } }, { idempotencyKey }), TypeError);
  }
  await assert.rejects(client.api.setup({ body: administrator }, { setupToken: { toString: () => 'x'.repeat(32) } }), TypeError);
  assert.equal(requests, 0);
});

test('payroll response schemas accept gross aggregates above per-entry limits while preserving integer cents', async (t) => {
  const { client } = await fixture(t);
  await client.api.setup({ body: administrator });
  const employees = [];
  for (const name of ['Primeiro Funcionário', 'Segundo Funcionário']) employees.push((await client.api.createEmployee({ body: { name, baseSalaryCents: 800_000_000 } })).item);
  const created = (await client.api.createPayroll({ body: {
    period: '2026-10',
    adjustments: employees.map(({ id }) => ({ employeeId: id, extrasCents: 200_000_000, deductionsCents: 900_000_000 })),
  } })).item;
  assert.equal(created.baseCents, 1_600_000_000);
  assert.equal(created.extrasCents, 400_000_000);
  assert.equal(created.deductionsCents, 1_800_000_000);
  assert.equal(created.totalCents, 200_000_000);
  checkSchema(schemas.Payroll, created);
  const page = await client.api.listPayroll({ query: { limit: 1, offset: 0 } });
  assert.deepEqual(page.page, { limit: 1, offset: 0, total: 1, hasMore: false });
  checkSchema(schemas.Payroll, page.items[0]);
  const empty = await client.api.listPayroll({ query: { limit: 1, offset: 1 } });
  assert.deepEqual(empty, { items: [], page: { limit: 1, offset: 1, total: 1, hasMore: false } });
  await assert.rejects(client.api.updateEmployee({ path: { id: employees[0].id }, body: { version: employees[0].version, baseSalaryCents: 1_000_000_001 } }), { code: 'VALIDATION_ERROR', status: 422 });
});

test('a payroll line can aggregate commissions above an individual money input limit', async (t) => {
  const { client } = await fixture(t);
  await client.api.setup({ body: administrator });
  const employee = (await client.api.createEmployee({ body: { name: 'Comissão Acumulada', baseSalaryCents: 0, commissionBps: 10000 } })).item;
  const seeded = await seedOrder(client, { priceCents: 600_000_000 });
  const first = (await client.api.updateOrder({ path: { orderId: seeded.order.id }, body: { version: seeded.order.version, employeeId: employee.id, items: [{ serviceId: seeded.service.id, quantity: 1 }] } })).item;
  const second = (await client.api.createOrder({ body: { customerId: seeded.customer.id, vehicleId: seeded.vehicle.id, employeeId: employee.id, items: [{ serviceId: seeded.service.id, quantity: 1 }] } })).item;
  for (let order of [first, second]) {
    order = (await client.api.recordOrderPayment({ path: { orderId: order.id }, body: { version: order.version, amountCents: order.totalCents, method: 'pix' } })).item;
    for (const status of ['in_progress', 'quality_check', 'ready', 'delivered']) order = (await client.api.transitionOrder({ path: { orderId: order.id }, body: { version: order.version, status } })).item;
  }
  const period = (await client.api.getDashboard()).item.businessDate.slice(0, 7);
  const payroll = (await client.api.createPayroll({ body: { period, adjustments: [{ employeeId: employee.id, deductionsCents: 800_000_000 }] } })).item;
  assert.equal(payroll.lines[0].commissionCents, 1_200_000_000);
  assert.equal(payroll.totalCents, 400_000_000);
  checkSchema(schemas.Payroll, payroll);
});
