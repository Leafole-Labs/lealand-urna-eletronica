// Rol eleitoral de Lealand — metadados de exibição da eleição única.
// Fonte de verdade dos NÚMEROS e NOMES DE URNA é o dataset
// (wasm/bases/lealand-gerente.data); este arquivo espelha o rol completo
// (incluindo nomes civis e vices, que o estado do motor não expõe) para o
// ZIP de sessão e o boletim. tools/verify-lealand.mjs cruza estes dados com
// o .data a cada verificação. Puro ESM, sem DOM (usado no navegador e no node).
export const ELECTION = {
  electionId: 'lealand-gerente-2026',
  urna: 'lealand-gerente',
  titulo: 'Eleição de Lealand — Gerente',
  autoridade: 'Supremo Eleitoral de Lealand (SEL)',
  localidade: 'Lealand',
  turno: 2,
  fase: 'te',
  cargo: {
    codigo: 11,
    nome: 'Gerente',
    nomeFeminino: 'Gerenta',
    abreviacao: 'Ger.',
    digitos: 2,
    majoritario: true,
    vice: { nome: 'Vice-Gerente', nomeFeminino: 'Vice-Gerenta', abreviacao: 'V. Ger.' }
  }
};

export const CANDIDATES = [
  {
    numero: '91',
    partido: { numero: 91, sigla: 'PGL', nome: 'Partido Gerencial de Lealand' },
    titular: { nome: 'Tibúrcio Lemos', nomeUrna: 'Tibúrcio' },
    vice: { nome: 'Zulmira Prado', nomeUrna: 'Zulmira' }
  },
  {
    numero: '92',
    partido: { numero: 92, sigla: 'PUL', nome: 'Partido da Uniao de Lealand' },
    titular: { nome: 'Dagoberto Sales', nomeUrna: 'Dagoberto' },
    vice: { nome: 'Hermínia Fontoura', nomeUrna: 'Hermínia' }
  },
  {
    numero: '93',
    partido: { numero: 93, sigla: 'PCL', nome: 'Partido Comunitario de Lealand' },
    titular: { nome: 'Quitéria Vasconcellos', nomeUrna: 'Quitéria' },
    vice: { nome: 'Agenor Pimenta', nomeUrna: 'Agenor' }
  }
];

// Identidade da seção e do pleito (formato do urnaemu; valores de Lealand).
// SECTION_ID = UF(2) + municipio(5) + zona(4) + secao(4) → /^[a-z]{2}\d{13}$/.
export const SECAO = {
  uf: 'll',
  municipio: 1,
  zona: 1,
  local: 1011,
  secao: 1,
  get sectionId() {
    const p = (v, n) => String(v).padStart(n, '0');
    return this.uf + p(this.municipio, 5) + p(this.zona, 4) + p(this.secao, 4);
  }
};

export const PLEITO = {
  idPleito: 2400, // herdado do dataset (pe)
  idEleicao: 2421, // eleição municipal de 2º turno (sintético, documentado)
  turno: 2,
  fase: 3, // FASES do urnaemu: 1 simulado, 2 oficial, 3 treinamento (nunca 2)
  get prefixo() {
    return 't' + String(this.idPleito).padStart(5, '0') + SECAO.sectionId;
  }
};

export const URNA_INFO = {
  tipoUrna: 'secao',
  versaoVotacao: '1.0-sel',
  urnaId: 'SEL-0001',
  // Séries sintéticas de laboratório (nunca números reais de hardware).
  numeroSerieFV: 'SEL0000000001',
  numeroSerieFC: 'SELF0000000001'
};
