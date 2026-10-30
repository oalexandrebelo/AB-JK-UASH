import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli=fileURLToPath(new URL('../integrations/whatsapp-baileys/cli.mjs',import.meta.url));

test('pairing refuses noninteractive output before loading private configuration',()=>{
  const result=spawnSync(process.execPath,[cli,'pair'],{encoding:'utf8',env:{...process.env,AB_JK_BAILEYS_CONFIG_FILE:'/not-read-private-config'}});
  assert.equal(result.status,1);assert.equal(result.stdout,'');
  assert.equal(result.stderr,'BAILEYS_PAIR_REQUIRES_PRIVATE_TERMINAL\n');
});

test('offline CLI status reads synthetic private config and never reports a paired connection',async t=>{
  const parent=await mkdtemp(join(tmpdir(),'jk-baileys-cli-'));t.after(()=>rm(parent,{recursive:true,force:true}));
  const file=join(parent,'config.json');await writeFile(file,JSON.stringify({authDir:join(parent,'auth'),accountPhone:'5511912345678'}),{mode:0o600});
  const result=spawnSync(process.execPath,[cli,'status'],{encoding:'utf8',env:{...process.env,AB_JK_BAILEYS_CONFIG_FILE:file,AB_JK_BAILEYS_CONNECT_ENABLED:'false'}});
  assert.equal(result.status,0,result.stderr);
  const status=JSON.parse(result.stdout);assert.equal(status.connection,'disconnected');assert.equal(status.connectionVerified,false);
  assert.equal(result.stdout.includes('5511912345678'),false);
});
