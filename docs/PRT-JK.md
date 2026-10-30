# PRT — Plano de requisitos técnicos do AB-JK-UASH

**Revisão:** 30/10/2026. **Versão de referência:** `0.1.1`. **0.1.1 publicada; implantação e aceite operacional possuem registro privado entregue ao titular.** Este documento especifica requisitos e contratos técnicos gerais, complementando o [PRD](PRD-JK.md), a [arquitetura](ARCHITECTURE.md) e a [matriz](FEATURE-MATRIX.md). A [release pública](RELEASE-0.1.1.md) registra escopo e validação sintética. [VALIDATION-JK.md](VALIDATION-JK.md) preserva evidências históricas de 28–29/10; identificadores, configuração e observações do ambiente real não são publicados aqui.

## 1. Base técnica e fronteiras

| Camada | Implementação e requisito |
| --- | --- |
| Frontend | React/TypeScript, Vite e `@react-spectrum/s2`, com versões e integridades do manifesto/lock raiz. Landing sem login em `/`, operação autenticada em `/app` e rotas por hash. Disponibilidade e acesso de uma instalação concreta são objeto de aceite privado. |
| Runtime | Node.js 24 conforme `engines`; servidor HTTP nativo em `server/application.mjs`. O browser chama somente `/api` da mesma origem. |
| Dados locais | SQLite via `node:sqlite`, privado, persistente, com transações e migrações do produto JK. O banco da aplicação de origem não pode ser reutilizado sem migração compatível. |
| PostgreSQL | Store alternativo de backend via `pg`, com schema/privilégios preparados pela implantação; não deve existir conexão direta do browser ao banco. Migração Jumpcar continua restrita ao perfil local. |
| Provedores | Adaptadores opcionais fiscal, Pix e WhatsApp, configurados no servidor. Ausência ou falha de configuração mantém efeito externo bloqueado. |
| Mídia | Autoria em `design/`; somente HTML/MP4/poster necessários são servidos. Python, modelos, renderizadores e executáveis de autoria não pertencem ao runtime operacional. |
| Distribuição | Código público separado de banco, uploads, exportações, backups, configuração e segredos reais. Ambiente de implantação usa volume privado próprio. |

Fontes: [package.json](../package.json), [vite.config.ts](../vite.config.ts), [application](../server/application.mjs), [store](../server/db.mjs), [arquitetura](ARCHITECTURE.md), [proveniência](../PROVENANCE.md).

A instalação representa uma empresa. Não existe `tenantId` que separe filiais/clientes empresariais na base. Uma implantação compartilhada entre negócios exige nova modelagem de isolamento e testes próprios; múltiplos usuários não satisfazem esse requisito.

## 2. Modelo de domínio e invariantes

| Grupo de dados | Invariante obrigatório | Fonte principal |
| --- | --- | --- |
| Clientes, veículos e catálogo | Veículo pertence ao cliente; placa/SKU respeitam unicidade; desativação preserva referências históricas | [domain-core](../server/domain-core.mjs) |
| OS e itens | Pelo menos um serviço; valores/preços/duração/comissão capturados no item; totais reconciliados; transições autorizadas | [domain-orders](../server/domain-orders.mjs) |
| Agenda e transporte | Um responsável não ocupa tarefas conflitantes; conversão agenda→OS não duplica atendimento; devolução respeita situação/saldo da OS | [domain-orders](../server/domain-orders.mjs), [jk-deliveries](../server/jk-deliveries.mjs) |
| Estoque | Quantidade em milésimos; consumo não gera saldo negativo; reversão referencia e devolve o movimento uma única vez | [domain-finance](../server/domain-finance.mjs) |
| Pagamentos e caixa | Pagamento/alocação/auditoria atômicos; valor até saldo; dinheiro exige caixa aberto; meios digitais não aumentam caixa físico | [domain-finance](../server/domain-finance.mjs) |
| Fatura pós-paga | OS do mesmo cliente habilitado; saldo elegível; nenhuma dupla fatura ativa; recebimento distribuído atomicamente | [domain-finance](../server/domain-finance.mjs) |
| Pacotes | Cliente, serviço, validade e crédito conferidos; venda é receita; resgate não cria a mesma receita novamente | [domain-finance](../server/domain-finance.mjs) |
| Comissão e folha | OS entregue e quitada; comissão capturada na OS e reservada uma vez; pagamento de folha não se repete | [domain-office](../server/domain-office.mjs) |
| Fiscal / integração | Preparação, tentativa e resultado distinguíveis; resposta ambígua não autoriza reenvio cego | [fiscal](../server/fiscal.mjs), [jk-integrations](../server/jk-integrations.mjs) |
| Histórico migrado | Não aciona operação, caixa, comissão, estoque, nota ou mensagem atual; identidade de origem permanece rastreável | [jk-migration](../server/jk-migration.mjs) |

Valores monetários são inteiros em centavos; percentuais usam basis points e estoque usa milésimos. Instantes são ISO UTC; datas sem horário têm formato `YYYY-MM-DD`. A interface usa BRL, português e `America/Sao_Paulo` para a rotina implementada. Agregações e conversões precisam preservar unidades e rejeitar números inválidos; floats não devem ser tratados como centavos finais. [Contrato](../server/CONTRACT.md), [api.ts](../src/lib/api.ts).

As transições finais de OS não reabrem ordens entregues/canceladas. Cancelamento não é mecanismo de estorno financeiro. Uma mudança que altere essas invariantes exige contrato, migração de dados quando aplicável e testes de concorrência/efeitos financeiros; não basta alterar os botões da tela.

## 3. Contrato HTTP, concorrência e repetição

O prefixo do produto é `/api`, sem substituir implicitamente pelo `/api/v1` de outra versão do AB-UASH. Sucesso e falha seguem os envelopes `{ok:true,data:...}` e `{ok:false,error:{...}}`. Listas devolvem `items` e informação de paginação; entidades usam `item`, com exceções contratuais de autenticação/relatórios. IDs, versões e erros devem manter compatibilidade com os consumidores. [Contrato principal](../server/CONTRACT.md), [SDK/OpenAPI](api/README.md).

Mutações exigem sessão/CSRF e as ações protegidas exigem papel vivo dentro da transação. A versão esperada evita sobrescrever atualização concorrente. Uma chave idempotente corresponde à mesma intenção e payload; reutilizá-la com outro conteúdo deve falhar. Replays não dispensam autorização atual. O cliente reutiliza a chave após falha de rede até o payload ter resultado conhecido e bloqueia chamadas simultâneas do mesmo formulário. [security](../server/security.mjs), [useMutation](../src/lib/api.ts), [testes de segurança](../tests/security-review.test.mjs).

Requisitos de integração de API:

- A atualização de filtro deve reiniciar a paginação antes de enviar a consulta; o cliente não presume que a primeira página contém todos os registros.
- Toda falha de consulta deve permanecer erro. Não converter falha em lista vazia, caixa fechado, conta inexistente ou suporte confirmado.
- Um formulário que depende de dados existentes não deve enviar uma reconstrução vazia quando a consulta falhar.
- Transação SQL não permanece aberta durante chamada externa. A intenção/lease é persistida antes do I/O; resposta tardia só pode concluir a tentativa que ainda detém o lease válido.
- Mudança de contrato deve atualizar SDK/testes quando o endpoint pertencer ao contrato principal. Extensões JK têm contratos próprios; não presumir cobertura automática no SDK herdado.

Fontes: [api.ts](../src/lib/api.ts), [ui-review](../tests/ui-review-20261021.test.mjs), [ponte JK](../integrations/jk/README.md).

## 4. Autenticação, autorização e segredos

O núcleo usa derivação scrypt para senhas e tokens aleatórios de sessão com hash persistido. Cookies usam `HttpOnly` e `SameSite=Strict`, com `Secure` conforme implantação. A validade absoluta descrita pela arquitetura é de oito horas. Há limitação persistida de tentativas de login e revalidação do usuário ativo. [security.mjs](../server/security.mjs), [arquitetura](ARCHITECTURE.md#api-autenticação-e-autorização).

O primeiro acesso não deve criar senha conhecida. Bootstrap autorizado recebe dados pelo canal privado previsto; credenciais não devem aparecer em argumentos, README, logs, teste público, vídeo ou captura. Exemplos usam placeholders e identidades sintéticas. Remover um arquivo do estado atual não elimina vazamento do histórico Git: a revisão de publicação precisa considerar o histórico e os artefatos distribuídos. [Operação](operations-jk.md), [bootstrap](../scripts/jk-bootstrap-admin.mjs).

Configuração de provedor fica no servidor. A ponte JK restringe os caminhos de segredos ao diretório configurado, rejeita symlinks e aplica limites/permissões. O transporte preservado limita hosts/protocolos e rejeita redirecionamentos/retry de mutações. A API e logs não devem ecoar tokens, certificados, payloads brutos ou exceções de transporte com conteúdo privado. [Contrato de configuração](../integrations/jk/README.md#configuração-do-servidor).

Critério de aceite: demonstrar negação de acesso por papel, usuário revogado, ausência de CSRF, versão conflitante e replay sem autorização; verificar respostas e logs sanitizados. A presença dessas medidas não equivale a auditoria de segurança completa ou certificação de conformidade.

## 5. Migração Jumpcar

O importador é exclusivo de administrador e SQLite local. A UI consulta `GET /api/jk/migration/status` antes de oferecer arquivos. `supported:false`, erro de consulta e carregamento são estados distintos; uma resposta em cache não mantém ações liberadas após falha de atualização. Histórico/preview/commit não devem ser oferecidos como operacionais num perfil sem suporte. [MigrationPage](../src/pages/MigrationPage.tsx), [regressão UI](../tests/ui-jk-flows.test.mjs).

| Entrada / etapa | Contrato técnico |
| --- | --- |
| Formatos | Um dataset JSON canônico ou arquivos CSV/HTML tabular. `.xls` textual pode ser identificado pelo conteúdo; XLS binário e XLSX não são interpretados. |
| Limites | 8 MiB, até 20.000 registros e até seis arquivos por lote, um por coleção; veículos extraídos da tabela nativa contam no limite. |
| Coleções | `customers`, `vehicles`, `services`, `orders`, `orderItems`, `payments`. Credenciais, usuários, anexos, produtos, despesas e documentos fiscais autorizados não fazem parte do contrato. |
| Prévia | Valida esquema, referências, identidades e totais; não grava operação, lote ou arquivo temporário de dados; retorna contagens, pendências, avisos e hash. |
| Aprovação | Mesmo conteúdo e `previewHash`; alteração relevante de entrada/destino exige nova prévia. A confirmação é atômica, sem importação parcial de lote rejeitado. |
| Replay | Reaplicação do mesmo lote retorna o resultado existente sem duplicar os efeitos. Conteúdo diferente para a mesma chave é conflito. |
| Histórico | Clientes/veículos/serviços alimentam cadastros; OS/itens/pagamentos ficam em `jk_history_*`. `sourceRows` é consulta autenticada de evidência privada. |
| Snapshot nativo | Ausência de IDs é declarada; identidade técnica por conteúdo/linha não é apresentada como ID Jumpcar. Outro snapshot requer reconciliação, sem deduplicação automática por nome, telefone ou e-mail. |

Fonte e detalhes de campos/erros: [migration-jk.md](migration-jk.md), [parser](../server/jk-migration-parse.mjs), [domínio](../server/jk-migration.mjs).

Para lotes grandes, preservar grupos coerentes de OS, itens e pagamentos conforme o contrato. Uma exportação nativa sem IDs não pode ser cortada arbitrariamente em snapshots independentes. O limite técnico não autoriza perder linhas ou mudar a identidade silenciosamente. Prévia aprovada prova a coerência do material recebido, não a completude da exportação de origem.

Aceite real exige manifesto privado dos arquivos autorizados, reconciliação de contagens/valores/vínculos, revisão dos avisos e backup/rollback. Publicar somente evidências agregadas sanitizadas; não incluir amostras reais para tornar um teste reproduzível.

## 6. Integrações externas e validade do resultado

### Fiscal

O fluxo Focus NFe/gateway usa rascunho imutável da OS, dados do tomador/prestador, classificação fiscal e revisão explícita. Enviar e reconciliar exigem configuração/ambiente apropriados. O produto deve distinguir `prepared`, `pending`, `uncertain`, rejeição e autorização real conforme o contrato existente. Não inferir regime, código municipal, alíquota ou certificado a partir do nome do serviço. [FiscalPage](../src/pages/FiscalPage.tsx), [fiscal](../server/fiscal.mjs), [adaptador](../integrations/fiscal/index.mjs).

Cancelamento local de rascunho não cancela nota autorizada. XML/DANFSe e retenção de documentos seguem o fluxo do provedor e o procedimento definido pelo responsável. Antes de operar, validar emitente, tomador, município, ambiente e casos de retorno com a equipe fiscal. Este documento não declara adequação tributária ou homologação universal.

### Pix

A ponte prepara cobrança a partir do saldo/versão da OS, vincula conta/provedor/ambiente e envia por ação explícita. Criar uma cobrança ou receber status `active` não quita a OS. Somente evidência autenticada elegível de produção, com valor, referência, comprovantes únicos e saldo atual correspondentes, autoriza a baixa atômica. Homologação, divergência, parcialidade, devolução ou pagamento concorrente exigem tratamento específico sem baixa fictícia. [Contrato Pix](../integrations/jk/README.md#evidências-e-baixa-pix).

Não há webhook nem conciliação em background. Timeout mantém estado incerto e exige consulta; trocar configuração não deve transferir uma preparação silenciosamente para outra conta/ambiente. O aceite depende de credenciais/certificado corretos e testes autorizados no PSP escolhido.

### WhatsApp

O fluxo utiliza modelo/parâmetros e destinatário do cliente da OS, com confirmação de consentimento registrada na preparação. `accepted` significa aceitação pelo provedor, enquanto entrega permanece `unconfirmed`. Não há webhook de entrega, aprovação automática de modelo, campanha ou reenvio automático. A fila `messages` legada continua local. [Contrato WhatsApp](../integrations/jk/README.md#whatsapp-e-fiscal).

Readiness dos três conectores é informação de configuração; não é teste de credenciais. O startup não deve fazer efeitos externos. Fixtures de transporte não demonstram sucesso em conta real.

## 7. Interface, documentos, imagens e mídia

Spectrum 2 deve manter `Provider`, locale e configuração de macros coerentes com a versão fixada. Elementos personalizados precisam de rótulo/nome acessível, foco visível, navegação por teclado e mensagens de erro. O CSS local não deve eliminar os estados semânticos da biblioteca. Referências oficiais: [Getting started](https://react-spectrum.adobe.com/getting-started), [Provider](https://react-spectrum.adobe.com/Provider), [Styling](https://react-spectrum.adobe.com/styling).

Os testes de DOM emulado verificam comportamento/HTTP, mas não geometria real, impressão, fidelidade visual ou toda interação assistiva. Testar os tamanhos de tela e dispositivos da JK, além do fluxo de teclado. O carregamento lazy deve tratar falha de chunk com recuperação compreensível. [RootApp](../src/RootApp.tsx), [ui-helpers](../tests/ui-helpers.mjs), [REVIEW-JK](REVIEW-JK.md).

Fotos de OS são autenticadas, JPEG/PNG, com limites de oito por OS, 1,5 MiB por arquivo, 16 MP e até 8192 por dimensão. Os endpoints validam conteúdo, autorização e situação da OS. OCR local é sugestão revisável; não consulta proprietário e não oferece acurácia comprovada para todas as fotos reais. [media.mjs](../server/media.mjs), [OCR](../src/features/ocr/PlateReader.tsx).

Recibos/faturas são HTML de impressão com indicação não fiscal. `window.print()` oferece o diálogo do navegador; não constitui API de PDF ou envio automático. CSV deve proteger texto não confiável contra interpretação de fórmula. [InvoicesPage](../src/pages/InvoicesPage.tsx), [OrderDetailPage](../src/pages/OrderDetailPage.tsx), [csv.ts](../src/lib/csv.ts).

A ajuda usa vídeo nativo voluntário, controles, áudio inicialmente desativado e alternativa textual/diagrama. As quatro referências de mídia são ferramentas de autoria; Earshot não é serviço de transcrição/atendimento de voz. Preservar licenças e a distinção MIT/código versus GPL/wheels nativas do ManimGX se a distribuição mudar. [DESIGN-MEDIA.md](DESIGN-MEDIA.md).

## 8. Dados pessoais e limites de conformidade

| Categoria | Tratamento técnico exigido |
| --- | --- |
| Clientes, contatos e placas | Acesso autenticado por função, campos necessários à operação, exportações privadas e correção controlada |
| Fotos e observações | Armazenamento autenticado, limites de conteúdo/tamanho e ausência de publicação acidental na LP |
| Fiscal e pagamentos | Payloads privados, logs sanitizados e uso restrito ao fluxo/configuração revisados |
| Mensageria | Destinatário/parâmetros privados, consentimento confirmado no fluxo e sem envio automático presumido |
| Credenciais e certificados | Somente servidor/armazenamento privado, fora do bundle, repositório e argumentos/logs |
| Backups e evidências | Mesmo nível de proteção da base original; testes públicos com fixtures sintéticas |

Não existe certificação de LGPD decorrente desses mecanismos. Antes da operação, o responsável deve definir finalidade, acesso, retenção, atendimento a solicitações, recuperação/incidentes e responsabilidades com provedores. Não foi implementado um programa completo de privacidade apenas por existir RBAC. Evidências técnicas, decisão operacional e avaliação de conformidade são registros distintos.

## 9. Implantação, backup e recuperação

O perfil JK de destino é `compose.yaml`; os perfis herdados têm requisitos diferentes e não devem ser usados por semelhança de nome. O volume privado deve sobreviver à substituição da imagem. A configuração real, conta administrativa e segredos permanecem fora do código público. Os procedimentos de instalação, atualização e rollback estão em [operations-jk.md](operations-jk.md).

Saúde de processo, prontidão de banco e readiness de conectores têm significados distintos. LP renderizada, processo vivo ou build aprovado não comprovam base persistente nem emissão/baixa reais. Verificar `/api/health`, `/api/ready` e o contrato de readiness como camadas separadas. [healthcheck](../scripts/healthcheck.mjs), [integrações](../integrations/jk/README.md).

Backup precisa ser consistente, ter manifesto/verificação e restauração de prova. Preservar banco, mídia e configuração/segredos pelo procedimento apropriado. A rotina SQLite não configura recuperação PostgreSQL hospedada. Uma cópia no mesmo host não satisfaz por si só a recuperação após perda do host; definir destino externo e acesso. RPO/RTO precisam ser acordados e medidos, não inferidos da existência do script. [Backup](../scripts/backup.mjs), [restore](../scripts/restore.mjs), [operação](operations-jk.md).

## 10. Validação e critérios de saída

| Área | Gate técnico | Evidência de teste disponível |
| --- | --- | --- |
| Build e contrato | SDK, tipos e build da revisão final sem falhas; contrato coerente com consumidores | Scripts do [manifesto](../package.json), `sdk-contract.test.mjs`, `sdk-types.test.mjs` |
| Domínio | Saldos, crédito, estoque, comissão, versões, replay e concorrência sem efeitos duplicados | `domain.test.mjs`, `security-review.test.mjs`, `final-review-20261021.test.mjs` |
| Autenticação/HTTP | CSRF, papéis vivos, revogação, limitação de login e erros sanitizados | `backend.test.mjs`, `backend-review-20261021.test.mjs`, `security-review.test.mjs` |
| Migração | Prévia sem escrita, hash, rejeições, atomicidade/replay e ausência de efeitos operacionais históricos | `jk-migration.test.mjs`, `ui-jk-flows.test.mjs` |
| UI | Fluxo compilado sobre HTTP real, estado pendente, falha de leitura, paginação e suporte de migração | `ui-integration.test.mjs`, `ui-review-20261021.test.mjs`, `ui-jk-flows.test.mjs` |
| Fiscal/Pix/WhatsApp | Configuração bloqueada, estados incertos, consulta e baixa apenas por evidência elegível | `fiscal*.test.mjs`, `jk-integrations*.test.mjs`; homologação real separada |
| Transporte | Vínculo, conflito, versões, estados e conclusão coerente com a OS | `jk-deliveries.test.mjs` |
| Recuperação | Backup, restauração e persistência após reinício no perfil adotado | `backup-review-20261021.test.mjs`, `storage.test.mjs`, testes de infraestrutura |
| Dados públicos | Ausência de segredos/dados reais nos arquivos, histórico e artefatos destinados à publicação | Revisão específica do pacote/repositório; não substituída por lint/build |
| Equipamentos | Layout/foco/impressão/OCR na configuração da JK | Roteiro manual e evidência do ambiente real, ainda distintos de DOM emulado |

As suítes UI importam o bundle em `dist`; executar depois do build atualizado e com o runtime de QA disponível. Um teste pulado deve permanecer identificado como não executado. Relatórios de rodada anterior, respostas de fixtures e recibos de autoria não devem ser renomeados como prova da revisão final.

Nenhum resultado numérico de performance, acurácia, disponibilidade ou contagem de testes aprovados é presumido aqui. Cada execução deve registrar revisão, comando, ambiente, data, resultado e skips no fechamento.

## 11. Critérios técnicos para o aceite operacional

1. Validar acesso seguro, provisionamento autorizado, autenticação, persistência e restauração na instalação adotada. Registrar configuração, resultados, responsáveis e limitações somente no relatório operacional privado.
2. Obter exportações autorizadas completas e reconciliar a migração real em ambiente privado. Suporte técnico do parser não comprova a completude ou a correção do material de origem.
3. Configurar e homologar somente provedores efetivamente adotados, com responsável fiscal/financeiro e evidências de ambiente/conta corretos.
4. Executar QA de tela, teclado, impressão e OCR no equipamento JK, registrando limitações e correções necessárias.
5. Definir procedimentos de privacidade, retenção e recuperação; não apresentar mecanismos técnicos como certificado LGPD.
6. Implementar ou aceitar explicitamente as lacunas de paridade da [matriz](FEATURE-MATRIX.md). Multiunidade, offline sincronizado, SmartPOS, loja, CRM e outros módulos ausentes exigem desenvolvimento; não se resolvem por configuração.

O aceite deve manter responsável, evidência exigida e estado no registro privado entregue ao titular. Este PRT define critérios públicos de avaliação; não divulga o resultado de uma instalação real nem emite uma declaração de “zero bloqueios”.
