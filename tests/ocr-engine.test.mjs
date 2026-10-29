import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Worker} from 'node:worker_threads';
import {extractPlateCandidates} from '../src/features/ocr/plate.ts';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const origin = 'http://127.0.0.1:43123';

function localWorker() {
  const worker = new Worker(new URL('../internal/ocr/browser-worker-node-harness.mjs', import.meta.url), {
    workerData: {publicRoot: `${projectRoot}/public`, origin}
  });
  const jobs = new Map();
  const assets = [];
  let sequence = 0;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const fail = (error) => {
    rejectReady(error);
    for (const job of jobs.values()) job.reject(error);
    jobs.clear();
  };
  worker.on('error', fail);
  worker.on('message', (event) => {
    if (event.kind === 'ready') resolveReady();
    if (event.kind === 'fatal') fail(new Error(event.error));
    if (event.kind === 'asset') assets.push(event.url);
    if (event.kind !== 'packet') return;
    const packet = event.packet;
    if (packet.status === 'progress') return;
    const job = jobs.get(packet.jobId);
    if (!job) return;
    jobs.delete(packet.jobId);
    if (packet.status === 'resolve') job.resolve(packet.data);
    else job.reject(new Error(String(packet.data)));
  });
  return {
    assets,
    ready,
    terminate: () => worker.terminate(),
    call: (action, payload) => new Promise((resolve, reject) => {
      const jobId = `test-${++sequence}`;
      jobs.set(jobId, {resolve, reject});
      worker.postMessage({workerId: 'plate', jobId, action, payload});
    })
  };
}

test('shipped OCR assets match recorded SHA-256 provenance', async () => {
  const manifest = JSON.parse(await readFile(new URL('../internal/ocr/assets-manifest.json', import.meta.url), 'utf8'));
  for (const entry of manifest.files) {
    const bytes = await readFile(`${projectRoot}/${entry.file}`);
    assert.equal(bytes.byteLength, entry.bytes, `${entry.file}: byte length`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `${entry.file}: SHA-256`);
  }
});

test('real vendored browser worker recognizes both synthetic Brazilian plate layouts using local assets only', {timeout: 60_000}, async (t) => {
  const engine = localWorker();
  t.after(() => engine.terminate());
  await engine.ready;
  // This sequence is the same pinned Tesseract.js 7 worker protocol as client.ts.
  await engine.call('load', {options: {lstmOnly: true, corePath: `${origin}/ocr/core`, logging: false}});
  await engine.call('loadLanguage', {langs: 'eng', options: {
    langPath: `${origin}/ocr/lang`, dataPath: '/ocr', cacheMethod: 'none', gzip: true, lstmOnly: true
  }});
  await engine.call('FS', {method: 'chdir', args: ['/ocr']});
  await engine.call('initialize', {langs: 'eng', oem: 1, config: {load_system_dawg: '0', load_freq_dawg: '0'}});
  await engine.call('setParameters', {params: {
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    tessedit_pageseg_mode: '7',
    user_defined_dpi: '300'
  }});
  for (const [fixture, expected] of [['mercosul', 'ABC1D23'], ['legacy', 'ABC1234']]) {
    const image = new Uint8Array(await readFile(new URL(`./ocr-fixtures/${fixture}.png`, import.meta.url)));
    const result = await engine.call('recognize', {image, options: {}, output: {text: true, blocks: false}});
    assert.deepEqual(extractPlateCandidates(result.text), [expected]);
    assert.equal(typeof result.confidence, 'number');
    assert.ok(result.confidence >= 0 && result.confidence <= 100);
    t.diagnostic(`${fixture}: ${JSON.stringify(result.text.trim())}; engine confidence ${result.confidence}/100`);
  }
  assert.ok(engine.assets.some((url) => url.endsWith('/eng.traineddata.gz')));
  assert.ok(engine.assets.some((url) => url.endsWith('.wasm.js')));
  assert.ok(engine.assets.every((url) => url.startsWith(`${origin}/ocr/`)));
  t.diagnostic(`Assets read through a file-only adapter: ${engine.assets.map((url) => new URL(url).pathname).join(', ')}`);
});
