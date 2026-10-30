import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, sqliteStore } from '../server/db.mjs';
import { migrateDomain, migrateStorage } from '../server/domain-schema.mjs';
import { migrateJkIntegrations } from '../server/jk-integrations.mjs';
import { createJkRuntime, jkReadiness, parseJkConfiguration } from '../integrations/jk/runtime.mjs';

const accountId='11111111-2222-4333-8444-555555555555';
const asaas={kind:'pix-asaas',environment:'homologation',accountId,apiKeyFile:'api-key',webhookTokenFile:'webhook-token',dateTimeOffset:'-03:00'};
async function fixture(t,entries,{migrate=true,...overrides}={}) {
  const directory=await mkdtemp(join(tmpdir(),'jk-provider-runtime-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  await writeFile(join(directory,'config.json'),JSON.stringify({version:1,integrations:entries}),{mode:0o600});
  await writeFile(join(directory,'api-key'),'fixture-only-api-key',{mode:0o600});
  await writeFile(join(directory,'webhook-token'),'fixture-only-webhook-token-more-than-32-characters',{mode:0o600});
  await writeFile(join(directory,'templates.json'),JSON.stringify([{templateName:'os_ready',languageCode:'pt_BR',text:'OS {{1}} pronta.'}]),{mode:0o600});
  const raw=openDatabase(':memory:');migrateDomain(raw);migrateStorage(raw);if(migrate)migrateJkIntegrations(raw);
  const db=sqliteStore(raw);t.after(()=>db.close());
  const env={AB_JK_SECRETS_ROOT:directory,AB_JK_INTEGRATIONS_CONFIG:'config.json',...overrides};
  return {directory,raw,db,env};
}

test('JK configuration accepts exactly one Pix and one WhatsApp provider with provider-specific fields',()=>{
  const baileys={kind:'whatsapp-baileys',environment:'production',accountPhone:'5511999999999',authDir:'/private/tmp/fixture-auth',templatesFile:'templates.json'};
  assert.deepEqual(parseJkConfiguration({version:1,integrations:[asaas,baileys]}).integrations,[asaas,baileys]);
  for(const entries of [[asaas,{...asaas}],[baileys,{kind:'whatsapp-cloud',environment:'production',phoneNumberId:'123',graphVersion:'v23.0',accessTokenFile:'token'}],
    [{...asaas,apiKey:'inline-secret'}],[{...baileys,environment:'homologation'}],[{...baileys,authDir:'relative/path'}]])
    assert.throws(()=>parseJkConfiguration({version:1,integrations:entries}));
});

test('Asaas startup reads credentials but does not dispatch; missing explicit enablement keeps submit blocked',async t=>{
  const f=await fixture(t,[asaas]);const runtime=await createJkRuntime(f.db,{env:f.env});t.after(()=>runtime.close());
  const readiness=jkReadiness(runtime);assert.equal(readiness.pix.configured,true);assert.equal(readiness.pix.state,'blocked');assert.equal(readiness.pix.homologated,false);
  assert.ok(readiness.pix.blockers.includes('EXTERNAL_EFFECTS_DISABLED'));assert.equal(runtime.adapters.has('pix'),false);
});

test('webhook additive schema is explicitly migrated and checked before Asaas readiness',async t=>{
  const f=await fixture(t,[asaas],{AB_JK_INTEGRATIONS_ENABLED:'true'});f.raw.exec('DROP TABLE jk_asaas_webhook_events');
  const runtime=await createJkRuntime(f.db,{env:f.env});t.after(()=>runtime.close());
  assert.equal(runtime.channels.pix.state,'blocked');assert.ok(runtime.channels.pix.blockers.includes('ASAAS_WEBHOOK_STORAGE_UNAVAILABLE'));
});

test('Baileys connection and send gates block startup before opening a session',async t=>{
  const f=await fixture(t,[]);const entry={kind:'whatsapp-baileys',environment:'production',accountPhone:'5511999999999',authDir:join(f.directory,'auth'),templatesFile:'templates.json'};
  await writeFile(join(f.directory,'config.json'),JSON.stringify({version:1,integrations:[entry]}),{mode:0o600});let calls=0;
  const runtime=await createJkRuntime(f.db,{env:f.env,baileysAdapterFactory:async()=>{calls++;throw new Error('must not construct');}});t.after(()=>runtime.close());
  assert.equal(runtime.channels.whatsapp.configured,true);assert.equal(jkReadiness(runtime).whatsapp.state,'blocked');assert.equal(calls,0);
});

test('Baileys readiness follows live pairing state, closes once, and never claims verified delivery',async t=>{
  const f=await fixture(t,[],{AB_JK_INTEGRATIONS_ENABLED:'true',AB_JK_ALLOW_PRODUCTION:'true',AB_JK_BAILEYS_CONNECT_ENABLED:'true',AB_JK_BAILEYS_SEND_ENABLED:'true'});
  const entry={kind:'whatsapp-baileys',environment:'production',accountPhone:'5511999999999',authDir:join(f.directory,'auth'),templatesFile:'templates.json'};
  await writeFile(join(f.directory,'config.json'),JSON.stringify({version:1,integrations:[entry]}),{mode:0o600});
  let connected=false,sendEnabled=true,closed=0,connects=0;const fake={accountScope:'fixture-account-scope',async connect(){connects++;},status(){return {connection:connected?'connected':'connecting',connectionVerified:connected,sendEnabled,qrAvailable:!connected,deliveryVerified:false};},async close(){closed++;}};
  const runtime=await createJkRuntime(f.db,{env:f.env,baileysAdapterFactory:async(settings)=>{assert.equal(settings.templates[0].text,'OS {{1}} pronta.');return fake;}});
  assert.equal(connects,1);assert.equal(jkReadiness(runtime).whatsapp.state,'blocked');assert.equal(jkReadiness(runtime).whatsapp.connection,'connecting');
  connected=true;assert.equal(jkReadiness(runtime).whatsapp.state,'ready');assert.equal(jkReadiness(runtime).whatsapp.capabilities.verifyDelivery,false);
  sendEnabled=false;assert.equal(jkReadiness(runtime).whatsapp.state,'blocked');sendEnabled=true;
  connected=false;assert.equal(jkReadiness(runtime).whatsapp.state,'blocked');
  await runtime.close();await runtime.close();assert.equal(closed,1);assert.equal(jkReadiness(runtime).whatsapp.state,'blocked');
});

test('unmigrated JK storage prevents Baileys socket creation even with all external gates enabled',async t=>{
  const f=await fixture(t,[],{migrate:false,AB_JK_INTEGRATIONS_ENABLED:'true',AB_JK_ALLOW_PRODUCTION:'true',AB_JK_BAILEYS_CONNECT_ENABLED:'true',AB_JK_BAILEYS_SEND_ENABLED:'true'});
  const entry={kind:'whatsapp-baileys',environment:'production',accountPhone:'5511999999999',authDir:join(f.directory,'auth'),templatesFile:'templates.json'};
  await writeFile(join(f.directory,'config.json'),JSON.stringify({version:1,integrations:[entry]}),{mode:0o600});let calls=0;
  const runtime=await createJkRuntime(f.db,{env:f.env,baileysAdapterFactory:async()=>{calls++;throw new Error('must not construct');}});t.after(()=>runtime.close());
  assert.equal(runtime.storageReady,false);assert.equal(calls,0);assert.ok(runtime.channels.whatsapp.blockers.includes('INTEGRATION_STORAGE_UNAVAILABLE'));
});
