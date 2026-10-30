import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { fiscalFixture, enabledEnv } from './fiscal-helpers.mjs';
import { mutate } from '../server/domain-core.mjs';

const setMode = (f,mode,version,status=200,key=randomUUID()) => f.call('/jk/transition',{method:'PATCH',body:{mode,version},status,key});

test('parallel mode persists, versions, audits and preserves historical import without operational writes', async t => {
  const f = await fiscalFixture(t);
  assert.deepEqual((await f.call('/jk/transition')).data,{mode:'normal',version:0,automaticSync:false,authority:'jk',historicalImportAllowed:true});
  const key=randomUUID();
  const enabled = await setMode(f,'parallel_readonly',0,200,key);
  assert.equal(enabled.data.authority,'jumpcar'); assert.equal(enabled.data.version,1);
  assert.deepEqual((await setMode(f,'parallel_readonly',0,200,key)).data,enabled.data);
  await setMode(f,'normal',0,409);
  await f.restart();
  assert.deepEqual((await f.call('/jk/transition')).data,enabled.data);
  await f.call('/customers'); await f.call('/auth/session');
  const paths=['/customers','/orders','/orders/missing/payments','/cash/open','/invoices/missing/payments','/package-sales','/payroll','/messages','/jk/orders/missing/pix','/jk/messages/missing/submit','/fiscal/drafts','/jk/deliveries','/settings'];
  for(const path of paths) {
    const denied=await f.call(path,{method:'POST',body:{},status:409});
    assert.equal(denied.error.code,'PARALLEL_READONLY',path);
  }
  const input={source:'jumpcar',dataset:{schemaVersion:1,customers:[{sourceId:'synthetic-history',name:'Histórico sintético'}]}};
  const preview=(await f.call('/jk/migration/preview',{method:'POST',body:input})).data;
  const committed=await f.call('/jk/migration/commit',{method:'POST',body:{...input,previewHash:preview.previewHash},status:201});
  assert.equal(committed.data.status,'COMMITTED');
  for(const table of ['payments','cash_movements','commission_claims','messages']) assert.equal((await f.app.store.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).count,0);
  assert.equal((await f.app.store.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action='jk.transition.changed'").get()).count,1);
  const restored=await setMode(f,'normal',1); assert.equal(restored.data.version,2);
  await f.create('/customers',{name:'Cadastro normal restaurado'});
});

test('transition requires current admin, CSRF, idempotency and rejects malformed modes', async t => {
  const f=await fiscalFixture(t);
  await f.call('/jk/transition',{headers:{cookie:''},status:401});
  await f.call('/jk/transition',{method:'PATCH',body:{mode:'parallel_readonly',version:0},headers:{'x-csrf-token':''},status:403});
  await f.call('/jk/transition',{method:'PATCH',body:{mode:'parallel_readonly',version:0},key:'',status:400});
  await setMode(f,'pretend_sync',0,422);
  const key=randomUUID(); await setMode(f,'parallel_readonly',0,200,key);
  const current=(await f.call('/auth/session')).data.user;
  await f.app.store.prepare("UPDATE users SET role='viewer' WHERE id=?").run(current.id);
  await f.call('/jk/transition');
  await setMode(f,'parallel_readonly',0,403,key);
});

test('a mutation admitted before the switch is checked again inside its write transaction', async t => {
  const f=await fiscalFixture(t);
  const user=(await f.call('/auth/session')).data.user;
  const sessionRow=await f.app.store.prepare('SELECT token_hash FROM sessions WHERE user_id=?').get(user.id);
  const request=new PassThrough();request.headers={'content-type':'application/json','idempotency-key':randomUUID()};
  let effects=0;
  const pending=mutate({db:f.app.store,session:{user,tokenHash:sessionRow.token_hash},request,method:'POST',pathname:'/api/customers'},['admin'],async()=>{effects++;return {};});
  const rejected=assert.rejects(pending,{code:'PARALLEL_READONLY'});
  await setMode(f,'parallel_readonly',0);
  request.end('{}');await rejected;assert.equal(effects,0);
});

test('in-flight fiscal effects prevent activation; completion is not cancelled or replayed', async t => {
  const started=Promise.withResolvers(), release=Promise.withResolvers();let calls=0;
  const f=await fiscalFixture(t,{fiscalEnv:enabledEnv,fiscalTransport:async()=>{calls++;started.resolve();return release.promise;}});
  const draft=await f.draft(await f.order());
  const submission=f.call(`/fiscal/drafts/${draft.id}/submit`,{method:'POST',body:{version:draft.version}});
  await started.promise;
  try {
    const blocked=await setMode(f,'parallel_readonly',0,409);
    assert.equal(blocked.error.code,'TRANSITION_PENDING_EXTERNAL');
    assert.equal((await f.call('/jk/transition')).data.mode,'normal');
  } finally {release.resolve({statusCode:200,body:{status:'autorizado'}});}
  await submission;await setMode(f,'parallel_readonly',0);assert.equal(calls,1);
});

test('prepared integration cannot be dispatched after activation; outstanding Pix blocks activation', async t => {
  const f=await fiscalFixture(t);const order=await f.order();
  const prepared=(await f.call(`/jk/orders/${order.id}/pix`,{method:'POST',body:{version:order.version},status:201})).data.item;
  await f.app.store.prepare("UPDATE jk_integration_records SET status='active',attempt_count=1 WHERE id=?").run(prepared.id);
  const blocked=await setMode(f,'parallel_readonly',0,409);assert.equal(blocked.error.code,'TRANSITION_PENDING_EXTERNAL');
  await f.app.store.prepare("UPDATE jk_integration_records SET status='prepared',attempt_count=0 WHERE id=?").run(prepared.id);
  await setMode(f,'parallel_readonly',0);
  const denied=await f.call(`/jk/pix/${prepared.id}/submit`,{method:'POST',body:{version:prepared.version},status:409});
  assert.equal(denied.error.code,'PARALLEL_READONLY');
  assert.equal((await f.app.store.prepare('SELECT attempt_count FROM jk_integration_records WHERE id=?').get(prepared.id)).attempt_count,0);
});

test('two application instances serialize mode changes and reject stale versions', async t => {
  const f=await fiscalFixture(t);const peer=await f.peer();
  const responses=await Promise.all([f,peer].map(client=>client.call('/jk/transition',{method:'PATCH',body:{mode:'parallel_readonly',version:0},status:null})));
  assert.deepEqual(responses.map(row=>row.status).sort(),[200,409]);
  assert.equal((await f.call('/jk/transition')).data.version,1);
  assert.equal((await peer.call('/jk/transition')).data.mode,'parallel_readonly');
});

test('invalid persisted mode fails closed while authentication and administrator recovery remain available', async t => {
  const f=await fiscalFixture(t);
  await f.app.store.prepare("INSERT INTO app_settings(key,value_json,updated_at) VALUES('jk_transition',?,?)").run('{invalid',new Date().toISOString());
  const denied=await f.call('/customers',{method:'POST',body:{name:'Não deve gravar'},status:503});
  assert.equal(denied.error.code,'TRANSITION_CONFIGURATION_INVALID');
  await f.call('/jk/transition',{status:503});await f.call('/auth/session');await f.call('/users');
});
