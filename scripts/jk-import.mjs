import { DatabaseSync } from 'node:sqlite';
import { lstat, readFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sqliteStore } from '../server/db.mjs';
import { previewJkMigration, commitJkMigration, MAX_IMPORT_BYTES } from '../server/jk-migration.mjs';
import { ApiError } from '../server/errors.mjs';

const HELP = `Importação local JK em modo histórico. O banco deve ter sido inicializado pelo aplicativo.
Prévia (somente leitura):
  node scripts/jk-import.mjs --db /privado/operacao.sqlite --input /privado/lote.json --preview
Confirmação do mesmo conteúdo e banco:
  node scripts/jk-import.mjs --db /privado/operacao.sqlite --input /privado/lote.json --commit --preview-hash HASH
CSV/HTML: adicionar --format csv|jumpcar-html --entity customers|vehicles|services|orders|orderItems|payments
JSON: envelope {source:"jumpcar",dataset:{schemaVersion:1,...}}.
Sem senhas, consultas remotas ou rotinas de cobrança. A saída contém apenas diagnóstico, hashes e contagens.
`;
function options(argv) {
  const result = {}, flags = new Set(['--preview','--commit']), values = new Set(['--db','--input','--format','--entity','--preview-hash','--actor-id']);
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (Object.hasOwn(result,key) || !flags.has(key) && !values.has(key)) throw new ApiError(422,'INVALID_ARGUMENTS','Argumentos inválidos. Use --help.');
    if (flags.has(key)) result[key] = true;
    else { const value = argv[++index]; if (!value || value.startsWith('--')) throw new ApiError(422,'INVALID_ARGUMENTS','Um argumento obrigatório está ausente.'); result[key] = value; }
  }
  if (!result['--db'] || !result['--input'] || Boolean(result['--preview']) === Boolean(result['--commit'])) throw new ApiError(422,'INVALID_ARGUMENTS','Informe banco, arquivo e exatamente um modo: --preview ou --commit.');
  if (result['--commit'] && !result['--preview-hash']) throw new ApiError(422,'PREVIEW_HASH_REQUIRED','A confirmação exige --preview-hash.');
  return result;
}
async function regularFile(path,maxBytes) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new ApiError(422,'REGULAR_FILE_REQUIRED','Use arquivos regulares, sem links simbólicos.');
  if (maxBytes && info.size > maxBytes) throw new ApiError(413,'IMPORT_TOO_LARGE','O arquivo excede o limite de 8 MiB.');
}
export async function main(argv = process.argv.slice(2),{stdout = process.stdout,stderr = process.stderr} = {}) {
  let store;
  try {
    if (argv.length === 1 && argv[0] === '--help') { stdout.write(HELP); return 0; }
    const opts = options(argv), dbPath = resolve(opts['--db']), inputPath = resolve(opts['--input']);
    await regularFile(dbPath); await regularFile(inputPath,MAX_IMPORT_BYTES);
    const bytes = await readFile(inputPath);
    let content;
    try { content = new TextDecoder('utf-8',{fatal:true}).decode(bytes); }
    catch { throw new ApiError(422,'INVALID_IMPORT_UTF8','Use um arquivo de texto UTF-8.'); }
    let input;
    if (!opts['--format'] || opts['--format'] === 'json') {
      try { input = JSON.parse(content); }
      catch { throw new ApiError(422,'INVALID_JSON','O arquivo JSON é inválido.'); }
    } else input = {source:'jumpcar',files:[{entity:opts['--entity'],format:opts['--format'],content}]};
    const raw = new DatabaseSync(dbPath,{readOnly:Boolean(opts['--preview']),timeout:5000});
    store = sqliteStore(raw);
    raw.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;');
    if (!raw.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='jk_migration_batches'").get()) throw new ApiError(409,'IMPORT_SCHEMA_REQUIRED','Inicie a aplicação JK para preparar o esquema antes da importação.');
    let report;
    if (opts['--preview']) report = await previewJkMigration(store,input);
    else {
      const actor = opts['--actor-id'] ? await store.prepare("SELECT id FROM users WHERE id=? AND active=1 AND role='admin'").get(opts['--actor-id']) : null;
      if (opts['--actor-id'] && !actor) throw new ApiError(403,'ADMIN_REQUIRED','O ator precisa ser um administrador ativo.');
      await chmod(dbPath,0o600);
      report = await commitJkMigration(store,input,{previewHash:opts['--preview-hash'],actorId:actor?.id || null});
    }
    // Identity maps and source values are available only through authenticated UI/database.
    const {identityMap,...safe} = report;
    stdout.write(JSON.stringify(safe,null,2) + '\n');
    return report.status === 'REJECTED' ? 2 : 0;
  } catch (error) {
    // Never echo input values, filenames, credentials, SQL driver text, or stacks.
    stderr.write(JSON.stringify({status:'REJECTED',code:error instanceof ApiError ? error.code : 'LOCAL_IMPORT_FAILED',message:error instanceof ApiError ? error.message : 'Não foi possível concluir a importação local.'}) + '\n');
    return 1;
  } finally { if (store) await store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
