import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDatabase, sqliteStore } from '../server/db.mjs';
import { migrateDomain, migrateStorage } from '../server/domain-schema.mjs';
import { initializeJkDeliveries } from '../server/jk-deliveries-schema.mjs';
import { orderBalance } from '../server/domain-core.mjs';
import { initializeBookingFulfillment, recordBookingAdvance, previewBookingFulfillment, commitBookingFulfillment,
  bookingUnallocatedReceivedCents, bookingAdvanceRows, bookingAdvanceSummary } from '../server/jk-booking-fulfillment.mjs';

const scope='asaas:production:synthetic-account',e2e=`E${'7'.repeat(31)}`;
const receivedAt='2026-10-29T14:00:00.000Z',period={start:'2026-10-29T00:00:00.000Z',end:'2026-10-30T00:00:00.000Z'};
const selection={bookingId:'booking-one',bookingVersion:1,customerId:'customer-one',vehicleId:'vehicle-one',employeeId:'employee-one',operationalServiceId:'service-one',commissionBps:1250,commissionReviewed:true,identityMatchConfirmed:true};
function fixture(t) {
  const raw=openDatabase(':memory:');migrateDomain(raw);migrateStorage(raw);initializeJkDeliveries(raw);
  raw.exec(readFileSync(new URL('../integrations/jk/schema.sql',import.meta.url),'utf8'));
  raw.exec(`CREATE TABLE jk_booking_reservations(id TEXT PRIMARY KEY,reference TEXT,identity_id TEXT,service_name TEXT,category TEXT,duration_minutes INTEGER,amount_cents INTEGER,starts_at TEXT,ends_at TEXT,status TEXT,financial_status TEXT,account_scope TEXT,environment TEXT,provider_reference TEXT,version INTEGER,created_at TEXT);
    CREATE TABLE jk_booking_receipts(end_to_end_id TEXT PRIMARY KEY,booking_id TEXT UNIQUE REFERENCES jk_booking_reservations(id),amount_cents INTEGER,received_at TEXT,evidence_hash TEXT);`);
  for(const [id,role] of [['actor','operator'],['viewer','viewer']])raw.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,id,id+'@example.test','no-login',role,receivedAt,receivedAt);
  raw.prepare('INSERT INTO customers(id,name,phone,kind,postpaid,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('customer-one','Cliente sintético','+5511999999999','individual',0,receivedAt,receivedAt);
  raw.prepare('INSERT INTO customers(id,name,phone,kind,postpaid,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('customer-other','Outro sintético','+5511888888888','individual',0,receivedAt,receivedAt);
  raw.prepare('INSERT INTO vehicles(id,customer_id,plate,model,category,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('vehicle-one','customer-one','ABC1D23','Modelo sintético','medium',receivedAt,receivedAt);
  raw.prepare('INSERT INTO employees(id,name,base_salary_cents,commission_bps,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('employee-one','Funcionário sintético',0,2000,receivedAt,receivedAt);
  // Current catalog differs deliberately: fulfillment must honor the purchased snapshot.
  raw.prepare('INSERT INTO services(id,name,price_cents,duration_minutes,commission_bps,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('service-one','Serviço atualizado',15000,60,2500,receivedAt,receivedAt);
  raw.prepare('INSERT INTO jk_booking_reservations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('booking-one','ABCDEF12','identity-one','Serviço contratado','medium',30,12029,'2026-10-30T15:00:00.000Z','2026-10-30T15:30:00.000Z','arrived','received',scope,'production','booking-reference',1,'2026-10-29T13:59:00.000Z');
  raw.prepare('INSERT INTO jk_booking_receipts VALUES(?,?,?,?,?)').run(e2e,'booking-one',12029,receivedAt,'a'.repeat(64));
  initializeBookingFulfillment(raw);const db=sqliteStore(raw);t.after(()=>db.close());
  const opts={actorId:'actor',authorize:async()=>{}};
  const advance=()=>db.transaction(()=>recordBookingAdvance(db,{bookingId:'booking-one',endToEndId:e2e},{scope,environment:'production'}));
  const preview=(patch={})=>previewBookingFulfillment(db,{...selection,...patch},opts);
  const commit=async(patch={},key='fulfillment-request-one')=>{const p=await preview(patch);return commitBookingFulfillment(db,{...selection,...patch,previewHash:p.previewHash},{...opts,idempotencyKey:key});};
  return {raw,db,opts,advance,preview,commit};
}

test('advance records one original-dated online Pix without customer payment or OS',async t=>{
  const f=fixture(t);await f.advance();await f.advance();
  const cash=f.raw.prepare('SELECT * FROM cash_movements').all();assert.equal(cash.length,1);assert.equal(cash[0].source,'booking');assert.equal(cash[0].method,'pix');assert.equal(cash[0].amount_cents,12029);assert.equal(cash[0].created_at,receivedAt);assert.equal(cash[0].cash_session_id,null);
  for(const table of ['orders','payments','payment_allocations'])assert.equal(f.raw.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
  assert.equal(await bookingUnallocatedReceivedCents(f.db,period),12029);
});

test('advance requires a write transaction and production scope',async t=>{
  const f=fixture(t);await assert.rejects(recordBookingAdvance(f.db,{bookingId:'booking-one',endToEndId:e2e},{scope,environment:'production'}),{code:'BOOKING_TRANSACTION_REQUIRED'});
  for(const options of [{scope,environment:'homologation'},{scope:'another',environment:'production'}])await assert.rejects(f.db.transaction(()=>recordBookingAdvance(f.db,{bookingId:'booking-one',endToEndId:e2e},options)),{code:'BOOKING_SCOPE_MISMATCH'});
  assert.equal(f.raw.prepare('SELECT count(*) n FROM cash_movements').get().n,0);
});

test('receipt tampering and immutable replay mismatch reject without another cash entry',async t=>{
  const f=fixture(t);f.raw.prepare('UPDATE jk_booking_receipts SET amount_cents=1').run();await assert.rejects(f.advance(),{code:'BOOKING_RECEIPT_INVALID'});
  f.raw.prepare('UPDATE jk_booking_receipts SET amount_cents=12029').run();await f.advance();
  f.raw.prepare('UPDATE jk_booking_reservations SET provider_reference=?').run('changed');await assert.rejects(f.advance(),{code:'BOOKING_ADVANCE_CONFLICT'});
  assert.equal(f.raw.prepare('SELECT count(*) n FROM cash_movements').get().n,1);
});

test('late or cancelled receipt remains a visible gross advance in review, not a fictitious refund',async t=>{
  const f=fixture(t);f.raw.prepare("UPDATE jk_booking_reservations SET status='cancelled',financial_status='refund_pending'").run();await f.advance();
  const rows=await bookingAdvanceRows(f.db,{unallocatedOnly:true});assert.equal(rows.items.length,1);assert.equal(rows.items[0].financialStatus,'refund_pending');assert.equal(rows.items[0].customerName,'Reserva pública');
  const summary=await bookingAdvanceSummary(f.db,period);assert.equal(summary.grossReceivedCents,12029);assert.equal(summary.refundPendingCents,12029);assert.equal(summary.unallocatedReceivedCents,12029);
  await assert.rejects(f.preview(),{code:'FULFILLMENT_NOT_READY'});assert.equal(f.raw.prepare("SELECT count(*) n FROM cash_movements WHERE type='out'").get().n,0);
});

test('preview is zero-DML and shows frozen price, duration and reviewed commission',async t=>{
  const f=fixture(t);await f.advance();const before=f.raw.prepare('SELECT total_changes() n').get().n,p=await f.preview();
  assert.equal(f.raw.prepare('SELECT total_changes() n').get().n,before);assert.equal(p.canCommit,true);assert.match(p.previewHash,/^[a-f0-9]{64}$/u);
  assert.equal(p.order.unitPriceCents,12029);assert.equal(p.order.durationMinutes,30);assert.equal(p.order.commissionBps,1250);assert.equal(p.order.commissionCents,1504);assert.equal(p.order.catalogPriceCents,15000);assert.equal(p.effects.cashMovementsCreated,0);
});

test('fulfillment creates one real order and allocates original receipt without cash or external collection',async t=>{
  const f=fixture(t);await f.advance();const result=await f.commit();
  const order=f.raw.prepare('SELECT * FROM orders').get(),item=f.raw.prepare('SELECT * FROM order_items').get(),payment=f.raw.prepare('SELECT * FROM payments').get();
  assert.equal(result.orderId,order.id);assert.equal(order.customer_id,'customer-one');assert.equal(order.vehicle_id,'vehicle-one');assert.equal(order.status,'waiting');assert.equal(order.total_cents,12029);assert.equal(order.settled_at,receivedAt);
  assert.equal(item.name,'Serviço contratado');assert.equal(item.unit_price_cents,12029);assert.equal(item.duration_minutes,30);assert.equal(item.commission_bps,1250);assert.equal(item.commission_cents,1504);
  assert.equal(payment.source,'order');assert.equal(payment.source_id,order.id);assert.equal(payment.created_at,receivedAt);assert.equal(payment.method,'pix');assert.ok(payment.reference.includes(e2e));
  assert.equal((await orderBalance(f.db,order.id)).balanceCents,0);assert.equal(f.raw.prepare('SELECT count(*) n FROM cash_movements').get().n,1);assert.equal(f.raw.prepare('SELECT count(*) n FROM jk_integration_records').get().n,0);
});

test('explicitly reviewed zero commission stays zero rather than falling back to an employee rate',async t=>{
  const f=fixture(t);await f.advance();await f.commit({commissionBps:0});
  const item=f.raw.prepare('SELECT commission_bps,commission_cents FROM order_items').get();assert.equal(item.commission_bps,0);assert.equal(item.commission_cents,0);
});

test('combined historical receipts stay identical on allocation and attendance day adds no receipt',async t=>{
  const f=fixture(t);await f.advance();const before=await bookingUnallocatedReceivedCents(f.db,period);await f.commit();
  const unallocated=await bookingUnallocatedReceivedCents(f.db,period),paid=f.raw.prepare('SELECT coalesce(sum(amount_cents),0) n FROM payments WHERE created_at>=? AND created_at<?').get(period.start,period.end).n;
  assert.equal(before,paid+unallocated);assert.equal(unallocated,0);assert.equal(paid,12029);
  assert.equal(await bookingUnallocatedReceivedCents(f.db,{start:'2026-10-30T00:00:00.000Z',end:'2026-10-31T00:00:00.000Z'}),0);
  const summary=await bookingAdvanceSummary(f.db,period);assert.equal(summary.allocatedReceivedCents,12029);assert.equal(summary.unallocatedReceivedCents,0);
});

test('idempotent and concurrent commits return one allocation and require current authorization on replay',async t=>{
  const f=fixture(t);await f.advance();const p=await f.preview(),input={...selection,previewHash:p.previewHash},options={...f.opts,idempotencyKey:'same-request-key'};
  const results=await Promise.all([commitBookingFulfillment(f.db,input,options),commitBookingFulfillment(f.db,input,options)]);
  assert.equal(results[0].orderId,results[1].orderId);assert.equal(results[1].replayed,true);assert.equal(f.raw.prepare('SELECT count(*) n FROM orders').get().n,1);
  f.raw.prepare('UPDATE users SET active=0 WHERE id=?').run('actor');await assert.rejects(commitBookingFulfillment(f.db,input,options),{code:'OPERATOR_REQUIRED'});
});

test('missing callback, wrong role, readonly mode and revoked callback fail before writes',async t=>{
  const f=fixture(t);await f.advance();const p=await f.preview(),input={...selection,previewHash:p.previewHash};
  await assert.rejects(commitBookingFulfillment(f.db,input,{actorId:'actor',idempotencyKey:'no-auth-callback'}),{code:'AUTHORIZATION_REQUIRED'});
  await assert.rejects(previewBookingFulfillment(f.db,selection,{actorId:'viewer'}),{code:'OPERATOR_REQUIRED'});
  await assert.rejects(commitBookingFulfillment(f.db,input,{...f.opts,idempotencyKey:'rejected-callback',authorize:()=>{throw Error('session revoked');}}),/session revoked/u);
  f.raw.prepare('INSERT INTO app_settings VALUES(?,?,?)').run('jk_transition',JSON.stringify({mode:'parallel_readonly',version:1}),receivedAt);
  await assert.rejects(commitBookingFulfillment(f.db,input,{...f.opts,idempotencyKey:'parallel-request'}),{code:'PARALLEL_READONLY'});assert.equal(f.raw.prepare('SELECT count(*) n FROM orders').get().n,0);
});

test('real ownership, category, active employee and explicit commission are mandatory',async t=>{
  const f=fixture(t);await f.advance();
  for(const patch of [{identityMatchConfirmed:false},{commissionReviewed:false},{commissionBps:null},{commissionBps:10001},{employeeId:null}])await assert.rejects(f.preview(patch));
  await assert.rejects(f.preview({customerId:'customer-other'}),{code:'CUSTOMER_VEHICLE_MISMATCH'});
  f.raw.prepare("UPDATE vehicles SET category='large'").run();await assert.rejects(f.preview(),{code:'BOOKING_CATEGORY_MISMATCH'});f.raw.prepare("UPDATE vehicles SET category='medium'").run();
  f.raw.prepare('UPDATE employees SET active=0').run();await assert.rejects(f.preview(),{code:'INACTIVE_RECORD'});
});

test('stale version and tampered preview cannot write, including changed master data',async t=>{
  const f=fixture(t);await f.advance();const p=await f.preview();
  await assert.rejects(commitBookingFulfillment(f.db,{...selection,previewHash:'0'.repeat(64)},{...f.opts,idempotencyKey:'wrong-preview-hash'}),{code:'BOOKING_PREVIEW_MISMATCH'});
  f.raw.prepare('UPDATE services SET version=version+1').run();await assert.rejects(commitBookingFulfillment(f.db,{...selection,previewHash:p.previewHash},{...f.opts,idempotencyKey:'changed-service-request'}),{code:'BOOKING_PREVIEW_MISMATCH'});
  f.raw.prepare('UPDATE jk_booking_reservations SET version=2').run();await assert.rejects(f.preview(),{code:'BOOKING_VERSION_CONFLICT'});assert.equal(f.raw.prepare('SELECT count(*) n FROM orders').get().n,0);
});

test('failed audit rolls the entire fulfillment back while preserving the original advance',async t=>{
  const f=fixture(t);await f.advance();f.raw.exec("CREATE TRIGGER reject_fulfillment_audit BEFORE INSERT ON audit_events WHEN NEW.action='jk.booking.fulfilled' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  await assert.rejects(f.commit(),/synthetic audit failure/u);
  for(const table of ['orders','order_items','payments','payment_allocations'])assert.equal(f.raw.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
  assert.equal(f.raw.prepare('SELECT payment_id FROM jk_booking_advances').get().payment_id,null);assert.equal(f.raw.prepare('SELECT count(*) n FROM cash_movements').get().n,1);
});

test('failed receipt/advance transaction leaves no partial receipt or cash movement',async t=>{
  const f=fixture(t);f.raw.prepare('DELETE FROM jk_booking_receipts').run();f.raw.exec("CREATE TRIGGER reject_advance_audit BEFORE INSERT ON audit_events WHEN NEW.action='jk.booking.advance_received' BEGIN SELECT RAISE(ABORT,'synthetic advance audit failure'); END");
  await assert.rejects(f.db.transaction(async()=>{await f.db.prepare('INSERT INTO jk_booking_receipts VALUES(?,?,?,?,?)').run(e2e,'booking-one',12029,receivedAt,'a'.repeat(64));await recordBookingAdvance(f.db,{bookingId:'booking-one',endToEndId:e2e},{scope,environment:'production'});}),/synthetic advance audit failure/u);
  for(const table of ['jk_booking_receipts','jk_booking_advances','cash_movements'])assert.equal(f.raw.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
});
