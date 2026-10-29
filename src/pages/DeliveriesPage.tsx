import {useState} from 'react';
import {Button} from '@react-spectrum/s2/Button';
import {Form} from '@react-spectrum/s2/Form';
import {SearchField} from '@react-spectrum/s2/SearchField';
import {Picker,PickerItem} from '@react-spectrum/s2/Picker';
import {ComboBox,ComboBoxItem} from '@react-spectrum/s2/ComboBox';
import {ActionDialog,Fields,initialValues,serializeValues,type Field} from '../components/FormFields';
import {DataTable,EmptyState,ErrorNotice,Loading,Modal,Notice,PageHeader,Pagination,StatusPill,fullWidth} from '../components/ui';
import {dateTime,navigate,useDebounced,useMutation,usePagedResource,useResource,type ListData,type RecordData,type User} from '../lib/api';

type DeliveryStatus='scheduled'|'en_route'|'completed'|'cancelled'|'failed';
type DeliveryAddress={street:string;number:string;neighborhood:string;city:string;state:string;postalCode:string;complement:string;reference:string};
type DeliveryEvent={id:string;action:string;actorName:string;createdAt:string;reason:string;snapshot:{startsAt:string;endsAt:string;address:DeliveryAddress;receivedBy:string}};
type Delivery=RecordData & {kind:'pickup'|'return';status:DeliveryStatus;version:number;sourceVersion:number;orderVersion:number|null;address:DeliveryAddress;events:DeliveryEvent[];sourceChanged:boolean;linkedOrderId:string|null};
const statusLabels:Record<DeliveryStatus,string>={scheduled:'Agendada',en_route:'Em deslocamento',completed:'Concluída',cancelled:'Cancelada',failed:'Sem sucesso'};
const kindLabels={pickup:'Retirada',return:'Devolução'};
const eventLabels:Record<string,string>={created:'Tarefa criada',updated:'Tarefa reagendada ou alterada',en_route:'Deslocamento iniciado',completed:'Tarefa concluída',cancelled:'Tarefa cancelada',failed:'Tentativa sem sucesso'};
const tone=(status:DeliveryStatus)=>status==='completed'?'green':status==='en_route'?'blue':status==='failed'?'red':status==='scheduled'?'orange':'neutral';
const addressText=(address:DeliveryAddress)=>`${address.street}, ${address.number}${address.complement?` · ${address.complement}`:''} · ${address.neighborhood} · ${address.city}/${address.state}${address.postalCode?` · CEP ${address.postalCode}`:''}`;
const addressKeys=['street','number','neighborhood','city','state','postalCode','complement','reference'] as const;
const fields:Field[]=[
  {key:'employeeId',label:'Responsável pelo transporte',relation:'employees',required:true},
  {key:'startsAt',label:'Início da janela',type:'datetime',required:true},
  {key:'endsAt',label:'Fim da janela',type:'datetime',required:true},
  {key:'street',label:'Logradouro',required:true},
  {key:'number',label:'Número',required:true,description:'Use s/n quando o endereço não tiver número.'},
  {key:'neighborhood',label:'Bairro',required:true},
  {key:'city',label:'Cidade',required:true},
  {key:'state',label:'UF',type:'select',required:true,options:'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ').map(id=>({id,label:id}))},
  {key:'postalCode',label:'CEP',description:'Opcional, com oito dígitos.'},
  {key:'complement',label:'Complemento'},
  {key:'reference',label:'Ponto de referência',type:'textarea'},
  {key:'notes',label:'Observações do transporte',type:'textarea'},
];

function SourcePicker({type,onChange,isDisabled}:{type:'appointment'|'order';onChange:(value:RecordData|null)=>void;isDisabled:boolean}) {
  const [search,setSearch]=useState('');
  const [selected,setSelected]=useState<RecordData|null>(null);
  const query=useDebounced(search);
  const resource=useResource<ListData>(`/${type==='appointment'?'appointments':'orders'}?limit=50&q=${encodeURIComponent(query)}`);
  const options=(resource.data?.items||[]).filter(item=>!['quote','cancelled'].includes(String(item.status)));
  if(selected&&!options.some(item=>item.id===selected.id))options.unshift(selected);
  const label=(item:RecordData)=>`${type==='order'?`OS ${item.number} · `:''}${item.customerName} · ${item.vehiclePlate}${type==='appointment'?` · ${dateTime(item.startsAt)}`:''}`;
  return <><ComboBox label={type==='appointment'?'Agendamento vinculado':'OS vinculada'} selectedKey={selected?.id||null} onSelectionChange={key=>{const item=options.find(item=>item.id===key)||null;setSelected(item);onChange(item);}} onInputChange={setSearch} items={options} loadingState={resource.loading?'loading':'idle'} isRequired isDisabled={isDisabled} styles={fullWidth} placeholder="Busque por cliente ou placa" description={resource.data?.page.hasMore?'Digite mais detalhes para refinar os primeiros 50 registros.':'Cliente e veículo serão preservados a partir do atendimento selecionado.'}>{item=><ComboBoxItem id={item.id} textValue={label(item)}>{label(item)}</ComboBoxItem>}</ComboBox><ErrorNotice message={resource.error} retry={resource.refresh}/></>;
}

function DeliveryEditor({item,onClose,onSaved}:{item?:Delivery;onClose:()=>void;onSaved:()=>void}) {
  const [sourceType,setSourceType]=useState<'appointment'|'order'>('appointment');
  const [source,setSource]=useState<RecordData|null>(null);
  const [kind,setKind]=useState<'pickup'|'return'>(item?.kind||'pickup');
  const [values,setValues]=useState(()=>initialValues(fields,item?{...item,...item.address}:undefined));
  const mutation=useMutation();
  return <Modal title={item?'Reagendar transporte':'Nova retirada ou devolução'} onClose={onClose} isPending={mutation.pending} wide><Form isDisabled={mutation.pending} onSubmit={async event=>{
    event.preventDefault();
    if(!item&&!source){mutation.setError('Selecione o agendamento ou a OS.');return;}
    try {
      const data=serializeValues(fields,values);
      const address=Object.fromEntries(addressKeys.map(key=>[key,data[key]]));
      const body={employeeId:data.employeeId,startsAt:data.startsAt,endsAt:data.endsAt,address,notes:data.notes,...(item?{version:item.version}:{[`${sourceType}Id`]:source!.id,sourceVersion:source!.version,kind})};
      const result=await mutation.mutate(`/jk/deliveries${item?`/${item.id}`:''}`,body,item?'PATCH':'POST');
      if(result)onSaved();
    }catch(error){mutation.setError(error instanceof Error?error.message:'Confira a janela de horário.');}
  }}>
    <ErrorNotice message={mutation.error}/>
    {item?<Notice>{kindLabels[item.kind]} de {String(item.customerName)} · {String(item.vehiclePlate)}</Notice>:<div className="form-grid"><Picker label="Vincular a" value={sourceType} onChange={key=>{setSourceType(key==='order'?'order':'appointment');setSource(null);}} isDisabled={mutation.pending} styles={fullWidth}><PickerItem id="appointment">Agendamento</PickerItem><PickerItem id="order">Ordem de serviço</PickerItem></Picker><Picker label="Tipo de transporte" value={kind} onChange={key=>setKind(key==='return'?'return':'pickup')} isDisabled={mutation.pending} styles={fullWidth}><PickerItem id="pickup">Retirada do veículo</PickerItem><PickerItem id="return">Devolução ao cliente</PickerItem></Picker><div className="form-field full"><SourcePicker key={sourceType} type={sourceType} onChange={setSource} isDisabled={mutation.pending}/></div></div>}
    <Fields fields={fields} values={values} onChange={(key,value)=>setValues(previous=>({...previous,[key]:value}))} isDisabled={mutation.pending}/>
    <div className="modal-actions"><Button variant="secondary" onPress={onClose} isDisabled={mutation.pending}>Cancelar</Button><Button variant="accent" type="submit" isPending={mutation.pending}>{item?'Salvar reagendamento':'Agendar transporte'}</Button></div>
  </Form></Modal>;
}

function DeliveryDetails({id,onClose,onEdit,onAction}:{id:string;onClose:()=>void;onEdit:(item:Delivery)=>void;onAction:(item:Delivery,status:DeliveryStatus)=>void}) {
  const resource=useResource<{item:Delivery}>(`/jk/deliveries/${id}`);
  const item=resource.data?.item;
  return <Modal title="Detalhes do transporte" onClose={onClose} wide><ErrorNotice message={resource.error} retry={resource.refresh}/>{!item?<Loading/>:<>
    <div className="panel-heading"><h2>{kindLabels[item.kind]} · {String(item.vehiclePlate)}</h2><StatusPill tone={tone(item.status)}>{statusLabels[item.status]}</StatusPill></div>
    <dl className="detail-grid"><div><dt>Cliente</dt><dd>{String(item.customerName)}</dd></div><div><dt>Responsável</dt><dd>{String(item.employeeName)}</dd></div><div><dt>Janela prevista</dt><dd>{dateTime(item.startsAt)} — {dateTime(item.endsAt)}</dd></div><div><dt>Endereço</dt><dd>{addressText(item.address)}</dd></div>{item.address.reference&&<div><dt>Ponto de referência</dt><dd>{item.address.reference}</dd></div>}{Boolean(item.notes)&&<div><dt>Observações</dt><dd>{String(item.notes)}</dd></div>}{Boolean(item.receivedBy)&&<div><dt>Recebido por</dt><dd>{String(item.receivedBy)} · {dateTime(item.completedAt)}</dd></div>}</dl>
    {item.sourceChanged&&<Notice>O cliente ou veículo do atendimento foi alterado. Cancele esta tarefa e crie outra com os dados atuais.</Notice>}
    {item.kind==='return'&&!['ready','delivered'].includes(String(item.orderStatus))&&!['completed','cancelled','failed'].includes(item.status)&&<Notice>A devolução poderá sair quando a OS estiver pronta para entrega e estiver quitada ou vinculada a cliente pós-pago.</Notice>}
    <div className="modal-actions">{item.linkedOrderId&&<Button variant="secondary" onPress={()=>{onClose();navigate(`orders/${item.linkedOrderId}`);}}>Abrir OS {String(item.orderNumber)}</Button>}{item.status==='scheduled'&&<><Button variant="secondary" onPress={()=>onEdit(item)}>Reagendar</Button><Button variant="negative" fillStyle="outline" onPress={()=>onAction(item,'cancelled')}>Cancelar tarefa</Button><Button variant="accent" onPress={()=>onAction(item,'en_route')}>Iniciar deslocamento</Button></>}{item.status==='en_route'&&<><Button variant="negative" fillStyle="outline" onPress={()=>onAction(item,'failed')}>Registrar tentativa sem sucesso</Button><Button variant="accent" onPress={()=>onAction(item,'completed')}>{item.kind==='pickup'?'Concluir retirada':'Concluir devolução'}</Button></>}</div>
    <h3>Histórico da tarefa</h3><ol>{item.events.map(event=><li key={event.id}><p><strong>{eventLabels[event.action]||event.action}</strong> · {event.actorName} · {dateTime(event.createdAt)}</p>{event.reason&&<p>{event.reason}</p>}{event.action==='updated'&&<p>Janela: {dateTime(event.snapshot.startsAt)} — {dateTime(event.snapshot.endsAt)}. {addressText(event.snapshot.address)}</p>}{event.snapshot.receivedBy&&<p>Recebido por {event.snapshot.receivedBy}.</p>}</li>)}</ol>
  </>}</Modal>;
}

export function DeliveriesPage({user}:{user:User}) {
  const [query,setQuery]=useState('');
  const [status,setStatus]=useState('all');
  const [kind,setKind]=useState('all');
  const [editing,setEditing]=useState<Delivery|'new'|null>(null);
  const [selected,setSelected]=useState<string|null>(null);
  const [action,setAction]=useState<{item:Delivery;status:DeliveryStatus}|null>(null);
  const params=new URLSearchParams({q:useDebounced(query),...(status==='all'?{}:{status}),...(kind==='all'?{}:{kind})});
  const resource=usePagedResource(user.role==='viewer'?null:`/jk/deliveries?${params}`);
  const items=resource.data?.items||[];
  if(user.role==='viewer')return <EmptyState icon="shield" title="Acesso à operação" description="A agenda de transportes está disponível para administradores, gestores e operadores."/>;
  return <><PageHeader eyebrow="OPERAÇÃO" title="Retiradas e devoluções" description="Reserve o transporte do veículo, acompanhe o responsável e registre cada entrega."><Button variant="secondary" onPress={resource.refresh}>Atualizar</Button><Button variant="accent" onPress={()=>setEditing('new')}>Novo transporte</Button></PageHeader>
    <ErrorNotice message={resource.error} retry={resource.refresh}/><section className="panel"><div className="list-toolbar"><SearchField label="Buscar transporte" value={query} onChange={setQuery} placeholder="Cliente, placa ou responsável"/><Picker label="Situação" value={status} onChange={key=>setStatus(String(key))}><PickerItem id="all">Todas</PickerItem>{Object.entries(statusLabels).map(([id,label])=><PickerItem id={id} key={id}>{label}</PickerItem>)}</Picker><Picker label="Tipo" value={kind} onChange={key=>setKind(String(key))}><PickerItem id="all">Todos</PickerItem><PickerItem id="pickup">Retiradas</PickerItem><PickerItem id="return">Devoluções</PickerItem></Picker></div>
      {resource.loading&&!resource.data?<Loading/>:items.length?<DataTable items={items} label="Retiradas e devoluções" columns={[{key:'startsAt',label:'Janela',render:row=><>{dateTime(row.startsAt)}<br/><small>até {dateTime(row.endsAt)}</small></>},{key:'kind',label:'Tarefa',render:row=>kindLabels[row.kind as keyof typeof kindLabels]},{key:'customerName',label:'Cliente / veículo',render:row=><>{String(row.customerName)}<br/><small>{String(row.vehiclePlate)}</small></>},{key:'employeeName',label:'Responsável'},{key:'status',label:'Situação',render:row=><StatusPill tone={tone(row.status as DeliveryStatus)}>{statusLabels[row.status as DeliveryStatus]}</StatusPill>}]} actions={row=><Button size="S" variant="secondary" onPress={()=>setSelected(row.id)}>Detalhes</Button>}/>:!resource.error&&<EmptyState icon="vehicles" title="Nenhum transporte neste filtro" description="Agende uma retirada ou devolução vinculada ao atendimento e indique quem fará o transporte." action={<Button variant="accent" onPress={()=>setEditing('new')}>Agendar transporte</Button>}/>}
    </section><Pagination page={resource.page} loading={resource.loading} onOffset={resource.setOffset}/>
    {editing&&<DeliveryEditor item={editing==='new'?undefined:editing} onClose={()=>setEditing(null)} onSaved={()=>{setEditing(null);resource.refresh();}}/>}
    {selected&&!editing&&!action&&<DeliveryDetails id={selected} onClose={()=>setSelected(null)} onEdit={item=>{setSelected(null);setEditing(item);}} onAction={(item,status)=>{setSelected(null);setAction({item,status});}}/>}
    {action&&<ActionDialog title={action.status==='en_route'?'Iniciar deslocamento':action.status==='completed'?`Concluir ${action.item.kind==='pickup'?'retirada':'devolução'}`:action.status==='cancelled'?'Cancelar tarefa':'Registrar tentativa sem sucesso'} path={`/jk/deliveries/${action.item.id}/status`} base={{version:action.item.version,status:action.status,sourceVersion:action.item.sourceVersion,...(action.item.orderVersion?{orderVersion:action.item.orderVersion}:{})}} fields={action.status==='completed'?[{key:'receivedBy',label:'Nome de quem recebeu o veículo',required:true},{key:'reason',label:'Observações da conclusão',type:'textarea'}]:['cancelled','failed'].includes(action.status)?[{key:'reason',label:'Motivo',type:'textarea',required:true}]:[]} note={action.status==='completed'?(action.item.kind==='pickup'?'Confirme que o veículo chegou ao estabelecimento. O atendimento será marcado como chegado.':'Confirme a devolução ao cliente. A OS pronta será marcada como entregue, mantendo a regra de pagamento.'):undefined} submit={action.status==='en_route'?'Confirmar saída':action.status==='completed'?'Confirmar conclusão':'Salvar motivo'} onClose={()=>{setSelected(action.item.id);setAction(null);}} onSaved={()=>{setSelected(action.item.id);setAction(null);resource.refresh();}}/>}
  </>;
}
