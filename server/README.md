# Backend local AB-UASH

O domínio entregue é lava-rápido/estética automotiva. O contrato completo de cadastros, ordens, agenda, estoque, financeiro, pacotes, folha, mensagens e relatórios está em `server/CONTRACT.md`. `createApplication()` inicializa e oferece todos os módulos por padrão, incluindo fotos locais do módulo `media.mjs`.

## Execução

O servidor usa módulos nativos de Node.js e `node:sqlite`. Foi executado com **Node 24.19.0 / SQLite 3.53.3**. Não há dependências npm de runtime do backend.

```sh
node server/index.mjs
```

Por padrão atende em `http://127.0.0.1:4173`, serve a interface compilada em `dist/` e mantém o SQLite em `data/ab-uash.sqlite`. `PORT`, `HOST`, `DB_PATH` e `DIST_DIR` podem ser configurados por ambiente. O servidor rejeita bind externo sem `PUBLIC_ORIGIN` explícito. O uso suportado nesta entrega é local em loopback. A interface e a API usam a mesma origem.

Não há senha padrão ou usuário pré-criado. No primeiro acesso, `POST /api/setup` cria o administrador inicial. Senhas devem ter de 12 a 128 caracteres; espaços de uma senha são preservados. A criação inicial verifica novamente, dentro de transação, que ainda não há usuários.

## Contrato JSON

Sucesso: `{ "ok": true, "data": ... }`.

Falha: `{ "ok": false, "error": { "code": "CODIGO", "message": "Mensagem", "requestId": "uuid", "details": { "campo": "Erro opcional" } } }`.

Todos os corpos de mutação devem usar `Content-Type: application/json`. Após setup/login, o browser recebe um cookie `HttpOnly`, `SameSite=Strict`, `Path=/` e validade fixa de oito horas. As respostas retornam `csrfToken`; mutações autenticadas exigem esse valor no cabeçalho `X-CSRF-Token`. O token de sessão original não é guardado no banco, somente seu SHA-256. O token CSRF permanece associado à sessão no banco.

| Método e rota | Corpo / resultado | Permissão |
| --- | --- | --- |
| `GET /api/health` | `{status:"ok"}` | Público, host válido |
| `GET /api/status` | `{setupRequired,user,csrfToken?,expiresAt?}` | Público, host/origem válidos |
| `GET /api/auth/session` | Mesmo contrato de status | Público, host/origem válidos |
| `POST /api/setup` | `{name,email,password}` → sessão e admin | Apenas banco sem usuários |
| `POST /api/auth/login` | `{email,password}` → sessão e usuário | Público, com limitação de tentativas |
| `POST /api/auth/logout` | `{}` → `{loggedOut:true}` | Autenticado + CSRF |
| `POST /api/auth/password` | `{currentPassword,newPassword}` → nova sessão | Autenticado + CSRF |
| `GET /api/users` | `{items:[user]}` | Admin |
| `POST /api/users` | `{name,email,password,role}` → `{user}` | Admin + CSRF |
| `PATCH /api/users/:id` | Campos opcionais `{name,role,active}` → `{user}` | Admin + CSRF |
| `GET /api/audit?limit=100` | `{items:[event]}`, limite 1–500 | Admin ou manager |

Usuário público: `{id,name,email,role,active,createdAt}`. Papéis disponíveis: `admin`, `manager`, `operator`, `viewer`. Troca de papel e desativação invalidam todas as sessões da conta; não é possível desativar/rebaixar o último administrador ativo. Troca de senha revoga as sessões anteriores e emite uma nova sessão para a operação atual.

## Persistência e integridade

O banco usa tabelas `STRICT`, chaves estrangeiras, WAL e `synchronous=FULL`. Instruções com valores dinâmicos usam parâmetros preparados. Mutações críticas usam `BEGIN IMMEDIATE` e callbacks síncronos, sem `await` dentro de transações. `idempotentWrite` vincula uma chave ao ator e ao hash canônico de método, rota e corpo; grava mutação, auditoria e resposta de replay na mesma transação. Uma chave reutilizada com outro conteúdo retorna 409. Chaves idempotentes não expiram automaticamente.

A trilha de auditoria registra UUIDs de atores e recursos, ação, instante UTC e metadados permitidos pelo chamador. Ela não registra senhas, corpo completo de requisições, e-mail de tentativa de login ou token de sessão. Eventos de autenticação com falha não identificam a conta solicitada. As consultas administrativas autorizadas ainda retornam nomes e e-mails necessários à operação.

## Controles e limites

- Senhas: scrypt com N=32768, r=8, p=1, sal aleatório de 32 bytes e derivação de 64 bytes. A conta inexistente usa uma derivação equivalente antes de retornar erro genérico.
- Host é validado para reduzir exposição a DNS rebinding; Origin e `Sec-Fetch-Site` são verificados. Não há CORS liberado.
- JSON limitado a 64 KiB, timeout HTTP, cabeçalhos de segurança e caminhos estáticos restritos a `dist/`, incluindo resolução de links simbólicos.
- Limitação de login permanece em memória (reiniciar o processo zera contadores). São bloqueadas, por 15 minutos, as tentativas após 12 falhas por IP ou identificador de conta. O uso é local, sem proxy confiável configurado.
- O SQLite e os arquivos locais não são criptografados em repouso. A proteção depende da conta do sistema e do disco. O arquivo principal é criado com modo `0600` e o diretório novo com `0700`.
- Não há TLS nativo, MFA, e-mail, recuperação remota de senha ou integração externa. `COOKIE_SECURE=true` só deve ser usado quando houver HTTPS configurado fora deste processo; não transforma HTTP em HTTPS.
- Não há sincronização multiusuário distribuída nem rotina automática de backup. Copiar um SQLite em uso exige uma estratégia consistente que inclua WAL; parar o servidor antes de copiar os dados é o procedimento simples.
- A trilha de auditoria é local, não uma prova inviolável contra quem tem acesso de escrita ao arquivo do banco.

## Verificação executada

```sh
node --test --test-reporter=spec tests/backend.test.mjs tests/domain.test.mjs tests/security-review.test.mjs tests/media.test.mjs
```

Verificação integrada: **23 testes passaram**, com HTTP real em loopback e SQLite temporário. O resultado completo está em `server/TEST-RESULTS.txt`. Além do núcleo de autenticação, os casos verificam preço/comissão capturados, rateio exato em centavos, estado da OS, recebimentos concorrentes, reconciliação de caixa, estoque e reversão, agenda/conversão, faturas, pacotes/arredondamento, folha local, mensagens sem envio, paginação e datas no fuso de São Paulo. A revisão independente também confirmou que revogação de sessão durante a chegada do corpo HTTP bloqueia tanto mutações novas quanto replay idempotente (domínio e fotos), que crédito ativo de zero centavos impede cancelamento/reescrita e que symlinks não expõem arquivos fora da interface compilada.

O saldo a receber usa uma consulta com agregações separadas de recebimentos e créditos antes de unir as ordens; não faz uma consulta por ordem nem multiplica valores ao combinar vários recebimentos e resgates. Uma regressão de carteira mista (direto, fatura, créditos, orçamento e cancelamento) verifica o saldo de 2.200 centavos.

O ambiente de execução exigiu autorização automática para abrir o socket local; não houve acesso ao serviço real. Testes de armazenamento/backup, OCR e interface são de outras frentes e não estão incluídos no total acima.

## Decisões operacionais explícitas

- Cadastros, OS e ações usam versão para impedir sobrescrita concorrente. Toda mutação de domínio exige chave idempotente; o replay revalida sessão e papel dentro da transação.
- Alterar apenas o responsável da OS preserva preço, duração e comissão capturados. Enviar `items` no PATCH recaptura os preços/taxas atuais. Isso deve ficar claro no formulário de edição.
- Recebimentos não são reembolsos bancários; a entrega não implementa estorno financeiro de valor já recebido. O cancelamento de uma OS recebida é bloqueado. Estoque e resgates de pacote têm reversão local antes do encerramento.
- A folha é cálculo e registro local, sem encargos ou interpretação trabalhista. O rascunho pode ser recalculado antes de aprovação, e a mesma comissão não entra em duas folhas.
- Mensagens são somente rascunhos/fila local. Não existe confirmação de entrega externa. Recibos são NÃO FISCAIS.
- Relatórios usam datas do estabelecimento em `America/Sao_Paulo`, com instantes armazenados em UTC. Exportadores devem percorrer `page.hasMore` até o fim; saldos e estoque são posições atuais, mesmo quando o relatório inclui filtro de período.
- Listas internas extensas de uma única OS/caixa ainda são retornadas completas; a paginação é aplicada às coleções principais e relatórios. O servidor SQLite síncrono foi destinado ao uso local, não a escalabilidade distribuída.

Referência oficial do módulo usado: <https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html>.
