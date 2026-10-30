import { AsaasPixAdapter, asaasAllowedHosts, validAsaasAccountId, validAsaasDateTimeOffset } from './asaas.mjs';
import { AsaasWebhookReceiver, AsyncAsaasWebhookInbox } from './asaas-webhook.mjs';
import { AsyncPixChargeJournal } from './journal.mjs';
import { SecureHttpTransport } from './vendor/connectors/transport.mjs';
import { PixConnectorError, text } from './vendor/connectors/banking/validation.mjs';
import { readPrivateText } from './vendor/integrations/secrets.mjs';

export function parseAsaasConfiguration(entry) {
  const allowed=['kind','environment','apiKeyFile','webhookTokenFile','accountId','dateTimeOffset'];
  if(!entry||typeof entry!=='object'||Array.isArray(entry)||Object.keys(entry).some(key=>!allowed.includes(key))||entry.kind!=='pix-asaas'
    ||!['homologation','production'].includes(entry.environment)||!validAsaasAccountId(entry.accountId)
    ||!text(entry.apiKeyFile,500)||!text(entry.webhookTokenFile,500)
    ||entry.dateTimeOffset!==undefined&&!validAsaasDateTimeOffset(entry.dateTimeOffset)) throw new PixConnectorError('INVALID_CONFIGURATION','REJECTED');
  return {...entry};
}

/** Reads deployment-owned files; never contacts Asaas or runs a schema migration. */
export async function createAsaasConnector(db,entry,{secretsRoot,allowProduction=false}={}) {
  const configuration=parseAsaasConfiguration(entry);
  const [apiKey,authToken]=await Promise.all([readPrivateText(secretsRoot,configuration.apiKeyFile),readPrivateText(secretsRoot,configuration.webhookTokenFile)]);
  if(apiKey===authToken) throw new PixConnectorError('INVALID_CONFIGURATION','REJECTED');
  const transport=new SecureHttpTransport({allowedHosts:asaasAllowedHosts(configuration.environment)});
  const adapter=new AsaasPixAdapter({...configuration,apiKey,allowProduction},transport,new AsyncPixChargeJournal(db));
  const inbox=new AsyncAsaasWebhookInbox(db);
  const webhook=new AsaasWebhookReceiver({...configuration,authToken},inbox);
  return {adapter,scope:adapter.scope,webhook,inbox,transport};
}
