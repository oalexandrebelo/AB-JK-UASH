import test from 'node:test';
import assert from 'node:assert/strict';
import {bookingFixture} from './ui-booking-helpers.mjs';
test('privacy opens as a public route with the defined contact and limited purpose',{timeout:90000},async t=>{
  const f=await bookingFixture(t,{path:'/privacidade',readyText:'Seus dados, com clareza'});
  assert.ok([...f.document.querySelectorAll('a')].some(node=>node.href==='mailto:contato@alexandrebelo.com.br'));
  assert.ok(f.text().includes('não inclui autorização para publicidade'));assert.ok(!f.text().includes('CNPJ:'));
  assert.equal(f.requests.filter(row=>row.method==='POST').length,0);assert.equal(f.runtimeErrors.length,0);
});
