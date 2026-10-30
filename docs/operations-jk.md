# Operação e release — AB-JK-UASH

Este runbook descreve o perfil JK da Oficina. Os exemplos de caminho usam o
identificador original `ab-jk-uash` e o checkout
`/srv/ab-oficina/projetos/ab-jk-uash/codigo`, com dados privados em `../dados`
e artefatos operacionais em `../artefatos`. Confirme o identificador e o caminho
retornados pela Oficina para a instalação efetiva; o nome do repositório não
determina o diretório do projeto. A porta inicial configurada é `9220`, dentro
da faixa originalmente reservada `9220–9229`, e a origem do perfil é
`https://ab-pcsrv.tail6bac78.ts.net:9220`. Confirme a reserva antes de ativar o
projeto.

Os comandos abaixo são procedimentos, não resultados de implantação. O
registro da release deve identificar o commit, o projeto/caminho efetivos,
a configuração aplicada e as evidências obtidas em cada ambiente.

## Configuração de execução

Use explicitamente o perfil `compose.yaml` para a Oficina, seja o Compose base
com checkout completo ou o manifesto derivado dele por `jk-oficina-compose.mjs`
conforme o procedimento abaixo. O arquivo histórico
`docker-compose.yml` continua disponível para a instalação AB-UASH anterior,
com proxy nginx, origem antiga, `./data` e UID 1000. Ele não deve ser combinado
com o Compose novo. Seu `user: "1000:1000"` explícito continua sobrescrevendo
o usuário padrão da imagem; os recursos do runtime agora são legíveis para
ambos os usuários. A nova instalação usa UID/GID `1001:1001`.

| Item | Valor da instalação Oficina |
| --- | --- |
| Imagem base | `node:24.21.0-bookworm-slim`, build e runtime |
| Porta no host | `127.0.0.1:${AB_PORTA:-9220}:4173` |
| Banco SQLite | `/data/ab-jk-uash.sqlite` |
| Dados persistentes | Bind de `../dados` para `/data` |
| Origem HTTPS | `https://ab-pcsrv.tail6bac78.ts.net:${AB_PORTA:-9220}` |
| Cookies | `COOKIE_SECURE=true` |
| Bootstrap | `SETUP_TOKEN_FILE=/data/setup-token` |
| Manutenção | A cada 21.600 segundos; últimas 28 cópias válidas |

`../dados` já deve existir e pertencer a `1001:1001`. O Compose usa
`create_host_path: false`: uma pasta ausente é um erro de implantação e não
deve ser criada implicitamente pelo Docker como root. O bind aponta para o
diretório existente diretamente. Os subdiretórios `backups` e `maintenance`
são criados pelo processo de UID 1001, com modo 0700.

O Dockerfile instala dependências somente no estágio de build com
`npm ci --ignore-scripts --no-audit --no-fund` e compila a interface com
`npm run build`. O estágio de execução contém `dist`, `server`, `scripts`,
`integrations`, `package.json` e `licenses`; não contém `node_modules`.
O caminho SQLite usa o `node:sqlite` do Node 24. Os conectores JK incluídos
são módulos locais sem dependências adicionais de runtime. O modo PostgreSQL
opcional da base não faz parte desta imagem operacional sem `pg`.

Os arquivos recebidos da Oficina podem ter modo 0640. O Dockerfile aplica
`chmod -R a+rX /app` antes de trocar para UID 1001, garantindo a leitura das
fontes, SQL e recursos compilados independentemente do dono do checkout.
O sistema de arquivos da aplicação permanece somente leitura durante a
execução; `/data` e o tmpfs `/tmp` são as áreas graváveis.

## Sequência de release

No checkout de revisão, depois que todas as alterações estiverem integradas:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm run sdk:build
npm test
node --test infra/tests/*.test.mjs
node scripts/jk-release-check.mjs check
```

O workflow `.github/workflows/ci.yml` reproduz esses gates com Node 24,
`contents: read`, sem credenciais configuradas pelo projeto. Ele também roda
`docker compose -f compose.yaml config --quiet` no runner hospedado. As Actions
estão fixadas pelos commits das releases oficiais, verificados em 2026-10-28:

- [actions/checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1):
  `3d3c42e5aac5ba805825da76410c181273ba90b1`.
- [actions/setup-node v7.0.0](https://github.com/actions/setup-node/releases/tag/v7.0.0):
  `820762786026740c76f36085b0efc47a31fe5020`.
- A tag Node consta no [catálogo oficial de imagens Docker](https://github.com/docker-library/official-images/blob/master/library/node).

### Smoke test de containers na CI

O workflow também executa `node infra/ci-smoke.mjs run` no runner Ubuntu
com Docker. Esse gate constrói a imagem pelo `compose.yaml`, inicia os
serviços `app` e `maintenance`, verifica os healths e cria um administrador
exclusivamente sintético pelo bootstrap via stdin. Um ciclo de manutenção
deve produzir um backup restaurável contendo esse registro. Após restart
dos dois serviços, o mesmo administrador deve continuar no SQLite e no
backup, com os healths novamente aprovados.

O teste usa diretório temporário privado do runner, imagem e projeto Compose
com nomes únicos e porta livre apenas em loopback. Um override troca
o armazenamento de teste, a origem por `https://ci.ab-jk-uash.invalid` e o
intervalo dos healths; a aplicação fica numa rede Docker interna, sem saída
externa, e a manutenção conserva `network_mode: none`. O gate também confere
UID/GID 1001, recursos de runtime sem `node_modules`, token 0600, filesystem
somente leitura e bind real de `/data`. Não chama provedores nem a Oficina.

A senha sintética é aleatória e passa apenas por stdin, sem arquivo, argumento
ou variável de ambiente. A etapa seguinte usa `if: always()` para executar
`node infra/ci-smoke.mjs cleanup`, removendo o projeto de teste, sua imagem,
rede e diretório de dados mesmo quando build ou smoke test falham. O estado
privado dessa limpeza fica em `JK_CI_SMOKE_STATE`, dentro de `runner.temp`.

Este gate passou na [execução real do GitHub Actions](https://github.com/oalexandrebelo/AB-JK-UASH/actions/runs/40791408960)
do commit `f965e03d92a881cfc9d3bb9df67caeeee9d48045`, encerrada em 29/10/2026
às 00:04:12 UTC. Build, health, backup/restauração, persistência após restart
e limpeza terminaram com sucesso. Ele valida containers com dados sintéticos e não
substitui a verificação do host de produção ou da exposição HTTPS tailnet.

### Manifesto Oficina com fonte Git fixada

Quando o canal de implantação não comportar o checkout completo, use
[`scripts/jk-oficina-compose.mjs`](../scripts/jk-oficina-compose.mjs) para
derivar o manifesto do `compose.yaml` revisado. O gerador troca o contexto de
build local por `https://github.com/oalexandrebelo/AB-JK-UASH.git#SHA_COMPLETO`
e nomeia a imagem com os primeiros doze caracteres desse commit. O contexto
usa o SHA completo, não uma branch ou tag móvel. Isso fixa a fonte pública do
build; não substitui o registro da imagem efetivamente construída.

Primeiro integre, teste, revise e publique a fonte. Substitua o marcador do
comando pelo SHA de quarenta caracteres hexadecimais do commit publicado e
escolha um caminho de saída novo:

```sh
node scripts/jk-oficina-compose.mjs \
  --commit SHA_COMPLETO_PUBLICADO \
  --out /tmp/compose-oficina-jk.yaml
```

O gerador valida o formato do SHA, mas não consulta o GitHub nem comprova que
esse commit foi publicado, testado ou aprovado. A coordenação da release deve
conferir essa correspondência. O comando não publica, não implanta e não
inicia serviços. Recusa sobrescrever o Compose base e qualquer arquivo de
saída existente; se os marcadores esperados do Compose mudarem, exige revisão
do gerador.

Revise o arquivo gerado e instale seu conteúdo como `compose.yaml` no diretório
`codigo` do projeto autorizado. Não execute o manifesto diretamente em `/tmp`:
o bind `../dados` é relativo ao local do manifesto e precisa continuar apontando
para os dados privados desse projeto. Preserve o banco existente. O host de
build precisa conseguir ler o repositório público e obter os recursos previstos
pelo Dockerfile. Não há senha, token de GitHub ou exportação de clientes no
contexto configurado pelo gerador.

O manifesto mantém o bind publicado somente em loopback, UID/GID 1001,
filesystem somente leitura e manutenção com `network_mode: none`. Acrescenta
o serviço `verification`, usando a mesma imagem fixada, sem volumes e sem
portas publicadas. Esse serviço tem filesystem somente leitura, capabilities
removidas, `no-new-privileges`, limites de recursos e `restart: "no"`. Inicia
após `app` e `maintenance` saudáveis, executa o probe e encerra. O manifesto
não cria um administrador nem modifica dados de negócio.

### Verificação anônima no destino

[`scripts/jk-runtime-probe.mjs`](../scripts/jk-runtime-probe.mjs) consulta a
aplicação por HTTP dentro da rede dos contêineres. O sidecar usa o hostname
`app`, porta interna 4173 e a origem pública configurada apenas nos headers
`Host` e `Origin`; isso não negocia nem verifica TLS externo.

O probe exige os seguintes resultados:

| Consulta | Evidência exigida |
| --- | --- |
| `GET /api/ready` | HTTP 200, API pronta e acesso ao banco confirmado |
| `GET /api/status` | Estado anônimo válido, usuário `null`, modo de armazenamento e flags de configuração |
| `HEAD /` | HTTP 200, conteúdo HTML, `X-Frame-Options: DENY` e presença de CSP |
| `GET /api/customers?limit=1`, sem sessão | HTTP 401 e `AUTH_REQUIRED` |
| `GET /api/ready`, com Host inválido | HTTP 403 e `HOST_REJECTED` |

Cada requisição tem timeout de três segundos e resposta limitada a 64 KiB.
O resultado contém somente indicadores agregados e o escopo da prova. Erros
usam mensagens controladas; corpo JSON malformado, credenciais em URL,
argumentos inválidos e exceções de transporte não são copiados para os logs.
O probe não lê o arquivo de token, não recebe senha, não cria conta e não
consulta provedores.

Depois do `compose up`, confira a execução efetivamente concluída:

```sh
docker compose -f compose.yaml ps -a verification
docker compose -f compose.yaml logs --no-color verification
```

Exija encerramento com código zero e o resultado `ok: true` correspondente à
execução atual. A conclusão de `compose up -d`, a simples presença do contêiner
ou um log antigo não comprovam sucesso do probe. Quando o manifesto base não
contiver `verification`, o mesmo script pode ser executado dentro de `app`
por um canal operacional autorizado:

```sh
docker compose -f compose.yaml exec -T app node scripts/jk-runtime-probe.mjs
```

`frontend: "html"` atesta a rota e os headers de `HEAD /`; não testa execução
do JavaScript, assets, interação autenticada, impressão ou aparência. O probe
também não demonstra login real, criação de administrador, migração, acesso
HTTPS externo ou homologação de provedores. `setupRequired: true` mantém o
bootstrap pendente mesmo quando todos os checks anônimos passam. A
[revisão do núcleo de 30/10/2026](CORE-REVIEW-2026-10-30.md) documenta
separadamente as correções e testes locais de importação/pós-pago; nenhuma
dessas evidências substitui a prova operacional no destino.

No servidor de destino, a publicação responsável pelo projeto deve validar
o diretório de dados e executar os passos equivalentes a:

```sh
cd /srv/ab-oficina/projetos/ab-jk-uash/codigo
AB_PORTA=9220 docker compose -f compose.yaml config --quiet
AB_PORTA=9220 docker compose -f compose.yaml build
AB_PORTA=9220 docker compose -f compose.yaml up -d
docker compose -f compose.yaml ps
docker compose -f compose.yaml exec -T app node scripts/healthcheck.mjs
docker compose -f compose.yaml exec -T maintenance node scripts/jk-maintenance.mjs health
```

A exposição HTTPS do projeto precisa encaminhar a origem pública acima para
`http://127.0.0.1:9220` no servidor. O bind de loopback do Compose não configura
TLS por si só. Depois de a exposição estar ativa, verificar `/`,
`/api/health` e `/api/status` pela URL HTTPS. A resposta de status também
informa se a criação do primeiro administrador ainda está pendente.

O health da aplicação usa somente loopback interno e verifica API, acesso ao
banco e interface compilada. O health da manutenção não usa sockets ou rede:
ele lê o estado, verifica os bytes do último backup e checa sua integridade
SQLite. O serviço `maintenance` tem `network_mode: none`.

## Primeiro administrador e canal de segredo

Na primeira execução, `scripts/start.mjs` pede a criação exclusiva de
`/data/setup-token` por `scripts/bootstrap-token.mjs`, com aleatoriedade
criptográfica, dono igual ao processo e modo 0600. A execução seguinte
preserva e valida esse arquivo. O conteúdo não é registrado nos logs.
O token não está no Compose, em `.env`, no repositório ou na imagem.

A disponibilidade da interface não comprova a criação de um administrador.
O build por SHA e a aprovação do sidecar também não criam a conta real. O
bootstrap privado continua sendo uma etapa obrigatória para uma instalação
vazia, com o titular e a credencial previamente autorizados. Se já houver
usuários, preserve o acesso existente e use o fluxo apropriado de administração;
o bootstrap se recusa a sobrescrever contas.

O comando local abaixo aceita um JSON privado com as chaves `name`, `email`
e `password` via stdin e falha se a instalação já tiver qualquer usuário:

```sh
docker compose -f compose.yaml exec -T app \
  node scripts/jk-bootstrap-admin.mjs --db /data/ab-jk-uash.sqlite \
  < /caminho/privado/admin.json
```

O JSON deve estar fora de `codigo`, pertencer ao operador e ter modo 0600.
Não colocar senha em argumento de shell, comentário, workflow, commit ou
saída de ferramenta. Novas senhas seguem a política da aplicação; a opção
`--import-legacy-account` existe somente para a importação explícita de uma
conta legada autorizada. Nenhuma conta padrão é criada pela infraestrutura.

**Limite operacional identificado:** a interface Oficina disponível nesta
entrega escreve em `codigo`, não em `dados`, e não fornece um canal privado
para a entrada de credenciais. Sem terminal autorizado com stdin privado ou
um mecanismo equivalente de segredos, o bootstrap administrativo permanece
pendente. Não contornar esse limite publicando segredo em arquivo de código
ou variável versionada. A geração automática do token resolve o início do
servidor; ela não fornece a credencial inicial ao operador.

## Backup, prova e retenção

O serviço de manutenção inicia depois que a aplicação está saudável. Seu
primeiro ciclo é imediato; os seguintes começam seis horas após o término
do ciclo anterior. Em caso de falha, o health falha e uma nova tentativa
ocorre em até cinco minutos.

Cada ciclo executa:

1. Verificação de arquivo SQLite regular e estimativa de espaço para duas
   cópias temporariamente coexistentes, com reserva de 64 MiB.
2. Backup online consistente pela API `backup()` de `node:sqlite`, usando
   `createSnapshot()` de `scripts/storage.mjs`. O WAL ativo é contemplado
   pela API; não há cópia bruta do arquivo de banco em uso.
3. Verificações de integridade SQLite e chaves estrangeiras, com manifesto
   SHA-256 privado para o snapshot.
4. Restauração real desse backup em um diretório temporário privado. A
   restauração verifica o manifesto, revoga sessões e registra
   `system.restored` no banco restaurado. A manutenção inspeciona esses
   efeitos e grava um arquivo `.restore-check.json` com hashes e resultado.
5. Remoção do banco de prova temporário. O snapshot original e sua prova
   permanecem; o banco ativo e suas sessões não são alterados.
6. Retenção das 28 cópias válidas mais recentes. O banco, manifesto e prova
   das cópias antigas são removidos juntos, depois de conferir seus hashes.

Com a periodicidade padrão, 28 cópias correspondem aproximadamente a sete
dias. O critério é quantidade de cópias concluídas, não idade: execuções
manuais adicionais podem reduzir o período coberto. Arquivos de operador,
cópias sem manifesto/prova e cópias corrompidas são preservados para
inspeção e não contam como cópias válidas na retenção. Esses itens podem
exigir limpeza manual após investigação. O ciclo não faz backup do token,
de credenciais de integrações ou do código.

O resultado atual fica em `/data/maintenance/status.json`. Banco, manifesto,
prova e status têm modo 0600. A prova permite rastrear quais bytes foram
restaurados e quando; o health confirma que a cópia recente ainda corresponde
ao hash. O health expira após o intervalo configurado mais 15 minutos.
Falta de espaço, restauração incompatível ou cópia corrompida não são tratadas
como sucesso. O stdout contém apenas identificadores de backup e contagens.

Para um ciclo manual, no mesmo volume e UID do serviço:

```sh
docker compose -f compose.yaml exec -T maintenance \
  node scripts/jk-maintenance.mjs once
```

Essas cópias ficam no mesmo volume que o banco. A recuperação contra perda
do servidor exige uma cópia adicional dos pares banco/manifesto para um
destino privado independente. Nenhuma réplica externa é configurada por
esta entrega. A prova `.restore-check.json` pode acompanhar o par para
auditoria, mas a restauração valida o manifesto original de cada backup.

## Recuperação do banco

Use sempre o backup e seu `.manifest.json` correspondente. Escolha um nome
de destino novo; o restaurador se recusa a sobrescrever banco, manifesto ou
sidecars existentes. Primeiro interrompa os dois serviços para uma troca
operacional planejada e, então, crie a restauração em arquivo separado:

```sh
docker compose -f compose.yaml stop app maintenance
docker compose -f compose.yaml run --rm --no-deps maintenance \
  node scripts/restore.mjs \
  --from /data/backups/BACKUP-SELECIONADO.sqlite \
  --to /data/ab-jk-uash-restored.sqlite
```

Após a restauração terminar, configure **ambos** os serviços com `DB_PATH`
apontando para o arquivo novo por um override local fora do repositório.
Reinicie com o mesmo override e repita os healths. Preserve o banco anterior
e os sidecars para investigação; não renomeie um banco enquanto outro
processo o mantém aberto. As sessões da cópia restaurada já estarão
revogadas e os usuários precisarão fazer login novamente. Manter o mesmo
diretório `/data` conserva as localizações de backups e de estado.

## Snapshot e REA após congelamento

O snapshot é uma preparação da análise estática solicitada. Ele só deve ser
produzido depois do congelamento das fontes integradas. O script não
executa REA, não instala ferramentas e não inicia a aplicação:

```sh
node scripts/jk-release-check.mjs snapshot --out /tmp/ab-jk-uash-release-source
node scripts/jk-release-check.mjs verify --snapshot /tmp/ab-jk-uash-release-source
```

O destino precisa ser novo e ficar fora do checkout. São incluídos apenas
`server`, `integrations`, `src`, `scripts`, `package*.json`, os três arquivos
`tsconfig*.json` conhecidos e `vite.config.ts`. O script aceita as extensões
textuais indicadas no código, rejeita links simbólicos e limita cada arquivo
a 1 MiB, o conjunto a 32 MiB e a contagem a 1.000 arquivos. Esses limites são
política do staging, não opções ou garantias do REA. Nenhum `node_modules`,
banco, `.git`, segredo, distribuição ou OCR compilado entra no snapshot.

O `MANIFEST.json` relaciona caminhos, tamanhos, SHA-256 de cada arquivo e
digest agregado da árvore. A cópia é comparada novamente com a fonte antes
de o manifesto ser concluído. `verify` detecta mudança na fonte, no snapshot
ou adição de arquivos ao staging. Se houver alteração depois do
congelamento, produza outro snapshot com nome novo e mantenha a relação
entre a nova evidência e o novo digest.

O runtime REA 6.7.0 da sessão está instalado em
`/tmp/ab-jk-rea-runtime/node_modules/rea-agents/scripts/rea.mjs`; sua aquisição
e SHA-512 foram verificados pela coordenação da entrega. Não é dependência
do projeto. Depois de `verify`, a análise final pode usar:

```sh
timeout --signal=TERM --kill-after=10s 600s \
  node --max-old-space-size=512 \
  /tmp/ab-jk-rea-runtime/node_modules/rea-agents/scripts/rea.mjs \
  analyze-javascript-application /tmp/ab-jk-uash-release-source \
  --max-heap-mb 512 --analysis-timeout-ms 120000 \
  --format json --full-output \
  > /tmp/ab-jk-uash-rea-final.json
node scripts/jk-release-check.mjs verify --snapshot /tmp/ab-jk-uash-release-source
```

O timeout de 120 segundos é por fonte; o limite externo de 600 segundos
delimita o processo completo. A saída de CLI observada na sessão usa o
envelope `{ok, data, meta}`, com a Evidence dentro de `data`. Preserve o
`evidence_id` real, digest, inventário, cobertura, limitações e unknowns. Se
houver interrupção, erro ou cobertura parcial, registre exatamente esse
estado. Inspeção estática não prova comportamento executado, bootstrap,
aceite visual ou implantação. Não repetir o probe anterior contra o checkout
com `node_modules`: a seleção de uma fonte ainda inventaria a árvore inteira.

## Evidências locais e fechamento remoto

Em 2026-10-28, esta frente executou Node 24.22.1 e confirmou:

- 7 testes novos de manutenção e snapshot aprovados.
- 12 regressões existentes de backup/restauração aprovadas junto aos novos
  testes: 19 testes aprovados, sem falha ou skip nesse conjunto.
- 13 verificações estáticas de `jk-release-check.mjs check` aprovadas,
  incluindo a existência de uma interface compilada no checkout.
- YAML do Compose parseado localmente; anchors, usuário, ausência de rede
  da manutenção e `create_host_path: false` conferidos.

A suíte completa, o build e o SDK foram executados sobre a fonte congelada e
estão registrados em [VALIDATION-JK.md](VALIDATION-JK.md). A análise REA final
está em [rea/README.md](rea/README.md), com cobertura parcial e seus limites
explícitos. Os 19 testes citados acima são um conjunto focado; não são somados
novamente aos totais consolidados.

O Docker CLI não estava disponível no ambiente local dessa rodada. A CI
remota posteriormente aprovou o Compose real, o build e o smoke test descritos
acima. Essa prova usa apenas dados sintéticos. No fechamento de 28–29/10/2026,
health da instalação JK, origem HTTPS, persistência no volume do servidor,
restauração nesse destino, criação do administrador real e homologação de
provedores ficaram pendentes. O conector Oficina respondeu erro interno
`-32603` naquela verificação; nenhuma ativação no host foi declarada nesse
registro. Esse é um resultado histórico, não uma descrição presumida do estado
atual. Os resultados de 0.1.1, inclusive testes, implantação e bloqueios que
permanecerem, pertencem ao registro de entrega dessa release.
