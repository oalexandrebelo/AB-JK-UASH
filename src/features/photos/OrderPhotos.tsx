import {useEffect, useRef, useState} from 'react';
import {Button} from '@react-spectrum/s2/Button';
import {TextField} from '@react-spectrum/s2/TextField';
import {request, useMutation, useResource} from '../../lib/api';
import {inspectImageFile} from '../ocr/image';
import './photos.css';

type Photo = {id: string; caption: string; bytes: number; createdAt: string; version: number; mimeType: string; dataUri?: string};
async function preparePhoto(file: File) {
  await inspectImageFile(file);
  const bitmap = await createImageBitmap(file, {imageOrientation: 'from-image'});
  try {
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    try {
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Não foi possível preparar a foto.');
      context.fillStyle = 'white'; context.fillRect(0,0,canvas.width,canvas.height); context.drawImage(bitmap,0,0,canvas.width,canvas.height);
      const dataUri = canvas.toDataURL('image/jpeg',0.82);
      const dataBase64 = dataUri.split(',')[1];
      if (!dataBase64 || dataBase64.length > 2_097_152) throw new Error('A foto ficou acima de 1,5 MiB. Recorte ou reduza a imagem.');
      return {dataUri, dataBase64, mimeType: 'image/jpeg'};
    } finally {canvas.width=0; canvas.height=0;}
  } finally {bitmap.close();}
}

export function OrderPhotos({orderId, editable}: {orderId:string; editable:boolean}) {
  const {data,loading,error,refresh} = useResource<{items:Photo[]}>(`/orders/${orderId}/photos`);
  const mutation = useMutation();
  const [caption,setCaption] = useState('');
  const [prepared,setPrepared] = useState<Awaited<ReturnType<typeof preparePhoto>> | null>(null);
  const [selected,setSelected] = useState<Photo | null>(null);
  const [processing,setProcessing] = useState(false);
  const [localError,setLocalError] = useState('');
  const sequence = useRef(0);
  const viewSequence = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {sequence.current++; viewSequence.current++; setPrepared(null); setSelected(null); setCaption(''); setLocalError(''); setProcessing(false); return () => {sequence.current++;viewSequence.current++;};},[orderId]);
  async function choose(file?:File) {
    if (!file) return;
    const current=++sequence.current;
    setProcessing(true);setLocalError('');setPrepared(null);
    try {const image=await preparePhoto(file); if(current===sequence.current)setPrepared(image);}
    catch(cause) {if(current===sequence.current)setLocalError(cause instanceof Error?cause.message:'Falha ao preparar foto.');}
    finally {if(current===sequence.current)setProcessing(false);}
  }
  async function save() {
    if(!prepared)return;
    const result=await mutation.mutate(`/orders/${orderId}/photos`,{mimeType:prepared.mimeType,dataBase64:prepared.dataBase64,caption});
    if(result) {setPrepared(null);setCaption('');if(input.current)input.current.value='';refresh();}
  }
  async function inspect(photo:Photo) {
    const current=++viewSequence.current;setLocalError('');
    try {const result=await request<{item:Photo}>(`/order-photos/${photo.id}`);if(current===viewSequence.current)setSelected(result.item);}
    catch(cause) {if(current===viewSequence.current)setLocalError(cause instanceof Error?cause.message:'Falha ao carregar foto.');}
  }
  return <section className="order-photos" aria-label="Fotos de avarias">
    <div className="photos-heading"><div><h3>Fotos de avarias</h3><p>Até oito fotos por ordem. As imagens ficam no banco da operação.</p></div><span>{data?.items.length || 0}/8</span></div>
    {(error||localError||mutation.error)&&<p role="alert" className="notice notice-error">{error||localError||mutation.error}</p>}
    {loading&&<p role="status">Carregando fotos…</p>}
    {data?.items.length===0&&<p className="photos-empty">Nenhuma foto adicionada a esta ordem.</p>}
    <div className="photos-list">{data?.items.map((photo,index)=><Button key={photo.id} variant="secondary" onPress={()=>void inspect(photo)}>Foto {index+1}{photo.caption?` · ${photo.caption.slice(0,35)}`:''}</Button>)}</div>
    {selected?.dataUri&&<figure className="photos-preview"><img src={selected.dataUri} alt={selected.caption||'Registro de avaria do veículo'}/><figcaption>{selected.caption||'Foto sem descrição'} · {new Date(selected.createdAt).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})}</figcaption><Button variant="secondary" onPress={()=>setSelected(null)}>Fechar foto</Button></figure>}
    {editable&&(data?.items.length||0)<8&&<div className="photos-upload"><label>Selecionar foto de avaria (PNG ou JPEG, até 10 MB e 16 megapixels)<input ref={input} type="file" accept="image/png,image/jpeg" disabled={processing||mutation.pending} onChange={event=>void choose(event.target.files?.[0])}/></label>{processing&&<p role="status">Preparando imagem no computador…</p>}{prepared&&<><figure className="photos-preview"><img src={prepared.dataUri} alt="Prévia da foto selecionada"/><figcaption>Confira a foto antes de adicionar.</figcaption></figure><TextField label="Descrição da avaria ou posição no veículo" value={caption} onChange={setCaption} maxLength={500}/><div className="photos-actions"><Button variant="primary" isPending={mutation.pending} onPress={()=>void save()}>Adicionar foto à ordem</Button><Button variant="secondary" isDisabled={mutation.pending} onPress={()=>{setPrepared(null);if(input.current)input.current.value='';}}>Cancelar foto</Button></div></>}</div>}
  </section>;
}
