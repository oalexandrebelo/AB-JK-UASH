import {TEF_PROVIDERS} from '../integrations/jk/tef-catalog.mjs';
import {audit,idempotentWrite} from './db.mjs';
import {assert} from './errors.mjs';
import {readJson} from './http.mjs';
import {requireRole,requireLiveRole,verifyCsrf} from './security.mjs';
import * as v from './validation.mjs';

const flags={state:'preparation_only',canSubmit:false,connectionVerified:false,homologated:false};
const planPath='/api/jk/tef/plan';
const diagnosticsPath='/api/jk/tef/diagnostics';
export function validateTefPlan(input){
  const body=v.object(input);v.onlyKeys(body,['version','providers']);
  const version=v.integer(body.version,'version',{min:0,max:Number.MAX_SAFE_INTEGER-1});
  assert(Array.isArray(body.providers)&&body.providers.length<=TEF_PROVIDERS.length,422,'VALIDATION_ERROR','Informe uma lista de provedores do catálogo.');
  const ids=new Set();
  const providers=body.providers.map(value=>{
    const entry=v.object(value);v.onlyKeys(entry,['providerId','terminalModel','notes']);
    const providerId=v.choice(entry.providerId,'providerId',TEF_PROVIDERS.map(provider=>provider.id));
    assert(!ids.has(providerId),422,'VALIDATION_ERROR','Cada provedor pode aparecer somente uma vez.');ids.add(providerId);
    return {providerId,terminalModel:v.text(entry.terminalModel,'terminalModel',{max:100}),notes:v.text(entry.notes,'notes',{max:500})};
  });
  return {version,providers};
}
export async function readTefPlan(db){
  const row=await db.prepare("SELECT value_json FROM app_settings WHERE key='jk_tef_plan'").get();
  if(!row)return {version:0,providers:[],...flags};
  let stored;
  try{stored=validateTefPlan(JSON.parse(row.value_json));if(stored.version<1)stored=null;}catch{stored=null;}
  assert(stored,503,'TEF_CONFIGURATION_INVALID','A preparação TEF precisa ser revisada pelo administrador.');
  return {...stored,...flags};
}
async function readTefDiagnostics(db){
  const plan=await readTefPlan(db);
  return {...flags,localOnly:true,networkAttempted:false,hardwareInspected:false,planVersion:plan.version,selectedCount:plan.providers.length,
    providers:TEF_PROVIDERS.map(provider=>{
      const selection=plan.providers.find(item=>item.providerId===provider.id);
      const terminalModelInformed=Boolean(selection?.terminalModel.trim());
      return {providerId:provider.id,selected:Boolean(selection),terminalModelInformed,connectorImplemented:false,
        state:!selection?'not_selected':!terminalModelInformed?'terminal_model_missing':'connector_missing'};
    })};
}
export async function handleJkTef(ctx){
  if(!['/api/jk/tef/catalog',planPath,diagnosticsPath].includes(ctx.pathname))return null;
  if(ctx.method==='GET'){
    requireRole(ctx.session,['admin','manager']);await requireLiveRole(ctx.db,ctx.session,['admin','manager']);
    return {data:ctx.pathname===planPath?await readTefPlan(ctx.db):ctx.pathname===diagnosticsPath?await readTefDiagnostics(ctx.db):{providers:TEF_PROVIDERS}};
  }
  if(ctx.pathname!==planPath||ctx.method!=='PATCH')return null;
  const actor=requireRole(ctx.session,['admin']);verifyCsrf(ctx.request,ctx.session);
  const body=v.object(await readJson(ctx.request));const validated=validateTefPlan(body);
  const response=await idempotentWrite(ctx.db,{actorId:actor.id,key:ctx.request.headers['idempotency-key'],method:ctx.method,path:ctx.pathname,body,
    authorize:()=>requireLiveRole(ctx.db,ctx.session,['admin'])},async()=>{
    const current=await readTefPlan(ctx.db);
    assert(current.version===validated.version,409,'VERSION_CONFLICT','A preparação foi alterada. Atualize a consulta antes de salvar.');
    const next={version:current.version+1,providers:validated.providers};
    await ctx.db.prepare("INSERT INTO app_settings(key,value_json,updated_at) VALUES('jk_tef_plan',?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at").run(JSON.stringify(next),new Date().toISOString());
    await audit(ctx.db,{actorId:actor.id,action:'jk.tef.plan.changed',resourceType:'jk_tef_plan',resourceId:'preparation',metadata:{version:next.version,providerIds:next.providers.map(p=>p.providerId),state:'preparation_only'}});
    return {data:{...next,...flags}};
  });
  if(response.replayed)response.headers={'Idempotency-Replayed':'true'};
  return response;
}
