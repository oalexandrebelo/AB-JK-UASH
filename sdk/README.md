# SDK AB-UASH

Cliente TypeScript e JavaScript ESM da API AB-UASH. O pacote não tem dependências de execução. Usa as APIs Web `fetch`, `Headers`, `AbortController` e `crypto.randomUUID`, disponíveis no Node 24 distribuído com o projeto e em navegadores modernos.

O contrato cobre **97 operações: 89 da aplicação e 8 fiscais**. Os modelos, entradas e assinaturas são gerados da definição revisada em `scripts/sdk-contract.mjs`. O contrato HTTP está em `docs/api/openapi.json` (OpenAPI 3.1). A API usa o mesmo endereço e as mesmas operações com SQLite local ou PostgreSQL no servidor.

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

A suíte realiza chamadas HTTP reais com SQLite temporário, percorre todas as 97 operações e confere entradas/saídas contra os schemas, incluindo os seis formatos de relatório. Também cobre quatro papéis, campos condicionais, sessão revogada, troca de senha, token de setup, timeout durante leitura do corpo, cancelamento, bloqueio de redirecionamento e resposta de pagamento perdida seguida de replay.

O transporte fiscal desses testes é um fixture em memória; nenhum documento é emitido. Os testes do SDK não comprovam homologação fiscal nem implantação real em Vercel/Supabase. Essas verificações pertencem à integração e ao ambiente de destino.
