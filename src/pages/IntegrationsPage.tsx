import {useState} from 'react';
import {TextArea} from '@react-spectrum/s2/TextArea';
import {IntegrationDialog, type IntegrationAction} from '../features/integrations/IntegrationDialog';
import {Button} from '@react-spectrum/s2/Button';
import {StatusLight} from '@react-spectrum/s2/StatusLight';
import {DataTable, EmptyState, ErrorNotice, Icon, Loading, Modal, Notice, PageHeader, Section, StatusPill, fullWidth} from '../components/ui';
import {dateTime, money, navigate, useResource, type RecordData} from '../lib/api';

type Integration = {id: string; label: string; state: 'blocked' | 'ready'; configured: boolean; environment: string; provider: string | null; blockers: string[]; canPrepareLocally: boolean; capabilities: Record<string, boolean>};
type Readiness = {pix: Integration; whatsapp: Integration; fiscal: Integration; rules: Record<string, boolean>};
const environments: Record<string, string> = {homologation: 'Homologação', sandbox: 'Homologação', production: 'Produção', 'not-configured': 'Não definido'};
const providers: Record<string, string> = {'pix-efi': 'Efí', 'pix-inter': 'Inter', 'whatsapp-cloud': 'WhatsApp Cloud API', focusnfe: 'Focus NFe', gateway: 'Gateway fiscal'};
const integrationDescriptions: Record<string, string> = {pix: 'Cobranças vinculadas à ordem de serviço, com confirmação do provedor.', whatsapp: 'Mensagens da operação por modelos aprovados, com consentimento do cliente.', fiscal: 'Preparação de DPS e acompanhamento da emissão de NFS-e.'};
const blockerDescriptions: Record<string, string> = {
  INTEGRATION_NOT_CONFIGURED: 'Escolha o provedor e cadastre as credenciais no servidor da operação.',
  INTEGRATION_CONFIG_INVALID: 'O responsável pela implantação precisa conferir o arquivo de configuração.',
  EXTERNAL_EFFECTS_DISABLED: 'A configuração foi encontrada. O envio ainda precisa ser habilitado pelo responsável pela implantação.',
  PRODUCTION_NOT_ENABLED: 'O uso da conta em produção ainda precisa ser habilitado após a homologação.',
  CREDENTIALS_OR_CONNECTOR_INVALID: 'Confira as credenciais, o certificado e as permissões de leitura da configuração.',
  INTEGRATION_STORAGE_UNAVAILABLE: 'As tabelas desta integração precisam ser preparadas no banco da operação.',
  FISCAL_UNAVAILABLE: 'Conclua a configuração fiscal e a homologação do contribuinte.',
};

export function IntegrationsPage() {
  const resource = useResource<Readiness>('/jk/integrations/readiness');
  const integrations = resource.data ? [resource.data.pix, resource.data.whatsapp, resource.data.fiscal] : [];
  return <><PageHeader eyebrow="CONTROLE DA OPERAÇÃO" title="Integrações" description="Veja o que está configurado e o que falta para cada serviço funcionar."><Button variant="secondary" onPress={resource.refresh}>Verificar configurações</Button></PageHeader><ErrorNotice message={resource.error} retry={resource.refresh}/>
    {resource.loading && !resource.data ? <Loading label="Consultando as integrações da operação…"/> : resource.data && <>
      <div className="integration-intro"><div className="integration-intro-icon"><Icon name="integrations" size={26}/></div><div><h2>Uma operação. Cada conexão, no seu tempo.</h2><p>As configurações abaixo vêm do servidor. Quando houver uma pendência, ela aparece junto ao serviço correspondente.</p></div></div>
      <div className="integration-grid">{integrations.map(item => <section className="integration-card" key={item.id}><div className="integration-card-top"><span className={`integration-service-icon ${item.id}`}><Icon name={item.id === 'pix' ? 'cash' : item.id === 'whatsapp' ? 'messages' : 'fiscal'} size={25}/></span><StatusPill tone={item.state === 'ready' ? 'green' : 'orange'}>{item.state === 'ready' ? 'Configurada' : 'Configuração pendente'}</StatusPill></div><h2>{item.label}</h2><p>{integrationDescriptions[item.id]}</p><dl className="integration-facts"><div><dt>Provedor</dt><dd>{item.provider ? providers[item.provider] || item.provider : 'Não definido'}</dd></div><div><dt>Ambiente</dt><dd>{environments[item.environment] || item.environment}</dd></div><div><dt>Envio externo</dt><dd>{item.capabilities.submit ? 'Disponível' : 'Bloqueado'}</dd></div></dl>
        {item.blockers.length > 0 ? <div className="integration-blockers"><h3>Para ativar esta integração</h3><ul>{item.blockers.map((blocker, index) => <li key={`${index}-${blocker}`}>{blockerDescriptions[blocker] || blocker}</li>)}</ul></div> : <div className="integration-ready"><StatusLight variant="positive" size="S">Configuração disponível</StatusLight><p>O resultado de cada envio será acompanhado na respectiva ordem.</p></div>}
        <div className="integration-card-action">{item.id === 'fiscal' ? <Button variant="secondary" size="S" onPress={() => navigate('fiscal')}>Abrir área fiscal</Button> : <Button variant="secondary" size="S" onPress={() => navigate('orders')}>Consultar por atendimento</Button>}</div>
      </section>)}</div>
      <Section title="Como os resultados são confirmados" subtitle="Cada integração mantém seu próprio acompanhamento."><div className="integration-explain-grid"><div><Icon name="shield"/><h3>Pix com comprovação</h3><p>A cobrança só quita a ordem após a confirmação autenticada de pagamento em produção.</p></div><div><Icon name="messages"/><h3>Mensagens com acompanhamento</h3><p>A aceitação pelo provedor não significa que a mensagem chegou ao cliente. A entrega continua identificada separadamente.</p></div><div><Icon name="fiscal"/><h3>Fiscal por situação real</h3><p>Um rascunho permanece identificado como rascunho até que exista uma resposta válida do provedor.</p></div></div></Section>
    </>}
  </>;
}

const operationStatuses: Record<string, string> = {prepared:'Preparada', blocked:'Bloqueada', submitting:'Enviando', submitted:'Enviada ao provedor', accepted:'Aceita pelo provedor', pending:'Aguardando confirmação', active:'Aguardando pagamento', paid:'Pagamento confirmado', confirmed:'Pagamento confirmado', settled:'Quitada', test_confirmed:'Confirmada em homologação', partial:'Pagamento parcial em análise', review:'Requer conferência', failed:'Falha no envio', rejected:'Rejeitada', uncertain:'Requer conciliação', reconciling:'Conciliando', authorized:'Autorizada', cancelled:'Cancelada', expired:'Expirada', sent:'Aceita pelo provedor'};
function integrationTone(status: unknown): 'green' | 'red' | 'orange' | 'blue' | 'neutral' {
  return ['paid','confirmed','settled','authorized'].includes(String(status)) ? 'green' : ['failed','rejected','cancelled'].includes(String(status)) ? 'red' : ['blocked','uncertain','expired','partial','review'].includes(String(status)) ? 'orange' : ['submitting','submitted','pending','active','accepted','sent','reconciling','test_confirmed'].includes(String(status)) ? 'blue' : 'neutral';
}

export function OrderIntegrationSummary({order, onChanged}: {order: RecordData; onChanged: () => void}) {
  const resource = useResource<{pixCharges: RecordData[]; messages: RecordData[]; fiscalDrafts: RecordData[]}>(`/jk/orders/${order.id}/integrations`);
  const readiness = useResource<Readiness>('/jk/integrations/readiness');
  const [operation, setOperation] = useState<IntegrationAction | null>(null);
  const [details, setDetails] = useState<RecordData | null>(null);
  const groups = resource.data ? [{id: 'pix', title: 'Cobranças Pix', icon: 'cash', items: resource.data.pixCharges || []}, {id: 'whatsapp', title: 'Mensagens pelo WhatsApp', icon: 'messages', items: resource.data.messages || []}, {id: 'fiscal', title: 'Documentos fiscais', icon: 'fiscal', items: resource.data.fiscalDrafts || []}] : [];
  const eligible = !['quote', 'cancelled'].includes(String(order.status));
  const pixEligible = eligible && !order.invoiceId && Number(order.balanceCents) > 0;
  const refresh = () => {resource.refresh(); readiness.refresh();};
  const evidence = details?.evidence && typeof details.evidence === 'object' ? details.evidence as Record<string, unknown> : {};
  return <><div className="integration-order-toolbar"><p className="muted-text">Prepare, envie e acompanhe cada operação vinculada a este atendimento.</p><Button variant="secondary" size="S" onPress={refresh}>Atualizar situações</Button></div><ErrorNotice message={resource.error} retry={resource.refresh}/><ErrorNotice message={readiness.error} retry={readiness.refresh}/>
    {resource.loading && !resource.data ? <Loading/> : groups.map(group => <Section key={group.id} title={group.title} action={group.id === 'fiscal' ? <Button variant="secondary" size="S" onPress={() => navigate('fiscal')}>Abrir área fiscal</Button> : <Button variant="secondary" size="S" isDisabled={!(group.id === 'pix' ? pixEligible && readiness.data?.pix.canPrepareLocally : eligible && readiness.data?.whatsapp.canPrepareLocally)} onPress={() => setOperation({channel: group.id as 'pix' | 'whatsapp', action: 'prepare'})}>{group.id === 'pix' ? 'Preparar cobrança' : 'Preparar mensagem'}</Button>}>
      {group.id !== 'fiscal' && readiness.data?.[group.id as 'pix' | 'whatsapp'].state === 'blocked' && <div className="panel-inset"><Notice>O envio está bloqueado até concluir a configuração desta integração. As preparações locais podem ser conferidas antes de ativá-la.</Notice></div>}
      {group.id === 'whatsapp' && group.items.length > 0 && <div className="panel-inset"><Notice>Os registros de envio ainda não confirmam entrega ao cliente.</Notice></div>}
      {group.items.length ? <DataTable label={group.title} items={group.items} columns={[{key:'createdAt',label:'Criada em',render:row=>dateTime(row.createdAt)},{key:'provider',label:'Provedor',render:row=>providers[String(row.provider || row.providerKind)] || String(row.provider || row.providerKind || 'Não definido')},{key:'environment',label:'Ambiente',render:row=>environments[String(row.environment || row.providerEnvironment)] || String(row.environment || row.providerEnvironment || '—')},...(group.id === 'pix' ? [{key:'amountCents',label:'Valor',render:(row:RecordData)=>money(row.amountCents)}] : []),{key:'status',label:'Situação',render:row=><StatusPill tone={integrationTone(row.status)}>{operationStatuses[String(row.status)] || String(row.status || '—')}</StatusPill>}]}
        actions={group.id === 'fiscal' ? undefined : row => <div className="integration-row-actions">{Boolean(row.preparationRequiresRefresh) && <span className="integration-refresh-note">A configuração mudou. Cancele esta preparação e prepare novamente.</span>}<Button size="S" variant="secondary" onPress={() => setDetails(row)}>Detalhes</Button>{Boolean(row.canSubmit) && <Button size="S" variant="accent" onPress={() => setOperation({channel: group.id as 'pix' | 'whatsapp', action: 'submit', item: row})}>Enviar</Button>}{Boolean(row.canReconcile) && <Button size="S" variant="secondary" onPress={() => setOperation({channel: 'pix', action: 'reconcile', item: row})}>Conciliar</Button>}{Boolean(row.canCancel) && <Button size="S" variant="secondary" onPress={() => setOperation({channel: group.id as 'pix' | 'whatsapp', action: 'cancel', item: row})}>Cancelar preparação</Button>}</div>}
      /> : <EmptyState icon={group.icon} title="Nenhum registro nesta ordem" description={group.id === 'fiscal' ? 'Os documentos preparados na área fiscal aparecerão aqui.' : 'Use a ação acima para preparar um registro para este atendimento.'}/>}
    </Section>)}
    {operation && <IntegrationDialog operation={operation} order={order} onClose={() => setOperation(null)} onSaved={() => {setOperation(null); refresh(); onChanged();}}/>}
    {details && <Modal title={details.kind === 'pix' ? 'Detalhes da cobrança Pix' : 'Detalhes da mensagem'} onClose={() => setDetails(null)}><dl className="integration-facts"><div><dt>Situação</dt><dd>{operationStatuses[String(details.status)] || String(details.status)}</dd></div><div><dt>Referência do provedor</dt><dd className="break-value">{String(details.providerReference || 'Ainda não disponível')}</dd></div>{details.kind === 'whatsapp' && <><div><dt>Modelo</dt><dd>{String(details.templateName || '—')}</dd></div><div><dt>Destinatário</dt><dd>{String(details.recipientMasked || '—')}</dd></div></>}{Boolean(details.lastErrorCode) && <div><dt>Código para conferência</dt><dd className="break-value">{String(details.lastErrorCode)}</dd></div>}</dl>{typeof evidence.pixCopiaECola === 'string' && <TextArea label="Pix Copia e Cola fornecido pelo banco" value={evidence.pixCopiaECola} isReadOnly styles={fullWidth}/>} {Boolean(details.preparationRequiresRefresh) && <Notice>A configuração mudou. Cancele esta preparação e prepare novamente antes de enviar.</Notice>}{Boolean(details.reconciliationRequired || evidence.reviewRequired) && <Notice>Este registro precisa de conferência. Consulte o provedor antes de registrar qualquer recebimento manual.</Notice>}<div className="modal-actions"><Button variant="secondary" onPress={() => setDetails(null)}>Fechar</Button></div></Modal>}
  </>;
}
