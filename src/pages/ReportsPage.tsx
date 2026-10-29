import {useState} from 'react';
import {Button} from '@react-spectrum/s2/Button';
import {Fields,paymentMethods,type FormValues,type Field} from '../components/FormFields';
import {DataTable,EmptyState,ErrorNotice,Loading,Notice,PageHeader,Pagination,type TableColumn} from '../components/ui';
import {usePagedResource,type PageInfo,type RecordData,money,dateTime,today} from '../lib/api';
import {csvCell} from '../lib/csv';

type Report={items:RecordData[];page?:PageInfo;summary:{receivedCents:number;deliveredCents:number;openReceivableCents:number;orderCount:number};period:{from:string;to:string};type:string};
const names:Record<string,string>={summary:'Resumo da operação',sales:'Recebimentos',services:'Serviços entregues',employees:'Desempenho da equipe',stock:'Posição de estoque',cash:'Movimentos de caixa'};
const sources:Record<string,string>={order:'Ordem de serviço',invoice:'Fatura',package:'Pacote',payroll:'Folha',manual:'Manual'};
const monetary=(key:string,label:string):TableColumn=>({key,label,render:row=>money(row[key]),align:'right'});
const columns:Record<string,TableColumn[]>={
  summary:[{key:'label',label:'Indicador'},{key:'value',label:'Valor',render:r=>['cents','BRL','currency'].includes(String(r.unit))?money(r.value):Number(r.value).toLocaleString('pt-BR')}],
  sales:[{key:'createdAt',label:'Data',render:r=>dateTime(r.createdAt)},{key:'customerName',label:'Cliente'},{key:'source',label:'Origem',render:r=>sources[String(r.source)]||String(r.source)},{key:'method',label:'Forma',render:r=>paymentMethods[String(r.method) as keyof typeof paymentMethods]||String(r.method)},monetary('amountCents','Valor'),{key:'reference',label:'Referência'}],
  services:[{key:'name',label:'Serviço'},{key:'quantity',label:'Quantidade'},monetary('grossCents','Bruto'),monetary('netCents','Líquido'),monetary('commissionCents','Comissões')],
  employees:[{key:'name',label:'Profissional'},{key:'orders',label:'Ordens entregues'},monetary('netCents','Valor líquido'),monetary('commissionCents','Comissões')],
  stock:[{key:'name',label:'Produto'},{key:'sku',label:'Código'},{key:'unit',label:'Unidade'},{key:'quantityMilli',label:'Saldo',render:r=>(Number(r.quantityMilli)/1000).toLocaleString('pt-BR')},{key:'minQuantityMilli',label:'Mínimo',render:r=>(Number(r.minQuantityMilli)/1000).toLocaleString('pt-BR')},monetary('costCents','Custo unitário')],
  cash:[{key:'createdAt',label:'Data',render:r=>dateTime(r.createdAt)},{key:'type',label:'Tipo',render:r=>r.type==='out'?'Saída':'Entrada'},{key:'source',label:'Origem',render:r=>sources[String(r.source)]||String(r.source)},{key:'category',label:'Categoria'},monetary('amountCents','Valor')],
};
export function ReportsPage() {
  const currentDate=today();
  const [filters,setFilters]=useState<FormValues>({type:'summary',from:`${currentDate.slice(0,7)}-01`,to:currentDate});
  const [applied,setApplied]=useState(filters);
  const resource=usePagedResource<Report>(`/reports?type=${applied.type}&from=${applied.from}&to=${applied.to}`);
  const [filterError,setFilterError]=useState<string|null>(null);
  const fields:Field[]=[{key:'type',label:'Relatório',type:'select',options:Object.entries(names).map(([id,label])=>({id,label}))},{key:'from',label:'De',type:'date',required:true},{key:'to',label:'Até',type:'date',required:true}];
  const report=resource.data;
  const reportColumns=columns[String(applied.type)]||columns.summary;
  const items=(report?.items||[]).map((item,index):RecordData=>({...item,id:item.id||String(item.serviceId||item.employeeId||item.metric||index)}));
  function exportCsv() {
    if(!report)return;
    const cell=csvCell;
    const exportColumns=applied.type==='summary'?[...reportColumns,{key:'unit',label:'Unidade (cents = centavos; count = quantidade)'}]:reportColumns;
    const data=[exportColumns.map(col=>cell(`${col.label}${col.key.endsWith('Cents')?' (centavos)':col.key.endsWith('Milli')?' (milésimos de unidade)':''}`)).join(';'),...items.map(row=>exportColumns.map(col=>cell(row[col.key])).join(';'))].join('\r\n');
    const blob=new Blob(['\uFEFF',data],{type:'text/csv;charset=utf-8'});
    const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=`ab-uash-${applied.type}-${applied.from}-${applied.to}-pagina-${Math.floor((report.page?.offset||0)/(report.page?.limit||25))+1}.csv`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  return <><div className="screen-only"><PageHeader eyebrow="CONTROLE" title="Relatórios" description="Transforme os registros da operação em informações para decidir."><Button variant="secondary" onPress={()=>window.print()} isDisabled={!report||resource.loading}>Imprimir página</Button><Button variant="accent" onPress={exportCsv} isDisabled={!report||resource.loading}>Exportar página CSV</Button></PageHeader><section className="panel report-filters"><Fields fields={fields} values={filters} onChange={(key,value)=>setFilters(old=>({...old,[key]:value}))}/><Button variant="accent" onPress={()=>{if(!filters.from||!filters.to||String(filters.from)>String(filters.to)){setFilterError('Informe um intervalo de datas válido.');return;}setFilterError(null);setApplied({...filters});}}>Aplicar filtros</Button></section><ErrorNotice message={filterError||resource.error} retry={resource.error?resource.refresh:undefined}/>{resource.loading?<Loading/>:report&&<><div className="metric-grid"><div className="metric-card"><span>Recebido no período</span><strong>{money(report.summary.receivedCents)}</strong></div><div className="metric-card"><span>Serviços entregues</span><strong>{money(report.summary.deliveredCents)}</strong></div><div className="metric-card"><span>Saldo atual a receber</span><strong>{money(report.summary.openReceivableCents)}</strong></div><div className="metric-card"><span>Ordens no período</span><strong>{report.summary.orderCount}</strong></div></div><Notice>{applied.type==='stock'?'O estoque representa a posição atual, independentemente do período selecionado.':'Recebimentos consideram a data do lançamento; serviços e equipe consideram a entrega. O saldo a receber representa a posição atual.'} Valores monetários do CSV estão em centavos; quantidades de estoque em milésimos de unidade.</Notice><section className="panel"><div className="panel-heading"><div><h2>{names[String(applied.type)]}</h2><p>{String(applied.from)} a {String(applied.to)} · {items.length} registros</p></div></div>{items.length?<DataTable label={names[String(applied.type)]} items={items} columns={reportColumns}/>:<EmptyState icon="reports" title="Nenhum registro neste período" description="Altere o intervalo ou registre novos atendimentos para acompanhar os resultados."/>}</section><Pagination page={resource.page} loading={resource.loading} onOffset={resource.setOffset}/></>}</div>{report&&<article className="print-document"><header><div><h1>AB-UASH</h1><p>{names[String(applied.type)]}</p></div><div><p>De {String(applied.from)} até {String(applied.to)}</p><p>Gerado em {dateTime(new Date().toISOString())}</p><p>Página: {report.page?report.page.total?`${report.page.offset+1}–${Math.min(report.page.offset+report.page.limit,report.page.total)} de ${report.page.total}`:'0':items.length} registros</p></div></header><hr/><p>Recebido: {money(report.summary.receivedCents)} · Entregue: {money(report.summary.deliveredCents)} · Saldo atual a receber: {money(report.summary.openReceivableCents)}</p><DataTable label={names[String(applied.type)]} items={items} columns={reportColumns}/><footer>Relatório de controle interno · AB-UASH · Valores monetários em reais, salvo indicação.</footer></article>}</>;
}
