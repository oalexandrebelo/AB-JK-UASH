import test from 'node:test';
import assert from 'node:assert/strict';
import {request, setSession} from '../src/lib/api.ts';

function session(csrfToken) {
  return {setupRequired:false,setupTokenRequired:false,storageMode:'local',csrfToken};
}

function observeExpiry(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const target = new EventTarget();
  Object.defineProperty(globalThis, 'window', {configurable:true,value:target});
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete globalThis.window;
    setSession(session(''));
  });
  let count = 0;
  target.addEventListener('ab-uash-session-expired', () => count++);
  return () => count;
}

function unauthorized() {
  return Response.json({ok:false,error:{code:'UNAUTHORIZED',message:'Sessão expirada.'}}, {status:401});
}

test('401 da sessão atual informa expiração e preserva o erro da requisição', async t => {
  const expirations = observeExpiry(t);
  setSession(session('current-session'));
  t.mock.method(globalThis, 'fetch', async () => unauthorized());
  await assert.rejects(request('/customers'), {status:401,code:'UNAUTHORIZED'});
  assert.equal(expirations(), 1);
});

test('401 atrasado da sessão anterior não encerra um novo login', async t => {
  const expirations = observeExpiry(t);
  setSession(session('previous-session'));
  const response = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', () => response.promise);
  const pending = request('/customers');
  setSession(session('new-session'));
  response.resolve(unauthorized());
  await assert.rejects(pending, {status:401,code:'UNAUTHORIZED'});
  assert.equal(expirations(), 0);
});

test('credencial de login recusada não dispara expiração global', async t => {
  const expirations = observeExpiry(t);
  t.mock.method(globalThis, 'fetch', async () => unauthorized());
  await assert.rejects(request('/auth/login', {method:'POST',body:{}}), {status:401});
  assert.equal(expirations(), 0);
});
