import type {RecordData} from './api';
export const orderStatuses: Record<string, string> = {quote:'Orçamento', scheduled:'Agendada', waiting:'Aguardando', in_progress:'Em execução', quality_check:'Conferência', ready:'Pronta', delivered:'Entregue', cancelled:'Cancelada'};
export const statusTone = (status: unknown): 'neutral'|'blue'|'green'|'orange'|'red' => ['delivered','paid','ready','ok'].includes(String(status)) ? 'green' : ['cancelled','damage'].includes(String(status)) ? 'red' : ['waiting','quality_check','attention','partial'].includes(String(status)) ? 'orange' : ['in_progress','scheduled','confirmed','issued','approved'].includes(String(status)) ? 'blue' : 'neutral';
export const transitions: Record<string, string[]> = {quote:['scheduled','waiting','cancelled'], scheduled:['waiting','cancelled'], waiting:['in_progress','cancelled'], in_progress:['quality_check','cancelled'], quality_check:['in_progress','ready','cancelled'], ready:['in_progress','delivered','cancelled']};
export const appointmentStatuses: Record<string,string> = {scheduled:'Agendado',confirmed:'Confirmado',arrived:'Cliente chegou',converted:'OS criada',cancelled:'Cancelado'};
export const records = (value: unknown): RecordData[] => Array.isArray(value) ? value as RecordData[] : [];
export const currencyField = (key: string, label: string, initial = 0) => ({key,label,type:'money' as const,default:initial});
export const canManage = (role: string) => ['admin','manager'].includes(role);
