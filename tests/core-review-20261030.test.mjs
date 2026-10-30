import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server/application.mjs';

function response() {
  return {
    headers:{},headersSent:false,
    setHeader(key,value) { this.headers[key.toLowerCase()] = value; },
    writeHead(status,headers) { this.status=status;for(const [key,value] of Object.entries(headers))this.setHeader(key,value);this.headersSent=true; },
    end(value) { this.body=JSON.parse(value); },
    destroy() { this.destroyed=true; },
  };
}

test('two SQLite applications serialize postpaid issue, cancel, reissue and concurrent partial receipts',async t => {
  const directory = await mkdtemp(join(tmpdir(),'jk-postpaid-review-'));
  const apps = [], errors = [];
  t.after(async () => {
    for (const app of apps) await app.close();
    await rm(directory,{recursive:true,force:true});
    assert.deepEqual(errors,[],'The shared SQLite workflow must not produce an internal error');
  });
  for (let index=0;index<2;index++) apps.push(await createApplication({dbPath:join(directory,'local.sqlite'),logger:{error:value=>errors.push(value)}}));
  let cookie = '', csrf = '';
  async function call(index,path,body,{method = body === undefined ? 'GET' : 'POST',key = randomUUID(),status = 200} = {}) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method=method;req.url=`/api${path}`;
    req.headers={host:'127.0.0.1:4173','content-type':'application/json',cookie,'x-csrf-token':csrf,'idempotency-key':key};
    const res=response();await apps[index].handler(req,res);
    if(status!==null) assert.equal(res.status,status,JSON.stringify(res.body));
    return res;
  }
  const setup=await call(0,'/setup',{name:'Administrador sintético',email:'postpaid-review@example.test',password:'synthetic-postpaid-review-2026'},{status:201});
  cookie=setup.headers['set-cookie'].split(';')[0];csrf=setup.body.data.csrfToken;
  const item=async(path,body,options)=> (await call(0,path,body,options)).body.data.item;
  const create=(path,body)=>item(path,body,{status:201});
  const customer=await create('/customers',{name:'Cliente pós-pago sintético',postpaid:true});
  const vehicle=await create('/vehicles',{customerId:customer.id,plate:'TST9Z87',model:'Modelo sintético'});
  const service=await create('/services',{name:'Serviço sintético',priceCents:1000});
  let order=await create('/orders',{customerId:customer.id,vehicleId:vehicle.id,items:[{serviceId:service.id,quantity:1}]});
  for(const status of ['in_progress','quality_check','ready','delivered']) order=await item(`/orders/${order.id}/transition`,{version:order.version,status});
  const invoiceBody={customerId:customer.id,orderIds:[order.id],dueDate:'2026-11-30'};
  const issued=await Promise.all(apps.map((_,index)=>call(index,'/invoices',invoiceBody,{status:null})));
  assert.deepEqual(issued.map(result=>result.status).sort(),[201,409]);
  assert.equal(issued.find(result=>result.status===409).body.error.code,'ORDER_ALREADY_INVOICED');
  let invoice=issued.find(result=>result.status===201).body.data.item;
  const cancelled=await item(`/invoices/${invoice.id}/cancel`,{version:invoice.version});
  assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.balanceCents,0);
  assert.equal((await item(`/orders/${order.id}`)).invoiceId,null);
  invoice=await create('/invoices',invoiceBody);
  const path=`/invoices/${invoice.id}/payments`, key='postpaid-concurrent-receipt';
  const body={version:invoice.version,amountCents:400,method:'pix'};
  const receipts=await Promise.all(apps.map((_,index)=>call(index,path,body,{key})));
  assert.equal(receipts.filter(result=>result.headers['idempotency-replayed']==='true').length,1);
  assert.equal(new Set(receipts.map(result=>result.body.data.item.payments[0].id)).size,1);
  invoice=await item(`/invoices/${invoice.id}`);
  assert.equal(invoice.status,'partial');assert.equal(invoice.balanceCents,600);
  const stale=await call(1,path,body,{status:409});
  assert.equal(stale.body.error.code,'VERSION_CONFLICT');
  const ledger=async()=>{
    const result={};
    for(const table of ['payments','payment_allocations','cash_movements','audit_events','idempotency_keys']) result[table]=(await apps[0].store.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n;
    return result;
  };
  const before=await ledger();
  const noCash=await call(1,path,{version:invoice.version,amountCents:600,method:'cash'},{status:409});
  assert.equal(noCash.body.error.code,'CASH_CLOSED');
  assert.deepEqual(await ledger(),before,'A failed cash receipt must not leave an allocation, audit entry or replay response');
  const finalBody={version:invoice.version,amountCents:600,method:'transfer'};
  const finals=await Promise.all(apps.map((_,index)=>call(index,path,finalBody,{status:null})));
  assert.deepEqual(finals.map(result=>result.status).sort(),[200,409]);
  assert.equal(finals.find(result=>result.status===409).body.error.code,'VERSION_CONFLICT');
  invoice=await item(`/invoices/${invoice.id}`);
  assert.equal(invoice.status,'paid');assert.equal(invoice.balanceCents,0);
  assert.equal((await item(`/orders/${order.id}`)).balanceCents,0);
  for(const table of ['payments','payment_allocations','cash_movements']) assert.equal((await apps[0].store.prepare(`SELECT SUM(amount_cents) AS total FROM ${table}`).get()).total,1000,table);
  assert.equal((await apps[0].store.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='invoice.payment_recorded'").get()).n,2);
  assert.deepEqual(await apps[0].store.prepare('PRAGMA foreign_key_check').all(),[]);
});
