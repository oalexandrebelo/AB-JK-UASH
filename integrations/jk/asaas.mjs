import { createHash } from 'node:crypto';
import { TransportError } from './vendor/connectors/transport.mjs';
import { PixConnectorError, record, text, validTxid, timestamp } from './vendor/connectors/banking/validation.mjs';

const PAYMENT_STATUSES = new Set(['PENDING','RECEIVED','CONFIRMED','OVERDUE','REFUNDED','RECEIVED_IN_CASH','REFUND_REQUESTED',
  'REFUND_IN_PROGRESS','CHARGEBACK_REQUESTED','CHARGEBACK_DISPUTE','AWAITING_CHARGEBACK_REVERSAL','DUNNING_REQUESTED','DUNNING_RECEIVED','AWAITING_RISK_ANALYSIS']);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const validAsaasAccountId = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value);
export const validAsaasDateTimeOffset = value => typeof value === 'string' && /^[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00)$/u.test(value);
const identifier = (value,prefix) => typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9]{1,100}$`,'u').test(value);
const validCents = value => Number.isSafeInteger(value) && value > 0 && value <= 1_000_000_000;
const invalid = () => { throw new PixConnectorError('INVALID_INPUT','REJECTED'); };
function date(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;
}
function money(value,allowZero=false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !/^\d{1,8}(?:\.\d{1,2})?$/u.test(String(value))) throw new PixConnectorError('INVALID_RESPONSE');
  const [whole,decimal=''] = String(value).split('.');
  const cents = Number(whole)*100 + Number(decimal.padEnd(2,'0'));
  if (!(validCents(cents) || allowZero && cents === 0)) throw new PixConnectorError('INVALID_RESPONSE');
  return cents;
}
function json(response) {
  if (!/^application\/json(?:\s*;|$)/iu.test(response.headers?.['content-type'] || '') || !(response.body instanceof Uint8Array) || response.body.byteLength > 2*1024*1024) throw new PixConnectorError('INVALID_RESPONSE');
  try { return record(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(response.body))); }
  catch { throw new PixConnectorError('INVALID_RESPONSE'); }
}
export function asaasAllowedHosts(environment) {
  if (!['homologation','production'].includes(environment)) throw new PixConnectorError('INVALID_CONFIGURATION','REJECTED');
  return [environment === 'production' ? 'api.asaas.com' : 'api-sandbox.asaas.com'];
}
function paymentBody(input,txid) {
  return { customer:input.customerId,billingType:'PIX',value:input.amountCents/100,dueDate:input.dueDate,externalReference:txid,
    ...(input.description ? {description:input.description} : {}) };
}
function parsePayment(value,expected,reservation) {
  record(value);
  if (!identifier(value.id,'pay') || !identifier(value.customer,'cus') || !date(value.dueDate) || !PAYMENT_STATUSES.has(value.status)
    || typeof value.deleted !== 'boolean' || value.description != null && !text(value.description,500)) throw new PixConnectorError('INVALID_RESPONSE');
  if (value.externalReference !== expected.txid || money(value.value) !== expected.amountCents || value.billingType !== 'PIX') throw new PixConnectorError('RESPONSE_MISMATCH');
  // The existing journal stores the immutable request hash, not customer PII.
  const returnedBody = paymentBody({customerId:value.customer,amountCents:expected.amountCents,dueDate:value.dueDate,description:value.description},expected.txid);
  if (hash({body:returnedBody,orderId:reservation.orderId}) !== reservation.fingerprint) throw new PixConnectorError('RESPONSE_MISMATCH');
  return value;
}
function refundEvidence(payment) {
  if (payment.refunds == null) return {refundedCents:0,refundPending:false};
  if (!Array.isArray(payment.refunds) || payment.refunds.length > 1000) throw new PixConnectorError('INVALID_RESPONSE');
  let refundedCents=0,refundPending=false;
  for(const item of payment.refunds) {
    record(item);
    if (!['PENDING','AWAITING_CRITICAL_ACTION_AUTHORIZATION','AWAITING_CUSTOMER_EXTERNAL_AUTHORIZATION','CANCELLED','DONE'].includes(item.status)) throw new PixConnectorError('INVALID_RESPONSE');
    const amount=money(item.value);
    if(item.status==='DONE') refundedCents+=amount;
    else if(item.status!=='CANCELLED') refundPending=true;
  }
  if (!Number.isSafeInteger(refundedCents)) throw new PixConnectorError('INVALID_RESPONSE');
  return {refundedCents,refundPending};
}
function effectiveTimestamp(value,offset) {
  if (typeof value !== 'string') return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value) && offset ? value.replace(' ','T')+offset : value;
  try { return new Date(timestamp(normalized)).toISOString(); } catch { return null; }
}

/** Only Pix collection is supported. This adapter never writes domain payments or cash. */
export class AsaasPixAdapter {
  id = 'pix-asaas';
  operations = Object.freeze(['create-charge','get-charge','get-pix-qrcode','reconcile']);
  scope;
  #config;
  #transport;
  #journal;
  #base;
  constructor(config,transport,journal) {
    const host=asaasAllowedHosts(config?.environment)[0];
    if (!text(config.apiKey,8192) || /\s/u.test(config.apiKey) || !validAsaasAccountId(config.accountId)
      || config.dateTimeOffset !== undefined && !validAsaasDateTimeOffset(config.dateTimeOffset)
      || typeof transport?.request !== 'function' || typeof journal?.reserve !== 'function' || typeof journal?.find !== 'function') throw new PixConnectorError('INVALID_CONFIGURATION','REJECTED');
    if(config.environment==='production' && config.allowProduction!==true) throw new PixConnectorError('PRODUCTION_NOT_ENABLED','REJECTED');
    this.#config={environment:config.environment,apiKey:config.apiKey,accountId:config.accountId.toLowerCase(),dateTimeOffset:config.dateTimeOffset};
    this.#transport=transport;this.#journal=journal;this.#base=`https://${host}/v3`;
    this.scope=`asaas:${config.environment}:${hash([this.#config.accountId,config.apiKey])}`;
  }
  async execute(operation,input,context) {
    let txid,mayHaveCreated=false;
    try {
      if(!this.operations.includes(operation)) throw new PixConnectorError('UNSUPPORTED_OPERATION','REJECTED');
      record(input,'INVALID_INPUT');
      const allowed=operation==='create-charge' ? ['txid','orderId','amountCents','customerId','dueDate','description']
        : operation==='reconcile' ? ['txid','orderId','amountCents','customerId','dueDate','start','end'] : ['txid','orderId','amountCents','customerId','dueDate'];
      if(Object.keys(input).some(key=>!allowed.includes(key)) || !text(context?.idempotencyKey,200)
        || !context?.signal || typeof context.signal.addEventListener!=='function' || !validCents(input.amountCents) || !text(input.orderId,200)) invalid();
      txid=input.txid ?? (operation==='create-charge' ? hash([this.id,this.#config.environment,context.idempotencyKey]).slice(0,32) : undefined);
      if(!validTxid(txid)) invalid();
      if(context.signal.aborted) throw new PixConnectorError('ABORTED','REJECTED');
      let period;
      if(operation==='reconcile') {
        try { period={start:timestamp(input.start),end:timestamp(input.end)}; } catch { invalid(); }
        if(period.end<period.start || period.end-period.start>31*86400_000) invalid();
      }
      const expected={txid,amountCents:input.amountCents};
      let reservation,replayed=false,payment;
      if(operation==='create-charge') {
        if(!identifier(input.customerId,'cus') || !date(input.dueDate) || input.description!==undefined && !text(input.description,500)) invalid();
        const body=paymentBody(input,txid);
        reservation={scope:this.scope,txid,fingerprint:hash({body,orderId:input.orderId}),amountCents:input.amountCents,orderId:input.orderId};
        const status=await this.#journal.reserve(reservation);
        if(status==='CONFLICT') throw new PixConnectorError('IDEMPOTENCY_CONFLICT','REJECTED');
        if(!['NEW','EXISTING'].includes(status)) throw new PixConnectorError('JOURNAL_UNAVAILABLE','REJECTED');
        replayed=status==='EXISTING';
        mayHaveCreated=replayed;
        payment=parsePayment(replayed ? await this.#lookup(txid,context.signal) : await this.#api('POST','/payments',context.signal,body),expected,reservation);
        mayHaveCreated=true;
      } else {
        reservation=await this.#journal.find(this.scope,txid);
        if(!reservation) throw new PixConnectorError('JOURNAL_NOT_LINKED','REJECTED');
        if(reservation.amountCents!==input.amountCents || reservation.orderId!==input.orderId) throw new PixConnectorError('IDEMPOTENCY_CONFLICT','REJECTED');
        payment=parsePayment(await this.#lookup(txid,context.signal),expected,reservation);
        if(input.customerId!==undefined&&input.customerId!==payment.customer || input.dueDate!==undefined&&input.dueDate!==payment.dueDate) throw new PixConnectorError('RESPONSE_MISMATCH');
      }
      const data={...expected,orderId:reservation.orderId,journalLinked:true,replayed,asaasPaymentId:payment.id,asaasPaymentStatus:payment.status,
        chargeStatus:payment.deleted ? 'REMOVIDA_PELO_USUARIO_RECEBEDOR' : ['RECEIVED','REFUNDED'].includes(payment.status) ? 'CONCLUIDA' : 'ATIVA',
        paymentConfirmed:false,environment:this.#config.environment};
      if(operation==='get-pix-qrcode' || operation==='create-charge' && !payment.deleted && ['PENDING','OVERDUE'].includes(payment.status)) {
        const qr=await this.#api('GET',`/payments/${payment.id}/pixQrCode`,context.signal);
        if(!text(qr.payload,10_000) || !qr.payload.startsWith('000201') || typeof qr.expirationDate!=='string'
          || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/u.test(qr.expirationDate)) throw new PixConnectorError('INVALID_RESPONSE');
        data.pixCopiaECola=qr.payload;data.pixExpirationDate=qr.expirationDate;
      }
      if(period) Object.assign(data,await this.#reconcile(payment,expected,period,context.signal));
      return {state:'SUCCEEDED',providerReference:txid,data};
    } catch(error) {
      const safe=error instanceof PixConnectorError ? error : error instanceof TransportError
        ? new PixConnectorError('TRANSPORT_ERROR',error.outcome==='NOT_SENT' ? 'REJECTED' : 'UNKNOWN') : new PixConnectorError('INVALID_RESPONSE');
      return {state:mayHaveCreated&&safe.state==='REJECTED' ? 'UNKNOWN' : safe.state,...txid ? {providerReference:txid} : {},data:{errorCode:safe.code,...safe.httpStatus ? {httpStatus:safe.httpStatus} : {},paymentConfirmed:false,environment:this.#config.environment}};
    }
  }
  async #lookup(txid,signal) {
    const page=await this.#api('GET',`/payments?${new URLSearchParams({externalReference:txid,offset:'0',limit:'2'})}`,signal);
    if(!Array.isArray(page.data) || !Number.isSafeInteger(page.totalCount) || page.totalCount<0 || typeof page.hasMore!=='boolean') throw new PixConnectorError('INVALID_RESPONSE');
    if(page.hasMore || page.totalCount>1 || page.data.length>1) throw new PixConnectorError('DUPLICATE_PROVIDER_REFERENCE');
    if(page.totalCount!==1 || page.data.length!==1) throw new PixConnectorError('PROVIDER_REFERENCE_UNRESOLVED');
    return page.data[0];
  }
  async #reconcile(payment,expected,period,signal) {
    const evidence={receiptStatus:['PENDING','OVERDUE'].includes(payment.status)&&!payment.deleted ? 'PENDING' : 'REVIEW',receipts:[],receivedCents:0,refundedCents:0,
      outstandingCents:expected.amountCents,paymentConfirmed:false,evidenceSource:'authenticated-polling',observedAt:new Date().toISOString()};
    const refunds=refundEvidence(payment);
    if(refunds.refundedCents>0||refunds.refundPending) evidence.receiptStatus='REVIEW';
    if(payment.deleted || payment.status!=='RECEIVED' || payment.chargeback != null || !text(payment.pixTransaction,100)) return evidence;
    if(!/^[A-Za-z0-9-]{1,100}$/u.test(payment.pixTransaction)) throw new PixConnectorError('INVALID_RESPONSE');
    const pix=await this.#api('GET',`/pix/transactions/${payment.pixTransaction}`,signal);
    if(pix.id!==payment.pixTransaction || pix.payment!==payment.id || pix.type!=='CREDIT' || money(pix.value)!==expected.amountCents) throw new PixConnectorError('RESPONSE_MISMATCH');
    if(pix.status!=='DONE') return evidence;
    const receivedAt=effectiveTimestamp(pix.effectiveDate,this.#config.dateTimeOffset);
    if(typeof pix.endToEndIdentifier!=='string' || !/^E[A-Za-z0-9]{31}$/u.test(pix.endToEndIdentifier) || !receivedAt) return evidence;
    if(Date.parse(receivedAt)<period.start || Date.parse(receivedAt)>period.end) throw new PixConnectorError('RESPONSE_MISMATCH');
    const refundedCents=Math.max(money(pix.refundedValue,true),refunds.refundedCents);
    if(refundedCents>expected.amountCents || payment.originalValue!=null && money(payment.originalValue)!==expected.amountCents) throw new PixConnectorError('RESPONSE_MISMATCH');
    const receipt={endToEndId:pix.endToEndIdentifier,amountCents:expected.amountCents,receivedAt,refundedCents,refundPending:refunds.refundPending};
    const confirmed=refundedCents===0&&!refunds.refundPending;
    return {...evidence,receipts:[receipt],receivedCents:expected.amountCents-refundedCents,refundedCents,outstandingCents:refundedCents,
      receiptStatus:confirmed ? 'CONFIRMED' : 'REVIEW',paymentConfirmed:confirmed};
  }
  async #api(method,path,signal,body) {
    const response=await this.#transport.request({url:this.#base+path,method,headers:{access_token:this.#config.apiKey,'user-agent':'AB-JK-UASH/0.2.0',accept:'application/json',
      ...(body ? {'content-type':'application/json'} : {})},...(body ? {body:Buffer.from(JSON.stringify(body))} : {}),signal,timeoutMs:20_000,retry:method==='GET' ? 'safe-read' : 'never'});
    if(response.status!==200) {
      const ambiguous=response.status>=500 || [408,409,429].includes(response.status) || response.status>=200&&response.status<400;
      throw new PixConnectorError(ambiguous ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_REJECTED',ambiguous ? 'UNKNOWN' : 'REJECTED',response.status);
    }
    return json(response);
  }
}
