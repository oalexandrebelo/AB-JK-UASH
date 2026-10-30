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
  const pending: User = (await client.api.createUser({body:{name:'Conta pendente',email:'pending@test.test',role:'viewer',pendingPassword:true}})).user;
  const passwordRequired: true | undefined = pending.passwordSetupRequired;
  await client.prepare('setInitialUserPassword',{path:{userId:pending.id},body:{password:'synthetic-initial-password'}}).execute();
  await client.api.prepareJkPix({path:{orderId:order.id},body:{version:order.version,customerId:'cus_synthetic',dueDate:'2026-11-01'}});
  await client.api.prepareJkPix({path:{orderId:order.id},body:{version:order.version,expiresInSeconds:600}});
  await client.api.prepareJkMessage({path:{orderId:order.id},body:{version:order.version,templateName:'service_ready',languageCode:'pt_BR',consentConfirmed:true}});
  await client.api.getJkTefDiagnostics();
  const reconciliation=await client.api.previewJkReconciliation({body:{}});
  await client.api.commitJkReconciliation({body:{previewHash:reconciliation.previewHash}});
  const documentary=(await client.api.listJkReconciliationVehicles({query:{status:'awaiting_review',plate:'AAA1A11'}})).items[0];
  if(!documentary)throw new Error('Sem candidato para este exemplo compilável.');
  const unknownCategory:null|'small'|'medium'|'large'|'motorcycle'=documentary.category;
  const noSourceId:null=documentary.sourceId;
  await client.api.previewJkReconciliation({body:{vehicleReviews:[{vehicleRef:documentary.vehicleRef,category:'large',model:'Modelo confirmado'}]}});
  // @ts-expect-error category is required and has no automatic default
  await client.api.previewJkReconciliation({body:{vehicleReviews:[{vehicleRef:'vehicle',model:'Modelo'}]}});
  // @ts-expect-error a review cannot replace the owner
  await client.api.previewJkReconciliation({body:{vehicleReviews:[{vehicleRef:'vehicle',category:'small',model:'Modelo',customerId:'other'}]}});
  // @ts-expect-error documentary balances must not be used as payments
  await client.api.commitJkSourceCatalog({body:{snapshot:{},paymentId:'invented'}});
  await client.api.listJkSourceCatalogRows({query:{collection:'balances'}});
  void unknownCategory;void noSourceId;
  const nativeInput={source:'jumpcar' as const,nativeCustomerMode:'customers-only' as const,files:[{entity:'customers' as const,format:'csv' as const,content:'conteúdo sintético de teste'}]};
  const nativePreview=await client.api.previewJkMigration({body:nativeInput});
  await client.api.commitJkMigration({body:{...nativeInput,previewHash:nativePreview.previewHash}});
  const sourceIdentity:null|undefined=nativePreview.identityMap[0]?.sourceId;
  // @ts-expect-error source identity in a native import report is readonly
  nativePreview.identityMap[0].sourceId=null;
  // @ts-expect-error native mode cannot accompany a canonical dataset
  await client.api.previewJkMigration({body:{source:'jumpcar',nativeCustomerMode:'customers-only',dataset:{schemaVersion:1,customers:[{sourceId:'real-id',name:'Cliente'}]}}});
  // @ts-expect-error a technical native identity cannot become an invented Jumpcar source ID
  const inventedSourceId:string=nativePreview.identityMap[0].sourceId;
  void sourceIdentity;void inventedSourceId;
  await client.api.previewJkTeam({body:{source:'jumpcar-ui',establishmentId:24453,users:[{name:'Conta sintética',email:'team@test.test',sourceRole:'Operação',role:'operator',createEmployee:false}]}});
  // @ts-expect-error pending access cannot include a password
  await client.api.createUser({body:{name:'Conta pendente',email:'pending@test.test',role:'viewer',pendingPassword:true,password:'not-allowed'}});
  // @ts-expect-error Asaas input cannot also request bank expiration
  await client.api.prepareJkPix({path:{orderId:order.id},body:{version:1,customerId:'cus_synthetic',dueDate:'2026-11-01',expiresInSeconds:600}});
  // @ts-expect-error Asaas input requires its due date
  await client.api.prepareJkPix({path:{orderId:order.id},body:{version:1,customerId:'cus_synthetic'}});
  // @ts-expect-error consent must be explicitly true
  await client.api.prepareJkMessage({path:{orderId:order.id},body:{version:1,templateName:'ready',languageCode:'pt_BR',consentConfirmed:false}});
  // @ts-expect-error provider webhook is not a cookie-authenticated user SDK action
  await client.api.receiveAsaasWebhook({body:{}});
  void passwordRequired;
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
