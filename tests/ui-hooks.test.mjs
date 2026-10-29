import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fixture, until, uiQaAvailable, uiQaSkipReason} from './ui-helpers.mjs';

let reactAvailable = false;
try { createRequire(import.meta.url).resolve('react-dom/client'); reactAvailable = true; } catch {}
const skip = !uiQaAvailable ? uiQaSkipReason : !reactAvailable ? 'QA de hooks requer npm ci das dependências de desenvolvimento do projeto.' : false;

test('hooks reais: concorrência, retry idempotente, respostas obsoletas, limpeza de estado e fuso', {timeout: 30000, skip}, async t => {
  const f = await fixture(t);
  const React = await import('react');
  const {createRoot} = await import('react-dom/client');
  const api = await import('../src/lib/api.ts');
  const session = await f.api('/setup', {method: 'POST', body: {name: 'QA Hooks', email: 'qa-hooks@example.test', password: 'Senha-sintetica-12345'}});
  assert.equal(session.status, 201);
  api.setSession(session.data);
  const host = f.document.createElement('div');
  f.document.body.append(host);
  const root = createRoot(host);
  t.after(() => root.unmount());
  let mutation;
  function MutationHarness() { mutation = api.useMutation(); return null; }
  root.render(React.createElement(MutationHarness));
  await until(() => mutation, 'hook de mutação montado');

  await t.test('duas chamadas no mesmo tick geram uma única escrita', async () => {
    const before = f.requests.length;
    const first = mutation.mutate('/customers', {name: 'Cliente de duplo clique'});
    const second = mutation.mutate('/customers', {name: 'Cliente que não deve ser salvo'});
    assert.equal(await second, null);
    assert.equal((await first).item.name, 'Cliente de duplo clique');
    const writes = f.requests.slice(before).filter(row => row.path === '/api/customers' && row.method === 'POST');
    assert.equal(writes.length, 1);
    assert.equal((await f.api('/customers')).data.items.length, 1);
  });

  await t.test('perda da resposta depois do commit reutiliza chave e não duplica registro', async () => {
    const actualFetch = globalThis.fetch;
    let drop = true;
    globalThis.fetch = async (path, options) => {
      const response = await actualFetch(path, options);
      if (drop && path === '/api/customers' && options.method === 'POST') {
        drop = false;
        throw new TypeError('Simulação de perda da resposta após commit');
      }
      return response;
    };
    try {
      const before = f.requests.length;
      const body = {name: 'Cliente retry idempotente'};
      assert.equal(await mutation.mutate('/customers', body), null);
      await until(() => !mutation.pending, 'falha de comunicação exibida');
      assert.match(mutation.error, /comunicar/u);
      const retried = await mutation.mutate('/customers', body);
      assert.equal(retried.item.name, body.name);
      const writes = f.requests.slice(before).filter(row => row.path === '/api/customers' && row.method === 'POST');
      assert.equal(writes.length, 2);
      assert.equal(writes[0].headers.get('idempotency-key'), writes[1].headers.get('idempotency-key'));
      assert.equal((await f.api('/customers?q=retry')).data.items.length, 1);
    } finally {globalThis.fetch = actualFetch;}
  });

  const service = await f.api('/services', {method: 'POST', body: {name: 'Serviço do recurso mais novo', priceCents: 12345}});
  assert.equal(service.status, 201);
  let resource;
  const renders = [];
  function ResourceHarness({path}) {
    resource = api.useResource(path);
    renders.push({path, data: resource.data, error: resource.error, loading: resource.loading});
    return React.createElement('div', null, resource.data ? JSON.stringify(resource.data) : resource.error || 'loading');
  }
  await t.test('mudança de rota não expõe dados anteriores nem aceita resposta atrasada', async () => {
    root.render(React.createElement(ResourceHarness, {path: '/customers?q=duplo&limit=1'}));
    await until(() => resource?.data?.items?.[0]?.name === 'Cliente de duplo clique', 'primeiro recurso');
    const actualFetch = globalThis.fetch;
    let release;
    let intercepted;
    const gate = new Promise(resolve => { release = resolve; });
    globalThis.fetch = async (path, options) => {
      // HTTP continua real; omitir signal aqui reproduz uma resposta já concluída
      // ou um adaptador que não cancela, para testar a guarda do hook.
      const response = await actualFetch(path, path === '/api/customers?q=retry' ? {...options, signal: undefined} : options);
      if (path === '/api/customers?q=retry') { intercepted = true; await gate; }
      return response;
    };
    try {
      root.render(React.createElement(ResourceHarness, {path: '/customers?q=retry'}));
      await until(() => intercepted, 'resposta antiga retida');
      root.render(React.createElement(ResourceHarness, {path: '/services?limit=1'}));
      await until(() => resource?.data?.items?.[0]?.name === service.data.item.name, 'recurso mais novo');
      release();
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(resource.data.items[0].name, service.data.item.name);
      assert.ok(renders.filter(row => row.path === '/services?limit=1').every(row => row.data === null || row.data.items[0].name === service.data.item.name));
      assert.ok(renders.filter(row => row.path === '/customers?q=retry').every(row => row.data === null));
    } finally {release(); globalThis.fetch = actualFetch;}
  });
  await t.test('recurso desativado remove erro e dados, sem requisição adicional', async () => {
    root.render(React.createElement(ResourceHarness, {path: '/missing-qa'}));
    await until(() => resource?.error, 'erro 404 renderizado');
    const before = f.requests.length;
    root.render(React.createElement(ResourceHarness, {path: null}));
    await until(() => resource?.error === null && resource?.data === null && resource?.loading === false, 'estado desativado limpo');
    assert.equal(f.requests.length, before);
  });
  await t.test('datas seguem São Paulo e valores monetários preservam centavos', () => {
    assert.equal(api.businessDateTimeInput('2026-10-20T02:30:00.000Z'), '2026-10-19T23:30');
    assert.equal(api.businessDateTimeIso('2026-10-19T23:30'), '2026-10-20T02:30:00.000Z');
    assert.equal(api.businessDateTimeIso('2026-01-15T08:45'), '2026-01-15T11:45:00.000Z');
    assert.equal(api.businessDateTimeIso(''), null);
    assert.equal(api.dateOnly('2026-10-20'), '20/10/2026');
    assert.match(api.dateTime('2026-10-20T02:30:00.000Z'), /19\/10\/2026.*23:30/u);
    assert.equal(api.money(12345).replace(/\s/gu, ' '), 'R$ 123,45');
    assert.equal(api.money(1).replace(/\s/gu, ' '), 'R$ 0,01');
    assert.equal(api.money(0).replace(/\s/gu, ' '), 'R$ 0,00');
    for(const missing of [undefined, null, '', '   ', NaN, Infinity, 'inválido', false]) assert.equal(api.money(missing), '—');
  });
  assert.deepEqual(f.runtimeErrors, []);
});
