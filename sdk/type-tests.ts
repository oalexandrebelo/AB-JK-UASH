import { createClient, type Order, type Customer, type User, type FiscalDraft } from './src/index.js';

const client = createClient({ baseUrl: 'http://127.0.0.1:4173' });
async function compileOnly() {
  const customer: Customer = (await client.api.createCustomer({ body: { name: 'Teste' } })).item;
  const user: User = (await client.api.createUser({ body: { name: 'Usuário', email: 'user@test.test', password: 'test-password', role: 'operator' } })).user;
  const order: Order = (await client.api.getOrder({ path: { orderId: 'order' } })).item;
  const fiscal: FiscalDraft = (await client.api.getFiscalDraft({ path: { draftId: 'draft' } })).draft;
  const prepared = client.prepare('recordOrderPayment', { path: { orderId: order.id }, body: { version: order.version, amountCents: 1000, method: 'pix' } });
  await prepared.execute({ timeoutMs: 1000, signal: new AbortController().signal });
  await client.api.updateCustomer({ path: { id: customer.id }, body: { version: customer.version, active: false } });
  await client.api.updateUser({ path: { userId: user.id }, body: { role: 'manager' } });
  await client.api.getSession();
  await client.request('getHealth');
  await client.api.setup({ body: { name: 'Admin', email: 'admin@test.test', password: 'test-password' } }, { setupToken: 'x'.repeat(32) });
  // @ts-expect-error users are not versioned
  await client.api.updateUser({ path: { userId: user.id }, body: { version: 1, active: false } });
  // @ts-expect-error user response uses user, not item
  (await client.api.createUser({ body: { name: 'User', email: 'u@test.test', password: 'test-password', role: 'viewer' } })).item;
  // @ts-expect-error users do not support pagination
  await client.api.listUsers({ query: { offset: 100 } });
  // @ts-expect-error users do not have page metadata
  (await client.api.listUsers()).page;
  // @ts-expect-error fiscal pagination does not have hasMore
  (await client.api.listFiscalDrafts()).page.hasMore;
  // @ts-expect-error login is not idempotent
  await client.api.login({ body: { email: 'u@test.test', password: 'secret' } }, { idempotencyKey: 'abcdefgh' });
  // @ts-expect-error auth mutations cannot be prepared for replay
  client.prepare('changePassword', { body: { currentPassword: 'secret', newPassword: 'new-secret-password' } });
  // @ts-expect-error password must be present
  await client.api.login({ body: { email: 'u@test.test' } });
  // @ts-expect-error illegal payment method
  await client.api.recordOrderPayment({ path: { orderId: order.id }, body: { version: 1, amountCents: 10, method: 'bitcoin' } });
  // @ts-expect-error setup token is scoped to setup only
  await client.api.getHealth({}, { setupToken: 'x'.repeat(32) });
  // @ts-expect-error stock balances cannot be edited via product PATCH
  await client.api.updateProduct({ path: { id: 'p' }, body: { version: 1, quantityMilli: 500 } });
  return fiscal;
}
void compileOnly;
