import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, stat, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createBaileysAdapter } from '../integrations/jk/baileys.mjs';

const env = { AB_JK_BAILEYS_CONNECT_ENABLED:'true', AB_JK_BAILEYS_SEND_ENABLED:'true', AB_JK_INTEGRATIONS_ENABLED:'true', AB_JK_ALLOW_PRODUCTION:'true' };
const input = {to:'5511987654321',text:'Sua lavagem está pronta.'};
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, options = {}) {
  const parent = await mkdtemp(join(tmpdir(),'jk-baileys-'));
  const adapters=[];
  t.after(async()=>{for(const item of adapters)await item.close();await rm(parent,{recursive:true,force:true});});
  const calls = [], sockets = [], scheduled = [], pairing = [];
  let imports = 0;
  const sdk = {
    BufferJSON:{replacer:(_key,value)=>value,reviver:(_key,value)=>value},
    initAuthCreds:()=>({registered:false}),
    proto:{Message:{AppStateSyncKeyData:{fromObject:value=>value}}},
    default(config) {
      const socket = {ev:new EventEmitter(),user:{id:'5511912345678:1@s.whatsapp.net'},authState:config.auth,
        end() { this.ended = true; },
        async requestPairingCode(phone) { calls.push({pairing:phone}); return 'ABCD1234'; },
        async sendMessage(jid,content,settings) { calls.push({jid,content,settings}); return options.send ? options.send(jid,content,settings) : {key:{id:settings.messageId}}; },
      };
      sockets.push(socket); return socket;
    },
  };
  const config = {authDir:join(parent,'private'),accountPhone:'5511912345678',templates:[{templateName:'order_ready',languageCode:'pt_BR',text:'OS {{1}} pronta.'}],sendTimeoutMs:50,...options.config};
  const dependencies = {env:{...env,...options.env},loadBaileys:async()=>{imports++;return sdk;},schedule:(fn,ms)=>{const item={fn,ms};scheduled.push(item);return item;},cancelSchedule:item=>{item.cancelled=true;},onPairing:item=>pairing.push(item)};
  const adapter = await createBaileysAdapter(config,dependencies);
  adapters.push(adapter);
  return {adapter,adapters,config,dependencies,sdk,calls,sockets,scheduled,pairing,get imports(){return imports;}};
}

async function connected(f) {
  await f.adapter.connect();
  f.sockets.at(-1).ev.emit('connection.update',{connection:'open'});
  await tick();
}

test('construction never imports Baileys or connects and public status contains no secrets',async t=>{
  const f=await fixture(t);
  assert.equal(f.imports,0);
  assert.deepEqual(f.adapter.status(),{provider:'whatsapp-baileys',connection:'disconnected',connectionVerified:false,sendEnabled:true,qrAvailable:false,reconnectAttempts:0,deliveryVerified:false});
});

test('connect gate blocks SDK loading and every sending gate blocks dispatch',async t=>{
  const f=await fixture(t,{env:{AB_JK_BAILEYS_CONNECT_ENABLED:'false'}});
  await assert.rejects(f.adapter.connect(),/BAILEYS_CONNECTION_DISABLED/);
  assert.equal(f.imports,0);
  for (const gate of ['AB_JK_BAILEYS_SEND_ENABLED','AB_JK_INTEGRATIONS_ENABLED','AB_JK_ALLOW_PRODUCTION']) {
    const item=await fixture(t,{env:{[gate]:'false'}}); await connected(item);
    assert.equal((await item.adapter.execute('send-text',input,{idempotencyKey:'blocked'})).data.code,'BAILEYS_SEND_DISABLED');
    assert.equal(item.calls.length,0);
  }
});

test('QR is available only to explicit pairing callback and cleared on verified open',async t=>{
  const f=await fixture(t); await f.adapter.connect();
  f.sockets[0].ev.emit('connection.update',{qr:'PRIVATE-QR-PAYLOAD'}); await tick();
  assert.equal(f.pairing[0].qr,'PRIVATE-QR-PAYLOAD');
  assert.equal(f.adapter.status().qrAvailable,true);
  assert.equal(JSON.stringify(f.adapter.status()).includes('PRIVATE'),false);
  assert.equal(await f.adapter.requestPairingCode(),'ABCD1234');
  f.sockets[0].ev.emit('connection.update',{connection:'open'}); await tick();
  assert.equal(f.adapter.status().connectionVerified,true);
  assert.equal(f.adapter.status().qrAvailable,false);
});

test('only configured account can become connected',async t=>{
  const f=await fixture(t); await f.adapter.connect(); f.sockets[0].user.id='5511999999999:1@s.whatsapp.net';
  f.sockets[0].ev.emit('connection.update',{connection:'open'}); await tick();
  assert.equal(f.adapter.status().connection,'account-mismatch');
  assert.equal((await f.adapter.execute('send-text',input,{idempotencyKey:'account'})).data.code,'BAILEYS_NOT_CONNECTED');
  assert.equal(f.calls.length,0);
});

test('send acceptance uses Baileys ID and explicitly leaves delivery unconfirmed',async t=>{
  const f=await fixture(t); await connected(f);
  const result=await f.adapter.execute('send-text',input,{idempotencyKey:'send-one'});
  assert.equal(result.state,'SUCCEEDED'); assert.match(result.providerReference,/^baileys:[A-F0-9]+$/);
  assert.equal(result.data.acceptance,'socket-accepted'); assert.equal(result.data.delivery,'unconfirmed');
  assert.equal(f.calls[0].jid,'5511987654321@s.whatsapp.net');
  assert.deepEqual(f.calls[0].content,{text:input.text,linkPreview:null});
});

test('concurrent and persisted replay sends once; same key with changed input conflicts',async t=>{
  const f=await fixture(t); await connected(f);
  const [first,second]=await Promise.all([f.adapter.execute('send-text',input,{idempotencyKey:'same'}),f.adapter.execute('send-text',input,{idempotencyKey:'same'})]);
  assert.equal(first.state,'SUCCEEDED'); assert.ok(['UNKNOWN','SUCCEEDED'].includes(second.state)); assert.equal(f.calls.length,1);
  assert.deepEqual(await f.adapter.execute('send-text',input,{idempotencyKey:'same'}),first);
  assert.equal((await f.adapter.execute('send-text',{...input,text:'Changed'},{idempotencyKey:'same'})).data.code,'BAILEYS_IDEMPOTENCY_CONFLICT');
  await f.adapter.close();
  const reopened=await createBaileysAdapter(f.config,f.dependencies); f.adapters.push(reopened); await reopened.connect();
  f.sockets.at(-1).ev.emit('connection.update',{connection:'open'}); await tick();
  assert.deepEqual(await reopened.execute('send-text',input,{idempotencyKey:'same'}),first); assert.equal(f.calls.length,1);
});

test('timeout is uncertain and persisted replay never retransmits it',async t=>{
  const f=await fixture(t,{send:()=>new Promise(()=>{})}); await connected(f);
  const result=await f.adapter.execute('send-text',input,{idempotencyKey:'timeout'});
  assert.equal(result.state,'UNKNOWN'); assert.equal(result.data.code,'BAILEYS_SEND_UNCONFIRMED');
  await f.adapter.execute('send-text',input,{idempotencyKey:'timeout'}); assert.equal(f.calls.length,1);
  await f.adapter.close();
  const reopened=await createBaileysAdapter(f.config,f.dependencies); f.adapters.push(reopened); await reopened.connect();
  f.sockets.at(-1).ev.emit('connection.update',{connection:'open'}); await tick();
  assert.deepEqual(await reopened.execute('send-text',input,{idempotencyKey:'timeout'}),result); assert.equal(f.calls.length,1);
});

test('abort after socket dispatch is uncertain and never retries',async t=>{
  const f=await fixture(t,{send:()=>new Promise(()=>{})}); await connected(f);
  const controller=new AbortController();
  const result=f.adapter.execute('send-text',input,{idempotencyKey:'abort-after',signal:controller.signal});
  controller.abort();
  assert.equal((await result).state,'UNKNOWN');
  await f.adapter.execute('send-text',input,{idempotencyKey:'abort-after'}); assert.equal(f.calls.length,1);
});

test('network errors and mismatched provider IDs stay uncertain without exposing error details',async t=>{
  const failed=await fixture(t,{send:()=>{throw new Error('PRIVATE_PROVIDER_DETAIL');}});await connected(failed);
  const result=await failed.adapter.execute('send-text',input,{idempotencyKey:'network'});
  assert.equal(result.state,'UNKNOWN');assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
  const invalid=await fixture(t,{send:()=>({key:{id:'foreign'}})});await connected(invalid);
  assert.equal((await invalid.adapter.execute('send-text',input,{idempotencyKey:'foreign'})).state,'UNKNOWN');
});

test('abort before dispatch and invalid input create no socket message',async t=>{
  const f=await fixture(t); await connected(f);
  const controller=new AbortController(); controller.abort();
  assert.equal((await f.adapter.execute('send-text',input,{idempotencyKey:'aborted',signal:controller.signal})).data.code,'BAILEYS_ABORTED');
  for (const invalid of [{...input,to:'123@g.us'},{...input,text:''},{...input,previewUrl:true},{...input,extra:'x'}]) assert.equal((await f.adapter.execute('send-text',invalid,{idempotencyKey:'bad'})).state,'REJECTED');
  assert.equal((await f.adapter.execute('send-text',input,{})).data.code,'BAILEYS_IDEMPOTENCY_REQUIRED');
  assert.equal(f.calls.length,0);
});

test('templates render only configured local text and reject missing or extra placeholders',async t=>{
  const f=await fixture(t); await connected(f);
  const template={to:input.to,templateName:'order_ready',languageCode:'pt_BR',bodyParameters:['123']};
  const result=await f.adapter.execute('send-template',template,{idempotencyKey:'template'});
  assert.equal(result.state,'SUCCEEDED'); assert.equal(result.data.localTemplate,true); assert.equal(f.calls[0].content.text,'OS 123 pronta.');
  for (const invalid of [{...template,templateName:'unconfigured'},{...template,bodyParameters:[]},{...template,bodyParameters:['1','2']}]) assert.equal((await f.adapter.execute('send-template',invalid,{idempotencyKey:'bad-template'})).state,'REJECTED');
  assert.equal(f.calls.length,1);
});

test('reconnection is bounded and logout or replacement never reconnects',async t=>{
  const f=await fixture(t); await connected(f);
  for(let i=0;i<5;i++) { f.sockets.at(-1).ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:408}}}}); await tick(); await f.scheduled.at(-1).fn(); }
  f.sockets.at(-1).ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:408}}}}); await tick();
  assert.equal(f.scheduled.length,5); assert.equal(f.adapter.status().connection,'reconnect-exhausted');
  assert.deepEqual(f.scheduled.map(x=>x.ms),[1000,2000,4000,8000,16000]);
  for(const statusCode of [401,403,411,440,500]) {
    const item=await fixture(t); await connected(item); item.sockets[0].ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode}}}}); await tick();
    assert.equal(item.scheduled.length,0); assert.equal(item.adapter.status().connection,'reauth-required');
  }
});

test('close cancels reconnect and detaches socket listeners',async t=>{
  const f=await fixture(t); await connected(f); const socket=f.sockets[0];
  socket.ev.emit('connection.update',{connection:'close'}); await tick(); await f.adapter.close();
  assert.equal(f.scheduled[0].cancelled,true); await f.scheduled[0].fn(); assert.equal(f.sockets.length,1);
  assert.equal(socket.ev.listenerCount('connection.update'),0);
});

test('credentials and signal keys persist with private permissions; second owner is refused',async t=>{
  const f=await fixture(t); await f.adapter.connect();
  const auth=f.sockets[0].authState; auth.creds.registered=true;
  f.sockets[0].ev.emit('creds.update',{}); await tick();
  await auth.keys.set({'app-state-sync-key':{'abc':{keyData:'private'}}});
  await assert.rejects(createBaileysAdapter(f.config,f.dependencies),/BAILEYS_SESSION_IN_USE/);
  assert.equal((await stat(f.config.authDir)).mode & 0o777,0o700);
  assert.equal((await stat(join(f.config.authDir,'session.sqlite'))).mode & 0o777,0o600);
  await f.adapter.close();
  const reopened=await createBaileysAdapter(f.config,f.dependencies); f.adapters.push(reopened); await reopened.connect();
  assert.equal(f.sockets.at(-1).authState.creds.registered,true);
  assert.deepEqual(await f.sockets.at(-1).authState.keys.get('app-state-sync-key',['abc']),{abc:{keyData:'private'}});
});

test('auth directory inside repository, symlink, permissive directory and foreign files are refused',async t=>{
  const parent=await mkdtemp(join(tmpdir(),'jk-baileys-unsafe-')); t.after(()=>rm(parent,{recursive:true,force:true}));
  const path=join(parent,'private'); await mkdir(path,{mode:0o700});
  const linked=join(parent,'linked'); await symlink(path,linked);
  await assert.rejects(createBaileysAdapter({authDir:process.cwd(),accountPhone:'5511912345678'}),/BAILEYS_AUTH_OUTSIDE_REPOSITORY_REQUIRED/);
  await assert.rejects(createBaileysAdapter({authDir:linked,accountPhone:'5511912345678'}),/BAILEYS_AUTH_SYMLINK_FORBIDDEN/);
  const wide=join(parent,'wide'); await mkdir(wide,{mode:0o755});
  await assert.rejects(createBaileysAdapter({authDir:wide,accountPhone:'5511912345678'}),/BAILEYS_AUTH_PERMISSIONS/);
  await writeFile(join(path,'session.sqlite'),'not a database',{mode:0o644});
  await assert.rejects(createBaileysAdapter({authDir:path,accountPhone:'5511912345678'}),/BAILEYS_AUTH_PERMISSIONS/);
});

test('foreign SQLite databases and unsafe journal files cannot be repurposed as auth state',async t=>{
  const parent=await mkdtemp(join(tmpdir(),'jk-baileys-foreign-'));t.after(()=>rm(parent,{recursive:true,force:true}));
  const foreign=join(parent,'foreign');await mkdir(foreign,{mode:0o700});
  const file=join(foreign,'session.sqlite');await writeFile(file,'',{mode:0o600});
  const db=new DatabaseSync(file);db.exec('CREATE TABLE unrelated(value TEXT)');db.close();
  await assert.rejects(createBaileysAdapter({authDir:foreign,accountPhone:'5511912345678'}),/BAILEYS_AUTH_DATABASE_UNRECOGNIZED/);
  const privateDir=join(parent,'private');await mkdir(privateDir,{mode:0o700});
  await symlink(file,join(privateDir,'session.sqlite-journal'));
  await assert.rejects(createBaileysAdapter({authDir:privateDir,accountPhone:'5511912345678'}),/BAILEYS_AUTH_SYMLINK_FORBIDDEN/);
});
