import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSourceSnapshot, verifySourceSnapshot} from '../../scripts/jk-release-check.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ab-jk-release-test-'));
  const source = join(directory, 'source'), out = join(directory, 'snapshot');
  await mkdir(source);
  for (const path of ['server', 'integrations', 'src', 'scripts', 'data', 'node_modules', 'dist']) await mkdir(join(source, path));
  for (const path of ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json']) await writeFile(join(source, path), '{}\n');
  await writeFile(join(source, 'vite.config.ts'), 'export default {};\n');
  await writeFile(join(source, 'server', 'application.mjs'), 'export const version = 1;\n');
  await writeFile(join(source, 'src', 'App.tsx'), 'export const title = "Aplicação";\n');
  await writeFile(join(source, 'data', 'setup-token'), 'fixture must not be copied');
  await writeFile(join(source, '.env'), 'fixture must not be copied');
  await writeFile(join(source, 'dist', 'index.html'), 'fixture must not be copied');
  t.after(async () => { await chmod(out, 0o700).catch(() => {}); await rm(directory, {recursive: true, force: true}); });
  return {source, out};
}

test('snapshot freezes the explicit source scope and excludes runtime data and dependencies', async t => {
  const {source, out} = await fixture(t);
  const result = await createSourceSnapshot(source, out);
  assert.equal(result.fileCount, 8);
  assert.match(result.treeSha256, /^[a-f0-9]{64}$/u);
  assert.equal((await verifySourceSnapshot(source, out)).treeSha256, result.treeSha256);
  for (const path of ['.env', 'data', 'node_modules', 'dist']) await assert.rejects(stat(join(out, path)), {code: 'ENOENT'});
  const manifest = JSON.parse(await readFile(join(out, 'MANIFEST.json'), 'utf8'));
  assert.equal(manifest.maxFileBytes, 1024 * 1024);
  assert.equal(manifest.limitations.length, 3);
  await assert.rejects(createSourceSnapshot(source, out), {code: 'EEXIST'});
  await assert.rejects(createSourceSnapshot(source, join(source, '..nested')), /fora da árvore/u);
});

test('verification rejects source drift and extra staged files', async t => {
  const {source, out} = await fixture(t);
  await createSourceSnapshot(source, out);
  const target = join(source, 'server', 'application.mjs');
  await writeFile(target, 'export const version = 2;\n');
  await assert.rejects(verifySourceSnapshot(source, out), /diferentes/u);
  await writeFile(target, 'export const version = 1;\n');
  await chmod(out, 0o700);
  await writeFile(join(out, 'extra.mjs'), 'export const extra = true;\n');
  await assert.rejects(verifySourceSnapshot(source, out), /fora do escopo/u);
});

test('snapshot rejects symlinks and oversized files without preserving partial output', async t => {
  const {source, out} = await fixture(t);
  await writeFile(join(source, 'server', 'large.mjs'), Buffer.alloc(1024 * 1024 + 1, 32));
  await assert.rejects(createSourceSnapshot(source, out), /1 MiB/u);
  await assert.rejects(stat(out), {code: 'ENOENT'});
  await rm(join(source, 'server', 'large.mjs'));
  if (process.platform !== 'win32') {
    await symlink(join(source, '.env'), join(source, 'server', 'linked.mjs'));
    await assert.rejects(createSourceSnapshot(source, out), /simbólicos/u);
    await assert.rejects(stat(out), {code: 'ENOENT'});
  }
});
