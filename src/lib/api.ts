import {useCallback, useEffect, useRef, useState} from 'react';
import type {Session as ApiSession} from '../../sdk/src/models';

export type RecordData = {id: string; [key: string]: unknown};
export type User = {id: string; name: string; email: string; role: 'admin' | 'manager' | 'operator' | 'viewer'; active: boolean};
export type Session = ApiSession;
export type StorageMode = Session['storageMode'];
export type PageInfo = {limit:number;offset:number;total:number;hasMore:boolean};
export type ListData = {items:RecordData[];page:PageInfo};
export const BUSINESS_TIMEZONE = 'America/Sao_Paulo';
let csrfToken = '';
let sessionRevision = 0;
export function setSession(session: Session) {csrfToken = session.csrfToken || '';sessionRevision++;}

export class ApiError extends Error {
  status: number;
  code: string;
  details?: Record<string, string>;
  constructor(message: string, status = 0, code = 'NETWORK_ERROR', details?: Record<string, string>) {
    super(message); this.name = 'ApiError'; this.status = status; this.code = code; this.details = details;
  }
}

export type RequestOptions = {method?: string; body?: unknown; key?: string; signal?: AbortSignal; setupToken?: string};
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const requestSessionRevision = sessionRevision;
  let response: Response;
  const method = options.method || 'GET';
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(method !== 'GET' ? {'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken} : {}),
        ...(options.key ? {'Idempotency-Key': options.key} : {}),
        ...(options.setupToken ? {'X-Setup-Token': options.setupToken} : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('Não foi possível comunicar com o servidor. Confira sua conexão e tente novamente.');
  }
  let result: {ok?: boolean; data?: T; error?: {message?: string; code?: string; details?: Record<string, string>}};
  try {result = await response.json();} catch {throw new ApiError('O servidor retornou uma resposta inesperada. Tente atualizar a página.', response.status);}
  if (!response.ok || !result.ok) {
    if (response.status === 401 && !path.startsWith('/auth/login') && requestSessionRevision === sessionRevision) window.dispatchEvent(new Event('ab-uash-session-expired'));
    throw new ApiError(result.error?.message || 'Não foi possível concluir a operação.', response.status, result.error?.code, result.error?.details);
  }
  return result.data as T;
}

/** Reuse the same key after network failure until the exact payload succeeds. */
export function useMutation() {
  const attempt = useRef<{signature: string; key: string} | null>(null);
  const inFlight=useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function mutate<T>(path: string, body: unknown, method = 'POST', options: Pick<RequestOptions, 'setupToken'> = {}): Promise<T | null> {
    if (inFlight.current) return null;
    inFlight.current=true;
    const signature = JSON.stringify([method, path, body]);
    if (attempt.current?.signature !== signature) attempt.current = {signature, key: crypto.randomUUID()};
    setPending(true); setError(null);
    try {
      const result = await request<T>(path, {method, body, key: attempt.current.key, ...options});
      attempt.current = null;
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível salvar.');
      return null;
    } finally {inFlight.current=false;setPending(false);}
  }
  return {mutate, pending, error, setError};
}

export function useResource<T>(path: string | null) {
  const lastPath=useRef<string|null>(null);
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(n => n + 1), []);
  useEffect(() => {
    if(lastPath.current!==path){setData(null);lastPath.current=path;}
    if (!path) {setData(null); setError(null); setFailure(null); setLoading(false); return;}
    const controller = new AbortController();
    setLoading(true); setError(null); setFailure(null);
    request<T>(path, {signal: controller.signal}).then(value => {if(controller.signal.aborted)return;setData(value); setLoading(false);}).catch(cause => {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : 'Falha ao carregar dados.'); setFailure(cause instanceof ApiError ? cause : null); setLoading(false);
    });
    return () => controller.abort();
  }, [path, revision]);
  const pathChanged=lastPath.current!==path;
  return {data:pathChanged?null:data, loading:pathChanged?Boolean(path):loading, error:pathChanged?null:error, failure:pathChanged?null:failure, refresh};
}

export function useDebounced(value:string, delay=250) {const [result,setResult]=useState(value);useEffect(()=>{const timer=setTimeout(()=>setResult(value),delay);return()=>clearTimeout(timer);},[value,delay]);return result;}
export function usePagedResource<T extends {items:RecordData[];page?:PageInfo}=ListData>(base:string|null,limit=25) {
  const [pagination,setPagination]=useState({base,offset:0});
  // Resolve a new filter's first page during render, before any request starts.
  const offset=pagination.base===base?pagination.offset:0;
  useEffect(()=>setPagination(previous=>previous.base===base?previous:{base,offset:0}),[base]);
  const setOffset=useCallback((next:number)=>setPagination({base,offset:Math.max(0,next)}),[base]);
  const resource=useResource<T>(base?`${base}${base.includes('?')?'&':'?'}limit=${limit}&offset=${offset}`:null);
  const page=resource.data?.page;
  useEffect(()=>{
    if(!resource.loading&&!resource.error&&page&&offset>0&&offset>=page.total){
      setOffset(Math.max(0,Math.floor((page.total-1)/limit)*limit));
    }
  },[resource.loading,resource.error,page?.total,offset,limit,setOffset]);
  return {...resource,offset,setOffset,limit,page:resource.data?.page};
}

const businessPartsFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:BUSINESS_TIMEZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const moneyFormatter=new Intl.NumberFormat('pt-BR', {style: 'currency', currency: 'BRL'});
const businessDateTimeFormatter=new Intl.DateTimeFormat('pt-BR',{timeZone:BUSINESS_TIMEZONE,day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
const businessDateFormatter=new Intl.DateTimeFormat('pt-BR',{timeZone:BUSINESS_TIMEZONE});
function dateParts(date:Date) {return Object.fromEntries(businessPartsFormatter.formatToParts(date).map(part=>[part.type,part.value]));}
export function businessDateTimeInput(value:unknown) {if(!value)return '';const p=dateParts(new Date(String(value)));return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;}
export function businessDateTimeIso(value:unknown) {
  if(!value)return null;
  const match=String(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if(!match)throw new Error('Informe data e horário válidos.');
  const target=Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3]),Number(match[4]),Number(match[5]));
  let instant=target;
  for(let i=0;i<3;i++){const p=dateParts(new Date(instant));const current=Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day),Number(p.hour),Number(p.minute));instant+=target-current;}
  return new Date(instant).toISOString();
}

export const money = (value: unknown) => {
  if(typeof value!=='number'&&typeof value!=='string'||typeof value==='string'&&!value.trim())return '—';
  const cents=Number(value);
  return Number.isFinite(cents)?moneyFormatter.format(cents/100):'—';
};
export const dateTime = (value: unknown) => value ? businessDateTimeFormatter.format(new Date(String(value))) : '—';
export const dateOnly = (value: unknown) => value ? (/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? String(value).split('-').reverse().join('/') : businessDateFormatter.format(new Date(String(value)))) : '—';
export const textValue = (value: unknown) => value === undefined || value === null || value === '' ? '—' : String(value);
export const today = () => {const p=dateParts(new Date());return `${p.year}-${p.month}-${p.day}`;};
export const navigate = (path: string) => {window.location.hash = `/${path}`;};
export function useRoute() {
  const [route, setRoute] = useState(() => window.location.hash.replace(/^#\/?/, '') || 'dashboard');
  useEffect(() => {const handler = () => setRoute(window.location.hash.replace(/^#\/?/, '') || 'dashboard'); window.addEventListener('hashchange', handler); return () => window.removeEventListener('hashchange', handler);}, []);
  return route;
}
