// Builder do dataset próprio de Lealand (Gerente 91/92/93).
// Estratégia: usa municipal-t2 como MOLDE ESTRUTURAL offline (códigos internos
// compatíveis com o motor), mas o conteúdo final (cargos, candidaturas,
// partidos, fotos remapeadas) é próprio de Lealand e persistido em
// wasm/bases/lealand-gerente.data (+ .data.js + manifest.json).
// Em runtime, lealand/ NUNCA carrega municipal-t2.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VotaLoadFormat as F } from 'file:///C:/Users/rafae/Downloads/urna/lealand-urna/urnaemu/src/lib/engine/load/load-format.js';
import { readCandidates, writeCandidates } from 'file:///C:/Users/rafae/Downloads/urna/lealand-urna/urnaemu/src/lib/engine/load/candidates.js';

const ROOT = 'C:/Users/rafae/Downloads/urna/lealand-urna';
const TPL_BASE = ROOT + '/meu/recuperado/wasm/bases';
const OUT_BASE = ROOT + '/lealand/wasm/bases';
fs.mkdirSync(OUT_BASE, { recursive: true });

function loadPack(jsName) {
  const s = fs.readFileSync(TPL_BASE + '/' + jsName, 'utf8');
  const start = s.lastIndexOf('carregarPacote(') + 'carregarPacote('.length;
  const tail = s.slice(start);
  const meta = JSON.parse(tail.slice(0, tail.indexOf(']});') + 2));
  const buf = fs.readFileSync(TPL_BASE + '/' + meta.data);
  const files = new Map();
  for (const f of meta.files) files.set(f.filename, Buffer.from(buf.subarray(f.start, f.end)));
  return { meta, files };
}

const tpl = loadPack('municipal-t2.data.js');       // molde: 1 cargo majoritário 2 dígitos + vice
const extra = loadPack('municipal-t1.data.js');     // fonte das fotos 5/6 (Bombeira/Detetive)

// ---- 1. ce.dat: renomear cargos (código interno 11 mantido p/ compat) ----
const CE_PATH = '/dsk/fi/estatico/t02421ac-ce.dat';
{
  const root = F.parse(tpl.files.get(CE_PATH));
  const ren = (t, from, to) => { if (t === from) return to; return t; };
  const walk = (n) => {
    if (n.text !== undefined) {
      n.text = ren(n.text, 'Eleição Municipal', 'Eleição de Lealand');
      n.text = ren(n.text, 'Prefeito', 'Gerente');
      n.text = ren(n.text, 'Prefeita', 'Gerenta');
      n.text = ren(n.text, 'Pref.', 'Ger.');
      n.text = ren(n.text, 'Vice-Prefeito', 'Vice-Gerente');
      n.text = ren(n.text, 'Vice-Prefeita', 'Vice-Gerenta');
      n.text = ren(n.text, 'V. Pref.', 'V. Ger.');
    }
    (n.children || []).forEach(walk);
  };
  walk(root);
  tpl.files.set(CE_PATH, Buffer.from(F.encode(root)));
}

// ---- 1b. textos de localidade/pleito (valores de exibição; códigos pe/uf/turno mantidos) ----
{
  const pairs = [
    ['Eleições Municipais', 'Eleição de Lealand'],
    ['Eleição Municipal', 'Eleição de Lealand'],
    ['Municipais', 'de Lealand'],
    ['Municipal', 'de Lealand'],
    ['Minha Cidade', 'Lealand'],
    ['Acre', 'Lealand'],
    ['BRASIL', 'LEALAND'],
  ];
  for (const p of ['/dsk/fi/estatico/t02400ac-mu.dat', '/dsk/fi/estatico/t02400-cp.dat', '/dsk/fi/estatico/0000100010001-lo.dat']) {
    const root = F.parse(tpl.files.get(p));
    const walk = (n) => {
      if (n.text !== undefined) for (const [a, b] of pairs) n.text = n.text.split(a).join(b);
      (n.children || []).forEach(walk);
    };
    walk(root);
    tpl.files.set(p, Buffer.from(F.encode(root)));
  }
}

// ---- 2. candidaturas próprias de Lealand ----
function photoOf(pack, caPath, code) {
  const foPath = caPath.replace(/-ca\.dat$/, '-fo.dat');
  const fo = F.parse(pack.files.get(foPath));
  const e = fo.children[2].children.find((x) => x.children[0].text === String(code));
  if (!e) throw new Error('foto ausente: ' + code);
  return Buffer.from(F.unhex(e.children[1].children[1].hex));
}
const CA_PATH = '/dsk/fi/estatico/t02421ac00001-ca.dat';
const elections = readCandidates(tpl.files);
const el = elections.find((e) => e.path === CA_PATH);
if (!el) throw new Error('election não encontrada');
const off = el.offices.find((o) => o.code === 11);
console.log('molde:', off.nome, off.digitos, 'cands', off.candidacies.length);

const P = (code, nome, urna, nasc, genero, ordem = null) => ({
  code: String(code), nome, nomeUrna: urna, fonetico: '',
  nascimento: nasc, genero, situacao: 12,
  ordem, extra: { int: '00', flag: '00' },
});
// Vice titular alternado para variedade; nomes de vices são fictícios (só titulares foram especificados).
// ordem 1 no vice = exigência do motor (CCandidatura: "Ordem de suplente errada" caso contrário).
// Candidaturas fictícias de Lealand (nomes incomuns, sem correspondência real).
off.candidacies = [
  { party: 91, number: 91, titular: P(1, 'Tibúrcio Lemos', 'Tibúrcio', '19720408', 2), label: '', suplentes: [P(2, 'Zulmira Prado', 'Zulmira', '19851130', 4, 1)], groupTail: '3000' },
  { party: 92, number: 92, titular: P(3, 'Dagoberto Sales', 'Dagoberto', '19790917', 2), label: '', suplentes: [P(4, 'Hermínia Fontoura', 'Hermínia', '19880225', 4, 1)], groupTail: '3000' },
  { party: 93, number: 93, titular: P(5, 'Quitéria Vasconcellos', 'Quitéria', '19761103', 4), label: '', suplentes: [P(6, 'Agenor Pimenta', 'Agenor', '19900119', 2, 1)], groupTail: '3000' },
];
el.parties = [
  { number: 91, sigla: 'PGL', nome: 'Partido Gerencial de Lealand' },
  { number: 92, sigla: 'PUL', nome: 'Partido da Uniao de Lealand' },
  { number: 93, sigla: 'PCL', nome: 'Partido Comunitario de Lealand' },
];
el.offices = [off]; // garante cargo único

const photos = new Map([
  ['1', photoOf(tpl, CA_PATH, 1)],
  ['2', photoOf(tpl, CA_PATH, 2)],
  ['3', photoOf(tpl, CA_PATH, 3)],
  ['4', photoOf(tpl, CA_PATH, 4)],
  ['5', photoOf(extra, '/dsk/fi/estatico/t02411ac00001-ca.dat', 5)],
  ['6', photoOf(extra, '/dsk/fi/estatico/t02411ac00001-ca.dat', 6)],
]);
const out = writeCandidates(tpl.files, elections, photos);
console.log('writeCandidates OK');

// ---- 3. cenario.json próprio ----
const cenario = {
  id: 'lealand-gerente', scenario: 'lealand', label: 'Eleição de Lealand — Gerente',
  description: 'Cenário oficial de Lealand: cargo único de Gerente (91 Tibúrcio, 92 Dagoberto, 93 Quitéria).',
  fase: 'te', pe: 2400, uf: 'ac', turno: 2, municipio: 1, zona: 1, secao: 1,
  aliases: [
    { source: '/dsk/fi/estatico', target: '/dsk/fe/estatico' },
    { source: '/dsk/fi/serialv.dat', target: '/dsk/fe/serialv.dat' },
  ],
  data: 'lealand-gerente.data', dataJs: 'lealand-gerente.data.js',
};
out.set('/cenario.json', Buffer.from(JSON.stringify(cenario, null, 2), 'utf8'));

// ---- 4. repack .data + .data.js ----
function repack(files, order, dataName, jsName) {
  const chunks = []; const index = []; let at = 0;
  for (const fn of order) {
    const b = files.get(fn);
    if (!b) throw new Error('arquivo ausente no pack: ' + fn);
    chunks.push(b); index.push({ filename: fn, start: at, end: at + b.length }); at += b.length;
  }
  const data = Buffer.concat(chunks);
  fs.writeFileSync(OUT_BASE + '/' + dataName, data);
  const loaderTpl = fs.readFileSync(TPL_BASE + '/municipal-t2.data.js', 'utf8');
  const head = loaderTpl.slice(0, loaderTpl.lastIndexOf('carregarPacote('));
  const payload = JSON.stringify({ data: dataName, remote_package_size: data.length, files: index });
  fs.writeFileSync(OUT_BASE + '/' + jsName, head + '  carregarPacote(' + payload + ');\n})();\n');
  return { data, index };
}
const order = tpl.meta.files.map((f) => f.filename);
if (!order.includes('/cenario.json')) order.unshift('/cenario.json');
const { data, index } = repack(out, order, 'lealand-gerente.data', 'lealand-gerente.data.js');

// ---- 5. pack OFICIAL (fase 'oficial' no motor; sem TREINAMENTO) ----
// Replica as transformações estruturais de generateOfficialLoad do urnaemu
// (rename t→o, enum de fase 03→02, texto do -cp, ano do -ce). Sem assinaturas:
// o boot de treinamento/apuração SEL não as verifica.
const renameOf = (s) => s.replace(/(^|\/)t(?=\d{5})/g, '$1o')
  .replace(/infomidia-fv-(\d)-t\./g, 'infomidia-fv-$1-o.')
  .replace(/scueconf-t(\d)\./g, 'scueconf-o$1.');
function isPackageId(n) {
  const c = n.children;
  return n.tag === 48 && c?.length === 5 && c[0].tag === 10 && c[1].tag === 48 &&
    c[1].children?.[1]?.tag === 10 && c[2].tag === 27 && c[3].tag === 18 && c[4].tag === 10;
}
const ofFiles = new Map();
for (const [fpath, bytes] of out) {
  const dest = fpath.endsWith('.dat') ? renameOf(fpath) : fpath;
  let dataOut = bytes;
  if (fpath.endsWith('.dat') && fpath !== '/dsk/fi/serialv.dat' && !fpath.endsWith('-rdj.dat') && bytes.length) {
    const n = F.parse(bytes);
    const walk = (x) => {
      if (x.text !== undefined) x.text = renameOf(x.text);
      if (isPackageId(x)) {
        if (!['03', '02'].includes(x.children[1].children[1].hex)) throw new Error('fase inesperada em ' + fpath);
        x.children[1].children[1].hex = '02';
      }
      (x.children || []).forEach(walk);
    };
    walk(n);
    if (fpath.endsWith('-cp.dat')) {
      n.children[1].text = (n.children[1].text || '').replace(/^Treinamento\s+/i, '') + ' - LEALAND';
    }
    if (fpath.endsWith('-ce.dat')) {
      n.children[5].hex = Number('2026').toString(16).padStart(4, '0');
    }
    dataOut = Buffer.from(F.encode(n));
  }
  if (ofFiles.has(dest)) throw new Error('colisão oficial: ' + dest);
  ofFiles.set(dest, dataOut);
}
const cenarioOf = {
  ...cenario,
  id: 'lealand-oficial', label: 'Eleição de Lealand — Gerente (oficial)',
  description: 'Mídia oficial de Lealand: fase oficial do motor (sem TREINAMENTO).',
  fase: 'of',
  data: 'lealand-oficial.data', dataJs: 'lealand-oficial.data.js',
};
ofFiles.set('/cenario.json', Buffer.from(JSON.stringify(cenarioOf, null, 2), 'utf8'));
const ofOrder = order.map((fn) => (fn.endsWith('.dat') ? renameOf(fn) : fn));
repack(ofFiles, ofOrder, 'lealand-oficial.data', 'lealand-oficial.data.js');
fs.writeFileSync(OUT_BASE + '/manifest.json', JSON.stringify({ version: 1, generatedAt: new Date().toISOString().slice(0, 19), scenarios: [cenario, cenarioOf] }, null, 2));
console.log('pack OK:', data.length, 'bytes,', index.length, 'arquivos');
// sanity: reler e validar
const back = readCandidates(new Map(index.map((e) => [e.filename, new Uint8Array(data.subarray(e.start, e.end))])));
console.log(JSON.stringify(back.map((e) => ({ path: e.path, parties: e.parties, offices: e.offices.map((o) => ({ code: o.code, nome: o.nome, digitos: o.digitos, nums: o.candidacies.map((c) => c.number) })) })), null, 2));
