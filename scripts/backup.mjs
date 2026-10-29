import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseOptions, createSnapshot} from './storage.mjs';

try {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const options = parseOptions(process.argv.slice(2), ['--db', '--out']);
  const source = options['--db'] || process.env.DB_PATH || resolve(root, 'data/ab-uash.sqlite');
  const destination = options['--out'] || resolve(root, `backups/ab-uash-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}.sqlite`);
  const result = await createSnapshot(source, destination);
  console.log(JSON.stringify({ok: true, ...result}, null, 2));
} catch (error) { console.error(`Backup não concluído: ${error.message}`); process.exitCode = 1; }
