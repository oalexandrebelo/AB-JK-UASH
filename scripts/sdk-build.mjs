import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { generateContract } from './sdk-contract.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
await generateContract();
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
if (!existsSync(compiler)) throw new Error('Instale as dependências de desenvolvimento na raiz antes de compilar o SDK.');
const result = spawnSync(process.execPath, [compiler, '-p', 'sdk/tsconfig.json', '--pretty', 'false'], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log('SDK compilado: sdk/dist (ESM + declarações TypeScript; zero dependências de execução).');
