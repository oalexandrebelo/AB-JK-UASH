# WhatsApp pelo Baileys: instalação e pareamento do titular

O provedor `whatsapp-baileys` usa [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys), uma biblioteca para WhatsApp Web. Ele é diferente da Cloud API oficial da Meta. A versão fixada é `baileys@7.0.0-rc14` (release candidate), licença MIT; a [origem, integridade e referências](../../integrations/whatsapp-baileys/PROVENANCE.md) estão registradas junto ao subpacote.

A licença MIT é do Baileys. A dependência obrigatória `libsignal@6.0.0` declara GPL-3.0 e há pacotes de plataforma com LGPL. O [inventário de dependências](../../integrations/whatsapp-baileys/licenses/dependencies.json) registra essas declarações. A preparação local não libera automaticamente uma distribuição comercial que inclua todo esse conjunto.

O protocolo Web e as regras de aparelhos conectados podem mudar, invalidar a sessão ou limitar a conta. O titular precisa poder reconectar e manter outro meio de contato com o cliente. Uma aceitação do socket não prova entrega ou leitura. O adapter não oferece disparos em massa, respostas automáticas, grupos, mídia, importação de conversas ou confirmação de entrega.

## 1. Instalar o componente opcional

Use Node 24, como na aplicação JK. Na pasta do projeto:

```sh
cd integrations/whatsapp-baileys
npm ci --ignore-scripts --no-audit --no-fund
npm run verify:installed
```

O lockfile é exclusivo desse subpacote. A instalação não exige alterar `package.json` nem `package-lock.json` da raiz. Os scripts de dependências ficam desativados. O comando de verificação só importa o SDK e faz uma gravação/leitura sintética de autenticação em pasta temporária, com rede bloqueada; não constrói socket, não usa conta e não envia mensagens.

## 2. Reservar uma pasta privada

Escolha uma pasta absoluta **fora de qualquer repositório Git** e fora de diretórios públicos ou sincronizados. Um exemplo no Mac é `~/Library/Application Support/AB-JK-UASH/baileys/`. Use diretórios com permissão `700` e arquivos privados com `600`, pertencentes ao usuário que executará o processo.

Dentro dessa pasta, crie `pairing.json` com este formato. Substitua os valores indicados pelo número do titular e pelo caminho absoluto real; variáveis como `$HOME` não são expandidas dentro do JSON.

```json
{
  "authDir": "/caminho/privado/fora/do/repositorio/baileys/session",
  "accountPhone": "DDIDDDNUMERO_SOMENTE_DIGITOS",
  "templates": [
    {
      "templateName": "order_ready",
      "languageCode": "pt_BR",
      "text": "Olá! A OS {{1}} está pronta para retirada."
    }
  ]
}
```

`accountPhone` deve conter código do país, DDD e número, somente dígitos, sem `+`. O adapter recusa uma conta conectada diferente desse número. `authDir` é criado com acesso privado quando ainda não existe; diretórios e arquivos existentes com permissões amplas, symlinks ou banco de origem desconhecida são recusados.

`session.sqlite` contém credenciais, chaves de sessão e registros de deduplicação. Trate-o como credencial: não anexe a suporte, não registre no Git e não coloque em um download da aplicação. O SQLite não é cifrado pelo adapter; a proteção em disco depende do usuário do sistema, das permissões e da cifra do dispositivo/volume. Restrinja também backups. Preserve a base completa: ela inclui as chaves que impedem reenvios acidentais.

## 3. Parear em terminal privado

Encerre primeiro qualquer servidor que esteja usando o mesmo `authDir`. O arquivo `session.lock` impede dois processos de usar a sessão simultaneamente. Não remova esse arquivo de um processo em execução.

No terminal do próprio titular, na pasta `integrations/whatsapp-baileys`, execute, ajustando o caminho:

```sh
export AB_JK_BAILEYS_CONFIG_FILE="/caminho/privado/baileys/pairing.json"
export AB_JK_BAILEYS_CONNECT_ENABLED=true
export AB_JK_BAILEYS_SEND_ENABLED=false
export AB_JK_INTEGRATIONS_ENABLED=false
export AB_JK_ALLOW_PRODUCTION=false
npm run pair
```

O comando exige terminal interativo, mostra o código de pareamento apenas nesse terminal e não imprime o QR bruto. No celular do titular, abra **WhatsApp → Aparelhos conectados → Conectar aparelho → Conectar com número de telefone** e informe o código. A redação dessa opção pode variar com a versão do aplicativo. O comando termina depois de observar a conexão com a conta esperada e persistir as credenciais. O prazo do comando é de três minutos; um vencimento não declara a sessão conectada.

Não copie o código, payload de QR ou credenciais para chats, capturas ou registros de atendimento. Se a biblioteca produzir um QR, o adapter também pode entregá-lo ao callback explícito `onPairing({ qr })` de um operador local; esse dado não integra o status público. A CLI usa pareamento por código. Não há renderizador de QR nem endpoint público de pareamento nesse componente.

Para conferir o componente sem abrir conexão:

```sh
npm run status
```

Esse status é deliberadamente `disconnected`: ele examina o componente offline e não comprova que a conta continua conectada. A conexão real será observada pelo processo que mantiver o socket aberto.

## 4. Configurar o provedor na aplicação JK

No arquivo privado de integrações usado pelo servidor, a entrada Baileys segue este contrato:

```json
{
  "kind": "whatsapp-baileys",
  "environment": "production",
  "accountPhone": "DDIDDDNUMERO_SOMENTE_DIGITOS",
  "authDir": "/caminho/privado/fora/do/repositorio/baileys/session",
  "templatesFile": "baileys-templates.json"
}
```

`templatesFile` é uma referência relativa à raiz privada `AB_JK_SECRETS_ROOT`, lida pelo runtime; o arquivo contém o array de modelos locais mostrado no passo 2. O `authDir` e o número precisam coincidir com o pareamento. Encerre a CLI antes de iniciar o servidor. A construção do adapter não acessa o WhatsApp; o runtime precisa chamar `connect()` de forma explícita e refletir `status().connectionVerified` em sua prontidão.

Para manter o socket conectado com o envio ainda bloqueado, habilite somente `AB_JK_BAILEYS_CONNECT_ENABLED=true`. Para permitir um envio solicitado na aplicação, são necessários **todos** os gates:

| Variável | Valor exigido |
| --- | --- |
| `AB_JK_BAILEYS_CONNECT_ENABLED` | `true` para abrir a conexão |
| `AB_JK_BAILEYS_SEND_ENABLED` | `true` para despachar mensagem |
| `AB_JK_INTEGRATIONS_ENABLED` | `true` para efeitos externos |
| `AB_JK_ALLOW_PRODUCTION` | `true` para ambiente real |

Baileys não tem sandbox de entrega: conectar pareia uma conta real e enviar alcança um destinatário real. A habilitação desses gates pertence ao titular/deployment autorizado. Confirme o destinatário, o texto e a autorização do cliente antes do envio na aplicação. A execução feita para preparar este componente não habilitou conta nem enviou mensagem.

Os nomes `templateName`, `languageCode` e `bodyParameters` identificam **modelos locais de texto**, não modelos aprovados pela Meta. O catálogo aceita marcadores sequenciais `{{1}}` a `{{30}}`, recusa modelos não configurados e exige o número exato de parâmetros. Não substitua um modelo da Cloud API por Baileys silenciosamente: revise o catálogo local, o provedor e a conta no registro preparado.

## 5. Interpretar os resultados

- `SUCCEEDED` significa que `sendMessage` retornou o mesmo ID reivindicado antes do envio; a referência é `baileys:<id>`, com `acceptance: socket-accepted` e `delivery: unconfirmed`.
- `UNKNOWN` significa que o resultado ficou sem confirmação, inclusive por timeout, falha de rede ou interrupção. Não envie novamente com uma nova chave para tentar resolver a dúvida; confira o aplicativo do titular e o registro da operação.
- A chave de idempotência é obrigatória. Uma repetição com a mesma chave e o mesmo conteúdo retorna a evidência persistida sem chamar `sendMessage` novamente. A mesma chave com outro conteúdo é recusada. Uma reivindicação interrompida antes da persistência do resultado permanece incerta após reiniciar.
- Essa é uma garantia local de não retransmissão automática por chave. Ela não transforma WhatsApp Web em uma API de entrega exatamente uma vez e não elimina reenvios feitos manualmente com novas chaves.

O adapter desativa previews de links e tentativas automáticas de recuperação de mensagem da biblioteca; não armazena texto, destinatário ou conversas no seu registro de despacho. Guarda hashes, ID de mensagem e resultado. As credenciais/chaves de autenticação continuam sensíveis.

## 6. Queda, logout e encerramento

Depois de uma queda transitória, o adapter recria somente a conexão, com até cinco tentativas por processo, após 1, 2, 4, 8 e 16 segundos. Esse orçamento não se reinicia em cada abertura. Ele não repete operações de envio. Ao esgotar o orçamento, o estado vira `reconnect-exhausted` e exige revisão do operador.

Logout, conexão substituída, sessão inválida, bloqueio ou incompatibilidade deixam o estado `reauth-required` e não geram loop de reconexão. `account-mismatch` bloqueia uma conta diferente da configurada. Confirme os aparelhos conectados no celular e revise a situação antes de parear novamente. A CLI não apaga sessões nem revoga aparelhos automaticamente.

No encerramento normal, `close()` cancela a reconexão, encerra o socket, registra como incerto um despacho interrompido e libera o lock. Um encerramento abrupto pode deixar `session.lock`; antes de removê-lo, confirme no sistema operacional que o PID nele registrado não está em execução e que nenhum outro processo usa a pasta. Não apague `session.sqlite` como tentativa de recuperação: isso também perderia a deduplicação. A revogação de um aparelho é feita pelo titular no WhatsApp.

## Verificação realizada e limites

```sh
node --test tests/baileys-adapter.test.mjs tests/baileys-cli.test.mjs
```

Os testes usam sockets/SDK falsos e SQLite/disco temporários reais. Cobrem gates, conta esperada, QR/código sintéticos, catálogo local, autenticação, permissões/locks, reconexão limitada, timeout, cancelamento e deduplicação concorrente/persistida. A importação e a serialização de auth do SDK instalado têm verificação offline separada (`npm run verify:installed`). Não houve pareamento de conta, QR real, mensagem, entrega, homologação de WhatsApp ou alteração de produção.
