import { createHash } from 'node:crypto';
import { assert } from '../../server/errors.mjs';
import * as v from '../../server/validation.mjs';

const code = (length, required = false) => ({ type: 'code', length, required });
const choice = (values, required = false) => ({ type: 'choice', values, required });
const text = (max, required = false) => ({ type: 'text', max, required });
const amount = () => ({ type: 'decimal', min: 0, max: 1_000_000_000 });
const percentage = () => ({ type: 'decimal', min: 0, max: 100 });
export const FISCAL_FIELDS = Object.freeze({
  data_emissao: { type: 'datetime', required: true },
  data_competencia: { type: 'date', required: true },
  serie_dps: { type: 'integer', min: 1, max: 49999, required: true },
  numero_dps: { type: 'integer', min: 1, max: 999999999999999, required: true },
  emitente_dps: choice(['1'], true),
  cnpj_prestador: { type: 'cnpj', required: true },
  codigo_municipio_emissora: code(7, true),
  codigo_opcao_simples_nacional: choice(['1','2','3'], true),
  regime_tributario_simples_nacional: choice(['1','2','3']),
  regime_especial_tributacao: choice(['0','1','2','3','4','5','6','9'], true),
  inscricao_municipal_prestador: text(15),
  codigo_municipio_prestacao: code(7, true),
  codigo_tributacao_nacional_iss: code(6, true),
  codigo_tributacao_municipal_iss: code(3),
  codigo_nbs: code(9, true),
  descricao_servico: text(1000),
  tributacao_iss: choice(['1','2','3','4'], true),
  tipo_retencao_iss: choice(['1','2'], true),
  percentual_aliquota_relativa_municipio: percentage(),
  tipo_imunidade: choice(['0','1','2','3','4','5']),
  codigo_pais_exportacao: { type: 'country' },
  tipo_exigibilidade_suspensao: choice(['1','2']),
  numero_processo_suspensao: text(30),
  situacao_tributaria_pis_cofins: code(2),
  base_calculo_pis_cofins: amount(),
  aliquota_pis: percentage(),
  aliquota_cofins: percentage(),
  valor_pis: amount(),
  valor_cofins: amount(),
  tipo_retencao_pis_cofins: choice(['0','1','2','3','4','5','6','7','8','9']),
  valor_cp: amount(),
  valor_irrf: amount(),
  valor_csll: amount(),
  valor_total_tributos_federais: amount(),
  valor_total_tributos_estaduais: amount(),
  valor_total_tributos_municipais: amount(),
  percentual_total_tributos_federais: percentage(),
  percentual_total_tributos_estaduais: percentage(),
  percentual_total_tributos_municipais: percentage(),
  indicador_total_tributacao: choice(['0']),
  percentual_total_tributos_simples_nacional: percentage(),
  finalidade_emissao: choice(['0']),
  consumidor_final: choice(['0','1']),
  codigo_indicador_operacao: code(6),
  indicador_destinatario: choice(['0']),
  ibs_cbs_situacao_tributaria: code(3),
  ibs_cbs_classificacao_tributaria: code(6),
});
export const REQUIRED_FISCAL_FIELDS = Object.freeze(Object.entries(FISCAL_FIELDS).filter(([, spec]) => spec.required).map(([key]) => key));
export const IBS_CBS_FIELDS = Object.freeze(['finalidade_emissao','consumidor_final','codigo_indicador_operacao','indicador_destinatario','ibs_cbs_situacao_tributaria','ibs_cbs_classificacao_tributaria']);

function invalid(field) { assert(false, 422, 'FISCAL_VALIDATION_ERROR', 'Revise os dados obrigatórios do rascunho fiscal.', { field }); }
function onlyKeys(body, allowed) {
  if (Object.keys(body).some((key) => !allowed.includes(key))) invalid('body');
}
function simpleText(value, field, max, min = 1) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) invalid(field);
  return value.trim();
}
function digits(value, field, length) {
  if (typeof value !== 'string' || !new RegExp(`^[0-9]{${length}}$`, 'u').test(value)) invalid(field);
  return value;
}

// CNPJ alphanumeric uses ASCII code minus 48 for the first 12 positions.
export function validTaxId(value, type) {
  if (typeof value !== 'string') return false;
  if ((type === 'cpf' || type === undefined) && /^\d{11}$/u.test(value) && !/^(\d)\1{10}$/u.test(value)) {
    const numbers = [...value].map(Number);
    for (let size = 9; size <= 10; size++) {
      const mod = (numbers.slice(0, size).reduce((sum, n, index) => sum + n * (size + 1 - index), 0) * 10) % 11;
      if ((mod === 10 ? 0 : mod) !== numbers[size]) return false;
    }
    return true;
  }
  if ((type === 'cnpj' || type === undefined) && /^[A-Z0-9]{12}\d{2}$/u.test(value) && !/^(\d)\1{13}$/u.test(value)) {
    const numbers = [...value].map((character) => character.charCodeAt(0) - 48);
    for (let size = 12; size <= 13; size++) {
      const sum = numbers.slice(0, size).reduce((total, n, index) => total + n * ((size - 1 - index) % 8 + 2), 0);
      const remainder = sum % 11;
      if ((remainder < 2 ? 0 : 11 - remainder) !== numbers[size]) return false;
    }
    return true;
  }
  return false;
}

function fieldValue(value, name, spec) {
  const field = `fiscal.${name}`;
  if (value === undefined) { if (spec.required) invalid(field); return undefined; }
  switch (spec.type) {
    case 'code': return digits(value, field, spec.length);
    case 'choice': {
      // Codes are strings in the public contract; no implicit fiscal defaults.
      if (!spec.values.includes(value)) invalid(field);
      return value;
    }
    case 'text': return simpleText(value, field, spec.max);
    case 'integer':
      if (!Number.isSafeInteger(value) || value < spec.min || value > spec.max) invalid(field);
      return value;
    case 'decimal':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < spec.min || value > spec.max
        || Math.abs(value * 100 - Math.round(value * 100)) > 0.00001) invalid(field);
      return value;
    case 'cnpj':
      if (!validTaxId(value, 'cnpj')) invalid(field);
      return value;
    case 'country':
      if (typeof value !== 'string' || !/^[A-Z]{2}$/u.test(value)) invalid(field);
      return value;
    case 'date':
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)
        || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) invalid(field);
      return value;
    case 'datetime':
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
        || !Number.isFinite(Date.parse(value))) invalid(field);
      // Date.parse normalizes invalid calendar dates; validate the local day too.
      fieldValue(value.slice(0, 10), name, { type: 'date' });
      return value;
    default: invalid(field);
  }
}

export function validateDraftInput(body) {
  v.object(body); onlyKeys(body, ['orderId','customer','fiscal','taxReview']);
  const orderId = v.identifier(body.orderId, 'orderId');
  v.object(body.customer); onlyKeys(body.customer, ['taxId','name','address']);
  if (!validTaxId(body.customer.taxId)) invalid('customer.taxId');
  v.object(body.customer.address);
  onlyKeys(body.customer.address, ['municipalityCode','zipCode','street','number','neighborhood','complement']);
  const inputAddress = body.customer.address;
  const customer = {
    taxId: body.customer.taxId, name: simpleText(body.customer.name, 'customer.name', 150),
    address: {
      municipalityCode: digits(inputAddress.municipalityCode, 'customer.address.municipalityCode', 7),
      zipCode: digits(inputAddress.zipCode, 'customer.address.zipCode', 8),
      street: simpleText(inputAddress.street, 'customer.address.street', 255),
      number: simpleText(inputAddress.number, 'customer.address.number', 60),
      neighborhood: simpleText(inputAddress.neighborhood, 'customer.address.neighborhood', 60),
      ...(inputAddress.complement === undefined ? {} : { complement: simpleText(inputAddress.complement, 'customer.address.complement', 156) }),
    },
  };
  v.object(body.fiscal); onlyKeys(body.fiscal, Object.keys(FISCAL_FIELDS));
  const fiscal = {};
  for (const [key, spec] of Object.entries(FISCAL_FIELDS)) {
    const value = fieldValue(body.fiscal[key], key, spec);
    if (value !== undefined) fiscal[key] = value;
  }
  if (fiscal.codigo_opcao_simples_nacional === '3' && !fiscal.regime_tributario_simples_nacional) invalid('fiscal.regime_tributario_simples_nacional');
  if (fiscal.tributacao_iss === '2' && fiscal.tipo_imunidade === undefined) invalid('fiscal.tipo_imunidade');
  if (fiscal.tributacao_iss === '3' && fiscal.codigo_pais_exportacao === undefined) invalid('fiscal.codigo_pais_exportacao');
  if (fiscal.tipo_exigibilidade_suspensao !== undefined && fiscal.numero_processo_suspensao === undefined) invalid('fiscal.numero_processo_suspensao');
  v.object(body.taxReview); onlyKeys(body.taxReview, ['ibsCbsRequired','justification','discountTreatment']);
  const taxReview = {
    ibsCbsRequired: v.boolean(body.taxReview.ibsCbsRequired, 'taxReview.ibsCbsRequired'),
    justification: simpleText(body.taxReview.justification, 'taxReview.justification', 500, 10),
    discountTreatment: v.choice(body.taxReview.discountTreatment, 'taxReview.discountTreatment', ['none','unconditional','conditional']),
  };
  const hasIbsCbs = IBS_CBS_FIELDS.some((name) => fiscal[name] !== undefined);
  if (taxReview.ibsCbsRequired || hasIbsCbs) for (const name of IBS_CBS_FIELDS) if (fiscal[name] === undefined) invalid(`fiscal.${name}`);
  return { orderId, customer, fiscal, taxReview };
}

export function buildFocusPayload(input, snapshot) {
  const { customer, fiscal, taxReview } = input;
  assert(snapshot.totalCents > 0 && snapshot.items.length > 0, 422, 'FISCAL_ORDER_EMPTY', 'A ordem deve conter serviços com valor positivo.');
  if ((snapshot.discountCents > 0) === (taxReview.discountTreatment === 'none')) invalid('taxReview.discountTreatment');
  const description = fiscal.descricao_servico || snapshot.items.map((item) => `${item.quantity} x ${item.name}`).join('; ');
  if (description.length > 1000) invalid('fiscal.descricao_servico');
  const payload = {
    ...fiscal,
    [customer.taxId.length === 11 ? 'cpf_tomador' : 'cnpj_tomador']: customer.taxId,
    razao_social_tomador: customer.name, codigo_municipio_tomador: customer.address.municipalityCode,
    cep_tomador: customer.address.zipCode, logradouro_tomador: customer.address.street,
    numero_tomador: customer.address.number, bairro_tomador: customer.address.neighborhood,
    ...(customer.address.complement ? { complemento_tomador: customer.address.complement } : {}),
    descricao_servico: description, valor_servico: snapshot.subtotalCents / 100,
    ...(snapshot.discountCents > 0 ? { [taxReview.discountTreatment === 'conditional' ? 'desconto_condicionado' : 'desconto_incondicionado']: snapshot.discountCents / 100 } : {}),
  };
  const payloadJson = JSON.stringify(payload);
  const summary = Object.fromEntries(Object.entries(fiscal).filter(([key]) => !['cnpj_prestador','inscricao_municipal_prestador','descricao_servico','numero_processo_suspensao'].includes(key)));
  return {
    payloadJson, payloadHash: createHash('sha256').update(payloadJson).digest('hex'),
    dpsKey: createHash('sha256').update(`${fiscal.cnpj_prestador}:${fiscal.serie_dps}:${fiscal.numero_dps}`).digest('hex'),
    fiscalSummary: { ...summary, ibsCbsRequired: taxReview.ibsCbsRequired, discountTreatment: taxReview.discountTreatment, taxReviewRecorded: true },
    customerMask: `${'*'.repeat(customer.taxId.length - 4)}${customer.taxId.slice(-4)}`,
    // Justification is retained with the request snapshot, never exposed in logs or API.
    review: taxReview,
  };
}
