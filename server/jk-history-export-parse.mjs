import {assert} from './errors.mjs';
import {parseCsv,CUSTOMER_HEADERS,MAX_IMPORT_BYTES,sha256,onlyKeys} from './jk-migration-parse.mjs';

export const ARCHIVE_HEADERS = Object.freeze({
  orders:Object.freeze(['Nº','Cliente','Telefone','Email','Placa','Modelo','Cor','Cartão','Data Entrada','Hora Entrada','Data Saída','Hora Saída','Permanência','Operador','Operador Saída','Cobrança','Serviços','Produtos','Pagamento','Observação','Desconto','Valor','Período','Total de OS alterada','Total de OS paga','Total de OS cancelada','Total de OS','Total de OS isenta','Período total','Período médio']),
  customers:CUSTOMER_HEADERS,
  products:Object.freeze(['Nome','Marca','Categoria do Produto','Aplicação do Produto','Estoque Consumo Atual','Estoque Consumo Mínimo','Qnd. und. de medida por item','Unidade de medida']),
});
export function archiveKind(kind='orders') {
  assert(Object.hasOwn(ARCHIVE_HEADERS,kind),422,'INVALID_ARCHIVE_KIND','Selecione orders, customers ou products.');
  return kind;
}
function money(value) {
  const text=value.trim().replace(/^R\$\s*/u,'');
  assert(/^(?:\d+|\d{1,3}(?:\.\d{3})+),\d{2}$/u.test(text),422,'INVALID_ARCHIVE_MONEY','O arquivo contém valor monetário sem representação exata em centavos.');
  const cents=Number(text.replaceAll('.','').replace(',',''));
  assert(Number.isSafeInteger(cents),422,'INVALID_ARCHIVE_MONEY','O valor monetário excede o limite numérico.');
  return cents;
}
function date(value) {
  const match=/^(\d{2})\/(\d{2})\/(\d{4})$/u.exec(value);
  assert(match,422,'INVALID_ARCHIVE_DATE','Uma data do histórico não está no formato dia/mês/ano.');
  const iso=`${match[3]}-${match[2]}-${match[1]}`;
  const parsed=new Date(iso+'T00:00:00Z');
  assert(Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===iso,422,'INVALID_ARCHIVE_DATE','Uma data do histórico não existe no calendário.');
  return iso;
}
export function parseJkHistoryExport(input) {
  onlyKeys(input,['content','previewHash']);
  assert(typeof input.content==='string'&&Buffer.byteLength(input.content)<=MAX_IMPORT_BYTES,422,'IMPORT_TOO_LARGE','Envie texto CSV de até 8 MiB.');
  assert(Buffer.from(input.content,'utf8').toString('utf8')===input.content,422,'INVALID_ARCHIVE_TEXT','O arquivo contém caracteres Unicode incompletos.');
  // Keep the untouched text as evidence. Source row is the CSV record ordinal,
  // including the header and leading empty records, not a physical line number.
  const text=input.content.replace(/^\uFEFF/u,'');
  const leading=text.match(/^(?:\r?\n)*/u)[0];
  const offset=(leading.match(/\n/gu)||[]).length;
  const [headers,...values]=parseCsv(text.slice(leading.length));
  const kind=Object.keys(ARCHIVE_HEADERS).find(key=>JSON.stringify(headers)===JSON.stringify(ARCHIVE_HEADERS[key]));
  assert(kind,422,'UNRECOGNIZED_ARCHIVE_HEADERS','Os cabeçalhos não correspondem a um arquivo nativo de histórico, clientes ou produtos.');
  assert(values.length>0,422,'EMPTY_ARCHIVE','O arquivo não contém registros.');
  const snapshotHash=sha256(input.content);
  const rows=values.map((value,index)=>({id:`${snapshotHash}:${index+offset+2}`,sourceRow:index+offset+2,sourceNumber:kind==='orders'?value[0]:null,values:value}));
  const counts={rows:rows.length,columns:headers.length,duplicateOrderNumbers:0};
  let totals=null,dates=null;
  if(kind==='orders') {
    totals={valueCents:0,discountCents:0};dates={entryMin:null,entryMax:null,exitMin:null,exitMax:null};
    const numbers=new Map();
    for(const row of rows) {
      const cells=row.values;
      assert(cells[0].length>0,422,'ARCHIVE_ORDER_NUMBER_REQUIRED','O histórico contém número de OS vazio.');
      numbers.set(cells[0],(numbers.get(cells[0])||0)+1);
      totals.valueCents+=money(cells[21]);totals.discountCents+=money(cells[20]);
      assert(Number.isSafeInteger(totals.valueCents)&&Number.isSafeInteger(totals.discountCents),422,'INVALID_ARCHIVE_MONEY','A soma excede o limite numérico.');
      for(const [prefix,index] of [['entry',8],['exit',10]]) {
        const value=date(cells[index]);
        dates[`${prefix}Min`]=dates[`${prefix}Min`]===null||value<dates[`${prefix}Min`]?value:dates[`${prefix}Min`];
        dates[`${prefix}Max`]=dates[`${prefix}Max`]===null||value>dates[`${prefix}Max`]?value:dates[`${prefix}Max`];
      }
    }
    counts.duplicateOrderNumbers=[...numbers.values()].filter(n=>n>1).length;
    for(const row of rows) {
      if(row.values[26].trim())assert(money(row.values[26])===totals.valueCents,422,'ARCHIVE_TOTAL_MISMATCH','O total declarado no arquivo difere da soma das linhas.');
      // A broader export may include unpaid or cancelled rows. Paid count is
      // source metadata, not evidence that every row represents a receipt.
      if(row.values[24].trim())assert(/^\d+$/u.test(row.values[24])&&Number(row.values[24])<=rows.length,422,'ARCHIVE_COUNT_MISMATCH','A quantidade declarada de OS pagas excede as linhas do arquivo ou é inválida.');
    }
  }
  return {kind,snapshotHash,headers,rows,counts,totals,dates};
}
