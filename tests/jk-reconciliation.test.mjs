import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {openDatabase,sqliteStore} from '../server/db.mjs';
import {migrateDomain} from '../server/domain-schema.mjs';
import {initializeJkMigration,previewJkMigration,commitJkMigration,jkMigrationStatus} from '../server/jk-migration.mjs';
import {initializeJkHistoryArchive,previewJkHistoryArchive,commitJkHistoryArchive} from '../server/jk-history-archive.mjs';
import {ARCHIVE_HEADERS} from '../server/jk-history-export-parse.mjs';
import {initializeJkReconciliation,previewJkReconciliation,commitJkReconciliation,jkReconciliationStatus,jkReconciliationVehicles,jkReconciliationHistory,handleJkReconciliation} from '../server/jk-reconciliation.mjs';

const csv=(kind,rows)=>'\uFEFF'+[ARCHIVE_HEADERS[kind],...rows].map(row=>row.map(value=>'"'+String(value).replaceAll('"','""')+'"').join(';')).join('\r\n');
const customer=(name,phone,plate)=>[name,'--',phone,'','','',plate,'',''];
const order=(number,name,phone,plate)=>ARCHIVE_HEADERS.orders.map(header=>({'Nº':number,'Cliente':name,'Telefone':phone,'Placa':plate,'Data Entrada':'30/10/2026','Data Saída':'30/10/2026','Valor':'10,00','Desconto':'0,00','Pagamento':'Boleto','Serviços':'Texto original sem preço por item'}[header]??''));
const count=(raw,table)=>raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const zeroEffects=['orders','payments','cash_movements','invoices','stock_movements','commission_claims','jk_history_orders','jk_history_order_items','jk_history_payments'];
async function fixture(t,{customers,orders}={}) {
  const raw=openDatabase(':memory:');migrateDomain(raw);initializeJkMigration(raw);initializeJkHistoryArchive(raw);initializeJkReconciliation(raw);const db=sqliteStore(raw);t.after(()=>db.close());
  raw.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('admin','Admin sintético','reconciliation@example.test','not-login','admin','2026-01-01','2026-01-01');
  const source=csv('customers',customers||[customer('Cliente A','(11) 99999-1111','AAA1A11'),customer('Cliente B','','BBB2B22'),customer('Cliente C','11999992222','CCC3C33'),customer('Cliente D','11999993333','CCC3C33'),customer('Cliente E','','texto a revisar'),customer('Cliente F','','FFF6F66')]);
  const history=csv('orders',orders||[order('001','Cliente A','11999991111','AAA1A11'),order('001','Cliente A','11999991111','AAA1A11'),order('003','Cliente B','','BBB2B22'),order('004','Outro cliente','11999991111','AAA1A11'),order('005','Cliente C','11999992222','CCC3C33'),order('006','Sem cadastro','','DDD4D44'),order('007','Sem placa','','')]);
  for(const content of [source,history]){const p=await previewJkHistoryArchive(db,{content});await commitJkHistoryArchive(db,{content,previewHash:p.previewHash});}
  const input={source:'jumpcar',nativeCustomerMode:'customers-only',files:[{entity:'customers',format:'csv',content:source}]};const p=await previewJkMigration(db,input);const imported=await commitJkMigration(db,input,{previewHash:p.previewHash});
  return {raw,db,source,history,imported};
}
const commit=async(db,input={},options={})=>{const p=await previewJkReconciliation(db,input);return commitJkReconciliation(db,{...input,previewHash:p.previewHash},{actorId:'admin',...options});};
const page=(path='')=>new URL('http://local/?'+path);

test('documentary reconciliation retains snapshot identities and duplicates without inventing category or operational effects',async t=>{
  const {raw,db}=await fixture(t),before=raw.prepare('SELECT total_changes() n').get().n;
  const p=await previewJkReconciliation(db,{});assert.equal(raw.prepare('SELECT total_changes() n').get().n,before);assert.equal(p.canCommit,true);
  assert.equal(p.counts.vehicles.eligible,3);assert.equal(p.counts.vehicles.conflictGroups,1);assert.equal(p.counts.vehicles.conflictingEntries,2);assert.equal(p.counts.vehicles.ambiguousCustomerRows,1);
  assert.deepEqual(p.counts.history,{rows:7,proposal:2,insufficientIdentity:1,identityMismatch:1,plateConflict:1,plateAbsent:1,invalidPlate:1});
  const result=await commit(db);assert.equal(result.status,'COMMITTED');assert.equal(count(raw,'vehicles'),0);assert.equal(count(raw,'customers'),6);
  const vehicles=await jkReconciliationVehicles(db,page());assert.equal(vehicles.page.total,3);assert.ok(vehicles.items.every(x=>x.sourceId===null&&x.category===null&&x.model===null&&x.vehicleId===null&&x.status==='awaiting_review'));
  const original=raw.prepare("SELECT target_id FROM jk_migration_records WHERE entity='customers' AND source_row=2").get();assert.equal(vehicles.items.find(x=>x.plate==='AAA1A11').customerId,original.target_id);
  const history=await jkReconciliationHistory(db,page());assert.equal(history.items.length,7);assert.equal(history.items.filter(x=>x.sourceNumber==='001').length,2);assert.notEqual(history.items[0].id,history.items[1].id);assert.ok(history.items.every(x=>x.values.length===30&&x.values[18]==='Boleto'&&x.proposal.sourceVerified===false));
  for(const table of zeroEffects)assert.equal(count(raw,table),0,table);
  assert.equal((await jkReconciliationStatus(db)).counts.vehicles.pendingReview,3);
});
test('category and model require explicit review; only the selected vehicle is promoted with the original customer',async t=>{
  const {raw,db}=await fixture(t);await commit(db);const v=(await jkReconciliationVehicles(db,page('plate=AAA1A11'))).items[0];
  for(const review of [{vehicleRef:v.vehicleRef,model:'Modelo confirmado'},{vehicleRef:v.vehicleRef,category:'large'},{vehicleRef:v.vehicleRef,category:'unknown',model:'Modelo confirmado'}])await assert.rejects(previewJkReconciliation(db,{vehicleReviews:[review]}));
  const result=await commit(db,{vehicleReviews:[{vehicleRef:v.vehicleRef,category:'large',model:'Modelo confirmado',color:'Azul'}]});assert.equal(result.operationalWrites.vehicles,1);assert.equal(count(raw,'vehicles'),1);
  const actual=raw.prepare('SELECT * FROM vehicles').get();assert.equal(actual.customer_id,v.customerId);assert.equal(actual.category,'large');assert.equal(actual.model,'Modelo confirmado');assert.equal(actual.id,v.vehicleRef);
  const after=(await jkReconciliationVehicles(db,page('status=promoted'))).items[0];assert.equal(after.vehicleId,actual.id);assert.equal(after.category,'large');assert.equal((await jkReconciliationStatus(db)).counts.vehicles.pendingReview,2);
  assert.equal(count(raw,'customers'),6);for(const table of zeroEffects)assert.equal(count(raw,table),0,table);
});
test('conflicts and valid tokens hidden in ambiguous rows are excluded; no owner choice is accepted',async t=>{
  const {db}=await fixture(t,{customers:[customer('Cliente A','','AAA1A11'),customer('Cliente B','','AAA1A11, desconhecido'),customer('Cliente C','','CCC3C33'),customer('Cliente D','','CCC3C33')]});
  const p=await previewJkReconciliation(db,{});assert.equal(p.counts.vehicles.eligible,0);assert.equal(p.counts.vehicles.ambiguousTokenCollisions,1);
  await assert.rejects(previewJkReconciliation(db,{vehicleReviews:[{vehicleRef:'fabricated',category:'small',model:'Não revisado'}]}));
  await assert.rejects(previewJkReconciliation(db,{plateDecisions:[]}));await commit(db);assert.equal((await jkReconciliationVehicles(db,page())).page.total,0);
});
test('changed archive, missing source identity and mismatched preserved source rows fail closed',async t=>{
  for(const mutation of [
    raw=>raw.prepare("UPDATE jk_history_archive_files SET content=content||' ' WHERE kind='customers'").run(),
    raw=>raw.prepare("UPDATE jk_migration_records SET source_id='fabricated' WHERE entity='customers' AND source_row=2").run(),
    raw=>raw.prepare("UPDATE jk_migration_source_rows SET data_json='{}' WHERE source_row=2").run(),
    raw=>raw.prepare("UPDATE jk_history_archive_rows SET values_json='[]' WHERE source_row=2").run(),
  ]){const {raw,db}=await fixture(t);mutation(raw);await assert.rejects(previewJkReconciliation(db,{}),error=>error.code==='RECONCILIATION_SOURCE_MISMATCH');assert.equal(count(raw,'jk_reconciliation_batches'),0);}
});
test('stale preview cannot commit after a customer changes or a plate becomes occupied',async t=>{
  const {raw,db}=await fixture(t);await commit(db);const v=(await jkReconciliationVehicles(db,page())).items[0],input={vehicleReviews:[{vehicleRef:v.vehicleRef,category:'medium',model:'Confirmado'}]};const p=await previewJkReconciliation(db,input);
  raw.prepare('UPDATE customers SET version=version+1 WHERE id=?').run(v.customerId);
  await assert.rejects(commitJkReconciliation(db,{...input,previewHash:p.previewHash},{actorId:'admin'}),{code:'PREVIEW_HASH_MISMATCH'});
  const other=raw.prepare('SELECT id FROM customers WHERE id<>? LIMIT 1').get(v.customerId).id;
  raw.prepare('INSERT INTO vehicles(id,customer_id,plate,model,category,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('occupied',other,v.plate,'Outro veículo','small','2026-01-01','2026-01-01');
  await assert.rejects(previewJkReconciliation(db,input),{code:'RECONCILIATION_VEHICLE_EXISTS'});assert.equal(raw.prepare('SELECT customer_id FROM vehicles').get().customer_id,other);
});
test('replay is idempotent; tampered body and deactivated admin cannot reuse approval',async t=>{
  const {raw,db}=await fixture(t),p=await previewJkReconciliation(db,{}),input={previewHash:p.previewHash},opts={actorId:'admin',idempotencyKey:'reconciliation-replay'};
  const first=await commitJkReconciliation(db,input,opts),second=await commitJkReconciliation(db,input,opts);assert.equal(second.status,'REPLAYED');assert.equal(second.batchId,first.batchId);assert.equal(count(raw,'jk_reconciliation_batches'),1);
  await assert.rejects(commitJkReconciliation(db,{previewHash:'0'.repeat(64)},opts),{code:'IDEMPOTENCY_CONFLICT'});
  raw.prepare('UPDATE users SET active=0 WHERE id=?').run('admin');await assert.rejects(commitJkReconciliation(db,input,opts),{code:'ADMIN_REQUIRED'});
});
test('late audit failure rolls back staged links, operational vehicle, batch and idempotency atomically',async t=>{
  const {raw,db}=await fixture(t);await commit(db);const v=(await jkReconciliationVehicles(db,page())).items[0];const input={vehicleReviews:[{vehicleRef:v.vehicleRef,category:'motorcycle',model:'Modelo confirmado'}]},p=await previewJkReconciliation(db,input),before=count(raw,'jk_reconciliation_batches');
  raw.exec("CREATE TRIGGER fail_reconciliation_audit BEFORE INSERT ON audit_events WHEN NEW.action='jk.reconciliation.committed' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
  await assert.rejects(commitJkReconciliation(db,{...input,previewHash:p.previewHash},{actorId:'admin',idempotencyKey:'reconciliation-rollback'}));assert.equal(count(raw,'vehicles'),0);assert.equal(count(raw,'jk_reconciliation_batches'),before);assert.equal(count(raw,'idempotency_keys'),0);assert.equal((await jkReconciliationStatus(db)).counts.vehicles.promoted,0);
});
test('initial staging audit failure leaves no partial documentary batch or links',async t=>{
  const {raw,db}=await fixture(t),p=await previewJkReconciliation(db,{});
  raw.exec("CREATE TRIGGER fail_initial_reconciliation BEFORE INSERT ON audit_events WHEN NEW.action='jk.reconciliation.committed' BEGIN SELECT RAISE(ABORT,'synthetic initial failure'); END;");
  await assert.rejects(commitJkReconciliation(db,{previewHash:p.previewHash},{actorId:'admin',idempotencyKey:'initial-reconciliation-failure'}));
  for(const table of ['jk_reconciliation_batches','jk_reconciliation_vehicles','jk_reconciliation_history','vehicles','idempotency_keys'])assert.equal(count(raw,table),0,table);
  assert.equal(count(raw,'customers'),6);assert.equal(count(raw,'jk_history_archive_rows'),13);
});
test('changed vehicle review invalidates the hash and concurrent replay creates one vehicle',async t=>{
  const {raw,db}=await fixture(t);await commit(db);const vehicle=(await jkReconciliationVehicles(db,page())).items[0];
  const input={vehicleReviews:[{vehicleRef:vehicle.vehicleRef,category:'medium',model:'Revisado'}]},p=await previewJkReconciliation(db,input);
  await assert.rejects(commitJkReconciliation(db,{vehicleReviews:[{...input.vehicleReviews[0],category:'large'}],previewHash:p.previewHash},{actorId:'admin'}),{code:'PREVIEW_HASH_MISMATCH'});
  const body={...input,previewHash:p.previewHash},options={actorId:'admin',idempotencyKey:'concurrent-reviewed-vehicle'};
  const results=await Promise.all([commitJkReconciliation(db,body,options),commitJkReconciliation(db,body,options)]);
  assert.equal(results[0].batchId,results[1].batchId);assert.equal(results[1].status,'REPLAYED');assert.equal(count(raw,'vehicles'),1);assert.equal(count(raw,'jk_reconciliation_batches'),2);
});
test('documentary filters are exact, paginated and preserve unresolved reasons',async t=>{
  const {db}=await fixture(t);await commit(db);const v=(await jkReconciliationVehicles(db,page('plate=AAA1A11'))).items[0];
  const byCustomer=await jkReconciliationHistory(db,page('customerId='+v.customerId+'&limit=1&offset=1'));assert.equal(byCustomer.page.total,3);assert.equal(byCustomer.page.hasMore,true);
  const mismatch=await jkReconciliationHistory(db,page('plate=AAA1A11&status=identity_mismatch'));assert.equal(mismatch.page.total,1);assert.equal(mismatch.items[0].proposal.status,'identity_mismatch');
  assert.equal((await jkReconciliationHistory(db,page('plate=AAA1A1'))).page.total,0);
  await assert.rejects(jkReconciliationHistory(db,page('status=fabricated')));await assert.rejects(jkReconciliationVehicles(db,page('limit=501')));
});
test('handler requires live admin, CSRF and commit idempotency',async t=>{
  const {raw,db}=await fixture(t),session={user:{id:'admin',role:'admin'},csrfToken:'a'.repeat(43),tokenHash:'reconciliation-token'};
  raw.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?,?)').run(session.tokenHash,'admin',session.csrfToken,Date.now(),Date.now()+60000,Date.now());
  const ctx=(suffix,body={},headers={})=>({db,pathname:'/api/jk/reconciliation/'+suffix,method:'POST',session,url:page(),request:Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]),{headers:{'content-type':'application/json','x-csrf-token':session.csrfToken,...headers}})});
  await assert.rejects(handleJkReconciliation({...ctx('preview'),session:null}),{code:'AUTH_REQUIRED'});await assert.rejects(handleJkReconciliation(ctx('preview',{}, {'x-csrf-token':''})),{code:'CSRF_INVALID'});
  const p=(await handleJkReconciliation(ctx('preview'))).data;await assert.rejects(handleJkReconciliation(ctx('commit',{previewHash:p.previewHash})),{code:'IDEMPOTENCY_KEY_REQUIRED'});
  assert.equal((await handleJkReconciliation(ctx('commit',{previewHash:p.previewHash},{'idempotency-key':'handler-reconciliation'}))).status,201);
  raw.prepare("UPDATE users SET role='viewer' WHERE id='admin'").run();await assert.rejects(handleJkReconciliation(ctx('commit',{previewHash:p.previewHash},{'idempotency-key':'handler-reconciliation'})),{code:'FORBIDDEN'});
});
test('SQLite migration status breaks identical timestamps by insertion order',async t=>{
  const {raw,db}=await fixture(t),existing=raw.prepare('SELECT * FROM jk_migration_batches LIMIT 1').get();
  for(const [id,hash]of [['z-first','first'],['a-second','second']])raw.prepare('INSERT INTO jk_migration_batches(id,source,scope,input_hash,preview_hash,report_json,committed_at) VALUES(?,?,?,?,?,?,?)').run(id,'jumpcar','jk',hash,'0'.repeat(64),existing.report_json,'2099-01-01T00:00:00Z');
  assert.deepEqual((await jkMigrationStatus(db)).latestBatches.slice(0,2).map(x=>x.batchId),['a-second','z-first']);
});
