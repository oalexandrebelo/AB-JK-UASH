# Proveniência · AB-JK-UASH 0.1.0

## Origem e autorização

Este cliente foi preparado a pedido do responsável pela operação do Lava Rápido JK. O usuário autorizou a criação de um novo repositório público e a implementação das funções necessárias. O conteúdo publicado é código, documentação e ativos de autoria; nenhum banco operacional, exportação de clientes, credencial, cookie de sessão ou certificado acompanha a fonte.

A origem foi materializada como snapshots de arquivos, sem copiar o histórico Git privado para o novo repositório.

| Origem | Referência verificada | Uso |
| --- | --- | --- |
| AB-UASH, linha 0.2.1 | `630d295aaa72a7fe08cacde6182c07790638ba91`, branch `work/ab-uash-macmini-20261021` | Base operacional: usuários e papéis, cadastros, agenda/OS, caixa/pós-pago, estoque, pacotes, equipe, fotos/OCR, fiscal e SDK |
| AB-UASH, main | `b2dc7785ef99166287f06dead2d985def8eb36b0` | Subconjunto de conectores Pix e WhatsApp, transporte seguro e leitura de segredos, adaptado à persistência 0.2.1 |
| AB-R3A | `e76c4aff2d97b27ae00ebefcf60f16804130edd8`, produto 1.5.0 | Referência do processo de auditoria e pin do REA |
| REA | npm `rea-agents@6.7.0` | Ferramenta de análise estática do desenvolvimento; não é dependência do produto |

Os blobs dos snapshots AB-UASH foram confrontados com os identificadores Git retornados pelo provedor. A cópia main continha 281 arquivos e a cópia 0.2.1 continha 248 arquivos dentro do escopo textual/materializável da auditoria. Isso descreve as fontes auditadas, não a quantidade de arquivos ou a cobertura de execução deste cliente.

A adaptação do conector preserva uma [proveniência específica](integrations/jk/PROVENANCE.md). Os schemas das duas linhas de AB-UASH são diferentes: este cliente usa a linha 0.2.1 e tabelas aditivas `jk_*`. Não houve fusão de bancos nem cópia de tabelas incompatíveis.

## Evidência Jumpcar e fronteira de equivalência

As páginas públicas solicitadas de [emissão de nota fiscal](https://www.jumpcar.com.br/funcionalidades/emissao-de-nota-fiscal) e [pós-pago](https://www.jumpcar.com.br/funcionalidades/gestao-de-pos-pago), além do catálogo oficial, serviram para decompor capacidades. Foi observado acesso autenticado à unidade JK, versão 4.28.0, e parte dos menus/cadastros. Nem todas as telas, integrações ou estados internos foram observados.

Não foi obtido o código proprietário do Jumpcar, acesso direto ao seu banco ou um contrato completo de API. Não foram capturados hashes de senha nem automatizada extração fora dos recursos disponibilizados. O download do arquivo nativo foi bloqueado pela sessão de origem; nenhuma tentativa de contornar essa restrição integra esta entrega. A [matriz](docs/FEATURE-MATRIX.md) distingue evidência pública, observação autenticada, implementação própria e validação ainda necessária.

## Identidade e mídia

A marca vetorial JK, a ilustração do carro, a composição das telas, o roteiro visual e a cena de atendimento são originais desta implementação. Não foram reutilizadas fotografias de clientes, placas reais, logotipos de montadoras ou a marca Jumpcar como identidade do cliente. A paleta proposta não é apresentada como identidade histórica confirmada pelo Instagram.

Diagram Design, Hyperframes, Earshot e ManimGX têm versões, commits, licenças, fontes e recibos em [DESIGN-MEDIA.md](docs/DESIGN-MEDIA.md) e `design/`. Ferramentas pesadas de autoria ficam fora do runtime. As saídas finais de mídia não demonstram operação comercial, pagamento ou autorização fiscal reais.

## Licenças

`licenses/` preserva os avisos do aplicativo herdado; as bibliotecas de autoria possuem avisos adicionais em `design/diagram/` e `design/media/licenses/`. As licenças próprias das dependências continuam aplicáveis. O código dos wheels nativos do ManimGX inclui componentes declarados GPL pelo upstream; esses binários não são redistribuídos no aplicativo.

Não foi aplicada uma licença genérica MIT/Apache ao projeto inteiro por suposição. Tornar este repositório público não altera a titularidade de código, marcas, documentação ou dados de terceiros. Uma eventual licença do projeto deve ser definida pelo titular. As referências e avisos de licença não constituem análise jurídica.

## Escopo da comprovação

Os testes usam dados sintéticos e bancos temporários. As simulações de respostas de banco, fiscal e WhatsApp são identificadas nos testes e não comprovam credenciais reais ou homologação. A análise REA preserva escopo, hashes e limitações; ela não substitui testes de comportamento. O relatório de validação é o registro atual de quais verificações realmente terminaram.

Uma conta inicial do cliente exige canal privado no destino. O usuário GitHub correspondente ao operador não foi inferido a partir de endereço de e-mail, e nenhum convite de colaborador foi enviado por suposição. A disponibilidade pública para leitura é distinta da permissão de escrita no repositório.
