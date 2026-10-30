import {useRef, useState} from 'react';
import {Button} from '@react-spectrum/s2/Button';
import {Checkbox} from '@react-spectrum/s2/Checkbox';
import {FileTrigger} from '@react-spectrum/s2/FileTrigger';
import {Picker, PickerItem} from '@react-spectrum/s2/Picker';
import {SearchField} from '@react-spectrum/s2/SearchField';
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from '../../components/ui/card';
import {Alert, AlertDescription, AlertTitle} from '../../components/ui/alert';
import {EmptyState, ErrorNotice, Icon, Loading, Pagination, StatusPill} from '../../components/ui';
import {dateOnly, dateTime, money, useDebounced, useMutation, usePagedResource, useResource, type PageInfo} from '../../lib/api';
import './native-archive.css';

type Kind = 'orders' | 'customers' | 'products';
const names: Record<Kind, string> = {orders:'Histórico operacional', customers:'Clientes', products:'Produtos'};
type Report = {
  kind: Kind; status?: string; supported?: boolean; canCommit?: boolean; previewHash?: string;
  counts: {rows: number; columns: number; duplicateOrderNumbers: number};
  totals: {valueCents: number; discountCents: number} | null;
  dates: {entryMin: string; entryMax: string; exitMin: string; exitMax: string} | null;
  issues?: {code: string; message: string}[]; committedAt?: string | null; replayAvailable?: boolean;
};
type ArchiveRows = {headers: string[]; items: {id: string; sourceRow: number; values: string[]}[]; page: PageInfo};
const MAX_BYTES = 8 * 1024 * 1024;

export function NativeArchive() {
  const [kind, setKind] = useState<Kind>('orders');
  const [search, setSearch] = useState('');
  const query = useDebounced(search);
  const status = useResource<Report>(`/jk/history-archive/status?kind=${kind}`);
  const rows = usePagedResource<ArchiveRows>(status.data?.supported ? `/jk/history-archive/rows?kind=${kind}&q=${encodeURIComponent(query)}` : null);
  const [file, setFile] = useState<{name: string; content: string} | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Report | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [committed, setCommitted] = useState<Report | null>(null);
  const revision = useRef(0);
  const analysis = useMutation();
  const importFile = useMutation();
  const busy = reading || analysis.pending || importFile.pending;
  const available = status.data?.supported === true && !status.loading && !status.error;
  function reset() {
    revision.current++;
    setPreview(null); setConfirmed(false); setCommitted(null); setError(null);
    analysis.setError(null); importFile.setError(null);
  }
  async function selectFile(files: FileList | null) {
    if (!files?.length || busy || !available) return;
    reset(); setFile(null); setReading(true);
    try {
      const selected = files[0];
      if (selected.size > MAX_BYTES) throw new Error('O arquivo ultrapassa o limite de 8 MB. Preserve a exportação completa para conferência.');
      const buffer = await selected.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      if ((bytes[0] === 0xd0 && bytes[1] === 0xcf) || (bytes[0] === 0x50 && bytes[1] === 0x4b)) throw new Error('Este arquivo é uma planilha binária. Selecione a exportação original do Jumpcar em CSV, mesmo que o nome termine em .xls.');
      let content: string;
      try {content = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(buffer);} catch {throw new Error('O arquivo não está em UTF-8. Selecione a exportação original para preservar todos os caracteres.');}
      if (!content.trim()) throw new Error('O arquivo está vazio.');
      if (new TextEncoder().encode(JSON.stringify({content, previewHash:'0'.repeat(64)})).byteLength > MAX_BYTES) throw new Error('O conteúdo ultrapassa o limite de 8 MB por envio.');
      setFile({name:selected.name, content});
    } catch (cause) {setError(cause instanceof Error ? cause.message : 'Não foi possível ler o arquivo.');}
    finally {setReading(false);}
  }
  async function analyze() {
    if (!file || busy || !available) return;
    reset(); const current = revision.current;
    const result = await analysis.mutate<Report>('/jk/history-archive/preview', {content:file.content});
    if (result && current === revision.current) setPreview(result);
  }
  async function preserve() {
    if (!file || !confirmed || !preview?.canCommit || !preview.previewHash || busy || !available) return;
    const result = await importFile.mutate<Report>('/jk/history-archive/commit', {content:file.content, previewHash:preview.previewHash});
    if (result) {
      setCommitted(result); setConfirmed(false); setKind(result.kind); setSearch('');
      status.refresh(); rows.refresh();
    }
  }
  return <div className="native-archive">
    <Alert role="note"><Icon name="migration"/><AlertTitle>Os arquivos originais, disponíveis para consulta</AlertTitle><AlertDescription>Preserve todas as colunas de clientes, produtos e histórico operacional. Este acervo não cria atendimentos, recebimentos, comissões ou movimentações de estoque. Novas exportações precisam de reconciliação: não há sincronização automática.</AlertDescription></Alert>
    <Card>
      <CardHeader><CardTitle><h2>Preservar uma exportação</h2></CardTitle><CardDescription>Use um arquivo original por vez. O tipo é identificado pelos cabeçalhos, sem vincular clientes ou ordens pelo nome.</CardDescription></CardHeader>
      <CardContent>
        <ErrorNotice message={status.error} retry={status.refresh}/>
        {status.data?.supported === false && <p>O acervo está disponível na instalação local JK.</p>}
        <div className="archive-upload"><div><strong>{file?.name || 'Selecione o arquivo do Jumpcar'}</strong><p>CSV ou exportação .xls em formato de texto · até 8 MB.</p></div><FileTrigger acceptedFileTypes={['.xls','.csv']} onSelect={selectFile}><Button variant="secondary" isDisabled={busy || !available} isPending={reading}>Escolher exportação</Button></FileTrigger><Button variant="accent" isDisabled={!file || busy || !available || Boolean(committed)} isPending={analysis.pending} onPress={analyze}>Conferir arquivo</Button></div>
        <ErrorNotice message={error || analysis.error || importFile.error}/>
        {preview && <section className="archive-preview" aria-label="Prévia do acervo"><div className="archive-heading"><h3>{names[preview.kind]}</h3><StatusPill tone={preview.canCommit ? 'green' : 'orange'}>{preview.canCommit ? 'Arquivo conferido' : 'Revisão necessária'}</StatusPill></div><ArchiveSummary report={preview}/>
          {Boolean(preview.counts.duplicateOrderNumbers) && <p>Existem {preview.counts.duplicateOrderNumbers} números de ordem repetidos. Cada linha será preservada separadamente, sem juntar registros.</p>}
          {preview.issues?.map(issue=><p key={issue.code} role="alert">{issue.message}</p>)}
          {committed ? <p role="status" className="archive-success"><Icon name="check"/>{committed.status === 'REPLAYED' ? 'Este arquivo já estava preservado. Nenhum registro foi duplicado.' : 'Arquivo preservado. Os registros estão disponíveis na consulta abaixo.'}</p> : preview.canCommit && <div className="archive-confirm"><Checkbox isSelected={confirmed} onChange={setConfirmed} isDisabled={busy}>Conferi os totais e quero preservar este arquivo no acervo da JK.</Checkbox><Button variant="accent" isDisabled={!confirmed || busy || !available} isPending={importFile.pending} onPress={preserve}>Preservar arquivo</Button></div>}
        </section>}
      </CardContent>
    </Card>
    <Card>
      <CardHeader><CardTitle><h2>Consultar os dados originais</h2></CardTitle><CardDescription>As informações aparecem como constam na exportação. A linha de origem distingue registros com o mesmo número.</CardDescription></CardHeader>
      <CardContent>
        <div className="archive-toolbar"><Picker label="Acervo" value={kind} onChange={value=>{setKind(value as Kind);setSearch('');}}>{Object.entries(names).map(([id,name])=><PickerItem id={id} key={id}>{name}</PickerItem>)}</Picker><SearchField label="Buscar no acervo" value={search} onChange={setSearch} maxLength={200}/><Button variant="secondary" onPress={()=>{status.refresh();rows.refresh();}} isDisabled={status.loading || rows.loading}>Atualizar consulta</Button></div>
        {status.data?.supported === true && <ArchiveSummary report={status.data}/>}
        {status.data?.committedAt && <p className="archive-caption">Arquivo preservado em {dateTime(status.data.committedAt)}.</p>}
        <ErrorNotice message={rows.error} retry={rows.refresh}/>
        {status.loading || rows.loading ? <Loading label="Carregando o acervo…"/> : rows.data?.items.length ? <div className="archive-table-scroll" tabIndex={0} role="region" aria-label="Tabela do acervo, com rolagem horizontal"><table><caption>{names[kind]} · dados da exportação</caption><thead><tr><th scope="col">Linha de origem</th>{rows.data.headers.map((header,index)=><th scope="col" key={index}>{header}</th>)}</tr></thead><tbody>{rows.data.items.map(row=><tr key={row.id}><th scope="row">{row.sourceRow}</th>{row.values.map((value,index)=><td key={index}>{value || '—'}</td>)}</tr>)}</tbody></table></div> : !rows.error && !status.error && <EmptyState icon="migration" title={query ? 'Nenhum registro encontrado' : 'Nenhum arquivo preservado neste acervo'} description={query ? 'Tente outro nome, placa ou número de ordem.' : 'Confira uma exportação e confirme a preservação para consultar os dados aqui.'}/>}
        <Pagination page={rows.page} loading={rows.loading} onOffset={rows.setOffset}/>
      </CardContent>
    </Card>
  </div>;
}

function ArchiveSummary({report}: {report: Report}) {
  return <dl className="archive-summary"><div><dt>Registros</dt><dd>{report.counts.rows.toLocaleString('pt-BR')}</dd></div><div><dt>Colunas preservadas</dt><dd>{report.counts.columns}</dd></div>{report.totals && <div><dt>Valor no histórico</dt><dd>{money(report.totals.valueCents)}</dd></div>}{report.dates?.entryMin && <div><dt>Período de entrada</dt><dd>{dateOnly(report.dates.entryMin)} a {dateOnly(report.dates.entryMax)}</dd></div>}</dl>;
}
