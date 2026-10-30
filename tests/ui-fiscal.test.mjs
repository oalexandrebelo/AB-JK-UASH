import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, until, fill, click, choose, button, field, submit, uiQaAvailable, uiQaSkipReason} from './ui-helpers.mjs';
import {draftInput, enabledEnv} from './fiscal-helpers.mjs';

test('fiscal no bundle: prepara sem emitir, valida tomador, cancela e reconcilia resultado incerto', {timeout:90000,skip:!uiQaAvailable && uiQaSkipReason}, async t => {
  const providerCalls = [];
  let failBrowserResponse = false;
  const f = await fixture(t,{
    application:{fiscalEnv:{}},
    responseOverride:async ({url,options,fetch}) => {
      if (failBrowserResponse && url.pathname.endsWith('/submit') && options.method === 'POST') {
        failBrowserResponse = false;
        await fetch(url,options);
        throw new TypeError('Resposta perdida após o processamento HTTP de teste');
      }
      return null;
    },
  });
  await until(() => f.text().includes('Prepare a operação JK'),'setup vazio');
  assert.ok(!f.text().includes('Token de configuração'),'Instalação sem token não deve exibir campo.');
  await fill(f,'Seu nome','Administrador QA Fiscal');
  await fill(f,'E-mail','qa-fiscal@example.test');
  await fill(f,'Senha','Senha-sintetica-12345');
  await submit(f,'Criar acesso de administrador');
  await until(() => f.document.querySelector('[aria-label="Navegação principal"]'),'sessão fiscal');
  const create = async (path,body) => {
    const result = await f.api(path,{method:'POST',body});
    assert.equal(result.status,201,JSON.stringify(result));
    return result.data.item;
  };
  const customer = await create('/customers',{name:'Tomador comercial QA'});
  const vehicle = await create('/vehicles',{customerId:customer.id,plate:'FIS1A23',model:'Veículo QA'});
  const service = await create('/services',{name:'Serviço QA',priceCents:12345});
  const newOrder = () => create('/orders',{customerId:customer.id,vehicleId:vehicle.id,items:[{serviceId:service.id,quantity:1}]});
  const order = await newOrder();
  await f.route('fiscal');
  await until(() => f.text().includes('Emissão desativada'),'fiscal desativado por padrão');
  assert.ok([...f.document.querySelectorAll('[aria-label="Navegação principal"] a')].some(a => a.textContent.includes('DPS / NFS-e')));
  assert.ok([...f.document.querySelectorAll('[aria-label="Navegação principal"] a')].some(a => a.textContent.includes('Pós-pago')));
  await click(f,'Preparar rascunho');
  await until(() => f.text().includes('Selecionar OS 0001'),'ordem elegível listada');
  await click(f,'Selecionar OS 0001');
  for (const [label,value] of [
    ['CPF/CNPJ do tomador','12345678900'],['Nome / razão social do tomador','Pessoa Fiscal Fictícia'],
    ['Município do tomador (IBGE)','3550308'],['CEP do tomador','01001-000'],
    ['Logradouro do tomador','Rua de Teste'],['Número do endereço','10'],['Bairro do tomador','Centro'],
    ['Data e hora de emissão','2026-10-20T12:00'],['Data de competência','2026-10-20'],
    ['Série da DPS','999'],['Número da DPS','1001'],['CNPJ do prestador','11.222.333/0001-81'],
    ['Município emissor (IBGE)','3550308'],['Município da prestação (IBGE)','3550308'],
    ['Código de tributação nacional do ISS','140101'],['Código NBS','120019000'],
    ['Justificativa da revisão fiscal','Enquadramento fictício para o teste de interface.'],
  ]) await fill(f,label,value);
  for (const [label,value] of [
    ['Emitente da DPS','1 · Prestador'],['Opção pelo Simples Nacional','3 · ME/EPP optante'],
    ['Regime de apuração do Simples Nacional','1 · Tributos federais e ISS pelo Simples'],
    ['Regime especial de tributação','0 · Nenhum'],['Tributação do ISS','1 · Operação tributável'],
    ['Retenção do ISS','1 · Não retido'],['IBS/CBS exigido nesta operação?','Não, registrar a justificativa'],
    ['Tratamento do desconto','Sem desconto na ordem'],
  ]) await choose(f,label,value);
  const reviewLabel = 'Conferi os dados e a revisão fiscal. Entendo que salvar este rascunho não emite uma NFS-e.';
  await click(f,field(f,reviewLabel));
  await submit(f,'Salvar rascunho sem emitir');
  await until(() => f.text().includes('CPF ou CNPJ válido'),'CPF incorreto bloqueado');
  assert.equal(f.requests.filter(r => r.path === '/api/fiscal/drafts' && r.method === 'POST').length,0);
  await fill(f,'CPF/CNPJ do tomador','123.456.789-09');
  await click(f,field(f,reviewLabel));
  await submit(f,'Salvar rascunho sem emitir');
  await until(() => f.text().includes('Rascunho salvo no sistema'),'preparação concluída sem transmissão');
  const draftWrite = f.requests.find(r => r.path === '/api/fiscal/drafts' && r.method === 'POST');
  assert.equal(draftWrite.status,201,JSON.stringify(draftWrite.result));
  const firstDraft = draftWrite.result.data.draft;
  assert.equal(firstDraft.status,'prepared');
  assert.equal(firstDraft.orderId,order.id);
  assert.equal(JSON.parse(draftWrite.body).customer.taxId,'12345678909');
  assert.equal(JSON.parse(draftWrite.body).fiscal.cnpj_prestador,'11222333000181');
  assert.equal(JSON.parse(draftWrite.body).fiscal.data_emissao,'2026-10-20T15:00:00Z');
  assert.equal(button(f,'Enviar ao provedor').disabled,true);
  assert.equal(f.requests.filter(r => r.path.endsWith('/submit')).length,0);
  assert.ok(!f.text().includes('12345678909'),'Detalhe apresenta somente documento mascarado.');
  await click(f,'Cancelar rascunho');
  await click(f,'Voltar sem confirmar');
  assert.equal(f.requests.filter(r => r.path.endsWith('/cancel')).length,0);
  await click(f,'Cancelar rascunho');
  await click(f,'Confirmar cancelamento do rascunho');
  await until(() => f.text().includes('Nenhuma nota fiscal foi cancelada'),'cancelamento do rascunho explícito');
  assert.equal((await f.api(`/fiscal/drafts/${firstDraft.id}`)).data.draft.payloadRetained,false);

  const nextOrder = await newOrder();
  const nextDraftResponse = await f.api('/fiscal/drafts',{method:'POST',body:draftInput(nextOrder.id,1002)});
  assert.equal(nextDraftResponse.status,201);
  await f.restart({
    fiscalEnv:enabledEnv,
    fiscalTransport:async operation => {
      providerCalls.push({method:operation.method,path:operation.path});
      if (operation.method === 'POST') throw new Error('Falha sintética do transporte');
      return {statusCode:200,body:{status:'autorizado'}};
    },
  });
  await click(f,'Voltar aos rascunhos');
  await click(f,'Atualizar');
  await until(() => f.text().includes('Envio habilitado'),'configuração de teste habilitada');
  const nextDraftRow = await until(() => [...f.document.querySelectorAll('table[aria-label="Rascunhos fiscais"] tbody tr')].find(row => row.querySelector('strong')?.textContent.startsWith('DPS 1002 ·')),'segundo rascunho atualizado na listagem');
  await click(f,'Conferir rascunho',nextDraftRow);
  await until(() => f.text().includes('DPS 1002'),'segundo rascunho aberto');
  await click(f,'Enviar ao provedor');
  assert.equal(button(f,'Confirmar envio ao provedor').disabled,true);
  await click(f,'Voltar sem confirmar');
  assert.equal(providerCalls.length,0,'Abrir e dispensar a confirmação não transmite.');
  await click(f,'Enviar ao provedor');
  await click(f,field(f,'Conferi a empresa, o tomador, a classificação fiscal, os valores e o ambiente. Autorizo este envio.'));
  failBrowserResponse = true;
  await click(f,'Confirmar envio ao provedor');
  await until(() => f.text().includes('A resposta do envio não chegou ao navegador'),'resposta HTTP perdida tratada');
  assert.equal(button(f,'Enviar ao provedor').disabled,true);
  assert.equal(providerCalls.filter(r => r.method === 'POST').length,1);
  await click(f,'Atualizar estado');
  await until(() => f.text().includes('O resultado do envio não foi confirmado'),'estado incerto recuperado por GET');
  assert.ok(![...f.document.querySelectorAll('button')].some(b => b.textContent === 'Enviar ao provedor'));
  assert.equal(button(f,'Consultar provedor').disabled,false);
  await click(f,'Consultar provedor');
  await until(() => f.text().includes('Este resultado não tem validade fiscal'),'autorização de teste não confundida com nota válida');
  assert.equal(providerCalls.filter(r => r.method === 'POST').length,1,'Reconciliação nunca repete o POST externo.');
  assert.equal(providerCalls.filter(r => r.method === 'GET').length,1);
  const reconcile = f.requests.find(r => r.path.endsWith('/reconcile'));
  assert.equal(reconcile.status,200);
  assert.equal(reconcile.result.data.draft.fiscalValidity,'test_without_fiscal_validity');

  await t.test('paginação fiscal usa total porque o contrato não tem hasMore',async () => {
    for (let i=0;i<24;i++) {
      const item = await newOrder();
      const result = await f.api('/fiscal/drafts',{method:'POST',body:draftInput(item.id,1100+i)});
      assert.equal(result.status,201);
    }
    await click(f,'Voltar aos rascunhos');
    await until(() => f.text().includes('1–25 de 26 registros'),'primeira página fiscal');
    assert.equal(button(f,'Próxima').disabled,false);
    await click(f,'Próxima');
    await until(() => f.text().includes('26–26 de 26 registros'),'segunda página fiscal');
    assert.equal(button(f,'Próxima').disabled,true);
    assert.equal(button(f,'Anterior').disabled,false);
  });
  await t.test('operador não recebe navegação fiscal nem carrega o endpoint pela rota direta',async () => {
    const account = await f.api('/users',{method:'POST',body:{name:'Operador QA',email:'qa-operator@example.test',password:'Senha-sintetica-12345',role:'operator'}});
    assert.equal(account.status,201);
    await click(f,'Sair');
    await until(() => f.text().includes('Vamos começar o dia?'),'login do operador');
    await fill(f,'E-mail','qa-operator@example.test');
    await fill(f,'Senha','Senha-sintetica-12345');
    const before = f.requests.length;
    await submit(f,'Entrar na operação');
    await until(() => f.text().includes('Área de gestão'),'rota fiscal negada ao operador');
    assert.ok(![...f.document.querySelectorAll('[aria-label="Navegação principal"] a')].some(a => a.textContent.includes('DPS / NFS-e')));
    assert.equal(f.requests.slice(before).filter(r => r.path.startsWith('/api/fiscal/')).length,0);
  });
  assert.deepEqual(f.runtimeErrors,[]);
});
