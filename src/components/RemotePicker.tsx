import {useState} from 'react';
import {ComboBox,ComboBoxItem} from '@react-spectrum/s2/ComboBox';
import {useResource,useDebounced,type ListData,type RecordData} from '../lib/api';
import {ErrorNotice,fullWidth} from './ui';

function labelFor(item:RecordData) {if(item.plate)return `${item.plate} · ${item.model}`;if(item.packageName)return `${item.packageName} · ${item.remainingCredits} créditos`;return String(item.name||item.number||item.id);}
export function RemotePicker({collection,label,value,onChange,required=false,description,filters={},match,onItem,isDisabled=false}:{collection:string;label:string;value:string;onChange:(value:string)=>void;required?:boolean;description?:string;filters?:Record<string,string>;match?:(row:RecordData)=>boolean;onItem?:(item:RecordData)=>void;isDisabled?:boolean}) {
  const [input,setInput]=useState('');
  const query=useDebounced(input);
  const params=new URLSearchParams({limit:'50',q:query,...(collection==='package-sales'?{}:{active:'true'}),...filters});
  const resource=useResource<ListData>(isDisabled?null:`/${collection}?${params}`);
  const selected=useResource<{item:RecordData}>(value&&!resource.data?.items.some(row=>row.id===value)?`/${collection}/${encodeURIComponent(value)}`:null);
  const options=(resource.data?.items||[]).filter(row=>row.id===value||!match||match(row));
  if(selected.data?.item&&selected.data.item.id===value&&!options.some(row=>row.id===value))options.unshift(selected.data.item);
  const helper=resource.data?.page.hasMore?`Mostrando até 50 de ${resource.data.page.total}. Digite mais detalhes para refinar a busca.`:description||'Digite para buscar no cadastro.';
  return <><ComboBox label={label} isRequired={required} selectedKey={value||null} onSelectionChange={key=>{const next=String(key||'');onChange(next);const item=options.find(row=>row.id===next);if(item&&onItem)onItem(item);}} onInputChange={setInput} items={options} loadingState={resource.loading?'loading':'idle'} description={helper} placeholder="Digite para buscar…" styles={fullWidth} isDisabled={isDisabled}>{item=><ComboBoxItem id={item.id} textValue={labelFor(item)}>{labelFor(item)}</ComboBoxItem>}</ComboBox><ErrorNotice message={resource.error||selected.error}/></>;
}
