import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,until,fill,click,submit,button,field,choose,uiQaAvailable,uiQaSkipReason} from './ui-helpers.mjs';

const counts={vehicles:{eligible:1,staged:1,promoted:0,pendingReview:1,conflictGroups:0,conflictingEntries:0,ambiguousCustomerRows:0,ambiguousTokenCollisions:0},history:{rows:1,proposal:1,insufficientIdentity:0,identityMismatch:0,plateConflict:0,plateAbsent:0,invalidPlate:0}};
const json=data=>new Response(JSON.stringify({ok:true,data}),{status:200,headers:{'content-type':'application/json'}});
async function enter(f,tab){
  await until(()=>f.text().includes('Prepare a operação JK'),'primeiro acesso');
  await fill(f,'Seu nome','Admin revisão QA');await fill(f,'E-mail','review-qa@example.test');await fill(f,'Senha','Senha-sintetica-12345');await submit(f,'Criar acesso de administrador');
  await until(()=>f.text().includes('Visão geral'),'admin autenticado');await f.route('migration');
  await until(()=>[...f.document.querySelectorAll('[role="tab"]')].find(node=>node.textContent===tab),`aba ${tab}`);
  await click(f,[...f.document.querySelectorAll('[role="tab"]')].find(node=>node.textContent===tab));
}
test('conciliação consulta sem escrita e exige revisão individual sem categoria presumida', {timeout:90000,skip:!uiQaAvailable&&uiQaSkipReason},async t=>{
  let promoted=false;
  const f=await fixture(t,{responseOverride:async({url,options})=>{
    if(!url.pathname.startsWith('/api/jk/reconciliation/'))return;
    if(url.pathname.endsWith('/status'))return json({supported:true,ready:true,mode:'documentary',sourceVerified:false,counts,latestBatch:{batchId:'batch-review',committedAt:'2026-10-30T20:00:00Z'}});
    if(url.pathname.endsWith('/vehicles'))return json({items:[{vehicleRef:'vehicle-ref-qa',customerId:'customer-qa',customerName:'Cliente fictício QA',plate:'TST1A23',sourceRow:2,status:promoted?'promoted':'awaiting_review',category:promoted?'small':null,model:promoted?'Hatch QA':null,color:null,vehicleId:promoted?'vehicle-ref-qa':null}],page:{limit:25,offset:0,total:1,hasMore:false}});
    if(url.pathname.endsWith('/history'))return json({headers:['OS'],items:[],page:{limit:25,offset:0,total:0,hasMore:false}});
    const body=JSON.parse(options.body||'{}');
    if(url.pathname.endsWith('/preview'))return json({status:'PREVIEW',canCommit:true,previewHash:'hash-rehearsal',counts,operationalWrites:{vehicles:body.vehicleReviews?.length||0},warnings:[]});
    if(url.pathname.endsWith('/commit')){promoted=Boolean(body.vehicleReviews?.length);return json({status:'COMMITTED',counts,committedAt:'2026-10-30T20:00:00Z'});}
  }});
  await enter(f,'Conciliação');await until(()=>f.text().includes('Cliente fictício QA'),'consulta documental');
  assert.equal(f.requests.filter(row=>row.path.startsWith('/api/jk/reconciliation/')&&row.method==='POST').length,0);
  await click(f,'Conferir vínculos documentais');await until(()=>f.text().includes('Confirmar vínculos documentais'),'prévia documental');
  assert.equal(button(f,'Confirmar vínculos documentais').disabled,true);
  await click(f,field(f,'Conferi a prévia e autorizo preservar somente os vínculos documentais.'));
  await click(f,'Confirmar vínculos documentais');await until(()=>f.text().includes('Vínculos documentais preservados'),'commit documental');
  const documentary=f.requests.filter(row=>row.path==='/api/jk/reconciliation/commit').at(-1);assert.equal(JSON.parse(documentary.body).previewHash,'hash-rehearsal');assert.equal(Object.hasOwn(JSON.parse(documentary.body),'vehicleReviews'),false);
  const reviewButton=await until(()=>[...f.document.querySelectorAll('button')].find(node=>node.textContent.trim()==='Revisar TST1A23'),'linha disponível após atualizar vínculos');
  await click(f,reviewButton);await until(()=>f.document.querySelector('[role="dialog"]'),'revisão individual');
  await fill(f,'Modelo confirmado','Hatch QA');assert.equal(button(f,'Conferir este veículo').disabled,true,'Categoria não ganha valor padrão.');
  await choose(f,'Categoria confirmada','Pequeno');await click(f,'Conferir este veículo');await until(()=>f.text().includes('Confirmar cadastro deste veículo'),'prévia individual');
  assert.equal(button(f,'Confirmar cadastro deste veículo').disabled,true);
  await click(f,field(f,'Confirmei o proprietário, a categoria e o modelo deste veículo.'));
  await fill(f,'Modelo confirmado','Outro modelo QA');assert.ok(!f.text().includes('Confirmar cadastro deste veículo'),'Editar modelo invalida prévia e consentimento.');
  assert.equal(f.requests.filter(row=>row.path==='/api/jk/reconciliation/commit').length,1);
  await click(f,'Conferir este veículo');await until(()=>f.text().includes('Confirmar cadastro deste veículo'),'prévia atualizada');
  assert.equal(field(f,'Confirmei o proprietário, a categoria e o modelo deste veículo.').checked,false);
  await click(f,field(f,'Confirmei o proprietário, a categoria e o modelo deste veículo.'));await click(f,'Confirmar cadastro deste veículo');
  await until(()=>f.text().includes('Cadastro revisado de TST1A23 preservado.'),'veículo revisado');
  const promotion=f.requests.filter(row=>row.path==='/api/jk/reconciliation/commit').at(-1);
  assert.deepEqual(JSON.parse(promotion.body),{vehicleReviews:[{vehicleRef:'vehicle-ref-qa',category:'small',model:'Outro modelo QA',color:''}],previewHash:'hash-rehearsal'});
  assert.equal(f.runtimeErrors.length,0);
});

