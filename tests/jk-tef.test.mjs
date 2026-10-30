import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createApplication} from '../server/application.mjs';
import {validateTefPlan,readTefPlan} from '../server/jk-tef.mjs';
import {TEF_PROVIDERS} from '../integrations/jk/tef-catalog.mjs';

const entry=()=>({providerId:TEF_PROVIDERS[0].id,terminalModel:'Modelo a confirmar',notes:'Preparação sintética'});
test('plan validation accepts multiple catalog families and rejects unknown, duplicate, secret fields and oversized values',()=>{
  assert.equal(validateTefPlan({version:0,providers:TEF_PROVIDERS.map(p=>({...entry(),providerId:p.id}))}).providers.length,TEF_PROVIDERS.length);
  for(const input of [{version:0,providers:[{...entry(),token:'secret'}]},{version:0,providers:[{...entry(),providerId:'unknown'}]},{version:0,providers:[entry(),entry()]},{version:0,providers:[{...entry(),terminalModel:'x'.repeat(101)}]},{version:0,providers:[{...entry(),notes:'x'.repeat(501)}]},{version:0,providers:[],canSubmit:true},{version:-1,providers:[]},{version:0,providers:null}])assert.throws(()=>validateTefPlan(input),{status:422});
});

async function fixture(t){
  const app=await createApplication({dbPath:':memory:',fiscalEnv:{},jkIntegrationsEnv:{},logger:{error(){}}});t.after(()=>app.close());
  async function request(path,body,{cookie,csrf,key,method=body===undefined?'GET':'PATCH'}={}){
    const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);req.method=method;req.url=path;req.headers={host:'127.0.0.1:4173','content-type':'application/json',...(cookie?{cookie}:{}),...(csrf?{'x-csrf-token':csrf}:{}),...(key?{'idempotency-key':key}:{})};
    const res={headers:{},headersSent:false,setHeader(k,v){this.headers[k.toLowerCase()]=v;},writeHead(s,h){this.status=s;Object.assign(this.headers,Object.fromEntries(Object.entries(h).map(([k,v])=>[k.toLowerCase(),v])));this.headersSent=true;},end(body){this.body=JSON.parse(body);},destroy(){}};
    await app.handler(req,res);return res;
  }
  const setup=await request('/api/setup',{name:'Admin sintético',email:'tef@example.test',password:'synthetic-password-2026'},{method:'POST'});assert.equal(setup.status,201);
  return {app,request,userId:setup.body.data.user.id,session:{cookie:setup.headers['set-cookie'].split(';')[0],csrf:setup.body.data.csrfToken}};
}
const path='/api/jk/tef/plan';
test('HTTP preparation works in readonly, remains inert, authorizes replay, and serializes competing versions',async t=>{
  const {app,request,userId,session}=await fixture(t);
  assert.equal((await request(path)).status,401);
  const initial=(await request(path,undefined,session)).body.data;assert.equal(initial.version,0);assert.deepEqual(initial.providers,[]);
  assert.equal((await request('/api/jk/tef/catalog',undefined,session)).body.data.providers.length,TEF_PROVIDERS.length);
  assert.equal((await request('/api/jk/tef/nested/plan',undefined,session)).status,404);
  assert.equal((await request('/api/jk/transition',{mode:'parallel_readonly',version:0},{...session,key:'tef-parallel-mode'})).status,200);
  const body={version:0,providers:[entry()]};
  assert.equal((await request(path,body,{cookie:session.cookie,key:'tef-no-csrf'})).status,403);
  assert.equal((await request(path,body,session)).status,400);
  const results=await Promise.all(['tef-first-write','tef-second-write'].map(key=>request(path,body,{...session,key})));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const winner=results.findIndex(r=>r.status===200),key=['tef-first-write','tef-second-write'][winner];
  const replay=await request(path,body,{...session,key});assert.equal(replay.status,200);assert.equal(replay.headers['idempotency-replayed'],'true');
  for(const field of ['canSubmit','connectionVerified','homologated'])assert.equal(replay.body.data[field],false);
  assert.equal(replay.body.data.state,'preparation_only');assert.equal(replay.body.data.version,1);
  assert.equal((await request(path,{version:1,providers:[]},{...session,key})).status,409);
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='jk.tef.plan.changed'").get().n,1);
  for(const table of ['payments','cash_movements','jk_integration_records'])assert.equal(app.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
  const removed=await request(path,{version:1,providers:[]},{...session,key:'tef-remove-plan'});assert.equal(removed.status,200);assert.equal(removed.body.data.version,2);assert.deepEqual((await request(path,undefined,session)).body.data.providers,[]);
  await app.store.prepare("UPDATE users SET role='manager' WHERE id=?").run(userId);
  assert.equal((await request(path,undefined,session)).status,200);
  assert.equal((await request(path,body,{...session,key})).status,403);
  await app.store.prepare("UPDATE users SET role='viewer' WHERE id=?").run(userId);
  assert.equal((await request(path,undefined,session)).status,403);
});
test('audit failure rolls back settings and idempotency; corrupt stored plan fails closed',async t=>{
  const {app,request,session}=await fixture(t);
  app.db.exec("CREATE TRIGGER fail_tef_audit BEFORE INSERT ON audit_events WHEN NEW.action='jk.tef.plan.changed' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  assert.equal((await request(path,{version:0,providers:[entry()]},{...session,key:'tef-atomic-write'})).status,500);
  assert.equal((await readTefPlan(app.store)).version,0);
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM idempotency_keys WHERE idempotency_key='tef-atomic-write'").get().n,0);
  app.db.exec('DROP TRIGGER fail_tef_audit');
  await app.store.prepare("INSERT INTO app_settings(key,value_json,updated_at) VALUES('jk_tef_plan',?,?)").run('{broken','2026-01-01');
  assert.equal((await request(path,undefined,session)).status,503);
  assert.equal((await request(path,{version:0,providers:[]},{...session,key:'tef-corrupt-write'})).status,503);
});

test('catalog offers an evidence checklist per family without asserting implementation',()=>{
  assert.equal(TEF_PROVIDERS.length,7);
  for(const provider of TEF_PROVIDERS){
    assert.equal(provider.connectorImplemented,false);
    assert.equal(provider.reviewedAt,'2026-10-30');
    assert.ok(provider.preparationSteps.length>=4,provider.id);
    assert.equal(new Set(provider.preparationSteps.map(step=>step.id)).size,provider.preparationSteps.length);
    for(const step of provider.preparationSteps){assert.ok(step.action.length>10);assert.ok(step.evidence.length>10);}
    assert.ok(Object.isFrozen(provider.preparationSteps));
  }
});

test('local diagnostics reports preparation gaps and never verifies hardware or performs financial work',async t=>{
  const {app,request,session,userId}=await fixture(t);
  const diagnosticsPath='/api/jk/tef/diagnostics';
  assert.equal((await request(diagnosticsPath)).status,401);
  const before=(await request(diagnosticsPath,undefined,session)).body.data;
  assert.equal(before.localOnly,true);assert.equal(before.networkAttempted,false);assert.equal(before.hardwareInspected,false);
  assert.equal(before.providers.length,7);assert.equal(before.selectedCount,0);assert.equal(before.canSubmit,false);
  for(const provider of before.providers){assert.equal(provider.connectorImplemented,false);assert.equal(provider.terminalModelInformed,false);assert.equal(provider.selected,false);assert.equal(provider.state,'not_selected');}
  assert.equal((await request(path,{version:0,providers:[entry(),{providerId:TEF_PROVIDERS[1].id,terminalModel:'',notes:''}]},{...session,key:'tef-diagnostics-plan'})).status,200);
  const after=(await request(diagnosticsPath,undefined,session)).body.data;
  assert.equal(after.selectedCount,2);assert.equal(after.planVersion,1);
  assert.equal(after.providers[0].state,'connector_missing');assert.equal(after.providers[0].terminalModelInformed,true);
  assert.equal(after.providers[1].state,'terminal_model_missing');
  assert.equal(JSON.stringify(after).includes('Preparação sintética'),false);
  for(const table of ['payments','cash_movements','jk_integration_records'])assert.equal(app.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
  assert.equal((await request(diagnosticsPath,{}, {...session,method:'POST'})).status,404);
  await app.store.prepare("UPDATE users SET role='manager' WHERE id=?").run(userId);
  assert.equal((await request(diagnosticsPath,undefined,session)).status,200);
  await app.store.prepare("UPDATE users SET role='viewer' WHERE id=?").run(userId);
  assert.equal((await request(diagnosticsPath,undefined,session)).status,403);
});
