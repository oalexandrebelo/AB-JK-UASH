import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createTestApplication,testDatabaseAdministrator} from './database-fixture.mjs';
import {openPostgresStore} from '../server/db.mjs';

const onlyPostgres = {skip:!process.env.AB_UASH_TEST_DATABASE_URL};
const credentials = {name:'Administrador PG',email:'postgres@example.test',password:'postgres-tests-password-2026'};
const deferred = () => {let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'ab-uash-postgres-'));
  const options={dbPath:join(directory,'logical-db'),databasePoolSize:1,logger:{error(error){throw new Error(JSON.stringify(error));}}};
  const applications=[];
  async function open(){
    const app=await createTestApplication(options);applications.push(app);
    const address=await app.listen({port:0}),base=`http://127.0.0.1:${address.port}`;let cookie='',csrf='';
    async function api(path,body,method=body===undefined?'GET':'POST'){
      const response=await fetch(base+path,{method,headers:{cookie,'x-csrf-token':csrf,'idempotency-key':randomUUID(),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
      const result=await response.json();if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];if(result.data?.csrfToken)csrf=result.data.csrfToken;
      return {status:response.status,...result};
    }
    return {app,store:app.store,api};
  }
  const first=await open();t.after(async()=>{for(const app of applications)await app.close();await rm(directory,{recursive:true,force:true});});
  return {...first,open};
}
const set=(db,key,value)=>db.prepare('INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,?)').run(key,value,new Date().toISOString());

test('PostgreSQL private runtime role has RLS access but cannot change schema or truncate',onlyPostgres,async t=>{
  const admin=await testDatabaseAdministrator();
  // These are local NOLOGIN fixture roles, never Supabase cloud accounts.
  await admin.query(`DO $roles$ DECLARE actor text; BEGIN
    PERFORM pg_advisory_xact_lock(-883021476559275377::bigint);
    FOREACH actor IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname=actor) THEN EXECUTE format('CREATE ROLE %I NOLOGIN',actor); END IF;
    END LOOP;
  END $roles$`);
  const f=await fixture(t),db=f.store;
  const role=await db.prepare('SELECT current_user AS name,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user').get();
  assert.deepEqual(role,{name:'ab_uash_app',rolsuper:0,rolcreatedb:0,rolcreaterole:0,rolbypassrls:0});
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM pg_tables WHERE schemaname=? AND NOT rowsecurity").get(db.schema)).n,0);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a WHERE n.nspname=? AND a.grantee=0").get(db.schema)).n,0);
  await assert.rejects(db.prepare('CREATE TABLE forbidden_table(id text)').run(),{code:'42501'});
  await assert.rejects(db.prepare('TRUNCATE users').run(),{code:'42501'});
  await assert.rejects(db.prepare('UPDATE app_schema_version SET version=2').run(),{code:'42501'});
  await assert.rejects(db.exec('CREATE TABLE forbidden_table(id text)'),/migrações/);
  assert.equal((await f.api('/api/setup',credentials)).status,201);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM users').get()).n,1);
  for(const actor of ['anon','authenticated','service_role']){
    const denied=(await admin.query(`SELECT has_schema_privilege($1,$2,'USAGE') AS schema_access,
      EXISTS(SELECT 1 FROM pg_tables WHERE schemaname=$2 AND has_table_privilege($1,format('%I.%I',schemaname,tablename),'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')) AS table_access`,[actor,db.schema])).rows[0];
    assert.deepEqual(denied,{schema_access:false,table_access:false});
    await admin.query('BEGIN');
    try{
      await admin.query(`SET LOCAL ROLE "${actor}"`);
      await assert.rejects(admin.query(`SELECT * FROM "${db.schema}".users`),{code:'42501'});
    }finally{await admin.query('ROLLBACK');}
  }
  await assert.rejects(openPostgresStore({databaseUrl:process.env.AB_UASH_TEST_DATABASE_URL,databaseSchema:db.schema}),/requer a conta ab_uash_app/);
});

test('PostgreSQL read snapshot stays consistent while an independent writer commits',onlyPostgres,async t=>{
  const f=await fixture(t),second=await f.open(),ready=deferred(),release=deferred();
  const reading=f.store.read(async()=>{
    const before=(await f.store.prepare('SELECT COUNT(*) n FROM app_settings').get()).n;ready.resolve();await release.promise;
    const after=(await f.store.prepare('SELECT COUNT(*) n FROM app_settings').get()).n;return {before,after};
  });
  await ready.promise;
  try{await set(second.store,'parallel','committed');}finally{release.resolve();}
  assert.deepEqual(await reading,{before:0,after:0});
  assert.equal((await f.store.prepare('SELECT COUNT(*) n FROM app_settings').get()).n,1);
});

test('PostgreSQL schema advisory lock times out and releases clients for later work',onlyPostgres,async t=>{
  const f=await fixture(t),second=await f.open(),ready=deferred(),release=deferred();
  const holding=f.store.transaction(async()=>{ready.resolve();await release.promise;});await ready.promise;
  const start=Date.now();
  try{await assert.rejects(second.store.transaction(()=>set(second.store,'blocked','no')),{code:'55P03'});assert.ok(Date.now()-start>=4000);}finally{release.resolve();await holding;}
  await set(second.store,'after-timeout','yes');
  assert.equal((await second.store.prepare('SELECT COUNT(*) n FROM app_settings').get()).n,1);
});

test('PostgreSQL order numbering and the last administrator are protected across instances',onlyPostgres,async t=>{
  const f=await fixture(t),second=await f.open();const setup=await f.api('/api/setup',credentials);assert.equal(setup.status,201);
  const other={name:'Segundo administrador',email:'second@example.test',password:'another-secure-password',role:'admin'};
  const created=await f.api('/api/users',other);assert.equal(created.status,201);
  assert.equal((await second.api('/api/auth/login',{email:other.email,password:other.password})).status,200);
  const customer=(await f.api('/api/customers',{name:'Cliente concorrente'})).data.item;
  const vehicle=(await f.api('/api/vehicles',{customerId:customer.id,plate:'PGT1A23',model:'Teste PG'})).data.item;
  const service=(await f.api('/api/services',{name:'Serviço concorrente',priceCents:1000})).data.item;
  const body={customerId:customer.id,vehicleId:vehicle.id,items:[{serviceId:service.id,quantity:1}]};
  const results=await Promise.all(Array.from({length:16},(_,i)=>(i%2?f:second).api('/api/orders',body)));
  assert.deepEqual(results.map(result=>result.status),Array(16).fill(201));
  assert.deepEqual(results.map(result=>result.data.item.number).sort((a,b)=>a-b),Array.from({length:16},(_,i)=>i+1));
  const changes=await Promise.all([f.api(`/api/users/${setup.data.user.id}`,{role:'viewer'},'PATCH'),second.api(`/api/users/${created.data.user.id}`,{role:'viewer'},'PATCH')]);
  assert.deepEqual(changes.map(result=>result.status).sort(),[200,409]);
  assert.equal(changes.find(result=>result.status===409).error.code,'LAST_ADMIN');
  assert.equal((await f.store.prepare("SELECT COUNT(*) n FROM users WHERE active=1 AND role='admin'").get()).n,1);
});
