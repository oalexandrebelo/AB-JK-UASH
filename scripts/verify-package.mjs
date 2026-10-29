import {readFile, lstat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(resolve(root, 'MANIFEST.json'), 'utf8'));
if (manifest.format !== 'ab-uash-distribution-v1' || !Array.isArray(manifest.files)) throw new Error('Manifesto de distribuição inválido.');
let verifiedBytes = 0;
for (const entry of manifest.files) {
  if (typeof entry.path !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sha256) || entry.path.includes('\\')) throw new Error('Entrada inválida no manifesto.');
  const path = resolve(root, entry.path);
  if (!path.startsWith(`${resolve(root)}${sep}`)) throw new Error('Caminho fora da distribuição.');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.bytes) throw new Error(`Arquivo ausente ou tamanho diferente: ${entry.path}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== entry.sha256) throw new Error(`SHA-256 divergente: ${entry.path}`);
  verifiedBytes += info.size;
}
console.log(JSON.stringify({ok: true, files: manifest.files.length, bytes: verifiedBytes,
  scope: 'Compara os arquivos distribuídos com o manifesto. Não autentica sua autoria e não verifica bancos ou arquivos criados após a extração.'}, null, 2));
