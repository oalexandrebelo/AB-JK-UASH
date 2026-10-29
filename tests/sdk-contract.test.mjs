import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildOpenApi, operations, schemas } from '../scripts/sdk-contract.mjs';
import { administrator, fixture, checkSchema } from './sdk-helpers.mjs';

test('OpenAPI 3.1 and generated SDK cover all 89 base plus 8 fiscal routes with exact envelopes', async () => {
  const expected = new Set([
    'GET /api/health', 'GET /api/status', 'GET /api/auth/session', 'POST /api/setup', 'POST /api/auth/login', 'POST /api/auth/logout', 'POST /api/auth/password',
    'GET /api/users', 'POST /api/users', 'PATCH /api/users/{x}', 'GET /api/audit',
    ...['customers', 'vehicles', 'services', 'employees', 'products', 'packages'].flatMap((name) => [`GET /api/${name}`, `POST /api/${name}`, `GET /api/${name}/{x}`, `PATCH /api/${name}/{x}`]),
    'GET /api/orders', 'POST /api/orders', 'GET /api/orders/{x}', 'PATCH /api/orders/{x}',
    ...['transition', 'payments', 'checklist', 'consumptions', 'consumptions/{x}/reverse', 'package-redemptions', 'package-redemptions/{x}/reverse'].map((action) => `POST /api/orders/{x}/${action}`),
    'GET /api/orders/{x}/photos', 'POST /api/orders/{x}/photos', 'GET /api/order-photos/{x}', 'PATCH /api/order-photos/{x}',
    'GET /api/products/{x}/movements', 'POST /api/products/{x}/movements',
    'GET /api/cash', 'GET /api/cash/current', 'GET /api/cash/{x}', 'POST /api/cash/open', 'POST /api/cash/{x}/movements', 'POST /api/cash/{x}/close',
    'GET /api/invoices', 'POST /api/invoices', 'GET /api/invoices/{x}', 'POST /api/invoices/{x}/payments', 'POST /api/invoices/{x}/cancel',
    'GET /api/package-sales', 'GET /api/package-sales/{x}', 'POST /api/packages/{x}/sales', 'GET /api/payments',
    'GET /api/payroll', 'POST /api/payroll', 'GET /api/payroll/{x}', 'PATCH /api/payroll/{x}',
    ...['approve', 'pay', 'recalculate'].map((action) => `POST /api/payroll/{x}/${action}`),
    'GET /api/appointments', 'POST /api/appointments', 'GET /api/appointments/{x}', 'PATCH /api/appointments/{x}', 'POST /api/appointments/{x}/convert',
    'GET /api/messages', 'POST /api/messages', 'GET /api/messages/{x}', 'PATCH /api/messages/{x}', 'POST /api/messages/{x}/queue', 'POST /api/messages/{x}/cancel',
    'GET /api/settings', 'PATCH /api/settings', 'GET /api/dashboard', 'GET /api/reports',
    'GET /api/fiscal/status', 'GET /api/fiscal/config', 'GET /api/fiscal/drafts', 'POST /api/fiscal/drafts', 'GET /api/fiscal/drafts/{x}',
    ...['cancel', 'submit', 'reconcile'].map((action) => `POST /api/fiscal/drafts/{x}/${action}`),
  ]);
  assert.equal(expected.size, 97);
  const actual = new Set(operations.map((operation) => `${operation.method} ${operation.path.replace(/\{\w+\}/g, '{x}')}`));
  assert.deepEqual(actual, expected);
  assert.equal(operations.length, actual.size, 'No duplicate route definitions');
  assert.equal(new Set(operations.map((op) => op.operationId)).size, actual.size);
  const spec = buildOpenApi();
  assert.equal(spec.openapi, '3.1.0');
  assert.deepEqual(JSON.parse(await readFile(new URL('../docs/api/openapi.json', import.meta.url))), spec, 'Checked-in spec must match contract source');
  for (const [path, definitions] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(definitions)) {
      assert.ok(operation.responses.default);
      const needsIdempotency = operation['x-idempotent-write'];
      assert.equal(operation.parameters?.some((p) => p.$ref?.endsWith('/IdempotencyKey')) || false, needsIdempotency, `${method} ${path}`);
      assert.ok(operation.responses['200'] || operation.responses['201']);
    }
  }
  assert.equal(schemas.UpdateUserInput.properties.version, undefined);
  assert.equal(spec.paths['/api/users'].post['x-idempotent-write'], false);
  assert.deepEqual(spec.paths['/api/cash/current'].get['x-roles'], ['admin', 'manager', 'operator']);
  assert.deepEqual(spec.paths['/api/cash'].get['x-roles'], ['admin', 'manager']);
  for (const operationId of ['listUsers', 'listAudit', 'listOrderPhotos']) assert.equal(operations.find((op) => op.operationId === operationId).response.properties.page, undefined);
  assert.equal(schemas.FiscalPage.properties.hasMore, undefined);
});

test('real SQLite HTTP response and request schemas cover every one of 97 SDK operations', async (t) => {
  const fiscalCalls = [];
  const { client } = await fixture(t, {
    fiscalEnv: { AB_UASH_FISCAL_ENABLED: 'true', AB_UASH_FISCAL_PROVIDER: 'focusnfe', AB_UASH_FISCAL_ENVIRONMENT: 'sandbox', AB_UASH_FOCUS_NFE_TOKEN: 'fixture-token-not-real' },
    fiscalTransport: async (request) => {
      fiscalCalls.push({ method: request.method, path: request.path });
      return request.method === 'POST' ? { statusCode: 202, body: { status: 'processando_autorizacao' } } : { statusCode: 200, body: { status: 'autorizado' } };
    },
  });
  const seen = new Set();
  async function call(operationId, input = {}, options) {
    const operation = operations.find((candidate) => candidate.operationId === operationId);
    assert.ok(operation, `Known operation ${operationId}`);
    if (operation.body) checkSchema(operation.body, input.body, `${operationId}.request`);
    const output = await client.api[operationId](input, options);
    checkSchema(operation.response, output, `${operationId}.response`);
    seen.add(operationId);
    return output;
  }
  const item = async (...args) => (await call(...args)).item;
  await call('getHealth');
  await call('getStatus');
  await call('getSession');
  await call('setup', { body: administrator });
  await call('login', { body: { email: administrator.email, password: administrator.password } });
  const { user } = await call('createUser', { body: { name: 'SDK Viewer', email: 'sdk-viewer-contract@example.test', password: 'test-sdk-contract-password', role: 'viewer' } });
  await call('updateUser', { path: { userId: user.id }, body: { name: 'Updated Viewer' } });
  await call('listUsers');
  let customer = await item('createCustomer', { body: { name: 'Contrato SDK', postpaid: true } });
  let vehicle = await item('createVehicle', { body: { customerId: customer.id, plate: 'SDK0A01', model: 'Modelo SDK' } });
  let service = await item('createService', { body: { name: 'Serviço SDK', priceCents: 2000, commissionBps: 1000 } });
  let employee = await item('createEmployee', { body: { name: 'Funcionário SDK', baseSalaryCents: 200000 } });
  let product = await item('createProduct', { body: { name: 'Produto SDK', sku: 'SDK-001', quantityMilli: 5000, costCents: 2000 } });
  let plan = await item('createPackage', { body: { name: 'Pacote SDK', serviceId: service.id, credits: 2, priceCents: 3000 } });
  for (const [name, object, update] of [
    ['Customer', customer, { phone: '11999990000' }], ['Vehicle', vehicle, { color: 'Prata' }],
    ['Service', service, { durationMinutes: 45 }], ['Employee', employee, { roleLabel: 'Lavador' }],
    ['Product', product, { minQuantityMilli: 500 }], ['Package', plan, { validDays: 180 }],
  ]) {
    const next = await item(`update${name}`, { path: { id: object.id }, body: { version: object.version, ...update } });
    if (name === 'Customer') customer = next;
    if (name === 'Vehicle') vehicle = next;
    if (name === 'Service') service = next;
    if (name === 'Employee') employee = next;
    if (name === 'Product') product = next;
    if (name === 'Package') plan = next;
    await item(`get${name}`, { path: { id: object.id } });
    await call(`list${name}s`, { query: { limit: 1, offset: 0, active: 'true', q: 'SDK' } });
  }
  product = await item('changeStock', { path: { productId: product.id }, body: { version: product.version, type: 'purchase', quantityMilli: 200 } });
  await call('listProductMovements', { path: { productId: product.id }, query: { limit: 1, offset: 0 } });
  let order = await item('createOrder', { body: { customerId: customer.id, vehicleId: vehicle.id, employeeId: employee.id, items: [{ serviceId: service.id, quantity: 2 }] } });
  order = await item('updateOrder', { path: { orderId: order.id }, body: { version: order.version, notes: 'Atualização de contrato' } });
  await item('getOrder', { path: { orderId: order.id } });
  await call('listOrders', { query: { customerId: customer.id, vehicleId: vehicle.id, employeeId: employee.id, status: 'waiting', q: 'SDK', limit: 1, offset: 0 } });
  order = await item('updateOrderChecklist', { path: { orderId: order.id }, body: { version: order.version, items: [{ zone: 'Porta', condition: 'ok' }] } });
  order = await item('consumeProduct', { path: { orderId: order.id }, body: { version: order.version, productId: product.id, quantityMilli: 100 } });
  order = await item('reverseConsumption', { path: { orderId: order.id, movementId: order.consumptions[0].id }, body: { version: order.version, notes: 'Teste de reversão' } });
  const photo = await item('addOrderPhoto', { path: { orderId: order.id }, body: { mimeType: 'image/png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', caption: 'Foto de teste' } });
  await call('listOrderPhotos', { path: { orderId: order.id } });
  await item('getPhoto', { path: { photoId: photo.id } });
  await item('updatePhoto', { path: { photoId: photo.id }, body: { version: photo.version, caption: 'Legenda atualizada' } });
  order = await item('recordOrderPayment', { path: { orderId: order.id }, body: { version: order.version, amountCents: 1000, method: 'pix', reference: 'SDK' } });
  const sale = await item('sellPackage', { path: { packageId: plan.id }, body: { customerId: customer.id, method: 'pix' } });
  await item('getPackageSale', { path: { saleId: sale.id } });
  await call('listPackageSales', { query: { customerId: customer.id, q: 'SDK' } });
  order = await item('redeemPackage', { path: { orderId: order.id }, body: { version: order.version, packageSaleId: sale.id, quantity: 1 } });
  order = await item('reverseRedemption', { path: { orderId: order.id, redemptionId: order.packageRedemptions[0].id }, body: { version: order.version } });
  async function ready(row) {
    for (const status of ['in_progress', 'quality_check', 'ready']) row = await item('transitionOrder', { path: { orderId: row.id }, body: { version: row.version, status } });
    return row;
  }
  order = await ready(order);
  let invoice = await item('createInvoice', { body: { customerId: customer.id, orderIds: [order.id], dueDate: new Date().toISOString().slice(0, 10) } });
  await item('getInvoice', { path: { invoiceId: invoice.id } });
  await call('listInvoices', { query: { status: 'issued', customerId: customer.id, q: 'SDK' } });
  invoice = await item('recordInvoicePayment', { path: { invoiceId: invoice.id }, body: { version: invoice.version, amountCents: invoice.balanceCents, method: 'pix' } });
  order = await item('getOrder', { path: { orderId: order.id } });
  order = await item('transitionOrder', { path: { orderId: order.id }, body: { version: order.version, status: 'delivered' } });
  let secondOrder = await item('createOrder', { body: { customerId: customer.id, vehicleId: vehicle.id, items: [{ serviceId: service.id, quantity: 1 }] } });
  secondOrder = await ready(secondOrder);
  const cancelledInvoice = await item('createInvoice', { body: { customerId: customer.id, orderIds: [secondOrder.id], dueDate: new Date().toISOString().slice(0, 10) } });
  await item('cancelInvoice', { path: { invoiceId: cancelledInvoice.id }, body: { version: cancelledInvoice.version } });
  await call('listPayments', { query: { customerId: customer.id, source: 'order', limit: 2 } });
  let cash = await item('openCash', { body: { openingCents: 1000 } });
  await item('getCurrentCash');
  await item('getCashSession', { path: { cashId: cash.id } });
  await call('listCashSessions');
  cash = await item('moveCash', { path: { cashId: cash.id }, body: { version: cash.version, type: 'in', amountCents: 100, category: 'Teste' } });
  await item('closeCash', { path: { cashId: cash.id }, body: { version: cash.version, countedCents: 1100 } });
  let payroll = await item('createPayroll', { body: { period: new Date().toISOString().slice(0, 7), adjustments: [{ employeeId: employee.id, extrasCents: 100, deductionsCents: 0 }] } });
  await item('getPayroll', { path: { payrollId: payroll.id } });
  await call('listPayroll', { query: { status: 'draft' } });
  payroll = await item('updatePayroll', { path: { payrollId: payroll.id }, body: { version: payroll.version, adjustments: [{ employeeId: employee.id, extrasCents: 200 }] } });
  payroll = await item('recalculatePayroll', { path: { payrollId: payroll.id }, body: { version: payroll.version } });
  payroll = await item('approvePayroll', { path: { payrollId: payroll.id }, body: { version: payroll.version } });
  await item('payPayroll', { path: { payrollId: payroll.id }, body: { version: payroll.version, method: 'pix' } });
  let appointment = await item('createAppointment', { body: { customerId: customer.id, vehicleId: vehicle.id, employeeId: employee.id, items: [{ serviceId: service.id, quantity: 1 }], startsAt: '2030-04-05T12:00:00Z' } });
  await item('getAppointment', { path: { appointmentId: appointment.id } });
  await call('listAppointments', { query: { status: 'scheduled', customerId: customer.id, employeeId: employee.id, q: 'SDK' } });
  appointment = await item('updateAppointment', { path: { appointmentId: appointment.id }, body: { version: appointment.version, status: 'confirmed' } });
  await item('convertAppointment', { path: { appointmentId: appointment.id }, body: { version: appointment.version } });
  let message = await item('createMessage', { body: { customerId: customer.id, template: 'after_service', orderId: order.id } });
  await item('getMessage', { path: { messageId: message.id } });
  await call('listMessages', { query: { status: 'draft', q: 'SDK' } });
  message = await item('updateMessage', { path: { messageId: message.id }, body: { version: message.version, body: 'Texto local SDK' } });
  message = await item('queueMessage', { path: { messageId: message.id }, body: { version: message.version } });
  await item('cancelMessage', { path: { messageId: message.id }, body: { version: message.version } });
  const settings = await item('getSettings');
  await item('updateSettings', { body: { version: settings.version, phone: '11900000000' } });
  await item('getDashboard');
  for (const type of ['summary', 'sales', 'services', 'employees', 'stock', 'cash']) await call('getReports', { query: { type, limit: 100, offset: 0 } });
  await call('getFiscalStatus');
  await call('getFiscalConfig');
  const draftInput = {
    orderId: order.id,
    customer: { taxId: '52998224725', name: 'Tomador de Teste SDK', address: { municipalityCode: '3550308', zipCode: '01001000', street: 'Rua de Teste', number: '100', neighborhood: 'Centro' } },
    fiscal: { data_emissao: '2026-10-20T12:00:00Z', data_competencia: '2026-10-20', serie_dps: 1, numero_dps: 100, emitente_dps: '1', cnpj_prestador: '11222333000181', codigo_municipio_emissora: '3550308', codigo_opcao_simples_nacional: '1', regime_especial_tributacao: '0', codigo_municipio_prestacao: '3550308', codigo_tributacao_nacional_iss: '140101', codigo_nbs: '112233445', tributacao_iss: '1', tipo_retencao_iss: '1' },
    taxReview: { ibsCbsRequired: false, justification: 'Fixture técnica sem validade fiscal.', discountTreatment: 'none' },
  };
  const firstDraft = (await call('createFiscalDraft', { body: draftInput })).draft;
  await call('getFiscalDraft', { path: { draftId: firstDraft.id } });
  await call('listFiscalDrafts', { query: { orderId: order.id, status: 'prepared', limit: 10, offset: 0 } });
  await call('cancelFiscalDraft', { path: { draftId: firstDraft.id }, body: { version: firstDraft.version } });
  const secondDraft = (await call('createFiscalDraft', { body: { ...draftInput, fiscal: { ...draftInput.fiscal, numero_dps: 101 } } })).draft;
  const submitted = (await call('submitFiscalDraft', { path: { draftId: secondDraft.id }, body: { version: secondDraft.version } })).draft;
  assert.equal(submitted.status, 'pending');
  const reconciled = (await call('reconcileFiscalDraft', { path: { draftId: secondDraft.id }, body: { version: submitted.version } })).draft;
  assert.equal(reconciled.status, 'authorized');
  assert.deepEqual(fiscalCalls.map((entry) => entry.method), ['POST', 'GET']);
  assert.equal(JSON.stringify(reconciled).includes(draftInput.customer.taxId), false);
  await call('listAudit', { query: { limit: 500 } });
  await call('changePassword', { body: { currentPassword: administrator.password, newPassword: 'contract-new-password-2026' } });
  await call('logout', { body: {} });
  assert.deepEqual([...seen].sort(), operations.map((operation) => operation.operationId).sort(), 'Every SDK operation must complete successfully and satisfy its schema');
  t.diagnostic(`${seen.size}/97 distinct operations verified over a real HTTP server with SQLite, including all six report shapes.`);
});
