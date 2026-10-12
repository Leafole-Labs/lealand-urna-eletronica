// Servidor local da urna real de Lealand (SEL) — SEM dependências externas.
// Somente módulos embutidos do Node (http, crypto, fs, path). Escuta em
// 127.0.0.1 por padrão (--host 0.0.0.0 para a LAN) e serve:
//   /urna/ e /mesario/ (interfaces), /health, /api/zip (pendrive, com token)
//   /ws (WebSocket RFC 6455 implementado aqui; sem Internet, só LAN/localhost)
// Autoridade da sessão: arquivos em data/sessions/<id>.json (fonte de verdade;
// o navegador guarda apenas cópia efêmera). Uso: node server/server.mjs
//   [--host 127.0.0.1] [--port 8765] [--data ./data]   (a partir de urna-real/)
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANDIDATES } from '../shared/sel-election-config.js';
import { construirArtefatos, obterOuCriarIdentidade, zipPendrive } from '../shared/sel-result-files.js';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, '..');

const args = process.argv.slice(2);
const opt = (nome, padrao) => {
  const i = args.indexOf(nome);
  return i >= 0 && args[i + 1] ? args[i + 1] : padrao;
};
const HOST = opt('--host', '127.0.0.1');
const PORT = Number(opt('--port', '8765'));
const DATA = path.resolve(opt('--data', path.join(RAIZ, 'data')));
const DIR_SESSOES = path.join(DATA, 'sessions');

fs.mkdirSync(DIR_SESSOES, { recursive: true });

const PROTOCOLO = 1;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const TECLAS_TESTE = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'B', 'D', 'C'];
const CODIGO_TTL_MS = 5 * 60 * 1000;

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- persistência em disco (fonte autoritativa) ----------
function caminhoSessao(id) {
  if (!/^sel-[A-Za-z0-9-]+$/.test(id)) throw new Error('id de sessão inválido');
  return path.join(DIR_SESSOES, id + '.json');
}
function salvarSessao(sessao) {
  fs.writeFileSync(caminhoSessao(sessao.sessionId), JSON.stringify(sessao, null, 2));
}
function arquivoIdentidade() {
  return path.join(DATA, 'identity.json');
}
function armazenamentoArquivo() {
  return {
    getItem: (k) => {
      if (k !== 'sel-lealand-identidade') return null;
      try {
        return fs.readFileSync(arquivoIdentidade(), 'utf8');
      } catch {
        return null;
      }
    },
    setItem: (k, v) => {
      if (k !== 'sel-lealand-identidade') return;
      fs.writeFileSync(arquivoIdentidade(), String(v));
    }
  };
}
const unb64 = (s) => Uint8Array.from(Buffer.from(s, 'base64'));

// ---------- estado da máquina (espelho do ciclo do urnaemu) ----------
const ESTADOS = ['BOOT', 'SELF_TEST', 'KEYBOARD_TEST', 'PREPARING', 'WAITING_FOR_POLL_WORKER',
  'READY', 'VOTER_AUTHORIZED', 'VOTING', 'VOTE_FINISHED', 'CLOSING', 'CLOSED'];

function novaSessao() {
  const d = new Date();
  const p = (v, n = 2) => String(v).padStart(n, '0');
  const id = `sel-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;
  return {
    versao: 1, urna: 'lealand-gerente', sessionId: id, inicio: d.toISOString(), fim: null,
    estado: 'BOOT', motorFase: 'oficial', faseNumerica: 2, eleitorSeq: 0,
    mesario: null, votos: [], eventos: [], candidatos: {}, artefatos: null
  };
}

const app = {
  sessao: novaSessao(),
  urnaConn: null, // {ws, urnaId, token}
  mesarioConn: null, // {ws, token}
  tokenUrna: null,
  tokenMesario: null,
  pareamento: null, // {codigo, expiraEm}
  eventoSeq: 0
};
salvarSessao(app.sessao);

function evento(sessao, tipo, detalhe, visibilidade = 'publico') {
  sessao.eventos.push({ t: new Date().toISOString(), tipo, detalhe, vis: visibilidade });
  salvarSessao(sessao);
}

// Visão do mesário: NUNCA conteúdo de voto (número, tipo, candidato, RDV).
function visaoMesario() {
  const s = app.sessao;
  return {
    v: PROTOCOLO, type: 'status', state: s.estado, sessionId: s.sessionId,
    urnaId: app.urnaConn?.urnaId || null, urnaConectada: !!app.urnaConn,
    eleitorSeq: s.eleitorSeq, votosCount: s.votos.length,
    mesario: s.mesario ? { nome: s.mesario.nome, matricula: s.mesario.matricula } : null,
    encerrada: s.estado === 'CLOSED',
    eventos: s.eventos.filter((e) => e.vis === 'publico').slice(-30).map((e) => ({ t: e.t, tipo: e.tipo, detalhe: e.detalhe }))
  };
}

function visaoUrna(extra = {}) {
  const s = app.sessao;
  return {
    v: PROTOCOLO, type: 'status', state: s.estado, sessionId: s.sessionId,
    eleitorSeq: s.eleitorSeq,
    pareamento: app.pareamento && Date.now() < app.pareamento.expiraEm && s.estado === 'WAITING_FOR_POLL_WORKER'
      ? { codigo: app.pareamento.codigo, expiraEm: new Date(app.pareamento.expiraEm).toISOString() }
      : null,
    ...extra
  };
}

function difundirUrna(msg) {
  if (app.urnaConn) enviar(app.urnaConn.ws, msg);
}
function difundirMesario(msg) {
  if (app.mesarioConn) enviar(app.mesarioConn.ws, msg);
}

// ---------- WebSocket RFC 6455 (mínimo, texto) ----------
function aceitarWs(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers.upgrade !== 'websocket') {
    socket.write('HTTP/1.1 400 Falha no upgrade\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  return { socket, buf: Buffer.alloc(0), papel: null, token: null, vivo: true };
}

function moldura(texto) {
  const data = Buffer.from(texto, 'utf8');
  const n = data.length;
  let head;
  if (n < 126) head = Buffer.from([0x81, n]);
  else if (n < 65536) head = Buffer.from([0x81, 126, (n >>> 8) & 0xff, n & 0xff]);
  else head = Buffer.from([0x81, 127, 0, 0, 0, 0, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
  return Buffer.concat([head, data]);
}

function enviar(ws, obj) {
  if (!ws || !ws.vivo) return;
  try {
    ws.socket.write(moldura(JSON.stringify(obj)));
  } catch { /* conexão caiu; o 'close' trata */ }
}

function molduraControle(opcode, pay) {
  // Quadros de controle (close/pong) com o mesmo escalonamento de tamanho
  // dos quadros de texto: um comprimento >125 num único byte gera
  // "Invalid frame header" no navegador e derruba a conexão.
  const n = pay.length;
  let head;
  if (n < 126) head = Buffer.from([opcode, n]);
  else if (n < 65536) head = Buffer.from([opcode, 126, (n >>> 8) & 0xff, n & 0xff]);
  else head = Buffer.from([opcode, 127, 0, 0, 0, 0, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
  return Buffer.concat([head, pay]);
}

function fecharWs(ws, codigo = 1000, motivo = '') {
  if (!ws || !ws.vivo) return;
  ws.vivo = false;
  log('ws fechado pelo servidor:', codigo, motivo);
  try {
    const m = Buffer.from(motivo, 'utf8');
    const pay = Buffer.concat([Buffer.from([(codigo >>> 8) & 0xff, codigo & 0xff]), m]);
    ws.socket.write(molduraControle(0x88, pay));
    ws.socket.end();
  } catch { /* já fechado */ }
}

function erro(ws, codigo, detalhe, reqId) {
  enviar(ws, { v: PROTOCOLO, type: 'error', codigo, detalhe, ...(reqId ? { reqId } : {}) });
}

// ---------- protocolo sel-ws/1 ----------
function validarBase(msg) {
  if (!msg || typeof msg !== 'object') return 'mensagem inválida (objeto)';
  if (msg.v !== PROTOCOLO) return `versão de protocolo não suportada (${msg.v ?? 'ausente'}; esperado ${PROTOCOLO})`;
  if (typeof msg.type !== 'string') return 'mensagem sem tipo';
  return null;
}

function exigirToken(ws, msg, papel) {
  if (papel === 'urna') {
    if (!ws.token || ws.token !== app.tokenUrna) return 'urna não registrada (hello primeiro)';
  } else {
    if (!ws.token || ws.token !== app.tokenMesario) return 'terminal não pareado (pair primeiro)';
  }
  return null;
}

const TRANSICOES = {
  BOOT: ['SELF_TEST'],
  SELF_TEST: ['KEYBOARD_TEST'],
  KEYBOARD_TEST: ['PREPARING'],
  PREPARING: ['WAITING_FOR_POLL_WORKER'],
  WAITING_FOR_POLL_WORKER: ['READY'],
  READY: ['VOTER_AUTHORIZED', 'CLOSING'],
  VOTER_AUTHORIZED: ['VOTING'],
  VOTING: ['VOTE_FINISHED'],
  VOTE_FINISHED: ['READY'],
  CLOSING: ['CLOSED'],
  CLOSED: []
};

function transitar(para, motivo) {
  const de = app.sessao.estado;
  if (!TRANSICOES[de]?.includes(para)) {
    return `transição inválida: ${de} → ${para}`;
  }
  app.sessao.estado = para;
  evento(app.sessao, 'ESTADO', `${de} → ${para}${motivo ? ' (' + motivo + ')' : ''}`, 'publico');
  difundirUrna(visaoUrna());
  difundirMesario(visaoMesario());
  return null;
}

const ROL_NUMEROS = new Set(CANDIDATES.map((c) => c.numero));

function validarVoto(v) {
  if (!v || typeof v !== 'object') return 'voto inválido';
  if (!['nominal', 'branco', 'nulo'].includes(v.tipo)) return `tipo de voto inválido (${v.tipo})`;
  if (v.tipo === 'nominal') {
    if (!/^\d{2}$/.test(v.numero || '')) return 'voto nominal sem número';
    if (!ROL_NUMEROS.has(String(v.numero))) return `candidatura desconhecida (${v.numero})`;
  }
  if (v.tipo === 'branco' && v.numero) return 'voto em branco com número';
  if (v.tipo === 'nulo' && v.numero && !/^\d{2}$/.test(v.numero)) return 'voto nulo com número inválido';
  return null;
}

async function rotear(ws, msg) {
  const problema = validarBase(msg);
  if (problema) {
    erro(ws, 'protocolo', problema, msg?.reqId);
    return;
  }
  const { type, reqId } = msg;
  const resp = (obj) => enviar(ws, { v: PROTOCOLO, reqId, ...obj });

  if (type === 'hello') {
    if (msg.role === 'urna') {
      const urnaId = String(msg.urnaId || 'urna-01');
      if (app.urnaConn && app.urnaConn.ws !== ws) {
        erro(ws, 'urna-ocupada', 'outra urna já está conectada', reqId);
        return;
      }
      app.tokenUrna = app.tokenUrna || ('urna-' + crypto.randomBytes(16).toString('hex'));
      app.urnaConn = { ws, urnaId };
      ws.papel = 'urna';
      ws.token = app.tokenUrna;
      resp({ type: 'hello-ok', urnaId, token: app.tokenUrna, sessionId: app.sessao.sessionId });
      enviar(ws, visaoUrna());
      log('urna conectada:', urnaId);
      return;
    }
    if (msg.role === 'mesario') {
      ws.papel = 'mesario';
      if (msg.token && msg.token === app.tokenMesario) {
        app.mesarioConn = { ws, token: msg.token };
        ws.token = msg.token;
        resp({ type: 'hello-ok', retomada: true });
        enviar(ws, visaoMesario());
        log('mesário retomou sessão');
        return;
      }
      resp({ type: 'hello-ok', pareamentoNecessario: true });
      enviar(ws, visaoMesario());
      return;
    }
    erro(ws, 'protocolo', `papel desconhecido (${msg.role})`, reqId);
    return;
  }

  if (type === 'self_test_result') {
    const t = exigirToken(ws, msg, 'urna');
    if (t) {
      erro(ws, 'auth', t, reqId);
      return;
    }
    const checks = Array.isArray(msg.checks) ? msg.checks : [];
    const faltam = ['wasm-sha256', 'dataset-manifest', 'dataset-size'].filter((id) => !checks.some((c) => c.id === id && c.ok));
    if (app.sessao.estado !== 'BOOT' && app.sessao.estado !== 'SELF_TEST') {
      erro(ws, 'estado', `autoteste fora de hora (${app.sessao.estado})`, reqId);
      return;
    }
    if (app.sessao.estado === 'BOOT') {
      const e = transitar('SELF_TEST', 'autoteste recebido');
      if (e) {
        erro(ws, 'estado', e, reqId);
        return;
      }
    }
    if (faltam.length) {
      erro(ws, 'selftest', `autotestes falharam: ${faltam.join(', ')}`, reqId);
      return;
    }
    const e = transitar('KEYBOARD_TEST', 'autotestes OK');
    if (e) erro(ws, 'estado', e, reqId);
    else resp({ type: 'selftest-ok' });
    return;
  }

  if (type === 'key_test_complete') {
    const t = exigirToken(ws, msg, 'urna');
    if (t) {
      erro(ws, 'auth', t, reqId);
      return;
    }
    if (app.sessao.estado !== 'KEYBOARD_TEST') {
      erro(ws, 'estado', `teste de teclado fora de hora (${app.sessao.estado})`, reqId);
      return;
    }
    const teclas = Array.isArray(msg.keys) ? msg.keys : [];
    const faltam = TECLAS_TESTE.filter((k) => !teclas.includes(k));
    if (faltam.length) {
      erro(ws, 'teclado', `teclas não detectadas: ${faltam.join(',')}`, reqId);
      return;
    }
    evento(app.sessao, 'TESTE_TECLADO', `checagem JS concluída: 13 teclas físicas (${teclas.join(',')}).`, 'publico');
    app.pareamento = {
      codigo: String(crypto.randomInt(0, 1000000)).padStart(6, '0'),
      expiraEm: Date.now() + CODIGO_TTL_MS
    };
    log('pareamento emitido (expira em 5min)');
    let e = transitar('PREPARING', 'teclado OK');
    if (e) {
      erro(ws, 'estado', e, reqId);
      return;
    }
    e = transitar('WAITING_FOR_POLL_WORKER', 'pronta para parear');
    if (e) {
      erro(ws, 'estado', e, reqId);
      return;
    }
    resp({ type: 'keytest-ok' });
    return;
  }

  if (type === 'pair') {
    if (ws.papel !== 'mesario') {
      erro(ws, 'auth', 'pareamento é do terminal do mesário', reqId);
      return;
    }
    if (app.mesarioConn && app.mesarioConn.ws !== ws) {
      erro(ws, 'pareamento', 'outro terminal já controla esta urna', reqId);
      return;
    }
    const p = app.pareamento;
    if (!p || Date.now() > p.expiraEm || String(msg.code) !== p.codigo) {
      erro(ws, 'pareamento', 'código inválido ou expirado', reqId);
      return;
    }
    app.tokenMesario = 'mesario-' + crypto.randomBytes(16).toString('hex');
    app.mesarioConn = { ws, token: app.tokenMesario };
    ws.token = app.tokenMesario;
    app.pareamento = null;
    evento(app.sessao, 'PAREAMENTO', 'Terminal do mesário pareado.', 'publico');
    resp({ type: 'paired', token: app.tokenMesario });
    enviar(ws, visaoMesario());
    log('mesário pareado');
    return;
  }

  if (type === 'register_mesario') {
    const t = exigirToken(ws, msg, 'mesario');
    if (t) {
      erro(ws, 'auth', t, reqId);
      return;
    }
    const nome = String(msg.nome || '').trim();
    const matricula = String(msg.matricula || '').trim();
    if (nome.length < 3 || matricula.length < 3) {
      erro(ws, 'registro', 'nome e matrícula fictícios com ao menos 3 caracteres', reqId);
      return;
    }
    if (app.sessao.estado !== 'WAITING_FOR_POLL_WORKER') {
      erro(ws, 'estado', `registro fora de hora (${app.sessao.estado})`, reqId);
      return;
    }
    app.sessao.mesario = { nome, matricula, registradoEm: new Date().toISOString() };
    evento(app.sessao, 'REGISTRO_MESARIO', `${nome} (${matricula}).`, 'publico');
    const e = transitar('READY', 'mesário registrado');
    if (e) erro(ws, 'estado', e, reqId);
    else resp({ type: 'registered' });
    return;
  }

  if (type === 'authorize_voter') {
    const t = exigirToken(ws, msg, 'mesario');
    if (t) {
      erro(ws, 'auth', t, reqId);
      return;
    }
    if (app.sessao.estado !== 'READY') {
      erro(ws, 'estado', `habilitação recusada em ${app.sessao.estado} (só em READY)`, reqId);
      return;
    }
    app.sessao.eleitorSeq += 1;
    evento(app.sessao, 'HABILITACAO', `Eleitor nº ${app.sessao.eleitorSeq} habilitado.`, 'publico');
    const e = transitar('VOTER_AUTHORIZED', `eleitor ${app.sessao.eleitorSeq}`);
    if (e) {
      erro(ws, 'estado', e, reqId);
      return;
    }
    resp({ type: 'voter_authorized', eleitorSeq: app.sessao.eleitorSeq });
    difundirUrna({ v: PROTOCOLO, type: 'voter_authorized', sessionId: app.sessao.sessionId, eleitorSeq: app.sessao.eleitorSeq });
    return;
  }

  if (type === 'voting_started') {
    const t = exigirToken(ws, msg, 'urna');
    if (t) {
      erro(ws, 'auth', t, reqId);
      return;
    }
    if (app.sessao.estado !== 'VOTER_AUTHORIZED') {
      erro(ws, 'estado', `início de voto fora de hora (${app.sessao.estado})`, reqId);
      return;
    }
    const e = transitar('VOTING', `eleitor ${app.sessao.eleitorSeq}`);
    if (e) erro(ws, 'estado', e, reqId);
    return;
  }

  if (type === 'vote_cast') {
    const t = exigirToken(ws, msg, 'urna');
    if (t) {
      erro(ws, 'auth', t, reqId);
      return;
    }
    if (ws.papel !== 'urna') {
      erro(ws, 'auth', 'só a urna registra votos', reqId);
      return;
    }
    if (app.sessao.estado !== 'VOTING') {
      erro(ws, 'estado', `voto fora de hora (${app.sessao.estado})`, reqId);
      return;
    }
    const voto = msg.vote || {};
    const pv = validarVoto(voto);
    if (pv) {
      erro(ws, 'voto', pv, reqId);
      return;
    }
    if (app.sessao.votos.some((x) => x.clientVoteId === msg.clientVoteId)) {
      resp({ type: 'vote-ack', clientVoteId: msg.clientVoteId, seq: app.sessao.votos.find((x) => x.clientVoteId === msg.clientVoteId).seq, duplicado: true });
      return;
    }
    const agora = new Date().toISOString();
    app.sessao.votos.push({
      seq: app.sessao.votos.length + 1,
      clientVoteId: msg.clientVoteId || null,
      cargo: 'Gerente',
      tipo: voto.tipo,
      numero: String(voto.numero || ''),
      registradoEm: agora
    });
    // Evento sigiloso: jamais encaminhado ao mesário.
    evento(app.sessao, 'VOTO', `seq ${app.sessao.votos.length} (${voto.tipo}${voto.numero ? ' ' + voto.numero : ''}).`, 'sigiloso');
    resp({ type: 'vote-ack', clientVoteId: msg.clientVoteId, seq: app.sessao.votos.length });
    return;
  }

  if (type === 'vote_finished') {
    const t = exigirToken(ws, msg, 'urna');
    if (t) {
      erro(ws, 'auth', t, reqId);
      return;
    }
    if (app.sessao.estado !== 'VOTING') {
      erro(ws, 'estado', `fim de voto fora de hora (${app.sessao.estado})`, reqId);
      return;
    }
    const e = transitar('VOTE_FINISHED', `eleitor ${app.sessao.eleitorSeq}`);
    if (e) {
      erro(ws, 'estado', e, reqId);
      return;
    }
    resp({ type: 'finish-ack' });
    return;
  }

  if (type === 'voter_ready') {
    const t = exigirToken(ws, msg, 'urna');
    if (t) {
      erro(ws, 'auth', t, reqId);
      return;
    }
    if (app.sessao.estado !== 'VOTE_FINISHED') {
      erro(ws, 'estado', `pronto fora de hora (${app.sessao.estado})`, reqId);
      return;
    }
    const e = transitar('READY', 'urna pronta para o próximo');
    if (e) erro(ws, 'estado', e, reqId);
    else resp({ type: 'ready-ack' });
    return;
  }

  if (type === 'sync_push') {
    const t = exigirToken(ws, msg, 'urna');
    if (t) {
      erro(ws, 'auth', t, reqId);
      return;
    }
    const lista = Array.isArray(msg.votes) ? msg.votes : [];
    const acks = [];
    let novos = 0;
    for (const voto of lista) {
      if (validarVoto(voto)) continue;
      const existente = voto.clientVoteId && app.sessao.votos.find((x) => x.clientVoteId === voto.clientVoteId);
      if (existente) {
        if (voto.clientVoteId) acks.push(voto.clientVoteId);
        continue;
      }
      app.sessao.votos.push({
        seq: app.sessao.votos.length + 1,
        clientVoteId: voto.clientVoteId || null,
        cargo: 'Gerente',
        tipo: voto.tipo,
        numero: String(voto.numero || ''),
        registradoEm: voto.registradoEm || new Date().toISOString()
      });
      evento(app.sessao, 'VOTO', `seq ${app.sessao.votos.length} (sincronizado).`, 'sigiloso');
      if (voto.clientVoteId) acks.push(voto.clientVoteId);
      novos++;
    }
    resp({ type: 'sync-ack', acks, novos, total: app.sessao.votos.length });
    difundirMesario(visaoMesario());
    return;
  }

  if (type === 'close_session') {
    const t = exigirToken(ws, msg, 'mesario');
    if (t) {
      erro(ws, 'auth', t, reqId);
      return;
    }
    if (app.sessao.estado !== 'READY') {
      erro(ws, 'estado', `encerramento recusado em ${app.sessao.estado} (só em READY)`, reqId);
      return;
    }
    let e = transitar('CLOSING', 'encerramento solicitado');
    if (e) {
      erro(ws, 'estado', e, reqId);
      return;
    }
    try {
      const identidade = await obterOuCriarIdentidade(armazenamentoArquivo());
      const { construirArtefatos, zipPendrive } = await import('../shared/sel-result-files.js');
      const s = app.sessao;
      s.fim = new Date().toISOString();
      evento(s, 'ENCERRAMENTO', `Sessão encerrada com ${s.votos.length} voto(s).`, 'publico');
      const { arquivos, resumo } = await construirArtefatos(s, identidade);
      const b64 = (b) => Buffer.from(b).toString('base64');
      const persistidos = {};
      for (const [nome, bytes] of Object.entries(arquivos)) persistidos[nome] = b64(bytes);
      s.artefatos = { geradoEm: new Date().toISOString(), arquivos: persistidos, resumo };
      salvarSessao(s);
      app.zipPendrive = zipPendrive(arquivos);
      e = transitar('CLOSED', `${Object.keys(persistidos).length} artefatos`);
      if (e) throw new Error(e);
      resp({ type: 'session_closed', zipUrl: '/api/zip?token=' + app.tokenMesario });
      difundirUrna({ v: PROTOCOLO, type: 'session_closed', sessionId: s.sessionId });
    } catch (err) {
      erro(ws, 'encerramento', String(err?.message ?? err), reqId);
    }
    return;
  }

  erro(ws, 'protocolo', `tipo desconhecido (${type})`, reqId);
}

function aoDesconectar(ws) {
  if (app.urnaConn?.ws === ws) {
    app.urnaConn = null;
    log('urna desconectada (estado preservado:', app.sessao.estado + ')');
    difundirMesario(visaoMesario());
  }
  if (app.mesarioConn?.ws === ws) {
    app.mesarioConn = null;
    log('mesário desconectado (token mantido para retomada)');
  }
}

// ---------- HTTP: estáticos + /health + /api/zip ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm',
  '.data': 'application/octet-stream', '.version': 'text/plain; charset=utf-8',
  '.zip': 'application/zip', '.txt': 'text/plain; charset=utf-8'
};

function servirEstatico(req, res) {
  const url = new URL(req.url, 'http://x');
  let p = decodeURIComponent(url.pathname);
  if (p === '/') {
    res.writeHead(302, { Location: '/urna/' });
    res.end();
    return;
  }
  // Sessões e código do servidor nunca saem por HTTP.
  if (p === '/data' || p.startsWith('/data/') || p === '/server' || p.startsWith('/server/') || p.includes('/.')) {
    res.writeHead(403);
    res.end('proibido');
    return;
  }
  if (p.endsWith('/')) p += 'index.html';
  const arq = path.normalize(path.join(RAIZ, p));
  if (!arq.startsWith(RAIZ + path.sep) && arq !== RAIZ) {
    res.writeHead(403);
    res.end('proibido');
    return;
  }
  fs.stat(arq, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404);
      res.end('não encontrado');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(arq)] || 'application/octet-stream' });
    fs.createReadStream(arq).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, protocolo: PROTOCOLO, estado: app.sessao.estado, sessionId: app.sessao.sessionId }));
    return;
  }
  if (url.pathname === '/api/zip') {
    const token = url.searchParams.get('token');
    if (!token || token !== app.tokenMesario) {
      res.writeHead(401);
      res.end('terminal não pareado');
      return;
    }
    if (app.sessao.estado !== 'CLOSED' || !app.zipPendrive) {
      res.writeHead(409);
      res.end('sessão ainda não encerrada');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="pendrive-lealand-${app.sessao.sessionId}.zip"`
    });
    res.end(Buffer.from(app.zipPendrive));
    return;
  }
  if (req.headers.upgrade === 'websocket') {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws') {
      req.socket.write('HTTP/1.1 404 WebSocket aqui é em /ws\r\nConnection: close\r\n\r\n');
      req.socket.destroy();
      return;
    }
    const ws = aceitarWs(req, req.socket);
    if (!ws) return;
    req.socket.on('data', (chunk) => aoReceber(ws, chunk));
    req.socket.on('close', () => {
      ws.vivo = false;
      aoDesconectar(ws);
    });
    req.socket.on('error', () => {
      ws.vivo = false;
      aoDesconectar(ws);
    });
    return;
  }
  servirEstatico(req, res);
});

// ---------- quadros WS ----------
function aoReceber(ws, chunk) {
  ws.buf = Buffer.concat([ws.buf, chunk]);
  for (;;) {
    if (ws.buf.length < 2) return;
    const b0 = ws.buf[0], b1 = ws.buf[1];
    const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
    if (!fin || opcode === 0) {
      erro(ws, 'protocolo', 'fragmentação não suportada');
      fecharWs(ws, 1002, 'fragmentado');
      return;
    }
    let n = b1 & 0x7f, at = 2;
    if (n === 126) {
      if (ws.buf.length < 4) return;
      n = ws.buf.readUInt16BE(2);
      at = 4;
    } else if (n === 127) {
      if (ws.buf.length < 10) return;
      const hi = ws.buf.readUInt32BE(2);
      if (hi !== 0) {
        fecharWs(ws, 1009, 'grande demais');
        return;
      }
      n = ws.buf.readUInt32BE(6);
      at = 10;
    }
    if (n > 1024 * 1024) {
      fecharWs(ws, 1009, 'grande demais');
      return;
    }
    const head = at + (masked ? 4 : 0);
    if (ws.buf.length < head + n) return;
    const mask = masked ? ws.buf.subarray(at, at + 4) : null;
    const pay = ws.buf.subarray(head, head + n);
    ws.buf = ws.buf.subarray(head + n);
    if (opcode === 0x8) {
      ws.vivo = false;
      aoDesconectar(ws);
      try {
        ws.socket.end();
      } catch { /* já fechado */ }
      return;
    }
    if (opcode === 0x9) {
      try {
        ws.socket.write(molduraControle(0x8a, Buffer.from(pay)));
      } catch { /* já fechado */ }
      continue;
    }
    if (opcode === 0xa) continue;
    if (opcode !== 0x1) {
      erro(ws, 'protocolo', 'somente quadros de texto');
      continue;
    }
    if (!masked) {
      erro(ws, 'protocolo', 'quadro do cliente sem máscara');
      fecharWs(ws, 1002, 'sem máscara');
      return;
    }
    const dec = Buffer.alloc(n);
    for (let i = 0; i < n; i++) dec[i] = pay[i] ^ mask[i % 4];
    let msg;
    try {
      msg = JSON.parse(dec.toString('utf8'));
    } catch {
      erro(ws, 'protocolo', 'JSON inválido');
      continue;
    }
    Promise.resolve(rotear(ws, msg)).catch((e) => erro(ws, 'interno', String(e?.message ?? e)));
  }
}

server.listen(PORT, HOST, () => {
  log(`urna-real SEL em http://${HOST}:${PORT}/ (urna em /urna/, mesário em /mesario/)`);
  log(`sessão ${app.sessao.sessionId} aberta (BOOT)`);
});

export { app, TRANSICOES, PROTOCOLO };
