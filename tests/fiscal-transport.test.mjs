import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createFiscalTransport, fiscalConfiguration, publicFiscalConfiguration, interpretFocusResponse } from '../integrations/fiscal/index.mjs';
import { createPinnedHttpsTransport, isGlobalAddress, MAX_RESPONSE_BYTES } from '../integrations/fiscal/transport.mjs';
import { validTaxId, validateDraftInput, buildFocusPayload } from '../integrations/fiscal/payload.mjs';
import { providerFixture, enabledEnv, draftInput, sendProvider } from './fiscal-helpers.mjs';

const base = {
  origin: 'https://api.focusnfe.com.br', allowedHosts: ['api.focusnfe.com.br'],
  authorization: 'Basic Zml4dHVyZS10b2tlbjo=', timeoutMs: 50,
};
const operation = { method: 'GET', path: '/v2/nfsen/fixture_ref_1234' };

test('default transport is inert; configuration never exposes credentials', async () => {
  for (const env of [{}, { AB_UASH_FISCAL_ENABLED: 'true' }, { ...enabledEnv, AB_UASH_FOCUS_NFE_TOKEN: undefined }]) {
    const transport = createFiscalTransport({ env });
    await assert.rejects(transport(operation), { name: 'FiscalTransportError' });
    assert.equal(publicFiscalConfiguration(fiscalConfiguration(env)).disabled, true);
  }
  const configuration = publicFiscalConfiguration(fiscalConfiguration(enabledEnv));
  assert.equal(configuration.enabled, true);
  assert.ok(!JSON.stringify(configuration).includes(enabledEnv.AB_UASH_FOCUS_NFE_TOKEN));
  assert.equal('authorization' in configuration, false);
  assert.equal(fiscalConfiguration({ ...enabledEnv, AB_UASH_FISCAL_PROVIDER: 'gateway', AB_UASH_FISCAL_GATEWAY_ORIGIN: 'http://127.0.0.1', AB_UASH_FISCAL_GATEWAY_ALLOWED_HOST: '127.0.0.1', AB_UASH_FISCAL_GATEWAY_TOKEN: 'fixture-token' }).enabled, false);
});

test('transport rejects private and special IPs plus protocol, hostname, port and credential URL tricks', async () => {
  for (const address of ['127.0.0.1','0.0.0.0','10.1.2.3','100.64.0.1','169.254.169.254','172.16.1.1','192.168.0.1','192.0.2.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255','::','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1','2002:0808:0808::1','3fff::1']) assert.equal(isGlobalAddress(address), false, address);
  for (const address of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111','2001:4860:4860::8888']) assert.equal(isGlobalAddress(address), true, address);
  for (const origin of ['http://api.focusnfe.com.br','https://api.focusnfe.com.br:8443','https://api.focusnfe.com.br.evil.test','https://api.focusnfe.com.br.','https://api.focusnfe.com.br@evil.test','https://u:p@api.focusnfe.com.br','https://127.0.0.1','https://api.focusnfe.com.br/path','https://api.focusnfe.com.br?next=x']) {
    assert.throws(() => createPinnedHttpsTransport({ ...base, origin }), { name: 'FiscalTransportError' }, origin);
  }
  let sockets = 0;
  const transport = createPinnedHttpsTransport({ ...base, lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }], request: () => { sockets++; } });
  await assert.rejects(transport(operation), { code: 'FISCAL_DNS_REJECTED' });
  assert.equal(sockets, 0);
});

test('DNS is pinned to the validated IP with certificate hostname preserved', async () => {
  let lookupCalls = 0;
  const transport = createPinnedHttpsTransport({
    ...base, timeoutMs: 1000,
    lookup: async () => { lookupCalls++; return [{ address: '8.8.8.8', family: 4 }]; },
    request: (url, options, receive) => {
      assert.equal(new URL(url).hostname, 'api.focusnfe.com.br');
      assert.equal(options.servername, 'api.focusnfe.com.br');
      assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.agent, false);
      options.lookup('api.focusnfe.com.br', {}, (error, address, family) => {
        assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4);
      });
      options.lookup('api.focusnfe.com.br', { all: true }, (error, addresses) => {
        assert.equal(error, null); assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]);
      });
      const req = new EventEmitter();
      req.destroy = () => {};
      req.end = () => queueMicrotask(() => {
        const response = new EventEmitter(); response.statusCode = 200; response.headers = { 'content-type': 'application/json' }; response.destroy = () => {};
        receive(response); response.emit('data', Buffer.from('{"status":"autorizado"}')); response.emit('end');
      });
      return req;
    },
  });
  assert.equal((await transport(operation)).body.status, 'autorizado'); assert.equal(lookupCalls, 1);
});

test('total timeout covers DNS and prevents sockets from late DNS completion', async () => {
  let resolveDns, sockets = 0;
  const lookup = new Promise((resolve) => { resolveDns = resolve; });
  const transport = createPinnedHttpsTransport({ ...base, timeoutMs: 20, lookup: () => lookup, request: () => { sockets++; } });
  await assert.rejects(transport(operation), { code: 'FISCAL_TIMEOUT' });
  resolveDns([{ address: '8.8.8.8', family: 4 }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sockets, 0);
});

test('real loopback fixture enforces redirect, response size, malformed JSON and total response timeout', async (t) => {
  const variants = [
    ['redirect', (call, res) => { res.writeHead(302, { location: 'http://127.0.0.1/secrets', 'content-type': 'application/json' }); res.end('{}'); }, 'FISCAL_REDIRECT_REJECTED'],
    ['declared oversized', (call, res) => { res.writeHead(200, { 'content-type': 'application/json', 'content-length': MAX_RESPONSE_BYTES + 1 }); res.end('{}'); }, 'FISCAL_RESPONSE_TOO_LARGE'],
    ['stream oversized', (call, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"padding":"'); res.write('x'.repeat(MAX_RESPONSE_BYTES)); res.end('"}'); }, 'FISCAL_RESPONSE_TOO_LARGE'],
    ['malformed JSON', (call, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"invalid":'); }, 'FISCAL_RESPONSE_INVALID'],
    ['compressed', (call, res) => { res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }); res.end('{}'); }, 'FISCAL_RESPONSE_INVALID'],
    ['slow response', (call, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"waiting":'); }, 'FISCAL_TIMEOUT'],
  ];
  for (const [name, handler, expected] of variants) {
    await t.test(name, async (sub) => {
      const provider = await providerFixture(sub, handler, { timeoutMs: expected === 'FISCAL_TIMEOUT' ? 100 : 1000 });
      await assert.rejects(provider.transport(operation), { code: expected });
      assert.equal(provider.calls.length, 1);
    });
  }
});

test('provider status allowlist never returns raw error data and mismatched reference stays uncertain', () => {
  assert.deepEqual(interpretFocusResponse({ statusCode: 200, body: { status: 'autorizado', ref: 'wrong', secret: 'private' } }, 'reconcile', 'expected'),
    { status: 'uncertain', providerStatus: null, errorCode: 'FISCAL_REFERENCE_MISMATCH' });
  for (const statusCode of [404,409,429,500,502,503]) {
    const result = interpretFocusResponse({ statusCode, body: { status: 'private PII', mensagem: 'sensitive data' } }, 'submit');
    assert.equal(result.status, 'uncertain'); assert.equal(result.providerStatus, null);
  }
  assert.equal(interpretFocusResponse({ statusCode: 422, body: {} }, 'submit').status, 'rejected');
  assert.equal(interpretFocusResponse({ statusCode: 422, body: {} }, 'reconcile').status, 'uncertain');
});

test('CNPJ alphanumeric check digits and fiscal discount/IBS choices are explicit', () => {
  assert.equal(validTaxId('12ABC34501DE35', 'cnpj'), true);
  assert.equal(validTaxId('12ABC34501DE36', 'cnpj'), false);
  assert.equal(validTaxId('11111111111'), false);
  const body = draftInput('order_test_1234');
  const input = validateDraftInput(body);
  const snapshot = { subtotalCents: 15000, discountCents: 1000, totalCents: 14000, items: [{ quantity: 1, name: 'Serviço exemplo' }] };
  assert.throws(() => buildFocusPayload(input, snapshot), { code: 'FISCAL_VALIDATION_ERROR' });
  input.taxReview.discountTreatment = 'unconditional';
  let payload = JSON.parse(buildFocusPayload(input, snapshot).payloadJson);
  assert.equal(payload.valor_servico, 150); assert.equal(payload.desconto_incondicionado, 10);
  input.taxReview.discountTreatment = 'conditional';
  payload = JSON.parse(buildFocusPayload(input, snapshot).payloadJson);
  assert.equal(payload.desconto_condicionado, 10); assert.equal(payload.desconto_incondicionado, undefined);
  body.taxReview.ibsCbsRequired = true;
  assert.throws(() => validateDraftInput(body), { code: 'FISCAL_VALIDATION_ERROR' });
  Object.assign(body.fiscal, { finalidade_emissao: '0', consumidor_final: '1', codigo_indicador_operacao: '010101', indicador_destinatario: '0', ibs_cbs_situacao_tributaria: '000', ibs_cbs_classificacao_tributaria: '000001' });
  assert.equal(validateDraftInput(body).taxReview.ibsCbsRequired, true);
});
