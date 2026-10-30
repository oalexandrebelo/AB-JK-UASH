import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {ARCHIVE_HEADERS} from '../server/jk-history-export-parse.mjs';
import {sha256} from '../server/jk-migration-parse.mjs';
import {inspectJkReadiness} from '../scripts/jk-migration-readiness.mjs';

const csv=(kind,rows)=>[ARCHIVE_HEADERS[kind],...rows].map(row=>row.map(cell=>'"'+String(cell).replaceAll('"','""')+'"').join(';')).join('\r\n');
const order=(number,entry,exit)=>ARCHIVE_HEADERS.orders.map(header=>({'Nº':number,'Cliente':'Cliente sintético','Data Entrada':'30/10/2026','Data Saída':'30/10/2026','Operador':entry,'Operador Saída':exit,'Desconto':'0,00','Valor':'10,01'}[header]??''));
const expected={customers:{rows:3,columns:9},orders:{rows:2,columns:30,valueCents:2002},products:{rows:1,columns:8}};
function fixture(){return {
  customers:csv('customers',[['Cliente A','private-a@example.test','','','','','ABC1D23','',''],['Cliente B','','','','','','ABC1D23','',''],['Cliente C','','','','','','formato desconhecido','','']]),
  orders:csv('orders',[order('001','Operador sintético A','Operador sintético B'),order('002','Operador sintético A','--')]),
  products:csv('products',[['Produto sintético','','','','1','0','1','L']]),
};}
function review(inspection){return {...inspection.reviewTemplate,
  employees:[{id:'employee-a',active:true},{id:'employee-b',active:true}],
  operatorMappings:inspection.inventory.operators.map((operator,index)=>({operatorRef:operator.operatorRef,employeeId:index?'employee-b':'employee-a'})),
  plateDecisions:inspection.inventory.plateConflicts.map(group=>({plateRef:group.plateRef,decision:'hold',customerSourceRow:null})),
};}

test('native exports reconcile exact counts and cents without exposing personal values in report',()=>{
  const result=inspectJkReadiness(fixture(),{expected});
  assert.equal(result.report.baselineMatches,true);
  assert.equal(result.report.exports.orders.valueCents,2002);
  assert.equal(result.report.vehicles.conflictGroups,1);
  assert.equal(result.report.vehicles.conflictingEntries,2);
  assert.equal(result.report.vehicles.ambiguousCustomerRows,1);
  assert.equal(result.report.operators.distinctLabels,2);
  assert.equal(result.report.operators.unresolved,2);
  assert.equal(result.report.canCommit,false);
  assert.equal(result.inventory.operators[0].entryRows.length,2);
  assert.doesNotMatch(JSON.stringify(result.report),/Cliente|private-a|ABC1D23|Operador sintético|employee-/u);
});
test('identical names never assign employees; only explicit snapshot-bound IDs resolve labels',()=>{
  const input=fixture(),first=inspectJkReadiness(input,{expected});
  const result=inspectJkReadiness(input,{expected,reconciliation:review(first)});
  assert.equal(result.report.operators.unresolved,0);
  assert.equal(result.report.vehicles.reviewedConflictGroups,1);
  assert.equal(result.report.vehicles.heldConflictGroups,1);
  assert.equal(result.report.reviewComplete,true);
  assert.equal(result.report.canCommit,false);
  assert.equal(result.report.operationalCustomerImportBlocked,true);
  assert.equal(result.resolvedOperators[0].employeeId,'employee-a');
  assert.equal(result.resolvedOperators[0].entryRows.length,2);
});
test('changed export cannot reuse a completed reconciliation',()=>{
  const input=fixture(),first=inspectJkReadiness(input,{expected}),reconciliation=review(first);
  assert.throws(()=>inspectJkReadiness({...input,orders:input.orders+'\r\n'},{expected,reconciliation}),{code:'RECONCILIATION_SNAPSHOT_MISMATCH'});
});
test('unknown, inactive, duplicate and fabricated employee mappings are rejected',()=>{
  const input=fixture(),first=inspectJkReadiness(input,{expected});
  for(const mutate of [
    r=>{r.operatorMappings[0].employeeId='missing';},
    r=>{r.employees[0].active=false;},
    r=>{r.operatorMappings.push({...r.operatorMappings[0]});},
    r=>{r.operatorMappings[0].operatorRef='fabricated';},
    r=>{r.employees.push({...r.employees[0]});},
    r=>{r.employees[0].id='x'.repeat(101);r.operatorMappings[0].employeeId=r.employees[0].id;},
  ]){const value=review(first);mutate(value);assert.throws(()=>inspectJkReadiness(input,{expected,reconciliation:value}),{code:'INVALID_RECONCILIATION'});}
});
test('plate decision requires one actual customer row and cannot merge rows',()=>{
  const input=fixture(),first=inspectJkReadiness(input,{expected}),value=review(first);
  value.plateDecisions[0]={plateRef:first.inventory.plateConflicts[0].plateRef,decision:'reviewed-owner',customerSourceRow:2};
  assert.equal(inspectJkReadiness(input,{expected,reconciliation:value}).report.vehicles.reviewedConflictGroups,1);
  value.plateDecisions[0].customerSourceRow=4;
  assert.throws(()=>inspectJkReadiness(input,{expected,reconciliation:value}),{code:'INVALID_RECONCILIATION'});
  value.plateDecisions[0].customerSourceRow=[2,3];
  assert.throws(()=>inspectJkReadiness(input,{expected,reconciliation:value}),{code:'INVALID_RECONCILIATION'});
});
test('baseline mismatch and missing decisions stay review-required',()=>{
  const result=inspectJkReadiness(fixture());
  assert.equal(result.report.baselineMatches,false);
  assert.equal(result.report.reviewComplete,false);
  assert.equal(result.report.status,'REVIEW_REQUIRED');
  assert.equal(result.report.vehicles.unresolvedConflictGroups,1);
});
test('wrong export kinds and unknown review fields reject instead of discarding data',()=>{
  const input=fixture();
  assert.throws(()=>inspectJkReadiness({...input,products:input.customers}),{code:'EXPORT_KIND_MISMATCH'});
  const first=inspectJkReadiness(input,{expected});
  assert.throws(()=>inspectJkReadiness(input,{expected,reconciliation:{...review(first),password:'never-accepted'}}),{code:'INVALID_RECONCILIATION'});
});
test('CLI reads exports without changing them and writes private worksheets exclusively',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'jk-readiness-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const input=Object.fromEntries(Object.entries(fixture()).map(([kind,content])=>[kind,'\uFEFF'+content])),args=[];
  for(const [kind,content] of Object.entries(input)){const file=join(directory,kind+'.csv');await writeFile(file,content,{mode:0o600});args.push('--'+kind,file);}
  const privateDir=join(directory,'private');
  const result=spawnSync(process.execPath,['scripts/jk-migration-readiness.mjs',...args,'--private-dir',privateDir],{cwd:resolve(import.meta.dirname,'..'),encoding:'utf8'});
  assert.equal(result.status,2,result.stderr);
  assert.equal(JSON.parse(result.stdout).status,'REVIEW_REQUIRED');
  for(const kind of ['customers','orders','products'])assert.equal(JSON.parse(result.stdout).exports[kind].snapshotHash,sha256(input[kind]));
  assert.doesNotMatch(result.stdout+result.stderr,/Cliente|private-a|ABC1D23|Operador sintético|jk-readiness-/u);
  for(const [kind,content] of Object.entries(input))assert.equal(await readFile(join(directory,kind+'.csv'),'utf8'),content);
  assert.equal((await stat(privateDir)).mode&0o777,0o700);
  assert.deepEqual((await readdir(privateDir)).sort(),['inventory.private.json','review.private.json']);
  for(const file of await readdir(privateDir))assert.equal((await stat(join(privateDir,file))).mode&0o777,0o600);
  const again=spawnSync(process.execPath,['scripts/jk-migration-readiness.mjs',...args,'--private-dir',privateDir],{cwd:resolve(import.meta.dirname,'..'),encoding:'utf8'});
  assert.equal(again.status,1);assert.equal(JSON.parse(again.stderr).code,'PRIVATE_OUTPUT_EXISTS');
  const forbidden=resolve(import.meta.dirname,'../evidence/private-readiness-forbidden');
  const inside=spawnSync(process.execPath,['scripts/jk-migration-readiness.mjs',...args,'--private-dir',forbidden],{cwd:resolve(import.meta.dirname,'..'),encoding:'utf8'});
  assert.equal(inside.status,1);assert.equal(JSON.parse(inside.stderr).code,'PRIVATE_OUTPUT_REQUIRED');
  await assert.rejects(stat(forbidden),{code:'ENOENT'});
});
test('CLI never echoes paths or driver errors',()=>{
  const result=spawnSync(process.execPath,['scripts/jk-migration-readiness.mjs','--customers','/missing/private-name','--orders','/missing/orders','--products','/missing/products'],{cwd:resolve(import.meta.dirname,'..'),encoding:'utf8'});
  assert.equal(result.status,1);assert.equal(JSON.parse(result.stderr).code,'READINESS_FAILED');
  assert.doesNotMatch(result.stderr,/private-name|\/missing|ENOENT|Error:|stack/u);
});
