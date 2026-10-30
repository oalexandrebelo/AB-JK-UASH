# PRD — AB-JK-UASH / Lava Rápido JK

**Revisão:** 30/10/2026. **Base do produto:** versão `0.1.1` do manifesto, em fechamento. **Natureza:** requisitos de produto e critérios de aceite do cliente JK, confrontados com a implementação existente. O baseline `5304ee6` já foi instalado no AB-PCSRV com prova de backup/restauração; isso não declara a release final instalada, migração real, homologação fiscal/bancária ou paridade integral concluídas. O estado atual pertence a [RELEASE-0.1.1.md](RELEASE-0.1.1.md); [VALIDATION-JK.md](VALIDATION-JK.md) é evidência histórica de 28–29/10. Capacidades e lacunas estão na [FEATURE-MATRIX.md](FEATURE-MATRIX.md).

## 1. Problema, público e objetivo

O produto reúne atendimento, cadastros, ordens de serviço, agenda, recebimentos e controle administrativo de uma operação de lava-rápido. A JK precisa consultar os dados anteriores do Jumpcar sem transformar serviços e recebimentos históricos em novas cobranças, receitas ou comissões. A página pública apresenta a empresa e encaminha o contato para o canal informado. A equipe utiliza uma área autenticada própria. [Arquitetura](ARCHITECTURE.md), [migração](migration-jk.md), [interface pública](../src/pages/LandingPage.tsx).

O objetivo é permitir uma rotina rastreável, desde a entrada do veículo até a entrega e o fechamento financeiro, com interface Adobe Spectrum 2, valores consistentes, acesso por papel e tratamento explícito de falhas. A meta de paridade com o Jumpcar permanece verificável por capacidade: uma tela com o mesmo nome não equivale a integração homologada ou comportamento completo. As páginas públicas do fornecedor são referência de escopo; regras internas não observadas não devem ser presumidas. [Matriz de escopo](FEATURE-MATRIX.md).

O recorte implementado é **uma empresa por instalação/banco**. Há múltiplos usuários, mas não segregação por filial ou tenant. O destino JK principal usa armazenamento local; o perfil PostgreSQL herdado tem requisitos próprios e não oferece a migração Jumpcar. [Arquitetura](ARCHITECTURE.md), [contrato de migração](migration-jk.md).

## 2. Pessoas e responsabilidades

| Pessoa / papel | Necessidade | Fronteira do produto |
| --- | --- | --- |
| Visitante da LP | Conhecer o catálogo publicado e combinar atendimento | Sem acesso a clientes, placas, ordens ou saldos; contato pelo Instagram informado; não há reserva pública confirmada pelo sistema. |
| `operator` | Cadastrar cliente/veículo, registrar e movimentar OS, agenda, fotos, consumo e recebimento permitido | Não administra usuários nem possui todas as permissões de gestão. A API decide a autorização de cada rota. |
| `manager` | Gerir catálogo, equipe, estoque, caixa, faturas, pacotes, folha interna e integrações | Configuração de provedor e dados fiscais precisam ser reais e revisados; preparação local não representa efeito externo. |
| `admin` | Gerir usuários, configuração e importação, além da operação | Responsável por revisar prévia, ambiente, recuperação e acesso; arquivos reais permanecem privados. |
| `viewer` | Consultar a operação permitida | Sem mutações; acesso financeiro e dados privados adicionais seguem restrições do servidor. |

Os papéis são implementados pela aplicação, não por visibilidade de botões apenas. A agenda privada de transporte não é disponibilizada ao `viewer`. Referências: [segurança e papéis](ARCHITECTURE.md#api-autenticação-e-autorização), [contrato principal](../server/CONTRACT.md), [delivery](JK-DELIVERIES.md).

## 3. Escopo funcional e situação atual

“Implementado” nesta tabela significa código e contrato identificados. Aceite da rotina real continua dependendo dos gates da seção 8. A matriz detalhada contém as rotas, arquivos e suítes de cada módulo.

| Requisito | Resultado esperado | Situação e limite atual |
| --- | --- | --- |
| RF01 — Cadastros | Buscar, criar, editar e desativar clientes, veículos, serviços e equipe; preservar vínculos e histórico | Implementado. Placa é normalizada e única; dados importados ainda exigem conferência real. |
| RF02 — Atendimento / OS | Montar itens, registrar responsável, acompanhar execução e entregar segundo o saldo e o tipo de cliente | Implementado para instalação local; sem portal do cliente ou multiunidade. |
| RF03 — Orçamentos | Preparar proposta e convertê-la em atendimento preservando a OS | Parcial: impressão comercial pelo navegador; sem aceite remoto assinado ou envio de PDF dedicado. |
| RF04 — Checklist, fotos e OCR | Registrar condições/avarias e sugerir placa a partir de imagem com revisão humana | Parcial perante a referência completa: fotos persistidas e OCR local; sem assinatura ou mapa interativo de avarias. |
| RF05 — Agenda e transporte | Agendar, verificar conflitos, converter em OS e controlar retirada/devolução por responsável | Implementado localmente; sem mapa, GPS, otimização de rota, reserva pública ou capacidade por box. |
| RF06 — Estoque | Controlar entrada, ajustes, mínimo, consumo por OS e reversão rastreável | Parcial: consumo manual; sem receita automática de insumos por serviço, compras/contas a pagar, lotes ou validade. |
| RF07 — Caixa e recebimentos | Abrir/fechar caixa, receber parcialmente e distinguir dinheiro físico de meios digitais | Implementado como registro financeiro local. Registro de cartão não autoriza transação na adquirente. |
| RF08 — Pós-pago | Agrupar saldos de OS elegíveis do mesmo cliente, estabelecer vencimento, receber e imprimir fatura | Implementado para controle local; documento não fiscal, sem boleto, juros, débito recorrente ou Pix agregado de fatura. |
| RF09 — Fiscal | Preparar dados revisados, transmitir por provedor habilitado e consultar resultado | Adaptador e fluxo existentes; homologação e cadastro fiscal pendentes. Sem NF-e/NFC-e completo, classificação automática universal ou cancelamento de nota autorizada. |
| RF10 — Pacotes | Vender créditos, consumir na OS e conferir validade, cliente e serviço | Implementado localmente; sem renovação/cobrança recorrente automática. |
| RF11 — Comissões e folha interna | Apurar comissão elegível e fechar remuneração com ajustes e pagamento único | Parcial: percentual por serviço/empregado, sem comissão fixa ou rateio. Folha interna não calcula obrigações trabalhistas completas. |
| RF12 — Pix e WhatsApp | Preparar, enviar explicitamente e acompanhar integração configurada sem duplicar efeitos | Externo pendente e parcial. Pix Efí/Inter e WhatsApp Cloud têm adaptadores; faltam ensaios reais. Não há worker, webhook de recebimento/entrega nem retry automático de mutações. |
| RF13 — CRM / pós-venda | Organizar relacionamento e automações de retorno | Lacuna para CRM automatizado: rascunhos locais não implementam segmentação, campanhas, agendamento, opt-out de campanha ou conversão. |
| RF14 — Relatórios e auditoria | Consultar indicadores, exportar CSV, imprimir e rastrear alterações conforme o papel | Implementado para uma instalação, com significado próprio de cada período/indicador. Sem consolidação multiunidade. |
| RF15 — Migração | Conferir arquivos autorizados, importar com aprovação vinculada à prévia e consultar histórico | Implementado em SQLite local; extração completa, reconciliação e importação dos dados reais pendentes. |
| RF16 — LP e orientação | Apresentar identidade/catálogo reais e orientar a equipe com ajuda acessível | LP e ajuda implementadas; catálogo não deve receber preços ou avaliações fictícios. Mídia opcional não modifica atendimento. |

Fontes de implementação: [FEATURE-MATRIX.md](FEATURE-MATRIX.md), [MANUAL-JK.md](MANUAL-JK.md), [contrato principal](../server/CONTRACT.md), [integrações JK](../integrations/jk/README.md).

## 4. Jornadas e regras de aceite

### J01 — Primeiro acesso e operação diária

A instalação deve iniciar sem senha ou conta padrão. O administrador cria o acesso pelo fluxo autorizado, configura a empresa e cadastra os recursos reais. Um operador deve conseguir localizar cliente/veículo, criar OS com pelo menos um serviço, conferir os valores e executar as transições permitidas. Configuração indisponível não deve produzir dados demonstrativos como se fossem da operação. [README](../README.md), [AuthPage](../src/pages/AuthPage.tsx), [OrderEditor](../src/pages/OrderEditor.tsx).

Aceite: usuário desativado ou sem papel adequado não conclui escrita; conflito de versão exige atualização; repetição da mesma intenção após falha de rede não duplica o atendimento. A interface mantém mensagem acionável para erro e distingue carregamento de lista vazia. [Cliente HTTP](../src/lib/api.ts), [testes de UI](../tests/ui-review-20261021.test.mjs).

### J02 — Execução, conferência, pagamento e entrega

As etapas operacionais são orçamento, agendada, aguardando, em execução, conferência, pronta, entregue e cancelada. Conferência e pronta permitem retorno à execução para correção. Entregue e cancelada encerram o fluxo. A entrega exige quitação, exceto para cliente habilitado a pós-pago; esse caso mantém o recebível. Cancelamento exige ausência dos vínculos e efeitos financeiros/consumos que o domínio bloqueia. [Contrato de OS](../server/CONTRACT.md#ordens-de-serviço).

Aceite: cadastro e serviço usados pertencem ao atendimento; mudanças posteriores de preço não alteram silenciosamente o valor negociado; pagamentos não excedem saldo; dinheiro exige caixa aberto; métodos digitais não aumentam o valor de cédulas/moedas esperado. Fotos, checklist e consumo não continuam editáveis depois do fechamento permitido pelo domínio. [Domínio de OS](../server/domain-orders.mjs), [financeiro](../server/domain-finance.mjs), [fotos](../server/media.mjs).

### J03 — Pós-pago e documento comercial

O gestor seleciona cliente habilitado, escolhe OS prontas/entregues com saldo, informa vencimento, revisa o total e cria a fatura. A fatura deve distribuir o recebimento pelas OS de forma atômica, impedir dupla vinculação ativa e permitir cancelamento apenas nas condições implementadas. [InvoicesPage](../src/pages/InvoicesPage.tsx), [domínio financeiro](../server/domain-finance.mjs).

Aceite: total/saldo conferem com os vínculos; impressão identifica fatura de controle não fiscal e não boleto; o usuário consegue consultar recebimentos e vencimento. A impressão/salvamento em PDF pelo navegador não deve ser anunciada como um serviço de PDF emitido/enviado automaticamente. A referência [Jump Car pós-pago](https://www.jumpcar.com.br/funcionalidades/gestao-de-pos-pago) documenta agrupamento por período, faturas PDF e controle de cobrança; diferenças remanescentes devem permanecer na matriz.

### J04 — Importação revisada

O administrador obtém a exportação autorizada fora do repositório, escolhe arquivos compatíveis, revisa pendências/contagens/totais e confirma exatamente a prévia analisada. A interface deve verificar o suporte da instalação antes de disponibilizar arquivos ou ações. Falha dessa consulta impede a importação até recuperação; não deve ser apresentada como prova de incompatibilidade. [MigrationPage](../src/pages/MigrationPage.tsx).

Clientes, veículos e serviços tornam-se cadastros operacionais. OS, itens e pagamentos migram para histórico separado e não geram caixa, cobrança, comissão, nota, mensagem ou estoque atual. Uma alteração do arquivo ou do estado relevante do destino exige nova prévia. O mesmo lote deve ser reaplicável sem duplicação. Arquivos nativos sem IDs usam a identidade técnica declarada de snapshot/linha; novo snapshot exige reconciliação, sem mesclagem presumida por nome/telefone. [Contrato completo](migration-jk.md).

Aceite real: comparar origem e destino por coleção, relações e totais; revisar pendências e registros que ficaram somente como evidência histórica; obter aprovação do responsável; restaurar cópia de prova antes de usar o destino como base operacional. Nenhum teste sintético prova que a exportação da JK estava completa.

### J05 — Integrações e situações incertas

Fiscal, Pix e WhatsApp exigem fluxo explícito, configuração válida e usuário autorizado. Preparação salva intenção local. Readiness de configuração não comprova credencial aceita ou homologação. Timeout não permite repetir envio às cegas. O produto deve mostrar o ambiente e os estados efetivamente recebidos. [Contrato da ponte](../integrations/jk/README.md), [FiscalPage](../src/pages/FiscalPage.tsx).

Aceite: Pix só baixa com evidência autenticada elegível de produção; homologação não reduz saldo real; WhatsApp aceito pelo provedor não é apresentado como entregue; fiscal só é autorizado mediante retorno validado. Cancelamento de preparação local não é cancelamento bancário nem cancelamento de NFS-e autorizada. A [referência fiscal Jump Car](https://www.jumpcar.com.br/funcionalidades/emissao-de-nota-fiscal) condiciona cobertura a municípios integrados; não sustenta promessa universal de emissão.

### J06 — LP e ajuda

A LP utiliza o nome JK, o [perfil informado](https://www.instagram.com/lavar.apidojk/) e catálogo público permitido pelo backend. A indicação histórica de Rio Verde não equivale a nova verificação de endereço ou horários. Campos de contato, serviços e preços precisam ter origem autorizada. O catálogo vazio continua vazio; links não devem simular reserva ou mensagem concluída. [Perfil público](../server/jk-public.mjs), [LP](../src/pages/LandingPage.tsx).

Aceite: informações privadas não aparecem no endpoint público; ilustrações não são apresentadas como fotos do estabelecimento; navegação e contato funcionam em tela pequena e por teclado. A ajuda de atendimento abre voluntariamente, permite ler texto/diagrama sem vídeo e não inicia áudio automaticamente. [Ajuda](../src/components/HelpFlow.tsx), [design e mídia](DESIGN-MEDIA.md).

## 5. Requisitos de experiência e qualidade

- **Compreensão do estado:** carregando, vazio, falha, indisponível, salvo localmente e confirmado externamente têm mensagens diferentes. Toda escrita pendente bloqueia repetição e cancelamento que possam esconder seu resultado.
- **Spectrum 2 real:** componentes de formulário, diálogo, navegação e seleção usam a biblioteca oficial; cores, espaços e tipografia devem preservar legibilidade, foco, erro e estados desabilitados. [Provider](../src/main.tsx), [componentes compartilhados](../src/components/ui.tsx).
- **Acesso por teclado e tela pequena:** realizar o fluxo principal sem mouse, manter foco previsível, nomes acessíveis, reflow e movimento reduzido. S2 não certifica a composição inteira; leitor de tela e equipamento JK precisam de QA.
- **Consistência:** dinheiro em BRL, datas operacionais no fuso definido, listas paginadas sem perder registros e busca de cadastros que permite localizar itens fora da primeira página. [Cliente e formatação](../src/lib/api.ts), [RemotePicker](../src/components/RemotePicker.tsx).
- **Recuperação:** erro de leitura não deve abrir formulário vazio capaz de apagar dados anteriores; alteração financeira e auditoria precisam ser atômicas; backup deve ter restauração demonstrada no destino. [Revisão](REVIEW-JK.md), [operação](operations-jk.md).

Não há SLO de latência, disponibilidade ou taxa de acerto OCR aprovado neste documento. Medições precisam declarar equipamento, volume, revisão e cenário; não usar números de fixtures como resultados da rotina JK.

## 6. Dados, privacidade e publicação

O repositório público contém código, documentação e dados sintéticos claramente identificados. Dados de cliente/veículo, documentos fiscais, fotos de avarias, destinatários de mensagens, comprovantes, exportações, backups e segredos pertencem ao ambiente privado da operação. Os exemplos não devem incluir valores reais de acesso. [Arquitetura](ARCHITECTURE.md), [operação](operations-jk.md).

Para o aceite de produção, definir responsáveis por acesso, retenção, correção/exclusão quando cabível, incidentes e recuperação. Controles técnicos presentes não representam certificação de LGPD nem substituem essa definição. Este PRD não declara auditoria legal ou eliminação de todos os riscos. O contrato técnico e as pendências de privacidade estão no [PRT](PRT-JK.md).

## 7. Lacunas que impedem afirmar paridade integral

Além da configuração externa pendente, há trabalho de produto ainda não implementado: multiunidade, sincronização offline entre dispositivos, SmartPOS/TEF, venda de mercadorias na OS, CRM/campanhas automáticas, comissão fixa/rateio, mapa/GPS, aceite remoto de orçamento e fluxo completo de NF-e/NFC-e. Estoque automatizado por serviço e integração bancária ampliada também permanecem incompletos. [Matriz](FEATURE-MATRIX.md).

Cada lacuna precisa de decisão explícita: implementar com critério/teste, ou aceitar por escrito o recorte para a instalação inicial. Aceitar uma instalação inicial com limites não converte o produto em equivalente integral ao Jumpcar. Credenciais não resolvem lacunas de código.

## 8. Gates de aceite e evidência necessária

| Gate | Evidência exigida | Responsável funcional |
| --- | --- | --- |
| G01 — Código distribuível | Build, tipos, suítes obrigatórias, licença/proveniência e revisão de conteúdo público vinculados à revisão final | Engenharia |
| G02 — Ambiente de destino | Aplicação, banco persistente, origem segura, controles de acesso e recuperação após reinício verificados | Administração técnica |
| G03 — Migração real | Arquivos autorizados completos, prévia aprovada, contagens/relações/totais conciliados e backup restaurável | Administrador e responsável JK |
| G04 — Rotina principal | Cadastro → OS → execução → recebimento/pós-pago → entrega → conferência de caixa, com usuários do negócio | Operação e gestão JK |
| G05 — Provedores adotados | Homologação e casos autorizados de sucesso, pendência, erro e consulta; ambiente/conta corretos | Responsável financeiro/fiscal e técnico |
| G06 — Equipamentos e acessibilidade | Navegação, teclado, impressão e OCR testados nos dispositivos usados, com limitações registradas | Operação e engenharia |
| G07 — Privacidade e recuperação | Responsáveis, acesso, retenção, backup externo e ensaio de restauração definidos e evidenciados | Responsável JK e administração técnica |
| G08 — Escopo de paridade | Aceite ou plano de implementação para cada item parcial/lacuna da matriz | Responsável do produto |

O estado de cada gate deve ser atualizado no registro de entrega com data, revisão, evidência e pendência. Este PRD define o que aceitar; não assina os gates nem antecipa seus resultados.
