import { createHash } from 'node:crypto';
import { ApiError } from './errors.mjs';

export const ENTITIES = Object.freeze(['customers','vehicles','services','orders','orderItems','payments']);
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 20_000;
export const CUSTOMER_HEADERS = Object.freeze(['Nome','E-mail','Telefone','Situação da fatura','Data de vencimento','Valor da fatura','Veículos','Vagas','Observação']);
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key,canonical(value[key])]));
  return value;
}
export const hashObject = value => sha256(JSON.stringify(canonical(value)));
export const technicalImportId = (entity,originKey) => `jk_${entity}_${hashObject({source:'jumpcar',scope:'jk',entity,originKey}).slice(0,32)}`;
const fail = (code,message) => { throw new ApiError(422,code,message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export function onlyKeys(value,keys) {
  if (!object(value)) fail('INVALID_IMPORT_OBJECT','A importação exige um objeto JSON.');
  if (Object.keys(value).some(key => !keys.includes(key))) fail('UNSUPPORTED_IMPORT_FIELD','O conteúdo contém campos sem mapeamento. Nenhum campo desconhecido é descartado.');
}

// RFC-style CSV with explicit quoting and width checks; no formulas are evaluated.
export function parseCsv(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_IMPORT_BYTES) fail('IMPORT_TOO_LARGE','O arquivo deve conter texto de até 8 MiB.');
  content = content.replace(/^\uFEFF/u,'');
  const firstLine = content.split(/\r?\n/u,1)[0];
  const separator = firstLine.includes(';') ? ';' : ',';
  const records = []; let row = [], cell = '', state = 'start';
  const field = () => { row.push(cell); cell = ''; state = 'start'; };
  const record = () => { field(); records.push(row); row = []; if (records.length > MAX_IMPORT_ROWS + 1) fail('TOO_MANY_IMPORT_ROWS','O limite é de 20.000 linhas por importação.'); };
  for (let index = 0; index < content.length; index++) {
    const char = content[index];
    if (state === 'quoted') {
      if (char === '"') { if (content[index + 1] === '"') { cell += '"'; index++; } else state = 'closed'; }
      else cell += char;
    } else if (char === separator) field();
    else if (char === '\n') record();
    else if (char === '\r' && content[index + 1] === '\n') { index++; record(); }
    else if (state === 'closed') fail('INVALID_CSV','Há conteúdo após o fechamento de aspas no CSV.');
    else if (char === '"' && state === 'start') state = 'quoted';
    else if (char === '"' || char === '\r') fail('INVALID_CSV','Aspas ou quebras de linha inválidas no CSV.');
    else { cell += char; state = 'unquoted'; }
  }
  if (state === 'quoted') fail('INVALID_CSV','O CSV contém aspas sem fechamento.');
  if (row.length || cell.length || state !== 'start') record();
  return validateTable(records);
}

function decodeEntities(value) {
  const named = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu,(token,name) => {
    if (name[0] !== '#') return named[name.toLowerCase()] ?? token;
    const number = name[1].toLowerCase() === 'x' ? Number.parseInt(name.slice(2),16) : Number(name.slice(1));
    if (!number || number > 0x10ffff || number >= 0xd800 && number <= 0xdfff) fail('INVALID_HTML_ENTITY','O arquivo contém entidade de texto inválida.');
    return String.fromCodePoint(number);
  });
}

// Deliberately limited to a single flat HTML table. Never executes or fetches HTML.
export function parseJumpcarHtml(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_IMPORT_BYTES) fail('IMPORT_TOO_LARGE','O arquivo deve conter texto de até 8 MiB.');
  if (!/<table\b/iu.test(content)) fail('UNSUPPORTED_XLS','XLS binário e XLSX não são suportados. Exporte CSV ou uma tabela HTML.');
  const tables = [...content.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/giu)];
  if (tables.length !== 1 || (content.match(/<table\b/giu) || []).length !== 1) fail('UNSUPPORTED_HTML_TABLE','O arquivo deve conter exatamente uma tabela HTML simples.');
  const body = tables[0][1];
  if (/<(?:script|style|iframe|object|table)\b/iu.test(body) || /\b(?:colspan|rowspan)\s*=\s*["']?(?!1(?:["'\s>]|$))/iu.test(body)) fail('UNSUPPORTED_HTML_TABLE','A tabela contém estrutura ou conteúdo ativo não suportado.');
  const records = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/giu)].map(match => [...match[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/giu)].map(cell => decodeEntities(cell[1].replace(/<br\s*\/?\s*>/giu,'\n').replace(/<[^>]*>/gu,'')).trim()));
  if (records.length > MAX_IMPORT_ROWS + 1) fail('TOO_MANY_IMPORT_ROWS','O limite é de 20.000 linhas por importação.');
  return validateTable(records);
}

function validateTable(records) {
  if (records.length < 1 || !records[0].length) fail('EMPTY_IMPORT_FILE','O arquivo precisa de um cabeçalho.');
  if (new Set(records[0]).size !== records[0].length) fail('DUPLICATE_IMPORT_HEADER','O cabeçalho contém colunas duplicadas.');
  if (records.some(row => row.length !== records[0].length)) fail('INVALID_IMPORT_WIDTH','Há linhas com quantidade incorreta de colunas.');
  return records;
}

const INTEGER_FIELDS = new Set(['priceCents','durationMinutes','commissionBps','quantity','unitPriceCents','lineTotalCents','discountCents','netCents','historicalCommissionCents','subtotalCents','totalCents','amountCents']);
const BOOLEAN_FIELDS = new Set(['active','postpaid']);
function csvValue(key,value) {
  if (INTEGER_FIELDS.has(key)) { if (!/^(0|[1-9]\d*)$/u.test(value)) fail('INVALID_IMPORT_INTEGER','Os valores monetários devem ser inteiros em centavos e as quantidades devem ser inteiras.'); return Number(value); }
  if (BOOLEAN_FIELDS.has(key)) { if (!['true','false','1','0'].includes(value)) fail('INVALID_IMPORT_BOOLEAN','Use true/false ou 1/0 para campos booleanos.'); return value === 'true' || value === '1'; }
  return value;
}

export function decodeImport(input) {
  onlyKeys(input,['source','scope','mode','dataset','files','previewHash']);
  if (input.source !== 'jumpcar' || (input.scope !== undefined && input.scope !== 'jk') || (input.mode !== undefined && input.mode !== 'historical')) fail('UNSUPPORTED_IMPORT_SCOPE','Esta importação atende somente Jumpcar, cliente JK e modo histórico.');
  if (Boolean(input.dataset) === Boolean(input.files)) fail('IMPORT_INPUT_REQUIRED','Informe dataset ou files, exclusivamente.');
  const normalizedInput = {...input}; delete normalizedInput.previewHash;
  if (Buffer.byteLength(JSON.stringify(normalizedInput)) > MAX_IMPORT_BYTES) fail('IMPORT_TOO_LARGE','A importação excede 8 MiB.');
  const result = {source:'jumpcar',scope:'jk',mode:'historical',inputHash:hashObject(normalizedInput),rows:Object.fromEntries(ENTITIES.map(entity => [entity,[]])),warnings:[],snapshots:[]};
  if (input.dataset) {
    onlyKeys(input.dataset,['schemaVersion',...ENTITIES]);
    if (input.dataset.schemaVersion !== 1) fail('UNSUPPORTED_IMPORT_VERSION','Somente o contrato canônico JK schemaVersion 1 é aceito.');
    for (const entity of ENTITIES) {
      const rows = input.dataset[entity] ?? [];
      if (!Array.isArray(rows)) fail('INVALID_IMPORT_ARRAY','Cada coleção precisa ser uma lista.');
      result.rows[entity] = rows.map(value => ({value,origin:null}));
    }
  } else {
    if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > ENTITIES.length) fail('INVALID_IMPORT_FILES','Envie de um a seis arquivos.');
    const seen = new Set();
    for (const file of input.files) {
      onlyKeys(file,['entity','format','content']);
      if (!ENTITIES.includes(file.entity) || seen.has(file.entity)) fail('INVALID_IMPORT_ENTITY','Coleção inválida ou repetida.');
      seen.add(file.entity);
      if (!['csv','jumpcar-html'].includes(file.format)) fail('UNSUPPORTED_IMPORT_FORMAT','Use csv ou jumpcar-html.');
      const table = file.format === 'csv' ? parseCsv(file.content) : parseJumpcarHtml(file.content);
      const [headers,...rows] = table;
      if (file.entity === 'customers' && JSON.stringify(headers) === JSON.stringify(CUSTOMER_HEADERS)) {
        const snapshotHash = sha256(file.content);
        result.snapshots.push(snapshotHash);
        result.rows.customers = rows.map((row,index) => ({value:{sourceId:null,name:row[0],email:row[1] === '--' ? '' : row[1],phone:row[2] === '--' ? '' : row[2],notes:row[8] === '--' ? '' : row[8]},origin:{provenance:'snapshot-row',snapshotHash,row:index + 2,originKey:`snapshot:${snapshotHash}:${index + 2}`,archive:Object.fromEntries(headers.map((header,column) => [header,row[column]]))}}));
        let ambiguousVehicles = 0, shortNames = 0, extractedVehicles = 0;
        for (const [index,row] of rows.entries()) {
          if (row[0].trim().length === 1) shortNames++;
          const rawPlates = row[6].trim();
          if (!rawPlates || rawPlates === '--') continue;
          const plates = rawPlates.toUpperCase().split(/[\s,;|/]+/u).map(plate => plate.replaceAll('-',''));
          if (!plates.every(plate => /^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/u.test(plate))) { ambiguousVehicles++; continue; }
          const customerKey = `snapshot:${snapshotHash}:${index + 2}`;
          for (const plate of plates) {
            result.rows.vehicles.push({value:{sourceId:null,customerImportId:technicalImportId('customers',customerKey),plate,model:''},origin:{provenance:'snapshot-row',snapshotHash,row:index + 2,originKey:`${customerKey}:vehicle:${plate}`,derived:'native-plate'}});
            extractedVehicles++;
          }
        }
        result.warnings.push({code:'SNAPSHOT_ROW_IDENTITIES',message:'Sem IDs Jumpcar: as identidades técnicas representam arquivo e linha; nomes e telefones não são usados para deduplicar.'},{code:'SOURCE_FIELDS_ARCHIVED',message:'Faturas, vencimentos, veículos e vagas permanecem como evidência da linha original. Faturas não geram cobrança.'},{code:'CUSTOMER_DEFAULTS',message:'Tipo pessoa física e pós-pago desativado são valores operacionais iniciais, não dados verificados da origem. Datas ausentes usam a data da importação.'});
        if (shortNames) result.warnings.push({code:'LEGACY_SHORT_NAMES',count:shortNames,message:'Nomes legados de um caractere são preservados sem renomear. Revise a qualidade desses cadastros.'});
        if (extractedVehicles) result.warnings.push({code:'NATIVE_PLATES_EXTRACTED',count:extractedVehicles,message:'Placas brasileiras inequívocas foram vinculadas ao cliente da linha. Modelo vazio significa desconhecido; categoria small é um valor operacional inicial não verificado.'});
        if (ambiguousVehicles) result.warnings.push({code:'VEHICLE_LAYOUT_REVIEW_REQUIRED',count:ambiguousVehicles,message:'Linhas com veículos em formato ambíguo foram preservadas para revisão; seus veículos não foram criados.'});
      } else {
        if (file.format === 'jumpcar-html') fail('UNRECOGNIZED_JUMPCAR_HEADERS','Somente o layout nativo de clientes com nove colunas é reconhecido em HTML.');
        if (!headers.includes('sourceId')) fail('SOURCE_ID_REQUIRED','O CSV canônico exige a coluna sourceId. O layout nativo de clientes deve preservar seus nove cabeçalhos.');
        result.rows[file.entity].push(...rows.map(row => ({value:Object.fromEntries(headers.map((key,index) => [key,csvValue(key,row[index])])),origin:null})));
      }
    }
  }
  const total = Object.values(result.rows).reduce((sum,rows) => sum + rows.length,0);
  if (total < 1) fail('EMPTY_IMPORT','Nenhum registro foi fornecido.');
  if (total > MAX_IMPORT_ROWS) fail('TOO_MANY_IMPORT_ROWS','O limite total é de 20.000 registros.');
  return result;
}
