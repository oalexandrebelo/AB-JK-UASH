# Contrato HTTP da agenda pública

Extensão SQLite do AB-JK-UASH 0.5.0. A implantação usa a mesma origem HTTPS da interface. Sucesso: `{ok:true,data:...}`; erro: `{ok:false,error:{code,message,requestId}}`. Respostas da agenda usam `Cache-Control: no-store`. A agenda não está disponível no armazenamento PostgreSQL.

O SDK operacional de sessão e seu OpenAPI não incluem esta extensão. A interface web usa o cliente específico em `src/features/booking/api.ts`. Não enviar tokens, CPF, recibos ou chaves em URLs, logs ou métricas.

## Cliente público

Prefixo `/api/public/booking`. POST exige JSON; limite de corpo de 16 KiB e controles de origem e frequência. Não há confirmação financeira enviada pelo cliente. GET consulta somente o estado local.

| Método e sufixo | Entrada e autenticação | Retorno em data |
|---|---|---|
| GET `/catalog` | Sem autenticação | `enabled`, `closedReasons`, `policyVersion`, `termsVersion`, `arrivalMinutesBefore:10`, `noShowLimit:2`, `services` |
| GET `/availability` | Query `date`, `serviceId`, `category` | `date`, `timezone`, `closedReasons`, `slots` com início, fim e capacidade restante |
| POST `/identity/request` | `{phone}` em E.164; origem definida pelo servidor | `challengeId`, `expiresAt` |
| POST `/identity/verify` | `{challengeId,code}` | `identityToken`, `expiresAt`, `blocked` |
| POST `/holds` | Bearer de identidade; `Idempotency-Key`; corpo abaixo | `reservationToken`, `reservation` |
| GET `/reservations` | Bearer de identidade; `limit`, `offset` opcionais | `items:[{reservationToken,reservation}]`, `page` |
| GET `/reservation` | Bearer da reserva | `reservation` |
| POST `/reservation/pix` | Bearer da reserva; `{customerInput:{name,cpfCnpj}}` | `reservation` |
| POST `/reservation/reconcile` | Bearer da reserva; `{}` | `reservation`; consulta autenticada ao provedor, até quatro solicitações por minuto por reserva |
| POST `/reservation/cancel` | Bearer da reserva; `{version}` | `reservation` |

Os dois tipos de token têm finalidades distintas. Usar `Authorization: Bearer TOKEN`, nunca parâmetros de URL. A identidade expira em duas horas; revalidar o mesmo telefone recupera suas reservas e não zera faltas. O código de verificação vale cinco minutos e tem cinco tentativas. Pedido de código não autoriza marketing.

O corpo de `/holds` contém somente `serviceId`, `category`, `startsAt`, `policyVersion`, `termsVersion` e `attendanceAccepted:true`. O início é ISO UTC canônico com milissegundos. A chave de tentativa tem entre 8 e 128 caracteres alfanuméricos, hífen ou sublinhado. Repetir a mesma tentativa exige o mesmo conteúdo; não gerar outra chave automaticamente após uma falha de transporte.

Uma reserva retorna `id`, `reference`, `status`, `financialStatus`, `startsAt`, `endsAt`, `holdExpiresAt`, `arrivalDeadline`, `amountCents`, `serviceName`, `category`, `version`, `pixCopiaECola` e `whatsappUrl`. O valor Pix e o link são nulos quando indisponíveis. O link de WhatsApp só aparece após confirmação financeira e não contém token de acesso. Valores monetários são centavos inteiros; duração e regras são definidas no servidor.

Estados de reserva: `holding`, `awaiting_payment`, `confirmed`, `arrived`, `no_show`, `cancelled`, `expired`. Financeiro: `pending`, `received`, `review`, `refund_pending`, `refunded`. Uma pendência de devolução não comprova devolução executada. A implementação não oferece endpoint de estorno automático.

## Operação autenticada

Prefixo `/api/jk/booking`. Exige cookie de sessão ativo e papel admin, manager ou operator; escritas exigem `X-CSRF-Token`. A autorização é conferida novamente na transação. As operações de atendimento e alocação são recusadas em consulta paralela.

| Método e sufixo | Requisito adicional | Contrato |
|---|---|---|
| GET `/policy` | — | `{policy,closedReasons}` |
| PUT `/policy` | Admin | Política completa com `version`; salvar desabilitada é permitido no paralelo |
| GET `/reservations` | — | Filtros `date`, `status`, `limit`, `offset`; `{items,page}`; itens incluem `orderId` quando alocados |
| POST `/reservations/:id/check-in` | — | `{version,reason}`; chegada até o prazo, inclusive |
| POST `/reservations/:id/no-show` | — | `{version,reason}`; somente após o prazo |
| POST `/reservations/:id/reverse-no-show` | Admin | `{version,reason}`; revisão auditada, sem ressuscitar vaga |
| GET `/advances` | Admin ou manager | `start`, `end` UTC e paginação opcionais; `{items,page}` de recebimentos originais |
| POST `/fulfillment/preview` | — | Seleção abaixo; prévia sem gravação |
| POST `/fulfillment/commit` | `Idempotency-Key` | Mesma seleção e `previewHash`; cria OS e aloca o adiantamento, sem nova entrada de caixa |

Seleção da alocação: `bookingId`, `bookingVersion`, `customerId`, `vehicleId`, `employeeId`, `operationalServiceId`, `commissionBps`, `commissionReviewed:true`, `identityMatchConfirmed:true`. A reserva precisa ter chegada e recebimento confirmados. Cadastro ativo, vínculo do veículo, categoria, disponibilidade do funcionário e comissão são revistos. O preço e a duração contratados não são substituídos pelos atuais do catálogo.

A prévia retorna `canCommit`, `previewHash`, `booking`, `receipt`, `order`, `effects` e `warnings`. O commit retorna `bookingId`, `orderId`, `paymentId`, `amountCents`, `receivedAt`, `endToEndId`, `replayed`. Uma nova autorização continua obrigatória ao repetir a mesma tentativa.

O processo periódico apenas consulta cobranças existentes e processa presença. Não cria cobrança, devolução ou mensagem. Webhook, comprovante e indicação `paid=true` não liberam vaga. A unicidade do E2E é conferida nos dois sentidos entre a agenda e os pagamentos das OS.
