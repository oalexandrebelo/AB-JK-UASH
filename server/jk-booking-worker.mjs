import {assert} from './errors.mjs';
import {readJkTransition} from './jk-transition.mjs';
import {dueBookingPayments,reconcileBookingPixById,sweepBookingNoShows,recoverBookingChargeReferences} from './jk-booking.mjs';

// No charge creation or messages here: only authenticated reads and local state transitions.
export async function runBookingWorkerOnce(db,runtime,{onError=()=>{}}={}){
 await recoverBookingChargeReferences(db,runtime);
 const due=runtime?.pix?.enabled?await dueBookingPayments(db,runtime,{limit:10}):[];
 let checked=0,errors=0;
 for(let index=0;index<due.length;index+=2){
  const results=await Promise.allSettled(due.slice(index,index+2).map(row=>reconcileBookingPixById(db,row.id,runtime)));
  for(const result of results){if(result.status==='fulfilled')checked++;else{errors++;onError(result.reason);}}
 }
 let attendance={marked:0};
 if((await readJkTransition(db)).mode==='normal'){
  try{attendance=await sweepBookingNoShows(db,runtime,{limit:100});}
  catch(error){if(error.code!=='PARALLEL_READONLY')throw error;}
 }
 return {checked,errors,noShows:attendance.marked};
}
export function startBookingWorker(db,runtime,{intervalMs=15000,onError=()=>{}}={}){
 assert(Number.isSafeInteger(intervalMs)&&intervalMs>=1000&&intervalMs<=60000&&runtime?.attendanceAutomationReady===true,503,'BOOKING_AUTOMATION_CLOSED','Revise a configuração do processo de agendamento.');
 let stopped=false,pending=null;
 const tick=()=>{if(stopped||pending)return;pending=runBookingWorkerOnce(db,runtime,{onError}).catch(error=>{runtime.attendanceAutomationReady=false;clearInterval(timer);onError(error);}).finally(()=>{pending=null;});};
 const timer=setInterval(tick,intervalMs);timer.unref();tick();
 return {async stop(){stopped=true;clearInterval(timer);if(pending)await pending;runtime.attendanceAutomationReady=false;}};
}
