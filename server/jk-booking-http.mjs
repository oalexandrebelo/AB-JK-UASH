import {assert} from './errors.mjs';
import {readJson} from './http.mjs';
import {requireRole,requireLiveRole,verifyCsrf,createRateLimiter,tokenHash} from './security.mjs';
import {assertJkMutationAllowed,readJkTransition} from './jk-transition.mjs';
import {previewBookingFulfillment,commitBookingFulfillment,bookingAdvanceRows} from './jk-booking-fulfillment.mjs';
import * as booking from './jk-booking.mjs';
import {requestBookingOtp,verifyBookingOtp,bookingKeys} from './jk-booking-identity.mjs';

const PUBLIC='/api/public/booking';
const ADMIN='/api/jk/booking';
const answer=data=>({data,headers:{'Cache-Control':'no-store'}});
function bearer(request){const value=request.headers.authorization;assert(typeof value==='string'&&/^Bearer [A-Za-z0-9_-]{43}$/u.test(value),401,'IDENTITY_REQUIRED','Confirme seu contato para continuar.');return value.slice(7);}
function key(request){const value=request.headers['idempotency-key'];assert(typeof value==='string'&&/^[A-Za-z0-9_-]{8,128}$/u.test(value),400,'IDEMPOTENCY_KEY_REQUIRED','Use a identificação desta tentativa para continuar.');return value;}
async function body(request,keys){const value=await readJson(request,16*1024);bookingKeys(value,keys);return value;}
function pageQuery(url){const values=Object.fromEntries(url.searchParams);for(const field of ['limit','offset'])if(values[field]!==undefined){assert(/^\d{1,8}$/u.test(values[field]),422,'INVALID_INPUT','Revise a página solicitada.');values[field]=Number(values[field]);}return values;}

/** Public booking authentication is a separate bearer identity; staff cookies grant no customer access. */
export async function handleJkPublicBooking(ctx){
 if(!ctx.pathname.startsWith(PUBLIC+'/'))return null;
 assert(ctx.db.mode==='local',503,'BOOKING_CLOSED','A agenda online está indisponível nesta instalação.');
 const {request,method,pathname,url,db,jkBooking:runtime}=ctx;
 if(method==='GET'&&pathname===PUBLIC+'/catalog'){
  const value=await booking.bookingCatalog(db,runtime),transition=await readJkTransition(db);
  if(transition.mode!=='normal'){value.enabled=false;value.closedReasons=[...value.closedReasons,'PARALLEL_READONLY'];}
  return answer(value);
 }
 if(method==='GET'&&pathname===PUBLIC+'/availability'){
  const transition=await readJkTransition(db);
  if(transition.mode!=='normal')return answer({date:url.searchParams.get('date'),timezone:'America/Sao_Paulo',closedReasons:['PARALLEL_READONLY'],slots:[]});
  return answer(await booking.bookingAvailability(db,Object.fromEntries(url.searchParams),runtime));
 }
 if(method==='GET'&&pathname===PUBLIC+'/reservation')return answer(await booking.getBookingReservation(db,bearer(request),runtime));
 if(method==='GET'&&pathname===PUBLIC+'/reservations')return answer(await booking.listOwnBookingReservations(db,{...pageQuery(url),identityToken:bearer(request)},runtime));
 assert(method==='POST',404,'NOT_FOUND','Recurso não encontrado.');
 if([PUBLIC+'/holds',PUBLIC+'/reservation/pix'].includes(pathname))await assertJkMutationAllowed(db,method,pathname);
 const clientKey=ctx.bookingClientKey;
 await createRateLimiter(db,{maximum:60,windowMs:60_000}).reserve([`booking-http:${clientKey}`]);
 if(pathname===PUBLIC+'/identity/request')return answer(await requestBookingOtp(db,{...await body(request,['phone']),clientKey},runtime));
 if(pathname===PUBLIC+'/identity/verify')return answer(await verifyBookingOtp(db,await body(request,['challengeId','code']),runtime));
 if(pathname===PUBLIC+'/holds')return answer(await booking.createBookingHold(db,{...await body(request,['serviceId','category','startsAt','policyVersion','termsVersion','attendanceAccepted']),identityToken:bearer(request),idempotencyKey:key(request)},runtime));
 if(pathname===PUBLIC+'/reservation/pix')return answer(await booking.createBookingPix(db,{...await body(request,['customerInput']),reservationToken:bearer(request)},runtime));
 if(pathname===PUBLIC+'/reservation/cancel')return answer(await booking.cancelBookingReservation(db,{...await body(request,['version']),reservationToken:bearer(request)},runtime));
 if(pathname===PUBLIC+'/reservation/reconcile'){
  await body(request,[]);const token=bearer(request);
  await createRateLimiter(db,{maximum:4,windowMs:60_000}).reserve([`booking-poll:${tokenHash(token)}`]);
  return answer(await booking.reconcileBookingPix(db,{reservationToken:token},runtime));
 }
 assert(false,404,'NOT_FOUND','Recurso não encontrado.');
}

export async function handleJkBookingAdmin(ctx){
 if(!ctx.pathname.startsWith(ADMIN+'/'))return null;
 const {request,method,pathname,url,db,jkBooking:runtime,session}=ctx;
 assert(db.mode==='local',503,'BOOKING_CLOSED','A agenda online está indisponível nesta instalação.');
 const actor=requireRole(session,['admin','manager','operator']);await requireLiveRole(db,session,['admin','manager','operator']);
 if(method==='GET'&&pathname===ADMIN+'/policy')return answer(await booking.bookingPolicy(db,runtime));
 const authorization={actorId:actor.id,authorize:()=>requireLiveRole(db,session,['admin','manager','operator'])};
 if(method==='GET'&&pathname===ADMIN+'/reservations'){
  const result=await booking.listAdminBookingReservations(db,pageQuery(url),authorization,runtime);
  const ids=result.items.map(item=>item.id),links=ids.length?await db.prepare(`SELECT booking_id,order_id FROM jk_booking_advances WHERE booking_id IN (${ids.map(()=>'?').join(',')})`).all(...ids):[];
  const byBooking=new Map(links.map(row=>[row.booking_id,row.order_id]));
  return answer({...result,items:result.items.map(item=>({...item,orderId:byBooking.get(item.id)||null}))});
 }
 if(method==='GET'&&pathname===ADMIN+'/advances'){
  requireRole(session,['admin','manager']);await requireLiveRole(db,session,['admin','manager']);
  return answer(await bookingAdvanceRows(db,pageQuery(url)));
 }
 verifyCsrf(request,session);
 if(method==='POST'&&[ADMIN+'/fulfillment/preview',ADMIN+'/fulfillment/commit'].includes(pathname)){
  const input=await readJson(request,16*1024);
  return answer(await (pathname.endsWith('/commit')?commitBookingFulfillment(db,input,{...authorization,idempotencyKey:key(request)}):previewBookingFulfillment(db,input,authorization)));
 }
 if(method==='PUT'&&pathname===ADMIN+'/policy'){
  requireRole(session,['admin']);await requireLiveRole(db,session,['admin']);
  return answer(await booking.configureJkBooking(db,await readJson(request,32*1024),{actorId:actor.id,authorize:()=>requireLiveRole(db,session,['admin'])},runtime));
 }
 const match=pathname.match(/^\/api\/jk\/booking\/reservations\/([a-zA-Z0-9_-]+)\/(check-in|no-show|reverse-no-show)$/u);
 if(method==='POST'&&match){
  await assertJkMutationAllowed(db,method,pathname);
  const input={...await body(request,['version','reason']),bookingId:match[1]};
  if(match[2]==='reverse-no-show')return answer(await booking.reverseBookingNoShow(db,input,{actorId:actor.id,authorize:()=>requireLiveRole(db,session,['admin'])},runtime));
  return answer(await booking.recordBookingAttendance(db,{...input,action:match[2]==='check-in'?'arrived':'no_show'},authorization,runtime));
 }
 assert(false,404,'NOT_FOUND','Recurso não encontrado.');
}
