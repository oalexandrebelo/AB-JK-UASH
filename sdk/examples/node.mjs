import { createClient, ApiError, TransportError } from '../dist/index.js';

// Usage:
// AB_UASH_URL=http://127.0.0.1:4173 node sdk/examples/node.mjs
// Supply AB_UASH_EMAIL and AB_UASH_PASSWORD privately to list customers.
// Initial setup additionally requires --setup and AB_UASH_NAME.
// If required by the server, supply AB_UASH_SETUP_TOKEN privately.
const client = createClient({
  baseUrl: process.env.AB_UASH_URL || 'http://127.0.0.1:4173',
  mode: 'server',
});
let authenticated = false;
try {
  const status = await client.api.getStatus();
  console.log({ setupRequired: status.setupRequired, setupTokenRequired: status.setupTokenRequired, storageMode: status.storageMode });
  const email = process.env.AB_UASH_EMAIL;
  const password = process.env.AB_UASH_PASSWORD;
  if (process.argv.includes('--setup')) {
    if (!email || !password || !process.env.AB_UASH_NAME) throw new Error('Defina AB_UASH_NAME, AB_UASH_EMAIL e AB_UASH_PASSWORD no ambiente privado.');
    await client.api.setup({ body: { name: process.env.AB_UASH_NAME, email, password } }, process.env.AB_UASH_SETUP_TOKEN ? { setupToken: process.env.AB_UASH_SETUP_TOKEN } : {});
    authenticated = true;
  } else if (email && password && !status.setupRequired) {
    await client.api.login({ body: { email, password } });
    authenticated = true;
  }
  if (authenticated) {
    const { items, page } = await client.api.listCustomers({ query: { active: 'true', limit: 50 } });
    // Only aggregate metadata is printed; no customer PII or session token.
    console.log({ returnedCustomers: items.length, totalCustomers: page.total, hasMore: page.hasMore });
  }
} catch (error) {
  if (error instanceof ApiError || error instanceof TransportError) console.error(error.toJSON());
  else console.error({ error: error instanceof Error ? error.message : 'Falha no exemplo.' });
  process.exitCode = 1;
} finally {
  if (authenticated) {
    try { await client.api.logout({ body: {} }); }
    catch (error) {
      if (error instanceof ApiError || error instanceof TransportError) console.error(error.toJSON());
      process.exitCode = 1;
    }
  }
}
