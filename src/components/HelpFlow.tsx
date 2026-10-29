import {useState} from 'react';
import {Button} from '@react-spectrum/s2/Button';
import {LinkButton} from '@react-spectrum/s2/LinkButton';
import {Modal} from './ui';
import {orderStatuses} from '../lib/domain';
import './help-flow.css';

const steps = [
  {status: 'waiting', description: 'O veículo está na fila. Confira os serviços e as condições de entrada antes de iniciar.'},
  {status: 'in_progress', description: 'A equipe executa os serviços da ordem e registra os detalhes do atendimento.'},
  {status: 'quality_check', description: 'Confira o resultado. Se precisar de correção, retorne a ordem para a execução.'},
  {status: 'ready', description: 'O serviço foi conferido e o veículo aguarda a entrega ao cliente.'},
] as const;

export function HelpFlow({onClose}: {onClose: () => void}) {
  const [videoUnavailable, setVideoUnavailable] = useState(false);
  return <Modal wide title="Como funciona o atendimento" onClose={onClose} footer={<Button variant="secondary" onPress={onClose}>Entendi</Button>}>
    <div className="help-flow">
      <p className="help-flow-intro" id="help-flow-description">Acompanhe o caminho da ordem, da espera à entrega. O vídeo de 18 segundos começa quando você apertar reproduzir, com o som desativado.</p>
      <figure className="help-flow-film">
        <video controls muted playsInline preload="none" width="1280" height="720" poster="/media/jk-operation-poster.png" aria-label="Animação das etapas do atendimento JK" aria-describedby="help-flow-description help-flow-transcript" onError={() => setVideoUnavailable(true)}>
          <source src="/media/jk-operation.mp4" type="video/mp4" onError={() => setVideoUnavailable(true)}/>
          Seu navegador não conseguiu abrir o vídeo. Consulte a explicação das etapas abaixo.
        </video>
        <figcaption>Use os controles do vídeo para reproduzir, pausar ou ativar o som, se preferir.</figcaption>
      </figure>
      {videoUnavailable && <p className="help-flow-unavailable" role="status">O vídeo não está disponível agora. Você pode acompanhar o mesmo fluxo na explicação abaixo e no diagrama completo.</p>}
      <section className="help-flow-transcript" id="help-flow-transcript" aria-labelledby="help-flow-steps-title">
        <h2 id="help-flow-steps-title">As etapas, em palavras</h2>
        <ol className="help-flow-steps">{steps.map((step, index) => <li key={step.status}><span className="help-flow-step-number" aria-hidden="true">{index + 1}</span><div><h3>{orderStatuses[step.status]}</h3><p>{step.description}</p></div></li>)}</ol>
        <div className="help-flow-delivery"><h3>Quando marcar como entregue?</h3><p>Depois da conferência, entregue o veículo com o saldo quitado ou com o cliente habilitado para pós-pago. Se surgir um ajuste enquanto a ordem estiver pronta, ela também pode voltar para execução antes da entrega.</p></div>
      </section>
      <div className="help-flow-guide"><p>O diagrama inclui orçamento, agendamento, correções e regras de cancelamento.</p><LinkButton variant="secondary" fillStyle="outline" href="/guides/order-lifecycle.html" target="_blank" rel="noopener noreferrer">Abrir diagrama completo (nova aba)</LinkButton></div>
    </div>
  </Modal>;
}
