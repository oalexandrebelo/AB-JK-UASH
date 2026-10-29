# Implantação no AB-SRV

O Compose executa a interface Vite compilada e a API Node.js 24 no mesmo processo e na mesma origem. O armazenamento deste perfil é SQLite em `./data/ab-uash.sqlite`. O perfil não precisa de `.env`, banco externo nem credenciais para iniciar. O primeiro administrador define sua própria senha na interface, mediante o token privado de configuração.

## Endereço e isolamento

O projeto Compose chama-se `ab-uash`. O padrão reservado para esta instalação é `AB_PORTA=8455`, com origem pública exata `https://ab-srv.tail6bac78.ts.net:8455`. A variável `AB_PORTA` altera em conjunto a porta publicada, a origem permitida e a sondagem do proxy; qualquer alteração exige uma reserva correspondente no AB-SRV.

Somente o nginx publica uma porta, em `127.0.0.1:${AB_PORTA:-8455}:8080`. A terminação HTTPS e o acesso à Tailnet pertencem ao publicador do AB-SRV. O Node está apenas na rede `internal: true`, sem rota de saída pública. O nginx participa das redes `web` e `internal` e encaminha toda a interface e a API ao mesmo processo. Preserva os valores originais de `Host` e `Origin` e remove cabeçalhos de encaminhamento; o servidor valida a origem configurada e não confia em `X-Forwarded-*`.

Os dois serviços usam UID/GID `1000:1000`, raiz somente leitura, `cap_drop: ALL`, `no-new-privileges`, diretório temporário em tmpfs e limites explícitos. O processo principal tem 512 MiB, uma CPU e 128 PIDs; o proxy tem 128 MiB, 0,25 CPU e 64 PIDs. O limite do heap V8 é 320 MiB. Arquivos de banco, WAL e token permanecem no único bind persistente, `./data:/data`, com `create_host_path: false`.

## Preparação e inicialização

O publicador do AB-SRV prepara `/opt/ab-uash/data` com proprietário `1000:1000` e permissão `0700`. Para uma instalação equivalente, um administrador prepara esse diretório antes de iniciar o Compose. O bind não cria silenciosamente um diretório com proprietário incorreto.

Na raiz da aplicação:

```sh
docker compose config --quiet
docker compose build --pull
docker compose up -d --wait
docker compose ps
```

A compilação baixa as imagens oficiais e as dependências fixadas pelo lockfile. A execução posterior serve fontes, OCR, JavaScript e CSS locais. O Dockerfile usa `node:24.21.0-bookworm-slim`; o proxy usa `nginx:1.31.5-alpine`. As referências são versões explícitas, não aliases `latest`. A imagem final `ab-uash:0.2.1` contém o runtime, `dist/`, `server/`, `scripts/` e `integrations/`; o perfil SQLite não precisa de `node_modules`. A conexão PostgreSQL opcional do código-fonte requer seu próprio pacote de runtime com a dependência `pg` e não integra este perfil isolado.

Referências oficiais das versões: [Node no Docker Hub](https://hub.docker.com/layers/library/node/24.21.0-bookworm-slim/images/) e [nginx no Docker Hub](https://hub.docker.com/layers/library/nginx/1.31.5-alpine/images/). A existência das tags deve ser confirmada pelo `docker compose build --pull` e pelo pull do proxy no servidor de implantação; a compilação efetiva também verifica a disponibilidade dos artefatos.

## Primeiro administrador

O Compose configura `SETUP_TOKEN_FILE=/data/setup-token`. No primeiro início o processo cria, com gerador criptográfico, um token base64url de 64 caracteres em arquivo `0600` pertencente ao usuário da aplicação. Uma reinicialização preserva o arquivo e o token. O valor não é impresso nos logs nem incluído no bundle da interface. Arquivos com permissões incorretas, links simbólicos ou conteúdo inválido impedem a inicialização.

Um administrador com acesso ao host deve disponibilizar o token por um canal privado ao responsável pelo primeiro acesso. Não coloque o token em URLs, argumentos de comandos, histórico do terminal, mensagens públicas ou arquivos versionados. A interface o envia no cabeçalho `X-Setup-Token`; o token autoriza somente a configuração inicial e deixa de ser solicitado depois da criação do primeiro administrador. Preserve o arquivo para que a política de inicialização remota continue satisfeita nos reinícios.

Se for necessário preparar o arquivo antes da subida, o mesmo procedimento idempotente está disponível dentro do contêiner, sem exibir seu valor:

```sh
docker compose run --rm --no-deps app node scripts/bootstrap-token.mjs
```

Fora do Compose, `SETUP_TOKEN` ou `SETUP_TOKEN_FILE` são aceitos de forma mutuamente exclusiva. Um caminho de arquivo explicitamente configurado permite a criação automática. Um bind externo sem origem pública ou sem uma dessas configurações falha antes da abertura do banco. O uso em loopback pode continuar com a configuração inicial interativa sem token.

## Saúde, parada e manutenção

A sondagem Node consulta `/api/health`, `/api/status` e a página inicial usando conexão local e `Host`/`Origin` da URL pública. Assim verifica o processo HTTP, uma consulta ao banco e a presença da interface compilada. A sondagem nginx passa pelo proxy até `/api/health`. O nginx somente inicia depois de o serviço principal estar saudável.

```sh
docker compose exec app node scripts/healthcheck.mjs
docker compose stop
docker compose up -d --wait
```

Use os scripts de backup/restauração da aplicação para preservar a consistência do SQLite. Não copie apenas o arquivo principal enquanto ele estiver em uso com WAL. Faça backup de `data/` por procedimento compatível com o SQLite e preserve separadamente o token e suas permissões. Nunca execute `down --volumes` ou apague `data/` como parte de uma atualização comum.

O núcleo local não usa saída pública. Integrações que precisam contatar provedores externos, como emissão fiscal real, permanecem sem conectividade neste perfil e exigem implantação e política de saída próprias. Não conecte o serviço principal à rede `web` para contornar esse isolamento.

## Inicialização local e pacote completo

`start.sh` e `Iniciar-AB-UASH.command` primeiro tentam um runtime Node 24 compatível em `runtime/<plataforma>/node`, depois `NODE_BIN`, depois uma instalação local de Node 24, incluindo os caminhos padrão do Homebrew. Um Node 25 encontrado no PATH não é escolhido. O iniciador não baixa runtimes nem instala dependências.

Um checkout de código pode não conter `runtime/` nem `dist/`: é necessário um Node 24 instalado e a compilação da interface. Uma distribuição completa deve conter o runtime oficial da plataforma, `dist/`, `server/`, `scripts/` e `integrations/`. O teste `tests/distribution.test.mjs` copia apenas esses componentes para um diretório temporário sem `node_modules`, inicia a aplicação, cria dados sintéticos e confirma sua persistência após reiniciar. Há execução nativa para Linux x64 e macOS arm64/x64 quando o runtime correspondente está presente; um checkout sem runtime registra explicitamente o motivo de não executar essa prova.

```sh
node --test tests/deployment.test.mjs tests/distribution.test.mjs
```

Esses testes verificam permissões do token, preservação do segredo, bloqueio de bootstrap remoto sem configuração, primeiro cadastro protegido, sondagem de saúde, seleção do runtime e distribuição isolada. A compilação e as verificações reais de Docker/nginx são executadas no host de implantação e não são substituídas por esses testes Node.
