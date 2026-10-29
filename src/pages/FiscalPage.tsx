import {useRef, useState} from 'react';
import {Button} from '@react-spectrum/s2/Button';
import {Checkbox} from '@react-spectrum/s2/Checkbox';
import {Form} from '@react-spectrum/s2/Form';
import {Picker, PickerItem} from '@react-spectrum/s2/Picker';
import {TextField} from '@react-spectrum/s2/TextField';
import {TextArea} from '@react-spectrum/s2/TextArea';
import type {CreateFiscalDraftInput, FiscalConfig, FiscalDraft, FiscalFields, FiscalPage as FiscalPageInfo, FiscalStatus} from '../../sdk/src/models';
import {DataTable, EmptyState, ErrorNotice, fullWidth, Loading, Notice, PageHeader, Pagination, StatusPill} from '../components/ui';
import {businessDateTimeIso, dateOnly, dateTime, money, request, useMutation, useResource, type ListData, type RecordData} from '../lib/api';
import {fiscalChoiceLabels, fiscalLabels, fiscalOutcome, fiscalStatusLabels, fiscalTone, fieldRequired, normalizeTaxId, validFiscalTaxId, type FiscalFieldKey, type FiscalFieldSpec, type FiscalFormValues} from '../lib/fiscal';

const providerLabel = (provider: FiscalStatus['provider']) => provider === 'focusnfe' ? 'Focus NFe' : provider === 'gateway' ? 'Gateway configurado' : 'Não configurado';
const environmentLabel = (environment: string | null) => environment === 'production' ? 'Produção' : environment === 'sandbox' ? 'Teste · sem validade fiscal' : 'Ambiente não definido';

export function FiscalPage() {
  const status = useResource<FiscalStatus>('/fiscal/status');
  const config = useResource<FiscalConfig>('/fiscal/config');
  const [filter, setFilter] = useState('');
  const [offset, setOffset] = useState(0);
  const [view, setView] = useState<'list'|'create'>('list');
  const [selected, setSelected] = useState<string|null>(null);
  const drafts = useResource<{items: FiscalDraft[]; page: FiscalPageInfo}>(`/fiscal/drafts?limit=25&offset=${offset}${filter ? `&status=${filter}` : ''}`);
  const page = drafts.data?.page;
  function refresh() {status.refresh(); config.refresh(); drafts.refresh();}
  function back() {setView('list'); setSelected(null); drafts.refresh();}
  return <>
    <PageHeader eyebrow="GESTÃO FISCAL" title="DPS / NFS-e" description="Prepare rascunhos, acompanhe o provedor e confira o resultado de cada envio.">
      {(view !== 'list' || selected) ? <Button variant="secondary" onPress={back}>Voltar aos rascunhos</Button> : <><Button variant="secondary" onPress={refresh}>Atualizar</Button><Button variant="accent" isDisabled={!config.data || config.loading} onPress={() => setView('create')}>Preparar rascunho</Button></>}
    </PageHeader>
    <ErrorNotice message={status.error || config.error} retry={refresh}/>
    {status.data && <section className="fiscal-connection" aria-label="Configuração fiscal"><div><StatusPill tone={status.data.enabled ? 'blue' : 'neutral'}>{status.data.enabled ? 'Envio habilitado' : 'Emissão desativada'}</StatusPill><h2>{status.data.enabled ? 'Revise os dados antes de transmitir' : 'Você pode preparar rascunhos'}</h2><p>{status.data.enabled ? 'Cada transmissão depende de uma confirmação. A resposta do provedor determina o resultado.' : 'Os rascunhos ficam no sistema sem transmissão externa. O responsável pela instalação pode configurar o provedor quando a empresa estiver pronta.'}</p></div><dl><div><dt>Provedor</dt><dd>{providerLabel(status.data.provider)}</dd></div><div><dt>Ambiente</dt><dd>{environmentLabel(status.data.environment)}</dd></div><div><dt>Homologação da integração</dt><dd>Não comprovada</dd></div></dl></section>}
    {selected ? <FiscalDetail key={selected} id={selected} status={status.data} onChanged={drafts.refresh}/> :
      view === 'create' && config.data ? <FiscalEditor config={config.data} onCancel={back} onSaved={draft => {setSelected(draft.id); setView('list'); drafts.refresh();}}/> :
        <><section className="panel"><div className="panel-heading"><div><h2>Rascunhos e transmissões</h2><p>Uma DPS preparada e uma fatura pós-paga não são uma NFS-e autorizada.</p></div><Picker label="Filtrar situação fiscal" value={filter || 'all'} onChange={value => {setFilter(value === 'all' ? '' : String(value)); setOffset(0);}}><PickerItem id="all">Todas as situações</PickerItem>{Object.entries(fiscalStatusLabels).map(([id,label]) => <PickerItem id={id} key={id}>{label}</PickerItem>)}</Picker></div>
          <ErrorNotice message={drafts.error} retry={drafts.refresh}/>
          {drafts.loading && !drafts.data ? <Loading/> : drafts.data?.items.length ? <DataTable label="Rascunhos fiscais" items={drafts.data.items} columns={[
            {key:'number',label:'DPS / Ordem',render:r => {const d = r as FiscalDraft; return <><strong>DPS {d.fiscal.numero_dps} · série {d.fiscal.serie_dps}</strong><small className="fiscal-table-note">OS {String(d.snapshot.number).padStart(4,'0')}</small></>;}},
            {key:'customer',label:'Tomador',render:r => (r as FiscalDraft).customer.taxIdMasked},
            {key:'status',label:'Situação',render:r => {const d = r as FiscalDraft; return <><StatusPill tone={fiscalTone(d.status)}>{fiscalStatusLabels[d.status]}</StatusPill>{d.fiscalValidity === 'test_without_fiscal_validity' && <small className="fiscal-table-note">Teste sem validade fiscal</small>}</>;}},
            {key:'updatedAt',label:'Atualizado',render:r => dateTime(r.updatedAt)},
            {key:'total',label:'Total da ordem',align:'right',render:r => money((r as FiscalDraft).snapshot.totalCents)},
          ]} actions={r => <Button variant="secondary" size="S" onPress={() => setSelected(r.id)}>Conferir rascunho</Button>}/> : !drafts.error && <EmptyState icon="fiscal" title={filter ? 'Nenhum rascunho nesta situação' : 'Sua área fiscal está pronta para organizar'} description="Selecione uma ordem de serviço e informe os dados fiscais para preparar o primeiro rascunho. Nenhum envio acontece nesta etapa." action={!filter && <Button variant="accent" isDisabled={!config.data || config.loading} onPress={() => setView('create')}>Preparar primeiro rascunho</Button>}/>}
        </section><Pagination page={page ? {...page,hasMore:page.offset + page.limit < page.total} : undefined} loading={drafts.loading} onOffset={setOffset}/></>}
  </>;
}

function FiscalDetail({id,status,onChanged}: {id:string;status:FiscalStatus|null;onChanged:()=>void}) {
  const resource = useResource<{draft:FiscalDraft}>(`/fiscal/drafts/${encodeURIComponent(id)}`);
  const [latest,setLatest] = useState<FiscalDraft|null>(null);
  const [confirm,setConfirm] = useState<'submit'|'cancel'|null>(null);
  const [accepted,setAccepted] = useState(false);
  const [unknownSubmission,setUnknownSubmission] = useState(false);
  const [checking,setChecking] = useState(false);
  const {mutate,pending,error,setError} = useMutation();
  const draft = latest || resource.data?.draft;
  const busy = pending || checking || resource.loading;
  async function check() {
    if (busy) return;
    setChecking(true); setError(null); setConfirm(null); setAccepted(false);
    try {const result = await request<{draft:FiscalDraft}>(`/fiscal/drafts/${encodeURIComponent(id)}`); setLatest(result.draft); setUnknownSubmission(false); onChanged();}
    catch(cause) {setError(cause instanceof Error ? cause.message : 'Não foi possível atualizar o estado.');}
    finally {setChecking(false);}
  }
  async function act(action:'submit'|'cancel'|'reconcile') {
    if (!draft || busy || action === 'submit' && (!accepted || unknownSubmission)) return;
    const result = await mutate<{draft:FiscalDraft}>(`/fiscal/drafts/${encodeURIComponent(id)}/${action}`, {version:draft.version});
    setConfirm(null); setAccepted(false);
    if (result) {setLatest(result.draft); setUnknownSubmission(false); onChanged();}
    else if (action === 'submit') {setUnknownSubmission(true); onChanged();}
  }
  if (!draft) return <><ErrorNotice message={resource.error} retry={resource.refresh}/>{resource.loading && <Loading label="Carregando rascunho…"/>}</>;
  const canSubmit = status?.enabled && status.capabilities.submit && draft.canSubmit && draft.status === 'prepared' && !unknownSubmission;
  const canReconcile = status?.enabled && status.capabilities.reconcile && draft.reconciliationRequired && ['uncertain','pending'].includes(draft.status);
  return <section className="panel fiscal-detail">
    <header className="panel-heading"><div><h2>DPS {draft.fiscal.numero_dps} · série {draft.fiscal.serie_dps}</h2><p>OS {String(draft.snapshot.number).padStart(4,'0')} · versão do rascunho {draft.version}</p></div><StatusPill tone={fiscalTone(draft.status)}>{fiscalStatusLabels[draft.status]}</StatusPill></header>
    <div className="fiscal-section">
      <div className={`fiscal-outcome ${fiscalTone(draft.status)}`} role="status">{fiscalOutcome(draft)}</div>
      {unknownSubmission && <Notice>A resposta do envio não chegou ao navegador. Atualize o estado antes de continuar; o envio não será repetido automaticamente.</Notice>}
      <ErrorNotice message={error || resource.error}/>
      <dl className="fiscal-summary"><div><dt>CPF/CNPJ do tomador</dt><dd>{draft.customer.taxIdMasked}</dd></div><div><dt>Subtotal da ordem</dt><dd>{money(draft.snapshot.subtotalCents)}</dd></div><div><dt>Desconto</dt><dd>{money(draft.snapshot.discountCents)}</dd></div><div><dt>Total da ordem</dt><dd>{money(draft.snapshot.totalCents)}</dd></div><div><dt>Ambiente do envio</dt><dd>{environmentLabel(draft.environment)}</dd></div><div><dt>Criado em</dt><dd>{dateTime(draft.createdAt)}</dd></div></dl>
      <div className="fiscal-actions"><Button variant="secondary" isDisabled={busy} isPending={checking} onPress={check}>Atualizar estado</Button>{draft.canCancel && !unknownSubmission && <Button variant="secondary" isDisabled={busy} onPress={() => {setConfirm('cancel'); setAccepted(false);}}>Cancelar rascunho</Button>}{draft.status === 'prepared' && <Button variant="accent" isDisabled={busy || !canSubmit} onPress={() => {setConfirm('submit'); setAccepted(false);}}>Enviar ao provedor</Button>}{draft.reconciliationRequired && <Button variant="accent" isDisabled={busy || !canReconcile} onPress={() => act('reconcile')} isPending={pending}>Consultar provedor</Button>}</div>
      {!status?.enabled && (draft.status === 'prepared' || draft.reconciliationRequired) && <p className="muted-text">Envio e consulta ficam disponíveis quando o provedor estiver habilitado. Preparar ou cancelar um rascunho não envia dados ao provedor.</p>}
      {confirm && <section className="fiscal-confirm" aria-label={confirm === 'submit' ? 'Confirmar transmissão fiscal' : 'Confirmar cancelamento do rascunho'}>
        <h3>{confirm === 'submit' ? 'Confirme a transmissão desta DPS' : 'Cancelar este rascunho?'}</h3>
        <p>{confirm === 'submit' ? `Os dados fiscais e do tomador serão enviados a ${providerLabel(status?.provider || null)}, no ambiente ${environmentLabel(status?.environment || null)}. ${status?.environment === 'production' ? 'Esta ação pode resultar na autorização de uma NFS-e real.' : 'O resultado deste ambiente não tem validade fiscal.'}` : 'Esta ação cancela somente o rascunho ainda não enviado e remove seu payload fiscal privado. Os metadados comerciais e o histórico permanecem.'}</p>
        {confirm === 'submit' && <Checkbox isSelected={accepted} onChange={setAccepted} isDisabled={pending}>Conferi a empresa, o tomador, a classificação fiscal, os valores e o ambiente. Autorizo este envio.</Checkbox>}
        <div className="fiscal-actions"><Button variant="secondary" isDisabled={pending} onPress={() => {setConfirm(null); setAccepted(false);}}>Voltar sem confirmar</Button><Button variant="accent" isPending={pending} isDisabled={busy || confirm === 'submit' && (!accepted || !canSubmit)} onPress={() => act(confirm)}>{confirm === 'submit' ? 'Confirmar envio ao provedor' : 'Confirmar cancelamento do rascunho'}</Button></div>
      </section>}
      <h3>Serviços da ordem na preparação</h3>
      <DataTable label="Serviços do rascunho" items={draft.snapshot.items.map((item,index) => ({...item,id:String(index)}))} columns={[{key:'name',label:'Serviço'},{key:'quantity',label:'Quantidade'},{key:'unitPriceCents',label:'Unitário',render:r => money(r.unitPriceCents)},{key:'netCents',label:'Valor líquido',align:'right',render:r => money(r.netCents)}]}/>
      <details className="fiscal-advanced"><summary>Classificação e rastreabilidade</summary><dl className="fiscal-summary">{Object.entries(draft.fiscal).map(([key,value]) => <div key={key}><dt>{fiscalLabels[key as FiscalFieldKey] || ({ibsCbsRequired:'IBS/CBS exigido na revisão',discountTreatment:'Tratamento do desconto',taxReviewRecorded:'Revisão fiscal registrada'} as Record<string,string>)[key] || key}</dt><dd>{typeof value === 'boolean' ? value ? 'Sim' : 'Não' : key === 'data_competencia' ? dateOnly(value) : String(value)}</dd></div>)}<div><dt>Referência no provedor</dt><dd className="fiscal-reference">{draft.providerRef}</dd></div><div><dt>Último código de retorno</dt><dd>{draft.lastErrorCode || '—'}</dd></div><div><dt>Estado informado pelo provedor</dt><dd>{draft.providerStatus || 'Sem resposta registrada'}</dd></div></dl></details>
      <p className="muted-text">O rascunho é imutável. Se a ordem ou os dados estiverem incorretos, cancele antes do primeiro envio e prepare outro. XML e DANFSe devem ser obtidos e guardados com o provedor.</p>
    </div>
  </section>;
}

const baseFields: FiscalFieldKey[] = ['data_emissao','data_competencia','serie_dps','numero_dps','emitente_dps','cnpj_prestador','inscricao_municipal_prestador','codigo_municipio_emissora','codigo_municipio_prestacao','codigo_opcao_simples_nacional','regime_tributario_simples_nacional','regime_especial_tributacao','codigo_tributacao_nacional_iss','codigo_tributacao_municipal_iss','codigo_nbs','tributacao_iss','tipo_retencao_iss','percentual_aliquota_relativa_municipio','tipo_imunidade','codigo_pais_exportacao','tipo_exigibilidade_suspensao','numero_processo_suspensao','descricao_servico'];
const customerFields = [
  {key:'taxId',label:'CPF/CNPJ do tomador',max:18}, {key:'name',label:'Nome / razão social do tomador',max:150},
  {key:'municipalityCode',label:'Município do tomador (IBGE)',max:7}, {key:'zipCode',label:'CEP do tomador',max:9},
  {key:'street',label:'Logradouro do tomador',max:255}, {key:'number',label:'Número do endereço',max:60},
  {key:'neighborhood',label:'Bairro do tomador',max:60}, {key:'complement',label:'Complemento do endereço',max:156},
];

function FiscalEditor({config,onCancel,onSaved}: {config:FiscalConfig;onCancel:()=>void;onSaved:(draft:FiscalDraft)=>void}) {
  const [orderId,setOrderId] = useState('');
  const [query,setQuery] = useState('');
  const [search,setSearch] = useState('');
  const [orderOffset,setOrderOffset] = useState(0);
  const [chosenOrder,setChosenOrder] = useState<RecordData|null>(null);
  const orders = useResource<ListData>(`/orders?limit=25&offset=${orderOffset}&q=${encodeURIComponent(search)}`);
  const [customer,setCustomer] = useState<Record<string,string>>({});
  const [values,setValues] = useState<FiscalFormValues>({});
  const [ibsDecision,setIbsDecision] = useState('');
  const [discountTreatment,setDiscountTreatment] = useState('');
  const [justification,setJustification] = useState('');
  const [reviewed,setReviewed] = useState(false);
  const {mutate,pending,error,setError} = useMutation();
  const errorRef = useRef<HTMLDivElement>(null);
  const specs = config.fiscalFields as Record<FiscalFieldKey,FiscalFieldSpec>;
  const ibsKeys = config.ibsCbsFields as readonly FiscalFieldKey[];
  const advanced = (Object.keys(specs) as FiscalFieldKey[]).filter(key => !baseFields.includes(key) && !ibsKeys.includes(key));
  const change = (key:FiscalFieldKey,value:string) => {setValues(previous => ({...previous,[key]:value})); setReviewed(false);};
  function reject(message:string) {setError(message); errorRef.current?.scrollIntoView({block:'center'}); errorRef.current?.focus();}
  async function save() {
    if (!chosenOrder || !orderId) return reject('Selecione a ordem de serviço deste rascunho.');
    if (!validFiscalTaxId(customer.taxId || '')) return reject('Informe um CPF ou CNPJ válido para o tomador, incluindo os dígitos verificadores.');
    if (!reviewed || !ibsDecision || !discountTreatment || justification.trim().length < 10) return reject('Conclua a revisão fiscal, informe sua justificativa e confirme a conferência dos dados.');
    if ((Number(chosenOrder.discountCents) > 0) === (discountTreatment === 'none')) return reject('O tratamento do desconto deve corresponder ao desconto registrado na ordem.');
    const fiscal: Record<string,string|number> = {};
    for (const [name,spec] of Object.entries(specs)) {
      const key = name as FiscalFieldKey;
      const raw = (values[key] || '').trim();
      if (!raw) {if (fieldRequired(key,spec,values,config,ibsDecision === 'yes')) return reject(`Preencha: ${fiscalLabels[key]}.`); continue;}
      let value: string|number = raw;
      if (spec.type === 'integer' || spec.type === 'decimal') {
        value = Number(raw.replace(',','.'));
        if (!Number.isFinite(value) || value < (spec.min ?? 0) || value > (spec.max ?? Number.MAX_SAFE_INTEGER) || spec.type === 'integer' && !Number.isSafeInteger(value) || spec.type === 'decimal' && Math.abs(value * 100 - Math.round(value * 100)) > 0.00001) return reject(`Revise o valor de ${fiscalLabels[key]}.`);
      } else if (spec.type === 'cnpj') {
        value = normalizeTaxId(raw);
        if (!validFiscalTaxId(value,true)) return reject('Informe um CNPJ válido para o prestador, incluindo os dígitos verificadores.');
      } else if (spec.type === 'code' && !new RegExp(`^\\d{${spec.length}}$`,'u').test(raw)) return reject(`${fiscalLabels[key]} deve ter ${spec.length} dígitos.`);
      else if (spec.type === 'datetime') {
        try {value = businessDateTimeIso(raw)!.replace('.000Z','Z');} catch {return reject('Revise a data e hora de emissão.');}
      } else if (spec.type === 'country') value = raw.toUpperCase();
      fiscal[key] = value;
    }
    const address = {municipalityCode:customer.municipalityCode || '',zipCode:(customer.zipCode || '').replace(/[-\s]/gu,''),street:(customer.street || '').trim(),number:(customer.number || '').trim(),neighborhood:(customer.neighborhood || '').trim(),...(customer.complement?.trim() ? {complement:customer.complement.trim()} : {})};
    if (!/^\d{7}$/u.test(address.municipalityCode) || !/^\d{8}$/u.test(address.zipCode)) return reject('Informe o município do tomador com 7 dígitos e o CEP com 8 dígitos.');
    const body: CreateFiscalDraftInput = {orderId,customer:{taxId:normalizeTaxId(customer.taxId),name:customer.name.trim(),address},fiscal:fiscal as FiscalFields,taxReview:{ibsCbsRequired:ibsDecision === 'yes',justification:justification.trim(),discountTreatment:discountTreatment as CreateFiscalDraftInput['taxReview']['discountTreatment']}};
    const result = await mutate<{draft:FiscalDraft}>('/fiscal/drafts',body);
    if (result) onSaved(result.draft);
  }
  function renderFields(keys:readonly FiscalFieldKey[]) {
    return <div className="form-grid">{keys.map(key => {
      const spec = specs[key];
      const required = fieldRequired(key,spec,values,config,ibsDecision === 'yes');
      const value = values[key] || '';
      const shared = {label:fiscalLabels[key],isRequired:required,styles:fullWidth,isDisabled:pending};
      let input;
      if (spec.type === 'choice') input = <Picker {...shared} value={value || null} onChange={next => change(key,String(next || ''))} placeholder="Selecione o enquadramento">{!required && <PickerItem id="">Não informar</PickerItem>}{spec.values?.map(option => <PickerItem id={option} key={option}>{fiscalChoiceLabels[key]?.[option] || `Código ${option}`}</PickerItem>)}</Picker>;
      else if (spec.type === 'date' || spec.type === 'datetime') input = <label className="native-date-field"><span>{fiscalLabels[key]}{required ? ' *' : ''}</span><input type={spec.type === 'datetime' ? 'datetime-local' : 'date'} value={value} required={required} disabled={pending} onChange={event => change(key,event.target.value)}/>{spec.type === 'datetime' && <small>Horário de São Paulo.</small>}</label>;
      else if (key === 'descricao_servico') input = <TextArea {...shared} value={value} onChange={next => change(key,next)} maxLength={1000} description="Opcional. Se vazio, será formada pelos serviços da ordem." />;
      else input = <TextField {...shared} value={value} onChange={next => change(key,next)} inputMode={['integer','decimal','code'].includes(spec.type) ? spec.type === 'decimal' ? 'decimal' : 'numeric' : undefined} maxLength={spec.type === 'text' ? spec.max : spec.type === 'code' ? spec.length : spec.type === 'cnpj' ? 18 : spec.type === 'country' ? 2 : 30} description={spec.type === 'code' ? `${spec.length} dígitos. Informe o código revisado para esta operação.` : spec.type === 'integer' ? `Inteiro entre ${spec.min} e ${spec.max}.` : spec.type === 'decimal' ? 'Até duas casas decimais. Deixe vazio quando não se aplicar.' : undefined}/>;
      return <div key={key} className={`form-field ${key === 'descricao_servico' ? 'full' : ''}`}>{input}</div>;
    })}</div>;
  }
  const eligible = (orders.data?.items || []).filter(order => !['quote','cancelled'].includes(String(order.status)) && Number(order.totalCents) > 0);
  return <Form onSubmit={event => {event.preventDefault(); void save();}}>
    <section className="panel fiscal-editor"><div className="panel-heading"><div><h2>Preparar rascunho fiscal</h2><p>Os dados são específicos deste rascunho e não alteram o cadastro comercial.</p></div></div>
      <div className="fiscal-section">
        <div ref={errorRef} tabIndex={-1}><ErrorNotice message={error}/></div>
        <h3>1. Ordem de serviço</h3><p className="muted-text">Escolha uma ordem com serviços e valor positivo. Orçamentos e ordens canceladas não podem gerar rascunho.</p>
        <div className="fiscal-order-search"><TextField label="Buscar ordem" value={query} onChange={setQuery} description="Busque pelo número, cliente ou placa."/><Button variant="secondary" isDisabled={pending} onPress={() => {setSearch(query); setOrderOffset(0);}}>Buscar</Button></div>
        <ErrorNotice message={orders.error} retry={orders.refresh}/>
        {orders.loading ? <Loading label="Buscando ordens…"/> : <><div className="fiscal-order-list">{eligible.map(order => <div className={`fiscal-order-option ${orderId === order.id ? 'selected' : ''}`} key={order.id}><div><strong>OS {String(order.number).padStart(4,'0')} · {String(order.vehiclePlate)}</strong><span>{String(order.customerName)} · {money(order.totalCents)}</span></div><Button variant={orderId === order.id ? 'accent' : 'secondary'} isDisabled={pending} size="S" onPress={() => {setOrderId(order.id); setChosenOrder(order); setReviewed(false);}}>{orderId === order.id ? 'Selecionada' : `Selecionar OS ${String(order.number).padStart(4,'0')}`}</Button></div>)}</div>{!eligible.length && <Notice>Nenhuma ordem elegível nesta página. Confira as demais páginas ou ajuste a busca.</Notice>}</>}
        <Pagination page={orders.data?.page} loading={orders.loading || pending} onOffset={setOrderOffset}/>
        {chosenOrder && <div className="fiscal-selected" role="status"><strong>Selecionada: OS {String(chosenOrder.number).padStart(4,'0')}</strong><span>Subtotal {money(chosenOrder.subtotalCents)} · desconto {money(chosenOrder.discountCents)} · total {money(chosenOrder.totalCents)}</span></div>}
        <h3>2. Tomador do serviço</h3><p className="muted-text">Informe os dados fiscais completos do destinatário. CPF/CNPJ recebe validação dos dígitos; não há consulta cadastral à Receita.</p>
        <div className="form-grid">{customerFields.map(field => <TextField key={field.key} label={field.label} value={customer[field.key] || ''} onChange={value => {setCustomer(previous => ({...previous,[field.key]:value})); setReviewed(false);}} isRequired={field.key !== 'complement'} maxLength={field.max} autoComplete="off" isDisabled={pending} styles={fullWidth}/>)}</div>
        <h3>3. DPS, prestador e classificação</h3><p className="muted-text">Preencha a numeração, os códigos e o regime definidos pelo responsável fiscal. O sistema não deduz classificação, alíquota ou enquadramento a partir do nome do serviço.</p>
        {renderFields(baseFields)}
        <h3>4. Revisão de IBS/CBS e descontos</h3>
        <div className="form-grid"><Picker label="IBS/CBS exigido nesta operação?" value={ibsDecision || null} onChange={value => {setIbsDecision(String(value)); setReviewed(false);}} isRequired isDisabled={pending} styles={fullWidth}><PickerItem id="yes">Sim, informar o conjunto completo</PickerItem><PickerItem id="no">Não, registrar a justificativa</PickerItem></Picker><Picker label="Tratamento do desconto" value={discountTreatment || null} onChange={value => {setDiscountTreatment(String(value)); setReviewed(false);}} isRequired isDisabled={pending} styles={fullWidth}><PickerItem id="none">Sem desconto na ordem</PickerItem><PickerItem id="unconditional">Desconto incondicionado</PickerItem><PickerItem id="conditional">Desconto condicionado</PickerItem></Picker></div>
        <p className="muted-text">Se algum campo de IBS/CBS for preenchido, todo o conjunto abaixo será necessário. A decisão deve considerar o regime, a operação e a data de competência.</p>{renderFields(ibsKeys)}
        <TextArea label="Justificativa da revisão fiscal" value={justification} onChange={value => {setJustification(value); setReviewed(false);}} isRequired minLength={10} maxLength={500} isDisabled={pending} description="De 10 a 500 caracteres. Registre o fundamento da decisão; evite incluir dados pessoais." styles={fullWidth}/>
        <details className="fiscal-advanced"><summary>Tributos federais e totais opcionais</summary><p className="muted-text">Preencha somente os campos que se aplicam à operação, conforme revisão fiscal.</p>{renderFields(advanced)}</details>
        <p className="muted-text">Recorte disponível: prestador CNPJ, tomador doméstico CPF/CNPJ e destinatário igual ao tomador. <a href="https://campos.focusnfe.com.br/nfse_nacional/EmissaoDPSXml.html" target="_blank" rel="noreferrer">Referência dos campos fiscais</a>.</p>
        <Checkbox isSelected={reviewed} onChange={setReviewed} isRequired isDisabled={pending}>Conferi os dados e a revisão fiscal. Entendo que salvar este rascunho não emite uma NFS-e.</Checkbox>
        <div className="modal-actions"><Button variant="secondary" isDisabled={pending} onPress={onCancel}>Voltar sem salvar</Button><Button variant="accent" type="submit" isPending={pending} isDisabled={!orderId || !reviewed}>Salvar rascunho sem emitir</Button></div>
      </div>
    </section>
  </Form>;
}
