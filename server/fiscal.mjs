import { createHash, randomUUID } from 'node:crypto';
import { transaction, audit } from './db.mjs';
import { assert } from './errors.mjs';
import { requireRole, requireLiveRole } from './security.mjs';
import { readJson } from './http.mjs';
import * as v from './validation.mjs';
import {
  createFiscalTransport, fiscalConfiguration, publicFiscalConfiguration, interpretFocusResponse,
  FiscalTransportError, FISCAL_STATUSES, FISCAL_ROLES, FISCAL_FIELDS, REQUIRED_FISCAL_FIELDS,
  FISCAL_LEASE_MS, validateDraftInput, buildFocusPayload,
} from '../integrations/fiscal/index.mjs';
import { IBS_CBS_FIELDS } from '../integrations/fiscal/payload.mjs';

const BUSY = new Set(['submitting','reconciling']);
const RECONCILABLE = new Set(['uncertain','pending','submitting','reconciling']);
const nowIso = (runtime) => new Date(runtime.now()).toISOString();

export async function initializeFiscal(_db, { env = process.env, transport } = {}) {
  // No network and no DDL during initialization; migrations own both schemas.
  return {
    configuration: fiscalConfiguration(env), transport: transport || createFiscalTransport({ env }),
    now: () => Date.now(),
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function requestIdentity(ctx, body) {
  const key = ctx.request.headers['idempotency-key'];
  assert(typeof key === 'string' && /^[a-zA-Z0-9_-]{8,128}$/u.test(key), 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Envie Idempotency-Key com 8 a 128 letras, números, hífens ou sublinhados.');
  const hash = createHash('sha256').update(JSON.stringify({ method: ctx.method, path: ctx.pathname, body: canonical(body) })).digest('hex');
  return { key, hash, actorId: ctx.session.user.id };
}

function effectiveStatus(row, runtime) {
  return BUSY.has(row.status) && Number(row.lease_expires_at || 0) <= runtime.now() ? 'uncertain' : row.status;
}

export function publicFiscalDraft(row, runtime) {
  const status = effectiveStatus(row, runtime);
  return {
    id: row.id, orderId: row.order_id, orderVersion: row.order_version, version: row.version, status,
    providerRef: row.provider_ref, provider: row.provider_kind, environment: row.provider_environment,
    snapshot: JSON.parse(row.snapshot_json), fiscal: JSON.parse(row.fiscal_summary_json),
    customer: { taxIdMasked: row.customer_mask },
    providerStatus: row.provider_status, lastErrorCode: row.last_error_code,
    attemptCount: row.attempt_count, payloadRetained: row.payload_json !== null,
    reconciliationRequired: RECONCILABLE.has(status),
    canCancel: status === 'prepared', canSubmit: status === 'prepared' && runtime.configuration.enabled,
    fiscalValidity: status === 'authorized' ? (row.provider_environment === 'production' ? 'provider_authorized' : 'test_without_fiscal_validity') : 'not_authorized',
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

async function getDraft(db, id) {
  const row = await db.prepare('SELECT * FROM fiscal_drafts WHERE id=?').get(id);
  assert(row, 404, 'FISCAL_DRAFT_NOT_FOUND', 'Rascunho fiscal não encontrado.');
  return row;
}

async function reserveOperation(ctx, identity, action) {
  await requireLiveRole(ctx.db, ctx.session, FISCAL_ROLES);
  const inserted = await ctx.db.prepare('INSERT INTO fiscal_operations(actor_id,idempotency_key,request_hash,draft_id,action,response_json,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(actor_id,idempotency_key) DO NOTHING')
    .run(identity.actorId, identity.key, identity.hash, null, action, null, nowIso(ctx.fiscal));
  if (Number(inserted.changes) > 0) return null;
  const prior = await ctx.db.prepare('SELECT * FROM fiscal_operations WHERE actor_id=? AND idempotency_key=?').get(identity.actorId, identity.key);
  assert(prior?.request_hash === identity.hash, 409, 'IDEMPOTENCY_CONFLICT', 'A chave de idempotência já foi usada com outra solicitação.');
  if (prior.response_json) return JSON.parse(prior.response_json);
  assert(prior.draft_id, 409, 'FISCAL_OPERATION_IN_PROGRESS', 'A operação fiscal ainda está sendo concluída.');
  const draft = await getDraft(ctx.db, prior.draft_id);
  const current = publicFiscalDraft(draft, ctx.fiscal);
  return { status: current.reconciliationRequired ? 202 : 200, data: { draft: current } };
}

async function completeOperation(ctx, identity, draftId, response) {
  await ctx.db.prepare('UPDATE fiscal_operations SET draft_id=?,response_json=? WHERE actor_id=? AND idempotency_key=? AND request_hash=?')
    .run(draftId, JSON.stringify(response), identity.actorId, identity.key, identity.hash);
}

async function fiscalAudit(ctx, action, draftId, metadata = {}) {
  await audit(ctx.db, { actorId: ctx.session.user.id, action: `fiscal.${action}`, resourceType: 'fiscal_draft', resourceId: draftId, metadata });
}

async function snapshotOrder(db, orderId) {
  const suffix = db.mode === 'postgres' ? ' FOR UPDATE' : '';
  const order = await db.prepare(`SELECT id,number,version,status,subtotal_cents,discount_cents,total_cents FROM orders WHERE id=?${suffix}`).get(orderId);
  assert(order, 404, 'NOT_FOUND', 'Ordem não encontrada.');
  assert(!['quote','cancelled'].includes(order.status), 409, 'FISCAL_ORDER_INVALID', 'Orçamentos e ordens canceladas não podem gerar rascunho fiscal.');
  const items = await db.prepare('SELECT service_id,name,quantity,unit_price_cents,line_total_cents,discount_cents,net_cents FROM order_items WHERE order_id=? ORDER BY position,id').all(orderId);
  return {
    orderId: order.id, number: order.number, orderVersion: order.version, status: order.status,
    subtotalCents: order.subtotal_cents, discountCents: order.discount_cents, totalCents: order.total_cents,
    items: items.map((item) => ({
      serviceId: item.service_id, name: item.name, quantity: item.quantity, unitPriceCents: item.unit_price_cents,
      lineTotalCents: item.line_total_cents, discountCents: item.discount_cents, netCents: item.net_cents,
    })),
  };
}

async function createDraft(ctx, body, identity) {
  const input = validateDraftInput(body);
  return transaction(ctx.db, async () => {
    const replay = await reserveOperation(ctx, identity, 'create');
    if (replay) return replay;
    const snapshot = await snapshotOrder(ctx.db, input.orderId);
    const built = buildFocusPayload(input, snapshot);
    const occupied = await ctx.db.prepare("SELECT id FROM fiscal_drafts WHERE (order_id=? OR dps_key=?) AND status NOT IN ('cancelled','rejected')").get(input.orderId, built.dpsKey);
    assert(!occupied, 409, 'FISCAL_DRAFT_EXISTS', 'A ordem ou a numeração DPS já possui um processo fiscal ativo.');
    const id = randomUUID();
    const now = nowIso(ctx.fiscal);
    const inserted = await ctx.db.prepare(`INSERT INTO fiscal_drafts
      (id,order_id,order_version,status,version,provider_ref,provider_kind,provider_environment,provider_target,dps_key,snapshot_json,fiscal_summary_json,tax_review_json,customer_mask,payload_json,payload_hash,provider_status,last_error_code,attempt_count,lease_token,lease_expires_at,created_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
      .run(id, input.orderId, snapshot.orderVersion, 'prepared', 1, `abuash_${id.replaceAll('-', '')}`, null, null, null, built.dpsKey,
        JSON.stringify(snapshot), JSON.stringify(built.fiscalSummary), JSON.stringify(built.review), built.customerMask, built.payloadJson, built.payloadHash, null, null, 0, null, null,
        identity.actorId, now, now);
    assert(Number(inserted.changes) === 1, 409, 'FISCAL_DRAFT_EXISTS', 'A ordem ou a numeração DPS já possui um processo fiscal ativo.');
    const response = { status: 201, data: { draft: publicFiscalDraft(await getDraft(ctx.db, id), ctx.fiscal) } };
    await completeOperation(ctx, identity, id, response);
    await fiscalAudit(ctx, 'draft_created', id, { orderId: input.orderId, orderVersion: snapshot.orderVersion });
    return response;
  });
}

function requireVersion(body, row) {
  const version = v.integer(body.version, 'version', { min: 1, max: Number.MAX_SAFE_INTEGER });
  assert(version === row.version, 409, 'VERSION_CONFLICT', 'O rascunho foi atualizado. Recarregue antes de continuar.', { currentVersion: row.version });
}

async function cancelDraft(ctx, id, body, identity) {
  return transaction(ctx.db, async () => {
    const replay = await reserveOperation(ctx, identity, 'cancel');
    if (replay) return replay;
    const row = await getDraft(ctx.db, id);
    requireVersion(body, row);
    assert(row.status === 'prepared', 409, 'FISCAL_CANNOT_CANCEL', 'Somente um rascunho ainda não enviado pode ser cancelado localmente.');
    const result = await ctx.db.prepare("UPDATE fiscal_drafts SET status='cancelled',version=version+1,payload_json=NULL,tax_review_json=NULL,updated_at=? WHERE id=? AND version=? AND status='prepared'")
      .run(nowIso(ctx.fiscal), id, row.version);
    assert(Number(result.changes) === 1, 409, 'VERSION_CONFLICT', 'O rascunho foi atualizado. Recarregue antes de continuar.');
    const response = { data: { draft: publicFiscalDraft(await getDraft(ctx.db, id), ctx.fiscal) } };
    await completeOperation(ctx, identity, id, response);
    await fiscalAudit(ctx, 'draft_cancelled', id);
    return response;
  });
}

function assertEnabled(runtime) {
  assert(runtime.configuration.enabled, 409, 'FISCAL_DISABLED', 'A emissão fiscal está desativada ou sem configuração válida. O rascunho permanece local.', { reason: runtime.configuration.disabledReason });
}

async function dispatch(ctx, id, body, identity, action) {
  const claim = await transaction(ctx.db, async () => {
    const replay = await reserveOperation(ctx, identity, action);
    if (replay) return { replay };
    assertEnabled(ctx.fiscal);
    const row = await getDraft(ctx.db, id);
    requireVersion(body, row);
    const configuration = ctx.fiscal.configuration;
    const now = ctx.fiscal.now();
    if (action === 'submit') {
      assert(row.status === 'prepared' && row.attempt_count === 0, 409, 'FISCAL_RECONCILE_REQUIRED', 'Este rascunho já teve envio iniciado. Consulte o provedor pela reconciliação.');
      const suffix = ctx.db.mode === 'postgres' ? ' FOR UPDATE' : '';
      const order = await ctx.db.prepare(`SELECT version,status FROM orders WHERE id=?${suffix}`).get(row.order_id);
      assert(order && order.version === row.order_version && !['quote','cancelled'].includes(order.status), 409, 'FISCAL_ORDER_CHANGED', 'A ordem mudou após a preparação. Cancele o rascunho local e prepare outro.');
    } else {
      assert(RECONCILABLE.has(row.status), 409, 'FISCAL_RECONCILE_INVALID', 'Este rascunho não possui envio pendente de consulta.');
      assert(!BUSY.has(row.status) || Number(row.lease_expires_at || 0) <= now, 409, 'FISCAL_BUSY', 'Uma operação fiscal ainda está em andamento.');
      assert(row.provider_kind === configuration.provider && row.provider_environment === configuration.environment && row.provider_target === configuration.origin,
        409, 'FISCAL_PROVIDER_CHANGED', 'Restaure o provedor e o ambiente originais para reconciliar esta referência.');
    }
    const token = randomUUID();
    const status = action === 'submit' ? 'submitting' : 'reconciling';
    const changed = await ctx.db.prepare(`UPDATE fiscal_drafts SET status=?,version=version+1,provider_kind=?,provider_environment=?,provider_target=?,lease_token=?,lease_expires_at=?,attempt_count=attempt_count+?,updated_at=?
      WHERE id=? AND version=?`)
      .run(status, configuration.provider, configuration.environment, configuration.origin, token, now + FISCAL_LEASE_MS, action === 'submit' ? 1 : 0,
        nowIso(ctx.fiscal), id, row.version);
    assert(Number(changed.changes) === 1, 409, 'VERSION_CONFLICT', 'O rascunho foi atualizado. Recarregue antes de continuar.');
    await ctx.db.prepare('UPDATE fiscal_operations SET draft_id=? WHERE actor_id=? AND idempotency_key=?').run(id, identity.actorId, identity.key);
    await fiscalAudit(ctx, `${action}_claimed`, id, { provider: configuration.provider, environment: configuration.environment });
    return { row, token };
  });
  if (claim.replay) return claim.replay;

  // No DB transaction survives this boundary. Never retry this POST, including
  // DNS failure: a crash between dispatch and persistence is reconciled by GET.
  let outcome;
  try {
    let payload;
    if (action === 'submit') {
      assert(claim.row.payload_json && createHash('sha256').update(claim.row.payload_json).digest('hex') === claim.row.payload_hash,
        409, 'FISCAL_PAYLOAD_CHANGED', 'O conteúdo fiscal persistido não corresponde ao rascunho.');
      payload = JSON.parse(claim.row.payload_json);
    }
    const response = await ctx.fiscal.transport({
      method: action === 'submit' ? 'POST' : 'GET',
      path: action === 'submit' ? `/v2/nfsen?ref=${claim.row.provider_ref}` : `/v2/nfsen/${claim.row.provider_ref}`,
      ...(payload ? { body: payload } : {}),
    });
    outcome = interpretFocusResponse(response, action, claim.row.provider_ref);
  } catch (error) {
    // Never persist or log exception messages, response bodies, tokens or PII.
    const code = error instanceof FiscalTransportError && /^FISCAL_[A-Z_]+$/u.test(error.code) ? error.code : 'FISCAL_TRANSPORT_UNCONFIRMED';
    outcome = { status: 'uncertain', providerStatus: null, errorCode: code };
  }
  return transaction(ctx.db, async () => {
    const changed = await ctx.db.prepare(`UPDATE fiscal_drafts SET status=?,version=version+1,provider_status=?,last_error_code=?,lease_token=NULL,lease_expires_at=NULL,updated_at=?
      WHERE id=? AND lease_token=? AND lease_expires_at>?`)
      .run(outcome.status, outcome.providerStatus, outcome.errorCode, nowIso(ctx.fiscal), id, claim.token, ctx.fiscal.now());
    const row = await getDraft(ctx.db, id);
    const status = effectiveStatus(row, ctx.fiscal);
    const response = { status: RECONCILABLE.has(status) ? 202 : 200, data: { draft: publicFiscalDraft(row, ctx.fiscal) } };
    if (Number(changed.changes) === 1) {
      await completeOperation(ctx, identity, id, response);
      await fiscalAudit(ctx, `${action}_completed`, id, { status: row.status, errorCode: row.last_error_code });
    }
    // If this worker lost its lease, its late answer cannot change the newer result.
    // Returning the current row is safe; replay remains a local lookup.
    return response;
  });
}

export async function handleFiscal(ctx) {
  if (!ctx.pathname.startsWith('/api/fiscal/')) return null;
  requireRole(ctx.session, FISCAL_ROLES);
  await requireLiveRole(ctx.db, ctx.session, FISCAL_ROLES);
  assert(ctx.fiscal, 503, 'FISCAL_UNAVAILABLE', 'A integração fiscal não foi inicializada.');
  if (ctx.method === 'GET' && ctx.pathname === '/api/fiscal/status') return { data: publicFiscalConfiguration(ctx.fiscal.configuration) };
  if (ctx.method === 'GET' && ctx.pathname === '/api/fiscal/config') {
    return { data: {
      ...publicFiscalConfiguration(ctx.fiscal.configuration),
      requiredFields: REQUIRED_FISCAL_FIELDS, fiscalFields: FISCAL_FIELDS, ibsCbsFields: IBS_CBS_FIELDS,
      taxReviewRequired: true, supportedCustomer: 'domestic_cpf_cnpj', statuses: FISCAL_STATUSES,
      rules: { immutableDraft: true, staleOrderMustBeRecreated: true, noAutomaticPostRetry: true, localDraftIsNotInvoice: true },
    } };
  }
  if (ctx.method === 'GET' && ctx.pathname === '/api/fiscal/drafts') {
    const limit = v.integer(Number(ctx.url.searchParams.get('limit') || 50), 'limit', { min: 1, max: 100 });
    const offset = v.integer(Number(ctx.url.searchParams.get('offset') || 0), 'offset', { min: 0, max: 1000000 });
    const clauses = [];
    const params = [];
    if (ctx.url.searchParams.has('status')) {
      const status = v.choice(ctx.url.searchParams.get('status'), 'status', FISCAL_STATUSES);
      if (status === 'uncertain') {
        clauses.push("(status='uncertain' OR (status IN ('submitting','reconciling') AND lease_expires_at<=?))");
        params.push(ctx.fiscal.now());
      } else if (BUSY.has(status)) {
        clauses.push('status=? AND lease_expires_at>?'); params.push(status, ctx.fiscal.now());
      } else { clauses.push('status=?'); params.push(status); }
    }
    if (ctx.url.searchParams.has('orderId')) { clauses.push('order_id=?'); params.push(v.identifier(ctx.url.searchParams.get('orderId'), 'orderId')); }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const total = (await ctx.db.prepare(`SELECT COUNT(*) AS count FROM fiscal_drafts${where}`).get(...params)).count;
    const rows = await ctx.db.prepare(`SELECT * FROM fiscal_drafts${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return { data: { items: rows.map((row) => publicFiscalDraft(row, ctx.fiscal)), page: { limit, offset, total: Number(total) } } };
  }
  if (ctx.method === 'POST' && ctx.pathname === '/api/fiscal/drafts') {
    const body = v.object(await readJson(ctx.request));
    return createDraft(ctx, body, requestIdentity(ctx, body));
  }
  const match = ctx.pathname.match(/^\/api\/fiscal\/drafts\/([a-zA-Z0-9_-]+)(?:\/(cancel|submit|reconcile))?$/u);
  if (!match) return null;
  const [, id, action] = match;
  if (ctx.method === 'GET' && !action) return { data: { draft: publicFiscalDraft(await getDraft(ctx.db, id), ctx.fiscal) } };
  if (ctx.method !== 'POST' || !action) return null;
  const body = v.object(await readJson(ctx.request));
  assert(Object.keys(body).every((key) => key === 'version'), 422, 'FISCAL_VALIDATION_ERROR', 'Informe somente a versão do rascunho.');
  v.integer(body.version, 'version', { min: 1, max: Number.MAX_SAFE_INTEGER });
  const identity = requestIdentity(ctx, body);
  return action === 'cancel' ? cancelDraft(ctx, id, body, identity) : dispatch(ctx, id, body, identity, action);
}
