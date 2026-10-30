import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase,sqliteStore} from '../server/db.mjs';
import {migrateDomain} from '../server/domain-schema.mjs';
import {initializeJkMigration,previewJkMigration,commitJkMigration,jkMigrationHistory,jkMigrationStatus} from '../server/jk-migration.mjs';
import {CUSTOMER_HEADERS,decodeImport,sha256} from '../server/jk-migration-parse.mjs';

function fixture(t) {
  const raw=openDatabase(':memory:');migrateDomain(raw);initializeJkMigration(raw);
  raw.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('customer-only-admin','Admin sintético','customer-only@example.test','not-a-login-hash','admin','2026-10-30T12:00:00Z','2026-10-30T12:00:00Z');
  const db=sqliteStore(raw);t.after(()=>db.close());return {raw,db};
}
const row=(name,plate='ABC1D23')=>[name,'--','--','Em aberto','31/10/2026','R$ 90,00',plate,'1','Observação preservada'];
const content=rows=>'\uFEFF'+CUSTOMER_HEADERS.join(';')+'\r\n'+rows.map(item=>item.map(cell=>'"'+cell.replaceAll('"','""')+'"').join(';')).join('\r\n')+'\r\n';
const input=(rows,mode)=>({source:'jumpcar',files:[{entity:'customers',format:'csv',content:content(rows)}],...(mode===undefined?{}:{nativeCustomerMode:mode})});
const count=async(db,table)=>(await db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).n;
const zeroEffects=['vehicles','services','orders','order_items','jk_history_orders','jk_history_order_items','jk_history_payments','payments','payment_allocations','cash_movements','invoices','messages','stock_movements','commission_claims','payroll','appointments'];

test('explicit customers-only defers eighteen conflicting plate groups and preserves every native column and identity',async t=>{
  const {db,raw}=fixture(t),rows=[];
  for(let i=0;i<18;i++)for(let j=0;j<(i<2?3:2);j++)rows.push(row(`Pessoa sintética ${i}-${j}`,`ABC${1000+i}`));
  rows.push(row('.', 'DEF1G23 HIJ4K56'),row('Veículo ambíguo','placa a revisar (texto original)'));
  const request=input(rows,'customers-only'),before=raw.prepare('SELECT total_changes() n').get().n;
  const preview=await previewJkMigration(db,request);
  assert.equal(preview.canCommit,true);assert.equal(preview.counts.customers.insert,40);assert.deepEqual(preview.counts.vehicles,{received:0,insert:0,unchanged:0,rejected:0});
  assert.deepEqual(preview.nativeCustomerImport,{mode:'customers-only',sourceRows:40,sourceColumns:9,snapshotHash:sha256(request.files[0].content),deferredVehicleEntries:40,deferredVehicleRows:39,ambiguousVehicleRows:1,reason:'EXPLICIT_CUSTOMERS_ONLY'});
  assert.equal(preview.identityMap.length,40);assert.ok(preview.identityMap.every(item=>item.entity==='customers'&&item.sourceId===null&&item.provenance==='snapshot-row'));
  assert.ok(preview.warnings.some(item=>item.code==='NATIVE_VEHICLES_DEFERRED'&&item.count===40));
  assert.ok(!preview.warnings.some(item=>item.code==='NATIVE_PLATES_EXTRACTED'));
  assert.equal(raw.prepare('SELECT total_changes() n').get().n,before);
  const committed=await commitJkMigration(db,request,{previewHash:preview.previewHash,actorId:'customer-only-admin',idempotencyKey:'customer-only-18'});
  assert.equal(committed.status,'COMMITTED');assert.equal(await count(db,'customers'),40);
  for(const table of zeroEffects)assert.equal(await count(db,table),0,table);
  const history=await jkMigrationHistory(db,new URL('http://local/history?entity=sourceRows&limit=100'));
  assert.equal(history.items.length,40);
  for(const item of history.items)assert.deepEqual(item.dataJson,Object.fromEntries(CUSTOMER_HEADERS.map((header,index)=>[header,rows[item.sourceRow-2][index]])));
  const origins=await db.prepare('SELECT source_id,provenance,snapshot_hash FROM jk_migration_records').all();
  assert.ok(origins.every(item=>item.source_id===null&&item.provenance==='snapshot-row'&&item.snapshot_hash===sha256(request.files[0].content)));
  const audit=JSON.parse((await db.prepare("SELECT metadata_json FROM audit_events WHERE action='jk.migration.committed'").get()).metadata_json);
  assert.deepEqual(audit.nativeCustomerImport,preview.nativeCustomerImport);
  assert.ok(!JSON.stringify(audit).includes('Pessoa sintética'));
  assert.deepEqual((await jkMigrationStatus(db)).latestBatches[0].nativeCustomerImport,preview.nativeCustomerImport);
});

test('default and explicit native plate extraction still reject conflicting ownership',async t=>{
  const {db}=fixture(t),rows=[row('Primeira pessoa'),row('Segunda pessoa')];
  for(const mode of [undefined,'customers-and-vehicles']) {
    const request=input(rows,mode),preview=await previewJkMigration(db,request);
    assert.equal(preview.canCommit,false);assert.ok(preview.issues.some(item=>item.code==='PLATE_ALREADY_EXISTS'));
    await assert.rejects(commitJkMigration(db,request,{previewHash:preview.previewHash}),{code:'IMPORT_REJECTED'});
  }
  assert.equal(await count(db,'customers'),0);assert.equal(await count(db,'vehicles'),0);
});

test('native mode is bound to reviewed input hash and cannot be permuted at commit or replay',async t=>{
  const {db}=fixture(t),rows=[row('Pessoa sintética')],only=input(rows,'customers-only'),full=input(rows,'customers-and-vehicles');
  const a=await previewJkMigration(db,only),b=await previewJkMigration(db,full),legacy=await previewJkMigration(db,input(rows));
  assert.notEqual(a.inputHash,b.inputHash);assert.notEqual(a.previewHash,b.previewHash);assert.notEqual(b.inputHash,legacy.inputHash);
  await assert.rejects(commitJkMigration(db,full,{previewHash:a.previewHash}),{code:'PREVIEW_HASH_MISMATCH'});
  const options={previewHash:a.previewHash,actorId:'customer-only-admin',idempotencyKey:'customer-only-replay'};
  const first=await commitJkMigration(db,only,options),second=await commitJkMigration(db,only,options);
  assert.equal(second.status,'REPLAYED');assert.equal(second.batchId,first.batchId);assert.equal(await count(db,'customers'),1);assert.equal(await count(db,'vehicles'),0);
  const replay=await previewJkMigration(db,only);assert.equal(replay.replayAvailable,true);assert.equal(replay.counts.customers.unchanged,1);assert.deepEqual(replay.nativeCustomerImport,a.nativeCustomerImport);
  await assert.rejects(commitJkMigration(db,full,options),{code:'IDEMPOTENCY_CONFLICT'});
  assert.equal((await previewJkMigration(db,full)).counts.customers.unchanged,1,'A mesma identidade de cliente é reutilizada quando o modo muda sob nova revisão.');
  assert.equal(await count(db,'audit_events'),1);
});

test('native mode rejects canonical datasets, canonical CSV, extra files, noncustomer entity and unknown choices',async t=>{
  const {db}=fixture(t),native=input([row('Pessoa sintética')],'customers-only');
  for(const invalid of [
    {...native,nativeCustomerMode:'ignore-conflicts'},
    {source:'jumpcar',nativeCustomerMode:'customers-only',dataset:{schemaVersion:1,customers:[{sourceId:'real-synthetic-test-id',name:'Pessoa sintética'}]}},
    {...native,files:[{entity:'customers',format:'csv',content:'sourceId;name\nreal-synthetic-test-id;Pessoa sintética\n'}]},
    {...native,files:[...native.files,{entity:'vehicles',format:'csv',content:'sourceId;plate\nv1;ABC1D23\n'}]},
    {...native,files:[{...native.files[0],entity:'services'}]},
  ])await assert.rejects(previewJkMigration(db,invalid),error=>['UNSUPPORTED_NATIVE_CUSTOMER_MODE','NATIVE_CUSTOMER_MODE_REQUIRES_NATIVE_FILE'].includes(error.code));
  assert.equal(await count(db,'customers'),0);assert.equal(await count(db,'jk_migration_batches'),0);
});

test('customers-only retains validation, rejects a different native snapshot and requires all native columns',async t=>{
  const {db}=fixture(t),request=input([row('Pessoa sintética')],'customers-only'),preview=await previewJkMigration(db,request);
  await commitJkMigration(db,request,{previewHash:preview.previewHash});
  const next=await previewJkMigration(db,input([row('Outra pessoa')],'customers-only'));
  assert.equal(next.canCommit,false);assert.ok(next.issues.some(item=>item.code==='SNAPSHOT_RECONCILIATION_REQUIRED'));
  const broken={...request,files:[{...request.files[0],content:request.files[0].content.replace('Observação','Coluna diferente')}]};
  assert.throws(()=>decodeImport(broken),{code:'NATIVE_CUSTOMER_MODE_REQUIRES_NATIVE_FILE'});
  const invalidRow=row('Pessoa inválida');invalidRow[1]='e-mail inválido';
  const invalid=await previewJkMigration(db,input([invalidRow],'customers-only'));assert.equal(invalid.canCommit,false);assert.ok(invalid.issues.some(item=>item.code==='INVALID_IMPORT_EMAIL'));
});

test('customers-only works for untouched native HTML and preserves ambiguous vehicle text',async t=>{
  const {db}=fixture(t),headers=CUSTOMER_HEADERS.map(value=>`<th>${value}</th>`).join(''),cells=row('Cliente sintético','texto sem placa').map(value=>`<td>${value}</td>`).join('');
  const html=`<table><tr>${headers}</tr><tr>${cells}</tr></table>`;
  const request={source:'jumpcar',nativeCustomerMode:'customers-only',files:[{entity:'customers',format:'jumpcar-html',content:html}]};
  const preview=await previewJkMigration(db,request);assert.equal(preview.canCommit,true);assert.equal(preview.nativeCustomerImport.ambiguousVehicleRows,1);assert.equal(preview.nativeCustomerImport.deferredVehicleEntries,0);
  await commitJkMigration(db,request,{previewHash:preview.previewHash});assert.equal(await count(db,'vehicles'),0);
  assert.equal((await jkMigrationHistory(db,new URL('http://local/history?entity=sourceRows'))).items[0].dataJson.Veículos,'texto sem placa');
});
