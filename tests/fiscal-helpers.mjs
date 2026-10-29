import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { createTestApplication as createApplication } from './database-fixture.mjs';
import { createPinnedHttpsTransport } from '../integrations/fiscal/transport.mjs';

export const enabledEnv = Object.freeze({
  AB_UASH_FISCAL_ENABLED: 'true', AB_UASH_FISCAL_PROVIDER: 'focusnfe',
  AB_UASH_FISCAL_ENVIRONMENT: 'sandbox', AB_UASH_FOCUS_NFE_TOKEN: 'fixture-only-token-not-a-real-credential',
});

export function draftInput(orderId, number = 1001) {
  return {
    orderId,
    customer: {
      taxId: '12345678909', name: 'Pessoa Fictícia para Teste',
      address: { municipalityCode: '3550308', zipCode: '01001000', street: 'Rua do Teste', number: '10', neighborhood: 'Centro' },
    },
    fiscal: {
      data_emissao: '2026-10-20T12:00:00-03:00', data_competencia: '2026-10-20', serie_dps: 999,
      numero_dps: number, emitente_dps: '1', cnpj_prestador: '11222333000181', codigo_municipio_emissora: '3550308',
      codigo_opcao_simples_nacional: '3', regime_tributario_simples_nacional: '1', regime_especial_tributacao: '0',
      codigo_municipio_prestacao: '3550308', codigo_tributacao_nacional_iss: '140101', codigo_nbs: '120019000',
      tributacao_iss: '1', tipo_retencao_iss: '1',
    },
    taxReview: { ibsCbsRequired: false, justification: 'Decisão fictícia exclusivamente para o teste automatizado.', discountTreatment: 'none' },
  };
}

export async function fiscalFixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ab-uash-fiscal-'));
  const errors = [];
  const applicationOptions = { dbPath: join(directory, 'test.sqlite'), fiscalEnv: {}, logger: { error(value) { errors.push(value); } }, ...options };
  let app = await createApplication(applicationOptions);
  let address = await app.listen({ port: 0 });
  let base = `http://127.0.0.1:${address.port}`;
  let cookie = '', csrf = '';
  const peers = [];
  t.after(async () => { for (const peer of peers) await peer.close(); await app.close(); await rm(directory, { recursive: true, force: true }); assert.deepEqual(errors, []); });
  async function call(path, { method = 'GET', body, status = 200, key = randomUUID(), headers = {}, targetBase = base } = {}) {
    const response = await fetch(`${targetBase}/api${path}`, {
      method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), cookie, 'x-csrf-token': csrf, 'idempotency-key': key, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (status !== null) assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`);
    return { status: response.status, response, ...result };
  }
  const setup = await call('/setup', { method: 'POST', body: { name: 'Admin Fiscal de Teste', email: 'admin@example.test', password: 'test-only-fiscal-password' }, status: 201 });
  cookie = setup.response.headers.get('set-cookie').split(';')[0]; csrf = setup.data.csrfToken;
  const create = async (path, body) => (await call(path, { method: 'POST', body, status: 201 })).data.item;
  const customer = await create('/customers', { name: 'Cliente Comercial de Teste' });
  const vehicle = await create('/vehicles', { customerId: customer.id, plate: 'FIS1A23', model: 'Veículo Fictício' });
  const service = await create('/services', { name: 'Lavagem de teste', priceCents: 12345, durationMinutes: 30, commissionBps: 0 });
  const order = (overrides = {}) => create('/orders', { customerId: customer.id, vehicleId: vehicle.id, items: [{ serviceId: service.id, quantity: 1 }], ...overrides });
  const draft = async (item, number = 1001, key) => (await call('/fiscal/drafts', { method: 'POST', body: draftInput(item.id, number), status: 201, key })).data.draft;
  return {
    get app() { return app; }, call, create, order, draft, service, errors,
    async peer() {
      const peer = await createApplication(applicationOptions);
      peers.push(peer);
      const address = await peer.listen({ port: 0 });
      return { call: (path, options) => call(path, { ...options, targetBase: `http://127.0.0.1:${address.port}` }) };
    },
    async restart(overrides = {}) {
      await app.close();
      Object.assign(applicationOptions, overrides);
      app = await createApplication(applicationOptions);
      address = await app.listen({ port: 0 }); base = `http://127.0.0.1:${address.port}`;
    },
  };
}

// The loopback HTTP fixture is injected at the native request seam. Production
// hostname/DNS/HTTPS validation still run, and no env flag permits private egress.
export async function providerFixture(t, handler, { timeoutMs = 1000 } = {}) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = { method: req.method, path: req.url, authorization: req.headers.authorization, body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined };
    calls.push(call);
    await handler(call, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const port = server.address().port;
  const transport = createPinnedHttpsTransport({
    origin: 'https://homologacao.focusnfe.com.br', allowedHosts: ['homologacao.focusnfe.com.br'],
    authorization: `Basic ${Buffer.from(`${enabledEnv.AB_UASH_FOCUS_NFE_TOKEN}:`).toString('base64')}`, timeoutMs,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: (url, options, callback) => {
      assert.equal(new URL(url).hostname, 'homologacao.focusnfe.com.br');
      assert.equal(options.rejectUnauthorized, true);
      return httpRequest(`http://127.0.0.1:${port}${new URL(url).pathname}${new URL(url).search}`, { method: options.method, headers: options.headers, agent: false }, callback);
    },
  });
  return { transport, calls };
}

export function sendProvider(res, statusCode, body) {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
