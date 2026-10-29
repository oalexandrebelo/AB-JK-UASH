import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {chmod, lstat, mkdir, open, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {dirname, extname, isAbsolute, join, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOURCE_DIRS = ['server', 'integrations', 'src', 'scripts'];
const SOURCE_FILES = ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json', 'vite.config.ts'];
const BLOCKED_NAMES = new Set(['node_modules', 'data', 'dados', 'dist', 'backups', '.git', '.env', 'setup-token']);
const SOURCE_EXTENSIONS = new Set(['.mjs', '.cjs', '.js', '.jsx', '.ts', '.tsx', '.json', '.css', '.sql', '.md', '.txt']);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MANIFEST_FORMAT = 'ab-jk-source-snapshot-v1';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sorted = values => values.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);

async function readSource(path) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > MAX_FILE_BYTES) throw new Error(`Fonte não regular ou maior que 1 MiB: ${path}`);
    const bytes = await file.readFile();
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) throw new Error(`A fonte mudou durante a leitura: ${path}`);
    return bytes;
  } finally { await file.close(); }
}

async function sourceInventory(root) {
  const paths = [], excluded = [];
  async function visit(path) {
    const full = join(root, path);
    const info = await lstat(full);
    if (info.isSymbolicLink()) throw new Error(`Links simbólicos não são aceitos no snapshot: ${path}`);
    if (info.isDirectory()) {
      for (const name of sorted(await readdir(full))) {
        const child = `${path}/${name}`;
        if (BLOCKED_NAMES.has(name) || name.startsWith('.env.')) excluded.push(child);
        else await visit(child);
      }
    } else if (info.isFile() && SOURCE_EXTENSIONS.has(extname(path))) paths.push(path);
    else excluded.push(path);
  }
  for (const path of [...SOURCE_DIRS, ...SOURCE_FILES]) await visit(path);
  if (paths.length > 1000) throw new Error('Snapshot excede o limite de 1000 arquivos. Reveja o escopo.');
  return {paths: sorted(paths), excluded: sorted(excluded)};
}

async function hashedInventory(root) {
  const inventory = await sourceInventory(root);
  const files = [];
  let totalBytes = 0;
  for (const path of inventory.paths) {
    const bytes = await readSource(join(root, path));
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Snapshot excede 32 MiB. Reveja o escopo.');
    files.push({path, bytes: bytes.length, sha256: sha256(bytes)});
  }
  return {...inventory, files, totalBytes};
}

function treeDigest(files) {
  return sha256(Buffer.from(files.map(file => `${file.sha256}  ${file.bytes}  ${file.path}\n`).join('')));
}

/** Freeze source bytes for the explicitly requested static release analysis. */
export async function createSourceSnapshot(sourceRoot, destination) {
  const root = resolve(sourceRoot), out = resolve(destination);
  const rel = relative(root, out);
  if (rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel))) throw new Error('O snapshot deve ficar fora da árvore do projeto.');
  // mkdir without recursive is intentionally exclusive; never reuse a snapshot.
  await mkdir(out, {mode: 0o700});
  try {
    const inventory = await sourceInventory(root);
    const files = [];
    let totalBytes = 0;
    for (const path of SOURCE_DIRS) await mkdir(join(out, path), {mode: 0o700});
    for (const path of inventory.paths) {
      const bytes = await readSource(join(root, path));
      totalBytes += bytes.length;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Snapshot excede 32 MiB. Reveja o escopo.');
      const target = join(out, path);
      await mkdir(dirname(target), {recursive: true, mode: 0o700});
      await writeFile(target, bytes, {flag: 'wx', mode: 0o400});
      files.push({path, bytes: bytes.length, sha256: sha256(bytes)});
    }
    const after = await hashedInventory(root);
    if (JSON.stringify(files) !== JSON.stringify(after.files) || JSON.stringify(inventory.excluded) !== JSON.stringify(after.excluded)) throw new Error('A árvore mudou durante o snapshot. Congele as fontes antes de repetir.');
    const manifest = {
      format: MANIFEST_FORMAT, createdAt: new Date().toISOString(),
      treeSha256: treeDigest(files), sourceDirectories: SOURCE_DIRS, sourceFiles: SOURCE_FILES,
      fileCount: files.length, totalBytes, maxFileBytes: MAX_FILE_BYTES, files,
      excludedWithinScope: inventory.excluded,
      limitations: [
        'Snapshot estático das fontes selecionadas; não é imagem Docker nem distribuição executável.',
        'node_modules, banco, segredos, dist, OCR compilado, .git e arquivos fora do escopo não são copiados.',
        'O manifesto atesta bytes e escopo; não atesta execução, deploy ou segurança do aplicativo.',
      ],
    };
    await writeFile(join(out, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, {flag: 'wx', mode: 0o400});
    await chmod(out, 0o500);
    return {ok: true, snapshot: out, manifest: join(out, 'MANIFEST.json'), treeSha256: manifest.treeSha256, fileCount: files.length, totalBytes};
  } catch (error) {
    await rm(out, {recursive: true, force: true});
    throw error;
  }
}

export async function verifySourceSnapshot(sourceRoot, snapshot) {
  const manifest = JSON.parse(await readSource(join(snapshot, 'MANIFEST.json')));
  if (manifest.format !== MANIFEST_FORMAT || !Array.isArray(manifest.files) || manifest.files.length > 1000) throw new Error('Manifesto de snapshot inválido.');
  const current = await hashedInventory(resolve(sourceRoot));
  if (manifest.treeSha256 !== treeDigest(current.files) || JSON.stringify(manifest.files) !== JSON.stringify(current.files)) throw new Error('Fontes diferentes do snapshot congelado.');
  for (const file of current.files) {
    const bytes = await readSource(join(snapshot, file.path));
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error(`Snapshot alterado: ${file.path}`);
  }
  // Detect extra staged source files so a later analysis cannot silently widen.
  const staged = await hashedInventory(resolve(snapshot));
  if (JSON.stringify(staged.files) !== JSON.stringify(current.files)) throw new Error('O escopo do snapshot foi alterado.');
  const allFiles = [];
  async function visit(path = '') {
    for (const name of await readdir(join(snapshot, path))) {
      const child = path ? `${path}/${name}` : name;
      const info = await lstat(join(snapshot, child));
      if (info.isSymbolicLink()) throw new Error('O snapshot contém link simbólico.');
      if (info.isDirectory()) await visit(child);
      else if (info.isFile()) allFiles.push(child);
      else throw new Error('O snapshot contém arquivo especial.');
    }
  }
  await visit();
  if (JSON.stringify(sorted(allFiles)) !== JSON.stringify(sorted([...current.paths, 'MANIFEST.json']))) throw new Error('O snapshot contém arquivos fora do escopo.');
  return {ok: true, treeSha256: manifest.treeSha256, fileCount: current.files.length};
}

export async function checkRelease(root = ROOT) {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Release requer Node.js 24.');
  const [docker, compose, ci, page] = await Promise.all([
    readFile(join(root, 'Dockerfile'), 'utf8'), readFile(join(root, 'compose.yaml'), 'utf8'),
    readFile(join(root, '.github/workflows/ci.yml'), 'utf8'), readFile(join(root, 'dist/index.html'), 'utf8'),
  ]);
  const checks = [
    ['container-node24', /FROM node:24\./u.test(docker)],
    ['build-real', docker.includes('npm ci --ignore-scripts') && docker.includes('npm run build')],
    ['runtime-readable-uid1001', docker.includes('USER 1001:1001') && docker.includes('chmod -R a+rX /app')],
    ['runtime-resources', ['dist', 'server', 'scripts', 'integrations', 'licenses'].every(path => docker.includes(`/build/${path}`))],
    ['oficina-port-loopback', compose.includes('"127.0.0.1:${AB_PORTA:-9220}:4173"')],
    ['oficina-data-mount', compose.includes('source: ../dados') && compose.includes('create_host_path: false')],
    ['sqlite-path', compose.includes('DB_PATH: /data/ab-jk-uash.sqlite')],
    ['https-origin-and-cookie', compose.includes('PUBLIC_ORIGIN: https://ab-pcsrv.tail6bac78.ts.net:${AB_PORTA:-9220}') && compose.includes('COOKIE_SECURE: "true"')],
    ['bootstrap-file', compose.includes('SETUP_TOKEN_FILE: /data/setup-token') && !/^\s*SETUP_TOKEN:/mu.test(compose)],
    ['offline-maintenance', compose.includes('network_mode: none') && compose.includes('scripts/jk-maintenance.mjs')],
    ['ci-read-only', ci.includes('contents: read') && !ci.includes('secrets.') && !ci.includes('pull_request_target:')],
    ['ci-pinned-actions', [...ci.matchAll(/uses:\s*(\S+)/gu)].every(match => /^actions\/[\w-]+@[a-f0-9]{40}$/u.test(match[1]))],
    ['compiled-interface', /<!doctype html>/iu.test(page) && /<script[^>]+src=/u.test(page)],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length) throw new Error(`Gates estáticos não atendidos: ${failed.join(', ')}`);
  return {ok: true, checks: checks.map(([name]) => name), limitations: ['A sintaxe Compose requer docker compose config.', 'Build Docker, health do servidor, HTTPS e bootstrap precisam de evidência no ambiente de destino.']};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const {values, positionals} = parseArgs({options: {source: {type: 'string'}, out: {type: 'string'}, snapshot: {type: 'string'}}, allowPositionals: true});
    if (positionals.length !== 1) throw new Error('Use check, snapshot --out CAMINHO-NOVO, ou verify --snapshot CAMINHO.');
    let result;
    if (positionals[0] === 'check' && !values.out && !values.snapshot) result = await checkRelease(values.source || ROOT);
    else if (positionals[0] === 'snapshot' && values.out && !values.snapshot) result = await createSourceSnapshot(values.source || ROOT, values.out);
    else if (positionals[0] === 'verify' && values.snapshot && !values.out) result = await verifySourceSnapshot(values.source || ROOT, values.snapshot);
    else throw new Error('Argumentos inválidos para o gate de release.');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`Release não verificado: ${error.message}`);
    process.exitCode = 1;
  }
}
