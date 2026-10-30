import { assertJkMutationAllowed } from './jk-transition.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { transaction, audit } from './db.mjs';
import { assert, ApiError } from './errors.mjs';
import { requireRole, requireLiveRole } from './security.mjs';
import { readJson } from './http.mjs';
import * as v from './validation.mjs';
import { orderBalance, receive, touchOrder, version } from './domain-core.mjs';
import { publicFiscalDraft } from './fiscal.mjs';
import { createJkRuntime, jkReadiness } from '../integrations/jk/runtime.mjs';
import { validateWhatsAppInput } from '../integrations/jk/vendor/connectors/messaging/whatsapp.mjs';
import { ASAAS_WEBHOOK_SCHEMA } from '../integrations/jk/asaas-webhook.mjs';

const WRITERS = ['admin','manager'];
const READERS = ['admin','manager','operator','viewer'];
const BUSY = new Set(['submitting','reconciling']);
const RECONCILABLE = new Set(['submitting','active','reconciling','uncertain','pending','partial','review','test_confirmed','settled']);
const stamp = runtime => new Date(runtime.now()).toISOString();
const hash = value => createHash('sha256').update(value).digest('hex');
const errorCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/u.test(value) ? value : 'PROVIDER_RESULT_UNCONFIRMED';

export function migrateJkIntegrations(raw) {
  transaction(raw, () => raw.exec(readFileSync(new URL('../integrations/jk/schema.sql', import.meta.url), 'utf8') + '\n' + ASAAS_WEBHOOK_SCHEMA));
}

export async function initializeJkIntegrations(db, options = {}) {
  return createJkRuntime(db, options);
}

/** Public provider callback: authenticate separately from user sessions and persist hints only. */
export async function handleJkAsaasWebhook(ctx) {
  if (ctx.pathname !== '/api/jk/integrations/asaas/webhook') return null;
  assert(ctx.method === 'POST',405,'WEBHOOK_METHOD_INVALID','Este endereço aceita somente notificações POST.');
  const runtime = ctx.jkIntegrations;
  assert(runtime?.storageReady && runtime.asaas?.webhook,503,'ASAAS_WEBHOOK_NOT_CONFIGURED','O recebimento de notificações Asaas está indisponível.');
  const maximum = 256*1024;
  const declared = Number(ctx.request.headers['content-length']);
  assert(!Number.isFinite(declared) || declared <= maximum,413,'WEBHOOK_BODY_INVALID','A notificação excede o tamanho permitido.');
  const chunks = []; let size = 0;
  for await (const chunk of ctx.request) {
    size += chunk.length;
    assert(size <= maximum,413,'WEBHOOK_BODY_INVALID','A notificação excede o tamanho permitido.');
    chunks.push(chunk);
  }
  try {
    // Notification ingestion never dispatches or settles. Read-only transition
    // mode still guards every user-triggered reconciliation through reserve().
    return await transaction(ctx.db,()=>runtime.asaas.webhook.accept({method:ctx.method,headers:ctx.request.headers,body:Buffer.concat(chunks)}));
  } catch (error) {
    if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 && /^[A-Z][A-Z0-9_]{1,79}$/u.test(error.code)) throw new ApiError(error.status,error.code,'A notificação Asaas não pôde ser aceita.');
    throw error;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key,canonical(value[key])]));
  return value;
}
function identity(ctx, body) {
  const key = ctx.request.headers['idempotency-key'];
  assert(typeof key === 'string' && /^[a-zA-Z0-9_-]{8,128}$/u.test(key), 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Envie Idempotency-Key com 8 a 128 letras, números, hífens ou sublinhados.');
  return { actorId: ctx.session.user.id, key, hash: hash(JSON.stringify({ method: ctx.method, path: ctx.pathname, body: canonical(body) })) };
}
function effectiveStatus(row, runtime) {
  return BUSY.has(row.status) && Number(row.lease_expires_at || 0) <= runtime.now() ? 'uncertain' : row.status;
}
function matchesConfiguredDestination(row, runtime) {
  const channel = runtime.channels[row.kind];
  return Boolean(row.account_scope) && row.account_scope === runtime.scopes.get(row.kind)
    && row.provider === channel.provider && row.environment === channel.environment;
}

export function publicJkIntegration(row, runtime) {
  runtime.refresh?.();
  const status = effectiveStatus(row, runtime);
  const evidence = JSON.parse(row.evidence_json);
  const input = JSON.parse(row.input_json);
  const ready = runtime.channels[row.kind].state === 'ready';
  const destinationMatches = matchesConfiguredDestination(row, runtime);
  return {
    id: row.id, kind: row.kind, orderId: row.order_id, orderVersion: row.order_version, version: row.version,
    status, provider: row.provider, environment: row.environment, amountCents: row.amount_cents,
    providerReference: row.provider_reference, paymentId: row.payment_id, lastErrorCode: row.last_error_code,
    attemptCount: row.attempt_count, evidence,
    reconciliationRequired: row.kind === 'pix' && (['uncertain','review'].includes(status) || Boolean(evidence.reviewRequired)),
    paymentConfirmed: row.kind === 'pix' && row.environment === 'production' && !!row.payment_id,
    delivery: 'unconfirmed',
    preparationRequiresRefresh: ready && status === 'prepared' && !destinationMatches,
    canSubmit: ready && status === 'prepared' && row.attempt_count === 0 && destinationMatches,
    canReconcile: ready && row.kind === 'pix' && RECONCILABLE.has(status) && !BUSY.has(status),
    canCancel: status === 'prepared',
    ...(row.kind === 'whatsapp' ? { templateName: input.templateName, recipientMasked: `***${input.to.slice(-4)}` } : {}),
    ...(row.provider === 'pix-asaas' ? { customerId: input.customerId, dueDate: input.dueDate } : {}),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

async function getRecord(ctx, id, kind) {
  const row = await ctx.db.prepare('SELECT * FROM jk_integration_records WHERE id=?').get(id);
  assert(row && (!kind || row.kind === kind), 404, 'INTEGRATION_NOT_FOUND', 'Registro de integração não encontrado.');
  return row;
}
async function getOrder(db, orderId) {
  const row = await db.prepare(`SELECT * FROM orders WHERE id=?${db.mode === 'postgres' ? ' FOR UPDATE' : ''}`).get(orderId);
  assert(row, 404, 'NOT_FOUND', 'Ordem não encontrada.');
  return row;
}
async function event(ctx, row, action, code = null) {
  await ctx.db.prepare('INSERT INTO jk_integration_events(id,record_id,actor_id,action,status,code,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(randomUUID(),row.id,ctx.session.user.id,action,row.status,code,stamp(ctx.jkIntegrations));
  await audit(ctx.db, { actorId: ctx.session.user.id, action: `jk.${row.kind}.${action}`, resourceType: 'integration', resourceId: row.id,
    metadata: { orderId: row.order_id, status: row.status, ...(code ? {code} : {}) } });
}
async function reserve(ctx, requestIdentity) {
  await requireLiveRole(ctx.db,ctx.session,WRITERS);
  await assertJkMutationAllowed(ctx.db,ctx.method,ctx.pathname);
  const changed = await ctx.db.prepare(`INSERT INTO jk_integration_operations(actor_id,idempotency_key,request_hash,record_id,response_json,created_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(actor_id,idempotency_key) DO NOTHING`)
    .run(requestIdentity.actorId,requestIdentity.key,requestIdentity.hash,null,null,stamp(ctx.jkIntegrations));
  if (Number(changed.changes) === 1) return null;
  const prior = await ctx.db.prepare('SELECT * FROM jk_integration_operations WHERE actor_id=? AND idempotency_key=?').get(requestIdentity.actorId,requestIdentity.key);
  assert(prior?.request_hash === requestIdentity.hash,409,'IDEMPOTENCY_CONFLICT','A chave de idempotência já foi usada com outra solicitação.');
  if (prior.response_json) return { ...JSON.parse(prior.response_json), headers: { 'Idempotency-Replayed': 'true' } };
  assert(prior.record_id,409,'INTEGRATION_IN_PROGRESS','A operação ainda está em andamento.');
  return { status: 202, data: { item: publicJkIntegration(await getRecord(ctx,prior.record_id),ctx.jkIntegrations) }, headers: { 'Idempotency-Replayed': 'true' } };
}
async function finish(ctx, requestIdentity, row, status = 200) {
  const response = { status, data: { item: publicJkIntegration(row,ctx.jkIntegrations) } };
  await ctx.db.prepare('UPDATE jk_integration_operations SET record_id=?,response_json=? WHERE actor_id=? AND idempotency_key=? AND request_hash=?')
    .run(row.id,JSON.stringify(response),requestIdentity.actorId,requestIdentity.key,requestIdentity.hash);
  return response;
}

function phoneNumber(value) {
  const source = v.text(value,'customerPhone',{min:8,max:40});
  assert(/^\+?[\d ().-]+$/u.test(source),422,'WHATSAPP_RECIPIENT_INVALID','Cadastre um telefone válido no cliente da OS.');
  let digits = source.replace(/\D/gu,'');
  if (!source.startsWith('+') && [10,11].includes(digits.length)) digits = `55${digits}`;
  assert(/^[1-9]\d{7,14}$/u.test(digits) && (source.startsWith('+') || /^55\d{10,11}$/u.test(digits)),422,'WHATSAPP_RECIPIENT_INVALID','Cadastre o telefone com o código do país no cliente da OS.');
  return digits;
}

async function prepare(ctx, orderId, kind, body, requestIdentity) {
  const asaas = kind === 'pix' && ctx.jkIntegrations.channels.pix.provider === 'pix-asaas';
  v.onlyKeys(body,kind === 'pix' ? asaas ? ['version','customerId','dueDate'] : ['version','expiresInSeconds'] : ['version','templateName','languageCode','bodyParameters','consentConfirmed']);
  return transaction(ctx.db,async () => {
    const replay = await reserve(ctx,requestIdentity); if (replay) return replay;
    const order = await getOrder(ctx.db,orderId); version(order,body.version);
    assert(!['quote','cancelled'].includes(order.status),409,'ORDER_NOT_PAYABLE','Orçamentos e ordens canceladas não permitem esta operação.');
    let input, amount = 0;
    const id = randomUUID();
    if (kind === 'pix') {
      assert(!order.invoice_id,409,'INVOICE_PAYMENT_REQUIRED','Registre o recebimento pela fatura desta ordem.');
      amount = (await orderBalance(ctx.db,order.id)).balanceCents;
      assert(amount > 0,409,'ORDER_ALREADY_PAID','A ordem já está quitada.');
      assert(!await ctx.db.prepare("SELECT id FROM jk_integration_records WHERE order_id=? AND kind='pix' AND status NOT IN ('cancelled','rejected','settled')").get(order.id),409,'PIX_CHARGE_EXISTS','A ordem já tem uma cobrança ativa ou que exige reconciliação.');
      input = { txid: id.replaceAll('-',''), orderId: order.id, amountCents: amount, description: `OS ${order.number}` };
      if (asaas) {
        const customerId = v.text(body.customerId,'customerId',{min:5,max:104});
        const dueDate = v.text(body.dueDate,'dueDate',{min:10,max:10});
        assert(/^cus_[A-Za-z0-9]{1,100}$/u.test(customerId),422,'ASAAS_CUSTOMER_REQUIRED','Informe o identificador do cliente já cadastrado no Asaas.');
        assert(/^\d{4}-\d{2}-\d{2}$/u.test(dueDate) && Number.isFinite(Date.parse(`${dueDate}T00:00:00Z`))
          && new Date(`${dueDate}T00:00:00Z`).toISOString().slice(0,10) === dueDate,422,'ASAAS_DUE_DATE_INVALID','Informe uma data de vencimento válida.');
        Object.assign(input,{customerId,dueDate});
      } else input.expiresInSeconds = v.integer(body.expiresInSeconds ?? 3600,'expiresInSeconds',{min:60,max:86400});
    } else {
      assert(body.consentConfirmed === true,422,'MESSAGE_CONSENT_REQUIRED','Confirme que o cliente autorizou esta comunicação.');
      const customer = await ctx.db.prepare('SELECT phone FROM customers WHERE id=?').get(order.customer_id);
      input = { to: phoneNumber(customer?.phone), templateName: body.templateName, languageCode: body.languageCode,
        ...(body.bodyParameters !== undefined ? { bodyParameters: body.bodyParameters } : {}) };
      assert(validateWhatsAppInput('send-template',input),422,'INVALID_MESSAGE_INPUT','Confira o modelo aprovado, o idioma e os parâmetros da mensagem.');
    }
    const capability = ctx.jkIntegrations.channels[kind];
    // An offline preparation has no reviewed external destination. Activation,
    // provider/environment/account drift, and older unbound preparations must
    // be reviewed through a new preparation before any provider request.
    const accountScope = capability.state === 'ready' ? ctx.jkIntegrations.scopes.get(kind) || null : null;
    const createdAt = stamp(ctx.jkIntegrations);
    await ctx.db.prepare(`INSERT INTO jk_integration_records
      (id,kind,order_id,order_version,status,provider,environment,account_scope,amount_cents,provider_reference,input_json,evidence_json,created_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id,kind,order.id,order.version,'prepared',capability.provider,capability.environment,accountScope,amount,kind === 'pix' ? input.txid : null,JSON.stringify(input),
        JSON.stringify(kind === 'whatsapp' ? { consentConfirmedAt: createdAt, consentActorId: ctx.session.user.id, delivery: 'unconfirmed' } : {}),ctx.session.user.id,createdAt,createdAt);
    const row = await getRecord(ctx,id);
    await event(ctx,row,'prepared');
    return finish(ctx,requestIdentity,row,201);
  });
}

async function cancel(ctx, id, kind, body, requestIdentity) {
  v.onlyKeys(body,['version']);
  return transaction(ctx.db,async () => {
    const replay = await reserve(ctx,requestIdentity); if (replay) return replay;
    const row = await getRecord(ctx,id,kind); version(row,body.version);
    assert(row.status === 'prepared' && row.attempt_count === 0,409,'INTEGRATION_CANNOT_CANCEL','Somente uma preparação ainda não enviada pode ser cancelada localmente.');
    await ctx.db.prepare("UPDATE jk_integration_records SET status='cancelled',version=version+1,updated_at=? WHERE id=? AND version=?")
      .run(stamp(ctx.jkIntegrations),id,row.version);
    const current = await getRecord(ctx,id); await event(ctx,current,'cancelled');
    return finish(ctx,requestIdentity,current);
  });
}

function reconciliationPeriod(row, body, runtime) {
  const minimum = Date.parse(row.submitted_at || row.created_at) - 60_000;
  const start = body.start === undefined ? new Date(minimum).toISOString() : v.text(body.start,'start',{min:20,max:40});
  const end = body.end === undefined ? stamp(runtime) : v.text(body.end,'end',{min:20,max:40});
  const from = Date.parse(start), until = Date.parse(end);
  assert(Number.isFinite(from) && Number.isFinite(until) && /(?:Z|[+-]\d{2}:\d{2})$/u.test(start) && /(?:Z|[+-]\d{2}:\d{2})$/u.test(end)
    && from >= minimum && until >= from && until <= runtime.now() + 10_000,422,'PIX_RECONCILIATION_WINDOW_INVALID','Informe um intervalo válido após a preparação da cobrança.');
  assert(until-from <= 31*86400_000,422,'PIX_RECONCILIATION_WINDOW_REQUIRED','Informe start e end com um intervalo de até 31 dias.');
  return { start: new Date(from).toISOString(), end: new Date(until).toISOString() };
}

async function claim(ctx,id,kind,body,requestIdentity,action) {
  return transaction(ctx.db,async () => {
    ctx.jkIntegrations.refresh?.();
    const replay = await reserve(ctx,requestIdentity); if (replay) return { replay };
    const runtime = ctx.jkIntegrations;
    const channel = runtime.channels[kind];
    assert(channel.state === 'ready' && runtime.adapters.has(kind),409,'INTEGRATION_BLOCKED','A integração está bloqueada. Confira a configuração do servidor.',{ blockers: channel.blockers });
    const row = await getRecord(ctx,id,kind); version(row,body.version);
    let input = JSON.parse(row.input_json);
    if (action === 'submit') {
      assert(row.status === 'prepared' && row.attempt_count === 0,409,'INTEGRATION_ALREADY_SUBMITTED','Esta operação já teve envio iniciado. Não repita o envio.');
      assert(matchesConfiguredDestination(row,runtime),409,'INTEGRATION_PREPARATION_CHANGED','A configuração mudou. Cancele esta preparação e prepare novamente.');
      const order = await getOrder(ctx.db,row.order_id);
      assert(order.version === row.order_version && !['quote','cancelled'].includes(order.status),409,'INTEGRATION_ORDER_CHANGED','A OS mudou. Cancele a preparação local e prepare novamente.');
      if (kind === 'pix') assert(!order.invoice_id && (await orderBalance(ctx.db,order.id)).balanceCents === row.amount_cents,409,'PIX_BALANCE_CHANGED','O saldo da OS mudou. Prepare uma nova cobrança.');
    } else {
      assert(kind === 'pix' && RECONCILABLE.has(row.status),409,'PIX_RECONCILE_INVALID','A cobrança ainda não teve envio iniciado.');
      assert(!BUSY.has(row.status) || Number(row.lease_expires_at || 0) <= runtime.now(),409,'INTEGRATION_BUSY','Uma operação ainda está em andamento.');
      assert(row.provider === channel.provider && row.environment === channel.environment && row.account_scope === runtime.scopes.get(kind),409,'INTEGRATION_PROVIDER_CHANGED','Restaure o provedor, a conta e o ambiente originais para consultar esta referência.');
      input = { txid: row.provider_reference, orderId: row.order_id, amountCents: row.amount_cents,
        ...(row.provider === 'pix-asaas' ? {customerId:input.customerId,dueDate:input.dueDate} : {}), ...reconciliationPeriod(row,body,runtime) };
    }
    const token = randomUUID();
    await ctx.db.prepare(`UPDATE jk_integration_records SET status=?,version=version+1,lease_token=?,lease_expires_at=?,
      attempt_count=attempt_count+?,submitted_at=COALESCE(submitted_at,?),updated_at=? WHERE id=? AND version=?`)
      .run(action === 'submit' ? 'submitting' : 'reconciling',token,runtime.now()+runtime.leaseMs,
        action === 'submit' ? 1 : 0,stamp(runtime),stamp(runtime),id,row.version);
    await ctx.db.prepare('UPDATE jk_integration_operations SET record_id=? WHERE actor_id=? AND idempotency_key=?').run(id,requestIdentity.actorId,requestIdentity.key);
    await event(ctx,await getRecord(ctx,id),`${action}_claimed`);
    return { row, input, token, environment: channel.environment, adapter: runtime.adapters.get(kind) };
  });
}

function pixEvidence(result,row,operation,environment) {
  const data = result?.data;
  if (result?.state !== 'SUCCEEDED') return { status: operation === 'submit' && result?.state === 'REJECTED' ? 'rejected' : 'uncertain', code: errorCode(data?.errorCode || data?.code), evidence: { paymentConfirmed: false } };
  if (!data || data.txid !== row.provider_reference || result.providerReference !== row.provider_reference || data.amountCents !== row.amount_cents
    || data.orderId !== row.order_id || data.journalLinked !== true || data.environment !== environment) {
    return {status:'uncertain',code:'PIX_EVIDENCE_MISMATCH',evidence:{paymentConfirmed:false}};
  }
  const evidence = { txid: data.txid, amountCents: data.amountCents, chargeStatus: data.chargeStatus, paymentConfirmed: false,
    ...(typeof data.pixCopiaECola === 'string' && data.pixCopiaECola.length <= 10_000 ? { pixCopiaECola: data.pixCopiaECola } : {}) };
  if (row.provider === 'pix-asaas') {
    if (!/^pay_[A-Za-z0-9]{1,100}$/u.test(data.asaasPaymentId) || typeof data.asaasPaymentStatus !== 'string' || !/^[A-Z_]{1,100}$/u.test(data.asaasPaymentStatus)) return {status:'uncertain',code:'ASAAS_EVIDENCE_INCOMPLETE',evidence};
    Object.assign(evidence,{asaasPaymentId:data.asaasPaymentId,asaasPaymentStatus:data.asaasPaymentStatus,
      ...(typeof data.pixExpirationDate === 'string' && data.pixExpirationDate.length <= 50 ? {pixExpirationDate:data.pixExpirationDate} : {})});
  }
  if (operation === 'submit') return { status: 'active', code: null, evidence };
  const receipts = data.receipts;
  if (data.evidenceSource !== 'authenticated-polling' || !Array.isArray(receipts) || receipts.length > 10_000
    || !['CONFIRMED','PENDING','PARTIAL','REVIEW'].includes(data.receiptStatus) || !Number.isFinite(Date.parse(data.observedAt))) {
    return {status:'review',code:'PIX_EVIDENCE_INCOMPLETE',evidence};
  }
  const ids = new Set(); let gross = 0, refunded = 0, refundPending = false;
  const sanitized = [];
  for (const receipt of receipts) {
    if (!/^E[A-Za-z0-9]{31}$/u.test(receipt?.endToEndId) || ids.has(receipt.endToEndId) || !Number.isSafeInteger(receipt.amountCents) || receipt.amountCents < 1
      || !Number.isSafeInteger(receipt.refundedCents) || receipt.refundedCents < 0 || receipt.refundedCents > receipt.amountCents
      || typeof receipt.refundPending !== 'boolean' || !Number.isFinite(Date.parse(receipt.receivedAt))) {
      return {status:'review',code:'PIX_EVIDENCE_INCOMPLETE',evidence};
    }
    ids.add(receipt.endToEndId); gross += receipt.amountCents; refunded += receipt.refundedCents; refundPending ||= receipt.refundPending;
    sanitized.push({ endToEndId: receipt.endToEndId, amountCents: receipt.amountCents, receivedAt: receipt.receivedAt, refundedCents: receipt.refundedCents, refundPending: receipt.refundPending });
  }
  if (!Number.isSafeInteger(gross) || !Number.isSafeInteger(refunded) || data.receivedCents !== gross-refunded || data.refundedCents !== refunded) {
    return {status:'review',code:'PIX_EVIDENCE_MISMATCH',evidence};
  }
  Object.assign(evidence,{ evidenceSource: 'authenticated-polling', observedAt: data.observedAt, receiptStatus: data.receiptStatus,
    receivedCents: gross-refunded, refundedCents: refunded, receipts: sanitized });
  const confirmed = data.paymentConfirmed === true && data.receiptStatus === 'CONFIRMED' && data.chargeStatus === 'CONCLUIDA'
    && receipts.length > 0 && gross === row.amount_cents && refunded === 0 && !refundPending;
  if (confirmed) return { status: environment === 'production' ? 'settled' : 'test_confirmed', code: null, evidence, receipts: sanitized, shouldSettle: environment === 'production' };
  const review = data.paymentConfirmed === true || data.receiptStatus === 'REVIEW' || refunded > 0 || refundPending || gross > row.amount_cents;
  return {status: review ? 'review' : gross > 0 ? 'partial' : 'pending',code: review ? 'PIX_RECEIPT_REQUIRES_REVIEW' : null,evidence,receipts:sanitized};
}

async function recordReceiptsAndSettle(ctx,row,outcome) {
  if (!outcome.receipts) return;
  const hasBookings = ctx.db.mode === 'local' && await ctx.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jk_booking_receipts'").get();
  for (const receipt of outcome.receipts) {
    if (hasBookings && await ctx.db.prepare('SELECT booking_id FROM jk_booking_receipts WHERE end_to_end_id=?').get(receipt.endToEndId)) {
      outcome.status = 'review'; outcome.code = 'PIX_RECEIPT_ALREADY_LINKED'; outcome.shouldSettle = false; return;
    }
    const existing = await ctx.db.prepare('SELECT * FROM jk_pix_receipts WHERE end_to_end_id=?').get(receipt.endToEndId);
    if (existing && (existing.record_id !== row.id || existing.amount_cents !== receipt.amountCents || Date.parse(existing.received_at) !== Date.parse(receipt.receivedAt))) {
      outcome.status = 'review'; outcome.code = 'PIX_RECEIPT_ALREADY_LINKED'; outcome.shouldSettle = false; return;
    }
  }
  for (const receipt of outcome.receipts) await ctx.db.prepare(`INSERT INTO jk_pix_receipts
    (end_to_end_id,record_id,amount_cents,received_at,refunded_cents,refund_pending,payment_id,first_observed_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(end_to_end_id) DO UPDATE SET refunded_cents=excluded.refunded_cents,refund_pending=excluded.refund_pending,updated_at=excluded.updated_at`)
    .run(receipt.endToEndId,row.id,receipt.amountCents,receipt.receivedAt,receipt.refundedCents,Number(receipt.refundPending),row.payment_id,stamp(ctx.jkIntegrations),stamp(ctx.jkIntegrations));
  if (row.payment_id) {
    if (!outcome.shouldSettle) { outcome.evidence.reviewRequired = true; outcome.code ||= 'PIX_SETTLED_RECEIPT_CHANGED'; }
    outcome.status = 'settled'; outcome.evidence.paymentConfirmed = true; return;
  }
  if (!outcome.shouldSettle) return;
  const order = await getOrder(ctx.db,row.order_id);
  const balance = await orderBalance(ctx.db,row.order_id);
  if (['quote','cancelled'].includes(order.status) || order.invoice_id || balance.balanceCents !== row.amount_cents) {
    outcome.status = 'review'; outcome.code = 'PIX_BALANCE_REQUIRES_REVIEW'; return;
  }
  // Core payment, cash movement, allocation, order balance, receipts and audit all
  // commit in this same transaction. No provider response can directly call it.
  const paymentId = await receive(ctx.db,{ source:'order',sourceId:order.id,customerId:order.customer_id,amountCents:row.amount_cents,method:'pix',reference:`Pix ${row.provider_reference}` });
  await ctx.db.prepare('INSERT INTO payment_allocations(payment_id,order_id,amount_cents) VALUES(?,?,?)').run(paymentId,order.id,row.amount_cents);
  await touchOrder(ctx.db,order.id);
  await ctx.db.prepare('UPDATE jk_pix_receipts SET payment_id=? WHERE record_id=?').run(paymentId,row.id);
  outcome.paymentId = paymentId; outcome.evidence.paymentConfirmed = true;
  await audit(ctx.db,{ actorId:ctx.session.user.id,action:'order.payment_recorded',resourceType:'order',resourceId:order.id,
    metadata:{amountCents:row.amount_cents,method:'pix',paymentId,integrationId:row.id,evidenceSource:'authenticated-polling'} });
}

function messageEvidence(result,row) {
  const previous = JSON.parse(row.evidence_json);
  const baileys = row.provider === 'whatsapp-baileys';
  const validReference = baileys ? /^baileys:3EB0[A-F0-9]{32}$/u.test(result?.providerReference) : /^wamid\.[A-Za-z0-9_+/=-]{1,512}$/u.test(result?.providerReference);
  const acceptance = baileys ? 'socket-accepted' : 'provider-accepted';
  if (result?.state === 'SUCCEEDED' && validReference && (!baileys || result.data?.provider === 'whatsapp-baileys')
    && result.data?.acceptance === acceptance && result.data?.delivery === 'unconfirmed') {
    return {status:'accepted',code:null,reference:result.providerReference,evidence:{...previous,acceptance,delivery:'unconfirmed',...(baileys ? {localTemplate:result.data.localTemplate === true} : {})}};
  }
  return {status:result?.state === 'REJECTED' ? 'rejected' : 'uncertain',code:errorCode(result?.data?.code),evidence:{...previous,delivery:'unconfirmed'}};
}

async function dispatch(ctx,id,kind,body,requestIdentity,action) {
  v.onlyKeys(body,action === 'reconcile' ? ['version','start','end'] : ['version']);
  const claimed = await claim(ctx,id,kind,body,requestIdentity,action); if (claimed.replay) return claimed.replay;
  const runtime = ctx.jkIntegrations;
  const controller = new AbortController(); let timer, result;
  try {
    const execution = claimed.adapter.execute(kind === 'pix' ? action === 'submit' ? 'create-charge' : 'reconcile' : 'send-template',claimed.input,
      {idempotencyKey:`jk-${claimed.row.id}`,signal:controller.signal});
    result = await Promise.race([execution,new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve({state:'UNKNOWN',data:{code:'INTEGRATION_DEADLINE_EXCEEDED'}}); },runtime.deadlineMs); })]);
  } catch { result = {state:'UNKNOWN',data:{code:'PROVIDER_RESULT_UNCONFIRMED'}}; }
  finally { clearTimeout(timer); controller.abort(); }
  return transaction(ctx.db,async () => {
    const row = await getRecord(ctx,id);
    if (row.lease_token !== claimed.token || Number(row.lease_expires_at || 0) <= runtime.now()) {
      return {status:202,data:{item:publicJkIntegration(row,runtime)}};
    }
    const outcome = kind === 'pix' ? pixEvidence(result,row,action,claimed.environment) : messageEvidence(result,row);
    if (kind === 'pix') await recordReceiptsAndSettle(ctx,row,outcome);
    // Already recorded bank receipts must never be downgraded by a timeout.
    if (row.payment_id && kind === 'pix') { outcome.status = 'settled'; outcome.evidence.paymentConfirmed = true; if (outcome.code) outcome.evidence.reviewRequired = true; }
    await ctx.db.prepare(`UPDATE jk_integration_records SET status=?,version=version+1,evidence_json=?,last_error_code=?,payment_id=COALESCE(?,payment_id),
      provider_reference=COALESCE(?,provider_reference),lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND lease_token=?`)
      .run(outcome.status,JSON.stringify(outcome.evidence),outcome.code,outcome.paymentId || null,outcome.reference || null,stamp(runtime),id,claimed.token);
    const current = await getRecord(ctx,id); await event(ctx,current,`${action}_completed`,outcome.code);
    return finish(ctx,requestIdentity,current,['uncertain','pending','review'].includes(current.status) ? 202 : 200);
  });
}

async function orderIntegrations(ctx,orderId) {
  // A plain SELECT works inside the host's read snapshot (including PostgreSQL).
  assert(await ctx.db.prepare('SELECT id FROM orders WHERE id=?').get(orderId),404,'NOT_FOUND','Ordem não encontrada.');
  const rows = await ctx.db.prepare('SELECT * FROM jk_integration_records WHERE order_id=? ORDER BY created_at DESC,id DESC LIMIT 100').all(orderId);
  const drafts = ctx.fiscal ? await ctx.db.prepare('SELECT * FROM fiscal_drafts WHERE order_id=? ORDER BY created_at DESC,id DESC LIMIT 100').all(orderId) : [];
  return {data:{pixCharges:rows.filter(row=>row.kind==='pix').map(row=>publicJkIntegration(row,ctx.jkIntegrations)),
    messages:rows.filter(row=>row.kind==='whatsapp').map(row=>publicJkIntegration(row,ctx.jkIntegrations)),fiscalDrafts:drafts.map(row=>publicFiscalDraft(row,ctx.fiscal))}};
}

export async function handleJkIntegrations(ctx) {
  if (!/^\/api\/jk\/(?:integrations(?:\/|$)|orders\/[\w-]+\/(?:integrations|pix|messages|fiscal-source)$|(?:pix|messages)\/)/u.test(ctx.pathname)) return null;
  requireRole(ctx.session,READERS); await requireLiveRole(ctx.db,ctx.session,READERS);
  assert(ctx.jkIntegrations,503,'INTEGRATIONS_UNAVAILABLE','As integrações ainda não foram inicializadas.');
  ctx.jkIntegrations.refresh?.();
  if (ctx.method === 'GET' && ctx.pathname === '/api/jk/integrations/readiness') return {data:jkReadiness(ctx.jkIntegrations,ctx.fiscal)};
  assert(ctx.jkIntegrations.storageReady,503,'INTEGRATION_STORAGE_UNAVAILABLE','Aplique a migração das integrações antes de usar este recurso.');
  const order = ctx.pathname.match(/^\/api\/jk\/orders\/([\w-]+)\/(integrations|pix|messages|fiscal-source)$/u);
  if (order && ctx.method === 'GET' && order[2] === 'integrations') return orderIntegrations(ctx,order[1]);
  if (order && ctx.method === 'GET' && order[2] === 'fiscal-source') {
    const source = await ctx.db.prepare('SELECT id,number,version,status,total_cents,customer_id FROM orders WHERE id=?').get(order[1]);
    assert(source,404,'NOT_FOUND','Ordem não encontrada.');
    const items = await ctx.db.prepare('SELECT service_id,name,quantity,net_cents FROM order_items WHERE order_id=? ORDER BY position,id').all(order[1]);
    return {data:{orderId:source.id,orderNumber:source.number,orderVersion:source.version,status:source.status,totalCents:source.total_cents,
      eligible:!['quote','cancelled'].includes(source.status),items:items.map(item=>({serviceId:item.service_id,name:item.name,quantity:item.quantity,netCents:item.net_cents})),
      createDraftEndpoint:'/api/fiscal/drafts',requiredConfigurationEndpoint:'/api/fiscal/config',taxReviewRequired:true}};
  }
  const record = ctx.pathname.match(/^\/api\/jk\/(pix|messages)\/([\w-]+)(?:\/(submit|reconcile|cancel))?$/u);
  if (record && ctx.method === 'GET' && !record[3]) {
    const row = await getRecord(ctx,record[2],record[1] === 'pix' ? 'pix' : 'whatsapp');
    const events = await ctx.db.prepare('SELECT action,status,code,created_at FROM jk_integration_events WHERE record_id=? ORDER BY created_at,id LIMIT 100').all(row.id);
    return {data:{item:publicJkIntegration(row,ctx.jkIntegrations),events:events.map(value=>({action:value.action,status:value.status,code:value.code,createdAt:value.created_at}))}};
  }
  if (ctx.method !== 'POST') return null;
  requireRole(ctx.session,WRITERS);
  const body = v.object(await readJson(ctx.request)); const requestIdentity = identity(ctx,body);
  if (order && ['pix','messages'].includes(order[2])) return prepare(ctx,order[1],order[2] === 'pix' ? 'pix' : 'whatsapp',body,requestIdentity);
  if (record && record[3]) {
    const kind = record[1] === 'pix' ? 'pix' : 'whatsapp';
    if (record[3] === 'cancel') return cancel(ctx,record[2],kind,body,requestIdentity);
    assert(kind === 'pix' || record[3] === 'submit',404,'NOT_FOUND','Não há confirmação de entrega configurada para este canal.');
    return dispatch(ctx,record[2],kind,body,requestIdentity,record[3]);
  }
  return null;
}
