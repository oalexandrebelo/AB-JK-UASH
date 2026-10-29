import {randomUUID} from 'node:crypto';
import {audit, idempotentWrite} from './db.mjs';
import {assert} from './errors.mjs';
import {readJson} from './http.mjs';
import {requireAuth, requireLiveRole, requireRole} from './security.mjs';
import * as validate from './validation.mjs';

const MAX_IMAGE_BYTES = 1_572_864;
const MAX_IMAGES = 8;
const ROLES = ['admin', 'manager', 'operator'];
export function initializeMedia(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS order_photos (
    id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
    mime_type TEXT NOT NULL CHECK(mime_type IN ('image/jpeg','image/png')),
    image BLOB NOT NULL CHECK(length(image) BETWEEN 20 AND 1572864),
    caption TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ) STRICT; CREATE INDEX IF NOT EXISTS order_photos_order ON order_photos(order_id,created_at);`);
}
function checkImage(bytes, mime) {
  assert(bytes.length >= 20 && bytes.length <= MAX_IMAGE_BYTES, 422, 'IMAGE_SIZE', 'A foto deve ter até 1,5 MiB.');
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  assert((mime === 'image/jpeg' && jpeg) || (mime === 'image/png' && png), 422, 'INVALID_IMAGE', 'Use uma imagem JPEG ou PNG válida.');
  let width = 0, height = 0;
  if (png) {
    assert(bytes.length >= 33 && bytes.toString('ascii',12,16) === 'IHDR', 422, 'INVALID_IMAGE', 'PNG inválido.');
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else {
    let position = 2;
    const frames = new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
    while (position + 4 <= bytes.length) {
      if (bytes[position] !== 0xff) break;
      while (position < bytes.length && bytes[position] === 0xff) position++;
      const marker = bytes[position++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (position + 2 > bytes.length) break;
      const size = bytes.readUInt16BE(position);
      if (size < 2 || position + size > bytes.length) break;
      if (frames.has(marker) && size >= 8) {height = bytes.readUInt16BE(position + 3); width = bytes.readUInt16BE(position + 5); break;}
      position += size;
    }
  }
  assert(width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 16_000_000, 422, 'IMAGE_DIMENSIONS', 'Imagem inválida ou acima do limite de 16 megapixels.');
}
function metadata(row) {
  return {id: row.id, orderId: row.order_id, mimeType: row.mime_type, bytes: row.bytes, caption: row.caption, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at};
}
async function getMetadata(db, id) { return metadata((await db.prepare('SELECT *,length(image) AS bytes FROM order_photos WHERE id=?').get(id))); }
async function order(db, id, writing = false) {
  const row = (await db.prepare('SELECT id,status FROM orders WHERE id=?').get(id));
  assert(row, 404, 'NOT_FOUND', 'Ordem de serviço não encontrada.');
  if (writing) assert(!['delivered','cancelled'].includes(row.status), 409, 'ORDER_CLOSED', 'Fotos de uma ordem encerrada não podem ser alteradas.');
  return row;
}
export async function handleMedia({request, method, pathname, session, db}) {
  const collection = pathname.match(/^\/api\/orders\/([a-zA-Z0-9_-]+)\/photos$/u);
  const single = pathname.match(/^\/api\/order-photos\/([a-zA-Z0-9_-]+)$/u);
  if (!collection && !single) return null;
  requireAuth(session);
  if (collection && method === 'GET') {
    (await order(db, collection[1]));
    return {data: {items: (await db.prepare('SELECT id,order_id,mime_type,length(image) AS bytes,caption,version,created_at,updated_at FROM order_photos WHERE order_id=? ORDER BY created_at,id').all(collection[1])).map(metadata)}};
  }
  if (single && method === 'GET') {
    const row = (await db.prepare('SELECT *,length(image) AS bytes FROM order_photos WHERE id=?').get(single[1]));
    assert(row, 404, 'NOT_FOUND', 'Foto não encontrada.');
    return {data: {item: {...metadata(row), dataUri: `data:${row.mime_type};base64,${Buffer.from(row.image).toString('base64')}`}}};
  }
  if (collection && method === 'POST') {
    const actor = requireRole(session, ROLES);
    const body = validate.object(await readJson(request, 2_200_000));
    validate.onlyKeys(body, ['mimeType','dataBase64','caption']);
    const mime = validate.choice(body.mimeType, 'mimeType', ['image/jpeg','image/png']);
    const caption = validate.text(body.caption, 'caption', {optional:true, max:500});
    assert(typeof body.dataBase64 === 'string' && body.dataBase64.length <= 2_097_152 && /^[A-Za-z0-9+/]+={0,2}$/u.test(body.dataBase64), 422, 'INVALID_IMAGE', 'Conteúdo de imagem inválido.');
    const bytes = Buffer.from(body.dataBase64, 'base64');
    assert(bytes.toString('base64') === body.dataBase64, 422, 'INVALID_IMAGE', 'Codificação de imagem inválida.');
    checkImage(bytes, mime);
    const result = (await idempotentWrite(db, {actorId:actor.id,key:request.headers['idempotency-key'],method,path:pathname,body,authorize:async ()=>(await requireLiveRole(db,session,ROLES))}, async () => {
      (await order(db, collection[1], true));
      assert((await db.prepare('SELECT COUNT(*) AS count FROM order_photos WHERE order_id=?').get(collection[1])).count < MAX_IMAGES, 409, 'PHOTO_LIMIT', 'O limite é de oito fotos por ordem de serviço.');
      const id = randomUUID(), now = new Date().toISOString();
      (await db.prepare('INSERT INTO order_photos(id,order_id,mime_type,image,caption,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id,collection[1],mime,bytes,caption,actor.id,now,now));
      (await audit(db,{actorId:actor.id,action:'order.photo_added',resourceType:'order',resourceId:collection[1],metadata:{photoId:id,bytes:bytes.length,mimeType:mime}}));
      return {item:(await getMetadata(db,id))};
    }));
    return {status:201,data:result};
  }
  if (single && method === 'PATCH') {
    const actor = requireRole(session, ROLES);
    const body = validate.object(await readJson(request));
    validate.onlyKeys(body,['version','caption']);
    const version = validate.integer(body.version,'version',{min:1});
    const caption = validate.text(body.caption,'caption',{max:500});
    const result = (await idempotentWrite(db,{actorId:actor.id,key:request.headers['idempotency-key'],method,path:pathname,body,authorize:async ()=>(await requireLiveRole(db,session,ROLES))},async () => {
      const row = (await db.prepare('SELECT order_id,version FROM order_photos WHERE id=?').get(single[1]));
      assert(row,404,'NOT_FOUND','Foto não encontrada.'); (await order(db,row.order_id,true));
      assert(row.version === version,409,'VERSION_CONFLICT','A foto foi atualizada por outra pessoa. Atualize a página.');
      (await db.prepare('UPDATE order_photos SET caption=?,version=version+1,updated_at=? WHERE id=?').run(caption,new Date().toISOString(),single[1]));
      (await audit(db,{actorId:actor.id,action:'order.photo_caption_updated',resourceType:'order',resourceId:row.order_id,metadata:{photoId:single[1]}}));
      return {item:(await getMetadata(db,single[1]))};
    }));
    return {data:result};
  }
  assert(false,405,'METHOD_NOT_ALLOWED','Método não permitido.');
}
