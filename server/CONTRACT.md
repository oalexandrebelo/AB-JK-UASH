# AB-UASH — contrato local da API

Implementação local para lava-rápido/estética automotiva. Este contrato não afirma equivalência com telas autenticadas do Jumpcar: o acesso observado estava bloqueado por CAPTCHA. Pagamentos são registros locais; mensagens permanecem em fila local; recibos são NÃO FISCAIS.

## Convenções estáveis

- Base `/api`, mesma origem do frontend, backend `127.0.0.1:4173`.
- Sucesso `{ok:true,data:{...}}`; falha `{ok:false,error:{code,message,details?,requestId}}`.
- Listas: `data.items`; entidade única e mutações: `data.item`. Auth conserva `data.user`, `data.csrfToken` e `data.setupRequired` conforme núcleo já entregue.
- IDs UUID em texto, instantes ISO 8601 UTC, datas `YYYY-MM-DD`. Valores monetários inteiros em **centavos**, taxas em **basis points** (10000 = 100%), estoque em **milésimos de unidade** (1000 = 1 unidade).
- Entidades têm `id`, `version` (inicia em 1), `createdAt`, `updatedAt`. PATCH e ações em entidades existentes exigem `version`; conflito retorna 409 `VERSION_CONFLICT`.
- Todos os POST de domínio e ações financeiras exigem `Idempotency-Key` com UUID ou texto de 8–128 caracteres. O frontend pode gerar `crypto.randomUUID()` por intenção e reutilizar a chave somente ao repetir essa mesma requisição. PATCH exige versão e também aceita/exige a mesma chave.
- Mutações autenticadas exigem `Content-Type: application/json` e `X-CSRF-Token`. GET permite todos os papéis autenticados, salvo dados financeiros/folha/auditoria e usuários conforme abaixo.
- Cadastros são desativados (`active:false`) em vez de excluídos. Estoque inicial é informado no POST; ajustes posteriores usam movimentos.
- Parâmetros genéricos GET list: `q` (busca textual nos módulos com campos de busca), `limit` (1–500, padrão 200), `offset` (inteiro ≥ 0). Resposta inclui `page:{limit,offset,total,hasMore}`; continue buscando enquanto `hasMore`. Ordens/agendamentos/faturas/mensagens também aceitam `status`, quando aplicável. Listas pequenas internas a uma entidade (serviços da OS, fotos limitadas a 8) são retornadas completas.

## Auth e papéis

`GET /status`, `GET /auth/session`, `POST /setup {name,email,password}`, `POST /auth/login {email,password}`, `POST /auth/logout {}`, `POST /auth/password {currentPassword,newPassword}`. Senha inicial 12–128 caracteres.

Papéis: `admin`, `manager`, `operator`, `viewer`. Admin gerencia usuários. Admin/manager gerenciam serviços, empregados, produtos, preços/pacotes, caixa manual, faturas, folha, configurações e relatórios financeiros. Operator também cadastra clientes/veículos, cria e movimenta OS, agenda, consome estoque e registra recebimentos. Viewer consulta operação, sem mutações. Folha, auditoria e dados de usuários são restritos.

## Cadastros

Para cada coleção: `GET /coleção`, `GET /coleção/:id`, `POST /coleção`, `PATCH /coleção/:id`.

Cadastros aceitam `active=true|false`. Clientes aceitam também `postpaid=true|false`, aplicado antes da contagem e da paginação; o seletor de faturas usa esse filtro. Veículos aceitam `customerId`.

| Coleção | Campos POST; PATCH aceita os mesmos campos + version, salvo indicado |
| --- | --- |
| `customers` | `name` obrigatório; `phone=""`, `email=""`, `kind="individual"` (`individual\|company`), `postpaid=false`, `notes=""`, `active=true` |
| `vehicles` | `customerId`, `plate`, `model`; `color=""`, `category="small"` (`small\|medium\|large\|motorcycle`), `active=true`. Placa normalizada para maiúsculas sem espaço/hífen, única. |
| `services` | `name`, `priceCents`; `durationMinutes=30`, `commissionBps=0`, `active=true` |
| `employees` | `name`; `roleLabel=""`, `baseSalaryCents=0`, `commissionBps=0`, `active=true` |
| `products` | `name`, `sku`; `unit="un"`, `quantityMilli=0`, `minQuantityMilli=0`, `costCents=0`, `active=true`. `quantityMilli` só POST; PATCH não altera saldo. SKU único. |
| `packages` | `name`, `serviceId`, `credits`, `priceCents`; `validDays=365`, `active=true` |

Cadastros retornam seus campos em camelCase. Campos relacionados incluem o ID original; não é obrigatório enviar nomes relacionados.

## Ordens de serviço

`GET /orders`, `GET /orders/:id`, `POST /orders`, `PATCH /orders/:id`.

POST: `{customerId,vehicleId,employeeId:null|id,items:[{serviceId,quantity}],discountCents:0,status:"waiting",scheduledAt:null,promisedAt:null,notes:""}`. `status` inicial permitido: `quote`, `scheduled`, `waiting`. Cliente e veículo precisam corresponder. Quantidade inteira 1–1000; mínimo um item, serviço não repetido.

PATCH: `{version,...camposDoPOST}` apenas enquanto `quote|scheduled|waiting`, sem pagamentos/créditos/fatura/consumos. Preços, durações e comissões são capturados novamente quando `items` for fornecido. Alterar somente o responsável preserva os snapshots anteriores, inclusive comissão; não recalcula automaticamente a taxa de um atendimento já negociado. Um resgate ativo bloqueia reescrita/cancelamento mesmo quando cobre zero centavos.

Retorno inclui `number` sequencial, `subtotalCents`, `discountCents`, `totalCents`, `paidCents`, `creditCents`, `balanceCents`, `invoiceId`, `deliveredAt`, `settledAt`, `customerName`, `vehiclePlate`, `employeeName` e:

- `items:[{id,serviceId,name,quantity,unitPriceCents,durationMinutes,commissionBps,lineTotalCents,discountCents,netCents,commissionCents}]`: snapshots locais. Comissão usa a taxa do serviço quando maior que zero; caso contrário, taxa padrão do empregado. Desconto é distribuído proporcionalmente em centavos sem perda de soma.
- `payments:[{id,amountCents,method,reference,createdAt}]` e `checklist:[{zone,condition,notes}]`.
- `consumptions` e `packageRedemptions` com identificadores e reversões locais.

### Ações

| Rota POST | Corpo | Regra |
| --- | --- | --- |
| `/orders/:id/transition` | `{version,status}` | Transições abaixo; cancelar exige ausência de recebimentos/créditos/consumos ativos/fatura. |
| `/orders/:id/payments` | `{version,amountCents,method,reference?}` | Valor positivo até saldo. `method`: `cash\|pix\|credit\|debit\|transfer`. Dinheiro exige caixa aberto. OS faturada recebe pela fatura. |
| `/orders/:id/checklist` | `{version,items:[{zone,condition,notes?}]}` | `condition`: `ok\|attention\|damage\|not_applicable`. Substitui checklist local, sem anexos neste módulo. |
| `/orders/:id/consumptions` | `{version,productId,quantityMilli,notes?}` | Deduz estoque; nunca negativo. |
| `/orders/:id/consumptions/:movementId/reverse` | `{version,notes?}` | Devolve exatamente o consumo original uma única vez. |
| `/orders/:id/package-redemptions` | `{version,packageSaleId,quantity}` | Créditos do mesmo cliente/serviço, dentro da validade, saldo e linhas da OS. |
| `/orders/:id/package-redemptions/:redemptionId/reverse` | `{version}` | Reverte antes da entrega e sem fatura. |

Transições: `quote→scheduled|waiting|cancelled`; `scheduled→waiting|cancelled`; `waiting→in_progress|cancelled`; `in_progress→quality_check|cancelled`; `quality_check→in_progress|ready|cancelled`; `ready→in_progress|delivered|cancelled`. `delivered` e `cancelled` encerram o fluxo. Entrega sem quitação é permitida somente para cliente pós-pago. OS finalizada não aceita edição/consumo/checklist; pagamento de pós-pago ainda pode ocorrer.

## Agendamentos

`GET /appointments`, `GET /appointments/:id`, `POST /appointments`, `PATCH /appointments/:id`.

Corpo: `{customerId,vehicleId,employeeId:null|id,items:[{serviceId,quantity}],startsAt,endsAt?,notes:"",status:"scheduled"}`. Fim omitido é derivado da duração dos serviços. PATCH exige `version`. Status editáveis: `scheduled`, `confirmed`, `arrived`, `cancelled`; `converted` só pela ação. Conflito de horário de empregado em agendamentos ou OS programadas retorna 409. Intervalos adjacentes são permitidos.

`POST /appointments/:id/convert {version}` cria uma única OS `waiting`, marca agendamento `converted` e retorna `data.item` da **OS**. O agendamento passa a incluir `orderId`.

## Estoque

`GET /products/:id/movements` → `items`.

`POST /products/:id/movements {version,type,quantityMilli,notes?}`; `type="purchase"|"adjustment_in"|"adjustment_out"`. Quantidade sempre positiva; saída limitada ao saldo. Retorna produto atualizado. Consumo de OS é feito pela rota de ordens, não por ajuste genérico. Produto inclui `lowStock` derivado de quantidade ≤ mínimo.

## Caixa e recebimentos

`GET /cash` lista sessões; `GET /cash/current` retorna `item:null` ou sessão aberta; `GET /cash/:id` retorna sessão com movimentos.

- `POST /cash/open {openingCents,notes?}` → sessão; apenas um caixa aberto.
- `POST /cash/:id/movements {version,type:"in"|"out",amountCents,category,notes?}` → sessão; ajuste manual, admin/manager.
- `POST /cash/:id/close {version,countedCents,notes?}` → sessão fechada.

Sessão: `status:"open"|"closed"`, `openingCents`, `expectedCents`, `countedCents`, `differenceCents`, `openedAt`, `closedAt`, `movements`. Esperado = abertura + movimentos em dinheiro; métodos digitais são registrados e não aumentam dinheiro físico. Pagamentos em dinheiro, venda de pacote e pagamento de folha em dinheiro geram movimento vinculado atomicamente.

`GET /payments` lista recebimentos e origem (`order|invoice|package`), para conferência. Não processa adquirente, Pix ou banco. Reembolso bancário e estorno de recebimentos não são implementados; não há cancelamento silencioso de valor recebido.

## Pós-pago e faturas

`GET /invoices`, `GET /invoices/:id`.

- `POST /invoices {customerId,orderIds:[id],dueDate,notes?}` agrupa saldos de OS `ready|delivered` do mesmo cliente pós-pago. Uma OS não pode pertencer a duas faturas ativas.
- `POST /invoices/:id/payments {version,amountCents,method,reference?}` baixa e distribui valor por OS na mesma transação; rejeita excedente.
- `POST /invoices/:id/cancel {version}` somente sem recebimentos, liberando vínculo das OS.

Campos: `number`, `customerId`, `customerName`, `status:"issued"|"partial"|"paid"|"cancelled"`, `dueDate`, `totalCents`, `paidCents`, `balanceCents`, `orders`, `payments`.

## Pacotes de serviço

Planos são a coleção `/packages` do cadastro. Vendas: `GET /package-sales`, `GET /package-sales/:id`, `POST /packages/:id/sales {customerId,method,reference?}`. A venda registra o preço inteiro do pacote como recebido localmente; dinheiro exige caixa. Retorno é a venda, com `packageId`, `serviceId`, `customerId`, `credits`, `remainingCredits`, `priceCents`, `expiresAt`, snapshots de nomes e versão.

Resgate ocorre na OS e cobre o valor líquido proporcional dos serviços. Créditos e saldo da OS nunca ficam negativos. A receita é registrada na venda do pacote; o resgate não cria outro recebimento.

## Folha local

`GET /payroll`, `GET /payroll/:id` (admin/manager).

- `POST /payroll {period:"YYYY-MM",adjustments:[{employeeId,extrasCents,deductionsCents}],notes?}` gera folha local única do período, com empregados ativos, salário base e comissões ainda não utilizadas de OS entregues e quitadas. Data de elegibilidade da comissão = momento mais recente entre entrega e quitação.
- `PATCH /payroll/:id {version,adjustments:[...],notes?}` altera extras/descontos enquanto rascunho.
- `POST /payroll/:id/approve {version}` aprova snapshot.
- `POST /payroll/:id/recalculate {version}` recalcula o rascunho com os cadastros e comissões elegíveis atuais, preservando seus extras/descontos.
- `POST /payroll/:id/pay {version,method}` registra pagamento local uma vez; dinheiro exige caixa e gera saída.

Campos: `period`, `status:"draft"|"approved"|"paid"`, `baseCents`, `commissionCents`, `extrasCents`, `deductionsCents`, `totalCents`, `lines:[{employeeId,employeeName,baseCents,commissionCents,extrasCents,deductionsCents,totalCents,orderIds}]`. Não calcula impostos, vínculo, férias, encargos ou conformidade trabalhista.

## Mensagens locais

`GET /messages`, `GET /messages/:id`, `POST /messages {customerId,template:"custom"|"after_service"|"appointment",body?,orderId?,appointmentId?}`, `PATCH /messages/:id {version,body}`.

Se `body` for omitido para template conhecido, o servidor preenche texto simples com nome local da empresa/cliente. `POST /messages/:id/queue {version}` marca `queued`; `POST /messages/:id/cancel {version}` marca `cancelled`. Status inicial `draft`; fila não envia WhatsApp, SMS ou e-mail. Campo `deliveryMode:"local_only"` e `sentAt:null` deixam esse limite visível.

## Configurações, indicadores e relatórios

`GET /settings` → `item:{businessName,phone,address,currency:"BRL",timezone:"America/Sao_Paulo",receiptFooter,version}`. `PATCH /settings {version,businessName?,phone?,address?,receiptFooter?}` (admin/manager).

`GET /dashboard` → `item:{ordersByStatus,openOrders,receivedTodayCents,receivableCents,lowStockCount,appointmentsToday,recentOrders,upcomingAppointments,stockAlerts}`. Valores derivados do banco, sem dados fictícios de instalação.

`GET /reports?type=summary|sales|services|employees|stock|cash&from=YYYY-MM-DD&to=YYYY-MM-DD` → `{items,page,summary,period:{from,to,timezone},type,positionAsOf}`. Admin/manager. Padrão mês corrente no fuso do estabelecimento, `America/Sao_Paulo`. Relatórios aceitam `limit`/`offset`; um exportador deve buscar todas as páginas enquanto `page.hasMore`, não tratar a primeira página como conjunto completo.

- `summary`: indicadores `{metric,label,value,unit}`.
- `sales`: recebimentos `{id,createdAt,source,customerName,method,amountCents,reference}`.
- `services`: `{serviceId,name,quantity,grossCents,netCents,commissionCents}` de OS entregues no intervalo.
- `employees`: `{employeeId,name,orders,netCents,commissionCents}` de OS entregues no intervalo.
- `stock`: posição atual `{id,name,sku,unit,quantityMilli,minQuantityMilli,costCents,lowStock}`; movimentos do intervalo não alteram o significado de posição atual.
- `cash`: movimentos `{id,cashSessionId,createdAt,type,source,method,amountCents,category}` no intervalo.

`summary` inclui `receivedCents`, `deliveredCents`, `openReceivableCents`, `orderCount`. Filtro de data de recebimento usa instante do lançamento; OS entregues usam `deliveredAt`. Saldo em aberto e estoque são posições atuais. O frontend pode gerar CSV a partir dos itens e imprimir dados locais como recibo **NÃO FISCAL**. Emissão fiscal oficial é externa e não é simulada.
