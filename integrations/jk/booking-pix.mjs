import { createHash } from 'node:crypto';
import { AsaasPixAdapter, asaasAllowedHosts } from './asaas.mjs';
import { parseAsaasConfiguration } from './asaas-config.mjs';
import { SecureHttpTransport, TransportError } from './vendor/connectors/transport.mjs';
import { PixConnectorError, text } from './vendor/connectors/banking/validation.mjs';
import { readPrivateText } from './vendor/integrations/secrets.mjs';
import { validTaxId } from '../fiscal/payload.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(code,state='REJECTED')=>{throw new PixConnectorError(code,state);};
const only=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));
const cents=value=>Number.isSafeInteger(value)&&value>0&&value<=1_000_000_000;
const taxId=value=>typeof value==='string'?value.replace(/[.\-/ ]/gu,'').toUpperCase():'';
function validDate(value) {
  return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/u.test(value)&&Number.isFinite(Date.parse(`${value}T00:00:00Z`))&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
}

export const BOOKING_PIX_SCHEMA=`
CREATE TABLE IF NOT EXISTS jk_booking_pix_journal (
  scope TEXT NOT NULL,txid TEXT NOT NULL,fingerprint TEXT NOT NULL,amount_cents INTEGER NOT NULL,
  booking_id TEXT NOT NULL REFERENCES jk_booking_reservations(id),created_at TEXT NOT NULL,
  PRIMARY KEY(scope,txid),UNIQUE(scope,booking_id)
);
CREATE TABLE IF NOT EXISTS jk_booking_asaas_customers (
  scope TEXT NOT NULL,identity_id TEXT NOT NULL REFERENCES jk_booking_identities(id),external_reference TEXT NOT NULL,
  fingerprint TEXT NOT NULL,request_state TEXT NOT NULL CHECK(request_state IN ('reserved','attempted','linked')),
  customer_id TEXT,created_at TEXT NOT NULL,PRIMARY KEY(scope,identity_id),UNIQUE(scope,external_reference)
);`;
export function initializeBookingPix(raw) { raw.exec(BOOKING_PIX_SCHEMA); }

class BookingChargeJournal {
  constructor(db) {this.db=db;}
  async reserve(charge) {
    try {
      const result=await this.db.prepare(`INSERT INTO jk_booking_pix_journal(scope,txid,fingerprint,amount_cents,booking_id,created_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING`).run(charge.scope,charge.txid,charge.fingerprint,charge.amountCents,charge.orderId,new Date().toISOString());
      if(Number(result.changes)===1)return 'NEW';
      const prior=await this.find(charge.scope,charge.txid);
      return prior?.fingerprint===charge.fingerprint&&prior.amountCents===charge.amountCents&&prior.orderId===charge.orderId?'EXISTING':'CONFLICT';
    }catch{fail('JOURNAL_UNAVAILABLE');}
  }
  async find(scope,txid) {
    try {
      const row=await this.db.prepare('SELECT * FROM jk_booking_pix_journal WHERE scope=? AND txid=?').get(scope,txid);
      return row?{scope:row.scope,txid:row.txid,fingerprint:row.fingerprint,amountCents:row.amount_cents,orderId:row.booking_id}:undefined;
    }catch{fail('JOURNAL_UNAVAILABLE');}
  }
}

/** Internal gateway only. HTTP identity authentication belongs to the booking domain. */
export class AsaasBookingGateway {
  #db;#transport;#config;#adapter;#customerScope;#base;#now;
  constructor(config,transport,db) {
    if(typeof db?.prepare!=='function'||config.now!==undefined&&typeof config.now!=='function')fail('INVALID_CONFIGURATION');
    this.#adapter=new AsaasPixAdapter(config,transport,new BookingChargeJournal(db));
    this.#config={...config};this.#transport=transport;this.#db=db;this.#now=config.now??Date.now;
    this.scope=this.#adapter.scope;this.environment=config.environment;this.enabled=config.enabled===true;
    this.#base=`https://${asaasAllowedHosts(config.environment)[0]}/v3`;
    // Customer recovery survives API-key rotation; charge scope intentionally does not.
    this.#customerScope=`asaas-customer:${config.environment}:${hash(config.accountId.toLowerCase())}`;
  }
  #context(input,context,allowed) {
    if(!this.enabled)fail('BOOKING_PIX_DISABLED');
    if(!only(input,allowed)||!text(input.bookingId,200)||!cents(input.amountCents)||!text(input.idempotencyKey,128)
      ||!context?.signal||typeof context.signal.addEventListener!=='function')fail('INVALID_INPUT');
    if(input.expectedScope!==undefined&&input.expectedScope!==this.scope)fail('SCOPE_MISMATCH');
    if(context.signal.aborted)fail('ABORTED');
  }
  async #booking(input,creating=false) {
    const row=await this.#db.prepare('SELECT * FROM jk_booking_reservations WHERE id=?').get(input.bookingId);
    if(!row||row.amount_cents!==input.amountCents||row.account_scope!==this.scope||creating&&row.identity_id!==input.identityId)fail('BOOKING_MISMATCH');
    if(creating&&(!['holding','awaiting_payment'].includes(row.status)||!(Date.parse(row.hold_expires_at)>this.#now())))fail('BOOKING_NOT_PAYABLE');
    return row;
  }
  #result(result,bookingId) {
    const {orderId,...data}=result.data;
    const evidence={...data,bookingId,scope:this.scope};
    if(evidence.evidenceSource==='authenticated-polling')evidence.evidenceHash=hash({providerReference:result.providerReference,...evidence});
    return {...result,data:evidence};
  }
  #error(error,bookingId) {
    const safe=error instanceof PixConnectorError?error:error instanceof TransportError
      ?new PixConnectorError('TRANSPORT_ERROR',error.outcome==='NOT_SENT'?'REJECTED':'UNKNOWN'):new PixConnectorError('JOURNAL_UNAVAILABLE');
    return {state:safe.state,data:{errorCode:safe.code,paymentConfirmed:false,environment:this.environment,...text(bookingId,200)?{bookingId}:{}}};
  }
  async create(input,context) {
    try {
      this.#context(input,context,['bookingId','identityId','phone','customerInput','amountCents','dueDate','idempotencyKey','expectedScope']);
      if(!text(input.identityId,200)||!text(input.phone,30)||!validDate(input.dueDate)
        ||!only(input.customerInput,['name','cpfCnpj'])||!text(input.customerInput.name,200)||input.customerInput.name.length<2)fail('INVALID_INPUT');
      const cpfCnpj=taxId(input.customerInput.cpfCnpj);
      if(!validTaxId(cpfCnpj))fail('INVALID_TAX_ID');
      await this.#booking(input,true);
      const identity=await this.#db.prepare('SELECT id,phone,verified_at FROM jk_booking_identities WHERE id=?').get(input.identityId);
      if(!identity||identity.phone!==input.phone||!Number.isFinite(Date.parse(identity.verified_at)))fail('IDENTITY_NOT_VERIFIED');
      const customerId=await this.#customer(identity.id,{name:input.customerInput.name,cpfCnpj},context.signal);
      // A slow customer lookup must not create a charge after the hold has expired.
      await this.#booking(input,true);
      return this.#result(await this.#adapter.execute('create-charge',{orderId:input.bookingId,amountCents:input.amountCents,
        customerId,dueDate:input.dueDate,description:`Reserva ${input.bookingId}`},
      {signal:context.signal,idempotencyKey:hash(['jk-booking',input.bookingId,input.idempotencyKey])}),input.bookingId);
    }catch(error){return this.#error(error,input?.bookingId);}
  }
  async reconcile(input,context) {
    try {
      this.#context(input,context,['bookingId','txid','amountCents','start','end','idempotencyKey','expectedScope']);
      await this.#booking(input);
      return this.#result(await this.#adapter.execute('reconcile',{orderId:input.bookingId,txid:input.txid,amountCents:input.amountCents,start:input.start,end:input.end},
        {signal:context.signal,idempotencyKey:hash(['jk-booking-reconcile',input.bookingId,input.idempotencyKey])}),input.bookingId);
    }catch(error){return this.#error(error,input?.bookingId);}
  }
  async #customer(identityId,customer,signal) {
    const body={...customer,externalReference:`jk-booking-customer:${hash(identityId)}`,notificationDisabled:true};
    const fingerprint=hash(body),scope=this.#customerScope;
    await this.#db.prepare(`INSERT INTO jk_booking_asaas_customers(scope,identity_id,external_reference,fingerprint,request_state,created_at)
      VALUES(?,?,?,?,'reserved',?) ON CONFLICT DO NOTHING`).run(scope,identityId,body.externalReference,fingerprint,new Date().toISOString());
    const prior=await this.#db.prepare('SELECT * FROM jk_booking_asaas_customers WHERE scope=? AND identity_id=?').get(scope,identityId);
    if(!prior||prior.fingerprint!==fingerprint)fail('CUSTOMER_IDENTITY_CONFLICT');
    const page=await this.#api('GET',`/customers?${new URLSearchParams({externalReference:body.externalReference,offset:'0',limit:'2'})}`,signal);
    if(!Array.isArray(page.data)||!Number.isSafeInteger(page.totalCount)||page.totalCount<0||typeof page.hasMore!=='boolean')fail('INVALID_CUSTOMER_RESPONSE','UNKNOWN');
    if(page.hasMore||page.totalCount>1||page.data.length>1)fail('DUPLICATE_CUSTOMER_REFERENCE','UNKNOWN');
    if(page.totalCount!==page.data.length)fail('INVALID_CUSTOMER_RESPONSE','UNKNOWN');
    let found=page.data[0];
    if(!found) {
      const claim=await this.#db.prepare(`UPDATE jk_booking_asaas_customers SET request_state='attempted'
        WHERE scope=? AND identity_id=? AND fingerprint=? AND request_state='reserved'`).run(scope,identityId,fingerprint);
      if(Number(claim.changes)!==1)fail('CUSTOMER_REFERENCE_UNRESOLVED','UNKNOWN');
      // Never retry this POST. An inconclusive attempt is recovered by the GET above.
      found=await this.#api('POST','/customers',signal,body);
    }
    if(!found||typeof found!=='object'||!/^cus_[A-Za-z0-9]{1,100}$/u.test(found.id)||found.deleted!==false
      ||found.externalReference!==body.externalReference||taxId(found.cpfCnpj)!==body.cpfCnpj||found.name!==body.name
      ||found.notificationDisabled!==true||prior.customer_id&&prior.customer_id!==found.id)fail('CUSTOMER_RESPONSE_MISMATCH','UNKNOWN');
    const linked=await this.#db.prepare(`UPDATE jk_booking_asaas_customers SET request_state='linked',customer_id=?
      WHERE scope=? AND identity_id=? AND fingerprint=? AND (customer_id IS NULL OR customer_id=?)`).run(found.id,scope,identityId,fingerprint,found.id);
    if(Number(linked.changes)!==1)fail('CUSTOMER_IDENTITY_CONFLICT','UNKNOWN');
    return found.id;
  }
  async #api(method,path,signal,body) {
    const response=await this.#transport.request({url:this.#base+path,method,signal,timeoutMs:20_000,retry:method==='GET'?'safe-read':'never',
      headers:{access_token:this.#config.apiKey,'user-agent':'AB-JK-UASH/booking-candidate',accept:'application/json',...(body?{'content-type':'application/json'}:{})},
      ...(body?{body:Buffer.from(JSON.stringify(body))}:{})});
    if(response.status!==200)fail('CUSTOMER_PROVIDER_ERROR',response.status>=500||[408,409,429].includes(response.status)||response.status>=200&&response.status<400?'UNKNOWN':'REJECTED');
    if(!/^application\/json(?:\s*;|$)/iu.test(response.headers?.['content-type']||'')||!(response.body instanceof Uint8Array)||response.body.byteLength>2*1024*1024)fail('INVALID_CUSTOMER_RESPONSE','UNKNOWN');
    try {const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(response.body));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value;}
    catch{fail('INVALID_CUSTOMER_RESPONSE','UNKNOWN');}
  }
}

/** Reads private configuration only; does not migrate storage or contact the provider. */
export async function createAsaasBookingGateway(db,entry,{secretsRoot,enabled=false,allowProduction=false,now=Date.now}={}) {
  if(enabled!==true)fail('BOOKING_PIX_DISABLED');
  const config=parseAsaasConfiguration(entry);
  const [apiKey,webhookToken]=await Promise.all([readPrivateText(secretsRoot,config.apiKeyFile),readPrivateText(secretsRoot,config.webhookTokenFile)]);
  if(apiKey===webhookToken)fail('INVALID_CONFIGURATION');
  return new AsaasBookingGateway({...config,apiKey,enabled,allowProduction,now},new SecureHttpTransport({allowedHosts:asaasAllowedHosts(config.environment)}),db);
}
