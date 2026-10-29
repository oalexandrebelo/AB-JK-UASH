# Origem e adaptações dos conectores

Fonte fornecida para esta implementação: snapshot `audit-fontes/ab-uash`, pasta `server/connectors` e leitor de segredos `server/integrations/secrets.ts`. O snapshot não contém metadados Git locais suficientes para atribuir um commit; `vendor/manifest.json` registra SHA-256 de cada arquivo fonte exato.

Foram reaproveitados somente código de transporte HTTPS, perfis/validação/conector Pix, conector/validação WhatsApp e leitura confinada de segredos. Nenhum arquivo de dados, banco, certificado, configuração de conta ou credencial foi copiado. O namespace de tabelas do `main` não é importado.

Adaptações deliberadas:

1. Tipos TypeScript removidos com `node:module.stripTypeScriptTypes`, modo `transform`, em Node 24; extensões dos imports mudadas de `.ts` para `.mjs`. Os módulos resultantes não exigem TypeScript ou bibliotecas adicionais no runtime.
2. `PixBankingAdapter` aguarda `journal.reserve()` e `journal.find()`, para usar o store assíncrono da 0.2.1. O reexport do journal síncrono específico de SQLite foi removido.
3. `AsyncPixChargeJournal` é uma implementação nova para a tabela `jk_pix_journal` no store atual. Não abre outro banco.
4. Toda associação à OS, idempotência de rotas, lease, autorização, outbox, preparação, baixa e validação de evidências da ponte fica em `server/jk-integrations.mjs` e nas tabelas `jk_*`.
5. O fiscal permanece na implementação já existente de `integrations/fiscal` e `server/fiscal.mjs`, evitando importar bibliotecas XML e um segundo modelo fiscal incompatível.

A semântica externa é preservada e verificada com fixtures dos conectores reais: criação de cobrança não confirma pagamento; comprovantes autenticados são exigidos; sucesso de WhatsApp confirma somente aceitação. As configurações de conta e o comportamento real de cada provedor ainda precisam de validação no respectivo ambiente autorizado.
