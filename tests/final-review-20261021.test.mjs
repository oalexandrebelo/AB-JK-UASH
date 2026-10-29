import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../server/application.mjs';
import {createSnapshot} from '../scripts/storage.mjs';
import {businessDate} from '../server/domain-core.mjs';

// These scenarios deliberately cross public HTTP operations and a real SQLite
// recovery. They assert business results, rather than duplicating SQL formulas.
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ab-uash-independent-'));
  const applications = [], errors = [];
  const credentials = {name: 'Revisor independente', email: 'independent@example.invalid', password: 'Independent-synthetic-2026'};
  t.after(async () => {
    for (const app of applications) await app.close();
    await rm(directory, {recursive: true, force: true});
    assert.deepEqual(errors, [], 'No unexpected server errors');
  });
  async function connect(dbPath, setup = false) {
    const app = await createApplication({dbPath, fiscalEnv: {}, logger: {error(value) {errors.push(value);}}});
    applications.push(app);
    const address = await app.listen({host: '127.0.0.1', port: 0});
    const origin = `http://127.0.0.1:${address.port}`;
    let cookie = '', csrf = '';
    async function call(path, {body, method = body === undefined ? 'GET' : 'POST', status = 200, key = randomUUID(), headers = {}} = {}) {
      const response = await fetch(`${origin}/api${path}`, {method, headers: {
        Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf, 'Idempotency-Key': key,
        ...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...headers,
      }, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
      const result = await response.json();
      if (status !== null) assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`);
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      if (result.data?.csrfToken) csrf = result.data.csrfToken;
      return {status: response.status, headers: response.headers, ...result};
    }
    const item = async (path, options) => (await call(path, options)).data.item;
    const create = (path, body) => item(path, {body, status: 201});
    const login = () => call('/auth/login', {body: {email: credentials.email, password: credentials.password}});
    if (setup) await call('/setup', {body: credentials, status: 201});
    return {app, origin, call, item, create, login, session: () => ({cookie, csrf})};
  }
  const source = join(directory, 'source.sqlite');
  const client = await connect(source, true);
  const customer = await client.create('/customers', {name: 'Cliente sintético da revisão', postpaid: true});
  const vehicle = await client.create('/vehicles', {customerId: customer.id, plate: 'REV1A23', model: 'Veículo sintético'});
  const service = await client.create('/services', {name: 'Serviço sintético', priceCents: 1001});
  const order = (overrides = {}) => client.create('/orders', {
    customerId: customer.id, vehicleId: vehicle.id, items: [{serviceId: service.id, quantity: 1}], ...overrides,
  });
  const transition = (current, status) => client.item(`/orders/${current.id}/transition`, {body: {version: current.version, status}});
  async function deliver(current) {
    for (const status of ['in_progress', 'quality_check', 'ready', 'delivered']) current = await transition(current, status);
    return current;
  }
  return {...client, directory, source, connect, customer, vehicle, service, order, deliver};
}

test('revisão independente: ordens diferentes disputam o último crédito e estoque sem duplicar seus saldos', async t => {
  const f = await fixture(t);
  const plan = await f.create('/packages', {name: 'Último crédito', serviceId: f.service.id, credits: 1, priceCents: 900});
  const sale = await f.create(`/packages/${plan.id}/sales`, {customerId: f.customer.id, method: 'pix'});
  const product = await f.create('/products', {name: 'Última unidade', sku: 'REVIEW-LAST', quantityMilli: 1000});
  const orders = await Promise.all([f.order(), f.order()]);
  const credits = await Promise.all(orders.map(order => f.call(`/orders/${order.id}/package-redemptions`, {
    body: {version: order.version, packageSaleId: sale.id, quantity: 1}, status: null,
  })));
  assert.deepEqual(credits.map(result => result.status).sort(), [200, 409]);
  assert.equal(credits.find(result => result.status === 409).error.code, 'INSUFFICIENT_CREDITS');
  assert.equal((await f.item(`/package-sales/${sale.id}`)).remainingCredits, 0);
  let current = await Promise.all(orders.map(order => f.item(`/orders/${order.id}`)));
  assert.deepEqual(current.map(order => order.creditCents).sort((a, b) => a - b), [0, 1001]);
  assert.equal(current.reduce((sum, order) => sum + order.packageRedemptions.length, 0), 1);

  const consumptions = await Promise.all(current.map(order => f.call(`/orders/${order.id}/consumptions`, {
    body: {version: order.version, productId: product.id, quantityMilli: 1000}, status: null,
  })));
  assert.deepEqual(consumptions.map(result => result.status).sort(), [200, 409]);
  assert.equal(consumptions.find(result => result.status === 409).error.code, 'INSUFFICIENT_STOCK');
  assert.equal((await f.item(`/products/${product.id}`)).quantityMilli, 0);
  current = await Promise.all(orders.map(order => f.item(`/orders/${order.id}`)));
  assert.equal(current.reduce((sum, order) => sum + order.consumptions.length, 0), 1);
  const payments = (await f.call('/payments')).data.items;
  assert.equal(payments.length, 1);
  assert.equal(payments[0].amountCents, 900);
  assert.equal((await f.item('/dashboard')).receivableCents, 1001);
});

test('revisão independente: dinheiro, créditos, estoque, fatura e foto sobrevivem à restauração sem repetir recebimento', async t => {
  const f = await fixture(t);
  let cash = await f.create('/cash/open', {openingCents: 5000});
  const plan = await f.create('/packages', {name: 'Pacote de três', serviceId: f.service.id, credits: 3, priceCents: 2400});
  const sale = await f.create(`/packages/${plan.id}/sales`, {customerId: f.customer.id, method: 'cash'});
  const product = await f.create('/products', {name: 'Produto fracionado', sku: 'REVIEW-FRACTION', quantityMilli: 5000});
  let prepaid = await f.order({items: [{serviceId: f.service.id, quantity: 3}], discountCents: 2});
  const photoBytes = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=';
  const photo = await f.create(`/orders/${prepaid.id}/photos`, {mimeType: 'image/png', dataBase64: photoBytes, caption: 'Registro sintético preservado'});
  for (let index = 0; index < 2; index++) prepaid = await f.item(`/orders/${prepaid.id}/package-redemptions`, {
    body: {version: prepaid.version, packageSaleId: sale.id, quantity: 1},
  });
  const firstRedemption = prepaid.packageRedemptions[0].id;
  prepaid = await f.item(`/orders/${prepaid.id}/package-redemptions/${firstRedemption}/reverse`, {body: {version: prepaid.version}});
  prepaid = await f.item(`/orders/${prepaid.id}/package-redemptions`, {body: {version: prepaid.version, packageSaleId: sale.id, quantity: 2}});
  prepaid = await f.item(`/orders/${prepaid.id}/consumptions`, {body: {version: prepaid.version, productId: product.id, quantityMilli: 1250}});
  prepaid = await f.deliver(prepaid);
  assert.equal(prepaid.totalCents, 3001);
  assert.equal(prepaid.creditCents, 3001);
  assert.equal(prepaid.paidCents, 0);
  assert.equal(prepaid.balanceCents, 0);

  let postpaid = await f.order();
  postpaid = await f.item(`/orders/${postpaid.id}/payments`, {body: {version: postpaid.version, amountCents: 101, method: 'pix'}});
  postpaid = await f.deliver(postpaid);
  let invoice = await f.create('/invoices', {customerId: f.customer.id, orderIds: [postpaid.id], dueDate: businessDate()});
  assert.equal(invoice.totalCents, 900);
  const receiptPath = `/invoices/${invoice.id}/payments`;
  const receiptBody = {version: invoice.version, amountCents: 900, method: 'cash'};
  const receiptKey = randomUUID();
  invoice = await f.item(receiptPath, {body: receiptBody, key: receiptKey});
  cash = await f.item('/cash/current');
  assert.equal(cash.expectedCents, 8300);
  assert.equal(cash.movements.length, 3);
  cash = await f.item(`/cash/${cash.id}/close`, {body: {version: cash.version, countedCents: 8295}});
  assert.equal(cash.differenceCents, -5);

  const period = businessDate();
  const reportPath = `/reports?type=summary&from=${period}&to=${period}`;
  const expectedSummary = {receivedCents: 3401, deliveredCents: 4002, openReceivableCents: 0, orderCount: 2};
  assert.deepEqual((await f.call(reportPath)).data.summary, expectedSummary);
  assert.equal((await f.call('/fiscal/status')).data.enabled, false);
  const originalSession = f.session();
  const backup = join(f.directory, 'backup.sqlite');
  const restored = join(f.directory, 'restored.sqlite');
  await createSnapshot(f.source, backup);
  await f.create('/customers', {name: 'Criado somente depois do backup'});
  await createSnapshot(backup, restored, {restore: true});
  const recovery = await f.connect(restored);
  await recovery.call(`/orders/${prepaid.id}`, {headers: {Cookie: originalSession.cookie}, status: 401});
  assert.equal((await recovery.call('/status')).data.setupRequired, false);
  await recovery.login();

  assert.deepEqual((await recovery.call(reportPath)).data.summary, expectedSummary);
  assert.equal((await recovery.call('/customers')).data.page.total, 1);
  assert.equal((await f.call('/customers')).data.page.total, 2);
  assert.equal((await recovery.item(`/products/${product.id}`)).quantityMilli, 3750);
  assert.equal((await recovery.item(`/package-sales/${sale.id}`)).remainingCredits, 0);
  assert.deepEqual(await recovery.item(`/orders/${prepaid.id}`), prepaid);
  assert.equal((await recovery.item(`/orders/${postpaid.id}`)).balanceCents, 0);
  assert.deepEqual(await recovery.item(`/invoices/${invoice.id}`), invoice);
  assert.deepEqual(await recovery.item(`/cash/${cash.id}`), cash);
  assert.equal(await recovery.item('/cash/current'), null);
  assert.equal((await recovery.item(`/order-photos/${photo.id}`)).dataUri, `data:image/png;base64,${photoBytes}`);
  await recovery.call(`/order-photos/${photo.id}`, {headers: {Cookie: ''}, status: 401});

  const beforeReplay = await recovery.call('/audit?limit=500');
  const replay = await recovery.call(receiptPath, {body: receiptBody, key: receiptKey});
  assert.equal(replay.headers.get('idempotency-replayed'), 'true');
  assert.equal(replay.data.item.id, invoice.id);
  assert.deepEqual((await recovery.call('/audit?limit=500')).data, beforeReplay.data);
  assert.equal((await recovery.call('/payments')).data.page.total, 3);
  assert.deepEqual((await recovery.call(reportPath)).data.summary, expectedSummary);
  const changedReplay = await recovery.call(receiptPath, {body: {...receiptBody, amountCents: 899}, key: receiptKey, status: 409});
  assert.equal(changedReplay.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await f.item(`/orders/${prepaid.id}`)).status, 'delivered', 'Restoring the copy does not revoke the source session');
});
