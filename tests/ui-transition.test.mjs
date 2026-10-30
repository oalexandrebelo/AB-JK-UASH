import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, until, fill, click, submit, button, field, uiQaAvailable, uiQaSkipReason} from './ui-helpers.mjs';

test('transição no bundle exige confirmação, persiste pelo HTTP e protege a operação paralela', {timeout:90000, skip:!uiQaAvailable && uiQaSkipReason}, async t => {
  const f = await fixture(t);
  await until(() => f.text().includes('Prepare a operação JK'), 'primeiro acesso');
  await fill(f, 'Seu nome', 'Admin Transição QA');
  await fill(f, 'E-mail', 'transition-admin@example.test');
  await fill(f, 'Senha', 'Senha-sintetica-12345');
  await submit(f, 'Criar acesso de administrador');
  await until(() => f.text().includes('Visão geral'), 'operação autenticada');
  assert.equal((await f.api('/users', {method:'POST', body:{name:'Consulta Transição QA',email:'transition-viewer@example.test',password:'Senha-viewer-12345',role:'viewer'}})).status, 201);
  const writes = () => f.requests.filter(row => row.path === '/api/jk/transition' && row.method === 'PATCH');
  const count = async table => (await f.app.store.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).count;
  const settings = async () => {
    await f.route('settings');
    await until(() => f.text().includes('Transição do Jumpcar'), 'aba de transição');
    await click(f, 'Transição do Jumpcar');
    await until(() => f.text().includes('Uma transição no ritmo da equipe'), 'configuração da transição');
  };

  await settings();
  const initial = (await f.api('/jk/transition')).data;
  assert.equal(initial.mode, 'normal');
  assert.equal(button(f, 'Ativar consulta paralela').disabled, true);
  await click(f, 'Ativar consulta paralela');
  assert.equal(writes().length, 0, 'Sem confirmação não envia alteração.');
  assert.equal((await f.api('/jk/transition')).data.version, initial.version);

  await click(f, field(f, 'Quero manter o Jumpcar como principal e usar o JK para consulta.'));
  await until(() => !button(f, 'Ativar consulta paralela').disabled, 'confirmação libera ativação');
  await click(f, 'Ativar consulta paralela');
  await until(() => f.document.querySelector('aside[aria-label="Modo de operação"]')?.textContent.includes('Jumpcar é o principal'), 'banner após resposta real');
  assert.equal(writes().length, 1);
  assert.equal(writes()[0].status, 200);
  assert.deepEqual(JSON.parse(writes()[0].body), {version:initial.version,mode:'parallel_readonly'});
  assert.equal((await f.api('/jk/transition')).data.mode, 'parallel_readonly');
  const beforeCustomers = await count('customers');
  const denied = await f.api('/customers', {method:'POST',body:{name:'Cadastro bloqueado sintético'}});
  assert.equal(denied.status, 409);
  assert.equal(denied.error.code, 'PARALLEL_READONLY');
  assert.equal(await count('customers'), beforeCustomers);

  await f.route('migration');
  const input = await until(() => f.document.querySelector('input[type="file"]'), 'importação histórica disponível em consulta');
  const dataset = {schemaVersion:1,customers:[{sourceId:'transition-history',name:'Histórico sintético de transição'}]};
  Object.defineProperty(input, 'files', {configurable:true,value:[new File([JSON.stringify(dataset)], 'transition-synthetic.json', {type:'application/json'})]});
  input.dispatchEvent(new f.window.Event('change', {bubbles:true}));
  await until(() => f.text().includes('transition-synthetic.json'), 'arquivo histórico selecionado');
  await click(f, 'Analisar e gerar prévia');
  await until(() => f.text().includes('Pronta para importar'), 'prévia aceita em consulta paralela');
  assert.equal(f.requests.filter(row => row.path === '/api/jk/migration/preview').at(-1).status, 200);
  assert.equal(await count('customers'), beforeCustomers);
  assert.equal(await count('jk_migration_batches'), 0);
  assert.ok(f.document.querySelector('aside[aria-label="Modo de operação"]'), 'Banner permanece em outra página.');

  await settings();
  assert.equal(button(f, 'Ativar operação JK').disabled, true);
  await click(f, 'Ativar operação JK');
  assert.equal(writes().length, 1, 'Retorno à operação também exige confirmação.');
  await click(f, field(f, 'Conferi a transição e quero habilitar as operações no JK.'));
  await click(f, 'Ativar operação JK');
  await until(() => writes().length === 2 && writes()[1].status === 200 && !f.document.querySelector('aside[aria-label="Modo de operação"]'), 'operação restaurada e banner removido');
  const restored = (await f.api('/jk/transition')).data;
  assert.equal(restored.mode, 'normal');
  assert.equal(restored.version, initial.version + 2);
  assert.equal((await f.api('/customers', {method:'POST',body:{name:'Cadastro após transição'}})).status, 201);

  await click(f, 'Sair');
  await until(() => f.text().includes('Vamos começar o dia?'), 'logout administrador');
  await fill(f, 'E-mail', 'transition-viewer@example.test');
  await fill(f, 'Senha', 'Senha-viewer-12345');
  await submit(f, 'Entrar na operação');
  await until(() => f.text().includes('Consulta Transição QA'), 'login consulta');
  await settings();
  assert.ok(f.text().includes('Somente um administrador pode alterar o modo de operação.'));
  assert.equal(f.document.querySelector('.transition-choice input[type="checkbox"]'), null);
  assert.equal([...f.document.querySelectorAll('button')].some(node => /Ativar (consulta paralela|operação JK)/u.test(node.textContent)), false);
  assert.equal((await f.api('/jk/transition', {method:'PATCH',body:{mode:'parallel_readonly',version:restored.version}})).status, 403);
  assert.equal((await f.api('/jk/transition')).data.mode, 'normal');
  assert.equal(f.runtimeErrors.length, 0, f.runtimeErrors.map(error => error.message).join('\n'));
});
