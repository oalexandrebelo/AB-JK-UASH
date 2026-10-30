import {randomBytes,randomInt,randomUUID,createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {transaction} from './db.mjs';
import {assert,ApiError} from './errors.mjs';

export const bookingNow=runtime=>runtime?.now?.()??Date.now();
export const bookingHash=value=>createHash('sha256').update(value).digest('hex');
export function bookingKeys(input,keys){assert(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).every(key=>keys.includes(key)),422,'INVALID_INPUT','Revise os campos enviados.');}
export function bookingSecret(runtime){assert(Buffer.isBuffer(runtime?.secret)&&runtime.secret.length>=32,503,'BOOKING_CLOSED','A verificação de identidade ainda não está disponível.');return runtime.secret;}
export const bookingMac=(runtime,value)=>createHmac('sha256',bookingSecret(runtime)).update(value).digest('hex');
export function bookingPhone(phone){assert(typeof phone==='string'&&/^\+[1-9]\d{7,14}$/u.test(phone),422,'INVALID_PHONE','Informe o telefone com código do país, como +5511999999999.');return phone;}
function otpReady(runtime){bookingSecret(runtime);assert(runtime?.otp?.enabled===true&&typeof runtime.otp.send==='function',503,'BOOKING_CLOSED','A verificação de identidade ainda não está disponível.');}
export function initializeBookingIdentity(raw){transaction(raw,()=>raw.exec(`
 CREATE TABLE IF NOT EXISTS jk_booking_identities(id TEXT PRIMARY KEY,phone TEXT NOT NULL UNIQUE,verified_at TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT;
 CREATE TABLE IF NOT EXISTS jk_booking_identity_sessions(token_hash TEXT PRIMARY KEY,identity_id TEXT NOT NULL REFERENCES jk_booking_identities(id),expires_at INTEGER NOT NULL) STRICT;
 CREATE TABLE IF NOT EXISTS jk_booking_challenges(id TEXT PRIMARY KEY,phone TEXT NOT NULL,code_digest TEXT NOT NULL,client_digest TEXT NOT NULL,expires_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),state TEXT NOT NULL CHECK(state IN ('sending','sent','failed','used')),created_at INTEGER NOT NULL) STRICT;
 CREATE INDEX IF NOT EXISTS jk_booking_challenge_phone ON jk_booking_challenges(phone,created_at);
 CREATE INDEX IF NOT EXISTS jk_booking_challenge_client ON jk_booking_challenges(client_digest,created_at);
 `));}

export async function requestBookingOtp(db,input,runtime){
 bookingKeys(input,['phone','clientKey']);otpReady(runtime);const phone=bookingPhone(input.phone);
 assert(typeof input.clientKey==='string'&&input.clientKey.length>0&&input.clientKey.length<=200,422,'INVALID_INPUT','Origem da solicitação ausente.');
 const now=bookingNow(runtime),id=randomUUID(),code=String(randomInt(0,1000000)).padStart(6,'0'),client=bookingMac(runtime,'client:'+input.clientKey);
 await db.transaction(async()=>{
  const byPhone=await db.prepare('SELECT count(*) n FROM jk_booking_challenges WHERE phone=? AND created_at>?').get(phone,now-15*60000);
  const byClient=await db.prepare('SELECT count(*) n FROM jk_booking_challenges WHERE client_digest=? AND created_at>?').get(client,now-15*60000);
  assert(byPhone.n<3&&byClient.n<10,429,'TOO_MANY_ATTEMPTS','Aguarde quinze minutos antes de pedir outro código.');
  await db.prepare("INSERT INTO jk_booking_challenges(id,phone,code_digest,client_digest,expires_at,state,created_at) VALUES(?,?,?,?,?,'sending',?)").run(id,phone,bookingMac(runtime,`otp:${id}:${phone}:${code}`),client,now+5*60000,now);
 });
 try{const sent=await runtime.otp.send({phone,code,challengeId:id,expiresAt:now+5*60000});assert(sent?.accepted===true,503,'OTP_UNAVAILABLE','Não foi possível enviar o código.');}
 catch{await db.prepare("UPDATE jk_booking_challenges SET state='failed' WHERE id=?").run(id);throw new ApiError(503,'OTP_UNAVAILABLE','Não foi possível enviar o código. Tente novamente mais tarde.');}
 await db.prepare("UPDATE jk_booking_challenges SET state='sent' WHERE id=? AND state='sending'").run(id);
 return {challengeId:id,expiresAt:new Date(now+5*60000).toISOString()};
}

export async function verifyBookingOtp(db,input,runtime){
 bookingKeys(input,['challengeId','code']);otpReady(runtime);
 assert(typeof input.challengeId==='string'&&input.challengeId.length<=80&&typeof input.code==='string'&&/^\d{6}$/u.test(input.code),401,'OTP_INVALID','O código está incorreto ou expirou.');
 const now=bookingNow(runtime);
 const result=await db.transaction(async()=>{
  const row=await db.prepare('SELECT * FROM jk_booking_challenges WHERE id=?').get(input.challengeId);
  if(!row||row.state!=='sent'||row.expires_at<=now||row.attempts>=5)return null;
  await db.prepare('UPDATE jk_booking_challenges SET attempts=attempts+1 WHERE id=?').run(row.id);
  if(!timingSafeEqual(Buffer.from(row.code_digest,'hex'),Buffer.from(bookingMac(runtime,`otp:${row.id}:${row.phone}:${input.code}`),'hex')))return null;
  await db.prepare("UPDATE jk_booking_challenges SET state='used' WHERE phone=? AND state='sent'").run(row.phone);
  await db.prepare('INSERT INTO jk_booking_identities(id,phone,verified_at,created_at) VALUES(?,?,?,?) ON CONFLICT(phone) DO UPDATE SET verified_at=excluded.verified_at').run(randomUUID(),row.phone,new Date(now).toISOString(),now);
  const identity=await db.prepare('SELECT * FROM jk_booking_identities WHERE phone=?').get(row.phone);
  const token=randomBytes(32).toString('base64url'),expires=now+2*3600000;
  await db.prepare('INSERT INTO jk_booking_identity_sessions VALUES(?,?,?)').run(bookingHash(token),identity.id,expires);
  const exists=await db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='jk_booking_strikes'").get();
  const strikes=exists?await db.prepare('SELECT count(*) n FROM jk_booking_strikes WHERE identity_id=? AND active=1').get(identity.id):{n:0};
  return {identityToken:token,expiresAt:new Date(expires).toISOString(),blocked:strikes.n>=2};
 });
 assert(result,401,'OTP_INVALID','O código está incorreto ou expirou.');return result;
}

export async function requireBookingIdentity(db,token,runtime){
 assert(typeof token==='string'&&/^[A-Za-z0-9_-]{43}$/u.test(token),401,'IDENTITY_REQUIRED','Confirme seu telefone para reservar.');
 const row=await db.prepare('SELECT i.* FROM jk_booking_identity_sessions s JOIN jk_booking_identities i ON i.id=s.identity_id WHERE s.token_hash=? AND s.expires_at>?').get(bookingHash(token),bookingNow(runtime));
 assert(row,401,'IDENTITY_REQUIRED','Confirme seu telefone para reservar.');return row;
}
