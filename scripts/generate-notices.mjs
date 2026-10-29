import {readFile, readdir, mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve, join} from 'node:path';
import {createHash} from 'node:crypto';

// Run after npm ci when updating dependencies. Runtime startup does not call this.
const root = fileURLToPath(new URL('../', import.meta.url));
const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
const output = resolve(root, 'licenses/npm');
await mkdir(output, {recursive: true});
const packages = [];
for (const [path, entry] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
  if (!path) continue;
  const directory = resolve(root, path);
  let metadata;
  try {metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));}
  catch (error) {if (error.code !== 'ENOENT') throw error;}
  const notices = [];
  if (metadata) {
    for (const item of await readdir(directory, {withFileTypes: true})) {
      if (!item.isFile() || !/^(?:licen[cs]e|notice|copying)(?:\.|$)/iu.test(item.name)) continue;
      const bytes = await readFile(join(directory, item.name));
      const filename = `${metadata.name.replaceAll('/', '__').replaceAll('@', '')}-${metadata.version}-${item.name}`;
      await writeFile(join(output, filename), bytes);
      notices.push({file: `licenses/npm/${filename}`, sha256: createHash('sha256').update(bytes).digest('hex')});
    }
  }
  packages.push({name: metadata?.name || path.split('node_modules/').at(-1), version: entry.version,
    declaredLicense: metadata?.license || entry.license || null, development: Boolean(entry.dev),
    optional: Boolean(entry.optional), installedOnBuildHost: Boolean(metadata),
    resolved: entry.resolved || null, integrity: entry.integrity || null, notices});
}
await writeFile(resolve(root, 'licenses/npm-manifest.json'), `${JSON.stringify({format: 'ab-uash-third-party-manifest-v1', generatedAt: new Date().toISOString(),
  scope: 'Packages locked for source compilation. Installed notices are preserved; platform-specific absent optional packages are identified. This is not a claim that every package is present in the browser bundle.', packages}, null, 2)}\n`);
console.log(JSON.stringify({packages: packages.length, installed: packages.filter(p => p.installedOnBuildHost).length, notices: packages.reduce((sum, p) => sum + p.notices.length, 0)}));
