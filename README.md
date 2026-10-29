# AB-JK-UASH · Lava Rápido JK

Cliente independente do AB-UASH para a operação do Lava Rápido JK, em Rio Verde (GO). Landing page pública em `/` e gestão autenticada em `/app`, com React, TypeScript e Adobe Spectrum 2.

**Versão inicial: 0.1.0.** O código implementa operação local, migração conferida, retirada/entrega e conectores opcionais. A migração dos dados reais e a homologação dos provedores ainda precisam ser concluídas. O estado comprovado de testes e implantação está em [VALIDATION-JK.md](docs/VALIDATION-JK.md); nenhuma página de saúde ou build, isoladamente, declara prontidão de produção.

## Executar localmente

Requer Node.js 24. O lockfile fixa as dependências do frontend e do perfil PostgreSQL opcional.

```sh
npm ci --ignore-scripts
npm run sdk:build
npm run build
npm start
```

Abra `http://127.0.0.1:4173/` para o site e `/app` para a operação. A instalação começa vazia, sem conta ou senha padrão. O perfil local usa SQLite; o servidor e a interface compilados funcionam sem dependências npm de runtime quando PostgreSQL não está habilitado. Preserve o banco ao atualizar o código.

```sh
# Desenvolvimento: servidor e Vite em terminais separados
npm run server
npm run dev

# Validação
npm test
npm run test:infra
npm run release:check
```

O frontend em desenvolvimento usa a API local; abrir o HTML diretamente não inicia o banco nem o backend. O launcher legado mantém o nome `data/ab-uash.sqlite` como padrão local. Na implantação JK, `DB_PATH=/data/ab-jk-uash.sqlite` torna a separação explícita. Nunca aponte este cliente para um banco AB-UASH existente sem uma migração específica.

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

## Implantação JK no AB-PCSRV

O perfil de destino é `compose.yaml`: app em `127.0.0.1:9220`, banco e arquivos privados em `../dados`, execução UID 1001 e imagem somente leitura. O serviço de manutenção executa backup consistente, restaura uma cópia de prova e retém 28 backups válidos. A publicação real e seus limites são registrados no relatório de validação.

[Procedimentos de operação e recuperação](docs/operations-jk.md) incluem implantação, bootstrap privado, configuração, backup, atualização e rollback. `docker-compose.yml`, `deploy/`, `api/`, `supabase/` e `vercel.json` são perfis herdados: sua presença não significa implantação ou homologação nesta entrega. Use `-f compose.yaml` no destino JK.

Nenhum banco, exportação de cliente, senha, token ou certificado pertence ao repositório público. A criação do administrador por CLI recebe JSON em **stdin privado**, sem credenciais em argumentos ou logs. A opção explícita de importação de conta legada existe para conservar um acesso previamente autorizado; ela não cria uma conta padrão nem modifica contas existentes.

## Migração do Jumpcar

Consulte [migration-jk.md](docs/migration-jk.md) para os formatos e limites. A exportação nativa de clientes observada é texto delimitado por ponto e vírgula com extensão `.xls`. O importador também aceita CSV, JSON canônico e a variante HTML de planilha; arquivos binários XLS/XLSX exigem conversão prévia. A interface recusa formatos não suportados.

Não houve obtenção do banco completo nem importação de dados reais nesta rodada. O acesso autenticado permitiu observar a unidade e parte dos cadastros; o download da exportação ficou bloqueado na sessão de origem. A migração final depende dos arquivos autorizados e da conferência de contagens, valores e vínculos. Usuários e hashes de senha não são presumidos a partir de um CSV de clientes.

## Documentação

| Documento | Conteúdo |
| --- | --- |
| [MANUAL-JK.md](docs/MANUAL-JK.md) | Operação de cada módulo e roteiro do primeiro teste |
| [FEATURE-MATRIX.md](docs/FEATURE-MATRIX.md) | Paridade, implementação, evidência e requisitos externos |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Arquitetura, limites, concorrência, segurança e decisões |
| [VALIDATION-JK.md](docs/VALIDATION-JK.md) | Resultados efetivos de testes, REA, browser e implantação |
| [REVIEW-JK.md](docs/REVIEW-JK.md) | Revisão independente e correções verificadas |
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
