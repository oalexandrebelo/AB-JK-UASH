import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,until,fill,click,submit,field,uiQaAvailable,uiQaSkipReason} from './ui-helpers.mjs';

test('Asaas e Baileys na UI: preparo explícito, modelos locais e atualização sem envio', {timeout:90000,skip:!uiQaAvailable&&uiQaSkipReason},async t=>{
  let paired=false;
  const pixCharges=[],messages=[];
  const channel=(id,provider,label)=>({id,provider,label,state:'blocked',configured:true,environment:'production',blockers:[],canPrepareLocally:true,capabilities:{prepare:true,submit:false,reconcile:false}});
  const readiness=()=>({pix:channel('pix','pix-asaas','Pix'),whatsapp:{...channel('whatsapp','whatsapp-baileys','WhatsApp'),state:paired?'ready':'blocked',connection:paired?'connected':'connecting',connectionVerified:paired,qrAvailable:!paired,sendEnabled:paired,blockers:paired?[]:['BAILEYS_NOT_CONNECTED'],capabilities:{prepare:true,submit:paired,verifyDelivery:false}},fiscal:channel('fiscal',null,'Fiscal'),rules:{providerAcceptanceIsNotDelivery:true}});
  const json=data=>new Response(JSON.stringify({ok:true,data}),{status:200,headers:{'content-type':'application/json'}});
  const f=await fixture(t,{responseOverride:async({url,options})=>{
    if(url.pathname==='/api/jk/integrations/readiness')return json(readiness());
    if(/^\/api\/jk\/orders\/[^/]+\/integrations$/u.test(url.pathname))return json({pixCharges,messages,fiscalDrafts:[]});
    if(options.method==='POST' && /^\/api\/jk\/orders\/[^/]+\/(pix|messages)$/u.test(url.pathname)){
      const body=JSON.parse(options.body),isPix=url.pathname.endsWith('/pix');
      const item={id:crypto.randomUUID(),kind:isPix?'pix':'whatsapp',provider:isPix?'pix-asaas':'whatsapp-baileys',version:1,status:'prepared',environment:'production',amountCents:4500,templateName:body.templateName,recipientMasked:'***4321',canSubmit:false,canCancel:true,createdAt:new Date().toISOString(),delivery:'unconfirmed'};
      (isPix?pixCharges:messages).push(item);return json({item});
    }
    return null;
  }});
  await until(()=>f.text().includes('Prepare a operação JK'),'primeiro acesso');
  await fill(f,'Seu nome','Admin Provedores QA');await fill(f,'E-mail','providers@example.test');await fill(f,'Senha','Senha-sintetica-12345');await submit(f,'Criar acesso de administrador');
  await until(()=>f.text().includes('Visão geral'),'operação');
  const create=async(path,body)=>{const result=await f.api(path,{method:'POST',body});assert.equal(result.status,201,JSON.stringify(result));return result.data.item;};
  const customer=await create('/customers',{name:'Cliente Provider QA',phone:'11987654321'});
  const vehicle=await create('/vehicles',{customerId:customer.id,plate:'PRV1A23',model:'Veículo sintético'});
  const service=await create('/services',{name:'Lavagem Provider QA',priceCents:4500});
  const order=await create('/orders',{customerId:customer.id,vehicleId:vehicle.id,items:[{serviceId:service.id,quantity:1}]});

  await f.route('integrations');await until(()=>[...f.document.querySelectorAll('.integration-card')].some(node=>node.textContent.includes('Asaas')),'provedor Asaas');
  assert.ok([...f.document.querySelectorAll('.integration-card')].some(node=>node.textContent.includes('Baileys · WhatsApp Web')));
  assert.ok(f.text().includes('Aguardando pareamento ou reconexão'));
  assert.ok(f.text().includes('Modelos locais de texto'));
  const before=f.requests.length;
  paired=true;f.window.dispatchEvent(new f.window.Event('focus'));
  await until(()=>f.text().includes('Conta conectada'),'status dinâmico');
  assert.ok(f.requests.slice(before).some(row=>row.path==='/api/jk/integrations/readiness' && row.method==='GET'));
  assert.equal(f.requests.slice(before).filter(row=>row.method!=='GET').length,0,'Atualizar status não despacha mensagens nem cobranças.');
  paired=false;
  await until(()=>f.text().includes('Aguardando pareamento ou reconexão'),'consulta periódica reflete perda da conexão',12_000);
  assert.equal(f.requests.slice(before).filter(row=>row.method!=='GET').length,0,'A consulta periódica apenas lê o status.');
  paired=true;f.window.dispatchEvent(new f.window.Event('focus'));
  await until(()=>f.text().includes('Conta conectada'),'conexão observada novamente');

  await f.route(`orders/${order.id}`);await until(()=>f.text().includes('Ordem 0001'),'OS');await click(f,'Integrações');await until(()=>f.text().includes('Preparar cobrança'),'ações');
  await click(f,'Preparar cobrança');
  assert.ok(f.text().includes('O cliente precisa existir na conta Asaas'));
  assert.equal([...f.document.querySelectorAll('label')].some(node=>node.textContent.includes('Validade da cobrança, em minutos')),false);
  await fill(f,'Identificador do cliente no Asaas','wrong');await fill(f,'Vencimento da cobrança','2026-11-03');await submit(f,'Salvar preparação');
  assert.equal(field(f,'Identificador do cliente no Asaas').validity.patternMismatch,true);
  assert.equal(f.requests.filter(row=>row.path===`/api/jk/orders/${order.id}/pix` && row.method==='POST').length,0);
  await fill(f,'Identificador do cliente no Asaas','cus_QA123');await fill(f,'Vencimento da cobrança','');await submit(f,'Salvar preparação');
  assert.equal(field(f,'Vencimento da cobrança').validity.valueMissing,true);
  await fill(f,'Vencimento da cobrança','2026-11-03');await submit(f,'Salvar preparação');
  await until(()=>!f.document.querySelector('[role="dialog"]'),'preparação Asaas salva');
  const pix=f.requests.find(row=>row.path===`/api/jk/orders/${order.id}/pix` && row.method==='POST');
  assert.deepEqual(JSON.parse(pix.body),{version:order.version,customerId:'cus_QA123',dueDate:'2026-11-03'});
  await click(f,'Preparar mensagem');
  assert.ok(f.text().includes('Modelos locais de texto'));
  assert.equal(f.text().includes('Informe o identificador aprovado na conta da empresa.'),false);
  await fill(f,'Nome do modelo local no Baileys','order_ready');await fill(f,'Parâmetros do corpo, um por linha','0001');
  await click(f,field(f,'O cliente autorizou esta comunicação sobre o atendimento.'));
  await submit(f,'Salvar preparação');await until(()=>!f.document.querySelector('[role="dialog"]'),'preparação Baileys salva');
  const message=f.requests.find(row=>row.path===`/api/jk/orders/${order.id}/messages` && row.method==='POST');
  assert.deepEqual(JSON.parse(message.body),{version:order.version,templateName:'order_ready',languageCode:'pt_BR',bodyParameters:['0001'],consentConfirmed:true});
  assert.equal(f.requests.filter(row=>/\/(submit|reconcile)$/u.test(row.path)).length,0);
  assert.equal(f.runtimeErrors.length,0,f.runtimeErrors.map(error=>error.message).join('\n'));
});
