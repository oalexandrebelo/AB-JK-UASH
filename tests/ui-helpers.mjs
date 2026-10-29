import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createApplication} from '../server/application.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const toolingManifest = process.env.AB_UASH_UI_QA_PACKAGE || process.env.UI_QA_PACKAGE
  || fileURLToPath(new URL('../qa/ui-tool/package.json', import.meta.url));
let JSDOM;
let VirtualConsole;
export let uiQaAvailable = false;
try {
  ({JSDOM, VirtualConsole} = createRequire(toolingManifest)('jsdom'));
  uiQaAvailable = true;
} catch (error) {
  if (process.env.AB_UASH_UI_QA_REQUIRED === '1') throw new Error('O runtime de QA DOM é obrigatório nesta execução.', {cause: error});
}
export const uiQaSkipReason = 'QA DOM opcional: execute npm ci --ignore-scripts --prefix qa/ui-tool; consulte docs/REVIEW-JK.md.';

export async function until(predicate, description, timeout = 7000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await predicate(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Tempo esgotado: ${description}${last ? ` (${last.message})` : ''}`);
}

/**
 * DOM emulado, sem navegador ou medição visual. O JS importado é o bundle de
 * produção. Fetch só permite a origem HTTP do próprio servidor temporário.
 */
export async function fixture(t, {application = {}, responseOverride} = {}) {
  assert.ok(uiQaAvailable, uiQaSkipReason);
  const directory = await mkdtemp(join(tmpdir(), 'ab-uash-ui-'));
  const appOptions = {
    dbPath: join(directory, 'local.sqlite'),
    distDir: join(projectRoot, 'dist'),
    fiscalEnv: {},
    jkIntegrationsEnv: {},
    logger: {error(value) { throw new Error(`Erro interno: ${JSON.stringify(value)}`); }},
    ...application,
  };
  let app = await createApplication(appOptions);
  let address = await app.listen({port: 0});
  let base = `http://127.0.0.1:${address.port}`;
  const html = await readFile(join(appOptions.distDir, 'index.html'), 'utf8');
  const virtualConsole = new VirtualConsole();
  const runtimeErrors = [];
  virtualConsole.on('jsdomError', error => runtimeErrors.push(error));
  const dom = new JSDOM(html, {url: `${base}/app`, pretendToBeVisual: true, virtualConsole});
  const {window} = dom;
  function expose(name, value) {
    Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
  }
  for (const name of [
    'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement',
    'HTMLButtonElement', 'HTMLTextAreaElement', 'HTMLFormElement', 'Element', 'Node', 'NodeFilter',
    'SVGElement', 'MutationObserver', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent',
    'FocusEvent', 'InputEvent', 'EventTarget', 'DOMException', 'DOMRect', 'CSS',
  ]) expose(name, name === 'window' ? window : window[name]);
  expose('getComputedStyle', window.getComputedStyle.bind(window));
  expose('requestAnimationFrame', window.requestAnimationFrame.bind(window));
  expose('cancelAnimationFrame', window.cancelAnimationFrame.bind(window));
  // Geometria e observers são suportes de acessibilidade/posicionamento, sem
  // alegação de fidelidade visual; CSS, layout e foco nativo precisam de browser.
  class ResizeObserver { observe() {} unobserve() {} disconnect() {} }
  class IntersectionObserver {
    constructor(callback) { this.callback = callback; }
    observe(target) { this.callback([{target, isIntersecting: true, intersectionRatio: 1}], this); }
    unobserve() {} disconnect() {}
  }
  class PointerEvent extends window.MouseEvent {
    constructor(type, options = {}) {
      super(type, options);
      Object.defineProperties(this, {
        pointerId: {value: options.pointerId ?? 1},
        pointerType: {value: options.pointerType ?? 'mouse'},
        isPrimary: {value: options.isPrimary ?? true},
      });
    }
  }
  for (const [name, value] of Object.entries({ResizeObserver, IntersectionObserver, PointerEvent})) {
    window[name] = value; expose(name, value);
  }
  window.matchMedia = query => ({
    matches: query.includes('prefers-reduced-motion'), media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return true; },
  });
  window.scrollTo = () => {};
  window.Element.prototype.getAnimations = function () { return []; };
  window.document.getAnimations = () => [];
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.HTMLElement.prototype.scrollTo = function () {};
  window.HTMLElement.prototype.setPointerCapture = function () {};
  window.HTMLElement.prototype.releasePointerCapture = function () {};
  window.HTMLElement.prototype.hasPointerCapture = function () { return false; };
  window.addEventListener('error', event => runtimeErrors.push(event.error || new Error(event.message)));
  window.addEventListener('unhandledrejection', event => runtimeErrors.push(event.reason));
  const requests = [];
  const downloads = [];
  const objectUrls = new Map();
  const nativeCreateObjectURL = URL.createObjectURL;
  const nativeRevokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = blob => {
    const value = nativeCreateObjectURL(blob);
    objectUrls.set(value, blob);
    return value;
  };
  URL.revokeObjectURL = value => { objectUrls.delete(value); nativeRevokeObjectURL(value); };
  const anchorClick = window.HTMLAnchorElement.prototype.click;
  window.HTMLAnchorElement.prototype.click = function () {
    if (this.download) { downloads.push({name: this.download, blob: objectUrls.get(this.href)}); return; }
    return anchorClick.call(this);
  };
  let cookie = '';
  let csrf = '';
  const nodeFetch = globalThis.fetch;
  const localFetch = async (input, options = {}) => {
    let url = new URL(typeof input === 'string' ? input : input.url || String(input), base);
    // Native imports execute the built JS from disk. Vite derives lazy preload
    // URLs from import.meta.url; map only this build's assets to real local HTTP.
    if (url.protocol === 'file:') {
      const assetRoot = pathToFileURL(join(appOptions.distDir, 'assets') + '/').href;
      if (url.href.startsWith(assetRoot)) url = new URL(`/assets/${url.href.slice(assetRoot.length)}`, base);
      else if (/^\/assets\/[^/]+\.(?:js|css)$/u.test(url.pathname)) url = new URL(url.pathname, base);
      else throw new Error('Asset fora do build de QA.');
    }
    if (url.origin !== base) throw new Error(`Requisição externa proibida no QA: ${url.origin}`);
    const headers = new Headers(options.headers);
    if (cookie) headers.set('cookie', cookie);
    headers.set('origin', base);
    const entry = {path: url.pathname + url.search, method: options.method || 'GET', body: options.body, headers};
    requests.push(entry);
    const response = await responseOverride?.({url, options: {...options, headers}, fetch: nodeFetch})
      || await nodeFetch(url, {...options, headers});
    entry.status = response.status;
    const incoming = response.headers.get('set-cookie');
    if (incoming !== null) cookie = incoming.split(';')[0];
    if (response.headers.get('content-type')?.includes('application/json')) {
      entry.result = await response.clone().json();
      csrf = entry.result?.data?.csrfToken || csrf;
    }
    return response;
  };
  expose('fetch', localFetch);
  window.fetch = localFetch;
  // JSDOM does not load CSS by default. Validate lazy chunk styles over the
  // same real HTTP server, then signal load so Vite can resolve its import.
  const assetObserver = new window.MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node.nodeName !== 'LINK' || node.rel !== 'stylesheet') continue;
      localFetch(node.href).then(response => {
        if (!response.ok) throw new Error(`CSS do build indisponível: ${response.status}`);
        node.dispatchEvent(new window.Event('load'));
      }).catch(error => {runtimeErrors.push(error); node.dispatchEvent(new window.Event('error'));});
    }
  });
  assetObserver.observe(window.document.head, {childList: true});
  t.after(async () => {
    assetObserver.disconnect();
    dom.window.close();
    // Cada arquivo é um processo isolado node:test. Conservamos os globals até
    // o encerramento para os cleanups assíncronos do React/Spectrum.
    await app.close();
    await rm(directory, {recursive: true, force: true});
  });
  const entry = html.match(/<script[^>]+src="([^"]+)"/)?.[1];
  assert.ok(entry?.startsWith('/assets/'), 'Bundle de produção deve estar referenciado no HTML.');
  await import(`${pathToFileURL(resolve(appOptions.distDir, `.${entry}`)).href}?qa=${Date.now()}`);
  return {
    get app() { return app; }, window, document: window.document, requests, downloads, runtimeErrors, directory,
    get base() { return base; },
    async api(path, {method = 'GET', body, key = crypto.randomUUID()} = {}) {
      const response = await localFetch(`/api${path}`, {
        method,
        headers: {'content-type': 'application/json', 'x-csrf-token': csrf, 'idempotency-key': key},
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
      });
      return {status: response.status, ...(await response.json())};
    },
    async restart(overrides = {}) {
      await app.close();
      Object.assign(appOptions, overrides);
      app = await createApplication(appOptions);
      address = await app.listen({port: address.port});
      base = `http://127.0.0.1:${address.port}`;
    },
    text() { return window.document.body.textContent.replace(/\s+/gu, ' ').trim(); },
    async route(path) {
      window.location.hash = `/${path}`;
      await new Promise(resolve => setTimeout(resolve, 50));
    },
  };
}

export function button(f, name, root = f.document) {
  const matches = [...root.querySelectorAll('button')].filter(element => element.textContent.trim() === name || element.getAttribute('aria-label') === name);
  assert.ok(matches.length, `Botão não encontrado: ${name}. Disponíveis: ${[...root.querySelectorAll('button')].map(x => x.textContent.trim()).join(' | ')}`);
  return matches[0];
}
export async function click(f, elementOrName, root) {
  const element = typeof elementOrName === 'string' ? button(f, elementOrName, root) : elementOrName;
  assert.ok(element, 'Elemento clicável precisa existir.');
  element.dispatchEvent(new f.window.MouseEvent('click', {bubbles: true, cancelable: true, detail: 0}));
  await new Promise(resolve => setTimeout(resolve, 25));
}
export function field(f, label, root = f.document) {
  const match = [...root.querySelectorAll('label')].find(node => [node.textContent, node.querySelector(':scope > span')?.textContent].some(text => text?.trim().replace(/\s*\*$/, '') === label));
  const input = match && (root.querySelector(`[id="${match.htmlFor}"]`) || match.querySelector('input,textarea,select'));
  const byAria = [...root.querySelectorAll('input,textarea,select')].find(node => node.getAttribute('aria-label') === label);
  assert.ok(input || byAria, `Campo não encontrado: ${label}. Labels: ${[...root.querySelectorAll('label')].map(node => node.textContent.trim()).join(' | ')}`);
  return input || byAria;
}
export async function fill(f, labelOrElement, value, root) {
  const element = typeof labelOrElement === 'string' ? field(f, labelOrElement, root) : labelOrElement;
  const prototype = element.tagName === 'TEXTAREA' ? f.window.HTMLTextAreaElement.prototype : f.window.HTMLInputElement.prototype;
  element.focus();
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
  element.dispatchEvent(new f.window.InputEvent('input', {bubbles: true, inputType: 'insertText', data: String(value)}));
  element.dispatchEvent(new f.window.Event('change', {bubbles: true}));
  element.blur();
  await new Promise(resolve => setTimeout(resolve, 25));
}
export async function submit(f, name, root = f.document.querySelector('[role="dialog"]') || f.document) {
  const element = button(f, name, root);
  assert.equal(element.type, 'submit');
  element.form.requestSubmit(element);
  await new Promise(resolve => setTimeout(resolve, 25));
}

export async function choose(f, label, optionText) {
  const labelled = [...f.document.querySelectorAll('[aria-labelledby]')].filter(node => {
    const texts = node.getAttribute('aria-labelledby').split(/\s+/u).map(id => f.document.getElementById(id)?.textContent.trim());
    return texts.includes(label);
  });
  const combo = labelled.find(node => node.tagName === 'INPUT' && node.getAttribute('role') === 'combobox');
  if (combo) {
    await fill(f, combo, optionText);
    combo.focus();
    combo.dispatchEvent(new f.window.KeyboardEvent('keydown', {key: 'ArrowDown', code: 'ArrowDown', bubbles: true, cancelable: true}));
  } else {
    const picker = labelled.find(node => node.tagName === 'BUTTON' || node.getAttribute('role') === 'combobox');
    assert.ok(picker, `Seletor não encontrado: ${label}`);
    // Picker expõe um select nativo para integração de formulário. Sem layout
    // real, a lista virtualizada do Spectrum pode renderizar só a primeira opção.
    // Neste caso usamos o evento DOM do select, não handlers internos de React.
    const pickerScope = f.document.querySelector('[role="dialog"]') || f.document;
    const native = [...pickerScope.querySelectorAll('select')].find(node =>
      [...node.options].some(option => option.textContent.trim() === optionText));
    if (native) {
      const option = [...native.options].find(option => option.textContent.trim() === optionText);
      Object.getOwnPropertyDescriptor(f.window.HTMLSelectElement.prototype, 'value').set.call(native, option.value);
      native.dispatchEvent(new f.window.Event('change', {bubbles: true}));
      await new Promise(resolve => setTimeout(resolve, 50));
      return;
    }
    await click(f, picker);
  }
  const option = await until(() => [...f.document.querySelectorAll('[role="option"]')].find(node => node.textContent.trim().includes(optionText)), `opção ${optionText} de ${label}`).catch(error => {
    throw new Error(`${error.message}. Opções: ${[...f.document.querySelectorAll('[role="option"]')].map(node => node.textContent.trim()).join(' | ')}`);
  });
  await click(f, option);
  await new Promise(resolve => setTimeout(resolve, 50));
}
