import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, sqliteStore } from '../server/db.mjs';
import { migrateDomain } from '../server/domain-schema.mjs';
import { initializeJkMigration, previewJkMigration, commitJkMigration, handleJkMigration, jkMigrationStatus, jkMigrationHistory } from '../server/jk-migration.mjs';
import { CUSTOMER_HEADERS, parseCsv, parseJumpcarHtml } from '../server/jk-migration-parse.mjs';
import { createApplication } from '../server/application.mjs';
import { main as importCli } from '../scripts/jk-import.mjs';

const stamp = '2025-01-02T12:00:00.000Z';
function fixture(t,path = ':memory:') {
  const raw = openDatabase(path); migrateDomain(raw); initializeJkMigration(raw);
  raw.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('migration-test-admin','Administrador sintético','migration@example.test','not-a-login-hash','admin',stamp,stamp);
  const db = sqliteStore(raw); t.after(() => db.close());
  return {raw,db};
}
const payload = () => ({source:'jumpcar',dataset:{schemaVersion:1,
  customers:[{sourceId:'c-1',name:'Cliente sintético',email:'customer@example.test'}],
  vehicles:[{sourceId:'v-1',customerSourceId:'c-1',plate:'TST1A23',model:'Modelo sintético'}],
  services:[{sourceId:'s-1',name:'Serviço sintético',priceCents:5000,durationMinutes:30}],
  orders:[{sourceId:'o-1',number:'OS-001',customerSourceId:'c-1',vehicleSourceId:'v-1',status:'delivered',subtotalCents:10000,discountCents:1000,totalCents:9000,createdAt:stamp,deliveredAt:'2025-01-02T13:00:00.000Z'}],
  orderItems:[{sourceId:'i-1',orderSourceId:'o-1',serviceSourceId:'s-1',name:'Serviço histórico',quantity:2,unitPriceCents:5000,lineTotalCents:10000,discountCents:1000,netCents:9000,historicalCommissionCents:900}],
  payments:[{sourceId:'p-1',orderSourceId:'o-1',customerSourceId:'c-1',amountCents:9000,method:'pix',createdAt:stamp}],
}});
const nativeCsv = name => CUSTOMER_HEADERS.join(';') + '\r\n' + `${name};--;11999999999;Em aberto;01/02/2025;R$ 90,00;TST1A23;1;Dado sintético\r\n`;
const nativeInput = (name = 'Cliente sintético') => ({source:'jumpcar',files:[{entity:'customers',format:'csv',content:nativeCsv(name)}]});
const count = async (db,table) => (await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).count;

test('preview is read-only and reconciles all six entities without returning personal data',async t => {
  const {db,raw} = fixture(t), before = raw.prepare('SELECT total_changes() AS n').get().n;
  const result = await previewJkMigration(db,payload());
  assert.equal(result.canCommit,true); assert.match(result.previewHash,/^[a-f0-9]{64}$/u);
  for (const value of Object.values(result.counts)) assert.deepEqual(value,{received:1,insert:1,unchanged:0,rejected:0});
  assert.equal(result.reconciliation.ordersTotalCents,9000); assert.equal(result.reconciliation.paymentsTotalCents,9000);
  assert.equal(raw.prepare('SELECT total_changes() AS n').get().n,before);
  assert.equal(await count(db,'jk_migration_batches'),0); assert.equal(await count(db,'audit_events'),0);
  assert.ok(!JSON.stringify(result).includes('customer@example.test')); assert.ok(!JSON.stringify(result).includes('Cliente sintético'));
});

test('commit persists linked history, reconciles foreign keys and has zero operational side effects',async t => {
  const {db} = fixture(t), input = payload(), preview = await previewJkMigration(db,input);
  const result = await commitJkMigration(db,input,{previewHash:preview.previewHash,actorId:'migration-test-admin',idempotencyKey:'migration-first'});
  assert.equal(result.status,'COMMITTED');
  for (const table of ['customers','vehicles','services','jk_history_orders','jk_history_order_items','jk_history_payments']) assert.equal(await count(db,table),1);
  for (const table of ['orders','order_items','payments','payment_allocations','cash_movements','invoices','messages','stock_movements','commission_claims','payroll','appointments']) assert.equal(await count(db,table),0,table);
  assert.deepEqual(await db.prepare('PRAGMA foreign_key_check').all(),[]);
  await assert.rejects(db.prepare('DELETE FROM vehicles').run(),/FOREIGN KEY/u);
  assert.equal(await count(db,'vehicles'),1);
  const history = await jkMigrationHistory(db,new URL('http://local/api/jk/migration/history?entity=orders&limit=1'));
  assert.equal(history.items[0].totalCents,9000); assert.equal(history.page.total,1); assert.equal(history.mode,'historical');
  const status = await jkMigrationStatus(db); assert.equal(status.totals.ordersTotalCents,9000); assert.equal(status.counts.payments,1);
  const audit = await db.prepare("SELECT metadata_json FROM audit_events WHERE action='jk.migration.committed'").get();
  assert.ok(!audit.metadata_json.includes('customer@example.test'));
});

test('same batch and idempotency key replay without writes; changed key content conflicts',async t => {
  const {db} = fixture(t), input = payload(), preview = await previewJkMigration(db,input);
  const options = {previewHash:preview.previewHash,actorId:'migration-test-admin',idempotencyKey:'migration-replay'};
  const first = await commitJkMigration(db,input,options);
  const second = await commitJkMigration(db,input,options);
  assert.equal(second.status,'REPLAYED'); assert.equal(second.batchId,first.batchId);
  const freshPreview = await previewJkMigration(db,input);
  assert.equal(freshPreview.previewHash,preview.previewHash); assert.equal(freshPreview.counts.customers.unchanged,1);
  const third = await commitJkMigration(db,input,{...options,idempotencyKey:'another-key-123'});
  assert.equal(third.status,'REPLAYED'); assert.equal(await count(db,'customers'),1); assert.equal(await count(db,'jk_migration_batches'),1);
  const altered = payload(); altered.dataset.customers[0].name = 'Outra pessoa sintética';
  await assert.rejects(commitJkMigration(db,altered,options),{code:'IDEMPOTENCY_CONFLICT'});
});

test('tampering with input, reviewed hash, or database state prevents commit',async t => {
  const {db} = fixture(t), input = payload(), preview = await previewJkMigration(db,input);
  const altered = payload(); altered.dataset.customers[0].name = 'Outro nome sintético';
  await assert.rejects(commitJkMigration(db,altered,{previewHash:preview.previewHash}),{code:'PREVIEW_HASH_MISMATCH'});
  await assert.rejects(commitJkMigration(db,input,{previewHash:'0'.repeat(64)}),{code:'PREVIEW_HASH_MISMATCH'});
  await db.prepare('INSERT INTO customers(id,name,kind,postpaid,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('concurrent','Cliente concorrente','individual',0,stamp,stamp);
  await assert.rejects(commitJkMigration(db,input,{previewHash:preview.previewHash}),{code:'PREVIEW_HASH_MISMATCH'});
  assert.equal(await count(db,'jk_migration_batches'),0); assert.equal(await count(db,'customers'),1);
});

test('late SQL failure rolls back master records, history, origins, audit and idempotency together',async t => {
  const {db,raw} = fixture(t), input = payload();
  raw.exec("CREATE TRIGGER fail_import_audit BEFORE INSERT ON audit_events WHEN NEW.action='jk.migration.committed' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
  const preview = await previewJkMigration(db,input);
  await assert.rejects(commitJkMigration(db,input,{previewHash:preview.previewHash,actorId:'migration-test-admin',idempotencyKey:'rollback-case'}),/synthetic failure/u);
  for (const table of ['customers','vehicles','services','jk_history_orders','jk_history_order_items','jk_history_payments','jk_migration_records','jk_migration_batches','audit_events','idempotency_keys']) assert.equal(await count(db,table),0,table);
  raw.exec('DROP TRIGGER fail_import_audit');
  const result = await commitJkMigration(db,input,{previewHash:preview.previewHash}); assert.equal(result.status,'COMMITTED');
});

test('orphan, ownership, duplicate, totals, unsupported fields and missing history dates reject explicitly',async t => {
  const {db} = fixture(t);
  for (const [mutate,code] of [
    [input => {input.dataset.vehicles[0].customerSourceId='missing';},'ORPHAN_IMPORT_REFERENCE'],
    [input => {input.dataset.customers.push({...input.dataset.customers[0]});},'DUPLICATE_SOURCE_ID'],
    [input => {input.dataset.orders[0].totalCents=8000;},'ORDER_TOTAL_MISMATCH'],
    [input => {input.dataset.orderItems=[];},'ORDER_ITEMS_MISMATCH'],
    [input => {input.dataset.payments[0].amountCents=10000;},'PAYMENT_TOTAL_MISMATCH'],
    [input => {input.dataset.orders[0].status='cancelled';},'CANCELLED_ORDER_PAYMENT'],
    [input => {input.dataset.customers[0].password='synthetic-sensitive-value';},'UNSUPPORTED_IMPORT_FIELD'],
    [input => {delete input.dataset.orders[0].createdAt;},'INVALID_IMPORT_DATE'],
    [input => {input.dataset.orders[0].createdAt='2025-02-30T12:00:00Z';},'INVALID_IMPORT_DATE'],
    [input => {input.dataset.customers.push({sourceId:'c-2',name:'Outro cliente'}); input.dataset.orders[0].customerSourceId='c-2';},'VEHICLE_CUSTOMER_MISMATCH'],
  ]) {
    const input = payload(); mutate(input); const preview = await previewJkMigration(db,input);
    assert.equal(preview.canCommit,false,code); assert.ok(preview.issues.some(issue => issue.code === code),JSON.stringify(preview.issues));
    await assert.rejects(commitJkMigration(db,input,{previewHash:preview.previewHash}),{code:'IMPORT_REJECTED'});
    assert.ok(!JSON.stringify(preview).includes('synthetic-sensitive-value'));
  }
  assert.equal(await count(db,'customers'),0);
});

test('native snapshots preserve evidence, declare technical identities, replay and block a second snapshot',async t => {
  const {db} = fixture(t), input = nativeInput(), preview = await previewJkMigration(db,input);
  assert.equal(preview.canCommit,true); assert.equal(preview.identityMap[0].sourceId,null); assert.equal(preview.identityMap[0].provenance,'snapshot-row');
  assert.equal(preview.identityMap[0].row,2);
  await commitJkMigration(db,input,{previewHash:preview.previewHash});
  const record = await db.prepare('SELECT source_id,provenance FROM jk_migration_records').get();
  assert.equal(record.source_id,null); assert.equal(record.provenance,'snapshot-row');
  assert.equal(await count(db,'vehicles'),1); assert.equal(await count(db,'invoices'),0);
  assert.equal((await db.prepare('SELECT model FROM vehicles').get()).model,'');
  const evidence = await jkMigrationHistory(db,new URL('http://local/history?entity=sourceRows'));
  assert.equal(evidence.items[0].dataJson['Situação da fatura'],'Em aberto');
  const replay = await commitJkMigration(db,input,{previewHash:preview.previewHash}); assert.equal(replay.status,'REPLAYED');
  const next = await previewJkMigration(db,nativeInput('Cliente alterado'));
  assert.equal(next.canCommit,false); assert.ok(next.issues.some(issue => issue.code === 'SNAPSHOT_RECONCILIATION_REQUIRED'));
});

test('native plate extraction preserves one-character names, rejects conflicting ownership and archives ambiguous vehicles',async t => {
  const {db} = fixture(t);
  const legacy = nativeInput('.'), report = await previewJkMigration(db,legacy);
  assert.equal(report.canCommit,true); assert.equal(report.counts.vehicles.insert,1);
  assert.ok(report.warnings.some(item => item.code === 'LEGACY_SHORT_NAMES'));
  const conflict = nativeInput(); conflict.files[0].content += 'Segundo cliente;--;11911111111;--;--;0,00;TST1A23;--;--\r\n';
  const rejected = await previewJkMigration(db,conflict);
  assert.equal(rejected.canCommit,false); assert.ok(rejected.issues.some(issue => issue.code === 'PLATE_ALREADY_EXISTS'));
  const ambiguous = nativeInput(); ambiguous.files[0].content = ambiguous.files[0].content.replace('TST1A23','TST1A23 (modelo desconhecido)');
  const review = await previewJkMigration(db,ambiguous);
  assert.equal(review.canCommit,true); assert.equal(review.counts.vehicles.received,0); assert.ok(review.warnings.some(item => item.code === 'VEHICLE_LAYOUT_REVIEW_REQUIRED'));
  await commitJkMigration(db,legacy,{previewHash:report.previewHash});
  assert.equal((await db.prepare('SELECT name FROM customers').get()).name,'.');
});

test('CSV quoting, canonical columns, disguised HTML, malformed tables and binary XLS fail safely',async t => {
  const {db} = fixture(t);
  assert.deepEqual(parseCsv('a;b\r\n"x;y";"linha\n2"\r\n'),[['a','b'],['x;y','linha\n2']]);
  assert.throws(() => parseCsv('a;b\n"x"bad;y'),{code:'INVALID_CSV'});
  assert.throws(() => parseCsv('a;a\nx;y'),{code:'DUPLICATE_IMPORT_HEADER'});
  const html = `<html><head><style>td{color:black}</style></head><body><table><tr>${CUSTOMER_HEADERS.map(header => `<th>${header}</th>`).join('')}</tr><tr><td>Cliente &amp; Teste</td>${['--','11999999999','--','--','0,00','--','--','--'].map(cell => `<td>${cell}</td>`).join('')}</tr></table></body></html>`;
  assert.equal(parseJumpcarHtml(html)[1][0],'Cliente & Teste');
  const native = {source:'jumpcar',files:[{entity:'customers',format:'jumpcar-html',content:html}]};
  assert.equal((await previewJkMigration(db,native)).canCommit,true);
  assert.throws(() => parseJumpcarHtml('binary-xls'),{code:'UNSUPPORTED_XLS'});
  assert.throws(() => parseJumpcarHtml('<table><tr><td colspan="2">x</td></tr></table>'),{code:'UNSUPPORTED_HTML_TABLE'});
  const csv = {source:'jumpcar',files:[{entity:'services',format:'csv',content:'sourceId;name;priceCents;durationMinutes\ns-csv;Serviço CSV;4200;30\n'}]};
  assert.equal((await previewJkMigration(db,csv)).counts.services.insert,1);
});

test('CLI preview opens an existing database read-only and prints aggregate diagnostics without records',async t => {
  const directory = await mkdtemp(join(tmpdir(),'jk-import-test-')); t.after(() => rm(directory,{recursive:true,force:true}));
  const dbPath = join(directory,'local.sqlite'), inputPath = join(directory,'input.json');
  const {db} = fixture(t,dbPath); await writeFile(inputPath,JSON.stringify(nativeInput()),{mode:0o600});
  await db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all();
  const before = await readFile(dbPath), beforeInfo = await stat(dbPath); let out = '', err = '';
  const code = await importCli(['--db',dbPath,'--input',inputPath,'--preview'],{stdout:{write:value => {out += value;}},stderr:{write:value => {err += value;}}});
  assert.equal(code,0,err); assert.equal(err,''); assert.equal(JSON.parse(out).canCommit,true);
  assert.ok(!out.includes('Cliente sintético')); assert.ok(!out.includes('11999999999'));
  assert.deepEqual(await readFile(dbPath),before); assert.equal((await stat(dbPath)).mtimeMs,beforeInfo.mtimeMs);
});

function mockResponse() { return {headers:{},headersSent:false,setHeader(key,value){this.headers[key.toLowerCase()]=value;},writeHead(status,headers){this.status=status;for(const [key,value] of Object.entries(headers))this.headers[key.toLowerCase()]=value;this.headersSent=true;},end(body){this.body=JSON.parse(body);},destroy(){this.destroyed=true;}}; }
test('application handler enforces authentication, CSRF, live admin role and paginated history',async t => {
  const app = await createApplication({dbPath:':memory:',domainHandler:handleJkMigration,logger:{error(){}}}); initializeJkMigration(app.db); t.after(() => app.close());
  async function request(path,body,{cookie,csrf,method = 'POST',key} = {}) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method=method;req.url=path;req.headers={host:'127.0.0.1:4173','content-type':'application/json',...(cookie ? {cookie} : {}),...(csrf ? {'x-csrf-token':csrf} : {}),...(key ? {'idempotency-key':key} : {})};
    const res = mockResponse(); await app.handler(req,res); return res;
  }
  const setup = await request('/api/setup',{name:'Administrador sintético',email:'synthetic-admin@example.test',password:'synthetic-test-password-2026'});
  assert.equal(setup.status,201); const session = {cookie:setup.headers['set-cookie'].split(';')[0],csrf:setup.body.data.csrfToken};
  assert.equal((await request('/api/jk/migration/preview',payload())).status,401);
  assert.equal((await request('/api/jk/migration/preview',payload(),{cookie:session.cookie})).status,403);
  const preview = await request('/api/jk/migration/preview',payload(),session); assert.equal(preview.status,200);
  const commit = await request('/api/jk/migration/commit',{...payload(),previewHash:preview.body.data.previewHash},{...session,key:'http-import-first'}); assert.equal(commit.status,201,JSON.stringify(commit.body));
  const history = await request('/api/jk/migration/history?entity=orders&limit=1',undefined,{...session,method:'GET'}); assert.equal(history.body.data.page.total,1);
  await app.store.prepare("UPDATE users SET role='viewer' WHERE id=?").run(setup.body.data.user.id);
  assert.equal((await request('/api/jk/migration/preview',payload(),session)).status,403);
  assert.equal((await request('/api/jk/migration/status',undefined,{...session,method:'GET'})).status,403);
});
