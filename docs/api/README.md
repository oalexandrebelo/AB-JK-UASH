# API AB-UASH

O documento `openapi.json` usa **OpenAPI 3.1.0 / JSON Schema 2020-12** e descreve 97 operações públicas do servidor: 89 da aplicação e 8 fiscais. O SDK TypeScript/JavaScript em `sdk/` usa exatamente essas operações. Seu README contém exemplos executáveis de autenticação, chamadas, idempotência, cancelamento e implantação.

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

Autenticação e gerenciamento de usuários não possuem idempotência. `PATCH /api/users/{userId}` não recebe versão. Alterações de domínio recebem `version`; conflitos retornam `409 VERSION_CONFLICT`. O SDK não repete chamadas automaticamente.

`GET /api/status` e `/api/auth/session` retornam `setupRequired`, `setupTokenRequired`, `storageMode`, `user` e, havendo sessão, `csrfToken`/`expiresAt`. O armazenamento é `local` ou `postgres`. Quando a primeira configuração exige proteção adicional, `POST /api/setup` recebe `X-Setup-Token` com 32–256 caracteres URL-safe; um valor ausente/incorreto produz `403 SETUP_TOKEN_REQUIRED`.

## Famílias e contagem

| Família | Operações | Observação |
| --- | ---: | --- |
| Saúde, status, sessão, autenticação, usuários e auditoria | 11 | Usuários retornam `user`; listas de usuários/auditoria sem `page` |
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
| **Total** | **97** | **89 base + 8 fiscais** |

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

`tests/sdk-contract.test.mjs` mantém um inventário independente das rotas e executa as 97 operações por HTTP real com SQLite temporário. Cada request/response é conferido com o schema correspondente; os relatórios são exercitados nos seis formatos. Os testes fiscais usam transporte fixture, não emissão real. `tests/sdk.test.mjs` cobre o comportamento do cliente e `tests/sdk-types.test.mjs` verifica o contrato TypeScript.
