import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, until, fill, click, button, field, submit, uiQaAvailable, uiQaSkipReason} from './ui-helpers.mjs';

test('revisão UI: foco, escrita pendente, falhas de leitura e paginação preservam o trabalho', {timeout:90000,skip:!uiQaAvailable && uiQaSkipReason}, async t => {
  let holdCash = false;
  let cashIntercepted = false;
  let releaseCash;
  let failCustomers = false;
  let failCashCurrent = false;
  let failPayrollDetail = false;
  const cashGate = new Promise(resolve => {releaseCash = resolve;});
  const f = await fixture(t, {responseOverride:async ({url,options,fetch}) => {
    if (holdCash && url.pathname === '/api/cash/open' && options.method === 'POST') {
      const response = await fetch(url,options);
      cashIntercepted = true;
      await cashGate;
      return response;
    }
    if (failCashCurrent && url.pathname === '/api/cash/current'
      || failCustomers && url.pathname === '/api/customers' && !options.method?.match(/POST|PATCH/u)
      || failPayrollDetail && /^\/api\/payroll\/[^/]+$/u.test(url.pathname) && !options.method?.match(/POST|PATCH/u)) {
      return new Response(JSON.stringify({ok:false,error:{code:'QA_READ_FAILURE',message:'Falha de leitura QA. Tente novamente.'}}), {status:503,headers:{'content-type':'application/json'}});
    }
    return null;
  }});
  t.after(() => releaseCash());
  await until(() => f.text().includes('Prepare a operação JK'),'primeiro acesso');
  await fill(f,'Seu nome','QA Fluxos');
  await fill(f,'E-mail','qa-fluxos@example.test');
  await fill(f,'Senha','Senha-sintetica-12345');
  await submit(f,'Criar acesso de administrador');
  await until(() => f.document.querySelector('[aria-label="Navegação principal"]'),'sessão criada');
  const create = async (path,body) => {
    const result = await f.api(path,{method:'POST',body});
    assert.equal(result.status,201,JSON.stringify(result));
    return result.data.item;
  };
  const press = (node,key) => node.dispatchEvent(new f.window.KeyboardEvent('keydown',{key,code:key,bubbles:true,cancelable:true}));

  await t.test('atalho de conteúdo mantém a rota; abas usam foco e semântica de painel', async () => {
    await f.route('settings');
    await until(() => f.text().includes('Dados da empresa'),'configurações');
    const hash = f.window.location.hash;
    await click(f,f.document.querySelector('.skip-link'));
    assert.equal(f.document.activeElement.id,'main-content');
    assert.equal(f.window.location.hash,hash);
    const first = f.document.getElementById('settings-tab-business');
    first.focus();
    press(first,'ArrowRight');
    await until(() => f.text().includes('Sua conta'),'aba da conta');
    assert.equal(f.document.activeElement.id,'settings-tab-account');
    assert.equal(f.document.querySelectorAll('[role="tab"][tabindex="0"]').length,1);
    const panel = f.document.getElementById('settings-panel');
    assert.equal(panel.getAttribute('aria-labelledby'),'settings-tab-account');
    press(f.document.activeElement,'End');
    await until(() => f.document.activeElement.id === 'settings-tab-audit','última aba');
    press(f.document.activeElement,'Home');
    await until(() => f.document.activeElement.id === 'settings-tab-business','primeira aba');
    assert.equal(first.getAttribute('aria-selected'),'true');
    assert.ok(f.document.querySelector('[aria-label="Navegação principal"]'));
    await click(f, 'Abrir navegação');
    await until(() => f.document.querySelector('[role="dialog"]'), 'menu móvel acessível');
    assert.equal(f.document.querySelectorAll('.mobile-nav-groups [aria-current="page"]').length, 1);
    assert.equal(f.document.querySelector('.mobile-nav-groups [aria-current="page"]').getAttribute('href'), '#/settings');
    const mobileCustomer = f.document.querySelector('.mobile-nav-groups a[href="#/customers"]');
    await click(f, mobileCustomer);
    await until(() => !f.document.querySelector('[role="dialog"]'), 'menu fecha ao navegar');
    await until(() => f.window.location.hash === '#/customers', 'link do menu móvel navega');
  });

  await t.test('salvamento pendente bloqueia Escape e cancelamento, sem escrita duplicada', async () => {
    failCashCurrent = true;
    await f.route('cash');
    await until(() => f.text().includes('Falha de leitura QA'),'falha de consulta do caixa');
    assert.ok(!f.text().includes('Seu caixa está fechado'),'Falha de consulta não pode afirmar que o caixa está fechado.');
    assert.equal(button(f,'Abrir caixa').disabled,true);
    failCashCurrent = false;
    await click(f,'Tentar novamente');
    await until(() => f.text().includes('Seu caixa está fechado'),'caixa vazio confirmado');
    await click(f,'Abrir caixa');
    await fill(f,'Valor inicial em dinheiro','25,00');
    holdCash = true;
    const before = f.requests.length;
    try {
      await submit(f,'Confirmar abertura');
      await until(() => cashIntercepted,'resposta de abertura retida');
      const dialog = f.document.querySelector('[role="dialog"]');
      await until(() => dialog.querySelector('[aria-busy="true"]'),'formulário com estado ocupado');
      assert.equal(button(f,'Cancelar').disabled,true);
      assert.equal(field(f,'Valor inicial em dinheiro').disabled,true);
      press(dialog,'Escape');
      await new Promise(resolve => setTimeout(resolve,50));
      assert.equal(f.document.querySelector('[role="dialog"]'),dialog);
    } finally {holdCash = false;releaseCash();}
    await until(() => !f.document.querySelector('[role="dialog"]'),'abertura confirmada');
    await until(() => f.text().includes('Caixa aberto'),'lista reflete abertura');
    assert.equal(f.requests.slice(before).filter(row => row.path === '/api/cash/open' && row.method === 'POST').length,1);
    assert.equal((await f.api('/cash/current')).data.item.openingCents,2500);
  });

  await t.test('falha ao ler folha bloqueia o envio que apagaria ajustes existentes', async () => {
    const employee = await create('/employees',{name:'Profissional QA',baseSalaryCents:200000});
    const payroll = await create('/payroll',{period:'2026-10',adjustments:[{employeeId:employee.id,extrasCents:1234,deductionsCents:345}]});
    await f.route('payroll');
    await until(() => f.document.querySelector('table[aria-label="Folhas locais"] tbody tr'),'folha listada');
    failPayrollDetail = true;
    await click(f,'Ajustar');
    await until(() => f.text().includes('Falha de leitura QA'),'falha no detalhe');
    assert.equal(button(f,'Salvar rascunho').disabled,true);
    assert.equal(field(f,'Observações').disabled,true);
    assert.equal(f.requests.filter(row => row.path === `/api/payroll/${payroll.id}` && row.method === 'PATCH').length,0);
    failPayrollDetail = false;
    await click(f,'Tentar novamente');
    await until(() => f.text().includes('Profissional QA') && !button(f,'Salvar rascunho').disabled,'ajustes carregados após retry');
    assert.match(field(f,'Extras').value,/12,34/u);
    assert.match(field(f,'Descontos').value,/3,45/u);
    await submit(f,'Salvar rascunho');
    await until(() => !f.document.querySelector('[role="dialog"]'),'ajuste salvo');
    const stored = (await f.api(`/payroll/${payroll.id}`)).data.item.lines[0];
    assert.equal(stored.extrasCents,1234);
    assert.equal(stored.deductionsCents,345);
  });

  await t.test('erro de lista não afirma cadastro vazio e o retry recupera a criação', async () => {
    failCustomers = true;
    await f.route('customers');
    await until(() => f.text().includes('Falha de leitura QA'),'erro de clientes');
    assert.ok(!f.text().includes('Seu primeiro cliente começa aqui'));
    failCustomers = false;
    await click(f,'Tentar novamente');
    await until(() => f.text().includes('Seu primeiro cliente começa aqui'),'lista vazia confirmada pelo servidor');
    await click(f,'Cadastrar cliente');
    await fill(f,'Nome / razão social','Cliente salvo pela UI');
    await submit(f,'Salvar cliente');
    await until(() => !f.document.querySelector('[role="dialog"]'),'cadastro salvo');
    await until(() => f.document.querySelector('table[aria-label="Clientes"]')?.textContent.includes('Cliente salvo pela UI'),'lista atualizada');
  });

  await t.test('trocar filtro busca somente a primeira página e reduzir o total corrige a página', async () => {
    for(let index=0;index<26;index++)await create('/customers',{name:`Paginação QA ${String(index).padStart(2,'0')}`});
    await fill(f,'Buscar Clientes','Paginação QA');
    await until(() => f.text().includes('1–25 de 26 registros'),'primeira página do filtro');
    await click(f,'Próxima');
    await until(() => f.text().includes('26–26 de 26 registros'),'segunda página do filtro');
    const before = f.requests.length;
    await fill(f,'Buscar Clientes','Cliente salvo pela UI');
    await until(() => f.text().includes('1–1 de 1 registros'),'novo filtro na página inicial');
    const searches = f.requests.slice(before).filter(row => row.path.startsWith('/api/customers?')).map(row => new URL(row.path,f.base));
    assert.ok(searches.length>0);
    assert.ok(searches.every(url => url.searchParams.get('offset') === '0'),'Nenhum request com offset anterior pode escapar no filtro novo.');
    await fill(f,'Buscar Clientes','Paginação QA');
    await until(() => f.text().includes('1–25 de 26 registros'),'retorno ao filtro também reinicia');
    await click(f,'Próxima');
    await until(() => f.text().includes('26–26 de 26 registros'),'última página antes de alterar o total');
    const last = (await f.api('/customers?q=Paginação%20QA&limit=25&offset=25')).data.items[0];
    assert.equal((await f.api(`/customers/${last.id}`,{method:'PATCH',body:{version:last.version,name:'Renomeado fora do filtro'}})).status,200);
    await click(f,'Atualizar');
    await until(() => f.text().includes('1–25 de 25 registros'),'página válida após redução do total');
    assert.equal(f.document.querySelectorAll('table[aria-label="Clientes"] tbody tr').length,25);
  });
  assert.deepEqual(f.runtimeErrors,[]);
});
