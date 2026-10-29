import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,cp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createTestApplication} from './database-fixture.mjs';
import {postgresSql,postgresConnectionOptions} from '../server/db.mjs';
import {toPublicError} from '../server/errors.mjs';
import {normalizePublicOrigins,validateRequestOrigin} from '../server/http.mjs';

const credentials = {name:'Administrador teste',email:'store@example.test',password:'store-tests-password-2026'};
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(),'ab-uash-store-'));
  const settings = {dbPath:join(directory,'store.sqlite'),logger:{error(value){throw new Error(JSON.stringify(value));}},...options};
  const apps = [];
  async function open() {
    const app = await createTestApplication(settings); apps.push(app);
    const address = await app.listen({port:0}); const base = `http://127.0.0.1:${address.port}`;
    const session = {cookie:'',csrf:''};
    async function api(path,body,extra={}) {
      const result = await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{cookie:session.cookie,'x-csrf-token':session.csrf,'idempotency-key':randomUUID(),...(body===undefined?{}:{'content-type':'application/json'}),...extra.headers},...(body===undefined?{}:{body:JSON.stringify(body)}),...extra});
      const json = await result.json();
      if(result.headers.get('set-cookie'))session.cookie=result.headers.get('set-cookie').split(';')[0];
      if(json.data?.csrfToken)session.csrf=json.data.csrfToken;
      return {status:result.status,...json};
    }
    return {app,store:app.store,base,api,session};
  }
  t.after(async()=>{for(const app of apps)await app.close();await rm(directory,{recursive:true,force:true});});
  return {...await open(),open,settings};
}
const set = (store,key,value) => store.prepare('INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,?)').run(key,value,new Date().toISOString());
const deferred = () => {let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};

test('store async rolls back awaited, queued and caught query failures, then recovers', async t => {
  const {store} = await fixture(t);
  await assert.rejects(store.transaction(async()=>{
    await set(store,'rollback','one'); await Promise.resolve(); throw new Error('rollback fixture');
  }),/rollback fixture/);
  assert.equal(await store.prepare("SELECT * FROM app_settings WHERE key='rollback'").get(),undefined);
  await assert.rejects(store.transaction(async()=>{
    const results = await Promise.allSettled([set(store,'duplicate','one'),set(store,'duplicate','two'),set(store,'after-error','three')]);
    assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');assert.equal(results[2].status,'rejected');
  }));
  assert.equal((await store.prepare('SELECT COUNT(*) n FROM app_settings').get()).n,0);
  await assert.rejects(store.transaction(async()=>{
    await set(store,'before-invalid-parameter','one');
    await assert.rejects(store.prepare('SELECT ? AS value').get(Number.MAX_SAFE_INTEGER+1),{code:'AMOUNT_LIMIT'});
  }),{code:'AMOUNT_LIMIT'});
  assert.equal((await store.prepare('SELECT COUNT(*) n FROM app_settings').get()).n,0);
  await store.transaction(async()=>{await Promise.all(Array.from({length:20},(_,i)=>set(store,`queued-${i}`,String(i))));});
  assert.equal((await store.prepare('SELECT COUNT(*) n FROM app_settings').get()).n,20);
});

test('concurrent store close drains work once and refuses shutdown inside its own transaction', async t => {
  const f=await fixture(t),ready=deferred(),release=deferred();
  await assert.rejects(f.store.transaction(()=>f.store.close()),/durante uma transação/);
  const pending=f.store.transaction(async()=>{
    await set(f.store,'before-close','yes');ready.resolve();await release.promise;
    await set(f.store,'during-close','yes');
  });
  await ready.promise;
  const first=f.store.close(),second=f.store.close();
  assert.equal(first,second);
  await assert.rejects(f.store.prepare('SELECT 1 AS n').get(),/encerrado/);
  release.resolve();
  await Promise.all([pending,first,second]);
  const reopened=await f.open();
  assert.equal((await reopened.store.prepare('SELECT COUNT(*) n FROM app_settings').get()).n,2);
});

test('application close drains direct serverless requests between transactions and is shared', async t => {
  const ready=deferred(),release=deferred();
  const f=await fixture(t,{domainHandler:async ctx=>{
    if(ctx.pathname!=='/api/shutdown-fixture')return null;
    ready.resolve();await release.promise;
    await ctx.db.transaction(()=>set(ctx.db,'serverless-drained','yes'));
    return {data:{complete:true}};
  }});
  assert.equal((await f.api('/api/setup',credentials)).status,201);
  await new Promise((resolve,reject)=>f.app.server.close(error=>error?reject(error):resolve()));
  const response={headers:{},setHeader(key,value){this.headers[key]=value;},writeHead(status,headers){this.status=status;Object.assign(this.headers,headers);this.headersSent=true;},end(body){this.body=JSON.parse(body);},destroy(){throw new Error('Unexpected response destruction');}};
  const request={method:'POST',url:'/api/shutdown-fixture',headers:{host:'127.0.0.1:4173',cookie:f.session.cookie,'x-csrf-token':f.session.csrf}};
  const pending=f.app.handler(request,response);
  await ready.promise;
  const first=f.app.close(),second=f.app.close();assert.equal(first,second);
  release.resolve();
  await Promise.all([pending,first,second]);
  assert.equal(response.status,200);assert.equal(response.body.data.complete,true);
  const reopened=await f.open();
  assert.equal((await reopened.store.prepare("SELECT value_json FROM app_settings WHERE key='serverless-drained'").get()).value_json,'yes');
});

test('internal error responses and logs omit raw messages and sensitive driver details', async t => {
  const logs=[],marker='private@example.invalid/credential-fixture';
  const f=await fixture(t,{logger:{error:value=>logs.push(value)},domainHandler:async()=>{throw Object.assign(new Error(marker),{code:marker,detail:marker});}});
  const result=await f.api('/api/error-fixture');
  assert.equal(result.status,500);assert.equal(result.error.code,'INTERNAL_ERROR');
  assert.equal(logs.length,1);assert.deepEqual(Object.keys(logs[0]).sort(),['code','requestId']);
  assert.equal(JSON.stringify({result,logs}).includes(marker),false);
  assert.equal((await f.api('/api/health')).status,200);
});

test('transaction contexts reject delayed use and nested transactions without poisoning later work', async t => {
  const {store} = await fixture(t); let late;
  await store.transaction(async()=>{
    await assert.rejects(store.transaction(async()=>{}),/aninhadas/);
    late = new Promise(resolve=>setTimeout(()=>store.prepare('SELECT 1 AS n').get().then(()=>resolve(null),resolve),10));
    await set(store,'committed','yes');
  });
  assert.match((await late).message,/encerrado/);
  assert.equal((await store.prepare("SELECT * FROM app_settings WHERE key='committed'").get()).value_json,'yes');
  await assert.rejects(store.read(()=>set(store,'read-only','no')),/Escritas/);
  await assert.rejects(store.read(()=>store.prepare("INSERT INTO app_settings(key,value_json,updated_at) VALUES('hidden-write','no','now') RETURNING key").get()));
  await set(store,'recovered','yes');
});

test('safe integer parsing preserves booleans and rejects oversized totals without rounding', async t => {
  const {store} = await fixture(t);
  assert.equal((await store.prepare('SELECT CAST(? AS BIGINT) AS value').get('9007199254740991')).value,Number.MAX_SAFE_INTEGER);
  await assert.rejects(store.prepare('SELECT CAST(? AS BIGINT) AS value').get('9007199254740992'),{code:'AMOUNT_LIMIT'});
  const statement = store.prepare('SELECT CAST(? AS BIGINT) AS value'); statement.setReadBigInts(true);
  assert.equal((await statement.get('9007199254740993')).value,9007199254740993n);
  assert.deepEqual(await store.prepare('SELECT 1=1 AS yes,1=0 AS no').get(),{yes:1,no:0});
  await assert.rejects(store.prepare('SELECT ? AS value').get(Number.MAX_SAFE_INTEGER+1),{code:'AMOUNT_LIMIT'});
  if(store.mode==='postgres')await assert.rejects(store.prepare('SELECT SUM(n) AS value FROM (VALUES (9007199254740991::bigint),(2::bigint)) x(n)').get(),{code:'AMOUNT_LIMIT'});
});

test('bootstrap and persistent rate reservations serialize across independent applications', async t => {
  const f = await fixture(t);const second = await f.open();
  const outcomes = await Promise.all([f.api('/api/setup',credentials),second.api('/api/setup',{...credentials,email:'other@example.test'})]);
  assert.deepEqual(outcomes.map(result=>result.status).sort(),[201,409]);
  assert.equal((await f.store.prepare('SELECT COUNT(*) n FROM users').get()).n,1);
  const requests = Array.from({length:13},(_,i)=>(i%2?f:second).api('/api/auth/login',{email:credentials.email,password:'wrong-password'}));
  const failed = await Promise.all(requests);
  assert.equal(failed.filter(result=>result.status===401).length,12);
  assert.equal(failed.filter(result=>result.status===429).length,1);
  const third = await f.open();
  assert.equal((await third.api('/api/auth/login',{email:credentials.email,password:'wrong-password'})).status,429);
});

test('opening another SQLite instance waits asynchronously for an active migration queue', {skip:Boolean(process.env.AB_UASH_TEST_DATABASE_URL)}, async t => {
  const f = await fixture(t);let ready;const started=new Promise(resolve=>{ready=resolve;});
  const holding=f.store.transaction(async()=>{await set(f.store,'startup-lock','yes');ready();await new Promise(resolve=>setTimeout(resolve,50));});
  await started;const second=await f.open();await holding;
  assert.equal((await second.store.prepare("SELECT value_json FROM app_settings WHERE key='startup-lock'").get()).value_json,'yes');
});

test('setup token gates bootstrap and session responses identify storage consistently', async t => {
  const token='setup-token-test-'.repeat(3);const f=await fixture(t,{setupToken:token});
  const status=await f.api('/api/status');assert.equal(status.data.setupTokenRequired,true);assert.equal(status.data.storageMode,f.store.mode);
  assert.equal((await f.api('/api/setup',credentials)).error.code,'SETUP_TOKEN_REQUIRED');
  assert.equal((await f.api('/api/setup',credentials,{headers:{'content-type':'application/json','x-setup-token':'x'.repeat(48)}})).status,403);
  const created=await f.api('/api/setup',credentials,{headers:{'content-type':'application/json','x-setup-token':token}});assert.equal(created.status,201);assert.equal(created.data.setupTokenRequired,false);assert.equal(created.data.storageMode,f.store.mode);
  assert.equal((await f.api('/api/auth/session')).data.setupTokenRequired,false);
  assert.equal((await f.api('/api/auth/login',{email:credentials.email,password:credentials.password})).data.storageMode,f.store.mode);
  const all = JSON.stringify(await f.store.prepare('SELECT * FROM audit_events').all());assert.equal(all.includes(token),false);
});

test('origin lists bind each exact Origin to its Host and reject wildcards or URL paths',()=>{
  const origins=normalizePublicOrigins(['https://one.example','https://two.example:8443']);const server={address:()=>null};
  assert.doesNotThrow(()=>validateRequestOrigin({headers:{host:'one.example',origin:'https://one.example'}},server,origins));
  assert.doesNotThrow(()=>validateRequestOrigin({headers:{host:'two.example:8443',origin:'https://two.example:8443'}},server,origins));
  for(const headers of [{host:'one.example',origin:'https://two.example:8443'},{host:'one.example.evil',origin:'https://one.example'},{host:'one.example',origin:'https://one.example/'},{host:'127.0.0.1:4173'}])assert.throws(()=>validateRequestOrigin({headers},server,origins));
  for(const origin of ['https://*.example','https://one.example/path','https://user:password@one.example','https://one.example?x=1'])assert.throws(()=>normalizePublicOrigins(origin));
});

test('database lock timeouts surface as temporary 503 errors without exposing database details',()=>{
  for(const error of [{code:'55P03',message:'private query'}, {code:'57014'}, {code:'ERR_SQLITE_ERROR',errcode:5}]){
    const result=toPublicError(error,'request-test');assert.equal(result.status,503);assert.equal(result.body.error.code,'DATABASE_BUSY');assert.equal(JSON.stringify(result).includes('private query'),false);
  }
});

test('SQL placeholder scanner leaves strings, comments and dollar quotes intact',()=>{
  const sql=`SELECT '?',"?",$$?$$,$tag$?$tag$,E'\\\'?',? -- ?\n/* ? /* ? */ ? */ WHERE id=? AND note LIKE '?'`;
  assert.equal(postgresSql(sql,2),`SELECT '?',"?",$$?$$,$tag$?$tag$,E'\\\'?',$1 -- ?\n/* ? /* ? */ ? */ WHERE id=$2 AND note ILIKE '?'`);
  assert.throws(()=>postgresSql('SELECT ?',0),/parâmetros/);assert.throws(()=>postgresSql("SELECT 'unterminated"),/encerrado/);
});

test('PostgreSQL connection options bind TLS to the effective host and preserve CA validation',async()=>{
  const {Client}=await import('pg');
  const databaseUrl='postgresql://ab_uash_app:test-fixture@database.example.test/app?ssl=no-verify&sslmode=disable&uselibpqcompat=true&sslnegotiation=direct';
  const config=postgresConnectionOptions({databaseUrl,databaseCa:'test-ca'});
  const effective=new Client(config).connectionParameters;
  assert.equal(effective.host,'database.example.test');
  assert.equal(effective.sslnegotiation,'direct');
  assert.deepEqual(effective.ssl,{rejectUnauthorized:true,minVersion:'TLSv1.2',ca:'test-ca'});
  assert.equal(Object.hasOwn(config,'connectionString'),false);
  for(const key of ['host','hostaddr','port','user','password','database']){
    assert.throws(()=>postgresConnectionOptions({databaseUrl:`postgresql://ab_uash_app:test-fixture@localhost/app?${key}=remote.example.test`}),/não permite substituir/);
  }
  const loopback=postgresConnectionOptions({databaseUrl:'postgresql://ab_uash_app@127.0.0.1:55433/postgres'});
  assert.equal(new Client(loopback).connectionParameters.ssl,false);
  assert.equal(new Client(postgresConnectionOptions({databaseUrl:'postgresql://ab_uash_app@localhost/app',databaseCa:'local-ca'})).connectionParameters.ssl.rejectUnauthorized,true);
  for(const databaseUrl of ['postgres://ab_uash_app@/app','postgresql://ab_uash_app@%2Ftmp/app','postgresql://ab_uash_app@host/app#private']){
    assert.throws(()=>postgresConnectionOptions({databaseUrl}));
  }
});

test('SQLite application imports and runs without node_modules',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'ab-uash-no-deps-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await cp(new URL('../server/',import.meta.url),join(dir,'server'),{recursive:true});
  await cp(new URL('../integrations/',import.meta.url),join(dir,'integrations'),{recursive:true});
  await writeFile(join(dir,'check.mjs'),"import {createApplication} from './server/application.mjs'; const app=await createApplication({dbPath:':memory:'}); console.log(app.store.mode,(await app.store.prepare('SELECT count(*) n FROM users').get()).n);await app.close();");
  const result=spawnSync(process.execPath,[join(dir,'check.mjs')],{encoding:'utf8',cwd:dir});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/local 0/);
});
