import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fiscalFixture } from './fiscal-helpers.mjs';

const address={street:'Rua de Teste',number:'120',neighborhood:'Centro',city:'São Paulo',state:'SP',postalCode:'01001-000',complement:'Portão azul',reference:'Entrada pela rua lateral'};
async function fixture(t) {
  const f=await fiscalFixture(t,{jkIntegrationsEnv:{}});
  const driver=await f.create('/employees',{name:'Motorista de teste',roleLabel:'Transporte'});
  const seed=await f.order();
  const appointment=(overrides={})=>f.create('/appointments',{customerId:seed.customerId,vehicleId:seed.vehicleId,items:[{serviceId:f.service.id,quantity:1}],startsAt:'2031-02-10T14:00:00-03:00',endsAt:'2031-02-10T15:00:00-03:00',...overrides});
  const input=(source,overrides={})=>({[source.number?'orderId':'appointmentId']:source.id,sourceVersion:source.version,kind:'pickup',employeeId:driver.id,startsAt:'2031-02-10T13:00:00-03:00',endsAt:'2031-02-10T13:30:00-03:00',address,...overrides});
  const schedule=(source,overrides={})=>f.create('/jk/deliveries',input(source,overrides));
  const transition=async(item,status,extra={})=>(await f.call(`/jk/deliveries/${item.id}/status`,{method:'POST',body:{version:item.version,status,sourceVersion:item.sourceVersion,...(item.orderVersion?{orderVersion:item.orderVersion}:{}),...extra}})).data.item;
  return {...f,get app(){return f.app;},driver,seed,appointment,input,schedule,transition};
}

test('JK deliveries preserve pickup address, source, history and arrival across replay and restart',async t=>{
  const f=await fixture(t); const appointment=await f.appointment();
  const key=randomUUID(),body=f.input(appointment);
  const created=await f.call('/jk/deliveries',{method:'POST',body,key,status:201});
  let item=created.data.item;
  assert.equal(item.status,'scheduled'); assert.equal(item.startsAt,'2031-02-10T16:00:00.000Z');
  assert.equal(item.address.postalCode,'01001000'); assert.equal(item.address.reference,address.reference);
  assert.equal(item.appointmentId,appointment.id); assert.equal(item.customerId,appointment.customerId);
  assert.equal(item.employeeName,'Motorista de teste'); assert.equal(item.events.length,1);
  const replay=await f.call('/jk/deliveries',{method:'POST',body,key,status:201});
  assert.equal(replay.data.item.id,item.id); assert.equal(replay.response.headers.get('idempotency-replayed'),'true');
  await f.call('/jk/deliveries',{method:'POST',body:{...body,notes:'Outro conteúdo'},key,status:409});
  item=(await f.call(`/jk/deliveries/${item.id}`,{method:'PATCH',body:{version:item.version,address:{...address,number:'122'},endsAt:'2031-02-10T13:40:00-03:00'}})).data.item;
  assert.equal(item.address.number,'122'); assert.equal(item.events[0].snapshot.address.number,'120');
  item=await f.transition(item,'en_route');
  await f.call(`/jk/deliveries/${item.id}`,{method:'PATCH',body:{version:item.version,notes:'Não editar em trânsito'},status:409});
  const completion={version:item.version,status:'completed',sourceVersion:item.sourceVersion,receivedBy:'Recepção JK'};
  const completeKey=randomUUID();
  item=(await f.call(`/jk/deliveries/${item.id}/status`,{method:'POST',key:completeKey,body:completion})).data.item;
  await f.call(`/jk/deliveries/${item.id}/status`,{method:'POST',key:completeKey,body:completion});
  assert.equal(item.status,'completed');assert.equal(item.receivedBy,'Recepção JK');assert.ok(item.completedAt);
  assert.equal((await f.call(`/appointments/${appointment.id}`)).data.item.status,'arrived');
  await f.restart();
  item=(await f.call(`/jk/deliveries/${item.id}`)).data.item;
  assert.equal(item.events.length,4);assert.equal(item.events[3].snapshot.receivedBy,'Recepção JK');
  assert.equal((await f.app.store.prepare('SELECT COUNT(*) AS count FROM messages').get()).count,0);
  assert.equal((await f.app.store.prepare('SELECT COUNT(*) AS count FROM payments').get()).count,0);
});

test('JK deliveries enforce host session, CSRF, current RBAC, version and idempotency',async t=>{
  const f=await fixture(t),appointment=await f.appointment(),body=f.input(appointment);
  await f.call('/jk/deliveries',{headers:{cookie:''},status:401});
  await f.call('/jk/deliveries',{method:'POST',body,headers:{'x-csrf-token':''},status:403});
  await f.call('/jk/deliveries',{method:'POST',body,headers:{'idempotency-key':''},status:400});
  await f.call('/jk/deliveries',{method:'POST',body:{...body,sourceVersion:appointment.version+1},status:409});
  for (const role of ['manager','operator','viewer']) {
    const password='test-only-delivery-password';
    const user=(await f.call('/users',{method:'POST',body:{name:`Usuário ${role}`,email:`delivery-${role}@example.test`,password,role},status:201})).data.user;
    const login=await f.call('/auth/login',{method:'POST',body:{email:user.email,password}});
    const headers={cookie:login.response.headers.get('set-cookie').split(';')[0],'x-csrf-token':login.data.csrfToken};
    await f.call('/jk/deliveries',{headers,status:role==='viewer'?403:200});
    const source=await f.appointment();
    const requestBody=f.input(source,{startsAt:`2031-02-${role==='manager'?'11':'12'}T13:00:00-03:00`,endsAt:`2031-02-${role==='manager'?'11':'12'}T13:30:00-03:00`});
    const key=randomUUID();
    const response=await f.call('/jk/deliveries',{method:'POST',body:requestBody,headers,key,status:role==='viewer'?403:201});
    if(role!=='viewer') {
      await f.call(`/jk/deliveries/${response.data.item.id}`,{method:'PATCH',body:{version:999,notes:'Versão errada'},headers,status:409});
      // A demotion must deny a replay that had previously succeeded.
      await f.call(`/users/${user.id}`,{method:'PATCH',body:{role:'viewer'}});
      await f.call('/jk/deliveries',{method:'POST',body:requestBody,headers,key,status:401});
    }
  }
  assert.equal((await f.app.store.prepare('SELECT COUNT(*) AS count FROM jk_deliveries').get()).count,2);
});

test('JK delivery validation rejects incomplete addresses, invalid sources and invalid intervals atomically',async t=>{
  const f=await fixture(t),appointment=await f.appointment(),body=f.input(appointment);
  const invalid=[
    {...body,address:{...address,street:''}},
    {...body,address:{...address,state:'XX'}},
    {...body,address:{...address,postalCode:'123'}},
    {...body,address:{...address,latitude:-23.5}},
    {...body,startsAt:'2031-02-10T13:00:00'},
    {...body,endsAt:'2031-02-10T12:00:00-03:00'},
    {...body,endsAt:'2031-02-12T13:00:00-03:00'},
    {...body,orderId:f.seed.id},
    {...body,employeeId:''},
  ];
  for(const value of invalid) await f.call('/jk/deliveries',{method:'POST',body:value,status:422});
  await f.call('/jk/deliveries',{method:'POST',body:{...body,appointmentId:'missing'},status:404});
  const quote=await f.order({status:'quote'});
  await f.call('/jk/deliveries',{method:'POST',body:f.input(quote),status:409});
  await f.call(`/employees/${f.driver.id}`,{method:'PATCH',body:{version:f.driver.version,active:false}});
  await f.call('/jk/deliveries',{method:'POST',body,status:409});
  assert.equal((await f.app.store.prepare('SELECT COUNT(*) AS count FROM jk_deliveries').get()).count,0);
  assert.equal((await f.app.store.prepare('SELECT COUNT(*) AS count FROM jk_delivery_events').get()).count,0);
});

test('JK deliveries reserve employee time in both directions, accept adjacent windows and serialize simultaneous bookings',async t=>{
  const f=await fixture(t),source=await f.appointment(),other=await f.appointment();
  const body=f.input(source),peer=await f.peer();
  const results=await Promise.all([f.call('/jk/deliveries',{method:'POST',body,status:null}),peer.call('/jk/deliveries',{method:'POST',body,status:null})]);
  assert.deepEqual(results.map(item=>item.status).sort(),[201,409]);
  await f.call('/jk/deliveries',{method:'POST',body:f.input(other),status:409});
  const appointmentBody={customerId:f.seed.customerId,vehicleId:f.seed.vehicleId,employeeId:f.driver.id,items:[{serviceId:f.service.id,quantity:1}],startsAt:body.startsAt,endsAt:body.endsAt};
  const blocked=await f.call('/appointments',{method:'POST',body:appointmentBody,status:409});
  assert.equal(blocked.error.code,'DELIVERY_SCHEDULE_CONFLICT');
  await f.call('/orders',{method:'POST',body:{customerId:f.seed.customerId,vehicleId:f.seed.vehicleId,employeeId:f.driver.id,items:appointmentBody.items,status:'scheduled',scheduledAt:body.startsAt,promisedAt:body.endsAt},status:409});
  const adjacent=await f.schedule(other,{startsAt:body.endsAt,endsAt:'2031-02-10T14:00:00-03:00'});
  assert.equal(adjacent.status,'scheduled');
  const busy=await f.appointment({employeeId:f.driver.id,startsAt:'2031-02-11T14:00:00-03:00',endsAt:'2031-02-11T15:00:00-03:00'});
  const rejected=await f.call('/jk/deliveries',{method:'POST',body:f.input(busy,{kind:'return',startsAt:busy.startsAt,endsAt:busy.endsAt}),status:409});
  assert.equal(rejected.error.code,'SCHEDULE_CONFLICT');
});

test('JK converted appointment keeps one transport leg and follows its original order',async t=>{
  const f=await fixture(t),source=await f.appointment();
  const pickup=await f.schedule(source);
  const converted=await f.call(`/appointments/${source.id}/convert`,{method:'POST',body:{version:source.version},status:201});
  const order=converted.data.item;
  const duplicate=await f.call('/jk/deliveries',{method:'POST',body:f.input(order),status:409});
  assert.equal(duplicate.error.code,'DELIVERY_EXISTS');
  const result=(await f.call(`/jk/deliveries?orderId=${order.id}`)).data;
  assert.equal(result.items.length,1);assert.equal(result.items[0].id,pickup.id);assert.equal(result.items[0].linkedOrderId,order.id);
  const returned=await f.schedule(order,{kind:'return',startsAt:'2031-02-10T16:00:00-03:00',endsAt:'2031-02-10T17:00:00-03:00'});
  assert.equal(returned.appointmentId,source.id);assert.equal(returned.orderId,null);assert.equal(returned.linkedOrderId,order.id);
  assert.equal((await f.app.store.prepare('SELECT COUNT(*) AS count FROM orders').get()).count,2);
});

test('JK return completion requires ready order, payment and fresh source versions; order and delivery commit together',async t=>{
  const f=await fixture(t); let order=f.seed;
  let item=await f.schedule(order,{kind:'return'});
  let failure=await f.call(`/jk/deliveries/${item.id}/status`,{method:'POST',body:{version:item.version,status:'en_route'},status:409});
  assert.equal(failure.error.code,'RETURN_NOT_READY');
  for(const status of ['in_progress','quality_check','ready']) order=(await f.call(`/orders/${order.id}/transition`,{method:'POST',body:{version:order.version,status}})).data.item;
  failure=await f.call(`/jk/deliveries/${item.id}/status`,{method:'POST',body:{version:item.version,status:'en_route'},status:409});
  assert.equal(failure.error.code,'PAYMENT_REQUIRED');
  order=(await f.call(`/orders/${order.id}/payments`,{method:'POST',body:{version:order.version,amountCents:order.balanceCents,method:'credit',reference:'Teste interno'}})).data.item;
  item=await f.transition(item,'en_route');
  const before=item;
  order=(await f.call(`/orders/${order.id}/checklist`,{method:'POST',body:{version:order.version,items:[]}})).data.item;
  const stale=await f.call(`/jk/deliveries/${item.id}/status`,{method:'POST',body:{version:item.version,status:'completed',sourceVersion:before.sourceVersion,orderVersion:before.orderVersion,receivedBy:'Cliente de teste'},status:409});
  assert.equal(stale.error.code,'VERSION_CONFLICT');
  assert.equal((await f.call(`/orders/${order.id}`)).data.item.status,'ready');
  assert.equal((await f.call(`/jk/deliveries/${item.id}`)).data.item.status,'en_route');
  item=(await f.call(`/jk/deliveries/${item.id}`)).data.item;
  const body={version:item.version,status:'completed',sourceVersion:item.sourceVersion,orderVersion:item.orderVersion,receivedBy:'Cliente de teste'},key=randomUUID();
  item=(await f.call(`/jk/deliveries/${item.id}/status`,{method:'POST',body,key})).data.item;
  await f.call(`/jk/deliveries/${item.id}/status`,{method:'POST',body,key});
  assert.equal(item.status,'completed');assert.equal(item.orderStatus,'delivered');
  assert.equal((await f.call(`/orders/${order.id}`)).data.item.status,'delivered');
  assert.equal((await f.app.store.prepare('SELECT COUNT(*) AS count FROM payments').get()).count,1);
  assert.equal((await f.app.store.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action='order.transitioned' AND metadata_json LIKE '%deliveryId%'").get()).count,1);
});

test('JK delivery failure and cancellation require a reason, keep evidence, and permit a new attempt',async t=>{
  const f=await fixture(t),source=await f.appointment();
  let item=await f.schedule(source);
  await f.call(`/jk/deliveries/${item.id}/status`,{method:'POST',body:{version:item.version,status:'completed',receivedBy:'Cliente de teste'},status:409});
  await f.call(`/jk/deliveries/${item.id}/status`,{method:'POST',body:{version:item.version,status:'cancelled'},status:422});
  item=await f.transition(item,'cancelled',{reason:'Cliente solicitou outro dia'});
  assert.equal(item.events.at(-1).reason,'Cliente solicitou outro dia');
  const replacement=await f.schedule(source);assert.notEqual(replacement.id,item.id);
  let active=await f.transition(replacement,'en_route');
  await f.call(`/jk/deliveries/${active.id}/status`,{method:'POST',body:{version:active.version,status:'failed'},status:422});
  active=await f.transition(active,'failed',{reason:'Endereço sem ninguém para receber'});
  assert.equal(active.events.at(-1).reason,'Endereço sem ninguém para receber');
  assert.equal((await f.call(`/appointments/${source.id}`)).data.item.status,'scheduled');
  await f.call(`/jk/deliveries/${active.id}/status`,{method:'POST',body:{version:active.version,status:'scheduled'},status:409});
  assert.equal((await f.call('/jk/deliveries?status=failed&kind=pickup&q=Motorista&limit=1')).data.page.total,1);
  const next=await f.schedule(source);assert.notEqual(next.id,active.id);
});

test('JK source identity changes block transport but allow a reasoned cancellation',async t=>{
  const f=await fixture(t),source=await f.appointment();
  let item=await f.schedule(source);
  const customer=await f.create('/customers',{name:'Outro cliente'});
  const vehicle=await f.create('/vehicles',{customerId:customer.id,plate:'XYZ7A99',model:'Outro veículo'});
  await f.call(`/appointments/${source.id}`,{method:'PATCH',body:{version:source.version,customerId:customer.id,vehicleId:vehicle.id}});
  const changed=(await f.call(`/jk/deliveries/${item.id}`)).data.item;
  assert.equal(changed.sourceChanged,true);assert.equal(changed.customerId,source.customerId);
  const failure=await f.call(`/jk/deliveries/${item.id}/status`,{method:'POST',body:{version:item.version,status:'en_route'},status:409});
  assert.equal(failure.error.code,'DELIVERY_SOURCE_CHANGED');
  item=await f.transition(item,'cancelled',{reason:'Vínculo corrigido no atendimento'});
  assert.equal(item.status,'cancelled');
});

test('JK postpaid return preserves receivable and an employee cannot drive two legs at once',async t=>{
  const f=await fixture(t);
  const customer=(await f.call(`/customers/${f.seed.customerId}`)).data.item;
  await f.call(`/customers/${customer.id}`,{method:'PATCH',body:{version:customer.version,postpaid:true}});
  let order=f.seed;
  for(const status of ['in_progress','quality_check','ready']) order=(await f.call(`/orders/${order.id}/transition`,{method:'POST',body:{version:order.version,status}})).data.item;
  let returned=await f.schedule(order,{kind:'return'});
  const source=await f.appointment();
  let pickup=await f.schedule(source,{startsAt:'2031-02-10T13:30:00-03:00',endsAt:'2031-02-10T14:00:00-03:00'});
  returned=await f.transition(returned,'en_route');
  const busy=await f.call(`/jk/deliveries/${pickup.id}/status`,{method:'POST',body:{version:pickup.version,status:'en_route'},status:409});
  assert.equal(busy.error.code,'DRIVER_IN_TRANSIT');
  returned=await f.transition(returned,'completed',{receivedBy:'Cliente pós-pago'});
  assert.equal(returned.orderStatus,'delivered');
  const delivered=(await f.call(`/orders/${order.id}`)).data.item;
  assert.equal(delivered.balanceCents,order.totalCents);assert.equal(delivered.paidCents,0);
  assert.equal((await f.app.store.prepare('SELECT COUNT(*) AS count FROM payments').get()).count,0);
  pickup=await f.transition(pickup,'en_route');
  assert.equal(pickup.status,'en_route');
});
