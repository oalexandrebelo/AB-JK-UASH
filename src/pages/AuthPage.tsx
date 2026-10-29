import {useState} from 'react';
import {Button} from '@react-spectrum/s2/Button';
import {TextField} from '@react-spectrum/s2/TextField';
import {Checkbox} from '@react-spectrum/s2/Checkbox';
import {Form} from '@react-spectrum/s2/Form';
import {StatusLight} from '@react-spectrum/s2/StatusLight';
import {type Session, type StorageMode, useMutation} from '../lib/api';
import {Brand} from '../components/Brand';
import {CarArtwork} from '../components/CarArtwork';
import {ErrorNotice, fullWidth, Icon} from '../components/ui';

export function AuthPage({setup, setupTokenRequired = false, storageMode, onSession}: {setup: boolean; setupTokenRequired?: boolean; storageMode: StorageMode; onSession: (session: Session) => void}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const {mutate, pending, error} = useMutation();
  return <main className="auth-screen"><section className="auth-story"><a className="brand brand-light" href="/" aria-label="Voltar ao site do Lava Rápido JK"><Brand light/></a><div className="auth-story-main"><span className="auth-label">A OPERAÇÃO JK, EM SUAS MÃOS</span><h1>Cuidado com os carros.<br/><em>Clareza para o seu dia.</em></h1><p>Da chegada à entrega, os detalhes de cada atendimento no mesmo lugar.</p><div className="auth-car-illustration"><CarArtwork/></div></div><div className="auth-local"><Icon name="location" size={18}/><span>Lava Rápido JK · Rio Verde, GO</span></div></section><section className="auth-form-side"><a className="auth-back-link" href="/"><Icon name="arrow-up-right" size={16}/> Voltar ao site</a><div className="auth-form-box"><span className="auth-form-icon"><Icon name="shield" size={24}/></span><span className="section-kicker">ÁREA DA EQUIPE</span><h2>{setup ? 'Prepare a operação JK' : 'Vamos começar o dia?'}</h2><p>{setup ? 'Crie o primeiro acesso de administrador. Depois, você poderá cadastrar a equipe e importar os dados do negócio.' : 'Entre com seu e-mail e senha para acompanhar os atendimentos e cuidar da operação.'}</p><ErrorNotice message={error}/><Form isDisabled={pending} onSubmit={async event => {event.preventDefault(); const session = await mutate<Session>(setup ? '/setup' : '/auth/login', setup ? {name, email, password} : {email, password}, 'POST', setup && setupTokenRequired ? {setupToken} : {}); if (session) {setSetupToken(''); setPassword(''); onSession(session);}}}>
    {setup && setupTokenRequired && <TextField label="Token de configuração" type="password" value={setupToken} onChange={setSetupToken} isRequired minLength={32} maxLength={256} autoComplete="off" description="Use o token fornecido pelo responsável pela implantação." styles={fullWidth}/>}
    {setup && <TextField label="Seu nome" value={name} onChange={setName} isRequired minLength={2} maxLength={80} autoComplete="name" styles={fullWidth}/>}
    <TextField label="E-mail" type="email" value={email} onChange={setEmail} isRequired autoComplete="username" styles={fullWidth}/>
    <TextField label="Senha" type={showPassword ? 'text' : 'password'} value={password} onChange={setPassword} isRequired minLength={setup ? 12 : 1} maxLength={128} autoComplete={setup ? 'new-password' : 'current-password'} description={setup ? 'Use pelo menos 12 caracteres.' : undefined} styles={fullWidth}/>
    <Checkbox isSelected={showPassword} onChange={setShowPassword}>Mostrar senha</Checkbox>
    <Button type="submit" variant="accent" size="L" isPending={pending} styles={fullWidth}>{setup ? 'Criar acesso de administrador' : 'Entrar na operação'}</Button>
  </Form><div className="auth-footnote"><StatusLight variant="positive" size="S">{storageMode === 'postgres' ? 'Banco conectado' : 'Dados no servidor local'}</StatusLight></div><p className="auth-access-help">{setup ? 'Cada pessoa da equipe poderá ter sua própria conta e permissão de acesso.' : 'Precisa de acesso ou esqueceu sua senha? Procure o administrador da operação.'}</p></div><footer>LAVA RÁPIDO JK <span>Gestão do atendimento</span></footer></section></main>;
}
