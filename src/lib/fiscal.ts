import type {FiscalConfig, FiscalDraft, FiscalFields} from '../../sdk/src/models';

export type FiscalFieldKey = keyof FiscalFields;
export type FiscalFieldSpec = {type: string; required?: boolean; length?: number; min?: number; max?: number; values?: readonly string[]};
export type FiscalFormValues = Partial<Record<FiscalFieldKey, string>>;

export const fiscalLabels: Record<FiscalFieldKey, string> = {
  data_emissao: 'Data e hora de emissão', data_competencia: 'Data de competência', serie_dps: 'Série da DPS',
  numero_dps: 'Número da DPS', emitente_dps: 'Emitente da DPS', cnpj_prestador: 'CNPJ do prestador',
  codigo_municipio_emissora: 'Município emissor (IBGE)', codigo_opcao_simples_nacional: 'Opção pelo Simples Nacional',
  regime_tributario_simples_nacional: 'Regime de apuração do Simples Nacional', regime_especial_tributacao: 'Regime especial de tributação',
  inscricao_municipal_prestador: 'Inscrição municipal do prestador', codigo_municipio_prestacao: 'Município da prestação (IBGE)',
  codigo_tributacao_nacional_iss: 'Código de tributação nacional do ISS', codigo_tributacao_municipal_iss: 'Código de tributação municipal do ISS',
  codigo_nbs: 'Código NBS', descricao_servico: 'Descrição fiscal do serviço', tributacao_iss: 'Tributação do ISS',
  tipo_retencao_iss: 'Retenção do ISS', percentual_aliquota_relativa_municipio: 'Alíquota municipal do ISS (%)',
  tipo_imunidade: 'Tipo de imunidade', codigo_pais_exportacao: 'País de exportação (ISO)', tipo_exigibilidade_suspensao: 'Suspensão de exigibilidade',
  numero_processo_suspensao: 'Número do processo de suspensão', situacao_tributaria_pis_cofins: 'Situação tributária PIS/COFINS',
  base_calculo_pis_cofins: 'Base de cálculo PIS/COFINS (R$)', aliquota_pis: 'Alíquota PIS (%)', aliquota_cofins: 'Alíquota COFINS (%)',
  valor_pis: 'Valor PIS (R$)', valor_cofins: 'Valor COFINS (R$)', tipo_retencao_pis_cofins: 'Retenção PIS/COFINS',
  valor_cp: 'Contribuição previdenciária (R$)', valor_irrf: 'IRRF (R$)', valor_csll: 'CSLL (R$)',
  valor_total_tributos_federais: 'Total de tributos federais (R$)', valor_total_tributos_estaduais: 'Total de tributos estaduais (R$)',
  valor_total_tributos_municipais: 'Total de tributos municipais (R$)', percentual_total_tributos_federais: 'Total de tributos federais (%)',
  percentual_total_tributos_estaduais: 'Total de tributos estaduais (%)', percentual_total_tributos_municipais: 'Total de tributos municipais (%)',
  indicador_total_tributacao: 'Indicador do total de tributação', percentual_total_tributos_simples_nacional: 'Total de tributos do Simples Nacional (%)',
  finalidade_emissao: 'Finalidade de emissão', consumidor_final: 'Consumidor final', codigo_indicador_operacao: 'Indicador de operação (cIndOp)',
  indicador_destinatario: 'Destinatário', ibs_cbs_situacao_tributaria: 'Situação tributária IBS/CBS (CST)',
  ibs_cbs_classificacao_tributaria: 'Classificação tributária IBS/CBS (cClassTrib)',
};

export const fiscalChoiceLabels: Partial<Record<FiscalFieldKey, Record<string, string>>> = {
  emitente_dps: {'1': '1 · Prestador'},
  codigo_opcao_simples_nacional: {'1': '1 · Não optante', '2': '2 · MEI', '3': '3 · ME/EPP optante'},
  regime_tributario_simples_nacional: {'1': '1 · Tributos federais e ISS pelo Simples', '2': '2 · Federais pelo Simples; ISS fora', '3': '3 · Federais e ISS fora do Simples'},
  regime_especial_tributacao: {'0': '0 · Nenhum', '1': '1 · Ato cooperado', '2': '2 · Estimativa', '3': '3 · Microempresa municipal', '4': '4 · Notário ou registrador', '5': '5 · Profissional autônomo', '6': '6 · Sociedade de profissionais', '9': '9 · Outros'},
  tributacao_iss: {'1': '1 · Operação tributável', '2': '2 · Imunidade', '3': '3 · Exportação de serviço', '4': '4 · Não incidência'},
  tipo_retencao_iss: {'1': '1 · Não retido', '2': '2 · Retido'},
  finalidade_emissao: {'0': '0 · NFS-e regular'},
  consumidor_final: {'0': '0 · Não', '1': '1 · Sim'},
  indicador_destinatario: {'0': '0 · O próprio tomador'},
};

export const fiscalStatusLabels: Record<FiscalDraft['status'], string> = {
  prepared: 'Rascunho preparado', submitting: 'Envio em andamento', uncertain: 'Resultado incerto',
  pending: 'Aguardando provedor', reconciling: 'Consulta em andamento', authorized: 'Autorização informada',
  rejected: 'Rejeitado', cancelled: 'Rascunho cancelado', provider_cancelled: 'Cancelado no provedor',
};
export function fiscalTone(status: FiscalDraft['status']): 'neutral'|'blue'|'green'|'orange'|'red' {
  if (status === 'authorized') return 'green';
  if (['uncertain','pending'].includes(status)) return 'orange';
  if (['rejected','provider_cancelled'].includes(status)) return 'red';
  if (['submitting','reconciling'].includes(status)) return 'blue';
  return 'neutral';
}
export function fiscalOutcome(draft: FiscalDraft): string {
  switch (draft.status) {
    case 'prepared': return 'Rascunho salvo no sistema, sem envio ao provedor. A preparação não autoriza uma NFS-e.';
    case 'submitting': return 'O envio está em andamento. Atualize o estado para acompanhar o resultado.';
    case 'reconciling': return 'A consulta está em andamento. Aguarde e atualize o estado.';
    case 'uncertain': return 'O resultado do envio não foi confirmado. Consulte a referência no provedor antes de qualquer nova emissão.';
    case 'pending': return 'O provedor está processando a solicitação. A NFS-e ainda não está autorizada.';
    case 'authorized': return draft.fiscalValidity === 'test_without_fiscal_validity'
      ? 'O provedor informou autorização no ambiente de teste. Este resultado não tem validade fiscal.'
      : 'O provedor informou autorização em produção. Consulte os documentos fiscais e sua guarda no provedor.';
    case 'cancelled': return 'Rascunho não enviado cancelado no sistema. Nenhuma nota fiscal foi cancelada.';
    case 'provider_cancelled': return 'A consulta informou cancelamento no provedor.';
    case 'rejected': return 'O provedor informou rejeição. Revise a classificação e os dados antes de preparar outro rascunho.';
  }
}
export const normalizeTaxId = (value: string) => value.replace(/[./\s-]/gu, '').toUpperCase();
/** Mirrors the accepted public contract, including alphanumeric CNPJ check digits. */
export function validFiscalTaxId(raw: string, cnpjOnly = false): boolean {
  const value = normalizeTaxId(raw);
  if (!cnpjOnly && /^\d{11}$/u.test(value) && !/^(\d)\1{10}$/u.test(value)) {
    const numbers = [...value].map(Number);
    for (let size = 9; size <= 10; size++) {
      const mod = (numbers.slice(0, size).reduce((sum, n, index) => sum + n * (size + 1 - index), 0) * 10) % 11;
      if ((mod === 10 ? 0 : mod) !== numbers[size]) return false;
    }
    return true;
  }
  if (/^[A-Z0-9]{12}\d{2}$/u.test(value) && !/^(\d)\1{13}$/u.test(value)) {
    const numbers = [...value].map(character => character.charCodeAt(0) - 48);
    for (let size = 12; size <= 13; size++) {
      const sum = numbers.slice(0, size).reduce((total, n, index) => total + n * ((size - 1 - index) % 8 + 2), 0);
      const remainder = sum % 11;
      if ((remainder < 2 ? 0 : 11 - remainder) !== numbers[size]) return false;
    }
    return true;
  }
  return false;
}
export function fieldRequired(key: FiscalFieldKey, spec: FiscalFieldSpec, values: FiscalFormValues, config: FiscalConfig, ibsCbs: boolean) {
  return Boolean(spec.required ||
    key === 'regime_tributario_simples_nacional' && values.codigo_opcao_simples_nacional === '3' ||
    key === 'tipo_imunidade' && values.tributacao_iss === '2' ||
    key === 'codigo_pais_exportacao' && values.tributacao_iss === '3' ||
    key === 'numero_processo_suspensao' && values.tipo_exigibilidade_suspensao ||
    (config.ibsCbsFields as readonly string[]).includes(key) && (ibsCbs || config.ibsCbsFields.some(name => Boolean(values[name]))));
}
