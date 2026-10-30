import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture, until, fill, click, choose, submit, button, field, uiQaAvailable, uiQaSkipReason} from './ui-helpers.mjs';

test('JK no bundle: migração revisada, transporte e integrações bloqueadas com HTTP real', {timeout: 90000, skip: !uiQaAvailable && uiQaSkipReason}, async t => {
  let migrationAvailability = 'available';
  const f = await fixture(t, {application: {fiscalEnv: {}, jkIntegrationsEnv: {}}, responseOverride:async ({url}) => {
    if (url.pathname !== '/api/jk/migration/status' || migrationAvailability === 'available') return null;
    const unavailable = migrationAvailability === 'unavailable';
    return new Response(JSON.stringify(unavailable
      ? {ok:true,data:{supported:false,mode:'historical',source:'jumpcar',scope:'jk',reason:'SQLITE_LOCAL_REQUIRED',limits:{maxBytes:8388608,maxRows:20000}}}
      : {ok:false,error:{code:'QA_READ_FAILURE',message:'Não foi possível confirmar a disponibilidade da migração.'}}),
    {status:unavailable ? 200 : 503,headers:{'content-type':'application/json'}});
  }});
  await until(() => f.text().includes('Prepare a operação JK'), 'primeiro acesso JK');
  await fill(f, 'Seu nome', 'Administrador QA JK');
  await fill(f, 'E-mail', 'qa-jk@example.test');
  await fill(f, 'Senha', 'Senha-sintetica-12345');
  await submit(f, 'Criar acesso de administrador');
  await until(() => f.text().includes('Visão geral'), 'operação JK');
  const create = async (path, body) => {
    const result = await f.api(path, {method: 'POST', body});
    assert.equal(result.status, 201, JSON.stringify(result));
    return result.data.item;
  };
  const count = async table => (await f.app.store.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).count;

  await t.test('suporte indisponível ou não confirmado impede selecionar e enviar arquivos', async () => {
    migrationAvailability = 'unavailable';
    const before = f.requests.length;
    await f.route('migration');
    await until(() => f.text().includes('Esta instalação não oferece esse recurso.'), 'migração indisponível informada');
    assert.equal(f.document.querySelector('input[type="file"]'), null);
    assert.ok(!f.text().includes('Analisar e gerar prévia'));
    assert.ok(!f.text().includes('Consultar histórico'));
    assert.equal(f.requests.slice(before).filter(row => /^\/api\/jk\/migration\/(history|preview|commit)(?:\?|$)/u.test(row.path)).length, 0);

    migrationAvailability = 'failed';
    await click(f, 'Atualizar histórico');
    await until(() => f.text().includes('Não foi possível confirmar a disponibilidade da migração.'), 'falha de disponibilidade informada');
    assert.equal(f.document.querySelector('input[type="file"]'), null);
    assert.ok(!f.text().includes('Esta instalação não oferece esse recurso.'), 'Falha de leitura não confirma incompatibilidade.');

    migrationAvailability = 'available';
    await click(f, 'Tentar novamente');
    await until(() => f.document.querySelector('input[type="file"]'), 'seleção liberada após confirmação do suporte');
    assert.equal(button(f, 'Escolher arquivos').disabled, false);
    migrationAvailability = 'failed';
    await click(f, 'Atualizar histórico');
    await until(() => f.text().includes('Não foi possível confirmar a disponibilidade da migração.'), 'falha posterior bloqueia suporte em cache');
    assert.equal(f.document.querySelector('input[type="file"]'), null);
    migrationAvailability = 'available';
    await click(f, 'Tentar novamente');
    await until(() => f.document.querySelector('input[type="file"]'), 'suporte recuperado');
    assert.equal(f.requests.slice(before).filter(row => /^\/api\/jk\/migration\/(preview|commit)$/u.test(row.path)).length, 0);
  });

  await t.test('prévia não grava, mudança de arquivo invalida confirmação e commit preserva histórico sem recebimento operacional', async () => {
    const date = '2025-01-02T12:00:00.000Z';
    const dataset = {schemaVersion: 1,
      customers: [{sourceId: 'qa-c-1', name: 'Cliente QA Histórico', email: 'historico@example.test'}],
      vehicles: [{sourceId: 'qa-v-1', customerSourceId: 'qa-c-1', plate: 'HST1A23', model: 'Veículo sintético'}],
      services: [{sourceId: 'qa-s-1', name: 'Serviço QA Histórico', priceCents: 5000, durationMinutes: 30}],
      orders: [{sourceId: 'qa-o-1', number: 'QA-H-001', customerSourceId: 'qa-c-1', vehicleSourceId: 'qa-v-1', status: 'delivered', subtotalCents: 5000, discountCents: 0, totalCents: 5000, createdAt: date, deliveredAt: date}],
      orderItems: [{sourceId: 'qa-i-1', orderSourceId: 'qa-o-1', serviceSourceId: 'qa-s-1', name: 'Serviço histórico', quantity: 1, unitPriceCents: 5000, lineTotalCents: 5000, discountCents: 0, netCents: 5000}],
      payments: [{sourceId: 'qa-p-1', orderSourceId: 'qa-o-1', customerSourceId: 'qa-c-1', amountCents: 5000, method: 'pix', createdAt: date}],
    };
    await f.route('migration');
    await until(() => f.text().includes('Migração do Jumpcar'), 'tela de migração');
    const upload = async () => {
      const input = f.document.querySelector('input[type="file"]');
      assert.ok(input, 'FileTrigger precisa expor o controle nativo.');
      Object.defineProperty(input, 'files', {configurable: true, value: [new File([JSON.stringify(dataset)], 'qa-jumpcar.json', {type: 'application/json'})]});
      input.dispatchEvent(new f.window.Event('change', {bubbles: true}));
      await until(() => f.text().includes('qa-jumpcar.json'), 'arquivo selecionado');
      await click(f, 'Analisar e gerar prévia');
      await until(() => f.text().includes('Pronta para importar'), 'prévia válida');
    };
    await upload();
    assert.equal(await count('customers'), 0);
    assert.equal(await count('jk_migration_batches'), 0);
    assert.equal(button(f, 'Confirmar importação').disabled, true);
    await click(f, 'Remover qa-jumpcar.json');
    assert.ok(!f.text().includes('Revise o resultado da análise'));
    assert.ok(!f.text().includes('Confirmar importação'));
    assert.equal(f.requests.filter(r => r.path === '/api/jk/migration/commit').length, 0);
    await upload();
    const preview = f.requests.filter(r => r.path === '/api/jk/migration/preview').at(-1).result.data;
    await click(f, field(f, 'Revisei a prévia e confirmo a importação destes registros para a operação JK.'));
    await click(f, 'Confirmar importação');
    await until(() => f.text().includes('Importação concluída.'), 'importação confirmada');
    const write = f.requests.find(r => r.path === '/api/jk/migration/commit');
    assert.equal(write.status, 201, JSON.stringify(write.result));
    assert.equal(JSON.parse(write.body).previewHash, preview.previewHash);
    for (const table of ['customers', 'vehicles', 'services', 'jk_history_orders', 'jk_history_order_items', 'jk_history_payments', 'jk_migration_batches']) assert.equal(await count(table), 1, table);
    for (const table of ['orders', 'payments', 'cash_movements', 'commission_claims', 'messages']) assert.equal(await count(table), 0, table);
    await click(f, 'Consultar histórico importado');
    await until(() => f.text().includes('QA-H-001'), 'OS no histórico');
  });

  const customer = await create('/customers', {name: 'Cliente QA Transporte', phone: '11999990000'});
  const vehicle = await create('/vehicles', {customerId: customer.id, plate: 'TRP1A23', model: 'Veículo QA Transporte'});
  const service = await create('/services', {name: 'Lavagem QA Atual', priceCents: 6543});
  const employee = await create('/employees', {name: 'Responsável QA Transporte'});
  const order = await create('/orders', {customerId: customer.id, vehicleId: vehicle.id, items: [{serviceId: service.id, quantity: 1}]});

  await t.test('Pix e WhatsApp preparam e cancelam localmente, mantendo envio bloqueado e saldo aberto', async () => {
    await f.route(`orders/${order.id}`);
    await until(() => f.text().includes('Ordem 0001'), 'detalhe da OS');
    await click(f, 'Integrações');
    await until(() => f.text().includes('Preparar cobrança'), 'integrações da OS');
    await click(f, 'Preparar cobrança');
    await submit(f, 'Salvar preparação');
    await until(() => !f.document.querySelector('[role="dialog"]'), 'Pix preparado');
    const pixWrite = f.requests.find(r => r.path === `/api/jk/orders/${order.id}/pix` && r.method === 'POST');
    assert.equal(pixWrite.status, 201, JSON.stringify(pixWrite.result));
    const pix = pixWrite.result.data.item;
    assert.equal(pix.amountCents, 6543);
    assert.equal(pix.canSubmit, false);
    await until(() => f.document.querySelector('table[aria-label="Cobranças Pix"]'), 'cobrança na tabela');
    let pixTable = f.document.querySelector('table[aria-label="Cobranças Pix"]');
    assert.ok(![...pixTable.querySelectorAll('button')].some(node => node.textContent.trim() === 'Enviar'));

    // Synthetic credential files exercise the real readiness/restart path.
    // No submit/reconcile action is invoked while this fixture is enabled.
    const configuration = {version: 1, integrations: [{kind: 'pix-efi', environment: 'production', clientIdFile: 'qa-client.txt', clientSecretFile: 'qa-secret.txt', pixKeyFile: 'qa-pix-key.txt', mtls: {pfxFile: 'qa-mtls.pfx'}}]};
    for (const [name, content] of [['qa-config.json', JSON.stringify(configuration)], ['qa-client.txt', 'fixture-only-client'], ['qa-secret.txt', 'fixture-only-not-a-real-secret'], ['qa-pix-key.txt', '01234567-89ab-cdef-0123-456789abcdef'], ['qa-mtls.pfx', 'fixture-only-not-a-certificate']]) await writeFile(join(f.directory, name), content, {mode: 0o600});
    await f.restart({jkIntegrationsEnv: {AB_JK_SECRETS_ROOT: f.directory, AB_JK_INTEGRATIONS_CONFIG: 'qa-config.json', AB_JK_INTEGRATIONS_ENABLED: 'true', AB_JK_ALLOW_PRODUCTION: 'true'}});
    assert.equal((await f.api('/jk/integrations/readiness')).data.pix.state, 'ready');
    await click(f, 'Atualizar situações');
    await until(() => f.text().includes('A configuração mudou. Cancele esta preparação e prepare novamente.'), 'preparação antiga exige nova revisão após ativação');
    pixTable = f.document.querySelector('table[aria-label="Cobranças Pix"]');
    assert.ok(![...pixTable.querySelectorAll('button')].some(node => node.textContent.trim() === 'Enviar'));
    assert.equal((await f.api(`/jk/pix/${pix.id}`)).data.item.preparationRequiresRefresh, true);
    await click(f, 'Cancelar preparação', pixTable);
    await submit(f, 'Cancelar preparação');
    await until(() => !f.document.querySelector('[role="dialog"]'), 'Pix cancelado localmente');
    assert.equal((await f.api(`/jk/pix/${pix.id}`)).data.item.status, 'cancelled');
    await f.restart({jkIntegrationsEnv: {}});
    await click(f, 'Atualizar situações');

    await click(f, 'Preparar mensagem');
    await fill(f, 'Nome do modelo aprovado no WhatsApp', 'aviso_atendimento_qa');
    await fill(f, 'Parâmetros do corpo, um por linha', 'Cliente QA\nOS 1');
    await submit(f, 'Salvar preparação');
    await until(() => f.text().includes('Confirme a autorização do cliente'), 'consentimento obrigatório');
    assert.equal(f.requests.filter(r => r.path === `/api/jk/orders/${order.id}/messages` && r.method === 'POST').length, 0);
    await click(f, field(f, 'O cliente autorizou esta comunicação sobre o atendimento.'));
    await submit(f, 'Salvar preparação');
    await until(() => !f.document.querySelector('[role="dialog"]'), 'WhatsApp preparado');
    const messageWrite = f.requests.find(r => r.path === `/api/jk/orders/${order.id}/messages` && r.method === 'POST');
    assert.equal(messageWrite.status, 201, JSON.stringify(messageWrite.result));
    const message = messageWrite.result.data.item;
    assert.equal(message.canSubmit, false);
    assert.equal(message.delivery, 'unconfirmed');
    assert.equal(message.recipientMasked, '***0000');
    await until(() => f.document.querySelector('table[aria-label="Mensagens pelo WhatsApp"]'), 'mensagem na tabela');
    const messageTable = f.document.querySelector('table[aria-label="Mensagens pelo WhatsApp"]');
    assert.ok(![...messageTable.querySelectorAll('button')].some(node => node.textContent.trim() === 'Enviar'));
    await click(f, 'Cancelar preparação', messageTable);
    await submit(f, 'Cancelar preparação');
    await until(() => !f.document.querySelector('[role="dialog"]'), 'mensagem cancelada');
    assert.equal((await f.api(`/jk/messages/${message.id}`)).data.item.status, 'cancelled');
    assert.equal(f.requests.filter(r => /\/jk\/.*\/(submit|reconcile)$/.test(r.path)).length, 0);
    assert.equal((await f.api(`/orders/${order.id}`)).data.item.balanceCents, 6543);
    assert.equal(await count('payments'), 0);
  });

  await t.test('transporte criado pela UI persiste responsável/endereço e transita até conclusão auditada', async () => {
    await f.route('deliveries');
    await until(() => f.text().includes('Retiradas e devoluções'), 'agenda de transporte');
    await click(f, 'Novo transporte');
    await choose(f, 'Vincular a', 'Ordem de serviço');
    await choose(f, 'OS vinculada', 'Cliente QA Transporte');
    await choose(f, 'Responsável pelo transporte', 'Responsável QA Transporte');
    for (const [label, value] of [['Início da janela', '2026-11-03T10:00'], ['Fim da janela', '2026-11-03T11:00'], ['Logradouro', 'Rua Sintética QA'], ['Número', '10'], ['Bairro', 'Centro QA'], ['Cidade', 'Rio Verde'], ['CEP', '75900000']]) await fill(f, label, value);
    await choose(f, 'UF', 'GO');
    await submit(f, 'Agendar transporte');
    await until(() => !f.document.querySelector('[role="dialog"]'), 'transporte salvo');
    const write = f.requests.find(r => r.path === '/api/jk/deliveries' && r.method === 'POST');
    assert.equal(write.status, 201, JSON.stringify(write.result));
    const delivery = write.result.data.item;
    assert.equal(delivery.employeeId, employee.id);
    assert.equal(delivery.orderId, order.id);
    assert.equal(delivery.address.city, 'Rio Verde');
    assert.equal(delivery.startsAt, '2026-11-03T13:00:00.000Z');
    await until(() => f.document.querySelector('table[aria-label="Retiradas e devoluções"]'), 'transporte na agenda');
    await click(f, 'Detalhes');
    await until(() => f.text().includes('Iniciar deslocamento'), 'detalhes carregados');
    await click(f, 'Iniciar deslocamento');
    await submit(f, 'Confirmar saída');
    await until(() => f.text().includes('Concluir retirada'), 'deslocamento iniciado');
    assert.equal((await f.api(`/jk/deliveries/${delivery.id}`)).data.item.status, 'en_route');
    await click(f, 'Concluir retirada');
    await fill(f, 'Nome de quem recebeu o veículo', 'Recebedor QA Sintético');
    await submit(f, 'Confirmar conclusão');
    await until(() => f.text().includes('Tarefa concluída'), 'conclusão auditada');
    const persisted = (await f.api(`/jk/deliveries/${delivery.id}`)).data.item;
    assert.equal(persisted.status, 'completed');
    assert.equal(persisted.receivedBy, 'Recebedor QA Sintético');
    assert.deepEqual(persisted.events.map(event => event.action), ['created', 'en_route', 'completed']);
    assert.equal(await count('payments'), 0, 'Retirada não quita a OS.');
  });

  await t.test('perfil de consulta não carrega nem altera migração, transportes ou gestão de integrações', async () => {
    await create('/users', {name: 'Consulta QA JK', email: 'consulta-jk@example.test', password: 'Senha-consulta-QA-12345', role: 'viewer'});
    await f.route('dashboard');
    await click(f, 'Sair');
    await until(() => f.text().includes('Vamos começar o dia?'), 'login após logout JK');
    await fill(f, 'E-mail', 'consulta-jk@example.test');
    await fill(f, 'Senha', 'Senha-consulta-QA-12345');
    await submit(f, 'Entrar na operação');
    await until(() => f.text().includes('Consulta QA JK'), 'consulta autenticada');
    const navigation = f.document.querySelector('[aria-label="Navegação principal"]');
    for (const route of ['migration', 'deliveries', 'integrations']) {
      assert.ok(!navigation.querySelector(`a[href="#/${route}"]`), `${route} ausente na navegação de consulta`);
      const before = f.requests.length;
      await f.route(route);
      await until(() => f.text().includes('Área de gestão'), `rota ${route} negada`);
      assert.equal(f.requests.slice(before).filter(request => request.path.startsWith(`/api/jk/${route}`)).length, 0);
    }
    assert.equal((await f.api('/jk/migration/status')).status, 403);
    assert.equal((await f.api('/jk/deliveries')).status, 403);
    assert.equal((await f.api(`/jk/orders/${order.id}/pix`, {method: 'POST', body: {version: order.version}})).status, 403);
  });
  assert.deepEqual(f.runtimeErrors, []);
});
