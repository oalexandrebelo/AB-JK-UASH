import {randomUUID} from 'node:crypto';
import {audit,idempotentWrite,transaction} from './db.mjs';
import {assert} from './errors.mjs';
import {requireRole,requireLiveRole,verifyCsrf} from './security.mjs';
import {readJson} from './http.mjs';
import * as v from './validation.mjs';
import {decodeImport,hashObject,onlyKeys,sha256,technicalImportId,MAX_IMPORT_BYTES} from './jk-migration-parse.mjs';
import {parseJkHistoryExport,ARCHIVE_HEADERS} from './jk-history-export-parse.mjs';

const PATH='/api/jk/reconciliation';
const HISTORY_STATUSES=['proposal','insufficient_identity','identity_mismatch','plate_conflict','plate_absent','invalid_plate'];
const CATEGORY=['small','medium','large','motorcycle'];
const matchSource=condition=>assert(condition,409,'RECONCILIATION_SOURCE_MISMATCH','O acervo ou os vínculos preservados mudaram. Revise a origem antes de conciliar.');
const available=db=>assert(db.mode==='local',501,'JK_RECONCILIATION_LOCAL_ONLY','A conciliação está disponível somente no SQLite local.');
const absent=value=>['','--'].includes(value.trim())?'':value.trim();
// Formatting equivalence only: never remove/add digits, country codes or accents.
const phone=value=>absent(value).replace(/[\s()+.\-]/gu,'');
const plate=value=>value.toUpperCase().replace(/[\s-]/gu,'');
const validPlate=value=>/^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/u.test(value);

export function initializeJkReconciliation(raw) {
  transaction(raw,()=>raw.exec(`
    CREATE TABLE IF NOT EXISTS jk_reconciliation_batches (
      id TEXT PRIMARY KEY,input_hash TEXT NOT NULL UNIQUE,preview_hash TEXT NOT NULL,report_json TEXT NOT NULL,
      actor_id TEXT NOT NULL REFERENCES users(id),committed_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS jk_reconciliation_vehicles (
      id TEXT PRIMARY KEY,customer_id TEXT NOT NULL REFERENCES customers(id),snapshot_hash TEXT NOT NULL,source_row INTEGER NOT NULL,
      plate TEXT NOT NULL UNIQUE,evidence_hash TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('awaiting_review','promoted')),
      category TEXT CHECK(category IN ('small','medium','large','motorcycle')),model TEXT,color TEXT,
      vehicle_id TEXT UNIQUE REFERENCES vehicles(id),batch_id TEXT NOT NULL REFERENCES jk_reconciliation_batches(id),
      review_batch_id TEXT REFERENCES jk_reconciliation_batches(id),reviewed_at TEXT,
      CHECK((status='awaiting_review' AND category IS NULL AND model IS NULL AND color IS NULL AND vehicle_id IS NULL AND review_batch_id IS NULL AND reviewed_at IS NULL)
        OR (status='promoted' AND category IS NOT NULL AND model IS NOT NULL AND color IS NOT NULL AND vehicle_id IS NOT NULL AND vehicle_id=id AND review_batch_id IS NOT NULL AND reviewed_at IS NOT NULL))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS jk_reconciliation_history (
      archive_row_id TEXT PRIMARY KEY REFERENCES jk_history_archive_rows(id),candidate_customer_id TEXT REFERENCES customers(id),
      vehicle_ref TEXT REFERENCES jk_reconciliation_vehicles(id),status TEXT NOT NULL CHECK(status IN ('proposal','insufficient_identity','identity_mismatch','plate_conflict','plate_absent','invalid_plate')),
      evidence_hash TEXT NOT NULL,batch_id TEXT NOT NULL REFERENCES jk_reconciliation_batches(id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS jk_reconciliation_vehicle_customer ON jk_reconciliation_vehicles(customer_id,source_row);
    CREATE INDEX IF NOT EXISTS jk_reconciliation_history_customer ON jk_reconciliation_history(candidate_customer_id,archive_row_id);
  `));
}

function inputReviews(input) {
  onlyKeys(input,['vehicleReviews','previewHash']);
  const reviews=input.vehicleReviews??[];
  assert(Array.isArray(reviews)&&reviews.length<=500,422,'INVALID_VEHICLE_REVIEWS','Revise no máximo 500 veículos por confirmação.');
  const seen=new Set();
  return reviews.map(review=>{
    onlyKeys(review,['vehicleRef','category','model','color']);
    const vehicleRef=v.identifier(review.vehicleRef,'vehicleRef');
    assert(!seen.has(vehicleRef),422,'DUPLICATE_VEHICLE_REVIEW','O mesmo veículo foi revisado mais de uma vez.');seen.add(vehicleRef);
    return {vehicleRef,category:v.choice(review.category,'category',CATEGORY),model:v.text(review.model,'model',{min:1,max:100}),color:v.text(review.color??'','color',{max:60})};
  }).sort((a,b)=>a.vehicleRef.localeCompare(b.vehicleRef));
}

async function loadState(db) {
  const result={};
  for(const [key,sql]of Object.entries({
    files:"SELECT * FROM jk_history_archive_files WHERE kind IN ('customers','orders') ORDER BY kind",
    archiveRows:"SELECT r.* FROM jk_history_archive_rows r JOIN jk_history_archive_files f ON f.id=r.file_id WHERE f.kind IN ('customers','orders') ORDER BY r.file_id,r.source_row",
    origins:"SELECT * FROM jk_migration_records WHERE source='jumpcar' AND scope='jk' AND entity='customers' ORDER BY origin_key",
    sourceRows:'SELECT * FROM jk_migration_source_rows ORDER BY snapshot_hash,source_row',
    customers:'SELECT * FROM customers ORDER BY id',vehicles:'SELECT * FROM vehicles ORDER BY id',
    stagedVehicles:'SELECT * FROM jk_reconciliation_vehicles ORDER BY id',stagedHistory:'SELECT * FROM jk_reconciliation_history ORDER BY archive_row_id',
  }))result[key]=await db.prepare(sql).all();
  return result;
}

function sourcePlan(state) {
  assert(state.files.length===2,422,'RECONCILIATION_ARCHIVES_REQUIRED','Preserve os acervos originais de clientes e histórico antes de conciliar.');
  const parsed={},files={};
  for(const file of state.files) {
    matchSource(sha256(file.content)===file.snapshot_hash);
    parsed[file.kind]=parseJkHistoryExport({content:file.content});files[file.kind]=file;
    matchSource(parsed[file.kind].kind===file.kind);
    const rows=state.archiveRows.filter(row=>row.file_id===file.id),expected=parsed[file.kind].rows;
    matchSource(rows.length===expected.length);
    for(let index=0;index<rows.length;index++)matchSource(rows[index].id===expected[index].id&&rows[index].source_row===expected[index].sourceRow&&rows[index].source_number===expected[index].sourceNumber&&rows[index].values_json===JSON.stringify(expected[index].values));
  }
  const native=decodeImport({source:'jumpcar',files:[{entity:'customers',format:'csv',content:files.customers.content}]});
  const origins=new Map(state.origins.map(row=>[row.origin_key,row])),sourceRows=new Map(state.sourceRows.map(row=>[`${row.snapshot_hash}:${row.source_row}`,row])),customers=new Map(state.customers.map(row=>[row.id,row]));
  const sourceCustomers=new Map();
  for(const row of native.rows.customers) {
    const origin=origins.get(row.origin.originKey),id=technicalImportId('customers',row.origin.originKey),preserved=sourceRows.get(`${row.origin.snapshotHash}:${row.origin.row}`);
    matchSource(origin&&origin.target_id===id&&origin.source_id===null&&origin.provenance==='snapshot-row'&&origin.snapshot_hash===row.origin.snapshotHash&&origin.source_row===row.origin.row&&customers.has(id));
    matchSource(preserved&&preserved.id===id&&preserved.customer_id===id&&preserved.batch_id===origin.batch_id&&preserved.data_json===JSON.stringify(row.origin.archive));
    sourceCustomers.set(row.origin.row,{id,values:row.origin.archive});
  }
  const groups=new Map();for(const row of native.rows.vehicles){if(!groups.has(row.value.plate))groups.set(row.value.plate,[]);groups.get(row.value.plate).push(row);}
  const ambiguousTokens=new Set();let ambiguousRows=0;
  for(const row of native.rows.customers) {
    const raw=row.origin.archive.Veículos.trim();if(!raw||raw==='--')continue;
    if(raw.toUpperCase().split(/[\s,;|/]+/u).map(x=>x.replaceAll('-','')).every(validPlate))continue;
    ambiguousRows++;
    for(const match of raw.toUpperCase().matchAll(/\b[A-Z]{3}-?[0-9][A-Z0-9][0-9]{2}\b/gu))ambiguousTokens.add(match[0].replaceAll('-',''));
  }
  const vehicles=[];let conflicts=0,conflictEntries=0,ambiguousTokenCollisions=0;
  for(const [key,rows]of groups) {
    if(rows.length>1){conflicts++;conflictEntries+=rows.length;continue;}
    if(ambiguousTokens.has(key)){ambiguousTokenCollisions++;continue;}
    const row=rows[0],customer=sourceCustomers.get(row.origin.row);matchSource(customer&&customer.id===row.value.customerImportId);
    const value={id:technicalImportId('vehicles',row.origin.originKey),customer_id:customer.id,snapshot_hash:row.origin.snapshotHash,source_row:row.origin.row,plate:key};
    vehicles.push({...value,evidence_hash:hashObject({value,origin:row.origin,customer:customer.values})});
  }
  const byPlate=new Map(vehicles.map(row=>[row.plate,row])),history=[];
  const counts={rows:parsed.orders.rows.length,proposal:0,insufficientIdentity:0,identityMismatch:0,plateConflict:0,plateAbsent:0,invalidPlate:0};
  for(const row of parsed.orders.rows) {
    const p=plate(row.values[4]),vehicle=byPlate.get(p);let status;
    if(!validPlate(p))status='invalid_plate';
    else if(groups.get(p)?.length>1||ambiguousTokens.has(p))status='plate_conflict';
    else if(!vehicle)status='plate_absent';
    else {
      const original=sourceCustomers.get(vehicle.source_row).values;
      const matches=row.values[1]===original.Nome&&phone(row.values[2])===phone(original.Telefone)&&absent(row.values[3])===absent(original['E-mail']);
      status=!matches?'identity_mismatch':absent(row.values[2])||absent(row.values[3])?'proposal':'insufficient_identity';
    }
    counts[status.replace(/_([a-z])/gu,(_,c)=>c.toUpperCase())]++;
    const value={archive_row_id:row.id,candidate_customer_id:vehicle?.customer_id??null,vehicle_ref:vehicle?.id??null,status};
    history.push({...value,evidence_hash:hashObject({value,source:row,vehicleEvidence:vehicle?.evidence_hash??null})});
  }
  return {vehicles,history,counts,snapshotHashes:{customers:parsed.customers.snapshotHash,orders:parsed.orders.snapshotHash},conflicts,conflictEntries,ambiguousRows,ambiguousTokenCollisions};
}

async function prepare(db,input={}) {
  const reviews=inputReviews(input),state=await loadState(db),plan=sourcePlan(state),candidates=new Map(plan.vehicles.map(row=>[row.id,row]));
  const staged=new Map(state.stagedVehicles.map(row=>[row.id,row])),storedHistory=new Map(state.stagedHistory.map(row=>[row.archive_row_id,row])),currentVehicles=new Map(state.vehicles.map(row=>[row.id,row]));
  for(const row of state.stagedVehicles) {
    const expected=candidates.get(row.id);matchSource(expected&&Object.keys(expected).every(key=>row[key]===expected[key]));
    if(row.status==='promoted'){const actual=currentVehicles.get(row.vehicle_id);matchSource(actual&&actual.id===row.id&&actual.customer_id===row.customer_id&&actual.plate===row.plate);}
  }
  const historyById=new Map(plan.history.map(row=>[row.archive_row_id,row]));
  for(const row of state.stagedHistory){const expected=historyById.get(row.archive_row_id);matchSource(expected&&Object.keys(expected).every(key=>row[key]===expected[key]));}
  const reviewInserts=[];
  for(const review of reviews) {
    const candidate=candidates.get(review.vehicleRef);assert(candidate,422,'UNKNOWN_RECONCILIATION_VEHICLE','A revisão deve indicar um veículo sem conflito deste acervo.');
    const previous=staged.get(candidate.id);
    if(previous?.status==='promoted') {
      assert(review.category===previous.category&&review.model===previous.model&&review.color===previous.color,409,'VEHICLE_REVIEW_CHANGED','O veículo já foi revisado. Alterações posteriores exigem edição no cadastro operacional.');continue;
    }
    assert(!state.vehicles.some(row=>row.id===candidate.id||row.plate===candidate.plate),409,'RECONCILIATION_VEHICLE_EXISTS','A placa ou identificação já existe no cadastro operacional. Nenhum proprietário será substituído.');
    assert(state.customers.find(row=>row.id===candidate.customer_id)?.active===1,409,'RECONCILIATION_CUSTOMER_INACTIVE','O cliente precisa estar ativo para cadastrar o veículo revisado.');
    reviewInserts.push({...candidate,...review});
  }
  const promoted=state.stagedVehicles.filter(row=>row.status==='promoted').length;
  const counts={vehicles:{eligible:plan.vehicles.length,staged:state.stagedVehicles.length,promoted,pendingReview:plan.vehicles.length-promoted,conflictGroups:plan.conflicts,conflictingEntries:plan.conflictEntries,ambiguousCustomerRows:plan.ambiguousRows,ambiguousTokenCollisions:plan.ambiguousTokenCollisions},history:plan.counts};
  const inputHash=hashObject({version:1,snapshotHashes:plan.snapshotHashes,vehicleReviews:reviews});
  const prior=await db.prepare('SELECT preview_hash,report_json FROM jk_reconciliation_batches WHERE input_hash=?').get(inputHash);
  const report={supported:true,ready:true,status:'PREVIEW',mode:'documentary',sourceVerified:false,snapshotHashes:plan.snapshotHashes,counts,inputHash,
    previewHash:prior?.preview_hash||hashObject({version:1,inputHash,state}),canCommit:true,replayAvailable:Boolean(prior),
    operationalWrites:{customers:0,vehicles:reviewInserts.length,orders:0,payments:0,cashMovements:0,invoices:0,stockMovements:0,commissions:0},
    documentaryWrites:{vehicles:plan.vehicles.filter(row=>!staged.has(row.id)).length,history:plan.history.filter(row=>!storedHistory.has(row.archive_row_id)).length},
    warnings:['Titularidade e identidade histórica permanecem não verificadas. As propostas usam concordância de campos, sem IDs Jumpcar.','Categoria e modelo são desconhecidos até a revisão explícita. Pagamentos e totais do acervo não geram recebimentos ou saldo.']};
  return {state,plan,reviewInserts,staged,storedHistory,report,prior};
}

export async function previewJkReconciliation(db,input={}, {authorize}={}) {
  available(db);return db.read(async()=>{if(authorize)await authorize();return (await prepare(db,input)).report;});
}

export async function commitJkReconciliation(db,input,{actorId=null,idempotencyKey,authorize}={}) {
  available(db);inputReviews(input);
  assert(typeof input.previewHash==='string'&&/^[a-f0-9]{64}$/u.test(input.previewHash),422,'PREVIEW_HASH_REQUIRED','Informe o hash da prévia revisada.');
  const authorizeCommit=async()=>{
    if(authorize)await authorize();
    assert(actorId&&await db.prepare("SELECT id FROM users WHERE id=? AND active=1 AND role='admin'").get(actorId),403,'ADMIN_REQUIRED','A conciliação exige um administrador ativo.');
  };
  const operation=async()=>{
    const {plan,reviewInserts,staged,storedHistory,report,prior}=await prepare(db,input);
    assert(input.previewHash===report.previewHash,409,'PREVIEW_HASH_MISMATCH','O acervo, a revisão ou o cadastro mudou. Gere uma nova prévia.');
    if(prior)return {...JSON.parse(prior.report_json),status:'REPLAYED',replayed:true};
    const batchId=randomUUID(),committedAt=new Date().toISOString(),result={...report,status:'COMMITTED',canCommit:false,batchId,committedAt,replayed:false};
    await db.prepare('INSERT INTO jk_reconciliation_batches(id,input_hash,preview_hash,report_json,actor_id,committed_at) VALUES(?,?,?,?,?,?)').run(batchId,report.inputHash,report.previewHash,JSON.stringify(result),actorId,committedAt);
    for(const row of plan.vehicles)if(!staged.has(row.id))await db.prepare("INSERT INTO jk_reconciliation_vehicles(id,customer_id,snapshot_hash,source_row,plate,evidence_hash,status,batch_id) VALUES(?,?,?,?,?,?,'awaiting_review',?)").run(row.id,row.customer_id,row.snapshot_hash,row.source_row,row.plate,row.evidence_hash,batchId);
    for(const row of plan.history)if(!storedHistory.has(row.archive_row_id))await db.prepare('INSERT INTO jk_reconciliation_history(archive_row_id,candidate_customer_id,vehicle_ref,status,evidence_hash,batch_id) VALUES(?,?,?,?,?,?)').run(row.archive_row_id,row.candidate_customer_id,row.vehicle_ref,row.status,row.evidence_hash,batchId);
    for(const row of reviewInserts) {
      await db.prepare('INSERT INTO vehicles(id,customer_id,plate,model,color,category,active,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)').run(row.id,row.customer_id,row.plate,row.model,row.color,row.category,committedAt,committedAt);
      await db.prepare("UPDATE jk_reconciliation_vehicles SET status='promoted',category=?,model=?,color=?,vehicle_id=id,review_batch_id=?,reviewed_at=? WHERE id=? AND status='awaiting_review'").run(row.category,row.model,row.color,batchId,committedAt,row.id);
    }
    matchSource((await db.prepare('PRAGMA foreign_key_check').all()).length===0);
    await audit(db,{actorId,action:'jk.reconciliation.committed',resourceType:'jk_reconciliation_batch',resourceId:batchId,metadata:{snapshotHashes:report.snapshotHashes,inputHash:report.inputHash,previewHash:report.previewHash,documentaryWrites:report.documentaryWrites,operationalWrites:report.operationalWrites,sourceVerified:false}});
    return result;
  };
  if(idempotencyKey!==undefined){const result=await idempotentWrite(db,{actorId,key:idempotencyKey,method:'POST',path:PATH+'/commit',body:input,authorize:authorizeCommit},operation);return result.replayed?{...result,status:'REPLAYED'}:result;}
  return transaction(db,async()=>{await authorizeCommit();return operation();});
}

export async function jkReconciliationStatus(db) {
  if(db.mode!=='local')return {supported:false,mode:'documentary',sourceVerified:false};
  const files=await db.prepare("SELECT kind FROM jk_history_archive_files WHERE kind IN ('customers','orders')").all();
  if(files.length!==2)return {supported:true,ready:false,mode:'documentary',sourceVerified:false,requiredArchives:['customers','orders'].filter(kind=>!files.some(row=>row.kind===kind))};
  const {report}=await prepare(db,{});
  const latest=await db.prepare('SELECT id,committed_at FROM jk_reconciliation_batches ORDER BY committed_at DESC,rowid DESC LIMIT 1').get();
  return {supported:true,ready:true,mode:'documentary',sourceVerified:false,snapshotHashes:report.snapshotHashes,counts:report.counts,latestBatch:latest?{batchId:latest.id,committedAt:latest.committed_at}:null};
}

function pagination(url,statuses) {
  const limit=Number(url.searchParams.get('limit')||25),offset=Number(url.searchParams.get('offset')||0),customerId=url.searchParams.get('customerId')||'',p=plate(url.searchParams.get('plate')||''),status=url.searchParams.get('status')||'';
  assert(Number.isSafeInteger(limit)&&limit>=1&&limit<=500&&Number.isSafeInteger(offset)&&offset>=0&&offset<=1e9&&customerId.length<=100&&p.length<=16&&(!status||statuses.includes(status)),422,'INVALID_RECONCILIATION_PAGE','Paginação ou filtro de conciliação inválido.');
  return {limit,offset,customerId,plate:p,status};
}
export async function jkReconciliationVehicles(db,url) {
  available(db);const q=pagination(url,['awaiting_review','promoted']);
  const where="FROM jk_reconciliation_vehicles v JOIN customers c ON c.id=v.customer_id WHERE (?='' OR v.customer_id=?) AND (?='' OR v.plate=?) AND (?='' OR v.status=?)",args=[q.customerId,q.customerId,q.plate,q.plate,q.status,q.status];
  const total=(await db.prepare(`SELECT COUNT(*) n ${where}`).get(...args)).n;
  const rows=await db.prepare(`SELECT v.*,c.name customer_name ${where} ORDER BY v.source_row,v.plate LIMIT ? OFFSET ?`).all(...args,q.limit,q.offset);
  return {mode:'documentary',sourceVerified:false,items:rows.map(row=>({vehicleRef:row.id,customerId:row.customer_id,customerName:row.customer_name,plate:row.plate,sourceRow:row.source_row,snapshotHash:row.snapshot_hash,sourceId:null,status:row.status,category:row.category,model:row.model,color:row.color,vehicleId:row.vehicle_id})),page:{limit:q.limit,offset:q.offset,total,hasMore:q.offset+rows.length<total}};
}
export async function jkReconciliationHistory(db,url) {
  available(db);const q=pagination(url,HISTORY_STATUSES);
  const where="FROM jk_reconciliation_history h JOIN jk_history_archive_rows r ON r.id=h.archive_row_id WHERE (?='' OR h.candidate_customer_id=?) AND (?='' OR upper(replace(replace(json_extract(r.values_json,'$[4]'),'-',''),' ',''))=?) AND (?='' OR h.status=?)",args=[q.customerId,q.customerId,q.plate,q.plate,q.status,q.status];
  const total=(await db.prepare(`SELECT COUNT(*) n ${where}`).get(...args)).n;
  const rows=await db.prepare(`SELECT h.*,r.source_row,r.source_number,r.values_json ${where} ORDER BY r.source_row LIMIT ? OFFSET ?`).all(...args,q.limit,q.offset);
  return {mode:'documentary',sourceVerified:false,headers:ARCHIVE_HEADERS.orders,items:rows.map(row=>({id:row.archive_row_id,sourceRow:row.source_row,sourceNumber:row.source_number,values:JSON.parse(row.values_json),proposal:{status:row.status,candidateCustomerId:row.candidate_customer_id,vehicleRef:row.vehicle_ref,sourceVerified:false}})),page:{limit:q.limit,offset:q.offset,total,hasMore:q.offset+rows.length<total}};
}

export async function handleJkReconciliation(ctx) {
  if(!ctx.pathname.startsWith(PATH+'/'))return null;
  const actor=requireRole(ctx.session,['admin']);
  if(ctx.method==='GET') {
    await requireLiveRole(ctx.db,ctx.session,['admin']);
    if(ctx.pathname===PATH+'/status')return {data:await jkReconciliationStatus(ctx.db)};
    if(ctx.pathname===PATH+'/vehicles')return {data:await jkReconciliationVehicles(ctx.db,ctx.url)};
    if(ctx.pathname===PATH+'/history')return {data:await jkReconciliationHistory(ctx.db,ctx.url)};
    return null;
  }
  if(ctx.method!=='POST'||![PATH+'/preview',PATH+'/commit'].includes(ctx.pathname))return null;
  verifyCsrf(ctx.request,ctx.session);available(ctx.db);
  const input=await readJson(ctx.request,MAX_IMPORT_BYTES),authorize=()=>requireLiveRole(ctx.db,ctx.session,['admin']);
  if(ctx.pathname===PATH+'/preview')return {data:await previewJkReconciliation(ctx.db,input,{authorize})};
  const key=ctx.request.headers['idempotency-key'];assert(typeof key==='string',400,'IDEMPOTENCY_KEY_REQUIRED','Envie Idempotency-Key.');
  const result=await commitJkReconciliation(ctx.db,input,{actorId:actor.id,idempotencyKey:key,authorize});
  return {status:result.replayed?200:201,data:result,...(result.replayed?{headers:{'Idempotency-Replayed':'true'}}:{})};
}
