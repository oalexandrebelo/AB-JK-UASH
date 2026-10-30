import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fiscalFixture } from './fiscal-helpers.mjs';
import { createAsaasConnector } from '../integrations/jk/asaas-config.mjs';
import { createBaileysAdapter } from '../integrations/jk/baileys.mjs';
import { TransportError } from '../integrations/jk/vendor/connectors/transport.mjs';

const accountId='11111111-2222-4333-8444-555555555555';
const webhookToken='fixture-webhook-token-more-than-32-characters';
const json=(body,status=200)=>({status,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify(body))});
async function configuration(t,{kind='pix-asaas',environment='homologation'}={}) {
  const directory=await mkdtemp(join(tmpdir(),'jk-provider-api-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const entry=kind==='pix-asaas' ? {kind,environment,accountId,apiKeyFile:'api-key',webhookTokenFile:'webhook-token'}
    : {kind,environment:'production',accountPhone:'5511999999999',authDir:join(directory,'auth'),templatesFile:'templates.json'};
  await writeFile(join(directory,'config.json'),JSON.stringify({version:1,integrations:[entry]}),{mode:0o600});
  await writeFile(join(directory,'api-key'),'fixture-api-key-not-a-real-credential',{mode:0o600});
  await writeFile(join(directory,'webhook-token'),webhookToken,{mode:0o600});
  await writeFile(join(directory,'templates.json'),JSON.stringify([{templateName:'os_ready',languageCode:'pt_BR',text:'OS {{1}} pronta.'}]),{mode:0o600});
  const env={AB_JK_SECRETS_ROOT:directory,AB_JK_INTEGRATIONS_CONFIG:'config.json',AB_JK_INTEGRATIONS_ENABLED:'true',
    ...(environment==='production'||kind==='whatsapp-baileys' ? {AB_JK_ALLOW_PRODUCTION:'true'} : {}),
    ...(kind==='whatsapp-baileys' ? {AB_JK_BAILEYS_CONNECT_ENABLED:'true',AB_JK_BAILEYS_SEND_ENABLED:'true'} : {})};
  return {env,entry};
}
function asaasFactory(provider) {
  return async(...args)=>{
    const connector=await createAsaasConnector(...args);
    connector.transport.request=async request=>{
      provider.calls.push({method:request.method,url:request.url});const url=new URL(request.url);
      if(request.method==='POST') {
        const body=JSON.parse(request.body);provider.payment={...body,id:'pay_fixture',status:'PENDING',deleted:false,pixTransaction:null,refunds:null};
        if(provider.failPost)throw new TransportError('DEADLINE_EXCEEDED','UNKNOWN');
        return json(provider.payment);
      }
      if(url.pathname.endsWith('/pixQrCode'))return json({payload:'000201-fixture-code',expirationDate:'2026-11-01 23:59:59'});
      if(url.pathname==='/v3/payments')return json({data:provider.payment?[provider.payment]:[],hasMore:false,totalCount:provider.payment?1:0});
      if(url.pathname.startsWith('/v3/pix/transactions/'))return json({id:'11111111-1111-4111-8111-111111111111',payment:'pay_fixture',type:'CREDIT',status:'DONE',value:provider.payment.value,
        refundedValue:0,endToEndIdentifier:provider.e2e,effectiveDate:provider.receivedAt});
      throw new Error('unexpected fixture route');
    };
    provider.connector=connector;return connector;
  };
}
const provider=()=>({calls:[],e2e:`E${randomUUID().replaceAll('-','').slice(0,31)}`});
function received(p) {Object.assign(p.payment,{status:'RECEIVED',pixTransaction:'11111111-1111-4111-8111-111111111111'});p.receivedAt=new Date(Date.now()-1000).toISOString();}
const prepareBody=order=>({version:order.version,customerId:'cus_fixture',dueDate:'2026-11-01'});
function webhook(p,id='evt_fixture') {return {id,event:'PAYMENT_RECEIVED',account:{id:accountId},payment:{...p.payment}};}
const webhookPath='/jk/integrations/asaas/webhook';
const callbackOptions=body=>({method:'POST',body,headers:{cookie:'','x-csrf-token':'','asaas-access-token':webhookToken}});

// Real loopback HTTP + SQLite + adapter code. Asaas HTTP and Baileys sockets are fixtures.
test('Asaas HTTP sandbox flow preserves customer review and never settles real cash',async t=>{
  const c=await configuration(t);const p=provider();const f=await fiscalFixture(t,{jkIntegrationsEnv:c.env,jkIntegrationsOptions:{asaasConnectorFactory:asaasFactory(p)}});
  const order=await f.order();const base=`/jk/orders/${order.id}/pix`;
  await f.call(base,{method:'POST',body:{version:order.version},status:422});
  await f.call(base,{method:'POST',body:{...prepareBody(order),dueDate:'2026-02-30'},status:422});
  await f.call(base,{method:'POST',body:{...prepareBody(order),expiresInSeconds:3600},status:422});
  const prepared=(await f.call(base,{method:'POST',body:prepareBody(order),status:201})).data.item;
  assert.equal(prepared.customerId,'cus_fixture');assert.equal(prepared.dueDate,'2026-11-01');assert.equal(p.calls.length,0);
  const active=(await f.call(`/jk/pix/${prepared.id}/submit`,{method:'POST',body:{version:prepared.version}})).data.item;
  assert.equal(active.status,'active');assert.equal(active.evidence.asaasPaymentId,'pay_fixture');assert.equal(active.evidence.asaasPaymentStatus,'PENDING');
  received(p);const confirmed=(await f.call(`/jk/pix/${active.id}/reconcile`,{method:'POST',body:{version:active.version}})).data.item;
  assert.equal(confirmed.status,'test_confirmed');assert.equal(confirmed.paymentConfirmed,false);assert.equal(confirmed.paymentId,null);
  assert.equal((await f.app.store.prepare('SELECT count(*) AS n FROM payments').get()).n,0);
  assert.equal((await f.app.store.prepare('SELECT count(*) AS n FROM cash_movements').get()).n,0);
});

test('Asaas HTTP production fixture settles once only after authenticated polling with E2E evidence',async t=>{
  const c=await configuration(t,{environment:'production'});const p=provider();const f=await fiscalFixture(t,{jkIntegrationsEnv:c.env,jkIntegrationsOptions:{asaasConnectorFactory:asaasFactory(p)}});
  const order=await f.order();const prepared=(await f.call(`/jk/orders/${order.id}/pix`,{method:'POST',body:prepareBody(order),status:201})).data.item;
  const active=(await f.call(`/jk/pix/${prepared.id}/submit`,{method:'POST',body:{version:prepared.version}})).data.item;
  received(p);
  const callback=await f.call(webhookPath,callbackOptions(webhook(p)));assert.equal(callback.data.received,true);
  const duplicate=await f.call(webhookPath,callbackOptions(webhook(p)));assert.equal(duplicate.data.duplicate,true);
  assert.equal((await f.app.store.prepare('SELECT count(*) AS n FROM payments').get()).n,0);
  const settled=(await f.call(`/jk/pix/${active.id}/reconcile`,{method:'POST',body:{version:active.version}})).data.item;
  assert.equal(settled.status,'settled');assert.equal(settled.paymentConfirmed,true);assert.ok(settled.paymentId);
  await f.call(`/jk/pix/${settled.id}/reconcile`,{method:'POST',body:{version:settled.version}});
  for(const table of ['payments','cash_movements','payment_allocations'])assert.equal((await f.app.store.prepare(`SELECT count(*) AS n FROM ${table}`).get()).n,1);
  assert.equal(p.calls.filter(call=>call.method==='POST').length,1);
  assert.equal((await f.app.store.prepare('SELECT count(*) AS n FROM jk_asaas_webhook_events').get()).n,1);
});

test('Asaas HTTP uncertain submit cannot be sent again and recovers using safe reads',async t=>{
  const c=await configuration(t);const p=provider();p.failPost=true;
  const f=await fiscalFixture(t,{jkIntegrationsEnv:c.env,jkIntegrationsOptions:{asaasConnectorFactory:asaasFactory(p)}});const order=await f.order();
  const prepared=(await f.call(`/jk/orders/${order.id}/pix`,{method:'POST',body:prepareBody(order),status:201})).data.item;
  const uncertain=(await f.call(`/jk/pix/${prepared.id}/submit`,{method:'POST',body:{version:prepared.version},status:202})).data.item;
  assert.equal(uncertain.status,'uncertain');
  await f.call(`/jk/pix/${uncertain.id}/submit`,{method:'POST',body:{version:uncertain.version},status:409});
  received(p);assert.equal((await f.call(`/jk/pix/${uncertain.id}/reconcile`,{method:'POST',body:{version:uncertain.version}})).data.item.status,'test_confirmed');
  assert.equal(p.calls.filter(call=>call.method==='POST').length,1);
});

test('public Asaas webhook rejects forged notifications and does not bypass parallel read-only business gates',async t=>{
  const c=await configuration(t);const p=provider();const f=await fiscalFixture(t,{jkIntegrationsEnv:c.env,jkIntegrationsOptions:{asaasConnectorFactory:asaasFactory(p)}});const order=await f.order();
  const event={id:'evt_parallel',event:'PAYMENT_RECEIVED',account:{id:accountId},payment:{id:'pay_fixture',billingType:'PIX',status:'RECEIVED',value:123.45,externalReference:'1234567890abcdef1234567890abcdef'}};
  await f.call(webhookPath,{...callbackOptions(event),headers:{cookie:'','x-csrf-token':'','asaas-access-token':'forged'},status:401});
  await f.call(webhookPath,{...callbackOptions({...event,account:{id:'99999999-2222-4333-8444-555555555555'}}),status:403});
  await f.call('/jk/transition',{method:'PATCH',body:{mode:'parallel_readonly',version:0}});
  const denied=await f.call(`/jk/orders/${order.id}/pix`,{method:'POST',body:prepareBody(order),status:409});assert.equal(denied.error.code,'PARALLEL_READONLY');
  assert.equal((await f.call(webhookPath,callbackOptions(event))).data.received,true);
  assert.equal((await f.app.store.prepare('SELECT count(*) AS n FROM payments').get()).n,0);assert.equal(p.calls.length,0);
  await f.call(webhookPath,{...callbackOptions({...event,payload:'x'.repeat(256*1024)}),status:413});
});

function baileysFactory(state) {
  return async(settings,{env})=>{
    const ev=new EventEmitter();
    const socket={ev,user:{id:`${settings.accountPhone}:1@s.whatsapp.net`},async sendMessage(jid,message,options){state.sends.push({jid,message});return {key:{id:options.messageId}};},end(){state.closed++;}};
    state.ev=ev;
    const sdk={default:()=>socket,initAuthCreds:()=>({registered:true}),BufferJSON:{replacer:(_key,value)=>value,reviver:(_key,value)=>value},proto:{Message:{AppStateSyncKeyData:{fromObject:value=>value}}}};
    const adapter=await createBaileysAdapter(settings,{env,loadBaileys:async()=>sdk});state.adapter=adapter;return adapter;
  };
}

test('Baileys HTTP sends a reviewed local template once, records socket acceptance and blocks after disconnect',async t=>{
  const c=await configuration(t,{kind:'whatsapp-baileys'});const state={sends:[],closed:0};
  const f=await fiscalFixture(t,{jkIntegrationsEnv:c.env,jkIntegrationsOptions:{baileysAdapterFactory:baileysFactory(state)}});const order=await f.order();
  await f.app.store.prepare('UPDATE customers SET phone=? WHERE id=?').run('11999999999',order.customerId);
  assert.equal((await f.call('/jk/integrations/readiness')).data.whatsapp.state,'blocked');
  state.ev.emit('connection.update',{connection:'open'});await new Promise(setImmediate);
  assert.equal((await f.call('/jk/integrations/readiness')).data.whatsapp.state,'ready');
  const body={version:order.version,templateName:'os_ready',languageCode:'pt_BR',bodyParameters:['1'],consentConfirmed:true};
  const prepared=(await f.call(`/jk/orders/${order.id}/messages`,{method:'POST',body,status:201})).data.item;
  const key=randomUUID();const accepted=(await f.call(`/jk/messages/${prepared.id}/submit`,{method:'POST',key,body:{version:prepared.version}})).data.item;
  assert.equal(accepted.status,'accepted');assert.match(accepted.providerReference,/^baileys:3EB0[A-F0-9]{32}$/u);
  assert.equal(accepted.evidence.acceptance,'socket-accepted');assert.equal(accepted.delivery,'unconfirmed');assert.equal(accepted.evidence.localTemplate,true);
  await f.call(`/jk/messages/${prepared.id}/submit`,{method:'POST',key,body:{version:prepared.version}});assert.equal(state.sends.length,1);
  assert.equal(state.sends[0].message.text,'OS 1 pronta.');
  const second=(await f.call(`/jk/orders/${order.id}/messages`,{method:'POST',body,status:201})).data.item;
  state.ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:401}}}});await new Promise(setImmediate);
  assert.equal((await f.call('/jk/integrations/readiness')).data.whatsapp.connection,'reauth-required');
  await f.call(`/jk/messages/${second.id}/submit`,{method:'POST',body:{version:second.version},status:409});assert.equal(state.sends.length,1);
  assert.equal((await f.app.store.prepare('SELECT count(*) AS n FROM payments').get()).n,0);
});
