# Baileys — origem e limite da validação

Verificado em 30/10/2026, por leitura do repositório, tag e metadados npm oficiais:

- Projeto: [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys).
- Versão fixada: [`baileys@7.0.0-rc14`](https://github.com/WhiskeySockets/Baileys/releases/tag/v7.0.0-rc14). É uma versão release candidate.
- [package.json da tag](https://github.com/WhiskeySockets/Baileys/blob/v7.0.0-rc14/package.json): ESM; Node >=20; licença MIT. Este adapter exige Node 24, como o JK.
- Tarball: `https://registry.npmjs.org/baileys/-/baileys-7.0.0-rc14.tgz`.
- Integridade publicada no npm: `sha512-pewtrljhWx5JTUBvvkXZz1fL3JPiwzjBsnhx/DWf2LWBx1cZNH7J/sF22xDehba5mySWUQU4a1Pwt7lWARUxaA==`.
- [Exemplo oficial](https://github.com/WhiskeySockets/Baileys/blob/v7.0.0-rc14/Example/example.ts): eventos `connection.update`, `creds.update`, `requestPairingCode`, `sendMessage` e opção `messageId`.
- [Razões de desconexão](https://github.com/WhiskeySockets/Baileys/blob/v7.0.0-rc14/src/Types/index.ts): logout, substituição da conexão, sessão inválida e incompatibilidade exigem revisão do titular.
- [Estado de autenticação de referência](https://github.com/WhiskeySockets/Baileys/blob/v7.0.0-rc14/src/Utils/use-multi-file-auth-state.ts): a própria fonte recomenda banco de dados para produção. O adapter usa SQLite nativa, sem copiar esse armazenamento em arquivos.

`package-lock.json` pertence somente a este subpacote. A resolução foi feita com `--package-lock-only --ignore-scripts`, sem executar código de dependências. A versão e os arquivos de licença devem ser preservados em qualquer distribuição. A licença MIT do Baileys está em `licenses/Baileys-MIT.txt`; as licenças transitivas permanecem nos respectivos pacotes instalados e precisam acompanhar uma distribuição que os inclua. Fixar a versão e resolver o lockfile não equivale a auditar todas as dependências ou homologar o protocolo externo.

O inventário `licenses/dependencies.json` registra 95 entradas do lockfile, todas com declaração de licença. Há uma dependência obrigatória `libsignal@6.0.0` declarada **GPL-3.0**; sua licença foi preservada em `licenses/libsignal-GPL-3.0.txt`. Os pacotes de plataforma de sharp/libvips também declaram LGPL-3.0-or-later. Portanto, o conjunto de dependências não é integralmente MIT. Uma distribuição que inclua esse componente precisa tratar as condições dessas licenças; a verificação local de funcionamento não constitui análise de compatibilidade de licença do produto distribuído.

Os testes deste repositório usam SDK/socket falsos, disco temporário e SQLite reais. Eles não autenticam conta, não abrem socket WhatsApp e não enviam mensagens. A compatibilidade de importação do pacote real e o pareamento do titular são verificações separadas, registradas no relatório de evidência quando executadas.
