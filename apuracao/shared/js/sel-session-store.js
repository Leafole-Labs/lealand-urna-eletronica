// Armazenamento persistente das sessões eleitorais de Lealand.
// Uma sessão deixa de ser "estado em memória": tudo (votos, eventos,
// artefatos do encerramento) é gravado em localStorage a cada mutação, e o
// ZIP exportado espelha o conteúdo do pendrive da urna.
// Puro ESM, sem DOM (com adaptador de storage injetável para testes).
export const STORE_KEY = 'sel-lealand-sessoes-v1';

const mem = new Map();
const memoryStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => void mem.set(k, String(v)),
  removeItem: (k) => void mem.delete(k)
};

function backend() {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('__sel_probe__', '1');
      localStorage.removeItem('__sel_probe__');
      return localStorage;
    }
  } catch (_) { /* sem armazenamento persistente */ }
  return memoryStorage;
}

function store(storage) {
  return storage || backend();
}

function loadAll(storage) {
  try {
    const raw = store(storage).getItem(STORE_KEY);
    if (!raw) return { sessoes: {}, ordem: [] };
    const o = JSON.parse(raw);
    if (!o || typeof o.sessoes !== 'object' || !Array.isArray(o.ordem)) {
      return { sessoes: {}, ordem: [] };
    }
    return o;
  } catch (_) {
    return { sessoes: {}, ordem: [] };
  }
}

function saveAll(db, storage) {
  store(storage).setItem(STORE_KEY, JSON.stringify(db));
}

function novoId() {
  const d = new Date();
  const p = (v, n = 2) => String(v).padStart(n, '0');
  const data = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const rand = Math.floor(Math.random() * 0xffffff).toString(36).padStart(4, '0');
  return `sel-${data}-${rand}`;
}

/** Abre uma sessão nova (aberta) e a persiste. */
export function criarSessao(storage) {
  const db = loadAll(storage);
  const agora = new Date().toISOString();
  const sessao = {
    versao: 1,
    urna: 'lealand-gerente',
    sessionId: novoId(),
    inicio: agora,
    fim: null,
    estado: 'aberta',
    votos: [],
    eventos: [{ t: agora, tipo: 'ABERTURA', detalhe: 'Sessão eleitoral aberta.' }],
    candidatos: {},
    artefatos: null
  };
  db.sessoes[sessao.sessionId] = sessao;
  db.ordem.unshift(sessao.sessionId);
  saveAll(db, storage);
  return structuredClone(sessao);
}

export function obterSessao(id, storage) {
  const db = loadAll(storage);
  const s = db.sessoes[id];
  return s ? structuredClone(s) : null;
}

export function listarSessoes(storage) {
  const db = loadAll(storage);
  return db.ordem.map((id) => db.sessoes[id]).filter(Boolean).map((s) => ({
    sessionId: s.sessionId,
    inicio: s.inicio,
    fim: s.fim,
    estado: s.estado,
    votos: s.votos.length,
    artefatos: s.artefatos ? Object.keys(s.artefatos.arquivos).length : 0
  }));
}

function gravar(sessao, storage) {
  const db = loadAll(storage);
  db.sessoes[sessao.sessionId] = sessao;
  if (!db.ordem.includes(sessao.sessionId)) db.ordem.unshift(sessao.sessionId);
  saveAll(db, storage);
  return structuredClone(sessao);
}

/** Registra um voto confirmado ({cargo, tipo, numero}) com seq + timestamp. */
export function registrarVoto(id, voto, storage) {
  const db = loadAll(storage);
  const s = db.sessoes[id];
  if (!s) throw new Error('Sessão inexistente.');
  if (s.estado !== 'aberta') throw new Error('Sessão encerrada: voto recusado.');
  if (!['nominal', 'branco', 'nulo'].includes(voto.tipo)) throw new Error('Tipo de voto inválido.');
  const agora = new Date().toISOString();
  s.votos.push({
    seq: s.votos.length + 1,
    cargo: voto.cargo || 'Gerente',
    tipo: voto.tipo,
    numero: String(voto.numero || ''),
    registradoEm: agora
  });
  s.eventos.push({ t: agora, tipo: 'VOTO', detalhe: `seq ${s.votos.length} (${voto.tipo}${voto.numero ? ' ' + voto.numero : ''}).` });
  if (voto.candidatos && !Object.keys(s.candidatos).length) s.candidatos = voto.candidatos;
  return gravar(s, storage);
}

/** Registra evento livre (ex.: CORRIGE exibido, EXPORTACAO). */
export function registrarEvento(id, tipo, detalhe, storage) {
  const db = loadAll(storage);
  const s = db.sessoes[id];
  if (!s) throw new Error('Sessão inexistente.');
  s.eventos.push({ t: new Date().toISOString(), tipo, detalhe: String(detalhe || '') });
  return gravar(s, storage);
}

/**
 * Encerra a sessão e gera os artefatos do pendrive.
 * `construir` = função de sel-result-files que recebe a sessão e devolve
 * `{arquivos: {nome: bytesClasseU8}, resumo}` (os bytes do log.zip em base64).
 */
export async function encerrarSessao(id, construir, storage) {
  const db = loadAll(storage);
  const s = db.sessoes[id];
  if (!s) throw new Error('Sessão inexistente.');
  if (s.estado !== 'aberta') throw new Error('Sessão já encerrada.');
  const agora = new Date().toISOString();
  s.fim = agora;
  s.estado = 'encerrada';
  s.eventos.push({ t: agora, tipo: 'ENCERRAMENTO', detalhe: `Sessão encerrada com ${s.votos.length} voto(s).` });
  const { arquivos, resumo } = await construir(s);
  const b64 = (b) => {
    let out = '';
    for (let i = 0; i < b.length; i += 8192) out += String.fromCharCode(...b.subarray(i, i + 8192));
    return btoa(out);
  };
  const persistidos = {};
  for (const [nome, bytes] of Object.entries(arquivos)) persistidos[nome] = b64(bytes);
  s.artefatos = { geradoEm: agora, arquivos: persistidos, resumo };
  return gravar(s, storage);
}

/** Remove uma sessão do armazenamento. */
export function excluirSessao(id, storage) {
  const db = loadAll(storage);
  delete db.sessoes[id];
  db.ordem = db.ordem.filter((x) => x !== id);
  saveAll(db, storage);
}
