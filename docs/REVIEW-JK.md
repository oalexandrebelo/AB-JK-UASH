# Revisão independente JK — 28/10/2026

Esta revisão verificou o bundle de produção, os fluxos novos de migração, transporte e integrações, os controles de acesso e o conteúdo elegível para publicação. Todos os dados de teste são sintéticos. Não houve importação de dados reais, criação de conta real, chamada a PSP, emissão fiscal, envio de WhatsApp ou implantação nesta frente.

## Resultado e escopo

| Verificação executada | Resultado |
| --- | --- |
| Suíte DOM completa sobre o build final, com HTTP local e SQLite temporário | **23 testes/subtestes passaram; 0 falhas; 0 ignorados** |
| API JK: bootstrap, migração, entregas, integrações e rotas HTTP | **46 testes passaram; 0 falhas; 0 ignorados** |
| Importação e execução do servidor SQLite sem `node_modules`, após correção da fixture | **1 teste passou; 0 falhas** |
| Instalação do runtime DOM a partir do manifest/lock publicado | `npm ci --ignore-scripts` concluído |
| Varredura dos arquivos elegíveis para Git | Sem banco, `.env` real, certificado, chave privada ou token literal encontrado pelos padrões descritos abaixo |

O build final usado pela rodada DOM tinha o SHA-256 de `dist/index.html` igual a `c623c168e8774454430afdc7be40f3bc59300c19544c71ef640ff0ae3f55d108`. Esse hash identifica o HTML da rodada; o congelamento completo das fontes pertence ao fluxo de release. Uma execução anterior coincidiu com a substituição de `dist` por um novo build e perdeu chunks lazy; ela foi descartada e repetida integralmente após o congelamento.

Os resultados acima são desta revisão. O build, a suíte geral, a suíte de manutenção, a auditoria de dependências e a execução remota da CI devem ser registrados pela frente de release. A presença do workflow não significa que o GitHub Actions já o executou.

## Correções realizadas

Foi corrigido um risco concreto em `server/jk-integrations.mjs`: uma preparação criada com a integração desligada, ou antes de uma troca de provedor/ambiente/conta, podia ficar disponível para envio com o destino novo. Agora a preparação guarda o identificador privado da conta quando a configuração está habilitada; o envio exige correspondência exata de provedor, ambiente e conta. Configuração diferente ou preparação antiga sem vínculo retorna `409 INTEGRATION_PREPARATION_CHANGED` antes de I/O, mantendo a opção de cancelar localmente e preparar novamente. O campo público `preparationRequiresRefresh` permite à interface explicar o bloqueio sem revelar o identificador privado. A correção usa a coluna existente e não requer DDL novo.

Os testes de regressão cobrem ativação após preparação sem configuração, ativação após preparação com envio desligado, homologação para produção, troca de provedor, troca de conta, registros antigos sem vínculo e ativação/troca de remetente WhatsApp. Verificam zero chamadas ao adapter, zero tentativas registradas, rollback da reserva idempotente, saldo intacto e recuperação por cancelamento e nova preparação.

Também foram corrigidos problemas concretos na infraestrutura de QA e em suas expectativas:

1. O harness abria `/`, que agora é o site público. A entrada autenticada testada passou a ser `/app`.
2. Os testes usavam textos e logos da interface UASH anterior. Foram atualizados para a marca JK, os textos atuais de autenticação, os badges Spectrum e a navegação `SideNav`.
3. Os módulos lazy do Vite usam `import.meta.url`. O harness agora valida os preloads JavaScript/CSS pelo mesmo servidor HTTP temporário e mantém a restrição de origem. O código JavaScript executado continua sendo o bundle produzido pelo build.
4. O suporte DOM a geometria, observers e animações é explícito. `getAnimations()` retorna uma lista vazia, compatível com a execução sem animação; isso não mede transições visuais.
5. A submissão de formulário procura primeiro o diálogo aberto. Isso evita selecionar um botão de fundo com o mesmo texto, preservando a verificação de `type="submit"` e a submissão nativa do formulário.
6. O teste de execução sem dependências copiava apenas `integrations/fiscal`. A aplicação também importa os conectores JK; a fixture passou a copiar `integrations/` completo, sem copiar `node_modules`.
7. O runtime opcional de DOM ganhou manifest e lock em [`qa/ui-tool`](../qa/ui-tool/package.json). A CI o instala e executa todos os testes `ui-*` depois do build. `AB_UASH_UI_QA_REQUIRED=1` transforma a ausência ou falha de carregamento do runtime em erro, evitando um gate verde por testes ignorados.

## Fluxos comprovados no DOM

O harness usa o bundle real, o backend real e SQLite temporário. Os casos de falha deliberada interceptam somente as respostas indicadas nos testes; os testes fiscais usam transporte de fixture. A configuração de integrações é vazia por padrão no harness.

| Fluxo | Evidência verificada |
| --- | --- |
| Bootstrap e login | Estado de instalação pendente; token de configuração somente em header; token ausente do corpo e de armazenamento do navegador; logout, login e expiração; marca e ícone JK. O rótulo PostgreSQL desse teste é uma fixture de contrato, não uma conexão PostgreSQL. |
| Atendimento | Cadastro de cliente, serviço e veículo; vínculo da OS; valores em centavos; data no fuso de São Paulo; transições; entrega rejeitada antes da quitação; recebimento e entrega; persistência após reinício. |
| Gestão | Navegação por áreas, erros recuperáveis, paginação remota, busca, CSV com neutralização de fórmulas, pós-pago e consulta sem privilégios de escrita. A impressão da fatura verifica documento único fora do shell do app, texto não fiscal, cliente, vencimento, valor, chamada a `window.print` e remoção do documento ao sair. Isso não valida a paginação física da impressão. |
| Migração JK | Seleção de JSON sintético pelo controle de arquivo; prévia sem escrita; confirmação desabilitada antes da revisão; remoção do arquivo invalida a prévia; commit com o mesmo hash revisado; consulta do histórico. Clientes, veículos e serviços são preservados, enquanto ordens e pagamentos antigos ficam nas tabelas históricas, sem gerar recebimentos, movimentos de caixa, comissões ou mensagens operacionais. |
| Pix | Preparação local com saldo derivado da OS; envio indisponível sem configuração; após reinício com configuração sintética habilitada, a preparação antiga mostra o aviso de revisão e continua sem botão de envio; cancelamento local; nenhuma chamada de envio ou conciliação; saldo da OS permanece aberto. |
| WhatsApp | Modelo e parâmetros pelo formulário; consentimento obrigatório antes da requisição; destinatário mascarado; entrega permanece não confirmada; envio indisponível e preparação cancelável. |
| Transporte JK | Criação vinculada à OS, responsável, endereço e janela em São Paulo; estados agendada, em deslocamento e concluída; recebedor e eventos persistidos; retirada não gera pagamento. |
| Permissões JK | Perfil de consulta sem links de migração, transportes ou gestão de integrações; rotas diretas negadas sem carregar os endpoints da área; API rejeita consulta de histórico/transporte e preparação Pix por perfil sem privilégio. |
| Estado e acessibilidade | Respostas atrasadas não substituem dados novos; recurso desativado limpa dados/erro; duas mutações no mesmo tick geram uma escrita; retry após perda da resposta reutiliza idempotência; diálogos pendentes bloqueiam fechamento; erros de leitura não afirmam listas vazias; foco de abas, atalho de conteúdo e menu móvel. |

Os testes correspondentes estão em [`tests/ui-jk-flows.test.mjs`](../tests/ui-jk-flows.test.mjs), [`tests/ui-integration.test.mjs`](../tests/ui-integration.test.mjs), [`tests/ui-bootstrap.test.mjs`](../tests/ui-bootstrap.test.mjs), [`tests/ui-fiscal.test.mjs`](../tests/ui-fiscal.test.mjs), [`tests/ui-hooks.test.mjs`](../tests/ui-hooks.test.mjs) e [`tests/ui-review-20261021.test.mjs`](../tests/ui-review-20261021.test.mjs).

## Revisão adversarial da API e do estado

**Concorrência e saldo.** A revisão inicialmente investigou se a leitura de um registro de integração seguida de escrita por versão permitiria dois envios concorrentes. O armazenamento compartilhado serializa escritas SQLite por fila e `BEGIN IMMEDIATE`, e escritas PostgreSQL por `pg_advisory_xact_lock` derivado do schema. Portanto esse cenário não se confirmou no contrato do armazenamento existente. Não foi introduzido um bloqueio adicional especulativo. A homologação real de PostgreSQL continua pendente.

As preparações Pix derivam o valor do saldo atual e são vinculadas à versão da OS. Após a correção desta revisão, Pix e WhatsApp também ficam vinculados ao provedor, ambiente e conta habilitados no momento da preparação. Preparações locais feitas com o envio desabilitado continuam locais e exigem nova preparação após ativação. O envio confere esse vínculo, a versão e, no Pix, o saldo novamente. O lease protege resultados tardios, e o encerramento da operação verifica o token corrente. A baixa, alocação, evidência bancária, movimento financeiro e auditoria são transacionais. Os testes cobrem pagamento manual concorrente, comprovantes reutilizados, pagamento parcial, devolução, mudança de conta/ambiente, timeout, lease vencido e rollback financeiro. Referências: [`server/db.mjs`](../server/db.mjs), [`server/jk-integrations.mjs`](../server/jk-integrations.mjs) e [`tests/jk-integrations.test.mjs`](../tests/jk-integrations.test.mjs).

**Autenticação, CSRF e autorização atual.** A aplicação verifica CSRF antes de encaminhar mutações autenticadas. As rotas de migração exigem administrador; transportes usam o conjunto de operadores; a escrita em integrações exige administrador ou gestor. A autorização é conferida novamente dentro das transações de escrita, inclusive em replays, usando sessão e papel atuais. Uma sessão antiga não deve manter privilégios revogados. Os testes de API cobrem ausência de sessão/CSRF, função insuficiente, revogação, versão desatualizada e conflito de idempotência. Referências: [`server/application.mjs`](../server/application.mjs), [`server/security.mjs`](../server/security.mjs) e [`server/domain-core.mjs`](../server/domain-core.mjs).

**Migração e estado desatualizado.** A prévia é somente leitura, produz hash e valida referências, totais, datas e duplicidades. O commit revalida o conjunto e o estado do banco dentro da transação. No frontend, a revisão do conjunto selecionado invalida a prévia anterior; `useResource` aborta ou ignora respostas obsoletas e `useMutation` protege a escrita pendente e o retry idempotente. Referências: [`server/jk-migration.mjs`](../server/jk-migration.mjs), [`src/pages/MigrationPage.tsx`](../src/pages/MigrationPage.tsx) e [`src/lib/api.ts`](../src/lib/api.ts).

**Bootstrap e superfície pública.** O bootstrap local recusa sobrescrever uma instalação que já contém usuários, não possui conta padrão e não imprime a credencial. A importação de uma credencial legada é uma opção explícita da CLI; a política de nova senha permanece separada. O perfil público usa uma lista fixa de campos empresariais e campos dos serviços ativos, sem consultar clientes, pagamentos ou credenciais. Referências: [`scripts/jk-bootstrap-admin.mjs`](../scripts/jk-bootstrap-admin.mjs), [`server/jk-public.mjs`](../server/jk-public.mjs) e [`tests/jk-bootstrap.test.mjs`](../tests/jk-bootstrap.test.mjs).

## Conteúdo para publicação

Foi inspecionado o inventário de arquivos rastreados ou não ignorados pelo Git, inclusive fontes, documentação, snapshots de conectores e licenças. A varredura procurou extensões e diretórios de bancos, dados, backups, certificados e credenciais, a assinatura binária de SQLite e padrões de chaves privadas, tokens GitHub/OpenAI/AWS e JWTs literais. Nenhum desses artefatos foi encontrado no inventário examinado.

Os endereços de e-mail fora dos domínios sintéticos encontrados estavam em atribuições de licenças, metadados de terceiros ou fixtures/configurações de exemplo. Não foram copiados dumps de clientes nem credenciais operacionais para os testes desta frente. Uma busca por padrões não é uma prova matemática de ausência de dados sensíveis; a revisão final do conjunto publicado continua sendo parte do release.

## Reprodução e gate de CI

O runtime DOM está fixado em **jsdom 30.1.3**. A versão, o repositório, a integridade e o requisito de Node foram conferidos no [registro oficial npm](https://registry.npmjs.org/jsdom/30.1.3); o projeto de origem é [jsdom/jsdom](https://github.com/jsdom/jsdom). A execução desta revisão usou Node **24.22.1**. O runtime de QA requer Node **24.15 ou posterior na linha 24**.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm ci --ignore-scripts --no-audit --no-fund --prefix qa/ui-tool
AB_UASH_UI_QA_PACKAGE="$PWD/qa/ui-tool/package.json" \
AB_UASH_UI_QA_REQUIRED=1 \
TZ=America/Sao_Paulo \
node --test --test-reporter=spec tests/ui-*.test.mjs
```

Não reconstrua `dist` durante a execução do QA: os imports lazy precisam dos mesmos chunks durante toda a rodada. O [workflow de CI](../.github/workflows/ci.yml) mantém o build antes da suíte e usa dependências travadas. O caminho alternativo `AB_UASH_UI_QA_PACKAGE` permite executar o runtime em um diretório temporário, sem adicioná-lo às dependências de produto.

```sh
node --test --test-reporter=spec \
  tests/jk-integrations.test.mjs tests/jk-integrations-api.test.mjs \
  tests/jk-deliveries.test.mjs tests/jk-migration.test.mjs tests/jk-bootstrap.test.mjs
```

## Limites e trabalho ainda externo a esta evidência

- DOM emulado não comprova layout, contraste, responsividade, geometria, animações ou foco nativo em um navegador. A revisão visual do site público e do login é uma evidência separada; os fluxos autenticados desta frente foram comprovados por DOM e HTTP.
- Não houve teste contra PostgreSQL. O DDL das tabelas JK é manual nesse modo, e a migração histórica desta versão usa SQLite. Não houve implantação de produção ou execução remota da CI nesta frente.
- Nenhuma integração foi homologada com credenciais reais. Pix, WhatsApp e fiscal continuam sujeitos à configuração, às autorizações e à homologação específicas de cada provedor. Uma preparação local não comprova cobrança emitida, mensagem entregue ou documento fiscal autorizado.
- Não houve importação da base real nem criação da conta real do operador. Esses passos exigem o ambiente privado e os dados fornecidos por seu responsável.

## Complemento de 29/10/2026: isolamento do teste de hooks

A [CI do fechamento documental](https://github.com/oalexandrebelo/AB-JK-UASH/actions/runs/40791854307) do commit `ddcee37f43555f9c2a8b98cf67c3460d0ac1ef99` identificou uma corrida no ambiente de QA: a asserção de recurso desativado contava todas as requisições do fixture, incluindo a montagem concorrente do Dashboard. O contador remoto passou de 30 para 34. Nenhuma fonte de produto havia mudado desde a execução remota aprovada.

A [reprodução controlada](qa/hooks-counter-probe.txt) confirmou a interferência: o contador passou de 21 para 29, contendo duas séries de GET para `/api/dashboard`, `/api/customers?limit=1`, `/api/vehicles?limit=1` e `/api/services?limit=1`. O recurso testado estava desativado, com estado limpo; `/api/missing-qa` permaneceu com uma chamada. Esses valores descrevem o experimento e não são contagens de defeitos no produto.

O fixture ganhou a opção `mountBundle`, cujo padrão continua `true`. Somente o teste que monta os hooks diretamente usa `mountBundle:false`, mantendo HTTP real e SQLite temporário. A asserção global exata de zero novas requisições foi preservada, e agora também aguarda o efeito correspondente a `null` terminar. Os demais testes continuam montando o bundle da aplicação.

A [reverificação focada](qa/hooks-focused-after-isolation.txt) passou em **6/6**, e a [suíte DOM completa após o isolamento](qa/tests-dom-after-isolation.txt) passou em **23/23**, sem falhas ou skips. Os seis testes focados já pertencem aos 23; o diagnóstico isolado não aumenta o total de 189 testes consolidados. Os 56 arquivos de `dist` permaneceram idênticos e o snapshot de produto V2 conservou seu digest. A alteração envolve apenas testes e documentação. As [execuções do workflow](https://github.com/oalexandrebelo/AB-JK-UASH/actions/workflows/ci.yml) registram o resultado remoto de cada revisão publicada.
