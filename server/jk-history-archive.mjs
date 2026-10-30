import {randomUUID} from 'node:crypto';
import {transaction,audit,idempotentWrite} from './db.mjs';
import {assert} from './errors.mjs';
import {requireRole,requireLiveRole,verifyCsrf} from './security.mjs';
import {readJson} from './http.mjs';
import {MAX_IMPORT_BYTES,hashObject} from './jk-migration-parse.mjs';
import {parseJkHistoryExport,archiveKind,ARCHIVE_HEADERS} from './jk-history-export-parse.mjs';

export function initializeJkHistoryArchive(raw) {
  transaction(raw,()=>raw.exec(`
    CREATE TABLE IF NOT EXISTS jk_history_archive_files (
      id TEXT PRIMARY KEY,kind TEXT NOT NULL UNIQUE CHECK(kind IN ('orders','customers','products')),
      snapshot_hash TEXT NOT NULL UNIQUE,content TEXT NOT NULL,preview_hash TEXT NOT NULL,report_json TEXT NOT NULL,
      actor_id TEXT REFERENCES users(id),committed_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS jk_history_archive_rows (
      id TEXT PRIMARY KEY,file_id TEXT NOT NULL REFERENCES jk_history_archive_files(id),
      source_row INTEGER NOT NULL,source_number TEXT,values_json TEXT NOT NULL,
      UNIQUE(file_id,source_row)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS jk_history_archive_file_rows ON jk_history_archive_rows(file_id,source_row);
  `));
}
function available(db){assert(db.mode==='local',501,'JK_ARCHIVE_LOCAL_ONLY','O arquivo documental está disponível somente no SQLite local.');}
async function prepare(db,input) {
  const parsed=parseJkHistoryExport(input);
  const existing=await db.prepare('SELECT id,snapshot_hash,preview_hash,report_json FROM jk_history_archive_files WHERE kind=?').get(parsed.kind);
  const replay=existing?.snapshot_hash===parsed.snapshotHash;
  const issues=existing&&!replay?[{code:'SNAPSHOT_RECONCILIATION_REQUIRED',message:'Outro arquivo deste tipo já foi preservado. Uma nova exportação exige reconciliação explícita.'}]:[];
  const report={status:issues.length?'REJECTED':'PREVIEW',mode:'documentary',kind:parsed.kind,sourceVerified:false,provenance:'snapshot-row',canCommit:!issues.length,snapshotHash:parsed.snapshotHash,counts:parsed.counts,totals:parsed.totals,dates:parsed.dates,issues,replayAvailable:Boolean(replay),previewHash:replay?existing.preview_hash:hashObject({snapshotHash:parsed.snapshotHash,existing:existing||null})};
  return {parsed,existing,report};
}
export async function previewJkHistoryArchive(db,input,{authorize}={}) {
  available(db);
  return db.read(async()=>{if(authorize)await authorize();return (await prepare(db,input)).report;});
}
export async function commitJkHistoryArchive(db,input,{actorId=null,idempotencyKey,authorize}={}) {
  available(db);
  assert(typeof input?.previewHash==='string'&&/^[a-f0-9]{64}$/u.test(input.previewHash),422,'PREVIEW_HASH_REQUIRED','Informe o hash da prévia revisada.');
  parseJkHistoryExport(input);
  const authorizeCommit=async()=>{
    if(authorize)await authorize();
    if(actorId!==null)assert(await db.prepare("SELECT id FROM users WHERE id=? AND active=1 AND role='admin'").get(actorId),403,'ADMIN_REQUIRED','O ator precisa ser um administrador ativo.');
  };
  const operation=async()=>{
    const {parsed,existing,report}=await prepare(db,input);
    assert(report.previewHash===input.previewHash,409,'PREVIEW_HASH_MISMATCH','O conteúdo ou arquivo preservado mudou. Gere uma nova prévia.');
    assert(report.canCommit,422,'ARCHIVE_REJECTED','A preservação contém pendências. Nenhum registro foi gravado.');
    if(report.replayAvailable)return {...JSON.parse(existing.report_json),status:'REPLAYED',replayed:true};
    const batchId=randomUUID(),committedAt=new Date().toISOString();
    const result={...report,status:'COMMITTED',canCommit:false,batchId,committedAt,replayed:false};
    await db.prepare('INSERT INTO jk_history_archive_files(id,kind,snapshot_hash,content,preview_hash,report_json,actor_id,committed_at) VALUES(?,?,?,?,?,?,?,?)').run(batchId,parsed.kind,parsed.snapshotHash,input.content,input.previewHash,JSON.stringify(result),actorId,committedAt);
    for(const row of parsed.rows)await db.prepare('INSERT INTO jk_history_archive_rows(id,file_id,source_row,source_number,values_json) VALUES(?,?,?,?,?)').run(row.id,batchId,row.sourceRow,row.sourceNumber,JSON.stringify(row.values));
    await audit(db,{actorId,action:'jk.history_archive.committed',resourceType:'jk_history_archive_file',resourceId:batchId,metadata:{kind:parsed.kind,snapshotHash:parsed.snapshotHash,rows:parsed.rows.length}});
    return result;
  };
  if(idempotencyKey!==undefined){
    assert(actorId,401,'AUTH_REQUIRED','A preservação exige um administrador autenticado.');
    const result=await idempotentWrite(db,{actorId,key:idempotencyKey,method:'POST',path:'/api/jk/history-archive/commit',body:input,authorize:authorizeCommit},operation);
    return result.replayed?{...result,status:'REPLAYED'}:result;
  }
  return transaction(db,async()=>{await authorizeCommit();return operation();});
}
export async function jkHistoryArchiveStatus(db,kind='orders') {
  kind=archiveKind(kind);
  if(db.mode!=='local')return {supported:false,mode:'documentary',kind,reason:'SQLITE_LOCAL_REQUIRED'};
  const row=await db.prepare('SELECT report_json FROM jk_history_archive_files WHERE kind=?').get(kind);
  if(!row)return {supported:true,mode:'documentary',kind,sourceVerified:false,counts:{rows:0,columns:ARCHIVE_HEADERS[kind].length,duplicateOrderNumbers:0},totals:null,dates:null,snapshotHash:null,committedAt:null};
  const {counts,totals,dates,snapshotHash,committedAt,batchId}=JSON.parse(row.report_json);
  return {supported:true,mode:'documentary',kind,sourceVerified:false,counts,totals,dates,snapshotHash,committedAt,batchId};
}
export async function jkHistoryArchiveRows(db,url) {
  available(db);const kind=archiveKind(url.searchParams.get('kind')||'orders');
  const limit=Number(url.searchParams.get('limit')||25),offset=Number(url.searchParams.get('offset')||0),q=url.searchParams.get('q')||'';
  assert(Number.isSafeInteger(limit)&&limit>=1&&limit<=500&&Number.isSafeInteger(offset)&&offset>=0&&offset<=1e9&&q.length<=200,422,'INVALID_ARCHIVE_PAGE','Paginação ou busca inválida.');
  // HTTP GET already runs inside the application's read-only snapshot.
  const where='FROM jk_history_archive_rows r JOIN jk_history_archive_files f ON f.id=r.file_id WHERE f.kind=? AND (?=\'\' OR EXISTS (SELECT 1 FROM json_each(r.values_json) cell WHERE instr(lower(CAST(cell.value AS TEXT)),lower(?))>0))';
  const total=(await db.prepare(`SELECT COUNT(*) AS n ${where}`).get(kind,q,q)).n;
  const rows=await db.prepare(`SELECT r.id,r.source_row,r.source_number,r.values_json ${where} ORDER BY r.source_row LIMIT ? OFFSET ?`).all(kind,q,q,limit,offset);
  return {mode:'documentary',kind,headers:ARCHIVE_HEADERS[kind],items:rows.map(row=>({id:row.id,sourceRow:row.source_row,sourceNumber:row.source_number,values:JSON.parse(row.values_json)})),page:{limit,offset,total,hasMore:offset+rows.length<total}};
}
export async function handleJkHistoryArchive(ctx) {
  if(!ctx.pathname.startsWith('/api/jk/history-archive/'))return null;
  const actor=requireRole(ctx.session,['admin']);
  if(ctx.method==='GET'){
    await requireLiveRole(ctx.db,ctx.session,['admin']);
    if(ctx.pathname==='/api/jk/history-archive/status')return {data:await jkHistoryArchiveStatus(ctx.db,ctx.url.searchParams.get('kind')||'orders')};
    if(ctx.pathname==='/api/jk/history-archive/rows')return {data:await jkHistoryArchiveRows(ctx.db,ctx.url)};
    return null;
  }
  if(ctx.method!=='POST'||!['/api/jk/history-archive/preview','/api/jk/history-archive/commit'].includes(ctx.pathname))return null;
  verifyCsrf(ctx.request,ctx.session);available(ctx.db);
  const input=await readJson(ctx.request,MAX_IMPORT_BYTES),authorize=()=>requireLiveRole(ctx.db,ctx.session,['admin']);
  if(ctx.pathname.endsWith('/preview'))return {data:await previewJkHistoryArchive(ctx.db,input,{authorize})};
  const key=ctx.request.headers['idempotency-key'];assert(typeof key==='string',400,'IDEMPOTENCY_KEY_REQUIRED','Envie Idempotency-Key.');
  const result=await commitJkHistoryArchive(ctx.db,input,{actorId:actor.id,idempotencyKey:key,authorize});
  return {status:result.replayed?200:201,data:result,...(result.replayed?{headers:{'Idempotency-Replayed':'true'}}:{})};
}
