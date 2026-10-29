# OCR local de placas — AB-UASH

## Integração e comportamento

```tsx
import PlateReader from './features/ocr/PlateReader';

<PlateReader onPlate={(plate) => setPlate(plate)} />
```

`onPlate` recebe apenas a placa que a pessoa conferiu e confirmou em **Usar placa
conferida**. Selecionar uma foto ou terminar a leitura não altera o cadastro.
O componente usa React e Adobe Spectrum 2 já presentes no projeto.

O usuário seleciona uma foto PNG/JPEG, recortada ao redor dos caracteres, e clica
em **Ler placa**. O leitor mostra texto, candidatos e a confiança informada pelo
motor. A conferência permite corrigir os sete caracteres. `O`/`0`, `I`/`1` e
outras ambiguidades nunca são substituídas automaticamente.

O módulo usa OCR genérico de uma linha de texto. Não contém detector automático
de placas, rastreamento, consulta de proprietários, cadastro externo, câmera,
envio de fotos ou reconhecimento industrial de veículos. Reflexos, inclinação,
baixa resolução, emblemas e contexto ao redor dos caracteres podem causar erro.
A confiança exibida é uma pontuação do motor, não uma probabilidade calibrada.

## Execução local

O cliente cria um `Worker` nativo da mesma origem e usa somente:

- `/ocr/worker.min.js`, de Tesseract.js **7.0.0**;
- `/ocr/core/`, com os seis builds oficiais de Tesseract.js-core **7.0.0**;
- `/ocr/lang/eng.traineddata.gz`, modelo **4.0.0_best_int**, do pacote
  `@tesseract.js-data/eng` **1.0.0**.

Os arquivos `.wasm.js` contêm o binário WASM embutido. O worker seleciona a
variante LSTM compatível com o dispositivo, incluindo SIMD/Relaxed SIMD quando
disponível. Os caminhos de core e modelo são explícitos; não se usa o CDN padrão.
As imagens chegam ao worker como bytes preparados no navegador, nunca como URL.
`dataPath: '/ocr'` é um diretório na memória do WASM, não um endereço de rede.
`FS.chdir('/ocr')` permite que a inicialização encontre o modelo nesse diretório.

O adaptador em `client.ts` usa a sequência de mensagens da versão fixada. Isso
permite encerrar o worker imediatamente por cancelamento, desmontagem ou limite
de 60 segundos, inclusive durante sua inicialização. O cache de modelo do
Tesseract/IndexedDB fica desativado (`cacheMethod: 'none'`). Não há persistência
da foto pelo módulo OCR. O navegador ainda pode usar seu cache HTTP normal para
os arquivos estáticos do motor.

O limite é 10 MiB por arquivo, 16 milhões de pixels e 8.192 pixels por lado.
As dimensões PNG/JPEG são inspecionadas antes de decodificar. O buffer enviado
ao OCR é limitado a 2.400 pixels por lado e 4 milhões de pixels. O canvas
reencoda a imagem como PNG e remove os metadados. O bitmap é fechado, o canvas
libera as dimensões e as URLs de preview são revogadas no descarte.

## Servidor e CSP

O conteúdo de `public/ocr` deve acompanhar a compilação do Vite. Não mover os
arquivos para uma CDN. O endpoint deve servir `.js` como JavaScript e `.gz` como
`application/gzip`. **Não** acrescentar `Content-Encoding: gzip` especificamente
ao `.traineddata.gz`: o próprio worker descompacta esse arquivo.

Diretivas necessárias na CSP, combinadas com as demais diretivas do app:

```text
script-src 'self' 'wasm-unsafe-eval';
worker-src 'self';
connect-src 'self';
img-src 'self' data: blob:;
```

`wasm-unsafe-eval` permite compilar o motor WebAssembly; `unsafe-eval` não é
necessário. O worker é carregado diretamente por URL local, sem worker `blob:`.
A permissão `blob:` de imagem atende ao preview local da foto.

## Prova executada e limites da validação

Rodar a partir da raiz do app com Node 24:

```bash
node tests/ocr-engine.test.mjs
node tests/ocr-input.test.mjs
```

`ocr-engine.test.mjs` executa **o próprio worker browser vendorizado**, com o
mesmo WASM e o mesmo modelo distribuídos no app. O adaptador de testes fornece
`importScripts`, mensagens e um `fetch` restrito a arquivos de `public/ocr`.
Qualquer URL fora dessa origem/caminho é rejeitada. Não há serviço OCR, mock de
texto reconhecido, dependência npm de teste ou acesso à rede nesse teste.

Resultados reais registrados em `test-results.txt`:

| Fixture sintética | Texto reconhecido | Confiança do motor |
| --- | --- | --- |
| `tests/ocr-fixtures/mercosul.png` | `ABC1D23` | 91/100 |
| `tests/ocr-fixtures/legacy.png` | `ABC1234` | 5/100 |

As duas fixtures são texto preto sobre fundo branco, 1.100 × 280 pixels, criado
localmente em DejaVu Sans Bold. Não são fotografias de clientes nem dados
inseridos na aplicação. Esses resultados provam que o motor executa e que os
assets/protocolo funcionam; não medem acurácia em fotos reais. A baixa confiança
de um resultado correto também reforça a necessidade de conferência.

O teste verifica todos os SHA-256 de `assets-manifest.json`. Os testes de
entrada cobrem tamanho, dimensões declaradas excessivas, arquivo truncado/SVG,
cancelamento já solicitado e candidatos sem substituição de caracteres.

**Não foi concluído um teste em navegador real nesta execução.** O navegador
controlado do ambiente não alcançava o servidor `127.0.0.1` deste workspace.
O adaptador Node não valida CSP no navegador, canvas, seletor de arquivo,
layout, foco ou interação com Spectrum. Esses pontos exigem uma execução
local em navegador suportado; não foram apresentados como aprovados.

Para verificar no navegador, abra o cadastro de veículo no app local, selecione
uma das fixtures, execute a leitura e confirme que a placa só é preenchida após
**Usar placa conferida**. Verifique também cancelamento e uma imagem ilegível.
No painel Network, a operação OCR deve carregar apenas assets da mesma origem
sob `/ocr/`, sem enviar a imagem. O servidor local precisa continuar disponível
para entregar esses arquivos; “local” não significa que uma página não
previamente carregada funciona sem o servidor.

## Proveniência e licenças

`assets-manifest.json` registra origem, versão, tamanho e SHA-256 dos arquivos.
`vendor-install-lock.json` preserva os tarballs e integridades npm da obtenção,
feita em diretório temporário com `--ignore-scripts`. O `package.json` do app
não precisou de novas dependências para OCR.

`licenses/` preserva os textos de licença oficiais e os metadados dos pacotes.
O aviso fornecido no bundle fica também em
`public/ocr/worker.min.js.LICENSE.txt`. Foram preservados os avisos completos
de buffer e ieee754 que esse bundle menciona. Os metadados do pacote npm
`@tesseract.js-data/eng` declaram MIT, enquanto o repositório dos modelos
fornece Apache-2.0; ambas as evidências foram mantidas sem reescrever seus termos.

Fontes técnicas primárias consultadas:

- [Tesseract.js — releases oficiais](https://github.com/naptha/tesseract.js/releases)
- [Tesseract.js — API](https://github.com/naptha/tesseract.js/blob/master/docs/api.md)
- [Tesseract.js — instalação local](https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md)
- [Tesseract.js-core](https://github.com/naptha/tesseract.js-core)
- [Tessdata — modelos e hospedagem local](https://github.com/naptha/tessdata)

Os documentos da versão npm 7.0.0 efetivamente usada, seu `createWorker.js` e a
seleção de core browser estão em `upstream-docs/`. Uma atualização do motor deve
atualizar assets e hashes, revisar esse protocolo e repetir a prova real.
