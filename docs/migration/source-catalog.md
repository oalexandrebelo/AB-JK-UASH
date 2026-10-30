# Catálogo e posição consultável da origem

O módulo `server/jk-source-catalog.mjs` preserva versões imutáveis de dados observados no Jumpcar da unidade **24453 Lava Rápido JK**. Serviços, produtos e posições financeiras continuam sendo referências da origem. Não cria serviço operacional, produto operacional, abertura de estoque, OS, fatura, pagamento, movimentação de caixa ou venda de pacote.

Os valores desconhecidos são `null`. A situação de serviço/produto também pode ser desconhecida. A quantidade do estoque da origem não representa uma contagem física do JK. Todos os preços são centavos inteiros; campos de quantidade permanecem textos da fonte, sem conversão de unidade ou cálculo.

## Integração

Inicializar `initializeJkSourceCatalog(raw)` depois de abrir o SQLite e encaminhar as rotas a `handleJkSourceCatalog(ctx)`. Essas duas ligações pertencem à aplicação hospedeira. A aplicação deve permitir exatamente os dois POSTs de preservação no modo `parallel_readonly`, mantendo os demais bloqueios operacionais.

Exports disponíveis:

- `initializeJkSourceCatalog(raw)`
- `parseJkSourceCatalog(input)`
- `previewJkSourceCatalog(db, input, {authorize}?)`
- `commitJkSourceCatalog(db, input, {actorId, idempotencyKey, authorize}?)`
- `jkSourceCatalogStatus(db)`
- `jkSourceCatalogRows(db, url)`
- `handleJkSourceCatalog(ctx)`
- `SOURCE_CATALOG_COLLECTIONS`

O armazenamento é exclusivamente SQLite local. A API HTTP exige sessão atual de administrador em leituras e escritas, CSRF nos POSTs e `Idempotency-Key` na confirmação. A autorização é refeita dentro da transação, inclusive para replay. Todo chamador da biblioteca deve fornecer `actorId` de um administrador ativo; omissão, `null`, conta ausente, inativa ou sem esse papel são rejeitados antes da gravação ou repetição. O módulo não busca dados remotos nem manipula credenciais Jumpcar.

## Contrato de entrada

Prévia: `POST /api/jk/source-catalog/preview` com `{snapshot}`.

Confirmação: `POST /api/jk/source-catalog/commit` com `{snapshot, previewHash}` e header `Idempotency-Key` de 8–128 letras, números, hífens ou sublinhados.

O snapshot exige todos os campos abaixo. As três coleções devem estar presentes, mesmo quando vazias. Limites: 8 MiB, até 20.000 linhas no total e pelo menos uma linha. Campos não reconhecidos são rejeitados.

```json
{
  "snapshot": {
    "schemaVersion": 1,
    "source": "jumpcar-ui",
    "establishmentId": 24453,
    "observedAt": "2026-10-30T20:00:00.000Z",
    "services": [],
    "products": [],
    "balances": []
  }
}
```

Este exemplo mostra somente o envelope; preencher ao menos uma coleção antes de enviar. `observedAt` é o horário da observação, com fuso explícito, e não a data de criação das entidades. `sourceVerified:false` nos resultados indica que a API preserva a alegação de origem e não autentica a fonte por conta própria.

Todas as linhas exigem estes campos comuns:

| Campo | Tipo e significado |
| --- | --- |
| `sourceRow` | Inteiro positivo, único dentro da coleção. Ordinal da linha coletada, não um ID Jumpcar. Consolidar ativos e inativos com ordinais distintos. |
| `sourceId` | String real de origem, sem espaços e até 256 caracteres, ou `null` quando não foi exposta. Não colocar hash ou nome neste campo. |
| `name` | Texto não vazio, até 240 caracteres; nomes iguais são preservados. |
| `raw` | Objeto com até 80 campos de origem; valores string até 6.000 caracteres, inteiro seguro, booleano ou `null`. Decimais da fonte devem ser texto. Não colocar credenciais. |

Cada campo específico abaixo é obrigatório na linha. Ausência não significa zero ou configuração padrão; para desconhecido, enviar `null`.

### Serviço

| Campo | Tipo |
| --- | --- |
| `category` | string ou `null` |
| `priceCents` | inteiro 0–1.000.000.000 ou `null` |
| `active` | booleano ou `null` |
| `schedulingEnabled` | booleano ou `null` |
| `durationMinutes` | inteiro 1–1440 ou `null` |
| `commissionBps` | inteiro 0–10000 ou `null` |

Exemplo sintético:

```json
{
  "sourceRow": 1,
  "sourceId": null,
  "name": "Lavagem sintética",
  "category": "Veículo pequeno",
  "priceCents": 5000,
  "active": true,
  "schedulingEnabled": false,
  "durationMinutes": null,
  "commissionBps": null,
  "raw": {"Preço": "R$ 50,00", "Situação": "Ativo"}
}
```

Serviços de mesmo nome e categorias distintas são registros distintos. Não há ativação operacional neste módulo. Agendamento desligado não autoriza inferir duração zero, 30 minutos ou comissão zero.

### Produto

| Campos | Tipo |
| --- | --- |
| `sku`, `brand`, `category`, `application`, `unit` | string ou `null` |
| `unitsPerItem`, `sourceQuantity`, `sourceMinimumQuantity` | texto da quantidade na origem ou `null`; não são milésimos operacionais |
| `priceCents`, `costCents` | inteiro 0–1.000.000.000 ou `null` |
| `active` | booleano ou `null` |

Esses campos ficam consultáveis junto dos campos comuns. Por exemplo, `unitsPerItem:"500,00"`, `sourceQuantity:"10,00"` e `unit:"UN"` são preservados sem criar 10 ou 5.000 unidades operacionais. Uma fórmula explicativa mostrada na origem pode ser guardada literalmente em `raw`.

### Posição financeira observada

| Campo | Tipo e limite |
| --- | --- |
| `kind` | `account`, `cash`, `receivable`, `payable`, `customer-credit`, `package-credit` ou `other` |
| `amountCents` | inteiro entre -1.000.000.000 e 1.000.000.000 ou `null`; sinal preservado |
| `currency` | `BRL` |
| `status` | texto da origem ou `null` |
| `asOf` | data/hora da posição com fuso ou `null` se não exposta |

`observedAt` não preenche `asOf` automaticamente. Esta coleção preserva posição observada, não títulos operacionais. Cliente, conta, filtros, intervalo, valor bruto/líquido, taxas, vencimentos, quantidade de créditos e outras colunas da tela podem ser preservados em `raw`, sem inferir vínculos. Não somar automaticamente linhas de naturezas distintas. Saldo de conta, dívida de cliente, caixa físico e crédito de serviço não são intercambiáveis.

## Resultados e consulta

Todos os resultados HTTP usam `{data: ...}`; erros seguem o envelope padrão da aplicação. A prévia não grava snapshot, linhas, auditoria ou chaves de idempotência.

Prévia retorna `status:'PREVIEW'`, `canCommit`, `counts:{services,products,balances}`, `statuses`, `snapshotHash`, `previewHash`, `issues`, `replayAvailable`, `mode:'source-reference'`, `sourceVerified:false`, `operational:false` e contagens zero em `operationalWrites`. `statuses` descreve ativos, inativos e desconhecidos de serviços/produtos; não representa status financeiro.

Confirmação retorna HTTP 201 com `status:'COMMITTED'`, `batchId` e `committedAt`. Repetição retorna HTTP 200 com `status:'REPLAYED'`, o lote original e `Idempotency-Replayed:true`.

- `GET /api/jk/source-catalog/status`: resumo da **última versão confirmada**, incluindo `totalSnapshots`. Sem importação: `status:'not_imported'`, contagens zero e `snapshotHash:null`.
- `GET /api/jk/source-catalog/rows?collection=services&limit=25&offset=0&q=`: itens da **última versão**, paginação `{limit,offset,total,hasMore}`. `collection` aceita `services`, `products`, `balances`; máximo 500 por página; busca literal pelo nome.

Cada item retornado possui `id` técnico e todos os campos originais, mais:

```json
{
  "provenance": {
    "source": "jumpcar-ui",
    "establishmentId": 24453,
    "snapshotHash": "sha256-do-snapshot",
    "collection": "services",
    "sourceRow": 1,
    "observedAt": "2026-10-30T20:00:00.000Z"
  }
}
```

O `id` técnico combina hash, coleção e linha. Não substitui `sourceId`. O snapshot JSON completo também permanece guardado. Um mesmo ID real pode aparecer em snapshots diferentes; não é permitido repetir o ID real dentro da mesma coleção de um snapshot.

## Versões, concorrência e repetição

O hash SHA-256 cobre todo o snapshot em JSON canônico, incluindo campos brutos e nulos. A ordenação das chaves de objeto não altera a identidade; a ordem das linhas é preservada.

Um snapshot diferente cria uma nova versão completa e mantém as anteriores. O GET consulta apenas a versão confirmada mais recente pela sequência real de inserção, inclusive quando dois commits têm o mesmo milissegundo. As contagens e os saldos não são somados entre versões. Uma coleção vazia em nova versão significa que a nova posição não contém linhas nessa coleção; o módulo não preenche lacunas com versões antigas.

Reenviar hash já preservado devolve o lote original sem inserir linhas. Reenviar uma versão antiga não muda qual é a versão mais recente. Uma nova confirmação concorrente invalida a prévia da candidata que ainda não havia sido preservada. Alterar conteúdo depois da prévia ou reutilizar chave de idempotência com outro corpo também impede a gravação.

O módulo não certifica que as três coleções representam uma coleta completa ou simultânea: o responsável precisa reconciliar filtros, totais e horários antes da confirmação. A estrutura completa com três arrays impede omissões acidentais de chaves, mas não comprova cobertura da fonte.

## Erros e validação

Principais códigos: `PREVIEW_HASH_REQUIRED`, `PREVIEW_HASH_MISMATCH`, `IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_CONFLICT`, `SOURCE_CATALOG_SCOPE`, `SOURCE_CATALOG_FIELDS_REQUIRED`, `SOURCE_CATALOG_DUPLICATE_ROW`, `SOURCE_CATALOG_DUPLICATE_ID`, `INVALID_SOURCE_CATALOG_INTEGER`, `INVALID_SOURCE_CATALOG_DATE`, `INVALID_SOURCE_CATALOG_PAGE`, `SOURCE_CATALOG_LOCAL_ONLY`, além dos erros padrão de autenticação/CSRF.

Executar `node --test tests/jk-source-catalog.test.mjs` com Node 24. Os testes cobrem prévia sem DML; preservação de nulls/inativos/variantes/unidades; zero efeitos operacionais; snapshots versionados e replay antigo; adulteração e prévia desatualizada; dinheiro e IDs; paginação; rollback tardio; autorização atual inclusive no replay; concorrência; e o handler HTTP em memória, sem escutar uma porta.
