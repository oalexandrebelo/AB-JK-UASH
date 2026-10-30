import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, sqliteStore } from '../server/db.mjs';
import { AsaasWebhookReceiver, AsyncAsaasWebhookInbox, ASAAS_WEBHOOK_SCHEMA } from '../integrations/jk/asaas-webhook.mjs';

const config={environment:'homologation',accountId:'11111111-2222-4333-8444-555555555555',authToken:'fixture-webhook-token-more-than-32-characters'};
const event={id:'evt_fixture&123456',event:'PAYMENT_RECEIVED',account:{id:config.accountId},payment:{id:'pay_fixture',
  externalReference:'1234567890abcdef1234567890abcdef',billingType:'PIX',status:'RECEIVED',value:120.29}};
const request=(payload=event,overrides={})=>({method:'POST',headers:{'content-type':'application/json','asaas-access-token':config.authToken},
  body:Buffer.from(JSON.stringify(payload)),...overrides});
function fixture(t,withSchema=true) {
  const raw=openDatabase(':memory:');if(withSchema) raw.exec(ASAAS_WEBHOOK_SCHEMA);
  const db=sqliteStore(raw);t.after(()=>db.close());const inbox=new AsyncAsaasWebhookInbox(db);
  const receiver=new AsaasWebhookReceiver(config,inbox);return {db,inbox,receiver};
}

test('webhook requires a separate strong token and explicit account/environment',()=>{
  for(const patch of [{authToken:'short'},{authToken:'token with spaces longer than 32 characters'},{accountId:'invalid'}, {environment:'sandbox'}])
    assert.throws(()=>new AsaasWebhookReceiver({...config,...patch},{persist(){}}),{code:'INVALID_CONFIGURATION'});
});

test('authenticated webhook persists only a sanitized reconciliation hint before HTTP 200',async t=>{
  const f=fixture(t);const result=await f.receiver.accept(request({...event,customerPII:'private-customer',payment:{...event.payment,customerName:'private-person'}}));
  assert.equal(result.status,200);assert.equal(result.data.received,true);assert.equal(result.data.duplicate,false);
  const rows=await f.inbox.pending(f.receiver.scope);assert.equal(rows.length,1);assert.equal(rows[0].txid,event.payment.externalReference);assert.equal(rows[0].paymentReference,event.payment.id);
  const persisted=JSON.stringify(await f.db.prepare('SELECT * FROM jk_asaas_webhook_events').all());
  assert.ok(!persisted.includes('private-customer'));assert.ok(!persisted.includes('private-person'));assert.ok(!persisted.includes(config.authToken));
  assert.equal((await f.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('payments','cash_movements')").get()).n,0);
});

test('duplicate and concurrent webhook delivery is idempotent across receiver restart',async t=>{
  const f=fixture(t);const results=await Promise.all([f.receiver.accept(request()),f.receiver.accept(request()),f.receiver.accept(request())]);
  assert.equal(results.filter(result=>!result.data.duplicate).length,1);
  const restarted=new AsaasWebhookReceiver(config,new AsyncAsaasWebhookInbox(f.db));
  assert.equal((await restarted.accept(request())).data.duplicate,true);assert.equal((await f.inbox.pending(f.receiver.scope)).length,1);
  await f.inbox.complete(f.receiver.scope,event.id);assert.equal((await f.inbox.pending(f.receiver.scope)).length,0);
  assert.equal((await restarted.accept(request())).data.duplicate,true);
});

test('same event ID with changed business fields is rejected without overwriting evidence',async t=>{
  const f=fixture(t);await f.receiver.accept(request());
  await assert.rejects(f.receiver.accept(request({...event,payment:{...event.payment,value:999}})),{code:'WEBHOOK_REPLAY_CONFLICT',status:409});
  assert.equal((await f.inbox.pending(f.receiver.scope))[0].amountCents,12029);
});

test('invalid, missing, duplicate or array authentication headers are rejected before persistence',async t=>{
  const f=fixture(t);
  for(const headers of [{'content-type':'application/json'}, {'content-type':'application/json','asaas-access-token':'bad'},
    {'content-type':'application/json','asaas-access-token':[config.authToken]},
    {'content-type':'application/json','asaas-access-token':config.authToken,'Asaas-Access-Token':config.authToken}])
    await assert.rejects(f.receiver.accept(request(event,{headers})),{code:'WEBHOOK_UNAUTHORIZED',status:401});
  assert.equal((await f.inbox.pending(f.receiver.scope)).length,0);
});

test('wrong account, unsupported method, bad JSON, oversized/compressed/non-JSON bodies fail closed',async t=>{
  const f=fixture(t);
  const requests=[request({...event,account:{id:'99999999-2222-4333-8444-555555555555'}}),request(event,{method:'GET'}),request(event,{body:Buffer.from('{bad json')}),
    request(event,{body:Buffer.alloc(256*1024+1)}),request(event,{body:Buffer.from([0xff])}),
    request(event,{headers:{...request().headers,'content-encoding':'gzip'}}),request(event,{headers:{...request().headers,'content-type':'text/plain'}}),
    request({...event,id:'evt_bad\nheader'}),request({...event,payment:{...event.payment,value:1.001}})];
  for(const req of requests) await assert.rejects(f.receiver.accept(req));
  assert.equal((await f.inbox.pending(f.receiver.scope)).length,0);
});

test('future payment event names are accepted and queued after durable receipt',async t=>{
  const f=fixture(t);
  const unknown=await f.receiver.accept(request({...event,event:'PAYMENT_NEW_FUTURE_EVENT',newField:{anything:true}}));assert.equal(unknown.status,200);
  assert.equal((await f.inbox.pending(f.receiver.scope)).length,1);
  assert.equal((await f.inbox.pending(f.receiver.scope))[0].event,'PAYMENT_NEW_FUTURE_EVENT');
});

test('webhook token rotation preserves replay scope while environment/account stay separated',async t=>{
  const f=fixture(t);await f.receiver.accept(request());
  const rotated=new AsaasWebhookReceiver({...config,authToken:'another-fixture-token-with-more-than-32-characters'},f.inbox);
  assert.equal(rotated.scope,f.receiver.scope);
  assert.equal((await rotated.accept(request(event,{headers:{...request().headers,'asaas-access-token':'another-fixture-token-with-more-than-32-characters'}}))).data.duplicate,true);
  const production=new AsaasWebhookReceiver({...config,environment:'production'},f.inbox);assert.notEqual(production.scope,f.receiver.scope);
});

test('schema or storage failure never acknowledges an unpersisted webhook',async t=>{
  const f=fixture(t,false);await assert.rejects(f.receiver.accept(request()),{code:'WEBHOOK_STORAGE_UNAVAILABLE',status:503});
});

test('unrelated account payments are durably ignored without poisoning the Asaas delivery queue',async t=>{
  const f=fixture(t);
  for(const [index,patch] of [{externalReference:'external-invoice-123'},{externalReference:null},{billingType:'BOLETO'}].entries()) {
    const result=await f.receiver.accept(request({...event,id:`evt_unrelated${index}`,payment:{...event.payment,...patch}}));
    assert.equal(result.status,200);assert.equal(result.data.ignored,true);
  }
  assert.equal((await f.inbox.pending(f.receiver.scope)).length,0);
  const rows=await f.db.prepare('SELECT * FROM jk_asaas_webhook_events').all();assert.equal(rows.length,3);assert.ok(rows.every(row=>row.ignored===1));
  assert.ok(!JSON.stringify(rows).includes('external-invoice-123'));
});
