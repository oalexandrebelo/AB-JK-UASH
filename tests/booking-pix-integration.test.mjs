import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, sqliteStore } from '../server/db.mjs';
import { migrateDomain, migrateStorage } from '../server/domain-schema.mjs';
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

import { initializeBookingIdentity, requestBookingOtp, verifyBookingOtp } from '../server/jk-booking-identity.mjs';
import { initializeJkBooking, configureJkBooking, createBookingHold, createBookingPix, reconcileBookingPix } from '../server/jk-booking.mjs';
import { initializeBookingFulfillment, recordBookingAdvance, bookingUnallocatedReceivedCents } from '../server/jk-booking-fulfillment.mjs';

test('booking domain and real Asaas adapter interoperate from verified identity to confirmed Pix',async t=>{
  const f=fixture(t),raw=openDatabase(':memory:');migrateDomain(raw);migrateStorage(raw);initializeBookingIdentity(raw);initializeJkBooking(raw);initializeBookingPix(raw);initializeBookingFulfillment(raw);
  raw.exec('CREATE TABLE jk_pix_receipts(end_to_end_id TEXT PRIMARY KEY)');
  raw.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('admin','Admin','admin@example.test','no-login','admin','2026-10-30','2026-10-30');
  const db=sqliteStore(raw);t.after(()=>db.close());const codes=[];
  const pix=new AsaasBookingGateway({...config,environment:'production',allowProduction:true},f.transport,db);
  const runtime={secret:Buffer.alloc(32,7),now:Date.now,receiptRegistryReady:true,attendanceAutomationReady:true,financialLedgerReady:true,pix,
    recordBookingAdvance:(db,input)=>recordBookingAdvance(db,input,{scope:pix.scope,environment:pix.environment}),
    otp:{enabled:true,async send(input){codes.push(input);return {accepted:true};}}};
  const policy={version:1,enabled:true,capacity:1,capacityReviewed:true,legalReviewed:true,arrivalRuleReviewed:true,termsVersion:'synthetic-reviewed',timezone:'America/Sao_Paulo',slotStepMinutes:15,minimumNoticeMinutes:15,horizonDays:30,holdMinutes:5,businessWhatsapp:'+5511888888888',
    hours:Array.from({length:7},(_,weekday)=>({weekday,start:'00:00',end:'23:59'})),services:[{id:'wash',name:'Serviço sintético revisado',category:'medium',durationMinutes:30,amountCents:12029}]};
  await configureJkBooking(db,policy,{actorId:'admin'},runtime);
  const challenge=await requestBookingOtp(db,{phone:request.phone,clientKey:'synthetic-integration'},runtime);
  const identity=await verifyBookingOtp(db,{challengeId:challenge.challengeId,code:codes[0].code},runtime);
  const startsAt=new Date(Date.now()+86400000);startsAt.setUTCHours(15,0,0,0);
  const hold=await createBookingHold(db,{identityToken:identity.identityToken,serviceId:'wash',category:'medium',startsAt:startsAt.toISOString(),policyVersion:2,termsVersion:policy.termsVersion,attendanceAccepted:true,idempotencyKey:'synthetic-integration-hold'},runtime);
  const charge=await createBookingPix(db,{reservationToken:hold.reservationToken,customerInput},runtime);
  assert.equal(charge.reservation.status,'awaiting_payment');assert.equal(f.provider.payments.length,1);
  const pending=await reconcileBookingPix(db,{reservationToken:hold.reservationToken},runtime);
  assert.equal(pending.reservation.status,'awaiting_payment');assert.equal(pending.reservation.financialStatus,'pending');
  Object.assign(f.provider.payments[0],{status:'RECEIVED',pixTransaction:f.provider.transaction.id});
  f.provider.transaction.effectiveDate=new Date().toISOString();
  const paid=await reconcileBookingPix(db,{reservationToken:hold.reservationToken},runtime);
  assert.equal(paid.reservation.status,'confirmed');assert.equal(paid.reservation.financialStatus,'received');assert.match(paid.reservation.whatsappUrl,/^https:\/\/wa.me\//u);
  await reconcileBookingPix(db,{reservationToken:hold.reservationToken},runtime);
  assert.equal(raw.prepare('SELECT count(*) n FROM jk_booking_receipts').get().n,1);
  assert.equal(raw.prepare('SELECT count(*) n FROM jk_pix_receipts').get().n,0);
  assert.equal(raw.prepare('SELECT count(*) n FROM cash_movements').get().n,1);
  assert.equal(raw.prepare('SELECT count(*) n FROM payments').get().n,0);
  const date=f.provider.transaction.effectiveDate.slice(0,10),start=date+'T00:00:00.000Z',end=new Date(Date.parse(start)+86400000).toISOString();
  assert.equal(await bookingUnallocatedReceivedCents(db,{start,end}),12029);
});
