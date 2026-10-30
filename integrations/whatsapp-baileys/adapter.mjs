import { createHash, randomBytes } from 'node:crypto';
import { openBaileysStore } from './store.mjs';

const phone = value => typeof value==='string' && /^[1-9]\d{7,14}$/u.test(value);
const text = (value,max=4096) => typeof value==='string' && value.length>0 && value.length<=max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
const only = (value,fields) => value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).every(key=>fields.includes(key));
const reject = code => ({state:'REJECTED',data:{code,channel:'whatsapp',provider:'whatsapp-baileys'}});
const uncertain = () => ({state:'UNKNOWN',data:{code:'BAILEYS_SEND_UNCONFIRMED',channel:'whatsapp',provider:'whatsapp-baileys',delivery:'unconfirmed'}});
const silentLogger = {level:'silent',trace(){},debug(){},info(){},warn(){},error(){},fatal(){},child(){return this;}};
const terminalDisconnects = new Set([401,403,411,440,500]);
const retryDelays = [1000,2000,4000,8000,16000];

function configuration(config) {
  if(!only(config,['authDir','accountPhone','templates','sendTimeoutMs']) || !phone(config.accountPhone))throw new TypeError('INVALID_BAILEYS_CONFIG');
  const sendTimeoutMs=config.sendTimeoutMs ?? 30_000;
  if(!Number.isSafeInteger(sendTimeoutMs) || sendTimeoutMs<10 || sendTimeoutMs>60_000)throw new TypeError('INVALID_BAILEYS_TIMEOUT');
  const templates=config.templates ?? [];
  if(!Array.isArray(templates) || templates.length>100)throw new TypeError('INVALID_BAILEYS_TEMPLATES');
  const catalog=new Map();
  for(const item of templates) {
    if(!only(item,['templateName','languageCode','text']) || !/^[a-z0-9_]{1,128}$/u.test(item.templateName) || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/u.test(item.languageCode) || !text(item.text))throw new TypeError('INVALID_BAILEYS_TEMPLATES');
    const key=`${item.templateName}:${item.languageCode}`;
    if(catalog.has(key))throw new TypeError('INVALID_BAILEYS_TEMPLATES');
    const placeholders=[...item.text.matchAll(/\{\{([1-9]\d?)\}\}/gu)].map(match=>Number(match[1]));
    const count=Math.max(0,...placeholders);
    if(count>30 || Array.from({length:count},(_,i)=>i+1).some(i=>!placeholders.includes(i)) || /\{\{|\}\}/u.test(item.text.replace(/\{\{([1-9]\d?)\}\}/gu,'')))throw new TypeError('INVALID_BAILEYS_TEMPLATES');
    catalog.set(key,{text:item.text,count});
  }
  return {...config,sendTimeoutMs,catalog};
}

/** No SDK loading or network activity until the explicit connect() call. */
export async function createBaileysAdapter(config,dependencies={}) {
  const settings=configuration(config);
  const store=await openBaileysStore(settings.authDir,settings.accountPhone);
  return new BaileysWhatsAppAdapter(settings,store,dependencies);
}

export class BaileysWhatsAppAdapter {
  id='whatsapp-baileys';
  operations=['send-text','send-template'];
  #settings; #store; #env; #load; #schedule; #cancel; #onPairing; #socket; #sdk; #auth;
  #connection='disconnected'; #qr=false; #attempts=0; #timer; #closed=false; #starting; #listeners;
  #inflight=new Set(); #stop=new AbortController();
  constructor(settings,store,{env=process.env,loadBaileys=()=>import('baileys'),schedule=setTimeout,cancelSchedule=clearTimeout,onPairing}={}) {
    this.#settings=settings;this.#store=store;this.#env=env;this.#load=loadBaileys;this.#schedule=schedule;this.#cancel=cancelSchedule;this.#onPairing=onPairing;
    this.accountScope=createHash('sha256').update(JSON.stringify([this.id,settings.accountPhone])).digest('hex');
  }
  #sendEnabled(){return this.#env.AB_JK_BAILEYS_SEND_ENABLED==='true' && this.#env.AB_JK_INTEGRATIONS_ENABLED==='true' && this.#env.AB_JK_ALLOW_PRODUCTION==='true';}
  status(){return {provider:this.id,connection:this.#connection,connectionVerified:this.#connection==='connected',sendEnabled:this.#sendEnabled(),qrAvailable:this.#qr,reconnectAttempts:this.#attempts,deliveryVerified:false};}
  async connect() {
    if(this.#closed)throw new Error('BAILEYS_ADAPTER_CLOSED');
    if(this.#env.AB_JK_BAILEYS_CONNECT_ENABLED!=='true')throw new Error('BAILEYS_CONNECTION_DISABLED');
    if(this.#starting)return this.#starting;
    if(this.#socket)return this.status();
    if(['reauth-required','account-mismatch','reconnect-exhausted'].includes(this.#connection))throw new Error('BAILEYS_OPERATOR_REVIEW_REQUIRED');
    this.#starting=this.#openSocket();
    try{await this.#starting;return this.status();}finally{this.#starting=undefined;}
  }
  async #openSocket() {
    this.#connection='connecting';
    try {
      this.#sdk ??= await this.#load();
      if(this.#closed)return;
      this.#auth ??= this.#store.auth(this.#sdk);
      const socket=this.#sdk.default({auth:this.#auth.state,logger:silentLogger,markOnlineOnConnect:false,syncFullHistory:false,shouldSyncHistoryMessage:()=>false,
        getMessage:async()=>undefined,maxMsgRetryCount:0,enableRecentMessageCache:false,generateHighQualityLinkPreview:false,connectTimeoutMs:20_000,defaultQueryTimeoutMs:30_000});
      this.#socket=socket;
      const update=value=>{this.#update(socket,value).catch(()=>this.#failClosed('storage-error'));};
      const credentials=()=>{this.#auth.saveCreds().catch(()=>this.#failClosed('storage-error'));};
      socket.ev.on('connection.update',update);socket.ev.on('creds.update',credentials);
      this.#listeners={socket,update,credentials};
    }catch(error){this.#connection='connection-error';this.#detach();throw error;}
  }
  #detach() {
    const item=this.#listeners;
    if(item){item.socket.ev.off('connection.update',item.update);item.socket.ev.off('creds.update',item.credentials);this.#listeners=undefined;}
    const socket=this.#socket;this.#socket=undefined;socket?.end(new Error('BAILEYS_LOCAL_DISCONNECT'));
  }
  #failClosed(state){this.#connection=state;this.#qr=false;this.#detach();}
  async #update(socket,update) {
    if(this.#closed || socket!==this.#socket)return;
    if(update.qr) {
      this.#qr=true;
      if(this.#onPairing)await this.#onPairing({qr:update.qr});
    }
    if(update.connection==='open') {
      const identity=socket.user?.id ?? socket.authState?.creds?.me?.id;
      if(typeof identity!=='string' || identity.split('@')[0].split(':')[0]!==this.#settings.accountPhone || !identity.endsWith('@s.whatsapp.net'))return this.#failClosed('account-mismatch');
      this.#connection='connected';this.#qr=false;await this.#auth.saveCreds();
    }
    if(update.connection==='close') {
      this.#qr=false;this.#detach();
      const code=update.lastDisconnect?.error?.output?.statusCode;
      if(terminalDisconnects.has(code)){this.#connection='reauth-required';return;}
      if(this.#attempts>=retryDelays.length){this.#connection='reconnect-exhausted';return;}
      const delay=retryDelays[this.#attempts++];this.#connection='reconnecting';
      this.#timer=this.#schedule(async()=>{this.#timer=undefined;if(this.#closed)return;try{await this.connect();}catch{this.#connection='connection-error';}},delay);
    }
  }
  async requestPairingCode() {
    if(this.#closed || this.#env.AB_JK_BAILEYS_CONNECT_ENABLED!=='true')throw new Error('BAILEYS_CONNECTION_DISABLED');
    if(!this.#socket || !this.#qr || this.#auth.state.creds.registered)throw new Error('BAILEYS_PAIRING_NOT_AVAILABLE');
    return this.#socket.requestPairingCode(this.#settings.accountPhone);
  }
  #message(operation,input) {
    if(operation==='send-text') {
      if(!only(input,['to','text','previewUrl']) || !phone(input.to) || !text(input.text) || (input.previewUrl!==undefined && input.previewUrl!==false))return null;
      return {to:input.to,text:input.text,localTemplate:false};
    }
    if(operation==='send-template') {
      if(!only(input,['to','templateName','languageCode','bodyParameters']) || !phone(input.to))return null;
      const template=this.#settings.catalog.get(`${input.templateName}:${input.languageCode}`),parameters=input.bodyParameters ?? [];
      if(!template || !Array.isArray(parameters) || parameters.length!==template.count || !parameters.every(value=>text(value,1024)))return null;
      const rendered=template.text.replace(/\{\{([1-9]\d?)\}\}/gu,(_match,index)=>parameters[Number(index)-1]);
      return text(rendered) ? {to:input.to,text:rendered,localTemplate:true} : null;
    }
    return null;
  }
  async execute(operation,input,context={}) {
    const message=this.#message(operation,input);
    if(!message)return reject('INVALID_MESSAGE_INPUT');
    if(this.#closed)return reject('BAILEYS_ADAPTER_CLOSED');
    if(!this.#sendEnabled())return reject('BAILEYS_SEND_DISABLED');
    if(this.#connection!=='connected' || !this.#socket)return reject('BAILEYS_NOT_CONNECTED');
    if(context.signal?.aborted)return reject('BAILEYS_ABORTED');
    if(typeof context.idempotencyKey!=='string' || !/^[A-Za-z0-9._:-]{1,200}$/u.test(context.idempotencyKey))return reject('BAILEYS_IDEMPOTENCY_REQUIRED');
    const digest=createHash('sha256').update(JSON.stringify([operation,message.to,message.text])).digest('hex');
    const messageId=`3EB0${randomBytes(16).toString('hex').toUpperCase()}`;
    let claim;
    try { claim=this.#store.claim(context.idempotencyKey,digest,messageId); } catch {this.#failClosed('storage-error');return reject('BAILEYS_STORAGE_UNAVAILABLE');}
    if(claim.digest!==digest)return reject('BAILEYS_IDEMPOTENCY_CONFLICT');
    if(!claim.claimed)return claim.result ? JSON.parse(claim.result) : uncertain();
    const work=this.#dispatch(message,context,claim.message_id);
    this.#inflight.add(work);
    try{return await work;}finally{this.#inflight.delete(work);}
  }
  async #dispatch(message,context,messageId) {
    let timer,abort,stop,result;
    try {
      const interrupted=new Promise(resolve=>{
        abort=()=>resolve(null);stop=()=>resolve(null);
        context.signal?.addEventListener('abort',abort,{once:true});this.#stop.signal.addEventListener('abort',stop,{once:true});
        timer=setTimeout(()=>resolve(null),this.#settings.sendTimeoutMs);
      });
      if(context.signal?.aborted || this.#stop.signal.aborted)result=uncertain();
      else {
        const response=await Promise.race([this.#socket.sendMessage(`${message.to}@s.whatsapp.net`,{text:message.text,linkPreview:null},{messageId}),interrupted]);
        result=response?.key?.id===messageId ? {state:'SUCCEEDED',providerReference:`baileys:${messageId}`,data:{channel:'whatsapp',provider:this.id,acceptance:'socket-accepted',delivery:'unconfirmed',localTemplate:message.localTemplate}} : uncertain();
      }
    }catch {result=uncertain();}
    finally{clearTimeout(timer);context.signal?.removeEventListener('abort',abort);this.#stop.signal.removeEventListener('abort',stop);}
    try{this.#store.finish(context.idempotencyKey,result);}catch{this.#failClosed('storage-error');return uncertain();}
    return result;
  }
  async close() {
    if(this.#closed)return;
    this.#closed=true;this.#stop.abort();if(this.#timer)this.#cancel(this.#timer);this.#detach();this.#qr=false;this.#connection='closed';
    await this.#starting?.catch(()=>{});await Promise.allSettled([...this.#inflight]);await this.#store.close();
  }
}
