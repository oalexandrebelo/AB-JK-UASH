import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../server/db.mjs';
import {createSnapshot,fileHash} from '../scripts/storage.mjs';

const execute = promisify(execFile);
test('backup online preserva WAL, destino existente e restauração revoga sessões sem alterar origem',async () => {
  const dir = await mkdtemp(join(tmpdir(),'ab-uash-storage-'));
  const source=join(dir,'source.sqlite'),copy=join(dir,'copy.sqlite'),restored=join(dir,'restored.sqlite');
  const db=openDatabase(source);
  try {
    db.exec("INSERT INTO users(id,name,email,password_hash,role,created_at,updated_at) VALUES('test-user','Usuário de teste','test@example.invalid','not-a-login-secret','admin','2026-10-20','2026-10-20')");
    db.exec("INSERT INTO sessions VALUES('fixture-session','test-user','fixture-csrf',1,9999999999999,1)");
    const result=await createSnapshot(source,copy);
    assert.equal(result.sha256,await fileHash(copy));
    assert.equal(result.sessionsRevoked,false);
    const snapshot=new DatabaseSync(copy,{readOnly:true});
    assert.equal(snapshot.prepare('SELECT count(*) AS n FROM users').get().n,1);
    assert.equal(snapshot.prepare('SELECT count(*) AS n FROM sessions').get().n,1); snapshot.close();
    await assert.rejects(createSnapshot(source,copy),/destino já existe/);
    await assert.rejects(createSnapshot(source,source),/diferentes/);
    await assert.rejects(createSnapshot(dir,join(dir,'directory.sqlite')),/arquivo regular/);
    const unrelated=join(dir,'unrelated.sqlite');
    const other=new DatabaseSync(unrelated);other.exec('CREATE TABLE unrelated(id INTEGER)');other.close();
    await assert.rejects(createSnapshot(unrelated,join(dir,'unknown-copy.sqlite')),/não reconhecido/);
    await execute(process.execPath,['scripts/restore.mjs','--from',copy,'--to',restored],{cwd:new URL('../',import.meta.url)});
    const after=new DatabaseSync(restored,{readOnly:true});
    assert.equal(after.prepare('SELECT count(*) AS n FROM sessions').get().n,0);
    assert.equal(after.prepare("SELECT count(*) AS n FROM audit_events WHERE action='system.restored'").get().n,1); after.close();
    assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n,1);
    const tampered=JSON.parse(await readFile(`${copy}.manifest.json`,'utf8'));tampered.sha256='0'.repeat(64);
    await writeFile(`${copy}.manifest.json`,JSON.stringify(tampered));
    await assert.rejects(execute(process.execPath,['scripts/restore.mjs','--from',copy,'--to',join(dir,'invalid.sqlite')],{cwd:new URL('../',import.meta.url)}),/não corresponde/);
  } finally {db.close();await rm(dir,{recursive:true,force:true});}
});

test('backup de versão futura pode ser preservado mas restauração incompatível não é publicada',async () => {
  const dir=await mkdtemp(join(tmpdir(),'ab-uash-storage-version-'));
  const source=join(dir,'future.sqlite'),copy=join(dir,'copy.sqlite'),restored=join(dir,'refused.sqlite');
  const db=openDatabase(source);
  try {
    db.exec('PRAGMA user_version=3');
    assert.equal((await createSnapshot(source,copy)).schemaVersion,3);
    await assert.rejects(
      execute(process.execPath,['scripts/restore.mjs','--from',copy,'--to',restored],{cwd:new URL('../',import.meta.url)}),
      /não é compatível/
    );
    await assert.rejects(lstat(restored),{code:'ENOENT'});
    await assert.rejects(lstat(`${restored}.manifest.json`),{code:'ENOENT'});
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,3);
  } finally {db.close();await rm(dir,{recursive:true,force:true});}
});
