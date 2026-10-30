import {useState} from 'react';
import {Button} from '@react-spectrum/s2/Button';
import {SearchField} from '@react-spectrum/s2/SearchField';
import {EmptyState, StatusPill} from '../../components/ui';
import {navigate} from '../../lib/api';
import './integration-guides.css';

type Guide = {id:string;title:string;summary:string;steps:string[];destination:string;action:string;source:string;sourceLabel:string};
const guides:Guide[] = [
  {id:'asaas',title:'Pix com Asaas',summary:'Preparar a conta, as credenciais e a confirmação de recebimentos.',steps:[
    'Criar ou conferir a conta e o ambiente de testes no Asaas. Guardar a chave somente no servidor da operação.',
    'Pedir ao responsável pela implantação que configure a conta, a identificação do aplicativo e a autenticação das notificações.',
    'Conferir o estado da integração nesta central. Configuração encontrada ainda exige teste de conexão e homologação.',
    'Em teste autorizado, preparar uma cobrança por atendimento e acompanhar a confirmação do provedor. Ambiente de testes não quita o caixa de produção.',
  ],destination:'orders',action:'Consultar atendimentos',source:'https://docs.asaas.com/reference/comece-por-aqui',sourceLabel:'Guia oficial Asaas'},
  {id:'pix-bancos',title:'Pix com Efí ou Inter',summary:'Conferir a aplicação bancária, certificado e conta recebedora.',steps:[
    'Habilitar a aplicação Pix no banco escolhido e confirmar as permissões da conta e do certificado.',
    'Entregar as credenciais pelo canal privado do responsável pela implantação. Não colar certificados, senhas ou tokens nas observações.',
    'Conferir provedor, conta e ambiente antes de preparar a cobrança. Troca de conta ou ambiente exige nova preparação.',
    'Validar em teste autorizado a cobrança, o recebimento exato e a consulta autenticada. Comprovante isolado ou aviso no celular não comprova quitação no JK.',
  ],destination:'orders',action:'Consultar atendimentos',source:'https://dev.efipay.com.br/docs/api-pix/credenciais/',sourceLabel:'Credenciais oficiais Efí'},
  {id:'whatsapp',title:'WhatsApp',summary:'Escolher entre a API oficial e o serviço local Baileys.',steps:[
    'Escolher o canal com o responsável pela operação. Cloud API usa conta Meta, número e modelos aprovados; Baileys usa sessão própria vinculada ao aparelho.',
    'Confirmar o consentimento e o destinatário. Guardar token e sessão no servidor privado, separados dos dados mostrados na interface.',
    'Baileys: instalar e verificar o serviço local conforme o guia de implantação; o pareamento deve ser feito pelo titular autorizado. Esta página não pareia o aparelho.',
    'Fazer um envio de teste autorizado e conferir o resultado. Aceitação pelo serviço e entrega ao cliente são situações distintas; falha incerta pede conferência antes de reenviar.',
  ],destination:'orders',action:'Consultar mensagens por atendimento',source:'https://developers.facebook.com/docs/whatsapp/cloud-api/overview',sourceLabel:'Visão geral oficial WhatsApp'},
  {id:'fiscal',title:'Emissão fiscal',summary:'Conferir contribuinte, município, classificação e homologação.',steps:[
    'Confirmar com o responsável fiscal o contribuinte, o município, a classificação do serviço e a tributação.',
    'Configurar o provedor e o certificado no servidor. Credenciais de teste e de produção devem permanecer separadas.',
    'Preparar o rascunho a partir do atendimento e revisar os dados fiscais. O rascunho ainda não é uma nota emitida.',
    'Executar a homologação autorizada e conferir retorno, consulta e recuperação de envio incerto antes de habilitar produção.',
  ],destination:'fiscal',action:'Abrir área fiscal',source:'https://focusnfe.com.br/doc/',sourceLabel:'Documentação oficial Focus NFe'},
  {id:'cartoes',title:'Cartões, TEF e SmartPOS',summary:'Preparar as sete famílias disponíveis no catálogo abaixo.',steps:[
    'Escolher a família e registrar o modelo na preparação de cartões desta central. É possível salvar várias opções e completar os dados depois.',
    'Abrir o passo a passo do fornecedor e conferir contrato, kit oficial e compatibilidade do equipamento.',
    'Usar a conferência local para identificar dados faltantes. Ela consulta somente o plano salvo; não detecta máquinas e não testa rede.',
    'Concluir desenvolvimento do conector e homologação no equipamento. Todos os conectores de cartão deste catálogo continuam pendentes; o roteiro não habilita cobrança.',
  ],destination:'integrations',action:'Consultar esta central',source:'https://developer.pagbank.com.br/docs/faq-smartpos',sourceLabel:'Exemplo de requisitos oficiais SmartPOS'},
  {id:'migracao',title:'Ensaio e migração',summary:'Conferir a preparação de 31/10, o ensaio de 01/11 e o corte pretendido de 02/11.',steps:[
    '31/10: conferir os arquivos originais, as prévias, placas, equipe e acessos com o responsável. Manter a operação no sistema de origem durante a consulta paralela.',
    '01/11: ensaiar em cópia isolada, restaurar backup e conferir atendimentos, recebimentos e fechamento. Registrar o que ainda depende de fornecedor ou equipamento físico.',
    'Antes do corte: reconciliar alterações feitas no sistema de origem, ordens abertas, pagamentos pendentes e saldos de abertura.',
    '02/11 é a data pretendida. Somente avançar com evidências e autorização do responsável; configuração salva ou roteiro copiado não aprova a migração.',
  ],destination:'migration',action:'Abrir migração',source:'',sourceLabel:''},
];

export function IntegrationGuides() {
  const [query,setQuery]=useState('');
  const [copied,setCopied]=useState<string|null>(null);
  const search=query.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
  const visible=guides.filter(guide=>`${guide.title} ${guide.summary} ${guide.steps.join(' ')}`.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().includes(search));
  return <section className="integration-guides" aria-labelledby="integration-guides-title">
    <div className="integration-guides-heading"><div><p className="integration-guides-eyebrow">PASSO A PASSO</p><h2 id="integration-guides-title">Configure cada conexão no seu tempo</h2><p>Escolha um roteiro para saber o que preparar, quem precisa participar e como conferir o resultado. Nenhuma ação deste guia ativa um serviço.</p></div><SearchField label="Buscar roteiro de integração" value={query} onChange={setQuery}/></div>
    <p className="integration-guides-status" role="status">{visible.length} {visible.length === 1 ? 'roteiro disponível' : 'roteiros disponíveis'}{copied ? ` · ${copied}` : ''}</p>
    <div className="integration-guides-grid">{visible.map(guide=><details key={guide.id} className="integration-guide"><summary><span><strong>{guide.title}</strong><span>{guide.summary}</span></span><StatusPill tone="neutral">Roteiro</StatusPill></summary><div className="integration-guide-body"><ol>{guide.steps.map(step=><li key={step}>{step}</li>)}</ol><div className="integration-guide-actions"><Button variant="secondary" size="S" onPress={()=>navigate(guide.destination)}>{guide.action}</Button><Button variant="secondary" size="S" onPress={async()=>{
      const text=`${guide.title}\nRoteiro de preparação; conexão e homologação exigem evidências próprias.\n${guide.steps.map((step,index)=>`${index+1}. ${step}`).join('\n')}${guide.source ? `\nFonte: ${guide.source}` : ''}`;
      try{await navigator.clipboard.writeText(text);setCopied(`Roteiro de ${guide.title} copiado.`);}catch{setCopied('A cópia não está disponível. Selecione o texto do roteiro para copiar.');}
    }}>Copiar roteiro de {guide.title}</Button>{guide.source && <a href={guide.source} target="_blank" rel="noreferrer">{guide.sourceLabel} <span aria-hidden="true">↗</span></a>}</div></div></details>)}</div>
    {!visible.length && <EmptyState icon="integrations" title="Nenhum roteiro com este termo" description="Busque por Pix, WhatsApp, fiscal, cartões ou migração."/>}
  </section>;
}
