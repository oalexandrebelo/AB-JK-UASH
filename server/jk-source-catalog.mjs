import {randomUUID} from 'node:crypto';
import {transaction,audit,idempotentWrite} from './db.mjs';
import {assert} from './errors.mjs';
import {requireRole,requireLiveRole,verifyCsrf} from './security.mjs';
import {readJson} from './http.mjs';
import {MAX_IMPORT_BYTES,hashObject,onlyKeys} from './jk-migration-parse.mjs';

export const SOURCE_CATALOG_COLLECTIONS=Object.freeze(['services','products','balances']);
const ROOT='/api/jk/source-catalog';
const MODE='source-reference';
const MAX_ROWS=20_000;
const EFFECTS=Object.freeze({services:0,products:0,orders:0,payments:0,cashMovements:0,invoices:0,stockMovements:0,packages:0});

export function initializeJkSourceCatalog(raw) {
  transaction(raw,()=>raw.exec(`
    CREATE TABLE IF NOT EXISTS jk_source_catalog_snapshots (
      id TEXT PRIMARY KEY,establishment_id INTEGER NOT NULL CHECK(establishment_id=24453),
      snapshot_hash TEXT NOT NULL UNIQUE,snapshot_json TEXT NOT NULL,preview_hash TEXT NOT NULL,
      report_json TEXT NOT NULL,observed_at TEXT NOT NULL,actor_id TEXT REFERENCES users(id),committed_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS jk_source_catalog_rows (
      id TEXT PRIMARY KEY,snapshot_id TEXT NOT NULL REFERENCES jk_source_catalog_snapshots(id),
      collection TEXT NOT NULL CHECK(collection IN ('services','products','balances')),
      source_row INTEGER NOT NULL CHECK(source_row>0),source_id TEXT,name TEXT NOT NULL,
      active INTEGER CHECK(active IN (0,1)),data_json TEXT NOT NULL,
      UNIQUE(snapshot_id,collection,source_row)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS jk_source_catalog_collection_rows ON jk_source_catalog_rows(collection,source_row);
  `));
}

function available(db) {assert(db.mode==='local',501,'SOURCE_CATALOG_LOCAL_ONLY','O catálogo da origem está disponível somente no SQLite local.');}
function text(value,field,max=2000,required=false) {
  assert(typeof value==='string'&&value.length<=max&&(!required||value.trim().length>0)&&Buffer.from(value,'utf8').toString('utf8')===value&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value),422,'INVALID_SOURCE_CATALOG_TEXT','Texto ausente, longo demais ou inválido.',{field});
  return value;
}
function integer(value,field,min=0,max=1_000_000_000) {
  assert(Number.isSafeInteger(value)&&!Object.is(value,-0)&&value>=min&&value<=max,422,'INVALID_SOURCE_CATALOG_INTEGER','Informe um inteiro no limite permitido; dinheiro é representado em centavos.',{field});
  return value;
}
function nullable(value,validator) {return value===null?null:validator(value);}
function boolean(value,field) {assert(typeof value==='boolean',422,'INVALID_SOURCE_CATALOG_BOOLEAN','Informe verdadeiro, falso ou desconhecido (null).',{field});return value;}
function timestamp(value,field) {
  text(value,field,40,true);
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)&&Number.isFinite(Date.parse(value)),422,'INVALID_SOURCE_CATALOG_DATE','Informe data e hora com fuso explícito.',{field});
  const date=value.slice(0,10);
  assert(new Date(`${date}T00:00:00Z`).toISOString().slice(0,10)===date,422,'INVALID_SOURCE_CATALOG_DATE','A data não existe.',{field});
  return value;
}
function rawFields(value) {
  onlyKeys(value,Object.keys(value||{}));
  assert(Object.keys(value).length<=80,422,'SOURCE_CATALOG_RAW_LIMIT','O registro contém campos de origem demais.');
  for(const [key,cell] of Object.entries(value)) {
    text(key,'raw.key',120,true);
    assert(cell===null||['string','number','boolean'].includes(typeof cell),422,'SOURCE_CATALOG_RAW_SCALAR','Os campos brutos precisam ser valores simples.');
    if(typeof cell==='string')text(cell,`raw.${key}`,6000);
    if(typeof cell==='number')assert(Number.isSafeInteger(cell)&&!Object.is(cell,-0),422,'INVALID_SOURCE_CATALOG_INTEGER','Preserve decimais brutos como texto, sem arredondamento.');
  }
  return value;
}
function record(collection,row) {
  const shared=['sourceRow','sourceId','name','raw'];
  const fields={
    services:['category','priceCents','active','schedulingEnabled','durationMinutes','commissionBps'],
    products:['sku','brand','category','application','unit','unitsPerItem','sourceQuantity','sourceMinimumQuantity','priceCents','costCents','active'],
    balances:['kind','amountCents','currency','status','asOf'],
  };
  onlyKeys(row,[...shared,...fields[collection]]);
  // Unknown values must be explicit nulls. Omission is not an instruction to default.
  assert([...shared,...fields[collection]].every(field=>Object.hasOwn(row,field)),422,'SOURCE_CATALOG_FIELDS_REQUIRED','Informe todos os campos do contrato; use null para valores desconhecidos.');
  integer(row.sourceRow,'sourceRow',1,1_000_000_000);
  nullable(row.sourceId,value=>{text(value,'sourceId',256,true);assert(!/\s/u.test(value),422,'INVALID_SOURCE_CATALOG_ID','O ID real da origem não pode conter espaços.');});
  text(row.name,'name',240,true);rawFields(row.raw);
  for(const field of ['category','sku','brand','application','unit','unitsPerItem','sourceQuantity','sourceMinimumQuantity','status'])if(Object.hasOwn(row,field))nullable(row[field],value=>text(value,field,240));
  for(const field of ['priceCents','costCents'])if(Object.hasOwn(row,field))nullable(row[field],value=>integer(value,field));
  for(const field of ['active','schedulingEnabled'])if(Object.hasOwn(row,field))nullable(row[field],value=>boolean(value,field));
  if(collection==='services') {
    nullable(row.durationMinutes,value=>integer(value,'durationMinutes',1,1440));
    nullable(row.commissionBps,value=>integer(value,'commissionBps',0,10000));
  }
  if(collection==='balances') {
    assert(['account','cash','receivable','payable','customer-credit','package-credit','other'].includes(row.kind),422,'INVALID_SOURCE_BALANCE_KIND','Selecione a natureza da posição observada.');
    nullable(row.amountCents,value=>integer(value,'amountCents',-1_000_000_000));
    assert(row.currency==='BRL',422,'SOURCE_BALANCE_CURRENCY','Esta posição usa reais (BRL).');
    nullable(row.asOf,value=>timestamp(value,'asOf'));
  }
  return row;
}

export function parseJkSourceCatalog(input) {
  onlyKeys(input,['snapshot','previewHash']);
  assert(Buffer.byteLength(JSON.stringify(input))<=MAX_IMPORT_BYTES,422,'IMPORT_TOO_LARGE','O catálogo excede 8 MiB.');
  const snapshot=input.snapshot;
  onlyKeys(snapshot,['schemaVersion','source','establishmentId','observedAt',...SOURCE_CATALOG_COLLECTIONS]);
  assert(snapshot.schemaVersion===1&&snapshot.source==='jumpcar-ui'&&snapshot.establishmentId===24453,422,'SOURCE_CATALOG_SCOPE','Confira a versão, a origem e a unidade Lava Rápido JK.');
  timestamp(snapshot.observedAt,'observedAt');
  const counts={},statuses={},rows=[];
  for(const collection of SOURCE_CATALOG_COLLECTIONS) {
    assert(Array.isArray(snapshot[collection])&&snapshot[collection].length<=MAX_ROWS,422,'SOURCE_CATALOG_ROWS','Cada coleção precisa ser uma lista de até 20.000 registros.');
    counts[collection]=snapshot[collection].length;
    statuses[collection]={active:0,inactive:0,unknown:0};
    const rowNumbers=new Set(),sourceIds=new Set();
    for(const value of snapshot[collection]) {
      const data=record(collection,value);
      assert(!rowNumbers.has(data.sourceRow),422,'SOURCE_CATALOG_DUPLICATE_ROW','Uma coleção repete a linha de origem.',{collection,sourceRow:data.sourceRow});rowNumbers.add(data.sourceRow);
      if(data.sourceId!==null){assert(!sourceIds.has(data.sourceId),422,'SOURCE_CATALOG_DUPLICATE_ID','Uma coleção repete o ID real da origem.',{collection});sourceIds.add(data.sourceId);}
      if(collection!=='balances')statuses[collection][data.active===null?'unknown':data.active?'active':'inactive']++;
      rows.push({collection,data});
    }
  }
  assert(rows.length>0&&rows.length<=MAX_ROWS,422,'SOURCE_CATALOG_ROWS','Informe de 1 a 20.000 registros no total.');
  const snapshotHash=hashObject(snapshot);
  return {snapshot,snapshotHash,counts,statuses,rows:rows.map(row=>({...row,id:`${snapshotHash}:${row.collection}:${row.data.sourceRow}`}))};
}

async function prepare(db,input) {
  const parsed=parseJkSourceCatalog(input);
  const existing=await db.prepare('SELECT id,snapshot_hash,preview_hash,report_json FROM jk_source_catalog_snapshots WHERE snapshot_hash=?').get(parsed.snapshotHash);
  const latest=await db.prepare('SELECT id,snapshot_hash FROM jk_source_catalog_snapshots ORDER BY rowid DESC LIMIT 1').get();
  const report={status:'PREVIEW',mode:MODE,source:'jumpcar-ui',establishmentId:24453,observedAt:parsed.snapshot.observedAt,sourceVerified:false,operational:false,
    canCommit:true,counts:parsed.counts,statuses:parsed.statuses,snapshotHash:parsed.snapshotHash,issues:[],replayAvailable:Boolean(existing),operationalWrites:{...EFFECTS},
    previewHash:existing?existing.preview_hash:hashObject({snapshotHash:parsed.snapshotHash,latest:latest?{id:latest.id,snapshotHash:latest.snapshot_hash}:null})};
  return {parsed,existing,report};
}
export async function previewJkSourceCatalog(db,input,{authorize}={}) {
  available(db);return db.read(async()=>{if(authorize)await authorize();return (await prepare(db,input)).report;});
}
export async function commitJkSourceCatalog(db,input,{actorId=null,idempotencyKey,authorize}={}) {
  available(db);
  assert(typeof input?.previewHash==='string'&&/^[a-f0-9]{64}$/u.test(input.previewHash),422,'PREVIEW_HASH_REQUIRED','Informe o hash da prévia revisada.');
  parseJkSourceCatalog(input);
  const authorizeCommit=async()=>{
    if(authorize)await authorize();
    assert(typeof actorId==='string'&&actorId&&await db.prepare("SELECT id FROM users WHERE id=? AND active=1 AND role='admin'").get(actorId),403,'ADMIN_REQUIRED','A preservação exige um administrador ativo.');
  };
  const operation=async()=>{
    const {parsed,existing,report}=await prepare(db,input);
    assert(report.previewHash===input.previewHash,409,'PREVIEW_HASH_MISMATCH','A posição ou o catálogo preservado mudou. Gere uma nova prévia.');
    assert(report.canCommit,422,'SOURCE_CATALOG_REJECTED','A posição exige conciliação; nenhum registro foi gravado.',{issues:report.issues});
    if(report.replayAvailable)return {...JSON.parse(existing.report_json),status:'REPLAYED',replayed:true};
    const batchId=randomUUID(),committedAt=new Date().toISOString();
    const result={...report,status:'COMMITTED',canCommit:false,batchId,committedAt,replayed:false};
    await db.prepare('INSERT INTO jk_source_catalog_snapshots(id,establishment_id,snapshot_hash,snapshot_json,preview_hash,report_json,observed_at,actor_id,committed_at) VALUES(?,24453,?,?,?,?,?,?,?)')
      .run(batchId,parsed.snapshotHash,JSON.stringify(parsed.snapshot),input.previewHash,JSON.stringify(result),parsed.snapshot.observedAt,actorId,committedAt);
    for(const {id,collection,data} of parsed.rows)await db.prepare('INSERT INTO jk_source_catalog_rows(id,snapshot_id,collection,source_row,source_id,name,active,data_json) VALUES(?,?,?,?,?,?,?,?)')
      .run(id,batchId,collection,data.sourceRow,data.sourceId,data.name,data.active===undefined||data.active===null?null:Number(data.active),JSON.stringify(data));
    await audit(db,{actorId,action:'jk.source_catalog.committed',resourceType:'jk_source_catalog_snapshot',resourceId:batchId,metadata:{snapshotHash:parsed.snapshotHash,counts:parsed.counts,operational:false}});
    return result;
  };
  if(idempotencyKey!==undefined) {
    const result=await idempotentWrite(db,{actorId,key:idempotencyKey,method:'POST',path:`${ROOT}/commit`,body:input,authorize:authorizeCommit},operation);
    return result.replayed?{...result,status:'REPLAYED'}:result;
  }
  return transaction(db,async()=>{await authorizeCommit();return operation();});
}
export async function jkSourceCatalogStatus(db) {
  if(db.mode!=='local')return {supported:false,mode:MODE,reason:'SQLITE_LOCAL_REQUIRED'};
  const row=await db.prepare('SELECT report_json FROM jk_source_catalog_snapshots ORDER BY rowid DESC LIMIT 1').get();
  const totalSnapshots=(await db.prepare('SELECT COUNT(*) AS n FROM jk_source_catalog_snapshots').get()).n;
  if(!row)return {supported:true,mode:MODE,status:'not_imported',sourceVerified:false,operational:false,counts:{services:0,products:0,balances:0},snapshotHash:null,totalSnapshots};
  const report=JSON.parse(row.report_json);
  return {...report,supported:true,totalSnapshots};
}
export async function jkSourceCatalogRows(db,url) {
  available(db);
  const collection=url.searchParams.get('collection')||'services',limit=Number(url.searchParams.get('limit')||25),offset=Number(url.searchParams.get('offset')||0),q=url.searchParams.get('q')||'';
  assert(SOURCE_CATALOG_COLLECTIONS.includes(collection),422,'SOURCE_CATALOG_COLLECTION','Selecione services, products ou balances.');
  assert(Number.isSafeInteger(limit)&&limit>=1&&limit<=500&&Number.isSafeInteger(offset)&&offset>=0&&offset<=1e9&&q.length<=200,422,'INVALID_SOURCE_CATALOG_PAGE','Paginação ou busca inválida.');
  const where="FROM jk_source_catalog_rows r JOIN jk_source_catalog_snapshots s ON s.id=r.snapshot_id WHERE s.id=(SELECT id FROM jk_source_catalog_snapshots ORDER BY rowid DESC LIMIT 1) AND r.collection=? AND (?='' OR instr(lower(r.name),lower(?))>0)";
  const total=(await db.prepare(`SELECT COUNT(*) AS n ${where}`).get(collection,q,q)).n;
  const rows=await db.prepare(`SELECT r.id,r.data_json,s.snapshot_hash,s.observed_at ${where} ORDER BY r.source_row LIMIT ? OFFSET ?`).all(collection,q,q,limit,offset);
  return {mode:MODE,collection,operational:false,items:rows.map(row=>{const data=JSON.parse(row.data_json);return {id:row.id,...data,provenance:{source:'jumpcar-ui',establishmentId:24453,snapshotHash:row.snapshot_hash,collection,sourceRow:data.sourceRow,observedAt:row.observed_at}};}),page:{limit,offset,total,hasMore:offset+rows.length<total}};
}
export async function handleJkSourceCatalog(ctx) {
  if(![`${ROOT}/status`,`${ROOT}/rows`,`${ROOT}/preview`,`${ROOT}/commit`].includes(ctx.pathname))return null;
  const actor=requireRole(ctx.session,['admin']);
  if(ctx.method==='GET') {
    await requireLiveRole(ctx.db,ctx.session,['admin']);
    if(ctx.pathname===`${ROOT}/status`)return {data:await jkSourceCatalogStatus(ctx.db)};
    if(ctx.pathname===`${ROOT}/rows`)return {data:await jkSourceCatalogRows(ctx.db,ctx.url)};
    return null;
  }
  if(ctx.method!=='POST'||![`${ROOT}/preview`,`${ROOT}/commit`].includes(ctx.pathname))return null;
  verifyCsrf(ctx.request,ctx.session);available(ctx.db);
  const input=await readJson(ctx.request,MAX_IMPORT_BYTES),authorize=()=>requireLiveRole(ctx.db,ctx.session,['admin']);
  if(ctx.pathname===`${ROOT}/preview`)return {data:await previewJkSourceCatalog(ctx.db,input,{authorize})};
  const key=ctx.request.headers['idempotency-key'];assert(typeof key==='string',400,'IDEMPOTENCY_KEY_REQUIRED','Envie Idempotency-Key.');
  const result=await commitJkSourceCatalog(ctx.db,input,{actorId:actor.id,idempotencyKey:key,authorize});
  return {status:result.replayed?200:201,data:result,...(result.replayed?{headers:{'Idempotency-Replayed':'true'}}:{})};
}
