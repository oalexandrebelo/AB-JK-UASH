import {useRef,useState} from 'react';
export type BookingService={id:string;name:string;category:string;durationMinutes:number;amountCents:number};
export type BookingCatalog={enabled:boolean;closedReasons:string[];policyVersion:number;termsVersion:string;arrivalMinutesBefore:10;noShowLimit:2;services:BookingService[]};
export type BookingAvailability={date:string;timezone:string;closedReasons:string[];slots:{startsAt:string;endsAt:string;remaining:number}[]};
export type Reservation={id:string;reference:string;status:'holding'|'awaiting_payment'|'confirmed'|'arrived'|'no_show'|'cancelled'|'expired';financialStatus:'pending'|'received'|'review'|'refund_pending'|'refunded';startsAt:string;endsAt:string;holdExpiresAt:string;arrivalDeadline:string;amountCents:number;serviceName:string;category:string;version:number;pixCopiaECola:string|null;whatsappUrl:string|null};
export type StaffReservation=Reservation&{orderId?:string|null};
const messages:Record<string,string>={BOOKING_CLOSED:'A agenda online está indisponível neste momento. Você pode falar com a equipe.',OTP_INVALID:'O código não foi aceito. Confira os seis dígitos ou solicite outro código.',TOO_MANY_ATTEMPTS:'Houve muitas tentativas. Aguarde antes de tentar novamente.',IDENTITY_REQUIRED:'Confirme novamente seu WhatsApp para continuar.',BOOKING_BLOCKED:'Novas reservas online estão suspensas para este contato. Fale com a equipe para revisar o registro.',SLOT_UNAVAILABLE:'Esse horário deixou de estar disponível. Consulte os horários novamente.',POLICY_CHANGED:'As condições da agenda mudaram. Atualize os serviços e confira as condições antes de continuar.',RESERVATION_REQUIRED:'Não foi possível acessar a reserva nesta sessão. Fale com a equipe usando a referência que você recebeu.',VERSION_CONFLICT:'A reserva foi atualizada. Consulte a situação atual antes de continuar.',PAYMENT_REVIEW:'O pagamento está em conferência. Evite pagar novamente e fale com a equipe.'};
export class BookingError extends Error {code:string;constructor(code:string,message:string){super(message);this.code=code;}}
export async function bookingRequest<T>(path:string,{method='GET',body,token,key,signal}:{method?:string;body?:unknown;token?:string;key?:string;signal?:AbortSignal}={}):Promise<T>{
  let response:Response;
  try {response=await fetch('/api/public/booking'+path,{method,credentials:'same-origin',redirect:'error',cache:'no-store',signal,headers:{Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'}),...(token?{Authorization:`Bearer ${token}`} :{}),...(key?{'Idempotency-Key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});}catch{throw new BookingError('NETWORK_ERROR','Não foi possível consultar a agenda. Confira sua conexão; se o pagamento já foi feito, consulte a situação antes de tentar outra vez.');}
  let result:{ok?:boolean;data?:T;error?:{code?:string}};
  try {result=await response.json();}catch{throw new BookingError('INVALID_RESPONSE','A resposta não pôde ser conferida. Tente consultar a situação novamente.');}
  if(!response.ok||!result.ok){const code=result.error?.code||'REQUEST_FAILED';throw new BookingError(code,messages[code]||'Não foi possível concluir esta etapa. Confira os dados e tente novamente.');}
  return result.data as T;
}
/** A failed mutation keeps its key while the exact request remains unchanged. */
export function useBookingAction(){
  const attempt=useRef<{signature:string;key:string}|null>(null);const inFlight=useRef(false);
  const [pending,setPending]=useState(false);const [error,setError]=useState<string|null>(null);
  async function run<T>(path:string,body:unknown,token?:string):Promise<T|null>{
    if(inFlight.current)return null;inFlight.current=true;
    const signature=JSON.stringify([path,body,token]);if(attempt.current?.signature!==signature)attempt.current={signature,key:crypto.randomUUID()};
    setPending(true);setError(null);
    try {const value=await bookingRequest<T>(path,{method:'POST',body,token,key:attempt.current.key});attempt.current=null;return value;}catch(cause){setError(cause instanceof Error?cause.message:'Não foi possível continuar.');return null;}finally{inFlight.current=false;setPending(false);}
  }
  return {run,pending,error,setError};
}
export const categoryNames:Record<string,string>={small:'Pequeno',medium:'Médio',large:'Grande',motorcycle:'Moto'};
export const bookingDate=(value:string,timezone='America/Sao_Paulo')=>new Intl.DateTimeFormat('pt-BR',{timeZone:timezone,dateStyle:'short',timeStyle:'short'}).format(new Date(value));
export function safeWhatsAppUrl(value:string|null){try{const url=new URL(value||'');return url.protocol==='https:'&&['wa.me','api.whatsapp.com'].includes(url.hostname)?url.href:null;}catch{return null;}}
