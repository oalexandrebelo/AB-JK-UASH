/**
 * Test adapter only: runs the unmodified browser worker in Node's worker thread.
 * It supplies the Web Worker messaging/importScripts APIs and a file-only fetch.
 * This is real OCR with the shipped WASM/model, not a browser or visual test.
 */
import {readFileSync} from 'node:fs';
import {resolve, relative, sep} from 'node:path';
import {runInThisContext} from 'node:vm';
import {parentPort, workerData} from 'node:worker_threads';

const {publicRoot, origin} = workerData;
const assetRoot = resolve(publicRoot, 'ocr');
const nodeProcess = process;

function fail(error) {
  parentPort.postMessage({kind: 'fatal', error: String(error?.message ?? error).slice(0, 1000)});
}
nodeProcess.on('uncaughtException', fail);
nodeProcess.on('unhandledRejection', fail);

function assetPath(value) {
  const url = new URL(String(value), `${origin}/ocr/worker.min.js`);
  if (url.origin !== origin || !url.pathname.startsWith('/ocr/')) {
    throw new Error(`Network access blocked by test adapter: ${url.href}`);
  }
  const path = resolve(publicRoot, `.${decodeURIComponent(url.pathname)}`);
  const local = relative(assetRoot, path);
  if (!local || local.startsWith(`..${sep}`) || local === '..') {
    throw new Error('Asset path escapes /ocr.');
  }
  parentPort.postMessage({kind: 'asset', url: url.href});
  return path;
}

globalThis.self = globalThis;
globalThis.location = new URL(`${origin}/ocr/worker.min.js`);
globalThis.WorkerGlobalScope = class WorkerGlobalScope {};
globalThis.postMessage = (packet) => parentPort.postMessage({kind: 'packet', packet});
globalThis.addEventListener = (type, listener) => {
  if (type === 'message') parentPort.on('message', (data) => listener({data}));
};
globalThis.importScripts = (...urls) => {
  for (const url of urls) {
    const path = assetPath(url);
    runInThisContext(readFileSync(path, 'utf8'), {filename: path});
  }
};
globalThis.fetch = async (url) => {
  const data = readFileSync(assetPath(url));
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  };
};

// Match the browser branch in the unmodified Emscripten/WASM build.
Object.defineProperty(globalThis, 'process', {value: undefined, configurable: true});

try {
  importScripts(`${origin}/ocr/worker.min.js`);
  parentPort.postMessage({kind: 'ready'});
} catch (error) {
  fail(error);
}
