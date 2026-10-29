import test from 'node:test';
import assert from 'node:assert/strict';
import {csvCell} from '../src/lib/csv.ts';

test('CSV trata fórmulas, controles iniciais, aspas e unidades monetárias sem alterar o valor', () => {
  for (const unsafe of ['=1+1', '+1', '-1', '@SUM(A1)', '   =1', '\t=1', '\r=1', '\n=1', ' \t+1', '\ttexto', '\rtexto']) {
    assert.ok(csvCell(unsafe).startsWith('"\''));
  }
  assert.equal(csvCell('Cliente; "A"\nLinha 2'), '"Cliente; ""A""\nLinha 2"');
  assert.equal(csvCell('Nome sem fórmula'), '"Nome sem fórmula"');
  assert.equal(csvCell(10001), '"10001"');
  assert.equal(csvCell(0), '"0"');
  assert.equal(csvCell(null), '""');
});
