import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, until, fill, click, choose, submit, button, uiQaAvailable, uiQaSkipReason} from './ui-helpers.mjs';

test('bundle de produção: setup, operação e persistência por DOM emulado + HTTP real', {timeout: 90000, skip: !uiQaAvailable && uiQaSkipReason}, async t => {
  const f = await fixture(t);
  await until(() => f.text().includes('Prepare a operação JK'), 'tela inicial vazia');
  await fill(f, 'Seu nome', 'QA Administrador');
  await fill(f, 'E-mail', 'qa-admin@example.test');
  await fill(f, 'Senha', 'Senha-sintetica-12345');
  await submit(f, 'Criar acesso de administrador');
  await until(() => f.text().includes('Visão geral'), `dashboard após setup; texto: ${f.text()}`);
  assert.equal(f.requests.find(r => r.path === '/api/setup').status, 201);
  assert.equal((await f.api('/customers')).data.items.length, 0);
  assert.equal((await f.api('/orders')).data.items.length, 0);
  await f.route('customers');
  await until(() => f.text().includes('Cadastrar cliente'), 'cadastro de clientes vazio');
  await click(f, 'Cadastrar cliente');
  await until(() => f.document.querySelector('[role="dialog"]'), 'formulário de cliente');
  await fill(f, 'Nome / razão social', 'Cliente QA Sintético');
  await fill(f, 'Telefone / WhatsApp', '11999990000');
  await submit(f, 'Salvar cliente');
  await until(() => f.requests.find(r => r.path === '/api/customers' && r.method === 'POST')?.status, 'cliente salvo via UI');
  assert.equal(f.requests.find(r => r.path === '/api/customers' && r.method === 'POST').status, 201);
  const customer = (await f.api('/customers')).data.items[0];
  assert.equal(customer.name, 'Cliente QA Sintético');
  await f.route('services');
  await until(() => f.text().includes('Cadastrar serviço'), 'cadastro de serviços vazio');
  await click(f, 'Cadastrar serviço');
  await until(() => f.document.querySelector('[role="dialog"]'), 'formulário de serviço');
  await fill(f, 'Nome do serviço', 'Lavagem QA Sintética');
  await fill(f, 'Preço', '123,45');
  await submit(f, 'Salvar serviço');
  await until(() => f.requests.find(r => r.path === '/api/services' && r.method === 'POST')?.status, 'serviço salvo via UI');
  assert.equal(f.requests.find(r => r.path === '/api/services' && r.method === 'POST').status, 201);
  const service = (await f.api('/services')).data.items[0];
  assert.equal(service.priceCents, 12345, 'Dinheiro digitado em reais deve persistir em centavos.');
  await f.route('vehicles');
  await until(() => f.text().includes('Cadastrar veículo'), 'cadastro de veículos');
  await click(f, 'Cadastrar veículo');
  await until(() => f.document.querySelector('[role="dialog"]'), 'formulário de veículo');
  await choose(f, 'Cliente', 'Cliente QA Sintético');
  await fill(f, 'Placa', 'QAT-1A23');
  await fill(f, 'Marca e modelo', 'Veículo QA Sintético');
  await submit(f, 'Salvar veículo');
  await until(() => f.requests.find(r => r.path === '/api/vehicles' && r.method === 'POST')?.status, 'veículo salvo via UI');
  const vehicleWrite = f.requests.find(r => r.path === '/api/vehicles' && r.method === 'POST');
  assert.equal(vehicleWrite.status, 201, JSON.stringify(vehicleWrite.result));
  const vehicle = (await f.api('/vehicles')).data.items[0];
  assert.equal(vehicle.customerId, customer.id);
  assert.equal(vehicle.plate, 'QAT1A23');
  await f.route('orders');
  await until(() => f.text().includes('Nova ordem de serviço'), 'lista de ordens');
  await click(f, 'Nova ordem de serviço');
  await until(() => f.document.querySelector('[role="dialog"]'), 'formulário de ordem');
  await choose(f, 'Cliente', 'Cliente QA Sintético');
  await choose(f, 'Veículo', 'QAT1A23');
  await choose(f, 'Adicionar serviço', 'Lavagem QA Sintética');
  await click(f, 'Adicionar');
  await fill(f, 'Desconto total', '23,44');
  await fill(f, 'Entrega prevista', '2026-10-20T10:00');
  await submit(f, 'Criar ordem');
  await until(() => f.requests.find(r => r.path === '/api/orders' && r.method === 'POST')?.status, 'ordem salva via UI');
  const orderWrite = f.requests.find(r => r.path === '/api/orders' && r.method === 'POST');
  assert.equal(orderWrite.status, 201, JSON.stringify(orderWrite.result));
  const order = orderWrite.result.data.item;
  assert.equal(order.customerId, customer.id);
  assert.equal(order.vehicleId, vehicle.id);
  assert.equal(order.totalCents, 10001);
  assert.equal(order.promisedAt, '2026-10-20T13:00:00.000Z');
  await until(() => f.text().includes('Ordem 0001'), 'detalhe da ordem');
  for (const [label, status] of [['Em execução', 'in_progress'], ['Conferência', 'quality_check'], ['Pronta', 'ready']]) {
    await click(f, 'Atualizar etapa');
    await choose(f, 'Próxima etapa', label);
    await submit(f, 'Confirmar etapa');
    await until(() => !f.document.querySelector('[role="dialog"]'), `etapa ${label} concluída`);
    assert.equal((await f.api(`/orders/${order.id}`)).data.item.status, status);
    await until(() => [...f.document.querySelectorAll('.order-summary-strip [role="status"], .order-summary-strip span')].some(node => node.textContent.trim() === label), `etapa ${label} atualizada na tela`);
  }
  await click(f, 'Atualizar etapa');
  await choose(f, 'Próxima etapa', 'Entregue');
  await submit(f, 'Confirmar etapa');
  await until(() => f.document.querySelector('[role="alert"]'), 'entrega sem quitação rejeitada');
  const rejected = f.requests.filter(r => r.path === `/api/orders/${order.id}/transition`).at(-1);
  assert.equal(rejected.status, 409);
  assert.equal((await f.api(`/orders/${order.id}`)).data.item.status, 'ready');
  await click(f, 'Cancelar');
  await click(f, 'Recebimentos');
  await click(f, 'Registrar recebimento');
  await fill(f, 'Valor recebido', '100,01');
  await fill(f, 'Referência / comprovante', '=1+1');
  await submit(f, 'Confirmar recebimento');
  await until(() => !f.document.querySelector('[role="dialog"]'), 'recebimento registrado');
  let persisted = (await f.api(`/orders/${order.id}`)).data.item;
  assert.equal(persisted.paidCents, 10001);
  assert.equal(persisted.balanceCents, 0);
  assert.equal(persisted.payments.length, 1);
  assert.equal(persisted.payments[0].method, 'pix');
  await click(f, 'Atualizar etapa');
  await choose(f, 'Próxima etapa', 'Entregue');
  await submit(f, 'Confirmar etapa');
  await until(() => !f.document.querySelector('[role="dialog"]'), 'entrega quitada concluída');
  await f.restart();
  persisted = (await f.api(`/orders/${order.id}`)).data.item;
  assert.equal(persisted.status, 'delivered');
  assert.equal(persisted.paidCents, 10001);
  assert.equal(persisted.payments.length, 1);

  for (const [route, title] of [
    ['dashboard', 'Visão geral'], ['orders', 'Ordens de serviço'], ['appointments', 'Agenda'],
    ['customers', 'Clientes'], ['vehicles', 'Veículos'], ['checklist', 'Checklist dos veículos'],
    ['services', 'Serviços'], ['products', 'Estoque'], ['cash', 'Financeiro e caixa'],
    ['invoices', 'Pós-pago'], ['packages', 'Pacotes'], ['employees', 'Equipe e comissões'],
    ['messages', 'Mensagens'], ['reports', 'Relatórios'], ['settings', 'Configurações'],
    ['payroll', 'Folha local'], ['package-sales', 'Pacotes vendidos'],
  ]) {
    await f.route(route);
    await until(() => f.document.querySelector('.page-heading h1')?.textContent === title, `rota ${route}`);
    await until(() => !f.document.querySelector('.loading-state'), `dados de ${route}`);
    assert.equal(f.document.querySelector('.notice-error'), null, `rota ${route} sem erro`);
  }
  await f.route('pagina-inexistente-qa');
  await until(() => f.text().includes('Página não encontrada'), 'rota inexistente tratada');
  await f.route('orders/00000000-0000-4000-8000-000000000000');
  await until(() => f.document.querySelector('[role="alert"]'), 'ordem inexistente com erro recuperável');
  assert.ok(f.text().includes('Tentar novamente'));

  for (let i = 0; i < 52; i++) assert.equal((await f.api('/customers', {method: 'POST', body: {name: `QA Paginação ${String(i).padStart(2, '0')}`}})).status, 201);
  const beforePagination = f.requests.length;
  await f.route('customers');
  await until(() => f.text().includes('1–25 de 53 registros'), 'primeira página limitada a 25');
  assert.equal(f.document.querySelectorAll('table[aria-label="Clientes"] tbody tr').length, 25);
  await click(f, 'Próxima');
  await until(() => f.text().includes('26–50 de 53 registros'), 'segunda página remota');
  await click(f, 'Próxima');
  await until(() => f.text().includes('51–53 de 53 registros'), 'terceira página remota');
  assert.equal(f.document.querySelectorAll('table[aria-label="Clientes"] tbody tr').length, 3);
  await fill(f, 'Buscar Clientes', 'Cliente QA Sintético');
  await until(() => f.text().includes('1–1 de 1 registros'), 'busca remota reinicia paginação');
  assert.equal(f.document.querySelectorAll('table[aria-label="Clientes"] tbody tr').length, 1);
  const pageRequests = f.requests.slice(beforePagination).filter(row => row.path.startsWith('/api/customers?'));
  assert.ok(pageRequests.every(row => new URL(row.path, f.base).searchParams.get('limit') === '25'));
  assert.deepEqual([...new Set(pageRequests.map(row => new URL(row.path, f.base).searchParams.get('offset')))].sort(), ['0', '25', '50']);

  await f.route('reports');
  await until(() => f.text().includes('Exportar página CSV'), 'relatório');
  await choose(f, 'Relatório', 'Recebimentos');
  await click(f, 'Aplicar filtros');
  await until(() => f.document.querySelector('table[aria-label="Recebimentos"] tbody tr'), 'relatório de recebimento');
  await click(f, 'Exportar página CSV');
  const download = f.downloads.at(-1);
  assert.match(download.name, /^ab-uash-sales-.*-pagina-1\.csv$/u);
  const csv = await download.blob.text();
  assert.match(csv, /"Valor \(centavos\)"/u);
  assert.match(csv, /"10001"/u);
  assert.match(csv, /"'=1\+1"/u, 'CSV neutraliza fórmula no texto de referência.');

  assert.equal((await f.api(`/customers/${customer.id}`, {method: 'PATCH', body: {version: customer.version, postpaid: true}})).status, 200);
  let invoiceOrder = (await f.api('/orders', {method: 'POST', body: {customerId: customer.id, vehicleId: vehicle.id, items: [{serviceId: service.id, quantity: 1}]}})).data.item;
  for (const status of ['in_progress', 'quality_check', 'ready']) {
    invoiceOrder = (await f.api(`/orders/${invoiceOrder.id}/transition`, {method: 'POST', body: {version: invoiceOrder.version, status}})).data.item;
  }
  await f.route('invoices');
  await until(() => f.text().includes('Nova fatura'), 'lista de faturas');
  await click(f, 'Nova fatura');
  await choose(f, 'Cliente pós-pago', 'Cliente QA Sintético');
  await fill(f, 'Data de vencimento', '2026-12-15');
  const checkbox = await until(() => f.document.querySelector('.invoice-order input[type="checkbox"]'), 'ordem elegível na fatura');
  await click(f, checkbox);
  await submit(f, 'Criar fatura de controle');
  await until(() => !f.document.querySelector('[role="dialog"]'), 'fatura criada pela interface');
  const invoice = (await f.api('/invoices')).data.items[0];
  assert.equal(invoice.totalCents, 12345);
  await until(() => f.document.querySelector('table[aria-label="Faturas pós-pago"] tbody tr'), 'fatura na tabela');
  await click(f, 'Detalhes');
  const invoiceRow = await until(() => f.document.querySelector('table[aria-label="Ordens da fatura"] tbody tr'), 'detalhes de fatura');
  assert.equal(invoiceRow.querySelectorAll('td')[1].textContent.replace(/\s/gu, ' '), 'R$ 123,45');
  assert.ok(f.text().includes('Valor faturado'));
  await until(() => !button(f, 'Imprimir fatura').disabled, 'dados da empresa carregados para impressão');
  const printable = f.document.querySelector('body > .jk-invoice-print');
  assert.ok(printable, 'Documento de impressão deve existir fora do shell do app.');
  assert.equal(f.document.querySelectorAll('.jk-invoice-print').length, 1);
  assert.equal(printable.querySelector('.app-shell'), null);
  assert.match(printable.textContent, /DOCUMENTO NÃO FISCAL/u);
  assert.match(printable.textContent, /Cliente QA Sintético/u);
  assert.match(printable.textContent, /15\/12\/2026/u);
  assert.match(printable.textContent.replace(/\s/gu, ' '), /R\$ 123,45/u);
  let printCalls = 0;
  const nativePrint = f.window.print;
  f.window.print = () => {printCalls++;};
  try {await click(f, 'Imprimir fatura');} finally {f.window.print = nativePrint;}
  assert.equal(printCalls, 1);
  await f.route('dashboard');
  await until(() => !f.document.querySelector('.jk-invoice-print'), 'documento de impressão removido ao sair da fatura');

  const viewer = await f.api('/users', {method: 'POST', body: {name: 'QA Consulta', email: 'qa-viewer@example.test', password: 'Senha-viewer-12345', role: 'viewer'}});
  assert.equal(viewer.status, 201);
  await click(f, 'Sair');
  await until(() => f.text().includes('Vamos começar o dia?'), 'logout');
  await fill(f, 'E-mail', 'qa-viewer@example.test');
  await fill(f, 'Senha', 'Senha-incorreta-12345');
  await submit(f, 'Entrar na operação');
  await until(() => f.text().includes('E-mail ou senha inválidos'), 'credencial inválida visível');
  await fill(f, 'Senha', 'Senha-viewer-12345');
  await submit(f, 'Entrar na operação');
  await until(() => f.text().includes('QA Consulta'), 'login de consulta');
  for (const route of ['cash', 'invoices', 'payroll', 'reports']) {
    const before = f.requests.length;
    await f.route(route);
    await until(() => f.text().includes('Área de gestão'), `restrição UI ${route}`);
    assert.equal(f.requests.slice(before).filter(row => row.path.startsWith(`/api/${route}`)).length, 0);
    assert.equal((await f.api(`/${route}`)).status, 403, `restrição HTTP ${route}`);
  }
  await f.route('customers');
  await until(() => f.document.querySelector('table[aria-label="Clientes"]'), 'consulta de clientes');
  assert.ok(!f.text().includes('Cadastrar cliente'));
  assert.equal(f.document.querySelectorAll('table[aria-label="Clientes"] button').length, 0);
  assert.equal((await f.api('/customers', {method: 'POST', body: {name: 'Negado'}})).status, 403);
  await f.route('settings');
  await until(() => f.text().includes('Dados da empresa'), 'configurações de consulta');
  assert.ok(!f.text().includes('Salvar dados da empresa'));
  assert.ok(![...f.document.querySelectorAll('[role="tab"]')].some(node => node.textContent === 'Acessos'));
  assert.equal((await f.api('/auth/logout', {method: 'POST', body: {}})).status, 200);
  await f.route('vehicles');
  await until(() => f.text().includes('Vamos começar o dia?'), 'sessão revogada retorna ao login após 401');
  assert.deepEqual(f.runtimeErrors, []);
});
