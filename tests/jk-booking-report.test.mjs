import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { openDatabase, sqliteStore } from '../server/db.mjs';
import { migrateDomain, migrateStorage } from '../server/domain-schema.mjs';
import { initializeJkDeliveries } from '../server/jk-deliveries-schema.mjs';
import { initializeBookingIdentity } from '../server/jk-booking-identity.mjs';
import { initializeJkBooking } from '../server/jk-booking.mjs';
import { initializeBookingFulfillment, recordBookingAdvance, previewBookingFulfillment, commitBookingFulfillment } from '../server/jk-booking-fulfillment.mjs';
import { migrateJkIntegrations, initializeJkIntegrations, handleJkIntegrations } from '../server/jk-integrations.mjs';
import { createSession, readSession, sessionCookie } from '../server/security.mjs';
import { reportRoutes, dashboardRoutes } from '../server/domain-reports.mjs';
import { businessDate, orderBalance } from '../server/domain-core.mjs';
import { schemas } from '../scripts/sdk-contract.mjs';
import { checkSchema } from './sdk-helpers.mjs';

const scope='asaas:production:synthetic-report-account',e2e=`E${'8'.repeat(31)}`,amountCents=12029;
// UTC October 30 is still October 29 in the establishment's timezone.
const originalReceivedAt='2026-10-30T01:00:00.000Z';
const selection={bookingId:'booking-report',bookingVersion:1,customerId:'customer-report',vehicleId:'vehicle-report',employeeId:'employee-report',operationalServiceId:'service-report',commissionBps:1250,commissionReviewed:true,identityMatchConfirmed:true};

async function fixture(t,{receivedAt=originalReceivedAt}={}) {
  const raw=openDatabase(':memory:');
  migrateDomain(raw);migrateStorage(raw);migrateJkIntegrations(raw);initializeJkDeliveries(raw);
  initializeBookingIdentity(raw);initializeJkBooking(raw);initializeBookingFulfillment(raw);
  const createdAt=new Date(Date.parse(receivedAt)-60000).toISOString();
  raw.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('actor-report','Gestor sintético','report@example.test','unused','manager',createdAt,createdAt);
  raw.prepare('INSERT INTO customers(id,name,kind,postpaid,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(selection.customerId,'Cliente sintético identificado','individual',0,createdAt,createdAt);
  raw.prepare('INSERT INTO vehicles(id,customer_id,plate,model,category,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(selection.vehicleId,selection.customerId,'RPT1A23','Veículo sintético','medium',createdAt,createdAt);
  raw.prepare('INSERT INTO employees(id,name,base_salary_cents,commission_bps,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(selection.employeeId,'Atendente sintético',0,2000,createdAt,createdAt);
  raw.prepare('INSERT INTO services(id,name,price_cents,duration_minutes,commission_bps,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(selection.operationalServiceId,'Catálogo revisado',15000,60,2500,createdAt,createdAt);
  raw.prepare('INSERT INTO jk_booking_identities VALUES(?,?,?,?)').run('identity-report','+5511999999999',createdAt,Date.parse(createdAt));
  raw.prepare(`INSERT INTO jk_booking_reservations(id,reference,identity_id,token_nonce,token_hash,idempotency_key,request_hash,
    service_id,service_name,category,duration_minutes,amount_cents,starts_at,ends_at,hold_expires_at,policy_json,
    account_scope,environment,provider_reference,status,financial_status,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(selection.bookingId,'ABCDEF123456','identity-report','synthetic-nonce','synthetic-hash','synthetic-request','synthetic-request-hash',
      'quoted-service','Serviço contratado','medium',30,amountCents,'2026-10-30T15:00:00.000Z','2026-10-30T15:30:00.000Z',receivedAt,'{}',scope,'production','synthetic-reference','arrived','received',createdAt);
  raw.prepare('INSERT INTO jk_booking_receipts VALUES(?,?,?,?,?)').run(e2e,selection.bookingId,amountCents,receivedAt,'b'.repeat(64));
  const db=sqliteStore(raw);t.after(()=>db.close());
  const issued=await createSession(db,'actor-report');
  const session=await readSession(db,{headers:{cookie:sessionCookie(issued.token).split(';')[0]}});
  const advance=()=>db.transaction(()=>recordBookingAdvance(db,{bookingId:selection.bookingId,endToEndId:e2e},{scope,environment:'production'}));
  const report=async(type,from='2026-10-29',to=from,query='')=>{
    const url=new URL(`http://local.invalid/api/reports?type=${type}&from=${from}&to=${to}${query}`);
    const data=(await db.read(()=>reportRoutes({db,session,method:'GET',pathname:url.pathname,url}))).data;
    checkSchema(schemas.Report,data);return data;
  };
  const dashboard=async()=>(await db.read(()=>dashboardRoutes({db,session,method:'GET',pathname:'/api/dashboard'}))).data.item;
  const fulfill=async()=>{
    const options={actorId:session.user.id,authorize:async()=>{}},preview=await previewBookingFulfillment(db,selection,options);
    return commitBookingFulfillment(db,{...selection,previewHash:preview.previewHash},{...options,idempotencyKey:'fulfillment-report-request'});
  };
  return {raw,db,session,advance,report,dashboard,fulfill};
}

test('real financial reports replace the advance with its OS payment without duplicating amount or cash',async t=>{
  const f=await fixture(t);await f.advance();
  const before=await f.report('sales'),cashBefore=await f.report('cash');
  assert.equal(before.summary.receivedCents,amountCents);assert.equal(before.summary.openReceivableCents,0);assert.equal(before.summary.deliveredCents,0);
  assert.equal(before.page.total,1);assert.equal(before.items[0].source,'booking');assert.equal(before.items[0].customerName,'Reserva pública');
  assert.equal(before.items[0].createdAt,originalReceivedAt);assert.equal(before.items[0].amountCents,amountCents);
  assert.equal(cashBefore.page.total,1);assert.equal(cashBefore.items[0].source,'booking');assert.equal(cashBefore.items[0].cashSessionId,null);
  const fulfilled=await f.fulfill(),after=await f.report('sales'),cashAfter=await f.report('cash');
  assert.equal(after.summary.receivedCents,before.summary.receivedCents);assert.equal(after.summary.openReceivableCents,0);assert.equal(after.summary.deliveredCents,0);
  assert.equal(after.page.total,1);assert.equal(after.items[0].id,fulfilled.paymentId);assert.equal(after.items[0].source,'order');
  assert.equal(after.items[0].customerName,'Cliente sintético identificado');assert.equal(after.items[0].createdAt,originalReceivedAt);assert.equal(after.items[0].amountCents,amountCents);
  assert.deepEqual(cashAfter.items,cashBefore.items);assert.equal((await orderBalance(f.db,fulfilled.orderId)).balanceCents,0);
  const summary=await f.report('summary');assert.equal(summary.items.find(row=>row.metric==='receivedCents').value,amountCents);
  assert.equal((await f.report('sales','2026-10-29','2026-10-30','&limit=1&offset=1')).items.length,0);
  assert.equal(f.raw.prepare('SELECT count(*) n FROM payments').get().n,1);assert.equal(f.raw.prepare('SELECT count(*) n FROM cash_movements').get().n,1);
});

test('report dates honor São Paulo receipt day and never move money to the attendance day',async t=>{
  const f=await fixture(t);await f.advance();
  for(const fulfilled of [false,true]){
    if(fulfilled)await f.fulfill();
    for(const type of ['summary','sales','cash']){
      const prior=await f.report(type,'2026-10-29'),attendance=await f.report(type,'2026-10-30');
      assert.equal(prior.summary.receivedCents,amountCents);assert.equal(attendance.summary.receivedCents,0);
      assert.equal(prior.period.timezone,'America/Sao_Paulo');
      if(type!=='summary'){assert.equal(prior.page.total,1);assert.equal(attendance.page.total,0);}
    }
  }
});

test('manager dashboard shows an advance immediately and keeps the same received total after fulfillment',async t=>{
  const receivedAt=new Date().toISOString(),f=await fixture(t,{receivedAt});await f.advance();
  const before=await f.dashboard();assert.equal(before.businessDate,businessDate(receivedAt,'America/Sao_Paulo'));
  assert.equal(before.receivedTodayCents,amountCents);assert.equal(before.receivableCents,0);assert.equal(before.openOrders,0);
  await f.fulfill();const after=await f.dashboard();
  assert.equal(after.receivedTodayCents,amountCents);assert.equal(after.receivableCents,0);assert.equal(after.openOrders,1);
});

test('unallocated cancelled receipt stays in gross received and cash while refund is awaiting review',async t=>{
  const f=await fixture(t);f.raw.prepare("UPDATE jk_booking_reservations SET status='cancelled',financial_status='refund_pending'").run();await f.advance();
  for(const type of ['summary','sales','cash'])assert.equal((await f.report(type)).summary.receivedCents,amountCents);
  const cash=await f.report('cash');assert.equal(cash.items.length,1);assert.equal(cash.items[0].type,'in');assert.equal(cash.items[0].amountCents,amountCents);
  await assert.rejects(f.fulfill(),{code:'FULFILLMENT_NOT_READY'});assert.equal(f.raw.prepare('SELECT count(*) n FROM payments').get().n,0);
});

async function orderPixHandler(f) {
  const runtime=await initializeJkIntegrations(f.db,{env:{}}),calls=[];
  Object.assign(runtime.channels.pix,{state:'ready',configured:true,provider:'pix-efi',environment:'production',blockers:[]});
  runtime.scopes.set('pix','synthetic-other-account');
  // Only the provider seam is synthetic: real handler, session, journal and ledger guards run.
  runtime.adapters.set('pix',{async execute(operation,input){
    calls.push(operation);return {state:'SUCCEEDED',providerReference:input.txid,data:{...input,journalLinked:true,environment:'production',
      chargeStatus:operation==='reconcile'?'CONCLUIDA':'ATIVA',paymentConfirmed:operation==='reconcile',receiptStatus:'CONFIRMED',
      evidenceSource:'authenticated-polling',observedAt:new Date().toISOString(),receivedCents:amountCents,refundedCents:0,
      receipts:[{endToEndId:e2e,amountCents,receivedAt:originalReceivedAt,refundedCents:0,refundPending:false}]}};
  }});
  const call=async(path,body)=>{
    const request=Readable.from([Buffer.from(JSON.stringify(body))]);request.headers={'content-type':'application/json','idempotency-key':randomUUID()};
    const url=new URL(`http://local.invalid/api/jk${path}`);
    return handleJkIntegrations({db:f.db,session:f.session,request,method:'POST',pathname:url.pathname,url,jkIntegrations:runtime});
  };
  return {call,calls};
}

test('OS reconciliation rejects an E2E already recorded as booking advance and adds no second cash receipt',async t=>{
  const f=await fixture(t);await f.advance();
  f.raw.prepare('INSERT INTO orders(id,number,customer_id,vehicle_id,status,subtotal_cents,discount_cents,total_cents,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('order-unrelated',1,selection.customerId,selection.vehicleId,'waiting',amountCents,0,amountCents,originalReceivedAt,originalReceivedAt);
  const h=await orderPixHandler(f),prepared=(await h.call('/orders/order-unrelated/pix',{version:1})).data.item;
  const active=(await h.call(`/pix/${prepared.id}/submit`,{version:prepared.version})).data.item;
  const review=(await h.call(`/pix/${active.id}/reconcile`,{version:active.version})).data.item;
  assert.equal(review.status,'review');assert.equal(review.lastErrorCode,'PIX_RECEIPT_ALREADY_LINKED');assert.equal(review.paymentConfirmed,false);assert.equal(review.paymentId,null);
  assert.equal(f.raw.prepare('SELECT count(*) n FROM jk_pix_receipts').get().n,0);assert.equal(f.raw.prepare('SELECT count(*) n FROM payments').get().n,0);
  assert.equal(f.raw.prepare('SELECT count(*) n FROM cash_movements').get().n,1);assert.equal((await f.report('sales')).summary.receivedCents,amountCents);
});

test('fulfilled booking OS is already settled and cannot prepare a second external Pix charge',async t=>{
  const f=await fixture(t);await f.advance();const fulfilled=await f.fulfill(),h=await orderPixHandler(f);
  const order=f.raw.prepare('SELECT version FROM orders WHERE id=?').get(fulfilled.orderId);
  await assert.rejects(h.call(`/orders/${fulfilled.orderId}/pix`,{version:order.version}),{code:'ORDER_ALREADY_PAID'});
  assert.deepEqual(h.calls,[]);assert.equal(f.raw.prepare('SELECT count(*) n FROM jk_integration_records').get().n,0);
});

test('booking advance rejects an E2E already settled by the operational OS handler',async t=>{
  const f=await fixture(t);f.raw.prepare('DELETE FROM jk_booking_receipts').run();
  f.raw.prepare('INSERT INTO orders(id,number,customer_id,vehicle_id,status,subtotal_cents,discount_cents,total_cents,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('order-first',1,selection.customerId,selection.vehicleId,'waiting',amountCents,0,amountCents,originalReceivedAt,originalReceivedAt);
  const h=await orderPixHandler(f),prepared=(await h.call('/orders/order-first/pix',{version:1})).data.item;
  const active=(await h.call(`/pix/${prepared.id}/submit`,{version:prepared.version})).data.item;
  assert.equal((await h.call(`/pix/${active.id}/reconcile`,{version:active.version})).data.item.status,'settled');
  await assert.rejects(f.db.transaction(async()=>{
    await f.db.prepare('INSERT INTO jk_booking_receipts VALUES(?,?,?,?,?)').run(e2e,selection.bookingId,amountCents,originalReceivedAt,'b'.repeat(64));
    await recordBookingAdvance(f.db,{bookingId:selection.bookingId,endToEndId:e2e},{scope,environment:'production'});
  }),{code:'BOOKING_RECEIPT_CONFLICT'});
  for(const table of ['jk_booking_receipts','jk_booking_advances'])assert.equal(f.raw.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
  for(const table of ['payments','cash_movements','jk_pix_receipts'])assert.equal(f.raw.prepare(`SELECT count(*) n FROM ${table}`).get().n,1);
});
