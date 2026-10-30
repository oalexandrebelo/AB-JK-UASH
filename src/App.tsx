import {lazy, Suspense, useEffect, useState} from 'react';
import {Brand} from './components/Brand';
import {Loading} from './components/ui';
import {LandingPage} from './pages/LandingPage';
import {BookingPage} from './features/booking/BookingPage';
import {BookingPolicyPage} from './features/booking/BookingPolicies';

const OperationalApp = lazy(() => import('./RootApp').then(module => ({default: module.App})));
const isOperation = () => /^\/app(?:\/|$)/.test(window.location.pathname) || window.location.hash.startsWith('#/');

export function App() {
  const [operation, setOperation] = useState(isOperation);
  const [publicRoute,setPublicRoute]=useState(()=>window.location.pathname.replace(/\/+$/,'')||'/');
  useEffect(() => {
    const update = () => {setOperation(isOperation());setPublicRoute(window.location.pathname.replace(/\/+$/,'')||'/');};
    window.addEventListener('popstate', update);
    window.addEventListener('hashchange', update);
    return () => {window.removeEventListener('popstate', update); window.removeEventListener('hashchange', update);};
  }, []);
  useEffect(() => {document.title = operation ? 'Operação · Lava Rápido JK' : 'Lava Rápido JK · Rio Verde';}, [operation]);
  if(publicRoute==='/agendar')return <BookingPage/>;
  if(publicRoute==='/privacidade')return <BookingPolicyPage kind="privacy"/>;
  if(publicRoute==='/condicoes-de-agendamento')return <BookingPolicyPage kind="terms"/>;
  return operation ? <Suspense fallback={<main className="startup-screen"><Brand/><Loading label="Abrindo a operação JK…"/></main>}><OperationalApp/></Suspense> : <LandingPage/>;
}
