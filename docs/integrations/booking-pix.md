# Agenda pública com Pix

O endereço público é `/agendar`. As páginas `/privacidade` e `/condicoes-de-agendamento` explicam o tratamento de dados e as regras de presença. A agenda começa fechada: nenhuma duração, capacidade, conta bancária ou autorização comercial é presumida.

## Preparação pelo responsável

O endereço atual do AB-PCSRV pertence à rede privada. Antes de divulgar a agenda aos clientes, é necessário definir o domínio público, configurar HTTPS e a origem permitida do servidor e testar o acesso fora dessa rede. Criar a rota `/agendar` não publica automaticamente o servidor na Internet.

1. Em **Integrações**, siga o [guia Asaas](asaas.md) para a conta recebedora. O pagamento do cliente é Pix; o banco do pagador pode ser Nubank, C6 ou outro participante. Isso não conecta automaticamente uma conta recebedora nesses bancos.
2. Prepare o WhatsApp pelo [guia Baileys](whatsapp-baileys.md) para esta versão da agenda. Confirme a conta do estabelecimento. O código de verificação só deve ser enviado ao telefone informado pelo próprio cliente na solicitação.
3. Cadastre o modelo `jk_booking_otp`, idioma `pt_BR`, com um parâmetro. No Baileys, acrescente ao arquivo privado de modelos, preservando os modelos existentes:

```json
{"templateName":"jk_booking_otp","languageCode":"pt_BR","text":"Seu código de acesso à agenda Lava Rápido JK é {{1}}. Ele vale por cinco minutos. Não compartilhe este código."}
```

O conector Cloud API existente não implementa todos os componentes dos modelos de autenticação; ele permanece indisponível para códigos desta agenda até a adaptação e validação específicas. A aceitação de uma mensagem pelo conector não prova entrega. A confirmação do código correto comprova o acesso ao telefone.

4. Prepare um segredo persistente e exclusivo da agenda, fora do Git, pelo utilitário já existente. Exemplo para o diretório privado montado no servidor:

```sh
node scripts/bootstrap-token.mjs --file /data/integrations/booking-secret
```

O diretório precisa existir com acesso privado. O comando cria o arquivo com permissão `0600`, preserva um arquivo válido existente e não exibe o segredo. Faça backup privado junto com o banco. Não use o mesmo arquivo do token de instalação e não gere um segredo novo a cada reinício.

5. Na configuração privada do servidor, associe os caminhos reais e configure:

```dotenv
AB_JK_BOOKING_ENABLED=true
AB_JK_BOOKING_SECRET_FILE=booking-secret
AB_JK_BOOKING_OTP_TEMPLATE=jk_booking_otp
AB_JK_BOOKING_OTP_LANGUAGE=pt_BR
```

O arquivo é relativo a `AB_JK_SECRETS_ROOT`. A agenda reutiliza `AB_JK_INTEGRATIONS_CONFIG`, `AB_JK_INTEGRATIONS_ENABLED` e `AB_JK_ALLOW_PRODUCTION`. A configuração deve conter um recebedor `pix-asaas` de produção e um WhatsApp pronto. O Baileys ainda exige seus controles explícitos de conexão e envio. Credenciais nunca são informadas na tela pública ou em links. Ativar essas variáveis autoriza efeitos reais; faça isso somente na configuração da conta do titular.

6. Em **Configurações → Agenda online**, cadastre serviços operacionais e revise preço, duração, porte do veículo, horários, intervalo entre vagas, antecedência, prazo para pagamento, telefone comercial e capacidade. A capacidade deve ser fisicamente dedicada à agenda pública: a agenda manual ainda não compartilha sua ocupação automaticamente. Confira a identificação real do fornecedor, seus contatos e as políticas antes de abrir.
7. Mantenha a agenda fechada durante o ensaio paralelo com Jumpcar. Habilite somente depois dos testes e da decisão de assumir a operação. A aplicação rejeita novas reservas e cobranças enquanto estiver em consulta paralela.

## Jornada e conferência financeira

O cliente consulta disponibilidade, verifica o telefone, aceita os termos e solicita a reserva temporária. Nome e CPF/CNPJ são solicitados para gerar a cobrança no Asaas. O preço, a conta e a referência são definidos no servidor. A reserva só é confirmada por consulta autenticada ao provedor, com valor integral e identificador Pix único; comprovante enviado ou indicação do navegador não confirmam pagamento.

Depois da confirmação, o cliente abre o WhatsApp da JK para conferir os dados. A chegada deve ser registrada até dez minutos antes do horário, inclusive nesse instante. Após esse prazo, uma reserva paga sem chegada gera falta. Duas faltas ativas suspendem novas reservas para o telefone verificado. A equipe pode corrigir um registro com motivo e trilha de auditoria; nova verificação do telefone não zera faltas.

O Pix recebido entra como adiantamento na data do recebimento, mesmo se exigir revisão. Após registrar a chegada, a equipe confere cliente, veículo, funcionário, serviço e comissão e converte o adiantamento em uma ordem de serviço. O preço e a duração pagos são preservados. Essa vinculação não cria uma segunda entrada de caixa nem cobra novamente.

O prazo de reserva não cancela automaticamente o QR bancário. Um pagamento recebido depois da liberação da vaga exige revisão e não reabre o horário. Cancelamento, falta, estorno observado e divergência financeira ficam visíveis para tratamento. O sistema não decide retenção nem executa devolução automática; `refund_pending` significa pendência, não dinheiro devolvido. Antes de devolver pelo provedor, confira o identificador original e registre o resultado conforme o procedimento financeiro do estabelecimento.

## Testes antes da abertura

- Disponibilidade concorrente: dois clientes não podem ocupar a mesma capacidade.
- Pagamento pendente, confirmado, duplicado e tardio; o mesmo Pix não pode pagar uma reserva e outra OS.
- Entrada financeira antes da OS, conversão depois da chegada e repetição da mesma tentativa, mantendo o total recebido e uma única movimentação de caixa.
- Chegada pontual, prazo ultrapassado, duas faltas, correção administrativa e recuperação de reservas após verificar o telefone novamente.
- WhatsApp desconectado, provedor indisponível e reinício do servidor: estados pendentes permanecem recuperáveis e não geram cobrança repetida.
- Backup restaurado em ambiente isolado. Testes reais de Pix e WhatsApp dependem das contas configuradas; os testes automatizados usam dados sintéticos e não comprovam homologação externa.

## Escolhas de integração

O [YouPI-PG](https://github.com/youpi-pg/YouPI-PG) trabalha com UPI da Índia e não implementa o Pix brasileiro. Por isso, ele não confirma recebimentos desta agenda. O [C6](https://www.c6bank.com.br/blog/api-c6-bank) oferece uma rota própria de integração que depende de credenciais e homologação; ela não foi implementada como se fosse um conector pronto. Para Nubank, nenhum contrato de API de recebimento adequado à conta desta instalação foi validado.

O [Cal.diy](https://github.com/calcom/cal.diy) foi analisado como referência de disponibilidade, verificação e reservas. Seu código completo e suas dependências não foram incorporados ao JK. A implementação usa o banco e os conectores existentes, com origem e evidências do estudo registradas no relatório da entrega.
