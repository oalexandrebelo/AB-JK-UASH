# Evidência REA da release AB-JK-UASH

A análise estática final recuperou fatos semânticos para **41 fontes críticas em 15 grupos**, sem omissões por recurso ou truncamento semântico nesses grupos. **A cobertura semântica global continua parcial.** Os resultados descrevem fontes como texto inerte; não demonstram execução, entrega em provedores, implantação ou ausência de vulnerabilidades.

O [resumo estruturado](summary-jk.json) contém estatísticas e limitações resumidas. A [cobertura por fonte](coverage-files-v2.json) liga cada arquivo aos hashes e aos IDs de Evidence. O [manifesto das evidências](evidence-manifest.json) registra os nomes, hashes e tamanhos dos envelopes JSON completos, entregues separadamente em pacote privado. Nenhuma conclusão aqui significa “zero vulnerabilidades”.

## Distribuição pública e pacote privado

Este repositório publica os relatórios legíveis, a cobertura, os planos e registros de execução, os manifestos de fontes e os hashes das evidências. **Os 17 envelopes completos comprimidos não fazem parte da publicação pública.** A revisão automática de aprovação bloqueou a publicação de payloads completos comprimidos e opacos no GitHub público; esses arquivos não foram enviados por outro formato ou caminho.

As evidências completas foram preservadas e entregues ao usuário no pacote privado `AB-JK-UASH-REA-20261028.zip`, com **26 arquivos e 20.305.635 bytes**, SHA-256 `d38592abc191252355598c30f319f6b9be8fe1d3b0b4258b22c759a4b4980387`. O pacote contém a cópia original dos relatórios e o `SHA256SUMS` completo, anteriores a esta adaptação de distribuição. Nenhum endereço de acesso privado é publicado aqui.

Os nomes `evidence/*.json.gz` abaixo e nos metadados identificam arquivos dentro desse pacote; não são links de download no repositório. Os IDs de Evidence, as contagens, os hashes das fontes e os resultados da análise permanecem iguais. O [SHA256SUMS público](SHA256SUMS) cobre somente os arquivos publicados desta pasta, exceto ele próprio.

## Identidade congelada

- Snapshot final: V2, 116 arquivos e 972743 bytes de fontes selecionadas.
- Digest agregado do nosso manifesto: `0fd848376f48ce6bf3a2280ec864cf7d1a42085d8a6eb0f982b919638dfc7307`.
- Identidade de artefato do REA: `ae294dd1cf58df889ebc87c32db459934efae7ed834e05a9eeca60bf75c22833`.
- Evidence agregada V2: `ev_ec02b2e2edb6fc4e99048b0f1ffb399318708987025783163b273b907a73900c`.
- Ferramenta: `rea-agents@6.7.0`; o hash do script CLI e da regra de interpretação de parser estão no resumo.
- [Manifesto original V2](source-v2.manifest.json): caminho, tamanho e SHA-256 de cada arquivo.

Os dois digests usam esquemas de identidade diferentes. A identidade REA cobre seu inventário, incluindo o manifesto dentro do staging; o digest do manifesto combina os arquivos de fonte selecionados. Não se espera que sejam iguais. Os hashes das fontes da V2 foram verificados novamente contra o checkout após a análise.

A Evidence agregada V1 (`evidence/aggregate-v1.json.gz`, no pacote privado) e o [manifesto V1](source-v1.manifest.json) são históricos. Entre V1 e V2 mudaram:

- `integrations/jk/README.md`.
- `server/jk-integrations.mjs`.
- `src/jk.css`.
- `src/pages/IntegrationsPage.tsx`.
- `src/pages/InvoicesPage.tsx`.

O resumo conserva os hashes antigos e novos. A Evidence V1 não deve certificar o código modificado da V2. A correção funcional da preparação Pix depende também da revisão e dos testes de comportamento registrados pela entrega; REA não executou o Pix ou os conectores.

## O que o agregado alcançou

O agregado V2 terminou com `ok=true` em **10252ms** e informou 95 arquivos JavaScript/TypeScript parseados, 121381 nós AST visitados e `parse_failures=0`. Isso não tornou sua análise semântica completa:

- 80 arquivos preservaram fatos sintáticos no nó, mas perderam a expansão das relações por limite do orçamento interno do resultado.
- 81 arquivos ficaram sem corpo semântico analisado, com placeholders e `resource-limit`.
- Apenas 14 fontes tinham nós semânticos além do nó de módulo nesse agregado.
- O grafo da aplicação declarou `partial`. O grafo semântico declarou `partial`, com `truncated=true` e contagens omitidas desconhecidas (`null`).
- Houve 3706 unknowns: 972 por recurso, 671 de valor desconhecido, 1.273 de alvo ambíguo, 709 de chamada dinâmica e 81 de propriedade dinâmica. Esses números não são contagens de vulnerabilidades.

O resultado anunciou orçamento interno de `175101176` bytes para projeções da aplicação. O JSON serializado da V2 tem 17459187 bytes. O limite interno observado e o tamanho final do arquivo são medidas distintas.

O campo de inventário `parse_status` também pode ser `partial` quando o extrator encontra sintaxe cujo significado estático não resolve, mesmo com `parse_failures=0`. A implementação REA 6.7.0 usa a condição `parserErrors > 0 || accumulator.unknownFindings > 0`. Preservamos os estados por arquivo; não os reclassificamos como análise completa.

## Resolução focada das perdas por recurso

Os grupos abaixo analisaram caminhos explícitos com `--source-path` repetido. Cada chamada incluiu `package.json`; a contagem de fontes abaixo inclui apenas JS/TS. Dependências não entram implicitamente. A tela de faturas foi incluída por aparecer entre as fontes financeiras alteradas da V2.

| Grupo | Fontes JS/TS selecionadas | Fontes com fatos semânticos além do módulo | `parse_failures` | Duração CLI | Registro no pacote privado |
| --- | ---: | ---: | ---: | --- | --- |
| `auth` | 5 | 5 | 0 | 2949ms | `evidence/v2-auth.json.gz` |
| `bootstrap` | 4 | 4 | 0 | 1703ms | `evidence/v2-bootstrap.json.gz` |
| `database` | 2 | 2 | 0 | 2348ms | `evidence/v2-database.json.gz` |
| `migration` | 3 | 3 | 0 | 2614ms | `evidence/v2-migration.json.gz` |
| `migration-parse` | 1 | 1 | 0 | 1629ms | `evidence/v2-migration-parse.json.gz` |
| `integrations-api` | 3 | 3 | 0 | 3140ms | `evidence/v2-integrations-api.json.gz` |
| `banking` | 3 | 3 | 0 | 2339ms | `evidence/v2-banking.json.gz` |
| `transport` | 4 | 4 | 0 | 2483ms | `evidence/v2-transport.json.gz` |
| `deliveries` | 2 | 2 | 0 | 1947ms | `evidence/v2-deliveries.json.gz` |
| `ui-auth` | 5 | 5 | 0 | 2176ms | `evidence/v2-ui-auth.json.gz` |
| `ui-migration` | 3 | 3 | 0 | 2288ms | `evidence/v2-ui-migration.json.gz` |
| `ui-integrations` | 4 | 4 | 0 | 2308ms | `evidence/v2-ui-integrations.json.gz` |
| `ui-deliveries` | 3 | 3 | 0 | 2239ms | `evidence/v2-ui-deliveries.json.gz` |
| `maintenance` | 4 | 4 | 0 | 2087ms | `evidence/v2-maintenance.json.gz` |
| `ui-invoices` | 3 | 3 | 0 | 2729ms | `evidence/v2-ui-invoices.json.gz` |

Todos os 15 grupos terminaram com `ok=true`, saída de processo 0, **nenhum `resource_constraint`** e **`semantic_graph.coverage.truncated=false`**. Todos os 41 arquivos críticos selecionados produziram nós semânticos além do nó de módulo. Os caminhos exatos e os hashes estão no [plano executado](shard-plan.json); os tempos e códigos de saída medidos estão no [log dos comandos](command-log.json).

Essa resolução é específica ao problema observado de orçamento. Os grafos dos grupos continuam parciais: os arquivos fora da seleção permanecem como `incomplete-module`, e chamadas, propriedades, alvos e valores dinâmicos podem permanecer desconhecidos dentro da seleção. Não unimos grafos de grupos diferentes nem afirmamos provar suas relações cruzadas.

A união do agregado V2 com esses grupos contém nós semânticos além do módulo para 46 das 95 fontes JS/TS do snapshot. As 49 fontes restantes estão enumeradas no resumo como sem corpo semântico retido em qualquer resultado. Elas não se tornam analisadas por existirem no inventário. O escopo exclui `node_modules`, dados privados, `.git`, o build `dist` e OCR compilado.

## Reprodução e preservação

A análise agregada usou heap de 512 MiB, timeout de 120 segundos por fonte e timeout externo de 600 segundos. Cada grupo manteve o mesmo heap e timeout por fonte, com timeout externo de 180 segundos. Nenhuma chamada usou `record-and-continue`: a política de integridade foi a padrão `fail`.

O [plano](shard-plan.json) é um JSON executável: cada item contém o array exato de argumentos `command`, os caminhos selecionados, os hashes esperados e o arquivo de saída. Ele registra o snapshot V2 e o runtime da sessão. Em outro ambiente, prepare o mesmo conjunto de bytes e uma instalação verificada de `rea-agents@6.7.0`, e atualize somente os caminhos do comando. Preserve o manifesto original se precisar reproduzir a mesma identidade de artefato REA.

Não repita uma análise só para obter uma saída menor: os envelopes completos já estão preservados no pacote privado. Para inspecioná-los, extraia o ZIP entregue, descomprima o arquivo selecionado e leia `data.normalized_result`, `data.limitations` e `data.evidence_id`. Para uma nova análise justificada por fontes alteradas ou uma lacuna concreta, o plano pode ser executado por um driver que usa `subprocess.run(item["command"], stdout=arquivo_novo, check=True)`, sem shell e sem substituir saídas existentes. Os comandos não iniciam o aplicativo.

O pacote privado contém 17 arquivos gzip de Evidence, todos menores que 5 MB; o maior tem 2873958 bytes. São os envelopes CLI completos, não apenas sumários. Cada arquivo foi descomprimido localmente e comparado byte a byte com seu JSON original. O manifesto público registra SHA-256 tanto do gzip quanto do JSON original, para permitir a conferência de quem recebeu o pacote.

[SHA256SUMS](SHA256SUMS) cobre somente os arquivos públicos desta pasta, exceto o próprio arquivo de checksums. Para verificar a parte pública da entrega:

```sh
cd docs/rea
sha256sum -c SHA256SUMS
```

As evidências de testes, browser, build, bootstrap e implantação são independentes desses registros estáticos e devem ser avaliadas separadamente. A análise REA não observou credenciais, criou contas, executou migrações ou enviou mensagens/pagamentos.
