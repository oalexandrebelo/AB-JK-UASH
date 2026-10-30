import { createHash, randomUUID } from 'node:crypto';
import { audit, idempotentWrite, transaction } from './db.mjs';
import { assert } from './errors.mjs';
import * as v from './validation.mjs';
import { record, insert, roundRatio } from './domain-core.mjs';
import { association, checkAvailability } from './domain-orders.mjs';
import { assertJkMutationAllowed } from './jk-transition.mjs';

const PATH='/api/jk/booking/fulfillment/commit';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const now=()=>new Date().toISOString();
const validStamp=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)&&Number.isFinite(Date.parse(value));
const validCents=value=>Number.isSafeInteger(value)&&value>0&&value<=1_000_000_000;
const safe=value=>{const n=BigInt(value??0);assert(n>=0n&&n<=BigInt(Number.MAX_SAFE_INTEGER),422,'AMOUNT_LIMIT','O total excede o limite permitido.');return Number(n);};
const keys=(input,allowed)=>{v.object(input);v.onlyKeys(input,allowed);};

export const BOOKING_FULFILLMENT_SCHEMA=`CREATE TABLE IF NOT EXISTS jk_booking_advances (
  end_to_end_id TEXT PRIMARY KEY REFERENCES jk_booking_receipts(end_to_end_id),
  booking_id TEXT NOT NULL UNIQUE REFERENCES jk_booking_reservations(id),
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0 AND amount_cents<=1000000000),received_at TEXT NOT NULL,
  account_scope TEXT NOT NULL,provider_reference TEXT NOT NULL,environment TEXT NOT NULL CHECK(environment='production'),evidence_hash TEXT NOT NULL,
  cash_movement_id TEXT NOT NULL UNIQUE REFERENCES cash_movements(id),recorded_at TEXT NOT NULL,
  order_id TEXT UNIQUE REFERENCES orders(id),payment_id TEXT UNIQUE REFERENCES payments(id),
  fulfilled_by TEXT REFERENCES users(id),fulfilled_at TEXT,
  CHECK((order_id IS NULL AND payment_id IS NULL AND fulfilled_by IS NULL AND fulfilled_at IS NULL)
    OR (order_id IS NOT NULL AND payment_id IS NOT NULL AND fulfilled_by IS NOT NULL AND fulfilled_at IS NOT NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS jk_booking_advance_date ON jk_booking_advances(received_at,end_to_end_id);`;
export function initializeBookingFulfillment(raw) {transaction(raw,()=>raw.exec(BOOKING_FULFILLMENT_SCHEMA));}

async function proof(db,bookingId,endToEndId) {
  const booking=await db.prepare('SELECT * FROM jk_booking_reservations WHERE id=?').get(bookingId);
  const receipt=await db.prepare('SELECT * FROM jk_booking_receipts WHERE end_to_end_id=? AND booking_id=?').get(endToEndId,bookingId);
  assert(booking&&receipt&&validCents(receipt.amount_cents)&&receipt.amount_cents===booking.amount_cents
    &&/^E[A-Za-z0-9]{31}$/u.test(receipt.end_to_end_id)&&validStamp(receipt.received_at)
    &&Date.parse(receipt.received_at)>=Date.parse(booking.created_at)&&/^[a-f0-9]{64}$/u.test(receipt.evidence_hash),409,'BOOKING_RECEIPT_INVALID','O recebimento da reserva precisa de revisão.');
  assert(booking.environment==='production'&&typeof booking.account_scope==='string'&&booking.account_scope.length>0
    &&typeof booking.provider_reference==='string'&&booking.provider_reference.length>0,409,'BOOKING_SCOPE_MISMATCH','A origem do recebimento precisa de revisão.');
  assert(!await db.prepare('SELECT end_to_end_id FROM jk_pix_receipts WHERE end_to_end_id=?').get(endToEndId),409,'BOOKING_RECEIPT_CONFLICT','Este Pix já está vinculado a outro recebimento.');
  return {booking,receipt};
}
async function checkedAdvance(db,advance,{booking,receipt}) {
  const same=advance.booking_id===booking.id&&advance.end_to_end_id===receipt.end_to_end_id&&advance.amount_cents===receipt.amount_cents
    &&advance.received_at===receipt.received_at&&advance.evidence_hash===receipt.evidence_hash&&advance.account_scope===booking.account_scope
    &&advance.provider_reference===booking.provider_reference&&advance.environment===booking.environment;
  const cash=await db.prepare('SELECT * FROM cash_movements WHERE id=?').get(advance.cash_movement_id);
  assert(same&&cash&&cash.type==='in'&&cash.method==='pix'&&cash.source==='booking'&&cash.resource_id===booking.id
    &&cash.cash_session_id===null&&cash.amount_cents===advance.amount_cents&&cash.created_at===advance.received_at,409,'BOOKING_ADVANCE_CONFLICT','A antecipação não corresponde ao recibo original.');
  return advance;
}

/** Must be called inside the receipt acceptance transaction. No external I/O or refund inference. */
export async function recordBookingAdvance(db,input,{scope,environment}={}) {
  const context=db.context?.getStore?.();
  assert(context?.accepting&&!context.readOnly,503,'BOOKING_TRANSACTION_REQUIRED','O registro deve acompanhar a transação do recebimento.');
  keys(input,['bookingId','endToEndId']);v.identifier(input.bookingId,'bookingId');
  const evidence=await proof(db,input.bookingId,input.endToEndId),{booking,receipt}=evidence;
  assert(environment==='production'&&scope===booking.account_scope,409,'BOOKING_SCOPE_MISMATCH','A conta de recebimento mudou.');
  const prior=await db.prepare('SELECT * FROM jk_booking_advances WHERE booking_id=? OR end_to_end_id=?').get(booking.id,receipt.end_to_end_id);
  if(prior){await checkedAdvance(db,prior,evidence);return {bookingId:booking.id,endToEndId:receipt.end_to_end_id,cashMovementId:prior.cash_movement_id,replayed:true};}
  const cashId=randomUUID();
  await db.prepare(`INSERT INTO cash_movements(id,cash_session_id,type,amount_cents,method,source,resource_id,category,notes,created_at)
    VALUES(?,NULL,'in',?,'pix','booking',?,'antecipacao',?,?)`).run(cashId,receipt.amount_cents,booking.id,`Reserva ${booking.reference}`,receipt.received_at);
  await db.prepare(`INSERT INTO jk_booking_advances(end_to_end_id,booking_id,amount_cents,received_at,account_scope,provider_reference,environment,evidence_hash,cash_movement_id,recorded_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(receipt.end_to_end_id,booking.id,receipt.amount_cents,receipt.received_at,scope,booking.provider_reference,environment,receipt.evidence_hash,cashId,now());
  await audit(db,{action:'jk.booking.advance_received',resourceType:'jk_booking',resourceId:booking.id,
    metadata:{endToEndId:receipt.end_to_end_id,amountCents:receipt.amount_cents,receivedAt:receipt.received_at,cashMovementId:cashId}});
  return {bookingId:booking.id,endToEndId:receipt.end_to_end_id,cashMovementId:cashId,replayed:false};
}

const SELECTION=['bookingId','bookingVersion','customerId','vehicleId','employeeId','operationalServiceId','commissionBps','commissionReviewed','identityMatchConfirmed'];
function selection(input,commit=false) {
  keys(input,commit?[...SELECTION,'previewHash']:SELECTION);
  for(const field of ['bookingId','customerId','vehicleId','employeeId','operationalServiceId'])v.identifier(input[field],field);
  v.integer(input.bookingVersion,'bookingVersion',{min:1});v.integer(input.commissionBps,'commissionBps',{min:0,max:10000});
  assert(input.commissionReviewed===true&&input.identityMatchConfirmed===true,422,'FULFILLMENT_REVIEW_REQUIRED','Confirme a identidade e a comissão revisada.');
  if(commit)assert(typeof input.previewHash==='string'&&/^[a-f0-9]{64}$/u.test(input.previewHash),422,'BOOKING_PREVIEW_REQUIRED','Faça a prévia antes de confirmar.');
  return Object.fromEntries(SELECTION.map(key=>[key,input[key]]));
}
async function authorize(db,options,required=false) {
  assert(!required||typeof options?.authorize==='function',403,'AUTHORIZATION_REQUIRED','A sessão precisa ser validada novamente.');
  if(options?.authorize)await options.authorize();
  const actor=typeof options?.actorId==='string'?await db.prepare('SELECT role FROM users WHERE id=? AND active=1').get(options.actorId):null;
  assert(actor&&['admin','manager','operator'].includes(actor.role),403,'OPERATOR_REQUIRED','Seu perfil não permite iniciar este atendimento.');
  await assertJkMutationAllowed(db,'POST',PATH);
}
async function preview(db,input) {
  const booking=await db.prepare('SELECT * FROM jk_booking_reservations WHERE id=?').get(input.bookingId);
  assert(booking,404,'NOT_FOUND','Reserva não encontrada.');
  assert(booking.version===input.bookingVersion,409,'BOOKING_VERSION_CONFLICT','A reserva mudou. Atualize a prévia.');
  assert(booking.status==='arrived'&&booking.financial_status==='received',409,'FULFILLMENT_NOT_READY','Confirme a chegada e resolva o recebimento antes de iniciar a OS.');
  assert(Number.isSafeInteger(booking.duration_minutes)&&booking.duration_minutes>0&&booking.duration_minutes<=1440
    &&Date.parse(booking.ends_at)-Date.parse(booking.starts_at)===booking.duration_minutes*60000,409,'BOOKING_RECEIPT_INVALID','A duração contratada precisa de revisão.');
  const advance=await db.prepare('SELECT * FROM jk_booking_advances WHERE booking_id=?').get(booking.id);
  assert(advance,409,'BOOKING_ADVANCE_MISSING','A antecipação ainda não foi registrada.');
  await checkedAdvance(db,advance,await proof(db,booking.id,advance.end_to_end_id));
  assert(!advance.order_id&&!advance.payment_id,409,'ALREADY_FULFILLED','A reserva já possui uma OS.');
  const {customer,vehicle,employee}=await association(db,input.customerId,input.vehicleId,input.employeeId);
  const service=await record(db,'services',input.operationalServiceId,true);
  assert(vehicle.category===booking.category,409,'BOOKING_CATEGORY_MISMATCH','A categoria do veículo não corresponde à reserva.');
  await checkAvailability(db,employee.id,booking.starts_at,booking.ends_at);
  const order={customerId:customer.id,customerName:customer.name,vehicleId:vehicle.id,vehiclePlate:vehicle.plate,employeeId:employee.id,employeeName:employee.name,
    operationalServiceId:service.id,serviceName:booking.service_name,unitPriceCents:booking.amount_cents,durationMinutes:booking.duration_minutes,
    commissionBps:input.commissionBps,commissionCents:roundRatio(booking.amount_cents,input.commissionBps,10000),catalogPriceCents:service.price_cents,catalogDurationMinutes:service.duration_minutes,status:'waiting'};
  const snapshot={input,booking:{id:booking.id,version:booking.version,reference:booking.reference,status:booking.status,financialStatus:booking.financial_status,category:booking.category,
    startsAt:booking.starts_at,endsAt:booking.ends_at,serviceName:booking.service_name},advance,order,versions:{customer:customer.version,vehicle:vehicle.version,employee:employee.version,service:service.version}};
  const warnings=[];
  if(service.price_cents!==booking.amount_cents)warnings.push('O preço contratado será mantido; o catálogo tem outro preço.');
  if(service.duration_minutes!==booking.duration_minutes)warnings.push('A duração contratada será mantida; o catálogo tem outra duração.');
  return {canCommit:true,previewHash:hash(snapshot),booking:snapshot.booking,
    receipt:{endToEndId:advance.end_to_end_id,amountCents:advance.amount_cents,receivedAt:advance.received_at},order,
    effects:{ordersCreated:1,paymentsCreated:1,allocationsCreated:1,cashMovementsCreated:0,externalChargesCreated:0},warnings};
}
export async function previewBookingFulfillment(db,input,options={}) {
  const normalized=selection(input);
  return db.read(async()=>{await authorize(db,options);return preview(db,normalized);});
}
export async function commitBookingFulfillment(db,input,options={}) {
  const normalized=selection(input,true);
  return idempotentWrite(db,{actorId:options.actorId,key:options.idempotencyKey,method:'POST',path:PATH,body:input,
    authorize:()=>authorize(db,options,true)},async()=>{
    const plan=await preview(db,normalized);
    assert(plan.previewHash===input.previewHash,409,'BOOKING_PREVIEW_MISMATCH','Os dados mudaram. Revise uma nova prévia.');
    const number=(await db.prepare('SELECT COALESCE(MAX(number),0)+1 AS number FROM orders').get()).number;
    const order=await insert(db,'orders',{number,customerId:plan.order.customerId,vehicleId:plan.order.vehicleId,employeeId:plan.order.employeeId,status:'waiting',
      subtotalCents:plan.receipt.amountCents,discountCents:0,totalCents:plan.receipt.amountCents,scheduledAt:plan.booking.startsAt,promisedAt:plan.booking.endsAt,
      notes:`Reserva pública ${plan.booking.reference}`,checklistJson:'[]',invoiceId:null,deliveredAt:null,settledAt:plan.receipt.receivedAt});
    await db.prepare(`INSERT INTO order_items(id,order_id,service_id,name,quantity,unit_price_cents,duration_minutes,commission_bps,line_total_cents,discount_cents,net_cents,commission_cents,position)
      VALUES(?,?,?,?,1,?,?,?,?,0,?,?,0)`).run(randomUUID(),order.id,plan.order.operationalServiceId,plan.order.serviceName,plan.receipt.amountCents,plan.order.durationMinutes,
      plan.order.commissionBps,plan.receipt.amountCents,plan.receipt.amountCents,plan.order.commissionCents);
    const paymentId=randomUUID();
    await db.prepare(`INSERT INTO payments(id,source,source_id,customer_id,amount_cents,method,reference,created_at)
      VALUES(?,'order',?,?,?,'pix',?,?)`).run(paymentId,order.id,plan.order.customerId,plan.receipt.amountCents,`Reserva ${plan.booking.reference} Pix ${plan.receipt.endToEndId}`,plan.receipt.receivedAt);
    await db.prepare('INSERT INTO payment_allocations(payment_id,order_id,amount_cents) VALUES(?,?,?)').run(paymentId,order.id,plan.receipt.amountCents);
    const linked=await db.prepare('UPDATE jk_booking_advances SET order_id=?,payment_id=?,fulfilled_by=?,fulfilled_at=? WHERE booking_id=? AND payment_id IS NULL AND order_id IS NULL')
      .run(order.id,paymentId,options.actorId,now(),plan.booking.id);
    assert(linked.changes===1,409,'ALREADY_FULFILLED','A reserva já possui uma OS.');
    const changed=await db.prepare('UPDATE jk_booking_reservations SET version=version+1 WHERE id=? AND version=?').run(plan.booking.id,normalized.bookingVersion);
    assert(changed.changes===1,409,'BOOKING_VERSION_CONFLICT','A reserva mudou. Atualize a prévia.');
    await audit(db,{actorId:options.actorId,action:'jk.booking.fulfilled',resourceType:'order',resourceId:order.id,
      metadata:{bookingId:plan.booking.id,paymentId,endToEndId:plan.receipt.endToEndId,amountCents:plan.receipt.amountCents,receivedAt:plan.receipt.receivedAt,commissionBps:plan.order.commissionBps}});
    return {bookingId:plan.booking.id,orderId:order.id,paymentId,amountCents:plan.receipt.amountCents,receivedAt:plan.receipt.receivedAt,endToEndId:plan.receipt.endToEndId,replayed:false};
  });
}

function range(input,required=true) {
  const has=input.start!==undefined||input.end!==undefined;
  assert(!required&&!has||validStamp(input.start)&&validStamp(input.end)&&input.end>input.start,422,'INVALID_PERIOD','Informe o início e o fim do período em UTC.');
  return has?{sql:' AND a.received_at>=? AND a.received_at<?',params:[input.start,input.end]}:{sql:'',params:[]};
}
export async function bookingUnallocatedReceivedCents(db,input) {
  keys(input,['start','end']);const filter=range(input),statement=db.prepare(`SELECT COALESCE(SUM(a.amount_cents),0) AS amount FROM jk_booking_advances a WHERE a.payment_id IS NULL${filter.sql}`);
  statement.setReadBigInts(true);return safe((await statement.get(...filter.params)).amount);
}
export async function bookingAdvanceSummary(db,input) {
  keys(input,['start','end']);const filter=range(input),statement=db.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(a.amount_cents),0) AS grossReceivedCents,
    COALESCE(SUM(CASE WHEN a.payment_id IS NULL THEN a.amount_cents ELSE 0 END),0) AS unallocatedReceivedCents,
    COALESCE(SUM(CASE WHEN a.payment_id IS NOT NULL THEN a.amount_cents ELSE 0 END),0) AS allocatedReceivedCents,
    COALESCE(SUM(CASE WHEN b.financial_status='review' THEN a.amount_cents ELSE 0 END),0) AS reviewReceivedCents,
    COALESCE(SUM(CASE WHEN b.financial_status='refund_pending' THEN a.amount_cents ELSE 0 END),0) AS refundPendingCents
    FROM jk_booking_advances a JOIN jk_booking_reservations b ON b.id=a.booking_id WHERE 1=1${filter.sql}`);
  statement.setReadBigInts(true);return Object.fromEntries(Object.entries(await statement.get(...filter.params)).map(([key,value])=>[key,safe(value)]));
}
export async function bookingAdvanceRows(db,input={}) {
  keys(input,['start','end','limit','offset','unallocatedOnly']);const filter=range(input,false),limit=v.integer(input.limit??25,'limit',{min:1,max:500}),offset=v.integer(input.offset??0,'offset',{min:0,max:1_000_000});
  assert(input.unallocatedOnly===undefined||typeof input.unallocatedOnly==='boolean',422,'INVALID_INPUT','Revise o filtro de antecipações.');
  const where=`WHERE 1=1${filter.sql}${input.unallocatedOnly?' AND a.payment_id IS NULL':''}`;
  return db.read(async()=>{
    const total=safe((await db.prepare(`SELECT COUNT(*) AS total FROM jk_booking_advances a ${where}`).get(...filter.params)).total);
    const rows=await db.prepare(`SELECT a.*,b.reference,b.status AS booking_status,b.financial_status,b.service_name,b.starts_at
      FROM jk_booking_advances a JOIN jk_booking_reservations b ON b.id=a.booking_id ${where} ORDER BY a.received_at DESC,a.end_to_end_id LIMIT ? OFFSET ?`).all(...filter.params,limit,offset);
    return {items:rows.map(row=>({endToEndId:row.end_to_end_id,bookingId:row.booking_id,reference:row.reference,customerName:'Reserva pública',source:'booking',method:'pix',
      amountCents:row.amount_cents,receivedAt:row.received_at,recordedAt:row.recorded_at,bookingStatus:row.booking_status,financialStatus:row.financial_status,
      serviceName:row.service_name,startsAt:row.starts_at,orderId:row.order_id,paymentId:row.payment_id,cashMovementId:row.cash_movement_id,fulfilledAt:row.fulfilled_at})),page:{limit,offset,total}};
  });
}
