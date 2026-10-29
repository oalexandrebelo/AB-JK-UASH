import test from 'node:test';
import assert from 'node:assert/strict';
import { createVercelHandler, deploymentConfiguration, vercelClientAddress } from '../server/vercel-runtime.mjs';

const env = {DATABASE_URL:'postgresql://ab_uash_app:test-only@db.example.test:6543/postgres', AB_UASH_SETUP_TOKEN:'test-only-installation-token-with-32-characters', NODEJS_HELPERS:'0', VERCEL_URL:'immutable.example.vercel.app', VERCEL_PROJECT_PRODUCTION_URL:'app.example.vercel.app'};
function response() {
  return {headers:{},headersSent:false,setHeader(k,v){this.headers[k]=v;},writeHead(status,headers){this.status=status;Object.assign(this.headers,headers);this.headersSent=true;},end(body){this.body=body;},destroy(){this.destroyed=true;}};
}
test('cloud refuses missing database or insecure bootstrap configuration without a SQLite fallback', async()=>{
  let calls=0;
  const handler=createVercelHandler({env:{},applicationFactory:()=>{calls++;}});
  const res=response(); await handler({headers:{}},res);
  assert.equal(calls,0);assert.equal(res.status,503);assert.equal(JSON.parse(res.body).error.code,'CONFIGURATION_REQUIRED');assert.equal(res.headers['Cache-Control'],'no-store');
  for(const overrides of [{DATABASE_URL:'sqlite:///tmp/local.db'},{DATABASE_URL:'postgresql://u:p@127.0.0.1/db'},{AB_UASH_SETUP_TOKEN:'weak'},{NODEJS_HELPERS:'1'},{PUBLIC_ORIGIN:'https://user:pass@host.example'},{DATABASE_SCHEMA:'public'},{VERCEL_URL:'evil.example/path'}])assert.throws(()=>deploymentConfiguration({...env,...overrides}),{code:'CONFIGURATION_REQUIRED'});
});
test('concurrent cold starts share one application and retain strict transport configuration',async()=>{
  let calls=0,options,release;
  const barrier=new Promise(resolve=>{release=resolve;});
  const handler=createVercelHandler({env,applicationFactory:async value=>{calls++;options=value;await barrier;return{handler:async(_req,res)=>{res.writeHead(200,{});res.end('ok');}};}});
  const responses=[response(),response(),response()];const pending=responses.map(res=>handler({headers:{}},res));
  await Promise.resolve();await Promise.resolve();release();await Promise.all(pending);
  assert.equal(calls,1);assert.equal(options.databasePoolSize,1);assert.equal(options.secureCookies,true);assert.equal(options.setupToken,env.AB_UASH_SETUP_TOKEN);
  assert.deepEqual(options.publicOrigin,['https://immutable.example.vercel.app','https://app.example.vercel.app']);assert.ok(responses.every(res=>res.status===200));
});
test('failed database initialization is sanitized and can recover without a permanently rejected cache',async()=>{
  let time=100,calls=0;const logs=[];
  const handler=createVercelHandler({env,now:()=>time,logger:{error:value=>logs.push(value)},applicationFactory:async()=>{if(++calls===1)throw new Error(env.DATABASE_URL);return{handler:async(_req,res)=>{res.writeHead(200,{});res.end('ok');}};}});
  const first=response(),second=response();await handler({headers:{}},first);await handler({headers:{}},second);
  assert.equal(calls,1);assert.equal(first.status,503);assert.equal(second.status,503);assert.ok(!JSON.stringify([logs,first.body]).includes('test-only'));
  time+=5001;const third=response();await handler({headers:{}},third);assert.equal(calls,2);assert.equal(third.status,200);
  assert.equal(vercelClientAddress({headers:{'x-vercel-forwarded-for':'203.0.113.9'}}),'203.0.113.9');
  assert.equal(vercelClientAddress({headers:{'x-forwarded-for':'203.0.113.9'}}),'unknown');
  assert.equal(vercelClientAddress({headers:{'x-vercel-forwarded-for':'1.1.1.1, 8.8.8.8'}}),'unknown');
});
