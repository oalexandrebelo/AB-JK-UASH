import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

test('SDK TypeScript signatures and browser example compile while incorrect contracts fail at compile time', () => {
  const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'sdk/tsconfig.type-tests.json', '--pretty', 'false'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('compiled SDK and package have no server imports or runtime dependencies', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../sdk/package.json', import.meta.url)));
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.peerDependencies, undefined);
  const directory = new URL('../sdk/dist/', import.meta.url);
  for (const filename of await readdir(directory)) {
    if (!filename.endsWith('.js')) continue;
    const source = await readFile(new URL(filename, directory), 'utf8');
    for (const match of source.matchAll(/(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g)) assert.match(match[1], /^\.\/[^/]+\.js$/, `${filename}: non-local runtime import ${match[1]}`);
    assert.doesNotMatch(source, /node:|localStorage|sessionStorage|document\.cookie|console\.(log|debug|error)/);
  }
});
