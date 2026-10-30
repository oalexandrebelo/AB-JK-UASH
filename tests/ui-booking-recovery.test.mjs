import test from 'node:test';
import assert from 'node:assert/strict';
import {bookingFixture,json,catalog,reservation,until,fill,click,submit} from './ui-booking-helpers.mjs';
test('closed booking still lets a verified blocked customer read and cancel an existing reservation',{timeout:90000},async t=>{
  const f=await bookingFixture(t,{responseOverride:async({url})=>{
    if(!url.pathname.startsWith('/api/public/booking/'))return;
    if(url.pathname.endsWith('/catalog'))return json({...catalog,enabled:false,closedReasons:['POLICY_DISABLED'],services:[]});
    if(url.pathname.endsWith('/identity/request'))return json({challengeId:'challenge-recover',expiresAt:'2031-02-10T12:20:00.000Z'});
    if(url.pathname.endsWith('/identity/verify'))return json({identityToken:'i'.repeat(43),expiresAt:'2031-02-10T12:30:00.000Z',blocked:true});
    if(url.pathname.endsWith('/reservations'))return json({items:[{reservationToken:'r'.repeat(43),reservation:{...reservation,status:'confirmed',financialStatus:'received',version:2}}],page:{limit:25,offset:0,total:1}});
    if(url.pathname.endsWith('/reservation/cancel'))return json({reservation:{...reservation,status:'cancelled',financialStatus:'refund_pending',version:3}});
    throw new Error('Unexpected route '+url.pathname);
  }});
  await until(()=>f.text().includes('A agenda online ainda não está disponível.'),'agenda fechada');assert.equal(f.requests.filter(row=>row.method==='POST').length,0);
  await click(f,'Consultar minhas reservas');await fill(f,'WhatsApp com código do país e DDD (obrigatório)','+5511999990000');await submit(f,'Receber código pelo WhatsApp');
  await until(()=>f.document.querySelector('#booking-code'),'OTP de recuperação');await fill(f,'Código de seis dígitos (obrigatório)','123456');await submit(f,'Confirmar WhatsApp');
  await until(()=>f.text().includes('Consultar reservas deste WhatsApp'),'contato bloqueado pode consultar reservas');await click(f,'Consultar reservas deste WhatsApp');await until(()=>f.text().includes('Abrir reserva ABC12345'),'lista privada');
  const list=f.requests.find(row=>row.path.startsWith('/api/public/booking/reservations?'));assert.equal(list.headers.get('Authorization'),'Bearer '+'i'.repeat(43));assert.ok(!list.path.includes('i'.repeat(43)));
  await click(f,'Abrir reserva ABC12345');await until(()=>f.text().includes('Seu horário está confirmado.'),'token recuperado em memória');
  await click(f,f.document.querySelector('summary'));await click(f,'Confirmar cancelamento da reserva');await until(()=>f.text().includes('Devolução em acompanhamento'),'cancelamento recuperado');
  assert.equal(f.requests.filter(row=>row.path.endsWith('/holds')||row.path.endsWith('/reservation/pix')).length,0);assert.equal(f.window.localStorage.length,0);assert.equal(f.runtimeErrors.length,0);
});
