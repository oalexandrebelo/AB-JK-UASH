import test from 'node:test';
import assert from 'node:assert/strict';
import { fiscalFixture } from './fiscal-helpers.mjs';

test('pending team access preserves identity without allowing login or activation by PATCH', async t => {
  const f = await fiscalFixture(t, {jkIntegrationsEnv:{}});
  const input = {name:'Pessoa da equipe',email:'pending@example.test',role:'manager',pendingPassword:true};
  const created = (await f.call('/users',{method:'POST',body:input,status:201})).data.user;
  assert.equal(created.active,false);
  assert.equal(created.passwordSetupRequired,true);
  await f.call('/auth/login',{method:'POST',body:{email:input.email,password:'not-a-password'},status:401});
  const activated = await f.call(`/users/${created.id}`,{method:'PATCH',body:{active:true},status:409});
  assert.equal(activated.error.code,'INITIAL_PASSWORD_REQUIRED');
  await f.call('/users',{method:'POST',body:input,status:409});
  await f.restart();
  const listed = (await f.call('/users')).data.items.find(row=>row.id===created.id);
  assert.equal(listed.passwordSetupRequired,true);
  assert.equal(listed.active,false);
  assert.equal((await f.app.store.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').get(created.id)).n,0);
});

test('only an administrator can define the first password, once, with CSRF and password validation', async t => {
  const f = await fiscalFixture(t, {jkIntegrationsEnv:{}});
  const input = {name:'Equipe teste',email:'initial@example.test',role:'operator',pendingPassword:true};
  const user = (await f.call('/users',{method:'POST',body:input,status:201})).data.user;
  const path = `/users/${user.id}/initial-password`;
  const password = 'initial-private-password-2026';
  await f.call(path,{method:'POST',body:{password},headers:{'x-csrf-token':''},status:403});
  await f.call(path,{method:'POST',body:{password:'short'},status:422});
  await f.call('/users',{method:'POST',body:{name:'Gerente teste',email:'manager@example.test',role:'manager',password:'manager-password-test'},status:201});
  const login = await f.call('/auth/login',{method:'POST',body:{email:'manager@example.test',password:'manager-password-test'}});
  const headers = {cookie:login.response.headers.get('set-cookie').split(';')[0],'x-csrf-token':login.data.csrfToken};
  await f.call(path,{method:'POST',body:{password},headers,status:403});
  const key='initial-password-replay';
  const ready = (await f.call(path,{method:'POST',body:{password},key})).data.user;
  const replay = await f.call(path,{method:'POST',body:{password},key});
  assert.equal(replay.response.headers.get('idempotency-replayed'),'true');
  assert.deepEqual(replay.data.user,ready);
  await f.call(path,{method:'POST',body:{password:'different-password-value'},key,status:409});
  assert.equal(ready.active,true);
  assert.ok(!ready.passwordSetupRequired);
  await f.call(path,{method:'POST',body:{password:'replacement-password'},status:409});
  const entered = await f.call('/auth/login',{method:'POST',body:{email:input.email,password}});
  assert.equal(entered.data.user.id,user.id);
  assert.match((await f.app.store.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id)).password_hash,/^scrypt\$/u);
});

test('pending creation rejects contradictory credential input and missing authority', async t => {
  const f = await fiscalFixture(t, {jkIntegrationsEnv:{}});
  const body={name:'Equipe teste',email:'invalid@example.test',role:'viewer',pendingPassword:true};
  await f.call('/users',{method:'POST',body:{...body,password:'contradictory-password'},status:422});
  await f.call('/users',{method:'POST',body:{...body,pendingPassword:'true'},status:422});
  await f.call('/users',{method:'POST',body,headers:{cookie:'','x-csrf-token':''},status:401});
});
