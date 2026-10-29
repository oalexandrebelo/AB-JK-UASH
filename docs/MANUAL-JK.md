# Manual operacional — Lava Rápido JK

Este manual descreve as telas e ações existentes no código do AB-JK-UASH em 28/10/2026. Serve para treinamento, conferência da operação e preparação da entrada em uso. A disponibilidade do endereço publicado deve ser confirmada com o administrador: este documento não comprova implantação, migração de dados reais, homologação bancária ou emissão fiscal.

O roteiro inicial usa **uma instalação de teste isolada, apenas com registros sintéticos e integrações externas desabilitadas**. Não execute os exemplos na base real. O catálogo ativo pode aparecer no site público da mesma instalação; cadastrar um serviço de teste em produção também pode torná-lo público. Não copie nomes, placas, telefones, documentos, fotografias ou credenciais reais para o treinamento.

Consulte a [matriz de funcionalidades e lacunas](FEATURE-MATRIX.md) para distinguir implementação local, integração pendente e funcionalidade ausente. A [arquitetura](ARCHITECTURE.md), o [contrato de migração](migration-jk.md) e o [guia técnico de operação](operations-jk.md) detalham os procedimentos do administrador. Resultados consolidados de validação pertencem ao relatório de fechamento da versão; o roteiro abaixo não é uma declaração de que todas as etapas já foram executadas em produção.

## 1. Acesso, perfis e navegação

Abra o endereço fornecido pelo administrador e entre na área `/app`. Informe **E-mail** e **Senha** e pressione **Entrar na operação**. **Mostrar senha** permite conferir a digitação. Não há envio de recuperação de senha pela tela: em caso de perda de acesso, contate o administrador pelo canal já combinado com a empresa.

Em uma instalação ainda não configurada, pode aparecer a criação do primeiro administrador: **Seu nome**, **E-mail**, **Senha** e, quando exigido, **Token de configuração**. O responsável pela implantação fornece esse token em canal privado. A senha deve ter de 12 a 128 caracteres; este manual não fornece senha padrão. **Criar acesso de administrador** é uma ação de instalação, não o cadastro de um funcionário de atendimento.

| Perfil | Uso na interface |
| --- | --- |
| **Administrador** | Operação e gestão, criação de acessos, permissões e migração de dados. |
| **Gestor** | Operação, cadastros de gestão, caixa, pós-pago, folha, relatórios, fiscal e integrações; não administra usuários nem executa migração. |
| **Operador** | Rotina de clientes, veículos, agenda, OS, checklist, consumo, recebimentos permitidos na OS e transporte. As áreas financeiras de gestão e integrações não ficam disponíveis. |
| **Consulta** | Consulta das áreas operacionais permitidas, sem gravação. Transporte e áreas de gestão restritas não ficam disponíveis. |

Os botões e menus respeitam o perfil, e o servidor também valida a permissão. Se uma opção não aparecer, confirme seu perfil; não use a conta de outra pessoa para contornar a restrição.

A navegação se divide em **Atendimento**, **Gestão** e **Controle**. A busca **Buscar**, também acessível por `Ctrl+K` ou `Command+K`, procura áreas do aplicativo. Para localizar uma pessoa, placa ou OS, use a busca dentro da página correspondente. No celular, abra **Abrir navegação**. Use **Sair** ao terminar em um equipamento compartilhado.

Em **Visão geral**, consulte os indicadores e atualize pelo botão **Atualizar painel**. O recurso **Como funciona o atendimento** explica as etapas com texto, vídeo controlado pela pessoa e acesso ao diagrama. Reproduzir essa ajuda não altera nenhuma OS.

**Fonte da interface:** [AuthPage](../src/pages/AuthPage.tsx), [Shell](../src/components/Shell.tsx), [RootApp](../src/RootApp.tsx), [HelpFlow](../src/components/HelpFlow.tsx).

## 2. Configurações e responsabilidade pelos registros

Em **Configurações → Empresa**, administrador ou gestor pode editar **Nome da empresa**, **Telefone**, **Endereço** e **Mensagem no recibo** e usar **Salvar dados da empresa**. Esses campos alimentam recibos e textos de mensagens. Não presuma que essa tela altere todos os conteúdos do site público. Confira o fuso apresentado; as telas de agendamento e transporte utilizam o horário de São Paulo.

Em **Minha conta**, informe **Senha atual** e **Nova senha** e pressione **Atualizar senha**. As demais sessões da própria conta são encerradas.

Em **Acessos**, o administrador usa **Criar acesso**, com **Nome**, **E-mail**, **Senha inicial** e **Permissão**. **Editar acesso** permite alterar nome, permissão e **Acesso ativo**. Essa edição não contém um campo para trocar a senha de outra pessoa. Alterar o perfil ou desativar a conta encerra as sessões dela; o último administrador ativo deve ser mantido.

**Equipe e comissões** cadastra profissionais que podem receber atribuições e comissões. **Acessos** cadastra pessoas que entram no sistema. Criar um profissional não cria automaticamente uma conta de login, nem o contrário.

Administrador e gestor podem consultar **Auditoria**, que mostra os últimos 100 eventos locais. Ela ajuda a localizar uma alteração, mas essa tela não é uma exportação de todo o histórico.

**Fonte:** [SettingsPage](../src/pages/SettingsPage.tsx).

## 3. Cadastros para o primeiro teste

Os valores a seguir foram escolhidos apenas para conferir cálculos. Peça ao administrador uma base de treinamento vazia e um acesso apropriado. Antes de começar, confirme que nenhum provedor real está habilitado e que a base não é a usada no atendimento público.

| Página e botão | Preenchimento sintético |
| --- | --- |
| **Clientes → Cadastrar cliente** | **Nome / razão social:** `TESTE JK — Particular`; **Tipo de cliente:** Pessoa física. Deixe telefone e e-mail vazios e **Permitir pós-pago e faturamento** desmarcado. |
| **Veículos → Cadastrar veículo** | Selecione o cliente acima. **Placa:** `TST1A23`, usada aqui somente como identificador sintético; **Marca e modelo:** `Veículo sintético`; **Cor:** Cinza; **Categoria:** Pequeno. |
| **Serviços → Cadastrar serviço** | **Nome do serviço:** `TESTE — Lavagem`; **Preço:** R$ 50,00; **Duração em minutos:** 30; **Comissão do serviço (%):** 10. |
| **Equipe e comissões → Cadastrar profissional** | **Nome:** `TESTE — Operação`; **Função:** Atendimento de teste; **Salário base:** R$ 0,00; **Comissão padrão (%):** 5. |
| **Estoque → Cadastrar produto** | **Nome do produto:** `TESTE — Insumo`; **Código / SKU:** `TESTE-INS-001`; **Unidade:** L; **Estoque inicial:** 1; **Estoque mínimo:** 0,25; **Custo por unidade:** R$ 10,00. |

Mantenha **Cadastro ativo** marcado nesses exemplos e salve cada formulário. A interface apresenta dinheiro em reais, porcentagem em percentual e estoque na unidade escolhida. Não digite `5000` para representar R$ 50,00 no campo **Preço**: centavos são uma convenção de API e de alguns arquivos de exportação, não dessa entrada visual.

Use **Editar** para corrigir um cadastro. O fluxo disponível permite desativá-lo por **Cadastro ativo**; não apresenta exclusão geral de registros. Um cadastro usado em atendimentos anteriores continua fazendo parte do histórico. Preços e comissões já registrados na OS não devem ser conferidos apenas pelo valor atual do catálogo.

No exemplo, a comissão do serviço de 10% prevalece sobre a comissão padrão de 5% do profissional. Se a comissão do serviço for zero, utiliza-se a padrão do responsável. Essa configuração não representa rateio entre vários profissionais.

### Ler placa com uma foto

No formulário de veículo, **Ler placa de uma foto** permite **Selecionar foto**, executar **Ler placa**, conferir o texto e usar **Usar placa conferida**. Use no treinamento uma imagem sintética, por exemplo uma das [imagens de teste do OCR](../tests/ocr-fixtures/), sem rosto, documento ou veículo de cliente.

PNG e JPEG são aceitos nos limites informados pela tela. A leitura é local no navegador. Confira a **Placa para conferência** e corrija qualquer caractere antes de aplicá-la ao formulário. **Cancelar leitura** interrompe o processamento. Aplicar a sugestão não salva o cadastro: ainda é necessário salvar o veículo. O recurso não consulta proprietário, restrição do veículo ou cadastro oficial. A foto usada no OCR não se torna uma foto de avaria da OS.

**Fonte:** [entitySchemas](../src/pages/entitySchemas.tsx), [EntityPage](../src/pages/EntityPage.tsx), [PlateReader](../src/features/ocr/PlateReader.tsx).

## 4. Primeiro atendimento: da agenda para uma única OS

1. Entre em **Agenda** e pressione **Novo agendamento**. Na lista vazia, também pode aparecer **Agendar atendimento**.
2. Selecione **Cliente**, **Veículo** e **Responsável** criados no teste. A seleção do veículo deve corresponder ao cliente.
3. Em **Situação inicial**, escolha **Agendado**. Preencha **Início**, por exemplo amanhã às 10h, no horário de São Paulo, e confira **Fim previsto**, por exemplo 10h30.
4. Em **Adicionar serviço**, escolha `TESTE — Lavagem`, pressione **Adicionar** e mantenha quantidade 1. Confira o valor de R$ 50,00. Registre uma observação identificando o treinamento e use **Salvar agendamento**.
5. Na agenda, use **Abrir atendimento** e confirme em **Criar ordem de serviço**. O agendamento passa a indicar **OS criada**, com **Abrir OS**.
6. Abra essa OS e anote o número. O resultado esperado é uma ordem em **Aguardando**, vinculada ao cliente, veículo, responsável e serviço escolhidos, com total R$ 50,00 e saldo R$ 50,00.

Essa conversão cria o atendimento correspondente. Não crie uma segunda ordem manual para o mesmo agendamento. Se a tela não atualizar após a confirmação, atualize e procure o vínculo antes de repetir a ação.

O sistema verifica conflitos de horário do responsável, incluindo os vínculos de transporte. Se houver conflito, confira a janela e o profissional; não troque para um profissional aleatório só para remover a mensagem. Não há configuração de capacidade de boxes nem reserva pública online nesta versão.

Atendimentos sem agenda podem ser criados em **Ordens de serviço → Nova ordem de serviço**. O editor permite cliente, veículo, responsável, situação inicial, agendamento, entrega prevista, serviços, desconto e observações. **Criar ordem** conclui essa entrada direta. **Editar ordem** aparece apenas em estados iniciais elegíveis e sem recebimento, consumo ativo, crédito de pacote ativo ou fatura que impeça a alteração.

**Fonte:** [AppointmentsPage](../src/pages/AppointmentsPage.tsx), [OrderEditor](../src/pages/OrderEditor.tsx), [OrdersPage](../src/pages/OrdersPage.tsx).

## 5. Checklist, fotos e consumo

### Conferência do veículo

Na OS, abra **Checklist e fotos → Preencher checklist**. Se ainda estiver vazia, a área também oferece **Iniciar conferência**. Confira as áreas apresentadas — frente, traseira, laterais, vidros e espelhos, rodas e pneus, interior e objetos — e selecione **Em ordem**, **Atenção**, **Avaria** ou **Não se aplica**. Acrescente **Observação** quando necessário e use **Salvar conferência**.

Registre apenas áreas efetivamente conferidas; pelo menos uma precisa ter condição selecionada para salvar. No treinamento, identifique as observações como simulação. Salvar o checklist não muda automaticamente a etapa da OS para **Conferência**. Não há desenho do veículo com marcações por coordenadas nem assinatura do cliente.

### Fotos de avarias

Em **Fotos de avarias**, escolha uma imagem PNG ou JPEG de teste. A tela aceita até 10 MB e 16 megapixels por imagem de entrada e até oito fotos por ordem. Preencha **Descrição da avaria ou posição no veículo** e pressione **Adicionar foto à ordem**. **Cancelar foto** descarta a seleção ainda não gravada. Confira a imagem salva usando **Foto 1**, **Foto 2** etc.

O navegador reduz a imagem antes do envio; o registro não preserva necessariamente a resolução do original. A interface atual não oferece um botão para excluir uma foto já adicionada. Ordens entregues ou canceladas não aceitam novas alterações desse fluxo. Não fotografe terceiros, documentos ou placas reais para este exercício.

### Consumo de produto

Abra **Consumo e pacotes → Registrar consumo**. Selecione `TESTE — Insumo`, preencha **Quantidade consumida** com `0,100` e uma **Observação** de teste, depois salve. Como a unidade cadastrada é L, isso representa 0,100 L, não 100 L. O estoque esperado passa de 1 L para 0,900 L.

O consumo é lançado explicitamente; escolher um serviço não baixa automaticamente uma receita de produtos. O sistema não converte L para mL entre cadastros diferentes.

**Devolver ao estoque** pede **Motivo da devolução** e **Confirmar devolução**. A quantidade original volta uma única vez ao estoque. Use a ação quando o lançamento precisar ser revertido e houver correspondência com a situação física. Produto realmente consumido não deve voltar ao saldo apenas para permitir um cancelamento. Para praticar reversão, use uma OS de teste separada antes da entrega.

Em **Estoque**, as ações **Movimentar** e **Histórico** atendem entradas e ajustes. A movimentação pede tipo, quantidade e motivo; diferencie compra, ajuste de entrada e ajuste de saída. Não use um ajuste de estoque para disfarçar erro financeiro.

**Fonte:** [OrderDetailPage](../src/pages/OrderDetailPage.tsx), [OrderPhotos](../src/features/photos/OrderPhotos.tsx), [EntityPage](../src/pages/EntityPage.tsx).

## 6. Etapas, conclusão e cancelamento

Use **Atualizar etapa**, escolha **Próxima etapa** e confirme em **Confirmar etapa**. O seletor oferece as transições válidas para o estado atual.

| Etapa atual | Próximas etapas previstas |
| --- | --- |
| Orçamento | Agendada, Aguardando ou Cancelada. |
| Agendada | Aguardando ou Cancelada. |
| Aguardando | Em execução ou Cancelada. |
| Em execução | Conferência ou Cancelada. |
| Conferência | Em execução, Pronta ou Cancelada. |
| Pronta | Em execução, Entregue ou Cancelada. |
| Entregue / Cancelada | Estados finais; não há reabertura pela interface. |

No roteiro principal, avance **Aguardando → Em execução → Conferência → Pronta**. O retorno a **Em execução** permite corrigir um serviço enquanto a ordem ainda não foi entregue. Preenchimento do checklist, consumo, recebimento e etapa operacional são registros distintos.

Para um cliente comum, **Entregue** exige saldo zero. Um cliente com pós-pago previamente autorizado pode receber o veículo com saldo, que permanece a receber. Habilitar pós-pago apenas para contornar um recebimento não confirmado torna o registro incorreto; a autorização comercial deve existir antes.

Cancelar não estorna recebimentos. O sistema bloqueia o cancelamento quando existem pagamentos, consumo ou resgate de pacote ativos, ou vínculo de fatura incompatível. Em uma OS com movimentações, confira primeiro cada registro e envolva o gestor. Não crie recebimentos negativos, saídas de caixa fictícias ou devoluções de estoque sem fundamento para forçar o cancelamento.

**Fonte:** [transições da interface](../src/lib/domain.ts), [regras de OS](../server/domain-orders.mjs).

## 7. Recebimento parcial e conferência de caixa

Faça esta sequência antes dos exercícios extras de pacote, pós-pago e folha, para manter a conta simples. Na base vazia, o único movimento será o recebimento da OS de R$ 50,00.

1. Com perfil gestor ou administrador, abra **Financeiro e caixa → Abrir caixa**. Informe **Valor inicial em dinheiro** de R$ 100,00 e **Observação** de treinamento. Use **Confirmar abertura**. Esse valor é uma simulação de numerário da base de teste.
2. Volte à OS pronta de R$ 50,00 e abra **Recebimentos → Registrar recebimento**. O campo **Valor recebido** vem com o saldo completo: altere para R$ 20,00. Em **Forma de recebimento**, selecione **Dinheiro**; use **Referência / comprovante** como `TESTE-PARCIAL-001`. Confirme em **Confirmar recebimento**.
3. Confira **Total da ordem: R$ 50,00**, **Recebido: R$ 20,00**, **Coberto por pacote: R$ 0,00** e **Saldo em aberto: R$ 30,00**. O registro deve aparecer na lista de recebimentos.
4. Para verificar a proteção, tente marcar **Entregue** nessa base de treinamento. O cliente sem pós-pago e com R$ 30,00 em aberto não deve ser liberado. Preserve o erro como resultado esperado; não altere o perfil comercial do cliente.
5. Registre o segundo recebimento de R$ 30,00, também em Dinheiro, com referência `TESTE-FINAL-001`. Confira saldo zero e então marque **Entregue**.
6. Use **Imprimir OS / recibo** para revisar a prévia de impressão do navegador. Se escolher salvar em PDF, confira cliente, placa, itens, pagamentos e saldo. É um **documento não fiscal**.
7. Em **Financeiro e caixa**, confira **Caixa atual** e **Recebimentos**. Sem outros movimentos, o dinheiro esperado é R$ 100,00 de abertura + R$ 20,00 + R$ 30,00 = **R$ 150,00**.
8. Use **Fechar caixa**. No diálogo **Conferir e fechar caixa**, preencha **Valor contado em dinheiro** e **Observação da conferência**, depois **Confirmar fechamento**. No exercício isolado, o valor simulado é R$ 150,00. Na operação real, informe a contagem física efetiva, inclusive quando houver diferença.

### O que cada forma de recebimento significa

**Pix**, **Cartão de crédito**, **Cartão de débito** e **Transferência**, no formulário de recebimento, são registros manuais. O clique não cria cobrança, não autoriza cartão e não transfere dinheiro. Antes de registrar uma entrada real, confira a confirmação externa, o valor, o destinatário e se o comprovante já foi registrado em outra OS ou pela integração. Uma referência digitada não é validação bancária automática.

Recebimento em **Dinheiro** exige caixa aberto. Pix, cartão e transferência não aumentam o numerário físico esperado no caixa. **Movimentar caixa** registra **Entrada / suprimento** ou **Saída / retirada**, com **Valor em dinheiro**, **Categoria / motivo** e observação. Essas ações não substituem a baixa de uma OS nem desfazem um pagamento já vinculado a ela.

Existe apenas um caixa aberto por instalação. **Histórico de caixas** permite a conferência dos anteriores. Não há comando de reabertura ou edição do fechamento na tela. Uma diferença precisa ser investigada pelos movimentos e comprovantes, sem ajustar a contagem para fazê-la coincidir artificialmente com o esperado.

**Fonte:** [CashPage](../src/pages/CashPage.tsx), [campos de recebimento](../src/components/FormFields.tsx), [OrderDetailPage](../src/pages/OrderDetailPage.tsx), [regras financeiras](../server/domain-finance.mjs).

## 8. Exercício separado: venda e uso de pacote

Em **Pacotes → Cadastrar pacote**, informe `TESTE — Quatro lavagens`, **Serviço incluído:** `TESTE — Lavagem`, **Créditos por pacote:** 4, **Preço total:** R$ 160,00 e **Validade em dias:** 30. Salve o cadastro ativo.

Na linha do pacote, use **Vender**, selecione o cliente de teste e confira forma e referência do recebimento. **Registrar venda e recebimento** registra a venda e o recebimento integral do pacote; não existe nesse diálogo uma venda sem pagamento ou parcela inicial. Em uso real, confirme o recebimento antes dessa ação. Se escolher dinheiro no treinamento, abra um novo caixa de teste; o primeiro já foi fechado.

Entre em **Pacotes vendidos** para conferir cliente, validade e saldo de quatro créditos. Crie outra OS do mesmo cliente, com uma unidade do serviço de R$ 50,00. Em estado elegível, abra **Consumo e pacotes → Utilizar créditos**, escolha **Pacote do cliente**, informe **Quantidade de créditos:** 1 e salve.

Confira três créditos restantes no pacote e R$ 50,00 em **Coberto por pacote** nessa OS, com saldo zero. O valor unitário do catálogo e o preço comercial do pacote são diferentes no exemplo; o recebimento ocorreu na venda de R$ 160,00. **Não registre novamente R$ 50,00 como dinheiro recebido pelo resgate.**

O resgate exige cliente e serviço correspondentes, validade e saldo. Não é feito em orçamento, ordem final ou ordem faturada. **Reverter crédito → Confirmar reversão**, quando permitido, devolve o crédito e recalcula o saldo da OS; não devolve dinheiro ao comprador. Confira o saldo antes de prosseguir à entrega.

**Fonte:** [EntityPage](../src/pages/EntityPage.tsx), [PackageSalesPage](../src/pages/PackageSalesPage.tsx), [OrderDetailPage](../src/pages/OrderDetailPage.tsx).

## 9. Exercício separado: pós-pago e fatura de controle

Cadastre `TESTE JK — Conveniado`, selecione o tipo comercial adequado ao exercício e marque **Permitir pós-pago e faturamento**. Cadastre um veículo sintético diferente. Crie uma OS de R$ 50,00 e leve-a até **Pronta**, mantendo saldo em aberto. Esse cliente poderá ter entrega a prazo; a OS continua com valor a receber.

Em **Pós-pago → Nova fatura**, escolha **Cliente pós-pago**, **Data de vencimento** e **Observações**. Marque a OS elegível e confira o total antes de **Criar fatura de controle**. A lista reúne somente ordens prontas ou entregues, do mesmo cliente, com saldo e sem outra fatura ativa.

Use **Detalhes** para conferir as ordens agrupadas. Use **Receber** e, somente na base sintética, registre R$ 20,00 e depois R$ 30,00 com a forma escolhida para o exercício. **Confirmar recebimento** distribui o valor pelas OS da fatura. Confira o saldo da fatura e o da OS; não faça outra baixa diretamente na OS faturada.

**Cancelar → Confirmar cancelamento** só é permitido para fatura sem recebimentos. As ordens ficam livres para outra fatura. Uma fatura parcialmente paga exige conferência do gestor; não há botão de estorno do recebimento.

Essa é uma fatura de controle interno. Não emite boleto, nota fiscal, débito automático, juros ou cobrança recorrente. Em **Detalhes → Imprimir fatura**, aguarde o carregamento dos dados da empresa e confira a prévia do navegador: cliente, vencimento, OS vinculadas, total, recebimentos e saldo. O documento é identificado como **não fiscal**. Salvar em PDF depende da opção de impressão do navegador; não existe uma API dedicada para gerar ou enviar esse PDF.

**Fonte:** [InvoicesPage](../src/pages/InvoicesPage.tsx), [regras financeiras](../server/domain-finance.mjs).

## 10. Retirada e entrega do veículo

Em **Retirada e entrega**, a página **Retiradas e devoluções** permite **Novo transporte**. Use um agendamento ou uma OS de teste; não agende deslocamento real neste roteiro.

O formulário pede **Vincular a** — Agendamento ou Ordem de serviço —, **Tipo de transporte** — Retirada do veículo ou Devolução ao cliente — e o atendimento correspondente. Selecione **Responsável pelo transporte**, **Início da janela** e **Fim da janela**. A janela deve respeitar os limites e os conflitos com os demais compromissos do profissional.

Preencha **Logradouro**, **Número**, **Bairro**, **Cidade**, **UF** e os campos adicionais necessários. No teste, identifique o endereço explicitamente como fictício, por exemplo logradouro `Rua de Teste`, número `1`, bairro e cidade `Teste`, e deixe CEP opcional vazio. Não use um endereço pessoal real. **Agendar transporte** grava a tarefa; não envia rota nem aciona um motorista externamente.

Para o exercício, escolha uma janela sem sobreposição com o serviço e um profissional de teste disponível. Abra **Detalhes**, use **Iniciar deslocamento** e depois **Concluir retirada** ou **Concluir devolução**, conforme a tarefa. Na conclusão, informe **Nome de quem recebeu o veículo** como `TESTE Recebedor` e uma observação da simulação.

Uma retirada vinculada a agendamento pode registrar a chegada do cliente. Uma devolução só conclui o fluxo de atendimento nas condições permitidas: serviço pronto ou já entregue e quitação ou pós-pago. Quando aplicável, concluir a devolução também marca a OS como entregue; confira o estado da ordem antes de registrar outra transição.

**Reagendar** permite alterar os dados elegíveis e exige **Salvar reagendamento**. **Cancelar tarefa** e **Registrar tentativa sem sucesso** pedem motivo. Se o vínculo estiver errado, não substitua silenciosamente o cliente ou veículo: cancele justificadamente e crie a tarefa correta. Confira também tarefas ligadas ao agendamento já convertido em OS, evitando cadastrar duas retiradas para o mesmo atendimento.

As situações são **Agendada**, **Em deslocamento**, **Concluída**, **Cancelada** e **Sem sucesso**. Não há mapa, GPS, rastreamento, cálculo de distância, geocodificação ou otimização de rota. Veja as regras e os conflitos em [JK-DELIVERIES.md](JK-DELIVERIES.md).

**Fonte:** [DeliveriesPage](../src/pages/DeliveriesPage.tsx), [regras de transporte](../server/jk-deliveries.mjs).

## 11. Equipe, comissões e folha local

Abra **Equipe e comissões → Folha local → Gerar folha**. Selecione **Período da folha** e informe **Observações**. O rascunho reúne profissionais ativos, salários base e comissões elegíveis; profissionais inativos com comissão elegível também podem aparecer. Uma comissão só entra a partir de uma OS entregue e quitada; o período considera a entrega e a quitação, não apenas o dia de criação da ordem.

No exemplo de uma única OS de R$ 50,00, sem desconto, com comissão de serviço de 10%, a comissão correspondente é R$ 5,00. O total da folha poderá ser maior se outros exercícios tiverem gerado ordens elegíveis, outros profissionais ou salário base. Compare os itens, não apenas o total.

**Profissional para ajuste → Adicionar ajuste** permite informar **Extras** e **Descontos**; **Remover ajuste** retira a linha do rascunho. **Salvar rascunho** grava o preparo. Na lista, **Detalhes** mostra a composição; **Ajustar** edita o rascunho; **Recalcular → Recalcular rascunho** atualiza salários e comissões elegíveis preservando os ajustes.

**Aprovar → Confirmar aprovação** fixa os valores. Depois, **Registrar pagamento → Confirmar pagamento** registra que a empresa pagou; não realiza transferência bancária. Em uso real, faça isso somente após comprovação do pagamento. Dinheiro exige caixa aberto e afeta sua conferência. Para o primeiro treinamento, é suficiente chegar ao rascunho e conferir a composição; teste aprovação e pagamento somente em um exercício financeiro separado e identificado.

Folha local não calcula encargos, férias, impostos, eSocial ou obrigações trabalhistas. Não oferece comissão fixa por serviço nem rateio entre vários responsáveis. A conferência profissional desses valores e obrigações é externa ao módulo.

**Fonte:** [PayrollPage](../src/pages/PayrollPage.tsx), [regras de escritório e folha](../server/domain-office.mjs).

## 12. Relatórios, impressão e interpretação dos valores

Em **Relatórios**, selecione **Relatório**, preencha **De** e **Até** quando aplicável e use **Aplicar filtros**. Há seis visões:

| Relatório | Conferência principal |
| --- | --- |
| Resumo da operação | Indicadores agregados e respectivas bases de cálculo. |
| Recebimentos | Entradas registradas, data e forma de recebimento. |
| Serviços entregues | Serviços efetivamente entregues no recorte. |
| Desempenho da equipe | Produção e valores atribuídos aos profissionais. |
| Posição de estoque | Saldo atual dos produtos. |
| Movimentos de caixa | Entradas e saídas do caixa no recorte. |

Data de recebimento, data de entrega e posição atual representam coisas diferentes. Um serviço entregue neste mês e recebido depois não deve ser forçado a coincidir em todos os relatórios. Estoque e saldos atuais não se transformam em um saldo histórico apenas por escolher uma data de início.

**Imprimir página** e **Exportar página CSV** trabalham com **a página atual da listagem**, não com todas as páginas automaticamente. Ao conferir um período grande, avance na paginação e identifique cada arquivo; não apresente um CSV de uma página como uma exportação completa. Os campos monetários do CSV são expressos em centavos e quantidades de estoque em milésimos, conforme o aviso da interface. Uma planilha deve aplicar a conversão explicitamente, sem alterar o arquivo original.

A impressão de OS/recibo, fatura e relatório usa o navegador. Teste papel, escala e impressora reais antes de oferecer recibos no balcão. Salvar a impressão em PDF não autoriza documento fiscal e não envia o arquivo por e-mail ou WhatsApp.

**Fonte:** [ReportsPage](../src/pages/ReportsPage.tsx), [regras dos relatórios](../server/domain-reports.mjs), [OrderDetailPage](../src/pages/OrderDetailPage.tsx).

## 13. Mensagens, Pix e fiscal: reconhecer cada estágio

**Neste treinamento, não pressione comandos de envio a provedores nem de consulta bancária remota. Não há autorização para mensagens, cobranças ou emissão reais.** É possível conhecer os campos e os bloqueios sem usar um telefone real, um documento fiscal fictício ou credenciais de produção.

### Mensagens locais

Em **Mensagens → Criar mensagem**, selecione cliente, **Modelo de mensagem** e texto e use **Salvar rascunho**. Existem texto personalizado, confirmação de agendamento e pós-atendimento. **Ver texto**, **Editar**, **Copiar texto**, **Preparar na fila** e **Cancelar** tratam registros locais. Colocar na fila não comprova envio ao WhatsApp. Para o teste, mantenha o texto identificado como simulação e não o encaminhe a outra pessoa.

### Integrações por atendimento

**Integrações → Verificar configurações** lê a prontidão informada pelo servidor. Estar configurado não comprova que o provedor aceitou as credenciais ou que a homologação foi concluída. Os dados de configuração são apresentados para consulta; senhas, tokens, certificados e chaves bancárias não são preenchidos pelo operador nessa tela. A aba **Integrações** da OS mostra registros associados ao atendimento.

| Ação disponível conforme situação | O que representa |
| --- | --- |
| **Preparar cobrança** | Cria preparo local de Pix com o saldo atual da OS e **Validade da cobrança, em minutos**. **Salvar preparação** não significa cobrança enviada ou paga. |
| **Preparar mensagem** | Pede **Nome do modelo aprovado no WhatsApp**, **Código do idioma**, **Parâmetros do corpo, um por linha** e confirmação de autorização do cliente. O telefone vem do cadastro vinculado. Não marque consentimento que não existe. |
| **Enviar → Confirmar envio ao provedor** | Ação explícita de comunicação externa, disponível conforme prontidão e situação. Deve conferir ambiente, destinatário e dados antes de qualquer uso real autorizado. |
| **Conciliar → Consultar e conciliar** | Consulta o banco. A baixa depende de comprovação autenticada, correspondência da cobrança, ambiente de produção e saldo atual. O diálogo pode permitir intervalo de consulta. |
| **Cancelar preparação** | Cancela apenas preparo local cujo envio ainda não começou. Não cancela cobrança bancária enviada nem desfaz mensagem. |
| **Detalhes** | Mostra situação, referência do provedor, código para conferência e, quando retornado pelo banco, **Pix Copia e Cola fornecido pelo banco**. |

Pix preparado ou ativo não equivale a recebido. Um retorno de homologação não quita uma operação real. Mensagem aceita pelo provedor não significa entregue ao cliente. Não há worker de envio, conciliação automática em segundo plano ou webhook de confirmação nesta versão.

Depois de ativar ou trocar provedor, conta ou ambiente, o gestor deve conferir se uma preparação anterior ainda corresponde à configuração. Quando a preparação nunca foi enviada e ficou incompatível, cancele-a e prepare novamente sob a configuração atual. Para qualquer registro cujo envio já tenha começado, preserve a referência e investigue o resultado antes de criar outro.

Se aparecer resultado desconhecido ou necessidade de revisão, **não faça outro envio nem registre um pagamento manual para eliminar o aviso**. Preserve a referência, atualize a situação local e peça ao gestor a conferência no provedor. Ele deve estabelecer o que aconteceu e evitar dupla cobrança ou dupla baixa antes de decidir a próxima ação.

### DPS / NFS-e

Na área **DPS / NFS-e**, **Preparar rascunho** permite selecionar a OS por **Buscar ordem**, **Buscar** e **Selecionar OS**. O formulário contém identificação e endereço do tomador e campos fiscais definidos pela configuração do servidor. A revisão inclui tratamento do desconto, justificativa e a confirmação de que salvar o rascunho não emite NFS-e.

**Salvar rascunho sem emitir** mantém um documento local. **Conferir rascunho**, **Atualizar estado**, **Enviar ao provedor** e **Consultar provedor** têm finalidades diferentes. O envio exige confirmação específica; **Cancelar rascunho** não cancela uma nota já autorizada. A integração legada FocusNFe depende de configuração e homologação adequadas ao emitente.

No primeiro teste, consulte os bloqueios e reconheça os campos. Não invente CPF/CNPJ, inscrição, classificação tributária ou alíquota para liberar a tela, e não execute envio. O responsável fiscal deve fornecer e conferir esses dados em um teste autorizado próprio. Recibo da OS e fatura interna não substituem NFS-e.

**Fonte:** [MessagesPage](../src/pages/MessagesPage.tsx), [IntegrationsPage](../src/pages/IntegrationsPage.tsx), [IntegrationDialog](../src/features/integrations/IntegrationDialog.tsx), [contrato de integração](../integrations/jk/README.md), [FiscalPage](../src/pages/FiscalPage.tsx).

## 14. Migração: prévia e confirmação com dados sintéticos

Somente administrador acessa **Migração de dados**. O importador atual funciona com SQLite local; não está habilitado para PostgreSQL. Ele recebe **três cadastros operacionais** — clientes, veículos e serviços — e **três coleções históricas separadas** — OS, itens de OS e recebimentos antigos. Não são seis cadastros mestres.

Histórico importado não cria pagamentos atuais, contas a receber operacionais, estoque, comissões, folha, faturas, mensagens ou documentos fiscais. Não há importação de credenciais, usuários ou fotos. Nenhum dado real foi migrado como consequência da criação deste manual. A prévia verifica o material fornecido, sem comprovar que a exportação de origem está completa.

### Exercício mínimo de um serviço

Na máquina de treinamento, crie um arquivo de texto UTF-8 chamado `servicos-teste.csv` com este conteúdo. Os valores aqui seguem o contrato do arquivo: `1000` centavos significa R$ 10,00.

```csv
sourceId;name;priceCents;durationMinutes
teste-manual-servico-001;TESTE Importacao;1000;15
```

1. Em **Importar arquivos**, use **Escolher arquivos** e selecione esse CSV.
2. Confira **Tipo de registro: Serviços**. Não confie apenas na inferência pelo nome do arquivo.
3. Use **Analisar e gerar prévia**. Em uma base sem esse ID de origem, espere um recebido, um a importar, nenhum já importado e nenhuma pendência para serviços. A prévia não deve criar o serviço.
4. Leia avisos e totais. Marque **Revisei a prévia e confirmo a importação destes registros para a operação JK.** apenas depois da conferência.
5. Pressione **Confirmar importação**. O aplicativo envia a confirmação vinculada à prévia revisada. Confira o identificador do lote e o serviço em **Serviços**.
6. Reabra o fluxo e analise exatamente o mesmo arquivo. O lote repetido deve ser reconhecido sem duplicação, com zero novos registros e o registro já importado. Não altere o `sourceId` para forçar uma segunda cópia.

O limite é de 8 MiB por envio, até seis arquivos e 20.000 registros por lote. JSON completo, CSV e tabela HTML são aceitos. Uma extensão `.xls` só funciona quando o conteúdo for texto CSV/HTML compatível; planilha binária XLS e XLSX não são interpretadas.

Se o arquivo ou os registros relevantes mudarem, gere outra prévia. Rejeições não permitem importação parcial. Em dados reais, IDs, vínculos, totais e recortes precisam ser reconciliados antes da confirmação. Não divida arbitrariamente exportações nativas sem IDs; consulte o [contrato de migração](migration-jk.md) para lotes e reconciliação de snapshots.

**Consultar histórico**, **Tipo de histórico**, **Atualizar consulta** e a paginação permitem examinar OS, itens, recebimentos e evidências de origem que tenham sido importados. O saldo desse histórico não é uma nova cobrança em aberto. Preserve os arquivos reais e seus resultados em armazenamento privado; não publique exportações em repositório, chamado ou imagem compartilhada.

**Fonte:** [MigrationPage](../src/pages/MigrationPage.tsx), [migration-jk.md](migration-jk.md).

## 15. Limites que exigem conferência ou trabalho adicional

| Situação | Procedimento correto nesta versão |
| --- | --- |
| Recebimento incorreto ou pedido de reembolso | Interrompa novas baixas e encaminhe número da OS, valor, forma e referência ao gestor. Não existe estorno de recebimento pela interface; saída de caixa, cancelamento de OS e reversão de pacote não equivalem a reembolso. A solução precisa manter coerência com o pagamento externo e o registro contábil. |
| Cartão com taxa ou parcelamento | Registre somente o recebimento efetivamente confirmado conforme a política da empresa. O módulo não calcula taxa da adquirente, agenda de parcelas, antecipação ou líquido a receber. Concilie esses valores externamente; não use desconto na OS para ocultar taxa. |
| SmartPOS / TEF | Não há integração com terminal. A opção Cartão de crédito/débito é um método de lançamento manual, sem autorização pelo aplicativo. |
| Pix com timeout, estado desconhecido ou revisão | Preserve a referência e peça conferência no provedor. Não repita a cobrança nem dê baixa manual sem estabelecer se já houve pagamento e registro. |
| Impressora ou PDF | Teste o dispositivo e a prévia do navegador. Há impressão de OS/recibo, de fatura e de página de relatório; não há geração e envio automáticos de PDF. |
| Mapa ou rastreamento de transporte | Use endereço e janela registrados; esta versão não calcula trajeto, localização ou tempo de deslocamento. |
| Perda de conexão | Não presuma que a gravação funcionou. Ao restabelecer a conexão, atualize e confira o registro antes de repetir. Não há sincronização offline. |
| Várias unidades, venda de mercadoria ou comissão dividida | Não adapte um campo de observação como se implementasse esses módulos. São lacunas descritas na matriz. |

Veja a [FEATURE-MATRIX.md](FEATURE-MATRIX.md) para os limites completos e a distinção entre uma configuração pendente e uma funcionalidade que ainda precisa ser desenvolvida.

## 16. Backup, restauração e contato com o administrador

Não há botão de backup ou restauração na interface de atendimento. O administrador técnico deve identificar o banco correto, preservar os arquivos de evidência e validar a recuperação em uma instalação isolada. Cópias da base e imagens de clientes contêm informações privadas e não pertencem ao repositório público.

Para SQLite, existem comandos locais no projeto. Os caminhos abaixo são **exemplos que o administrador deve substituir**; não são ordens para executar em um servidor real durante o treinamento:

```sh
node scripts/backup.mjs --db /privado/operacao.sqlite --out /privado/backups/jk-teste.sqlite
node scripts/restore.mjs --from /privado/backups/jk-teste.sqlite --to /privado/recuperacao/jk-validacao.sqlite
```

A restauração exige destino novo; não sobrescreve o banco ativo. Preserve o snapshot e os arquivos de verificação associados. Antes de mudar a aplicação para uma cópia restaurada, o administrador deve conferir integridade, acesso, registros e recebimentos no ambiente separado e planejar a parada e a troca de banco. Os comandos SQLite não substituem o procedimento de backup de PostgreSQL. O detalhamento está em [operations-jk.md](operations-jk.md), [backup.mjs](../scripts/backup.mjs) e [restore.mjs](../scripts/restore.mjs).

Ao pedir ajuda, informe a tela, o número da OS/fatura/tarefa, a ação tentada, o horário, o valor envolvido quando relevante e o texto ou código do erro. Confirme se o problema ocorreu em treinamento ou produção. O administrador pode usar **Atualizar**, os detalhes do registro e **Auditoria** para localizar o evento. Não envie senha, token, certificado, arquivo integral do banco ou foto pessoal em um chamado público.

## 17. Conferência de encerramento do treinamento

O exercício principal está coerente quando existe uma única OS criada do agendamento, checklist identificado como teste, consumo de 0,100 L, recebimentos de R$ 20,00 e R$ 30,00, saldo zero e etapa **Entregue**. O estoque do produto deve estar em 0,900 L se não houve outros movimentos. O caixa inicial de R$ 100,00 deve fechar com R$ 150,00 somente se nenhuma entrada ou saída adicional tiver ocorrido.

Confira os exercícios extras separadamente: pacote com créditos e recebimento de venda próprios; fatura com recebimentos distribuídos; transporte com vínculo correto; folha com comissões elegíveis; migração com lote identificado e sem duplicação. Não some o valor de créditos resgatados como se fosse um novo recebimento em dinheiro.

Registre divergências e peça revisão antes de liberar a base real. O administrador deve manter o treinamento isolado e decidir sua retenção ou descarte; desativar cadastros não apaga os movimentos já feitos. Ao terminar, saia da conta. A utilização real começa apenas após definição do endereço operacional, acessos, dados autorizados, backup, procedimentos de conferência e integrações efetivamente homologadas.
