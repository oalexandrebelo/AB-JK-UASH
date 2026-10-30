import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {openDatabase,sqliteStore} from '../server/db.mjs';
import {migrateDomain} from '../server/domain-schema.mjs';
import {initializeJkSourceCatalog,parseJkSourceCatalog,previewJkSourceCatalog,commitJkSourceCatalog,jkSourceCatalogStatus,jkSourceCatalogRows,handleJkSourceCatalog} from '../server/jk-source-catalog.mjs';

const stamp='2026-10-30T20:00:00.000Z';
const service=(values={})=>({sourceRow:1,sourceId:null,name:'Lavagem sintética',category:'Veículo pequeno',priceCents:5000,active:true,schedulingEnabled:false,durationMinutes:null,commissionBps:null,raw:{Nome:'Lavagem sintética',Preço:'R$ 50,00',Situação:'Ativo'},...values});
const product=(values={})=>({sourceRow:1,sourceId:null,name:'Água sintética',sku:null,brand:null,category:'ÁGUA',application:null,unit:'UN',unitsPerItem:'500,00',sourceQuantity:'10,00',sourceMinimumQuantity:'10,00',priceCents:null,costCents:null,active:true,raw:{'Quantidade por item':'500,00','Estoque na origem':'10,00','Texto da origem':'500 × 10 = 5000 UN'},...values});
const balance=(values={})=>({sourceRow:1,sourceId:null,name:'Posição sintética',kind:'account',amountCents:-12345,currency:'BRL',status:null,asOf:null,raw:{Saldo:'-R$ 123,45'},...values});
const input=()=>({snapshot:{schemaVersion:1,source:'jumpcar-ui',establishmentId:24453,observedAt:stamp,services:[service(),service({sourceRow:2,name:'Lavagem sintética',category:'Veículo grande',priceCents:10000,active:false})],products:[product()],balances:[balance()]}});
function fixture(t) {
  const raw=openDatabase(':memory:');migrateDomain(raw);initializeJkSourceCatalog(raw);
  raw.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('catalog-admin','Admin sintético','catalog@example.test','not-login','admin',stamp,stamp);
  const session={user:{id:'catalog-admin',role:'admin'},tokenHash:'catalog-session',csrfToken:'a'.repeat(43)};
  raw.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?,?)').run(session.tokenHash,session.user.id,session.csrfToken,Date.now(),Date.now()+3600000,Date.now());
  const db=sqliteStore(raw);t.after(()=>db.close());return {raw,db,session};
}
const count=(raw,table)=>raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const changes=raw=>raw.prepare('SELECT total_changes() AS n').get().n;
async function commit(db,payload=input(),options={}) {const preview=await previewJkSourceCatalog(db,payload);return commitJkSourceCatalog(db,{...payload,previewHash:preview.previewHash},{actorId:'catalog-admin',...options});}

test('preview has zero DML and preserves nulls, status, category variants and source-ledger text',async t=>{
  const {raw,db}=fixture(t),payload=input(),before=changes(raw);
  const preview=await previewJkSourceCatalog(db,payload);
  assert.equal(changes(raw),before);assert.equal(count(raw,'jk_source_catalog_snapshots'),0);assert.equal(count(raw,'audit_events'),0);
  assert.deepEqual(preview.counts,{services:2,products:1,balances:1});
  assert.deepEqual(preview.statuses.services,{active:1,inactive:1,unknown:0});assert.equal(preview.operational,false);assert.equal(preview.sourceVerified,false);
  assert.deepEqual(parseJkSourceCatalog(payload).snapshot,payload.snapshot);
  const result=await commit(db,payload);
  assert.equal(result.status,'COMMITTED');
  const services=await jkSourceCatalogRows(db,new URL('http://local/?collection=services'));
  assert.equal(services.items.length,2);assert.notEqual(services.items[0].id,services.items[1].id);
  assert.equal(services.items[0].durationMinutes,null);assert.equal(services.items[0].commissionBps,null);assert.equal(services.items[1].active,false);
  const products=await jkSourceCatalogRows(db,new URL('http://local/?collection=products'));
  assert.equal(products.items[0].sourceId,null);assert.equal(products.items[0].sku,null);assert.equal(products.items[0].costCents,null);
  assert.equal(products.items[0].sourceQuantity,'10,00');assert.equal(products.items[0].unitsPerItem,'500,00');assert.deepEqual(products.items[0].raw,payload.snapshot.products[0].raw);
  assert.deepEqual(products.items[0].provenance,{source:'jumpcar-ui',establishmentId:24453,snapshotHash:result.snapshotHash,collection:'products',sourceRow:1,observedAt:stamp});
  for(const table of ['services','products','orders','order_items','payments','payment_allocations','cash_sessions','cash_movements','invoices','stock_movements','packages','package_sales','payroll','commission_claims','messages'])assert.equal(count(raw,table),0,table);
  const restored=JSON.parse(raw.prepare('SELECT snapshot_json FROM jk_source_catalog_snapshots').get().snapshot_json);assert.deepEqual(restored,payload.snapshot);
  assert.ok(!raw.prepare('SELECT metadata_json FROM audit_events').get().metadata_json.includes('Lavagem sintética'));
});

test('every snapshot remains immutable, latest view replaces the complete position and old replay never promotes old data',async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date(stamp)});
  const {raw,db}=fixture(t),first=input(),one=await commit(db,first),second=input();
  second.snapshot.services=[service({priceCents:7000,active:null})];second.snapshot.products=[];second.snapshot.balances=[balance({amountCents:0})];
  const two=await commit(db,second);
  assert.equal(one.committedAt,two.committedAt);
  const status=await jkSourceCatalogStatus(db);
  assert.equal(status.snapshotHash,two.snapshotHash);assert.equal(status.totalSnapshots,2);assert.deepEqual(status.counts,{services:1,products:0,balances:1});
  assert.deepEqual(status.statuses.services,{active:0,inactive:0,unknown:1});
  assert.equal((await jkSourceCatalogRows(db,new URL('http://local/?collection=products'))).page.total,0);
  assert.equal((await jkSourceCatalogRows(db,new URL('http://local/?collection=services'))).items[0].priceCents,7000);
  assert.equal((await jkSourceCatalogRows(db,new URL('http://local/?collection=balances'))).items[0].amountCents,0);
  const before=changes(raw),replay=await commit(db,first);assert.equal(replay.status,'REPLAYED');assert.equal(replay.batchId,one.batchId);assert.equal(changes(raw),before);
  assert.equal((await jkSourceCatalogStatus(db)).snapshotHash,two.snapshotHash);assert.equal(count(raw,'jk_source_catalog_rows'),6);
});

test('canonical key order replays; altered content, stale predecessor or wrong preview hash does not commit',async t=>{
  const {raw,db}=fixture(t),payload=input(),preview=await previewJkSourceCatalog(db,payload);
  const changed=structuredClone(payload);changed.snapshot.services[0].priceCents++;
  await assert.rejects(commitJkSourceCatalog(db,{...changed,previewHash:preview.previewHash},{actorId:'catalog-admin'}),{code:'PREVIEW_HASH_MISMATCH'});
  await assert.rejects(commitJkSourceCatalog(db,{...payload,previewHash:'0'.repeat(64)},{actorId:'catalog-admin'}),{code:'PREVIEW_HASH_MISMATCH'});
  await commit(db,changed);
  await assert.rejects(commitJkSourceCatalog(db,{...payload,previewHash:preview.previewHash},{actorId:'catalog-admin'}),{code:'PREVIEW_HASH_MISMATCH'});
  const saved=await commit(db,payload);
  const reordered={snapshot:Object.fromEntries(Object.entries(payload.snapshot).reverse())};
  const replay=await commit(db,reordered);assert.equal(replay.batchId,saved.batchId);assert.equal(replay.status,'REPLAYED');assert.equal(count(raw,'jk_source_catalog_snapshots'),2);
});

test('all three arrays are mandatory, unknown fields and missing explicit nulls reject',()=>{
  for(const mutate of [
    p=>delete p.snapshot.balances,p=>delete p.snapshot.products,p=>delete p.snapshot.services,
    p=>delete p.snapshot.services[0].durationMinutes,p=>p.snapshot.source='other',p=>p.snapshot.establishmentId=99,
    p=>p.snapshot.schemaVersion=2,p=>p.snapshot.unknown=true,p=>p.snapshot.services[0].unknown=true,
    p=>p.snapshot.products[0].sku=undefined,p=>p.snapshot.observedAt='2026-02-30T12:00:00Z',
    p=>p.snapshot.observedAt='2026-10-30',p=>p.snapshot.services[0].name='\ud800',
    p=>p.snapshot.services[0].raw={secret:{nested:true}},p=>p.snapshot.services[0].raw={decimal:1.5},
    p=>{p.snapshot.services=[];p.snapshot.products=[];p.snapshot.balances=[];},
  ]){const payload=input();mutate(payload);assert.throws(()=>parseJkSourceCatalog(payload));}
});

test('money is exact integer cents, null differs from zero, balance sign does not become a receipt',()=>{
  for(const value of [1.5,NaN,Infinity,-1,-0,1_000_000_001,'5000']){
    const payload=input();payload.snapshot.services[0].priceCents=value;assert.throws(()=>parseJkSourceCatalog(payload));
  }
  for(const value of [-1_000_000_001,1.5,-0,'-123']){const payload=input();payload.snapshot.balances[0].amountCents=value;assert.throws(()=>parseJkSourceCatalog(payload));}
  const payload=input();payload.snapshot.services[0].priceCents=null;payload.snapshot.products[0].priceCents=0;payload.snapshot.balances[0].amountCents=null;
  const parsed=parseJkSourceCatalog(payload);assert.equal(parsed.snapshot.products[0].priceCents,0);assert.equal(parsed.snapshot.services[0].priceCents,null);assert.equal(parsed.snapshot.balances[0].amountCents,null);
});

test('duplicate rows and real IDs reject per collection; duplicate names and IDs in different collections stay distinct',()=>{
  const payload=input();payload.snapshot.services[1].sourceRow=1;assert.throws(()=>parseJkSourceCatalog(payload),{code:'SOURCE_CATALOG_DUPLICATE_ROW'});
  payload.snapshot.services[1].sourceRow=2;payload.snapshot.services[0].sourceId='123';payload.snapshot.services[1].sourceId='123';assert.throws(()=>parseJkSourceCatalog(payload),{code:'SOURCE_CATALOG_DUPLICATE_ID'});
  payload.snapshot.services[1].sourceId=null;payload.snapshot.products[0].sourceId='123';assert.equal(parseJkSourceCatalog(payload).rows.length,4);
});

test('pagination only reads latest collection, searches literal names and caps pages at 500',async t=>{
  const {db}=fixture(t),payload=input();payload.snapshot.services[0].name='Lavagem "Azul" C:\\Demo';await commit(db,payload);
  const url=new URL('http://local/?collection=services&limit=1');let rows=await jkSourceCatalogRows(db,url);assert.equal(rows.page.total,2);assert.equal(rows.page.hasMore,true);
  url.searchParams.set('offset','1');rows=await jkSourceCatalogRows(db,url);assert.equal(rows.items[0].sourceRow,2);assert.equal(rows.page.hasMore,false);
  url.searchParams.set('offset','0');url.searchParams.set('q','"Azul" C:\\Demo');assert.equal((await jkSourceCatalogRows(db,url)).page.total,1);
  for(const search of ['limit=501','limit=-1','offset=-1','collection=orders'])await assert.rejects(jkSourceCatalogRows(db,new URL(`http://local/?${search}`)));
});

test('late audit failure rolls back snapshot, rows, audit and idempotency together',async t=>{
  const {raw,db}=fixture(t);
  raw.exec("CREATE TRIGGER fail_catalog_audit BEFORE INSERT ON audit_events WHEN NEW.action='jk.source_catalog.committed' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
  await assert.rejects(commit(db,input(),{actorId:'catalog-admin',idempotencyKey:'catalog-rollback'}),/synthetic failure/u);
  for(const table of ['jk_source_catalog_snapshots','jk_source_catalog_rows','audit_events','idempotency_keys'])assert.equal(count(raw,table),0,table);
});

test('idempotency replay checks live administrator and prevents key reuse with changed body',async t=>{
  const {raw,db}=fixture(t),payload=input(),preview=await previewJkSourceCatalog(db,payload),body={...payload,previewHash:preview.previewHash},options={actorId:'catalog-admin',idempotencyKey:'catalog-idempotent'};
  const saved=await commitJkSourceCatalog(db,body,options);assert.equal((await commitJkSourceCatalog(db,body,options)).batchId,saved.batchId);
  await assert.rejects(commitJkSourceCatalog(db,{...body,previewHash:'0'.repeat(64)},options),{code:'IDEMPOTENCY_CONFLICT'});
  raw.prepare("UPDATE users SET role='viewer' WHERE id='catalog-admin'").run();
  await assert.rejects(commitJkSourceCatalog(db,body,options),{code:'ADMIN_REQUIRED'});
  assert.equal(count(raw,'jk_source_catalog_snapshots'),1);
});

test('library commits always require a named active administrator, including snapshot replay',async t=>{
  const {raw,db}=fixture(t),payload=input(),preview=await previewJkSourceCatalog(db,payload),body={...payload,previewHash:preview.previewHash};
  for(const options of [undefined,{actorId:null},{actorId:''},{actorId:'missing'},{actorId:null,authorize:()=>{}},{actorId:null,idempotencyKey:'catalog-no-actor'}])await assert.rejects(commitJkSourceCatalog(db,body,options),{code:'ADMIN_REQUIRED'});
  assert.equal(count(raw,'jk_source_catalog_snapshots'),0);assert.equal(count(raw,'audit_events'),0);
  await commitJkSourceCatalog(db,body,{actorId:'catalog-admin'});
  await assert.rejects(commitJkSourceCatalog(db,body),{code:'ADMIN_REQUIRED'});
  raw.prepare("UPDATE users SET active=0 WHERE id='catalog-admin'").run();
  await assert.rejects(commitJkSourceCatalog(db,body,{actorId:'catalog-admin'}),{code:'ADMIN_REQUIRED'});
  assert.equal(count(raw,'jk_source_catalog_snapshots'),1);assert.equal(count(raw,'audit_events'),1);
});

test('simultaneous commits from the same predecessor serialize and reject the stale candidate',async t=>{
  const {raw,db}=fixture(t),first=input(),second=input();second.snapshot.services[0].priceCents++;
  const previews=await Promise.all([previewJkSourceCatalog(db,first),previewJkSourceCatalog(db,second)]);
  const results=await Promise.allSettled([commitJkSourceCatalog(db,{...first,previewHash:previews[0].previewHash},{actorId:'catalog-admin'}),commitJkSourceCatalog(db,{...second,previewHash:previews[1].previewHash},{actorId:'catalog-admin'})]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(results.find(result=>result.status==='rejected').reason.code,'PREVIEW_HASH_MISMATCH');assert.equal(count(raw,'jk_source_catalog_snapshots'),1);
});

test('HTTP handler checks exact paths, current session, admin, CSRF, idempotency and request size',async t=>{
  const {raw,db,session}=fixture(t);
  async function request(path,body,{method='POST',auth=session,csrf=session.csrfToken,key='catalog-http-key'}={}) {
    const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);req.headers={'content-type':'application/json',...(csrf?{'x-csrf-token':csrf}:{}),...(key?{'idempotency-key':key}:{})};
    return handleJkSourceCatalog({db,session:auth,method,pathname:path.split('?')[0],url:new URL(`http://local${path}`),request:req});
  }
  const root='/api/jk/source-catalog',payload=input();
  assert.equal(await request(`${root}/nested/status`,undefined,{method:'GET',auth:null}),null);
  await assert.rejects(request(`${root}/preview`,payload,{auth:null}),{code:'AUTH_REQUIRED'});
  await assert.rejects(request(`${root}/preview`,payload,{csrf:null}),{code:'CSRF_INVALID'});
  const preview=await request(`${root}/preview`,payload),body={...payload,previewHash:preview.data.previewHash};
  await assert.rejects(request(`${root}/commit`,body,{key:null}),{code:'IDEMPOTENCY_KEY_REQUIRED'});
  assert.equal((await request(`${root}/commit`,body)).status,201);const replay=await request(`${root}/commit`,body);assert.equal(replay.status,200);assert.equal(replay.headers['Idempotency-Replayed'],'true');
  const rows=await request(`${root}/rows?collection=services&limit=1`,undefined,{method:'GET'});assert.equal(rows.data.items.length,1);
  raw.prepare("UPDATE users SET role='viewer' WHERE id='catalog-admin'").run();
  await assert.rejects(request(`${root}/status`,undefined,{method:'GET'}),{code:'FORBIDDEN'});
  await assert.rejects(request(`${root}/commit`,body),{code:'FORBIDDEN'});
  raw.prepare("UPDATE users SET role='admin' WHERE id='catalog-admin'").run();raw.prepare('DELETE FROM sessions').run();
  await assert.rejects(request(`${root}/commit`,body),{code:'AUTH_REQUIRED'});
  await assert.rejects(request(`${root}/preview`,{snapshot:'x'.repeat(8*1024*1024)}),{code:'BODY_TOO_LARGE'});
});
