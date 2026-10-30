import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fixture,until,fill,click,submit,button,field,uiQaAvailable,uiQaSkipReason} from './ui-helpers.mjs';

const choice='Importar somente clientes; revisar veículos depois';
const consent='Revisei a prévia e confirmo a importação destes registros para a operação JK.';
const native='\uFEFFNome;E-mail;Telefone;Situação da fatura;Data de vencimento;Valor da fatura;Veículos;Vagas;Observação\n'
  +'Cliente Alfa QA;alfa@example.test;11988881111;Em dia;--;0;ABC1D23;--;Conferir proprietário\n'
  +'Cliente Beta QA;beta@example.test;11988882222;Em dia;--;0;ABC1D23;--;Outro registro da mesma placa\n'
  +'Cliente Gama QA;gama@example.test;11988883333;Em dia;--;0;ABC9Z99 modelo incerto;--;Revisar veículo';

test('somente clientes é uma escolha explícita que invalida prévia, preserva linhas e não atribui veículos', {timeout:90000,skip:!uiQaAvailable&&uiQaSkipReason},async t=>{
  const f=await fixture(t,{application:{fiscalEnv:{},jkIntegrationsEnv:{}}});
  await until(()=>f.text().includes('Prepare a operação JK'),'primeiro acesso');
  await fill(f,'Seu nome','Admin clientes QA');await fill(f,'E-mail','native-customers-admin@example.test');await fill(f,'Senha','Senha-sintetica-12345');await submit(f,'Criar acesso de administrador');
  await until(()=>f.text().includes('Visão geral'),'admin autenticado');
  await f.route('migration');await until(()=>f.document.querySelector('input[type="file"]')&&!button(f,'Escolher arquivos').disabled,'importação disponível');
  const option=()=>field(f,choice);assert.equal(option().checked,false);
  const input=f.document.querySelector('input[type="file"]');
  Object.defineProperty(input,'files',{configurable:true,value:[new File([native],'clientes-nativos.csv',{type:'text/csv'})]});input.dispatchEvent(new f.window.Event('change',{bubbles:true}));
  await until(()=>f.text().includes('clientes-nativos.csv'),'arquivo selecionado');await click(f,'Analisar e gerar prévia');await until(()=>f.text().includes('Revisão necessária'),'fluxo completo mantém conflito');
  let request=f.requests.filter(row=>row.path==='/api/jk/migration/preview').at(-1);
  assert.equal(Object.hasOwn(JSON.parse(request.body),'nativeCustomerMode'),false,'Nenhum modo customers-only é inferido.');
  assert.equal(request.result.data.canCommit,false);
  await click(f,option());assert.ok(!f.text().includes('Revise o resultado da análise'),'Mudar escolha invalida prévia.');
  await click(f,'Analisar e gerar prévia');await until(()=>f.text().includes('Pronta para importar'),'prévia somente clientes');
  request=f.requests.filter(row=>row.path==='/api/jk/migration/preview').at(-1);const preview=request.result.data;
  assert.equal(JSON.parse(request.body).nativeCustomerMode,'customers-only');assert.equal(preview.nativeCustomerImport.sourceRows,3);
  assert.equal(JSON.parse(request.body).files[0].content,native,'O arquivo conserva o BOM e todas as células.');
  assert.equal(preview.nativeCustomerImport.snapshotHash,createHash('sha256').update(native).digest('hex'));
  assert.ok(f.text().includes('2 entradas de placas em 2 linhas ficam para revisão.'));
  assert.ok(f.text().includes('1 linha com veículos ambíguos'));
  assert.ok(f.text().includes('3 linhas originais de 9 colunas serão preservadas.'));
  assert.equal(button(f,'Confirmar importação').disabled,true);
  await click(f,field(f,consent));assert.equal(button(f,'Confirmar importação').disabled,false);
  await click(f,option());assert.ok(!f.text().includes('Confirmar importação'),'Mudar a escolha remove consentimento e confirmação.');
  await click(f,option());await click(f,'Analisar e gerar prévia');await until(()=>f.text().includes('Pronta para importar'),'prévia refeita');
  assert.equal(field(f,consent).checked,false);await click(f,field(f,consent));await click(f,'Confirmar importação');await until(()=>f.text().includes('Importação concluída.'),'clientes importados');
  const write=f.requests.filter(row=>row.path==='/api/jk/migration/commit').at(-1);assert.equal(write.status,201);assert.equal(JSON.parse(write.body).nativeCustomerMode,'customers-only');
  const source=f.requests.filter(row=>row.path==='/api/jk/migration/preview').at(-1);assert.equal(JSON.parse(write.body).previewHash,source.result.data.previewHash);
  assert.ok(f.text().includes('3 linhas originais de 9 colunas preservadas.'));
  const count=async table=>(await f.app.store.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).n;
  assert.equal(await count('customers'),3);assert.equal(await count('vehicles'),0);assert.equal(await count('jk_migration_source_rows'),3);
  for(const table of ['orders','payments','cash_movements','messages','commission_claims'])assert.equal(await count(table),0,table);
  const origins=await f.app.store.prepare('SELECT source_id,provenance FROM jk_migration_records').all();assert.ok(origins.every(row=>row.source_id===null&&row.provenance==='snapshot-row'));
  const rows=await f.app.store.prepare('SELECT snapshot_hash,data_json FROM jk_migration_source_rows').all();assert.ok(rows.every(row=>row.snapshot_hash===preview.nativeCustomerImport.snapshotHash&&Object.keys(JSON.parse(row.data_json)).length===9));
  assert.equal(f.runtimeErrors.length,0);
});
