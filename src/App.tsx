import {lazy, Suspense, useEffect, useState} from 'react';
import {Brand} from './components/Brand';
import {Loading} from './components/ui';
import {LandingPage} from './pages/LandingPage';

const OperationalApp = lazy(() => import('./RootApp').then(module => ({default: module.App})));
const isOperation = () => /^\/app(?:\/|$)/.test(window.location.pathname) || window.location.hash.startsWith('#/');

export function App() {
  const [operation, setOperation] = useState(isOperation);
  useEffect(() => {
    const update = () => setOperation(isOperation());
    window.addEventListener('popstate', update);
    window.addEventListener('hashchange', update);
    return () => {window.removeEventListener('popstate', update); window.removeEventListener('hashchange', update);};
  }, []);
  useEffect(() => {document.title = operation ? 'Operação · Lava Rápido JK' : 'Lava Rápido JK · Rio Verde';}, [operation]);
  return operation ? <Suspense fallback={<main className="startup-screen"><Brand/><Loading label="Abrindo a operação JK…"/></main>}><OperationalApp/></Suspense> : <LandingPage/>;
}
