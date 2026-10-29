import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createApplication} from '../server/application.mjs';
import {transaction, audit} from '../server/db.mjs';
import {hashPassword} from '../server/security.mjs';
import * as validate from '../server/validation.mjs';

/** Local installation only: no public endpoint, no default account, no credential output. */
export async function bootstrapAdmin({dbPath, input, importLegacyAccount = false}) {
  validate.object(input);
  validate.onlyKeys(input, ['name', 'email', 'password']);
  const name = validate.text(input.name, 'name', {min: 2, max: 80});
  const email = validate.email(input.email);
  if (importLegacyAccount) {
    // An explicit account-migration operation may retain an existing credential.
    // All new accounts and subsequent password changes retain the 12-char policy.
    if (typeof input.password !== 'string' || input.password.length < 8 || input.password.length > 128) throw new Error('Credencial legada fora dos limites de importação.');
  } else validate.password(input.password);
  const passwordHash = await hashPassword(input.password);
  const app = await createApplication({dbPath: resolve(dbPath), fiscalEnv: {AB_UASH_FISCAL_ENABLED: 'false'}});
  try {
    return await transaction(app.store, async () => {
      const count = await app.store.prepare('SELECT COUNT(*) AS count FROM users').get();
      if (count.count !== 0) throw new Error('A instalação já tem usuários. Nenhuma conta foi alterada.');
      const id = randomUUID();
      const now = new Date().toISOString();
      await app.store.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,name,email,passwordHash,'admin',now,now);
      await audit(app.store,{actorId:id,action:importLegacyAccount?'setup.legacy_account_imported':'setup.local_admin_created',resourceType:'user',resourceId:id,metadata:{credentialSource:importLegacyAccount?'operator-supplied-legacy':'new',recommendedRotation:importLegacyAccount}});
      return {created:true,role:'admin',legacyCredentialImported:importLegacyAccount};
    });
  } finally { await app.close(); }
}

async function main() {
  const args = process.argv.slice(2);
  if (!['--db', '--import-legacy-account'].includes(args[0]) && args[0] !== '--help') throw new Error('Uso: node scripts/jk-bootstrap-admin.mjs --db /privado/ab-jk-uash.sqlite [--import-legacy-account] < credencial.json');
  if (args[0] === '--help') {
    console.log('Inicializa uma instalação vazia. Entrada JSON em stdin: name, email, password. Não passe credenciais na linha de comando. --import-legacy-account conserva uma credencial existente autorizada; novas senhas exigem 12 caracteres.');
    return;
  }
  let dbPath, importLegacyAccount = false;
  for (let i=0;i<args.length;i++) {
    if (args[i] === '--db' && args[i+1] && !dbPath) dbPath=args[++i];
    else if (args[i] === '--import-legacy-account' && !importLegacyAccount) importLegacyAccount=true;
    else throw new Error('Argumentos inválidos. Consulte --help.');
  }
  if (!dbPath) throw new Error('Informe --db com o caminho privado do banco.');
  let size=0; const chunks=[];
  for await (const chunk of process.stdin) {size+=chunk.length;if(size>8192) throw new Error('Entrada excede 8 KiB.');chunks.push(chunk);}
  let input;
  try {input=JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {throw new Error('Entrada JSON inválida.');}
  const result=await bootstrapAdmin({dbPath,input,importLegacyAccount});
  input.password='';
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {await main();} catch {console.error('Não foi possível inicializar a conta. Verifique a instalação vazia, o caminho privado e os requisitos de entrada. Nenhum segredo é exibido.');process.exitCode=1;}
}
