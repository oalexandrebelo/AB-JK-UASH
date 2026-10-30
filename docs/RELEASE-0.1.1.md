# AB-JK-UASH 0.1.1 — entrega e validação

Data: **30/10/2026**, horário de São Paulo. Relatório público do produto, derivado do AB-UASH e destinado ao Lava Rápido JK. Esta versão contém código, testes sintéticos e critérios de aceite. Endereços, configurações e evidências operacionais do ambiente específico foram retirados deste documento e entregues ao titular em registro privado.

**Resultado publicado:** versão **0.1.1**, commit [`ac1a1bf13f422b113b6f9675aae328e9409baa4c`](https://github.com/oalexandrebelo/AB-JK-UASH/commit/ac1a1bf13f422b113b6f9675aae328e9409baa4c), com [CI remota aprovada](https://github.com/oalexandrebelo/AB-JK-UASH/actions/runs/40999978430). Localmente: compilação TypeScript/Vite e SDK concluída; **199 testes aprovados, zero falhas e cinco não executados**. As correções de importação, a proteção da tela de migração e a geração de manifesto com fonte Git imutável estão publicadas. A implantação e o aceite operacional possuem registro privado entregue ao titular.

**Critérios de aceite:** uma instalação exige acesso administrativo autorizado, ensaio pelo dispositivo de operação, importação reconciliada e homologação dos provedores adotados. A situação concreta desses critérios pertence ao registro privado. A matriz identifica funcionalidades que exigem desenvolvimento adicional; a validação sintética não declara paridade integral com o Jumpcar.

## 1. Correções verificadas

| Área | Problema encontrado | Resultado da correção e evidência |
| --- | --- | --- |
| Datas de itens migrados | `orderItems.createdAt` era aceito e depois descartado. | O valor passa a ser persistido em UTC; upgrade aditivo conserva dados antigos e deixa datas perdidas como `null`. [Revisão do núcleo](CORE-REVIEW-2026-10-30.md). |
| Reconciliação incremental | A validação considerava a OS completa, mas o relatório somava apenas linhas do lote. | Totais consideram cada OS afetada por inteiro, incluindo itens e pagamentos anteriores, sem duplicação dentro do relatório. Não somar relatórios que revisitem a mesma OS. [Contrato de migração](migration-jk.md). |
| Planilha HTML | Uma linha final incompleta podia desaparecer silenciosamente. | Linhas/células incompletas, incompatíveis ou aninhadas são rejeitadas antes da criação do lote. Tabelas simples válidas continuam aceitas. |
| Autorização da importação | O ator da CLI era conferido antes da transação, inclusive com possibilidade de replay após revogação. | Administrador ativo é revalidado dentro da transação antes de confirmar ou responder a um replay. Operação local sem ator mantém sua autorização pelo acesso privado ao arquivo. |
| Tela de migração | A interface oferecia importação quando o servidor informava `supported:false` ou depois de falha de consulta. | Seleção, prévia e confirmação dependem de suporte confirmado e consulta concluída; erro/incompatibilidade e atualização bloqueiam as ações. A regressão verifica que não há POST indevido. |
| Diagnóstico da implantação | Exceções de `JSON.parse` poderiam incluir fragmentos do corpo HTTP nos logs do probe. | O probe emite apenas diagnósticos controlados e nunca ecoa corpo, URL com credenciais ou argumentos desconhecidos. [Testes de infraestrutura](../infra/tests/runtime-probe.test.mjs). |

A revisão financeira exercitou duas aplicações com duas conexões ao mesmo SQLite: faturamento concorrente da mesma OS, cancelamento/reemissão, recebimento parcial idempotente, versão desatualizada, rollback com caixa fechado e quitação concorrente. O resultado preservou pagamentos, alocações, movimentos e auditoria em centavos exatos. É uma prova entre conexões no mesmo processo, não um ensaio de carga com múltiplos processos ou PostgreSQL.

## 2. Evidência automatizada

| Execução local | Aprovados | Falhas | Não executados | Evidência |
| --- | ---: | ---: | ---: | --- |
| Suíte principal, domínio/API/SQLite/segurança/integrações | 165 | 0 | 5 | [Transcrição](qa/2026-10-30/tests-main.txt) |
| Bundle de produção em DOM, incluindo HTTP real e fluxos Spectrum 2 | 24 | 0 | 0 | [Transcrição](qa/2026-10-30/tests-ui.txt) |
| Infraestrutura, backup/restore, snapshot, probe e gerador | 10 | 0 | 0 | [Transcrição](qa/2026-10-30/tests-infra.txt) |
| **Total de testes distintos** | **199** | **0** | **5** | [Resumo estruturado](qa/2026-10-30/validation.json) |

Os 35 testes focados da revisão do núcleo estão incluídos na suíte principal; não foram somados novamente. Quatro testes não executados dependem de um servidor PostgreSQL configurado, e um depende de uma distribuição com runtime Node empacotado. Esses perfis não constituem a instalação SQLite da JK. Todos os dados usados nos testes são sintéticos.

Comandos reproduzíveis, em Node.js 24:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm ci --ignore-scripts --no-audit --no-fund --prefix qa/ui-tool
npm run build
npm run sdk:build
npm test
AB_UASH_UI_QA_REQUIRED=1 TZ=America/Sao_Paulo node --test --test-reporter=spec tests/ui-*.test.mjs
node --test --test-reporter=spec infra/tests/*.test.mjs
node scripts/jk-release-check.mjs check
```

O build final transformou 733 módulos; o maior arquivo JavaScript ficou em aproximadamente 235 kB, sem alerta de chunk acima de 500 kB. Os 28.842.472 bytes dos recursos OCR locais foram conferidos pelo preparador. Os 13 checks estáticos de release passaram. O SDK compilou em ESM e declarações TypeScript. A suíte principal local precedeu a alteração de metadados para 0.1.1; DOM e infraestrutura foram executados novamente com as últimas fontes e o bundle final. A CI remota reexecutou build, SDK, aplicação, DOM, infraestrutura, configuração Compose e ensaio dos contêineres sobre o commit publicado, com **sucesso em todas as etapas**, concluído em `2026-10-30T03:56:42Z`.

**Limites:** DOM emulado não comprova layout/renderização em um navegador real, leitor de tela, câmera de celular ou impressão física. Não existe Docker CLI no ambiente local desta execução; as evidências públicas de contêineres pertencem à CI remota. Nenhum teste local emitiu nota, processou cobrança bancária, enviou mensagem a cliente ou migrou registros reais.

## 3. AB-R3A / REA e integridade das fontes

Foi executado o motor **`rea-agents@6.7.0`**, em instalação isolada, com a mesma versão e integridade npm registradas no pin do AB-R3A Turbo. Isso identifica o motor utilizado; não afirma execução do aplicativo de desktop AB-R3A. As frentes de revisão desta rodada foram delegadas em Astra 6 com esforço MAX.

O snapshot final contém **118 arquivos, 984.171 bytes**, nas pastas `server`, `integrations`, `src`, `scripts` e nos arquivos de configuração explicitados pelo manifesto. SHA-256 da árvore:

```text
a93a2303bfa0cd73e25d10951eac5c5dbac197fc1c17d169d4ae4111b954e2c2
```

O [manifesto](qa/2026-10-30/source-manifest.json) registra caminho, tamanho e hash de cada arquivo. Exclui banco, segredos, dependências instaladas, bundle compilado, arquivos privados e diretórios fora do escopo. Ele identifica as fontes analisadas, não uma imagem Docker.

| Análise REA | Arquivos JS/TS analisados | Falhas de parsing | Resultado |
| --- | ---: | ---: | --- |
| Escopo completo | 97 | 0 | Concluída; grafo parcial por orçamento de resultados. |
| Migração, esquema, banco e segurança | 5 | 0 | Concluída; sem avisos de estouro de orçamento no recorte. |
| Tela de migração e cliente HTTP | 2 | 0 | Concluída; sem avisos de estouro de orçamento no recorte. |
| Probe, gerador e healthcheck | 3 | 0 | Concluída; sem avisos de estouro de orçamento no recorte. |

O escopo completo registrou 104 arquivos relevantes, 873.907 bytes de texto lidos e 122.900 nós de AST visitados. As **1.191 observações estáticas não são 1.191 vulnerabilidades**. A cobertura de relações permanece parcial também nos recortes; relações ausentes não demonstram comportamento ausente. Os contadores orientados a Electron, como IPC e módulos, não descrevem a quantidade de módulos desta aplicação web. Não foram registradas contradições de integridade pelo analisador.

Uma tentativa anterior no ambiente restrito interrompeu na descoberta de propriedade de processo (`capability_unavailable`), antes da análise. A execução aprovada fora dessa restrição concluiu com limites de memória e tempo. O [resumo público legível](qa/2026-10-30/rea-summary.json) preserva IDs de evidência, estatísticas, limitações e hashes das saídas; não inclui os grandes payloads opacos de grafo. Análise estática não substitui testes de domínio, autenticação real ou homologação externa.

## 4. Implantação e registro de aceite

A CI pública validou a compilação, os testes de aplicação/interface/infraestrutura, a configuração Compose e o ensaio dos contêineres com dados sintéticos. A identificação da fonte validada está no início deste relatório. O gerador e o probe possuem testes próprios e fazem parte dessa revisão; a análise desses recursos não depende de divulgar o ambiente usado por um cliente.

O registro operacional entregue ao titular contém o resultado da implantação e os detalhes necessários para continuidade. Esta publicação não inclui endereço interno, configuração aplicada, topologia particular, situação de contas, identificadores de backups ou logs do ambiente. O estado de um processo não constitui aceite da rotina de negócio; os critérios de migração, integrações e recuperação continuam verificáveis separadamente.

Este fechamento documental não altera as fontes de runtime: o hash do snapshot permanece o registrado na seção de integridade. O commit que acrescenta documentação pode ser posterior ao commit das fontes executadas; a referência de implantação é mantida no registro privado.

## 5. Migração e acesso: alcance do produto

O importador aceita as coleções e os formatos definidos em [migration-jk.md](migration-jk.md). Clientes, veículos e serviços canônicos podem alimentar cadastros; OS, itens e pagamentos importados ficam no histórico de migração. Isso não recria movimentos de caixa, faturas, notas fiscais ou mensagens retroativas.

Uma exportação de clientes não demonstra exportação de contas ou senhas. A continuidade de acesso exige fonte autorizada e um procedimento privado compatível com a aplicação. Arquivos pessoais, bancos e credenciais não fazem parte das fixtures ou evidências públicas.

A migração real exige inventário dos arquivos, prévia, resolução de rejeições e conferência de contagens, vínculos, datas e valores. A existência de um pacote ou de uma tela de importação não prova que todos os dados da origem foram obtidos. A matriz e os requisitos explicitam esse limite, sem converter observações históricas em uma contagem atual.

## 6. Requisitos gerais de aceite

| Prioridade | Necessidade | Evidência que encerra a pendência |
| --- | --- | --- |
| P0 — acesso | Ativação privada do acesso do titular e abertura do endereço autorizado. | Login/logout real e acesso conforme o papel, conferidos pelo responsável. |
| P0 — dados | Exportações completas e autorizadas disponíveis por canal privado. | Inventário real de arquivos, prévia sem rejeições não resolvidas, contagens/vínculos/totais reconciliados, commit idempotente e conferência pelo responsável JK. |
| P0 para fiscal | Emitente, município/regime, credenciais e ambiente do provedor. | Emissão, consulta, reconciliação e cancelamento homologados para a configuração real da JK. |
| P0 para Pix/WhatsApp | Conta e credenciais próprias dos provedores, configuração de webhook/modelos conforme o fluxo adotado. | Cobrança/baixa Pix e envio/estado de mensagem verificados em ambiente apropriado; efeitos financeiros conferidos. |
| P0 para operação real | Ensaio do fluxo diário e recuperação no destino. | Roteiro abaixo executado, responsáveis identificados e cópia de backup em destino privado independente do servidor. |
| P1 — publicação da LP | Domínio/rota pública e escopo de acesso escolhidos. | Landing acessível ao público pretendido e gestão protegida; HTTPS e origem/cookies verificados. |
| P1 — paridade adicional | Decisões sobre lacunas de produto. | Critérios e implementação dos itens aplicáveis da matriz, com testes próprios. |

As lacunas não se resolvem todas com credenciais: CRM/campanhas automáticas, SmartPOS/TEF, sincronização offline entre dispositivos, multiunidade, venda comercial de produtos de estoque, taxas de adquirente e algumas regras de comissão/checklist exigem implementação adicional. Consulte a [matriz completa](FEATURE-MATRIX.md), o [PRD](PRD-JK.md) e o [PRT](PRT-JK.md). Não há percentual de paridade calculado, pois não foi concluído um inventário autenticado de toda a conta de origem.

## 7. Roteiro de teste e documentação

O [roteiro de teste de produção](PRODUCTION-TEST-JK.md) define a ordem de ativação, casos de aceite, registro de evidência e condição de interrupção. O [manual](MANUAL-JK.md) contém os passos de cada tela. [Operação e recuperação](operations-jk.md) cobre bootstrap, implantação, atualização, backup e rollback.

A UI utiliza o pacote real Adobe Spectrum 2. A LP atende ao Lava Rápido JK e ao perfil solicitado, sem inventar telefone, horários, preços, avaliações ou contagens de clientes. A identidade original, o diagrama e o vídeo de ajuda já existentes foram preservados. O uso dos quatro projetos solicitados e suas licenças está em [DESIGN-MEDIA](DESIGN-MEDIA.md) e na [pesquisa primária](REFERENCES-2026-10-30.md). Não foi colocado um motor de vídeo/áudio no runtime da operação nem anunciado atendimento por voz inexistente.

O repositório público contém código, documentação e evidências sintéticas. Este fechamento não publica dados pessoais, exports, banco, credenciais, certificados ou relatórios operacionais internos. A disponibilidade pública do código não comprova migração, publicação pública da LP, conformidade legal ou prontidão integral para uso real.
