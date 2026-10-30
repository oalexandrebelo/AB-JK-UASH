import {useState} from 'react';
import {Button} from '@react-spectrum/s2/Button';
import {Checkbox} from '@react-spectrum/s2/Checkbox';
import {TextField} from '@react-spectrum/s2/TextField';
import {Picker,PickerItem} from '@react-spectrum/s2/Picker';
import {DataTable,ErrorNotice,Notice,Section,fullWidth} from '../../components/ui';
import {useMutation,useResource,type RecordData} from '../../lib/api';

type Member={id:string;name:string;email:string;phone:string;sourceRole:string;role:'manager'|'operator'|'viewer';createEmployee:boolean};
type Report={canCommit:boolean;previewHash:string;counts:{users:number;employees:number};users:Member[];issues:{row:number;code:string}[]};
type Status={status:string;counts:{users:number;employees:number};committedAt?:string};
const roles=[{id:'manager',label:'Gestor'},{id:'operator',label:'Operador'},{id:'viewer',label:'Consulta'}];
const member=():Member=>({id:crypto.randomUUID(),name:'',email:'',phone:'',sourceRole:'',role:'operator',createEmployee:true});
const issues:Record<string,string>={EMAIL_EXISTS:'E-mail já cadastrado',EMPLOYEE_NAME_EXISTS:'Nome de profissional já existente',EMPLOYEE_NAME_REPEATED:'Nome de profissional repetido no lote',TEAM_ALREADY_IMPORTED:'A equipe já foi preservada; confira os acessos existentes'};

export function TeamMigration(){
  const status=useResource<Status>('/jk/team/status');
  const [members,setMembers]=useState<Member[]>([member()]);
  const [preview,setPreview]=useState<Report|null>(null);
  const [confirmed,setConfirmed]=useState(false);
  const check=useMutation();const commit=useMutation();
  const busy=check.pending||commit.pending;
  const preserved=status.data?.status==='preserved_pending_activation';
  const source={source:'jumpcar-ui',establishmentId:24453,users:members.map(({id:_,...entry})=>entry)};
  function update(id:string,change:Partial<Member>){setMembers(old=>old.map(item=>item.id===id?{...item,...change}:item));setPreview(null);setConfirmed(false);}
  return <div className="migration-tab-content"><Notice>Confira cada pessoa e a permissão que terá na JK. A importação preserva as contas sem senha e sem acesso. Profissionais ficam inativos até a revisão de salário e comissão. Contas compartilhadas podem ser preservadas sem criar um profissional.</Notice>
    <ErrorNotice message={status.error} retry={status.refresh}/><ErrorNotice message={check.error}/><ErrorNotice message={commit.error}/>
    {preserved?<Section title="Equipe preservada" subtitle="Resultado da importação, sem ativação automática."><div className="migration-preview-content"><p role="status">{status.data?.counts.users} contas e {status.data?.counts.employees} profissionais preservados.</p><p>Em Configurações → Acessos, defina a primeira senha diretamente na tela. Em Equipe e comissões, confira os dados do profissional antes de ativá-lo.</p><a href="#/settings">Abrir configurações de acesso</a></div></Section>:<Section title="Equipe da unidade JK" subtitle="Use os nomes, e-mails e cargos conferidos no Jumpcar.">
      <div className="content-stack">{members.map((item,index)=><fieldset key={item.id} disabled={busy} className="panel-inset"><legend>Cadastro {index+1}</legend><div className="form-grid">
        <TextField label={`Nome do cadastro ${index+1}`} value={item.name} onChange={name=>update(item.id,{name})} isRequired minLength={2} maxLength={80} styles={fullWidth}/>
        <TextField label={`E-mail do cadastro ${index+1}`} type="email" value={item.email} onChange={email=>update(item.id,{email})} isRequired maxLength={254} styles={fullWidth}/>
        <TextField label={`Telefone do cadastro ${index+1}`} type="tel" value={item.phone} onChange={phone=>update(item.id,{phone})} maxLength={40} styles={fullWidth}/>
        <TextField label={`Cargo no Jumpcar ${index+1}`} value={item.sourceRole} onChange={sourceRole=>update(item.id,{sourceRole})} isRequired maxLength={80} styles={fullWidth}/>
        <Picker label={`Permissão na JK ${index+1}`} selectedKey={item.role} onSelectionChange={role=>update(item.id,{role:String(role) as Member['role']})} styles={fullWidth}>{roles.map(role=><PickerItem key={role.id} id={role.id}>{role.label}</PickerItem>)}</Picker>
      </div><Checkbox isSelected={item.createEmployee} onChange={createEmployee=>update(item.id,{createEmployee})}>Criar também o profissional {index+1}, inicialmente inativo</Checkbox>
      {members.length>1&&<Button variant="secondary" size="S" onPress={()=>{setMembers(old=>old.filter(row=>row.id!==item.id));setPreview(null);setConfirmed(false);}}>Remover cadastro {index+1}</Button>}</fieldset>)}</div>
      <div className="modal-actions"><Button variant="secondary" isDisabled={busy||members.length>=100} onPress={()=>{setMembers(old=>[...old,member()]);setPreview(null);setConfirmed(false);}}>Adicionar cadastro</Button><Button variant="accent" isDisabled={busy} isPending={check.pending} onPress={async()=>{setConfirmed(false);const result=await check.mutate<Report>('/jk/team/preview',source);setPreview(result||null);}}>Conferir equipe</Button></div>
      {preview&&<div className="panel-inset"><h3>Confira {preview.counts.users} contas e {preview.counts.employees} profissionais</h3><DataTable label="Prévia da equipe" items={preview.users.map((row,index)=>({...row,id:String(index)})) as RecordData[]} columns={[{key:'name',label:'Nome'},{key:'email',label:'E-mail'},{key:'sourceRole',label:'Cargo na origem'},{key:'role',label:'Permissão na JK',render:row=>roles.find(role=>role.id===row.role)?.label||String(row.role)},{key:'createEmployee',label:'Profissional',render:row=>row.createEmployee?'Será criado inativo':'Somente conta'}]}/>
      {preview.issues.length>0&&<ul>{preview.issues.map((issue,index)=><li key={index}>{issue.row>0?`Cadastro ${issue.row}: `:''}{issues[issue.code]||issue.code}</li>)}</ul>}
      <Checkbox isDisabled={!preview.canCommit||busy} isSelected={confirmed} onChange={setConfirmed}>Conferi os dados e as permissões; quero preservar a equipe sem ativar acessos ou folha.</Checkbox>
      <div className="modal-actions"><Button variant="accent" isDisabled={!preview.canCommit||!confirmed||busy} isPending={commit.pending} onPress={async()=>{const result=await commit.mutate('/jk/team/commit',{...source,previewHash:preview.previewHash});if(result){setConfirmed(false);status.refresh();}}}>Preservar equipe</Button></div></div>}
    </Section>}</div>;
}
