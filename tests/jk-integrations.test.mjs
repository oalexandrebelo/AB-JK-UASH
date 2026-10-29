import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, sqliteStore, transaction } from '../server/db.mjs';
import { migrateDomain, migrateStorage } from '../server/domain-schema.mjs';
import { createSession, readSession, sessionCookie } from '../server/security.mjs';
import { orderBalance, receive, touchOrder } from '../server/domain-core.mjs';
import { migrateJkIntegrations, initializeJkIntegrations, handleJkIntegrations } from '../server/jk-integrations.mjs';
import { initializeFiscal } from '../server/fiscal.mjs';
import { PixBankingAdapter } from '../integrations/jk/vendor/connectors/banking/index.mjs';
import { WhatsAppCloudAdapter } from '../integrations/jk/vendor/connectors/messaging/whatsapp.mjs';
import { AsyncPixChargeJournal } from '../integrations/jk/journal.mjs';
import { parseJkConfiguration } from '../integrations/jk/runtime.mjs';

const e2e = () => `E${randomUUID().replaceAll('-','').slice(0,31)}`;
const decimal = cents => `${Math.floor(cents/100)}.${String(cents%100).padStart(2,'0')}`;
function json(body,status=200) { return {status,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify(body))}; }

async function fixture(t) {
  const raw = openDatabase(':memory:'); migrateDomain(raw); migrateStorage(raw); migrateJkIntegrations(raw);
  const db = sqliteStore(raw); t.after(()=>db.close());
  const now = new Date().toISOString();
  await db.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('admin-test','Admin Teste','integration@example.test','unused-hash','admin',now,now);
  const issued = await createSession(db,'admin-test');
  const session = await readSession(db,{headers:{cookie:sessionCookie(issued.token).split(';')[0]}});
  await db.prepare('INSERT INTO customers(id,name,phone,kind,postpaid,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('customer-test','Cliente Teste','(11) 99999-9999','individual',0,now,now);
  await db.prepare('INSERT INTO vehicles(id,customer_id,plate,model,category,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('vehicle-test','customer-test','JKT1A23','Veículo Teste','small',now,now);
  await db.prepare('INSERT INTO orders(id,number,customer_id,vehicle_id,status,subtotal_cents,discount_cents,total_cents,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('order-test',1,'customer-test','vehicle-test','waiting',12000,0,12000,now,now);
  const runtime = await initializeJkIntegrations(db,{env:{}});
  const fiscal = await initializeFiscal(db,{env:{}});
  async function call(path,{method='GET',body,key=randomUUID()}={}) {
    const request = Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
    request.headers = {'content-type':'application/json','idempotency-key':key};
    const url = new URL(`http://local.invalid/api/jk${path}`);
    const run = ()=>handleJkIntegrations({db,session,request,method,pathname:url.pathname,url,jkIntegrations:runtime,fiscal});
    return method==='GET' ? db.read(run) : run();
  }
  const prepare = (key=randomUUID()) => call('/orders/order-test/pix',{method:'POST',body:{version:1},key});
  const submit = item => call(`/pix/${item.id}/submit`,{method:'POST',body:{version:item.version}});
  const reconcile = (item,key=randomUUID()) => call(`/pix/${item.id}/reconcile`,{method:'POST',body:{version:item.version},key});
  const item = async id => (await call(`/pix/${id}`)).data.item;
  return {raw,db,runtime,session,call,prepare,submit,reconcile,item};
}

function pixProvider(f,environment='production') {
  const key = '01234567-89ab-cdef-0123-456789abcdef';
  const provider = {calls:[],receipts:[],status:'ATIVA',failCreate:false,txid:null,expiration:3600,delay:null};
  const transport = { async request(request) {
    provider.calls.push({method:request.method,url:request.url});
    const url = new URL(request.url);
    if (url.pathname.endsWith('/oauth/token')) return json({access_token:'fixture-access-token',token_type:'Bearer',expires_in:3600});
    if (url.pathname.includes('/cob/')) {
      const txid = url.pathname.split('/').at(-1);
      if (request.method === 'PUT') {
        provider.txid=txid;
        provider.expiration=JSON.parse(request.body).calendario.expiracao;
        if (provider.failCreate) throw new Error('fixture-timeout-after-bank-accepted');
        if (provider.delay) await provider.delay;
      }
      return json({txid,valor:{original:'120.00',modalidadeAlteracao:0},chave:key,status:provider.status,revisao:0,
        calendario:{criacao:new Date().toISOString(),expiracao:provider.expiration},pixCopiaECola:'000201-fixture-pix-code'},request.method==='PUT'?201:200);
    }
    if (url.pathname.endsWith('/pix')) return json({parametros:{inicio:url.searchParams.get('inicio'),fim:url.searchParams.get('fim'),
      paginacao:{paginaAtual:0,itensPorPagina:100,quantidadeDePaginas:provider.receipts.length?1:0,quantidadeTotalDeItens:provider.receipts.length}},
      pix:provider.receipts.map(item=>({txid:provider.txid,chave:key,endToEndId:item.id,valor:decimal(item.amount),horario:item.at,...(item.refunds?{devolucoes:item.refunds}:{})}))});
    throw new Error('unexpected fixture request');
  }};
  const adapter = new PixBankingAdapter({provider:'efi',environment,clientId:'fixture-client',clientSecret:'fixture-secret',pixKey:key,mtls:{pfx:Buffer.from('fixture-only')}},transport,new AsyncPixChargeJournal(f.db));
  Object.assign(f.runtime.channels.pix,{state:'ready',configured:true,provider:'pix-efi',environment,blockers:[]});
  f.runtime.adapters.set('pix',adapter); f.runtime.scopes.set('pix','fixture-account-scope');
  provider.receive = (amount=12000,id=e2e()) => {provider.status='CONCLUIDA';provider.receipts=[{id,amount,at:new Date().toISOString()}];return id;};
  return provider;
}

test('readiness is blocked without secrets; preparation is local, bound to order and idempotent',async t=>{
  const f=await fixture(t);
  const readiness=(await f.call('/integrations/readiness')).data;
  assert.equal(readiness.pix.state,'blocked');assert.equal(readiness.whatsapp.state,'blocked');assert.equal(readiness.fiscal.state,'blocked');
  assert.equal(readiness.rules.homologationNeverSettles,true);
  const key=randomUUID(); const created=await f.prepare(key); const replay=await f.prepare(key);
  assert.equal(created.status,201);assert.equal(created.data.item.amountCents,12000);assert.equal(replay.data.item.id,created.data.item.id);
  assert.equal(replay.headers['Idempotency-Replayed'],'true');
  await assert.rejects(f.call('/orders/order-test/pix',{method:'POST',key,body:{version:1,expiresInSeconds:900}}),{code:'IDEMPOTENCY_CONFLICT'});
  await assert.rejects(f.submit(created.data.item),{code:'INTEGRATION_BLOCKED'});
  assert.equal((await f.item(created.data.item.id)).attemptCount,0);
  await assert.rejects(f.prepare(),{code:'PIX_CHARGE_EXISTS'});
  assert.equal((await f.call('/orders/order-test/integrations')).data.pixCharges.length,1);
  assert.equal((await f.call('/orders/order-test/fiscal-source')).data.taxReviewRequired,true);
});

test('authenticated Pix receipt settles once across different idempotency keys and records core allocations plus cash evidence',async t=>{
  const f=await fixture(t);const provider=pixProvider(f);
  const created=(await f.prepare()).data.item;const sent=(await f.submit(created)).data.item;
  assert.equal(sent.status,'active');assert.equal(sent.paymentConfirmed,false);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM payments').get()).count,0);
  const receiptId=provider.receive();const key=randomUUID();const settled=(await f.reconcile(sent,key)).data.item;
  assert.equal(settled.status,'settled');assert.equal(settled.paymentConfirmed,true);assert.ok(settled.paymentId);
  assert.equal((await orderBalance(f.db,'order-test')).balanceCents,0);
  const calls=provider.calls.length;await f.reconcile(sent,key);assert.equal(provider.calls.length,calls);
  await f.reconcile(settled);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM payments').get()).count,1);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM payment_allocations').get()).count,1);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM cash_movements').get()).count,1);
  assert.equal((await f.db.prepare('SELECT payment_id FROM jk_pix_receipts WHERE end_to_end_id=?').get(receiptId)).payment_id,settled.paymentId);
  assert.equal(provider.calls.filter(call=>call.method==='PUT').length,1);
});

test('homologation receipts never settle the real order',async t=>{
  const f=await fixture(t);const provider=pixProvider(f,'homologation');
  const sent=(await f.submit((await f.prepare()).data.item)).data.item;provider.receive();
  const result=(await f.reconcile(sent)).data.item;
  assert.equal(result.status,'test_confirmed');assert.equal(result.paymentConfirmed,false);assert.equal(result.paymentId,null);
  assert.equal((await orderBalance(f.db,'order-test')).balanceCents,12000);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM payments').get()).count,0);
});

test('uncertain submit cannot be repeated; authenticated GET reconciliation recovers without another PUT',async t=>{
  const f=await fixture(t);const provider=pixProvider(f);provider.failCreate=true;
  const created=(await f.prepare()).data.item;const key=randomUUID();
  const result=(await f.call(`/pix/${created.id}/submit`,{method:'POST',key,body:{version:created.version}})).data.item;
  assert.equal(result.status,'uncertain');assert.equal(result.reconciliationRequired,true);
  await f.call(`/pix/${created.id}/submit`,{method:'POST',key,body:{version:created.version}});
  await assert.rejects(f.submit(result),{code:'INTEGRATION_ALREADY_SUBMITTED'});
  await assert.rejects(f.call(`/pix/${created.id}/cancel`,{method:'POST',body:{version:result.version}}),{code:'INTEGRATION_CANNOT_CANCEL'});
  provider.receive();assert.equal((await f.reconcile(result)).data.item.status,'settled');
  assert.equal(provider.calls.filter(call=>call.method==='PUT').length,1);
});

test('stale prepared order is blocked before provider I/O and may be cancelled locally',async t=>{
  const f=await fixture(t);const provider=pixProvider(f);const created=(await f.prepare()).data.item;
  await f.db.prepare('UPDATE orders SET version=version+1 WHERE id=?').run('order-test');
  await assert.rejects(f.submit(created),{code:'INTEGRATION_ORDER_CHANGED'});assert.equal(provider.calls.length,0);
  const cancelled=await f.call(`/pix/${created.id}/cancel`,{method:'POST',body:{version:created.version}});
  assert.equal(cancelled.data.item.status,'cancelled');
});

test('manual payment racing a bank receipt enters review without overpayment',async t=>{
  const f=await fixture(t);const provider=pixProvider(f);const sent=(await f.submit((await f.prepare()).data.item)).data.item;
  await transaction(f.db,async()=>{
    const id=await receive(f.db,{source:'order',sourceId:'order-test',customerId:'customer-test',amountCents:12000,method:'pix',reference:'manual fixture'});
    await f.db.prepare('INSERT INTO payment_allocations(payment_id,order_id,amount_cents) VALUES(?,?,?)').run(id,'order-test',12000);
    await touchOrder(f.db,'order-test');
  });
  provider.receive();const result=(await f.reconcile(sent)).data.item;
  assert.equal(result.status,'review');assert.equal(result.lastErrorCode,'PIX_BALANCE_REQUIRES_REVIEW');assert.equal(result.paymentConfirmed,false);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM payments').get()).count,1);
});

test('payment allocation failure rolls back every financial side effect and remains reconcilable',async t=>{
  const f=await fixture(t);const provider=pixProvider(f);const sent=(await f.submit((await f.prepare()).data.item)).data.item;
  provider.receive();
  await f.db.exec("CREATE TRIGGER jk_test_allocation_failure BEFORE INSERT ON payment_allocations BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
  await assert.rejects(f.reconcile(sent));
  for(const table of ['payments','payment_allocations','cash_movements','jk_pix_receipts']) assert.equal((await f.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).count,0);
  await f.db.exec('DROP TRIGGER jk_test_allocation_failure;');
  await f.db.prepare('UPDATE jk_integration_records SET lease_expires_at=? WHERE id=?').run(Date.now()-1,sent.id);
  const recovered=(await f.reconcile(await f.item(sent.id))).data.item;
  assert.equal(recovered.status,'settled');assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM payments').get()).count,1);
});

test('partial, refunded and reused receipts cannot create a new payment',async t=>{
  const f=await fixture(t);const provider=pixProvider(f);let item=(await f.submit((await f.prepare()).data.item)).data.item;
  provider.receive(5000);provider.status='ATIVA';item=(await f.reconcile(item)).data.item;assert.equal(item.status,'partial');
  const receiptId=provider.receive();provider.receipts[0].refunds=[{id:'r1',valor:'10.00',status:'DEVOLVIDO'}];
  item=(await f.reconcile(item)).data.item;assert.equal(item.status,'review');
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM payments').get()).count,0);
  provider.receipts[0].refunds=undefined;
  // A receipt identity bound to another local charge is never reused for settlement.
  await f.db.prepare('UPDATE jk_pix_receipts SET amount_cents=11999 WHERE end_to_end_id=?').run(receiptId);
  item=(await f.reconcile(item)).data.item;assert.equal(item.lastErrorCode,'PIX_RECEIPT_ALREADY_LINKED');
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM payments').get()).count,0);
});

test('expired lease is recovered by query and late submit completion cannot overwrite newer evidence',async t=>{
  const f=await fixture(t);const provider=pixProvider(f);let release;
  provider.delay=new Promise(resolve=>{release=resolve;});const created=(await f.prepare()).data.item;
  const pending=f.submit(created);
  for(let n=0;n<100 && !provider.txid;n++) await new Promise(resolve=>setImmediate(resolve));
  assert.ok(provider.txid);
  await f.db.prepare('UPDATE jk_integration_records SET lease_expires_at=? WHERE id=?').run(Date.now()-1,created.id);
  const stale=await f.item(created.id);assert.equal(stale.status,'uncertain');provider.receive();
  const settled=(await f.reconcile(stale)).data.item;assert.equal(settled.status,'settled');
  release();await pending;
  assert.equal((await f.item(created.id)).status,'settled');assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM payments').get()).count,1);
});

test('account/environment drift and revoked roles block submission or reconciliation',async t=>{
  const f=await fixture(t);pixProvider(f);const sent=(await f.submit((await f.prepare()).data.item)).data.item;
  f.runtime.scopes.set('pix','another-account');await assert.rejects(f.reconcile(sent),{code:'INTEGRATION_PROVIDER_CHANGED'});
  await f.db.prepare("UPDATE users SET role='viewer' WHERE id=?").run('admin-test');
  await assert.rejects(f.reconcile(sent),{code:'FORBIDDEN'});
});

test('Pix preparation pins its reviewed provider, environment and account before any dispatch',async t=>{
  const cases = [
    ['unconfigured preparation then production activation', 'blocked', f=>pixProvider(f)],
    ['disabled configured preparation then activation', 'disabled', f=>pixProvider(f)],
    ['homologation preparation then production', 'homologation', f=>pixProvider(f)],
    ['provider changed after preparation', 'production', f=>{f.runtime.channels.pix.provider='pix-inter';}],
    ['account changed after preparation', 'production', f=>{f.runtime.scopes.set('pix','another-reviewed-account');}],
    ['legacy preparation without account binding', 'production', async(f,item)=>{await f.db.prepare('UPDATE jk_integration_records SET account_scope=NULL WHERE id=?').run(item.id);}],
  ];
  for (const [name,initial,change] of cases) await t.test(name,async sub=>{
    const f=await fixture(sub);
    let original;
    if (initial==='disabled') Object.assign(f.runtime.channels.pix,{configured:true,provider:'pix-efi',environment:'production'});
    else if (initial!=='blocked') original=pixProvider(f,initial);
    const prepared=(await f.prepare()).data.item;
    const replacement=await change(f,prepared);
    const current=await f.item(prepared.id);
    assert.equal(current.preparationRequiresRefresh,true);
    assert.equal(current.canSubmit,false);
    assert.equal(current.canCancel,true);
    const key=randomUUID();
    await assert.rejects(f.call(`/pix/${prepared.id}/submit`,{method:'POST',key,body:{version:prepared.version}}),{code:'INTEGRATION_PREPARATION_CHANGED',status:409});
    assert.equal(original?.calls.length || 0,0);
    assert.equal(replacement?.calls.length || 0,0);
    assert.equal((await f.item(prepared.id)).attemptCount,0);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM jk_integration_operations WHERE idempotency_key=?').get(key)).count,0,'A rejected claim rolls back its idempotency reservation.');
    assert.equal((await orderBalance(f.db,'order-test')).balanceCents,12000);
    await f.call(`/pix/${prepared.id}/cancel`,{method:'POST',body:{version:prepared.version}});
    const fresh=(await f.prepare()).data.item;
    assert.equal(fresh.preparationRequiresRefresh,false);
    assert.equal(fresh.canSubmit,true);
    const stored=await f.db.prepare('SELECT account_scope FROM jk_integration_records WHERE id=?').get(fresh.id);
    assert.equal(stored.account_scope,f.runtime.scopes.get('pix'));
    assert.equal(Object.hasOwn(fresh,'accountScope'),false,'Account fingerprint stays private.');
  });
});

test('WhatsApp local preparations require a new review after activation or sender-account change',async t=>{
  for (const initial of ['blocked','ready']) await t.test(initial,async sub=>{
    const f=await fixture(sub);let calls=0;
    const enable=()=>{
      Object.assign(f.runtime.channels.whatsapp,{state:'ready',configured:true,provider:'whatsapp-cloud',environment:'production',blockers:[]});
      f.runtime.scopes.set('whatsapp','reviewed-sender-account');
      f.runtime.adapters.set('whatsapp',{async execute(){calls++;throw new Error('This fixture must never dispatch.');}});
    };
    if(initial==='ready')enable();
    const body={version:1,templateName:'aviso_qa',languageCode:'pt_BR',consentConfirmed:true};
    const prepared=(await f.call('/orders/order-test/messages',{method:'POST',body})).data.item;
    if(initial==='blocked')enable();else f.runtime.scopes.set('whatsapp','different-sender-account');
    const current=(await f.call(`/messages/${prepared.id}`)).data.item;
    assert.equal(current.preparationRequiresRefresh,true);assert.equal(current.canSubmit,false);
    await assert.rejects(f.call(`/messages/${prepared.id}/submit`,{method:'POST',body:{version:prepared.version}}),{code:'INTEGRATION_PREPARATION_CHANGED',status:409});
    assert.equal(calls,0);
    assert.equal((await f.call(`/messages/${prepared.id}`)).data.item.attemptCount,0);
    await f.call(`/messages/${prepared.id}/cancel`,{method:'POST',body:{version:prepared.version}});
    const fresh=(await f.call('/orders/order-test/messages',{method:'POST',body})).data.item;
    assert.equal(fresh.preparationRequiresRefresh,false);assert.equal(fresh.canSubmit,true);
  });
});

test('WhatsApp provider acceptance remains unconfirmed delivery and a replay sends no second message',async t=>{
  const f=await fixture(t);let calls=0;
  const adapter=new WhatsAppCloudAdapter({phoneNumberId:'1234567890',graphVersion:'v23.0',accessToken:'fixture-only-token'},
    {async request(request){calls++;const body=JSON.parse(request.body);assert.equal(body.to,'5511999999999');return json({messaging_product:'whatsapp',messages:[{id:'wamid.fixture_reference'}]});}});
  Object.assign(f.runtime.channels.whatsapp,{state:'ready',configured:true,provider:'whatsapp-cloud',environment:'production',blockers:[]});
  f.runtime.adapters.set('whatsapp',adapter);f.runtime.scopes.set('whatsapp','whatsapp-fixture');
  await assert.rejects(f.call('/orders/order-test/messages',{method:'POST',body:{version:1,templateName:'os_pronta',languageCode:'pt_BR'}}),{code:'MESSAGE_CONSENT_REQUIRED'});
  const item=(await f.call('/orders/order-test/messages',{method:'POST',body:{version:1,templateName:'os_pronta',languageCode:'pt_BR',consentConfirmed:true}})).data.item;
  const key=randomUUID();const path=`/messages/${item.id}/submit`;
  const sent=(await f.call(path,{method:'POST',key,body:{version:item.version}})).data.item;
  assert.equal(sent.status,'accepted');assert.equal(sent.delivery,'unconfirmed');assert.equal(sent.evidence.delivery,'unconfirmed');
  assert.equal(sent.recipientMasked,'***9999');assert.equal(JSON.stringify(sent).includes('5511999999999'),false);
  await f.call(path,{method:'POST',key,body:{version:item.version}});assert.equal(calls,1);
  await assert.rejects(f.call(path,{method:'POST',body:{version:sent.version}}),{code:'INTEGRATION_ALREADY_SUBMITTED'});
});

test('invalid configuration is closed and never exposes file paths or credentials',async t=>{
  const f=await fixture(t);const directory=await mkdtemp(join(tmpdir(),'jk-integrations-config-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  await writeFile(join(directory,'config.json'),JSON.stringify({version:1,integrations:[{kind:'whatsapp-cloud',environment:'production',phoneNumberId:'1234567890',graphVersion:'v23.0',accessTokenFile:'missing-token.txt'}]}),{mode:0o600});
  await chmod(directory,0o700);
  const runtime=await initializeJkIntegrations(f.db,{env:{AB_JK_SECRETS_ROOT:directory,AB_JK_INTEGRATIONS_CONFIG:'config.json'}});
  assert.equal(runtime.channels.whatsapp.state,'blocked');assert.equal(runtime.adapters.size,0);
  assert.ok(runtime.channels.whatsapp.blockers.includes('PRODUCTION_NOT_ENABLED'));
  assert.equal(JSON.stringify(runtime.channels).includes(directory),false);
  assert.throws(()=>parseJkConfiguration({version:1,integrations:[{kind:'pix-efi',environment:'production',url:'http://localhost'}]}));
});

test('missing integration migration explicitly blocks readiness and local preparations',async t=>{
  const f=await fixture(t);
  await f.db.exec('DROP TABLE jk_integration_events;');
  const runtime=await initializeJkIntegrations(f.db,{env:{}});
  Object.assign(f.runtime,runtime);
  const readiness=(await f.call('/integrations/readiness')).data;
  assert.equal(readiness.storageReady,false);assert.equal(readiness.pix.capabilities.prepare,false);
  assert.ok(readiness.pix.blockers.includes('INTEGRATION_STORAGE_UNAVAILABLE'));
  await assert.rejects(f.prepare(),{code:'INTEGRATION_STORAGE_UNAVAILABLE'});
});
