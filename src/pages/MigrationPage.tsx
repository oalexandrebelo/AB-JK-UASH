import {useRef, useState} from 'react';
import {Button} from '@react-spectrum/s2/Button';
import {ActionButton} from '@react-spectrum/s2/ActionButton';
import {FileTrigger} from '@react-spectrum/s2/FileTrigger';
import {Checkbox} from '@react-spectrum/s2/Checkbox';
import {Picker, PickerItem} from '@react-spectrum/s2/Picker';
import {Tabs, TabList, Tab, TabPanel} from '@react-spectrum/s2/Tabs';
import {TableView, TableHeader, TableBody, Column, Row, Cell} from '@react-spectrum/s2/TableView';
import {DataTable, EmptyState, ErrorNotice, Icon, Loading, Notice, PageHeader, Pagination, Section, StatusPill} from '../components/ui';
import {dateTime, money, useMutation, usePagedResource, useResource, type RecordData} from '../lib/api';
import {migrationEntities, migrationEntityNames, type MigrationCommit, type MigrationEntity, type MigrationInput, type MigrationPreview, type NativeCustomerImport} from '../lib/jk';
import {NativeArchive} from '../features/migration/NativeArchive';
import {TeamMigration} from '../features/migration/TeamMigration';
import {ReconciliationReview} from '../features/migration/ReconciliationReview';
import {SourceCatalog} from '../features/migration/SourceCatalog';

type MigrationStatus = {supported: boolean; mode: string; counts: Record<string, number>; totals: {ordersTotalCents: number; paymentsTotalCents: number; historicalOutstandingCents: number}; limits: {maxBytes: number; maxRows: number}; latestBatches: RecordData[]};
type Upload = {id: string; name: string; size: number; entity: MigrationEntity; format: 'json' | 'csv' | 'jumpcar-html'; content: string};
const MAX_BYTES = 8 * 1024 * 1024;
const LIMIT_MESSAGE = 'O conjunto ultrapassa o limite de 8 MB por envio. Não divida a exportação nativa de clientes sem IDs: preserve o arquivo completo e converta-o em lotes canônicos reconciliados. Para dados canônicos, use lotes menores mantendo cada ordem com seus itens e pagamentos.';
const countNames = {received:'Recebidos', insert:'A importar', unchanged:'Já importados', rejected:'Com pendência'} as const;

function inferEntity(name: string): MigrationEntity {
  const normalized = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/order.?items|itens/.test(normalized)) return 'orderItems';
  if (/vehicle|veicul/.test(normalized)) return 'vehicles';
  if (/service|servic/.test(normalized)) return 'services';
  if (/payment|recebiment|pagament/.test(normalized)) return 'payments';
  if (/order|ordem|ordens/.test(normalized)) return 'orders';
  return 'customers';
}
function bytesLabel(bytes: number) {return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toLocaleString('pt-BR', {maximumFractionDigits: 1})} KB` : `${(bytes / 1024 / 1024).toLocaleString('pt-BR', {maximumFractionDigits: 1})} MB`;}
function buildInput(uploads: Upload[], customersOnly: boolean): MigrationInput {
  if (!uploads.length) throw new Error('Selecione pelo menos um arquivo para preparar a prévia.');
  const json = uploads.filter(upload => upload.format === 'json');
  let input: MigrationInput;
  if (json.length) {
    if (uploads.length !== 1) throw new Error('Use um único arquivo JSON completo ou arquivos CSV/HTML separados. Remova os demais arquivos para continuar.');
    let parsed: unknown;
    try {parsed = JSON.parse(json[0].content.replace(/^\uFEFF/, ''));} catch {throw new Error('O arquivo JSON não pôde ser lido. Confira se ele foi exportado por completo.');}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('O JSON precisa conter um conjunto de dados com schemaVersion e as listas de registros.');
    const value = parsed as Record<string, unknown>;
    if (Object.hasOwn(value, 'dataset')) {
      if (Object.keys(value).some(key => !['source','scope','mode','dataset','previewHash'].includes(key))) throw new Error('O envelope JSON contém campos sem mapeamento. Nenhum campo pode ser descartado; revise a exportação.');
      if (!value.dataset || typeof value.dataset !== 'object' || Array.isArray(value.dataset)) throw new Error('O campo dataset precisa conter um objeto com schemaVersion e as listas de registros.');
      input = value as MigrationInput;
    } else input = {source:'jumpcar', dataset:value};
  } else input = {source:'jumpcar', files:uploads.map(upload => ({entity:upload.entity, format:upload.format as 'csv' | 'jumpcar-html', content:upload.content}))};
  if (customersOnly) {
    if (!input.files || input.files.length !== 1 || input.files[0].entity !== 'customers') throw new Error('Para importar somente clientes, selecione apenas o arquivo original de clientes do Jumpcar, em CSV ou tabela HTML com as nove colunas.');
    input.nativeCustomerMode = 'customers-only';
  }
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > MAX_BYTES) throw new Error(LIMIT_MESSAGE);
  return input;
}

export function MigrationPage() {
  const status = useResource<MigrationStatus>('/jk/migration/status');
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [reading, setReading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [preview, setPreview] = useState<MigrationPreview | null>(null);
  const [previewInput, setPreviewInput] = useState<MigrationInput | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [customersOnly, setCustomersOnly] = useState(false);
  const [committed, setCommitted] = useState<MigrationCommit | null>(null);
  const [tab, setTab] = useState('import');
  const inputRevision = useRef(0);
  const previewMutation = useMutation();
  const commitMutation = useMutation();
  const available = status.data?.supported === true && !status.loading && !status.error;
  const busy = !available || reading || previewMutation.pending || commitMutation.pending;
  function resetPreview() {inputRevision.current += 1; setPreview(null); setPreviewInput(null); setConfirmed(false); setCommitted(null); setLocalError(null); previewMutation.setError(null); commitMutation.setError(null);}
  async function selectFiles(files: FileList | null) {
    if (!files?.length || busy) return;
    resetPreview(); setReading(true);
    try {
      const selected = Array.from(files);
      if (selected.reduce((sum, file) => sum + file.size, uploads.reduce((sum, file) => sum + file.size, 0)) > MAX_BYTES) throw new Error(LIMIT_MESSAGE);
      const next: Upload[] = [];
      for (const file of selected) {
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        if ((bytes[0] === 0xd0 && bytes[1] === 0xcf) || (bytes[0] === 0x50 && bytes[1] === 0x4b)) throw new Error(`${file.name}: planilhas binárias não são aceitas. Exporte como CSV, JSON ou tabela HTML do Jumpcar.`);
        let content: string;
        try {content = new TextDecoder('utf-8', {fatal:true,ignoreBOM:true}).decode(buffer);} catch {content = new TextDecoder('windows-1252').decode(buffer);}
        if (!content.trim()) throw new Error(`${file.name} está vazio.`);
        const format = /^\s*[{[]/.test(content) ? 'json' : /<table[\s>]/i.test(content) ? 'jumpcar-html' : 'csv';
        next.push({id:crypto.randomUUID(), name:file.name, size:file.size, entity:inferEntity(file.name), format, content});
      }
      setUploads(old => [...old, ...next]);
    } catch (error) {setLocalError(error instanceof Error ? error.message : 'Não foi possível ler os arquivos.');}
    finally {setReading(false);}
  }
  async function preparePreview() {
    if (busy) return;
    resetPreview();
    try {
      const input = buildInput(uploads, customersOnly);
      const revision = inputRevision.current;
      const result = await previewMutation.mutate<MigrationPreview>('/jk/migration/preview', input);
      if (result && revision === inputRevision.current) {setPreview(result); setPreviewInput(input);}
    } catch (error) {setLocalError(error instanceof Error ? error.message : 'Não foi possível preparar a prévia.');}
  }
  async function commit() {
    if (busy || !confirmed || !preview?.canCommit || !previewInput) return;
    const result = await commitMutation.mutate<MigrationCommit>('/jk/migration/commit', {...previewInput, previewHash:preview.previewHash});
    if (result) {setCommitted(result); setConfirmed(false); status.refresh();}
  }
  const header = <PageHeader eyebrow="CONTROLE DOS DADOS" title="Migração do Jumpcar" description="Traga os registros da operação com prévia, conferência e histórico de importação."><Button variant="secondary" isDisabled={reading || previewMutation.pending || commitMutation.pending || status.loading} onPress={status.refresh}>Atualizar histórico</Button></PageHeader>;
  if (!status.data?.supported || status.error) return <>{header}<ErrorNotice message={status.error} retry={status.refresh}/>{status.loading ? <Loading label="Verificando a disponibilidade da migração…"/> : !status.error && status.data && <Notice>A importação e o histórico do Jumpcar estão disponíveis na instalação local JK. Esta instalação não oferece esse recurso.</Notice>}</>;
  return <>{header}<ErrorNotice message={status.error} retry={status.refresh}/>
    <div className="migration-overview"><div className="migration-overview-icon"><Icon name="migration" size={27}/></div><div><h2>Primeiro confira. Depois importe.</h2><p>A prévia mostra o que será incluído e aponta pendências. Os atendimentos e recebimentos antigos ficam no histórico para consulta, sem gerar novas cobranças ou comissões.</p></div><StatusPill tone="blue">Origem: Jumpcar</StatusPill></div>
    <Tabs aria-label="Migração de dados" selectedKey={tab} onSelectionChange={key => setTab(String(key))}><TabList><Tab id="import">Importar arquivos</Tab><Tab id="history">Consultar histórico</Tab><Tab id="archive">Acervo original</Tab><Tab id="reconciliation">Conciliação</Tab><Tab id="catalog">Catálogo da origem</Tab><Tab id="team">Equipe</Tab></TabList>
      <TabPanel id="import"><div className="migration-tab-content"><ol className="migration-steps" aria-label="Etapas da importação"><li className={uploads.length ? 'complete' : 'current'}><span>1</span>Escolha os arquivos</li><li className={preview ? 'complete' : uploads.length ? 'current' : ''}><span>2</span>Revise a prévia</li><li className={committed ? 'complete' : preview?.canCommit ? 'current' : ''}><span>3</span>Confirme a importação</li></ol>
        <Section title="Arquivos da exportação" subtitle="JSON completo, CSV ou tabela HTML exportada pelo Jumpcar. Até 8 MB por envio."><div className="migration-upload-zone"><span className="migration-upload-icon"><Icon name="migration" size={28}/></span><div><h3>Selecione os arquivos do Jumpcar</h3><p>Os arquivos são enviados para análise quando você solicitar a prévia.</p></div><FileTrigger allowsMultiple acceptedFileTypes={['.csv','.json','.html','.htm','.xls']} onSelect={selectFiles}><Button variant="accent" fillStyle="outline" isDisabled={busy} isPending={reading}>Escolher arquivos</Button></FileTrigger></div>
          {uploads.length > 0 && <div className="migration-files">{uploads.map(upload => <div className="migration-file" key={upload.id}><div className="migration-file-info"><Icon name="invoices"/><div><strong>{upload.name}</strong><span>{bytesLabel(upload.size)} · {upload.format === 'jumpcar-html' ? 'Tabela HTML do Jumpcar' : upload.format.toUpperCase()}</span></div></div>{upload.format !== 'json' ? <Picker label="Tipo de registro" value={upload.entity} isDisabled={busy} onChange={value => {resetPreview(); setUploads(old => old.map(item => item.id === upload.id ? {...item, entity:String(value) as MigrationEntity} : item));}}>{migrationEntities.map(entity => <PickerItem key={entity} id={entity}>{migrationEntityNames[entity]}</PickerItem>)}</Picker> : <StatusPill>Conjunto completo</StatusPill>}<ActionButton aria-label={`Remover ${upload.name}`} isDisabled={busy} onPress={() => {resetPreview(); setUploads(old => old.filter(item => item.id !== upload.id));}}><Icon name="close" size={18}/></ActionButton></div>)}</div>}
          <div className="panel-inset"><Checkbox isSelected={customersOnly} isDisabled={busy} onChange={value=>{resetPreview();setCustomersOnly(value);}}>Importar somente clientes; revisar veículos depois</Checkbox><p>Opção para um único arquivo original de clientes do Jumpcar, com as nove colunas. Nenhum veículo será criado e as linhas completas ficam preservadas para revisão. Placas repetidas não serão atribuídas a um proprietário. Desmarcada, a importação mantém o tratamento completo do arquivo.</p></div>
          <div className="migration-upload-actions"><span>{uploads.length ? `${uploads.length} ${uploads.length === 1 ? 'arquivo selecionado' : 'arquivos selecionados'}` : 'Nenhum arquivo selecionado'}</span><Button variant="accent" isDisabled={!uploads.length || busy || Boolean(committed)} isPending={previewMutation.pending} onPress={preparePreview}>Analisar e gerar prévia</Button></div>
        </Section>
        <ErrorNotice message={localError || previewMutation.error}/>
        {preview && <Section title="Revise o resultado da análise" subtitle="Confira os registros, as pendências e os totais antes de confirmar." action={<StatusPill tone={preview.canCommit ? 'green' : 'orange'}>{preview.canCommit ? 'Pronta para importar' : 'Revisão necessária'}</StatusPill>}><div className="migration-preview-content"><div className="migration-count-table"><TableView aria-label="Resumo dos registros da importação" selectionMode="none" overflowMode="wrap" density="spacious"><TableHeader><Column id="entity" isRowHeader>Tipo de registro</Column>{Object.entries(countNames).map(([key, name]) => <Column key={key} id={key} align="end">{name}</Column>)}</TableHeader><TableBody>{Object.entries(preview.counts).map(([entity, counts]) => <Row id={entity} key={entity}><Cell>{migrationEntityNames[entity as MigrationEntity] || entity}</Cell><Cell>{counts?.received ?? 0}</Cell><Cell>{counts?.insert ?? 0}</Cell><Cell>{counts?.unchanged ?? 0}</Cell><Cell>{counts?.rejected ?? 0}</Cell></Row>)}</TableBody></TableView></div>
          <Reconciliation values={preview.reconciliation}/>
          {(committed?.nativeCustomerImport || preview.nativeCustomerImport) && <NativeCustomerSummary value={committed?.nativeCustomerImport || preview.nativeCustomerImport!} committed={Boolean(committed)}/>}
          {Boolean(preview.warnings?.length) && <div className="migration-warnings"><h3>Observações da importação</h3><ul>{preview.warnings?.map((warning, index) => <li key={index}>{typeof warning === 'string' ? warning : warning.message}</li>)}</ul></div>}
          {preview.issues.length > 0 && <div className="migration-issues"><h3>Pendências encontradas ({preview.issues.length})</h3><DataTable label="Pendências da importação" items={preview.issues.slice(0, 100).map((issue, index) => ({...issue, id:String(index)}))} columns={[{key:'entity',label:'Registro',render:row=>migrationEntityNames[String(row.entity) as MigrationEntity] || String(row.entity)},{key:'row',label:'Linha'},{key:'message',label:'O que conferir'}]}/>{preview.issues.length > 100 && <p className="muted-text">Exibindo as primeiras 100 pendências. Corrija os arquivos e gere uma nova prévia.</p>}</div>}
          <ErrorNotice message={commitMutation.error}/>
          {committed ? <div className="migration-success" role="status"><Icon name="check" size={24}/><div><h3>{committed.status === 'REPLAYED' ? 'Esta importação já estava concluída.' : 'Importação concluída.'}</h3><p>{dateTime(committed.committedAt)} · Lote {committed.batchId}</p><Button variant="secondary" size="S" onPress={() => setTab('history')}>Consultar histórico importado</Button></div></div> : preview.canCommit ? <div className="migration-confirm"><Checkbox isSelected={confirmed} onChange={setConfirmed} isDisabled={busy}>Revisei a prévia e confirmo a importação destes registros para a operação JK.</Checkbox><p>Será importado exatamente o conjunto analisado. Alterar os arquivos ou a escolha sobre veículos exige uma nova prévia e confirmação.</p><Button variant="accent" isDisabled={!confirmed || busy} isPending={commitMutation.pending} onPress={commit}>Confirmar importação</Button></div> : <Notice>Corrija as pendências indicadas, selecione os arquivos atualizados e gere uma nova prévia.</Notice>}
        </div></Section>}
        {!uploads.length && <div className="migration-help"><Icon name="help"/><p>Na exportação nativa de clientes, campos de veículos e valores podem ser preservados como evidência histórica. A prévia explica como cada informação será tratada.</p></div>}
      </div></TabPanel>
      <TabPanel id="history"><div className="migration-tab-content"><MigrationHistory status={status.data} loading={status.loading}/></div></TabPanel>
      <TabPanel id="archive"><NativeArchive/></TabPanel>
      <TabPanel id="reconciliation"><ReconciliationReview/></TabPanel>
      <TabPanel id="catalog"><SourceCatalog/></TabPanel>
      <TabPanel id="team"><TeamMigration/></TabPanel>
    </Tabs>
  </>;
}

function NativeCustomerSummary({value,committed}: {value:NativeCustomerImport;committed:boolean}) {
  return <Notice><strong>{value.mode === 'customers-only' ? 'Somente clientes: nenhum veículo será criado.' : 'Clientes e veículos identificados no arquivo.'}</strong><p>{value.sourceRows.toLocaleString('pt-BR')} linhas originais de {value.sourceColumns} colunas {committed ? 'preservadas.' : 'serão preservadas.'}</p>{value.mode === 'customers-only' && <p>{value.deferredVehicleEntries.toLocaleString('pt-BR')} entradas de placas em {value.deferredVehicleRows.toLocaleString('pt-BR')} linhas ficam para revisão.</p>}<p>{value.ambiguousVehicleRows.toLocaleString('pt-BR')} {value.ambiguousVehicleRows === 1 ? 'linha com veículos ambíguos permanece' : 'linhas com veículos ambíguos permanecem'} para revisão. Os identificadores técnicos representam arquivo e linha; não são IDs fornecidos pelo Jumpcar.</p></Notice>;
}

function Reconciliation({values}: {values: Record<string, unknown>}) {
  const amounts = [['ordersTotalCents', 'Total das ordens'], ['paymentsTotalCents', 'Recebimentos históricos'], ['historicalOutstandingCents', 'Saldo histórico']] as const;
  const available = amounts.filter(([key]) => typeof values[key] === 'number');
  return available.length ? <dl className="migration-reconciliation">{available.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{money(values[key])}</dd></div>)}</dl> : null;
}

function MigrationHistory({status, loading}: {status: MigrationStatus | null; loading: boolean}) {
  const [entity, setEntity] = useState('orders');
  const history = usePagedResource(`/jk/migration/history?entity=${entity}`, 25);
  const historyColumns = entity === 'sourceRows' ? [{key:'sourceRow',label:'Linha da origem'},{key:'dataJson',label:'Cliente na origem',render:(row:RecordData)=>{const data = row.dataJson as Record<string,unknown> | undefined; return String(data?.Nome || data?.nome || 'Registro da exportação');}},{key:'batchId',label:'Lote'}] : entity === 'payments' ? [{key:'id',label:'Registro',render:(row:RecordData)=><span title={row.id}>{row.id.slice(0, 12)}…</span>},{key:'orderId',label:'Ordem'},{key:'amountCents',label:'Valor',render:(row:RecordData)=>money(row.amountCents)},{key:'paidAt',label:'Data',render:(row:RecordData)=>dateTime(row.paidAt || row.createdAt)}] : entity === 'orderItems' ? [{key:'id',label:'Registro',render:(row:RecordData)=><span title={row.id}>{row.id.slice(0, 12)}…</span>},{key:'name',label:'Serviço'},{key:'quantity',label:'Quantidade'},{key:'netCents',label:'Total',render:(row:RecordData)=>money(row.netCents ?? row.totalCents)}] : [{key:'id',label:'Registro',render:(row:RecordData)=><span title={row.id}>{row.id.slice(0, 12)}…</span>},{key:'number',label:'Número',render:(row:RecordData)=>String(row.number || row.sourceNumber || '—')},{key:'status',label:'Situação na origem'},{key:'totalCents',label:'Total',render:(row:RecordData)=>money(row.totalCents)}];
  return <><Notice>Estes são registros históricos. Consulte as ordens atuais na área Ordens de serviço.</Notice>{loading && !status ? <Loading/> : status && <><Reconciliation values={status.totals || {}}/><div className="migration-history-counts">{Object.entries(status.counts || {}).filter(([, count]) => count > 0).map(([key, count]) => <span key={key}><strong>{count.toLocaleString('pt-BR')}</strong>{migrationEntityNames[key as MigrationEntity] || (key === 'sourceRows' ? 'Linhas da origem' : key)}</span>)}</div></>}
    <Section title="Registros importados" subtitle="Consulte os dados preservados de cada exportação."><div className="list-toolbar"><Picker label="Tipo de histórico" value={entity} onChange={value => setEntity(String(value))}><PickerItem id="orders">Ordens de serviço</PickerItem><PickerItem id="orderItems">Itens das ordens</PickerItem><PickerItem id="payments">Recebimentos</PickerItem><PickerItem id="sourceRows">Evidências da exportação</PickerItem></Picker><Button variant="secondary" size="S" onPress={history.refresh}>Atualizar consulta</Button></div><ErrorNotice message={history.error} retry={history.refresh}/>{history.loading ? <Loading/> : history.data?.items.length ? <DataTable label="Histórico importado" items={history.data.items} columns={historyColumns}/> : !history.error && <EmptyState icon="migration" title="Nenhum registro neste histórico" description="As informações de uma importação concluída aparecerão aqui para consulta."/>}</Section><Pagination page={history.page} loading={history.loading} onOffset={history.setOffset}/>
    {Boolean(status?.latestBatches?.length) && <Section title="Importações recentes"><DataTable label="Lotes recentes" items={status!.latestBatches.map((item,index)=>({...item,id:String(item.id || item.batchId || index)}))} columns={[{key:'id',label:'Lote'},{key:'createdAt',label:'Importado em',render:row=>dateTime(row.committedAt || row.createdAt)},{key:'source',label:'Origem',render:row=>String(row.source || 'Jumpcar')} ]}/></Section>}
  </>;
}
