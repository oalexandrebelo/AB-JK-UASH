import {createHash,randomUUID} from 'node:crypto';
import {audit,idempotentWrite} from './db.mjs';
import {assert} from './errors.mjs';
import {readJson} from './http.mjs';
import {requireRole,requireLiveRole,verifyCsrf} from './security.mjs';
import * as v from './validation.mjs';

function input(body) {
  v.onlyKeys(body,['source','establishmentId','users','previewHash']);
  assert(body.source==='jumpcar-ui'&&body.establishmentId===24453,422,'TEAM_SOURCE_INVALID','Confira a origem e a unidade Lava Rápido JK.');
  assert(Array.isArray(body.users)&&body.users.length>0&&body.users.length<=100,422,'VALIDATION_ERROR','Informe de 1 a 100 cadastros conferidos.');
  const emails=new Set();
  const users=body.users.map(row=>{
    v.object(row);v.onlyKeys(row,['name','email','phone','sourceRole','role','createEmployee']);
    const user={name:v.text(row.name,'name',{min:2,max:80}),email:v.email(row.email),sourceRole:v.text(row.sourceRole,'sourceRole',{min:1,max:80}),
      phone:v.text(row.phone??'','phone',{max:40}),role:v.choice(row.role,'role',['manager','operator','viewer']),createEmployee:v.boolean(row.createEmployee,'createEmployee')};
    assert(!emails.has(user.email),422,'TEAM_DUPLICATE_EMAIL','O lote repete um e-mail. Nenhum cadastro foi alterado.');emails.add(user.email);return user;
  });
  return {source:body.source,establishmentId:body.establishmentId,users};
}
async function preview(db,source) {
  const issues=[];
  const normalizeName=name=>name.normalize('NFKC').toLocaleLowerCase('pt-BR').replace(/\s+/gu,' ').trim();
  const existingNames=new Set((await db.prepare('SELECT name FROM employees').all()).map(row=>normalizeName(row.name)));
  for(const [index,user] of source.users.entries()) {
    if(await db.prepare('SELECT id FROM users WHERE email=?').get(user.email)) issues.push({row:index+1,code:'EMAIL_EXISTS'});
    if(user.createEmployee&&existingNames.has(normalizeName(user.name))) issues.push({row:index+1,code:'EMPLOYEE_NAME_EXISTS'});
  }
  const employeeNames=source.users.filter(user=>user.createEmployee).map(user=>normalizeName(user.name));
  if(new Set(employeeNames).size!==employeeNames.length)issues.push({row:0,code:'EMPLOYEE_NAME_REPEATED'});
  const previous=await db.prepare("SELECT value_json FROM app_settings WHERE key='jk_team_import'").get();
  if(previous)issues.push({row:0,code:'TEAM_ALREADY_IMPORTED'});
  return {canCommit:issues.length===0,previewHash:createHash('sha256').update(JSON.stringify(source)).digest('hex'),
    counts:{users:source.users.length,employees:employeeNames.length},users:source.users,issues,accessEnabled:false,payrollEnabled:false};
}
export async function handleJkTeamMigration(ctx) {
  if(!['/api/jk/team/status','/api/jk/team/preview','/api/jk/team/commit'].includes(ctx.pathname))return null;
  const actor=requireRole(ctx.session,['admin']);await requireLiveRole(ctx.db,ctx.session,['admin']);
  if(ctx.method==='GET'&&ctx.pathname.endsWith('/status')) {
    const row=await ctx.db.prepare("SELECT value_json FROM app_settings WHERE key='jk_team_import'").get();
    return {data:row?JSON.parse(row.value_json):{status:'not_imported',counts:{users:0,employees:0}}};
  }
  if(ctx.method!=='POST'||ctx.pathname.endsWith('/status'))return null;
  verifyCsrf(ctx.request,ctx.session);
  const body=v.object(await readJson(ctx.request));const source=input(body);
  if(ctx.pathname.endsWith('/preview'))return {data:await preview(ctx.db,source)};
  const result=await idempotentWrite(ctx.db,{actorId:actor.id,key:ctx.request.headers['idempotency-key'],method:ctx.method,path:ctx.pathname,body,
    authorize:()=>requireLiveRole(ctx.db,ctx.session,['admin'])},async()=>{
    const checked=await preview(ctx.db,source);
    assert(checked.previewHash===body.previewHash,409,'TEAM_PREVIEW_CHANGED','Confira a prévia deste lote antes de preservar.');
    assert(checked.canCommit,409,'TEAM_RECONCILIATION_REQUIRED','Há cadastros existentes ou repetidos. Revise sem mesclar automaticamente.',{issues:checked.issues});
    const now=new Date().toISOString();const entries=[];
    for(const user of source.users) {
      const userId=randomUUID();const employeeId=user.createEmployee?randomUUID():null;
      await ctx.db.prepare("INSERT INTO users(id,name,email,password_hash,role,active,created_at,updated_at) VALUES(?,?,?,'pending',?,0,?,?)")
        .run(userId,user.name,user.email,user.role,now,now);
      if(employeeId)await ctx.db.prepare('INSERT INTO employees(id,name,role_label,base_salary_cents,commission_bps,active,created_at,updated_at) VALUES(?,?,?,0,0,0,?,?)')
        .run(employeeId,user.name,user.sourceRole,now,now);
      entries.push({userId,employeeId,sourceRole:user.sourceRole,sourceStatus:'active',phone:user.phone,compensationConfigured:false});
    }
    const report={status:'preserved_pending_activation',counts:checked.counts,source:source.source,establishmentId:source.establishmentId,
      snapshotHash:checked.previewHash,committedAt:now,accessEnabled:false,payrollEnabled:false,entries};
    await ctx.db.prepare("INSERT INTO app_settings(key,value_json,updated_at) VALUES('jk_team_import',?,?)").run(JSON.stringify(report),now);
    await audit(ctx.db,{actorId:actor.id,action:'jk.team.imported_pending',resourceType:'jk_team_import',resourceId:checked.previewHash,metadata:{...checked.counts,accessEnabled:false,payrollEnabled:false}});
    return {status:201,data:report};
  });
  if(result.replayed)result.headers={'Idempotency-Replayed':'true'};return result;
}
