# Revisão do núcleo JK — 30/10/2026

Revisão local do backend derivado do snapshot `5304ee6`, com Node.js 24.22.1 e SQLite. Foram corrigidas quatro falhas no importador e executados **35 testes, 35 aprovados, zero falhas e zero ignorados** no conjunto focado descrito abaixo. Todos os registros, usuários e credenciais de teste são sintéticos. Esta evidência não declara migração real, instalação remota, paridade completa com o sistema de origem ou homologação de fornecedores.

## Correções

### Data de criação dos itens históricos

O contrato aceitava `orderItems.createdAt`, mas a inserção não persistia esse valor, e a tabela histórica não tinha a coluna. O teste novo reproduziu a falha: a consulta retornava `createdAt: undefined` para uma data válida fornecida na entrada.

O importador agora grava a data fornecida, normalizada em UTC. Se o campo for omitido em uma importação nova, grava a data da confirmação, conforme o valor operacional inicial já previsto no contrato. A inicialização adiciona `created_at` aos bancos anteriores dentro de uma transação, sem alterar `PRAGMA user_version`, dados de autenticação, IDs, valores ou vínculos. A atualização é idempotente.

**Limite dos registros antigos:** datas descartadas por versões anteriores não podem ser reconstruídas a partir do hash de origem. Esses itens permanecem com `createdAt: null`. A atualização não atribui uma data histórica inventada nem altera a confirmação original. Uma recuperação futura exigiria consultar a exportação original autorizada e definir uma reconciliação explícita. O teste de atualização preserva o registro e os valores, verifica as chaves estrangeiras, executa a inicialização duas vezes e conserva o replay do lote já confirmado.

Código: [esquema aditivo](../server/jk-migration-schema.mjs), [persistência do importador](../server/jk-migration.mjs).

### Reconciliação de importações incrementais

A validação de uma OS já importada considerava seus itens e recebimentos anteriores, mas o relatório somava somente itens e pagamentos presentes na requisição. Isso permitia um lote válido cujo relatório não representava os mesmos dados que tinham sido validados.

O teste reproduziu uma OS histórica de 9.000 centavos com 1.000 recebidos anteriormente. Um lote posterior com a mesma OS e um novo recebimento de 8.000 mostrava itens líquidos de zero, pagamentos de 8.000 e saldo de 1.000, embora a OS estivesse totalmente quitada após a confirmação.

O relatório agora reconcilia cada OS afetada por inteiro, considerando as linhas anteriores e as do lote, uma única vez por ID. O exemplo retorna OS e itens líquidos de 9.000, pagamentos de 9.000 e saldo zero. Um lote contendo apenas uma linha de pagamento já importada também inclui a OS relacionada em sua reconciliação, evitando saldos negativos artificiais. As contagens `received`, `insert`, `unchanged` e `rejected` continuam referentes aos registros recebidos no lote.

**Interpretação dos totais:** `reconciliation` descreve o estado completo das OS afetadas na conferência. Não representa apenas o incremento financeiro do lote e não deve ser somado entre lotes que revisitem a mesma OS. O endpoint de estado continua calculando os totais globais diretamente das tabelas históricas. Relatórios de lotes confirmados antes desta correção permanecem preservados como resultados históricos; seu replay não recalcula o relatório antigo.

Código: [planejamento e reconciliação](../server/jk-migration.mjs).

### HTML incompleto não pode descartar registros

O parser extraía somente linhas com abertura e fechamento completos. Uma tabela com um cliente válido seguido de outro cliente sem `</tr>` era aceita com apenas o primeiro registro, sem informar a perda. A expressão anterior também permitia fechamento de célula com tipo diferente da abertura.

O parser agora confere o conteúdo que sobra fora das linhas e células completas. Linha incompleta, célula incompleta, fechamento incompatível, linha aninhada e conteúdo fora de uma célula provocam `UNSUPPORTED_HTML_TABLE` antes da criação de qualquer lote. Tabelas simples com `thead`, `tbody`, comentários e células completas continuam aceitas. O parser não executa HTML nem faz solicitações externas.

Código: [parser](../server/jk-migration-parse.mjs).

### Autorização do ator local na confirmação e no replay

A CLI verificava um `--actor-id` informado antes de entrar na transação de confirmação. O núcleo só fazia a autorização atual quando recebia um callback HTTP, deixando a verificação da CLI sujeita à mudança de papel ou desativação entre a leitura e a gravação. O mesmo núcleo também podia retornar uma resposta idempotente a esse ator sem conferir sua situação atual.

Quando existe `actorId`, a confirmação agora exige um administrador ativo dentro da transação, antes da procura pela resposta idempotente ou do primeiro efeito. Isso vale para confirmação nova, replay por chave e replay por lote. A autorização HTTP existente continua verificando sessão e papel atuais. A operação local sem ator mantém sua semântica de autorização pelo acesso ao arquivo privado; ela não cria uma identidade fictícia.

Os testes verificam rejeição sem escrita para papel revogado, rejeição de replay para ator desativado e replay sem duplicidade após a reativação. Nenhuma conta real foi criada ou alterada.

Código: [confirmação autorizada](../server/jk-migration.mjs).

## Pós-pago e concorrência verificados

Um teste novo executa duas instâncias da aplicação com duas conexões ao mesmo arquivo SQLite temporário. O fluxo verifica:

- Emissão concorrente para a mesma OS: uma fatura criada e uma rejeição `ORDER_ALREADY_INVOICED`.
- Cancelamento sem recebimentos, liberação da OS e emissão de uma nova fatura.
- Recebimento parcial concorrente com a mesma chave: um pagamento, uma alocação e um replay.
- Rejeição de recebimento com versão antiga e uma chave diferente.
- Recebimento em dinheiro com caixa fechado: rollback de pagamento, alocação, movimento, auditoria e chave idempotente.
- Quitação concorrente com chaves diferentes: uma baixa aceita e uma rejeição por versão.
- Soma exata de pagamentos, alocações e movimentos em 1.000 centavos, duas auditorias de recebimento e nenhuma violação de chave estrangeira.

Não foi necessário alterar a regra financeira existente para esse fluxo. A evidência demonstra o comportamento de concorrência entre conexões no mesmo processo Node.js. Ela não é um ensaio de carga, nem um teste com múltiplos processos ou servidor PostgreSQL.

Teste: [core-review-20261030.test.mjs](../tests/core-review-20261030.test.mjs).

## Validação executada

```sh
node --test --test-reporter=spec \
  tests/jk-migration.test.mjs \
  tests/core-review-20261030.test.mjs \
  tests/domain.test.mjs \
  tests/security-review.test.mjs \
  tests/jk-bootstrap.test.mjs
```

Resultado: **35 aprovados; zero falhas, cancelados ou ignorados**. O conjunto cobre as 16 verificações de migração, o novo fluxo concorrente de pós-pago, as regras de domínio, revogação de sessão durante leitura HTTP, limites de acesso e o bootstrap local com credenciais exclusivamente sintéticas. A inicialização aditiva foi exercitada tanto em bancos novos como na simulação de um esquema histórico anterior.

Os três testes que identificaram perda de data, saldo incorreto e omissão de linha HTML foram executados antes das correções e falharam pelos motivos documentados. Depois das correções, passaram junto com a suíte existente. Os testes locais não enviaram Pix, mensagens, documentos fiscais, migrações reais ou solicitações a provedores externos.
