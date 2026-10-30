import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, sqliteStore } from '../server/db.mjs';
import { TransportError } from '../integrations/jk/vendor/connectors/transport.mjs';
import { AsaasBookingGateway, createAsaasBookingGateway, initializeBookingPix } from '../integrations/jk/booking-pix.mjs';

const config={enabled:true,environment:'homologation',accountId:'11111111-2222-4333-8444-555555555555',apiKey:'synthetic-key',dateTimeOffset:'-03:00'};
const customerInput={name:'Pagador Sintetico',cpfCnpj:'12345678909'};
const request={bookingId:'booking-fixture',identityId:'identity-fixture',phone:'+5511999999999',customerInput,amountCents:12029,dueDate:'2026-10-31',idempotencyKey:'booking-request-fixture'};
const context=()=>({signal:new AbortController().signal});
const response=(body,status=200)=>({status,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify(body))});
function fixture(t,overrides={}) {
  const raw=openDatabase(':memory:');
  raw.exec(`CREATE TABLE jk_booking_identities(id TEXT PRIMARY KEY,phone TEXT,verified_at TEXT);
    CREATE TABLE jk_booking_reservations(id TEXT PRIMARY KEY,identity_id TEXT,amount_cents INTEGER,account_scope TEXT,status TEXT,hold_expires_at TEXT);
    CREATE TABLE orders(id TEXT PRIMARY KEY); CREATE TABLE payments(id TEXT PRIMARY KEY); CREATE TABLE cash_movements(id TEXT PRIMARY KEY);`);
  initializeBookingPix(raw); const db=sqliteStore(raw);t.after(()=>db.close());
  const provider={calls:[],customers:[],payments:[],customerError:null,paymentError:null,customerStatus:200,
    transaction:{id:'transaction-fixture',payment:'pay_fixture',type:'CREDIT',status:'DONE',value:120.29,refundedValue:0,endToEndIdentifier:`E${'1'.repeat(31)}`,effectiveDate:'2026-10-30 10:00:00'}};
  const transport={async request(req) {
    provider.calls.push(req); const url=new URL(req.url);
    if(url.pathname==='/v3/customers'&&req.method==='GET')return response({data:provider.customers,totalCount:provider.customers.length,hasMore:false});
    if(url.pathname==='/v3/customers'&&req.method==='POST') {
      provider.customers.push({id:'cus_fixture',...JSON.parse(req.body),deleted:false});
      if(provider.customerError)throw provider.customerError;
      return response(provider.customers[0],provider.customerStatus);
    }
    if(url.pathname==='/v3/payments'&&req.method==='POST') {
      provider.payments.push({id:'pay_fixture',...JSON.parse(req.body),deleted:false,status:'PENDING',refunds:null,pixTransaction:null});
      if(provider.paymentError)throw provider.paymentError;
      return response(provider.payments[0]);
    }
    if(url.pathname==='/v3/payments')return response({data:provider.payments,totalCount:provider.payments.length,hasMore:false});
    if(url.pathname.endsWith('/pixQrCode'))return response({payload:'000201-synthetic-pix',expirationDate:'2027-10-31 23:59:59'});
    if(url.pathname.startsWith('/v3/pix/transactions/'))return response(provider.transaction);
    throw new Error('unexpected synthetic request');
  }};
  const gateway=new AsaasBookingGateway({...config,...overrides},transport,db);
  raw.prepare('INSERT INTO jk_booking_identities VALUES(?,?,?)').run(request.identityId,request.phone,'2026-10-30T12:00:00Z');
  raw.prepare('INSERT INTO jk_booking_reservations VALUES(?,?,?,?,?,?)').run(request.bookingId,request.identityId,request.amountCents,gateway.scope,'awaiting_payment',new Date(Date.now()+3600000).toISOString());
  const create=(patch={})=>gateway.create({...request,...patch},context());
  const reconcile=async()=>gateway.reconcile({bookingId:request.bookingId,txid:provider.payments[0]?.externalReference,amountCents:request.amountCents,start:'2026-10-30T12:00:00Z',end:'2026-10-30T14:00:00Z',idempotencyKey:'reconcile-fixture'},context());
  return{raw,db,provider,transport,gateway,create,reconcile};
}

// All transports below are local synthetic fixtures; no account is contacted.
test('creates customer through official fields then charge, without writing operational finance',async t=>{
  const f=fixture(t),result=await f.create();assert.equal(result.state,'SUCCEEDED');
  assert.equal(result.data.bookingId,request.bookingId);assert.equal(result.data.orderId,undefined);assert.equal(result.data.paymentConfirmed,false);
  assert.equal(result.data.pixExpirationDate,'2027-10-31 23:59:59');assert.equal(result.data.scope,f.gateway.scope);
  const post=f.provider.calls.find(c=>c.method==='POST'&&c.url.endsWith('/customers'));
  assert.deepEqual(JSON.parse(post.body),{...customerInput,externalReference:f.provider.customers[0].externalReference,notificationDisabled:true});
  assert.equal(post.retry,'never');assert.equal(post.timeoutMs,20000);assert.equal(post.headers.access_token,config.apiKey);
  assert.ok(!f.provider.customers[0].externalReference.includes(request.phone));assert.ok(!f.provider.customers[0].externalReference.includes(customerInput.cpfCnpj));
  for(const table of ['orders','payments','cash_movements'])assert.equal(f.raw.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
  const stored=JSON.stringify(f.raw.prepare('SELECT * FROM jk_booking_asaas_customers').all());
  assert.ok(!stored.includes(customerInput.cpfCnpj));assert.ok(!stored.includes(customerInput.name));
});

test('replay and restart recover customer and charge without duplicate POST',async t=>{
  const f=fixture(t);await f.create();
  const gateway=new AsaasBookingGateway(config,f.transport,f.db);
  assert.equal((await gateway.create(request,context())).state,'SUCCEEDED');
  assert.equal(f.provider.calls.filter(c=>c.method==='POST').length,2);
});

test('concurrent customer and charge reservations allow only one POST per resource',async t=>{
  const f=fixture(t);await Promise.all([f.create(),f.create(),f.create()]);
  assert.equal(f.provider.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/customers')).length,1);
  assert.equal(f.provider.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/payments')).length,1);
});

test('unknown customer POST is recovered by externalReference without blind retry',async t=>{
  const f=fixture(t);f.provider.customerError=new TransportError('TIMEOUT','UNKNOWN');
  assert.equal((await f.create()).state,'UNKNOWN');assert.equal(f.provider.payments.length,0);
  f.provider.customerError=null;assert.equal((await f.create()).state,'SUCCEEDED');
  assert.equal(f.provider.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/customers')).length,1);
});

test('empty lookup after uncertain customer emission never creates another customer',async t=>{
  const f=fixture(t);f.provider.customerError=new TransportError('TIMEOUT','UNKNOWN');await f.create();f.provider.customers=[];
  const result=await f.create();assert.equal(result.state,'UNKNOWN');assert.equal(result.data.errorCode,'CUSTOMER_REFERENCE_UNRESOLVED');
  assert.equal(f.provider.calls.filter(c=>c.method==='POST').length,1);
});

test('duplicate customer lookup and changed provider fields fail closed',async t=>{
  const f=fixture(t);await f.create();f.provider.customers.push({...f.provider.customers[0],id:'cus_duplicate'});
  assert.equal((await f.create()).data.errorCode,'DUPLICATE_CUSTOMER_REFERENCE');f.provider.customers.pop();
  f.provider.customers[0].cpfCnpj='98765432100';assert.equal((await f.create()).data.errorCode,'CUSTOMER_RESPONSE_MISMATCH');
});

test('changed identity data does not silently overwrite or create a new provider customer',async t=>{
  const f=fixture(t);await f.create();const before=f.provider.calls.length;
  assert.equal((await f.create({customerInput:{...customerInput,name:'Outro Nome'}})).data.errorCode,'CUSTOMER_IDENTITY_CONFLICT');
  assert.equal(f.provider.calls.length,before);
});

test('disabled configuration and forged input reject before provider access',async t=>{
  const f=fixture(t,{enabled:false});assert.equal((await f.create()).data.errorCode,'BOOKING_PIX_DISABLED');assert.equal(f.provider.calls.length,0);
  const g=fixture(t);
  for(const patch of [{customerId:'cus_from_browser'},{amountCents:1.2},{dueDate:'2026-02-30'},{identityId:'other'},
    {phone:'+5511000000000'},{expectedScope:'wrong'},{customerInput:{name:'x',cpfCnpj:'11111111111'}},{customerInput:{...customerInput,customerId:'cus_forced'}}]) {
    assert.equal((await g.create(patch)).state,'REJECTED');
  }
  assert.equal(g.provider.calls.length,0);
});

test('unverified identity, expired hold and changed amount never issue payment',async t=>{
  const f=fixture(t);f.raw.prepare('UPDATE jk_booking_identities SET verified_at=NULL').run();
  assert.equal((await f.create()).data.errorCode,'IDENTITY_NOT_VERIFIED');
  f.raw.prepare('UPDATE jk_booking_identities SET verified_at=?').run('2026-10-30T12:00:00Z');
  assert.equal((await f.create({amountCents:1})).data.errorCode,'BOOKING_MISMATCH');
  f.raw.prepare('UPDATE jk_booking_reservations SET hold_expires_at=?').run('2000-01-01T00:00:00Z');
  assert.equal((await f.create()).data.errorCode,'BOOKING_NOT_PAYABLE');assert.equal(f.provider.calls.length,0);
});

test('CPF and numeric/alphanumeric CNPJ validation reuse the existing validator',async t=>{
  for(const cpfCnpj of ['12345678909','11222333000181','12ABC34501DE35']) {
    const f=fixture(t);assert.equal((await f.create({customerInput:{...customerInput,cpfCnpj}})).state,'SUCCEEDED');
  }
  for(const cpfCnpj of ['12345678900','11222333000180','12ABC34501DE36']) {
    const f=fixture(t);assert.equal((await f.create({customerInput:{...customerInput,cpfCnpj}})).state,'REJECTED');assert.equal(f.provider.calls.length,0);
  }
});

test('unknown payment POST uses existing adapter recovery and one booking cannot issue a second charge',async t=>{
  const f=fixture(t);f.provider.paymentError=new TransportError('TIMEOUT','UNKNOWN');assert.equal((await f.create()).state,'UNKNOWN');
  f.provider.paymentError=null;assert.equal((await f.create()).state,'SUCCEEDED');
  assert.equal((await f.create({idempotencyKey:'different-key'})).data.errorCode,'IDEMPOTENCY_CONFLICT');
  assert.equal(f.provider.payments.length,1);
});

test('authenticated receipt evidence preserves actual adapter statuses and sandbox label',async t=>{
  const f=fixture(t);await f.create();Object.assign(f.provider.payments[0],{status:'RECEIVED',pixTransaction:f.provider.transaction.id});
  const result=await f.reconcile();assert.equal(result.state,'SUCCEEDED');
  assert.equal(result.data.asaasPaymentStatus,'RECEIVED');assert.equal(result.data.chargeStatus,'CONCLUIDA');
  assert.equal(result.data.receiptStatus,'CONFIRMED');assert.equal(result.data.paymentConfirmed,true);assert.equal(result.data.environment,'homologation');
  assert.equal(result.data.evidenceSource,'authenticated-polling');assert.equal(result.data.receipts[0].endToEndId,f.provider.transaction.endToEndIdentifier);
  assert.match(result.data.evidenceHash,/^[a-f0-9]{64}$/u);
});

test('late payment is still observable but gateway never confirms the expired booking itself',async t=>{
  const f=fixture(t);await f.create();f.raw.prepare("UPDATE jk_booking_reservations SET status='expired'").run();
  Object.assign(f.provider.payments[0],{status:'RECEIVED',pixTransaction:f.provider.transaction.id});
  assert.equal((await f.reconcile()).data.paymentConfirmed,true);
  assert.equal(f.raw.prepare('SELECT status FROM jk_booking_reservations').get().status,'expired');
});

test('CONFIRMED without settled Pix and refunded receipts never confirm',async t=>{
  const f=fixture(t);await f.create();Object.assign(f.provider.payments[0],{status:'CONFIRMED',pixTransaction:f.provider.transaction.id});
  assert.equal((await f.reconcile()).data.paymentConfirmed,false);
  f.provider.payments[0].status='RECEIVED';f.provider.transaction.refundedValue=1;assert.equal((await f.reconcile()).data.paymentConfirmed,false);
});

test('key rotation blocks new emission for the old booking scope',async t=>{
  const f=fixture(t);await f.create();const before=f.provider.calls.length;
  const gateway=new AsaasBookingGateway({...config,apiKey:'rotated-synthetic-key'},f.transport,f.db);
  assert.equal((await gateway.create(request,context())).data.errorCode,'BOOKING_MISMATCH');assert.equal(f.provider.calls.length,before);
});

test('production requires explicit opt-in and is never confused with homologation',async t=>{
  const f=fixture(t);assert.throws(()=>new AsaasBookingGateway({...config,environment:'production'},f.transport,f.db),{code:'PRODUCTION_NOT_ENABLED'});
  const g=fixture(t,{environment:'production',allowProduction:true});assert.equal((await g.create()).data.environment,'production');
  assert.ok(g.provider.calls.every(c=>new URL(c.url).hostname==='api.asaas.com'));
});

test('failed initial lookup can recover before its first POST, while malformed responses never emit',async t=>{
  const f=fixture(t),original=f.transport.request;let failed=false;
  f.transport.request=async req=>{if(!failed){failed=true;throw new TransportError('TIMEOUT','UNKNOWN');}return original(req);};
  assert.equal((await f.create()).state,'UNKNOWN');assert.equal((await f.create()).state,'SUCCEEDED');
  assert.equal(f.provider.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/customers')).length,1);
  const g=fixture(t);g.transport.request=async()=>response({data:[],totalCount:1,hasMore:false});
  assert.equal((await g.create()).data.errorCode,'INVALID_CUSTOMER_RESPONSE');assert.equal(g.provider.payments.length,0);
});

test('unexpected successful customer status is uncertain and never triggers another POST',async t=>{
  const f=fixture(t);f.provider.customerStatus=201;assert.equal((await f.create()).state,'UNKNOWN');
  assert.equal((await f.create()).state,'SUCCEEDED');assert.equal(f.provider.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/customers')).length,1);
});

test('injected booking clock is shared with reservation decisions and default remains real time',async t=>{
  const f=fixture(t,{now:()=>Date.parse('2026-10-30T12:00:00Z')});
  f.raw.prepare('UPDATE jk_booking_reservations SET hold_expires_at=?').run('2026-10-30T12:05:00Z');
  assert.equal((await f.create()).state,'SUCCEEDED');
  const gateway=new AsaasBookingGateway({...config,now:()=>Date.parse('2026-10-30T12:06:00Z')},f.transport,f.db);
  assert.equal((await gateway.create(request,context())).data.errorCode,'BOOKING_NOT_PAYABLE');
});

test('real factory reads separate private credentials without dispatch or automatic migration',async t=>{
  const f=fixture(t),directory=await mkdtemp(join(tmpdir(),'jk-booking-credentials-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  await writeFile(join(directory,'api'),config.apiKey,{mode:0o600});await writeFile(join(directory,'webhook'),'synthetic-distinct-webhook-token',{mode:0o600});
  const entry={kind:'pix-asaas',environment:config.environment,accountId:config.accountId,apiKeyFile:'api',webhookTokenFile:'webhook'};
  await assert.rejects(()=>createAsaasBookingGateway(f.db,entry,{secretsRoot:directory}),{code:'BOOKING_PIX_DISABLED'});
  const gateway=await createAsaasBookingGateway(f.db,entry,{secretsRoot:directory,enabled:true});assert.equal(gateway.enabled,true);assert.equal(gateway.scope,f.gateway.scope);
  assert.equal(f.raw.prepare('SELECT count(*) n FROM jk_booking_pix_journal').get().n,0);
  await writeFile(join(directory,'webhook'),config.apiKey,{mode:0o600});
  await assert.rejects(()=>createAsaasBookingGateway(f.db,entry,{secretsRoot:directory,enabled:true}),{code:'INVALID_CONFIGURATION'});
});
