import {readPrivateFile} from '../integrations/jk/vendor/integrations/secrets.mjs';
import {parseJkConfiguration} from '../integrations/jk/runtime.mjs';
import {recordBookingAdvance} from './jk-booking-fulfillment.mjs';
import {createAsaasBookingGateway} from '../integrations/jk/booking-pix.mjs';

/** Disabled by default; reuses the configured provider and the existing private secret directory. */
export async function createJkBookingRuntime(db,{env=process.env,integrations,now=Date.now,receiptRegistryReady=false,financialLedgerReady=false,gatewayFactory=createAsaasBookingGateway}={}){
 const runtime={now,secret:null,pix:{enabled:false},otp:{enabled:false},receiptRegistryReady,financialLedgerReady,attendanceAutomationReady:false,configurationError:null};
 runtime.recordBookingAdvance=(store,input)=>recordBookingAdvance(store,input,{scope:runtime.pix.scope,environment:runtime.pix.environment});
 if(db.mode!=='local'||env.AB_JK_BOOKING_ENABLED!=='true')return runtime;
 try{
  if(env.AB_JK_INTEGRATIONS_ENABLED!=='true'||env.AB_JK_ALLOW_PRODUCTION!=='true')throw new Error('BOOKING_EXTERNAL_EFFECTS_DISABLED');
  const root=env.AB_JK_SECRETS_ROOT;
  runtime.secret=await readPrivateFile(root,env.AB_JK_BOOKING_SECRET_FILE,128);
  if(runtime.secret.length<32)throw new Error('BOOKING_SECRET_INVALID');
  const bytes=await readPrivateFile(root,env.AB_JK_INTEGRATIONS_CONFIG,64*1024);
  const config=parseJkConfiguration(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
  const entry=config.integrations.find(value=>value.kind==='pix-asaas');
  if(!entry||entry.environment!=='production')throw new Error('BOOKING_ASAAS_REQUIRED');
  runtime.pix=await gatewayFactory(db,entry,{secretsRoot:root,enabled:true,allowProduction:true,now});
  const template=env.AB_JK_BOOKING_OTP_TEMPLATE;
  const language=env.AB_JK_BOOKING_OTP_LANGUAGE;
  if(typeof template!=='string'||typeof language!=='string'||!/^[a-z0-9_]{1,100}$/u.test(template)||!/^[a-z]{2,3}(?:_[A-Z]{2})?$/u.test(language))throw new Error('BOOKING_TEMPLATE_INVALID');
  runtime.otp={
   get enabled(){integrations?.refresh?.();return integrations?.channels?.whatsapp?.state==='ready'&&integrations.channels.whatsapp.environment==='production'&&integrations.channels.whatsapp.provider==='whatsapp-baileys'&&integrations.adapters.has('whatsapp');},
   async send({phone,code,challengeId}){
    if(!this.enabled)throw new Error('BOOKING_WHATSAPP_UNAVAILABLE');
    const result=await integrations.adapters.get('whatsapp').execute('send-template',{to:phone.replace(/^\+/,''),templateName:template,languageCode:language,bodyParameters:[code]},
     {signal:AbortSignal.timeout(10_000),idempotencyKey:`jk-booking-otp:${challengeId}`});
    return {accepted:result?.state==='SUCCEEDED'};
   },
  };
 }catch{runtime.secret=null;runtime.pix={enabled:false};runtime.otp={enabled:false};runtime.configurationError='BOOKING_CONFIGURATION_UNAVAILABLE';}
 return runtime;
}
