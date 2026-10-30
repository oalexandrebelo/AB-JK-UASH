import test from 'node:test';
import assert from 'node:assert/strict';
import {bookingFixture} from './ui-booking-helpers.mjs';
test('terms open directly with arrival cancellation, appeal and no automatic forfeiture',{timeout:90000},async t=>{
  const f=await bookingFixture(t,{path:'/condicoes-de-agendamento',readyText:'Condições do agendamento'});
  assert.ok(f.text().includes('dez minutos antes'));assert.ok(f.text().includes('Cancelamento pelo estabelecimento e expiração sem pagamento não contam como faltas'));
  assert.ok(f.text().includes('não afastam os direitos previstos'));assert.ok(f.text().includes('Não há nesta página autorização para retenção automática'));
  assert.equal(f.requests.filter(row=>row.method==='POST').length,0);assert.equal(f.runtimeErrors.length,0);
});
