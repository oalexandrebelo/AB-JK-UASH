import { createPinnedHttpsTransport, FiscalTransportError, validateFiscalOrigin } from './transport.mjs';
export { FiscalTransportError, createPinnedHttpsTransport, isGlobalAddress } from './transport.mjs';
export { FISCAL_FIELDS, REQUIRED_FISCAL_FIELDS, validateDraftInput, buildFocusPayload } from './payload.mjs';

export const FISCAL_STATUSES = Object.freeze(['prepared','submitting','uncertain','pending','reconciling','authorized','rejected','cancelled','provider_cancelled']);
export const FISCAL_ROLES = Object.freeze(['admin','manager']);
export const FISCAL_SCHEMA_VERSION = 'focus-nfsen-v2/2026-10-20';
export const FOCUS_ORIGINS = Object.freeze({
  sandbox: 'https://homologacao.focusnfe.com.br',
  production: 'https://api.focusnfe.com.br',
});
export const FISCAL_LEASE_MS = 45_000;
const FOCUS_HOSTS = Object.freeze(['homologacao.focusnfe.com.br', 'api.focusnfe.com.br']);
const PROVIDER_STATUSES = new Set(['processando_autorizacao','autorizado','erro_autorizacao','cancelado','processando_cancelamento']);

// Only deployment configuration can choose an endpoint. Tokens stay in closures.
export function fiscalConfiguration(env = process.env) {
  const provider = env.AB_UASH_FISCAL_PROVIDER || 'focusnfe';
  const environment = env.AB_UASH_FISCAL_ENVIRONMENT || null;
  const configured = env.AB_UASH_FISCAL_ENABLED === 'true';
  let disabledReason = configured ? null : 'FISCAL_DISABLED';
  let origin = null;
  let authorization = null;
  let allowedHosts = [];
  if (configured) {
    if (!['focusnfe','gateway'].includes(provider)) disabledReason = 'FISCAL_PROVIDER_INVALID';
    else if (!['sandbox','production'].includes(environment)) disabledReason = 'FISCAL_ENVIRONMENT_REQUIRED';
    else if (provider === 'focusnfe') {
      const token = env.AB_UASH_FOCUS_NFE_TOKEN;
      if (typeof token !== 'string' || !/^[^\s:]{8,512}$/u.test(token)) disabledReason = 'FISCAL_CREDENTIALS_MISSING';
      else {
        origin = FOCUS_ORIGINS[environment];
        allowedHosts = FOCUS_HOSTS;
        authorization = `Basic ${Buffer.from(`${token}:`).toString('base64')}`;
      }
    } else {
      const token = env.AB_UASH_FISCAL_GATEWAY_TOKEN;
      const host = env.AB_UASH_FISCAL_GATEWAY_ALLOWED_HOST;
      try {
        origin = validateFiscalOrigin(env.AB_UASH_FISCAL_GATEWAY_ORIGIN, typeof host === 'string' ? [host] : []);
        allowedHosts = [host];
      } catch { disabledReason = 'FISCAL_ENDPOINT_REJECTED'; }
      if (typeof token !== 'string' || !/^[^\s]{8,512}$/u.test(token)) disabledReason ||= 'FISCAL_CREDENTIALS_MISSING';
      else authorization = `Bearer ${token}`;
    }
  }
  return { enabled: configured && !disabledReason, disabledReason, provider, environment, origin, authorization, allowedHosts };
}

export function createFiscalTransport({ env = process.env } = {}) {
  const configuration = fiscalConfiguration(env);
  if (!configuration.enabled) return async () => { throw new FiscalTransportError(configuration.disabledReason); };
  return createPinnedHttpsTransport({
    origin: configuration.origin, allowedHosts: configuration.allowedHosts, authorization: configuration.authorization,
  });
}

export function publicFiscalConfiguration(configuration) {
  return {
    enabled: configuration.enabled, disabled: !configuration.enabled, disabledReason: configuration.disabledReason,
    provider: ['focusnfe','gateway'].includes(configuration.provider) ? configuration.provider : null,
    environment: ['sandbox','production'].includes(configuration.environment) ? configuration.environment : null,
    canPrepareLocally: true, requiresInternetForEmission: true,
    schemaVersion: FISCAL_SCHEMA_VERSION, homologated: false,
    capabilities: { prepare: true, submit: configuration.enabled, reconcile: configuration.enabled, cancelLocalDraft: true, cancelAuthorizedInvoice: false },
  };
}

export function interpretFocusResponse(response, action, expectedRef) {
  if (expectedRef && response?.body?.ref !== undefined && response.body.ref !== expectedRef) {
    return { status: 'uncertain', providerStatus: null, errorCode: 'FISCAL_REFERENCE_MISMATCH' };
  }
  const statusCode = response?.statusCode;
  const rawStatus = response?.body?.status;
  const providerStatus = PROVIDER_STATUSES.has(rawStatus) ? rawStatus : null;
  if (Number.isInteger(statusCode) && statusCode >= 200 && statusCode < 300) {
    if (providerStatus === 'autorizado') return { status: 'authorized', providerStatus, errorCode: null };
    if (providerStatus === 'cancelado') return { status: 'provider_cancelled', providerStatus, errorCode: null };
    if (providerStatus === 'erro_autorizacao') return { status: 'rejected', providerStatus, errorCode: 'FISCAL_PROVIDER_REJECTED' };
    if (providerStatus === 'processando_autorizacao' || providerStatus === 'processando_cancelamento' || statusCode === 202) {
      return { status: 'pending', providerStatus, errorCode: null };
    }
  }
  // An error HTTP status cannot safely release the order/DPS when the body
  // reports processing, an existing document or an unknown state. Reconcile it.
  if (action === 'submit' && [400, 401, 403, 422].includes(statusCode)
    && (rawStatus === undefined || providerStatus === 'erro_autorizacao')) return { status: 'rejected', providerStatus: null, errorCode: 'FISCAL_PROVIDER_REJECTED' };
  // Neither 404 nor 409 proves that a previously transmitted POST never existed.
  return { status: 'uncertain', providerStatus, errorCode: statusCode === 404 ? 'FISCAL_REFERENCE_NOT_FOUND' : 'FISCAL_RESPONSE_UNCONFIRMED' };
}
