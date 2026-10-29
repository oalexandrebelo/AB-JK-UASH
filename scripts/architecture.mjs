import {createHash} from 'node:crypto';
import {readFile, writeFile, mkdir, copyFile, access} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

// Documentation tooling only. No dependency is added to the application runtime.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'artifacts/architecture');
const sourceMapFile = resolve(output, 'source-map.json');
const pinnedCommit = '25cf37080fc8b1dbe758a4efc3935b55f3327083';
const pins = {
  'bin/archify.mjs': '3cebcee3fa339e3b98deacae8cb9a5570525e003d8823368d304d904ba9ceecd',
  'assets/template.html': '4fe243de7448f83d2123e987db5ec2539b662480a6e3ce3c90deb9e0c9ad11ef',
  'package.json': 'bb44684564dd998c8c9099449aace07017545fa0d1efb74d1a82682a88f421ff',
};
const claims = [
  {component: 'interface', paths: ['src/main.tsx', 'src/RootApp.tsx', 'src/lib/api.ts'], claim: 'React/Spectrum, navegação, estado da sessão e HTTP de mesma origem.'},
  {component: 'servidor', paths: ['scripts/start.mjs', 'server/application.mjs', 'server/http.mjs', 'server/security.mjs', 'server/domain.mjs', 'server/media.mjs'], claim: 'Processo HTTP local, arquivos estáticos, Host/Origin, autenticação, papéis, CSRF, domínio e fotos.'},
  {component: 'store', paths: ['server/db.mjs', 'server/domain-core.mjs', 'server/domain-orders.mjs', 'server/domain-finance.mjs', 'server/domain-office.mjs', 'server/domain-reports.mjs'], claim: 'AsyncStore, fila SQLite, transações, versão, idempotência e auditoria.'},
  {component: 'ocr', paths: ['src/features/ocr/client.ts', 'src/features/ocr/image.ts', 'src/features/ocr/plate.ts'], claim: 'Worker no navegador, assets da mesma origem e sugestão de placa.'},
  {component: 'assets', paths: ['vite.config.ts', 'scripts/prepare-assets.mjs', 'internal/ocr/assets-manifest.json', 'package.json'], claim: 'Build Vite, Inter local, preparação e hashes dos assets OCR.'},
  {component: 'sqlite', paths: ['server/db.mjs', 'server/domain-schema.mjs', 'server/media.mjs'], claim: 'Banco local com WAL, dados relacionais, fotos e estado de segurança.'},
  {component: 'backup', paths: ['scripts/storage.mjs', 'scripts/backup.mjs', 'scripts/restore.mjs'], claim: 'Snapshot SQLite, manifesto SHA-256 e restauração em destino novo.'},
  {component: 'optional-postgres', paths: ['server/db.mjs', 'server/vercel-runtime.mjs', 'api/index.mjs', 'vercel.json', 'supabase/migrations/20261020122216_private_application_store.sql'], claim: 'Perfil PostgreSQL/Vercel separado; configuração e migrações obrigatórias.'},
  {component: 'optional-fiscal', paths: ['server/fiscal.mjs', 'integrations/fiscal/index.mjs', 'integrations/fiscal/transport.mjs', 'integrations/fiscal/payload.mjs'], claim: 'Rascunho local e envio HTTPS opcional explícito com recuperação por consulta.'},
  {component: 'deployment', paths: ['Dockerfile', 'docker-compose.yml', 'deploy/nginx.conf'], claim: 'Runtime SQLite sem node_modules, app em rede interna e proxy de entrada.'},
];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function fileEvidence(paths) {
  return Promise.all(paths.map(async path => {
    const bytes = await readFile(resolve(root, path));
    return {path, bytes: bytes.length, sha256: sha256(bytes)};
  }));
}

async function checkSources() {
  const saved = JSON.parse(await readFile(sourceMapFile, 'utf8'));
  const current = await fileEvidence(saved.files.map(entry => entry.path));
  const changed = current.filter((entry, index) => entry.sha256 !== saved.files[index].sha256).map(entry => entry.path);
  console.log(JSON.stringify({ok: changed.length === 0, files: current.length, changed}, null, 2));
  if (changed.length) process.exitCode = 1;
}

async function generate(args) {
  if (args.length !== 2 || args[0] !== '--archify-root') {
    throw new Error('Use: node scripts/architecture.mjs --archify-root /caminho/archify/archify; ou --check-sources.');
  }
  const toolRoot = resolve(args[1]);
  await access(resolve(toolRoot, 'bin/archify.mjs'));
  for (const [path, expected] of Object.entries(pins)) {
    if (sha256(await readFile(resolve(toolRoot, path))) !== expected) {
      throw new Error(`Archify diverge da versão fixa no arquivo ${path}. Consulte docs/REFERENCIAS-JANTT-ARCHIFY.md.`);
    }
  }
  const files = await fileEvidence([...new Set(claims.flatMap(entry => entry.paths))].sort());
  const snapshot = {
    format: 'ab-uash-architecture-source-map-v1',
    capturedAt: new Date().toISOString(),
    scope: 'Cópia de trabalho analisada. Hashes de arquivos; sem alegação de commit ou validação Git pelo Archify.',
    semantics: 'Mapa de responsabilidades revisado por leitura de código. Hashes identificam os bytes e não provam a interpretação.',
    upstream: {
      name: 'Archify', version: '3.2.0', commit: pinnedCommit,
      url: `https://github.com/tt-a1i/archify/tree/${pinnedCommit}`,
      archiveSha256: '48b8cc6e8d9725d0186b7cf7c19f4d0651559f5ad4bb8451ec8f8f65a1c9cd9b',
      entrypointHashes: pins,
      note: 'Os três hashes verificam pontos de entrada. A identidade completa exige o arquivo upstream fixo ou checkout desse commit.',
    },
    claims, files,
  };
  await mkdir(resolve(output, 'licenses'), {recursive: true});
  for (const [source, destination] of [['LICENSE', 'ARCHIFY-MIT.txt'], ['THIRD_PARTY_NOTICES.md', 'ARCHIFY-THIRD-PARTY-NOTICES.md'], ['assets/JetBrainsMono-OFL.txt', 'JetBrainsMono-OFL.txt']]) {
    await copyFile(resolve(toolRoot, source), resolve(output, 'licenses', destination));
  }
  await writeFile(sourceMapFile, `${JSON.stringify(snapshot, null, 2)}\n`);
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const review = `artifacts/architecture/reviews/${stamp}`;
  const command = ['finalize', 'architecture', 'artifacts/architecture/candidate.json', 'artifacts/architecture/ab-uash-local.html', '--quality', 'showcase', '--out-dir', review, '--json'];
  const result = spawnSync(process.execPath, [resolve(toolRoot, 'bin/archify.mjs'), ...command], {
    cwd: root, env: {...process.env, ARCHIFY_UPDATE_CHECK_DISABLED: '1'}, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.signal || result.status === null) throw new Error(`Archify interrompido: ${result.signal || 'status ausente'}.`);
  await writeFile(resolve(output, 'last-generation.json'), `${JSON.stringify({
    generatedAt: new Date().toISOString(), archifyCommit: pinnedCommit,
    candidate: 'artifacts/architecture/candidate.json', artifact: 'artifacts/architecture/ab-uash-local.html',
    evidenceDirectory: review, exitCode: result.status,
    updateCheckDisabled: true,
    note: 'Exit code não zero não é sucesso integral; leia o receipt para distinguir artefato, browser e revisão visual.',
  }, null, 2)}\n`);
  await checkSources();
  process.exitCode = result.status || process.exitCode || 0;
}

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--check-sources') await checkSources();
  else await generate(args);
} catch (error) {
  console.error(`Arquitetura: ${error.message}`);
  process.exitCode = 1;
}
