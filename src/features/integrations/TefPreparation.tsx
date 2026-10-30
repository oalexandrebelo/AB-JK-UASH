import {useState} from 'react';
import {Button} from '@react-spectrum/s2/Button';
import {Form} from '@react-spectrum/s2/Form';
import {TextField} from '@react-spectrum/s2/TextField';
import {TextArea} from '@react-spectrum/s2/TextArea';
import {SearchField} from '@react-spectrum/s2/SearchField';
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from '../../components/ui/card';
import {Alert, AlertDescription, AlertTitle} from '../../components/ui/alert';
import {EmptyState, ErrorNotice, Icon, Loading, Modal, StatusPill, fullWidth} from '../../components/ui';
import {useMutation, useResource, type User} from '../../lib/api';
import './tef-preparation.css';

type Provider = {id:string; label:string; platform:string; integrationMode:string; description:string; requirements:string[]; documentationUrl:string; sdkUrl?:string; licenseNote?:string; connectorImplemented:false; reviewedAt:string; preparationSteps:{id:string;action:string;evidence:string}[]};
type Selection = {providerId:string; terminalModel:string; notes:string};
type Plan = {version:number; providers:Selection[]; canSubmit:false; connectionVerified:false; homologated:false};
type Diagnostics = {selectedCount:number;planVersion:number;providers:{providerId:string;selected:boolean;state:'not_selected'|'terminal_model_missing'|'connector_missing'}[]};

export function TefPreparation({user}: {user:User}) {
  const catalog = useResource<{providers:Provider[]}>('/jk/tef/catalog');
  const plan = useResource<Plan>('/jk/tef/plan');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Provider | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const diagnosticRequest = useMutation();
  const [copied, setCopied] = useState<string | null>(null);
  const savedCount = plan.data?.providers.length ?? 0;
  const search = query.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  const providers = catalog.data?.providers.filter(provider=>`${provider.label} ${provider.platform} ${provider.integrationMode}`.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().includes(search)) || [];
  const refresh = () => {setDiagnostics(null);catalog.refresh();plan.refresh();};
  return <section className="tef-preparation" aria-labelledby="tef-title">
    <div className="tef-section-heading"><div><p className="tef-eyebrow">CARTÕES E MÁQUINAS</p><h2 id="tef-title">Prepare suas próximas integrações</h2><p>Compare as opções e salve os fornecedores que deseja usar. Os dados do equipamento podem ser preenchidos depois.</p></div><Button variant="secondary" onPress={refresh} isDisabled={catalog.loading || plan.loading}>Atualizar preparação</Button></div>
    <Alert role="note"><Icon name="shield"/><AlertTitle>Preparação disponível · conexão com as máquinas pendente</AlertTitle><AlertDescription>Salvar uma opção organiza a implantação. Os conectores de cartão ainda precisam ser implementados no JK e homologados para o equipamento escolhido. Esta central não cobra, estorna ou confirma pagamentos.</AlertDescription></Alert>
    <div className="tef-local-check"><div><h3>Guia de implantação por fornecedor</h3><p>Abra o roteiro de cada família para ver a próxima ação e a evidência necessária. A conferência abaixo consulta somente a preparação salva no JK; não acessa máquinas, contratos ou a rede do fornecedor.</p></div><Button variant="secondary" isPending={diagnosing} onPress={async()=>{
      setDiagnosing(true);setDiagnostics(null);
      const result=await diagnosticRequest.mutate<Diagnostics>('/jk/tef/diagnostics',undefined,'GET');
      if(result)setDiagnostics(result);
      setDiagnosing(false);
    }}>Conferir preparação local</Button></div>
    <ErrorNotice message={diagnosticRequest.error}/>
    {diagnostics && <div className="tef-diagnostics" role="status"><p>{diagnostics.selectedCount ? `${diagnostics.selectedCount} ${diagnostics.selectedCount === 1 ? 'fornecedor salvo' : 'fornecedores salvos'}. Nenhum conector de cartão implementado.` : 'Nenhum fornecedor salvo para preparar.'}</p>{diagnostics.selectedCount > 0 && <ul>{diagnostics.providers.filter(item=>item.selected).map(item=><li key={item.providerId}><strong>{catalog.data?.providers.find(provider=>provider.id===item.providerId)?.label || item.providerId}:</strong> {item.state === 'terminal_model_missing' ? 'Informe o modelo do equipamento.' : 'Equipamento informado; conector pendente.'}</li>)}</ul>}<p>Conferência da versão {diagnostics.planVersion} do plano. Não comprova conexão nem homologação.</p></div>}
    <ErrorNotice message={catalog.error || plan.error} retry={refresh}/>
    {saved && <p className="tef-saved" role="status"><Icon name="check"/>{saved} Nenhuma máquina foi ativada.</p>}
    {catalog.loading && !catalog.data ? <Loading label="Consultando opções de integração…"/> : catalog.data && <>
      <div className="tef-filter"><SearchField label="Buscar fornecedor ou plataforma" value={query} onChange={setQuery}/><span>{savedCount} {savedCount === 1 ? 'opção salva' : 'opções salvas'} para preparar</span></div>
      <div className="tef-grid">{providers.map(provider=>{
        const selection = plan.data?.providers.find(item=>item.providerId === provider.id);
        return <Card key={provider.id}>
          <CardHeader><div className="tef-card-heading"><span className="tef-provider-icon"><Icon name="cash" size={24}/></span><StatusPill tone={selection ? 'blue' : 'neutral'}>{selection ? 'Preparação salva' : 'Disponível para planejar'}</StatusPill></div><CardTitle><h3>{provider.label}</h3></CardTitle><CardDescription>{provider.description}</CardDescription></CardHeader>
          <CardContent><dl className="tef-facts"><div><dt>Plataforma</dt><dd>{provider.platform}</dd></div><div><dt>Integração prevista</dt><dd>{provider.integrationMode}</dd></div><div><dt>Equipamento informado</dt><dd>{selection?.terminalModel || 'A definir'}</dd></div></dl><h4>O que será necessário</h4><ul className="tef-requirements">{provider.requirements.map(item=><li key={item}>{item}</li>)}</ul><details className="tef-step-guide"><summary>Passo a passo de {provider.label}</summary><ol>{provider.preparationSteps.map(step=><li key={step.id}><p>{step.action}</p><p><strong>Evidência para conferir:</strong> {step.evidence}</p></li>)}</ol><p className="tef-license">Etapas pendentes de execução. Fontes revisadas em 30/10/2026.</p><Button variant="secondary" size="S" onPress={async()=>{
              const text=`${provider.label} — roteiro de preparação\nConector JK: não implementado. Conexão e homologação: não verificadas.\n${provider.preparationSteps.map((step,index)=>`${index+1}. ${step.action}\nEvidência: ${step.evidence}`).join('\n')}\nFonte: ${provider.documentationUrl}`;
              try{await navigator.clipboard.writeText(text);setCopied(`Roteiro de ${provider.label} copiado.`);}catch{setCopied('A cópia não está disponível neste navegador. Selecione o texto do roteiro para copiar.');}
            }}>Copiar roteiro de {provider.label}</Button></details>{provider.licenseNote && <p className="tef-license">{provider.licenseNote}</p>}<div className="tef-docs"><a href={provider.documentationUrl} target="_blank" rel="noreferrer">Documentação oficial <span aria-hidden="true">↗</span></a>{provider.sdkUrl && <a href={provider.sdkUrl} target="_blank" rel="noreferrer">SDK e exemplos oficiais <span aria-hidden="true">↗</span></a>}</div>
            {user.role === 'admin' ? <Button variant={selection ? 'secondary' : 'accent'} fillStyle="outline" isDisabled={!plan.data || plan.loading || Boolean(plan.error)} onPress={()=>{setSaved(null);setEditing(provider);}}>{selection ? `Revisar ${provider.label}` : `Preparar ${provider.label}`}</Button> : <p className="tef-license">Um administrador pode salvar a preparação.</p>}
          </CardContent>
        </Card>;
      })}</div>
      {!providers.length && <EmptyState icon="integrations" title="Nenhuma opção com este termo" description="Busque pelo fornecedor, Android, Windows ou Linux."/>}
      {copied && <p role="status" className="tef-license">{copied}</p>}
    </>}
    {editing && plan.data && <PreparationDialog key={editing.id} provider={editing} plan={plan.data} onClose={()=>setEditing(null)} onSaved={removed=>{setSaved(removed ? `${editing.label} retirado da preparação.` : `Preparação de ${editing.label} salva.`);setDiagnostics(null);setEditing(null);plan.refresh();}}/>}
  </section>;
}

function PreparationDialog({provider,plan,onClose,onSaved}: {provider:Provider;plan:Plan;onClose:()=>void;onSaved:(removed?:boolean)=>void}) {
  const selection = plan.providers.find(item=>item.providerId === provider.id);
  const [terminalModel, setTerminalModel] = useState(selection?.terminalModel || '');
  const [notes, setNotes] = useState(selection?.notes || '');
  const mutation = useMutation();
  return <Modal title={`Preparar ${provider.label}`} onClose={onClose} isPending={mutation.pending}><Form isDisabled={mutation.pending} onSubmit={async event=>{
    event.preventDefault();
    const next = {providerId:provider.id,terminalModel:terminalModel.trim(),notes:notes.trim()};
    const providers = selection ? plan.providers.map(item=>item.providerId === provider.id ? next : item) : [...plan.providers,next];
    if (await mutation.mutate('/jk/tef/plan',{version:plan.version,providers},'PATCH')) onSaved();
  }}><p className="tef-dialog-copy">Registre somente informações do equipamento e da instalação. Não inclua senhas, tokens, chaves ou dados de cartões. O acesso ao fornecedor será configurado em uma etapa própria.</p><ErrorNotice message={mutation.error}/><TextField label="Modelo do equipamento" value={terminalModel} onChange={setTerminalModel} maxLength={100} description="Opcional. Você pode completar quando escolher a máquina." styles={fullWidth}/><TextArea label="Observações da instalação" value={notes} onChange={setNotes} maxLength={500} description="Opcional. Exemplo: máquina do caixa principal." styles={fullWidth}/><p className="tef-dialog-copy">Esta ação salva a preparação. A cobrança por cartão permanece indisponível até a implementação do conector, o credenciamento e a homologação.</p>{selection && <Button variant="secondary" fillStyle="outline" isDisabled={mutation.pending} onPress={async()=>{if(await mutation.mutate('/jk/tef/plan',{version:plan.version,providers:plan.providers.filter(item=>item.providerId !== provider.id)},'PATCH'))onSaved(true);}}>Retirar da preparação</Button>}<div className="modal-actions"><Button variant="secondary" isDisabled={mutation.pending} onPress={onClose}>Voltar</Button><Button variant="accent" type="submit" isPending={mutation.pending}>Salvar preparação</Button></div></Form></Modal>;
}
