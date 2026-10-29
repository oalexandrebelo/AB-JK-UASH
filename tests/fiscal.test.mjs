import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fiscalFixture, providerFixture, draftInput, enabledEnv, sendProvider } from './fiscal-helpers.mjs';
import { FiscalTransportError } from '../integrations/fiscal/index.mjs';

test('disabled fiscal flow prepares immutable local drafts, persists, redacts and cancels locally', async (t) => {
  let outgoing = 0;
  const f = await fiscalFixture(t, { fiscalTransport: async () => { outgoing++; throw new Error('Must not be called'); } });
  const status = (await f.call('/fiscal/status')).data;
  assert.equal(status.disabled, true); assert.equal(status.disabledReason, 'FISCAL_DISABLED');
  assert.equal(status.canPrepareLocally, true); assert.equal(status.homologated, false);
  const order = await f.order();
  const key = randomUUID(), input = draftInput(order.id);
  const created = await f.call('/fiscal/drafts', { method: 'POST', body: input, key, status: 201 });
  const draft = created.data.draft;
  assert.equal(draft.status, 'prepared'); assert.equal(draft.snapshot.totalCents, 12345);
  assert.equal(draft.customer.taxIdMasked, '*******8909');
  const serialized = JSON.stringify(created.data);
  for (const secret of [input.customer.taxId,input.customer.name,input.customer.address.street,input.fiscal.cnpj_prestador,input.taxReview.justification]) assert.ok(!serialized.includes(secret));
  assert.deepEqual((await f.call('/fiscal/drafts', { method: 'POST', body: input, key, status: 201 })).data, created.data);
  await f.call('/fiscal/drafts', { method: 'POST', body: { ...input, fiscal: { ...input.fiscal, numero_dps: 1002 } }, key, status: 409 });
  await f.call(`/fiscal/drafts/${draft.id}/submit`, { method: 'POST', body: { version: draft.version }, status: 409 });
  assert.equal(outgoing, 0);
  await f.restart();
  assert.equal((await f.call(`/fiscal/drafts/${draft.id}`)).data.draft.providerRef, draft.providerRef);
  const listed = (await f.call(`/fiscal/drafts?orderId=${order.id}&status=prepared`)).data;
  assert.equal(listed.page.total, 1);
  const cancelKey = randomUUID();
  const cancelled = (await f.call(`/fiscal/drafts/${draft.id}/cancel`, { method: 'POST', body: { version: draft.version }, key: cancelKey })).data.draft;
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.payloadRetained, false);
  const stored = await f.app.store.prepare('SELECT payload_json,tax_review_json FROM fiscal_drafts WHERE id=?').get(draft.id);
  assert.deepEqual(stored, { payload_json: null, tax_review_json: null });
  assert.equal((await f.call(`/fiscal/drafts/${draft.id}/cancel`, { method: 'POST', body: { version: draft.version }, key: cancelKey })).data.draft.version, cancelled.version);
});

test('HTTP fixture receives Focus Basic POST once; accepted submission is reconciled only by GET', async (t) => {
  const provider = await providerFixture(t, (call, res) => sendProvider(res, call.method === 'POST' ? 202 : 200, {
    status: call.method === 'POST' ? 'processando_autorizacao' : 'autorizado',
    ref: call.method === 'POST' ? new URL(call.path, 'https://fixture.invalid').searchParams.get('ref') : call.path.split('/').at(-1),
    raw_secret: 'NEVER_ECHO_PROVIDER_DATA',
  }));
  const f = await fiscalFixture(t, { fiscalEnv: enabledEnv, fiscalTransport: provider.transport });
  const draft = await f.draft(await f.order());
  const key = randomUUID();
  const submitted = await f.call(`/fiscal/drafts/${draft.id}/submit`, { method: 'POST', body: { version: draft.version }, key, status: 202 });
  assert.equal(submitted.data.draft.status, 'pending');
  assert.equal(provider.calls.length, 1); assert.equal(provider.calls[0].method, 'POST');
  assert.equal(provider.calls[0].path, `/v2/nfsen?ref=${draft.providerRef}`);
  assert.equal(provider.calls[0].authorization, `Basic ${Buffer.from(`${enabledEnv.AB_UASH_FOCUS_NFE_TOKEN}:`).toString('base64')}`);
  assert.equal(provider.calls[0].body.valor_servico, 123.45);
  assert.equal(provider.calls[0].body.cpf_tomador, '12345678909');
  assert.equal(provider.calls[0].body.descricao_servico, '1 x Lavagem de teste');
  await f.call(`/fiscal/drafts/${draft.id}/submit`, { method: 'POST', body: { version: draft.version }, key, status: 202 });
  assert.equal(provider.calls.length, 1);
  const reconciled = await f.call(`/fiscal/drafts/${draft.id}/reconcile`, { method: 'POST', body: { version: submitted.data.draft.version } });
  assert.equal(reconciled.data.draft.status, 'authorized');
  assert.equal(reconciled.data.draft.fiscalValidity, 'test_without_fiscal_validity');
  assert.equal(provider.calls[1].method, 'GET'); assert.equal(provider.calls[1].path, `/v2/nfsen/${draft.providerRef}`);
  const audit = (await f.call('/audit')).data;
  assert.ok(!JSON.stringify([submitted.data,reconciled.data,audit]).includes('NEVER_ECHO_PROVIDER_DATA'));
  assert.ok(!JSON.stringify(audit).includes(enabledEnv.AB_UASH_FOCUS_NFE_TOKEN));
});

test('unknown outcome is durable; neither new nor replayed submit can repeat POST, including 404 reconciliation', async (t) => {
  const methods = [];
  const f = await fiscalFixture(t, { fiscalEnv: enabledEnv, fiscalTransport: async ({ method }) => {
    methods.push(method);
    if (method === 'POST') throw new FiscalTransportError('FISCAL_TIMEOUT');
    return { statusCode: 404, body: { codigo: 'nao_encontrado', mensagem: 'PRIVATE_PROVIDER_TEXT' } };
  } });
  const draft = await f.draft(await f.order());
  const key = randomUUID();
  const submitted = (await f.call(`/fiscal/drafts/${draft.id}/submit`, { method: 'POST', body: { version: draft.version }, key, status: 202 })).data.draft;
  assert.equal(submitted.status, 'uncertain'); assert.equal(submitted.attemptCount, 1);
  await f.restart();
  await f.call(`/fiscal/drafts/${draft.id}/submit`, { method: 'POST', body: { version: submitted.version }, status: 409 });
  await f.call(`/fiscal/drafts/${draft.id}/submit`, { method: 'POST', body: { version: draft.version }, key, status: 202 });
  const result = (await f.call(`/fiscal/drafts/${draft.id}/reconcile`, { method: 'POST', body: { version: submitted.version }, status: 202 })).data.draft;
  assert.equal(result.status, 'uncertain'); assert.equal(result.lastErrorCode, 'FISCAL_REFERENCE_NOT_FOUND');
  assert.deepEqual(methods, ['POST','GET']);
  await f.call(`/fiscal/drafts/${draft.id}/cancel`, { method: 'POST', body: { version: result.version }, status: 409 });
  await f.call('/fiscal/drafts', { method: 'POST', body: draftInput(draft.orderId, 2002), status: 409 });
});

test('leases fence late POST results; unrelated API writes proceed during provider wait', async (t) => {
  let release, started;
  const postStarted = new Promise((resolve) => { started = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  const methods = [];
  const f = await fiscalFixture(t, { fiscalEnv: enabledEnv, fiscalTransport: async ({ method }) => {
    methods.push(method);
    if (method === 'POST') { started(); return pending; }
    return { statusCode: 200, body: { status: 'autorizado' } };
  } });
  const draft = await f.draft(await f.order());
  const key = randomUUID();
  const submission = f.call(`/fiscal/drafts/${draft.id}/submit`, { method: 'POST', body: { version: draft.version }, key, status: 200 });
  await postStarted;
  const current = (await f.call(`/fiscal/drafts/${draft.id}`)).data.draft;
  assert.equal(current.status, 'submitting');
  await f.create('/services', { name: 'Escrita durante provedor lento', priceCents: 100, durationMinutes: 10, commissionBps: 0 });
  await f.call(`/fiscal/drafts/${draft.id}/submit`, { method: 'POST', body: { version: draft.version }, key, status: 202 });
  await f.call(`/fiscal/drafts/${draft.id}/reconcile`, { method: 'POST', body: { version: current.version }, status: 409 });
  await f.app.store.prepare('UPDATE fiscal_drafts SET lease_expires_at=? WHERE id=?').run(0, draft.id);
  const authorized = (await f.call(`/fiscal/drafts/${draft.id}/reconcile`, { method: 'POST', body: { version: current.version } })).data.draft;
  release({ statusCode: 422, body: { mensagem: 'Late rejection must never overwrite authorization' } });
  const late = await submission;
  assert.equal(late.data.draft.status, 'authorized'); assert.equal(late.data.draft.version, authorized.version);
  assert.deepEqual(methods, ['POST','GET']);
});

test('crash after durable claim recovers with GET without sending a new POST', async (t) => {
  const methods = [];
  const f = await fiscalFixture(t, { fiscalEnv: enabledEnv, fiscalTransport: async ({ method }) => { methods.push(method); return { statusCode: 200, body: { status: 'autorizado' } }; } });
  const draft = await f.draft(await f.order());
  // State persisted by claim before the process dies, with no result committed.
  await f.app.store.prepare("UPDATE fiscal_drafts SET status='submitting',version=version+1,attempt_count=1,lease_token=?,lease_expires_at=0,provider_kind='focusnfe',provider_environment='sandbox',provider_target=? WHERE id=?")
    .run(randomUUID(), 'https://homologacao.focusnfe.com.br', draft.id);
  await f.restart();
  const current = (await f.call(`/fiscal/drafts/${draft.id}`)).data.draft;
  assert.equal(current.status, 'uncertain');
  await f.call(`/fiscal/drafts/${draft.id}/submit`, { method: 'POST', body: { version: current.version }, status: 409 });
  assert.equal((await f.call(`/fiscal/drafts/${draft.id}/reconcile`, { method: 'POST', body: { version: current.version } })).data.draft.status, 'authorized');
  assert.deepEqual(methods, ['GET']);
});

test('accepted provider result with failed local commit remains a durable claim recoverable by GET', async (t) => {
  const methods = [];
  const f = await fiscalFixture(t, { fiscalEnv: enabledEnv, fiscalTransport: async ({ method }) => {
    methods.push(method); return { statusCode: 200, body: { status: 'autorizado' } };
  } });
  const draft = await f.draft(await f.order());
  const originalPrepare = f.app.store.prepare.bind(f.app.store);
  f.app.store.prepare = (sql) => {
    if (sql.startsWith('UPDATE fiscal_drafts SET status=?,version=version+1,provider_status=')) {
      return { run: async () => { throw new Error('TEST_RESULT_COMMIT_FAILURE'); } };
    }
    return originalPrepare(sql);
  };
  await f.call(`/fiscal/drafts/${draft.id}/submit`, { method: 'POST', body: { version: draft.version }, status: 500 });
  f.app.store.prepare = originalPrepare;
  assert.equal(f.errors.length, 1);
  assert.equal(f.errors[0].code, 'INTERNAL_ERROR');
  assert.match(f.errors[0].requestId, /^[0-9a-f-]{36}$/u);
  assert.equal(JSON.stringify(f.errors).includes('TEST_RESULT_COMMIT_FAILURE'), false);
  f.errors.length = 0;
  const claim = await f.app.store.prepare('SELECT status,attempt_count,version FROM fiscal_drafts WHERE id=?').get(draft.id);
  assert.equal(claim.status, 'submitting'); assert.equal(claim.attempt_count, 1);
  await f.app.store.prepare('UPDATE fiscal_drafts SET lease_expires_at=0 WHERE id=?').run(draft.id);
  await f.restart();
  const reconciled = await f.call(`/fiscal/drafts/${draft.id}/reconcile`, { method: 'POST', body: { version: claim.version } });
  assert.equal(reconciled.data.draft.status, 'authorized'); assert.deepEqual(methods, ['POST','GET']);
});

test('fiscal routes require live admin/manager, CSRF, idempotency and correct version', async (t) => {
  const f = await fiscalFixture(t);
  const order = await f.order(), body = draftInput(order.id);
  await f.call('/fiscal/status', { headers: { cookie: '' }, status: 401 });
  await f.call('/fiscal/drafts', { method: 'POST', body, headers: { 'x-csrf-token': '' }, status: 403 });
  await f.call('/fiscal/drafts', { method: 'POST', body, headers: { 'idempotency-key': '' }, status: 400 });
  const draft = await f.draft(order);
  await f.call(`/fiscal/drafts/${draft.id}/cancel`, { method: 'POST', body: { version: 999 }, status: 409 });
  for (const role of ['viewer','operator','manager']) {
    await f.call('/users', { method: 'POST', body: { name: `${role} Fiscal`, email: `${role}@example.test`, password: 'test-only-role-password', role }, status: 201 });
    const login = await f.call('/auth/login', { method: 'POST', body: { email: `${role}@example.test`, password: 'test-only-role-password' } });
    const headers = { cookie: login.response.headers.get('set-cookie').split(';')[0], 'x-csrf-token': login.data.csrfToken };
    await f.call('/fiscal/config', { headers, status: role === 'manager' ? 200 : 403 });
    if (role !== 'manager') await f.call(`/fiscal/drafts/${draft.id}/cancel`, { method: 'POST', body: { version: draft.version }, headers, status: 403 });
  }
});

test('drafts demand explicit fiscal fields and customer data; snapshot change blocks submission', async (t) => {
  let calls = 0;
  const f = await fiscalFixture(t, { fiscalEnv: enabledEnv, fiscalTransport: async () => { calls++; return { statusCode: 202, body: {} }; } });
  const order = await f.order();
  const input = draftInput(order.id);
  const missing = structuredClone(input); delete missing.fiscal.codigo_nbs;
  await f.call('/fiscal/drafts', { method: 'POST', body: missing, status: 422 });
  const unexpected = await f.call('/fiscal/drafts', { method: 'POST', body: { ...input, PRIVATE_KEY_NAME_DO_NOT_ECHO: 'sensitive' }, status: 422 });
  assert.ok(!JSON.stringify(unexpected.error).includes('PRIVATE_KEY_NAME_DO_NOT_ECHO'));
  const badTax = structuredClone(input); badTax.customer.taxId = '12345678900';
  await f.call('/fiscal/drafts', { method: 'POST', body: badTax, status: 422 });
  const requiredIbs = structuredClone(input); requiredIbs.taxReview.ibsCbsRequired = true;
  await f.call('/fiscal/drafts', { method: 'POST', body: requiredIbs, status: 422 });
  const draft = await f.draft(order);
  await f.call(`/orders/${order.id}`, { method: 'PATCH', body: { version: order.version, notes: 'Atualização após o rascunho' } });
  const failure = await f.call(`/fiscal/drafts/${draft.id}/submit`, { method: 'POST', body: { version: draft.version }, status: 409 });
  assert.equal(failure.error.code, 'FISCAL_ORDER_CHANGED'); assert.equal(calls, 0);
  assert.equal((await f.call(`/fiscal/drafts/${draft.id}`)).data.draft.snapshot.orderVersion, 1);
});

test('concurrent create and submit have one owner; provider changes cannot misroute reconciliation', async (t) => {
  let calls = 0;
  const f = await fiscalFixture(t, { fiscalEnv: enabledEnv, fiscalTransport: async () => { calls++; return { statusCode: 202, body: { status: 'processando_autorizacao' } }; } });
  const order = await f.order(), input = draftInput(order.id);
  const outcomes = await Promise.all([f.call('/fiscal/drafts', { method: 'POST', body: input, status: null }), f.call('/fiscal/drafts', { method: 'POST', body: input, status: null })]);
  assert.deepEqual(outcomes.map((result) => result.status).sort(), [201,409]);
  const draft = outcomes.find((result) => result.status === 201).data.draft;
  const results = await Promise.all([f.call(`/fiscal/drafts/${draft.id}/submit`, { method: 'POST', body: { version: 1 }, status: null }), f.call(`/fiscal/drafts/${draft.id}/submit`, { method: 'POST', body: { version: 1 }, status: null })]);
  assert.equal(calls, 1); assert.deepEqual(results.map((result) => result.status).sort(), [202,409]);
  const current = (await f.call(`/fiscal/drafts/${draft.id}`)).data.draft;
  await f.restart({ fiscalEnv: { ...enabledEnv, AB_UASH_FISCAL_ENVIRONMENT: 'production' } });
  const rejected = await f.call(`/fiscal/drafts/${draft.id}/reconcile`, { method: 'POST', body: { version: current.version }, status: 409 });
  assert.equal(rejected.error.code, 'FISCAL_PROVIDER_CHANGED'); assert.equal(calls, 1);
});

test('two application instances sharing one store cannot create or dispatch duplicate fiscal work', async (t) => {
  let sends = 0;
  const f = await fiscalFixture(t, { fiscalEnv: enabledEnv, fiscalTransport: async () => { sends++; return { statusCode: 202, body: { status: 'processando_autorizacao' } }; } });
  const peer = await f.peer();
  const order = await f.order(), body = draftInput(order.id);
  const created = await Promise.all([
    f.call('/fiscal/drafts', { method: 'POST', body, status: null }),
    peer.call('/fiscal/drafts', { method: 'POST', body, status: null }),
  ]);
  assert.deepEqual(created.map((result) => result.status).sort(), [201,409]);
  const draft = created.find((result) => result.status === 201).data.draft;
  const submitted = await Promise.all([
    f.call(`/fiscal/drafts/${draft.id}/submit`, { method: 'POST', body: { version: draft.version }, status: null }),
    peer.call(`/fiscal/drafts/${draft.id}/submit`, { method: 'POST', body: { version: draft.version }, status: null }),
  ]);
  assert.deepEqual(submitted.map((result) => result.status).sort(), [202,409]);
  assert.equal(sends, 1);
});
