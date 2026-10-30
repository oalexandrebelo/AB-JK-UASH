import {randomUUID,randomBytes,createHmac} from 'node:crypto';
import {transaction} from './db.mjs';
import {assert} from './errors.mjs';
import {readJkTransition} from './jk-transition.mjs';
import {bookingNow,bookingHash,bookingKeys,bookingSecret,bookingPhone,requireBookingIdentity} from './jk-booking-identity.mjs';

const CATEGORIES=['small','medium','large','motorcycle'];
const DEFAULT_POLICY={version:1,enabled:false,capacity:0,capacityReviewed:false,legalReviewed:false,arrivalRuleReviewed:false,termsVersion:'',timezone:'America/Sao_Paulo',slotStepMinutes:null,minimumNoticeMinutes:null,horizonDays:null,holdMinutes:null,businessWhatsapp:'',hours:[],services:[]};
const localFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const iso=value=>new Date(value).toISOString();
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const short=(value,min=1,max=100)=>typeof value==='string'&&value.trim().length>=min&&value.length<=max;
const tokenFor=(row,runtime)=>createHmac('sha256',bookingSecret(runtime)).update('reservation:'+row.token_nonce).digest('base64url');
const currentPolicy=async db=>JSON.parse((await db.prepare('SELECT value_json FROM jk_booking_policy WHERE id=1').get()).value_json);
const minute=value=>Number(value.slice(0,2))*60+Number(value.slice(3));
const validTime=value=>typeof value==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/u.test(value);

export function initializeJkBooking(raw){transaction(raw,()=>{
 raw.exec(`
 CREATE TABLE IF NOT EXISTS jk_booking_policy(id INTEGER PRIMARY KEY CHECK(id=1),value_json TEXT NOT NULL) STRICT;
 CREATE TABLE IF NOT EXISTS jk_booking_reservations(
  id TEXT PRIMARY KEY,reference TEXT NOT NULL UNIQUE,identity_id TEXT NOT NULL REFERENCES jk_booking_identities(id),
  token_nonce TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,
  service_id TEXT NOT NULL,service_name TEXT NOT NULL,category TEXT NOT NULL,duration_minutes INTEGER NOT NULL,amount_cents INTEGER NOT NULL,
  starts_at TEXT NOT NULL,ends_at TEXT NOT NULL,hold_expires_at TEXT NOT NULL,policy_json TEXT NOT NULL,
  account_scope TEXT NOT NULL,environment TEXT NOT NULL,provider_reference TEXT,pix_payload TEXT,payment_lease_until INTEGER NOT NULL DEFAULT 0,next_reconcile_at INTEGER NOT NULL DEFAULT 0,last_reconciled_at INTEGER,
  status TEXT NOT NULL CHECK(status IN ('holding','awaiting_payment','confirmed','arrived','no_show','cancelled','expired')),
  financial_status TEXT NOT NULL CHECK(financial_status IN ('pending','received','review','refund_pending','refunded')),
  version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,UNIQUE(identity_id,idempotency_key)
 ) STRICT;
 CREATE INDEX IF NOT EXISTS jk_booking_interval ON jk_booking_reservations(starts_at,ends_at,status);
 CREATE UNIQUE INDEX IF NOT EXISTS jk_booking_charge ON jk_booking_reservations(account_scope,provider_reference) WHERE provider_reference IS NOT NULL;
 CREATE TABLE IF NOT EXISTS jk_booking_receipts(end_to_end_id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE REFERENCES jk_booking_reservations(id),amount_cents INTEGER NOT NULL,received_at TEXT NOT NULL,evidence_hash TEXT NOT NULL) STRICT;
 CREATE TABLE IF NOT EXISTS jk_booking_strikes(booking_id TEXT PRIMARY KEY REFERENCES jk_booking_reservations(id),identity_id TEXT NOT NULL REFERENCES jk_booking_identities(id),active INTEGER NOT NULL CHECK(active IN (0,1))) STRICT;
 CREATE TABLE IF NOT EXISTS jk_booking_events(id TEXT PRIMARY KEY,booking_id TEXT REFERENCES jk_booking_reservations(id),actor_id TEXT REFERENCES users(id),action TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
 `);
 raw.prepare('INSERT OR IGNORE INTO jk_booking_policy VALUES(1,?)').run(JSON.stringify(DEFAULT_POLICY));
 });}
async function requireNormal(db){assert((await readJkTransition(db)).mode==='normal',409,'PARALLEL_READONLY','A agenda está em consulta paralela.');}
async function actor(db,actorId,admin=false){const row=typeof actorId==='string'?await db.prepare('SELECT role FROM users WHERE id=? AND active=1').get(actorId):null;assert(row&&(admin?row.role==='admin':['admin','manager','operator'].includes(row.role)),403,admin?'ADMIN_REQUIRED':'OPERATOR_REQUIRED','Seu perfil não permite esta operação.');}
async function event(db,bookingId,action,runtime,actorId=null,reason=''){await db.prepare('INSERT INTO jk_booking_events VALUES(?,?,?,?,?,?)').run(randomUUID(),bookingId,actorId,action,reason,iso(bookingNow(runtime)));}
function reasons(policy,runtime){const result=[];if(!policy.enabled)result.push('POLICY_DISABLED');if(!/^\+[1-9]\d{7,14}$/u.test(policy.businessWhatsapp))result.push('WHATSAPP_CONTACT_REQUIRED');if(!runtime?.otp?.enabled||typeof runtime.otp.send!=='function'||!Buffer.isBuffer(runtime.secret)||runtime.secret.length<32)result.push('IDENTITY_PROVIDER_UNAVAILABLE');if(!runtime?.pix?.enabled||runtime.pix.environment!=='production'||!short(runtime.pix.scope)||typeof runtime.pix.create!=='function'||typeof runtime.pix.reconcile!=='function')result.push('PAYMENT_PROVIDER_UNAVAILABLE');if(runtime?.receiptRegistryReady!==true)result.push('RECEIPT_REGISTRY_UNAVAILABLE');if(runtime?.financialLedgerReady!==true||typeof runtime.recordBookingAdvance!=='function')result.push('FINANCIAL_LEDGER_UNAVAILABLE');if(runtime?.attendanceAutomationReady!==true)result.push('ATTENDANCE_AUTOMATION_UNAVAILABLE');if(!policy.capacityReviewed||!policy.legalReviewed||!policy.arrivalRuleReviewed||policy.capacity<1||!policy.services.length||!policy.hours.length)result.push('POLICY_REVIEW_REQUIRED');return result;}
function requireOpen(policy,runtime){assert(reasons(policy,runtime).length===0,503,'BOOKING_CLOSED','A agenda online ainda não está disponível.');}
export async function bookingPolicy(db,runtime){const policy=await currentPolicy(db);return {policy,closedReasons:reasons(policy,runtime)};}

function validatePolicy(input){
 bookingKeys(input,Object.keys(DEFAULT_POLICY));assert(integer(input.version,1,1e9)&&typeof input.enabled==='boolean'&&typeof input.capacityReviewed==='boolean'&&typeof input.legalReviewed==='boolean'&&typeof input.arrivalRuleReviewed==='boolean'&&input.timezone==='America/Sao_Paulo'&&integer(input.capacity,0,20)&&Array.isArray(input.hours)&&input.hours.length<=21&&Array.isArray(input.services)&&input.services.length<=100,422,'INVALID_POLICY','Revise os dados da agenda.');
 const bounds={slotStepMinutes:[1,60],minimumNoticeMinutes:[0,10080],horizonDays:[1,90],holdMinutes:[1,30]};for(const [key,[min,max]]of Object.entries(bounds))assert((!input.enabled&&input[key]===null)||integer(input[key],min,max),422,'INVALID_POLICY','Informe os prazos e intervalos revisados.');
 assert(short(input.termsVersion,input.enabled?1:0,80)&&typeof input.businessWhatsapp==='string',422,'INVALID_POLICY','Revise os termos e o contato.');if(input.businessWhatsapp)bookingPhone(input.businessWhatsapp);
 const seen=new Set();for(const item of input.services){bookingKeys(item,['id','name','category','durationMinutes','amountCents']);assert(short(item.id,1,80)&&/^[A-Za-z0-9_-]+$/u.test(item.id)&&short(item.name)&&CATEGORIES.includes(item.category)&&integer(item.durationMinutes,1,480)&&integer(item.amountCents,1,1e9)&&!seen.has(item.id+':'+item.category),422,'INVALID_POLICY','Cada serviço precisa de categoria, preço e duração revisados.');seen.add(item.id+':'+item.category);}
 const hours=[];for(const h of input.hours){bookingKeys(h,['weekday','start','end']);assert(integer(h.weekday,0,6)&&validTime(h.start)&&validTime(h.end)&&minute(h.start)<minute(h.end)&&!hours.some(p=>p.weekday===h.weekday&&p.start<h.end&&p.end>h.start),422,'INVALID_POLICY','Revise os horários de atendimento.');hours.push(h);}
 if(input.enabled)assert(input.capacity>0&&Boolean(input.businessWhatsapp)&&input.capacityReviewed&&input.legalReviewed&&input.arrivalRuleReviewed&&input.hours.length>0&&input.services.length>0,422,'INVALID_POLICY','Confirme capacidade dedicada, horários, serviços e política antes de abrir a agenda.');
 return JSON.parse(JSON.stringify(input));
}
export async function configureJkBooking(db,input,{actorId,authorize}={},runtime){const next=validatePolicy(input);return db.transaction(async()=>{if(authorize)await authorize();await actor(db,actorId,true);if(next.enabled)await requireNormal(db);const prior=await currentPolicy(db);assert(next.version===prior.version,409,'VERSION_CONFLICT','A configuração mudou. Atualize a página.');next.version++;await db.prepare('UPDATE jk_booking_policy SET value_json=? WHERE id=1').run(JSON.stringify(next));await event(db,null,'policy_updated',runtime,actorId);return {policy:next,closedReasons:reasons(next,runtime)};});}
export async function bookingCatalog(db,runtime){const policy=await currentPolicy(db),closedReasons=reasons(policy,runtime);return {enabled:closedReasons.length===0,closedReasons,policyVersion:policy.version,termsVersion:policy.termsVersion,arrivalMinutesBefore:10,noShowLimit:2,services:policy.services};}

function serviceFor(policy,input){const service=policy.services.find(s=>s.id===input.serviceId&&s.category===input.category);assert(service,422,'SERVICE_UNAVAILABLE','Selecione um serviço e uma categoria disponíveis.');return service;}
function localParts(timestamp){const parts=localFormatter.formatToParts(new Date(timestamp));const get=type=>parts.find(p=>p.type===type).value;const date=`${get('year')}-${get('month')}-${get('day')}`;return {date,minute:Number(get('hour'))*60+Number(get('minute')),weekday:new Date(date+'T12:00:00Z').getUTCDay()};}
function slotValid(policy,service,start,now){
 if(!Number.isFinite(start)||start%60000!==0||start<=now+10*60000||start<now+policy.minimumNoticeMinutes*60000||start>now+policy.horizonDays*86400000)return false;
 const local=localParts(start),end=localParts(start+service.durationMinutes*60000);return local.date===end.date&&policy.hours.some(h=>h.weekday===local.weekday&&local.minute>=minute(h.start)&&end.minute<=minute(h.end)&&(local.minute-minute(h.start))%policy.slotStepMinutes===0);
}
async function remaining(db,policy,start,end,now){
 const rows=await db.prepare("SELECT starts_at,ends_at FROM jk_booking_reservations WHERE starts_at<? AND ends_at>? AND (status IN ('confirmed','arrived') OR (status IN ('holding','awaiting_payment') AND hold_expires_at>?))").all(iso(end),iso(start),iso(now));
 return remainingFrom(rows,policy.capacity,start,end);
}
function remainingFrom(rows,capacity,start,end){
 const events=rows.filter(r=>Date.parse(r.starts_at)<end&&Date.parse(r.ends_at)>start).flatMap(r=>[[Math.max(start,Date.parse(r.starts_at)),1],[Math.min(end,Date.parse(r.ends_at)),-1]]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);let current=0,max=0;for(const [,delta]of events){current+=delta;max=Math.max(max,current);}return Math.max(0,capacity-max);
}
export async function bookingAvailability(db,input,runtime){
 bookingKeys(input,['date','serviceId','category']);assert(typeof input.date==='string'&&/^\d{4}-\d{2}-\d{2}$/u.test(input.date)&&Number.isFinite(Date.parse(input.date+'T12:00:00Z'))&&iso(Date.parse(input.date+'T12:00:00Z')).slice(0,10)===input.date,422,'INVALID_DATE','Informe uma data válida.');
 return db.read(async()=>{const policy=await currentPolicy(db),closedReasons=reasons(policy,runtime),result={date:input.date,timezone:policy.timezone,closedReasons,slots:[]};if(closedReasons.length)return result;const service=serviceFor(policy,input),now=bookingNow(runtime);
 const base=Date.parse(input.date+'T00:00:00Z')-12*3600000,until=base+48*3600000;
 const occupied=await db.prepare("SELECT starts_at,ends_at FROM jk_booking_reservations WHERE starts_at<? AND ends_at>? AND (status IN ('confirmed','arrived') OR (status IN ('holding','awaiting_payment') AND hold_expires_at>?))").all(iso(until),iso(base),iso(now));
 for(let start=base;start<until;start+=60000){if(localParts(start).date!==input.date||!slotValid(policy,service,start,now))continue;const end=start+service.durationMinutes*60000,free=remainingFrom(occupied,policy.capacity,start,end);if(free)result.slots.push({startsAt:iso(start),endsAt:iso(end),remaining:free});}return result;});
}
function publicReservation(row){const expired=['holding','awaiting_payment'].includes(row.status)&&row._now>=Date.parse(row.hold_expires_at),policy=JSON.parse(row.policy_json);return {id:row.id,reference:row.reference,status:expired?'expired':row.status,financialStatus:row.financial_status,startsAt:row.starts_at,endsAt:row.ends_at,holdExpiresAt:row.hold_expires_at,arrivalDeadline:iso(Date.parse(row.starts_at)-10*60000),amountCents:row.amount_cents,serviceName:row.service_name,category:row.category,version:row.version,pixCopiaECola:!expired&&row.financial_status==='pending'&&['holding','awaiting_payment'].includes(row.status)?row.pix_payload:null,whatsappUrl:row.status==='confirmed'&&row.financial_status==='received'&&policy.businessWhatsapp?`https://wa.me/${policy.businessWhatsapp.slice(1)}?text=${encodeURIComponent('Minha reserva '+row.reference+' está confirmada para '+row.starts_at+'.')}`:null};}
async function reservation(db,token,runtime){assert(typeof token==='string'&&/^[A-Za-z0-9_-]{43}$/u.test(token),401,'RESERVATION_REQUIRED','Abra sua reserva ou confirme novamente seu telefone.');const row=await db.prepare('SELECT * FROM jk_booking_reservations WHERE token_hash=?').get(bookingHash(token));assert(row,401,'RESERVATION_REQUIRED','Abra sua reserva ou confirme novamente seu telefone.');return {...row,_now:bookingNow(runtime)};}
async function expire(db,row,runtime){if(['holding','awaiting_payment'].includes(row.status)&&Date.parse(row.hold_expires_at)<=bookingNow(runtime)){await db.prepare("UPDATE jk_booking_reservations SET status='expired',version=version+1 WHERE id=?").run(row.id);row.status='expired';row.version++;}}
export async function getBookingReservation(db,token,runtime){return db.read(async()=>({reservation:publicReservation(await reservation(db,token,runtime))}));}
export async function listOwnBookingReservations(db,input,runtime){bookingKeys(input,['identityToken','limit','offset']);const limit=input.limit??25,offset=input.offset??0;assert(integer(limit,1,100)&&integer(offset,0,100000),422,'INVALID_INPUT','Revise a paginação.');return db.read(async()=>{const identity=await requireBookingIdentity(db,input.identityToken,runtime),rows=await db.prepare('SELECT * FROM jk_booking_reservations WHERE identity_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').all(identity.id,limit,offset),total=(await db.prepare('SELECT count(*) n FROM jk_booking_reservations WHERE identity_id=?').get(identity.id)).n;return {items:rows.map(row=>({reservationToken:tokenFor(row,runtime),reservation:publicReservation({...row,_now:bookingNow(runtime)})})),page:{limit,offset,total}};});}
export async function listAdminBookingReservations(db,input,{actorId,authorize}={},runtime){
 bookingKeys(input,['limit','offset','date','status']);const limit=input.limit??25,offset=input.offset??0,date=input.date??'',status=input.status??'';assert(integer(limit,1,100)&&integer(offset,0,100000)&&(!date||/^\d{4}-\d{2}-\d{2}$/u.test(date)&&Number.isFinite(Date.parse(date+'T12:00:00Z'))&&iso(Date.parse(date+'T12:00:00Z')).slice(0,10)===date)&&['','holding','awaiting_payment','confirmed','arrived','no_show','cancelled','expired'].includes(status),422,'INVALID_INPUT','Revise os filtros.');
 return db.read(async()=>{if(authorize)await authorize();await actor(db,actorId);const from=date?iso(Date.parse(date+'T00:00:00-03:00')):'',until=date?iso(Date.parse(from)+86400000):'';const where="FROM jk_booking_reservations WHERE (?='' OR (starts_at>=? AND starts_at<?)) AND (?='' OR status=?)",args=[date,from,until,status,status],rows=await db.prepare(`SELECT * ${where} ORDER BY starts_at,id LIMIT ? OFFSET ?`).all(...args,limit,offset),total=(await db.prepare(`SELECT count(*) n ${where}`).get(...args)).n;return {items:rows.map(row=>publicReservation({...row,_now:bookingNow(runtime)})),page:{limit,offset,total}};});
}

export async function createBookingHold(db,input,runtime){
 bookingKeys(input,['identityToken','serviceId','category','startsAt','policyVersion','termsVersion','attendanceAccepted','idempotencyKey']);assert(short(input.idempotencyKey,8,128)&&/^[A-Za-z0-9_-]+$/u.test(input.idempotencyKey)&&typeof input.startsAt==='string'&&Number.isFinite(Date.parse(input.startsAt))&&iso(Date.parse(input.startsAt))===input.startsAt,422,'INVALID_INPUT','Revise o horário solicitado.');
 return db.transaction(async()=>{
  await requireNormal(db);const policy=await currentPolicy(db);requireOpen(policy,runtime);const identity=await requireBookingIdentity(db,input.identityToken,runtime),now=bookingNow(runtime);const blocked=await db.prepare('SELECT count(*) n FROM jk_booking_strikes WHERE identity_id=? AND active=1').get(identity.id);assert(blocked.n<2,403,'BOOKING_BLOCKED','Após duas faltas, fale com nossa equipe para revisar sua liberação.');
  const requestHash=bookingHash(JSON.stringify([input.serviceId,input.category,input.startsAt,input.policyVersion,input.termsVersion,input.attendanceAccepted]));const prior=await db.prepare('SELECT * FROM jk_booking_reservations WHERE identity_id=? AND idempotency_key=?').get(identity.id,input.idempotencyKey);if(prior){assert(prior.request_hash===requestHash,409,'IDEMPOTENCY_CONFLICT','Esta solicitação já foi usada com outro conteúdo.');return {reservationToken:tokenFor(prior,runtime),reservation:publicReservation({...prior,_now:now})};}
  assert(input.policyVersion===policy.version&&input.termsVersion===policy.termsVersion&&input.attendanceAccepted===true,409,'POLICY_CHANGED','Os serviços ou termos mudaram. Revise antes de reservar.');
  const service=serviceFor(policy,input),start=Date.parse(input.startsAt),end=start+service.durationMinutes*60000;assert(slotValid(policy,service,start,now)&&await remaining(db,policy,start,end,now)>0,409,'SLOT_UNAVAILABLE','Esse horário não está mais disponível.');
  const pending=await db.prepare("SELECT id FROM jk_booking_reservations WHERE identity_id=? AND status IN ('holding','awaiting_payment') AND hold_expires_at>? LIMIT 1").get(identity.id,iso(now));assert(!pending,409,'BOOKING_PENDING','Conclua ou cancele sua reserva em andamento.');
  const id=randomUUID(),nonce=randomBytes(32).toString('base64url'),token=tokenFor({token_nonce:nonce},runtime);await db.prepare(`INSERT INTO jk_booking_reservations(id,reference,identity_id,token_nonce,token_hash,idempotency_key,request_hash,service_id,service_name,category,duration_minutes,amount_cents,starts_at,ends_at,hold_expires_at,policy_json,account_scope,environment,status,financial_status,created_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'holding','pending',?)`).run(id,id.replaceAll('-','').slice(0,12).toUpperCase(),identity.id,nonce,bookingHash(token),input.idempotencyKey,requestHash,service.id,service.name,service.category,service.durationMinutes,service.amountCents,iso(start),iso(end),iso(Math.min(now+policy.holdMinutes*60000,start-10*60000)),JSON.stringify(policy),runtime.pix.scope,runtime.pix.environment,iso(now));await event(db,id,'held',runtime);return {reservationToken:token,reservation:publicReservation({...await db.prepare('SELECT * FROM jk_booking_reservations WHERE id=?').get(id),_now:now})};
 });
}

export async function createBookingPix(db,input,runtime){
 bookingKeys(input,['reservationToken','customerInput']);bookingKeys(input.customerInput,['name','cpfCnpj']);assert(short(input.customerInput.name,2,100)&&typeof input.customerInput.cpfCnpj==='string'&&/^(?:\d{11}|[A-Za-z0-9]{12}\d{2})$/u.test(input.customerInput.cpfCnpj),422,'INVALID_INPUT','Revise os dados exigidos para o Pix.');
 const claim=await db.transaction(async()=>{await requireNormal(db);const row=await reservation(db,input.reservationToken,runtime);await expire(db,row,runtime);requireOpen(await currentPolicy(db),runtime);assert(row.account_scope===runtime.pix.scope&&row.environment===runtime.pix.environment,409,'PAYMENT_REVIEW','A conta de pagamento mudou. Fale com nossa equipe.');if(row.provider_reference&&row.pix_payload)return {cached:publicReservation(row)};assert(['holding','awaiting_payment'].includes(row.status),409,'PAYMENT_REVIEW','Esta reserva não pode gerar uma nova cobrança.');assert(row.payment_lease_until<=bookingNow(runtime),409,'PAYMENT_IN_PROGRESS','A cobrança está sendo preparada.');const identity=await db.prepare('SELECT * FROM jk_booking_identities WHERE id=?').get(row.identity_id);await db.prepare('UPDATE jk_booking_reservations SET payment_lease_until=? WHERE id=?').run(bookingNow(runtime)+45000,row.id);return {row,identity};});
 if(claim.cached)return {reservation:claim.cached};let result;try{result=await runtime.pix.create({bookingId:claim.row.id,identityId:claim.identity.id,phone:claim.identity.phone,customerInput:input.customerInput,amountCents:claim.row.amount_cents,idempotencyKey:'booking-'+claim.row.id,dueDate:localParts(bookingNow(runtime)).date,expectedScope:claim.row.account_scope},{signal:AbortSignal.timeout(30000)});}catch{result={state:'UNKNOWN',data:{}};}
 return db.transaction(async()=>{const row=await reservation(db,input.reservationToken,runtime);await expire(db,row,runtime);const data=result?.data;const safe=result?.state==='SUCCEEDED'&&data?.bookingId===row.id&&data.scope===row.account_scope&&data.environment===row.environment&&data.paymentConfirmed===false&&short(result.providerReference,1,128)&&short(data.pixCopiaECola,1,10000);await db.prepare('UPDATE jk_booking_reservations SET provider_reference=COALESCE(?,provider_reference),pix_payload=?,financial_status=?,status=?,payment_lease_until=0,version=version+1 WHERE id=?').run(short(result?.providerReference,1,128)?result.providerReference:null,safe?data.pixCopiaECola:null,safe?row.financial_status:'review',safe&&row.status==='holding'?'awaiting_payment':row.status,row.id);await event(db,row.id,safe?'pix_created':'pix_uncertain',runtime);return {reservation:publicReservation({...await db.prepare('SELECT * FROM jk_booking_reservations WHERE id=?').get(row.id),_now:bookingNow(runtime)})};});
}

export async function reconcileBookingPix(db,input,runtime){
 bookingKeys(input,['reservationToken']);const row=await reservation(db,input.reservationToken,runtime);
 assert(runtime?.pix?.enabled===true&&runtime.pix.scope===row.account_scope&&runtime.pix.environment===row.environment&&row.provider_reference,409,'PAYMENT_REVIEW','Não foi possível consultar esta cobrança.');
 const claimed=await db.transaction(async()=>{const latest=await db.prepare('SELECT * FROM jk_booking_reservations WHERE id=?').get(row.id);if(latest.payment_lease_until>bookingNow(runtime))return false;await db.prepare('UPDATE jk_booking_reservations SET payment_lease_until=?,next_reconcile_at=? WHERE id=?').run(bookingNow(runtime)+45000,bookingNow(runtime)+60000,row.id);return true;});if(!claimed)return {reservation:publicReservation(row)};
 const prior=await db.prepare('SELECT received_at FROM jk_booking_receipts WHERE booking_id=?').get(row.id),now=bookingNow(runtime),received=prior?Date.parse(prior.received_at):null;
 const start=iso(prior?Math.max(Date.parse(row.created_at),received-60000):Math.max(Date.parse(row.created_at),now-31*86400000)),end=iso(prior?Math.min(now,received+60000):now);
 let result;try{result=await runtime.pix.reconcile({bookingId:row.id,txid:row.provider_reference,amountCents:row.amount_cents,start,end,idempotencyKey:'reconcile-'+row.id,expectedScope:row.account_scope},{signal:AbortSignal.timeout(30000)});}
 catch{await db.prepare('UPDATE jk_booking_reservations SET payment_lease_until=0,next_reconcile_at=? WHERE id=?').run(bookingNow(runtime)+60000,row.id);return getBookingReservation(db,input.reservationToken,runtime);}
 return applyBookingPaymentEvidence(db,result?.data?.bookingId===row.id?{...result.data,providerReference:result.providerReference,state:result.state}:{bookingId:row.id,state:'REJECTED'},runtime);
}
export async function reconcileBookingPixById(db,bookingId,runtime){const row=await db.prepare('SELECT * FROM jk_booking_reservations WHERE id=?').get(bookingId);assert(row,404,'RESERVATION_NOT_FOUND','Reserva não encontrada.');return reconcileBookingPix(db,{reservationToken:tokenFor(row,runtime)},runtime);}
export async function dueBookingPayments(db,runtime,{limit=10}={}){assert(integer(limit,1,10),422,'INVALID_INPUT','Lote de consulta inválido.');return db.prepare("SELECT id FROM jk_booking_reservations WHERE account_scope=? AND environment=? AND provider_reference IS NOT NULL AND financial_status<>'refunded' AND next_reconcile_at<=? AND payment_lease_until<=? ORDER BY next_reconcile_at,created_at,id LIMIT ?").all(runtime.pix.scope,runtime.pix.environment,bookingNow(runtime),bookingNow(runtime),limit);}
export async function recoverBookingChargeReferences(db,runtime){
 return db.transaction(async()=>{const exists=await db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='jk_booking_pix_journal'").get();if(!exists)return {recovered:0};
 const rows=await db.prepare(`SELECT r.id,j.txid FROM jk_booking_reservations r JOIN jk_booking_pix_journal j ON j.booking_id=r.id AND j.scope=r.account_scope AND j.amount_cents=r.amount_cents WHERE r.provider_reference IS NULL AND r.payment_lease_until<=? LIMIT 100`).all(bookingNow(runtime));
 for(const row of rows){await db.prepare("UPDATE jk_booking_reservations SET provider_reference=?,financial_status='review',version=version+1 WHERE id=?").run(row.txid,row.id);await event(db,row.id,'pix_reference_recovered',runtime);}return {recovered:rows.length};});
}
export async function applyBookingPaymentEvidence(db,evidence,runtime){
 return db.transaction(async()=>{
  const row=typeof evidence?.bookingId==='string'?await db.prepare('SELECT * FROM jk_booking_reservations WHERE id=?').get(evidence.bookingId):null;
  assert(row,422,'PAYMENT_REVIEW','A evidência não identifica a reserva.');await expire(db,row,runtime);
  const receipt=evidence.receipts?.[0],prior=await db.prepare('SELECT * FROM jk_booking_receipts WHERE booking_id=?').get(row.id);
  const trusted=evidence.state==='SUCCEEDED'&&evidence.evidenceSource==='authenticated-polling'&&evidence.environment==='production'&&row.environment==='production'
   &&evidence.scope===row.account_scope&&runtime?.pix?.scope===row.account_scope&&runtime?.receiptRegistryReady===true&&evidence.providerReference===row.provider_reference
   &&evidence.asaasPaymentStatus==='RECEIVED'&&evidence.chargeStatus==='CONCLUIDA'&&['CONFIRMED','PARTIAL','REVIEW'].includes(evidence.receiptStatus)
   &&Array.isArray(evidence.receipts)&&evidence.receipts.length===1&&receipt.amountCents===row.amount_cents&&integer(receipt.refundedCents,0,receipt.amountCents)
   &&typeof receipt.refundPending==='boolean'&&evidence.refundedCents===receipt.refundedCents&&evidence.receivedCents===receipt.amountCents-receipt.refundedCents
   &&/^E[A-Za-z0-9]{31}$/u.test(receipt.endToEndId)&&Number.isFinite(Date.parse(receipt.receivedAt))&&Date.parse(receipt.receivedAt)>=Date.parse(row.created_at)
   &&Date.parse(receipt.receivedAt)<=bookingNow(runtime)&&Number.isFinite(Date.parse(evidence.observedAt))&&Date.parse(evidence.observedAt)>=Date.parse(receipt.receivedAt)
   &&Date.parse(evidence.observedAt)<=bookingNow(runtime)+30000&&/^[a-f0-9]{64}$/u.test(evidence.evidenceHash);
  let conflict=false;
  if(trusted){
   const other=await db.prepare('SELECT booking_id FROM jk_booking_receipts WHERE end_to_end_id=?').get(receipt.endToEndId),operational=await db.prepare('SELECT end_to_end_id FROM jk_pix_receipts WHERE end_to_end_id=?').get(receipt.endToEndId);
   conflict=Boolean(operational||other&&other.booking_id!==row.id||prior&&(prior.end_to_end_id!==receipt.endToEndId||prior.amount_cents!==receipt.amountCents||Date.parse(prior.received_at)!==Date.parse(receipt.receivedAt)));
  }
  const confirmed=trusted&&!conflict&&evidence.paymentConfirmed===true&&evidence.receiptStatus==='CONFIRMED'&&receipt.refundedCents===0&&receipt.refundPending===false;
  if(trusted&&!conflict){
   assert(runtime?.financialLedgerReady===true&&typeof runtime.recordBookingAdvance==='function',503,'FINANCIAL_LEDGER_UNAVAILABLE','O registro financeiro do adiantamento ainda não está disponível.');
   if(!prior)await db.prepare('INSERT INTO jk_booking_receipts VALUES(?,?,?,?,?)').run(receipt.endToEndId,row.id,receipt.amountCents,receipt.receivedAt,evidence.evidenceHash);
   // The gross receipt is an advance even when late or already under refund review.
   // This hook must join this transaction; it must never call the bank or start another transaction.
   await runtime.recordBookingAdvance(db,{bookingId:row.id,endToEndId:receipt.endToEndId});
  }
  if(confirmed){
   const canConfirm=['holding','awaiting_payment'].includes(row.status)&&Date.parse(row.hold_expires_at)>bookingNow(runtime);
   const financial=canConfirm||['confirmed','arrived'].includes(row.status)?'received':row.status==='cancelled'?'refund_pending':'review';
   if(financial!==row.financial_status||canConfirm){await db.prepare('UPDATE jk_booking_reservations SET status=?,financial_status=?,version=version+1 WHERE id=?').run(canConfirm?'confirmed':row.status,financial,row.id);await event(db,row.id,canConfirm?'payment_confirmed':'payment_reviewed',runtime);}
  }else{
   const pending=evidence.state==='SUCCEEDED'&&evidence.evidenceSource==='authenticated-polling'&&evidence.scope===row.account_scope&&evidence.providerReference===row.provider_reference&&evidence.environment===row.environment&&evidence.receiptStatus==='PENDING'&&evidence.paymentConfirmed===false&&evidence.receivedCents===0&&evidence.refundedCents===0&&Array.isArray(evidence.receipts)&&evidence.receipts.length===0&&row.financial_status==='pending';
   if(!pending&&row.financial_status!=='review'){await db.prepare("UPDATE jk_booking_reservations SET financial_status='review',version=version+1 WHERE id=?").run(row.id);await event(db,row.id,'payment_requires_review',runtime);}
  }
  const next=bookingNow(runtime)+(Date.parse(row.ends_at)>bookingNow(runtime)?15000:3600000);await db.prepare('UPDATE jk_booking_reservations SET payment_lease_until=0,last_reconciled_at=?,next_reconcile_at=? WHERE id=?').run(bookingNow(runtime),next,row.id);
  return {reservation:publicReservation({...await db.prepare('SELECT * FROM jk_booking_reservations WHERE id=?').get(row.id),_now:bookingNow(runtime)})};
 });
}

export async function cancelBookingReservation(db,input,runtime){bookingKeys(input,['reservationToken','version']);return db.transaction(async()=>{const row=await reservation(db,input.reservationToken,runtime);assert(row.version===input.version,409,'VERSION_CONFLICT','A reserva mudou. Atualize a página.');if(await markDueNoShow(db,row,runtime))return {reservation:publicReservation({...row,_now:bookingNow(runtime)})};assert(!['arrived','no_show'].includes(row.status),409,'CANCELLATION_REVIEW','Fale com nossa equipe para revisar este cancelamento.');if(row.status==='cancelled')return {reservation:publicReservation(row)};const financial=row.financial_status==='received'?'refund_pending':row.financial_status;await db.prepare("UPDATE jk_booking_reservations SET status='cancelled',financial_status=?,version=version+1 WHERE id=?").run(financial,row.id);await event(db,row.id,'cancelled',runtime);return {reservation:publicReservation({...row,status:'cancelled',financial_status:financial,version:row.version+1})};});}
export async function recordBookingAttendance(db,input,{actorId,authorize}={},runtime){bookingKeys(input,['bookingId','version','action','reason']);assert(['arrived','no_show'].includes(input.action)&&short(input.reason,3,300),422,'INVALID_INPUT','Informe a situação e o motivo.');return db.transaction(async()=>{if(authorize)await authorize();await actor(db,actorId);await requireNormal(db);const row=await db.prepare('SELECT * FROM jk_booking_reservations WHERE id=?').get(input.bookingId);assert(row&&row.version===input.version,409,'VERSION_CONFLICT','A reserva mudou. Atualize a página.');assert(row.status==='confirmed'&&row.financial_status==='received',409,'ATTENDANCE_REVIEW','Revise a situação da reserva antes de registrar presença.');if(input.action==='arrived')assert(bookingNow(runtime)<=Date.parse(row.starts_at)-10*60000,409,'ARRIVAL_DEADLINE_PASSED','O prazo de chegada terminou. Solicite revisão administrativa se houver erro de registro.');if(input.action==='no_show'){assert(bookingNow(runtime)>Date.parse(row.starts_at)-10*60000,409,'NO_SHOW_TOO_EARLY','O prazo de chegada ainda não terminou.');await db.prepare('INSERT INTO jk_booking_strikes VALUES(?,?,1)').run(row.id,row.identity_id);}await db.prepare('UPDATE jk_booking_reservations SET status=?,financial_status=?,version=version+1 WHERE id=?').run(input.action,input.action==='no_show'?'review':'received',row.id);await event(db,row.id,input.action,runtime,actorId,input.reason);return {reservation:publicReservation({...row,status:input.action,financial_status:input.action==='no_show'?'review':'received',version:row.version+1,_now:bookingNow(runtime)})};});}
export async function reverseBookingNoShow(db,input,{actorId,authorize}={},runtime){bookingKeys(input,['bookingId','version','reason']);assert(short(input.reason,3,300),422,'INVALID_INPUT','Informe o motivo da revisão.');return db.transaction(async()=>{if(authorize)await authorize();await actor(db,actorId,true);await requireNormal(db);const row=await db.prepare('SELECT * FROM jk_booking_reservations WHERE id=?').get(input.bookingId);assert(row&&row.version===input.version,409,'VERSION_CONFLICT','A reserva mudou. Atualize a página.');const strike=await db.prepare('SELECT * FROM jk_booking_strikes WHERE booking_id=? AND active=1').get(row.id);assert(strike,409,'NO_SHOW_NOT_ACTIVE','Não há falta ativa para reverter.');await db.prepare('UPDATE jk_booking_strikes SET active=0 WHERE booking_id=?').run(row.id);await db.prepare("UPDATE jk_booking_reservations SET status='cancelled',version=version+1 WHERE id=?").run(row.id);await event(db,row.id,'no_show_reversed',runtime,actorId,input.reason);return {reservation:publicReservation({...row,status:'cancelled',version:row.version+1,_now:bookingNow(runtime)})};});}

async function markDueNoShow(db,row,runtime){
 if(row.status!=='confirmed'||row.financial_status!=='received'||Date.parse(row.starts_at)-10*60000>=bookingNow(runtime))return false;
 assert(JSON.parse(row.policy_json).arrivalRuleReviewed===true,409,'ARRIVAL_POLICY_REVIEW','A regra de chegada desta reserva precisa de revisão.');
 await db.prepare('INSERT INTO jk_booking_strikes VALUES(?,?,1)').run(row.id,row.identity_id);
 await db.prepare("UPDATE jk_booking_reservations SET status='no_show',financial_status='review',version=version+1 WHERE id=?").run(row.id);
 await event(db,row.id,'no_show',runtime,null,'Prazo de chegada de dez minutos antes do início encerrado sem check-in registrado.');
 row.status='no_show';row.financial_status='review';row.version++;return true;
}
export async function sweepBookingNoShows(db,runtime,{limit=100}={}){
 assert(runtime?.attendanceAutomationReady===true&&integer(limit,1,500),503,'BOOKING_AUTOMATION_CLOSED','A verificação automática de chegada não está habilitada.');
 return db.transaction(async()=>{await requireNormal(db);const rows=await db.prepare("SELECT * FROM jk_booking_reservations WHERE status='confirmed' AND financial_status='received' AND starts_at<? ORDER BY starts_at,id LIMIT ?").all(iso(bookingNow(runtime)+10*60000),limit);let marked=0;for(const row of rows)if(await markDueNoShow(db,row,runtime))marked++;return {marked};});
}
