# Prontidão da migração JK — 30/10/2026

Esta preparação local não autoriza importação, troca de modo, publicação ou cutover. O Jumpcar permanece a fonte operacional enquanto o JK estiver em `parallel_readonly`; não há sincronização automática. A ferramenta não abre bancos, credenciais, navegador ou rede e não altera os exports.

## Ferramenta local privada

```sh
node scripts/jk-migration-readiness.mjs \
  --customers /privado/clientes.xls \
  --orders /privado/historico.xls \
  --products /privado/produtos.xls \
  --private-dir /privado/reconciliacao-nova
```

Os arquivos `.xls` atuais são CSV UTF-8; a extensão não indica XLS binário. A leitura preserva o BOM e calcula a identidade sobre o conteúdo original. A saída padrão contém somente hashes, contagens e estado da revisão. O diretório privado deve ficar fora do repositório, com permissão 0700; os arquivos são criados com 0600, sem sobrescrita. Nunca publique esses arquivos:

- `inventory.private.json`: rótulos exatos de operador, linhas de entrada/saída e placas conflitantes com candidatos identificados por snapshot/linha.
- `review.private.json`: formulário vazio para decisões explícitas. `employees` recebe somente `{id, active}` dos funcionários já cadastrados e verificados no JK; contas de acesso são um cadastro distinto.

Preencha `operatorMappings` com `{operatorRef, employeeId}`. Preencha `plateDecisions` com `{plateRef, decision: "hold", customerSourceRow: null}` para manter a pendência, ou `{plateRef, decision: "reviewed-owner", customerSourceRow: 123}` para registrar o proprietário revisado entre os candidatos. O número acima é apenas exemplo sintético. Nenhuma decisão altera o cadastro ou elimina outra linha. Nomes iguais, grafias semelhantes, e-mails e contas genéricas não vinculam pessoas automaticamente.

```sh
node scripts/jk-migration-readiness.mjs \
  --customers /privado/clientes.xls \
  --orders /privado/historico.xls \
  --products /privado/produtos.xls \
  --reconciliation /privado/reconciliacao-nova/review.private.json \
  --private-dir /privado/reconciliacao-validada
```

O inventário novo inclui `resolvedOperators` com os IDs fornecidos e as linhas de origem; o formulário novo permanece vazio para uma nova revisão. O validador rejeita IDs desconhecidos/inativos, referências inventadas, decisões duplicadas, proprietários fora do grupo e decisões de outro snapshot. A lista `employees` é uma declaração do operador: deve ser conferida com o cadastro atual; a ferramenta não atesta a existência desses IDs no banco. Uma conta Jumpcar pode ser genérica e um operador histórico pode estar desligado. Não criar pessoas, salário, comissão, login, senha ou endereço de e-mail a partir desses textos.

Saídas: 0 indica revisão de operadores/conflitos de placa completa; 2 indica revisão pendente; 1 indica entrada inválida. `canCommit` é sempre `false`. `REVIEW_COMPLETE` não aprova cadastro operacional, estoque, financeiro ou cutover. Os IDs técnicos representam arquivo/linha; não são IDs estáveis fornecidos pelo Jumpcar. BOM, espaço ou nova exportação mudam o snapshot: use sempre o hash que a prévia efetivamente apresentou e nunca reaproveite confirmações entre conteúdos diferentes.

## Resultado dos exports reais disponíveis

| Export | Linhas | Colunas | Conferência |
| --- | ---: | ---: | --- |
| Clientes | 5.168 | 9 | 5.127 entradas de placas extraídas; 28 linhas de veículos ambíguos |
| Histórico | 10.133 | 30 | R$ 917.018,08; desconto total zero; 5 grupos de números de OS repetidos |
| Produtos | 3 | 8 | Preservação documental; sem conversão para estoque operacional |

Histórico de 08/10/2025 a 30/10/2026. Há 18 grupos de placas repetidas, com 38 entradas e 20 entradas excedentes. São quatro rótulos exatos de operador; nenhum foi associado automaticamente. Os exports duplicados locais de clientes/produtos têm conteúdo idêntico aos respectivos originais.

O tratamento completo do importador nativo de clientes continua rejeitando propriedade de placa conflitante e preservando veículos ambíguos sem criá-los. Registrar uma decisão nesta ferramenta não aplica essa decisão automaticamente no núcleo. Na versão candidata 0.3.1, a escolha explícita `nativeCustomerMode:"customers-only"` permite analisar e importar somente clientes de um único arquivo nativo original de nove colunas, sem criar nenhum veículo nem assumir proprietário. As nove colunas, BOM, hash literal e identidade `snapshot-row`/`sourceId:null` permanecem preservados; relatório e auditoria registram os veículos adiados. A opção deve ser escolhida antes da prévia e repetida no commit; alterá-la invalida hash e consentimento. Omissão ou modo completo explícito mantêm extração/validação de placas e bloqueio dos conflitos. Os 18 grupos e 28 linhas ambíguas continuam pendentes para o cadastro posterior de veículos; a escolha somente clientes não os resolve nem sincroniza snapshots. O arquivo histórico de 30 colunas preserva células e números repetidos, mas não constitui OS operacional, recebimento, pagamento comprovado ou folha. O importador canônico exige referências explícitas e reconciliação das seis coleções suportadas: clientes, veículos, serviços, OS históricas, itens e pagamentos. Funcionários e usuários não fazem parte desse contrato.

A 0.3.0 publicada já preservou os três arquivos no acervo documental e cinco contas pendentes/quatro profissionais inativos. Isso não criou os clientes operacionais. O modo somente clientes pertence ao novo candidato 0.3.1 e ainda exige prévia, confirmação e aceite próprios; esta documentação não declara sua importação em produção.

## Sábado, 31/10 — conferência assistida

1. Manter `parallel_readonly`. Conferir no JK que a autoridade operacional continua no Jumpcar e que novas operações permanecem nele.
2. Preservar os três originais em local privado, com hash e cópia independente. Conferir a prévia documental por tipo: quantidade de linhas/colunas, total em centavos, período, números repetidos e hashes efetivos. Após confirmação autorizada, consultar amostras privadas de início/meio/fim e conferir que nenhum caixa, estoque, comissão ou cobrança foi gerado.
3. Revisar os 18 grupos de placa e as 28 linhas ambíguas com o responsável. Manter linhas sem resposta em espera; nunca deduplicar por nome/telefone ou escolher proprietário pela primeira ocorrência. Mudança no arquivo exige nova prévia e nova reconciliação.
4. Conferir os funcionários reais com o responsável: pessoa, vínculo ativo, função e valores aprovados. Conferir os usuários separadamente: endereço exato confirmado, papel mínimo e acesso testado pelo titular. Usar os IDs atuais do JK no formulário privado; uma lista de usuários não prova a folha de funcionários.
5. Comparar as quatro etiquetas históricas com a lista confirmada; aliases somente por decisão explícita. Guardar o inventário e a revisão fora do repositório. Não converter comissão histórica em obrigação de folha atual.

**Gate:** todos os volumes e totais conferidos; pendências registradas por linha; equipe e acessos confirmados; nenhum vínculo inventado. Pendência impede a parte operacional correspondente, ainda que o arquivo documental esteja íntegro.

## Domingo, 01/11 — ensaio e recuperação

1. Usar cópia isolada do banco e a mesma versão candidata. Executar `node scripts/jk-maintenance.mjs once` com configuração da cópia, exigir backup/manifesto e prova `.restore-check.json`, e guardar cópia do par em outro destino privado. Não basta copiar um SQLite aberto.
2. Restaurar o backup para arquivo novo com `node scripts/restore.mjs --from /privado/backup.sqlite --to /privado/ensaio-restaurado.sqlite`. Exigir integridade, chaves estrangeiras, revogação de sessões e auditoria de restauração. Reabrir a cópia e conferir histórico, equipe, acesso e contagens; medir o tempo real de recuperação. Nunca apontar esse ensaio ao banco vivo.
3. Conferir clientes/veículos revisados e catálogo/preços aprovados. Ensaiar em cópia: OS, serviço, responsável, recebimento, cancelamento/estorno e fechamento de caixa, com saldos e auditoria antes/depois. Integrações externas exigem evidência própria e autorização específica; a existência de configuração ou formulário não prova funcionamento.
4. Definir responsável e horário do corte, como tratar OS abertas, pagamentos pendentes, pacotes/créditos e cadastros alterados no fim de semana. Como não há sincronização nem reconciliação de novo snapshot implementada, não importar novamente clientes sobre a primeira exportação: registrar cada delta e reconciliar explicitamente ou adiar o corte.

**Gate:** restauração real e ensaio aprovados; catálogo/equipe e cada delta conferidos; nenhuma pendência financeira ou externa sem decisão; responsáveis concordam com tempo e procedimento de recuperação.

## Segunda-feira, 02/11 — cutover condicionado

02/11 é a data pretendida; os gates prevalecem. O responsável deve confirmar se haverá operação local nesse dia e a janela disponível.

1. Obter autorização explícita de cutover. Encerrar/congelar a escrita operacional no Jumpcar no horário combinado, fechar ou listar as pendências e registrar os saldos de caixa/contas/créditos e a última OS. Preservar export final e lista dos deltas sem substituir snapshots já importados.
2. Gerar backup consistente do JK imediatamente antes do corte, com manifesto, restauração de prova e cópia independente. Registrar versão/imagem efetiva, banco, modo/versão de transição e hashes sem expor segredos.
3. Conferir que deltas, placas e proprietários, funcionários/usuários, serviços/preços e saldos de abertura têm decisão verificável. O total documental de R$ 917.018,08 não é saldo de caixa nem prova de contas a receber.
4. Somente após os gates, o administrador autorizado muda para `normal`, usando a versão atual de transição. Conferir no JK autoridade `jk`, acesso por função e um fluxo real supervisionado, com valores aprovados, retorno e auditoria. Não registrar a mesma operação nos dois sistemas.
5. Acompanhar o primeiro caixa e as primeiras OS, guardar evidências privadas e definir quem decide interromper o uso. Falha de proprietário/equipe, perda ou duplicação financeira, acesso indevido ou indisponibilidade sem recuperação testada exige interromper novos registros.

## Rollback real

Não há rollback automático da importação, sincronização de volta ao Jumpcar ou mesclagem entre bancos. Antes da primeira escrita real no JK, é possível retomar o Jumpcar depois de congelar o JK e confirmar que nenhum efeito externo ocorreu. Após novas OS/pagamentos no JK, um restore elimina essas operações da cópia restaurada: é obrigatório preservá-las, reconciliar caixa/efeitos externos e decidir como registrá-las uma única vez no sistema retomado.

Para restaurar, o operador autorizado para ambos os serviços `app` e `maintenance`, preserva o banco atual/sidecars e restaura o par backup/manifesto para arquivo novo. Só então aponta o `DB_PATH` de ambos para o arquivo restaurado, reinicia e verifica healths, integridade, acesso e saldos. A manutenção já contém o procedimento de revogar sessões e auditar a restauração. Não renomear banco aberto nem copiar por cima do banco vivo. O procedimento detalhado e os comandos de operação estão em [operations-jk.md](../operations-jk.md#recuperação-do-banco).

## Verificação desta entrega

```sh
node --test tests/jk-migration-readiness.test.mjs tests/jk-history-archive.test.mjs tests/jk-migration.test.mjs
```

34 testes aprovados em 30/10/2026, incluindo nove da ferramenta: contagem/centavos, privacidade da saída, ausência de alteração dos exports, BOM, arquivos privados sem sobrescrita, bloqueio de diretório no repositório, snapshots divergentes e rejeição de vínculos inválidos. A leitura dos arquivos reais confirmou as contagens acima sem importá-los. Isso não comprova restauração ou cutover em produção; esses gates permanecem para o responsável.
