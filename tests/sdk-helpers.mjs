import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server/application.mjs';
import { createClient } from '../sdk/dist/index.js';
import { schemas } from '../scripts/sdk-contract.mjs';

export const administrator = { name: 'Administrador SDK', email: 'sdk-admin@example.test', password: 'sdk-test-password-2026' };

export async function fixture(t, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ab-uash-sdk-'));
  await mkdir(join(directory, 'dist'));
  await writeFile(join(directory, 'dist/index.html'), '<!doctype html><title>SDK test</title>');
  const errors = [];
  const app = await createApplication({ dbPath: join(directory, 'app.sqlite'), distDir: join(directory, 'dist'), logger: { error: (error) => errors.push(error) }, ...extra });
  const address = await app.listen({ port: 0 });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const client = createClient({ baseUrl, mode: 'server' });
  t.after(async () => {
    app.server.closeAllConnections();
    await app.close();
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(errors, [], 'Unexpected server errors must not be hidden');
  });
  return { app, client, baseUrl, directory };
}

/** Dependency-free JSON Schema checks for every constraint used by this contract. */
export function checkSchema(schema, value, at = '$') {
  if (schema.$ref) return checkSchema(schemas[schema.$ref.split('/').at(-1)], value, at);
  if ('const' in schema) assert.deepEqual(value, schema.const, `${at}: const`);
  if (schema.enum) assert.ok(schema.enum.includes(value), `${at}: enum ${JSON.stringify(schema.enum)} received ${JSON.stringify(value)}`);
  if (schema.anyOf || schema.oneOf) {
    const matches = (schema.anyOf || schema.oneOf).filter((branch) => { try { checkSchema(branch, value, at); return true; } catch { return false; } });
    assert.ok(schema.oneOf ? matches.length === 1 : matches.length > 0, `${at}: ${schema.oneOf ? 'oneOf' : 'anyOf'} no matching schema: ${JSON.stringify(value)}`);
  }
  if (schema.allOf) for (const branch of schema.allOf) checkSchema(branch, value, at);
  if (schema.if) {
    let matches = true;
    try { checkSchema(schema.if, value, at); } catch { matches = false; }
    if (matches && schema.then) checkSchema(schema.then, value, at);
  }
  if (schema.type === 'null') assert.equal(value, null, `${at}: null`);
  if (schema.type === 'boolean') assert.equal(typeof value, 'boolean', `${at}: boolean`);
  if (schema.type === 'string') {
    assert.equal(typeof value, 'string', `${at}: string`);
    if (schema.minLength !== undefined) assert.ok(value.length >= schema.minLength, `${at}: minLength`);
    if (schema.maxLength !== undefined) assert.ok(value.length <= schema.maxLength, `${at}: maxLength`);
    if (schema.pattern) assert.match(value, new RegExp(schema.pattern), `${at}: pattern`);
    if (schema.format === 'date-time') assert.ok(Number.isFinite(Date.parse(value)) && /T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value), `${at}: date-time`);
    if (schema.format === 'date') assert.equal(new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10), value, `${at}: date`);
  }
  if (schema.type === 'integer' || schema.type === 'number') {
    assert.ok(typeof value === 'number' && Number.isFinite(value), `${at}: number`);
    if (schema.type === 'integer') assert.ok(Number.isSafeInteger(value), `${at}: safe integer`);
    if (schema.minimum !== undefined) assert.ok(value >= schema.minimum, `${at}: minimum ${schema.minimum}, received ${value}`);
    if (schema.maximum !== undefined) assert.ok(value <= schema.maximum, `${at}: maximum ${schema.maximum}, received ${value}`);
    if (schema.multipleOf !== undefined) assert.ok(Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) < 0.000001, `${at}: multipleOf`);
  }
  if (schema.type === 'array') {
    assert.ok(Array.isArray(value), `${at}: array`);
    if (schema.minItems !== undefined) assert.ok(value.length >= schema.minItems, `${at}: minItems`);
    if (schema.maxItems !== undefined) assert.ok(value.length <= schema.maxItems, `${at}: maxItems`);
    if (schema.uniqueItems) assert.equal(new Set(value.map((item) => JSON.stringify(item))).size, value.length, `${at}: uniqueItems`);
    value.forEach((item, index) => checkSchema(schema.items, item, `${at}[${index}]`));
  }
  if (schema.type === 'object' || schema.properties || schema.required) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${at}: object`);
    for (const key of schema.required || []) assert.ok(Object.hasOwn(value, key), `${at}: required ${key}`);
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties?.[key]) checkSchema(schema.properties[key], child, `${at}.${key}`);
      else if (schema.additionalProperties === false) assert.fail(`${at}: unexpected ${key}`);
      else if (typeof schema.additionalProperties === 'object') checkSchema(schema.additionalProperties, child, `${at}.${key}`);
    }
    if (schema.minProperties !== undefined) assert.ok(Object.keys(value).length >= schema.minProperties, `${at}: minProperties`);
  }
}

export async function seedOrder(client, { priceCents = 2500, postpaid = false } = {}) {
  const customer = (await client.api.createCustomer({ body: { name: 'Cliente SDK', postpaid } })).item;
  const vehicle = (await client.api.createVehicle({ body: { customerId: customer.id, plate: `SDK${Math.floor(Math.random() * 100000).toString().padStart(5, '0')}`, model: 'Veículo SDK' } })).item;
  const service = (await client.api.createService({ body: { name: 'Lavagem SDK', priceCents } })).item;
  const order = (await client.api.createOrder({ body: { customerId: customer.id, vehicleId: vehicle.id, items: [{ serviceId: service.id, quantity: 1 }] } })).item;
  return { customer, vehicle, service, order };
}
