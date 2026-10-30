import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createJkBookingRuntime} from '../server/jk-booking-runtime.mjs';

test('booking runtime is disabled unless deployment gates and private configuration are valid',async()=>{
 let calls=0;const gatewayFactory=async()=>{calls++;throw Error('must not construct');};
 for(const env of [{},{AB_JK_BOOKING_ENABLED:'true'},{AB_JK_BOOKING_ENABLED:'true',AB_JK_INTEGRATIONS_ENABLED:'true',AB_JK_ALLOW_PRODUCTION:'true',AB_JK_SECRETS_ROOT:'/nonexistent',AB_JK_BOOKING_SECRET_FILE:'secret'}]){
  const runtime=await createJkBookingRuntime({mode:'local'},{env,gatewayFactory});
  assert.equal(runtime.pix.enabled,false);assert.equal(runtime.otp.enabled,false);assert.equal(runtime.secret,null);
 }
 const pg=await createJkBookingRuntime({mode:'postgres'},{env:{AB_JK_BOOKING_ENABLED:'true'},gatewayFactory});assert.equal(pg.pix.enabled,false);assert.equal(calls,0);
});

test('runtime keeps the private stable secret and sends OTP only through a currently ready WhatsApp adapter',async t=>{
 const root=await mkdtemp(join(tmpdir(),'jk-booking-runtime-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'booking.secret'),Buffer.alloc(32,13),{mode:0o600});
 const entry={kind:'pix-asaas',environment:'production',apiKeyFile:'api.key',webhookTokenFile:'webhook.key',accountId:'11111111-2222-3333-4444-555555555555'};
 await writeFile(join(root,'config.json'),JSON.stringify({version:1,integrations:[entry]}),{mode:0o600});
 const sent=[];let refreshed=0;
 const integrations={refresh(){refreshed++;},channels:{whatsapp:{state:'blocked',environment:'production',provider:'whatsapp-baileys'}},adapters:new Map([['whatsapp',{async execute(...args){sent.push(args);return {state:'SUCCEEDED'};}}]])};
 const env={AB_JK_BOOKING_ENABLED:'true',AB_JK_INTEGRATIONS_ENABLED:'true',AB_JK_ALLOW_PRODUCTION:'true',AB_JK_SECRETS_ROOT:root,AB_JK_BOOKING_SECRET_FILE:'booking.secret',AB_JK_BOOKING_OTP_TEMPLATE:'jk_booking_otp',AB_JK_BOOKING_OTP_LANGUAGE:'pt_BR',AB_JK_INTEGRATIONS_CONFIG:'config.json'};
 let created=0;const gatewayFactory=async(db,config,options)=>{created++;assert.deepEqual(config,entry);assert.equal(options.secretsRoot,root);return {enabled:true};};
 const runtime=await createJkBookingRuntime({mode:'local'},{env,integrations,gatewayFactory,receiptRegistryReady:true});
 assert.deepEqual(runtime.secret,Buffer.alloc(32,13));assert.equal(created,1);assert.equal(runtime.otp.enabled,false);
 await assert.rejects(runtime.otp.send({phone:'+5511999991111',code:'123456',challengeId:'synthetic'}));assert.equal(sent.length,0);
 integrations.channels.whatsapp.state='ready';assert.equal(runtime.otp.enabled,true);
 assert.deepEqual(await runtime.otp.send({phone:'+5511999991111',code:'123456',challengeId:'synthetic'}),{accepted:true});
 assert.equal(sent[0][0],'send-template');assert.equal(sent[0][1].to,'5511999991111');assert.deepEqual(sent[0][1].bodyParameters,['123456']);assert.equal(sent[0][2].idempotencyKey,'jk-booking-otp:synthetic');assert.ok(refreshed>0);
 integrations.channels.whatsapp.environment='homologation';assert.equal(runtime.otp.enabled,false);
 integrations.channels.whatsapp.environment='production';integrations.channels.whatsapp.provider='whatsapp-cloud';assert.equal(runtime.otp.enabled,false);
 integrations.adapters.clear();assert.equal(runtime.otp.enabled,false);
});
