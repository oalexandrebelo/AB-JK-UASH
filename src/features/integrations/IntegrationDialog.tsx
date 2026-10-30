import {useState} from 'react';
import {Button} from '@react-spectrum/s2/Button';
import {Checkbox} from '@react-spectrum/s2/Checkbox';
import {Form} from '@react-spectrum/s2/Form';
import {NumberField} from '@react-spectrum/s2/NumberField';
import {TextArea} from '@react-spectrum/s2/TextArea';
import {TextField} from '@react-spectrum/s2/TextField';
import {ErrorNotice, Modal, Notice, fullWidth} from '../../components/ui';
import {businessDateTimeIso, dateOnly, money, useMutation, type RecordData} from '../../lib/api';

export type IntegrationAction = {
  channel: 'pix' | 'whatsapp';
  action: 'prepare' | 'submit' | 'reconcile' | 'cancel';
  provider?: string;
  item?: RecordData;
};

/** The server derives amount/recipient and owns the idempotency/version checks. */
export function IntegrationDialog({operation, order, onClose, onSaved}: {
  operation: IntegrationAction; order: RecordData; onClose: () => void; onSaved: () => void;
}) {
  const {channel, action, item} = operation;
  const [minutes, setMinutes] = useState(60);
  const [asaasCustomer, setAsaasCustomer] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [template, setTemplate] = useState('');
  const [language, setLanguage] = useState('pt_BR');
  const [parameters, setParameters] = useState('');
  const [consent, setConsent] = useState(false);
  const [customPeriod, setCustomPeriod] = useState(false);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const mutation = useMutation();
  const preparing = action === 'prepare';
  const provider = String(item?.provider || operation.provider || '');
  const asaas = provider === 'pix-asaas';
  const baileys = provider === 'whatsapp-baileys';
  const label = channel === 'pix' ? 'cobrança Pix' : 'mensagem de WhatsApp';
  const title = action === 'prepare' ? `Preparar ${label}` : action === 'submit' ? `Enviar ${label}` : action === 'reconcile' ? `Consultar pagamento ${asaas ? 'no Asaas' : 'no banco'}` : 'Cancelar preparação local';
  const submit = action === 'prepare' ? 'Salvar preparação' : action === 'submit' ? 'Confirmar envio ao provedor' : action === 'reconcile' ? 'Consultar e conciliar' : 'Cancelar preparação';
  return <Modal title={title} onClose={onClose} isPending={mutation.pending}><Form isDisabled={mutation.pending} onSubmit={async event => {
    event.preventDefault();
    const body: Record<string, unknown> = {version: preparing ? order.version : item?.version};
    if (preparing && channel === 'pix') {
      if (asaas) {
        if (!/^cus_[A-Za-z0-9]{1,100}$/.test(asaasCustomer.trim())) {mutation.setError('Informe o identificador do cliente já cadastrado no Asaas, começando por cus_.'); return;}
        const date = new Date(`${dueDate}T00:00:00.000Z`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== dueDate) {mutation.setError('Informe uma data de vencimento válida.'); return;}
        Object.assign(body, {customerId: asaasCustomer.trim(), dueDate});
      } else {
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {mutation.setError('Informe a validade de 1 a 1440 minutos inteiros.'); return;}
        body.expiresInSeconds = minutes * 60;
      }
    }
    if (preparing && channel === 'whatsapp') {
      if (!consent) {mutation.setError('Confirme a autorização do cliente para esta comunicação.'); return;}
      const parts = parameters ? parameters.split(/\r?\n/) : [];
      if (parts.length > 30 || parts.some(value => !value.trim() || value.length > 1024)) {mutation.setError('Use até 30 parâmetros, um por linha, sem linhas vazias e com até 1024 caracteres por parâmetro.'); return;}
      Object.assign(body, {templateName: template.trim(), languageCode: language.trim(), bodyParameters: parts, consentConfirmed: true});
    }
    if (action === 'reconcile' && customPeriod && !asaas) {
      if (!start || !end) {mutation.setError('Informe o início e o fim do intervalo de consulta.'); return;}
      try {Object.assign(body, {start: businessDateTimeIso(start), end: businessDateTimeIso(end)});} catch {mutation.setError('Informe datas e horários válidos.'); return;}
    }
    const path = preparing ? `/jk/orders/${order.id}/${channel === 'pix' ? 'pix' : 'messages'}` : `/jk/${channel === 'pix' ? 'pix' : 'messages'}/${item?.id}/${action}`;
    if (await mutation.mutate(path, body)) onSaved();
  }}>
    <Notice>{preparing ? `Esta etapa registra uma preparação na OS ${order.number}. O envio ao provedor será uma ação separada.` : action === 'submit' ? `Esta ação solicita o envio ao provedor configurado. Ambiente: ${item?.environment === 'production' ? 'produção' : item?.environment === 'homologation' ? 'homologação' : String(item?.environment || 'não definido')}.` : action === 'reconcile' ? 'O provedor será consultado. A OS só será quitada se o servidor comprovar um pagamento integral em produção e conferir o saldo atual.' : 'Apenas esta preparação será cancelada. Este comando está disponível para registros que ainda não tiveram envio iniciado.'}</Notice>
    <ErrorNotice message={mutation.error}/>
    {channel === 'pix' && <p className="panel-copy"><strong>Valor da cobrança:</strong> {money(preparing ? order.balanceCents : item?.amountCents)}</p>}
    {!preparing && asaas && <p className="panel-copy"><strong>Cliente no Asaas:</strong> {String(item?.customerId || '—')}<br/><strong>Vencimento:</strong> {dateOnly(item?.dueDate)}</p>}
    {preparing && channel === 'pix' && (asaas ? <div className="content-stack"><Notice>O cliente precisa existir na conta Asaas. Informe o identificador dessa conta para vincular a cobrança ao cadastro correto.</Notice><TextField label="Identificador do cliente no Asaas" value={asaasCustomer} onChange={setAsaasCustomer} isRequired maxLength={104} pattern="cus_[A-Za-z0-9]+" description="Começa por cus_. Use o cliente já cadastrado no Asaas." styles={fullWidth}/><label className="native-date-field"><span>Vencimento da cobrança</span><input type="date" required value={dueDate} onChange={event => setDueDate(event.target.value)}/></label></div> : <NumberField label="Validade da cobrança, em minutos" value={minutes} onChange={setMinutes} minValue={1} maxValue={1440} step={1} isRequired styles={fullWidth}/>)}
    {preparing && channel === 'whatsapp' && <div className="content-stack">
      {baileys && <Notice>Modelos locais de texto: use o catálogo configurado para o Baileys. Esses modelos são enviados pelo WhatsApp Web e não são modelos aprovados pela Meta.</Notice>}
      <TextField label={baileys ? 'Nome do modelo local no Baileys' : 'Nome do modelo aprovado no WhatsApp'} value={template} onChange={setTemplate} isRequired maxLength={128} pattern="[a-z0-9_]+" description={baileys ? 'Informe o identificador do catálogo local da operação.' : 'Informe o identificador aprovado na conta da empresa.'} styles={fullWidth}/>
      <TextField label="Código do idioma" value={language} onChange={setLanguage} isRequired maxLength={6} pattern="[a-z]{2,3}(_[A-Z]{2})?" description={`Exemplo: pt_BR. Deve corresponder ao modelo ${baileys ? 'local' : 'aprovado'}.`} styles={fullWidth}/>
      <TextArea label="Parâmetros do corpo, um por linha" value={parameters} onChange={setParameters} maxLength={30750} description="Preencha na ordem exigida pelo modelo. Deixe vazio quando ele não tiver parâmetros." styles={fullWidth}/>
      <Checkbox isSelected={consent} onChange={setConsent}>O cliente autorizou esta comunicação sobre o atendimento.</Checkbox>
      <p className="muted-text">O destinatário será o telefone cadastrado no cliente desta OS.</p>
    </div>}
    {action === 'reconcile' && !asaas && <div className="content-stack"><Checkbox isSelected={customPeriod} onChange={setCustomPeriod}>Escolher intervalo da consulta</Checkbox>{customPeriod && <><label className="native-date-field"><span>Início, horário de São Paulo</span><input type="datetime-local" required value={start} onChange={event => setStart(event.target.value)}/></label><label className="native-date-field"><span>Fim, horário de São Paulo</span><input type="datetime-local" required value={end} onChange={event => setEnd(event.target.value)}/></label><p className="muted-text">Intervalo de até 31 dias, a partir da criação da cobrança. O servidor valida o período.</p></>}</div>}
    {action === 'submit' && channel === 'whatsapp' && <p className="panel-copy"><strong>{baileys ? 'Modelo local' : 'Modelo'}:</strong> {String(item?.templateName || '')}<br/><strong>Destinatário:</strong> {String(item?.recipientMasked || '')}<br/>{baileys ? 'O aceite pelo socket não comprova entrega ao cliente.' : 'O aceite do provedor será registrado separadamente da entrega ao cliente.'}</p>}
    <div className="modal-actions"><Button variant="secondary" isDisabled={mutation.pending} onPress={onClose}>Voltar</Button><Button type="submit" variant="accent" isPending={mutation.pending}>{submit}</Button></div>
  </Form></Modal>;
}
