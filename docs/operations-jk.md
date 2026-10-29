# Operação e release — AB-JK-UASH

O projeto Oficina é `ab-jk-uash`. O checkout fica em
`/srv/ab-oficina/projetos/ab-jk-uash/codigo`, os dados privados em `../dados`
e os artefatos operacionais em `../artefatos`. A porta reservada inicial é
`9220`, dentro da faixa `9220–9229`. A origem pública configurada é
`https://ab-pcsrv.tail6bac78.ts.net:9220`.

## Configuração de execução

Use explicitamente `compose.yaml` para a Oficina. O arquivo histórico
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

O Docker CLI não estava disponível no ambiente local desta frente. A CI
remota posteriormente aprovou o Compose real, o build e o smoke test descritos
acima. Essa prova usa apenas dados sintéticos. Health da instalação JK,
origem HTTPS, persistência no volume do servidor, restauração nesse destino,
criação do administrador real e homologação de provedores continuam pendentes.
O conector Oficina permaneceu respondendo erro interno `-32603` na última
verificação; nenhuma ativação no host foi declarada.
