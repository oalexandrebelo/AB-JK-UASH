import { assert } from './errors.mjs';
import * as v from './validation.mjs';
import { requireRole } from './security.mjs';
import { OPERATORS, now, id, memo, publicRecord, record, version, insert, update, changed, mutate, paginate, iso, orderBalance, touchOrder } from './domain-core.mjs';

export { initializeJkDeliveries } from './jk-deliveries-schema.mjs';

export const DELIVERY_STATUSES = ['scheduled','en_route','completed','cancelled','failed'];
const TRANSITIONS = { scheduled: ['en_route','cancelled'], en_route: ['completed','failed'], completed: [], cancelled: [], failed: [] };
const EDIT_FIELDS = ['employeeId','startsAt','endsAt','address','notes'];
const STATES = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];

function addressInput(value) {
  v.object(value);
  v.onlyKeys(value,['street','number','neighborhood','city','state','postalCode','complement','reference']);
  const postalCode = v.text(value.postalCode ?? '', 'address.postalCode', {max:9}).replace('-', '');
  assert(!postalCode || /^\d{8}$/u.test(postalCode),422,'VALIDATION_ERROR','Informe um CEP com oito dígitos.');
  return {
    street: v.text(value.street,'address.street',{min:2,max:160}),
    number: v.text(value.number,'address.number',{min:1,max:20}),
    neighborhood: v.text(value.neighborhood,'address.neighborhood',{min:2,max:100}),
    city: v.text(value.city,'address.city',{min:2,max:100}),
    state: v.choice(value.state,'address.state',STATES),postalCode,
    complement: v.text(value.complement ?? '', 'address.complement',{max:160}),
    reference: v.text(value.reference ?? '', 'address.reference',{max:300}),
  };
}

async function sourceFor(db, delivery) {
  const appointment = delivery.appointment_id ? await record(db,'appointments',delivery.appointment_id) : null;
  const orderId = appointment?.order_id || delivery.order_id;
  const order = orderId ? await record(db,'orders',orderId) : null;
  return { appointment, order, row: appointment || order };
}

function assertSource(delivery, source) {
  assert(source.row.customer_id === delivery.customer_id && source.row.vehicle_id === delivery.vehicle_id
    && (!source.order || source.order.customer_id === delivery.customer_id && source.order.vehicle_id === delivery.vehicle_id),
  409,'DELIVERY_SOURCE_CHANGED','O cliente ou veículo do atendimento mudou. Cancele esta tarefa e crie outra com os dados atuais.');
  assert(source.row.status !== 'cancelled' && !['cancelled','quote'].includes(source.order?.status),
    409,'DELIVERY_SOURCE_CLOSED','O atendimento foi cancelado ou ainda é um orçamento.');
}

async function assertCanMove(db, delivery, source) {
  assertSource(delivery,source);
  await record(db,'employees',delivery.employee_id,true);
  if (delivery.kind === 'pickup') {
    assert(!source.order || ['scheduled','waiting'].includes(source.order.status),409,'PICKUP_NOT_AVAILABLE','O serviço já avançou. Confira a etapa da OS antes de retirar o veículo.');
  } else {
    assert(source.order && ['ready','delivered'].includes(source.order.status),409,'RETURN_NOT_READY','A devolução exige uma OS pronta para entrega.');
    assert((await orderBalance(db,source.order.id)).balanceCents === 0 || (await record(db,'customers',source.order.customer_id)).postpaid,
      409,'PAYMENT_REQUIRED','Quite a ordem antes da devolução ou habilite o cliente como pós-pago.');
  }
}

// The host's appointment/order availability check can use this same guard.
// The caller must run writes under its existing serialized transaction.
export async function checkJkDeliveryAvailability(db, employeeId, startsAt, endsAt, {deliveryId = ''} = {}) {
  if (!employeeId || !startsAt || !endsAt) return;
  const busy = await db.prepare("SELECT id FROM jk_deliveries WHERE employee_id=? AND id!=? AND status IN ('scheduled','en_route') AND starts_at<? AND ends_at>?")
    .get(employeeId,deliveryId,endsAt,startsAt);
  assert(!busy,409,'DELIVERY_SCHEDULE_CONFLICT','O responsável já tem uma retirada ou devolução nesse intervalo.');
}

async function availability(db, employeeId, startsAt, endsAt, deliveryId = '') {
  await checkJkDeliveryAvailability(db,employeeId,startsAt,endsAt,{deliveryId});
  const appointment = await db.prepare("SELECT id FROM appointments WHERE employee_id=? AND status NOT IN ('cancelled','converted') AND starts_at<? AND ends_at>?").get(employeeId,endsAt,startsAt);
  const order = await db.prepare("SELECT id FROM orders WHERE employee_id=? AND status NOT IN ('cancelled','delivered','quote') AND scheduled_at<? AND promised_at>?").get(employeeId,endsAt,startsAt);
  assert(!appointment && !order,409,'SCHEDULE_CONFLICT','O responsável já tem atendimento nesse intervalo.');
}

async function event(ctx,row,action,before = null,reason = '') {
  await ctx.db.prepare('INSERT INTO jk_delivery_events(id,delivery_id,actor_id,action,from_status,to_status,delivery_version,reason,snapshot_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id(),row.id,ctx.session.user.id,action,before?.status || null,row.status,row.version,reason,JSON.stringify({
      employeeId:row.employee_id,startsAt:row.starts_at,endsAt:row.ends_at,address:JSON.parse(row.address_json),
      notes:row.notes,receivedBy:row.received_by,
    }),now());
  await changed(ctx,`jk.delivery.${action}`,'delivery',row.id,{kind:row.kind,from:before?.status || null,to:row.status,version:row.version});
}

export async function deliveryView(db, deliveryId, {history = false} = {}) {
  const row = await record(db,'jk_deliveries',deliveryId);
  const {addressJson,...item} = publicRecord(row);
  const source = await sourceFor(db,row);
  const customer = await record(db,'customers',row.customer_id);
  const vehicle = await record(db,'vehicles',row.vehicle_id);
  const employee = await record(db,'employees',row.employee_id);
  return {
    ...item,address:JSON.parse(addressJson),customerName:customer.name,vehiclePlate:vehicle.plate,employeeName:employee.name,
    sourceStatus:source.row.status,sourceVersion:source.row.version,
    linkedOrderId:source.order?.id || null,orderNumber:source.order?.number || null,orderStatus:source.order?.status || null,orderVersion:source.order?.version || null,
    sourceChanged:source.row.customer_id !== row.customer_id || source.row.vehicle_id !== row.vehicle_id
      || Boolean(source.order && (source.order.customer_id !== row.customer_id || source.order.vehicle_id !== row.vehicle_id)),
    ...(history ? {events:(await db.prepare('SELECT e.*,u.name AS actor_name FROM jk_delivery_events e JOIN users u ON u.id=e.actor_id WHERE e.delivery_id=? ORDER BY e.delivery_version').all(row.id)).map(value => {
      const {snapshotJson,...entry}=publicRecord(value); return {...entry,snapshot:JSON.parse(snapshotJson)};
    })} : {}),
  };
}

async function editableValues(ctx,body,before) {
  const merged = {...(before ? publicRecord(before) : {}),...body};
  const employee = await record(ctx.db,'employees',v.identifier(merged.employeeId,'employeeId'),true);
  const startsAt = iso(merged.startsAt,'startsAt');
  const endsAt = iso(merged.endsAt,'endsAt');
  assert(endsAt > startsAt && Date.parse(endsAt)-Date.parse(startsAt) <= 24*3600_000,422,'INVALID_INTERVAL','Informe uma janela de transporte de até 24 horas, com término após o início.');
  const address = addressInput(body.address ?? (before ? JSON.parse(before.address_json) : undefined));
  await availability(ctx.db,employee.id,startsAt,endsAt,before?.id);
  return {employeeId:employee.id,startsAt,endsAt,addressJson:JSON.stringify(address),notes:memo(merged.notes)};
}

async function createDelivery(ctx,body) {
  v.onlyKeys(body,['appointmentId','orderId','sourceVersion','kind',...EDIT_FIELDS]);
  assert(Boolean(body.appointmentId) !== Boolean(body.orderId),422,'DELIVERY_SOURCE_REQUIRED','Selecione um agendamento ou uma OS para esta tarefa.');
  let appointment = body.appointmentId ? await record(ctx.db,'appointments',v.identifier(body.appointmentId,'appointmentId')) : null;
  const requestedOrder = body.orderId ? await record(ctx.db,'orders',v.identifier(body.orderId,'orderId')) : null;
  version(appointment || requestedOrder,body.sourceVersion);
  // Canonicalize converted appointments so using the OS cannot duplicate a leg.
  if (requestedOrder) appointment = await ctx.db.prepare('SELECT * FROM appointments WHERE order_id=?').get(requestedOrder.id) || null;
  const row = appointment || requestedOrder;
  const fields = {appointmentId:appointment?.id || null,orderId:appointment ? null : requestedOrder.id,
    customerId:row.customer_id,vehicleId:row.vehicle_id,kind:v.choice(body.kind,'kind',['pickup','return'])};
  const source = await sourceFor(ctx.db,{appointment_id:fields.appointmentId,order_id:fields.orderId});
  assertSource({customer_id:fields.customerId,vehicle_id:fields.vehicleId},source);
  const duplicate = await ctx.db.prepare(`SELECT id FROM jk_deliveries WHERE kind=? AND status NOT IN ('cancelled','failed') AND ${appointment ? 'appointment_id' : 'order_id'}=?`)
    .get(fields.kind,row.id);
  assert(!duplicate,409,'DELIVERY_EXISTS','Já existe uma tarefa deste tipo para o atendimento. Abra a tarefa existente.');
  const values = await editableValues(ctx,body);
  const delivery = await insert(ctx.db,'jk_deliveries',{...fields,...values,status:'scheduled',createdBy:ctx.session.user.id});
  await event(ctx,delivery,'created');
  return deliveryView(ctx.db,delivery.id,{history:true});
}

async function changeStatus(ctx,deliveryId,body) {
  v.onlyKeys(body,['version','status','reason','receivedBy','sourceVersion','orderVersion']);
  const row = await record(ctx.db,'jk_deliveries',deliveryId); version(row,body.version);
  const next = v.choice(body.status,'status',DELIVERY_STATUSES);
  assert(TRANSITIONS[row.status].includes(next),409,'INVALID_TRANSITION','Esta mudança de situação não é permitida.');
  const reason = memo(body.reason,'reason');
  assert(!['cancelled','failed'].includes(next) || reason.length >= 3,422,'DELIVERY_REASON_REQUIRED','Informe o motivo do cancelamento ou da tentativa sem sucesso.');
  let receivedBy = '';
  if (['en_route','completed'].includes(next)) {
    const source = await sourceFor(ctx.db,row);
    await assertCanMove(ctx.db,row,source);
    if (next === 'en_route') {
      await availability(ctx.db,row.employee_id,row.starts_at,row.ends_at,row.id);
      const active=await ctx.db.prepare("SELECT id FROM jk_deliveries WHERE employee_id=? AND id!=? AND status='en_route'").get(row.employee_id,row.id);
      assert(!active,409,'DRIVER_IN_TRANSIT','O responsável ainda está em deslocamento em outra tarefa. Conclua ou registre a falha antes da próxima saída.');
    }
    if (next === 'completed') {
      version(source.row,body.sourceVersion);
      receivedBy = v.text(body.receivedBy,'receivedBy',{min:2,max:120});
      if (row.kind === 'return') {
        version(source.order,body.orderVersion);
        if (source.order.status === 'ready') {
          await touchOrder(ctx.db,source.order.id,{status:'delivered',deliveredAt:now()});
          await changed(ctx,'order.transitioned','order',source.order.id,{from:'ready',to:'delivered',deliveryId:row.id});
        }
      } else if (source.appointment && !source.order && source.appointment.status !== 'arrived') {
        await update(ctx.db,'appointments',source.appointment,{status:'arrived'});
        await changed(ctx,'appointment.arrived','appointment',source.appointment.id,{deliveryId:row.id});
      } else if (source.order?.status === 'scheduled') {
        version(source.order,body.orderVersion);
        await touchOrder(ctx.db,source.order.id,{status:'waiting'});
        await changed(ctx,'order.transitioned','order',source.order.id,{from:'scheduled',to:'waiting',deliveryId:row.id});
      }
    }
  }
  const updated = await update(ctx.db,'jk_deliveries',row,{status:next,...(next === 'en_route' ? {dispatchedAt:now()} : {}),
    ...(next === 'completed' ? {completedAt:now(),receivedBy} : {})});
  await event(ctx,updated,next,row,reason);
  return deliveryView(ctx.db,row.id,{history:true});
}

export async function handleJkDeliveries(ctx) {
  const match = ctx.pathname.match(/^\/api\/jk\/deliveries(?:\/([\w-]+))?(?:\/(status))?$/u);
  if (!match) return null;
  requireRole(ctx.session,OPERATORS);
  const [,deliveryId,action] = match;
  if (ctx.method === 'GET' && !action) {
    if (deliveryId) return {data:{item:await deliveryView(ctx.db,deliveryId,{history:true})}};
    const clauses = [],params = [];
    for (const [key,column,choices] of [['status','d.status',DELIVERY_STATUSES],['kind','d.kind',['pickup','return']]]) {
      const value=ctx.url.searchParams.get(key); if (value) {clauses.push(`${column}=?`);params.push(v.choice(value,key,choices));}
    }
    for (const [key,column] of [['employeeId','d.employee_id'],['appointmentId','d.appointment_id'],['orderId','COALESCE(d.order_id,a.order_id)']]) {
      const value=ctx.url.searchParams.get(key); if(value) {clauses.push(`${column}=?`);params.push(v.identifier(value,key));}
    }
    const q=v.text(ctx.url.searchParams.get('q') || '', 'q',{max:120});
    if(q){clauses.push('(c.name LIKE ? OR v.plate LIKE ? OR e.name LIKE ?)');params.push(`%${q}%`,`%${q}%`,`%${q}%`);}
    for (const [key,operator] of [['from','>='],['to','<']]) {
      const value=ctx.url.searchParams.get(key);if(value){clauses.push(`d.starts_at${operator}?`);params.push(iso(value,key));}
    }
    const {rows,page}=await paginate(ctx.db,ctx.url,`SELECT d.id FROM jk_deliveries d JOIN customers c ON c.id=d.customer_id JOIN vehicles v ON v.id=d.vehicle_id JOIN employees e ON e.id=d.employee_id LEFT JOIN appointments a ON a.id=d.appointment_id${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY d.starts_at DESC,d.id`,params);
    return {data:{items:await Promise.all(rows.map(row=>deliveryView(ctx.db,row.id))),page}};
  }
  if(ctx.method === 'POST' && !deliveryId) return mutate(ctx,OPERATORS,body=>createDelivery(ctx,body),201);
  if(ctx.method === 'PATCH' && deliveryId && !action) return mutate(ctx,OPERATORS,async body=>{
    v.onlyKeys(body,['version',...EDIT_FIELDS]);
    assert(Object.keys(body).some(key=>key!=='version'),422,'VALIDATION_ERROR','Informe pelo menos uma alteração.');
    const before=await record(ctx.db,'jk_deliveries',deliveryId);version(before,body.version);
    assert(before.status==='scheduled',409,'DELIVERY_NOT_EDITABLE','Reagende ou altere a tarefa antes de iniciar o deslocamento.');
    assertSource(before,await sourceFor(ctx.db,before));
    const row=await update(ctx.db,'jk_deliveries',before,await editableValues(ctx,body,before));
    await event(ctx,row,'updated',before);
    return deliveryView(ctx.db,row.id,{history:true});
  });
  if(ctx.method === 'POST' && deliveryId && action==='status') return mutate(ctx,OPERATORS,body=>changeStatus(ctx,deliveryId,body));
  return null;
}
