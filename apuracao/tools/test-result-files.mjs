// Testes dos artefatos de sessão (cadeia SHA-512, P-521, validação, impresso).
// Uso: node --test tools/test-result-files.mjs  (a partir de lealand/)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, sha256hex, createZip, readZip } from '../shared/js/sel-zip.js';
import {
  dataHoraJE, codigoCargaDaSessao, agregarEleicao,
  construirArtefatos, zipPendrive, obterOuCriarIdentidade,
  RDV_TO_BU
} from '../shared/js/sel-result-files.js';
import { verifyResultFiles, parsePrintedBu, findResultFiles } from '../shared/js/sel-verify-results.js';
import { ELECTION, CANDIDATES } from '../shared/js/sel-election-config.js';

const te = new TextEncoder();
const td = new TextDecoder();

function sessaoFixture(votos) {
  const base = [
    { seq: 1, cargo: 'Gerente', tipo: 'nominal', numero: '91', registradoEm: '2026-03-01T10:00:00.000Z' },
    { seq: 2, cargo: 'Gerente', tipo: 'nominal', numero: '92', registradoEm: '2026-03-01T10:01:00.000Z' },
    { seq: 3, cargo: 'Gerente', tipo: 'nominal', numero: '93', registradoEm: '2026-03-01T10:02:00.000Z' },
    { seq: 4, cargo: 'Gerente', tipo: 'branco', numero: '', registradoEm: '2026-03-01T10:03:00.000Z' },
    { seq: 5, cargo: 'Gerente', tipo: 'nulo', numero: '99', registradoEm: '2026-03-01T10:04:00.000Z' }
  ];
  const lista = votos === undefined ? base : votos;
  return {
    sessionId: 'sel-20260301-100000-teste1',
    urna: 'lealand-gerente',
    inicio: '2026-03-01T10:00:00.000Z',
    fim: '2026-03-01T10:05:00.000Z',
    estado: 'encerrada',
    votos: lista,
    eventos: [{ t: '2026-03-01T10:00:00.000Z', tipo: 'ABERTURA', detalhe: 'x' }],
    candidatos: {}
  };
}

const memStore = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v))
  };
};

async function pacoteValido(sessao) {
  const id = await obterOuCriarIdentidade(memStore());
  const { arquivos } = await construirArtefatos(sessao ?? sessaoFixture(), id);
  const zip = zipPendrive(arquivos);
  const files = new Map(readZip(zip).map((e) => [e.name, e.data]));
  return { zip, files, valid: await verifyResultFiles(files) };
}

describe('codec ZIP', () => {
  it('round-trip + vetores', () => {
    const back = readZip(createZip([
      { name: 'a.json', data: te.encode('{"x":1}') },
      { name: 'logd.dat', data: te.encode('Tibúrcio') }
    ]));
    assert.equal(back.length, 2);
    assert.equal(td.decode(back[1].data), 'Tibúrcio');
    assert.equal(crc32(te.encode('123456789')), 0xcbf43926);
  });
  it('rejeita mágica, truncamento e ..', () => {
    const zip = createZip([{ name: 'a', data: te.encode('x') }]);
    zip[0] = 0x00;
    assert.throws(() => readZip(zip), /assinatura inesperada/);
    const zip2 = createZip([{ name: 'a', data: te.encode('xyz') }]);
    assert.throws(() => readZip(zip2.subarray(0, 20)), /truncado/);
    assert.throws(() => createZip([{ name: '../x', data: te.encode('x') }]), /Nome inválido/);
  });
  it('sha256 vetor', async () => {
    assert.equal(await sha256hex(te.encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('artefatos sel-bu/rdv/vota', () => {
  it('prefixo e carga no formato do urnaemu', async () => {
    const { files, valid } = await pacoteValido();
    assert.equal(valid.ok, true, JSON.stringify(valid.checks.filter((c) => !c.ok)));
    const names = [...files.keys()].sort();
    assert.deepEqual(names, [
      't02400ll0000100010001-bu.json', 't02400ll0000100010001-bu.txt',
      't02400ll0000100010001-candidaturas.json', 't02400ll0000100010001-log.zip',
      't02400ll0000100010001-rdv.json', 't02400ll0000100010001-vota.json'
    ]);
    assert.match(valid.bu.urna.correspondenciaResultado.carga.codigoCarga, /^[A-Z0-9]{1,24}$/);
    assert.match(valid.bu.dadosSecao.dataHoraAbertura, /^\d{8}T\d{6}$/);
  });
  it('cadeia: blocos, ordem e último hash', async () => {
    const { valid } = await pacoteValido();
    const el = valid.bu.resultadosVotacaoPorEleicao[0];
    const blocos = el.resultadosVotacao[0].totaisVotosCargo[0].votosVotaveis;
    assert.deepEqual(blocos.map((b) => [b.ordemGeracaoHash, b.tipoVoto, b.quantidadeVotos]),
      [[1, 1, 1], [2, 1, 1], [3, 1, 1], [4, 2, 1], [5, 3, 1]]);
    assert.match(el.ultimoHashVotosVotavel, /^[0-9a-f]{128}$/);
    assert.ok(valid.checks.find((c) => c.id.startsWith('chain:')).ok);
    assert.ok(valid.checks.find((c) => c.id.startsWith('final:')).ok);
    assert.ok(valid.checks.find((c) => c.id.startsWith('signature:')).ok);
  });
  it('RDV em ordem de votação + totais conferem', async () => {
    const { valid } = await pacoteValido();
    const votos = valid.rdv.eleicoes[0].votosCargos[0].votos;
    assert.deepEqual(votos.map((v) => [v.tipoVoto, v.digitacao ?? null]),
      [[2, '91'], [2, '92'], [2, '93'], [3, null], [4, '99']]);
    assert.ok(valid.checks.find((c) => c.id.startsWith('totals:')).ok);
    assert.ok(valid.checks.find((c) => c.id.startsWith('sorted:')).ok);
    assert.deepEqual(valid.tally, { porNumero: { 91: 1, 92: 1, 93: 1 }, brancos: 1, nulos: 1, total: 5 });
  });
  it('impresso casa com o BU', async () => {
    const { valid } = await pacoteValido();
    assert.ok(valid.checks.find((c) => c.id === 'impresso').ok);
  });
  it('sentenças conhecidas: dataHoraJE e carga', () => {
    assert.equal(dataHoraJE(new Date(2026, 2, 1, 10, 5, 9)), '20260301T100509');
    assert.equal(codigoCargaDaSessao('sel-abc-123'), 'SELABC123');
    assert.deepEqual(RDV_TO_BU, { 2: 1, 3: 2, 4: 3 });
    assert.equal(ELECTION.cargo.codigo, 11);
    assert.equal(CANDIDATES.length, 3);
  });
});

describe('rejeições', () => {
  it('ZIP corrompido / não-ZIP', () => {
    assert.throws(() => readZip(te.encode('nao e zip')), /ZIP inválido/);
    const bad = createZip([{ name: 'a', data: te.encode('xyz') }]);
    bad[31] ^= 0xff; // dado do arquivo → CRC diverge
    assert.throws(() => readZip(bad), /CRC/);
  });
  it('ZIP incompleto (sem rdv)', async () => {
    const { files } = await pacoteValido();
    const key = [...files.keys()].find((n) => n.endsWith('-rdv.json'));
    files.delete(key);
    const valid = await verifyResultFiles(files);
    assert.equal(valid.ok, false);
    assert.ok(valid.checks.some((c) => !c.ok));
  });
  it('hash adulterado no vota.json', async () => {
    const { files } = await pacoteValido();
    const key = [...files.keys()].find((n) => n.endsWith('-bu.json'));
    const b = Buffer.from(files.get(key));
    b[b.length - 20] ^= 0x01;
    files.set(key, b);
    const valid = await verifyResultFiles(files);
    assert.equal(valid.ok, false);
    assert.ok(valid.checks.some((c) => c.id === `arquivo:${key}` && !c.ok));
  });
  it('versão de formato não suportada', async () => {
    const { files } = await pacoteValido();
    const key = [...files.keys()].find((n) => n.endsWith('-bu.json'));
    const bu = JSON.parse(td.decode(files.get(key)));
    bu.formato = 'sel-bu/9';
    files.set(key, te.encode(JSON.stringify(bu)));
    const valid = await verifyResultFiles(files);
    assert.equal(valid.ok, false);
    assert.ok(valid.checks.some((c) => c.id === 'versao' && !c.ok));
  });
  it('cargo errado e nominal desconhecido', async () => {
    const id = await obterOuCriarIdentidade(memStore());
    const s = sessaoFixture([{ seq: 1, cargo: 'Gerente', tipo: 'nominal', numero: '97', registradoEm: '2026-03-01T10:00:00.000Z' }]);
    const { arquivos } = await construirArtefatos(s, id);
    const files = new Map(readZip(zipPendrive(arquivos)).map((e) => [e.name, e.data]));
    // nominal 97 não existe no rol → detectado na validação dos votos? (construção permite; validação de totais falha)
    const valid = await verifyResultFiles(files);
    assert.equal(valid.ok, false);
  });
  it('RDV fora de ordem de votação é canonizado (sorted passa)', async () => {
    const id = await obterOuCriarIdentidade(memStore());
    const s = sessaoFixture([
      { seq: 1, cargo: 'Gerente', tipo: 'nominal', numero: '93', registradoEm: '2026-03-01T10:00:00.000Z' },
      { seq: 2, cargo: 'Gerente', tipo: 'nulo', numero: '99', registradoEm: '2026-03-01T10:01:00.000Z' },
      { seq: 3, cargo: 'Gerente', tipo: 'nominal', numero: '91', registradoEm: '2026-03-01T10:02:00.000Z' }
    ]);
    const { arquivos } = await construirArtefatos(s, id);
    const files = new Map(readZip(zipPendrive(arquivos)).map((e) => [e.name, e.data]));
    const valid = await verifyResultFiles(files);
    assert.equal(valid.ok, true, JSON.stringify(valid.checks.filter((c) => !c.ok)));
    const votos = valid.rdv.eleicoes[0].votosCargos[0].votos;
    assert.deepEqual(votos.map((v) => [v.tipoVoto, v.digitacao ?? null]), [[2, '91'], [2, '93'], [4, '99']]);
    assert.deepEqual(valid.tally.porNumero, { 91: 1, 93: 1 });
  });
  it('sessão zerada: cadeia só-semente, total 0', async () => {
    const { valid } = await pacoteValido(sessaoFixture([]));
    assert.equal(valid.ok, true, JSON.stringify(valid.checks.filter((c) => !c.ok)));
    assert.deepEqual([valid.tally.total, valid.bu.qtdEleitoresCompareceram], [0, 0]);
  });
  it('parsePrintedBu encontra Gerente', async () => {
    const { files } = await pacoteValido();
    const txt = td.decode(files.get([...files.keys()].find((n) => n.endsWith('-bu.txt'))));
    const off = parsePrintedBu(txt).find((o) => o.key.includes('GERENTE'));
    assert.deepEqual(off.candidates, { 91: 1, 92: 1, 93: 1 });
    assert.deepEqual([off.brancos, off.nulos, off.apurado], [1, 1, 5]);
  });
  it('findResultFiles pelos sufixos', async () => {
    const { files } = await pacoteValido();
    const names = findResultFiles([...files.keys()]);
    assert.ok(names.bu && names.rdv && names.vsc && names.log && names.txt && names.cand);
  });
});
