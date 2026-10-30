# SDK AB-UASH

Cliente TypeScript e JavaScript ESM da API AB-UASH. O pacote não tem dependências de execução. Usa as APIs Web `fetch`, `Headers`, `AbortController` e `crypto.randomUUID`, disponíveis no Node 24 distribuído com o projeto e em navegadores modernos.

O contrato cobre **136 operações: 90 da aplicação/autenticação, 8 fiscais, 2 de transição, 4 de acervo documental, 4 de preparação/diagnóstico TEF, 3 de equipe, 12 da ponte de integrações JK, 4 do importador operacional/histórico, 5 de conciliação documental e 4 do catálogo da origem**. Os modelos, entradas e assinaturas são gerados da definição revisada em `scripts/sdk-contract.mjs`. O contrato HTTP está em `docs/api/openapi.json` (OpenAPI 3.1). O cliente usa a origem do aplicativo tanto com SQLite local quanto com PostgreSQL no servidor. Recursos exclusivos de SQLite, como o importador JK, a conciliação e os acervos documentais, informam a indisponibilidade nos demais ambientes.

## Compilar e usar

Na raiz do projeto, depois de instalar as dependências de desenvolvimento:

```sh
node scripts/sdk-build.mjs
node --test --test-reporter=tap tests/sdk.test.mjs tests/sdk-contract.test.mjs tests/sdk-types.test.mjs
```

No Linux, o Node incluído pode ser usado no lugar de `node`:

```sh
./runtime/linux-x64/node scripts/sdk-build.mjs
```

A compilação produz JavaScript ESM e declarações TypeScript em `sdk/dist`. O pacote é local; o nome `@ab-uash/sdk` não pressupõe publicação em um registro npm. Em outro projeto:

```sh
npm install /caminho/ab-uash/sdk
```

```ts
import { createClient } from '@ab-uash/sdk';

const client = createClient({ baseUrl: 'http://127.0.0.1:4173' });
const status = await client.api.getStatus();
console.log(status.setupRequired, status.storageMode);
```

Dentro deste repositório, exemplos Node importam `../dist/index.js`. O SDK não depende do código do servidor em execução.

## Endereço e sessão

`baseUrl` deve ser **somente a origem**: protocolo, host e porta opcional. Exemplos válidos são `http://127.0.0.1:4173` e `https://minha-aplicacao.example`. Não acrescente `/api`. O SDK rejeita URL com usuário, senha, caminho, consulta ou fragmento. HTTPS é obrigatório, exceto HTTP em `localhost`, IPv4 `127.0.0.0/8` ou IPv6 `::1`.

Em Node, o padrão é `mode: 'server'`. Cada cliente possui um cookie jar próprio, restrito à origem configurada e mantido exclusivamente em memória. Ele conserva o cookie HttpOnly de `setup`/`login` e o envia nas próximas chamadas. Não há arquivo de sessão, persistência em disco, exportação automática ou registro de credenciais.

Em navegador, use `mode: 'browser'`. O navegador guarda o cookie HttpOnly; o SDK usa `credentials: 'include'` por padrão e não tenta ler ou definir esse cookie. Para restaurar a sessão existente ao abrir a aplicação, chame `getSession()`: o SDK guarda o `csrfToken` da resposta em memória e o envia no cabeçalho `X-CSRF-Token` das mutações autenticadas.

```ts
const client = createClient({
  baseUrl: window.location.origin,
  mode: 'browser',
});

const session = await client.api.getSession();
if (session.user) {
  const { items, page } = await client.api.listCustomers({
    query: { active: 'true', limit: 50, offset: 0 },
  });
  console.log(items.length, page.hasMore);
}
```

A implantação deve permitir a origem usada pelo aplicativo e atender à política de cookies `SameSite=Strict` do servidor. Usar `credentials: 'include'` não contorna CORS, restrições de origem nem `SameSite`. O SDK não cria uma política CORS.

### Autenticar e sair

Receba a senha de uma interface de login ou de uma variável de ambiente privada em um programa Node; não a fixe no código, na URL ou em logs.

```ts
await client.api.login({
  body: { email: inputEmail, password: inputPassword },
});

const { items } = await client.api.listCustomers();
await client.api.logout({ body: {} });
```

`logout` revoga a sessão no servidor e limpa o estado local. `clearSession()` apenas limpa o estado local; não revoga a sessão remota. Uma resposta `AUTH_REQUIRED` também elimina o estado local. `changePassword` recebe a senha atual e a nova, revoga as sessões anteriores e atualiza automaticamente o cookie e o CSRF desta instância.

Use uma instância por usuário/sessão. Evite executar login, logout e troca de senha simultaneamente na mesma instância.

### Primeira configuração protegida

Leia `getStatus()` antes da configuração. `setupRequired` indica ausência do primeiro administrador; `setupTokenRequired` indica exigência do token adicional configurado pelo servidor.

```ts
const status = await client.api.getStatus();
if (status.setupRequired) {
  const session = await client.api.setup(
    { body: { name: inputName, email: inputEmail, password: inputPassword } },
    { setupToken: privateSetupToken },
  );
  console.log(session.user.role); // admin
}
```

`setupToken` é enviado somente no cabeçalho `X-Setup-Token` desta chamada. Deve ter 32–256 letras, números, hífens ou sublinhados. Não é guardado no cliente nem enviado às outras rotas. Quando o servidor não exige token, omita a opção. Um programa Node de configuração pode ler `AB_UASH_SETUP_TOKEN` do ambiente; não inclua esse valor em variáveis públicas de Vite, código de frontend ou arquivos distribuídos.

`setup`, `login`, `logout`, `changePassword`, `createUser` e `updateUser` não possuem proteção de idempotência no servidor. O SDK não aceita `idempotencyKey` nessas operações nem permite prepará-las para replay.

## Chamadas tipadas e formatos exatos

Todos os métodos estão em `client.api`. A forma genérica equivalente é `client.request(operationId, input, options)`. `input` agrupa apenas as partes que a rota aceita:

```ts
const created = await client.api.createCustomer({
  body: { name: 'Cliente de exemplo', kind: 'individual', postpaid: false },
});

const updated = await client.api.updateCustomer({
  path: { id: created.item.id },
  body: { version: created.item.version, phone: '11999990000' },
});

const page = await client.request('listVehicles', {
  query: { customerId: updated.item.id, limit: 50, offset: 0 },
});
```

Os métodos devolvem o conteúdo de `data` do envelope `{ok:true,data}` sem remodelar a estrutura:

| Operações | Retorno do SDK |
| --- | --- |
| Cadastros, ordens, caixa, folha, mensagens | `{ item: ... }` |
| `createUser` e `updateUser` | `{ user: ... }` |
| Listas comuns | `{ items, page: { limit, offset, total, hasMore } }` |
| `listUsers`, `listAudit`, `listOrderPhotos` | `{ items }` |
| `listFiscalDrafts` | `{ items, page: { limit, offset, total } }` |
| Ações e leitura de um rascunho fiscal | `{ draft: ... }` |
| Sessão, status e configuração fiscal | Campos diretamente no objeto |
| Relatórios | `{ items, page, summary, period, type, positionAsOf }` |

`getCurrentCash().item` pode ser `null`. `updateUser` recebe `name`, `role` e/ou `active`, sem `version`. As demais atualizações de domínio usam a versão retornada pela última leitura. Um `VERSION_CONFLICT` exige recarregar o registro e revisar a alteração.

Os parâmetros de filtro são específicos por operação. Por exemplo, `listUsers` não aceita `offset`, `listAudit` aceita apenas `limit` (padrão 100, máximo 500), e fotos não recebem paginação. Listas comuns usam `limit=200`, máximo 500. A lista fiscal usa `limit=50`, máximo 100, e não retorna `hasMore`.

Os valores monetários de domínio são inteiros em centavos. Quantidades de estoque usam milésimos de unidade (`quantityMilli`). Campos decimais fiscais seguem o contrato específico do provedor e não são convertidos pelo SDK.

Na folha, os totais brutos de salário, comissão, acréscimos e descontos podem ultrapassar o limite de um lançamento individual. A comissão de uma linha também pode somar várias ordens. Esses valores agregados continuam sendo inteiros seguros em centavos; os limites dos campos de entrada e do total líquido permanecem descritos no OpenAPI.

### Perfis

O servidor aplica autorização a cada requisição e revalida a sessão dentro das mutações. Os tipos refletem os campos que podem faltar por papel:

- `Employee.baseSalaryCents` e `Employee.commissionBps` só aparecem para `admin` e `manager`.
- `Dashboard.receivedTodayCents` e `Dashboard.receivableCents` só aparecem para `admin` e `manager`.
- `getCurrentCash` admite `admin`, `manager` e `operator`; o restante de caixa exige `admin` ou `manager`.
- Usuários exigem `admin`. Faturas, pagamentos globais, folha, relatórios e fiscal exigem `admin` ou `manager`.
- `viewer` pode consultar os cadastros, ordens, fotos, agenda e mensagens; não pode modificá-los.

Consulte `x-roles` de cada operação no OpenAPI para a matriz completa. Não use o tipo de um objeto como prova de autorização.

## Idempotência, pagamentos e perda de resposta

As mutações de domínio e de fiscal exigem `Idempotency-Key`. Por padrão, o SDK gera uma chave criptograficamente aleatória para uma chamada simples. Pode-se fornecê-la explicitamente na segunda opção. **Nenhuma chamada é repetida automaticamente.**

Para uma operação que precisa sobreviver a falha de rede, prepare-a antes de enviar:

```ts
import { TransportError } from '@ab-uash/sdk';

const payment = client.prepare('recordOrderPayment', {
  path: { orderId: order.id },
  body: {
    version: order.version,
    amountCents: 5000,
    method: 'pix',
    reference: 'Identificador interno da confirmação',
  },
});

try {
  const { item } = await payment.execute({ timeoutMs: 15_000 });
  renderOrder(item);
} catch (error) {
  if (error instanceof TransportError && error.outcome === 'unknown') {
    // A tela deve apresentar a incerteza e guardar este objeto em memória.
    showPendingResult({
      key: payment.idempotencyKey,
      retry: () => payment.execute(),
    });
  } else {
    throw error;
  }
}
```

`prepare` captura o JSON, caminho e consulta no momento da preparação. Alterar depois o objeto original não muda a repetição. Todas as chamadas a `execute` usam a mesma chave e o mesmo payload. O servidor devolve o resultado gravado, sem repetir a movimentação. Reutilizar a mesma chave com conteúdo diferente produz `IDEMPOTENCY_CONFLICT`.

O replay fica vinculado ao usuário da sessão: trocar de conta na mesma instância bloqueia a operação preparada. Depois de uma sessão expirar, autentique novamente o mesmo usuário antes de repetir. Isso preserva o escopo por usuário que o servidor aplica à chave idempotente.

O SDK não implementa retry automático de pagamentos. Se a resposta foi perdida após envio, cancelar ou atingir o timeout **não desfaz a operação no servidor**. `TransportError.outcome === 'unknown'` torna essa possibilidade explícita. `idempotencyKey` e `replaySafe` indicam se o replay idêntico está protegido pelo servidor. Para chamadas simples, guarde também a entrada original; prefira `prepare` para preservar o snapshot.

Os objetos preparados são mantidos somente em memória. Reiniciar o processo os perde. Uma aplicação que precise retomar após reinício deve guardar de forma apropriada sua própria chave e entrada original, respeitando a sensibilidade dos dados. O SDK não persiste essa informação.

`idempotencyKey` e `setupToken` exigem strings também em chamadas JavaScript. Números e objetos com conversão implícita para texto são rejeitados antes do envio; isso impede que uma chave preparada mude por alteração posterior de um objeto.

Na emissão fiscal, repetir o pedido com a mesma chave recupera o estado local. Quando o rascunho indica `reconciliationRequired`, use `reconcileFiscalDraft` com a versão atual e uma nova chave para consultar o provedor. Não crie outro envio para tentar resolver um resultado incerto.

## Erros, timeout e cancelamento

```ts
import { ApiError, TransportError } from '@ab-uash/sdk';

const controller = new AbortController();
const request = client.api.listOrders(
  { query: { status: 'waiting', limit: 50 } },
  { signal: controller.signal, timeoutMs: 5000 },
);
// controller.abort() cancela a espera e o fetch.

try {
  const result = await request;
  renderOrders(result.items);
} catch (error) {
  if (error instanceof ApiError) {
    showApiError(error.code, error.message, error.requestId);
  } else if (error instanceof TransportError) {
    showTransportError(error.kind, error.outcome, error.requestId);
  } else {
    throw error;
  }
}
```

`ApiError` contém `status`, `code`, `message`, `details`, `requestId` e a chave idempotente quando aplicável. `TransportError.kind` pode ser `network`, `timeout`, `aborted`, `redirect` ou `protocol`. O SDK não inclui corpos brutos de resposta ou exceções de fetch em seus erros de transporte.

Se o indicador `ok` contradiz o status HTTP, o SDK retorna `TransportError` com `kind: 'protocol'`. Um envelope de erro recebido com HTTP 2xx não é tratado como uma recusa confirmada da aplicação e não apaga a sessão local por alegar `AUTH_REQUIRED`.

O prazo padrão é 15 segundos e cobre tanto o recebimento dos cabeçalhos quanto a leitura integral do corpo. `timeoutMs: 0` desativa o prazo. O `AbortSignal` é encaminhado ao fetch; o SDK também interrompe sua própria espera caso um fetch injetado ignore o sinal.

O SDK usa `redirect: 'manual'` e rejeita respostas de redirecionamento, inclusive `opaqueredirect` no navegador. Não reenvia senha, CSRF, cookies, token de setup ou chave idempotente para outro destino. Um fetch injetado deve honrar esse contrato; código de transporte arbitrário que ignore deliberadamente `redirect: 'manual'` não pode ser controlado pelo SDK.

## Cookie jar do Node

`MemoryCookieJar` é um jar restrito a uma origem da API, não uma implementação geral de navegador:

- Respeita `Path`, expiração, `Max-Age`, `Secure`, `SameSite` e os prefixos `__Host-`/`__Secure-`.
- Isola host, protocolo e porta, e não segue redirecionamentos.
- Aceita cookie host-only e `Domain` exatamente igual ao host da origem.
- Rejeita `Domain` de domínio pai. A restrição é deliberada: sem uma lista de sufixos públicos, o SDK não tenta adivinhar domínios registráveis.
- Aplica contexto same-site por padrão a chamadas servidor-servidor; a API do jar permite contexto explícito para testes e usos avançados.
- Armazena no máximo 100 cookies e não expõe segredos em `JSON.stringify`.

O cookie emitido pelo servidor AB-UASH é host-only, `Path=/`, `HttpOnly`, `SameSite=Strict`; portanto essa restrição é compatível com a API.

## Local, Supabase e Vercel

O SDK sempre chama **o servidor AB-UASH**. Com SQLite, use sua origem local. Em uma implantação Vercel com PostgreSQL/Supabase no backend, use a URL HTTPS do aplicativo, como:

```ts
const client = createClient({
  baseUrl: 'https://sua-implantacao.vercel.app',
  mode: 'server',
});
```

Substitua a URL pelo domínio real. O SDK não chama diretamente a API REST do Supabase, não usa chaves `service_role` nem recebe a URL privada do banco. Credenciais de PostgreSQL, token fiscal e configuração de origem ficam no servidor. Configure o servidor conforme a documentação de implantação da aplicação.

O exemplo executável `examples/node.mjs` usa as mesmas chamadas em ambos os ambientes. `examples/browser.ts` mostra restauração de sessão e login sem embutir credenciais.

## Fiscal

`getFiscalStatus` informa se a integração está habilitada; `getFiscalConfig` fornece as especificações de campos e estados. `createFiscalDraft` exige dados explícitos do tomador, campos fiscais e a revisão tributária (`taxReview`). O SDK preserva esses nomes e valores; não infere classificação, regime ou obrigação de IBS/CBS.

Um rascunho pode existir localmente com integração desativada. Ele não é uma nota fiscal. `submitFiscalDraft`/`reconcileFiscalDraft` podem retornar estado pendente ou incerto com HTTP 202. A propriedade `fiscalValidity` distingue `not_authorized`, `test_without_fiscal_validity` em homologação e `provider_authorized` em produção. A aplicação deve exibir essa distinção.

## Escopo de verificação

A suíte realiza chamadas HTTP reais com SQLite temporário, percorre as 136 operações do SDK em dois cenários isolados e confere entradas/saídas contra os schemas, incluindo os seis formatos de relatório, propostas documentais, revisão explícita de veículo e as três coleções do catálogo da origem. Também cobre quatro papéis, campos condicionais, sessão revogada, troca de senha, token de setup, timeout durante leitura do corpo, cancelamento, bloqueio de redirecionamento e resposta de pagamento perdida seguida de replay.

Os transportes fiscal, Asaas e Baileys desses testes são fixtures em memória; nenhum documento é emitido, cobrança é feita ou mensagem é enviada. O teste dos 12 contratos JK usa Asaas em homologação e uma instância Baileys simulada; isso não prova funcionamento desses provedores. O webhook é exercitado separadamente sem cookie, com header próprio, para conferir persistência/deduplicação e ausência de baixa financeira. Os testes do SDK não comprovam homologação fiscal nem implantação real em Vercel/Supabase. Essas verificações pertencem à integração e ao ambiente de destino.

## Preparação TEF e acervo documental

`getJkTefCatalog`, `getJkTefPlan` e `getJkTefDiagnostics` permitem consulta por administrador ou gestor. O catálogo inclui `reviewedAt` e `preparationSteps` com ação/evidência por família. O diagnóstico lê somente o plano, com `localOnly:true`, `networkAttempted:false` e `hardwareInspected:false`; não retorna notas/modelo nem verifica terminal. `updateJkTefPlan` exige administrador, versão atual, CSRF e chave de idempotência; recebe somente fornecedores escolhidos, modelo de equipamento e observações. Não envie credenciais ou dados de cartão. O estado é sempre `preparation_only`, com `canSubmit`, `connectionVerified` e `homologated` falsos. Salvar preparação não implementa conectores nem ativa pagamentos; funciona também em consulta paralela.

`getJkHistoryArchiveStatus`, `listJkHistoryArchiveRows`, `previewJkHistoryArchive` e `commitJkHistoryArchive` são administrativos e preservam documentos localmente no SQLite. A prévia exige CSRF; o commit também exige hash revisado e idempotência. Não criam pagamentos, cadastros operacionais ou estoque. `sourceVerified:false` indica ausência de confirmação da origem; os documentos não são sincronizados automaticamente.


## Contas pendentes e equipe

`createUser` aceita dois formatos exclusivos: nome/e-mail/papel/senha ou nome/e-mail/papel/`pendingPassword:true` sem senha. O segundo cria conta inativa, com `passwordSetupRequired:true`. A propriedade é opcional em `User` e deixa de aparecer quando a senha existe. Cadastro de acesso e cadastro de profissional são distintos.

`setInitialUserPassword` exige administrador atual, CSRF e idempotência. Recebe `{password}` sem `version`, define a senha somente de uma conta pendente/inativa e ativa seu acesso. Não redefine uma senha já configurada. Para recuperar perda de resposta, preserve o objeto preparado e sua chave em memória; ele contém a senha e não deve ser salvo em logs ou armazenamento público.

```ts
const pending = (await client.api.createUser({body:{
  name: inputName, email: inputEmail, role: 'operator', pendingPassword: true,
}})).user;
const activation = client.prepare('setInitialUserPassword', {
  path: {userId: pending.id}, body: {password: passwordEnteredPrivately},
});
const {user} = await activation.execute();
```

`getJkTeamStatus`, `previewJkTeam` e `commitJkTeam` são administrativos. A entrada traz `source:'jumpcar-ui'`, `establishmentId:24453` e de 1 a 100 pessoas explicitamente revisadas, com nome, e-mail, cargo na origem, papel `manager|operator|viewer`, `createEmployee` e telefone opcional. A prévia exige CSRF, sem idempotência; o commit exige também o `previewHash` exato e chave idempotente. O resultado preserva contas sem senha e inativas, profissionais opcionais inativos e remuneração não configurada. `accessEnabled:false` e `payrollEnabled:false` não são aprovação de ativação ou folha.

## Integrações JK por atendimento

`getJkIntegrationReadiness`, `getJkOrderIntegrations`, `getJkOrderFiscalSource`, `getJkPix` e `getJkMessage` permitem consulta aos quatro papéis. Preparar, enviar, conciliar ou cancelar exige administrador/gestor atual, CSRF, versão e idempotência. O resumo da ordem tem listas sem paginação: até 100 registros Pix/mensagens combinados e até 100 rascunhos fiscais.

Use a prontidão para escolher o formato correto de `prepareJkPix`: Asaas exige `customerId` do cliente já cadastrado no Asaas e `dueDate`; não aceita `expiresInSeconds`. Efí/Inter ou preparação sem provedor aceitam `version` e `expiresInSeconds` opcional de 60 a 86400 segundos (padrão 3600). O corpo não recebe valor, `txid`, conta ou provedor: esses dados vêm do servidor. A união TypeScript impede misturar os ramos; o servidor confere o provedor efetivo.

`prepareJkMessage` recebe `templateName`, `languageCode`, `bodyParameters` opcionais e `consentConfirmed:true`; resolve o destinatário pelo cliente da ordem. Cloud usa modelo aprovado pela Meta; Baileys usa modelo local explicitamente configurado. Não aceita telefone arbitrário ou texto livre por essa rota.

`submitJkPix` e `submitJkMessage` iniciam o envio explícito. Resultado incerto não autoriza novo envio: use `reconcileJkPix` para consulta autenticada da mesma referência/conta/ambiente, com intervalo opcional `start/end` de até 31 dias. `cancelJkPix` e `cancelJkMessage` cancelam somente preparações nunca enviadas; não cancelam cobrança no provedor. Respostas 202 mantêm pendência/incerteza e não equivalem a pagamento ou entrega. Homologação nunca quita a ordem de produção.

A prontidão Baileys pode incluir `connection`, `connectionVerified`, `sendEnabled`, `qrAvailable`, `reconnectAttempts` e `deliveryVerified:false`. Esses campos são condicionais à configuração/instância local. Não há QR, código de pareamento ou credenciais nas respostas. `delivery:'unconfirmed'` continua explícito mesmo quando o socket aceita o envio.

## Receptor Asaas e limites do inventário

O OpenAPI também documenta `POST /api/jk/integrations/asaas/webhook`, que **não é método do SDK de usuário**. O provedor usa `asaas-access-token` próprio, sem sessão, CSRF ou `Idempotency-Key`, e envia JSON bruto UTF-8 não comprimido de até 256 KiB. O receptor confere conta e esquema, admite campos adicionais e só responde 200 após persistir a pista sanitizada; reentrega igual é deduplicada por ambiente/conta/evento. Isso não confirma quitação: a baixa requer a consulta autenticada explícita.

O contrato do SDK não inclui as sondas de infraestrutura `/api/ready` nem o perfil público `/api/public/profile`. O OpenAPI contém 137 operações documentadas (136 de usuário + receptor Asaas); essa contagem não deve ser apresentada como inventário de todo caminho interno do servidor.

### Conciliação documental e revisão de veículos

`getJkReconciliationStatus`, `listJkReconciliationVehicles` e `listJkReconciliationHistory` exigem administrador atual. A preparação usa os acervos já preservados no servidor e o mapa de clientes por arquivo/linha. `previewJkReconciliation({body:{}})` é somente leitura; confirmar seu hash com `commitJkReconciliation` registra vínculos e propostas documentais. Categoria, modelo e `vehicleId` permanecem `null`, e `sourceId` é sempre `null`. Números de OS repetidos continuam sendo linhas diferentes.

Para promover um único candidato, a prévia recebe `vehicleReviews:[{vehicleRef,category,model,color?}]`. Categoria e modelo são obrigatórios e devem ter sido revisados; não há categoria padrão. A confirmação deve repetir essas escolhas e o hash obtido. Placa conflitante, cliente inativo, proprietário existente ou estado alterado bloqueiam a criação. O cadastro de clientes e as informações financeiras não são modificados.

As consultas aceitam `customerId`, `plate`, `status`, `limit` e `offset`. A placa é um filtro exato. No histórico, `customerId` identifica um candidato documental, inclusive quando há divergência: sempre exiba `proposal.status`. `proposal` representa concordância de campos, `insufficient_identity` ausência de contato suficiente e os demais estados descrevem impedimentos. Nenhum deles prova identidade Jumpcar, titularidade histórica ou pagamento. Preserve `sourceVerified:false` e as 30 células originais.

### Catálogo e posições da origem

`previewJkSourceCatalog` e `commitJkSourceCatalog` recebem um `snapshot` completo com `schemaVersion:1`, `source:'jumpcar-ui'`, `establishmentId:24453`, `observedAt` e as listas `services`, `products` e `balances`. Todos os campos de cada linha são obrigatórios; desconhecidos são `null`. Dinheiro usa centavos inteiros, quantidades da origem permanecem texto, e `raw` preserva somente valores simples. Um ID técnico nunca deve ser enviado como `sourceId` da origem.

`getJkSourceCatalogStatus` e `listJkSourceCatalogRows` consultam a última versão preservada. A listagem aceita `collection`, `q`, `limit` e `offset`, e cada linha traz a proveniência do snapshot. Nova versão não soma saldos das anteriores. Esses métodos não ativam serviços ou produtos, não abrem estoque e não criam recebimentos, caixa, títulos ou pacotes. Consulte o [contrato detalhado de catálogo](../docs/migration/source-catalog.md).


## Importador nativo: somente clientes (0.3.1)

`getJkMigrationStatus`, `getJkMigrationHistory`, `previewJkMigration` e `commitJkMigration` expõem as rotas administrativas já existentes do importador. São diferentes do acervo original e do cadastro de equipe. A prévia exige sessão/CSRF; o commit também exige `previewHash` e idempotência. A API é local SQLite; o histórico não gera OS atual, recebimento operacional, caixa, estoque ou folha.

A nova opção `nativeCustomerMode:'customers-only'` é **explícita** e exclusiva de um único arquivo de clientes nativo CSV/HTML com nove colunas, íntegro. Importa clientes, sem criar veículos nem decidir proprietários. `customers-and-vehicles` solicita explicitamente o tratamento completo, sujeito às validações de placa; omitir a opção conserva o comportamento anterior. Não use essa opção com `dataset` canônico, arquivos extras ou outra entidade.

```ts
const input = {
  source: 'jumpcar' as const,
  nativeCustomerMode: 'customers-only' as const,
  files: [{entity: 'customers' as const, format: 'csv' as const, content: originalContent}],
};
const preview = await client.api.previewJkMigration({body: input});
// A pessoa deve conferir contagens, avisos e decisão de não criar veículos.
// Somente após essa conferência explícita:
const operation = client.prepare('commitJkMigration', {
  body: {...input, previewHash: preview.previewHash},
});
```

O trecho prepara a chamada; a aplicação só deve executar `operation.execute()` após o aceite humano. Envie exatamente os mesmos bytes textuais/opção na prévia e no commit. Em navegador, preserve BOM com `new TextDecoder('utf-8',{fatal:true,ignoreBOM:true})`; não remova BOM, espaços ou finais de linha. Qualquer mudança de arquivo ou escolha exige nova prévia e novo consentimento. O servidor vincula a opção a `inputHash` e `previewHash` e rejeita adulteração.

O relatório opcional `nativeCustomerImport` contém modo, `sourceRows`, `sourceColumns:9`, `snapshotHash`, `deferredVehicleEntries`, `deferredVehicleRows`, `ambiguousVehicleRows` e motivo. Linhas originais e as nove colunas ficam preservadas no histórico privado `sourceRows`. `identityMap` informa IDs técnicos de arquivo/linha, com `provenance:'snapshot-row'` e **`sourceId:null` somente leitura**, também `readonly` no TypeScript. Não invente IDs Jumpcar nem deduplique clientes por nome/e-mail/telefone.

A importação somente de clientes não resolve os proprietários adiados. Um snapshot posterior continua exigindo reconciliação explícita; o modo não sincroniza dados e não permite substituir silenciosamente o arquivo original. Consulte [o contrato completo do importador](../docs/migration-jk.md).
