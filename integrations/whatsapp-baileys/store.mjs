import { DatabaseSync } from 'node:sqlite';
import { constants } from 'node:fs';
import { mkdir, lstat, realpath, open, unlink } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const repository = fileURLToPath(new URL('../../',import.meta.url));
const applicationId=0x41424a57;
const hash = value => createHash('sha256').update(value).digest('hex');
const inside = (root,path) => { const name=relative(root,path); return !name || (!name.startsWith('..') && !isAbsolute(name)); };
function privateInfo(info,directory=false) {
  if (info.isSymbolicLink()) throw new Error('BAILEYS_AUTH_SYMLINK_FORBIDDEN');
  if ((directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
    || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error('BAILEYS_AUTH_PERMISSIONS');
}

/** Single-process store. Credentials, signal keys and dispatch claims stay outside every Git repository. */
export async function openBaileysStore(authDir,accountPhone) {
  if (typeof authDir !== 'string' || !isAbsolute(authDir) || authDir.includes('\0')) throw new Error('BAILEYS_AUTH_ABSOLUTE_PATH_REQUIRED');
  if (inside(repository,resolve(authDir))) throw new Error('BAILEYS_AUTH_OUTSIDE_REPOSITORY_REQUIRED');
  const existing=await lstat(authDir).catch(error=>{if(error.code!=='ENOENT')throw error;});
  if(existing) privateInfo(existing,true);
  await mkdir(authDir,{recursive:true,mode:0o700});
  const directory=await realpath(authDir);
  if (inside(await realpath(repository),directory)) throw new Error('BAILEYS_AUTH_OUTSIDE_REPOSITORY_REQUIRED');
  for(let path=directory;path!==dirname(path);path=dirname(path)) {
    if(await lstat(join(path,'.git')).catch(error=>{if(error.code!=='ENOENT')throw error;})) throw new Error('BAILEYS_AUTH_OUTSIDE_REPOSITORY_REQUIRED');
  }
  privateInfo(await lstat(directory),true);
  const file=join(directory,'session.sqlite');
  const fileInfo=await lstat(file).catch(error=>{if(error.code!=='ENOENT')throw error;});
  if(fileInfo) privateInfo(fileInfo);
  for(const suffix of ['-journal','-wal','-shm']) {
    const info=await lstat(`${file}${suffix}`).catch(error=>{if(error.code!=='ENOENT')throw error;});
    if(info)privateInfo(info);
  }
  const lockFile=join(directory,'session.lock');
  const lock=await open(lockFile,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
    .catch(error=>{if(error.code==='EEXIST')throw new Error('BAILEYS_SESSION_IN_USE');throw error;});
  let db;
  try {
    await lock.writeFile(JSON.stringify({pid:process.pid,createdAt:new Date().toISOString()}));
    await lock.sync();
    if(!fileInfo) { const handle=await open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600); await handle.close(); }
    db=new DatabaseSync(file);
    if(fileInfo?.size>0 && (db.prepare('PRAGMA application_id').get().application_id!==applicationId || db.prepare('PRAGMA user_version').get().user_version!==1))throw new Error('BAILEYS_AUTH_DATABASE_UNRECOGNIZED');
    db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      PRAGMA application_id=${applicationId}; PRAGMA user_version=1;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auth (type TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(type,id));
      CREATE TABLE IF NOT EXISTS dispatch (id TEXT PRIMARY KEY,digest TEXT NOT NULL,message_id TEXT NOT NULL,result TEXT);`);
    const owner=db.prepare("SELECT value FROM metadata WHERE key='account'").get();
    if(owner && owner.value!==accountPhone)throw new Error('BAILEYS_AUTH_ACCOUNT_MISMATCH');
    db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES('account',?)").run(accountPhone);
    let closed=false;
    return {
      auth(sdk) {
        const read=(type,id)=>{const row=db.prepare('SELECT value FROM auth WHERE type=? AND id=?').get(type,id);return row ? JSON.parse(row.value,sdk.BufferJSON.reviver) : undefined;};
        const write=(type,id,value)=>db.prepare('INSERT INTO auth(type,id,value) VALUES(?,?,?) ON CONFLICT(type,id) DO UPDATE SET value=excluded.value').run(type,id,JSON.stringify(value,sdk.BufferJSON.replacer));
        const creds=read('credentials','current') ?? sdk.initAuthCreds();
        return {state:{creds,keys:{
          async get(type,ids){const found={};for(const id of ids){let value=read(type,id);if(value!==undefined){if(type==='app-state-sync-key')value=sdk.proto.Message.AppStateSyncKeyData.fromObject(value);found[id]=value;}}return found;},
          async set(data){db.exec('BEGIN IMMEDIATE');try{for(const [type,items] of Object.entries(data))for(const [id,value] of Object.entries(items)){if(value==null)db.prepare('DELETE FROM auth WHERE type=? AND id=?').run(type,id);else write(type,id,value);}db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}},
        }},saveCreds:async()=>write('credentials','current',creds)};
      },
      claim(key,digest,messageId) {
        const id=hash(key);
        const changed=db.prepare('INSERT OR IGNORE INTO dispatch(id,digest,message_id,result) VALUES(?,?,?,NULL)').run(id,digest,messageId).changes;
        return {claimed:changed===1,...db.prepare('SELECT digest,message_id,result FROM dispatch WHERE id=?').get(id)};
      },
      finish(key,result){db.prepare('UPDATE dispatch SET result=? WHERE id=?').run(JSON.stringify(result),hash(key));},
      async close(){if(closed)return;closed=true;try{db.close();}finally{await lock.close();await unlink(lockFile);}},
    };
  } catch(error) { db?.close();await lock.close();await unlink(lockFile);throw error; }
}
