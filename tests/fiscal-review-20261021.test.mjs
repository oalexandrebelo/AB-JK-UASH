import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fiscalFixture, draftInput, enabledEnv } from './fiscal-helpers.mjs';
import { interpretFocusResponse } from '../integrations/fiscal/index.mjs';

test('fiscal snapshot and generated service description preserve order positions and exact cents', async (t) => {
  const f = await fiscalFixture(t);
  const second = await f.create('/services', { name: 'Secagem', priceCents: 101 });
  const third = await f.create('/services', { name: 'Enceramento', priceCents: 501 });
  const order = await f.order({ items: [{ serviceId: f.service.id, quantity: 1 }, { serviceId: second.id, quantity: 2 }, { serviceId: third.id, quantity: 1 }], discountCents: 333 });
  // UUID lexical ordering must not override the explicit position from the OS.
  for (const [index, item] of order.items.entries()) await f.app.store.prepare('UPDATE order_items SET id=? WHERE id=?').run(['z_review_item', 'm_review_item', 'a_review_item'][index], item.id);
  const input = draftInput(order.id);
  input.taxReview.discountTreatment = 'unconditional';
  const draft = (await f.call('/fiscal/drafts', { method: 'POST', body: input, status: 201 })).data.draft;
  assert.deepEqual(draft.snapshot.items.map(({ serviceId }) => serviceId), order.items.map(({ serviceId }) => serviceId));
  assert.equal(draft.snapshot.subtotalCents, 13048);
  assert.equal(draft.snapshot.discountCents, 333);
  assert.equal(draft.snapshot.totalCents, 12715);
  const stored = await f.app.store.prepare('SELECT payload_json FROM fiscal_drafts WHERE id=?').get(draft.id);
  const payload = JSON.parse(stored.payload_json);
  assert.equal(payload.descricao_servico, '1 x Lavagem de teste; 2 x Secagem; 1 x Enceramento');
  assert.equal(payload.valor_servico, 130.48);
  assert.equal(payload.desconto_incondicionado, 3.33);
});

test('contradictory provider errors remain uncertain and cannot release a second emission', async (t) => {
  for (const statusCode of [400, 401, 403, 422]) {
    for (const status of ['autorizado', 'processando_autorizacao', 'cancelado', 'processando_cancelamento', 'unknown_future_status', null, 17]) {
      assert.equal(interpretFocusResponse({ statusCode, body: { status } }, 'submit').status, 'uncertain');
    }
    assert.equal(interpretFocusResponse({ statusCode, body: { codigo: 'erro_validacao' } }, 'submit').status, 'rejected');
  }
  const methods = [];
  const f = await fiscalFixture(t, { fiscalEnv: enabledEnv, fiscalTransport: async ({ method }) => {
    methods.push(method);
    return method === 'POST' ? { statusCode: 422, body: { status: 'autorizado' } } : { statusCode: 200, body: { status: 'autorizado' } };
  } });
  const draft = await f.draft(await f.order());
  const input = { version: draft.version }, key = randomUUID();
  const submitted = (await f.call(`/fiscal/drafts/${draft.id}/submit`, { method: 'POST', body: input, key, status: 202 })).data.draft;
  assert.equal(submitted.status, 'uncertain');
  assert.equal(submitted.lastErrorCode, 'FISCAL_RESPONSE_UNCONFIRMED');
  await f.call('/fiscal/drafts', { method: 'POST', body: draftInput(draft.orderId, 2002), status: 409 });
  await f.call(`/fiscal/drafts/${draft.id}/submit`, { method: 'POST', body: input, key, status: 202 });
  const reconciled = (await f.call(`/fiscal/drafts/${draft.id}/reconcile`, { method: 'POST', body: { version: submitted.version } })).data.draft;
  assert.equal(reconciled.status, 'authorized');
  assert.deepEqual(methods, ['POST', 'GET']);
});

test('replay after a lost fiscal lease returns terminal HTTP status without repeating dispatch', async (t) => {
  let releasePost, markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const waiting = new Promise((resolve) => { releasePost = resolve; });
  const methods = [];
  const f = await fiscalFixture(t, { fiscalEnv: enabledEnv, fiscalTransport: async ({ method }) => {
    methods.push(method);
    if (method === 'POST') { markStarted(); return waiting; }
    return { statusCode: 200, body: { status: 'autorizado' } };
  } });
  const draft = await f.draft(await f.order());
  const key = randomUUID(), body = { version: draft.version };
  const submitted = f.call(`/fiscal/drafts/${draft.id}/submit`, { method: 'POST', body, key });
  await started;
  try {
    await f.app.store.prepare('UPDATE fiscal_drafts SET lease_expires_at=0 WHERE id=?').run(draft.id);
    const expired = (await f.call(`/fiscal/drafts/${draft.id}`)).data.draft;
    assert.equal(expired.status, 'uncertain');
    const current = (await f.call(`/fiscal/drafts/${draft.id}/reconcile`, { method: 'POST', body: { version: expired.version } })).data.draft;
    assert.equal(current.status, 'authorized');
  } finally {
    releasePost({ statusCode: 202, body: { status: 'processando_autorizacao' } });
  }
  assert.equal((await submitted).data.draft.status, 'authorized');
  const replayed = await f.call(`/fiscal/drafts/${draft.id}/submit`, { method: 'POST', body, key });
  assert.equal(replayed.status, 200);
  assert.equal(replayed.data.draft.status, 'authorized');
  assert.equal(replayed.data.draft.reconciliationRequired, false);
  assert.deepEqual(methods, ['POST', 'GET']);
});
