import {useRef,useState} from 'react';
import {Button} from '@react-spectrum/s2/Button';
import {Checkbox} from '@react-spectrum/s2/Checkbox';
import {FileTrigger} from '@react-spectrum/s2/FileTrigger';
import {SearchField} from '@react-spectrum/s2/SearchField';
import {DataTable,EmptyState,ErrorNotice,Loading,Notice,Pagination,Section,TabBar,type TableColumn} from '../../components/ui';
import {dateTime,money,useDebounced,useMutation,usePagedResource,useResource,type PageInfo,type RecordData} from '../../lib/api';
import './source-review.css';

type Collection='services'|'products'|'balances';
type Counts=Record<Collection,number>;
type Report={status:string;canCommit?:boolean;previewHash?:string;counts:Counts;issues?:{code:string;message?:string}[];committedAt?:string;replayAvailable?:boolean};
type State={supported:boolean;status:string;counts:Counts;totalSnapshots:number;observedAt?:string;committedAt?:string};
type SourceRow=RecordData&{name:string;sourceRow:number;raw:Record<string,unknown>;provenance:{sourceRow:number;observedAt:string}};
type Rows={items:SourceRow[];page:PageInfo};
const BASE='/jk/source-catalog';
const MAX_BYTES=8*1024*1024;
function parseSnapshot(content:string):Record<string,unknown>{
  let parsed:unknown;
  try {parsed=JSON.parse(content.replace(/^\uFEFF/,''));}catch{throw new Error('O conteúdo precisa conter JSON UTF-8 válido e completo.');}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('O JSON deve conter o objeto completo da referência da origem.');
  if(new TextEncoder().encode(JSON.stringify({snapshot:parsed,previewHash:'0'.repeat(64)})).byteLength>MAX_BYTES)throw new Error('O conjunto ultrapassa o limite de 8 MB por envio.');
  return parsed as Record<string,unknown>;
}
const names:Record<Collection,string>={services:'Serviços',products:'Produtos',balances:'Posições da origem'};
const unknown=(value:unknown)=>value===null||value===undefined||value===''?'Não informado':typeof value==='boolean'?(value?'Sim':'Não'):String(value);
const valueMoney=(value:unknown)=>value===null||value===undefined?'Não informado':money(value);
const active=(value:unknown)=>value===null||value===undefined?'Não informado':value?'Ativo na origem':'Inativo na origem';
const balanceKind:Record<string,string>={account:'Conta',cash:'Caixa',receivable:'A receber',payable:'A pagar','customer-credit':'Crédito de cliente','package-credit':'Crédito de pacote',other:'Outra posição'};
const columns:Record<Collection,TableColumn[]>={
  services:[{key:'name',label:'Serviço na origem'},{key:'sourceRow',label:'Linha de origem'},{key:'category',label:'Categoria',render:row=>unknown(row.category)},{key:'priceCents',label:'Preço na origem',render:row=>valueMoney(row.priceCents)},{key:'active',label:'Situação',render:row=>active(row.active)},{key:'schedulingEnabled',label:'Agenda habilitada',render:row=>unknown(row.schedulingEnabled)},{key:'durationMinutes',label:'Duração (minutos)',render:row=>unknown(row.durationMinutes)},{key:'commissionBps',label:'Comissão na origem',render:row=>row.commissionBps==null?'Não informado':`${Number(row.commissionBps)/100}%`}],
  products:[{key:'name',label:'Produto na origem'},{key:'sourceRow',label:'Linha de origem'},{key:'sku',label:'Código',render:row=>unknown(row.sku)},{key:'brand',label:'Marca',render:row=>unknown(row.brand)},{key:'category',label:'Categoria',render:row=>unknown(row.category)},{key:'application',label:'Aplicação',render:row=>unknown(row.application)},{key:'unit',label:'Unidade',render:row=>unknown(row.unit)},{key:'unitsPerItem',label:'Unidades por item',render:row=>unknown(row.unitsPerItem)},{key:'sourceQuantity',label:'Quantidade na origem',render:row=>unknown(row.sourceQuantity)},{key:'sourceMinimumQuantity',label:'Mínimo na origem',render:row=>unknown(row.sourceMinimumQuantity)},{key:'priceCents',label:'Preço na origem',render:row=>valueMoney(row.priceCents)},{key:'costCents',label:'Custo na origem',render:row=>valueMoney(row.costCents)},{key:'active',label:'Situação',render:row=>active(row.active)}],
  balances:[{key:'name',label:'Posição na origem'},{key:'sourceRow',label:'Linha de origem'},{key:'kind',label:'Natureza',render:row=>balanceKind[String(row.kind)]||unknown(row.kind)},{key:'amountCents',label:'Valor observado na origem',render:row=>valueMoney(row.amountCents)},{key:'status',label:'Situação informada',render:row=>unknown(row.status)},{key:'asOf',label:'Referência da posição',render:row=>row.asOf?dateTime(row.asOf):'Não informada'}],
};

export function SourceCatalog(){
  const status=useResource<State>(BASE+'/status');
  const [collection,setCollection]=useState<Collection>('services');const [search,setSearch]=useState('');const query=useDebounced(search);
  const available=status.data?.supported===true&&!status.error&&!status.loading;
  const rows=usePagedResource<Rows>(available?`${BASE}/rows?collection=${collection}&q=${encodeURIComponent(query)}`:null);
  const [file,setFile]=useState<{name:string;snapshot:Record<string,unknown>}|null>(null);
  const [pasted,setPasted]=useState('');
  const [reading,setReading]=useState(false);const [localError,setLocalError]=useState<string|null>(null);
  const [preview,setPreview]=useState<Report|null>(null);const [confirmed,setConfirmed]=useState(false);const [saved,setSaved]=useState<Report|null>(null);
  const analysis=useMutation();const commit=useMutation();const revision=useRef(0);
  const busy=reading||analysis.pending||commit.pending;
  function reset(){revision.current++;setPreview(null);setConfirmed(false);setSaved(null);setLocalError(null);analysis.setError(null);commit.setError(null);}
  async function selectFile(files:FileList|null){
    if(!files?.length||busy||!available)return;
    reset();setFile(null);setPasted('');setReading(true);
    try {
      const selected=files[0];if(selected.size>MAX_BYTES)throw new Error('O arquivo ultrapassa 8 MB. Preserve o conjunto privado e confira o formato de exportação.');
      let content:string;
      try {content=new TextDecoder('utf-8',{fatal:true}).decode(await selected.arrayBuffer());}catch{throw new Error('O arquivo precisa conter JSON UTF-8 válido e completo.');}
      setFile({name:selected.name,snapshot:parseSnapshot(content)});
    }catch(cause){setLocalError(cause instanceof Error?cause.message:'Não foi possível ler o arquivo privado.');}finally{setReading(false);}
  }
  function usePastedContent(){
    if(!available||busy||!pasted.trim())return;
    reset();setFile(null);
    try {setFile({name:'Conteúdo JSON colado',snapshot:parseSnapshot(pasted)});}catch(cause){setLocalError(cause instanceof Error?cause.message:'Não foi possível conferir o conteúdo colado.');}
  }
  return <div className="source-review">
    <Notice>Serviços, produtos e posições abaixo são referências observadas no Jumpcar. As posições não são saldos da JK. Preservar este catálogo não ativa serviços, não cria estoque, caixa, recebíveis, créditos ou pagamentos. Campos não observados permanecem como “Não informado”.</Notice>
    <ErrorNotice message={status.error} retry={status.refresh}/>
    {status.loading&&<Loading label="Carregando a referência da origem…"/>}
    {status.data?.supported===false&&<Notice>O catálogo documental está disponível na instalação local JK.</Notice>}
    <Section title="Consultar o catálogo da origem" subtitle="Consulta da referência completa mais recente, preservando o que foi informado e o que é desconhecido.">
      <div className="source-review-content">
        {status.data&&<CatalogCounts counts={status.data.counts}/>}
        {status.data?.observedAt&&<p>Observado na origem em {dateTime(status.data.observedAt)}.</p>}
        <TabBar id="source-catalog-view" label="Conjuntos da origem" items={[["services","Serviços"],["products","Produtos"],["balances","Posições da origem"]]} value={collection} onChange={value=>{setCollection(value as Collection);setSearch('');}}/>
        <div role="tabpanel" id="source-catalog-view-panel" aria-labelledby={`source-catalog-view-tab-${collection}`}>
          <div className="source-review-filters"><SearchField label="Buscar na referência da origem" value={search} onChange={setSearch} maxLength={200}/><Button variant="secondary" onPress={()=>{status.refresh();rows.refresh();}} isDisabled={status.loading||rows.loading}>Atualizar referência</Button></div>
          {collection==='balances'&&<Notice>Os valores informados pertencem à origem e à data observada. Não some posições de naturezas diferentes e não use este quadro como abertura financeira da JK.</Notice>}
          <ErrorNotice message={rows.error} retry={rows.refresh}/>
          {rows.loading?<Loading label={`Carregando ${names[collection].toLowerCase()}…`}/>:rows.data?.items.length?<DataTable label={`${names[collection]} — referência documental`} items={rows.data.items} columns={[...columns[collection],{key:'sourceId',label:'ID real da origem',render:row=>unknown(row.sourceId)},{key:'provenance',label:'Observação na origem',render:row=>dateTime((row.provenance as SourceRow['provenance'])?.observedAt)}]} actions={row=><details><summary>Campos originais</summary><dl className="source-review-raw">{Object.entries((row.raw||{}) as Record<string,unknown>).map(([key,value])=><div key={key}><dt>{key}</dt><dd>{unknown(value)}</dd></div>)}</dl></details>}/>:!rows.error&&<EmptyState icon="migration" title={query?'Nenhuma referência encontrada':'Nenhuma referência preservada neste conjunto'} description={query?'Tente outro nome ou código.':'A consulta permanece vazia até a preservação explícita de uma referência completa da origem.'}/>}
          <Pagination page={rows.page} loading={rows.loading} onOffset={rows.setOffset}/>
        </div>
      </div>
    </Section>
    <details><summary>Preservar uma nova referência privada da origem</summary><div className="source-review-actions">
      <p>Escolha o JSON completo preparado a partir da consulta autorizada da unidade JK. O arquivo é enviado somente ao solicitar a conferência. Preserve as listas de serviços, produtos e posições; use null para os campos desconhecidos. Esta etapa não ativa cadastros operacionais.</p>
      <div className="source-review-file"><strong>{file?.name||'Nenhum arquivo privado selecionado'}</strong><FileTrigger acceptedFileTypes={['.json','application/json']} onSelect={selectFile}><Button variant="secondary" isDisabled={!available||busy} isPending={reading}>Escolher JSON privado</Button></FileTrigger><Button variant="accent" isDisabled={!file||!available||busy||Boolean(saved)} isPending={analysis.pending} onPress={async()=>{if(!file)return;reset();const current=revision.current;const result=await analysis.mutate<Report>(BASE+'/preview',{snapshot:file.snapshot});if(result&&current===revision.current)setPreview(result);}}>Conferir catálogo</Button></div>
      <div className="source-review-paste"><label htmlFor="source-catalog-json-paste">JSON privado para colar</label><p id="source-catalog-paste-hint">Como alternativa ao arquivo, cole o objeto JSON completo, com até 8 MB. Digitar e usar o conteúdo não enviam dados; depois solicite a conferência.</p><textarea id="source-catalog-json-paste" value={pasted} onChange={event=>{setPasted(event.target.value);setFile(null);reset();}} rows={8} maxLength={MAX_BYTES} disabled={!available||busy} spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-describedby="source-catalog-paste-hint"/><Button variant="secondary" isDisabled={!pasted.trim()||!available||busy} onPress={usePastedContent}>Usar conteúdo colado</Button></div>
      <ErrorNotice message={localError||analysis.error||commit.error}/>
      {preview&&<section className="panel-inset" aria-label="Prévia da referência da origem"><h3>Confira os conjuntos da origem</h3><CatalogCounts counts={preview.counts}/><p>Nenhum cadastro operacional, estoque ou saldo da JK será criado.</p>
        {preview.issues?.length?<ul>{preview.issues.map((issue,index)=><li key={index}>{issue.message||issue.code}</li>)}</ul>:null}
        {saved?<p role="status">{saved.status==='REPLAYED'?'Esta referência já estava preservada. Nenhuma linha foi duplicada.':'Referência da origem preservada para consulta.'}</p>:<div className="source-review-actions"><Checkbox isSelected={confirmed} onChange={setConfirmed} isDisabled={busy||!preview.canCommit}>Conferi a prévia e quero preservar esta referência sem criar saldos ou cadastros operacionais.</Checkbox><Button variant="accent" isPending={commit.pending} isDisabled={!file||!confirmed||!preview.canCommit||!preview.previewHash||busy} onPress={async()=>{if(!file)return;const result=await commit.mutate<Report>(BASE+'/commit',{snapshot:file.snapshot,previewHash:preview.previewHash});if(result){setSaved(result);setConfirmed(false);status.refresh();rows.refresh();}}}>Confirmar referência da origem</Button></div>}
      </section>}
    </div></details>
  </div>;
}
function CatalogCounts({counts}:{counts:Counts}){return <dl className="source-review-summary">{(['services','products','balances'] as const).map(kind=><div key={kind}><dt>{names[kind]}</dt><dd>{counts[kind]}</dd></div>)}</dl>;}
