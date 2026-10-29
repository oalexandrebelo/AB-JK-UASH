# Ponte JK de integrações

Esta ponte liga as ordens de serviço e os recebimentos da base UASH 0.2.1 aos conectores Pix e WhatsApp reaproveitados do `main`. O fluxo fiscal existente continua em `/api/fiscal/*`, com a mesma OS como origem. Nenhum banco, certificado, token ou configuração de conta foi importado do snapshot de origem.

O estado inicial é **bloqueado para efeitos externos**. Preparar uma cobrança ou uma mensagem salva uma intenção local. O servidor somente chama um provedor após um `POST .../submit` autorizado e com configuração válida. Não há timer, fila de reenvio, envio no startup ou worker de envio automático.

## Contrato HTTP

As respostas seguem o envelope da aplicação: `{ok:true,data:...}` ou `{ok:false,error:{code,message,...}}`. Toda mutação requer sessão válida, CSRF do host e `Idempotency-Key` com 8–128 caracteres alfanuméricos, `_` ou `-`. Leitura: perfis autenticados. Escrita: `admin` e `manager`, com revalidação da função na transação.

| Método e caminho | Entrada | Resultado |
| --- | --- | --- |
| `GET /api/jk/integrations/readiness` | — | `data.pix`, `data.whatsapp`, `data.fiscal`, `data.storageReady` e regras |
| `GET /api/jk/orders/:orderId/integrations` | — | `data.pixCharges`, `data.messages`, `data.fiscalDrafts`; até 100 de cada consulta |
| `GET /api/jk/orders/:orderId/fiscal-source` | — | Número, versão, itens e valor da OS; elegibilidade e URLs do fluxo fiscal existente |
| `POST /api/jk/orders/:orderId/pix` | `{version,expiresInSeconds?}` | `201 data.item`, preparação local pelo saldo atual; expiração de 60 a 86400 segundos, padrão 3600 |
| `GET /api/jk/pix/:id` | — | `data.item` e eventos de auditoria |
| `POST /api/jk/pix/:id/submit` | `{version}` | Envio único; `active` não confirma pagamento |
| `POST /api/jk/pix/:id/reconcile` | `{version,start?,end?}` | Consulta autenticada do PSP e baixa atômica quando elegível |
| `POST /api/jk/pix/:id/cancel` | `{version}` | Cancela somente preparação local nunca enviada |
| `POST /api/jk/orders/:orderId/messages` | `{version,templateName,languageCode,bodyParameters?,consentConfirmed:true}` | `201 data.item`, preparação local usando telefone do cliente da OS |
| `GET /api/jk/messages/:id` | — | `data.item` e eventos |
| `POST /api/jk/messages/:id/submit` | `{version}` | Envio único de modelo; sucesso = `accepted`, entrega `unconfirmed` |
| `POST /api/jk/messages/:id/cancel` | `{version}` | Cancela somente preparação local nunca enviada |

Cada capacidade informa `state: blocked|ready`, `configured`, `provider`, `environment`, `blockers`, `canPrepareLocally` e `capabilities`. Pix/WhatsApp também retornam `connectionVerified:false` e `homologated:false`: `ready` significa que o conector foi construído com os arquivos e flags necessários; não é prova de aceitação das credenciais pelo provedor nem de homologação. O startup não realiza chamadas externas para testar credenciais.

`data.item` contém `id`, `kind`, `orderId`, `orderVersion`, `version`, `status`, `provider`, `environment`, `amountCents`, `providerReference`, `paymentId`, `attemptCount`, `lastErrorCode`, `evidence`, `reconciliationRequired`, `canSubmit`, `canReconcile`, `canCancel`, `createdAt` e `updatedAt`. Mensagens têm `templateName` e `recipientMasked`; o telefone completo e os parâmetros não são expostos. Pix pode retornar o texto `evidence.pixCopiaECola` recebido e validado pelo conector. Nenhuma imagem de QR artificial é criada.

## Evidências e baixa Pix

O saldo, o identificador da OS, a versão e o `txid` vêm do servidor. O cliente não informa o valor da cobrança. Orçamentos, OS canceladas, OS quitadas ou vinculadas a uma fatura são recusados. Há uma única cobrança em aberto por OS; uma cobrança incerta mantém essa reserva.

A preparação guarda também a identidade do provedor, do ambiente e da conta que estava habilitada. Preparações feitas sem configuração habilitada, ou cuja conta/ambiente mudou depois, exigem cancelamento local e nova preparação. O servidor recusa o envio antes de qualquer I/O externo; `preparationRequiresRefresh` informa essa situação à interface. Preparar localmente não autoriza migrar silenciosamente uma intenção de homologação para produção.

O journal registra a associação `txid ↔ valor ↔ OS` antes do I/O. O estado `submitting`, a tentativa, a conta, o ambiente e o lease também são persistidos antes do I/O. Não há transação SQL aberta durante uma chamada ao provedor. A chave idempotente é estável por registro.

Um envio incerto não pode ser reenviado pelo endpoint. Mesmo após reiniciar ou vencer o lease, a recuperação consulta o PSP por `GET`. Uma resposta atrasada somente é aplicada se ainda possuir o lease atual. O endpoint de reconciliação consulta tanto a cobrança quanto os recebimentos e valida a paginação por meio do conector original.

A baixa financeira exige, simultaneamente:

- Ambiente `production`, conta/provedor/ambiente iguais aos do envio e journal associado à OS.
- Cobrança `CONCLUIDA` e evidência `authenticated-polling`.
- Comprovantes com identificadores `endToEndId` distintos, total exato da cobrança e nenhum valor devolvido ou devolução pendente.
- Nenhum comprovante já associado a outra cobrança.
- Saldo atual da OS exatamente igual ao valor a baixar; OS sem cancelamento e sem fatura.

A gravação usa `receive()`, `payment_allocations` e `touchOrder()` do núcleo. Pagamento, movimento de caixa, alocação, saldo da OS, vínculo dos comprovantes, estado da integração e auditoria são confirmados na mesma transação. Qualquer erro desfaz os efeitos financeiros. O teste de falha forçada na alocação cobre esse comportamento.

Homologação pode resultar em `test_confirmed`, com `paymentConfirmed:false`, sem pagamento ou alteração do saldo. Recebimento parcial, devolução, comprovante incompatível, saldo alterado ou baixa manual concorrente resultam em análise (`partial`/`review`), sem baixa automática. Depois de uma baixa já registrada, uma alteração posterior nos comprovantes é sinalizada por `evidence.reviewRequired`; esta implementação não cria estornos financeiros automáticos.

A reconciliação padrão cobre do envio até o momento atual, com limite de 31 dias. Para registros mais antigos, informe `start` e `end` explícitos com no máximo 31 dias. Esta versão não soma automaticamente comprovantes de múltiplas janelas para completar uma baixa.

## WhatsApp e fiscal

WhatsApp utiliza apenas `send-template` no fluxo de OS. O operador informa o nome do modelo aprovado e os parâmetros, confirma o consentimento e o servidor resolve o destinatário a partir do cadastro da OS. Números brasileiros de 10/11 dígitos recebem `55`; números internacionais devem incluir `+` e código do país. A versão da OS é conferida novamente antes do envio.

Um identificador `wamid` válido significa aceitação pelo provedor. A interface recebe `delivery:unconfirmed` mesmo em sucesso. Não foram instalados webhooks de entrega, verificação automática de consentimento, aprovação de modelos, campanhas ou reenvio. Em timeout, a mensagem permanece `uncertain`; o registro não pode ser reenviado.

O fiscal reaproveita a implementação 0.2.1 de Focus NFe/gateway. `/api/fiscal/drafts` já captura uma versão imutável da OS, exige dados fiscais e revisão tributária, confere novamente a OS antes de enviar e reconcilia resultados incertos. `/api/jk/orders/:id/fiscal-source` facilita a consulta da origem; não preenche classificação tributária, alíquota, certificado, município ou dados do contribuinte por suposição. `homologated:false` continua explícito. Configuração ausente mantém a emissão bloqueada, preservando os rascunhos locais.

## Configuração do servidor

Nenhum arquivo real de configuração ou segredo é fornecido. As variáveis abaixo são lidas somente no servidor:

| Variável | Efeito |
| --- | --- |
| `AB_JK_SECRETS_ROOT` | Diretório dedicado, controlado pelo administrador, que contém configuração e segredos |
| `AB_JK_INTEGRATIONS_CONFIG` | Caminho relativo do JSON de configuração dentro desse diretório |
| `AB_JK_INTEGRATIONS_ENABLED` | Somente `true` permite submeter/consultar os conectores configurados; padrão desativado |
| `AB_JK_ALLOW_PRODUCTION` | Somente `true` habilita conectores cujo ambiente é `production`; padrão desativado |

Os arquivos são lidos pela rotina de segredos do `main`: confinamento ao diretório, rejeição de symlink, tamanho limitado e permissões privadas. O JSON aceita no máximo um provedor Pix e um WhatsApp. URLs arbitrárias não são aceitas. OAuth/mTLS de Pix usa os perfis fixos Efí/Inter; WhatsApp usa apenas `graph.facebook.com`. O transporte preservado recusa redirecionamentos, destinos privados e retry de mutações.

Estrutura de configuração, sem credenciais:

```json
{
  "version": 1,
  "integrations": [
    {
      "kind": "pix-efi",
      "environment": "homologation",
      "clientIdFile": "pix/client-id.txt",
      "clientSecretFile": "pix/client-secret.txt",
      "pixKeyFile": "pix/pix-key.txt",
      "mtls": { "pfxFile": "pix/certificate.p12" }
    }
  ]
}
```

Também são aceitos `kind:pix-inter`, mTLS com `certFile`+`keyFile`, `passphraseFile` opcional e `accountNumberFile` opcional para Inter. WhatsApp requer `kind:whatsapp-cloud`, `environment:production`, `phoneNumberId`, `graphVersion` explícito e `accessTokenFile`. Não há versão Graph padrão presumida.

As variáveis `AB_UASH_FISCAL_*` já existentes continuam configurando o fiscal, de forma independente. Não foi ativado nenhum provedor fiscal.

## Integração com o host e armazenamento

`server/application.mjs` deve chamar `migrateJkIntegrations(raw)` após a migração local 0.2.1, inicializar `initializeJkIntegrations(store,{env})`, passar `jkIntegrations` no contexto e registrar `handleJkIntegrations` na cadeia de handlers. Esses hooks estão integrados na aplicação JK.

SQLite: `schema.sql` cria apenas tabelas `jk_*`, com chaves estrangeiras para o núcleo. Não copia ou reutiliza o schema do `main`. Não muda `PRAGMA user_version` nem o banco de origem.

PostgreSQL: `schema.postgres.sql` é a mesma migração sem `STRICT`, com lease em `BIGINT`. Deve ser aplicada pelo fluxo de migrações da implantação, usando o schema da aplicação como `search_path` e concedendo os privilégios do runtime. O runtime nunca tenta fazer DDL no PostgreSQL. Se qualquer tabela necessária estiver ausente, `storageReady:false` e `INTEGRATION_STORAGE_UNAVAILABLE` bloqueiam a preparação e o envio de forma explícita. Esta rodada não executou testes contra um servidor PostgreSQL.

Os registros locais mantêm a entrada da mensagem e a evidência bancária necessária; os backups da base incluem esses dados. Logs e respostas não recebem tokens, certificados, segredos, corpos brutos dos provedores ou mensagens de exceção do transporte.

## Verificação executada

```sh
node --test --test-isolation=none --test-reporter=spec tests/jk-integrations.test.mjs tests/jk-integrations-api.test.mjs
```

Resultado: **15 testes passaram, 0 falhas**. Os testes de conector usam transporte de fixture, sem acesso aos provedores. Os dois testes HTTP usam apenas loopback. Cobertura: preparação persistente, auth/CSRF/RBAC, conflitos de versão/idempotência, baixa e caixa atômicos, rollback financeiro, homologação, timeout e recuperação por consulta, lease vencido/resposta tardia, saldo pago manualmente, parcial/devolução/comprovante reutilizado, conta trocada, aceite de WhatsApp sem falsa entrega e ausência de migração/configuração.

Limites concretos: nenhum pagamento real, emissão fiscal real, envio real de mensagem ou homologação de conta foi realizado. Não há reconciliação automática em background, estorno Pix, cancelamento bancário de cobrança enviada, webhook de recebimento/entrega ou retry automático de mensagens.
