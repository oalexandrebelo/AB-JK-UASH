import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createApplication} from '../server/application.mjs';
import {openDatabase,sqliteStore} from '../server/db.mjs';
import {parseJkHistoryExport,ARCHIVE_HEADERS} from '../server/jk-history-export-parse.mjs';
import {initializeJkHistoryArchive,previewJkHistoryArchive,commitJkHistoryArchive,jkHistoryArchiveStatus,jkHistoryArchiveRows} from '../server/jk-history-archive.mjs';

const csv = (kind,rows,prefix='') => prefix+[ARCHIVE_HEADERS[kind],...rows].map(row=>row.map(cell=>'"'+String(cell).replaceAll('"','""')+'"').join(';')).join('\r\n');
const order = (overrides={}) => ARCHIVE_HEADERS.orders.map(header=>({
  'Nº':'000123','Cliente':'  Cliente sintético  ','Serviços':'Lavagem (1) - R$ 1.234,56',
  'Data Entrada':'29/10/2026','Data Saída':'30/10/2026','Hora Entrada':'23:00:00','Hora Saída':'01:00:00',
  'Desconto':'R$\u00a00,00','Valor':'1.234,56','Pagamento':'Boleto','Observação':'Primeira linha\n"Segunda"; linha',...overrides,
}[header]??''));
function fixture(t){const raw=openDatabase(':memory:');initializeJkHistoryArchive(raw);const db=sqliteStore(raw);t.after(()=>db.close());return {raw,db};}
const count=(raw,table)=>raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

test('parser preserves all 30 cells, duplicate order numbers and exact Brazilian cents',()=>{
  const rows=[order(),order({'Cliente':'Outro cadastro sintético','Valor':'10,01'})];
  const parsed=parseJkHistoryExport({content:csv('orders',rows)});
  assert.equal(parsed.kind,'orders');assert.deepEqual(parsed.rows.map(r=>r.values),rows);
  assert.equal(parsed.counts.duplicateOrderNumbers,1);assert.equal(parsed.totals.valueCents,124457);
  assert.equal(parsed.dates.entryMin,'2026-10-29');assert.equal(parsed.rows[0].sourceNumber,'000123');
  assert.notEqual(parsed.rows[0].id,parsed.rows[1].id);
  assert.equal(parseJkHistoryExport({content:csv('orders',[order({'Total de OS paga':'0'})])}).counts.rows,1);
});
test('customer conflicts and short names remain documentary; products retain leading blank source record',()=>{
  const customer=['X','','','','','','ABC1D23','','nota'];
  const c=parseJkHistoryExport({content:csv('customers',[customer,customer])});
  assert.equal(c.rows.length,2);assert.equal(c.totals,null);assert.equal(c.rows[0].sourceNumber,null);
  assert.deepEqual(c.rows[0].values,customer);
  const product=['Produto sintético','','','','1,5','0,5','1','L'];
  const p=parseJkHistoryExport({content:csv('products',[product],'\r\n')});
  assert.equal(p.kind,'products');assert.equal(p.rows[0].sourceRow,3);assert.deepEqual(p.rows[0].values,product);
});
test('unknown headers, widths, dates, money, totals and limits reject without dropping rows',()=>{
  for(const content of [csv('orders',[order()]).replace('"Nº"','"ID"'),csv('orders',[order().slice(1)]),csv('orders',[order({'Valor':'1,234'})]),csv('orders',[order({'Data Entrada':'31/02/2026'})]),csv('orders',[order({'Total de OS':'R$ 2,00'})]),csv('orders',[order({'Total de OS paga':'2'})])]) assert.throws(()=>parseJkHistoryExport({content}));
  assert.throws(()=>parseJkHistoryExport({content:' '.repeat(8*1024*1024+1)}));
  assert.throws(()=>parseJkHistoryExport({content:csv('customers',Array.from({length:20001},()=>['X','','','','','','','','']))}));
  assert.throws(()=>parseJkHistoryExport({content:csv('customers',[])}));
  assert.throws(()=>parseJkHistoryExport({content:csv('orders',[order()]),unknown:true}));
  assert.throws(()=>parseJkHistoryExport({content:csv('customers',[['\ud800','','','','','','','','']])}),{code:'INVALID_ARCHIVE_TEXT'});
});
test('preview is read only; commit, search and replay preserve every original cell',async t=>{
  const {raw,db}=fixture(t),rows=[order(),order({'Nº':'000124','Valor':'50,00'})],input={content:csv('orders',rows)};
  const before=raw.prepare('SELECT total_changes() AS n').get().n;
  const preview=await previewJkHistoryArchive(db,input);assert.equal(preview.canCommit,true);
  assert.equal(raw.prepare('SELECT total_changes() AS n').get().n,before);
  const committed=await commitJkHistoryArchive(db,{...input,previewHash:preview.previewHash});assert.equal(committed.status,'COMMITTED');
  const result=await jkHistoryArchiveRows(db,new URL('http://local/?limit=1&offset=0&q=000123'));
  assert.equal(result.page.total,1);assert.deepEqual(result.items[0].values,rows[0]);
  const replay=await commitJkHistoryArchive(db,{...input,previewHash:preview.previewHash});assert.equal(replay.status,'REPLAYED');
  assert.equal(count(raw,'jk_history_archive_rows'),2);assert.equal(count(raw,'jk_history_archive_files'),1);
  assert.equal((await jkHistoryArchiveStatus(db,'orders')).counts.rows,2);
  const restored=raw.prepare('SELECT content FROM jk_history_archive_files').get().content;assert.equal(restored,input.content);
});
test('three independent kinds coexist; changed snapshot of same kind is blocked atomically',async t=>{
  const {raw,db}=fixture(t);
  for(const [kind,row] of [['orders',order()],['customers',['X','','','','','','','','']],['products',['Produto','','','','1','0','1','L']]]){
    const input={content:csv(kind,[row])};const p=await previewJkHistoryArchive(db,input);await commitJkHistoryArchive(db,{...input,previewHash:p.previewHash});
  }
  assert.equal(count(raw,'jk_history_archive_files'),3);
  const input={content:csv('orders',[order({'Valor':'80,00'})])};const p=await previewJkHistoryArchive(db,input);
  assert.equal(p.canCommit,false);assert.equal(p.issues[0].code,'SNAPSHOT_RECONCILIATION_REQUIRED');
  await assert.rejects(commitJkHistoryArchive(db,{...input,previewHash:p.previewHash}),{code:'ARCHIVE_REJECTED'});
  assert.equal(count(raw,'jk_history_archive_rows'),3);
});
test('search matches literal quotes and backslashes in decoded cells, not JSON escaping',async t=>{
  const {db}=fixture(t),row=['Cliente "Azul" sintético','','','','','','','','C:\\DEMO\\arquivo'];
  const input={content:csv('customers',[row])},preview=await previewJkHistoryArchive(db,input);
  await commitJkHistoryArchive(db,{...input,previewHash:preview.previewHash});
  for(const q of ['"Azul"','C:\\DEMO\\arquivo'])assert.equal((await jkHistoryArchiveRows(db,new URL('http://local/?kind=customers&q='+encodeURIComponent(q)))).page.total,1);
  assert.equal((await jkHistoryArchiveRows(db,new URL('http://local/?kind=customers&q='+encodeURIComponent('\\"Azul\\"')))).page.total,0);
});
test('stale hash and late audit failure roll back files and every row',async t=>{
  const {raw,db}=fixture(t),input={content:csv('orders',[order()])};const p=await previewJkHistoryArchive(db,input);
  await assert.rejects(commitJkHistoryArchive(db,{...input,previewHash:'0'.repeat(64)}),{code:'PREVIEW_HASH_MISMATCH'});
  raw.exec("CREATE TRIGGER fail_archive_audit BEFORE INSERT ON audit_events WHEN NEW.action='jk.history_archive.committed' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
  await assert.rejects(commitJkHistoryArchive(db,{...input,previewHash:p.previewHash}));
  assert.equal(count(raw,'jk_history_archive_files'),0);assert.equal(count(raw,'jk_history_archive_rows'),0);assert.equal(count(raw,'audit_events'),0);
});
test('live admin and idempotency apply before replay',async t=>{
  const {raw,db}=fixture(t);raw.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('admin','Admin sintético','archive@example.test','not-login','admin','2026-01-01','2026-01-01');
  const input={content:csv('orders',[order()])};const p=await previewJkHistoryArchive(db,input);const body={...input,previewHash:p.previewHash};const options={actorId:'admin',idempotencyKey:'archive-first'};
  await commitJkHistoryArchive(db,body,options);assert.equal((await commitJkHistoryArchive(db,body,options)).status,'REPLAYED');
  await assert.rejects(commitJkHistoryArchive(db,{...body,previewHash:'1'.repeat(64)},options),{code:'IDEMPOTENCY_CONFLICT'});
  raw.prepare('UPDATE users SET active=0 WHERE id=?').run('admin');await assert.rejects(commitJkHistoryArchive(db,body,options),{code:'ADMIN_REQUIRED'});
});
test('HTTP handler requires live admin, CSRF, idempotency and returns paginated original rows without operational writes',async t=>{
  const app=await createApplication({dbPath:':memory:',fiscalEnv:{},jkIntegrationsEnv:{},logger:{error(){}}});t.after(()=>app.close());
  async function request(path,body,{cookie,csrf,key,method='POST'}={}){
    const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);req.method=method;req.url=path;req.headers={host:'127.0.0.1:4173','content-type':'application/json',...(cookie?{cookie}:{}),...(csrf?{'x-csrf-token':csrf}:{}),...(key?{'idempotency-key':key}:{})};
    const res={headers:{},headersSent:false,setHeader(k,v){this.headers[k.toLowerCase()]=v;},writeHead(s,h){this.status=s;Object.assign(this.headers,Object.fromEntries(Object.entries(h).map(([k,v])=>[k.toLowerCase(),v])));this.headersSent=true;},end(body){this.body=JSON.parse(body);},destroy(){}};
    await app.handler(req,res);return res;
  }
  const setup=await request('/api/setup',{name:'Admin sintético',email:'archive-admin@example.test',password:'synthetic-password-2026'});assert.equal(setup.status,201);
  const session={cookie:setup.headers['set-cookie'].split(';')[0],csrf:setup.body.data.csrfToken};const input={content:csv('orders',[order()])};const path='/api/jk/history-archive';
  for(const suffix of ['/nested/status','/nested/rows'])assert.equal((await request(path+suffix,undefined,{...session,method:'GET'})).status,404);
  assert.equal((await request('/api/jk/transition',{mode:'parallel_readonly',version:0},{...session,method:'PATCH',key:'archive-parallel-mode'})).status,200);
  assert.equal((await request('/api/customers',{name:'Não deve criar'},{...session,key:'blocked-customer'})).status,409);
  assert.equal((await request(path+'/preview',input)).status,401);
  assert.equal((await request(path+'/preview',input,{cookie:session.cookie})).status,403);
  const preview=await request(path+'/preview',input,session);assert.equal(preview.status,200);
  const body={...input,previewHash:preview.body.data.previewHash};assert.equal((await request(path+'/commit',body,session)).status,400);
  assert.equal((await request(path+'/commit',body,{...session,key:'archive-http-first'})).status,201);
  assert.equal((await request(path+'/commit',body,{...session,key:'archive-http-first'})).status,200);
  const history=await request(path+'/rows?kind=orders&limit=1',undefined,{...session,method:'GET'});assert.equal(history.body.data.page.total,1);assert.deepEqual(history.body.data.items[0].values,order());
  assert.equal((await request(path+'/rows?kind=orders&limit=501',undefined,{...session,method:'GET'})).status,422);
  for(const table of ['customers','vehicles','services','orders','payments','cash_movements','invoices','stock_movements','messages'])assert.equal(count(app.db,table),0,table);
  await app.store.prepare("UPDATE users SET role='viewer' WHERE id=?").run(setup.body.data.user.id);
  assert.equal((await request(path+'/status',undefined,{...session,method:'GET'})).status,403);
  assert.equal((await request(path+'/commit',body,{...session,key:'archive-http-first'})).status,403);
});
