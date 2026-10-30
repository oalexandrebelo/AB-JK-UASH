import {constants} from 'node:fs';
import {lstat,mkdir,open,realpath,writeFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {ApiError} from '../server/errors.mjs';
import {decodeImport,MAX_IMPORT_BYTES,sha256} from '../server/jk-migration-parse.mjs';
import {parseJkHistoryExport} from '../server/jk-history-export-parse.mjs';

export const EXPECTED_EXPORTS=Object.freeze({customers:{rows:5168,columns:9},orders:{rows:10133,columns:30,valueCents:91701808},products:{rows:3,columns:8}});
const ROOT=fileURLToPath(new URL('../',import.meta.url));
const fail=(code,message)=>{throw new ApiError(422,code,message);};
const invalid=()=>fail('INVALID_RECONCILIATION','A reconciliação contém referência, decisão ou funcionário inválido.');
const keys=(value,allowed)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))invalid();};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

/** Local analysis only: no database, HTTP, identity inference or operational writes. */
export function inspectJkReadiness(contents,{expected=EXPECTED_EXPORTS,reconciliation}={}) {
  const parsed={},exports={},snapshotHashes={};
  for(const kind of ['customers','orders','products']) {
    const file=parseJkHistoryExport({content:contents[kind]});
    if(file.kind!==kind)fail('EXPORT_KIND_MISMATCH','Um arquivo não corresponde ao tipo de exportação indicado.');
    parsed[kind]=file;snapshotHashes[kind]=file.snapshotHash;
    exports[kind]={snapshotHash:file.snapshotHash,...file.counts,...(file.totals||{}),...(file.dates?{dates:file.dates}:{})};
  }
  const native=decodeImport({source:'jumpcar',files:[{entity:'customers',format:'csv',content:contents.customers}]});
  const plates=new Map();
  for(const row of native.rows.vehicles) {
    if(!plates.has(row.value.plate))plates.set(row.value.plate,[]);
    plates.get(row.value.plate).push({customerSourceRow:row.origin.row,customerImportId:row.value.customerImportId});
  }
  const plateConflicts=[...plates].filter(([,candidates])=>candidates.length>1).map(([plate,candidates])=>({
    plateRef:`plate:${snapshotHashes.customers}:${sha256(plate).slice(0,24)}`,plate,candidates,
  }));
  const operators=new Map();let missingEntryRows=0,missingExitRows=0;
  for(const row of parsed.orders.rows)for(const [role,index] of [['entry',13],['exit',14]]) {
    const label=row.values[index];
    if(!label.trim()||label.trim()==='--'){if(role==='entry')missingEntryRows++;else missingExitRows++;continue;}
    // Exact labels remain distinct; spelling, case and whitespace never infer identity.
    if(!operators.has(label))operators.set(label,{operatorRef:`operator:${snapshotHashes.orders}:${sha256(label).slice(0,24)}`,label,entryRows:[],exitRows:[]});
    operators.get(label)[role+'Rows'].push(row.sourceRow);
  }
  const inventory={format:'ab-jk-readiness-inventory-v1',snapshotHashes,operators:[...operators.values()],plateConflicts};
  const reviewTemplate={schemaVersion:1,snapshotHashes,employees:[],operatorMappings:[],plateDecisions:[]};
  const resolvedOperators=[],reviewedPlates=new Map();
  if(reconciliation!==undefined) {
    keys(reconciliation,['schemaVersion','snapshotHashes','employees','operatorMappings','plateDecisions']);
    if(reconciliation.schemaVersion!==1)invalid();
    keys(reconciliation.snapshotHashes,['customers','orders','products']);
    if(!['customers','orders','products'].every(kind=>reconciliation.snapshotHashes[kind]===snapshotHashes[kind]))fail('RECONCILIATION_SNAPSHOT_MISMATCH','Os arquivos mudaram. Gere e revise uma nova reconciliação.');
    if(!['employees','operatorMappings','plateDecisions'].every(key=>Array.isArray(reconciliation[key])))invalid();
    const employees=new Map(),mapped=new Set(),knownOperators=new Map(inventory.operators.map(row=>[row.operatorRef,row]));
    for(const employee of reconciliation.employees) {
      keys(employee,['id','active']);
      if(typeof employee.id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/u.test(employee.id)||typeof employee.active!=='boolean'||employees.has(employee.id))invalid();
      employees.set(employee.id,employee);
    }
    for(const mapping of reconciliation.operatorMappings) {
      keys(mapping,['operatorRef','employeeId']);
      if(!knownOperators.has(mapping.operatorRef)||mapped.has(mapping.operatorRef)||employees.get(mapping.employeeId)?.active!==true)invalid();
      mapped.add(mapping.operatorRef);
      const {operatorRef,entryRows,exitRows}=knownOperators.get(mapping.operatorRef);
      resolvedOperators.push({operatorRef,employeeId:mapping.employeeId,entryRows,exitRows});
    }
    const knownPlates=new Map(plateConflicts.map(row=>[row.plateRef,row]));
    for(const decision of reconciliation.plateDecisions) {
      keys(decision,['plateRef','decision','customerSourceRow']);
      const group=knownPlates.get(decision.plateRef);
      if(!group||reviewedPlates.has(decision.plateRef)||!['hold','reviewed-owner'].includes(decision.decision))invalid();
      if(decision.decision==='hold'?decision.customerSourceRow!==null:!Number.isSafeInteger(decision.customerSourceRow)||!group.candidates.some(candidate=>candidate.customerSourceRow===decision.customerSourceRow))invalid();
      reviewedPlates.set(decision.plateRef,decision);
    }
  }
  const baselineMatches=['customers','orders','products'].every(kind=>Object.entries(expected[kind]).every(([key,value])=>exports[kind][key]===value));
  const ambiguous=native.warnings.find(warning=>warning.code==='VEHICLE_LAYOUT_REVIEW_REQUIRED')?.count||0;
  const unresolvedOperators=inventory.operators.length-resolvedOperators.length,unresolvedPlates=plateConflicts.length-reviewedPlates.size;
  const reviewComplete=baselineMatches&&!unresolvedOperators&&!unresolvedPlates;
  const report={format:'ab-jk-migration-readiness-v1',status:reviewComplete?'REVIEW_COMPLETE':'REVIEW_REQUIRED',sourceVerified:false,canCommit:false,
    baselineMatches,exports,reviewComplete,reviewScope:'operators-and-plate-conflicts',
    operationalCustomerImportBlocked:Boolean(plateConflicts.length||ambiguous),
    vehicles:{extractedEntries:native.rows.vehicles.length,ambiguousCustomerRows:ambiguous,conflictGroups:plateConflicts.length,
      conflictingEntries:plateConflicts.reduce((sum,group)=>sum+group.candidates.length,0),
      excessEntries:plateConflicts.reduce((sum,group)=>sum+group.candidates.length-1,0),
      reviewedConflictGroups:reviewedPlates.size,heldConflictGroups:[...reviewedPlates.values()].filter(row=>row.decision==='hold').length,unresolvedConflictGroups:unresolvedPlates},
    operators:{distinctLabels:inventory.operators.length,mapped:resolvedOperators.length,unresolved:unresolvedOperators,missingEntryRows,missingExitRows},
  };
  return {report,inventory,reviewTemplate,resolvedOperators};
}

const HELP=`Verificação local JK: somente leitura dos três exports nativos UTF-8, sem banco ou rede.
node scripts/jk-migration-readiness.mjs --customers /privado/clientes.xls --orders /privado/historico.xls --products /privado/produtos.xls
Adicionar --private-dir /privado/reconciliacao para criar inventário e formulário privados (não sobrescreve).
Adicionar --reconciliation /privado/review.private.json para validar decisões e IDs de funcionários fornecidos.
Saída padrão: somente hashes, contagens e estado de revisão; nunca autoriza ou executa importação.
Saídas: 0 revisão completa, 2 revisão pendente, 1 arquivo/argumento inválido.
`;
function options(argv) {
  const result={},allowed=['--customers','--orders','--products','--private-dir','--reconciliation'];
  for(let index=0;index<argv.length;index++) {
    const key=argv[index],value=argv[++index];
    if(!allowed.includes(key)||Object.hasOwn(result,key)||!value||value.startsWith('--'))fail('INVALID_ARGUMENTS','Informe os três arquivos locais. Use --help.');
    result[key]=resolve(value);
  }
  if(!['customers','orders','products'].every(kind=>result['--'+kind]))fail('INVALID_ARGUMENTS','Informe os três arquivos locais. Use --help.');
  return result;
}
async function readPrivate(path) {
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const info=await file.stat();
    if(!info.isFile()||info.size>MAX_IMPORT_BYTES)fail('INVALID_LOCAL_FILE','Use arquivo regular de texto UTF-8 de até 8 MiB, sem link simbólico.');
    try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await file.readFile());}
    catch{fail('INVALID_LOCAL_FILE','Use arquivo regular de texto UTF-8 de até 8 MiB, sem link simbólico.');}
  } finally {await file.close();}
}
async function privateOutput(directory,result) {
  const inside=(directory,root)=>directory===root||directory.startsWith(root+sep);
  if(inside(resolve(directory),resolve(ROOT)))fail('PRIVATE_OUTPUT_REQUIRED','Salve a reconciliação privada fora do repositório.');
  await mkdir(directory,{recursive:true,mode:0o700});
  const [info,actual,root]=await Promise.all([lstat(directory),realpath(directory),realpath(ROOT)]);
  if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)||inside(actual,root))fail('PRIVATE_OUTPUT_REQUIRED','Use um diretório privado fora do repositório, sem link simbólico e com permissão 0700.');
  const outputs=[['inventory.private.json',{...result.inventory,resolvedOperators:result.resolvedOperators}],['review.private.json',result.reviewTemplate]];
  for(const [name] of outputs)try{await lstat(resolve(actual,name));fail('PRIVATE_OUTPUT_EXISTS','O diretório já contém uma saída. Escolha um diretório novo.');}catch(error){if(error.code!=='ENOENT')throw error;}
  for(const [name,value] of outputs)await writeFile(resolve(actual,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
}
export async function main(argv=process.argv.slice(2),{stdout=process.stdout,stderr=process.stderr}={}) {
  try {
    if(same(argv,['--help'])){stdout.write(HELP);return 0;}
    const opts=options(argv),contents={};
    for(const kind of ['customers','orders','products'])contents[kind]=await readPrivate(opts['--'+kind]);
    let reconciliation;
    if(opts['--reconciliation']){try{reconciliation=JSON.parse(await readPrivate(opts['--reconciliation']));}catch(error){if(error instanceof ApiError)throw error;invalid();}}
    const result=inspectJkReadiness(contents,{reconciliation});
    if(opts['--private-dir'])await privateOutput(opts['--private-dir'],result);
    stdout.write(JSON.stringify(result.report,null,2)+'\n');
    return result.report.reviewComplete?0:2;
  } catch(error) {
    stderr.write(JSON.stringify({status:'REJECTED',code:error instanceof ApiError?error.code:'READINESS_FAILED',message:error instanceof ApiError?error.message:'Não foi possível verificar os arquivos locais.'})+'\n');
    return 1;
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)process.exitCode=await main();
