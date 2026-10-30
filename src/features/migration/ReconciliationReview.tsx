import {useState} from 'react';
import {Button} from '@react-spectrum/s2/Button';
import {Checkbox} from '@react-spectrum/s2/Checkbox';
import {Picker,PickerItem} from '@react-spectrum/s2/Picker';
import {TextField} from '@react-spectrum/s2/TextField';
import {DataTable,EmptyState,ErrorNotice,Loading,Modal,Notice,Pagination,Section,TabBar,fullWidth} from '../../components/ui';
import {dateTime,useDebounced,useMutation,usePagedResource,useResource,type PageInfo,type RecordData} from '../../lib/api';
import './source-review.css';

type Counts={vehicles:{eligible:number;staged:number;promoted:number;pendingReview:number;conflictGroups:number;conflictingEntries:number;ambiguousCustomerRows:number;ambiguousTokenCollisions:number};history:{rows:number;proposal:number;insufficientIdentity:number;identityMismatch:number;plateConflict:number;plateAbsent:number;invalidPlate:number}};
type Report={status:string;canCommit?:boolean;previewHash?:string;counts:Counts;warnings?:string[];committedAt?:string;operationalWrites?:{vehicles:number}};
type State={supported:boolean;ready:boolean;counts?:Counts;requiredArchives?:string[];latestBatch?:{batchId:string;committedAt:string}|null};
type Vehicle=RecordData&{vehicleRef:string;customerId:string;customerName:string;plate:string;sourceRow:number;status:string;category:string|null;model:string|null;vehicleId:string|null};
type VehicleRows={items:Vehicle[];page:PageInfo};
type History=RecordData&{sourceRow:number;sourceNumber:string;values:string[];proposal:{status:string;candidateCustomerId:string|null;vehicleRef:string|null}};
type HistoryRows={headers:string[];items:History[];page:PageInfo};
type Review={vehicle:Vehicle;category:string;model:string;color:string};
const BASE='/jk/reconciliation';
const categories=[['small','Pequeno'],['medium','Médio'],['large','Grande'],['motorcycle','Moto']] as const;
const labels:Record<string,string>={awaiting_review:'Aguardando revisão',promoted:'Cadastro revisado',proposal:'Proposta documental',insufficient_identity:'Identidade insuficiente',identity_mismatch:'Identidade divergente',plate_conflict:'Placa conflitante',plate_absent:'Placa sem candidato',invalid_plate:'Placa inválida ou ausente'};

export function ReconciliationReview(){
  const status=useResource<State>(BASE+'/status');
  const [view,setView]=useState('vehicles');
  const [plate,setPlate]=useState('');const [customerId,setCustomerId]=useState('');const [filter,setFilter]=useState('');
  const debouncedPlate=useDebounced(plate);const debouncedCustomer=useDebounced(customerId);
  const query=`plate=${encodeURIComponent(debouncedPlate)}&customerId=${encodeURIComponent(debouncedCustomer)}&status=${encodeURIComponent(filter)}`;
  const available=status.data?.supported===true&&status.data.ready&&!status.error;
  const vehicles=usePagedResource<VehicleRows>(available&&view==='vehicles'?`${BASE}/vehicles?${query}`:null);
  const history=usePagedResource<HistoryRows>(available&&view==='history'?`${BASE}/history?${query}`:null);
  const prepare=useMutation();const preserve=useMutation();const vehiclePreview=useMutation();const vehicleCommit=useMutation();
  const [preview,setPreview]=useState<Report|null>(null);const [confirmed,setConfirmed]=useState(false);const [saved,setSaved]=useState(false);
  const [review,setReview]=useState<Review|null>(null);const [reviewed,setReviewed]=useState<Report|null>(null);const [reviewConfirmed,setReviewConfirmed]=useState(false);
  const [success,setSuccess]=useState<string|null>(null);
  const busy=prepare.pending||preserve.pending||vehiclePreview.pending||vehicleCommit.pending;
  const source=review?{vehicleReviews:[{vehicleRef:review.vehicle.vehicleRef,category:review.category,model:review.model.trim(),color:review.color.trim()}]}:null;
  const reviewValid=Boolean(review?.category&&review.model.trim());
  function clearReview(){setReviewed(null);setReviewConfirmed(false);vehiclePreview.setError(null);vehicleCommit.setError(null);}
  function updateReview(change:Partial<Review>){setReview(old=>old?{...old,...change}:null);clearReview();}
  function refresh(){status.refresh();vehicles.refresh();history.refresh();}
  return <div className="source-review">
    <Notice>Os acervos já preservados ajudam a revisar placas e histórico. As propostas continuam documentais: não confirmam proprietário por semelhança de nome, não criam OS, recebimentos, saldos ou sincronização. Um veículo só ganha cadastro após revisão individual do administrador.</Notice>
    <ErrorNotice message={status.error} retry={status.refresh}/>
    {status.loading?<Loading label="Verificando os acervos da conciliação…"/>:status.data&&!available&&<Notice>Preserve os acervos originais de clientes e histórico e confira a importação dos clientes antes de preparar os vínculos. Nenhum arquivo será reimportado por esta tela.</Notice>}
    <Section title="Vínculos dos acervos existentes" subtitle="Confira a proposta antes de preservar os vínculos para consulta.">
      <div className="source-review-content">
        {status.data?.counts&&<ReconciliationCounts counts={status.data.counts}/>}
        {status.data?.latestBatch&&<p>Última conferência preservada: {dateTime(status.data.latestBatch.committedAt)}.</p>}
        <Button variant="secondary" isDisabled={!available||busy} isPending={prepare.pending} onPress={async()=>{setPreview(null);setConfirmed(false);setSaved(false);preserve.setError(null);const result=await prepare.mutate<Report>(BASE+'/preview',{});if(result)setPreview(result);}}>Conferir vínculos documentais</Button>
        <ErrorNotice message={prepare.error||preserve.error}/>
        {preview&&<div className="panel-inset"><h3>Prévia dos vínculos documentais</h3><ReconciliationCounts counts={preview.counts}/><p>Esta confirmação preserva referências das linhas originais. Nenhum veículo operacional será criado por esta etapa.</p>
          {preview.warnings?.length?<ul>{preview.warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul>:null}
          {saved?<p role="status">Vínculos documentais preservados. Consulte as linhas abaixo e revise cada veículo necessário.</p>:<div className="source-review-actions"><Checkbox isSelected={confirmed} onChange={setConfirmed} isDisabled={busy||!preview.canCommit}>Conferi a prévia e autorizo preservar somente os vínculos documentais.</Checkbox><Button variant="accent" isPending={preserve.pending} isDisabled={!confirmed||!preview.canCommit||!preview.previewHash||busy} onPress={async()=>{const result=await preserve.mutate<Report>(BASE+'/commit',{previewHash:preview.previewHash});if(result){setConfirmed(false);setSaved(true);refresh();}}}>Confirmar vínculos documentais</Button></div>}
        </div>}
      </div>
    </Section>
    <Section title="Consultar e revisar as linhas" subtitle="Placa exata e ID do cliente são filtros; o histórico mantém todas as colunas originais.">
      <div className="source-review-content">
        <TabBar id="reconciliation-view" label="Consultar conciliação" items={[["vehicles","Veículos"],["history","Histórico"]]} value={view} onChange={value=>{setView(value);setFilter('');}}/>
        <div role="tabpanel" id="reconciliation-view-panel" aria-labelledby={`reconciliation-view-tab-${view}`}>
          <div className="source-review-filters"><TextField label="Placa exata" value={plate} onChange={setPlate} maxLength={20}/><TextField label="ID do cliente" value={customerId} onChange={setCustomerId} maxLength={100}/><Picker label="Situação da conciliação" value={filter||null} onChange={value=>setFilter(String(value||''))}><PickerItem id="">Todas as situações</PickerItem>{(view==='vehicles'?['awaiting_review','promoted']:['proposal','insufficient_identity','identity_mismatch','plate_conflict','plate_absent','invalid_plate']).map(value=><PickerItem id={value} key={value}>{labels[value]}</PickerItem>)}</Picker><Button variant="secondary" onPress={refresh} isDisabled={status.loading||vehicles.loading||history.loading}>Atualizar consulta</Button></div>
          <ErrorNotice message={vehicles.error||history.error} retry={view==='vehicles'?vehicles.refresh:history.refresh}/>
          {success&&<p role="status">{success}</p>}
          {vehicles.loading||history.loading?<Loading label="Carregando linhas para revisão…"/>:view==='vehicles'?vehicles.data?.items.length?<DataTable label="Veículos para revisão individual" items={vehicles.data.items.map(row=>({...row,id:row.vehicleRef}))} columns={[{key:'plate',label:'Placa'},{key:'customerName',label:'Cliente candidato'},{key:'sourceRow',label:'Linha de origem'},{key:'status',label:'Situação',render:row=>labels[String(row.status)]||String(row.status)},{key:'category',label:'Categoria',render:row=>categories.find(([id])=>id===row.category)?.[1]||'Não confirmada'},{key:'model',label:'Modelo',render:row=>row.model?String(row.model):'Não confirmado'}]} actions={row=>row.status==='awaiting_review'?<Button size="S" variant="secondary" isDisabled={busy} onPress={()=>{setReview({vehicle:row as Vehicle,category:'',model:'',color:''});setSuccess(null);clearReview();}}>Revisar {String(row.plate)}</Button>:null}/>:<EmptyState icon="migration" title="Nenhum veículo nesta consulta" description="Confira os filtros e preserve primeiro os vínculos documentais. Placas conflitantes ou ambíguas continuam pendentes."/>:history.data?.items.length?<div className="source-review-table" role="region" tabIndex={0} aria-label="Histórico completo, com rolagem horizontal"><table><caption>Histórico documental · valores originais, sem OS operacional</caption><thead><tr><th scope="col">Linha</th><th scope="col">Situação do vínculo</th><th scope="col">ID do cliente candidato</th><th scope="col">Referência do veículo</th>{history.data.headers.map((header,index)=><th scope="col" key={index}>{header}</th>)}</tr></thead><tbody>{history.data.items.map(row=><tr key={row.id}><th scope="row">{row.sourceRow}</th><td>{labels[row.proposal.status]||row.proposal.status}</td><td>{row.proposal.candidateCustomerId||'Sem candidato confirmado'}</td><td>{row.proposal.vehicleRef||'Sem referência'}</td>{row.values.map((value,index)=><td key={index}>{value||'Não informado'}</td>)}</tr>)}</tbody></table></div>:<EmptyState icon="migration" title="Nenhuma linha histórica nesta consulta" description="Confira os filtros e preserve primeiro os vínculos documentais. A ausência de proposta não autoriza uma associação por nome."/>}
          <Pagination page={view==='vehicles'?vehicles.page:history.page} loading={vehicles.loading||history.loading} onOffset={view==='vehicles'?vehicles.setOffset:history.setOffset}/>
        </div>
      </div>
    </Section>
    {review&&<Modal title={`Revisar veículo ${review.vehicle.plate}`} onClose={()=>{if(!busy){setReview(null);clearReview();}}} isPending={busy} footer={<Button variant="secondary" isDisabled={busy} onPress={()=>{setReview(null);clearReview();}}>Fechar revisão</Button>}>
      <p>Cliente candidato: <strong>{review.vehicle.customerName}</strong> · linha {review.vehicle.sourceRow}. ID: {review.vehicle.customerId}.</p><Notice>Confirme a propriedade com o responsável. Categoria e modelo não foram comprovados pelo acervo e começam sem preenchimento. O cadastro de um veículo não inicia a operação diária nem cria OS ou recebimentos.</Notice>
      <div className="form-grid"><Picker label="Categoria confirmada" value={review.category||null} onChange={value=>updateReview({category:String(value||'')})} isRequired isDisabled={busy} styles={fullWidth}>{categories.map(([id,name])=><PickerItem key={id} id={id}>{name}</PickerItem>)}</Picker><TextField label="Modelo confirmado" value={review.model} onChange={model=>updateReview({model})} isRequired maxLength={100} isDisabled={busy} styles={fullWidth}/><TextField label="Cor confirmada (opcional)" value={review.color} onChange={color=>updateReview({color})} maxLength={60} isDisabled={busy} styles={fullWidth}/></div>
      <ErrorNotice message={vehiclePreview.error||vehicleCommit.error}/>
      <div className="source-review-actions"><Button variant="secondary" isDisabled={!reviewValid||busy} isPending={vehiclePreview.pending} onPress={async()=>{clearReview();const result=await vehiclePreview.mutate<Report>(BASE+'/preview',source);if(result)setReviewed(result);}}>Conferir este veículo</Button>
      {reviewed&&<><p>Será criado somente o cadastro revisado de <strong>{review.vehicle.plate}</strong>, para {review.vehicle.customerName}, com categoria {categories.find(([id])=>id===review.category)?.[1]} e modelo {review.model}. As propostas históricas continuam documentais.</p><Checkbox isSelected={reviewConfirmed} onChange={setReviewConfirmed} isDisabled={busy||!reviewed.canCommit}>Confirmei o proprietário, a categoria e o modelo deste veículo.</Checkbox><Button variant="accent" isDisabled={!reviewConfirmed||!reviewed.canCommit||!reviewed.previewHash||!reviewValid||busy} isPending={vehicleCommit.pending} onPress={async()=>{const result=await vehicleCommit.mutate<Report>(BASE+'/commit',{...source,previewHash:reviewed.previewHash});if(result){setSuccess(`Cadastro revisado de ${review.vehicle.plate} preservado. A operação diária permanece no modo já definido.`);setReview(null);clearReview();setPreview(null);setConfirmed(false);refresh();}}}>Confirmar cadastro deste veículo</Button></>}
      </div>
    </Modal>}
  </div>;
}
function ReconciliationCounts({counts}:{counts:Counts}){
  return <dl className="source-review-summary"><div><dt>Placas elegíveis para revisão</dt><dd>{counts.vehicles.eligible}</dd></div><div><dt>Cadastros de veículos revisados</dt><dd>{counts.vehicles.promoted}</dd></div><div><dt>Grupos de placas conflitantes</dt><dd>{counts.vehicles.conflictGroups}</dd></div><div><dt>Linhas com veículos ambíguos</dt><dd>{counts.vehicles.ambiguousCustomerRows}</dd></div><div><dt>Linhas históricas preservadas</dt><dd>{counts.history.rows}</dd></div><div><dt>Propostas históricas documentais</dt><dd>{counts.history.proposal}</dd></div></dl>;
}
