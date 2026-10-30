import { randomUUID } from 'node:crypto';
import { audit, idempotentWrite, transaction } from './db.mjs';
import { ApiError, assert } from './errors.mjs';
import { requireRole, requireLiveRole, verifyCsrf } from './security.mjs';
import { readJson } from './http.mjs';
import { ENTITIES, MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, canonical, decodeImport, hashObject, onlyKeys, technicalImportId } from './jk-migration-parse.mjs';
export { initializeJkMigration } from './jk-migration-schema.mjs';
export { ENTITIES, MAX_IMPORT_BYTES, MAX_IMPORT_ROWS };

const TABLES = {customers:'customers',vehicles:'vehicles',services:'services',orders:'jk_history_orders',orderItems:'jk_history_order_items',payments:'jk_history_payments'};
const MONEY_LIMIT = 1_000_000_000;
const ROLES = ['admin'];
const STATUSES = ['quote','scheduled','waiting','in_progress','quality_check','ready','delivered','cancelled'];
const METHODS = ['cash','pix','credit','debit','transfer'];
const idKey = (entity,originKey) => `${entity}\u0000${originKey}`;
const emptyCounts = () => Object.fromEntries(ENTITIES.map(entity => [entity,{received:0,insert:0,unchanged:0,rejected:0}]));

function invalid(code,field,message) { throw new ApiError(422,code,message,{field}); }
function text(value,field,{required = false,max = 2000} = {}) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || required && !value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(value)) invalid('INVALID_IMPORT_TEXT',field,'Texto ausente, longo demais ou com caracteres inválidos.');
  return value.trim();
}
function sourceId(value,field = 'sourceId') {
  const result = text(value,field,{required:true,max:256});
  if (result !== value || /\s/u.test(result)) invalid('INVALID_SOURCE_ID',field,'IDs de origem devem ser textos estáveis, sem espaços.');
  return result;
}
function integer(value,field,{min = 0,max = MONEY_LIMIT,defaultValue} = {}) {
  if (value === undefined && defaultValue !== undefined) return defaultValue;
  if (!Number.isSafeInteger(value) || value < min || value > max || Object.is(value,-0)) invalid('INVALID_IMPORT_INTEGER',field,'Use um inteiro dentro dos limites do contrato; valores monetários são centavos.');
  return value;
}
function boolean(value,field,defaultValue) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'boolean') invalid('INVALID_IMPORT_BOOLEAN',field,'Use um valor booleano.');
  return value;
}
function choice(value,field,allowed,defaultValue) {
  if (value === undefined && defaultValue !== undefined) return defaultValue;
  if (!allowed.includes(value)) invalid('UNSUPPORTED_IMPORT_VALUE',field,'O valor não possui representação no contrato de importação.');
  return value;
}
function timestamp(value,field,required = false) {
  if ((value === undefined || value === null || value === '') && !required) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(Date.parse(value))) invalid('INVALID_IMPORT_DATE',field,'Use data ISO 8601 com horário e fuso explícito.');
  const calendar = value.slice(0,10);
  if (new Date(`${calendar}T00:00:00Z`).toISOString().slice(0,10) !== calendar) invalid('INVALID_IMPORT_DATE',field,'A data não existe no calendário.');
  return new Date(value).toISOString();
}
function reference(value,prefix) {
  const source = value[`${prefix}SourceId`], imported = value[`${prefix}ImportId`];
  if ((source !== undefined) === (imported !== undefined)) invalid('IMPORT_REFERENCE_REQUIRED',`${prefix}SourceId`,'Informe exatamente um ID de origem ou ID técnico de importação para a referência.');
  if (imported !== undefined) {
    if (typeof imported !== 'string' || !/^jk_[A-Za-z]+_[a-f0-9]{32}$/u.test(imported)) invalid('INVALID_IMPORT_REFERENCE',`${prefix}ImportId`,'O ID técnico de importação é inválido.');
    return {importId:imported};
  }
  return {sourceId:sourceId(source,`${prefix}SourceId`)};
}
const referenceFields = prefix => [`${prefix}SourceId`,`${prefix}ImportId`];
function normalize(entity,input,origin) {
  const base = ['sourceId','createdAt'];
  const fields = {
    customers:['name','phone','email','kind','postpaid','notes','active'],
    vehicles:[...referenceFields('customer'),'plate','model','color','category','active'],
    services:['name','priceCents','durationMinutes','commissionBps','active'],
    orders:['number',...referenceFields('customer'),...referenceFields('vehicle'),'status','subtotalCents','discountCents','totalCents','notes','deliveredAt'],
    orderItems:[...referenceFields('order'),...referenceFields('service'),'name','quantity','unitPriceCents','lineTotalCents','discountCents','netCents','historicalCommissionCents'],
    payments:[...referenceFields('order'),...referenceFields('customer'),'amountCents','method','reference'],
  };
  onlyKeys(input,[...base,...fields[entity]]);
  const result = {sourceId:origin ? null : sourceId(input.sourceId),createdAt:timestamp(input.createdAt,'createdAt',['orders','payments'].includes(entity))};
  if (entity === 'customers') {
    result.name = text(input.name,'name',{required:true,max:120});
    if (result.name.length < 2 && !origin) invalid('INVALID_IMPORT_TEXT','name','O nome canônico deve ter ao menos dois caracteres.');
    result.phone = text(input.phone,'phone',{max:30});
    result.email = text(input.email,'email',{max:254}).toLowerCase();
    if (result.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(result.email)) invalid('INVALID_IMPORT_EMAIL','email','O e-mail informado não é válido.');
    Object.assign(result,{kind:choice(input.kind,'kind',['individual','company'],'individual'),postpaid:boolean(input.postpaid,'postpaid',false),notes:text(input.notes,'notes'),active:boolean(input.active,'active',true)});
  } else if (entity === 'vehicles') {
    result.customer = reference(input,'customer');
    result.plate = text(input.plate,'plate',{required:true,max:16}).toUpperCase().replace(/[\s-]/gu,'');
    if (!/^[A-Z0-9]{4,12}$/u.test(result.plate)) invalid('INVALID_IMPORT_PLATE','plate','A placa precisa de quatro a doze letras ou números.');
    Object.assign(result,{model:text(input.model,'model',{required:origin?.derived !== 'native-plate',max:100}),color:text(input.color,'color',{max:60}),category:choice(input.category,'category',['small','medium','large','motorcycle'],'small'),active:boolean(input.active,'active',true)});
  } else if (entity === 'services') {
    Object.assign(result,{name:text(input.name,'name',{required:true,max:120}),priceCents:integer(input.priceCents,'priceCents'),durationMinutes:integer(input.durationMinutes,'durationMinutes',{min:1,max:1440}),commissionBps:integer(input.commissionBps,'commissionBps',{max:10000,defaultValue:0}),active:boolean(input.active,'active',true)});
  } else if (entity === 'orders') {
    Object.assign(result,{number:text(input.number,'number',{required:true,max:80}),customer:reference(input,'customer'),vehicle:reference(input,'vehicle'),status:choice(input.status,'status',STATUSES),subtotalCents:integer(input.subtotalCents,'subtotalCents'),discountCents:integer(input.discountCents,'discountCents',{defaultValue:0}),totalCents:integer(input.totalCents,'totalCents'),notes:text(input.notes,'notes'),deliveredAt:timestamp(input.deliveredAt,'deliveredAt')});
    if (result.subtotalCents - result.discountCents !== result.totalCents) invalid('ORDER_TOTAL_MISMATCH','totalCents','O total da OS deve ser subtotal menos desconto.');
    if (result.deliveredAt && result.deliveredAt < result.createdAt) invalid('INVALID_IMPORT_DATE','deliveredAt','A entrega antecede a criação da OS.');
  } else if (entity === 'orderItems') {
    Object.assign(result,{order:reference(input,'order'),service:reference(input,'service'),name:text(input.name,'name',{required:true,max:120}),quantity:integer(input.quantity,'quantity',{min:1,max:100000}),unitPriceCents:integer(input.unitPriceCents,'unitPriceCents'),lineTotalCents:integer(input.lineTotalCents,'lineTotalCents'),discountCents:integer(input.discountCents,'discountCents',{defaultValue:0}),netCents:integer(input.netCents,'netCents'),historicalCommissionCents:integer(input.historicalCommissionCents,'historicalCommissionCents',{defaultValue:0})});
    if (BigInt(result.quantity) * BigInt(result.unitPriceCents) !== BigInt(result.lineTotalCents) || result.lineTotalCents - result.discountCents !== result.netCents) invalid('ITEM_TOTAL_MISMATCH','netCents','O item deve reconciliar quantidade, preço, desconto e total líquido.');
    if (result.historicalCommissionCents > result.netCents) invalid('ITEM_COMMISSION_MISMATCH','historicalCommissionCents','A comissão histórica excede o valor líquido do item.');
  } else {
    Object.assign(result,{order:reference(input,'order'),customer:reference(input,'customer'),amountCents:integer(input.amountCents,'amountCents',{min:1}),method:choice(input.method,'method',METHODS),reference:text(input.reference,'reference',{max:200})});
  }
  return result;
}

async function loadState(db) {
  const origins = await db.prepare("SELECT * FROM jk_migration_records WHERE source='jumpcar' AND scope='jk' ORDER BY entity,origin_key").all();
  const tables = {};
  for (const entity of ENTITIES) tables[entity] = await db.prepare(`SELECT * FROM ${TABLES[entity]} ORDER BY id`).all();
  return {origins,tables};
}

async function preparePlan(db,input) {
  const decoded = decodeImport(input);
  const priorBatch = await db.prepare("SELECT report_json FROM jk_migration_batches WHERE source='jumpcar' AND scope='jk' AND input_hash=?").get(decoded.inputHash);
  if (priorBatch) {
    const prior = JSON.parse(priorBatch.report_json);
    return {decoded,entries:[],report:{...prior,status:'PREVIEW',canCommit:true,replayAvailable:true,replayed:false,counts:Object.fromEntries(ENTITIES.map(entity => [entity,{...prior.counts[entity],insert:0,unchanged:prior.counts[entity].insert + prior.counts[entity].unchanged}]))}};
  }
  const state = await loadState(db), counts = emptyCounts();
  const issues = [], rejected = new Set(), entries = [], identityMap = [];
  let totalIssueCount = 0;
  const issue = (entry,code,message,field) => {
    totalIssueCount++;
    if (entry) rejected.add(`${entry.entity}:${entry.row}`);
    if (issues.length < 1000) issues.push({entity:entry?.entity || 'dataset',row:entry?.row ?? null,code,message,...(field ? {field} : {})});
  };
  const origins = new Map(state.origins.map(row => [idKey(row.entity,row.origin_key),row]));
  const targets = Object.fromEntries(ENTITIES.map(entity => [entity,new Map(state.tables[entity].map(row => [row.id,row]))]));
  const keyed = new Map(), imported = new Map();
  for (const prior of state.origins) imported.set(prior.target_id,{entity:prior.entity,targetId:prior.target_id,existing:targets[prior.entity]?.get(prior.target_id)});
  for (const snapshotHash of decoded.snapshots) {
    if (state.origins.some(row => row.entity === 'customers' && row.provenance === 'snapshot-row' && row.snapshot_hash !== snapshotHash)) issue(null,'SNAPSHOT_RECONCILIATION_REQUIRED','Já existe outra exportação nativa de clientes. Reconcilie os IDs técnicos antes de importar um novo snapshot.');
  }
  for (const entity of ENTITIES) {
    counts[entity].received = decoded.rows[entity].length;
    for (const [index,row] of decoded.rows[entity].entries()) {
      const entry = {entity,row:index + 1,origin:row.origin};
      try {
        entry.value = normalize(entity,row.value,row.origin);
        entry.originKey = row.origin?.originKey || `source:${entry.value.sourceId}`;
        entry.targetId = technicalImportId(entity,entry.originKey);
        entry.rowHash = hashObject({value:entry.value,origin:row.origin});
        const key = idKey(entity,entry.originKey), prior = origins.get(key);
        if (keyed.has(key)) { issue(entry,'DUPLICATE_SOURCE_ID','Há IDs de origem repetidos na mesma coleção.'); issue(keyed.get(key),'DUPLICATE_SOURCE_ID','Há IDs de origem repetidos na mesma coleção.'); }
        else keyed.set(key,entry);
        if (prior) {
          entry.targetId = prior.target_id; entry.action = 'unchanged';
          if (prior.row_hash !== entry.rowHash) issue(entry,'SOURCE_RECORD_CHANGED','O ID de origem já foi importado com conteúdo diferente. Uma atualização exige reconciliação explícita.');
          if (!targets[entity].has(prior.target_id)) issue(entry,'IMPORT_TARGET_MISSING','O registro de destino vinculado não existe.');
        } else {
          entry.action = 'insert';
          if (targets[entity].has(entry.targetId)) issue(entry,'IMPORT_ID_COLLISION','O ID técnico de destino já está em uso sem correspondência de origem.');
        }
        imported.set(entry.targetId,entry);
        if (row.origin) identityMap.push({entity,row:row.origin.row,importId:entry.targetId,sourceId:null,provenance:'snapshot-row',snapshotHash:row.origin.snapshotHash});
        entries.push(entry);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        issue(entry,error.code,error.message,error.details?.field);
      }
    }
  }
  function resolveRef(entry,entity,ref,field) {
    const resolved = ref.importId ? imported.get(ref.importId) : keyed.get(idKey(entity,`source:${ref.sourceId}`)) || (() => {
      const prior = origins.get(idKey(entity,`source:${ref.sourceId}`));
      return prior && {entity,targetId:prior.target_id,existing:targets[entity].get(prior.target_id)};
    })();
    if (!resolved || resolved.entity !== entity || !resolved.value && !resolved.existing) { issue(entry,'ORPHAN_IMPORT_REFERENCE','A referência não está no lote nem em uma importação anterior válida.',field); return null; }
    return resolved.targetId;
  }
  const plateOwner = new Map(state.tables.vehicles.map(row => [row.plate,row.id]));
  for (const entry of entries) {
    const value = entry.value;
    entry.refs = {};
    for (const [name,entity] of [['customer','customers'],['vehicle','vehicles'],['order','orders'],['service','services']]) if (value[name]) entry.refs[`${name}Id`] = resolveRef(entry,entity,value[name],name);
    if (entry.entity === 'vehicles') {
      if (plateOwner.has(value.plate) && plateOwner.get(value.plate) !== entry.targetId) issue(entry,'PLATE_ALREADY_EXISTS','A placa já está vinculada a outro cadastro. Não há mesclagem automática.','plate');
      else plateOwner.set(value.plate,entry.targetId);
    }
  }
  const newEntry = (entity,id) => { const entry = imported.get(id); return entry?.entity === entity && entry.value ? entry : null; };
  for (const entry of entries) {
    if (entry.entity === 'orders' && entry.refs.vehicleId && entry.refs.customerId) {
      const vehicle = imported.get(entry.refs.vehicleId);
      const owner = targets.vehicles.get(entry.refs.vehicleId)?.customer_id || vehicle?.refs?.customerId || vehicle?.existing?.customer_id;
      if (owner !== entry.refs.customerId) issue(entry,'VEHICLE_CUSTOMER_MISMATCH','O veículo não pertence ao cliente informado na OS.','vehicle');
    }
    if (entry.entity === 'payments' && entry.refs.orderId && entry.refs.customerId) {
      const order = imported.get(entry.refs.orderId);
      const owner = targets.orders.get(entry.refs.orderId)?.customer_id || order?.refs?.customerId || order?.existing?.customer_id;
      if (owner !== entry.refs.customerId) issue(entry,'PAYMENT_CUSTOMER_MISMATCH','O pagamento não pertence ao cliente da OS.','customer');
    }
    if (['orderItems','payments'].includes(entry.entity) && entry.action === 'insert' && entry.refs.orderId && !newEntry('orders',entry.refs.orderId)) issue(entry,'ORDER_RECONCILIATION_REQUIRED','Itens e pagamentos novos exigem a OS no lote para uma reconciliação completa.');
  }
  let ordersTotalCents = 0, paymentsTotalCents = 0, itemNetTotalCents = 0;
  const itemsByOrder = new Map(), paymentsByOrder = new Map();
  const group = (groups,orderId,id,value) => { if (!groups.has(orderId)) groups.set(orderId,new Map()); groups.get(orderId).set(id,value); };
  for (const item of state.tables.orderItems) group(itemsByOrder,item.order_id,item.id,{subtotal:item.line_total_cents,discount:item.discount_cents,net:item.net_cents});
  for (const payment of state.tables.payments) group(paymentsByOrder,payment.order_id,payment.id,payment.amount_cents);
  for (const entry of entries) {
    if (entry.entity === 'orderItems' && entry.refs.orderId) group(itemsByOrder,entry.refs.orderId,entry.targetId,{subtotal:entry.value.lineTotalCents,discount:entry.value.discountCents,net:entry.value.netCents});
    if (entry.entity === 'payments' && entry.refs.orderId) group(paymentsByOrder,entry.refs.orderId,entry.targetId,entry.value.amountCents);
  }
  // Reconciliation covers complete affected orders, including rows imported in
  // earlier batches. Received/insert/unchanged counts remain specific to input.
  const affectedOrders = new Map(entries.filter(entry => entry.entity === 'orders').map(entry => [entry.targetId,{entry,value:entry.value}]));
  for (const entry of entries) {
    if (!entry.refs.orderId || affectedOrders.has(entry.refs.orderId)) continue;
    const existing = targets.orders.get(entry.refs.orderId);
    if (existing) affectedOrders.set(existing.id,{entry:null,value:{subtotalCents:existing.subtotal_cents,discountCents:existing.discount_cents,totalCents:existing.total_cents,status:existing.status}});
  }
  for (const [orderId,{entry,value}] of affectedOrders) {
    const items = itemsByOrder.get(orderId) || new Map(), payments = paymentsByOrder.get(orderId) || new Map();
    const sum = field => [...items.values()].reduce((total,item) => total + BigInt(item[field]),0n);
    const net = sum('net');
    if (!items.size || sum('subtotal') !== BigInt(value.subtotalCents) || sum('discount') !== BigInt(value.discountCents) || net !== BigInt(value.totalCents)) issue(entry,'ORDER_ITEMS_MISMATCH','Os itens devem reconciliar exatamente subtotal, desconto e total da OS.');
    const paid = [...payments.values()].reduce((total,value) => total + BigInt(value),0n);
    if (paid > BigInt(value.totalCents)) issue(entry,'PAYMENT_TOTAL_MISMATCH','A soma dos pagamentos excede o total da OS. Estornos exigem um layout próprio.');
    if (value.status === 'cancelled' && paid > 0n) issue(entry,'CANCELLED_ORDER_PAYMENT','OS cancelada com recebimento exige reconciliação de estorno antes da importação.');
    ordersTotalCents += value.totalCents;
    paymentsTotalCents += Number(paid);
    itemNetTotalCents += Number(net);
  }
  for (const entry of entries) {
    if (!rejected.has(`${entry.entity}:${entry.row}`)) counts[entry.entity][entry.action]++;
  }
  for (const key of rejected) counts[key.split(':')[0]].rejected++;
  const reconciliation = {ordersTotalCents,itemNetTotalCents,paymentsTotalCents,historicalOutstandingCents:ordersTotalCents - paymentsTotalCents,operationalWrites:{orders:0,payments:0,cashMovements:0,invoices:0,fiscalDocuments:0,messages:0,stockMovements:0,commissions:0}};
  const previewHash = hashObject({version:1,inputHash:decoded.inputHash,state:hashObject(state),counts,reconciliation,issues,totalIssueCount});
  const report = {status:totalIssueCount ? 'REJECTED' : 'PREVIEW',previewHash,inputHash:decoded.inputHash,canCommit:totalIssueCount === 0,mode:'historical',source:'jumpcar',scope:'jk',counts,issues,totalIssueCount,warnings:decoded.warnings,reconciliation,identityMap,sourceVerified:false,...(decoded.nativeCustomerImport ? {nativeCustomerImport:decoded.nativeCustomerImport} : {})};
  return {decoded,entries,report};
}

// A preview is a read-only SQLite snapshot. No batch, log, staging table or file is created.
export async function previewJkMigration(db,input,{authorize} = {}) {
  assert(db.mode === 'local',501,'JK_MIGRATION_LOCAL_ONLY','A migração JK está disponível somente no armazenamento SQLite local.');
  return db.read(async () => { if (authorize) await authorize(); return (await preparePlan(db,input)).report; });
}

async function insertEntry(db,entry,batchId,stamp) {
  const {entity,value:v,refs:r,targetId:id} = entry;
  const created = v.createdAt || stamp;
  if (entity === 'customers') await db.prepare('INSERT INTO customers(id,name,phone,email,kind,postpaid,notes,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,v.name,v.phone,v.email,v.kind,Number(v.postpaid),v.notes,Number(v.active),created,stamp);
  if (entity === 'vehicles') await db.prepare('INSERT INTO vehicles(id,customer_id,plate,model,color,category,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,r.customerId,v.plate,v.model,v.color,v.category,Number(v.active),created,stamp);
  if (entity === 'services') await db.prepare('INSERT INTO services(id,name,price_cents,duration_minutes,commission_bps,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id,v.name,v.priceCents,v.durationMinutes,v.commissionBps,Number(v.active),created,stamp);
  if (entity === 'orders') await db.prepare('INSERT INTO jk_history_orders(id,number,customer_id,vehicle_id,status,subtotal_cents,discount_cents,total_cents,notes,created_at,delivered_at,batch_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,v.number,r.customerId,r.vehicleId,v.status,v.subtotalCents,v.discountCents,v.totalCents,v.notes,created,v.deliveredAt,batchId);
  if (entity === 'orderItems') await db.prepare('INSERT INTO jk_history_order_items(id,order_id,service_id,name,quantity,unit_price_cents,line_total_cents,discount_cents,net_cents,commission_cents,created_at,batch_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,r.orderId,r.serviceId,v.name,v.quantity,v.unitPriceCents,v.lineTotalCents,v.discountCents,v.netCents,v.historicalCommissionCents,created,batchId);
  if (entity === 'payments') await db.prepare('INSERT INTO jk_history_payments(id,order_id,customer_id,amount_cents,method,reference,created_at,batch_id) VALUES(?,?,?,?,?,?,?,?)').run(id,r.orderId,r.customerId,v.amountCents,v.method,v.reference,created,batchId);
  const origin = entry.origin;
  await db.prepare('INSERT INTO jk_migration_records(source,scope,entity,origin_key,source_id,provenance,snapshot_hash,source_row,target_id,row_hash,batch_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('jumpcar','jk',entity,entry.originKey,v.sourceId,origin ? 'snapshot-row' : 'source-id',origin?.snapshotHash || null,origin?.row || null,id,entry.rowHash,batchId);
  if (origin?.archive) await db.prepare('INSERT INTO jk_migration_source_rows(id,batch_id,customer_id,snapshot_hash,source_row,data_json) VALUES(?,?,?,?,?,?)').run(id,batchId,id,origin.snapshotHash,origin.row,JSON.stringify(origin.archive));
}

export async function commitJkMigration(db,input,{previewHash = input?.previewHash,actorId = null,idempotencyKey,authorize} = {}) {
  assert(db.mode === 'local',501,'JK_MIGRATION_LOCAL_ONLY','A migração JK está disponível somente no armazenamento SQLite local.');
  assert(typeof previewHash === 'string' && /^[a-f0-9]{64}$/u.test(previewHash),422,'PREVIEW_HASH_REQUIRED','Informe o hash da prévia revisada.');
  const decoded = decodeImport(input);
  const authorizeCommit = async () => {
    if (authorize) await authorize();
    // Local callers can supply an audited administrator without an HTTP session.
    // Check that principal in the same transaction as writes and replay lookup.
    if (actorId !== null) assert(await db.prepare("SELECT id FROM users WHERE id=? AND active=1 AND role='admin'").get(actorId),403,'ADMIN_REQUIRED','O ator precisa ser um administrador ativo.');
  };
  const operation = async () => {
    const prior = await db.prepare("SELECT preview_hash,report_json FROM jk_migration_batches WHERE source='jumpcar' AND scope='jk' AND input_hash=?").get(decoded.inputHash);
    if (prior) {
      assert(prior.preview_hash === previewHash,409,'PREVIEW_HASH_MISMATCH','O hash não corresponde ao lote confirmado.');
      return {...JSON.parse(prior.report_json),status:'REPLAYED',replayed:true};
    }
    const {report,entries} = await preparePlan(db,input);
    assert(report.previewHash === previewHash,409,'PREVIEW_HASH_MISMATCH','O conteúdo ou o banco mudou desde a prévia. Gere uma nova prévia.');
    assert(report.canCommit,422,'IMPORT_REJECTED','A importação contém rejeições. Nenhum registro foi gravado.',{report});
    const batchId = randomUUID(), committedAt = new Date().toISOString();
    const result = {...report,status:'COMMITTED',batchId,committedAt,canCommit:false,replayed:false};
    await db.prepare('INSERT INTO jk_migration_batches(id,source,scope,input_hash,preview_hash,report_json,actor_id,committed_at) VALUES(?,?,?,?,?,?,?,?)').run(batchId,'jumpcar','jk',decoded.inputHash,previewHash,JSON.stringify(result),actorId,committedAt);
    for (const entry of entries) if (entry.action === 'insert') await insertEntry(db,entry,batchId,committedAt);
    const invalidForeignKeys = await db.prepare('PRAGMA foreign_key_check').all();
    assert(invalidForeignKeys.length === 0,409,'IMPORT_FOREIGN_KEY_FAILURE','A reconciliação de vínculos falhou. A transação foi revertida.');
    await audit(db,{actorId,action:'jk.migration.committed',resourceType:'jk_migration_batch',resourceId:batchId,metadata:{mode:'historical',inputHash:decoded.inputHash,previewHash,counts:Object.fromEntries(ENTITIES.map(entity => [entity,report.counts[entity].insert])),...(report.nativeCustomerImport ? {nativeCustomerImport:report.nativeCustomerImport} : {})}});
    return result;
  };
  if (idempotencyKey !== undefined) {
    assert(actorId,401,'AUTH_REQUIRED','A importação exige um administrador autenticado.');
    const response = await idempotentWrite(db,{actorId,key:idempotencyKey,method:'POST',path:'/api/jk/migration/commit',body:{input:canonical(input),previewHash},authorize:authorizeCommit},operation);
    return response.replayed ? {...response,status:'REPLAYED',replayed:true} : response;
  }
  return transaction(db,async () => { await authorizeCommit(); return operation(); });
}

function available(db) { assert(db.mode === 'local',501,'JK_MIGRATION_LOCAL_ONLY','A migração JK está disponível somente no armazenamento SQLite local.'); }
export async function jkMigrationStatus(db) {
  if (db.mode !== 'local') return {supported:false,mode:'historical',source:'jumpcar',scope:'jk',reason:'SQLITE_LOCAL_REQUIRED',limits:{maxBytes:MAX_IMPORT_BYTES,maxRows:MAX_IMPORT_ROWS}};
  const counts = {};
  for (const entity of ENTITIES) counts[entity] = (await db.prepare('SELECT COUNT(*) AS count FROM jk_migration_records WHERE entity=?').get(entity)).count;
  const batches = await db.prepare('SELECT id,committed_at,report_json FROM jk_migration_batches ORDER BY committed_at DESC,rowid DESC LIMIT 20').all();
  const totals = await db.prepare('SELECT COALESCE(SUM(total_cents),0) AS ordersTotalCents FROM jk_history_orders').get();
  totals.paymentsTotalCents = (await db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS total FROM jk_history_payments').get()).total;
  totals.historicalOutstandingCents = totals.ordersTotalCents - totals.paymentsTotalCents;
  return {supported:true,mode:'historical',source:'jumpcar',scope:'jk',counts,totals,limits:{maxBytes:MAX_IMPORT_BYTES,maxRows:MAX_IMPORT_ROWS},latestBatches:batches.map(row => { const report = JSON.parse(row.report_json); return {batchId:row.id,committedAt:row.committed_at,counts:report.counts,reconciliation:report.reconciliation,previewHash:report.previewHash,...(report.nativeCustomerImport ? {nativeCustomerImport:report.nativeCustomerImport} : {})}; })};
}

export async function jkMigrationHistory(db,url) {
  available(db);
  const entity = url.searchParams.get('entity') || 'orders';
  assert(['orders','orderItems','payments','sourceRows'].includes(entity),422,'INVALID_HISTORY_ENTITY','Selecione orders, orderItems, payments ou sourceRows.');
  const limit = Number(url.searchParams.get('limit') || 100), offset = Number(url.searchParams.get('offset') || 0);
  assert(Number.isSafeInteger(limit) && limit >= 1 && limit <= 500 && Number.isSafeInteger(offset) && offset >= 0 && offset <= 1000000000,422,'INVALID_HISTORY_PAGE','Paginação inválida.');
  const table = entity === 'sourceRows' ? 'jk_migration_source_rows' : TABLES[entity];
  const total = (await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).count;
  const rows = await db.prepare(`SELECT * FROM ${table} ORDER BY id LIMIT ? OFFSET ?`).all(limit,offset);
  const items = rows.map(row => Object.fromEntries(Object.entries(row).map(([key,value]) => [key.replace(/_([a-z])/gu,(_,char) => char.toUpperCase()),key === 'data_json' ? JSON.parse(value) : value])));
  return {mode:'historical',items,page:{limit,offset,total,hasMore:offset + items.length < total}};
}

export async function handleJkMigration(ctx) {
  if (!ctx.pathname.startsWith('/api/jk/migration/')) return null;
  const actor = requireRole(ctx.session,ROLES);
  if (ctx.method === 'GET') {
    await requireLiveRole(ctx.db,ctx.session,ROLES);
    if (ctx.pathname === '/api/jk/migration/status') return {data:await jkMigrationStatus(ctx.db)};
    if (ctx.pathname === '/api/jk/migration/history') return {data:await jkMigrationHistory(ctx.db,ctx.url)};
    return null;
  }
  if (ctx.method !== 'POST' || !['/api/jk/migration/preview','/api/jk/migration/commit'].includes(ctx.pathname)) return null;
  verifyCsrf(ctx.request,ctx.session);
  available(ctx.db);
  const input = await readJson(ctx.request,MAX_IMPORT_BYTES);
  const authorize = () => requireLiveRole(ctx.db,ctx.session,ROLES);
  if (ctx.pathname.endsWith('/preview')) return {data:await previewJkMigration(ctx.db,input,{authorize})};
  const key = ctx.request.headers['idempotency-key'];
  assert(typeof key === 'string',400,'IDEMPOTENCY_KEY_REQUIRED','Envie Idempotency-Key para confirmar a importação.');
  const result = await commitJkMigration(ctx.db,input,{actorId:actor.id,idempotencyKey:key,authorize});
  return {status:result.replayed ? 200 : 201,data:result,...(result.replayed ? {headers:{'Idempotency-Replayed':'true'}} : {})};
}
