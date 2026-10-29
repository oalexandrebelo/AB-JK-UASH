import {useEffect,useState} from 'react';
import {Button} from '@react-spectrum/s2/Button';
import {NumberField} from '@react-spectrum/s2/NumberField';
import {Form} from '@react-spectrum/s2/Form';
import {Fields, initialValues, serializeValues, type Field} from '../components/FormFields';
import {ErrorNotice, Modal, Notice} from '../components/ui';
import {money, request, useMutation, type RecordData} from '../lib/api';
import {orderStatuses, appointmentStatuses, records} from '../lib/domain';
import {RemotePicker} from '../components/RemotePicker';

export function OrderEditor({item, appointment = false, onClose, onSaved}: {item?: RecordData; appointment?: boolean; onClose: () => void; onSaved: (item: RecordData) => void}) {
  const fields: Field[] = [
    {key:'customerId',label:'Cliente',relation:'customers',required:true},
    {key:'vehicleId',label:'Veículo',relation:'vehicles',required:true},
    {key:'employeeId',label:'Responsável',relation:'employees'},
    {key:'status',label:'Situação inicial',type:'select',default:appointment ? 'scheduled' : 'waiting',options:(appointment ? ['scheduled','confirmed','arrived','cancelled'] : ['quote','scheduled','waiting']).map(id => ({id,label:(appointment ? appointmentStatuses : orderStatuses)[id]}))},
    ...(appointment ? [{key:'startsAt',label:'Início',type:'datetime' as const,required:true},{key:'endsAt',label:'Fim previsto',type:'datetime' as const,description:'Se vazio, calculado pela duração dos serviços.'}] : [{key:'scheduledAt',label:'Agendamento',type:'datetime' as const},{key:'promisedAt',label:'Entrega prevista',type:'datetime' as const},{key:'discountCents',label:'Desconto total',type:'money' as const}]),
    {key:'notes',label:'Observações do atendimento',type:'textarea'},
  ];
  const [values, setValues] = useState(() => initialValues(fields,item));
  const [lines, setLines] = useState<{serviceId:string;quantity:number}[]>(() => records(item?.items).map(line => ({serviceId:String(line.serviceId),quantity:Number(line.quantity)})));
  const [serviceId, setServiceId] = useState('');
  const [catalog,setCatalog]=useState<Record<string,RecordData>>(()=>Object.fromEntries(records(item?.items).map(line=>[String(line.serviceId),{...line,id:String(line.serviceId),priceCents:line.unitPriceCents??line.priceCents??0}])));
  const [serviceLoading,setServiceLoading]=useState(Boolean(appointment&&item));
  const [serviceError,setServiceError]=useState<string|null>(null);
  const [serviceRevision,setServiceRevision]=useState(0);
  useEffect(()=>{
    if(!appointment||!item)return;
    const controller=new AbortController();
    const ids=[...new Set(records(item.items).map(line=>String(line.serviceId)))];
    setServiceLoading(true);setServiceError(null);
    async function loadServices(){
      const loaded:Record<string,RecordData>={};
      for(let offset=0;offset<ids.length;offset+=4){
        const chunk=await Promise.all(ids.slice(offset,offset+4).map(id=>request<{item:RecordData}>(`/services/${encodeURIComponent(id)}`,{signal:controller.signal})));
        for(const response of chunk)loaded[response.item.id]=response.item;
      }
      if(!controller.signal.aborted){setCatalog(old=>({...loaded,...Object.fromEntries(Object.entries(old).filter(([id])=>!ids.includes(id)))}));setServiceLoading(false);}
    }
    loadServices().catch(cause=>{if(!controller.signal.aborted){setServiceError(cause instanceof Error?cause.message:'Não foi possível carregar os serviços da agenda.');setServiceLoading(false);}});
    return()=>controller.abort();
  },[appointment,item?.id,serviceRevision]);
  const {mutate, pending, error, setError} = useMutation();
  const total = lines.reduce((sum,line) => sum + Number(catalog[line.serviceId]?.priceCents || 0) * line.quantity,0);
  const formFields=fields.map(field=>field.key==='vehicleId'?{...field,relationFilters:{customerId:String(values.customerId)}}:field);
  return <Modal wide title={`${item ? 'Editar' : 'Nova'} ${appointment ? 'reserva na agenda' : 'ordem de serviço'}`} onClose={onClose} isPending={pending}><Form isDisabled={pending} onSubmit={async event => {
    event.preventDefault();
    if(!lines.length) {setError('Adicione pelo menos um serviço ao atendimento.'); return;}
    if(serviceLoading||serviceError)return;
    const body:Record<string,unknown> = {...serializeValues(fields,values),employeeId:values.employeeId && values.employeeId !== 'none' ? values.employeeId : null,items:lines,...(item ? {version:item.version} : {})};
    if (appointment && !body.endsAt) delete body.endsAt;
    if(item&&!appointment&&JSON.stringify(lines)===JSON.stringify(records(item.items).map(line=>({serviceId:String(line.serviceId),quantity:Number(line.quantity)}))))delete body.items;
    const response = await mutate<{item:RecordData}>(`/${appointment ? 'appointments' : 'orders'}${item ? `/${item.id}` : ''}`,body,item ? 'PATCH' : 'POST');
    if(response) onSaved(response.item);
  }}><ErrorNotice message={error}/><ErrorNotice message={serviceError} retry={()=>setServiceRevision(value=>value+1)}/><Notice>Os horários seguem o fuso de São Paulo. Cadastros podem ser localizados digitando no campo de busca.</Notice><Fields isDisabled={pending} fields={formFields} values={values} onChange={(key,value) => setValues(old => ({...old,[key]:value,...(key === 'customerId' ? {vehicleId:''} : {})}))}/><div className="form-subheading"><h3>Serviços do atendimento</h3><span>Novos itens usam preços atuais</span></div><div className="service-add-row"><RemotePicker collection="services" label="Adicionar serviço" isDisabled={pending} value={serviceId} onChange={setServiceId} onItem={service=>setCatalog(old=>({...old,[service.id]:service}))} match={service=>!lines.some(line=>line.serviceId===service.id)}/><Button variant="secondary" isDisabled={pending||!serviceId} onPress={() => {setLines(old => [...old,{serviceId,quantity:1}]);setServiceId('');}}>Adicionar</Button></div>{lines.map(line => {const service = catalog[line.serviceId]; return <div className="service-line" key={line.serviceId}><div><strong>{String(service?.name || 'Serviço')}</strong><small>{money(service?.priceCents)} por unidade</small></div><NumberField label="Quantidade" aria-label={`Quantidade de ${service?.name}`} value={line.quantity} minValue={1} maxValue={1000} onChange={quantity => setLines(old => old.map(current => current.serviceId === line.serviceId ? {...current,quantity} : current))}/><strong>{money(Number(service?.priceCents || 0)*line.quantity)}</strong><Button variant="secondary" size="S" onPress={() => setLines(old => old.filter(current => current.serviceId !== line.serviceId))}>Remover</Button></div>;})}<div className="form-total"><span>{appointment ? 'Valor dos serviços' : 'Total estimado'}</span><strong>{serviceLoading?'Carregando…':serviceError?'Indisponível':money(Math.max(0,total - (appointment ? 0 : Math.round(Number(values.discountCents)*100))))}</strong></div><div className="modal-actions"><Button variant="secondary" isDisabled={pending} onPress={onClose}>Cancelar</Button><Button type="submit" variant="accent" isPending={pending} isDisabled={serviceLoading||Boolean(serviceError)}>{item ? 'Salvar alterações' : appointment ? 'Salvar agendamento' : 'Criar ordem'}</Button></div></Form></Modal>;
}
