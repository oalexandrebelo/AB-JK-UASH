import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(resolve(root, 'internal/ocr/assets-manifest.json'), 'utf8'));
let total = 0;
for (const entry of manifest.files.filter(entry => entry.file.startsWith('public/ocr/'))) {
  const source = resolve(root, 'node_modules', entry.sourcePath);
  const destination = resolve(root, entry.file);
  if (!source.startsWith(resolve(root, 'node_modules') + sep) || !destination.startsWith(resolve(root, 'public/ocr') + sep)) throw new Error('Caminho de asset fora do diretório permitido.');
  const bytes = await readFile(source);
  if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error(`Asset divergente do manifesto fixado: ${entry.file}`);
  await mkdir(dirname(destination), {recursive: true});
  await writeFile(destination, bytes);
  total += bytes.length;
}
console.log(`Assets OCR locais preparados e verificados: ${total} bytes. Nenhuma requisição de rede foi usada pelo preparador.`);
