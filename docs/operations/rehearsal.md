# Ensaio local JK — 31/10 e 01/11/2026

O helper [`scripts/jk-rehearsal.mjs`](../../scripts/jk-rehearsal.mjs) abre exclusivamente um SQLite novo, privado e identificado como ensaio. Não conecta ao servidor operacional, não lê banco de produção, não copia sessões e não usa Docker. O Jumpcar continua sendo a origem operacional. O ensaio técnico abaixo não decide o corte de 02/11; o horário continua a ser definido depois dos testes e do aceite dos responsáveis.

## Preparar um ambiente novo

Use Node.js 24 no checkout revisado. O frontend precisa estar compilado em `dist` para o ensaio pelo navegador; a jornada automática exercita as APIs e não depende dele. Escolha um diretório **novo, fora do Git**, cujo nome comece com `jk-rehearsal-`. O diretório pai deve existir. Exemplo no Mac do responsável:

```sh
cd ./AB-JK-UASH
export JK_REHEARSAL_MODE=isolated
JK_REHEARSAL_DIR="$(cd .. && pwd)/jk-rehearsal-weekend-20261031"
node scripts/jk-rehearsal.mjs init --dir "$JK_REHEARSAL_DIR"
node scripts/jk-rehearsal.mjs check --dir "$JK_REHEARSAL_DIR"
```

Se o ambiente já foi preparado, execute somente `check`. `init` recusa sobrescrever qualquer diretório existente. O banco sempre se chama `jk-rehearsal.sqlite`; não há parâmetro para apontar outro banco, uma URL ou um backup. Não renomeie um banco vivo para esse nome. Preparação interrompida preserva o diretório para inspeção; prepare outro nome para tentar novamente.

O helper exige `JK_REHEARSAL_MODE=isolated`. Recusa configurações herdadas de banco, origem, porta, bootstrap e integrações (`DB_PATH`, `DATABASE_URL`, `PUBLIC_ORIGIN`, `HOST`, `PORT`, `SETUP_TOKEN*`, `AB_JK_*`, `AB_UASH_FISCAL_*` e demais chaves listadas no script). A mensagem identifica apenas os nomes das variáveis, sem seus valores. Remova essas variáveis na sessão destinada ao ensaio; não copie segredos de produção para contornar a recusa.

O diretório usa modo 0700; banco, configuração, senha e resultados usam 0600. A única conta criada é **Ensaio JK — NÃO OPERACIONAL**, `ensaio-jk@example.test`. A senha aleatória é nova e fica em `access.json`, nesse diretório privado. Abra o arquivo localmente para entrar no navegador; não o copie para Git, evidências compartilhadas ou mensagens. Nenhuma senha aparece na saída do helper.

## Abrir, operar e encerrar

```sh
node scripts/jk-rehearsal.mjs start --dir "$JK_REHEARSAL_DIR"
```

O endereço exibido é sempre `http://127.0.0.1:4179` por padrão. A porta 9220 e exposição em rede são recusadas. `--port 0` escolhe uma porta local livre. Confirme **endereço, caminho do banco, versão e conta de ensaio** antes de entrar. Este comando mantém `parallel_readonly`, com autoridade Jumpcar, e impede a criação de OS/recebimentos.

Para o ciclo manual com gravações **somente nesse banco isolado**, encerre o processo anterior e use a opção explícita:

```sh
node scripts/jk-rehearsal.mjs start --dir "$JK_REHEARSAL_DIR" --allow-local-writes
```

Esse processo muda apenas o banco identificado de ensaio para `normal`. Registre nomes e observações com **ENSAIO JK** para reconhecer os cadastros fictícios. A mudança não envia nada ao sistema publicado. Há somente o administrador de ensaio, nenhum cliente/profissional real, catálogo real, saldo ou estoque herdado.

Asaas/Pix, WhatsApp/Baileys e fiscal recebem configuração vazia/desativada, mesmo que existam variáveis no Mac. O helper confere a prontidão bloqueada antes de aceitar o uso; o transporte fiscal adicional recusa despacho. A opção de escrita não habilita provedores. Nenhum pareamento Baileys, segredo ou conta externa é carregado. Essa proteção pertence ao helper e à configuração dos adaptadores; não instala firewall no Mac nem testa um serviço externo.

**Ctrl+C** ou SIGTERM retorna o banco a `parallel_readonly`, encerra o servidor, faz logout e libera `running.lock`. Os dados e evidências permanecem. `check` confirma o estado após encerrar. Interrupção forçada pode deixar o lock: confira o PID e se o processo terminou antes de remover apenas `running.lock`; não remova banco/sidecars. Um lock existente impede uma segunda abertura pelo helper. Não abra o mesmo banco por outro servidor ou ferramenta durante o ensaio. Não há limpeza automática nem agendamento de corte.

## Jornada automática e recuperação

Use outro diretório novo para a jornada automática, preservando o ambiente manual vazio:

```sh
JK_REHEARSAL_SMOKE_DIR="$(cd .. && pwd)/jk-rehearsal-check-20261030"
node scripts/jk-rehearsal.mjs init --dir "$JK_REHEARSAL_SMOKE_DIR"
node scripts/jk-rehearsal.mjs smoke --dir "$JK_REHEARSAL_SMOKE_DIR"
node scripts/jk-rehearsal.mjs check --dir "$JK_REHEARSAL_SMOKE_DIR"
```

`smoke` exige que os cadastros/OS/recebimentos estejam vazios e não repete automaticamente uma jornada após falha. Para repetir, use um novo diretório. A jornada usa HTTP real apenas em loopback e os mesmos endpoints operacionais da aplicação:

1. Cria cliente, veículo e serviço claramente fictícios, no valor de 2.500 centavos.
2. Abre uma OS e percorre execução, conferência e pronto. Confirma que uma versão antiga é recusada.
3. Abre caixa fictício com 1.000 centavos, registra 2.500 centavos em dinheiro local e repete a mesma solicitação/chave, exigindo um único recebimento.
4. Entrega a OS quitada e fecha caixa esperado de 3.500 centavos, com diferença zero.
5. Confirma zero mensagens e zero registros de integrações; volta à consulta paralela.
6. Faz backup online consistente com manifesto, contendo uma sessão ativa. Restaura para `jk-rehearsal-restored.sqlite`, arquivo novo; exige integridade, relacionamentos, sessão revogada e auditoria `system.restored`.
7. Abre temporariamente a cópia restaurada em loopback; confere acesso anônimo recusado, novo login, OS preservada e logout. Preserva o banco anterior.

O resultado agregado fica em `smoke-result.json`, sem senha, cookie ou dados pessoais reais. O par `jk-rehearsal-backup.sqlite`/`.manifest.json` e a restauração ficam no mesmo diretório privado. Esse par local não comprova uma cópia independente contra perda do computador. O encerramento da restauração também não prova recuperação do banco publicado, uso por outro responsável ou duração aceitável no estabelecimento.

## Conferência que ainda cabe aos responsáveis

A jornada automática é uma prova local com dados fictícios. Sábado e domingo continuam exigindo os [critérios de prontidão da migração](../migration/readiness.md) e o roteiro operacional fornecido ao responsável, com evidência e decisão para cada critério: dados reais/placas/operadores, serviços/preços, estoque, recebimentos parciais, desistência e estorno aplicável, diferença de caixa, faturas/pacotes/créditos necessários e permissões de equipe. O helper não importa os 5.168 clientes nem os acervos e não converte a história documental em operação.

Integrações externas continuam bloqueadas neste ambiente. Testes reais de Asaas/Baileys/fiscal e seleção/desenvolvimento/homologação de TEF são tarefas separadas, com os titulares e autorizações aplicáveis. Nenhuma conexão, cobrança ou mensagem externa faz parte deste ensaio.

A recuperação manual da instalação real segue o [manual operacional](../operations-jk.md#recuperação-do-banco). Conciliação do delta final, cópia independente, aceite e autorização de corte permanecem necessários; o resultado do helper não concede esse aceite.

## Verificação do helper

```sh
node --test tests/jk-rehearsal.test.mjs
```

Os testes criam apenas diretórios temporários próprios e removem esses diretórios ao terminar. Precisam de permissão para abrir porta em loopback. Falta dessa permissão é falha de ambiente, não aprovação da jornada. O helper não instala dependências e não altera o pacote principal.
