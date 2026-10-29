import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createTestApplication as createApplication} from './database-fixture.mjs';

test('fotos autenticadas persistem no SQLite com idempotência, limites e bloqueio após entrega',async () => {
  const dir=await mkdtemp(join(tmpdir(),'ab-uash-media-'));
  const app=await createApplication({dbPath:join(dir,'test.sqlite'),logger:{error(){}}});
  let cookie='',csrf='';
  try {
    const address=await app.listen({port:0}),base=`http://127.0.0.1:${address.port}`;
    async function api(path,body,options={}) {
      const response=await fetch(base+path,{method:body?'POST':'GET',headers:{Origin:base,...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json','X-CSRF-Token':csrf,'Idempotency-Key':options.key||randomUUID()}:{}),...options.headers},...(body?{body:JSON.stringify(body)}:{})});
      if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
      const result=await response.json();
      return {status:response.status,...result};
    }
    const setup=await api('/api/setup',{name:'Administrador teste',email:'media@example.invalid',password:randomUUID()});csrf=setup.data.csrfToken;
    const customer=await api('/api/customers',{name:'Cliente sintético'});
    const vehicle=await api('/api/vehicles',{customerId:customer.data.item.id,plate:'TST0A01',model:'Veículo teste'});
    const service=await api('/api/services',{name:'Serviço de teste',priceCents:0});
    const created=await api('/api/orders',{customerId:customer.data.item.id,vehicleId:vehicle.data.item.id,items:[{serviceId:service.data.item.id,quantity:1}]});
    assert.equal(created.status,201);
    const orderId=created.data.item.id,path=`/api/orders/${orderId}/photos`;
    const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=';
    const body={mimeType:'image/png',dataBase64:png,caption:'Avaria de teste'},key=randomUUID();
    const saved=await api(path,body,{key});assert.equal(saved.status,201);
    const replay=await api(path,body,{key});assert.equal(replay.status,201);assert.equal(replay.data.item.id,saved.data.item.id);
    assert.equal((await api(path)).data.items.length,1);
    const photo=await api(`/api/order-photos/${saved.data.item.id}`);assert.equal(photo.data.item.dataUri,`data:image/png;base64,${png}`);
    const unauthorized=await fetch(`${base}/api/order-photos/${saved.data.item.id}`);assert.equal(unauthorized.status,401);
    assert.equal((await api(path,{mimeType:'image/svg+xml',dataBase64:Buffer.from('<svg><script>bad()</script></svg>').toString('base64')})).status,422);
    for(let i=1;i<8;i++)assert.equal((await api(path,body)).status,201);
    assert.equal((await api(path,body)).status,409);
    const imageRow=(await app.store.prepare('SELECT image FROM order_photos WHERE id=?').get(saved.data.item.id));assert.equal(Buffer.from(imageRow.image).toString('base64'),png);
    const second=await api('/api/orders',{customerId:customer.data.item.id,vehicleId:vehicle.data.item.id,items:[{serviceId:service.data.item.id,quantity:1}]});
    (await app.store.prepare("UPDATE orders SET status='delivered',delivered_at=? WHERE id=?").run(new Date().toISOString(),second.data.item.id));
    assert.equal((await api(`/api/orders/${second.data.item.id}/photos`,body)).status,409);
  } finally {await app.close();await rm(dir,{recursive:true,force:true});}
});
