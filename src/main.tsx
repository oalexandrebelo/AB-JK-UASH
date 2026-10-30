import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {Provider} from '@react-spectrum/s2/Provider';
import {App} from './App';
import '@react-spectrum/s2/page.css';
import '@fontsource-variable/inter';
import './shadcn.css';
import './styles.css';
import './jk.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Provider locale="pt-BR" colorScheme="light" background="base">
      <App />
    </Provider>
  </StrictMode>,
);
