// Artefatos da sessão de Lealand — espelho fiel do modelo do urnaemu.
// Conceitos, nomes, enums e matemática preservados verbatim; codificação em
// JSON (não BER/DER) e SHA-256→apenas-onde-o-urnaemu-usa-SHA-256: a cadeia de
// blocos usa SHA-512 REAL com o formato exato de verify.js do urnaemu:
//   semente = sha512(pad(pleito,5)|pad(idEleicao,5)|pad(mun,5)|pad(zona,4)|
//                    pad(sec,4)|pad(carga,24,' '))
//   bloco   = sha512(HEX_ANTERIOR_MAIUSCULO|seq|codCargo|tipo|qtd[|codigo|partido])
// Assinaturas ECDSA P-521 reais (WebCrypto), perfil de teste documentado
// (espelho de result-signature.js do urnaemu: "EMULATOR TEST SW/HW P521").
// Puro ESM, sem DOM.
import { ELECTION, CANDIDATES, SECAO, PLEITO, URNA_INFO } from './sel-election-config.js';
import { createZip, sha256hex } from './sel-zip.js';

const te = new TextEncoder();
const td = new TextDecoder();

const pad = (v, n, c = '0') => String(v).padStart(n, c);

/** DataHoraJE local: YYYYMMDDThhmmss (labels.js/dataHoraJE do urnaemu). */
export function dataHoraJE(date) {
  const d = date instanceof Date ? date : new Date(date);
  const p = (v, n = 2) => String(v).padStart(n, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function dataHoraBR(date) {
  const d = date instanceof Date ? date : new Date(date);
  const p = (v) => String(v).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function sha512bytes(text) {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-512', te.encode(text)));
}

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s) => Uint8Array.from(s.match(/../g).map((x) => parseInt(x, 16)));
const b64 = (b) => {
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return btoa(s);
};
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** RDV tipoVoto (labels.js do urnaemu): 2 nominal, 3 branco, 4 nulo. */
const RDV_TIPO = { nominal: 2, branco: 3, nulo: 4 };
/** BU tipoVoto: 1 nominal, 2 branco, 3 nulo. */
const BU_TIPO = { nominal: 1, branco: 2, nulo: 3 };
export const RDV_TO_BU = { 2: 1, 3: 2, 4: 3 };

// ---- Identidade de teste SEL (espelho de identity-store do urnaemu) ----
export const IDENTITY_KEY = 'sel-lealand-identidade';
export const IDENTITY_PROFILE = 'SEL-TESTE-P521';

function idBackend() {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch (_) { /* sem persistência */ }
  const mem = new Map();
  return {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => void mem.set(k, String(v))
  };
}

export async function obterOuCriarIdentidade(storage) {
  const back = storage || idBackend();
  try {
    const raw = back.getItem(IDENTITY_KEY);
    if (raw) {
      const rec = JSON.parse(raw);
      if (rec?.privateJwk && rec?.spki) return rec;
    }
  } catch (_) { /* recria */ }
  const par = await globalThis.crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-521' }, true, ['sign', 'verify']);
  const spki = new Uint8Array(await globalThis.crypto.subtle.exportKey('spki', par.publicKey));
  const rec = {
    perfil: IDENTITY_PROFILE,
    algoritmo: 'ECDSA-P-521/SHA-512',
    criadoEm: new Date().toISOString(),
    publicJwk: await globalThis.crypto.subtle.exportKey('jwk', par.publicKey),
    privateJwk: await globalThis.crypto.subtle.exportKey('jwk', par.privateKey),
    spki: b64(spki)
  };
  try {
    back.setItem(IDENTITY_KEY, JSON.stringify(rec));
  } catch (_) { /* usa em memória */ }
  return rec;
}

async function importarChaves(rec) {
  const publica = await globalThis.crypto.subtle.importKey(
    'jwk', rec.publicJwk, { name: 'ECDSA', namedCurve: 'P-521' }, false, ['verify']);
  const privada = await globalThis.crypto.subtle.importKey(
    'jwk', rec.privateJwk, { name: 'ECDSA', namedCurve: 'P-521' }, false, ['sign']);
  return { publica, privada };
}

async function assinar(privada, publica, bytes) {
  const sig = new Uint8Array(await globalThis.crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-512' }, privada, bytes));
  // Autoverificação imediata (espelho de result-signature.js do urnaemu).
  const ok = await globalThis.crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-512' }, publica, sig, bytes);
  if (!ok) throw new Error('Auto-verificação da assinatura falhou.');
  return sig;
}

// ---- Construção dos artefatos ----
export function codigoCargaDaSessao(sessionId) {
  return (String(sessionId).replace(/[^A-Za-z0-9]/g, '').toUpperCase() || 'SEL').slice(0, 24);
}

function votosRdv(sessao) {
  return sessao.votos.map((v) => {
    const tipoVoto = RDV_TIPO[v.tipo] ?? 4;
    const o = { tipoVoto };
    if (v.numero) o.digitacao = String(v.numero);
    return o;
  });
}

/** Ordenação canônica por cargo (espelho do RDV do VOTA, exigida pelo
 *  check `sorted` de verify.js; a ordem de votação segue em seq/registradoEm). */
function ordenarRdv(lista) {
  return [...lista].sort((a, b) => (a.tipoVoto - b.tipoVoto) ||
    String(a.digitacao || '').localeCompare(String(b.digitacao || '')));
}

/** Agrega RDV→BU e calcula a cadeia (port de verify.js:77-96, SHA-512). */
export async function agregarEleicao(votosRdvList, codigoCarga) {
  const cont = {};
  for (const v of votosRdvList) {
    const bu = RDV_TO_BU[v.tipoVoto];
    cont[bu] = cont[bu] || { qtd: 0, porVotavel: new Map() };
    cont[bu].qtd++;
    if (bu === 1 && v.digitacao) {
      const cand = CANDIDATES.find((c) => c.numero === v.digitacao);
      const key = v.digitacao;
      if (!cont[bu].porVotavel.has(key)) {
        cont[bu].porVotavel.set(key, {
          codigo: Number(v.digitacao),
          partido: cand ? cand.partido.numero : Number(String(v.digitacao).slice(0, 2)),
          qtd: 0
        });
      }
      cont[bu].porVotavel.get(key).qtd++;
    }
  }
  const blocos = [];
  for (const numero of [...(cont[1]?.porVotavel.keys() || [])].sort()) {
    const t = cont[1].porVotavel.get(numero);
    blocos.push({ tipoVoto: 1, quantidadeVotos: t.qtd, identificacaoVotavel: { codigo: t.codigo, partido: t.partido } });
  }
  if (cont[2]?.qtd) blocos.push({ tipoVoto: 2, quantidadeVotos: cont[2].qtd });
  if (cont[3]?.qtd) blocos.push({ tipoVoto: 3, quantidadeVotos: cont[3].qtd });

  let digest = await sha512bytes(
    `${pad(PLEITO.idPleito, 5)}|${pad(PLEITO.idEleicao, 5)}|${pad(SECAO.municipio, 5)}|` +
    `${pad(SECAO.zona, 4)}|${pad(SECAO.secao, 4)}|${pad(codigoCarga, 24, ' ')}`);
  const code = ELECTION.cargo.codigo;
  blocos.forEach((bloco, i) => {
    bloco.ordemGeracaoHash = i + 1;
  });
  for (const [i, bloco] of blocos.entries()) {
    const parts = [hex(digest).toUpperCase(), i + 1, code, bloco.tipoVoto, bloco.quantidadeVotos];
    if (bloco.identificacaoVotavel) parts.push(bloco.identificacaoVotavel.codigo, bloco.identificacaoVotavel.partido);
    digest = await sha512bytes(parts.join('|'));
    bloco.hash = hex(digest);
  }
  return { blocos, ultimoHash: hex(digest), total: votosRdvList.length };
}

function linhasBuImpresso(sessao, agreg) {
  const porNumero = new Map();
  for (const b of agreg.blocos) {
    if (b.tipoVoto === 1) porNumero.set(String(b.identificacaoVotavel.codigo).padStart(2, '0'), b.quantidadeVotos);
  }
  const q = (t) => agreg.blocos.find((b) => b.tipoVoto === t)?.quantidadeVotos ?? 0;
  const L = [
    'Supremo Eleitoral de Lealand',
    'Boletim de Urna',
    `Sessao ${sessao.sessionId}`,
    `--${ELECTION.cargo.nome}--`
  ];
  for (const c of CANDIDATES) {
    L.push(`Partido: ${c.partido.numero}`);
    L.push(`  ${c.titular.nome} ${c.numero} ${String(porNumero.get(c.numero) ?? 0).padStart(4, '0')}`);
    L.push(`  Vice: ${c.vice.nome}`);
  }
  L.push(`Brancos ${q(2)}`);
  L.push(`Nulos ${q(3)}`);
  L.push(`Total Apurado ${agreg.total}`);
  return L;
}

function linhasLog(sessao) {
  const L = [];
  for (const e of sessao.eventos) {
    L.push(`${dataHoraBR(e.t)}\tINFO\t${URNA_INFO.urnaId}\tSESSAO\t${e.tipo}${e.detalhe ? ' ' + e.detalhe : ''}`);
  }
  return L;
}

/**
 * Gera todos os artefatos do pendrive para a sessão encerrada.
 * @returns {Promise<{arquivos: Record<string,Uint8Array>, resumo}>}
 */
export async function construirArtefatos(sessao, identidade) {
  const prefixo = PLEITO.prefixo;
  const carga = codigoCargaDaSessao(sessao.sessionId);
  const listaRdv = ordenarRdv(votosRdv(sessao));
  const agreg = await agregarEleicao(listaRdv, carga);
  const ultimoBytes = unhex(agreg.ultimoHash);
  const { publica, privada } = await importarChaves(identidade);
  const assinaturaFinal = await assinar(privada, publica, ultimoBytes);

  const identificacao = {
    municipioZona: { municipio: SECAO.municipio, zona: SECAO.zona },
    local: SECAO.local,
    secao: SECAO.secao
  };
  const abertura = sessao.votos[0]?.registradoEm || sessao.inicio;
  const encerramento = sessao.fim || sessao.inicio;
  const bu = {
    formato: 'sel-bu/1',
    cabecalho: { idEleitoral: { idPleito: PLEITO.idPleito }, dataGeracao: dataHoraJE(encerramento) },
    // Fase reportada pelo motor: 3 treinamento (portal) ou 2 oficial (urna-real).
    fase: sessao.faseNumerica ?? PLEITO.fase,
    identificacaoSecao: identificacao,
    urna: {
      tipoUrna: URNA_INFO.tipoUrna,
      versaoVotacao: URNA_INFO.versaoVotacao,
      correspondenciaResultado: {
        identificacao,
        carga: {
          numeroSerieFC: URNA_INFO.numeroSerieFC,
          dataHoraCarga: dataHoraJE(sessao.inicio),
          codigoCarga: carga
        }
      },
      tipoArquivo: 'votacaoSEL',
      numeroSerieFV: URNA_INFO.numeroSerieFV
    },
    dadosSecao: { dataHoraAbertura: dataHoraJE(abertura), dataHoraEncerramento: dataHoraJE(encerramento) },
    resultadosVotacaoPorEleicao: [{
      idEleicao: PLEITO.idEleicao,
      resultadosVotacao: [{
        tipoCargo: 'majoritario',
        qtdComparecimento: agreg.total,
        totaisVotosCargo: [{
          codigoCargo: ELECTION.cargo.codigo,
          votosVotaveis: agreg.blocos
        }]
      }],
      ultimoHashVotosVotavel: agreg.ultimoHash,
      assinaturaUltimoHashVotosVotavel: b64(assinaturaFinal)
    }],
    dataHoraEmissao: dataHoraJE(encerramento),
    qtdEleitoresCompareceram: agreg.total,
    detalhamentoComparecimento: { semBiometria: agreg.total, porBiometria: 0, porBiografia: 0 }
  };
  const rdv = {
    formato: 'sel-rdv/1',
    pleito: PLEITO.idPleito,
    fase: sessao.faseNumerica ?? PLEITO.fase,
    urna: { tipoUrna: URNA_INFO.tipoUrna, versaoVotacao: URNA_INFO.versaoVotacao, numeroSerieFV: URNA_INFO.numeroSerieFV },
    identificacao,
    eleicoes: [{ idEleicao: PLEITO.idEleicao, votosCargos: [{ idCargo: ELECTION.cargo.codigo, votos: listaRdv }] }]
  };
  const candidaturas = {
    formato: 'sel-candidaturas/1',
    electionId: ELECTION.electionId,
    cargo: ELECTION.cargo.codigo,
    candidaturas: CANDIDATES
  };
  const enc = (o) => te.encode(JSON.stringify(o, null, 2) + '\n');
  const arquivos = {
    [`${prefixo}-bu.json`]: enc(bu),
    [`${prefixo}-rdv.json`]: enc(rdv),
    [`${prefixo}-candidaturas.json`]: enc(candidaturas),
    [`${prefixo}-bu.txt`]: te.encode(linhasBuImpresso(sessao, agreg).join('\n') + '\n'),
    [`${prefixo}-log.zip`]: createZip([{ name: 'logd.dat', data: te.encode(linhasLog(sessao).join('\n') + '\n') }])
  };
  // Catálogo de integridade (espelho de vota.vsc): SHA-512 + P-521 por arquivo.
  const entradas = [];
  for (const [nome, bytes] of Object.entries(arquivos)) {
    const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-512', bytes));
    const sig = await assinar(privada, publica, bytes);
    entradas.push({ nomeArquivo: nome, tamanho: bytes.length, sha512: hex(hash), assinatura: b64(sig) });
  }
  arquivos[`${prefixo}-vota.json`] = enc({
    formato: 'sel-vota/1',
    prefixo,
    geradoEm: new Date().toISOString(),
    perfil: IDENTITY_PROFILE,
    algoritmoHash: 'SHA-512',
    algoritmoAssinatura: 'ECDSA-P-521',
    identidade: { spki: identidade.spki },
    arquivos: entradas
  });
  return {
    arquivos,
    resumo: {
      prefixo,
      codigoCarga: carga,
      blocos: agreg.blocos.length,
      ultimoHash: agreg.ultimoHash,
      total: agreg.total,
      fase: sessao.faseNumerica ?? PLEITO.fase
    }
  };
}

/** ZIP-imagem do pendrive: arquivos no raiz, ordem fixa (espelho de DadosDeUrna). */
export function zipPendrive(arquivos) {
  const ordem = Object.keys(arquivos).sort();
  return createZip(ordem.map((name) => ({ name, data: arquivos[name] })));
}

export { unb64, b64, hex, unhex, te, td };
