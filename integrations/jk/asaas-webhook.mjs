import { createHash, timingSafeEqual } from 'node:crypto';
import { validAsaasAccountId } from './asaas.mjs';

// Apply in an explicit deployment migration; constructing an inbox never runs DDL.
export const ASAAS_WEBHOOK_SCHEMA = `CREATE TABLE IF NOT EXISTS jk_asaas_webhook_events (
  scope TEXT NOT NULL,event_id TEXT NOT NULL,fingerprint TEXT NOT NULL,event_type TEXT NOT NULL,
  payment_reference TEXT NOT NULL,txid TEXT,amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
  ignored INTEGER NOT NULL DEFAULT 0 CHECK(ignored IN (0,1)),
  received_at TEXT NOT NULL,processed_at TEXT,PRIMARY KEY(scope,event_id)
) STRICT;
CREATE INDEX IF NOT EXISTS jk_asaas_webhook_pending ON jk_asaas_webhook_events(scope,processed_at,received_at,event_id);`;
const digest=value=>createHash('sha256').update(value).digest();
const tokenValid=value=>typeof value==='string'&&value.length>=32&&value.length<=255&&/^[\x21-\x7e]+$/u.test(value);
export class AsaasWebhookError extends Error {
  constructor(code,status) {super(code);this.name='AsaasWebhookError';this.code=code;this.status=status;}
}
const fail=(code,status)=>{throw new AsaasWebhookError(code,status);};
function header(headers,name) {
  const matches=Object.entries(headers||{}).filter(([key])=>key.toLowerCase()===name);
  return matches.length===1&&typeof matches[0][1]==='string' ? matches[0][1] : undefined;
}
function object(value) {return value&&typeof value==='object'&&!Array.isArray(value);}
function cents(value) {
  if(typeof value!=='number'||!/^\d{1,10}(?:\.\d{1,2})?$/u.test(String(value))) fail('WEBHOOK_PAYLOAD_INVALID',400);
  const [whole,decimal='']=String(value).split('.');const amount=Number(whole)*100+Number(decimal.padEnd(2,'0'));
  if(!Number.isSafeInteger(amount)||amount<1) fail('WEBHOOK_PAYLOAD_INVALID',400);
  return amount;
}

/** This durable inbox stores notification hints only; authenticated polling owns settlement. */
export class AsyncAsaasWebhookInbox {
  constructor(db) {this.db=db;}
  async persist(event) {
    try {
      const result=await this.db.prepare(`INSERT INTO jk_asaas_webhook_events(scope,event_id,fingerprint,event_type,payment_reference,txid,amount_cents,ignored,received_at)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(scope,event_id) DO NOTHING`)
        .run(event.scope,event.id,event.fingerprint,event.event,event.paymentReference,event.txid,event.amountCents,event.ignored ? 1 : 0,new Date().toISOString());
      if(Number(result.changes)===1) return 'NEW';
      const prior=await this.db.prepare('SELECT fingerprint FROM jk_asaas_webhook_events WHERE scope=? AND event_id=?').get(event.scope,event.id);
      return prior?.fingerprint===event.fingerprint ? 'EXISTING' : 'CONFLICT';
    } catch {fail('WEBHOOK_STORAGE_UNAVAILABLE',503);}
  }
  async pending(scope,limit=100) {
    if(typeof scope!=='string'||!Number.isSafeInteger(limit)||limit<1||limit>1000) fail('WEBHOOK_QUERY_INVALID',400);
    try {
      const rows=await this.db.prepare('SELECT * FROM jk_asaas_webhook_events WHERE scope=? AND processed_at IS NULL AND ignored=0 ORDER BY received_at,event_id LIMIT ?').all(scope,limit);
      return rows.map(row=>({scope:row.scope,id:row.event_id,event:row.event_type,paymentReference:row.payment_reference,txid:row.txid,amountCents:row.amount_cents,receivedAt:row.received_at}));
    } catch {fail('WEBHOOK_STORAGE_UNAVAILABLE',503);}
  }
  async complete(scope,id) {
    try {await this.db.prepare('UPDATE jk_asaas_webhook_events SET processed_at=COALESCE(processed_at,?) WHERE scope=? AND event_id=?').run(new Date().toISOString(),scope,id);}
    catch {fail('WEBHOOK_STORAGE_UNAVAILABLE',503);}
  }
}
export class AsaasWebhookReceiver {
  scope;
  #account;
  #tokenHash;
  #inbox;
  constructor(config,inbox) {
    if(!['homologation','production'].includes(config?.environment)||!validAsaasAccountId(config?.accountId)||!tokenValid(config?.authToken)||typeof inbox?.persist!=='function') fail('INVALID_CONFIGURATION',500);
    this.#account=config.accountId.toLowerCase();this.#tokenHash=digest(config.authToken);this.#inbox=inbox;
    // API-key and webhook-token rotation must not reset webhook replay protection.
    this.scope=`asaas-webhook:${config.environment}:${digest(this.#account).toString('hex')}`;
  }
  async accept(request) {
    const token=header(request?.headers,'asaas-access-token');
    if(!tokenValid(token)||!timingSafeEqual(digest(token),this.#tokenHash)) fail('WEBHOOK_UNAUTHORIZED',401);
    if(request.method!=='POST') fail('WEBHOOK_METHOD_INVALID',405);
    if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(header(request.headers,'content-type')||'')
      || ![undefined,'identity'].includes(header(request.headers,'content-encoding'))) fail('WEBHOOK_CONTENT_TYPE_INVALID',415);
    if(!(request.body instanceof Uint8Array)||request.body.byteLength<1||request.body.byteLength>256*1024) fail('WEBHOOK_BODY_INVALID',413);
    let payload;
    try {payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(request.body));} catch {fail('WEBHOOK_PAYLOAD_INVALID',400);}
    if(!object(payload)||!object(payload.account)||typeof payload.account.id!=='string'||payload.account.id.toLowerCase()!==this.#account) fail('WEBHOOK_ACCOUNT_MISMATCH',403);
    const payment=payload.payment;
    if(typeof payload.id!=='string'||!/^evt_[A-Za-z0-9_&-]{1,196}$/u.test(payload.id)||typeof payload.event!=='string'||!/^PAYMENT_[A-Z0-9_]{1,100}$/u.test(payload.event)
      ||!object(payment)||typeof payment.id!=='string'||!/^pay_[A-Za-z0-9]{1,100}$/u.test(payment.id)
      ||payment.externalReference!=null&&(typeof payment.externalReference!=='string'||payment.externalReference.length>500)
      ||typeof payment.billingType!=='string'||!/^[A-Z_]{1,100}$/u.test(payment.billingType)
      ||typeof payment.status!=='string'||!/^[A-Z_]{1,100}$/u.test(payment.status)) fail('WEBHOOK_PAYLOAD_INVALID',400);
    const amountCents=cents(payment.value);
    const ignored=payment.billingType!=='PIX'||typeof payment.externalReference!=='string'||!/^[A-Za-z0-9]{26,35}$/u.test(payment.externalReference);
    const event={scope:this.scope,id:payload.id,event:payload.event,paymentReference:payment.id,txid:ignored ? null : payment.externalReference,amountCents,ignored,
      fingerprint:digest(JSON.stringify([payload.event,this.#account,payment.id,payment.externalReference,payment.billingType,payment.status,amountCents])).toString('hex')};
    const result=await this.#inbox.persist(event);
    if(result==='CONFLICT') fail('WEBHOOK_REPLAY_CONFLICT',409);
    if(!['NEW','EXISTING'].includes(result)) fail('WEBHOOK_STORAGE_UNAVAILABLE',503);
    return {status:200,data:{received:true,duplicate:result==='EXISTING',ignored}};
  }
}
