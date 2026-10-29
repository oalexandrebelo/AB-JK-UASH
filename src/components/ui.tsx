import type {ReactNode} from 'react';
import {Button} from '@react-spectrum/s2/Button';
import {ProgressCircle} from '@react-spectrum/s2/ProgressCircle';
import {Badge} from '@react-spectrum/s2/Badge';
import {Dialog, DialogContainer, Heading, Content, ButtonGroup} from '@react-spectrum/s2/Dialog';
import {style} from '@react-spectrum/s2/style' with {type: 'macro'};
import type {RecordData,PageInfo} from '../lib/api';

export const fullWidth = style({width: 'full'});
export function PageHeader({eyebrow, title, description, children}: {eyebrow?: string; title: string; description?: string; children?: ReactNode}) {
  return <header className="page-heading"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description && <p className="page-description">{description}</p>}</div>{children && <div className="page-actions">{children}</div>}</header>;
}
export function ErrorNotice({message, retry}: {message: string | null; retry?: () => void}) {
  if (!message) return null;
  return <div className="notice notice-error" role="alert"><span>{message}</span>{retry && <Button variant="secondary" onPress={retry}>Tentar novamente</Button>}</div>;
}
export function Notice({children}: {children: ReactNode}) {return <div className="notice notice-info">{children}</div>;}
export function Loading({label = 'Carregando informações…'}: {label?: string}) {return <div className="loading-state" role="status"><ProgressCircle aria-label={label} isIndeterminate size="S"/><span>{label}</span></div>;}
export function EmptyState({title, description, action, icon = 'spark'}: {title: string; description: string; action?: ReactNode; icon?: string}) {
  return <div className="empty-state"><div className="empty-icon"><Icon name={icon}/></div><h2>{title}</h2><p>{description}</p>{action}</div>;
}
export function Modal({title, children, onClose, footer, wide = false, isPending = false}: {title: string; children: ReactNode; onClose: () => void; footer?: ReactNode; wide?: boolean; isPending?: boolean}) {
  return <DialogContainer onDismiss={()=>{if(!isPending)onClose();}}><Dialog size={wide ? 'L' : 'M'} isDismissible={!isPending} isKeyboardDismissDisabled={isPending}><Heading>{title}</Heading><Content><div aria-busy={isPending || undefined}>{children}</div></Content>{footer && <ButtonGroup>{footer}</ButtonGroup>}</Dialog></DialogContainer>;
}
export function TabBar({id,label,items,value,onChange}: {id:string;label:string;items:readonly (readonly [string,string])[];value:string;onChange:(value:string)=>void}) {
  return <div className="tabs-row" role="tablist" aria-label={label}>{items.map(([key,title],index)=><button type="button" key={key} role="tab" id={`${id}-tab-${key}`} aria-controls={`${id}-panel`} aria-selected={value===key} tabIndex={value===key?0:-1} className={value===key?'active':''} onClick={()=>onChange(key)} onKeyDown={event=>{
    const next=event.key==='ArrowRight'?(index+1)%items.length:event.key==='ArrowLeft'?(index-1+items.length)%items.length:event.key==='Home'?0:event.key==='End'?items.length-1:null;
    if(next===null)return;
    event.preventDefault();onChange(items[next][0]);
    document.getElementById(`${id}-tab-${items[next][0]}`)?.focus();
  }}>{title}</button>)}</div>;
}
export type TableColumn = {key: string; label: string; render?: (row: RecordData) => ReactNode; align?: 'right'};
export function DataTable({items, columns, label, actions}: {items: RecordData[]; columns: TableColumn[]; label: string; actions?: (row: RecordData) => ReactNode}) {
  return <div className="table-scroll"><table className="data-table" aria-label={label}><thead><tr>{columns.map(col => <th scope="col" key={col.key} className={col.align === 'right' ? 'numeric' : undefined}>{col.label}</th>)}{actions && <th scope="col" className="actions-cell">Ações</th>}</tr></thead><tbody>{items.map(row => <tr key={row.id}>{columns.map((col, index) => {const content = col.render ? col.render(row) : String(row[col.key] ?? '—'); return index === 0 ? <th key={col.key} scope="row">{content}</th> : <td key={col.key} className={col.align === 'right' ? 'numeric' : undefined}>{content}</td>;})}{actions && <td className="actions-cell"><div className="row-actions">{actions(row)}</div></td>}</tr>)}</tbody></table></div>;
}
export function StatusPill({children, tone = 'neutral'}: {children: ReactNode; tone?: 'neutral' | 'blue' | 'green' | 'orange' | 'red'}) {
  const variants = {neutral:'neutral',blue:'informative',green:'positive',orange:'notice',red:'negative'} as const;
  return <Badge variant={variants[tone]} fillStyle="subtle" size="S">{children}</Badge>;
}
export function Pagination({page,loading,onOffset}:{page?:PageInfo;loading?:boolean;onOffset:(offset:number)=>void}) {if(!page)return null;return <div className="pagination-bar"><span>{page.total===0?'Nenhum registro':`${page.offset+1}–${Math.min(page.offset+page.limit,page.total)} de ${page.total} registros`}</span><div><Button size="S" variant="secondary" isDisabled={loading||page.offset===0} onPress={()=>onOffset(Math.max(0,page.offset-page.limit))}>Anterior</Button><Button size="S" variant="secondary" isDisabled={loading||!page.hasMore} onPress={()=>onOffset(page.offset+page.limit)}>Próxima</Button></div></div>;}
export function Section({title, subtitle, children, action}: {title: string; subtitle?: string; children: ReactNode; action?: ReactNode}) {return <section className="panel"><header className="panel-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{action}</header>{children}</section>;}
export function Icon({name, size = 20}: {name: string; size?: number}) {
  const paths: Record<string, ReactNode> = {
    dashboard: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="11" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="18" width="7" height="3" rx="1"/></>,
    orders: <><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V2h6v2M9 9h6M9 13h6M9 17h4"/></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18M7 15h2m4 0h2m-8 3h2"/></>,
    customers: <><circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5"/></>,
    vehicles: <><path d="m4 10 2-5h12l2 5M3 17v-6l2-1h14l2 1v6H3Zm2 0v3m14-3v3M7 13h1m8 0h1"/></>,
    checklist: <><path d="m3 6 2 2 4-4m3 2h9M3 13l2 2 4-4m3 2h9M3 20l2 2 4-4m3 2h9"/></>,
    services: <><path d="m12 3 2.4 5.6L20 11l-5.6 2.4L12 19l-2.4-5.6L4 11l5.6-2.4L12 3ZM20 3v4m-2-2h4M4 18v4m-2-2h4"/></>,
    products: <><path d="m3 7 9-4 9 4-9 4-9-4Zm0 0v10l9 4 9-4V7M12 11v10M7 5l10 4"/></>,
    cash: <><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 9h18M7 15h4m5 0h2"/></>,
    invoices: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Zm3 5h6m-6 4h6m-6 4h3"/></>,
    fiscal: <><path d="M5 3h10l4 4v6M15 3v5h4M5 3v18h8M8 11h7M8 15h3"/><circle cx="18" cy="18" r="4"/><path d="m16 18 1.5 1.5L20 17"/></>,
    packages: <><rect x="3" y="8" width="18" height="4" rx="1"/><path d="M5 12v9h14v-9M12 8v13M12 8H8a3 3 0 1 1 3-3l1 3Zm0 0h4a3 3 0 1 0-3-3l-1 3Z"/></>,
    employees: <><circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2M9 16l3 3 3-3"/></>,
    messages: <><path d="M21 11a8 8 0 0 1-8 8H8l-5 3V7a4 4 0 0 1 4-4h6a8 8 0 0 1 8 8Z"/><path d="M7 8h9M7 12h6"/></>,
    reports: <><path d="M3 3v18h18M7 16v-4m5 4V8m5 8V5"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="m9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3H9Z"/></>,
    spark: <><path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6L12 3Z"/></>,
    menu: <path d="M4 6h16M4 12h16M4 18h16"/>,
    arrow: <path d="m9 5 7 7-7 7"/>,
    shield: <><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z"/><path d="m8 12 3 3 5-6"/></>,
    instagram: <><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r=".75" fill="currentColor" stroke="none"/></>,
    location: <><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 0 1 14 0Z"/><circle cx="12" cy="10" r="2.5"/></>,
    'arrow-up-right': <path d="M6 18 18 6M6 6h12v12"/>,
    'arrow-down': <path d="M12 4v16m-6-6 6 6 6-6"/>,
    close: <path d="m6 6 12 12M6 18 18 6"/>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
    migration: <><path d="M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5"/></>,
    integrations: <><path d="m8 3 4 4-5 5-4-4m13 13-4-4 5-5 4 4M9 9l6 6M4 3 2 1m18 20 2 2"/></>,
    help: <><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4m0 3v.1"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.spark}</svg>;
}
