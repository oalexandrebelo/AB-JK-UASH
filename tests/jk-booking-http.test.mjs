import test from 'node:test';
import assert from 'node:assert/strict';
import {fiscalFixture} from './fiscal-helpers.mjs';

test('public booking is closed by default and staff cookies cannot replace customer verification',async t=>{
 const f=await fiscalFixture(t,{jkBookingEnv:{},jkIntegrationsEnv:{}});
 const catalog=await f.call('/public/booking/catalog',{headers:{cookie:''}});
 assert.equal(catalog.data.enabled,false);assert.equal(catalog.response.headers.get('cache-control'),'no-store');
 assert.ok(catalog.data.closedReasons.includes('POLICY_DISABLED'));
 const slots=(await f.call('/public/booking/availability?date=2026-10-31&serviceId=none&category=small')).data;assert.deepEqual(slots.slots,[]);
 await f.call('/public/booking/reservation',{status:401});
 await f.call('/public/booking/reservations?identityToken=unsafe',{status:401});
 await f.call('/public/booking/identity/request',{method:'POST',body:{phone:'+5511999991111'},headers:{cookie:''},status:503});
 assert.equal((await f.call('/public/profile')).data.acceptingOnlineBookings,false);
 for(const table of ['jk_booking_reservations','jk_booking_challenges','payments','cash_movements'])assert.equal((await f.app.store.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).n,0);
});

test('booking policy requires a live administrator and CSRF; disabled configuration remains editable during parallel consultation',async t=>{
 const f=await fiscalFixture(t,{jkBookingEnv:{},jkIntegrationsEnv:{}});
 const initial=(await f.call('/jk/booking/policy')).data.policy;
 await f.call('/jk/booking/policy',{headers:{cookie:''},status:401});
 await f.call('/jk/booking/policy',{method:'PUT',body:initial,headers:{'x-csrf-token':''},status:403});
 await f.call('/jk/transition',{method:'PATCH',body:{mode:'parallel_readonly',version:0}});
 const saved=await f.call('/jk/booking/policy',{method:'PUT',body:initial});
 assert.equal(saved.data.policy.version,initial.version+1);
 const catalog=(await f.call('/public/booking/catalog')).data;assert.equal(catalog.enabled,false);assert.ok(catalog.closedReasons.includes('PARALLEL_READONLY'));
 await f.call('/public/booking/holds',{method:'POST',body:{},headers:{cookie:''},status:409});
 const availability=(await f.call('/public/booking/availability?date=2026-10-31')).data;assert.deepEqual(availability.slots,[]);
 await f.call('/jk/booking/reservations?limit=abc',{status:422});
 const user=(await f.call('/auth/session')).data.user;
 await f.app.store.prepare("UPDATE users SET role='operator' WHERE id=?").run(user.id);
 await f.call('/jk/booking/policy',{method:'PUT',body:saved.data.policy,status:403});
 await f.call('/jk/booking/reservations?limit=10&offset=0');
 await f.app.store.prepare('UPDATE users SET active=0 WHERE id=?').run(user.id);
 await f.call('/jk/booking/reservations',{status:401});
});

test('booking endpoints reject foreign origins and do not accept payment evidence from the browser',async t=>{
 const f=await fiscalFixture(t,{jkBookingEnv:{},jkIntegrationsEnv:{}});
 await f.call('/public/booking/identity/request',{method:'POST',body:{phone:'+5511999991111'},headers:{origin:'https://untrusted.example'},status:403});
 await f.call('/public/booking/payment-confirmed',{method:'POST',body:{paid:true},status:404});
 await f.call('/public/booking/identity/request',{method:'POST',body:{phone:'+5511999991111',clientKey:'browser-choice'},status:422});
 await f.call('/public/booking/reservations?limit=-1',{headers:{authorization:'Bearer '+'a'.repeat(43)},status:422});
});
