import {randomBytes, randomUUID} from 'node:crypto';
import {chmod, lstat, mkdir, open, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createApplication} from '../server/application.mjs';
import {createSnapshot, inspectDatabase, parseOptions} from './storage.mjs';

const PROJECT_ROOT=fileURLToPath(new URL('../',import.meta.url));
const FORMAT='ab-jk-isolated-rehearsal-v1';
const VERSION=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;
const IDENTITY=Object.freeze({name:'Ensaio JK — NÃO OPERACIONAL',email:'ensaio-jk@example.test'});
const TABLES=['users','customers','vehicles','services','orders','payments','messages','jk_integration_records'];
const FORBIDDEN=/^(?:DATABASE_URL|DATABASE_SCHEMA|DATABASE_CA|DATABASE_POOL_SIZE|DB_PATH|PUBLIC_ORIGIN|HOST|PORT|SETUP_TOKEN|SETUP_TOKEN_FILE|COOKIE_SECURE|DIST_DIR|AB_UASH_TEST_DATABASE_URL|AB_JK_.*|AB_UASH_FISCAL_.*|AB_UASH_FOCUS_.*)$/u;
const inside=(path,root)=>{const value=relative(root,path);return value===''||value!=='..'&&!value.startsWith(`..${sep}`)&&!isAbsolute(value);};
const need=(condition,message)=>{if(!condition)throw new Error(message);};

export function validateRehearsalConfig({directory,port=4179,env=process.env}={}) {
  need(Number(process.versions.node.split('.')[0])===24,'Use Node.js 24 para o ensaio.');
  need(env.JK_REHEARSAL_MODE==='isolated','Defina JK_REHEARSAL_MODE=isolated explicitamente.');
  const inherited=Object.keys(env).filter(key=>FORBIDDEN.test(key)&&env[key]!==undefined&&env[key]!=='');
  need(!inherited.length,`Remova a configuração herdada antes do ensaio: ${inherited.join(', ')}.`);
  need(typeof directory==='string'&&isAbsolute(directory)&&!directory.includes('\0'),'Use um diretório absoluto novo para o ensaio.');
  const root=resolve(directory);
  need(/^jk-rehearsal-[a-z0-9][a-z0-9-]{2,60}$/u.test(basename(root)),'O nome do diretório deve começar com jk-rehearsal- e identificar o ensaio.');
  need(!inside(root,PROJECT_ROOT),'O diretório privado de ensaio deve ficar fora do checkout Git.');
  need(!['/data','/srv','/var/lib','/private/var/lib'].some(path=>inside(root,path)),'O ensaio recusa diretórios de dados de produção.');
  port=Number(port);
  need(Number.isInteger(port)&&port>=0&&port<=65535&&port!==9220,'Use uma porta local entre 0 e 65535, diferente da porta de produção 9220.');
  return {directory:root,dbPath:join(root,'jk-rehearsal.sqlite'),host:'127.0.0.1',port,env};
}

async function privateFile(path) {
  const info=await lstat(path);
  need(info.isFile()&&!info.isSymbolicLink(),'O arquivo de ensaio deve ser regular, sem link simbólico.');
  need((info.mode&0o077)===0&&info.uid===process.getuid?.(),'O arquivo de ensaio deve ser privado e pertencer ao operador.');
  return info;
}
async function readPrivateJson(path) {
  const info=await privateFile(path);need(info.size<=64*1024,'Arquivo de configuração do ensaio excedeu o limite.');
  try {return JSON.parse(await readFile(path,'utf8'));}catch{throw new Error('O JSON privado do ensaio é inválido.');}
}
async function configuration(options) {
  const config=validateRehearsalConfig(options);
  const info=await lstat(config.directory);
  need(info.isDirectory()&&!info.isSymbolicLink()&&(info.mode&0o077)===0&&info.uid===process.getuid?.(),'O diretório de ensaio deve ser privado, próprio e sem link simbólico.');
  const physical=await realpath(config.directory);
  validateRehearsalConfig({...config,directory:physical});
  config.directory=physical;config.dbPath=join(physical,'jk-rehearsal.sqlite');
  const marker=await readPrivateJson(join(physical,'rehearsal.json'));
  need(marker.format===FORMAT&&marker.purpose==='isolated-test-only'&&marker.dbFile==='jk-rehearsal.sqlite','Identificação do ensaio inválida; nenhum banco será aberto.');
  need(marker.sourceVersion===VERSION,'A versão do aplicativo mudou; prepare um novo ensaio com a versão revisada.');
  await privateFile(config.dbPath);
  return config;
}
function databaseFacts(path) {
  const db=new DatabaseSync(path,{readOnly:true});
  try {
    inspectDatabase(db);
    const counts=Object.fromEntries(TABLES.map(table=>[table,Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n)]));
    const identity=db.prepare('SELECT name,email,role FROM users').all();
    need(identity.length===1&&identity[0].name===IDENTITY.name&&identity[0].email===IDENTITY.email&&identity[0].role==='admin','O banco não tem exclusivamente a identidade de ensaio esperada.');
    const transition=db.prepare("SELECT value_json FROM app_settings WHERE key='jk_transition'").get();
    const operationMode=transition?JSON.parse(transition.value_json).mode:'normal';
    return {counts,operationMode};
  } finally {db.close();}
}
export async function inspectRehearsal(options) {
  const config=await configuration(options);
  const facts=databaseFacts(config.dbPath);
  return {directory:config.directory,dbPath:config.dbPath,sourceVersion:VERSION,...facts,testIdentity:IDENTITY,integrity:'ok',externalProviders:'disabled',providerScope:'helper passes empty provider configuration; no host firewall is installed'};
}
function application(config,setupToken) {
  return createApplication({dbPath:config.dbPath,distDir:join(PROJECT_ROOT,'dist'),setupToken,
    fiscalEnv:Object.freeze({AB_UASH_FISCAL_ENABLED:'false'}),
    fiscalTransport:async()=>{throw new Error('REHEARSAL_EXTERNAL_EFFECTS_DISABLED');},
    jkIntegrationsEnv:Object.freeze({})});
}
function client(url,setupToken) {
  let cookie='',csrf='';
  return async function call(path,{method='GET',body,status=200,key=randomUUID(),authenticated=true}={}) {
    need(typeof path==='string'&&path.startsWith('/')&&!path.startsWith('//')&&!path.includes('://'),'O cliente de ensaio aceita somente rotas locais.');
    const response=await fetch(`${url}/api${path}`,{method,redirect:'error',signal:AbortSignal.timeout(5000),headers:{
      ...(body===undefined?{}:{'content-type':'application/json'}),
      ...(authenticated?{cookie,'x-csrf-token':csrf}:{}),'idempotency-key':key,
      ...(setupToken&&path==='/setup'?{'x-setup-token':setupToken}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const result=await response.json();
    need(response.status===status,`${method} ${path}: HTTP ${response.status}; ${result.error?.code||'RESPOSTA_INESPERADA'}.`);
    if(['/setup','/auth/login'].includes(path)&&result.ok){cookie=response.headers.get('set-cookie').split(';')[0];csrf=result.data.csrfToken;}
    return {...result,response};
  };
}
async function providersBlocked(call) {
  const readiness=(await call('/jk/integrations/readiness')).data;
  for(const kind of ['pix','whatsapp','fiscal'])need(readiness[kind].state==='blocked'&&!readiness[kind].configured&&!readiness[kind].capabilities.submit,'O ensaio exige todos os provedores externos desativados.');
}
async function setMode(call,mode) {
  const current=(await call('/jk/transition')).data;
  if(current.mode!==mode)return (await call('/jk/transition',{method:'PATCH',body:{version:current.version,mode}})).data;
  return current;
}

export async function prepareRehearsal(options) {
  const config=validateRehearsalConfig(options);
  config.port=0;
  const parent=await realpath(dirname(config.directory));
  const directory=join(parent,basename(config.directory));
  validateRehearsalConfig({...config,directory});
  await mkdir(directory,{mode:0o700});
  config.directory=directory;config.dbPath=join(directory,'jk-rehearsal.sqlite');
  const credentials={...IDENTITY,password:randomBytes(32).toString('base64url')};
  await writeFile(join(directory,'access.json'),`${JSON.stringify(credentials,null,2)}\n`,{flag:'wx',mode:0o600});
  await writeFile(join(directory,'rehearsal.json'),`${JSON.stringify({format:FORMAT,purpose:'isolated-test-only',dbFile:'jk-rehearsal.sqlite',sourceVersion:VERSION,preparedAt:new Date().toISOString(),identity:IDENTITY},null,2)}\n`,{flag:'wx',mode:0o600});
  const setupToken=randomBytes(32).toString('base64url');
  let app;
  try {
    app=await application(config,setupToken);
    const address=await app.listen({host:config.host,port:0});
    const call=client(`http://127.0.0.1:${address.port}`,setupToken);
    await call('/setup',{method:'POST',body:credentials,status:201});
    await providersBlocked(call);await setMode(call,'parallel_readonly');
    await call('/auth/logout',{method:'POST',body:{}});
  } finally {await app?.close();}
  await chmod(config.dbPath,0o600);
  return inspectRehearsal({...options,directory});
}

export async function openRehearsal(options) {
  const config=await configuration(options);
  databaseFacts(config.dbPath);
  const lockPath=join(config.directory,'running.lock');
  let lock;
  try {lock=await open(lockPath,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw new Error('Ensaio em uso ou running.lock preservado após interrupção; confira o processo antes de remover o lock.');throw error;}
  let app,call;
  try {
    await lock.writeFile(`${JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()})}\n`);
    const credentials=await readPrivateJson(join(config.directory,'access.json'));
    need(credentials.email===IDENTITY.email&&credentials.name===IDENTITY.name&&typeof credentials.password==='string','A credencial deve pertencer à identidade de ensaio.');
    app=await application(config);
    const address=await app.listen({host:config.host,port:config.port});
    const url=`http://127.0.0.1:${address.port}`;
    call=client(url);await call('/auth/login',{method:'POST',body:{email:credentials.email,password:credentials.password}});
    await providersBlocked(call);
    const target=options.allowWrites===true?'normal':'parallel_readonly';
    await setMode(call,target);
    let closing;
    return {app,call,url,dbPath:config.dbPath,directory:config.directory,operationMode:target,
      close(){
        closing||=(async()=>{try {await setMode(call,'parallel_readonly');await call('/auth/logout',{method:'POST',body:{}});}finally{try{await app.close();}finally{await lock.close();await rm(lockPath);}}})();
        return closing;
      }};
  } catch(error) {
    try {await app?.close();}finally{await lock.close();await rm(lockPath);}
    throw error;
  }
}

export async function runRehearsalSmoke(options) {
  const initial=await inspectRehearsal(options);
  for(const table of TABLES.filter(table=>table!=='users'))need(initial.counts[table]===0,'A jornada automática exige banco vazio; crie um novo ensaio para repetir.');
  const runtime=await openRehearsal({...options,port:0,allowWrites:true});
  const snapshot=join(runtime.directory,'jk-rehearsal-backup.sqlite');
  const restored=join(runtime.directory,'jk-rehearsal-restored.sqlite');
  let result,sourceSessions;
  try {
    const {call}=runtime;
    const create=async(path,body)=>(await call(path,{method:'POST',body,status:201})).data.item;
    const customer=await create('/customers',{name:'ENSAIO JK — cliente fictício',postpaid:false});
    const vehicle=await create('/vehicles',{customerId:customer.id,plate:'TST1A23',model:'ENSAIO JK — veículo fictício'});
    const service=await create('/services',{name:'ENSAIO JK — lavagem fictícia',priceCents:2500,durationMinutes:30,commissionBps:0});
    let order=await create('/orders',{customerId:customer.id,vehicleId:vehicle.id,items:[{serviceId:service.id,quantity:1}],notes:'ENSAIO ISOLADO. Sem operação real.'});
    const firstVersion=order.version;
    for(const status of ['in_progress','quality_check','ready'])order=(await call(`/orders/${order.id}/transition`,{method:'POST',body:{version:order.version,status}})).data.item;
    const stale=await call(`/orders/${order.id}/payments`,{method:'POST',body:{version:firstVersion,amountCents:2500,method:'cash'},status:409});
    need(stale.error.code==='VERSION_CONFLICT','A proteção de versão da OS deve rejeitar a operação antiga.');
    await create('/cash/open',{openingCents:1000,notes:'ENSAIO JK — abertura fictícia'});
    const payment={version:order.version,amountCents:2500,method:'cash',reference:'ENSAIO-LOCAL-SEM-PROVEDOR'};
    const key=randomUUID();
    order=(await call(`/orders/${order.id}/payments`,{method:'POST',body:payment,key})).data.item;
    const replay=await call(`/orders/${order.id}/payments`,{method:'POST',body:payment,key});
    need(replay.response.headers.get('idempotency-replayed')==='true','O recebimento repetido deve usar o resultado anterior.');
    order=(await call(`/orders/${order.id}/transition`,{method:'POST',body:{version:order.version,status:'delivered'}})).data.item;
    let cash=(await call('/cash/current')).data.item;
    need(cash.expectedCents===3500,'O caixa de ensaio deve conciliar abertura e recebimento.');
    cash=(await call(`/cash/${cash.id}/close`,{method:'POST',body:{version:cash.version,countedCents:3500}})).data.item;
    need(order.status==='delivered'&&order.balanceCents===0&&cash.status==='closed'&&cash.differenceCents===0,'A jornada deve encerrar OS e caixa sem diferença.');
    const facts=databaseFacts(runtime.dbPath);
    need(facts.counts.payments===1&&facts.counts.messages===0&&facts.counts.jk_integration_records===0,'O ensaio não pode gerar duplicação nem efeitos externos.');
    await setMode(call,'parallel_readonly');
    await createSnapshot(runtime.dbPath,snapshot);
    const backupDb=new DatabaseSync(snapshot,{readOnly:true});
    try {sourceSessions=Number(backupDb.prepare('SELECT COUNT(*) AS n FROM sessions').get().n);need(sourceSessions===1,'O backup de recuperação deve conter a sessão ativa do ensaio.');}finally{backupDb.close();}
    result={ok:true,sourceVersion:VERSION,scope:'synthetic-local-http-only',testIdentity:IDENTITY,orderStatus:order.status,paidCents:order.paidCents,cashDifferenceCents:cash.differenceCents,paymentCount:facts.counts.payments,idempotencyReplay:true,staleVersionRejected:true,noExternalEffects:true};
  } finally {await runtime.close();}
  await createSnapshot(snapshot,restored,{restore:true});
  await privateFile(restored);
  const recovery=databaseFacts(restored);
  const db=new DatabaseSync(restored,{readOnly:true});
  try {
    need(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n===0,'A restauração deve revogar as sessões.');
    need(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='system.restored'").get().n===1,'A restauração deve registrar a recuperação.');
    need(recovery.counts.orders===1&&recovery.counts.payments===1,'A restauração deve preservar OS e recebimento.');
  } finally {db.close();}
  let restoredApp;
  try {
    restoredApp=await application({...validateRehearsalConfig({...options,port:0}),dbPath:restored});
    const address=await restoredApp.listen({host:'127.0.0.1',port:0});
    const call=client(`http://127.0.0.1:${address.port}`);
    const status=(await call('/status',{authenticated:false})).data;
    need(!status.setupRequired&&status.user===null,'A cópia restaurada deve exigir novo login.');
    const denied=await call('/orders',{authenticated:false,status:401});
    need(denied.error.code==='AUTH_REQUIRED','A cópia restaurada deve negar a consulta sem login.');
    const credentials=await readPrivateJson(join(runtime.directory,'access.json'));
    await call('/auth/login',{method:'POST',body:{email:credentials.email,password:credentials.password}});
    const orders=(await call('/orders')).data.items;
    need(orders.length===1&&orders[0].status==='delivered','O novo login deve consultar a OS restaurada.');
    await call('/auth/logout',{method:'POST',body:{}});
  } finally {await restoredApp?.close();}
  result={...result,operationMode:'parallel_readonly',recovery:{dbPath:restored,sourceSessions,sessionsRevoked:true,loginRequired:true,reloginVerified:true,integrity:'ok'}};
  await writeFile(join(runtime.directory,'smoke-result.json'),`${JSON.stringify(result,null,2)}\n`,{flag:'wx',mode:0o600});
  return result;
}

const isMain=process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href;
if(isMain){
  try {
    const [command,...args]=process.argv.slice(2);
    need(['init','check','smoke','start'].includes(command),'Use init, check, smoke ou start --dir CAMINHO_NOVO. start aceita --allow-local-writes.');
    const allowWrites=args.includes('--allow-local-writes');
    need(!allowWrites||command==='start','--allow-local-writes serve somente para start.');
    const flags=parseOptions(args.filter(value=>value!=='--allow-local-writes'),['--dir','--port']);
    const options={directory:flags['--dir'],port:flags['--port']??4179,allowWrites};
    if(command==='start') {
      const runtime=await openRehearsal(options);
      console.log(JSON.stringify({ok:true,purpose:'ENSAIO JK — NÃO OPERACIONAL',url:runtime.url,dbPath:runtime.dbPath,operationMode:runtime.operationMode,externalProviders:'disabled',accessFile:join(runtime.directory,'access.json'),stop:'Ctrl+C encerra e volta à consulta paralela; os dados são preservados.'},null,2));
      let stopping=false;
      for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{if(stopping)return;stopping=true;try{await runtime.close();}catch{console.error('Falha ao encerrar o ensaio. Confira o banco e o lock antes de reabrir.');process.exitCode=1;}});
    } else {
      const result=await ({init:prepareRehearsal,check:inspectRehearsal,smoke:runRehearsalSmoke})[command](options);
      console.log(JSON.stringify({ok:true,...result},null,2));
    }
  } catch(error){console.error(`Ensaio não concluído: ${error.code==='EACCES'||error.code==='EPERM'?'acesso local negado; use um diretório privado e permita a porta de loopback quando necessário.':error.message}`);process.exitCode=1;}
}
