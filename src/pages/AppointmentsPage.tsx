import {useState} from 'react';
import {Button} from '@react-spectrum/s2/Button';
import {SearchField} from '@react-spectrum/s2/SearchField';
import {DataTable, EmptyState, ErrorNotice, Loading, PageHeader, StatusPill, Pagination} from '../components/ui';
import {ActionDialog} from '../components/FormFields';
import {type RecordData,type User,usePagedResource,useDebounced,dateTime,navigate} from '../lib/api';
import {appointmentStatuses,statusTone} from '../lib/domain';
import {OrderEditor} from './OrderEditor';

export function AppointmentsPage({user}:{user:User}) {
  const [query,setQuery]=useState('');
  const resource=usePagedResource(`/appointments?q=${encodeURIComponent(useDebounced(query))}`);
  const [editing,setEditing]=useState<RecordData|'new'|null>(null);
  const [convert,setConvert]=useState<RecordData|null>(null);
  const items=resource.data?.items||[];
  return <><PageHeader eyebrow="OPERAÇÃO" title="Agenda" description="Organize os horários e transforme a chegada do cliente em uma ordem de serviço."><Button variant="secondary" onPress={resource.refresh}>Atualizar</Button>{user.role!=='viewer'&&<Button variant="accent" onPress={()=>setEditing('new')}>Novo agendamento</Button>}</PageHeader><ErrorNotice message={resource.error} retry={resource.refresh}/>{resource.loading&&!resource.data?<Loading/>:<section className="panel"><div className="list-toolbar"><SearchField label="Buscar agendamento" value={query} onChange={setQuery} placeholder="Cliente ou placa"/><span className="result-count">{items.length} agendamentos</span></div>{items.length?<DataTable items={items} label="Agendamentos" columns={[{key:'startsAt',label:'Início',render:r=>dateTime(r.startsAt)},{key:'endsAt',label:'Fim previsto',render:r=>dateTime(r.endsAt)},{key:'customerName',label:'Cliente'},{key:'vehiclePlate',label:'Veículo'},{key:'status',label:'Situação',render:r=><StatusPill tone={statusTone(r.status)}>{appointmentStatuses[String(r.status)]}</StatusPill>}]} actions={r=>r.status==='converted'?<Button variant="secondary" size="S" onPress={()=>navigate(`orders/${r.orderId}`)}>Abrir OS</Button>:user.role!=='viewer'&&r.status!=='cancelled'?<><Button variant="secondary" size="S" onPress={()=>setEditing(r)}>Editar</Button>{r.status!=='cancelled'&&<Button variant="accent" size="S" fillStyle="outline" onPress={()=>setConvert(r)}>Abrir atendimento</Button>}</>:null}/>:!resource.error&&<EmptyState icon="calendar" title="Uma agenda com espaço para crescer" description="Seus próximos atendimentos aparecerão aqui. Reserve um horário para o primeiro cliente." action={user.role!=='viewer'?<Button variant="accent" onPress={()=>setEditing('new')}>Agendar atendimento</Button>:undefined}/>}</section>}<Pagination page={resource.page} loading={resource.loading} onOffset={resource.setOffset}/>{editing&&<OrderEditor appointment item={editing==='new'?undefined:editing} onClose={()=>setEditing(null)} onSaved={()=>{setEditing(null);resource.refresh();}}/>}{convert&&<ActionDialog title="Abrir atendimento" path={`/appointments/${convert.id}/convert`} base={{version:convert.version}} fields={[]} note="Uma ordem de serviço será criada com os serviços e o cliente deste agendamento." submit="Criar ordem de serviço" onClose={()=>setConvert(null)} onSaved={({item})=>navigate(`orders/${item.id}`)}/>}</>;
}
