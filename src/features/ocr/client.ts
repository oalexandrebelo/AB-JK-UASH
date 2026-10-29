import {assertNotAborted, prepareImage} from './image';
import {extractPlateCandidates} from './plate';

export interface PlateOcrProgress {
  label: string;
  percent: number;
}

export interface PlateOcrResult {
  text: string;
  confidence: number;
  candidates: string[];
}

type PendingJob = {resolve: (data: unknown) => void; reject: (error: Error) => void};
type OcrAction = 'load' | 'loadLanguage' | 'FS' | 'initialize' | 'setParameters' | 'recognize';

const PROGRESS: Record<string, {label: string; from: number; to: number}> = {
  'loading tesseract core': {label: 'Abrindo o leitor local…', from: 5, to: 20},
  'initializing tesseract': {label: 'Preparando o leitor…', from: 20, to: 35},
  'loading language traineddata': {label: 'Carregando o modelo local…', from: 35, to: 55},
  'initializing api': {label: 'Preparando a leitura…', from: 55, to: 60},
  'recognizing text': {label: 'Lendo os caracteres da placa…', from: 60, to: 99}
};

/**
 * Small adapter to the vendored Tesseract.js 7.0.0 worker protocol.
 * Based on the upstream Apache-2.0 src/createWorker.js message sequence.
 * A native Worker is owned from the start, so cancel/unmount can terminate it
 * even while WASM or traineddata is being initialized. No remote URL is accepted.
 */
export async function recognizePlate(file: File, options: {
  signal: AbortSignal;
  onProgress?: (progress: PlateOcrProgress) => void;
}): Promise<PlateOcrResult> {
  const {signal, onProgress} = options;
  assertNotAborted(signal);
  onProgress?.({label: 'Preparando a foto…', percent: 0});
  const bytes = await prepareImage(file, signal);
  assertNotAborted(signal);
  if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') {
    throw new Error('Este navegador não oferece o leitor local. Você pode digitar a placa no cadastro.');
  }
  const asset = (path: string) => new URL(`/ocr/${path}`, window.location.origin).href;
  const worker = new Worker(asset('worker.min.js'), {name: 'ab-uash-plate-ocr'});
  const jobs = new Map<string, PendingJob>();
  let sequence = 0;
  let stopped = false;
  let highestProgress = 0;
  const stop = (reason: Error) => {
    if (stopped) return;
    stopped = true;
    worker.terminate();
    for (const job of jobs.values()) job.reject(reason);
    jobs.clear();
  };
  const abort = () => stop(new DOMException('Leitura cancelada.', 'AbortError'));
  signal.addEventListener('abort', abort, {once: true});
  const timeout = window.setTimeout(() => stop(new Error('A leitura demorou mais que o esperado. Recorte a placa e tente novamente.')), 60_000);
  const call = (action: OcrAction, payload: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    if (stopped || signal.aborted) {
      reject(new DOMException('Leitura cancelada.', 'AbortError'));
      return;
    }
    const jobId = `plate-${++sequence}`;
    jobs.set(jobId, {resolve, reject});
    try {
      worker.postMessage({workerId: 'plate', jobId, action, payload});
    } catch {
      jobs.delete(jobId);
      reject(new Error('Não foi possível iniciar a leitura local.'));
    }
  });
  worker.onmessage = ({data: packet}) => {
    if (stopped || !packet || typeof packet !== 'object') return;
    if (packet.status === 'progress') {
      const progress = PROGRESS[packet.data?.status];
      if (progress) {
        const fraction = Number.isFinite(packet.data.progress) ? Math.max(0, Math.min(1, packet.data.progress)) : 0;
        highestProgress = Math.max(highestProgress, Math.round(progress.from + fraction * (progress.to - progress.from)));
        onProgress?.({label: progress.label, percent: highestProgress});
      }
      return;
    }
    const job = jobs.get(packet.jobId);
    if (!job) return;
    jobs.delete(packet.jobId);
    if (packet.status === 'resolve') job.resolve(packet.data);
    else job.reject(new Error('O leitor local não conseguiu processar esta foto. Confira a imagem e tente novamente.'));
  };
  worker.onerror = () => stop(new Error('Não foi possível carregar o leitor local. Atualize o aplicativo e tente novamente.'));
  worker.onmessageerror = () => stop(new Error('Não foi possível ler o resultado da foto. Tente novamente.'));
  try {
    await call('load', {options: {lstmOnly: true, corePath: asset('core'), logging: false}});
    await call('loadLanguage', {langs: 'eng', options: {langPath: asset('lang'), dataPath: '/ocr', cacheMethod: 'none', gzip: true, lstmOnly: true}});
    await call('FS', {method: 'chdir', args: ['/ocr']});
    await call('initialize', {langs: 'eng', oem: 1, config: {load_system_dawg: '0', load_freq_dawg: '0'}});
    await call('setParameters', {params: {tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', tessedit_pageseg_mode: '7', user_defined_dpi: '300'}});
    const data = await call('recognize', {image: bytes, options: {}, output: {text: true, blocks: false}}) as {text?: unknown; confidence?: unknown};
    assertNotAborted(signal);
    const text = typeof data?.text === 'string' ? data.text.trim().slice(0, 500) : '';
    const confidence = typeof data?.confidence === 'number' && Number.isFinite(data.confidence) ? Math.max(0, Math.min(100, data.confidence)) : 0;
    onProgress?.({label: 'Leitura concluída. Confira a placa.', percent: 100});
    return {text, confidence, candidates: extractPlateCandidates(text)};
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    stop(new DOMException('Leitura encerrada.', 'AbortError'));
  }
}
