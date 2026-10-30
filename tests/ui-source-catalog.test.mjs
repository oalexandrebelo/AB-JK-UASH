import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,until,fill,click,submit,button,field,uiQaAvailable,uiQaSkipReason} from './ui-helpers.mjs';

const snapshot={schemaVersion:1,source:'jumpcar-ui',establishmentId:24453,observedAt:'2026-10-30T20:00:00Z',services:[],products:[],balances:[]};
const json=data=>new Response(JSON.stringify({ok:true,data}),{status:200,headers:{'content-type':'application/json'}});
async function enter(f,tab){
  await until(()=>f.text().includes('Prepare a operação JK'),'primeiro acesso');
  await fill(f,'Seu nome','Admin revisão QA');await fill(f,'E-mail','review-qa@example.test');await fill(f,'Senha','Senha-sintetica-12345');await submit(f,'Criar acesso de administrador');
  await until(()=>f.text().includes('Visão geral'),'admin autenticado');await f.route('migration');
  await until(()=>[...f.document.querySelectorAll('[role="tab"]')].find(node=>node.textContent===tab),`aba ${tab}`);
  await click(f,[...f.document.querySelectorAll('[role="tab"]')].find(node=>node.textContent===tab));
}
function upload(f,name,content){
  const input=f.document.querySelector('input[type="file"]');assert.ok(input,'Seletor privado de arquivo presente');
  Object.defineProperty(input,'files',{configurable:true,value:[new File([content],name,{type:'application/json'})]});input.dispatchEvent(new f.window.Event('change',{bubbles:true}));
}

test('catálogo mantém desconhecidos e exige prévia e consentimento novos quando o arquivo muda', {timeout:90000,skip:!uiQaAvailable&&uiQaSkipReason},async t=>{
  const f=await fixture(t,{responseOverride:async({url,options})=>{
    if(!url.pathname.startsWith('/api/jk/source-catalog/'))return;
    if(url.pathname.endsWith('/status'))return json({supported:true,status:'COMMITTED',counts:{services:1,products:0,balances:0},totalSnapshots:1,operational:false,sourceVerified:false});
    if(url.pathname.endsWith('/rows'))return json({items:[{id:'service-qa',name:'Lavagem origem QA',sourceRow:1,sourceId:null,category:null,priceCents:null,active:null,schedulingEnabled:null,durationMinutes:null,commissionBps:null,raw:{},provenance:{sourceRow:1,observedAt:'2026-10-30T20:00:00Z'}}],page:{limit:25,offset:0,total:1,hasMore:false}});
    if(url.pathname.endsWith('/preview'))return json({status:'PREVIEW',canCommit:true,counts:{services:0,products:0,balances:0},previewHash:JSON.parse(options.body).snapshot.observedAt.includes('21:')?'hash-new-catalog':'hash-catalog',issues:[],operationalWrites:{services:0,products:0,payments:0}});
    if(url.pathname.endsWith('/commit'))return json({status:'COMMITTED',counts:{services:0,products:0,balances:0}});
  }});
  await enter(f,'Catálogo da origem');await until(()=>f.text().includes('Lavagem origem QA'),'catálogo consultável');
  assert.ok(f.text().includes('Não informado'));assert.ok(f.text().includes('não são saldos da JK'));
  assert.equal(f.requests.filter(row=>row.path.startsWith('/api/jk/source-catalog/')&&row.method==='POST').length,0);
  await click(f,[...f.document.querySelectorAll('summary')].find(node=>node.textContent==='Preservar uma nova referência privada da origem'));upload(f,'catalogo-qa.json',JSON.stringify(snapshot));await until(()=>f.text().includes('catalogo-qa.json'),'arquivo privado escolhido');
  await click(f,'Conferir catálogo');await until(()=>f.text().includes('Confirmar referência da origem'),'prévia do catálogo');
  assert.equal(button(f,'Confirmar referência da origem').disabled,true);
  await click(f,field(f,'Conferi a prévia e quero preservar esta referência sem criar saldos ou cadastros operacionais.'));
  assert.equal(button(f,'Confirmar referência da origem').disabled,false);
  upload(f,'catalogo-outro-qa.json',JSON.stringify({...snapshot,observedAt:'2026-10-30T21:00:00Z'}));await until(()=>f.text().includes('catalogo-outro-qa.json'),'arquivo substituído');
  assert.ok(!f.text().includes('Confirmar referência da origem'),'Outro arquivo invalida prévia e consentimento.');
  assert.equal(f.requests.filter(row=>row.path==='/api/jk/source-catalog/commit').length,0);
  await click(f,'Conferir catálogo');await until(()=>f.text().includes('Confirmar referência da origem'),'nova prévia');
  assert.equal(field(f,'Conferi a prévia e quero preservar esta referência sem criar saldos ou cadastros operacionais.').checked,false);
  await click(f,field(f,'Conferi a prévia e quero preservar esta referência sem criar saldos ou cadastros operacionais.'));await click(f,'Confirmar referência da origem');
  await until(()=>f.text().includes('Referência da origem preservada para consulta.'),'referência preservada');
  const write=f.requests.filter(row=>row.path==='/api/jk/source-catalog/commit').at(-1);
  assert.deepEqual(JSON.parse(write.body),{snapshot:{...snapshot,observedAt:'2026-10-30T21:00:00Z'},previewHash:'hash-new-catalog'});
  const writesBeforePaste=f.requests.filter(row=>row.path.startsWith('/api/jk/source-catalog/')&&row.method==='POST').length;
  await fill(f,'JSON privado para colar','{incompleto');
  assert.equal(f.requests.filter(row=>row.path.startsWith('/api/jk/source-catalog/')&&row.method==='POST').length,writesBeforePaste,'Digitar não envia dados.');
  assert.ok(!f.text().includes('catalogo-outro-qa.json'),'Colar limpa a escolha anterior de arquivo.');
  await click(f,'Usar conteúdo colado');await until(()=>f.text().includes('JSON UTF-8 válido e completo'),'JSON colado inválido identificado');
  await fill(f,'JSON privado para colar',JSON.stringify(snapshot));await click(f,'Usar conteúdo colado');
  await until(()=>f.text().includes('Conteúdo JSON colado'),'conteúdo colado preparado');
  assert.equal(f.requests.filter(row=>row.path.startsWith('/api/jk/source-catalog/')&&row.method==='POST').length,writesBeforePaste,'Usar conteúdo não envia dados.');
  await click(f,'Conferir catálogo');await until(()=>f.text().includes('Confirmar referência da origem'),'prévia do conteúdo colado');
  await click(f,field(f,'Conferi a prévia e quero preservar esta referência sem criar saldos ou cadastros operacionais.'));
  await fill(f,'JSON privado para colar',JSON.stringify({...snapshot,observedAt:'2026-10-30T22:00:00Z'}));
  assert.ok(!f.text().includes('Confirmar referência da origem'),'Editar texto remove prévia/hash e consentimento.');
  assert.equal(button(f,'Conferir catálogo').disabled,true,'Novo texto precisa ser aceito explicitamente.');
  upload(f,'catalogo-final-qa.json',JSON.stringify(snapshot));await until(()=>f.text().includes('catalogo-final-qa.json'),'arquivo substitui colagem');
  assert.equal(field(f,'JSON privado para colar').value,'','Escolher arquivo limpa o texto colado.');
  assert.equal(f.requests.filter(row=>row.path==='/api/jk/source-catalog/commit').length,1,'Nenhuma edição gera novo commit.');
  assert.equal(f.runtimeErrors.length,0);
});
