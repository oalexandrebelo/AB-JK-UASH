# JK — autoria de design e mídia verificável

Os quatro projetos pedidos foram utilizados para produzir material concreto. O diagrama deriva do template Diagram Design; Earshot gerou e auditou o som; ManimGX renderizou a cena; Hyperframes compôs a cena com títulos e áudio em um filme de **18 segundos, 1280 × 720, 24 fps**. O pipeline fica em `design/` e não altera dependências ou execução da aplicação.

Abra o [guia estático de atendimento](../design/diagram/order-lifecycle.html) ou a [página de revisão do filme](../design/media/review.html). Esta última usa player HTML nativo, controles visíveis, som inicialmente desativado e `preload="none"`; não há reprodução automática. O texto equivalente e o diagrama continuam disponíveis sem reprodução de mídia. A Visão geral da operação agora oferece o botão **“Como funciona o atendimento”**, que abre a ajuda voluntária com o filme, texto equivalente e acesso ao diagrama completo. A landing page permanece sem player.

## O que foi realmente executado

| Projeto | Entrada concreta | Resultado executado | Evidência |
| --- | --- | --- | --- |
| Diagram Design | Template mínimo oficial adaptado, referência de state machine e perfil JK/Spectrum próprio; conteúdo retirado das transições reais da OS. | HTML único com SVG inline, oito estados, retorno para correção, regras de entrega/cancelamento, `title`/`desc`, equivalente textual e fontes de sistema. | [Fonte final](../design/diagram/order-lifecycle.html), [template upstream](../design/diagram/upstream-template.html), [perfil](../design/diagram/jk-spectrum-profile.json), [verificação](../design/media/evidence/diagram-checks.json). |
| Earshot | Banco `notify/mid_tine`, seed `51`, pico `-16 dBFS`; API procedural `bank.render` e `sfx.check`. | WAV PCM 24-bit, estéreo, 48 kHz, **0,425 s**, auditoria `ok:true`, zero warnings. Não foram carregados pesos, Torch ou modelos de escuta. | [WAV](../design/media/outputs/jk-ready.wav), [receita e auditoria](../design/media/outputs/earshot-report.json), [script](../design/media/sources/render_audio.py). |
| ManimGX | Cena original `OrderFlow`, quatro etapas com carro abstrato e retorno da conferência ao serviço; fonte Noto Sans empacotada pelo motor. | MP4 nativo de **8 s**, 1280 × 720/24 fps; dois storyboards; inspeção automática sem problemas em nove amostras. | [Fonte Python](../design/media/sources/order_scene.py), [MP4 nativo](../design/media/outputs/order-flow.mp4), [storyboard](../design/media/outputs/order-flow.storyboard.png). |
| Hyperframes | Composição HTML seekable de 18 s, GSAP local, cena ManimGX normalizada e duas ocorrências do sinal Earshot. | Filme MP4 H.264 com AAC 48 kHz estéreo, 432 frames. Render local em Chrome headless, software GPU. | [Composição](../design/media/sources/composition.html), [filme](../design/media/outputs/jk-operation.mp4), [recibo completo](../design/media/evidence/render-receipt.json). |

Os testes do template oficial `self_check.py` e `verify-geometry.py` passaram. A inspeção em Chrome verificou larguras de 1400 e 390 px: o documento não excede a viewport e o diagrama mantém seu tamanho legível em um scroll local. Não houve requisição HTTP externa na abertura do diagrama ou do player de revisão. O player foi confirmado `paused:true`, `muted:true`, `autoplay:false`, `controls:true`. [Resultado visual](../design/media/evidence/visual-review.json).

O lint Hyperframes terminou com **zero erros e três avisos** `nested_structure_needs_subcomposition`, um para cada seção da composição única. São recomendações de organização das faixas em arquivos de subcomposição; foram preservadas no recibo. O render não exigiu desabilitar lint, cobertura de frames ou validação de saída. Os quadros de abertura, etapa intermediária e encerramento foram inspecionados visualmente, com texto legível e sem cortes.

## Pins e licenças

As versões abaixo são as efetivamente utilizadas. Main e release não são intercambiáveis; a execução do ManimGX usa a release 0.1.1, não o commit mais novo observado na pesquisa inicial. [Lock de proveniência e hashes](../design/media/upstream.lock.json).

| Projeto | Versão / commit executado ou usado como fonte | Licença / tratamento |
| --- | --- | --- |
| [cathrynlavery/diagram-design](https://github.com/cathrynlavery/diagram-design/tree/0cf73c3fcc56667ad91a9a04c439ac6ccfabc9d1) | Commit `0cf73c3fcc56667ad91a9a04c439ac6ccfabc9d1`; manifesto 2.6.136; skill 2.6. | MIT, aviso preservado em [LICENSE.diagram-design](../design/diagram/LICENSE.diagram-design). Nenhum ícone externo copiado. |
| [heygen-com/hyperframes](https://github.com/heygen-com/hyperframes/tree/4719543e972548a261b8354f0a8dada479ae5d93) | npm `hyperframes@0.8.214`; tag `v0.8.214` → `4719543e972548a261b8354f0a8dada479ae5d93`. | Apache-2.0, [aviso preservado](../design/media/licenses/Hyperframes-Apache-2.0.txt). CLI/motor somente no ambiente de autoria. |
| [Leonxlnx/earshot](https://github.com/Leonxlnx/earshot/tree/591fa3e028032e6dce56620a20e932e35667e8d8) | 0.4.0, commit `591fa3e028032e6dce56620a20e932e35667e8d8`, arquivo de origem fixado por SHA-256. | MIT, [aviso preservado](../design/media/licenses/Earshot-MIT.txt). Uso de banco procedural do tipo `forge`, sem áudio amostrado de cliente ou modelo de ML. |
| [academa-labs/manimgx](https://github.com/academa-labs/manimgx/tree/0507708dc5d731478786de2f46ca8a1660d514d6) | PyPI `manimgx==0.1.1`; tag anotada `dabdde739b3565c84c30f6b7c8eb795ead09148b` → commit `0507708dc5d731478786de2f46ca8a1660d514d6`. | Código MIT; o upstream declara os wheels nativos como conjunto GPL-3.0-or-later por x264. [MIT](../design/media/licenses/ManimGX-MIT.txt) e [avisos completos](../design/media/licenses/ManimGX-THIRD-PARTY.txt) preservados. Wheels/binários não estão no repositório nem no app. |
| GSAP | 3.15.0 no lock npm de autoria. | Licença própria [Standard GSAP](https://gsap.com/standard-license), não rotulada como MIT. JS é copiado apenas para o staging temporário do render. |
| FFmpeg / Chrome | FFmpeg 6.1.1-3ubuntu5; HeadlessChrome 153.0.8010.0 observados neste ambiente. | Ferramentas do host, sem distribuição dos binários. A instalação concreta pode ter componentes GPL; manter seus avisos ao redistribuir binários. |

O código de fontes/tokens/cena/composição da JK é original, exceto o template Diagram Design atribuído e as APIs das ferramentas usadas. O filme não contém fotografias de terceiros, placa, voz, cliente, preço demonstrativo, avaliação, logotipo de montadora ou imagem que alegue retratar o negócio. O nome da JK e o Instagram exato informado são usados como texto. A paleta é uma proposta do cliente local resolvida de `src/jk.css`, não alegação sobre identidade histórica verificada.

## Organização e reprodução

| Arquivo / pasta | Função |
| --- | --- |
| `design/diagram/order-lifecycle.html` | Entregável estático; não depende do app ou de JavaScript. |
| `design/diagram/jk-spectrum-profile.json` | Tokens e fontes de sistema aplicados ao diagrama. |
| `design/media/sources/` | Receita Earshot, cena ManimGX e composição Hyperframes editáveis. |
| `design/media/package.json`, `package-lock.json` | Ambiente npm separado, versões e integridade de resolução. |
| `design/media/requirements.lock.txt` | Todas as 22 distribuições Python da execução fixadas; Python 3.13.9 foi utilizado. |
| `design/media/upstream.lock.json` | URLs/commits, hashes do arquivo Earshot e arquivos críticos, versão dos templates/licenças. |
| `design/media/fetch-upstream.py` | Download explícito do Earshot fixado, verifica SHA-256 antes de extrair e rejeita membros inseguros. Não executa código baixado. |
| `design/media/render.mjs` | Verifica versões/hash de fontes, gera áudio/cena, normaliza vídeo, compõe/linta/renderiza e registra recibo. |
| `design/media/outputs/` | Saídas finais e intermediários intencionais, sem runtimes pesados. |
| `design/media/evidence/` | Comandos, saídas, hashes, verificação visual e histórico resumido de tentativas. |

Requisitos locais: Node 24, Python 3.13+, FFmpeg/ffprobe e Chrome/Chromium compatível. Instalações têm acesso à rede; render usa entradas locais. Os comandos abaixo são a sequência reproduzível, a partir da raiz do repositório. Escolha diretórios de autoria próprios; não use o diretório de dados operacionais.

```sh
npm ci --prefix design/media
python3.13 -m venv /tmp/jk-media-venv
/tmp/jk-media-venv/bin/python -m pip install -r design/media/requirements.lock.txt
python3 design/media/fetch-upstream.py /tmp/jk-media-earshot

JK_MEDIA_PYTHON=/tmp/jk-media-venv/bin/python \
JK_MEDIA_EARSHOT_SOURCE=/tmp/jk-media-earshot \
HYPERFRAMES_BROWSER_PATH=/caminho/para/chrome \
node design/media/render.mjs
```

`JK_MEDIA_NODE_MODULES` é opcional; permite apontar uma instalação externa das mesmas versões e evitar duplicação. Nesta execução foi reutilizado um npm isolado já instalado em `/tmp`, com versões conferidas, e criado venv próprio para Python. Nenhuma dependência foi adicionada ao manifesto raiz.

O Earshot é importado a partir da fonte fixada; não se executa `pip install earshot` com todas as dependências do produto, que incluem Torch e Transformers. Isso é um caminho deliberadamente restrito à API procedural documentada no próprio [bank.py](https://github.com/Leonxlnx/earshot/blob/591fa3e028032e6dce56620a20e932e35667e8d8/earshot/forge/bank.py). Não promete suporte às funções de escuta, busca semântica, transcrição ou modelos do Earshot. O renderer impõe `EARSHOT_OFFLINE=1`, `HYPERFRAMES_NO_TELEMETRY=1` e `DO_NOT_TRACK=1`.

## Ajustes necessários e limites registrados

O primeiro MP4 nativo ManimGX apresentou timestamps variáveis. O Hyperframes interrompeu a renderização ao extrair somente 167 de 192 frames esperados, com cobertura de 87%, abaixo do gate de 95%. O pipeline agora normaliza para CFR de 24 fps com FFmpeg, GOP de 24 e último frame sustentado dentro dos oito segundos da cena. A nova renderização registrou `minVideoFrameCoverageRatio:1` e zero preflights VFR; o gate não foi desligado. O MP4 nativo é preservado separado de `order-flow-cfr.mp4`.

Também houve ajuste do requisito NumPy: 2.3.4 não satisfazia o ManimGX 0.1.1, que exige pelo menos 2.4.3. O conjunto compatível resolvido foi congelado. O sandbox inicialmente bloqueou subprocesso de render; o render local autorizado foi executado no ambiente adequado. O primeiro gravador de recibo tentou ler diretório temporário como arquivo após concluir MP4; foi corrigido para registrar somente arquivos regulares e o pipeline inteiro passou novamente. [Registro das tentativas](../design/media/evidence/render-attempts.json).

Os oito artefatos de saída registrados no recibo somam aproximadamente 1,0 MB. O filme final tem **416.359 bytes**, o poster **103.535 bytes** e o WAV **122.444 bytes** nesta execução. Esses são tamanhos dos arquivos gerados, não do bundle de aplicação, do npm instalado ou dos runtimes Python/Chrome. O recibo inclui hash SHA-256 por arquivo, versão observada e saída completa do ffprobe.

Não foi produzido corte vertical, campanha com locução, álbum de fotos, player Hyperframes de navegador ou notificação sonora operacional. O WAV é um ativo pronto, mas não está ligado a eventos da API/UI. Nenhum material foi publicado em rede social, nenhuma mensagem foi enviada a cliente, e o filme não comprova migração/homologação. A integração entregue inclui a autoria local com arquivos reais, reprodução documentada e sua incorporação voluntária à ajuda operacional.

## Incorporação na interface

**Estado: incorporado à ajuda da Visão geral.** O botão secundário “Como funciona o atendimento”, na seção Ritmo da operação, abre o componente [`HelpFlow`](../src/components/HelpFlow.tsx) em um diálogo Spectrum 2. O MP4 é reproduzido pelo elemento HTML nativo `video`, com controles visíveis, `muted`, `playsInline`, dimensões 1280 × 720 e `preload="none"`. Não há `autoplay`. O componente só é montado ao abrir a ajuda; o som começa desativado e pode ser ativado voluntariamente pelos controles. Fechar o diálogo desmonta o player.

O texto equivalente acompanha o vídeo: aguardando (`waiting`), execução (`in_progress`), conferência (`quality_check`) e pronta (`ready`); a conferência e a etapa pronta permitem retorno à execução para correções. A entrega exige saldo quitado ou cliente habilitado para pós-pago. Esse texto e um aviso de indisponibilidade permitem consultar o fluxo mesmo se o vídeo falhar. O link “Abrir diagrama completo (nova aba)” abre o guia estático sem alterar o atendimento.

Somente as saídas finais abaixo foram copiadas para ativos públicos versionados. Não foi adicionado script ao prebuild, dependência ao manifesto raiz ou runtime Hyperframes, ManimGX, Earshot ou GSAP ao cliente.

| Arquivo publicado | Origem de autoria | Verificação / adaptação |
| --- | --- | --- |
| [`public/media/jk-operation.mp4`](../public/media/jk-operation.mp4) | `design/media/outputs/jk-operation.mp4` | Cópia binária idêntica, 416.359 bytes; SHA-256 `4df6dfd838eee5bcae07b3e4ae7fbe118fa6494951a85907e1209fb37353ed11`. |
| [`public/media/jk-operation-poster.png`](../public/media/jk-operation-poster.png) | `design/media/outputs/jk-operation-poster.png` | Cópia binária idêntica, 103.535 bytes; SHA-256 `777c3d61c82892bf29592418522a9e5eb0503ba11d18a73bd1c69826006255d5`. |
| [`public/guides/order-lifecycle.html`](../public/guides/order-lifecycle.html) | `design/diagram/order-lifecycle.html` | Cópia de publicação com o mesmo diagrama e equivalente textual. O rodapé usa referências de proveniência em texto, evitando links relativos para arquivos que não são servidos pelo app. A licença MIT do template foi incorporada integralmente em comentário HTML. |

Os dois binários públicos somam **519.894 bytes**. O HTML estático acrescenta cerca de 9 KB. Fontes, saídas originais, recibos de renderização e evidências de revisão em `design/` não foram alterados durante a incorporação. Atualizações futuras devem copiar novamente as saídas finais após renderização e conferir os hashes contra o recibo correspondente; a adaptação do rodapé/licença aplica-se somente à cópia pública do diagrama.

A incorporação passou por `npm run typecheck`. O build final e a revisão DOM/visual integrada ficam na verificação compartilhada da aplicação; os resultados do player de revisão de autoria descritos acima não foram reclassificados como teste deste modal.

Uma eventual notificação sonora da operação continua fora deste escopo: ela exigiria preferência persistida do operador e gesto de ativação explícito, com estado visual equivalente. O WAV não foi ligado a eventos da API/UI. O vídeo e o diagrama não enviam mensagens, alteram etapas, registram pagamentos ou comprovam homologação.
