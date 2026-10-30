# AB-JK-UASH · Lava Rápido JK

Cliente independente do AB-UASH para a operação do Lava Rápido JK, em Rio Verde (GO). Landing page sem login em `/` e gestão autenticada em `/app`, com React, TypeScript e Adobe Spectrum 2. A disponibilidade de uma instalação concreta é tratada no aceite operacional privado.

**0.1.1 publicada; implantação e aceite operacional possuem registro privado entregue ao titular.** O código implementa operação local, migração conferida, retirada/entrega e conectores opcionais. A [release pública](docs/RELEASE-0.1.1.md) reúne o escopo e a validação sintética; a [CI pública](https://github.com/oalexandrebelo/AB-JK-UASH/actions/runs/40999978430) registra a execução automatizada.

Os critérios gerais de aceite incluem acesso seguro, provisionamento autorizado, teste de autenticação, importação/reconciliação e homologação dos provedores adotados. A situação de cada critério e as evidências do ambiente real permanecem no registro privado. Consulte o [roteiro de teste de produção](docs/PRODUCTION-TEST-JK.md).

A [CI de 0.1.0](https://github.com/oalexandrebelo/AB-JK-UASH/actions/runs/40791408960) e [VALIDATION-JK.md](docs/VALIDATION-JK.md) preservam evidências históricas de testes sintéticos de 28–29/10. Seus resultados não devem ser atribuídos automaticamente a outra revisão.

## Executar localmente

Requer Node.js 24. O lockfile fixa as dependências do frontend e do perfil PostgreSQL opcional.

```sh
npm ci --ignore-scripts
npm run sdk:build
npm run build
npm start
```

Abra o endereço informado pelo launcher para o site e acrescente `/app` para a operação. O produto não fornece conta ou senha padrão. O perfil local usa SQLite; o servidor e a interface compilados funcionam sem dependências npm de runtime quando PostgreSQL não está habilitado. Preserve os dados privados ao atualizar o código.

```sh
# Desenvolvimento: servidor e Vite em terminais separados
npm run server
npm run dev

# Validação
npm test
npm run test:infra
npm run release:check
```

O frontend em desenvolvimento usa a API do servidor local; abrir o HTML diretamente não inicia banco nem backend. Configure armazenamento persistente privado e separado por instalação. Não reutilize uma base de outra versão do AB-UASH sem uma migração compatível.

## Funcionalidades disponíveis

- Clientes, veículos, catálogo de serviços, equipe e controle de acesso por papel.
- Orçamentos, ordens de serviço, agenda com conflitos, checklist, fotos de avarias e OCR local de placa com conferência humana.
- Estoque e consumo por OS; caixas, despesas, recebimentos parciais, pós-pago, pacotes/créditos e comissões/folha interna.
- Retirada e devolução por responsável, janela, endereço, estados e histórico; conclusão vinculada à chegada ou entrega da OS.
- Migração com prévia, hash de conferência, transação atômica e idempotência. Clientes, veículos e serviços alimentam o cadastro; OS, itens e pagamentos importados ficam em histórico separado.
- Pix Efí/Inter e WhatsApp Cloud API: preparação local, envio explícito, acompanhamento e conciliação Pix. Configuração ausente impede efeitos externos.
- Rascunhos e fluxo fiscal Focus NFe/gateway, com revisão e reconciliação. Autorização fiscal depende de configuração e homologação reais.
- Relatórios, CSV, impressão comercial, auditoria, backup online e prova de restauração.

A [matriz completa](docs/FEATURE-MATRIX.md) relaciona capacidades, evidência no código, testes e pendências. Pagamentos manuais não processam a adquirente. A folha interna não substitui cálculo trabalhista. O histórico migrado não cria recebimento, emissão fiscal ou mensagem retroativa.

## Implantação e recuperação

**0.1.1 publicada; implantação e aceite operacional possuem registro privado entregue ao titular.** Endereços, topologia, configuração e observações do ambiente real não fazem parte deste README público.

Os requisitos gerais do produto incluem armazenamento persistente, controle de acesso, segredos fora do código, backup consistente e restauração de prova. Os perfis de implantação disponíveis têm requisitos próprios; a presença de um arquivo de configuração no repositório não comprova uma instalação ou homologação. Consulte os [procedimentos gerais de operação](docs/operations-jk.md) e o [PRT](docs/PRT-JK.md).

Dados operacionais, exportações de clientes, credenciais, certificados e configurações reais permanecem privados. O provisionamento deve ocorrer por canal autorizado, sem credenciais em argumentos, logs ou documentação pública.

## Migração do Jumpcar

Consulte [migration-jk.md](docs/migration-jk.md) para os formatos e limites. A exportação nativa de clientes observada é texto delimitado por ponto e vírgula com extensão `.xls`. O importador também aceita CSV, JSON canônico e a variante HTML de planilha; arquivos binários XLS/XLSX exigem conversão prévia. A interface recusa formatos não suportados.

A migração exige arquivos autorizados completos e conferência de contagens, valores e vínculos. Usuários e hashes de senha não são presumidos a partir de um CSV de clientes. A revisão 0.1.1 corrige integridade do importador e a liberação da tela em instalações sem suporte; detalhes estão na [revisão do núcleo](docs/CORE-REVIEW-2026-10-30.md) e na [release pública](docs/RELEASE-0.1.1.md). O aceite de dados reais possui registro privado.

## Documentação

| Documento | Conteúdo |
| --- | --- |
| [RELEASE-0.1.1.md](docs/RELEASE-0.1.1.md) | Release pública, capacidades e validação sintética |
| [PRODUCTION-TEST-JK.md](docs/PRODUCTION-TEST-JK.md) | Roteiro para acesso, administrador, rotina real, importação e provedores |
| [PRD-JK.md](docs/PRD-JK.md) | Requisitos de produto, jornadas, escopo e critérios de aceite |
| [PRT-JK.md](docs/PRT-JK.md) | Requisitos técnicos, contratos, segurança e critérios de validação |
| [MANUAL-JK.md](docs/MANUAL-JK.md) | Operação de cada módulo e roteiro do primeiro teste |
| [FEATURE-MATRIX.md](docs/FEATURE-MATRIX.md) | Paridade, implementação, evidência e requisitos externos |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Arquitetura, limites, concorrência, segurança e decisões |
| [CORE-REVIEW-2026-10-30.md](docs/CORE-REVIEW-2026-10-30.md) | Correções e validação focada do núcleo na revisão atual |
| [VALIDATION-JK.md](docs/VALIDATION-JK.md) | Evidência histórica de testes, REA, browser e CI de 28–29/10 |
| [REVIEW-JK.md](docs/REVIEW-JK.md) | Revisão independente histórica de 28/10 |
| [REFERENCES-2026-10-30.md](docs/REFERENCES-2026-10-30.md) | Fontes primárias, funções/licenças das referências e limites da pesquisa |
| [operations-jk.md](docs/operations-jk.md) | Deploy, bootstrap, backups, restauração e rollback |
| [migration-jk.md](docs/migration-jk.md) | Contrato e conferência da importação |
| [JK-DELIVERIES.md](docs/JK-DELIVERIES.md) | Retirada/devolução, estados, permissões e conflitos |
| [Integrações JK](integrations/jk/README.md) | Pix, WhatsApp, fiscal, configuração e efeitos financeiros |
| [API principal](server/CONTRACT.md) | Rotas e invariantes herdadas do núcleo |
| [SDK e OpenAPI](docs/api/README.md) | Contratos tipados do núcleo; extensões JK têm contratos próprios |
| [DESIGN-MEDIA.md](docs/DESIGN-MEDIA.md) | Uso verificável de Diagram Design, Hyperframes, Earshot e ManimGX |
| [PROVENANCE.md](PROVENANCE.md) | Origem do código, licenças e escopo desta publicação |

## Identidade e referências

A identidade JK e a ilustração do carro são originais desta implementação. O endereço de contato é o perfil solicitado: [@lavar.apidojk](https://www.instagram.com/lavar.apidojk/). Telefone, horários, avaliações, volume de clientes e preços não foram inventados para a landing; o catálogo é lido dos serviços ativos cadastrados.

Os componentes de gestão usam Adobe Spectrum 2 real, com carregamento por página. A mídia de autoria é compilada em arquivos estáticos; ferramentas de vídeo/áudio não entram no bundle da operação. Licenças de terceiros são preservadas em `licenses/` e nos diretórios de autoria. O acesso público ao código não constitui, por si, concessão de licença sobre todo o projeto nem sobre marcas de terceiros.
