import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {validateRehearsalConfig, prepareRehearsal, inspectRehearsal, openRehearsal, runRehearsalSmoke} from '../scripts/jk-rehearsal.mjs';

const env = {JK_REHEARSAL_MODE:'isolated'};
async function directory(t) {
  const parent=await mkdtemp(join(tmpdir(),'jk-rehearsal-test-'));
  t.after(()=>rm(parent,{recursive:true,force:true}));
  return join(parent,'jk-rehearsal-weekend');
}

test('rehearsal refuses inherited deployment settings and production paths before writing', async t=>{
  const dir=await directory(t);
  assert.throws(()=>validateRehearsalConfig({directory:dir,env:{}}),/JK_REHEARSAL_MODE/);
  for(const key of ['DATABASE_URL','DB_PATH','PUBLIC_ORIGIN','HOST','SETUP_TOKEN_FILE','AB_JK_INTEGRATIONS_CONFIG','AB_JK_BAILEYS_SEND_ENABLED','AB_UASH_FISCAL_ENABLED']) {
    assert.throws(()=>validateRehearsalConfig({directory:dir,env:{...env,[key]:'production-value-must-not-be-printed'}}),error=>error.message.includes(key)&&!error.message.includes('production-value'));
  }
  for(const path of ['/data/jk-rehearsal-weekend','/srv/jk-rehearsal-weekend',process.cwd()+'/jk-rehearsal-weekend','https://ab-pcsrv.tail6bac78.ts.net:9220','/private/tmp/production']) {
    assert.throws(()=>validateRehearsalConfig({directory:path,env}));
  }
  for(const port of [9220,-1,65536,'abc']) assert.throws(()=>validateRehearsalConfig({directory:dir,port,env}));
  assert.equal(validateRehearsalConfig({directory:dir,port:4179,env}).host,'127.0.0.1');
});

test('prepare creates a private new identity and rejects overwrite or redirected databases', async t=>{
  const dir=await directory(t);
  const prepared=await prepareRehearsal({directory:dir,env});
  assert.equal(prepared.operationMode,'parallel_readonly');
  assert.equal(prepared.testIdentity.email,'ensaio-jk@example.test');
  assert.match(prepared.dbPath,/jk-rehearsal\.sqlite$/);
  assert.equal((await stat(dir)).mode&0o777,0o700);
  assert.equal((await stat(prepared.dbPath)).mode&0o777,0o600);
  assert.equal((await stat(join(dir,'access.json'))).mode&0o777,0o600);
  await assert.rejects(prepareRehearsal({directory:dir,env}),/existe|EEXIST/);
  const inspected=await inspectRehearsal({directory:dir,env});
  assert.equal(inspected.counts.users,1);assert.equal(inspected.counts.customers,0);
  assert.equal(inspected.externalProviders,'disabled');assert.equal(inspected.integrity,'ok');
  const alternate=join(dir,'other.sqlite');
  await writeFile(alternate,'must stay untouched');
  await rm(prepared.dbPath);await symlink(alternate,prepared.dbPath);
  await assert.rejects(inspectRehearsal({directory:dir,env}),/regular|simbólico/);
  assert.equal(await readFile(alternate,'utf8'),'must stay untouched');
});

test('start preserves readonly by default and uses an exclusive lock',async t=>{
  const dir=await directory(t);await prepareRehearsal({directory:dir,env});
  const runtime=await openRehearsal({directory:dir,env,port:0});
  try {
    assert.match(runtime.url,/^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(runtime.operationMode,'parallel_readonly');
    await assert.rejects(openRehearsal({directory:dir,env,port:0}),/uso|lock/);
    const readiness=await runtime.call('/jk/integrations/readiness');
    for(const key of ['pix','whatsapp','fiscal']) assert.equal(readiness.data[key].state,'blocked');
    const denied=await runtime.call('/customers',{method:'POST',body:{name:'ENSAIO BLOQUEADO'},status:409});
    assert.equal(denied.error.code,'PARALLEL_READONLY');
  } finally {await runtime.close();}
  assert.equal((await inspectRehearsal({directory:dir,env})).counts.customers,0);
});

test('isolated HTTP journey completes once, restores a backup and revokes sessions',async t=>{
  const dir=await directory(t);await prepareRehearsal({directory:dir,env});
  const result=await runRehearsalSmoke({directory:dir,env});
  assert.equal(result.ok,true);assert.equal(result.orderStatus,'delivered');
  assert.equal(result.paidCents,2500);assert.equal(result.cashDifferenceCents,0);
  assert.equal(result.paymentCount,1);assert.equal(result.noExternalEffects,true);
  assert.equal(result.recovery.sourceSessions,1);assert.equal(result.recovery.sessionsRevoked,true);assert.equal(result.recovery.loginRequired,true);
  assert.equal(result.operationMode,'parallel_readonly');
  const inspected=await inspectRehearsal({directory:dir,env});
  assert.equal(inspected.counts.orders,1);assert.equal(inspected.counts.messages,0);assert.equal(inspected.counts.payments,1);
  await assert.rejects(runRehearsalSmoke({directory:dir,env}),/vazio|já|novo/);
  const restored=new DatabaseSync(result.recovery.dbPath,{readOnly:true});
  try {
    assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,0);
    assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM orders WHERE status='delivered'").get().n,1);
    assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='system.restored'").get().n,1);
  } finally {restored.close();}
});
