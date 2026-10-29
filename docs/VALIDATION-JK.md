# Validação de entrega · AB-JK-UASH 0.1.0

Registro da rodada local de 28 de outubro de 2026 e do fechamento remoto em 29 de outubro de 2026. **O código passou pelos gates locais descritos abaixo. A implantação no AB-PCSRV, o bootstrap privado, a migração real e a homologação externa continuam pendentes.** Este documento separa cada prova; não converte build, teste ou análise estática em declaração de prontidão integral de produção.

## Resultado executado

| Gate | Resultado | Evidência |
| --- | --- | --- |
| TypeScript + Vite/Spectrum 2 | Aprovado; páginas operacionais carregadas separadamente; sem aviso de chunk acima de 500 kB. O tempo informado pelo Vite é somente o bundling. | [Build](qa/build.txt) |
| SDK principal | ESM e declarações TypeScript compilados. O contrato herdado cobre 97 operações; extensões JK têm documentação própria. | [SDK](qa/sdk-build.txt), [API principal](api/README.md) |
| Suíte principal | **164 testes/subtestes: 159 aprovados, zero falhas, cinco ignorados: quatro dependem do servidor PostgreSQL externo e um exige o runtime Node empacotado da distribuição standalone.** | [Saída integral](qa/tests-main.txt) |
| Infraestrutura | **7 aprovados, zero falhas ou skips**, incluindo backup consistente, restauração de prova, retenção e congelamento/verificação da fonte. São adicionais à suíte principal. | [Saída integral](qa/tests-infra.txt) |
| Interface com DOM emulado | **23 aprovados, zero falhas ou skips**, incluindo o bundle compilado e um componente isolado para hooks, com API HTTP e SQLite temporários. | [Saída integral](qa/tests-dom.txt), [revisão independente](REVIEW-JK.md) |
| Auditoria npm | Consulta do registry retornou **zero avisos conhecidos** para o conjunto de 150 dependências resolvidas. Não é análise completa de segurança nem inclui o runtime isolado de autoria. | [Resultado JSON](qa/npm-audit.json) |
| Gates de release | 13 verificações estáticas aprovadas: runtime, bind, volume, cookies, bootstrap, manutenção, CI e presença do build. | [Script](../scripts/jk-release-check.mjs) |
| Navegador real | Landing e tela de acesso inspecionadas, navegação pública funcionando e link exato do Instagram observado. | [Landing](qa/landing-jk-20261028.jpg), [acesso](qa/login-jk-20261028.jpg) |
| Autoria de mídia | Diagrama, WAV, cena e filme renderizados; validações e limites próprios registrados. | [Design e mídia](DESIGN-MEDIA.md) |
| CI remota e contêineres | **Aprovada** no commit `f965e03d92a881cfc9d3bb9df67caeeee9d48045`: build da imagem, health dos dois serviços, bootstrap sintético por stdin, backup com prova de restauração, persistência após reinício e limpeza dos recursos. | [GitHub Actions](https://github.com/oalexandrebelo/AB-JK-UASH/actions/runs/40791408960), [registro estruturado](qa/ci-remote-result.json) |
| REA 6.7.0 | Análise estática do snapshot e análises adicionais dos grupos críticos; cobertura, limites e identificadores no relatório dedicado. | [REA](rea/README.md), [resumo estruturado](rea/summary-jk.json) |

A soma dos gates de teste acima é **189 aprovações**, com cinco testes não executados: quatro PostgreSQL e um da distribuição standalone com runtime empacotado, ausente neste checkout de fontes. As suítes focadas de migração, delivery e integração já estão contidas na suíte principal; não são somadas novamente. Relatórios de outras revisões do AB-UASH, quando presentes no código herdado, são históricos.

## Versão efetivamente testada

- Node.js local: **24.22.1**.
- Snapshot de produto: **116 arquivos**, **972.743 bytes**, incluindo `server`, `integrations`, `src`, `scripts` e os manifestos/configurações explicitamente selecionados.
- SHA-256 agregado da fonte congelada: `0fd848376f48ce6bf3a2280ec864cf7d1a42085d8a6eb0f982b919638dfc7307`.
- SHA-256 do `dist/index.html` usado pelo QA DOM: `c623c168e8774454430afdc7be40f3bc59300c19544c71ef640ff0ae3f55d108`.
- Manifesto completo do snapshot e relatórios legíveis do REA acompanham a [pasta de evidências](rea/).

O snapshot não inclui bancos, segredos, `node_modules`, distribuição compilada, SDK gerado, testes, mídia ou infraestrutura. O escopo é explícito; seu hash não pretende representar cada arquivo do repositório. A fonte foi conferida novamente após os testes.

**Distribuição separada do REA.** A revisão automática de aprovação bloqueou a publicação dos envelopes completos comprimidos e opacos no GitHub público. O repositório contém os relatórios legíveis, a cobertura, os planos, os manifestos e os hashes; os 17 arquivos de evidência completa foram preservados e entregues ao usuário no pacote privado `AB-JK-UASH-REA-20261028.zip`, com 26 arquivos, 20.305.635 bytes e SHA-256 `d38592abc191252355598c30f319f6b9be8fe1d3b0b4258b22c759a4b4980387`. O pacote mantém os relatórios originais e o `SHA256SUMS` completo. O `SHA256SUMS` público cobre somente os arquivos publicados em `docs/rea`. Os resultados, IDs de Evidence e hashes das fontes permanecem iguais; nenhum link privado é publicado. [Detalhes de distribuição](rea/README.md).

## Correções verificadas na revisão final

**Destino da integração vinculado à preparação.** Uma preparação nunca enviada poderia anteriormente ficar disponível depois de ativar ou trocar conta, provedor ou ambiente. A preparação agora registra o vínculo da conta quando habilitada; o envio exige correspondência exata. Mudança de destino, preparação sem configuração ou registro legado sem vínculo produzem `INTEGRATION_PREPARATION_CHANGED` antes do I/O. A interface exige cancelamento local e nova preparação. Foram adicionados cenários de Pix e WhatsApp verificando ausência de chamadas externas e preservação do saldo. [Detalhamento](REVIEW-JK.md).

**Distribuição sem dependências.** A fixture antiga copiava somente `integrations/fiscal`, deixando a ponte JK de fora. Ela passou a copiar `integrations/` completo; o teste continua executando a aplicação SQLite em um diretório sem `node_modules`.

**Pós-pago imprimível.** O detalhe da fatura oferece documento comercial não fiscal, isolado da interface por um portal de impressão. Os testes conferem conteúdo, identificador, valor, chamada única de impressão e remoção do documento. Não houve teste de impressora física ou criação de um gerador PDF de servidor.

**Ajuda operacional.** O vídeo é aberto por ação voluntária no painel, com controles, som inicialmente desativado e sem autoplay. A explicação textual e o diagrama são equivalentes ao conteúdo essencial. ManimGX, Earshot e Hyperframes não entram no JavaScript da operação.

## O que os testes de comportamento demonstram

A suíte exercita cadastro e pesquisa, vínculo cliente/veículo, versões e idempotência, concorrência de escritas, permissões atuais, CSRF, sessões, transições de OS, bloqueio de entrega com saldo, pagamentos parciais, caixa, pós-pago, pacotes, estoque, fotos, OCR, fiscal simulado, SDK e persistência/reinício.

As extensões JK acrescentam importação por prévia/hash/transação, repetição sem duplicidade, preservação do histórico sem movimentar caixa, transporte com conflitos de agenda, conclusão atômica da entrega, preparação de integrações, falhas incertas, conciliação autenticada simulada, homologação sem baixa e bloqueio de destino alterado. O QA DOM testa o bundle real e os eventos de formulário; não acessa handlers internos de React para simular cliques.

Todos os cadastros, contas, comprovantes e respostas de provedores usados nos testes são sintéticos. Não houve pagamento real, cobrança bancária real, mensagem a cliente ou autorização fiscal real.

## Navegador e aparência

A instância de inspeção foi temporária, isolada e executada com Node 24.22.1. A landing e o acesso foram carregados pelo navegador real. As capturas não contêm credenciais ou dados de clientes. Não foram observados erros JavaScript da aplicação nesses dois estados; o navegador registrou avisos da sua própria extensão de controle.

A entrada autenticada no navegador não foi automatizada: o canal de navegador exige o fluxo seguro de autenticação e não admite digitação de credenciais pelo agente. Essa restrição não foi contornada. Os fluxos autenticados foram exercitados por HTTP e pelo DOM emulado. Aparência do painel autenticado, responsividade em aparelho móvel, foco com leitor de tela, impressão física, câmera e hardware POS precisam de validação no ambiente real.

A instância temporária foi **encerrada** após a inspeção. Ela não é um endereço de produção e não é fornecida como implantação permanente.

## Implantação: bloqueio observado

A Oficina criou o projeto `ab-jk-uash`, com dados separados e faixa de portas **9220–9229**. O destino preparado é `https://ab-pcsrv.tail6bac78.ts.net:9220`. A criação do projeto não equivale à publicação do app.

Durante o fechamento, o conector passou a responder **MCP `-32603: Internal error`** em renovação da sessão, consulta de capacidade e tentativa de preparar o primeiro lote de fontes. O lote de fontes não foi confirmado nem enviado. Nesse destino, não foi executado build Docker, `compose up`, configuração HTTPS ou health. O build e o smoke test de contêineres aprovados na CI usaram um runner isolado, sem acesso à Oficina. Não se afirma que o servidor esteja indisponível; o bloqueio observado está no canal de implantação.

O `compose.yaml`, Dockerfile, CI, manutenção e [runbook](operations-jk.md) estão prontos no código. O primeiro administrador também precisa de um canal privado de stdin/segredos. Os comandos de bootstrap recusam instalação que já contenha usuários e não imprimem credenciais. Nenhum acesso administrativo do cliente foi criado no destino remoto.

## Requisitos para o teste de produção

| Requisito | Critério de encerramento |
| --- | --- |
| Canal de implantação | Enviar fonte revisada ao projeto JK; executar Compose real; comprovar app e manutenção saudáveis, HTTPS e persistência após restart. |
| Primeiro administrador | Criar acesso por canal privado; testar login, papel, logout e revogação de sessão. Não publicar credenciais. |
| Migração | Receber exportações autorizadas; prévia sem erros; reconciliar contagens, vínculos e valores; confirmar lote e recontar. Arquivos históricos incompletos não podem ser apresentados como banco completo. |
| Pix | Credenciais/certificado e conta corretos; homologação; demonstrar timeout/consulta e baixa exatamente uma vez; só depois habilitar produção. |
| Fiscal | Cadastro do contribuinte, município, classificação tributária e provedor efetivamente habilitados; emissão/reconciliação homologadas antes de uso real. |
| WhatsApp | Conta/remetente/modelos aprovados, consentimento e credenciais; homologação. Aceite do provedor continua distinto de entrega. |
| Continuidade | Executar backup/restauração no volume real e definir cópia externa. Não há alta disponibilidade ou cópia fora do equipamento configurada. |
| Dispositivos | Conferir câmera/OCR, impressão, aparelho móvel e eventual SmartPOS. Adaptadores/homologação de adquirente não são supridos por um registro manual de cartão. |
| Escala e perfis alternativos | Fazer teste de carga com volume e concorrência esperados; aplicar/testar DDL JK antes de considerar PostgreSQL. |

A [matriz de funcionalidades](FEATURE-MATRIX.md) mantém as demais lacunas de produto: estorno financeiro completo, plano de parcelas, taxas de cartão, venda de produto como item da OS, mapas/geocodificação, campanhas, comprovante de entrega WhatsApp, multiunidade e reserva pública, entre outras. Elas não foram ocultadas por interfaces ou registros simulados.

## Isolamento do teste de hooks após a publicação

A [CI do fechamento documental](https://github.com/oalexandrebelo/AB-JK-UASH/actions/runs/40791854307) do commit `ddcee37f43555f9c2a8b98cf67c3460d0ac1ef99` identificou uma corrida no ambiente de QA: a asserção de recurso desativado contava todas as requisições do fixture, incluindo a montagem concorrente do Dashboard. O contador remoto passou de 30 para 34. Nenhuma fonte de produto havia mudado desde a execução remota aprovada.

A [reprodução controlada](qa/hooks-counter-probe.txt) confirmou a interferência: o contador passou de 21 para 29, contendo duas séries de GET para `/api/dashboard`, `/api/customers?limit=1`, `/api/vehicles?limit=1` e `/api/services?limit=1`. O recurso testado estava desativado, com estado limpo; `/api/missing-qa` permaneceu com uma chamada. Esses valores descrevem o experimento e não são contagens de defeitos no produto.

O fixture ganhou a opção `mountBundle`, cujo padrão continua `true`. Somente o teste que monta os hooks diretamente usa `mountBundle:false`, mantendo HTTP real e SQLite temporário. A asserção global exata de zero novas requisições foi preservada, e agora também aguarda o efeito correspondente a `null` terminar. Os demais testes continuam montando o bundle da aplicação.

A [reverificação focada](qa/hooks-focused-after-isolation.txt) passou em **6/6**, e a [suíte DOM completa após o isolamento](qa/tests-dom-after-isolation.txt) passou em **23/23**, sem falhas ou skips. Os seis testes focados já pertencem aos 23; o diagnóstico isolado não aumenta o total de 189 testes consolidados. Os 56 arquivos de `dist` permaneceram idênticos e o snapshot de produto V2 conservou seu digest. A alteração envolve apenas testes e documentação. As [execuções do workflow](https://github.com/oalexandrebelo/AB-JK-UASH/actions/workflows/ci.yml) registram o resultado remoto de cada revisão publicada.

## Reproduzir os gates

```sh
npm ci --ignore-scripts
npm run build
npm run sdk:build
npm test
npm run test:infra
npm ci --ignore-scripts --prefix qa/ui-tool
AB_UASH_UI_QA_REQUIRED=1 TZ=America/Sao_Paulo node --test --test-reporter=spec tests/ui-*.test.mjs
npm run release:check
```

A [execução remota de CI](https://github.com/oalexandrebelo/AB-JK-UASH/actions/runs/40791408960) terminou com sucesso em **29/10/2026 às 00:04:12 UTC**, reproduzindo os 189 testes aprovados e os cinco skips descritos acima. Também validou Compose, construiu e iniciou a imagem real, conferiu app/manutenção saudáveis, criou somente um administrador sintético por stdin, comprovou backup/restauração e persistência após restart, e removeu os recursos temporários. O código testado foi o commit `f965e03d92a881cfc9d3bb9df67caeeee9d48045`; este fechamento altera apenas documentação. O gate de contêineres é adicional e não aumenta artificialmente a contagem dos testes unitários/de integração. Os dados estruturados estão em [validation-jk.json](qa/validation-jk.json) e [ci-remote-result.json](qa/ci-remote-result.json).
