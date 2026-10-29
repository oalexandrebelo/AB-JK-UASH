import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {createTestApplication as createApplication} from './database-fixture.mjs';

const password = 'security-review-fixture-password';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ab-uash-security-'));
  const distDir = join(dir, 'dist');
  await mkdir(distDir);
  await writeFile(join(distDir, 'index.html'), '<!doctype html><title>Teste isolado</title>');
  const errors = [];
  const app = await createApplication({dbPath:join(dir, 'local.sqlite'), distDir, logger:{error(error) {errors.push(error);}}});
  const address = await app.listen({port:0});
  const base = `http://127.0.0.1:${address.port}`;
  const admin = {cookie:'', csrf:''};
  async function api(path, body, {method = body === undefined ? 'GET' : 'POST', key = randomUUID(), client = admin, headers = {}} = {}) {
    const response = await fetch(base + path, {
      method,
      headers:{
        Origin:base, ...(client.cookie ? {Cookie:client.cookie} : {}),
        ...(body !== undefined ? {'Content-Type':'application/json', 'X-CSRF-Token':client.csrf, 'Idempotency-Key':key} : {}),
        ...headers,
      },
      ...(body !== undefined ? {body:JSON.stringify(body)} : {}),
    });
    const result = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
    return {status:response.status, result, headers:response.headers};
  }
  const setup = await api('/api/setup', {name:'Administrador sintético',email:'security@example.invalid',password});
  assert.equal(setup.status, 201);
  admin.cookie = setup.headers.get('set-cookie').split(';')[0];
  admin.csrf = setup.result.data.csrfToken;
  async function item(path, body, options) {
    const result = await api(path, body, options);
    assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result.result));
    return result.result.data.item;
  }
  async function principals() {
    const customer = await item('/api/customers', {name:'Cliente sintético'});
    const vehicle = await item('/api/vehicles', {customerId:customer.id,plate:randomUUID().replaceAll('-','').slice(0,10),model:'Modelo sintético'});
    return {customer, vehicle};
  }
  async function createOrder({priceCents = 1000, quantity = 1, discountCents = 0, ...orderFields} = {}) {
    const {customer, vehicle} = await principals();
    const service = await item('/api/services', {name:'Lavagem sintética', priceCents});
    const order = await item('/api/orders', {customerId:customer.id,vehicleId:vehicle.id,items:[{serviceId:service.id,quantity}],discountCents,...orderFields});
    return {customer, vehicle, service, order};
  }
  t.after(async () => {
    await app.close();
    await rm(dir, {recursive:true,force:true});
    assert.deepEqual(errors, [], 'Nenhuma falha interna deve ocorrer nos cenários de revisão');
  });
  return {dir, distDir, app, base, admin, api, item, principals, createOrder};
}

test('recebimentos concorrentes respeitam chave, versão e atomicidade com caixa fechado', async (t) => {
  const f = await fixture(t);
  const {order} = await f.createOrder();
  const path = `/api/orders/${order.id}/payments`;
  const body = {version:order.version,amountCents:400,method:'pix'};
  const key = randomUUID();
  const repeated = await Promise.all(Array.from({length:5}, () => f.api(path, body, {key})));
  assert.deepEqual(repeated.map(result => result.status), [200,200,200,200,200]);
  assert.equal(repeated.filter(result => result.headers.get('idempotency-replayed') === 'true').length, 4);
  assert.equal((await f.app.store.prepare('SELECT count(*) n FROM payments').get()).n, 1);
  assert.equal((await f.api(path, {...body,amountCents:401}, {key})).result.error.code, 'IDEMPOTENCY_CONFLICT');
  const current = await f.item(`/api/orders/${order.id}`);
  const racing = await Promise.all(Array.from({length:3}, () => f.api(path, {version:current.version,amountCents:600,method:'pix'})));
  assert.deepEqual(racing.map(result => result.status).sort(), [200,409,409]);
  assert.ok(racing.filter(result => result.status === 409).every(result => result.result.error.code === 'VERSION_CONFLICT'));
  assert.equal((await f.app.store.prepare('SELECT sum(amount_cents) n FROM payments').get()).n, 1000);
  assert.equal((await f.item(`/api/orders/${order.id}`)).balanceCents, 0);
  const another = (await f.createOrder()).order;
  const before = {
    payments:(await f.app.store.prepare('SELECT count(*) n FROM payments').get()).n,
    cash:(await f.app.store.prepare('SELECT count(*) n FROM cash_movements').get()).n,
    keys:(await f.app.store.prepare('SELECT count(*) n FROM idempotency_keys').get()).n,
    audit:(await f.app.store.prepare('SELECT count(*) n FROM audit_events').get()).n,
  };
  const rejected = await f.api(`/api/orders/${another.id}/payments`, {version:another.version,amountCents:1000,method:'cash'});
  assert.equal(rejected.result.error.code, 'CASH_CLOSED');
  assert.deepEqual({
    payments:(await f.app.store.prepare('SELECT count(*) n FROM payments').get()).n,
    cash:(await f.app.store.prepare('SELECT count(*) n FROM cash_movements').get()).n,
    keys:(await f.app.store.prepare('SELECT count(*) n FROM idempotency_keys').get()).n,
    audit:(await f.app.store.prepare('SELECT count(*) n FROM audit_events').get()).n,
  }, before);
  assert.equal((await f.item(`/api/orders/${another.id}`)).balanceCents, 1000);
});

test('consumo concorrente não cria estoque negativo e reversão restaura uma única vez', async (t) => {
  const f = await fixture(t);
  const {order} = await f.createOrder();
  const product = await f.item('/api/products', {name:'Produto sintético',sku:'SECURITY-TEST',quantityMilli:1000});
  const path = `/api/orders/${order.id}/consumptions`;
  const races = await Promise.all(Array.from({length:3}, () => f.api(path, {version:order.version,productId:product.id,quantityMilli:750})));
  assert.deepEqual(races.map(result => result.status).sort(), [200,409,409]);
  let current = await f.item(`/api/orders/${order.id}`);
  assert.equal((await f.item(`/api/products/${product.id}`)).quantityMilli, 250);
  assert.equal((await f.api(path, {version:current.version,productId:product.id,quantityMilli:251})).result.error.code, 'INSUFFICIENT_STOCK');
  const reverse = `${path}/${current.consumptions[0].id}/reverse`;
  current = await f.item(reverse, {version:current.version});
  assert.equal((await f.item(`/api/products/${product.id}`)).quantityMilli, 1000);
  assert.equal((await f.api(reverse, {version:current.version})).result.error.code, 'ALREADY_REVERSED');
  assert.equal((await f.item(`/api/products/${product.id}`)).quantityMilli, 1000);
});

test('crédito com valor arredondado zero impede reescrita e cancelamento até ser revertido', async (t) => {
  const f = await fixture(t);
  const {customer, service, order} = await f.createOrder({priceCents:1,quantity:3,discountCents:2});
  const plan = await f.item('/api/packages', {name:'Pacote sintético',serviceId:service.id,credits:3,priceCents:100});
  const sale = await f.item(`/api/packages/${plan.id}/sales`, {customerId:customer.id,method:'pix'});
  const redeemed = await f.item(`/api/orders/${order.id}/package-redemptions`, {version:order.version,packageSaleId:sale.id,quantity:1});
  assert.equal(redeemed.creditCents, 0, 'A unidade consumida pode representar zero centavos por arredondamento');
  assert.equal((await f.item(`/api/package-sales/${sale.id}`)).remainingCredits, 2);
  assert.equal((await f.api(`/api/orders/${order.id}`, {version:redeemed.version,notes:'Não pode reescrever'}, {method:'PATCH'})).result.error?.code, 'ORDER_HAS_MOVEMENTS');
  assert.equal((await f.api(`/api/orders/${order.id}/transition`, {version:redeemed.version,status:'cancelled'})).result.error?.code, 'ORDER_HAS_MOVEMENTS');
  const reverted = await f.item(`/api/orders/${order.id}/package-redemptions/${redeemed.packageRedemptions[0].id}/reverse`, {version:redeemed.version});
  assert.equal((await f.item(`/api/package-sales/${sale.id}`)).remainingCredits, 3);
  const cancelled = await f.item(`/api/orders/${order.id}/transition`, {version:reverted.version,status:'cancelled'});
  assert.equal(cancelled.status, 'cancelled');
});

test('alterar responsável preserva preços capturados até uma alteração explícita dos itens', async (t) => {
  const f = await fixture(t);
  const {service, order} = await f.createOrder({priceCents:1000});
  const employee = await f.item('/api/employees', {name:'Funcionário sintético',commissionBps:1000});
  await f.item(`/api/services/${service.id}`, {version:service.version,priceCents:2000}, {method:'PATCH'});
  const assigned = await f.item(`/api/orders/${order.id}`, {version:order.version,employeeId:employee.id}, {method:'PATCH'});
  assert.equal(assigned.totalCents, 1000);
  assert.equal(assigned.items[0].unitPriceCents, 1000);
  const repriced = await f.item(`/api/orders/${order.id}`, {version:assigned.version,items:[{serviceId:service.id,quantity:1}]}, {method:'PATCH'});
  assert.equal(repriced.totalCents, 2000);
});

function holdRequest(f, path, body, client, key) {
  const serialized = JSON.stringify(body);
  const marker = randomUUID();
  let ready;
  const receivedHeaders = new Promise(resolve => {ready = resolve;});
  const observer = request => {
    if (request.headers['x-review-hold'] !== marker) return;
    f.app.server.removeListener('request', observer);
    ready();
  };
  f.app.server.on('request', observer);
  let request;
  const response = new Promise((resolve, reject) => {
    request = httpRequest(f.base + path, {method:'POST', headers:{
      Origin:f.base,Cookie:client.cookie,'X-CSRF-Token':client.csrf,'Idempotency-Key':key,
      'Content-Type':'application/json','Content-Length':Buffer.byteLength(serialized),'X-Review-Hold':marker,
    }}, reply => {
      let data = '';
      reply.on('data', chunk => {data += chunk;});
      reply.on('end', () => resolve({status:reply.statusCode,result:JSON.parse(data)}));
    });
    request.on('error', reject);
    request.flushHeaders();
  });
  return {receivedHeaders, response, finish() {request.end(serialized);}};
}

test('revogação durante leitura HTTP bloqueia mutação nova e replay de domínio/foto', async (t) => {
  const f = await fixture(t);
  const {order} = await f.createOrder();
  const email = 'revoked-manager@example.invalid';
  const userResponse = await f.api('/api/users', {name:'Gestor sintético',email,password,role:'manager'});
  assert.equal(userResponse.status, 201);
  const managerId = userResponse.result.data.user.id;
  const login = await f.api('/api/auth/login', {email,password});
  const manager = {cookie:login.headers.get('set-cookie').split(';')[0],csrf:login.result.data.csrfToken};
  const serviceBody = {name:'Replay sintético',priceCents:500};
  const photoBody = {mimeType:'image/png',dataBase64:png,caption:'Foto sintética'};
  const serviceKey = randomUUID(), photoKey = randomUUID();
  assert.equal((await f.api('/api/services',serviceBody,{client:manager,key:serviceKey})).status,201);
  assert.equal((await f.api(`/api/orders/${order.id}/photos`,photoBody,{client:manager,key:photoKey})).status,201);
  const held = [
    holdRequest(f, '/api/services', serviceBody, manager, serviceKey),
    holdRequest(f, '/api/services', {...serviceBody,name:'Não deve existir'}, manager, randomUUID()),
    holdRequest(f, `/api/orders/${order.id}/photos`, photoBody, manager, photoKey),
  ];
  await Promise.all(held.map(request => request.receivedHeaders));
  assert.equal((await f.api(`/api/users/${managerId}`, {active:false}, {method:'PATCH'})).status,200);
  held.forEach(request => request.finish());
  const results = await Promise.all(held.map(request => request.response));
  assert.deepEqual(results.map(result => result.status), [401,401,401]);
  assert.ok(results.every(result => result.result.error.code === 'AUTH_REQUIRED'));
  assert.equal((await f.app.store.prepare("SELECT count(*) n FROM services WHERE name='Não deve existir'").get()).n,0);
  assert.equal((await f.app.store.prepare('SELECT count(*) n FROM order_photos').get()).n,1);
});

test('arquivos fora de dist não são servidos por symlink e origem incompatível é rejeitada', async (t) => {
  const f = await fixture(t);
  const secret = join(f.dir,'fora-do-dist.txt');
  await writeFile(secret,'SEGREDO SINTÉTICO');
  await symlink(secret, join(f.distDir,'public-link.txt'));
  const forbidden = await f.api('/public-link.txt');
  assert.equal(forbidden.status,404);
  assert.ok(!JSON.stringify(forbidden.result).includes('SEGREDO SINTÉTICO'));
  for (const headers of [
    {Origin:'null'},
    {Origin:'http://localhost:1'},
    {'Sec-Fetch-Site':'cross-site'},
  ]) assert.equal((await f.api('/api/status',undefined,{headers})).status,403,JSON.stringify(headers));
  // Node fetch substitutes Host; node:http sends the supplied wire header.
  const invalidHost = await new Promise((resolve, reject) => {
    const request = httpRequest(f.base + '/api/status', {headers:{Host:'127.0.0.1.attacker.invalid'}}, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error',reject);
    request.end();
  });
  assert.equal(invalidHost,403);
  const viewerResponse = await f.api('/api/users',{name:'Leitor sintético',email:'read-only@example.invalid',password,role:'viewer'});
  assert.equal(viewerResponse.status,201);
  const login = await f.api('/api/auth/login',{email:'read-only@example.invalid',password});
  const viewer = {cookie:login.headers.get('set-cookie').split(';')[0],csrf:login.result.data.csrfToken};
  for (const path of ['/api/users','/api/audit','/api/reports','/api/payroll','/api/payments','/api/cash']) {
    assert.equal((await f.api(path,undefined,{client:viewer})).status,403,path);
  }
  assert.equal((await f.api('/api/customers',{name:'Mutação bloqueada'},{client:viewer})).status,403);
});

test('fotos rejeitam dimensões exageradas, formato incompatível e alteração concorrente ou após entrega', async (t) => {
  const f = await fixture(t);
  let {order} = await f.createOrder({priceCents:0});
  const path = `/api/orders/${order.id}/photos`;
  const excessive = Buffer.from(png,'base64');
  excessive.writeUInt32BE(8192,16);
  excessive.writeUInt32BE(8192,20);
  assert.equal((await f.api(path,{mimeType:'image/png',dataBase64:excessive.toString('base64')})).result.error.code,'IMAGE_DIMENSIONS');
  assert.equal((await f.api(path,{mimeType:'image/jpeg',dataBase64:png})).result.error.code,'INVALID_IMAGE');
  assert.equal((await f.api(path,{mimeType:'image/png',dataBase64:Buffer.alloc(1_572_865).toString('base64')})).status,422);
  assert.equal((await f.api(path,{mimeType:'image/png',dataBase64:'A'.repeat(2_200_001)})).status,413);
  const photo = await f.item(path,{mimeType:'image/png',dataBase64:png,caption:'Antes'});
  const updates = await Promise.all(['Primeira','Segunda'].map(caption =>
    f.api(`/api/order-photos/${photo.id}`,{version:photo.version,caption},{method:'PATCH'})
  ));
  assert.deepEqual(updates.map(result => result.status).sort(),[200,409]);
  assert.equal(updates.find(result => result.status===409).result.error.code,'VERSION_CONFLICT');
  for (const status of ['in_progress','quality_check','ready','delivered']) {
    order = await f.item(`/api/orders/${order.id}/transition`,{version:order.version,status});
  }
  assert.equal((await f.api(path,{mimeType:'image/png',dataBase64:png})).result.error.code,'ORDER_CLOSED');
  assert.equal((await f.api(`/api/order-photos/${photo.id}`,{version:2,caption:'Não permitido'},{method:'PATCH'})).result.error.code,'ORDER_CLOSED');
  assert.equal((await f.item(`/api/order-photos/${photo.id}`)).version,2);
});
