# AB-JK-UASH — roteiro de teste no destino

Versão: **0.1.1**. Este documento define o aceite; não é uma lista de etapas já aprovadas. Resultados efetivos, commit implantado e limitações estão em [RELEASE-0.1.1.md](RELEASE-0.1.1.md). O responsável da JK deve conseguir executar cada jornada sem intervenção no banco ou manipulação manual de saldo.

## 1. Preparar a sessão de teste

1. Confirmar o commit da imagem e os logs de aplicação, manutenção e verificação. Usar o manifesto fixado por SHA e registrar seu hash. O código do repositório pode avançar depois do build; o SHA efetivamente implantado é a referência do ensaio.
2. Abrir a URL HTTPS pelo dispositivo autorizado da tailnet. Confirmar `/` e `/app`, carregamento da interface e ausência de erro de API. A verificação por HEAD no contêiner não substitui essa abertura.
3. Criar o primeiro administrador usando o [bootstrap privado](operations-jk.md), somente se a instalação ainda estiver vazia. Conservar acesso legado exige a opção explícita documentada e uma credencial autorizada fornecida em stdin privado. Não inserir credenciais em exemplos, tickets ou gravações.
4. Entrar e sair, testar recarga de página e expiração/revogação de sessão. Criar os papéis necessários com credenciais próprias. Confirmar que consulta não grava e operador não acessa gestão ou migração.
5. Preparar uma instalação isolada com dados sintéticos para as jornadas de treinamento. A base de teste não pode ser o banco real migrado; serviços ativos podem aparecer na landing da mesma instalação.
6. Manter provedores externos desabilitados durante o treinamento local. Homologação de Pix, fiscal e WhatsApp ocorre em sessão separada, com destinatários e ambientes definidos.

Se o endereço não abrir, resolver acesso, DNS/rota e HTTPS antes de cadastrar dados. Se `setupRequired` continuar verdadeiro, a disponibilidade da API não representa um login pronto. O token de configuração é um segredo do volume privado.

## 2. Casos de aceite operacional

Os dados sintéticos e a navegação detalhada estão no [MANUAL-JK](MANUAL-JK.md). Para cada caso, registrar data, versão, papel utilizado, resultado esperado, resultado observado e referência da evidência privada. Registrar somente IDs técnicos em documentos públicos.

| Caso | Ação | Critério de aceite |
| --- | --- | --- |
| AT01 — Landing | Abrir em desktop e celular; navegar por teclado; seguir o perfil JK; consultar catálogo. | Identidade da JK, textos legíveis, foco visível, contato correto e catálogo coerente com serviços ativos. Nenhum dado privado aparece sem login. |
| AT02 — Acessos | Entrar como administrador, gestor, operador e consulta; revogar uma sessão; tentar ação restrita pela API. | Interface e servidor recusam o que o papel não autoriza. Mudança de perfil/desativação revoga sessões. O último administrador é preservado. |
| AT03 — Cadastro e agenda | Cadastrar cliente, veículo, serviço, profissional e agenda; tentar conflito; converter agendamento. | Vínculos corretos, conflito informado e apenas uma OS criada por conversão. Valores e horários correspondem ao preenchimento. |
| AT04 — Atendimento | Criar OS, registrar checklist e foto sintética, consumir insumo, avançar até pronta e receber. | Etapas válidas, foto acessível só a autorizados, estoque coerente e pagamento único. Entrega de cliente comum exige saldo zero. |
| AT05 — Caixa | Abrir caixa, receber parcialmente, lançar despesa, fechar e tentar nova operação incompatível. | Saldo e movimentos em centavos corretos. Repetição/retry não duplica o recebimento. Caixa fechado impede a operação e preserva o estado anterior. |
| AT06 — Pós-pago | Autorizar cliente, concluir duas OS, faturar por período, imprimir, receber parcialmente e quitar. | Fatura contém somente OS elegíveis; saldo correto; vencimento visível; uma OS não pertence a duas faturas ativas. A impressão representa os valores salvos. |
| AT07 — Concorrência | Abrir a mesma OS/fatura em dois navegadores; tentar duas baixas a partir da mesma versão. | Apenas a operação válida é confirmada; o outro navegador recebe conflito e atualiza. Conferir pagamentos, alocações, caixa e auditoria. |
| AT08 — Transporte | Programar retirada/devolução, atribuir responsável, testar conflito e concluir etapas. | Janela e responsável corretos, conflitos respeitados, histórico e integração com chegada/entrega da OS consistentes. |
| AT09 — Pacote e comissão | Vender pacote de teste, usar crédito, tentar reutilização e apurar comissão elegível. | Crédito consumido uma vez; saldo consistente; comissão da OS preservada; não reutiliza a mesma reserva em duas folhas. |
| AT10 — Relatórios | Comparar relatório de período, CSV, OS, caixa e fatura. | Mesmos critérios de período e valores conciliáveis. Histórico migrado não é contado como novo movimento de caixa. |
| AT11 — Persistência | Reiniciar os serviços após operações sintéticas concluídas. | Cadastros, saldos e vínculos persistem. Não reinicializa banco nem cria conta padrão. |
| AT12 — Recuperação | Gerar backup online, verificar prova e restaurar em arquivo separado. | Integridade e chaves estrangeiras válidas, dados conferidos, sessões revogadas na cópia restaurada, original preservado. |

As automatizações desta versão cobrem parte dessas regras, inclusive concorrência entre duas conexões SQLite. O ensaio acima verifica a experiência real com o dispositivo, a rede e os papéis da JK. Não considerar o conjunto inteiro aprovado porque um endpoint de saúde respondeu.

## 3. Aceite de migração

Antes da primeira confirmação, obter inventário dos arquivos autorizados: origem, data de exportação, tipo, hash, contagem por entidade, total financeiro e alcance. Não presumir que um ZIP de evidências contém a exportação completa. O acesso ao pacote privado identificado na entrega depende da autorização específica exigida pela revisão automática.

Executar a prévia com a conta administradora ou CLI privada. Revisar todas as rejeições, avisos de qualidade, datas, identidades e vínculos. Dados sem ID nativo usam a identidade técnica documentada; comparar nome ou telefone não autoriza deduplicação. Outro snapshot nativo pode exigir reconciliação manual explícita.

Confirmar somente o hash revisado, com backup válido imediatamente anterior. Depois da transação, conferir as contagens do lote e o estado global. Selecionar amostras por entidade com o responsável da JK, incluindo nomes curtos, campos vazios, veículos repetidos, OS parcialmente pagas, OS quitadas e itens com datas antigas. A amostragem complementa a reconciliação integral das contagens e somas; não a substitui.

Repetir a mesma confirmação para comprovar resposta idempotente sem duplicação. Em lotes incrementais, `reconciliation` representa cada OS afetada completa, incluindo registros anteriores. Não somar relatórios de lotes que revisitem a mesma OS. O replay de um lote antigo preserva seu relatório histórico.

Para contas de acesso, registrar separadamente quais usuários foram efetivamente criados e quais exigem redefinição ou nova credencial. Exportação de clientes não contém senhas reutilizáveis. Conferir acesso real e permissões antes de considerar esse item migrado.

## 4. Homologação das integrações

| Integração | Preparação privada | Aceite mínimo |
| --- | --- | --- |
| NFS-e | Emitente, município e regime, inscrição/campos fiscais necessários, token e ambiente compatíveis. | Rascunho revisado, submissão, consulta de resultado, tratamento de timeout/estado incerto, reconciliação e cancelamento permitido pelo provedor. Guardar documento e protocolo em local privado. |
| Pix | Conta e aplicação do provedor escolhido, credenciais/certificados, configuração de consulta e conciliação. | Cobrança criada uma vez, status consultado, pagamento conciliado uma vez, valor/alocação corretos; testar rejeição e resultado incerto. Não confundir registro manual de Pix com transação bancária integrada. |
| WhatsApp | Conta Cloud API, telefone remetente, token, modelo aprovado e destinatário de ensaio autorizado. | Envio explícito único, ID externo preservado e falha reportada. O estado `accepted` não comprova entrega; o fluxo atual mantém entrega `unconfirmed`. |
| Cartão/SmartPOS | Equipamento e adquirente, quando essa capacidade for exigida. | Requer projeto de integração específico: os métodos manuais `credit`/`debit` não processam o terminal. |

Não reutilizar uma credencial do Jumpcar como se fosse uma credencial de banco, município ou Meta. Cada serviço exige a configuração própria do titular. Não marcar integração homologada com base apenas em mock ou credencial presente.

## 5. Interrupção, recuperação e decisão de entrada

Interromper a transição para uso real se houver divergência financeira inexplicada, duplicação, perda de vínculo, rejeição não resolvida de importação, permissão indevida, ausência de backup restaurável ou estado externo incerto sem reconciliação. Preservar banco e evidências; usar o procedimento de recuperação, sem editar saldos diretamente.

Até o aceite, conservar a origem disponível para conferência. Evitar duas bases recebendo lançamentos reais do mesmo atendimento sem um plano explícito de conciliação. Definir o instante de corte e conferir alterações ocorridas entre a exportação e o início do novo sistema.

A decisão de entrada registra: commit implantado, responsáveis, arquivos e hashes importados, contagens/totais conferidos, casos aprovados/reprovados, provedores efetivamente homologados, destino independente dos backups e lacunas aceitas. Funcionalidade ausente na [matriz](FEATURE-MATRIX.md) não pode ser registrada como aprovada por expectativa. A conclusão permite o escopo ensaiado, com os limites documentados.
