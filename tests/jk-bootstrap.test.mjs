import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bootstrapAdmin} from '../scripts/jk-bootstrap-admin.mjs';
import {createApplication} from '../server/application.mjs';
import {verifyPassword} from '../server/security.mjs';
import {publicJkProfile} from '../server/jk-public.mjs';

test('JK local bootstrap refuses overwrite and preserves explicit legacy account without exposing it publicly',async()=>{
  const root=await mkdtemp(join(tmpdir(),'jk-bootstrap-'));
  const dbPath=join(root,'test.sqlite');
  try {
    const input={name:'Synthetic operator',email:'operator@example.test',password:'Old$1234'};
    await assert.rejects(bootstrapAdmin({dbPath,input}));
    const result=await bootstrapAdmin({dbPath,input,importLegacyAccount:true});
    assert.deepEqual(result,{created:true,role:'admin',legacyCredentialImported:true});
    await assert.rejects(bootstrapAdmin({dbPath,input,importLegacyAccount:true}),/já tem usuários/);
    const app=await createApplication({dbPath});
    try {
      const user=await app.store.prepare('SELECT * FROM users').get();
      assert.equal(await verifyPassword(input.password,user.password_hash),true);
      assert.equal(user.email,input.email);
      const profile=await publicJkProfile(app.store);
      assert.equal(profile.name,'Lava Rápido JK');
      assert.deepEqual(profile.services,[]);
      assert.equal(JSON.stringify(profile).includes(input.email),false);
      assert.equal(JSON.stringify(profile).includes(user.password_hash),false);
    } finally {await app.close();}
  } finally {await rm(root,{recursive:true,force:true});}
});
