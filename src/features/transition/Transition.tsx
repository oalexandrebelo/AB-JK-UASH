import {createContext, useContext, useEffect, useState, type ReactNode} from 'react';
import {Button} from '@react-spectrum/s2/Button';
import {Checkbox} from '@react-spectrum/s2/Checkbox';
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from '../../components/ui/card';
import {Alert, AlertDescription, AlertTitle} from '../../components/ui/alert';
import {ErrorNotice, Icon, Loading, StatusPill} from '../../components/ui';
import {useMutation, useResource, type User} from '../../lib/api';
import './transition.css';

type TransitionState = {
  mode: 'normal' | 'parallel_readonly';
  version: number;
  automaticSync: false;
  authority: 'jk' | 'jumpcar';
  historicalImportAllowed: boolean;
};
type TransitionContextValue = {state: TransitionState | null; loading: boolean; error: string | null; refresh: () => void};
const TransitionContext = createContext<TransitionContextValue | null>(null);

export function TransitionProvider({children}: {children: ReactNode}) {
  const resource = useResource<TransitionState>('/jk/transition');
  const valid = resource.data && ['normal', 'parallel_readonly'].includes(resource.data.mode) && Number.isInteger(resource.data.version);
  useEffect(() => {
    const refresh = () => {if (!document.hidden) resource.refresh();};
    window.addEventListener('focus', refresh);
    const timer = window.setInterval(refresh, 30000);
    return () => {window.removeEventListener('focus', refresh); window.clearInterval(timer);};
  }, [resource.refresh]);
  return <TransitionContext.Provider value={{state:valid ? resource.data : null, loading:resource.loading, error:resource.error || (resource.data && !valid ? 'Não foi possível verificar o modo de operação.' : null), refresh:resource.refresh}}>{children}</TransitionContext.Provider>;
}

function useTransition() {
  const context = useContext(TransitionContext);
  if (!context) throw new Error('TransitionProvider ausente.');
  return context;
}

export function TransitionBanner() {
  const {state, error, refresh} = useTransition();
  if (error) return <ErrorNotice message={`Modo de operação indisponível: ${error}`} retry={refresh}/>;
  if (state?.mode !== 'parallel_readonly') return null;
  return <aside className="transition-banner" aria-label="Modo de operação"><Icon name="shield" size={24}/><div><strong>Consulta paralela · Jumpcar é o principal</strong><p>Explore os cadastros e o histórico. A operação e os recebimentos continuam no Jumpcar.</p></div><a href="#/settings">Ver configuração</a></aside>;
}

export function TransitionSettings({user}: {user: User}) {
  const {state, loading, error, refresh} = useTransition();
  const mutation = useMutation();
  const [confirmed, setConfirmed] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {setConfirmed(false); setSaved(false);}, [state?.version]);
  if (!state && loading) return <Loading label="Verificando o modo de operação…"/>;
  if (!state) return <ErrorNotice message={error || 'Não foi possível verificar o modo de operação.'} retry={refresh}/>;
  const parallel = state.mode === 'parallel_readonly';
  async function changeMode() {
    if (!confirmed || !state || mutation.pending || loading || error) return;
    const result = await mutation.mutate<TransitionState>('/jk/transition', {version:state.version,mode:parallel ? 'normal' : 'parallel_readonly'}, 'PATCH');
    if (result) {setConfirmed(false);setSaved(true);refresh();}
  }
  return <div className="transition-settings">
    <ErrorNotice message={error} retry={refresh}/>
    <Card>
      <CardHeader>
        <div className="transition-heading"><CardTitle><h2>Uma transição no ritmo da equipe</h2></CardTitle><StatusPill tone={parallel ? 'blue' : 'green'}>{parallel ? 'Consulta paralela' : 'Operação JK'}</StatusPill></div>
        <CardDescription>Escolha onde registrar a operação enquanto a equipe se familiariza com o novo portal.</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="transition-facts"><div><dt>Sistema principal neste modo</dt><dd>{parallel ? 'Jumpcar' : 'Lava Rápido JK'}</dd></div><div><dt>Sincronização automática</dt><dd>Não disponível</dd></div><div><dt>Importação de histórico</dt><dd>Com prévia e conferência</dd></div></dl>
        <div className="transition-explanation"><h3>{parallel ? 'Consulte aqui. Continue a operação no Jumpcar.' : 'As operações registradas aqui pertencem ao JK.'}</h3><p>{parallel ? 'O servidor bloqueia novos atendimentos, recebimentos, baixa de faturas, envios e alterações operacionais. A importação autorizada continua disponível para trazer cadastros e histórico.' : 'Este modo permite o atendimento e os registros financeiros no JK. Uma operação feita no Jumpcar não aparece automaticamente aqui: defina um único sistema para cada recebimento.'}</p></div>
        <Alert role="note"><Icon name="migration"/><AlertTitle>Histórico preservado, sem repetir cobranças</AlertTitle><AlertDescription>Ordens e recebimentos importados ficam em consulta histórica. A importação não cria cobranças, comissões a pagar ou movimentações no caixa atual.</AlertDescription></Alert>
      </CardContent>
    </Card>
    <section className="transition-choice" aria-labelledby="transition-choice-title"><h2 id="transition-choice-title">{parallel ? 'Quando a equipe estiver pronta' : 'Enquanto vocês usam os dois sistemas'}</h2><p>{parallel ? 'Antes de ativar a operação JK, confira os cadastros, o saldo de abertura e as integrações. Ativar este modo não transfere pendências nem sincroniza dados do Jumpcar.' : 'Ative a consulta paralela para explorar o portal com os dados importados, mantendo atendimentos e recebimentos no Jumpcar. Envios ou integrações pendentes podem impedir a mudança até serem conferidos.'}</p>
      {user.role === 'admin' ? <><ErrorNotice message={mutation.error}/><Checkbox isSelected={confirmed} onChange={value=>{setConfirmed(value);setSaved(false);}} isDisabled={loading || mutation.pending || Boolean(error)}>{parallel ? 'Conferi a transição e quero habilitar as operações no JK.' : 'Quero manter o Jumpcar como principal e usar o JK para consulta.'}</Checkbox><div className="transition-actions"><Button variant="accent" isDisabled={!confirmed || loading || Boolean(error)} isPending={mutation.pending} onPress={changeMode}>{parallel ? 'Ativar operação JK' : 'Ativar consulta paralela'}</Button>{saved && <span role="status">Modo atualizado.</span>}</div></> : <p>Somente um administrador pode alterar o modo de operação.</p>}
    </section>
  </div>;
}
