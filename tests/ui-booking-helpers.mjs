import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {fixture,until,field} from './ui-helpers.mjs';
export {until,fill,click,submit,button,field} from './ui-helpers.mjs';
export const json=data=>new Response(JSON.stringify({ok:true,data}),{headers:{'content-type':'application/json'}});
export const catalog={enabled:true,closedReasons:[],policyVersion:2,termsVersion:'test-terms',arrivalMinutesBefore:10,noShowLimit:2,services:[{id:'service-test',name:'Lavagem fictícia',category:'small',durationMinutes:40,amountCents:3000}]};
export const reservation={id:'booking-test',reference:'ABC12345',status:'holding',financialStatus:'pending',startsAt:'2031-02-10T13:00:00.000Z',endsAt:'2031-02-10T13:40:00.000Z',arrivalDeadline:'2031-02-10T12:50:00.000Z',holdExpiresAt:'2031-02-10T12:40:00.000Z',amountCents:3000,serviceName:'Lavagem fictícia',category:'small',version:1,pixCopiaECola:null,whatsappUrl:null};
export async function bookingFixture(t,{responseOverride,path='/agendar',readyText='Um horário para'}={}){
  const buildDir=process.env.BOOKING_UI_BUILD_DIR||new URL('../dist/',import.meta.url).pathname;
  const f=await fixture(t,{mountBundle:false,application:{distDir:buildDir},responseOverride});
  f.window.history.replaceState({},'',path);
  const html=await readFile(join(buildDir,'index.html'),'utf8');
  const entry=html.match(/<script[^>]+src="([^"]+)"/)?.[1];assert.ok(entry?.startsWith('/assets/'));
  await import(pathToFileURL(join(buildDir,entry)).href+'?test='+Date.now());
  await until(()=>f.text().includes(readyText),'página pública candidata');
  await until(()=>f.requests.every(row=>row.status!==undefined),'preloads locais concluídos antes do encerramento');
  return f;
}
export async function select(f,label,value){const element=field(f,label);Object.getOwnPropertyDescriptor(f.window.HTMLSelectElement.prototype,'value').set.call(element,value);element.dispatchEvent(new f.window.Event('change',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,25));}
