import test from 'node:test';
import assert from 'node:assert/strict';
import {fiscalFixture} from './fiscal-helpers.mjs';
const source={source:'jumpcar-ui',establishmentId:24453,users:[
  {name:'Pessoa teste',email:'team@example.test',sourceRole:'Gerente',role:'manager',createEmployee:true},
  {name:'caixa01',email:'desk@example.test',sourceRole:'Supervisor',role:'operator',createEmployee:false},
]};
test('team migration in parallel mode creates pending accounts and inactive employees once',async t=>{
  const f=await fiscalFixture(t,{jkIntegrationsEnv:{}});
  await f.call('/jk/transition',{method:'PATCH',body:{version:0,mode:'parallel_readonly'}});
  const preview=(await f.call('/jk/team/preview',{method:'POST',body:source})).data;
  assert.equal(preview.canCommit,true);assert.deepEqual(preview.counts,{users:2,employees:1});
  const body={...source,previewHash:preview.previewHash};const key='team-import-one';
  const first=(await f.call('/jk/team/commit',{method:'POST',body,key,status:201})).data;
  const replay=(await f.call('/jk/team/commit',{method:'POST',body,key,status:201})).data;
  assert.deepEqual(replay,first);
  const employee=await f.app.store.prepare('SELECT * FROM employees').get();assert.equal(employee.active,0);
  const users=await f.app.store.prepare("SELECT active,password_hash FROM users WHERE email IN (?,?)").all(source.users[0].email,source.users[1].email);
  assert.equal(users.length,2);assert.ok(users.every(u=>u.active===0&&u.password_hash==='pending'));
  assert.equal((await f.app.store.prepare('SELECT COUNT(*) n FROM payments').get()).n,0);
  await f.restart();assert.deepEqual((await f.call('/jk/team/status')).data.counts,first.counts);
});
test('team migration refuses authority escalation, duplicates, drift and non-admins',async t=>{
  const f=await fiscalFixture(t,{jkIntegrationsEnv:{}});
  await f.call('/jk/team/preview',{method:'POST',body:{...source,users:[{...source.users[0],role:'admin'}]},status:422});
  await f.call('/jk/team/preview',{method:'POST',body:{...source,establishmentId:9},status:422});
  await f.call('/jk/team/preview',{method:'POST',body:{...source,users:[source.users[0],source.users[0]]},status:422});
  const preview=(await f.call('/jk/team/preview',{method:'POST',body:source})).data;
  await f.call('/jk/team/commit',{method:'POST',body:{...source,previewHash:'0'.repeat(64)},status:409});
  await f.call('/users',{method:'POST',body:{name:'Existing',email:source.users[0].email,role:'viewer',pendingPassword:true},status:201});
  await f.call('/jk/team/commit',{method:'POST',body:{...source,previewHash:preview.previewHash},status:409});
  assert.equal((await f.app.store.prepare('SELECT COUNT(*) n FROM employees').get()).n,0);
  await f.call('/jk/team/status',{headers:{cookie:''},status:401});
});
test('team preview blocks existing professionals regardless of casing or Unicode normalization',async t=>{
  const f=await fiscalFixture(t,{jkIntegrationsEnv:{}});
  await f.call('/employees',{method:'POST',body:{name:'Péssoa Teste'},status:201});
  const result=(await f.call('/jk/team/preview',{method:'POST',body:{...source,users:[{...source.users[0],name:'PE\u0301SSOA TESTE'}]}})).data;
  assert.equal(result.canCommit,false);assert.equal(result.issues[0].code,'EMPLOYEE_NAME_EXISTS');
});
