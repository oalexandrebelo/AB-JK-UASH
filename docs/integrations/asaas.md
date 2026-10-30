# Pix Asaas no JK

O conector cria cobranças Pix, recupera o código de pagamento e concilia recebimentos pela API Asaas v3. A implementação usa o transporte HTTPS, os arquivos privados de credenciais e o diário de idempotência já existentes. Não adiciona dependências.

A validação desta entrega usa respostas HTTP e sockets simulados, SQLite real e requisições HTTP no computador local. Não houve autenticação em uma conta Asaas, emissão externa, pagamento, contratação, criação de cliente ou mensagem real. A integração permanece `homologated:false`; uma resposta simulada não homologa o fornecedor.

## Preparação

1. Use primeiro uma conta Sandbox e uma API Key desse ambiente. Sandbox e produção têm contas, clientes e chaves independentes.
2. Obtenha o identificador da conta (`account.id`, UUID) e o identificador de um cliente já cadastrado (`cus_...`). O JK não cria clientes automaticamente no Asaas.
3. Guarde a API Key e um token exclusivo de Webhook em arquivos privados fora do repositório. O token de Webhook deve ter 32–255 caracteres, sem espaços, ser aleatório e diferente da API Key. Os arquivos de segredo não podem ser links simbólicos nem permitir leitura pública.
4. Cadastre um Webhook de cobranças com API v3, token exclusivo e a URL HTTPS pública final `/api/jk/integrations/asaas/webhook`. O cadastro externo não é feito pelo JK. Confira a configuração e os logs no Asaas.
5. Instale a migração JK antes de habilitar o conector. `migrateJkIntegrations` aplica o esquema existente e a tabela adicional `jk_asaas_webhook_events`. A inicialização não migra um banco PostgreSQL; a ausência das tabelas bloqueia a integração.

Exemplo sem credenciais, salvo como arquivo privado de configuração:

```json
{
  "version": 1,
  "integrations": [
    {
      "kind": "pix-asaas",
      "environment": "homologation",
      "accountId": "11111111-2222-4333-8444-555555555555",
      "apiKeyFile": "asaas/api-key",
      "webhookTokenFile": "asaas/webhook-token"
    }
  ]
}
```

O UUID acima é fictício. Substitua-o pela conta revisada. `apiKeyFile` e `webhookTokenFile` são referências relativas a `AB_JK_SECRETS_ROOT`; não cole os valores secretos no JSON. `AB_JK_INTEGRATIONS_CONFIG` aponta para esse arquivo dentro da mesma raiz. A configuração admite um provedor Pix e um WhatsApp, no máximo.

`environment:homologation` seleciona somente `https://api-sandbox.asaas.com/v3`; `production` seleciona somente `https://api.asaas.com/v3`. Não há URL livre, fallback de ambiente ou reutilização automática de chave. O envio exige `AB_JK_INTEGRATIONS_ENABLED=true`; produção também exige `AB_JK_ALLOW_PRODUCTION=true`. Configurar os arquivos não prova a conexão.

## Emissão revisada

Prepare uma cobrança por `POST /api/jk/orders/{orderId}/pix`, com sessão de administrador/gerente, CSRF e `Idempotency-Key`:

```json
{
  "version": 1,
  "customerId": "cus_identificadorRevisado",
  "dueDate": "2026-11-01"
}
```

A versão é a versão atual da OS. O valor vem do saldo da própria ordem. O operador deve conferir o cliente Asaas e o vencimento exibidos na preparação. O envio posterior usa o endpoint `/api/jk/pix/{id}/submit`, com a versão atual da preparação. O modo de consulta paralela bloqueia preparação, envio e conciliação de negócio.

A API Asaas usa `dueDate`; o conector rejeita `expiresInSeconds`. A duração do QR segue as regras e a conta Asaas e é exibida em `pixExpirationDate`. Não há promessa de que vença em uma hora. A emissão envia apenas os campos documentados `customer`, `billingType:PIX`, `value`, `dueDate`, `externalReference` e descrição da OS. Configurações de comunicação ao pagador pertencem à conta Asaas e devem ser revisadas pelo operador antes de qualquer emissão externa.

O transporte envia `access_token`, `User-Agent` e JSON. Há prazo de 20 segundos por requisição e limite global de 60 segundos na operação JK. POST não tem repetição automática. Leituras podem ter as repetições limitadas do transporte existente.

## Idempotência e recuperação

Antes do POST, o diário existente reserva a referência e a impressão digital do pedido. A reserva inclui conta/credencial, ambiente, OS, cliente, valor, vencimento e descrição. Uma repetição busca a cobrança por `externalReference`; nunca faz outro POST para essa referência. Não é usado um header de idempotência não documentado pelo Asaas.

Se o resultado da emissão for incerto, inclusive falha ao buscar o QR depois de a cobrança ser aceita, a preparação fica incerta e só permite conciliação. Uma busca vazia, paginada ou com mais de uma cobrança não autoriza nova emissão. Restaure a conta/ambiente/credencial originais e investigue a cobrança no fornecedor; não descarte o diário nem prepare outra cobrança para contornar a incerteza. A cópia de segurança deve preservar o banco e o diário juntos.

A troca da API Key invalida o vínculo de preparações e consultas anteriores, por cautela. Planeje a rotação preservando a possibilidade de conciliar operações existentes; o JK não remapeia contas automaticamente.

## Webhook e confirmação

O callback aceita somente POST JSON de até 256 KiB. Valida `asaas-access-token` por comparação de tamanho fixo, confere `account.id` e grava um aviso mínimo antes de responder HTTP 200. Não grava o corpo completo, nomes, documentos ou o token. A chave de deduplicação é conta/ambiente mais `event.id`; a rotação do token não elimina essa proteção. Reenvios iguais retornam 200; reutilizar o mesmo evento com campos de negócio diferentes retorna conflito.

Cobranças não Pix e referências externas alheias ao formato JK são registradas como ignoradas e recebem 200. Assim, pagamentos de outros fluxos da mesma conta não paralisam a fila. Campos adicionais de eventos são tolerados. Configure somente eventos de cobrança; outros produtos Asaas não fazem parte deste callback.

O callback não baixa a OS, não movimenta caixa e não dispara consultas externas. Ele persiste avisos pendentes; a conciliação continua sendo acionada por um operador. `AsyncAsaasWebhookInbox.pending(scope)` permite inspecionar a fila e `complete(scope,eventId)` marca avisos tratados. Marque somente depois de verificar o resultado; não há consumidor automático nesta entrega. Em consulta paralela, receber o aviso continua permitido e as ações de negócio continuam bloqueadas.

A conciliação por `/api/jk/pix/{id}/reconcile` consulta a cobrança por referência e, quando disponível, a transação apontada por `pixTransaction`. Para confirmar exige:

- cobrança Pix vinculada ao diário, cliente, vencimento, descrição e valor esperados;
- estado `RECEIVED`, sem exclusão, chargeback ou estorno pendente;
- transação de crédito `CREDIT`, concluída `DONE`, vinculada ao mesmo `pay_...`, com valor integral;
- identificador E2E válido, horário dentro do intervalo da conciliação e nenhum valor estornado.

`CONFIRMED` sozinho não baixa a OS. `RECEIVED` sem transação/E2E verificáveis exige revisão. O código não inventa recibos para suprir campos ausentes. Recibos repetidos não geram um segundo pagamento. O núcleo faz pagamento, alocação e caixa na mesma transação apenas em produção; no Sandbox, o resultado é `test_confirmed` e o saldo real permanece aberto.

O schema Asaas exemplifica `effectiveDate` sem fuso. O conector aceita timestamps que já tragam fuso. Para respostas sem fuso, o operador pode declarar `dateTimeOffset`, por exemplo `-03:00`, **depois de confirmar a interpretação da conta com o fornecedor**. Esse exemplo não comprova o fuso do Asaas. Sem essa declaração, o resultado fica em revisão, sem baixa automática.

## Verificação e limites

`node --test tests/asaas*.test.mjs` cobre adapter, segredos, diário, notificações, inicialização e HTTP local. Os testes de produção são fixtures locais, sem dinheiro real. Os testes de Baileys nesse conjunto também usam socket simulado e não comprovam pareamento ou entrega em aparelho.

Antes do uso real, ainda é necessário validar credenciais do Sandbox, cadastro do cliente, emissão/QR, retorno de transação e horário, reenvio de Webhook, recuperação de falhas, permissões da conta e a configuração independente de produção. A disponibilidade depende dos campos que o Asaas efetivamente fornecer à conta; ausência de evidência mantém a OS em revisão. Esta entrega não implementa cartão, boleto, assinatura, Pix Automático, transferência, saque ou estorno externo.

## Fontes oficiais consultadas em 30/10/2026

- [Comece por aqui — ambientes](https://docs.asaas.com/reference/comece-por-aqui)
- [Autenticação e identificação do aplicativo](https://docs.asaas.com/docs/authentication-2)
- [Criar cobrança](https://docs.asaas.com/reference/criar-nova-cobranca)
- [Listar cobranças e filtrar referência externa](https://docs.asaas.com/reference/listar-cobrancas)
- [Recuperar cobrança](https://docs.asaas.com/reference/recuperar-uma-unica-cobranca)
- [QR Code Pix](https://docs.asaas.com/reference/get-qr-code-for-pix-payments)
- [Recuperar transação Pix](https://docs.asaas.com/reference/recuperar-uma-unica-transacao)
- [Eventos de cobrança](https://docs.asaas.com/docs/payment-events)
- [Receber Webhooks e autenticar notificações](https://docs.asaas.com/docs/receive-asaas-events-at-your-webhook-endpoint)
- [Reenvios, deduplicação e resposta HTTP 200](https://docs.asaas.com/docs/webhooks-faq)

O [link comercial fornecido](https://www.asaas.com/000/c/80ri1rht6i846dcq) não substitui a documentação técnica nem representa contratação, cadastro ou concessão de benefício. Nenhuma contratação foi realizada. Os módulos novos são código do projeto; o transporte, validação e leitura de segredos reutilizados mantêm a procedência descrita em `integrations/jk/PROVENANCE.md`. Nenhum SDK ou pacote Asaas foi incorporado.
