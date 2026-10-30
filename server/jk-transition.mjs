import { audit, idempotentWrite } from './db.mjs';
import { assert } from './errors.mjs';
import { requireAuth, requireRole, requireLiveRole, verifyCsrf } from './security.mjs';
import { readJson } from './http.mjs';
import * as v from './validation.mjs';

const MODES = ['normal','parallel_readonly'];
const HISTORICAL = new Set(['/api/jk/migration/preview','/api/jk/migration/commit','/api/jk/history-archive/preview','/api/jk/history-archive/commit','/api/jk/team/preview','/api/jk/team/commit','/api/jk/reconciliation/preview','/api/jk/reconciliation/commit','/api/jk/source-catalog/preview','/api/jk/source-catalog/commit']);

export async function readJkTransition(db) {
  const row = await db.prepare("SELECT value_json FROM app_settings WHERE key='jk_transition'").get();
  let stored = {mode:'normal',version:0};
  if (row) {
    try { stored = JSON.parse(row.value_json); } catch { stored = null; }
    assert(stored && MODES.includes(stored.mode) && Number.isSafeInteger(stored.version) && stored.version >= 1,
      503,'TRANSITION_CONFIGURATION_INVALID','O modo de operação precisa ser revisado pelo administrador.');
  }
  return {mode:stored.mode,version:stored.version,automaticSync:false,authority:stored.mode === 'normal' ? 'jk' : 'jumpcar',historicalImportAllowed:true};
}

// Call again under the existing write transaction: HTTP admission alone races
// with an administrator switching modes while a request body is still arriving.
export async function assertJkMutationAllowed(db, method, pathname) {
  if (!['POST','PUT','PATCH','DELETE'].includes(method) || method === 'POST' && HISTORICAL.has(pathname) || method === 'PATCH' && pathname === '/api/jk/tef/plan') return;
  const state = await readJkTransition(db);
  assert(state.mode === 'normal',409,'PARALLEL_READONLY','O JK está em consulta paralela. Registre operações no Jumpcar; não há sincronização automática.');
}

async function requireNoPendingExternal(db) {
  const fiscal = await db.prepare("SELECT COUNT(*) AS count FROM fiscal_drafts WHERE status IN ('submitting','reconciling','uncertain','pending')").get();
  const integrations = await db.prepare('SELECT kind,status,evidence_json FROM jk_integration_records').all();
  const unresolved = integrations.filter(row => {
    const pending = ['submitting','reconciling','uncertain','pending','active','partial','review'].includes(row.status);
    let evidence;
    try { evidence = JSON.parse(row.evidence_json); } catch { return true; }
    return pending || Boolean(evidence?.reviewRequired);
  });
  const booking = db.mode === 'local' ? await db.prepare(`SELECT COUNT(*) AS count FROM jk_booking_reservations b
    LEFT JOIN jk_booking_advances a ON a.booking_id=b.id
    WHERE b.financial_status IN ('review','refund_pending') OR a.payment_id IS NULL AND (
      b.status='confirmed' OR b.status='arrived' OR b.hold_expires_at>? AND b.status IN ('holding','awaiting_payment')
      OR b.provider_reference IS NOT NULL AND b.financial_status<>'refunded'
      OR b.financial_status<>'refunded' AND EXISTS(SELECT 1 FROM jk_booking_pix_journal j WHERE j.booking_id=b.id)
      OR a.booking_id IS NOT NULL)`).get(new Date().toISOString()) : {count:0};
  assert(!Number(fiscal.count) && !unresolved.length && !Number(booking.count),409,'TRANSITION_PENDING_EXTERNAL',
    'Há operações externas em andamento ou sem conciliação. Resolva-as no modo normal antes de ativar a consulta paralela.',
    {fiscal:Number(fiscal.count),bookings:Number(booking.count),pix:unresolved.filter(row=>row.kind === 'pix').length,whatsapp:unresolved.filter(row=>row.kind === 'whatsapp').length});
}

export async function handleJkTransition(ctx) {
  if (ctx.pathname !== '/api/jk/transition') return null;
  requireAuth(ctx.session);
  await requireLiveRole(ctx.db,ctx.session);
  if (ctx.method === 'GET') return {data:await readJkTransition(ctx.db)};
  if (ctx.method !== 'PATCH') return null;
  const actor = requireRole(ctx.session,['admin']);
  verifyCsrf(ctx.request,ctx.session);
  const body = v.object(await readJson(ctx.request));
  v.onlyKeys(body,['mode','version']);
  const mode = v.choice(body.mode,'mode',MODES);
  const version = v.integer(body.version,'version',{min:0,max:Number.MAX_SAFE_INTEGER});
  const response = await idempotentWrite(ctx.db,{actorId:actor.id,key:ctx.request.headers['idempotency-key'],method:ctx.method,path:ctx.pathname,body,
    authorize:async()=>requireLiveRole(ctx.db,ctx.session,['admin'])},async()=>{
    const current = await readJkTransition(ctx.db);
    assert(current.version === version,409,'VERSION_CONFLICT','O modo foi alterado. Atualize a consulta antes de continuar.');
    if (current.mode === mode) return {data:current};
    if (mode === 'parallel_readonly') await requireNoPendingExternal(ctx.db);
    const next = {mode,version:current.version + 1};
    await ctx.db.prepare("INSERT INTO app_settings(key,value_json,updated_at) VALUES('jk_transition',?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at")
      .run(JSON.stringify(next),new Date().toISOString());
    await audit(ctx.db,{actorId:actor.id,action:'jk.transition.changed',resourceType:'jk_transition',resourceId:'operation',metadata:{from:current.mode,to:mode,version:next.version,automaticSync:false}});
    return {data:await readJkTransition(ctx.db)};
  });
  if (response.replayed) response.headers = {'Idempotency-Replayed':'true'};
  return response;
}
