// Offline compatibility check only. It neither constructs a socket nor reads an operator's session.
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { openBaileysStore } from './store.mjs';

const blocked=()=>{throw new Error('NETWORK_DISABLED_FOR_IMPORT_CHECK');};
net.connect=blocked;net.createConnection=blocked;tls.connect=blocked;
http.request=blocked;http.get=blocked;https.request=blocked;https.get=blocked;globalThis.fetch=blocked;
syncBuiltinESMExports();
const sdk=await import('baileys');
assert.equal(typeof sdk.default,'function');assert.equal(typeof sdk.initAuthCreds,'function');
assert.equal(typeof sdk.BufferJSON?.replacer,'function');assert.equal(typeof sdk.proto?.Message?.AppStateSyncKeyData?.fromObject,'function');
const parent=await mkdtemp(join(tmpdir(),'jk-baileys-installed-'));
let store;
try {
  const directory=join(parent,'private');
  store=await openBaileysStore(directory,'5511912345678');
  const auth=store.auth(sdk),identity=Buffer.from(auth.state.creds.signedIdentityKey.private);
  await auth.saveCreds();
  await auth.state.keys.set({'app-state-sync-key':{synthetic:{keyData:Buffer.from([1,2,3])}}});
  await store.close();store=undefined;
  store=await openBaileysStore(directory,'5511912345678');
  const reopened=store.auth(sdk);
  assert.deepEqual(Buffer.from(reopened.state.creds.signedIdentityKey.private),identity);
  assert.deepEqual(Buffer.from((await reopened.state.keys.get('app-state-sync-key',['synthetic'])).synthetic.keyData),Buffer.from([1,2,3]));
  process.stdout.write(`${JSON.stringify({sdkVersion:'7.0.0-rc14',exportsVerified:true,authRoundTrip:true,networkDisabled:true,socketCreated:false,messagesSent:0})}\n`);
} finally {await store?.close();await rm(parent,{recursive:true,force:true});}
