import {parseOptions, createSnapshot} from './storage.mjs';

try {
  const options = parseOptions(process.argv.slice(2), ['--from', '--to']);
  const from = options['--from'], to = options['--to'];
  if (!from || !to) throw new Error('Use --from BACKUP.sqlite --to NOVO-BANCO.sqlite. O destino precisa ser novo.');
  const result = await createSnapshot(from, to, {restore: true});
  console.log(JSON.stringify({ok: true, ...result, nextStep: 'Encerre o servidor anterior e inicie com DB_PATH apontando para o novo arquivo. Faça login novamente.'}, null, 2));
} catch (error) { console.error(`Restauração não concluída: ${error.message}`); process.exitCode = 1; }
