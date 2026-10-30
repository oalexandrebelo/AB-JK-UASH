# AB-JK-UASH — referências verificadas e implicações de implementação

Consulta em **30/10/2026**. Fontes primárias: páginas do próprio Jump Car, documentação Adobe e arquivos dos repositórios solicitados. Esta pesquisa verifica a documentação pública; não acessou a conta autenticada e não certifica funcionamento fiscal em produção ou paridade integral. Recomendações abaixo são decisões de engenharia propostas, distintas das alegações dos fornecedores.

O estado de implantação e validação da versão 0.1.1 pertence a [RELEASE-0.1.1.md](RELEASE-0.1.1.md). Este documento registra referências e seus limites; os requisitos estão no [PRD](PRD-JK.md) e no [PRT](PRT-JK.md).

## Jump Car: escopo verificável

| Área | Documentado pela fonte | Limite da evidência |
| --- | --- | --- |
| Emissão fiscal | NFS-e integrada à rotina administrativa/financeira; associação ao serviço, valor e fatura; histórico no administrativo. | A página condiciona a emissão aos municípios integrados. Não demonstra API pública, credenciais, homologação, cancelamento, contingência ou esquema de eventos. |
| Cobertura fiscal | A página anuncia mais de 1.300 municípios e orienta conferir o município e as configurações necessárias. | É alegação do fornecedor, não lista de cidades nem comprovação da cobertura do município da JK. |
| Pós-pago | Cadastro de cliente a faturar; OS com cliente, veículo, horário, serviço e valor; agrupamento por período; fatura PDF e vencimento; controle de pendências, atrasos e pagamentos. | Não foram observadas especificações de cobrança bancária automática, débito recorrente, WhatsApp automático, juros, limite de crédito ou baixa conciliada. |

Fontes: [Emissão de nota fiscal](https://www.jumpcar.com.br/funcionalidades/emissao-de-nota-fiscal) e [Gestão de pós-pago](https://www.jumpcar.com.br/funcionalidades/gestao-de-pos-pago). A tabela comercial fiscal não deve ser transposta para a JK: mistura rótulos e valores cuja regra exige confirmação, além de tratar preços do fornecedor.

### Decisões de engenharia derivadas

1. Manter fatura comercial e documento fiscal como entidades distintas. Emitir um PDF de cobrança não autoriza apresentar uma NFS-e como emitida.
2. Uma ação de emissão deve distinguir modo demonstrativo, integração pendente, solicitação enviada, rejeição e autorização real. Protocolo/número/autorização devem vir da resposta validada do emissor configurado. Não produzir sucesso fictício.
3. Município, ambiente, provedor e credenciais configurados precisam integrar a validação antes do envio fiscal. Credenciais, certificado e senha permanecem no servidor, fora do bundle e do Git.
4. No fechamento pós-pago, selecionar somente OS elegíveis, impedir duplicação entre faturas, preservar os valores faturados e calcular saldo/pagamentos no servidor. Esta é uma recomendação de integridade, não uma descrição interna do Jump Car.
5. Validar a jornada completa: serviço concluído → OS elegível → fechamento por período → vencimento → PDF → pagamento → saldo atualizado. Pagamento não implica emissão fiscal; cancelamento fiscal não implica estorno financeiro automaticamente.
6. Usar a expressão “funcionalidades verificadas nas referências” na matriz. “Paridade completa” exige cobertura funcional e operacional demonstrada, incluindo integrações e hardware onde aplicável.

## Lava Rápido JK: identidade e conteúdo da LP

O endereço fornecido foi [instagram.com/lavar.apidojk](https://www.instagram.com/lavar.apidojk/). A leitura pública não pôde ser concluída; buscas pelo identificador exato não retornaram material verificável. A pesquisa encontrou homônimos com outro identificador, que foram descartados. **Não foram observados endereço, telefone, WhatsApp, horários, preços, avaliações, fotografias autorizadas ou lista real de serviços desse perfil.** A falha de acesso não prova ausência desses dados.

O registro histórico da implementação informa que uma sessão autorizada em 28/10/2026 observou a unidade Lava Rápido JK em Rio Verde no Jumpcar autenticado. Essa é a origem da cidade preservada na identidade do projeto; esta pesquisa pública não a verificou novamente e não estende a evidência a endereço, telefone ou outros dados. [Contexto do produto](../README.md#identidade-e-referências).

Para implementar a LP com os dados disponíveis, usar o nome fornecido e o link exato informado. Demais campos devem vir de configuração validada do estabelecimento. Não preencher com dados de homônimos, números fictícios acionáveis, depoimentos inventados ou fotos apresentadas como instalações reais. Não presumir autorização para republicar mídia do Instagram. Evitar que um CTA de agendamento simule envio quando não existe canal operacional configurado.

## Adobe Spectrum 2

Fontes oficiais consultadas:

- [Getting started](https://react-spectrum.adobe.com/getting-started): pacote `@react-spectrum/s2`, com instruções específicas para bundlers/frameworks.
- [Provider](https://react-spectrum.adobe.com/Provider): contexto de componentes, fontes, locale e esquema de cores.
- [Styling](https://react-spectrum.adobe.com/styling): macro `style` executada no build, com tokens de cores, espaços, tamanhos e tipografia.
- [TableView](https://react-spectrum.adobe.com/TableView): interface tabular com seleção, ações e ordenação.
- [Migração](https://react-spectrum.adobe.com/migrating): distingue Spectrum 2 dos imports antigos `@adobe/react-spectrum` e pacotes v3.
- [Licença do React Spectrum](https://github.com/adobe/react-spectrum/blob/main/LICENSE): Apache-2.0.

O endereço `s2.spectrum.adobe.com` redirecionou para o portal [Spectrum](https://spectrum.adobe.com/). Para implementação React, os documentos acima são a referência concreta. O manifesto local já fixa `@react-spectrum/s2` em `1.8.2`; manter o lock e testar contra essa versão, sem trocar para o estado variável de `main` por causa desta consulta.

Recomendações de revisão: preservar `Provider` no contexto adequado; usar componentes oficiais em formulários, diálogos e seletores; aplicar tokens sem sobrescrever os estados de foco/erro/desabilitado; declarar rótulos de controles e nomes acessíveis; manter português e BRL consistentes. A existência do pacote não comprova acessibilidade do aplicativo inteiro: navegação, foco dos diálogos, feedback de falha e reflow dependem da composição local.

## O que os quatro repositórios fazem

| Referência | Função observada | Licença observada | Aplicação adequada no AB-JK-UASH |
| --- | --- | --- | --- |
| [Diagram Design](https://github.com/cathrynlavery/diagram-design) | Skill e templates para diagramas em HTML com SVG inline; exportação e importação/redesenho de diagramas. | [MIT](https://github.com/cathrynlavery/diagram-design/blob/main/LICENSE), com [avisos de terceiros](https://github.com/cathrynlavery/diagram-design/blob/main/THIRD_PARTY_LICENSES.md). | Documentar arquitetura, estados da OS ou treinamento. Não fornece engine transacional de fluxos. |
| [HyperFrames](https://github.com/heygen-com/hyperframes) | Framework/CLI que transforma HTML, CSS, mídia e animações controláveis no tempo em MP4 determinístico; requer Node 22+ e FFmpeg segundo README. | [Apache-2.0](https://github.com/heygen-com/hyperframes/blob/main/LICENSE). | Produzir vídeo explicativo ou promocional em ambiente de autoria separado; servir somente o resultado quando útil. |
| [Earshot](https://github.com/Leonxlnx/earshot) | CLI, API Python e MCP para medir, descrever, comparar, localizar e sintetizar sons; ferramentas de QA de trilha e sincronismo. O README explicita que não avalia conteúdo da fala. | [MIT para código](https://github.com/Leonxlnx/earshot/blob/main/LICENSE); modelos CLAP e AST têm licenças próprias segundo README. | Síntese/QA de áudio de material explicativo. Não fundamenta voz conversacional, transcrição de atendimento ou reconhecimento de comandos. |
| [ManimGX](https://github.com/academa-labs/manimgx) | Motor de animação 2D/3D com API Python compatível com Manim CE, Rust/wgpu e exportação de vídeo; opção de execução no navegador via Pyodide/WebGPU. | [Código MIT](https://github.com/academa-labs/manimgx/blob/main/LICENSE); README e [avisos de terceiros](https://github.com/academa-labs/manimgx/blob/main/LICENSE-THIRD-PARTY) declaram wheels nativas como conjunto GPL-3.0-or-later por x264. | Produzir cenas didáticas fora do runtime operacional. Não é biblioteca de formulários, dashboard ou gestão. |

Não instalar esses projetos no frontend apenas para mencionar que foram usados. Fazer a escolha por uma necessidade de comunicação concreta, com entradas e saídas reproduzíveis. Nenhuma dessas bibliotecas entrega emissão fiscal, migração de clientes, caixa, estoque ou faturamento pós-pago.

### Pontos de privacidade e distribuição observados

- O [PRIVACY.md do Diagram Design](https://github.com/cathrynlavery/diagram-design/blob/main/PRIVACY.md) declara ausência de servidor/telemetria própria, mas informa que templates e exportações podem carregar Google Fonts. Artefatos locais podem usar fontes de sistema para evitar essa requisição.
- O README do Earshot descreve análise local e crítica opcional por Gemini com chave e consentimento explícito de upload. Isso não justifica enviar gravações ou dados de clientes por padrão.
- Licença de código não concede direitos sobre marca, áudio, fotografias ou dados usados como entrada. Manter a procedência dos ativos efetivamente distribuídos; não transformar a referência upstream em declaração de endosso.
- A ressalva de distribuição do ManimGX deve acompanhar qualquer decisão de embutir wheels/binários. Nesta pesquisa não se executou auditoria jurídica nem teste dos pacotes.

## Comparação inicial com o repositório existente

Foram lidos o [manifesto](../package.json) e o [registro de design e mídia](DESIGN-MEDIA.md) na revisão do repositório. O projeto já descreve autoria isolada em `design/`, licenças e versões fixadas, arquivos finais públicos, vídeo voluntário na ajuda e ausência de runtime audiovisual pesado no core. O documento também distingue a release executada do ManimGX de `main`, registra a ressalva GPL, usa áudio procedural sem dados de clientes e informa que o vídeo não demonstra homologação. A integração existente já atende a essa separação de autoria e runtime.

Essa comparação confirma a intenção e as evidências documentadas; não reexecuta o pipeline, não revalida hashes de binários e não transforma recibos anteriores em testes desta sessão. A revisão de código/UI e os testes atuais devem ter registro separado.

## Critérios propostos para publicação sem dados privados

Estes são critérios de revisão, não afirmações de que o checkout já foi aprovado:

- Demo e testes com dados sintéticos explicitamente identificados; evitar dados reais de clientes, placas, telefones, documentos e conversas em fixtures, capturas, logs, backups e PDFs.
- Nenhum banco operacional, upload de clientes, exportação Jump Car ou arquivo `.env` real versionado. Checar também histórico e arquivos gerados a distribuir.
- Chaves/credenciais/certificados em configuração de servidor, com exemplos contendo somente placeholders; não confiar em nome de variável para manter segredo se o valor acaba no bundle.
- Evidência de paridade deve apontar para requisito, implementação e teste. Mock, demonstração, integração configurável e operação homologada precisam de rótulos diferentes.

## Identificação das fontes GitHub lidas

Os valores abaixo são hashes de blobs dos READMEs consultados; **não são commits nem versões executadas**. Servem apenas para identificar o texto pesquisado. Os pins de execução em [upstream.lock.json](../design/media/upstream.lock.json) continuam sendo a referência para reproduzir os ativos do projeto.

| README | Blob SHA consultado |
| --- | --- |
| `cathrynlavery/diagram-design` | `2660309a3d05c5ddae1b298bc043b08c3798315a` |
| `heygen-com/hyperframes` | `ffe9f4c2c439c263ae3f3040fc22480fdd877c15` |
| `Leonxlnx/earshot` | `daf4cc8492f7e8d4c43a30834e1666a01546b4bf` |
| `academa-labs/manimgx` | `bce9610168d96a30476674b24c8239eae8fd2604` |
