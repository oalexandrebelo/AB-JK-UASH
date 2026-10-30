import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, sqliteStore } from '../server/db.mjs';
import { AsyncPixChargeJournal } from '../integrations/jk/journal.mjs';
import { SecureHttpTransport, TransportError } from '../integrations/jk/vendor/connectors/transport.mjs';
import { AsaasPixAdapter, asaasAllowedHosts } from '../integrations/jk/asaas.mjs';
import { createAsaasConnector, parseAsaasConfiguration } from '../integrations/jk/asaas-config.mjs';

const accountId = '11111111-2222-4333-8444-555555555555';
const config = { environment:'homologation', accountId, apiKey:'fixture-api-key-not-a-credential', dateTimeOffset:'-03:00' };
const input = { txid:'1234567890abcdef1234567890abcdef', orderId:'order-fixture', amountCents:12029,
  customerId:'cus_fixture', dueDate:'2026-10-31', description:'OS de teste sintética' };
const period = { start:'2026-10-30T12:00:00Z', end:'2026-10-30T14:00:00Z' };
const context = () => ({ idempotencyKey:'fixture-idempotency-key', signal:new AbortController().signal });
const response = (value,status=200) => ({status, headers:{'content-type':'application/json; charset=utf-8'}, body:Buffer.from(JSON.stringify(value))});
function fixture(t, overrides={}) {
  const raw=openDatabase(':memory:');
  raw.exec('CREATE TABLE orders(id TEXT PRIMARY KEY); INSERT INTO orders(id) VALUES(\'order-fixture\'); CREATE TABLE jk_pix_journal(scope TEXT,txid TEXT,fingerprint TEXT,amount_cents INTEGER,order_id TEXT REFERENCES orders(id),created_at TEXT,PRIMARY KEY(scope,txid));');
  const db=sqliteStore(raw); t.after(()=>db.close());
  const provider={calls:[],payments:[],postError:null,postStatus:200,transaction:{id:'11111111-1111-4111-8111-111111111111',
    payment:'pay_fixture',type:'CREDIT',status:'DONE',value:120.29,refundedValue:0,endToEndIdentifier:`E${'1'.repeat(31)}`,effectiveDate:'2026-10-30 10:00:00'}};
  const transport={async request(request) {
    provider.calls.push(request);
    const url=new URL(request.url);
    if (request.method==='POST') {
      const body=JSON.parse(request.body);
      provider.payments.push({id:'pay_fixture',...body,status:'PENDING',deleted:false,refunds:null,pixTransaction:null,originalValue:null});
      if (provider.postError) throw provider.postError;
      return response(provider.payments.at(-1),provider.postStatus);
    }
    if (url.pathname.endsWith('/pixQrCode')) return response({payload:'000201-fixture-code',expirationDate:'2026-10-31 23:59:59',encodedImage:'Zml4dHVyZQ=='});
    if (url.pathname.includes('/pix/transactions/')) return response(provider.transaction);
    if (url.pathname==='/v3/payments') return response({data:provider.payments,hasMore:false,totalCount:provider.payments.length,offset:0,limit:2});
    if (url.pathname==='/v3/payments/pay_fixture') return response(provider.payments[0]);
    throw new Error('unexpected mock request');
  }};
  const journal=new AsyncPixChargeJournal(db);
  const adapter=new AsaasPixAdapter({...config,...overrides},transport,journal);
  const create=()=>adapter.execute('create-charge',{...input},context());
  const reconcile=()=>adapter.execute('reconcile',{txid:input.txid,orderId:input.orderId,amountCents:input.amountCents,...period},context());
  return {db,journal,transport,provider,adapter,create,reconcile};
}

// All HTTP responses in this file are local fixtures. No Asaas account is contacted.
test('Asaas environments require explicit selection and production opt-in',()=>{
  const journal={reserve(){},find(){}},transport={request(){}};
  for (const environment of [undefined,'sandbox','test','PRODUCTION']) assert.throws(()=>new AsaasPixAdapter({...config,environment},transport,journal),{code:'INVALID_CONFIGURATION'});
  assert.throws(()=>new AsaasPixAdapter({...config,environment:'production'},transport,journal),{code:'PRODUCTION_NOT_ENABLED'});
  assert.deepEqual(asaasAllowedHosts('homologation'),['api-sandbox.asaas.com']);
  assert.deepEqual(asaasAllowedHosts('production'),['api.asaas.com']);
  assert.throws(()=>asaasAllowedHosts('test'),{code:'INVALID_CONFIGURATION'});
});

test('create uses documented Asaas fields, private header, bounded timeout and no automatic POST retry',async t=>{
  const f=fixture(t);const result=await f.create();
  assert.equal(result.state,'SUCCEEDED');assert.equal(result.providerReference,input.txid);
  assert.equal(result.data.asaasPaymentId,'pay_fixture');assert.equal(result.data.paymentConfirmed,false);
  assert.equal(result.data.pixCopiaECola,'000201-fixture-code');assert.equal(result.data.journalLinked,true);
  const post=f.provider.calls[0];
  assert.equal(post.url,'https://api-sandbox.asaas.com/v3/payments');assert.equal(post.method,'POST');assert.equal(post.retry,'never');assert.equal(post.timeoutMs,20_000);
  assert.equal(post.headers.access_token,config.apiKey);assert.equal(post.headers['user-agent'],'AB-JK-UASH/0.2.0');
  assert.equal(post.headers.authorization,undefined);assert.equal(post.headers['idempotency-key'],undefined);
  assert.deepEqual(JSON.parse(post.body),{customer:input.customerId,billingType:'PIX',value:120.29,dueDate:input.dueDate,externalReference:input.txid,description:input.description});
  assert.equal(f.provider.calls[1].retry,'safe-read');
});

test('production requests use only the production host when explicitly enabled',async t=>{
  const f=fixture(t,{environment:'production',allowProduction:true});assert.equal((await f.create()).state,'SUCCEEDED');
  assert.ok(f.provider.calls.every(call=>new URL(call.url).hostname==='api.asaas.com'));
});

test('unsupported expiry and invalid amounts/customer/date fail before journal or provider I/O',async t=>{
  const f=fixture(t);
  for (const patch of [{expiresInSeconds:3600},{amountCents:1.2},{amountCents:0},{amountCents:1_000_000_001},{customerId:'cus_x/../../x'},
    {dueDate:'2026-02-30'},{dueDate:'2026-13-01'},{dueDate:'2026-10-31T00:00:00Z'},{description:'bad\nvalue'},{orderId:''}]) {
    const result=await f.adapter.execute('create-charge',{...input,...patch},context());assert.equal(result.state,'REJECTED');assert.equal(result.data.errorCode,'INVALID_INPUT');
  }
  assert.equal(f.provider.calls.length,0);assert.equal((await f.db.prepare('SELECT count(*) AS n FROM jk_pix_journal').get()).n,0);
});

test('journal prevents duplicate POSTs across retries and adapter restart',async t=>{
  const f=fixture(t);assert.equal((await f.create()).state,'SUCCEEDED');
  const restarted=new AsaasPixAdapter(config,f.transport,new AsyncPixChargeJournal(f.db));
  const result=await restarted.execute('create-charge',input,context());
  assert.equal(result.state,'SUCCEEDED');assert.equal(result.data.replayed,true);assert.equal(f.provider.calls.filter(call=>call.method==='POST').length,1);
  const lookup=f.provider.calls.find(call=>call.method==='GET'&&new URL(call.url).pathname==='/v3/payments');
  assert.equal(new URL(lookup.url).searchParams.get('externalReference'),input.txid);assert.equal(new URL(lookup.url).searchParams.get('limit'),'2');
});

test('uncertain POST is recovered through lookup without resubmission',async t=>{
  const f=fixture(t);f.provider.postError=new TransportError('DEADLINE_EXCEEDED','UNKNOWN');
  assert.equal((await f.create()).state,'UNKNOWN');
  assert.equal((await f.create()).state,'SUCCEEDED');assert.equal(f.provider.calls.filter(call=>call.method==='POST').length,1);
});

test('empty or duplicate provider lookup never authorizes another POST',async t=>{
  const f=fixture(t);await f.create();
  f.provider.payments=[];const missing=await f.create();assert.equal(missing.state,'UNKNOWN');assert.equal(missing.data.errorCode,'PROVIDER_REFERENCE_UNRESOLVED');
  f.provider.payments=[{id:'pay_a'},{id:'pay_b'}];const duplicate=await f.create();assert.equal(duplicate.state,'UNKNOWN');assert.equal(duplicate.data.errorCode,'DUPLICATE_PROVIDER_REFERENCE');
  assert.equal(f.provider.calls.filter(call=>call.method==='POST').length,1);
});

test('concurrent retries reserve only one mutation',async t=>{
  const f=fixture(t);const results=await Promise.all([f.create(),f.create(),f.create()]);
  assert.ok(results.every(result=>['SUCCEEDED','UNKNOWN'].includes(result.state)));
  assert.equal(f.provider.calls.filter(call=>call.method==='POST').length,1);
});

test('idempotency conflicts and changed returned customer/dueDate/description are rejected',async t=>{
  const f=fixture(t);await f.create();const count=f.provider.calls.length;
  for(const patch of [{customerId:'cus_other'},{dueDate:'2026-11-01'},{description:'alterada'},{amountCents:12030}]) {
    const result=await f.adapter.execute('create-charge',{...input,...patch},context());assert.equal(result.data.errorCode,'IDEMPOTENCY_CONFLICT');assert.equal(result.state,'REJECTED');
  }
  assert.equal(f.provider.calls.length,count);
  for(const [key,value] of [['customer','cus_other'],['dueDate','2026-11-01'],['description','alterada']]) {
    const original=f.provider.payments[0][key];f.provider.payments[0][key]=value;
    const result=await f.reconcile();assert.equal(result.state,'UNKNOWN');assert.equal(result.data.errorCode,'RESPONSE_MISMATCH');f.provider.payments[0][key]=original;
  }
});

test('changed credentials separate the journal and cannot reconcile prior reservations',async t=>{
  const f=fixture(t);await f.create();const changed=new AsaasPixAdapter({...config,apiKey:'another-fixture-key'},f.transport,f.journal);
  assert.notEqual(changed.scope,f.adapter.scope);
  const count=f.provider.calls.length;const result=await changed.execute('get-charge',{txid:input.txid,orderId:input.orderId,amountCents:input.amountCents},context());
  assert.equal(result.state,'REJECTED');assert.equal(result.data.errorCode,'JOURNAL_NOT_LINKED');assert.equal(f.provider.calls.length,count);
});

test('aborted requests and unavailable durable journal never reach the provider',async t=>{
  const f=fixture(t);const controller=new AbortController();controller.abort();
  assert.equal((await f.adapter.execute('create-charge',input,{...context(),signal:controller.signal})).state,'REJECTED');
  const broken=new AsaasPixAdapter(config,f.transport,new AsyncPixChargeJournal({prepare(){throw new Error('private journal details');}}));
  const result=await broken.execute('create-charge',input,context());assert.equal(result.state,'REJECTED');assert.equal(result.data.errorCode,'JOURNAL_UNAVAILABLE');
  assert.equal(f.provider.calls.length,0);assert.ok(!JSON.stringify(result).includes('private'));
});

test('untrusted HTTP responses and provider errors expose only safe codes',async t=>{
  for (const bad of [response({errors:[{description:'private-secret-value'}]},500),response({errors:[{description:'private-secret-value'}]},400),
    {status:200,headers:{'content-type':'text/html'},body:Buffer.from('private-secret-value')},
    {status:200,headers:{'content-type':'application/json'},body:Buffer.from([0xff])},response({unexpected:'private-secret-value'})]) {
    const f=fixture(t);f.transport.request=async request=>{f.provider.calls.push(request);return bad;};
    const result=await f.create();assert.notEqual(result.state,'SUCCEEDED');assert.equal(result.data.paymentConfirmed,false);assert.ok(!JSON.stringify(result).includes('private-secret-value'));
    assert.equal(f.provider.calls.length,1);
  }
});

test('reconciliation verifies charge, Pix transaction, E2E, money and period before confirming',async t=>{
  const f=fixture(t,{environment:'production',allowProduction:true});await f.create();
  Object.assign(f.provider.payments[0],{status:'RECEIVED',pixTransaction:f.provider.transaction.id});
  const result=await f.reconcile();assert.equal(result.state,'SUCCEEDED');assert.equal(result.data.receiptStatus,'CONFIRMED');assert.equal(result.data.paymentConfirmed,true);
  assert.equal(result.data.receivedCents,12029);assert.equal(result.data.chargeStatus,'CONCLUIDA');assert.equal(result.data.evidenceSource,'authenticated-polling');
  assert.deepEqual(result.data.receipts,[{endToEndId:`E${'1'.repeat(31)}`,amountCents:12029,receivedAt:'2026-10-30T13:00:00.000Z',refundedCents:0,refundPending:false}]);
  assert.ok(f.provider.calls.every(call=>call.method==='POST'||call.retry==='safe-read'));
});

test('sandbox evidence stays explicitly marked and never writes payments or cash',async t=>{
  const f=fixture(t);await f.create();Object.assign(f.provider.payments[0],{status:'RECEIVED',pixTransaction:f.provider.transaction.id});
  const result=await f.reconcile();assert.equal(result.data.environment,'homologation');assert.equal(result.data.receiptStatus,'CONFIRMED');
  assert.equal((await f.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('payments','cash_movements')").get()).n,0);
});

test('CONFIRMED, missing Pix/E2E, refunds and pending refunds never confirm payment',async t=>{
  for(const variant of ['confirmed','missing-transaction','missing-e2e','refunded','pending-refund','cash','deleted']) {
    const f=fixture(t);await f.create();const charge=f.provider.payments[0];Object.assign(charge,{status:'RECEIVED',pixTransaction:f.provider.transaction.id});
    if(variant==='confirmed') charge.status='CONFIRMED';
    if(variant==='missing-transaction') charge.pixTransaction=null;
    if(variant==='missing-e2e') f.provider.transaction.endToEndIdentifier=null;
    if(variant==='refunded') {f.provider.transaction.refundedValue=1;charge.refunds=[{status:'DONE',value:1}];}
    if(variant==='pending-refund') charge.refunds=[{status:'PENDING',value:1}];
    if(variant==='cash') charge.billingType='RECEIVED_IN_CASH';
    if(variant==='deleted') charge.deleted=true;
    const result=await f.reconcile();assert.equal(result.data.paymentConfirmed,false,variant);assert.notEqual(result.data.receiptStatus,'CONFIRMED',variant);
  }
});

test('mismatched Pix transaction, unsafe precision and out-of-window dates fail closed',async t=>{
  for(const patch of [{payment:'pay_unrelated'},{type:'DEBIT'},{status:'REQUESTED'},{value:120.291},{value:120.30},{effectiveDate:'2026-10-29 10:00:00'},
    {endToEndIdentifier:'E-unsafe'}, {effectiveDate:'2026-02-30 10:00:00'}]) {
    const f=fixture(t);await f.create();Object.assign(f.provider.payments[0],{status:'RECEIVED',pixTransaction:f.provider.transaction.id});Object.assign(f.provider.transaction,patch);
    const result=await f.reconcile();assert.equal(result.data.paymentConfirmed,false,JSON.stringify(patch));assert.notEqual(result.data.receiptStatus,'CONFIRMED');
  }
});

test('timezone-free provider timestamps require an explicit operator offset',async t=>{
  const f=fixture(t,{dateTimeOffset:undefined});await f.create();Object.assign(f.provider.payments[0],{status:'RECEIVED',pixTransaction:f.provider.transaction.id});
  const unzoned=await f.reconcile();assert.equal(unzoned.data.paymentConfirmed,false);assert.equal(unzoned.data.receiptStatus,'REVIEW');
  f.provider.transaction.effectiveDate='2026-10-30T13:00:00Z';assert.equal((await f.reconcile()).data.receiptStatus,'CONFIRMED');
});

test('factory reads private secret references without contacting Asaas',async t=>{
  const f=fixture(t);const root=await mkdtemp(join(tmpdir(),'jk-asaas-secrets-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'api-key'),`${config.apiKey}\n`,{mode:0o600});
  await writeFile(join(root,'webhook-token'),'fixture-webhook-token-with-at-least-32-characters',{mode:0o600});
  const entry={kind:'pix-asaas',environment:'homologation',accountId,apiKeyFile:'api-key',webhookTokenFile:'webhook-token',dateTimeOffset:'-03:00'};
  const created=await createAsaasConnector(f.db,entry,{secretsRoot:root});
  assert.ok(created.adapter instanceof AsaasPixAdapter);assert.ok(created.transport instanceof SecureHttpTransport);assert.equal(created.scope,created.adapter.scope);assert.ok(created.webhook);
  for(const patch of [{apiKey:'inline-secret'},{baseUrl:'https://evil.example'},{environment:'sandbox'},{accountId:'not-account'},{dateTimeOffset:'+14:30'}])
    assert.throws(()=>parseAsaasConfiguration({...entry,...patch}),{code:'INVALID_CONFIGURATION'});
  await chmod(join(root,'api-key'),0o644);await assert.rejects(createAsaasConnector(f.db,entry,{secretsRoot:root}),{code:'SECRET_FILE_PERMISSIONS'});
});

test('failure fetching QR after an accepted POST remains uncertain and cannot reopen emission',async t=>{
  for(const failure of [new TransportError('NETWORK_ERROR','NOT_SENT'),response({errors:[]},400)]) {
    const f=fixture(t);const original=f.transport.request;
    f.transport.request=async request=>{
      if(request.url.endsWith('/pixQrCode')) {if(failure instanceof Error) throw failure;return failure;}
      return original(request);
    };
    const result=await f.create();assert.equal(result.state,'UNKNOWN');assert.equal(result.data.paymentConfirmed,false);
    await f.create();assert.equal(f.provider.calls.filter(call=>call.method==='POST').length,1);
  }
});

test('failed recovery reads cannot classify a previous possibly sent emission as rejected',async t=>{
  const f=fixture(t);await f.create();f.transport.request=async()=>{throw new TransportError('CIRCUIT_OPEN','NOT_SENT');};
  assert.equal((await f.create()).state,'UNKNOWN');
});

test('refund evidence on a nominally pending charge requires review',async t=>{
  const f=fixture(t);await f.create();f.provider.payments[0].refunds=[{status:'PENDING',value:1}];
  const result=await f.reconcile();assert.equal(result.data.receiptStatus,'REVIEW');assert.equal(result.data.paymentConfirmed,false);
});
