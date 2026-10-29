import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fiscalFixture } from './fiscal-helpers.mjs';

test('JK integration HTTP routes preserve session, CSRF, versioning, idempotency and durable local preparation',async t=>{
  const f=await fiscalFixture(t,{jkIntegrationsEnv:{}});
  await f.call('/jk/integrations/readiness',{headers:{cookie:''},status:401});
  const readiness=(await f.call('/jk/integrations/readiness')).data;
  assert.equal(readiness.storageReady,true);assert.equal(readiness.pix.state,'blocked');assert.equal(readiness.whatsapp.state,'blocked');
  const order=await f.order();const path=`/jk/orders/${order.id}/pix`;const key=randomUUID();
  await f.call(path,{method:'POST',body:{version:order.version},headers:{'x-csrf-token':''},status:403});
  await f.call(path,{method:'POST',body:{version:order.version},headers:{'idempotency-key':''},status:400});
  await f.call(path,{method:'POST',body:{version:order.version+1},status:409});
  const prepared=(await f.call(path,{method:'POST',key,body:{version:order.version},status:201})).data.item;
  assert.equal(prepared.status,'prepared');assert.equal(prepared.amountCents,order.totalCents);assert.equal(prepared.paymentConfirmed,false);
  const replay=await f.call(path,{method:'POST',key,body:{version:order.version},status:201});
  assert.equal(replay.data.item.id,prepared.id);assert.equal(replay.response.headers.get('idempotency-replayed'),'true');
  const blocked=await f.call(`/jk/pix/${prepared.id}/submit`,{method:'POST',body:{version:prepared.version},status:409});
  assert.equal(blocked.error.code,'INTEGRATION_BLOCKED');
  const draft=await f.draft(order);
  const summary=(await f.call(`/jk/orders/${order.id}/integrations`)).data;
  assert.equal(summary.pixCharges[0].id,prepared.id);assert.equal(summary.fiscalDrafts[0].id,draft.id);
  assert.equal((await f.call(`/jk/orders/${order.id}/fiscal-source`)).data.orderVersion,order.version);
  await f.restart();
  assert.equal((await f.call(`/jk/pix/${prepared.id}`)).data.item.id,prepared.id);
  const cancelled=(await f.call(`/jk/pix/${prepared.id}/cancel`,{method:'POST',body:{version:prepared.version}})).data.item;
  assert.equal(cancelled.status,'cancelled');
  assert.equal((await f.app.store.prepare('SELECT COUNT(*) AS count FROM payments').get()).count,0);
});

test('JK HTTP writer routes enforce current manager role; readers can inspect readiness',async t=>{
  const f=await fiscalFixture(t,{jkIntegrationsEnv:{}});const order=await f.order();
  await f.call('/users',{method:'POST',body:{name:'Leitor de Integrações',email:'reader@example.test',password:'fixture-reader-password',role:'viewer'},status:201});
  const login=await f.call('/auth/login',{method:'POST',body:{email:'reader@example.test',password:'fixture-reader-password'}});
  const headers={cookie:login.response.headers.get('set-cookie').split(';')[0],'x-csrf-token':login.data.csrfToken};
  assert.equal((await f.call('/jk/integrations/readiness',{headers})).data.pix.state,'blocked');
  const denied=await f.call(`/jk/orders/${order.id}/pix`,{method:'POST',headers,body:{version:order.version},status:403});
  assert.equal(denied.error.code,'FORBIDDEN');
});
