import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, until, fill, click, field, submit, uiQaAvailable, uiQaSkipReason} from './ui-helpers.mjs';

test('bootstrap no bundle: instalação pendente, token somente em header e metadados de banco preservados', {timeout:45000,skip:!uiQaAvailable && uiQaSkipReason}, async t => {
  const token = 'synthetic-setup-token-1234567890_abcdef';
  let pendingConfiguration = true;
  // A aplicação e o setup usam HTTP/SQLite reais. Somente o envelope 503 e o
  // rótulo storageMode=postgres são fixtures do contrato de implantação.
  const f = await fixture(t, {
    application:{setupToken:token,fiscalEnv:{}},
    responseOverride:async ({url,options,fetch}) => {
      if (url.pathname === '/api/status' && pendingConfiguration) return new Response(JSON.stringify({ok:false,error:{code:'CONFIGURATION_REQUIRED',message:'Configuração de implantação pendente.'}}),{status:503,headers:{'content-type':'application/json'}});
      if (['/api/status','/api/auth/session','/api/setup','/api/auth/login','/api/auth/logout'].includes(url.pathname)) {
        const response = await fetch(url,options);
        const result = await response.json();
        if (result.data?.storageMode) result.data.storageMode = 'postgres';
        return new Response(JSON.stringify(result),{status:response.status,headers:response.headers});
      }
      return null;
    },
  });
  await until(() => f.text().includes('Instalação pendente'),'estado de instalação pendente');
  assert.equal(f.document.querySelector('form'),null,'O estado 503 não deve oferecer criação de conta.');
  assert.equal(f.requests.filter(request => request.path === '/api/setup').length,0);
  assert.ok(f.document.querySelector('.jk-brand svg'));
  assert.match(f.document.querySelector('.jk-brand').textContent, /Lava Rápido JK/u);
  assert.ok(f.document.querySelector('link[rel="icon"][href="/logo/jk.svg"]'));
  pendingConfiguration = false;
  await click(f,'Verificar novamente');
  await until(() => f.text().includes('Prepare a operação JK'),'setup após configuração disponível');
  assert.equal(field(f,'Token de configuração').type,'password');
  assert.match(f.text(),/Banco conectado/u);
  assert.doesNotMatch(f.text(),/Seus dados ficam neste computador|Ambiente local/u);
  await fill(f,'Token de configuração',token);
  await fill(f,'Seu nome','Administrador QA Bootstrap');
  await fill(f,'E-mail','qa-bootstrap@example.test');
  await fill(f,'Senha','Senha-sintetica-12345');
  await submit(f,'Criar acesso de administrador');
  await until(() => f.document.querySelector('[aria-label="Navegação principal"]'),'sessão criada');
  const setup = f.requests.find(request => request.path === '/api/setup' && request.method === 'POST');
  assert.equal(setup.status,201);
  assert.equal(setup.headers.get('x-setup-token'),token);
  assert.equal(JSON.parse(setup.body).setupToken,undefined);
  assert.ok(!setup.body.includes(token));
  assert.equal(f.window.localStorage.length,0);
  assert.equal(f.window.sessionStorage.length,0);
  assert.match(f.text(),/Banco conectado/u);
  assert.doesNotMatch(f.text(),/Dados armazenados localmente|Dados no servidor local/u);
  await click(f,'Sair');
  await until(() => f.text().includes('Vamos começar o dia?'),'login após logout');
  assert.ok(!f.text().includes('Token de configuração'),'Token não deve ser solicitado no login.');
  assert.match(f.text(),/Banco conectado/u);
  await fill(f,'E-mail','qa-bootstrap@example.test');
  await fill(f,'Senha','Senha-sintetica-12345');
  await submit(f,'Entrar na operação');
  await until(() => f.document.querySelector('[aria-label="Navegação principal"]'),'login realizado');
  const login = f.requests.find(request => request.path === '/api/auth/login' && request.method === 'POST');
  assert.equal(login.headers.get('x-setup-token'),null,'Token inicial não pode contaminar requisições futuras.');
  f.window.dispatchEvent(new f.window.Event('ab-uash-session-expired'));
  await until(() => f.text().includes('Vamos começar o dia?'),'login após expiração');
  assert.match(f.text(),/Banco conectado/u);
  assert.doesNotMatch(f.text(),/Ambiente local/u);
  assert.deepEqual(f.runtimeErrors,[]);
});
