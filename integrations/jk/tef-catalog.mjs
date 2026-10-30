// Official documentation reviewed on 2026-10-30. Catalog entries are preparation only.
const preparationSteps = {
  'pagbank-smartpos':[
    ['partnership','Solicitar parceria comercial e conta avançada PagBank.','Contato do parceiro e autorização do ambiente de desenvolvimento.'],
    ['hardware','Confirmar modelo, Android e terminal de debug com o PagBank.','Modelo e versão conferidos no terminal autorizado.'],
    ['implementation','Desenvolver aplicativo Java ou Kotlin com PlugPag; a FAQ não permite WebApp ou WebView.','APK próprio e retorno tratado, incluindo interrupção e recusa.'],
    ['approval','Apresentar APK release, vídeo e guia do usuário para homologação.','Aprovação oficial vinculada ao pacote e assinatura do aplicativo.'],
  ],
  'stone-android':[
    ['partnership','Cadastrar a parceria e solicitar credencial de integração.','Credencial de sandbox recebida pelo canal autorizado.'],
    ['hardware','Conferir terminal e versão aceitos pelo SDK Stone.','Modelo, versão e kit compatíveis documentados.'],
    ['implementation','Implementar aplicativo nativo e testar retorno, recusa, timeout e recuperação.','Roteiro executado no ambiente de testes com referências rastreáveis.'],
    ['approval','Enviar roteiro de homologação e aguardar liberação comercial de produção.','Aprovação da Stone e aceite do responsável pela operação.'],
  ],
  'cielo-lio':[
    ['partnership','Cadastrar aplicativo e obter acessos no Dev Console Cielo.','Aplicativo e ambiente autorizados no portal.'],
    ['hardware','Confirmar modelo Smart ou LIO e disponibilidade do componente oficial.','Modelo e versão verificados no equipamento de testes.'],
    ['implementation','Implementar a camada lio:// e validar o callback; não usar SDK de hardware do fabricante.','Retorno correlacionado à ordem, com tratamento de interrupção e recuperação.'],
    ['approval','Executar o roteiro vigente da Cielo e obter autorização para distribuição.','Homologação documentada para a aplicação e equipamento.'],
  ],
  'sitef-desktop':[
    ['partnership','Obter contrato e distribuição autorizada das bibliotecas SiTef.','Termos, canal de suporte e versões permitidas registrados.'],
    ['hardware','Conferir sistema, arquitetura, pinpad e porta com o fornecedor.','Inventário da estação e pinpad confrontado com o kit contratado.'],
    ['implementation','Implementar ponte local para CliSiTefI e o fluxo interativo documentado.','Ponte autenticada e vinculada ao JK, com retorno rastreável.'],
    ['recovery','Validar confirmação, desfazimento e pendências após queda de energia.','Roteiro de recuperação e homologação aprovados pelo fornecedor.'],
  ],
  'msitef-android':[
    ['partnership','Obter contrato, aplicativo m-SiTef e parâmetros próprios do ambiente.','Empresa, servidor e transporte autorizados pelo fornecedor.'],
    ['hardware','Confirmar Android, pinpad ou APOS e versão do m-SiTef.','Compatibilidade e instalação verificadas no aparelho de testes.'],
    ['implementation','Implementar Intent e retorno Android com parâmetros próprios; não reutilizar exemplos como configuração.','Retorno correlacionado à ordem e tratamento de cancelamento e falhas.'],
    ['approval','Validar comunicação segura, recuperação e roteiro transacional aplicável.','Homologação e configuração aprovadas para o estabelecimento.'],
  ],
  'getnet-smartpos':[
    ['partnership','Cadastrar parceria no Portal Get Store e obter o kit autorizado.','Acesso ao portal e condições de uso confirmados.'],
    ['hardware','Conferir os modelos e versões Android requeridos pela Getnet.','Matriz de equipamentos suportados e terminais de testes disponíveis.'],
    ['implementation','Implementar Deep Link de pagamento e SDK de hardware obrigatório.','APK com callback, assinatura e permissões revisados conforme os requisitos oficiais.'],
    ['approval','Submeter o aplicativo ao processo de certificação e publicação Getnet.','Certificação e autorização de distribuição documentadas.'],
  ],
  'stone-desktop':[
    ['partnership','Confirmar contrato, licença e canal oficial do kit TEF Desktop.','Termos e distribuição autorizados para a operação.'],
    ['hardware','Conferir sistema da estação e pinpad na lista oficial vigente.','Modelo e compatibilidade documentados antes da instalação.'],
    ['implementation','Instalar runtime e kit oficiais em ambiente autorizado e implementar a ponte com o JK.','Versões registradas e interface local com acesso controlado.'],
    ['approval','Validar retorno, recuperação e homologação com o fornecedor.','Roteiro aprovado e aceite do estabelecimento antes de produção.'],
  ],
};
export const TEF_PROVIDERS = Object.freeze([
  {
    id:'pagbank-smartpos', label:'PagBank SmartPOS', platform:'Android', integrationMode:'SDK nativo PlugPag',
    description:'Aplicativo Android integrado ao serviço de pagamento embarcado. Exige desenvolvimento específico; selecionar não conecta o terminal.',
    requirements:['Confirmar modelo e versão do terminal PagBank.','Estabelecer parceria, obter ambiente de desenvolvimento e homologar o aplicativo.','Implementar em plataforma aceita pelo PagBank; WebApps e WebView não são permitidos pela FAQ consultada.'],
    documentationUrl:'https://developer.pagbank.com.br/docs/faq-smartpos',
    sdkUrl:'https://github.com/pagseguro/pagseguro-sdk-plugpagservicewrapper',
    licenseNote:'Distribuição oficial disponível; direitos de redistribuição e uso dependem dos termos do fornecedor. Não presumir licença livre.', connectorImplemented:false,
  },
  {
    id:'stone-android', label:'Stone Android', platform:'Android', integrationMode:'SDK Android',
    description:'Integração nativa com o SDK Stone, sujeita a credenciamento e homologação próprios.',
    requirements:['Confirmar terminal e versão suportados.','Obter credencial de integração pelo programa de parcerias.','Desenvolver e validar o roteiro de homologação antes de produção.'],
    documentationUrl:'https://sdkandroid.stone.com.br/reference/processo-de-integracao',
    sdkUrl:'https://github.com/stone-payments/demo-sdk-android',
    licenseNote:'A demonstração declara MIT; essa licença não cobre automaticamente SDK binário, credenciais ou serviço de adquirência.', connectorImplemented:false,
  },
  {
    id:'cielo-lio', label:'Cielo Smart / LIO', platform:'Android', integrationMode:'Deep Link oficial',
    description:'Comunicação com a camada oficial da Cielo para pagamentos, pedidos e impressão.',
    requirements:['Confirmar equipamento e interfaces vigentes no portal Cielo.','Cadastrar a aplicação e obter credenciais próprias de teste.','Usar a camada oficial lio://; não acessar diretamente bibliotecas do fabricante.','Validar retorno, recuperação e homologação da aplicação.'],
    documentationUrl:'https://docs.cielo.com.br/cielo-smart/docs/politica-de-integracao-camada-de-abstracao-obrigatoria',
    licenseNote:'Uso condicionado às interfaces e termos oficiais da Cielo; nenhuma biblioteca proprietária foi incorporada.', connectorImplemented:false,
  },
  {
    id:'sitef-desktop', label:'SiTef / CliSiTef', platform:'Desktop compatível a confirmar', integrationMode:'Biblioteca nativa CliSiTefI',
    description:'Automação comercial comunica-se com servidor SiTef por bibliotecas nativas. O navegador exige uma ponte compatível ainda não implementada.',
    requirements:['Confirmar sistema operacional, pinpad e distribuição compatíveis.','Obter contrato, bibliotecas e configuração autorizados do fornecedor.','Implementar o fluxo interativo pela CliSiTefI, sem chamar a CliSiTef diretamente.','Validar confirmação, desfazimento e recuperação antes de homologar.'],
    documentationUrl:'https://dev.softwareexpress.com.br/docs/clisitef/clisitef_documento_principal/',
    licenseNote:'Bibliotecas e serviço sujeitos aos termos do fornecedor; documentação pública não autoriza redistribuição irrestrita.', connectorImplemented:false,
  },
  {
    id:'msitef-android', label:'m-SiTef Android', platform:'Android', integrationMode:'Aplicativo m-SiTef / Intent',
    description:'Aplicativo oficial intermedeia funções do SiTef. Não equivale a instalar uma biblioteca no webapp.',
    requirements:['Confirmar aparelho, adquirente e ambiente SiTef compatíveis.','Obter aplicativo e parâmetros autorizados de empresa, servidor e terminal.','Implementar chamada e retorno conforme documentação oficial.','Validar fluxo transacional e homologação aplicáveis.'],
    documentationUrl:'https://dev.softwareexpress.com.br/docs/m-sitef/',
    licenseNote:'Aplicativo, bibliotecas e serviço mantêm os termos do fornecedor; exemplos não contêm credenciais utilizáveis da operação.', connectorImplemented:false,
  },
  {
    id:'getnet-smartpos', label:'Getnet Get Smart', platform:'Android', integrationMode:'Deep Link de pagamento e SDK de hardware',
    description:'Aplicativo do terminal usa interfaces oficiais de pagamento e a camada obrigatória de hardware Getnet.',
    requirements:['Cadastrar-se no Portal do Desenvolvedor Get Store.','Obter SDK e ferramentas pelo menu Downloads oficial.','Atender aos modelos e versões Android exigidos pela documentação vigente.','Implementar SDK de hardware obrigatório e submeter a aplicação à certificação.'],
    documentationUrl:'https://getstore.getnet.com.br/docs/',
    licenseNote:'Downloads oficiais pelo portal do parceiro; não foi verificada licença geral para redistribuir APK/AAR no projeto.', connectorImplemented:false,
  },
  {
    id:'stone-desktop', label:'Stone TEF Desktop', platform:'Desktop compatível a confirmar', integrationMode:'Runtime e API Desktop',
    description:'Kit oficial com runtime e instalador. Compatibilidade com a estação e conector web ainda precisam ser implementados e validados.',
    requirements:['Confirmar sistema operacional, equipamento e contrato aplicáveis.','Obter runtime e instalador pelo canal oficial.','Implementar a interface documentada e recuperação de transações.','Validar licença, credenciamento e homologação antes de uso.'],
    documentationUrl:'https://tefdoc.stone.com.br/docs/download-instalador-e-release-notes',
    licenseNote:'Instaladores sujeitos aos termos do fornecedor; não foram baixados nem redistribuídos.', connectorImplemented:false,
  },
].map(provider => Object.freeze({...provider,reviewedAt:'2026-10-30',requirements:Object.freeze(provider.requirements),preparationSteps:Object.freeze(preparationSteps[provider.id].map(([id,action,evidence])=>Object.freeze({id,action,evidence})))})));
