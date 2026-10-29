import {useState, type ReactNode} from 'react';
import {TextField} from '@react-spectrum/s2/TextField';
import {TextArea} from '@react-spectrum/s2/TextArea';
import {NumberField} from '@react-spectrum/s2/NumberField';
import {Picker, PickerItem} from '@react-spectrum/s2/Picker';
import {Checkbox} from '@react-spectrum/s2/Checkbox';
import {Button} from '@react-spectrum/s2/Button';
import {Form} from '@react-spectrum/s2/Form';
import {ErrorNotice, fullWidth, Modal, Notice} from './ui';
import {useMutation,businessDateTimeInput,businessDateTimeIso, type RecordData} from '../lib/api';
import {RemotePicker} from './RemotePicker';

export type Field = {key: string; label: string; type?: 'text' | 'email' | 'textarea' | 'number' | 'money' | 'percent' | 'quantity' | 'select' | 'boolean' | 'date' | 'datetime' | 'month' | 'password'; required?: boolean; min?: number; max?: number; default?: unknown; options?: {id: string; label: string}[]; relation?: string; relationFilters?:Record<string,string>; relationMatch?:(row:RecordData)=>boolean; description?: string; createOnly?: boolean};
export type FormValues = Record<string, string | number | boolean>;
export function initialValues(fields: Field[], item?: Record<string, unknown>): FormValues {
  return Object.fromEntries(fields.map(field => {
    const raw = item?.[field.key] ?? field.default ?? (field.type === 'boolean' ? false : ['money', 'number', 'quantity', 'percent'].includes(field.type || '') ? 0 : '');
    const factor = field.type === 'money' || field.type === 'percent' ? 100 : field.type === 'quantity' ? 1000 : 1;
    let value = factor === 1 ? raw : Number(raw) / factor;
    if (field.type === 'datetime' && typeof value === 'string' && value) value=businessDateTimeInput(value);
    return [field.key, value];
  })) as FormValues;
}
export function serializeValues(fields: Field[], values: FormValues) {
  return Object.fromEntries(fields.map(field => {
    let value: unknown = values[field.key];
    if (field.type === 'money' || field.type === 'percent') value = Math.round(Number(value) * 100);
    if (field.type === 'quantity') value = Math.round(Number(value) * 1000);
    if (field.type === 'number') value = Number(value);
    if (field.type === 'datetime') value = businessDateTimeIso(value);
    return [field.key, value];
  }));
}
export function Fields({fields, values, onChange, relations = {}, isDisabled}: {fields: Field[]; values: FormValues; onChange: (key: string, value: string | number | boolean) => void; relations?: Record<string, RecordData[]>; isDisabled?: boolean}) {
  return <div className="form-grid">{fields.map(field => {
    const shared = {label: field.label, isRequired: field.required, description: field.description, styles: fullWidth, isDisabled};
    const value = values[field.key];
    let input: ReactNode;
    if (field.type === 'boolean') input = <Checkbox isDisabled={isDisabled} isSelected={Boolean(value)} onChange={v => onChange(field.key, v)}>{field.label}</Checkbox>;
    else if(field.relation&&['customers','vehicles','services','employees','products','packages','sales'].includes(field.relation)) input=<RemotePicker collection={field.relation==='sales'?'package-sales':field.relation} label={field.label} required={field.required} value={String(value||'')} onChange={v=>onChange(field.key,v)} description={field.description} filters={field.relationFilters} match={field.relationMatch} isDisabled={isDisabled||field.relation==='vehicles'&&!field.relationFilters?.customerId}/>;
    else if (field.type === 'select' || field.relation) {
      const options = field.relation ? (relations[field.relation] || []).filter(item => item.active !== false || item.id === value).map(item => ({id: item.id, label: String(item.name || item.plate || item.number || item.period || item.id)})) : field.options || [];
      input = <Picker {...shared} value={String(value || '') || null} onChange={v => onChange(field.key, String(v || ''))} placeholder="Selecione uma opção">{options.map(option => <PickerItem key={option.id} id={option.id}>{option.label}</PickerItem>)}</Picker>;
    } else if (['money', 'number', 'quantity', 'percent'].includes(field.type || '')) {
      const money = field.type === 'money';
      input = <NumberField {...shared} value={Number(value)} onChange={v => onChange(field.key, Number.isFinite(v) ? v : 0)} minValue={field.min ?? 0} maxValue={field.max ?? (field.type === 'percent' ? 100 : undefined)} step={money || field.type === 'percent' ? .01 : field.type === 'quantity' ? .001 : 1} formatOptions={money ? {style: 'currency', currency: 'BRL'} : {maximumFractionDigits: field.type === 'quantity' ? 3 : field.type === 'percent' ? 2 : 0}} hideStepper={money}/>;
    } else if (field.type === 'textarea') input = <TextArea {...shared} value={String(value || '')} onChange={v => onChange(field.key, v)}/>;
    else if (field.type === 'date' || field.type === 'datetime' || field.type === 'month') input = <label className="native-date-field"><span>{field.label}{field.required ? ' *' : ''}</span><input type={field.type === 'datetime' ? 'datetime-local' : field.type} required={field.required} disabled={isDisabled} value={String(value || '')} onChange={event => onChange(field.key, event.target.value)}/>{(field.description||field.type==='datetime') && <small>{field.type==='datetime'?'Horário de São Paulo. ':''}{field.description}</small>}</label>;
    else input = <TextField {...shared} type={field.type === 'email' ? 'email' : field.type === 'password' ? 'password' : 'text'} value={String(value || '')} onChange={v => onChange(field.key, v)} maxLength={field.key === 'notes' ? 2000 : field.key === 'password' ? 128 : 250} minLength={field.type === 'password' ? 12 : undefined}/>;
    return <div className={`form-field ${field.type === 'textarea' || field.type === 'boolean' ? 'full' : ''}`} key={field.key}>{input}</div>;
  })}</div>;
}
export function ActionDialog({title, path, method = 'POST', fields, initial, base = {}, relations, note, onClose, onSaved, submit = 'Salvar', children}: {title: string; path: string; method?: string; fields: Field[]; initial?: Record<string, unknown>; base?: Record<string, unknown>; relations?: Record<string, RecordData[]>; note?: string; onClose: () => void; onSaved: (data: {item: RecordData}) => void; submit?: string; children?: ReactNode}) {
  const [values, setValues] = useState(() => initialValues(fields, initial));
  const {mutate, pending, error} = useMutation();
  return <Modal title={title} onClose={onClose} isPending={pending}><Form isDisabled={pending} onSubmit={async event => {event.preventDefault(); const response = await mutate<{item: RecordData}>(path, {...base, ...serializeValues(fields, values)}, method); if (response) onSaved(response);}}>
    {note && <Notice>{note}</Notice>}{children}<ErrorNotice message={error}/><Fields isDisabled={pending} fields={fields} values={values} onChange={(key, value) => setValues(old => ({...old, [key]: value}))} relations={relations}/><div className="modal-actions"><Button variant="secondary" onPress={onClose} isDisabled={pending}>Cancelar</Button><Button type="submit" variant="accent" isPending={pending}>{submit}</Button></div>
  </Form></Modal>;
}
export const paymentFields: Field[] = [
  {key: 'amountCents', label: 'Valor recebido', type: 'money', min: .01, required: true},
  {key: 'method', label: 'Forma de recebimento', type: 'select', default: 'pix', required: true, options: [{id: 'pix', label: 'Pix'}, {id: 'cash', label: 'Dinheiro'}, {id: 'credit', label: 'Cartão de crédito'}, {id: 'debit', label: 'Cartão de débito'}, {id: 'transfer', label: 'Transferência'}]},
  {key: 'reference', label: 'Referência / comprovante', description: 'Identificação opcional para sua conferência.'},
];
export const paymentMethods = {pix: 'Pix', cash: 'Dinheiro', credit: 'Crédito', debit: 'Débito', transfer: 'Transferência'};
