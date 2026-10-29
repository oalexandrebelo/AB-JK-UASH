# Agenda de retiradas e devoluções — AB-JK-UASH

Implementação local de 28/10/2026, sobre o núcleo 0.2.1. O módulo cobre o transporte operacional vinculado à agenda/OS, parte de **M05** na matriz `audit/jumpcar-public-features.md`. Não declara paridade completa com o Jump Car.

## Comportamento entregue

- Cria uma tarefa de **retirada** (`pickup`) ou **devolução** (`return`) a partir de um agendamento ou OS existente. Cliente e veículo vêm dessa fonte; não são digitados novamente.
- Reserva uma janela de até 24 horas para um colaborador ativo, com início e fim explícitos. Datas na API têm fuso explícito e são normalizadas em UTC; a interface usa horário de São Paulo, como a agenda do host.
- Preserva logradouro, número, bairro, cidade, UF, CEP opcional, complemento e referência. Não faz requisição de geocodificação, localização ou GPS.
- Permite reagendar, trocar responsável e corrigir endereço antes da saída. Cada alteração conserva um snapshot no histórico, com autor, horário e versão.
- Rejeita sobreposição com transporte, agendamento e OS do responsável. A agenda/OS também rejeita reservas criadas depois sobre uma tarefa de transporte. Janelas adjacentes são aceitas. Um responsável não pode iniciar outra tarefa enquanto estiver em deslocamento, mesmo que a janela anterior tenha vencido.
- Mantém a identidade do transporte quando a agenda vira OS. Criar uma tarefa pela OS convertida resolve o mesmo agendamento e não duplica uma perna já existente.
- Ao concluir a retirada, registra quem recebeu o veículo e marca um agendamento ainda não convertido como `arrived`; uma OS `scheduled` passa a `waiting`. A conversão de agenda para OS continua sendo a operação explícita existente.
- Ao iniciar/concluir devolução, exige OS `ready` ou `delivered` e saldo zero ou cliente pós-pago. Ao concluir uma OS `ready`, marca `delivered` na mesma transação da tarefa, preservando o saldo de pós-pago e sem inventar um pagamento.
- Cancelamento e tentativa sem sucesso exigem motivo. Registros encerrados são imutáveis. Uma tentativa posterior pode ser criada conservando a anterior.

## Papéis, estados e efeitos

Leitura e escrita: `admin`, `manager`, `operator`. `viewer` não pode listar nem inspecionar transportes; a interface também impede acesso. Todas as escritas usam a sessão e o CSRF do host. `mutate` revalida papel/sessão dentro da transação inclusive para replay idempotente.

| Estado API | Rótulo da interface | Próximos estados | Efeito operacional |
|---|---|---|---|
| `scheduled` | Agendada | `en_route`, `cancelled` | Reserva horário; permite reagendamento. |
| `en_route` | Em deslocamento | `completed`, `failed` | Registra saída e impede outro deslocamento simultâneo do responsável. |
| `completed` | Concluída | Nenhum | Registra recebedor/hora; sincroniza chegada/entrega conforme a fonte. |
| `cancelled` | Cancelada | Nenhum | Exige motivo, libera janela e permite nova tentativa. |
| `failed` | Sem sucesso | Nenhum | Exige motivo, libera janela e permite nova tentativa. |

O sistema verifica novamente estado, identidade do cliente/veículo e pagamento no momento da execução. Se a fonte mudou de cliente/veículo, o transporte mantém o vínculo original para auditoria e bloqueia avanço. Pode ser cancelado com motivo; uma tarefa nova utiliza os dados atuais.

## Integração com o host

Arquivos principais:

- `server/jk-deliveries-schema.mjs`: migração aditiva SQLite, export `initializeJkDeliveries(raw)`; também exporta DDL PostgreSQL.
- `server/jk-deliveries.mjs`: `handleJkDeliveries(ctx)`, `deliveryView` e `checkJkDeliveryAvailability`.
- `server/domain-orders.mjs`: `checkAvailability` chama o guard de transporte para manter a validação simétrica.
- `src/pages/DeliveriesPage.tsx`: interface com componentes Spectrum 2, busca de fontes reais, formulário, filtros, detalhe/histórico e ações persistentes.
- `tests/jk-deliveries.test.mjs`: casos HTTP com o `createApplication` real e banco temporário.

O host chama `initializeJkDeliveries` depois do schema de domínio e registra `handleJkDeliveries` depois da verificação de CSRF. A rota frontend é `deliveries`, com `DeliveriesPage({user})`. Os controles usam `useMutation`, preservando a mesma chave em uma tentativa de payload idêntico após falha de rede.

### Rotas

| Método/caminho | Entrada | Retorno |
|---|---|---|
| `GET /api/jk/deliveries` | Filtros opcionais `q`, `status`, `kind`, `employeeId`, `appointmentId`, `orderId`, `from`, `to`, `limit`, `offset`. `from` inclusivo e `to` exclusivo, ISO com fuso. | `data.items` e `data.page`. |
| `GET /api/jk/deliveries/:id` | Identificador da tarefa. | `data.item`, incluindo histórico e versões atuais da fonte/OS. |
| `POST /api/jk/deliveries` | Exatamente um `appointmentId` ou `orderId`; `sourceVersion`, `kind`, `employeeId`, `startsAt`, `endsAt`, `address`, `notes` opcional. | HTTP 201, `data.item`. |
| `PATCH /api/jk/deliveries/:id` | `version` e pelo menos um campo dentre responsável, janela, endereço completo e observações. | Tarefa atualizada. Somente `scheduled`. |
| `POST /api/jk/deliveries/:id/status` | `version`, `status`; `reason` para cancelamento/falha; `receivedBy` e `sourceVersion` para concluir; `orderVersion` para conclusão que entrega ou avança a OS. | Tarefa e fonte atualizadas atomicamente. |

Toda escrita exige `Idempotency-Key` e `X-CSRF-Token`. A reutilização da chave com payload diferente retorna 409. Versões desatualizadas retornam 409 sem efeito parcial. Replays autorizados retornam a resposta original e `Idempotency-Replayed: true`.

`sourceVersion` na criação é a versão do registro escolhido. Após canonicalizar uma OS convertida para seu agendamento, o retorno fornece `sourceVersion` do agendamento e `orderVersion` da OS; essas versões devem ser lidas novamente no detalhe antes de concluir. Os campos de retorno `linkedOrderId`, `orderStatus`, `sourceStatus` e `sourceChanged` deixam esse vínculo explícito.

### PostgreSQL

`integrations/jk/deliveries.postgres.sql` fornece o DDL aditivo correspondente, sem `STRICT`. Aplicar após a migração de domínio, com o schema privado da aplicação em `search_path`, usando o procedimento administrativo existente. Conceder `SELECT, INSERT, UPDATE, DELETE` à role da aplicação nessas duas tabelas, mantê-las fora dos schemas públicos e aplicar a mesma política RLS privada do host. O runtime não deve receber permissão de criação de tabelas. O arquivo não é aplicado automaticamente pelo boot PostgreSQL.

A validação executada nesta frente usa SQLite; a presença do DDL não comprova implantação ou execução PostgreSQL. A instalação PostgreSQL precisa ser provisionada antes de ativar este código, inclusive porque o guard simétrico da agenda consulta `jk_deliveries`.

## Evidência executável

Comandos locais, sem APIs externas, mensagens ou pagamentos reais:

```sh
node --test --test-reporter=spec tests/jk-deliveries.test.mjs
node --test --test-reporter=spec tests/domain.test.mjs
npm run typecheck
```

Resultado em 28/10/2026: **9/9** testes de delivery e **10/10** testes de domínio aprovados, sem skips; TypeScript aprovado. Os HTTP tests abriram somente portas locais de loopback e usaram dados sintéticos em SQLite temporário.

O conjunto de delivery exercita persistência/reinício, replay, CSRF, papéis incluindo revogação, endereço e intervalo inválidos, responsável inativo, concorrência entre duas conexões, conflito em ambas as direções, conversão agenda→OS sem duplicar tarefa, recebimento pendente, versão da fonte alterada, pós-pago mantendo recebível, impossibilidade de dirigir duas tarefas simultâneas e cancelamento/falha com histórico. O conjunto de domínio cobre regressão de OS, agenda, estoque, caixa, faturas, pacotes, folha interna e mensagens locais. TypeScript valida a integração tipada da tela; isso não equivale a QA visual ou homologação em equipamento JK.

## Limites e lacunas restantes da matriz

| Matriz / tema | Evidência no código | Lacuna remanescente |
|---|---|---|
| **M05 — mapa/delivery** | `jk-deliveries.mjs`: `addressInput`, `editableValues`, `changeStatus`; `DeliveriesPage.tsx`: endereço estruturado e operações reais. | Não há mapa, abertura de localização validada, geocodificação, rastreamento, roteirização, reserva por cliente nem capacidade por box. O critério público de mapa continua pendente. O módulo usa um responsável por tarefa. |
| **M05 — sincronização de agenda** | A fonte é consultada a cada execução; a janela é própria da tarefa, e `sourceVersion` protege a conclusão. | Reagendar o serviço não desloca automaticamente a janela de transporte. O operador deve reagendar a tarefa explicitamente. Cancelar a fonte não encerra automaticamente uma tarefa já aberta; o avanço fica bloqueado e o operador registra o motivo. |
| **Estorno financeiro / M09, M13, T04** | `domain-finance.mjs`: `paymentRoutes` expõe somente consulta de pagamentos; `invoiceRoutes` impede cancelar fatura recebida. `domain-orders.mjs` impede cancelar OS com recebimentos. `domain-schema.mjs`: `payments.amount_cents > 0`, sem vínculo de reversão financeira. | Não há fluxo completo de reembolso/estorno de pagamento, retorno de adquirente, recomposição de saldo e conciliação. A reversão de crédito de pacote em `packageRoutes` e a reversão de insumo em `orderRoutes` já existem, mas não equivalem a devolver dinheiro. `integrations/jk/README.md` também limita estorno Pix automático. |
| **Parcelamento / M09, T04** | `invoiceRoutes` aceita recebimentos parciais e aloca-os às OS; `invoices` tem um `due_date`. `paymentFields` recebe valor, método e referência. | Recebimento parcial não implementa plano de parcelas: faltam quantidade, calendário/vencimentos, valor por parcela, status por recebível, juros e reconciliação de parcelas de cartão. |
| **SmartPOS / T05** | `integrations/jk/runtime.mjs` configura canais Pix e WhatsApp; o fiscal é tratado separadamente. `domain-core.mjs:receive` grava pagamento local. Selecionar `credit`/`debit` não inicia uma transação em terminal. | Não há SDK/adaptador nem homologação Moderninha, Rede, Cielo Lio, Getnet, Stone, Gertec ou Sunmi; não estão comprovados autorização, recusa, cancelamento e recuperação de rede em equipamento JK. |
| **Taxas de cartão / T04** | `payments` e `cash_movements` guardam um `amount_cents`; `receive` registra entrada desse valor. `paymentFields` não solicita taxa, adquirente, valor líquido ou prazo de liquidação. | Não há cálculo/versionamento de taxa, separação bruto/taxa/líquido, despesa automática de cartão, agenda de liquidação ou conciliação de recebíveis com adquirente. |
| **Isolamento por unidade / T08** | O módulo usa a sessão/papel e o banco privado do host; o schema local de domínio não tem `tenant_id`/`unit_id`. | A autorização implementada é por papel na instalação. Não se deve declarar isolamento multiunidade dentro da mesma instalação com base neste módulo. |

Esta frente não altera saldo por mero clique de entrega, não configura canais externos, não consulta GPS e não envia mensagens automáticas. A homologação operacional JK e a cobertura financeira restante continuam explícitas.
