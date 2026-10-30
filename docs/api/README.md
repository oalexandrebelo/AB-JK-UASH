# API AB-UASH

O documento `openapi.json` usa **OpenAPI 3.1.0 / JSON Schema 2020-12** e descreve 128 operações: 127 disponíveis no SDK e o receptor Asaas autenticado por header próprio. O SDK TypeScript/JavaScript em `sdk/` cobre 90 operações da aplicação/autenticação, 8 fiscais, 2 de transição, 4 de acervo documental, 4 de preparação/diagnóstico TEF, 3 de equipe, 12 da ponte JK e 4 do importador de dados. As sondas `/api/ready` e o perfil público `/api/public/profile` ficam fora deste contrato. Seu README contém exemplos executáveis de autenticação, chamadas, idempotência, cancelamento e implantação.

## Convenções

Sucesso:

```json
{ "ok": true, "data": { "item": {} } }
```

Erro:

```json
{
  "ok": false,
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "O registro foi atualizado. Recarregue os dados antes de tentar novamente.",
    "details": { "currentVersion": 2 },
    "requestId": "identificador-da-requisicao"
  }
}
```

`details` é opcional. O cabeçalho `X-Request-Id` correlaciona a resposta. Os exemplos de `item` acima mostram somente o envelope; o OpenAPI descreve os campos completos de cada operação.

Mutação autenticada usa `Content-Type: application/json`, cookie de sessão e `X-CSRF-Token`. Mutações de domínio e fiscais também exigem `Idempotency-Key` (8–128 letras, números, hífens ou sublinhados). O mesmo usuário pode repetir o mesmo método, caminho e JSON canônico com a mesma chave. Uma mudança de conteúdo com a chave reutilizada retorna `409 IDEMPOTENCY_CONFLICT`.

Login/setup/logout/troca da senha própria, criação de usuário e PATCH de usuário não possuem idempotência. A definição administrativa da primeira senha, em `POST /api/users/{userId}/initial-password`, exige CSRF e `Idempotency-Key`, sem versão. `PATCH /api/users/{userId}` não recebe versão. Alterações de domínio recebem `version`; conflitos retornam `409 VERSION_CONFLICT`. O SDK não repete chamadas automaticamente.

`GET /api/status` e `/api/auth/session` retornam `setupRequired`, `setupTokenRequired`, `storageMode`, `user` e, havendo sessão, `csrfToken`/`expiresAt`. O armazenamento é `local` ou `postgres`. Quando a primeira configuração exige proteção adicional, `POST /api/setup` recebe `X-Setup-Token` com 32–256 caracteres URL-safe; um valor ausente/incorreto produz `403 SETUP_TOKEN_REQUIRED`.

## Famílias e contagem

| Família | Operações | Observação |
| --- | ---: | --- |
| Saúde, status, sessão, autenticação, usuários e auditoria | 12 | Usuários retornam `user`; listas de usuários/auditoria sem `page` |
| Clientes, veículos, serviços, funcionários, produtos e pacotes | 24 | GET lista/item, POST e PATCH por coleção |
| Ordens e ações, incluindo consumo e créditos | 11 | Estado, pagamentos, checklist, consumo/reversão, resgate/reversão |
| Fotos | 4 | Lista sem paginação, leitura de data URI, inclusão, legenda |
| Movimentos de produto | 2 | Consulta e alteração |
| Caixa | 6 | Atual, histórico, abertura, movimento e fechamento |
| Faturas | 5 | Consulta, criação, pagamento e cancelamento |
| Vendas de pacote e pagamentos globais | 4 | Compra de pacote e consultas |
| Folha | 7 | Consulta, geração, ajuste, recálculo, aprovação e pagamento |
| Agendamentos | 5 | Consulta, criação, alteração e conversão em OS |
| Mensagens | 6 | Rascunho/fila exclusivamente local |
| Configurações, dashboard e relatórios | 4 | Relatórios discriminados em seis formatos |
| Fiscal | 8 | Status, configuração, lista/item, criação, cancelamento, envio, reconciliação |
| Transição JK | 2 | Consulta e mudança administrativa versionada |
| Acervo documental JK | 4 | Prévia, preservação, situação e linhas |
| TEF e SmartPOS | 4 | Catálogo, plano, alteração e diagnóstico local |
| Equipe JK | 3 | Situação, prévia e preservação sem ativação |
| Ponte de integrações JK | 12 | Prontidão, resumo/fonte da OS, Pix e mensagens |
| Importador de dados JK | 4 | Estado, histórico, prévia e commit administrativo; opção explícita somente clientes |
| **Subtotal SDK** | **127** | **Sem sondas de infraestrutura e perfil público** |
| Receptor Asaas | 1 | Header próprio, fora do SDK de usuário |
| **Total OpenAPI** | **128** | **127 SDK + 1 receptor** |

## Paginação e filtros

| Recurso | Padrão | Máximo | Resposta |
| --- | ---: | ---: | --- |
| Listas de domínio, caixa, folha e relatórios | 200 | 500 | `items` + `page {limit,offset,total,hasMore}` |
| Auditoria | 100 | 500 | `items`; consulta aceita somente `limit` |
| Usuários | Todos | — | `items`; sem paginação |
| Fotos de uma OS | Todas | 8 fotos por OS | `items`; sem paginação |
| Rascunhos fiscais | 50 | 100 | `items` + `page {limit,offset,total}` |

Cada rota declara apenas seus filtros suportados no OpenAPI. Não se deve tratar listas simples como páginas nem enviar genericamente filtros de outra entidade.

## Papéis e campos condicionais

Cada operação declara `x-roles`. `x-idempotent-write` identifica as mutações protegidas por chave.

`admin` controla usuários. `admin` e `manager` controlam os recursos financeiros, folha, auditoria e fiscal. `operator` pode executar a operação diária; ele também pode consultar `/api/cash/current`, mas não histórico/alterações do caixa. `viewer` é somente leitura nos recursos operacionais permitidos.

Salário e comissão padrão de funcionários são omitidos para `operator`/`viewer`. Os totais financeiros de dashboard `receivedTodayCents` e `receivableCents` também são omitidos. Seus schemas não tornam esses campos obrigatórios e registram `x-visible-to-roles`.

## Valores e datas

Dinheiro de domínio usa centavos inteiros; estoque usa milésimos de unidade. Datas de calendário usam `AAAA-MM-DD`. Datas com horário exigem ISO 8601 com `Z` ou deslocamento explícito. Intervalos de relatório usam o fuso do estabelecimento (`America/Sao_Paulo`) e abrangem o dia final completo.

Os totais brutos da folha (`baseCents`, `commissionCents`, `extrasCents` e `deductionsCents`) e a comissão acumulada de uma linha podem exceder o teto de um lançamento individual. O contrato admite inteiros seguros nesses agregados. Isso não amplia os limites de entrada de salário, acréscimos e descontos, nem o limite do total líquido da folha.

Recebimentos são filtrados pela data do lançamento. Serviços entregues usam `deliveredAt`. Estoque e saldo aberto são posições atuais, mesmo quando existe um filtro de período; `positionAsOf` informa o instante da resposta.

Ordens incluem itens com `position` inteiro maior ou igual a zero, usado para ordenação estável entre SQLite e PostgreSQL.

## Fiscal

O formato fiscal preserva códigos em texto e as propriedades oficiais em `snake_case`. A criação exige `taxReview` explícito, dados do tomador e campos fiscais; regras condicionais aparecem nos schemas JSON (`if`/`then`). O SDK não resolve decisões tributárias.

Leitura e ações de um rascunho retornam `data.draft`. Envio/reconciliação usam HTTP 200 para desfecho terminal e 202 para estado pendente/incerto. O rascunho público contém apenas documento mascarado do tomador, resumo e snapshot; não expõe credenciais, payload bruto ou endereço do tomador.

O campo `fiscalValidity` distingue:

- `not_authorized`: sem autorização.
- `test_without_fiscal_validity`: autorizado no ambiente de testes, sem validade fiscal.
- `provider_authorized`: autorização informada pelo provedor em produção.

Cancelar localmente é permitido apenas antes de enviar. Cancelamento de documento autorizado não é oferecido por esta API. Uma situação incerta deve ser reconciliada pelo mesmo `providerRef`, sem novo POST automático ao provedor.

Uma resposta HTTP de erro do provedor que ao mesmo tempo informa autorização, processamento, cancelamento ou um estado desconhecido permanece `uncertain`, mantendo a proteção contra outro envio para a mesma ordem/DPS. A reconciliação consulta a referência original. Quando uma operação perdeu sua trava e outra reconciliação já concluiu o rascunho, o replay sem resposta gravada devolve o estado corrente com HTTP 200 para desfecho terminal ou 202 para pendência. O snapshot e a descrição gerada dos serviços seguem a ordem `position` da OS.

## Fonte e verificação

`scripts/sdk-contract.mjs` é a fonte revisável do contrato. `node scripts/sdk-build.mjs` gera os schemas e tipos e compila o SDK. As definições foram conferidas com `server/application.mjs`, `server/domain-*.mjs`, `server/media.mjs`, `server/fiscal.mjs` e as especificações em `integrations/fiscal/`.

`tests/sdk-contract.test.mjs` mantém um inventário independente das rotas e executa as 127 operações do SDK em dois cenários HTTP reais com SQLite temporário. Cada request/response é conferido com o schema correspondente; os relatórios são exercitados nos seis formatos. Os testes fiscais e dos contratos Asaas/Baileys usam transportes fixture, sem emissão, cobrança, envio ou pareamento real. O receptor Asaas é verificado separadamente sem cookie, com token próprio, persistência/deduplicação e nenhuma baixa financeira. `tests/sdk.test.mjs` cobre o comportamento do cliente e `tests/sdk-types.test.mjs` verifica o contrato TypeScript.

## Preparação TEF e acervo documental

`getJkTefCatalog`, `getJkTefPlan` e `getJkTefDiagnostics` permitem consulta por administrador ou gestor. O catálogo traz `reviewedAt` e etapas `preparationSteps {id,action,evidence}`. O diagnóstico confere somente o plano salvo e devolve `localOnly:true`, `networkAttempted:false`, `hardwareInspected:false`, versão e lacunas por família, sem conteúdo de modelo ou observações. `updateJkTefPlan` exige administrador, versão atual, CSRF e chave de idempotência; recebe somente fornecedores escolhidos, modelo de equipamento e observações. Não envie credenciais ou dados de cartão. O estado é sempre `preparation_only`, com `canSubmit`, `connectionVerified` e `homologated` falsos. Salvar preparação não implementa conectores nem ativa pagamentos; funciona também em consulta paralela.

`getJkHistoryArchiveStatus`, `listJkHistoryArchiveRows`, `previewJkHistoryArchive` e `commitJkHistoryArchive` são administrativos e preservam documentos localmente no SQLite. A prévia exige CSRF; o commit também exige hash revisado e idempotência. Não criam pagamentos, cadastros operacionais ou estoque. `sourceVerified:false` indica ausência de confirmação da origem; os documentos não são sincronizados automaticamente.


## Equipe e primeira senha

`CreateUserInput` é união exclusiva entre criação com senha e `pendingPassword:true` sem senha. Conta pendente retorna `active:false` e `passwordSetupRequired:true` opcional. `setInitialUserPassword` recebe apenas `{password}`, exige administrador atual/CSRF/idempotência e ativa somente conta pendente inativa; não redefine senha existente. O replay deve conservar usuário, caminho, chave e senha iguais; nenhuma senha é retornada.

`GET /api/jk/team/status`, `POST /api/jk/team/preview` e `POST /api/jk/team/commit` exigem administrador. A origem é `jumpcar-ui`, unidade `24453`; a entrada contém de 1 a 100 cadastros com nome, e-mail, `sourceRole`, papel `manager|operator|viewer`, `createEmployee` e telefone opcional. A prévia exige CSRF e devolve hash, contagens e conflitos sem escrever; o commit requer hash exato e idempotência. O resultado `preserved_pending_activation` mantém acessos e profissionais inativos, sem senha/salário/comissão configurados, com `accessEnabled:false` e `payrollEnabled:false`.

## Ponte JK de Pix, mensagens e fiscal

Prontidão/resumo/fonte fiscal e leitura de registros admitem os quatro papéis; mutações exigem administrador/gestor atual. `getJkOrderIntegrations` não é paginado e limita conjuntamente Pix/mensagens a 100 registros, além de 100 rascunhos fiscais. A fonte fiscal devolve dados da ordem, itens, elegibilidade e caminhos do fluxo fiscal; não decide tributação.

Preparação Pix usa o saldo atual da ordem, sem valor informado pelo cliente. O provedor seleciona o ramo da entrada: Asaas exige `customerId` externo e `dueDate`, rejeitando `expiresInSeconds`; Efí/Inter ou sem provedor usam somente `version` e expiração opcional 60–86400. Modelos WhatsApp exigem nome/idioma, parâmetros opcionais e consentimento verdadeiro; o telefone vem da ordem. Baileys usa modelo local configurado, Cloud usa modelo aprovado. Campos de conexão Baileys são opcionais na prontidão e não comprovam entrega.

Envio e conciliação admitem HTTP 202 para incerteza. Não repetir envio para resolver timeout; conciliação Pix consulta a referência original com evidência autenticada e janela de até 31 dias. Cancelamento nesta API atinge somente intenção local nunca enviada. `evidence` admite propriedades específicas dos provedores, sem tornar aceitação, notificação ou homologação equivalentes à quitação.

## Receptor de notificações Asaas

`POST /api/jk/integrations/asaas/webhook` usa exclusivamente `asaas-access-token` de 32–255 caracteres ASCII visíveis. Não usa cookie, CSRF nem `Idempotency-Key`. O token é diferente da chave API Asaas. O OpenAPI declara o esquema de segurança e o header obrigatório; o SDK de usuário não gera uma chamada para esse receptor.

Corpo: JSON bruto UTF-8 até 256 KiB, `Content-Type: application/json` (charset UTF-8 permitido), sem compressão. Exige `id`, `event`, `account.id` e pagamento com `id/billingType/status/value`; `externalReference` é opcional/nula. Propriedades extras são aceitas na raiz, conta e pagamento e não são persistidas como dados privados. A conta deve coincidir com a configuração; eventos válidos de referências externas/não Pix são guardados como ignorados.

A resposta 200 `{received:true,duplicate,ignored}` só ocorre após persistência da pista sanitizada. Identidade por ambiente/conta/evento mantém deduplicação após rotação do token. Conteúdo divergente com o mesmo evento retorna 409; falha de armazenamento retorna 503. O receptor não liquida pagamento, não envia cobrança nem dispara conciliação automática.


## Importação nativa somente de clientes (0.3.1)

As quatro rotas existentes `/api/jk/migration/status`, `/history`, `/preview` e `/commit` agora integram o SDK/OpenAPI. Todas exigem administrador atual. A prévia POST exige CSRF sem escrita; o commit exige também `previewHash` e chave idempotente e retorna 201 na primeira aplicação ou 200 no replay.

O topo aceita opcionalmente `nativeCustomerMode:'customers-only'|'customers-and-vehicles'`. Quando informado, exige **um único** arquivo `customers`, CSV/HTML com o layout nativo original de nove colunas; `dataset` canônico, arquivo extra, outra entidade e valor inválido são recusados. Omissão conserva o fluxo anterior. O cliente deve pedir essa escolha antes da prévia e invalidar hash/consentimento ao alterá-la; preview e commit repetem a mesma opção.

Em `customers-only`, `counts.vehicles` é zero e nenhum proprietário é atribuído. O objeto opcional `nativeCustomerImport` informa modo, linhas/colunas originais, hash literal, contagens de placas/linhas adiadas e linhas ambíguas, com razão `EXPLICIT_CUSTOMERS_ONLY`. No modo completo explícito, a razão é `NATIVE_PLATE_EXTRACTION`. O relatório, lote e auditoria preservam essa decisão; a resposta legada omitida não recebe esse objeto automaticamente.

A origem nativa não fornece ID Jumpcar. O schema `JkMigrationIdentity` conserva `sourceId:null` com `readOnly:true` e `provenance:'snapshot-row'`; IDs técnicos não devem ser convertidos em IDs de origem. Todas as nove colunas ficam em `sourceRows`, com acesso administrativo. Preserve BOM e conteúdo literal para o `snapshotHash`; não usar uma leitura que retire o BOM nem dividir o arquivo sem reconciliação. Isso não resolve conflitos de propriedade, não gera operações/caixa/estoque/folha e não sincroniza snapshots. [Contrato detalhado](../migration-jk.md).
