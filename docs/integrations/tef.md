# TEF e SmartPOS — preparação de implantação

Revisão das fontes públicas em 30/10/2026. Sete famílias podem ser salvas para preparação simultânea, sem escolher uma conta nem informar credenciais agora. **Nenhum conector TEF/SmartPOS do JK está implementado; conexão e homologação física não foram verificadas.** Não há cobrança, estorno, confirmação transacional, detecção de máquina, pareamento ou instalação automática nesta central.

O catálogo e os roteiros são código próprio. Não foram extraídos APK, AAR, DLL ou outros binários proprietários do Jumpcar. Documentação pública e licença de um exemplo não concedem, por si, licença de distribuição do SDK comercial.

## Ferramentas na central

- Busca no catálogo por fornecedor, plataforma ou modalidade; preparação salva por administrador e consultável por gestor.
- Roteiro expansível de cada família com ação e evidência esperada. Copiar roteiro inclui somente instruções estáticas e fonte oficial, sem modelo, observações, credenciais ou dados de clientes.
- **Conferir preparação local** consulta o plano salvo e informa fornecedor não escolhido, modelo ausente ou conector pendente. A presença de um modelo é declaração do operador, não comprovação de compatibilidade.
- Seis roteiros gerais com busca para Pix Asaas, Pix Efí/Inter, WhatsApp, fiscal, cartões e migração. Os roteiros não alteram configurações nem marcam homologação concluída.

A conferência informa a versão do plano observado. Alterar a preparação limpa o diagnóstico exibido. A verificação não abre arquivos de segredo, executa comandos, sonda portas, verifica contrato ou acessa servidor do fornecedor. Ela não serve como teste de funcionamento do terminal.

## Etapas por família

Cada linha abaixo complementa o passo a passo detalhado no catálogo. Os kits e versões devem ser confirmados com o fornecedor antes de desenvolver ou instalar.

| Família | Dependência e interface | Sequência a conferir | Evidência de liberação |
| --- | --- | --- | --- |
| PagBank SmartPOS | Terminal autorizado; SDK PlugPag em aplicativo Java/Kotlin. A FAQ consultada não permite WebApps/WebView. | Parceria e conta avançada → terminal de debug → aplicativo próprio e tratamento de retorno → envio do pacote para homologação. | Aprovação vinculada ao aplicativo, pacote e assinatura. A FAQ informa prazo de homologação de até sete dias úteis: o fim de semana de testes não garante liberação para 02/11. |
| Stone Android | Equipamento e SDK Stone compatíveis; credencial do programa de parceiros. | Credenciamento → sandbox → retorno, recusa, timeout e recuperação → roteiro oficial. | Aceite da homologação e liberação de produção pela Stone. A demonstração MIT não abrange automaticamente binários e serviço comercial. |
| Cielo Smart/LIO | Camada oficial de abstração; Deep Link `lio://` para pagamentos/pedidos/impressão. | Cadastro no portal → terminal de teste → callback e recuperação → homologação vigente. | Aprovação da aplicação e equipamento. A política proíbe SDK ou biblioteca de hardware do fabricante; usar somente a interface oficial aplicável. |
| SiTef/CliSiTef | Distribuição licenciada, sistema/arquitetura e pinpad compatíveis; ponte local ainda ausente. | Contrato e kit → inventário de estação/pinpad → integração interativa pela CliSiTefI → confirmação, desfazimento e recuperação. | Roteiro de recuperação e homologação aprovado. Não chamar a CliSiTef diretamente; a interface pública é a CliSiTefI. |
| m-SiTef Android | Aplicativo oficial, terminal/APOS ou pinpad compatível e ambiente autorizado. | Contrato e parâmetros próprios → instalação autorizada → Intent e retorno Android → transporte seguro e homologação. | Evidências correlacionadas à ordem e aceite do fornecedor. Parâmetros ilustrativos dos exemplos não são configuração real. |
| Getnet Get Smart | Portal Get Store, terminais compatíveis e SDK de hardware obrigatório, além do Deep Link de pagamento. | Parceria e kit → matriz de modelos/Android → APK e callback com permissões/assinatura → certificação. | Certificação e autorização de distribuição. Conferir requisitos atuais, sem presumir permissão geral para redistribuir AAR/APK. |
| Stone TEF Desktop | Contrato, runtime e instalador oficiais; estação/pinpad compatíveis; ponte web ainda ausente. | Licença e kit → compatibilidade → instalação autorizada e desenvolvimento → retorno, recuperação e homologação. | Aceite do fornecedor e do estabelecimento. O instalador público não prova licença livre, compatibilidade com o Mac ou funcionamento no JK. |

## Contrato local

| Método/caminho | Acesso | Resultado |
| --- | --- | --- |
| `GET /api/jk/tef/catalog` | Administrador ou gestor, função atual revalidada | Catálogo com `connectorImplemented:false`, data de revisão e etapas `id/action/evidence`. |
| `GET /api/jk/tef/plan` | Administrador ou gestor | Plano versionado, famílias selecionadas e informações opcionais do equipamento. |
| `PATCH /api/jk/tef/plan` | Administrador atual, CSRF e idempotência | Salva/retira preparações; conflito de versão retorna 409. Funciona no modo de consulta paralela. |
| `GET /api/jk/tef/diagnostics` | Administrador ou gestor | Somente leitura: versão do plano, quantidade selecionada e lacunas por família. Nenhuma operação financeira. |

O diagnóstico retorna `localOnly:true`, `networkAttempted:false`, `hardwareInspected:false`, `canSubmit:false`, `connectionVerified:false` e `homologated:false`. Não retorna o conteúdo de modelo ou observações. Seus estados por família são `not_selected`, `terminal_model_missing` e `connector_missing`. Nenhum deles permite cobrança. Plano inválido armazenado falha fechado com 503; gestor não pode salvar, operador/leitor não podem consultar esta preparação.

## Fim de semana e migração

Em **31/10**, listar contratos, equipamentos e responsáveis e registrar as lacunas; conferir os dados locais sem acionar adquirentes. Em **01/11**, os testes físicos só poderão ser planejados com conector próprio, kit, ambiente autorizado e roteiro do fornecedor disponíveis. A data pretendida de **02/11** não elimina homologação, prazo comercial ou dependência de hardware. Se um conector continuar ausente, a respectiva cobrança integrada continua indisponível.

Os demais guias técnicos são [Asaas](asaas.md), [WhatsApp/Baileys](whatsapp-baileys.md) e [prontidão da migração](../migration/readiness.md). A ativação de qualquer integração exige evidências próprias; a conferência TEF não valida Pix, mensagens, fiscal, restauração de backup nem corte operacional.

## Revisão dos projetos citados

| Projeto primário | Oportunidade analisada | Decisão nesta entrega |
| --- | --- | --- |
| [Gumroad](https://github.com/antiwork/gumroad), [licença MIT](https://github.com/antiwork/gumroad/blob/main/LICENSE.md) | Separar estado de configuração de resultado efetivo de pagamento. | Usar distinção explícita de estados nos guias e diagnóstico; não incorporar Rails, checkout, código ou dependências do projeto. Não oferece driver de SmartPOS brasileiro. |
| [YouPI-PG](https://github.com/youpi-pg/YouPI-PG) | O README distingue observação de pagamento e conciliação e descreve deduplicação de entregas. O projeto usa contas UPI indianas. | Manter observação/configuração separadas de quitação e homologação. O link `LICENSE` do README retornou 404 na revisão: licença não verificável, nenhum código copiado. Alertas SMS/Gmail e a fila por valor não substituem evidência autenticada de Pix/TEF no JK. |
| [Securo](https://github.com/securo-finance/securo), [licença AGPL-3.0](https://github.com/securo-finance/securo/blob/main/LICENSE) | Estado de configuração bancária e importação são separados de conexão e aceitação do provedor. | Adotar orientação própria por etapa e evidência; não incorporar serviço, conectores ou código AGPL. Sincronização bancária é outra capacidade, sem prova de suporte TEF. |

Esses projetos foram consultados como referências, sem executar scripts de instalação. As decisões são inferências de adequação ao JK, não alegações de equivalência entre seus produtos.

### Gumroad: comparação com módulos de código

Snapshot consultado pelo conector GitHub: [`161e9294068ae955ff9fb9a84a42a32809a040c2`](https://github.com/antiwork/gumroad/commit/161e9294068ae955ff9fb9a84a42a32809a040c2), revisão de 30/10/2026. A [licença MIT nesse snapshot](https://github.com/antiwork/gumroad/blob/161e9294068ae955ff9fb9a84a42a32809a040c2/LICENSE.md) permite avaliar reutilização com atribuição, mas nenhum trecho Rails ou dependência Gumroad foi incorporado.

| Módulo observado | Comparação com o código JK | Aplicação e limite |
| --- | --- | --- |
| [Entrada de webhooks](https://github.com/antiwork/gumroad/blob/161e9294068ae955ff9fb9a84a42a32809a040c2/app/controllers/foreign_webhooks_controller.rb) | A entrada Stripe valida a assinatura sobre o corpo bruto antes de enfileirar. Falha de transporte Redis devolve 503 para permitir reentrega, evitando confirmar evento descartado. No JK, `integrations/jk/asaas-webhook.mjs` valida o token específico do Asaas, conta, tipo/tamanho e esquema; persiste uma caixa de entrada com identidade por ambiente/conta/evento e rejeita conteúdo conflitante no mesmo ID. Falha de persistência também retorna 503. | Preservado o princípio de reconhecer somente o que foi guardado e autenticado. Não copiar assinatura Stripe para Asaas: os protocolos são diferentes. A notificação Asaas é pista para consulta, não comprovante que quita a ordem. Falta validar publicamente o endpoint com o Asaas e executar a rotina operacional de conciliação; nenhum worker de consumo automático foi acrescentado. |
| [Finalização de pagamento confirmado](https://github.com/antiwork/gumroad/blob/161e9294068ae955ff9fb9a84a42a32809a040c2/app/services/purchase/finalize_confirmed_charge_service.rb) | Gumroad recebe um PaymentIntent já consultado, serializa por registro, trata repetição como operação sem novo efeito e distingue processamento de sucesso. Quando o provedor capturou e a finalização local falha, mantém situação recuperável, sem oferecer nova cobrança. No JK, `server/jk-integrations.mjs` registra uma única tentativa, usa lease, consulta o mesmo provedor/conta/ambiente e valida ordem/valor/comprovantes antes de uma baixa SQL atômica. `server/db.mjs` rejeita reutilização de chave com corpo diferente. | A convergência conceitual já existia; os guias a tornam visível e o diagnóstico TEF mantém o estado pendente. Não foi copiado o bloqueio Rails em torno da chamada externa: o JK mantém I/O fora da transação. Ainda falta evidência real de recuperação com cada provedor/terminal. Retry de webhook não autoriza retry de cobrança incerta. |
| [Política base](https://github.com/antiwork/gumroad/blob/161e9294068ae955ff9fb9a84a42a32809a040c2/app/policies/application_policy.rb) e [política de compras](https://github.com/antiwork/gumroad/blob/161e9294068ae955ff9fb9a84a42a32809a040c2/app/policies/purchase_policy.rb) | A base recusa usuário ausente por padrão; operações da biblioteca exigem o papel de proprietário do vendedor. O domínio JK tem papéis da operação, não vendedores de marketplace: usa `requireRole` e `requireLiveRole`, inclusive antes de devolver replay idempotente. A preparação TEF permite salvar somente ao administrador e consultar ao administrador/gestor atuais. | A regra aproveitada é autorizar no servidor pela ação concreta, sem confiar no botão visível ou em uma sessão com papel antigo. Os testes TEF rebaixam a função entre chamadas e verificam a recusa. Não criar papéis de vendedor, checkout, OAuth de marketplace ou novas permissões sem necessidade do JK. |

As referências confirmam padrões de recuperação, autorização e estado, não tornam o JK equivalente ao Gumroad nem fornecem TEF/SmartPOS. A entrega própria desta rodada é o roteiro com evidência por família, os seis guias buscáveis e o diagnóstico local que nunca se apresenta como teste de adquirência.

## Fontes primárias

- [PagBank: FAQ e condições SmartPOS](https://developer.pagbank.com.br/docs/faq-smartpos) e [SDK oficial](https://github.com/pagseguro/pagseguro-sdk-plugpagservicewrapper).
- [Stone Android: integração, homologação e produção](https://sdkandroid.stone.com.br/reference/processo-de-integracao) e [demonstração oficial](https://github.com/stone-payments/demo-sdk-android).
- [Cielo: política obrigatória de integração](https://docs.cielo.com.br/cielo-smart/docs/politica-de-integracao-camada-de-abstracao-obrigatoria).
- [SiTef: especificação principal](https://dev.softwareexpress.com.br/docs/clisitef/clisitef_documento_principal/) e [versão indexada oficial consultada](https://dev.softwareexpress.com.br/es/docs/clisitef/clisitef_documento_principal/). O acesso direto à rota portuguesa retornou 502 na revisão; as restrições de CliSiTefI/recuperação foram conferidas na página oficial indexada.
- [m-SiTef: guia oficial](https://dev.softwareexpress.com.br/docs/m-sitef/) e [integração com outro aplicativo](https://dev.softwareexpress.com.br/docs/m-sitef/introducao_integracao_outro_app/). A rota principal também apresentou 502 no acesso direto, com conteúdo disponível no índice de busca oficial.
- [Getnet: requisitos atuais](https://getstore.getnet.com.br/docs/iniciando-integracao/requisitos-desenvolvimento/) e [SDK de hardware](https://getstore.getnet.com.br/docs/integracao-hardware/configuracao-sdk/).
- [Stone Desktop: runtime e instaladores](https://tefdoc.stone.com.br/docs/download-instalador-e-release-notes) e [dispositivos suportados](https://tefdoc.stone.com.br/docs/dispositivos-suportados).

## Verificação e limites

Os testes de catálogo/HTTP verificam sete roteiros, permissões atuais, idempotência/concorrência do plano, plano inválido, diagnóstico privado e nenhuma gravação em pagamentos, movimentos de caixa ou registros de integração. O teste de interface exercita preparação de vários fornecedores, diagnóstico, persistência, conflito e acesso de gestor em DOM emulado. Os resultados desta rodada ficam fora do repositório, em `../preparacao-jk-2026-10-30/tef/`.

Esses testes locais não validam máquina física, driver/SDK proprietário, contrato, rede de adquirência, homologação ou produção. Nenhum fornecedor foi ativado.
