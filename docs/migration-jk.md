# Migração local JK a partir do Jumpcar

O importador é compatível com o armazenamento assíncrono SQLite do UASH 0.2.1. O contrato canônico deste módulo é **JK schemaVersion 1**; ele não aceita diretamente o envelope `uash-legacy-canonical` de outra versão do sistema.

A importação tem três etapas: prévia somente de leitura, revisão do relatório e confirmação com o SHA-256 da prévia. O commit revalida o conteúdo e o estado do banco dentro de uma transação. Uma falha reverte cadastros, histórico, correspondências de origem, auditoria e resposta idempotente juntos.

As correções de preservação de datas, reconciliação incremental, parsing HTML e autorização do ator estão documentadas na [revisão do núcleo de 30/10/2026](CORE-REVIEW-2026-10-30.md). O contrato de entrada permanece `schemaVersion: 1`; a revisão não declara importação dos dados reais.

## Destinos e limites funcionais

| Entrada | Destino | Efeito |
| --- | --- | --- |
| `customers` | `customers` | Cadastro disponível na operação |
| `vehicles` | `vehicles` | Cadastro disponível, com proprietário validado |
| `services` | `services` | Catálogo disponível, preço em centavos |
| `orders` | `jk_history_orders` | Consulta histórica separada |
| `orderItems` | `jk_history_order_items` | Itens históricos reconciliados com a OS |
| `payments` | `jk_history_payments` | Recebimentos históricos, sem caixa atual |
| Colunas nativas sem representação | `jk_migration_source_rows` | Evidência privada da linha original |

O histórico não cria `orders`, `order_items`, pagamentos operacionais, alocações, faturas, caixa, documentos fiscais, mensagens, agendamentos, estoque, comissão a pagar ou folha. Uma comissão informada em `historicalCommissionCents` é apenas um valor histórico. Os totais históricos são consultados separadamente. O saldo histórico calculado não constitui cobrança em aberto na operação atual.

Não há importação de credenciais, usuários, documentos fiscais autorizados, estornos, anexos, produtos ou despesas neste contrato. Campos ou coleções desconhecidos provocam rejeição explícita. A conta local é configurada pelo fluxo de autenticação existente ou pelo bootstrap autorizado; o importador não altera autenticação.

Os limites são 8 MiB por requisição/arquivo, 20.000 registros por lote e até seis arquivos, um por coleção. Veículos extraídos de uma tabela nativa contam no limite. Valores monetários são inteiros de 0 a 1.000.000.000 centavos; pagamentos precisam ser positivos. Não há arredondamento monetário. O funcionamento é local; PostgreSQL retorna `JK_MIGRATION_LOCAL_ONLY`.

Bases maiores devem ser divididas em lotes: importe clientes, depois veículos e serviços; depois grupos completos de OS com seus itens e pagamentos. Referências por IDs de origem já importados são resolvidas entre lotes. Não separe uma OS de seus itens ou acrescente pagamentos sem incluir a OS para reconciliação. Uma exportação nativa sem IDs não pode ser dividida em arquivos independentes, porque outro snapshot exige reconciliação; nesse caso transforme a extração completa em um contrato canônico reconciliado antes de ultrapassar o limite.

## Integração no aplicativo

```js
import { initializeJkMigration, handleJkMigration } from './jk-migration.mjs';

// Dentro do callback de inicialização SQLite, após migrateDomain(raw):
initializeJkMigration(raw);

// Na cadeia de handlers já protegida pelo aplicativo:
const response = await handleJkMigration(context);
```

O handler usa `readJson`, a sessão existente, `requireRole`, `requireLiveRole` e `verifyCsrf`. A confirmação revalida a sessão e o administrador dentro da transação, inclusive antes de devolver replays. Todas as rotas são exclusivas de administradores ativos. Para chamadas locais com `actorId`, o núcleo também exige que esse ator continue sendo administrador ativo no momento da confirmação ou replay; uma verificação anterior pela CLI não substitui essa conferência.

A inicialização é aditiva, transacional e idempotente; não altera `PRAGMA user_version`. Bancos anteriores recebem a coluna `jk_history_order_items.created_at`. As linhas já existentes ficam com `null`, porque a versão anterior aceitava essa data na entrada, mas não a persistia. Nenhuma data antiga é reconstruída ou preenchida a partir do horário do lote. Inicie a versão atual da aplicação para concluir essa atualização antes de usar a CLI em um banco anterior. A prévia da CLI continua somente de leitura e não atualiza o esquema.

## Contrato HTTP

As respostas abaixo ficam em `data` no envelope habitual `{ok:true,data:...}` da aplicação.

### Prévia

`POST /api/jk/migration/preview`, com sessão e `X-CSRF-Token`:

```json
{
  "source": "jumpcar",
  "scope": "jk",
  "mode": "historical",
  "dataset": {
    "schemaVersion": 1,
    "customers": [],
    "vehicles": [],
    "services": [],
    "orders": [],
    "orderItems": [],
    "payments": []
  }
}
```

`scope` e `mode` são opcionais e, se informados, devem ser `jk` e `historical`. Coleções vazias podem ser omitidas, mas o lote precisa conter pelo menos um registro. Em vez de `dataset`, pode ser enviado `files`:

```json
{
  "source": "jumpcar",
  "files": [
    {
      "entity": "services",
      "format": "csv",
      "content": "sourceId;name;priceCents;durationMinutes\nsintetico-1;Serviço de exemplo;5000;30\n"
    }
  ]
}
```

Os únicos formatos são `csv` e `jumpcar-html`. `dataset` e `files` são mutuamente exclusivos. A interface deve identificar o conteúdo: a extensão `.xls` pode conter CSV ou HTML; XLS binário e XLSX não são interpretados.

O relatório contém:

- `status`: `PREVIEW` ou `REJECTED`.
- `previewHash`: SHA-256 do conteúdo canônico, plano e estado relevante do banco.
- `inputHash`: SHA-256 da entrada JSON com chaves ordenadas, excluindo `previewHash`. Conteúdo textual dos arquivos participa integralmente do hash.
- `canCommit`, `mode`, `source`, `scope` e `sourceVerified:false`.
- `counts`: por coleção, `received`, `insert`, `unchanged`, `rejected`.
- `issues`: lista de `{entity,row,code,message,field?}`. Até 1.000 problemas são detalhados; `totalIssueCount` informa o total. Os erros não ecoam valores pessoais.
- `warnings`: lista de `{code,message,count?}` com transformações e limitações conhecidas.
- `reconciliation`: `ordersTotalCents`, `itemNetTotalCents`, `paymentsTotalCents` e `historicalOutstandingCents` das OS afetadas completas; `operationalWrites` permanece zerado para todos os efeitos operacionais.
- `identityMap`: para clientes/veículos nativos, `{entity,row,importId,sourceId:null,provenance:"snapshot-row",snapshotHash}`. `row` inclui a linha do cabeçalho: o primeiro cliente é a linha 2.
- `replayAvailable:true` quando o mesmo lote já foi confirmado. Neste caso o hash original permanece válido, `insert` é zero e `unchanged` cobre o lote já aplicado.

A prévia não grava batch, arquivo, log ou tabela temporária. O relatório confirma coerência do material fornecido; ele não certifica que a extração incluiu todos os registros existentes no Jumpcar.

**Reconciliação incremental:** cada OS afetada entra uma vez nos totais, considerando seus itens e pagamentos já importados junto com as linhas do lote atual. As OS afetadas incluem as fornecidas diretamente e aquelas referenciadas por itens ou pagamentos do lote, inclusive quando estes registros já existiam. As contagens `received`, `insert`, `unchanged` e `rejected` continuam referentes somente à entrada do lote. Itens ou pagamentos novos ainda exigem a respectiva OS no lote para conferência.

Por exemplo, uma OS de 9.000 centavos com 1.000 já recebidos, revisitada em um lote com pagamento adicional de 8.000, apresenta `ordersTotalCents: 9000`, `itemNetTotalCents: 9000`, `paymentsTotalCents: 9000` e `historicalOutstandingCents: 0`. Os 9.000 centavos de pagamentos são o total reconciliado da OS; somente 8.000 correspondem ao novo recebimento histórico desse lote.

**Não some relatórios de lotes que revisitem a mesma OS.** Isso contaria valores anteriores novamente. Para os totais globais atuais, use `GET /api/jk/migration/status`, que calcula as somas diretamente das tabelas históricas. Os relatórios de lotes já confirmados são preservados como evidência da confirmação; seu replay não recalcula valores nem corrige relatórios produzidos antes da revisão de 30/10/2026.

### Confirmação

`POST /api/jk/migration/commit`, com o mesmo conteúdo da prévia mais `previewHash`, sessão, `X-CSRF-Token` e `Idempotency-Key` de 8 a 128 letras, números, hífens ou sublinhados.

Na primeira aplicação retorna HTTP 201 e `status:"COMMITTED"`. Em repetição idempotente retorna HTTP 200, `status:"REPLAYED"`, `replayed:true` e cabeçalho `Idempotency-Replayed:true`. O resultado contém o relatório, `batchId` e `committedAt`. A operação não atualiza silenciosamente registros já vinculados à origem. Alteração de conteúdo de um mesmo ID exige reconciliação explícita.

Se o conteúdo ou os cadastros/histórico relevantes mudarem desde a prévia, retorna `PREVIEW_HASH_MISMATCH` e solicita nova prévia. Uma mesma chave idempotente com outro conteúdo retorna `IDEMPOTENCY_CONFLICT`. Lotes com rejeições não têm importação parcial.

### Estado e histórico

`GET /api/jk/migration/status` retorna:

```json
{
  "supported": true,
  "mode": "historical",
  "source": "jumpcar",
  "scope": "jk",
  "counts": {"customers":0,"vehicles":0,"services":0,"orders":0,"orderItems":0,"payments":0},
  "totals": {"ordersTotalCents":0,"paymentsTotalCents":0,"historicalOutstandingCents":0},
  "limits": {"maxBytes":8388608,"maxRows":20000},
  "latestBatches": []
}
```

`latestBatches` contém até vinte lotes, com `batchId`, `committedAt`, `counts`, `reconciliation` e `previewHash`. Não contém linhas de origem.

`GET /api/jk/migration/history?entity=orders&limit=100&offset=0` retorna `{mode:"historical",items,page:{limit,offset,total,hasMore}}`. `entity` aceita `orders`, `orderItems`, `payments` ou `sourceRows`. O limite máximo é 500. As chaves dos registros usam camelCase. Em `sourceRows`, `dataJson` é o objeto original com os nove nomes de coluna; este endpoint é privado e autenticado.

## Campos canônicos

Todos os registros canônicos exigem `sourceId` textual, estável, sem espaços, de até 256 caracteres. Números de origem devem ser enviados como strings para preservar zeros iniciais. Os IDs são vinculados ao sistema e escopo; nomes, e-mails e telefones não são chaves de deduplicação. O destino recebe um ID técnico determinístico, guardando o ID real em separado.

Todos aceitam `createdAt`. É obrigatório para OS e pagamentos. Nas demais coleções, uma importação nova usa a data da confirmação quando o valor for omitido, `null` ou vazio; essa data é um valor operacional inicial, sem alegar ser a criação histórica. Datas fornecidas precisam de horário e fuso ISO 8601 e são normalizadas para UTC. `2025-01-02T12:00:00.000Z` é um exemplo sintético.

Para `orderItems`, `createdAt` é persistido em `jk_history_order_items.created_at` e devolvido como `createdAt` no histórico. Itens importados por versões anteriores, que perderam esse campo, permanecem com `createdAt: null` após a atualização aditiva. Repetir o lote não restaura a data: o replay preserva os registros e a resposta existentes. Recuperar uma data perdida exige a exportação original autorizada e uma reconciliação explícita, fora da reaplicação automática deste contrato.

| Coleção | Campos obrigatórios além de `sourceId` | Opcionais e valores iniciais |
| --- | --- | --- |
| `customers` | `name` (2–120 caracteres) | `phone` (até 30), `email`, `kind:"individual"`, `postpaid:false`, `notes`, `active:true`, `createdAt` |
| `vehicles` | `customerSourceId`, `plate`, `model` | `color`, `category:"small"`, `active:true`, `createdAt` |
| `services` | `name`, `priceCents`, `durationMinutes` (1–1440) | `commissionBps:0` (0–10000), `active:true`, `createdAt` |
| `orders` | `number` (string), `customerSourceId`, `vehicleSourceId`, `status`, `subtotalCents`, `totalCents`, `createdAt` | `discountCents:0`, `notes`, `deliveredAt` |
| `orderItems` | `orderSourceId`, `serviceSourceId`, `name`, `quantity`, `unitPriceCents`, `lineTotalCents`, `netCents` | `discountCents:0`, `historicalCommissionCents:0`, `createdAt` |
| `payments` | `orderSourceId`, `customerSourceId`, `amountCents`, `method`, `createdAt` | `reference` |

Em cada referência, `customerImportId`, `vehicleImportId`, `serviceImportId` ou `orderImportId` pode substituir o respectivo `...SourceId`, exclusivamente. Isso permite associar um veículo canônico a um cliente importado de um snapshot sem fingir que o ID técnico veio do Jumpcar. O ID técnico deve existir em uma importação anterior ou no lote atual.

Enums aceitos:

- `kind`: `individual`, `company`.
- `category`: `small`, `medium`, `large`, `motorcycle`.
- `status`: `quote`, `scheduled`, `waiting`, `in_progress`, `quality_check`, `ready`, `delivered`, `cancelled`. Todos continuam sendo somente histórico.
- `method`: `cash`, `pix`, `credit`, `debit`, `transfer`.

As placas são normalizadas para maiúsculas sem espaços/hífens. Uma placa associada a outro registro é rejeitada; não há fusão automática. O veículo precisa pertencer ao cliente da OS, e o pagamento precisa pertencer ao cliente da OS. Cada OS precisa de itens cujo subtotal, desconto e líquido reconciliem exatamente. Pagamentos não podem exceder o total. OS cancelada com recebimento exige reconciliação de estorno e é rejeitada. Itens ou pagamentos novos exigem a respectiva OS no lote.

CSV canônico usa esses nomes de campo no cabeçalho. Aceita `;` ou `,` e aspas CSV. Valores monetários não levam `R$`, separador decimal ou milhar; use centavos inteiros. Booleanos são `true`/`false` ou `1`/`0`. Não são executadas fórmulas.

## Exportação nativa de clientes

São reconhecidos exatamente estes nove cabeçalhos, nesta ordem:

```text
Nome;E-mail;Telefone;Situação da fatura;Data de vencimento;Valor da fatura;Veículos;Vagas;Observação
```

CSV UTF-8 e uma única tabela HTML simples são aceitos. HTML não é executado nem carrega recursos externos. O layout não fornece IDs Jumpcar, data de criação, status ativo individual ou cadastro estruturado dos veículos.

O parser HTML exige linhas e células completas, com fechamento correspondente à abertura. Linhas/células incompletas, fechamento `td`/`th` incompatível, linhas aninhadas e conteúdo fora das células/linhas completas provocam `UNSUPPORTED_HTML_TABLE`; nenhum registro é silenciosamente omitido. Envoltórios `thead`, `tbody` e `tfoot`, comentários e espaços entre linhas são permitidos. Tabelas aninhadas, conteúdo ativo e mesclagem de células não suportada também são rejeitados. Uma tabela visualmente recuperável pelo navegador pode ser recusada pelo importador: corrija a exportação e gere nova prévia.

Por autorização explícita desta implantação, o importador gera uma identidade por SHA-256 do conteúdo exato do arquivo e número da linha. A proveniência é `snapshot-row`, e `sourceId` permanece `null`. Nenhuma igualdade de nome, telefone ou e-mail autoriza deduplicação. O marcador nativo `--` em e-mail, telefone ou observação vira campo vazio; a linha completa original permanece como evidência privada. Nomes legados de um caractere são preservados sem renomear, com aviso de qualidade. Clientes recebem `kind:"individual"`, `postpaid:false`, `active:true` como valores operacionais iniciais declarados na prévia.

Quando a coluna `Veículos` contém somente placas brasileiras válidas, separadas por espaços, vírgula, ponto e vírgula, barra, pipe ou quebra de linha, os veículos são criados e vinculados ao cliente da linha. A identidade técnica combina snapshot, linha e placa; a placa não é apresentada como um ID do Jumpcar. O modelo fica vazio para representar desconhecimento, e `category:"small"` é um valor operacional inicial declarado, sem alegar que a categoria veio da origem. Placas duplicadas entre clientes bloqueiam o lote, sem mesclagem.

Textos mistos ou ambíguos na coluna de veículos são arquivados integralmente e geram `VEHICLE_LAYOUT_REVIEW_REQUIRED`; não se infere cadastro a partir deles. Depois de revisão, veículos canônicos podem usar `customerImportId` para estabelecer o vínculo correto. Vagas e dados de fatura também permanecem em `sourceRows`; não viram OS, fatura ou pagamento automaticamente.

O mesmo snapshot não duplica clientes. Outro snapshot nativo é bloqueado com `SNAPSHOT_RECONCILIATION_REQUIRED`, inclusive se a diferença for apenas ordem de linhas, nova linha ou formatação. Esta versão não aplica automaticamente uma reconciliação entre snapshots. A primeira migração deve usar a exportação completa revisada; a ausência de IDs não permite afirmar que duas exportações têm as mesmas identidades.

## CLI local

O banco deve existir e ter sido aberto pelo aplicativo JK para inicializar as tabelas aditivas. A prévia usa uma conexão SQLite `readOnly:true`; não inicializa esquema nem reescreve o arquivo. A confirmação exige o hash revisado.

```sh
node scripts/jk-import.mjs --db /privado/operacao.sqlite --input /privado/lote.json --preview
node scripts/jk-import.mjs --db /privado/operacao.sqlite --input /privado/lote.json --commit --preview-hash HASH_DA_PREVIA

node scripts/jk-import.mjs --db /privado/operacao.sqlite --input /privado/clientes.xls --format csv --entity customers --preview
```

`--actor-id` opcional associa a execução local a um administrador ativo. O núcleo confere novamente esse ator dentro da transação, antes de gravar ou retornar um replay por lote/chave; ator inexistente, desativado ou sem papel de administrador produz `ADMIN_REQUIRED`. Sem ele, a auditoria identifica uma operação local sem ator HTTP. A CLI depende da autorização de acesso ao arquivo privado; não aceita senhas. Saídas não incluem dados pessoais, caminhos, SQL, stack traces ou mapa de identidades. O mapa está disponível no endpoint de prévia autenticado. Códigos de saída: 0 sucesso, 2 prévia com rejeições, 1 erro de leitura/validação/confirmação.

Mantenha arquivos exportados, bancos, relatórios contendo registros, mapeamentos e credenciais fora do repositório. Fixtures da suíte são exclusivamente sintéticas. A aplicação armazena os dados importados somente no banco privado, e a auditoria recebe somente IDs de lote, hashes e contagens.

## Verificação

```sh
node tests/jk-migration.test.mjs
```

A suíte verifica prévia sem escrita, persistência das seis coleções, ausência de efeitos operacionais, chaves estrangeiras, replay por lote/chave, alteração de conteúdo/banco/hash, rollback após falha tardia na auditoria, órfãos, propriedade de veículo/pagamento, totais, datas, campos não suportados, CSV/HTML, identidade técnica nativa, bloqueio de novo snapshot, CLI somente de leitura e autorização/CSRF/paginação pela aplicação.

As regressões da [revisão de 30/10/2026](CORE-REVIEW-2026-10-30.md) acrescentam data do item persistida, atualização do esquema anterior sem inventar datas, total completo de OS em lotes incrementais, rejeição de HTML truncado e autorização atual do ator local durante confirmação e replay. A evidência dessa revisão usa somente dados sintéticos; os resultados finais de cada release devem permanecer no respectivo registro de entrega.
