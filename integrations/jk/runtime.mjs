import { createHash } from 'node:crypto';
import { SecureHttpTransport } from './vendor/connectors/transport.mjs';
import { PixBankingAdapter, pixAllowedHosts } from './vendor/connectors/banking/index.mjs';
import { WhatsAppCloudAdapter } from './vendor/connectors/messaging/whatsapp.mjs';
import { readPrivateFile, readPrivateText } from './vendor/integrations/secrets.mjs';
import { AsyncPixChargeJournal } from './journal.mjs';

const fields = {
  'pix-efi': ['clientIdFile','clientSecretFile','pixKeyFile','mtls'],
  'pix-inter': ['clientIdFile','clientSecretFile','pixKeyFile','mtls','accountNumberFile'],
  'whatsapp-cloud': ['phoneNumberId','graphVersion','accessTokenFile'],
};
const required = {
  'pix-efi': ['clientIdFile','clientSecretFile','pixKeyFile'],
  'pix-inter': ['clientIdFile','clientSecretFile','pixKeyFile'],
  'whatsapp-cloud': ['phoneNumberId','graphVersion','accessTokenFile'],
};
function configObject(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('INTEGRATION_CONFIG_INVALID');
  return value;
}
function configText(value) { return typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\u0000-\u001f\u007f]/u.test(value); }
export function parseJkConfiguration(value) {
  const root = configObject(value, ['version','integrations']);
  if (root.version !== 1 || !Array.isArray(root.integrations) || root.integrations.length > 2) throw new Error('INTEGRATION_CONFIG_INVALID');
  const kinds = new Set();
  for (const entry of root.integrations) {
    if (!Object.hasOwn(fields, entry?.kind)) throw new Error('INTEGRATION_CONFIG_INVALID');
    configObject(entry, ['kind','environment',...fields[entry.kind]]);
    if (!['homologation','production'].includes(entry.environment) || required[entry.kind].some(key => !configText(entry[key]))) throw new Error('INTEGRATION_CONFIG_INVALID');
    const channel = entry.kind.startsWith('pix-') ? 'pix' : 'whatsapp';
    if (kinds.has(channel)) throw new Error('INTEGRATION_CONFIG_INVALID');
    kinds.add(channel);
    if (channel === 'pix') {
      const mtls = configObject(entry.mtls, ['pfxFile','certFile','keyFile','passphraseFile']);
      if (Object.values(mtls).some(value => !configText(value)) || (mtls.pfxFile ? mtls.certFile || mtls.keyFile : !mtls.certFile || !mtls.keyFile)) throw new Error('INTEGRATION_CONFIG_INVALID');
      if (entry.accountNumberFile !== undefined && !configText(entry.accountNumberFile)) throw new Error('INTEGRATION_CONFIG_INVALID');
    } else if (entry.environment !== 'production') throw new Error('INTEGRATION_CONFIG_INVALID');
  }
  return root;
}

const blank = (id, label) => ({ id, label, configured: false, provider: null, environment: 'not-configured', state: 'blocked', blockers: ['INTEGRATION_NOT_CONFIGURED'], canPrepareLocally: true, connectionVerified: false, homologated: false });

/** Construction reads deployment-owned files only and never dispatches a request. */
export async function createJkRuntime(db, { env = process.env, now = () => Date.now() } = {}) {
  const channels = { pix: blank('pix','Pix'), whatsapp: blank('whatsapp','WhatsApp') };
  const adapters = new Map();
  const scopes = new Map();
  let storageReady = false;
  try {
    await db.read(async () => {
      await db.prepare('SELECT id,lease_token,lease_expires_at FROM jk_integration_records LIMIT 0').all();
      await db.prepare('SELECT actor_id,idempotency_key FROM jk_integration_operations LIMIT 0').all();
      await db.prepare('SELECT scope,txid FROM jk_pix_journal LIMIT 0').all();
      await db.prepare('SELECT end_to_end_id,payment_id FROM jk_pix_receipts LIMIT 0').all();
      await db.prepare('SELECT id FROM jk_integration_events LIMIT 0').all();
    });
    storageReady = true;
  } catch { /* Schema migrations belong to deployment, not connector startup. */ }
  let configuration;
  if (env.AB_JK_INTEGRATIONS_CONFIG) {
    try {
      if (!configText(env.AB_JK_SECRETS_ROOT)) throw new Error('SECRET_ROOT_REQUIRED');
      const bytes = await readPrivateFile(env.AB_JK_SECRETS_ROOT, env.AB_JK_INTEGRATIONS_CONFIG, 64 * 1024);
      configuration = parseJkConfiguration(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    } catch {
      for (const value of Object.values(channels)) value.blockers = ['INTEGRATION_CONFIG_INVALID'];
    }
  }
  for (const entry of configuration?.integrations || []) {
    const kind = entry.kind.startsWith('pix-') ? 'pix' : 'whatsapp';
    const capability = channels[kind];
    Object.assign(capability, { provider: entry.kind, environment: entry.environment, blockers: [] });
    if (env.AB_JK_INTEGRATIONS_ENABLED !== 'true') capability.blockers.push('EXTERNAL_EFFECTS_DISABLED');
    if (entry.environment === 'production' && env.AB_JK_ALLOW_PRODUCTION !== 'true') capability.blockers.push('PRODUCTION_NOT_ENABLED');
    try {
      const root = env.AB_JK_SECRETS_ROOT || '';
      let adapter, scope;
      if (kind === 'pix') {
        const provider = entry.kind.slice(4);
        const clientId = await readPrivateText(root, entry.clientIdFile);
        const clientSecret = await readPrivateText(root, entry.clientSecretFile);
        const pixKey = await readPrivateText(root, entry.pixKeyFile);
        const accountNumber = entry.accountNumberFile ? await readPrivateText(root, entry.accountNumberFile) : undefined;
        const passphrase = entry.mtls.passphraseFile ? await readPrivateText(root, entry.mtls.passphraseFile) : undefined;
        const mtls = entry.mtls.pfxFile ? { pfx: await readPrivateFile(root, entry.mtls.pfxFile), passphrase }
          : { cert: await readPrivateFile(root, entry.mtls.certFile), key: await readPrivateFile(root, entry.mtls.keyFile), passphrase };
        adapter = new PixBankingAdapter({ provider, environment: entry.environment, clientId, clientSecret, pixKey, accountNumber, mtls },
          new SecureHttpTransport({ allowedHosts: pixAllowedHosts(provider, entry.environment) }), new AsyncPixChargeJournal(db));
        scope = createHash('sha256').update(JSON.stringify([entry.kind,entry.environment,clientId,pixKey,accountNumber || ''])).digest('hex');
      } else {
        adapter = new WhatsAppCloudAdapter({ phoneNumberId: entry.phoneNumberId, graphVersion: entry.graphVersion, accessToken: await readPrivateText(root, entry.accessTokenFile) },
          new SecureHttpTransport({ allowedHosts: ['graph.facebook.com'] }));
        scope = createHash('sha256').update(JSON.stringify([entry.kind,entry.phoneNumberId,entry.graphVersion])).digest('hex');
      }
      capability.configured = true;
      if (!capability.blockers.length) {
        capability.state = 'ready'; adapters.set(kind, adapter); scopes.set(kind, scope);
      }
    } catch { capability.blockers.push('CREDENTIALS_OR_CONNECTOR_INVALID'); }
  }
  if (!storageReady) for (const value of Object.values(channels)) {
    value.state = 'blocked'; value.canPrepareLocally = false; value.blockers.push('INTEGRATION_STORAGE_UNAVAILABLE');
  }
  return { channels, adapters, scopes, storageReady, now, deadlineMs: 60_000, leaseMs: 90_000 };
}

export function jkReadiness(runtime, fiscal) {
  const pix = { ...runtime.channels.pix, capabilities: { prepare: runtime.storageReady, submit: runtime.channels.pix.state === 'ready', reconcile: runtime.channels.pix.state === 'ready', settleProductionOnly: true } };
  const whatsapp = { ...runtime.channels.whatsapp, capabilities: { prepare: runtime.storageReady, submit: runtime.channels.whatsapp.state === 'ready', verifyDelivery: false } };
  const configuration = fiscal?.configuration;
  return {
    pix, whatsapp, storageReady: runtime.storageReady,
    fiscal: { id: 'fiscal', label: 'Fiscal', state: configuration?.enabled ? 'ready' : 'blocked', configured: !!configuration?.enabled,
      provider: ['focusnfe','gateway'].includes(configuration?.provider) ? configuration.provider : null,
      environment: configuration?.environment || 'not-configured', blockers: configuration?.enabled ? [] : [configuration?.disabledReason || 'FISCAL_UNAVAILABLE'],
      canPrepareLocally: true, capabilities: { prepare: true, submit: !!configuration?.enabled, reconcile: !!configuration?.enabled },
      createDraftEndpoint: '/api/fiscal/drafts', invoiceOrigin: 'immutable-order-snapshot', homologated: false },
    rules: { noAutomaticMutationRetry: true, providerAcceptanceIsNotDelivery: true, pixRequiresAuthenticatedEvidence: true, homologationNeverSettles: true },
  };
}
