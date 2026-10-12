// Verificação dos artefatos da sessão — port de results/verify.js do urnaemu
// para o espelho JSON de Lealand (cadeia SHA-512 e checagens idênticas;
// assinatura P-521 real via WebCrypto; BER/DER não é reimplementado).
// Puro ESM, sem DOM.
import { hex, unhex, b64, unb64, td, RDV_TO_BU } from './sel-result-files.js';

const pad = (v, n, c = '0') => String(v).padStart(n, c);

async function sha512bytes(text) {
  return new Uint8Array(await globalThis.crypto.subtle.digest(
    'SHA-512', typeof text === 'string' ? new TextEncoder().encode(text) : text));
}

export const FORMATOS = {
  bu: 'sel-bu/1',
  rdv: 'sel-rdv/1',
  vsc: 'sel-vota/1',
  cand: 'sel-candidaturas/1'
};

export function findResultFiles(names) {
  const pick = (suffix) => names.find((n) => n.endsWith(suffix)) ?? null;
  return {
    bu: pick('-bu.json'),
    rdv: pick('-rdv.json'),
    vsc: pick('-vota.json'),
    log: pick('-log.zip'),
    txt: pick('-bu.txt'),
    cand: pick('-candidaturas.json')
  };
}

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();

/** Port de parsePrintedBu do urnaemu (linhas do bu.txt). */
export function parsePrintedBu(text) {
  const lines = String(text).split('\n');
  const start = lines.findIndex((l) => /^Boletim de Urna$/i.test(l.trim()));
  if (start < 0) return [];
  const offices = [];
  let office = null, party = null;
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trimEnd();
    if (/BU DIGITAL|Boletim de Justificativa/i.test(line)) break;
    const header = /^-{2,}([^-].*?[^-])-{2,}$/.exec(line.trim());
    if (header && !/\d+\s*\/\s*\d+/.test(header[1])) {
      office = { name: header[1].trim(), key: norm(header[1]), candidates: {}, legenda: {}, brancos: 0, nulos: 0, apurado: 0 };
      offices.push(office);
      party = null;
      continue;
    }
    if (!office) continue;
    let m;
    if ((m = /^Partido:\s*(\d+)/.exec(line))) party = Number(m[1]);
    else if ((m = /^\s*Votos de legenda\s+(\d+)$/.exec(line)) && party !== null) office.legenda[party] = Number(m[1]);
    else if ((m = /^Brancos\s+(\d+)$/.exec(line))) office.brancos = Number(m[1]);
    else if ((m = /^Nulos\s+(\d+)$/.exec(line))) office.nulos = Number(m[1]);
    else if ((m = /^Total Apurado\s+(\d+)$/.exec(line))) office.apurado = Number(m[1]);
    else if ((m = /^\s+.*?\s(\d{2,5})\s+(\d{4})$/.exec(line))) office.candidates[Number(m[1])] = Number(m[2]);
  }
  return offices;
}

async function importarSpki(spkiB64) {
  return globalThis.crypto.subtle.importKey(
    'spki', unb64(spkiB64), { name: 'ECDSA', namedCurve: 'P-521' }, false, ['verify']);
}

/**
 * @param {Map<string,Uint8Array>} files arquivos do ZIP por nome
 * @returns {Promise<{ok, checks, names, bu, rdv, vsc, elections, tally}>}
 */
export async function verifyResultFiles(files) {
  const names = findResultFiles([...files.keys()]);
  const checks = [];
  const check = (id, ok, detail) => checks.push({ id, ok: !!ok, detail });
  const need = ['bu', 'rdv', 'vsc', 'cand'];
  const faltam = need.filter((k) => !names[k]);
  if (faltam.length) {
    return {
      ok: false, names, checks: [{ id: 'arquivos', ok: false, detail: `Ausentes: ${faltam.join(', ')}.` }],
      bu: null, rdv: null, vsc: null, elections: [], tally: null
    };
  }
  const J = (n) => JSON.parse(new TextDecoder().decode(files.get(n)));
  let bu, rdv, vsc, cand;
  try {
    bu = J(names.bu);
    rdv = J(names.rdv);
    vsc = J(names.vsc);
    cand = J(names.cand);
  } catch {
    return { ok: false, names, checks: [{ id: 'json', ok: false, detail: 'Arquivo JSON inválido.' }], bu: null, rdv: null, vsc: null, elections: [], tally: null };
  }

  check('schema', [bu, rdv, vsc, cand].every((o) => o && typeof o === 'object'), 'bu, rdv, vota e candidaturas íntegros como JSON.');
  check('versao', bu.formato === FORMATOS.bu && rdv.formato === FORMATOS.rdv &&
    vsc.formato === FORMATOS.vsc && cand.formato === FORMATOS.cand,
    `formatos ${bu.formato}/${rdv.formato}/${vsc.formato}/${cand.formato}`);
  check('phase', bu.fase === rdv.fase && [1, 2, 3].includes(bu.fase), `fase ${bu.fase} (2 = motor em fase oficial)`);
  check('pleito', bu.cabecalho?.idEleitoral?.idPleito === rdv.pleito, `pleito ${rdv.pleito}`);
  const sec = (o) => JSON.stringify(o?.identificacaoSecao ?? o?.identificacao);
  check('section', sec(bu) === sec(rdv), sec(bu));
  const u = (o) => JSON.stringify({ t: o?.urna?.tipoUrna, v: o?.urna?.versaoVotacao, s: o?.urna?.numeroSerieFV });
  check('urna', u(bu) === u(rdv));
  check('cargo', bu.resultadosVotacaoPorEleicao?.every((e) =>
    e.resultadosVotacao?.every((g) => g.totaisVotosCargo?.every((o) => o.codigoCargo === 11))) ?? false, 'cargo 11 Gerente');

  // Catálogo vota.json: hashes + assinaturas por arquivo.
  let chave = null;
  try {
    chave = await importarSpki(vsc.identidade.spki);
    check('certificado', true, `SPKI P-521 (${vsc.perfil})`);
  } catch (e) {
    check('certificado', false, String(e?.message ?? e));
  }
  if (Array.isArray(vsc.arquivos)) {
    for (const e of vsc.arquivos) {
      const bytes = files.get(e.nomeArquivo);
      if (!bytes) {
        check(`arquivo:${e.nomeArquivo}`, false, 'ausente no ZIP');
        continue;
      }
      const h = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-512', bytes));
      const hashOk = hex(h) === e.sha512 && bytes.length === e.tamanho;
      let sigOk = false;
      if (chave && hashOk) {
        try {
          sigOk = await globalThis.crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-512' }, chave, unb64(e.assinatura), bytes);
        } catch { sigOk = false; }
      }
      check(`arquivo:${e.nomeArquivo}`, hashOk && sigOk, hashOk ? (sigOk ? undefined : 'assinatura inválida') : 'hash/tamanho diverge');
    }
  } else {
    check('catalogo', false, 'vota.json sem lista de arquivos');
  }

  // Cadeia por eleição (matemática idêntica a verify.js:77-96).
  const elections = [];
  const section = bu.urna.correspondenciaResultado.identificacao;
  const mz = section.municipioZona;
  const carga = bu.urna.correspondenciaResultado.carga.codigoCarga;
  for (const election of bu.resultadosVotacaoPorEleicao ?? []) {
    const id = election.idEleicao;
    let digest = await sha512bytes(
      `${pad(rdv.pleito, 5)}|${pad(id, 5)}|${pad(mz.municipio, 5)}|` +
      `${pad(mz.zona, 4)}|${pad(section.secao, 4)}|${pad(carga, 24, ' ')}`);
    const totals = new Map();
    let blocks = 0, chainOk = true;
    for (const group of election.resultadosVotacao ?? []) {
      for (const office of group.totaisVotosCargo ?? []) {
        const code = office.codigoCargo, counts = {};
        for (const [i, vote] of (office.votosVotaveis ?? []).entries()) {
          if (vote.ordemGeracaoHash !== i + 1) chainOk = false;
          const parts = [hex(digest).toUpperCase(), i + 1, code, vote.tipoVoto, vote.quantidadeVotos];
          if (vote.identificacaoVotavel) parts.push(vote.identificacaoVotavel.codigo, vote.identificacaoVotavel.partido);
          digest = await sha512bytes(parts.join('|'));
          if (hex(digest) !== vote.hash) chainOk = false;
          blocks++;
          counts[vote.tipoVoto] = (counts[vote.tipoVoto] ?? 0) + vote.quantidadeVotos;
        }
        totals.set(code, counts);
      }
    }
    const finalOk = hex(digest) === election.ultimoHashVotosVotavel;
    let signatureOk = null;
    if (chave && election.assinaturaUltimoHashVotosVotavel) {
      try {
        signatureOk = await globalThis.crypto.subtle.verify(
          { name: 'ECDSA', hash: 'SHA-512' }, chave,
          unb64(election.assinaturaUltimoHashVotosVotavel), unhex(election.ultimoHashVotosVotavel));
      } catch { signatureOk = false; }
    }
    check(`chain:${id}`, chainOk, `${blocks} blocos`);
    check(`final:${id}`, finalOk);
    if (signatureOk !== null) check(`signature:${id}`, signatureOk);

    // Votáveis nominais precisam existir no rol de candidaturas.
    const roll = new Set(((cand && cand.candidaturas) || []).map((c) => c.numero));
    let votaveisOk = true;
    for (const group of election.resultadosVotacao ?? []) {
      for (const office of group.totaisVotosCargo ?? []) {
        for (const vote of office.votosVotaveis ?? []) {
          if (vote.tipoVoto === 1 && !roll.has(String(vote.identificacaoVotavel?.codigo).padStart(2, '0'))) {
            votaveisOk = false;
          }
        }
      }
    }
    check(`votaveis:${id}`, votaveisOk);

    // RDV × BU: totais e ordenação (verify.js:109-121).
    const rdvEl = (rdv.eleicoes ?? []).find((e) => e.idEleicao === id);
    for (const office of rdvEl?.votosCargos ?? []) {
      const code = office.idCargo, votes = office.votos ?? [];
      const keys = votes.map((v) => [v.tipoVoto, v.digitacao ?? '']);
      const sorted = keys.every((k, i) => i === 0 || keys[i - 1][0] < k[0] ||
        (keys[i - 1][0] === k[0] && String(keys[i - 1][1]) <= String(k[1])));
      const counts = {};
      for (const v of votes) counts[RDV_TO_BU[v.tipoVoto]] = (counts[RDV_TO_BU[v.tipoVoto]] ?? 0) + 1;
      const buCounts = totals.get(code) ?? {};
      const matches = JSON.stringify(Object.entries(counts).sort()) === JSON.stringify(Object.entries(buCounts).sort());
      check(`totals:${id}:${code}`, matches);
      check(`sorted:${id}:${code}`, sorted);
    }
    elections.push({ id, chainOk, finalOk, signatureOk, blocks });
  }

  // Impresso × BU (bu.txt com as regras de parsePrintedBu).
  if (names.txt && files.has(names.txt)) {
    const imp = parsePrintedBu(td.decode(files.get(names.txt)));
    const g = imp.find((o) => o.key.includes('GERENTE'));
    const el = bu.resultadosVotacaoPorEleicao?.[0]?.resultadosVotacao?.[0]?.totaisVotosCargo?.[0];
    const cont = {};
    for (const v of el?.votosVotaveis ?? []) {
      if (v.tipoVoto === 1) cont[v.identificacaoVotavel.codigo] = v.quantidadeVotos;
      else if (v.tipoVoto === 2) cont.brancos = v.quantidadeVotos;
      else if (v.tipoVoto === 3) cont.nulos = v.quantidadeVotos;
    }
    const somaBu = (el?.votosVotaveis ?? []).reduce((a, v) => a + v.quantidadeVotos, 0);
    const confere = !!g && g.apurado === somaBu &&
      (g.brancos === (cont.brancos ?? 0)) && (g.nulos === (cont.nulos ?? 0)) &&
      Object.entries(cont).every(([k, v]) => k === 'brancos' || k === 'nulos' || g.candidates[Number(k)] === v);
    check('impresso', confere, g ? `impresso confere (${somaBu})` : 'bloco Gerente ausente no impresso');
  }

  // Tally para o boletim.
  const tally = { porNumero: {}, brancos: 0, nulos: 0, total: 0 };
  const el0 = bu.resultadosVotacaoPorEleicao?.[0]?.resultadosVotacao?.[0]?.totaisVotosCargo?.[0];
  for (const v of el0?.votosVotaveis ?? []) {
    if (v.tipoVoto === 1) tally.porNumero[String(v.identificacaoVotavel.codigo).padStart(2, '0')] = v.quantidadeVotos;
    else if (v.tipoVoto === 2) tally.brancos = v.quantidadeVotos;
    else if (v.tipoVoto === 3) tally.nulos = v.quantidadeVotos;
    tally.total += v.quantidadeVotos;
  }
  return { names, bu, rdv, vsc, elections, checks, tally, ok: checks.every((c) => c.ok) };
}
