import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { buildOpenApi, operations, schemas } from '../scripts/sdk-contract.mjs';
import { ARCHIVE_HEADERS } from '../server/jk-history-export-parse.mjs';
import { administrator, fixture, checkSchema } from './sdk-helpers.mjs';
import {AsaasWebhookReceiver,AsyncAsaasWebhookInbox} from '../integrations/jk/asaas-webhook.mjs';

const jkIntegrationIds=['getJkIntegrationReadiness','getJkOrderIntegrations','getJkOrderFiscalSource','prepareJkPix','prepareJkMessage','getJkPix','submitJkPix','reconcileJkPix','cancelJkPix','getJkMessage','submitJkMessage','cancelJkMessage'];

test('OpenAPI and generated SDK inventory covers every user, team, TEF and JK integration route with exact authentication', async () => {
  const expected = new Set([
    'GET /api/health', 'GET /api/status', 'GET /api/auth/session', 'POST /api/setup', 'POST /api/auth/login', 'POST /api/auth/logout', 'POST /api/auth/password',
    'GET /api/jk/transition', 'PATCH /api/jk/transition',
    'GET /api/jk/tef/catalog', 'GET /api/jk/tef/plan', 'PATCH /api/jk/tef/plan', 'GET /api/jk/tef/diagnostics',
    'GET /api/jk/team/status','POST /api/jk/team/preview','POST /api/jk/team/commit',
    'GET /api/jk/migration/status','GET /api/jk/migration/history','POST /api/jk/migration/preview','POST /api/jk/migration/commit',
    'GET /api/jk/reconciliation/status','GET /api/jk/reconciliation/vehicles','GET /api/jk/reconciliation/history','POST /api/jk/reconciliation/preview','POST /api/jk/reconciliation/commit',
    'GET /api/jk/source-catalog/status','GET /api/jk/source-catalog/rows','POST /api/jk/source-catalog/preview','POST /api/jk/source-catalog/commit',
    'GET /api/jk/integrations/readiness','GET /api/jk/orders/{x}/integrations','GET /api/jk/orders/{x}/fiscal-source',
    'POST /api/jk/orders/{x}/pix','POST /api/jk/orders/{x}/messages',
    'GET /api/jk/pix/{x}','GET /api/jk/messages/{x}',
    ...['submit','reconcile','cancel'].map(action=>`POST /api/jk/pix/{x}/${action}`),
    ...['submit','cancel'].map(action=>`POST /api/jk/messages/{x}/${action}`),
    'GET /api/jk/history-archive/status', 'GET /api/jk/history-archive/rows', 'POST /api/jk/history-archive/preview', 'POST /api/jk/history-archive/commit',
    'GET /api/users', 'POST /api/users', 'PATCH /api/users/{x}', 'POST /api/users/{x}/initial-password', 'GET /api/audit',
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
  assert.equal(expected.size, 136);
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
  assert.equal(spec.paths['/api/users/{userId}/initial-password'].post['x-idempotent-write'],true);
  assert.equal(spec.paths['/api/jk/team/preview'].post['x-idempotent-write'],false);
  assert.equal(spec.paths['/api/jk/team/commit'].post['x-idempotent-write'],true);
  assert.equal(spec.paths['/api/jk/migration/preview'].post['x-idempotent-write'],false);
  assert.equal(spec.paths['/api/jk/migration/commit'].post['x-idempotent-write'],true);
  for(const family of ['reconciliation','source-catalog']) {
    assert.equal(spec.paths[`/api/jk/${family}/preview`].post['x-idempotent-write'],false);
    assert.equal(spec.paths[`/api/jk/${family}/commit`].post['x-idempotent-write'],true);
    assert.deepEqual(spec.paths[`/api/jk/${family}/commit`].post['x-roles'],['admin']);
  }
  assert.deepEqual(spec.paths['/api/jk/migration/status'].get['x-roles'],['admin']);
  const webhook=spec.paths['/api/jk/integrations/asaas/webhook'].post;
  assert.deepEqual(webhook.security,[{asaasAccessToken:[]}]);
  assert.equal(webhook.parameters?.some(parameter=>parameter.$ref?.endsWith('/CsrfToken'))||false,false);
  assert.equal(operations.some(operation=>operation.operationId===webhook.operationId),false,'Provider receiver is not a cookie-authenticated SDK action');
  assert.deepEqual(spec.paths['/api/cash/current'].get['x-roles'], ['admin', 'manager', 'operator']);
  assert.deepEqual(spec.paths['/api/cash'].get['x-roles'], ['admin', 'manager']);
  for (const operationId of ['listUsers', 'listAudit', 'listOrderPhotos']) assert.equal(operations.find((op) => op.operationId === operationId).response.properties.page, undefined);
  assert.equal(schemas.FiscalPage.properties.hasMore, undefined);
});

test('native customer mode is explicit, file-only and keeps source identity read-only/null',()=>{
  const file={entity:'customers',format:'csv',content:'Nome;E-mail;Telefone;Situação da fatura;Data de vencimento;Valor da fatura;Veículos;Vagas;Observação\nCliente sintético;--;--;--;--;0;ABC1D23;--;--'};
  const input={source:'jumpcar',nativeCustomerMode:'customers-only',files:[file]};
  assert.ok(schemas.JkMigrationInput,'Contrato do importador disponível.');
  checkSchema(schemas.JkMigrationInput,input);
  assert.throws(()=>checkSchema(schemas.JkMigrationInput,{...input,dataset:{schemaVersion:1,customers:[]}}));
  assert.throws(()=>checkSchema(schemas.JkMigrationInput,{...input,files:[file,file]}));
  assert.throws(()=>checkSchema(schemas.JkMigrationInput,{...input,files:[{...file,entity:'vehicles'}]}));
  assert.throws(()=>checkSchema(schemas.JkMigrationInput,{...input,nativeCustomerMode:'automatic'}));
  assert.equal(schemas.JkMigrationIdentity.properties.sourceId.const,null);
  assert.equal(schemas.JkMigrationIdentity.properties.sourceId.readOnly,true);
  assert.equal(schemas.JkNativeCustomerImport.properties.sourceColumns.const,9);
  const reconciliation={ordersTotalCents:100,itemNetTotalCents:100,paymentsTotalCents:101,historicalOutstandingCents:-1,operationalWrites:Object.fromEntries(['orders','payments','cashMovements','invoices','fiscalDocuments','messages','stockMovements','commissions'].map(key=>[key,0]))};
  checkSchema(schemas.JkMigrationReport.properties.reconciliation,reconciliation,'rejected-preview.reconciliation');
});

test('new schemas distinguish pending access and provider-specific Pix inputs without secrets in responses',()=>{
  const pending={name:'Conta pendente',email:'pending-sdk@example.test',role:'operator',pendingPassword:true};
  checkSchema(schemas.CreateUserInput,pending);
  assert.throws(()=>checkSchema(schemas.CreateUserInput,{...pending,password:'should-not-be-allowed'}));
  assert.throws(()=>checkSchema(schemas.CreateUserInput,{...pending,pendingPassword:false}));
  checkSchema(schemas.CreateUserInput,{...pending,pendingPassword:false,password:'synthetic-password'});
  checkSchema(schemas.PrepareJkPixInput,{version:1,customerId:'cus_synthetic',dueDate:'2026-11-01'});
  checkSchema(schemas.PrepareJkPixInput,{version:1,expiresInSeconds:600});
  assert.throws(()=>checkSchema(schemas.PrepareJkPixInput,{version:1,customerId:'cus_synthetic',dueDate:'2026-11-01',expiresInSeconds:600}));
  assert.throws(()=>checkSchema(schemas.PrepareJkPixInput,{version:1,customerId:'cus_synthetic'}));
  assert.equal(schemas.User.required.includes('passwordSetupRequired'),false);
  assert.equal(schemas.JkIntegrationRecord.additionalProperties,false);
  assert.equal(schemas.JkIntegrationRecord.properties.evidence.additionalProperties,true);
  const webhook={id:'evt_synthetic',event:'PAYMENT_RECEIVED',account:{id:'11111111-2222-4333-8444-555555555555'},payment:{id:'pay_synthetic',billingType:'PIX',status:'RECEIVED',value:1.23}};
  checkSchema(schemas.AsaasWebhookPayload,webhook);
  assert.throws(()=>checkSchema(schemas.AsaasWebhookPayload,{...webhook,payment:{...webhook.payment,value:0}}));
});

test('real SQLite HTTP schemas cover domain, fiscal, team, pending access and TEF SDK operations', async (t) => {
  const fiscalCalls = [];
  const { client,app } = await fixture(t, {
    jkIntegrationsEnv:{},
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
  const archiveBody = { content: ARCHIVE_HEADERS.products.join(';') + '\nProduto sintético;Marca;Categoria;Consumo;2;1;1;un' };
  await call('getJkHistoryArchiveStatus', {query:{kind:'products'}});
  const archivePreview = await call('previewJkHistoryArchive', {body:archiveBody});
  await call('commitJkHistoryArchive', {body:{...archiveBody,previewHash:archivePreview.previewHash}});
  await call('getJkHistoryArchiveStatus', {query:{kind:'products'}});
  const archiveRows = await call('listJkHistoryArchiveRows', {query:{kind:'products',limit:25,offset:0}});
  assert.equal(archiveRows.items.length, 1);
  const tefCatalog = await call('getJkTefCatalog');
  const tefPlan = await call('getJkTefPlan');
  const prepared = await call('updateJkTefPlan', {body:{version:tefPlan.version,providers:[{providerId:tefCatalog.providers[0].id,terminalModel:'Sintético SDK',notes:''}]}});
  assert.equal(prepared.canSubmit,false);
  await call('getJkTefDiagnostics');
  assert.equal((await call('getJkMigrationStatus')).counts.customers,0);
  const nativeCustomers='\uFEFFNome;E-mail;Telefone;Situação da fatura;Data de vencimento;Valor da fatura;Veículos;Vagas;Observação\nPrimeiro cliente SDK;--;--;--;--;0;ABC1D23;--;Revisar proprietário\nSegundo cliente SDK;--;--;--;--;0;ABC1D23;--;Outra linha\nTerceiro cliente SDK;--;11999990000;--;--;0;XYZ9Z99;--;Linha com placa única';
  const nativeInput={source:'jumpcar',nativeCustomerMode:'customers-only',files:[{entity:'customers',format:'csv',content:nativeCustomers}]};
  const nativePreview=await call('previewJkMigration',{body:nativeInput});
  assert.equal(nativePreview.nativeCustomerImport.deferredVehicleEntries,3);assert.equal(nativePreview.counts.vehicles.insert,0);
  assert.ok(nativePreview.identityMap.every(row=>row.sourceId===null&&row.provenance==='snapshot-row'));
  const nativeCommitInput={body:{...nativeInput,previewHash:nativePreview.previewHash}},nativeOptions={idempotencyKey:'sdk-native-customers-replay'};
  const nativeResult=await call('commitJkMigration',nativeCommitInput,nativeOptions);assert.equal(nativeResult.status,'COMMITTED');
  assert.equal((await call('commitJkMigration',nativeCommitInput,nativeOptions)).status,'REPLAYED');
  const nativeHistory=await call('getJkMigrationHistory',{query:{entity:'sourceRows',limit:10,offset:0}});
  assert.equal(nativeHistory.items.length,3);assert.ok(nativeHistory.items.every(row=>Object.keys(row.dataJson).length===9));
  await call('getJkMigrationStatus');
  assert.equal((await call('getJkReconciliationStatus')).ready,false);
  const historyRow=ARCHIVE_HEADERS.orders.map(header=>({'Nº':'007','Cliente':'Terceiro cliente SDK','Telefone':'(11) 99999-0000','Placa':'XYZ9Z99','Data Entrada':'30/10/2026','Data Saída':'30/10/2026','Desconto':'0,00','Valor':'10,00','Pagamento':'Boleto'}[header]??''));
  const nativeOrders=[ARCHIVE_HEADERS.orders,historyRow,historyRow].map(row=>row.join(';')).join('\n');
  for(const content of [nativeCustomers,nativeOrders]){const p=await call('previewJkHistoryArchive',{body:{content}});await call('commitJkHistoryArchive',{body:{content,previewHash:p.previewHash}});}
  const reconciliation=await call('previewJkReconciliation',{body:{}});assert.equal(reconciliation.operationalWrites.vehicles,0);
  const reconciliationBody={previewHash:reconciliation.previewHash};
  await call('commitJkReconciliation',{body:reconciliationBody},{idempotencyKey:'sdk-reconciliation-replay'});
  assert.equal((await call('commitJkReconciliation',{body:reconciliationBody},{idempotencyKey:'sdk-reconciliation-replay'})).status,'REPLAYED');
  const candidate=(await call('listJkReconciliationVehicles',{query:{status:'awaiting_review',plate:'XYZ9Z99',limit:25,offset:0}})).items[0];assert.equal(candidate.category,null);assert.equal(candidate.sourceId,null);
  const documents=await call('listJkReconciliationHistory',{query:{customerId:candidate.customerId,plate:candidate.plate,status:'proposal',limit:25,offset:0}});assert.equal(documents.items.length,2);assert.notEqual(documents.items[0].id,documents.items[1].id);
  const review={vehicleReviews:[{vehicleRef:candidate.vehicleRef,category:'large',model:'Modelo sintético revisado',color:'Azul'}]},reviewPreview=await call('previewJkReconciliation',{body:review});
  assert.equal(reviewPreview.operationalWrites.vehicles,1);await call('commitJkReconciliation',{body:{...review,previewHash:reviewPreview.previewHash}});
  assert.equal((await call('listJkReconciliationVehicles',{query:{status:'promoted'}})).items[0].category,'large');
  assert.equal((await call('getJkReconciliationStatus')).counts.vehicles.promoted,1);
  assert.equal((await call('getJkSourceCatalogStatus')).status,'not_imported');
  const sourceSnapshot={schemaVersion:1,source:'jumpcar-ui',establishmentId:24453,observedAt:'2026-10-30T20:00:00Z',
    services:[{sourceRow:1,sourceId:null,name:'Serviço de origem sintético',category:'Grande',priceCents:5000,active:true,schedulingEnabled:false,durationMinutes:null,commissionBps:null,raw:{Preço:'50,00',Observado:true}}],
    products:[{sourceRow:1,sourceId:null,name:'Produto de origem sintético',sku:null,brand:null,category:null,application:null,unit:'L',unitsPerItem:'500,00',sourceQuantity:'10,00',sourceMinimumQuantity:null,priceCents:null,costCents:null,active:null,raw:{Quantidade:'10,00'}}],
    balances:[{sourceRow:1,sourceId:null,name:'Posição sintética',kind:'account',amountCents:-100,currency:'BRL',status:null,asOf:null,raw:{saldo:'-1,00'}}]};
  const sourcePreview=await call('previewJkSourceCatalog',{body:{snapshot:sourceSnapshot}});assert.equal(sourcePreview.operational,false);
  const sourceBody={snapshot:sourceSnapshot,previewHash:sourcePreview.previewHash};await call('commitJkSourceCatalog',{body:sourceBody},{idempotencyKey:'sdk-source-catalog-replay'});
  assert.equal((await call('commitJkSourceCatalog',{body:sourceBody},{idempotencyKey:'sdk-source-catalog-replay'})).status,'REPLAYED');
  assert.equal((await call('getJkSourceCatalogStatus')).totalSnapshots,1);
  for(const collection of ['services','products','balances']){const rows=await call('listJkSourceCatalogRows',{query:{collection,limit:25,offset:0,q:''}});assert.equal(rows.items.length,1);assert.equal(rows.items[0].sourceId,null);assert.equal(rows.items[0].provenance.collection,collection);}
  assert.equal((await call('getJkTeamStatus')).status,'not_imported');
  const team={source:'jumpcar-ui',establishmentId:24453,users:[{name:'Profissional SDK sintético',email:'team-employee-sdk@example.test',sourceRole:'Operador sintético',role:'operator',createEmployee:true},{name:'Conta SDK sintética',email:'team-account-sdk@example.test',phone:'11900000000',sourceRole:'Consulta sintética',role:'viewer',createEmployee:false}]};
  const teamPreview=await call('previewJkTeam',{body:team});
  const teamResult=await call('commitJkTeam',{body:{...team,previewHash:teamPreview.previewHash}});
  assert.equal(teamResult.accessEnabled,false);assert.equal(teamResult.payrollEnabled,false);
  assert.equal((await call('getJkTeamStatus')).status,'preserved_pending_activation');
  assert.equal((await app.store.prepare('SELECT active FROM employees WHERE id=?').get(teamResult.entries[0].employeeId)).active,0);
  const transition = await call('getJkTransition');
  const parallel = await call('updateJkTransition', {body:{mode:'parallel_readonly',version:transition.version}});
  assert.equal(parallel.authority,'jumpcar');
  await call('updateJkTransition', {body:{mode:'normal',version:parallel.version}});
  const { user } = await call('createUser', { body: { name: 'SDK Viewer', email: 'sdk-viewer-contract@example.test', password: 'test-sdk-contract-password', role: 'viewer' } });
  await call('updateUser', { path: { userId: user.id }, body: { name: 'Updated Viewer' } });
  await call('listUsers');
  const pending=(await call('createUser',{body:{name:'Acesso pendente SDK',email:'pending-contract-sdk@example.test',role:'viewer',pendingPassword:true}})).user;
  assert.equal(pending.active,false);assert.equal(pending.passwordSetupRequired,true);
  const initialInput={path:{userId:pending.id},body:{password:'synthetic-initial-sdk-password'}};
  const initialOptions={idempotencyKey:'sdk-initial-password-replay'};
  const activated=await call('setInitialUserPassword',initialInput,initialOptions);
  assert.equal(activated.user.active,true);assert.equal(activated.user.passwordSetupRequired,undefined);
  assert.deepEqual(await call('setInitialUserPassword',initialInput,initialOptions),activated);
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
  const expected=operations.filter(operation=>!jkIntegrationIds.includes(operation.operationId)).map(operation=>operation.operationId);
  assert.deepEqual([...seen].sort(),expected.sort(),'Every non-provider SDK operation must complete successfully and satisfy its schema');
  t.diagnostic(`${seen.size} distinct operations verified over HTTP/SQLite; the 12 provider bridge operations have a separate isolated fixture test.`);
});

test('all 12 JK provider bridge SDK operations and Asaas webhook use isolated HTTP fixtures',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'sdk-jk-contract-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const accountId='11111111-2222-4333-8444-555555555555';
  const webhookToken='sdk-fixture-webhook-token-with-more-than-32-characters';
  const configuration={version:1,integrations:[
    {kind:'pix-asaas',environment:'homologation',accountId,apiKeyFile:'unused-sdk-api.key',webhookTokenFile:'unused-sdk-webhook.key'},
    {kind:'whatsapp-baileys',environment:'production',accountPhone:'5511999999999',authDir:join(directory,'unused-auth'),templatesFile:'templates.json'},
  ]};
  await writeFile(join(directory,'configuration.json'),JSON.stringify(configuration),{mode:0o600});
  await writeFile(join(directory,'templates.json'),JSON.stringify([{name:'sdk_ready',languageCode:'pt_BR',text:'Ordem pronta.'}]),{mode:0o600});
  const providerCalls=[];
  const {client,app,baseUrl}=await fixture(t,{fiscalEnv:{},jkIntegrationsEnv:{AB_JK_SECRETS_ROOT:directory,AB_JK_INTEGRATIONS_CONFIG:'configuration.json',AB_JK_INTEGRATIONS_ENABLED:'true',AB_JK_ALLOW_PRODUCTION:'true',AB_JK_BAILEYS_CONNECT_ENABLED:'true',AB_JK_BAILEYS_SEND_ENABLED:'true'},
    jkIntegrationsOptions:{
      asaasConnectorFactory:async(db)=>({scope:'sdk-asaas-account',webhook:new AsaasWebhookReceiver({environment:'homologation',accountId,authToken:webhookToken},new AsyncAsaasWebhookInbox(db)),adapter:{async execute(operation,input){
        providerCalls.push(operation);
        return {state:'SUCCEEDED',providerReference:input.txid,data:{txid:input.txid,orderId:input.orderId,amountCents:input.amountCents,environment:'homologation',journalLinked:true,chargeStatus:'ATIVA',asaasPaymentId:'pay_sdkfixture',asaasPaymentStatus:'PENDING',
          ...(operation==='reconcile'?{evidenceSource:'authenticated-polling',observedAt:new Date().toISOString(),receiptStatus:'PENDING',receipts:[],receivedCents:0,refundedCents:0,paymentConfirmed:false}:{pixCopiaECola:'fixture-pix-code'})}};
      }}}),
      baileysAdapterFactory:async()=>({id:'whatsapp-baileys',accountScope:'sdk-baileys-account',async connect(){},async close(){},status(){return {provider:'whatsapp-baileys',connection:'connected',connectionVerified:true,sendEnabled:true,qrAvailable:false,reconnectAttempts:0,deliveryVerified:false};},async execute(operation){providerCalls.push(operation);return {state:'SUCCEEDED',providerReference:`baileys:3EB0${'A'.repeat(32)}`,data:{provider:'whatsapp-baileys',acceptance:'socket-accepted',delivery:'unconfirmed',localTemplate:true}};}}),
    },
  });
  const seen=new Set();
  async function call(id,input={}){
    const operation=operations.find(row=>row.operationId===id);assert.ok(operation);
    if(operation.body)checkSchema(operation.body,input.body,`${id}.request`);
    const output=await client.api[id](input);checkSchema(operation.response,output,`${id}.response`);seen.add(id);return output;
  }
  await client.api.setup({body:administrator});
  const customer=(await client.api.createCustomer({body:{name:'Cliente sintético da integração',phone:'11999999999'}})).item;
  const vehicle=(await client.api.createVehicle({body:{customerId:customer.id,plate:'SDK1B02',model:'Modelo sintético'}})).item;
  const service=(await client.api.createService({body:{name:'Serviço sintético integrado',priceCents:1999}})).item;
  const order=(await client.api.createOrder({body:{customerId:customer.id,vehicleId:vehicle.id,items:[{serviceId:service.id,quantity:1}]}})).item;
  const readiness=await call('getJkIntegrationReadiness');assert.equal(readiness.whatsapp.connectionVerified,true);assert.equal(readiness.whatsapp.capabilities.verifyDelivery,false);
  await call('getJkOrderFiscalSource',{path:{orderId:order.id}});
  await call('getJkOrderIntegrations',{path:{orderId:order.id}});
  const pixInput={path:{orderId:order.id},body:{version:order.version,customerId:'cus_sdkfixture',dueDate:'2026-11-01'}};
  let pix=(await call('prepareJkPix',pixInput)).item;
  await call('getJkPix',{path:{pixId:pix.id}});
  await call('cancelJkPix',{path:{pixId:pix.id},body:{version:pix.version}});
  pix=(await call('prepareJkPix',pixInput)).item;
  pix=(await call('submitJkPix',{path:{pixId:pix.id},body:{version:pix.version}})).item;
  assert.equal(pix.provider,'pix-asaas');assert.equal(pix.customerId,'cus_sdkfixture');
  pix=(await call('reconcileJkPix',{path:{pixId:pix.id},body:{version:pix.version}})).item;assert.equal(pix.status,'pending');assert.equal(pix.paymentConfirmed,false);
  const messageInput={path:{orderId:order.id},body:{version:order.version,templateName:'sdk_ready',languageCode:'pt_BR',bodyParameters:[],consentConfirmed:true}};
  let message=(await call('prepareJkMessage',messageInput)).item;
  await call('getJkMessage',{path:{messageId:message.id}});
  message=(await call('submitJkMessage',{path:{messageId:message.id},body:{version:message.version}})).item;
  assert.equal(message.status,'accepted');assert.equal(message.delivery,'unconfirmed');assert.equal(message.evidence.localTemplate,true);
  const cancelled=(await call('prepareJkMessage',messageInput)).item;
  await call('cancelJkMessage',{path:{messageId:cancelled.id},body:{version:cancelled.version}});
  await call('getJkOrderIntegrations',{path:{orderId:order.id}});
  assert.deepEqual([...seen].sort(),[...jkIntegrationIds].sort());
  assert.deepEqual(providerCalls,['create-charge','reconcile','send-template']);
  const payload={id:'evt_sdk&fixture',event:'PAYMENT_RECEIVED',account:{id:accountId,unknown:'accepted'},payment:{id:'pay_sdkfixture',externalReference:pix.providerReference,billingType:'PIX',status:'RECEIVED',value:19.99,unknown:'not-persisted'},unknown:'not-persisted'};
  checkSchema(schemas.AsaasWebhookPayload,payload);
  const endpoint=`${baseUrl}/api/jk/integrations/asaas/webhook`;
  const unauthenticated=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});assert.equal(unauthenticated.status,401);
  for(const duplicate of [false,true]){
    const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json','asaas-access-token':webhookToken},body:JSON.stringify(payload)});
    assert.equal(response.status,200);const data=await response.json();checkSchema(schemas.AsaasWebhookReceipt,data.data);assert.equal(data.data.duplicate,duplicate);
  }
  assert.equal((await app.store.prepare('SELECT COUNT(*) n FROM jk_asaas_webhook_events').get()).n,1);
  assert.equal((await app.store.prepare('SELECT COUNT(*) n FROM payments').get()).n,0);
  assert.equal(JSON.stringify(await app.store.prepare('SELECT * FROM jk_asaas_webhook_events').all()).includes('not-persisted'),false);
  t.diagnostic('12/12 JK bridge operations and cookie-free authenticated webhook verified locally. All provider I/O is injected fixture code.');
});
