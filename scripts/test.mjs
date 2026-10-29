import {readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.length > 2) throw new Error('Uso: node scripts/test.mjs. A suíte de DOM emulado tem comando separado em docs/REVISAO-INTEGRACAO.md.');
const files = (await readdir(new URL('../tests/', import.meta.url))).filter(name => name.endsWith('.test.mjs') && !name.startsWith('ui-')).sort().map(name => `tests/${name}`);
const child = spawn(process.execPath, ['--test', '--test-reporter=spec', ...files], {cwd: root, stdio: 'inherit', shell: false});
child.once('error', error => {console.error(error.message); process.exitCode = 1;});
child.once('close', code => {process.exitCode = code ?? 1;});
