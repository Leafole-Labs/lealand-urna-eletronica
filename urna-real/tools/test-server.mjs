// Testes do servidor urna-real (protocolo sel-ws/1, máquina de estados,
// pareamento, sigilo, quedas). Cada teste sobe seu próprio servidor
// (isolamento total de sessão). Uso: node --test tools/test-server.mjs
// (a partir de urna-real/)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, '..');
let proximaPorta = 19100;

function esperar(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Cliente WebSocket mínimo (texto, com máscara, comprimentos 16-bit).
function conectar(porta) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(porta, '127.0.0.1', () => {
      const key = crypto.randomBytes(16).toString('base64');
      sock.write('GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    const cli = {
      sock, buf: Buffer.alloc(0), fila: [], espera: [], stash: [],
      enviar(o) {
        const data = Buffer.from(JSON.stringify(o), 'utf8');
        const mask = crypto.randomBytes(4);
        let head;
        if (data.length < 126) head = Buffer.from([0x81, 0x80 | data.length]);
        else head = Buffer.from([0x81, 0x80 | 126, (data.length >>> 8) & 0xff, data.length & 0xff]);
        const out = Buffer.alloc(head.length + 4 + data.length);
        head.copy(out, 0);
        mask.copy(out, head.length);
        for (let i = 0; i < data.length; i++) out[head.length + 4 + i] = data[i] ^ mask[i % 4];
        sock.write(out);
      },
      async proxima(timeoutMs = 5000) {
        const achada = cli.fila.shift();
        if (achada) return achada;
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error('tempo esgotado aguardando mensagem')), timeoutMs);
          cli.espera.push((m) => {
            clearTimeout(t);
            res(m);
          });
        });
      },
      fechar() {
        sock.destroy();
      }
    };
    let cabecalho = Buffer.alloc(0);
    let trocou = false;
    sock.on('data', (chunk) => {
      if (!trocou) {
        cabecalho = Buffer.concat([cabecalho, chunk]);
        const i = cabecalho.indexOf('\r\n\r\n');
        if (i < 0) return;
        if (!cabecalho.subarray(0, i).toString().includes('101')) {
          reject(new Error('handshake recusado'));
          return;
        }
        trocou = true;
        chunk = cabecalho.subarray(i + 4);
        cabecalho = null;
      }
      cli.buf = Buffer.concat([cli.buf, chunk]);
      for (;;) {
        if (cli.buf.length < 2) return;
        const op = cli.buf[0] & 0x0f;
        let n = cli.buf[1] & 0x7f, at = 2;
        if (n === 126) {
          if (cli.buf.length < 4) return;
          n = cli.buf.readUInt16BE(2);
          at = 4;
        } else if (n === 127) return;
        if (cli.buf.length < at + n) return;
        const pay = cli.buf.subarray(at, at + n);
        cli.buf = cli.buf.subarray(at + n);
        if (op === 0x8) {
          cli.fila.push({ type: '(close)' });
        } else if (op === 0x1) {
          const msg = JSON.parse(pay.toString('utf8'));
          const w = cli.espera.shift();
          if (w) w(msg);
          else cli.fila.push(msg);
        }
      }
    });
    sock.on('error', () => {});
    const checar = setInterval(() => {
      if (trocou) {
        clearInterval(checar);
        resolve(cli);
      }
    }, 20);
    setTimeout(() => reject(new Error('sem handshake')), 5000);
  });
}

// Próxima mensagem que NÃO seja status difundido (status vai p/ o stash,
// de onde ateEstado a recupera — nada é descartado).
async function resposta(cli, n = 60) {
  for (let i = 0; i < n; i++) {
    const m = await cli.proxima();
    if (m.type !== 'status') return m;
    cli.stash.push(m);
  }
  throw new Error('sem resposta (só status)');
}

async function ateEstado(cli, estado) {
  for (let i = cli.stash.length - 1; i >= 0; i--) {
    if (cli.stash[i].type === 'status' && cli.stash[i].state === estado) {
      const achado = cli.stash[i];
      cli.stash.length = 0;
      return achado;
    }
  }
  cli.stash.length = 0;
  for (let i = 0; i < 150; i++) {
    const m = await cli.proxima();
    if (m.type === 'status' && m.state === estado) {
      cli.stash.length = 0;
      return m;
    }
    if (m.type === 'status') cli.stash.push(m);
  }
  throw new Error('estado ' + estado + ' não chegou');
}

async function helloUrna(cli, urnaId = 'urna-01') {
  cli.enviar({ v: 1, type: 'hello', role: 'urna', urnaId });
  const ok = await resposta(cli);
  assert.equal(ok.type, 'hello-ok');
  return ok;
}

async function comServidor(fn) {
  const porta = proximaPorta++;
  const dados = fs.mkdtempSync(path.join(os.tmpdir(), 'urna-real-test-'));
  const srv = spawn(process.execPath, [path.join(RAIZ, 'server/server.mjs'), '--port', String(porta), '--data', dados], process.env.SRV_DEBUG ? { stdio: 'inherit' } : { stdio: 'ignore' });
  try {
    for (let i = 0; i < 100; i++) {
      try {
        await new Promise((res, rej) => {
          const s = net.connect(porta, '127.0.0.1', () => {
            s.destroy();
            res();
          });
          s.on('error', rej);
        });
        break;
      } catch {
        await esperar(100);
      }
    }
    await fn(porta);
  } finally {
    srv.kill();
  }
}

const CHECKS_OK = [
  { id: 'wasm-sha256', ok: true }, { id: 'dataset-manifest', ok: true }, { id: 'dataset-size', ok: true }
];
const TECLAS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'B', 'D', 'C'];

async function cicloPronto(porta) {
  const pausa = () => new Promise((r) => setTimeout(r, 120));
  const u = await conectar(porta);
  await helloUrna(u, 'urna-M');
  u.enviar({ v: 1, type: 'self_test_result', checks: CHECKS_OK });
  await pausa();
  await ateEstado(u, 'KEYBOARD_TEST');
  assert.equal((await resposta(u)).type, 'selftest-ok'); // drena a resposta
  u.enviar({ v: 1, type: 'key_test_complete', keys: TECLAS });
  await pausa();
  const st = await ateEstado(u, 'WAITING_FOR_POLL_WORKER');
  assert.equal((await resposta(u)).type, 'keytest-ok'); // drena a resposta
  const m = await conectar(porta);
  m.enviar({ v: 1, type: 'hello', role: 'mesario' });
  assert.equal((await resposta(m)).type, 'hello-ok');
  return { u, m, codigo: st.pareamento.codigo };
}

async function parearRegistrar(m, codigo, nome = 'Mesaria Teste da Silva', matricula = 'SEL-TESTE-0001') {
  m.enviar({ v: 1, type: 'pair', code: codigo });
  const ok = await resposta(m);
  assert.equal(ok.type, 'paired');
  m.enviar({ v: 1, type: 'register_mesario', nome, matricula });
  assert.equal((await resposta(m)).type, 'registered');
  await ateEstado(m, 'READY');
  return ok.token;
}

describe('protocolo e máquina de estados', () => {
  it('hello urna + autoteste → KEYBOARD_TEST', async () => {
    await comServidor(async (porta) => {
      const u = await conectar(porta);
      await helloUrna(u);
      u.enviar({ v: 1, type: 'self_test_result', checks: [{ id: 'x', ok: true }] });
      assert.equal((await resposta(u)).type, 'error');
      u.enviar({ v: 1, type: 'self_test_result', checks: CHECKS_OK });
      await ateEstado(u, 'KEYBOARD_TEST');
      u.fechar();
    });
  });

  it('teclado incompleto é recusado; completo avança + pareamento', async () => {
    await comServidor(async (porta) => {
      const u = await conectar(porta);
      await helloUrna(u);
      u.enviar({ v: 1, type: 'self_test_result', checks: CHECKS_OK });
      await ateEstado(u, 'KEYBOARD_TEST');
      assert.equal((await resposta(u)).type, 'selftest-ok'); // drena a resposta
      u.enviar({ v: 1, type: 'key_test_complete', keys: ['1', '2'] });
      assert.equal((await resposta(u)).type, 'error');
      u.enviar({ v: 1, type: 'key_test_complete', keys: TECLAS });
      const st = await ateEstado(u, 'WAITING_FOR_POLL_WORKER');
      assert.match(st.pareamento.codigo, /^\d{6}$/);
      u.fechar();
    });
  });

  it('versão errada e tipo desconhecido', async () => {
    await comServidor(async (porta) => {
      const u = await conectar(porta);
      u.enviar({ v: 9, type: 'hello', role: 'urna' });
      assert.equal((await resposta(u)).type, 'error');
      u.enviar({ v: 1, type: 'abracadabra' });
      assert.equal((await resposta(u)).type, 'error');
      u.fechar();
    });
  });

  it('segunda urna é recusada', async () => {
    await comServidor(async (porta) => {
      const a = await conectar(porta);
      await helloUrna(a, 'urna-A');
      const b = await conectar(porta);
      b.enviar({ v: 1, type: 'hello', role: 'urna', urnaId: 'urna-B' });
      assert.equal((await resposta(b)).codigo, 'urna-ocupada');
      a.fechar();
      b.fechar();
    });
  });
});

describe('mesário: parear, registrar, habilitar, encerrar', () => {
  it('pair errado, par certo, segundo terminal recusado', async () => {
    await comServidor(async (porta) => {
      const { u, m, codigo } = await cicloPronto(porta);
      m.enviar({ v: 1, type: 'pair', code: '000000' });
      assert.equal((await resposta(m)).type, 'error');
      m.enviar({ v: 1, type: 'pair', code: codigo });
      assert.equal((await resposta(m)).type, 'paired');
      const m2 = await conectar(porta);
      m2.enviar({ v: 1, type: 'hello', role: 'mesario' });
      await resposta(m2);
      m2.enviar({ v: 1, type: 'pair', code: codigo });
      assert.equal((await resposta(m2)).type, 'error');
      u.fechar();
      m.fechar();
      m2.fechar();
    });
  });

  it('registro curto recusado; registro fictício → READY', async () => {
    await comServidor(async (porta) => {
      const { u, m, codigo } = await cicloPronto(porta);
      m.enviar({ v: 1, type: 'pair', code: codigo });
      await resposta(m);
      m.enviar({ v: 1, type: 'register_mesario', nome: 'A', matricula: 'B' });
      assert.equal((await resposta(m)).type, 'error');
      m.enviar({ v: 1, type: 'register_mesario', nome: 'Mesaria Teste da Silva', matricula: 'SEL-TESTE-0001' });
      assert.equal((await resposta(m)).type, 'registered');
      await ateEstado(m, 'READY');
      u.fechar();
      m.fechar();
    });
  });

  it('habilitar fora de READY é recusado; em READY autoriza', async () => {
    await comServidor(async (porta) => {
      const { u, m, codigo } = await cicloPronto(porta);
      m.enviar({ v: 1, type: 'pair', code: codigo });
      await resposta(m);
      m.enviar({ v: 1, type: 'authorize_voter' });
      assert.equal((await resposta(m)).type, 'error');
      m.enviar({ v: 1, type: 'register_mesario', nome: 'Mesaria Teste', matricula: 'SEL-1' });
      await resposta(m);
      await ateEstado(m, 'READY');
      m.enviar({ v: 1, type: 'authorize_voter' });
      const ok = await resposta(m);
      assert.equal(ok.type, 'voter_authorized');
      assert.equal(ok.eleitorSeq, 1);
      m.enviar({ v: 1, type: 'authorize_voter' });
      assert.equal((await resposta(m)).type, 'error');
      u.fechar();
      m.fechar();
    });
  });

  it('voto: started → cast → finished → ready; mesário sem conteúdo', async () => {
    await comServidor(async (porta) => {
      const { u, m, codigo } = await cicloPronto(porta);
      m.enviar({ v: 1, type: 'pair', code: codigo });
      await resposta(m);
      m.enviar({ v: 1, type: 'register_mesario', nome: 'Mesaria Teste', matricula: 'SEL-1' });
      await resposta(m);
      await ateEstado(m, 'READY');
      const vistosMesario = [];
      const origProxima = m.proxima.bind(m);
      m.proxima = async (...a) => {
        const x = await origProxima(...a);
        vistosMesario.push(JSON.stringify(x));
        return x;
      };
      m.enviar({ v: 1, type: 'authorize_voter' });
      await resposta(m);
      assert.equal((await resposta(u)).type, 'voter_authorized'); // difusão à urna
      u.enviar({ v: 1, type: 'voting_started' });
      await ateEstado(m, 'VOTING');
      m.enviar({ v: 1, type: 'vote_cast', clientVoteId: 'x', vote: { tipo: 'nominal', numero: '91' } });
      assert.equal((await resposta(m)).type, 'error');
      u.enviar({ v: 1, type: 'vote_cast', clientVoteId: 'z', vote: { tipo: 'nominal', numero: '97' } });
      assert.equal((await resposta(u)).type, 'error');
      u.enviar({ v: 1, type: 'vote_cast', clientVoteId: 'v1', vote: { tipo: 'nominal', numero: '91' } });
      assert.equal((await resposta(u)).type, 'vote-ack');
      u.enviar({ v: 1, type: 'vote_cast', clientVoteId: 'v1', vote: { tipo: 'nominal', numero: '91' } });
      assert.equal((await resposta(u)).duplicado, true);
      u.enviar({ v: 1, type: 'vote_finished' });
      await ateEstado(m, 'VOTE_FINISHED');
      u.enviar({ v: 1, type: 'voter_ready' });
      await ateEstado(m, 'READY');
      const texto = vistosMesario.join('\n');
      for (const proibido of ['Tib', 'nominal', 'digitacao', 'rdv', 'clientVoteId', '"91"', "'91'"]) {
        assert.ok(!texto.includes(proibido), `conteúdo proibido no terminal: ${proibido}`);
      }
      u.fechar();
      m.fechar();
    });
  });

  it('queda durante VOTING preserva o voto (sync)', async () => {
    await comServidor(async (porta) => {
      const { u, m, codigo } = await cicloPronto(porta);
      m.enviar({ v: 1, type: 'pair', code: codigo });
      await resposta(m);
      m.enviar({ v: 1, type: 'register_mesario', nome: 'Mesaria Teste', matricula: 'SEL-1' });
      await resposta(m);
      await ateEstado(m, 'READY');
      m.enviar({ v: 1, type: 'authorize_voter' });
      await resposta(m);
      u.enviar({ v: 1, type: 'voting_started' });
      await ateEstado(m, 'VOTING');
      u.fechar();
      const u2 = await conectar(porta);
      await helloUrna(u2, 'urna-M');
      u2.enviar({
        v: 1, type: 'sync_push',
        votes: [{ clientVoteId: 'queda1', tipo: 'nominal', numero: '92', registradoEm: new Date().toISOString() }]
      });
      const ack = await resposta(u2);
      assert.equal(ack.type, 'sync-ack');
      assert.equal(ack.novos, 1);
      u2.enviar({ v: 1, type: 'vote_finished' });
      await ateEstado(m, 'VOTE_FINISHED');
      u2.fechar();
      m.fechar();
    });
  });

  it('encerrar fora de READY recusado; em READY gera ZIP', async () => {
    await comServidor(async (porta) => {
      const { u, m, codigo } = await cicloPronto(porta);
      m.enviar({ v: 1, type: 'pair', code: codigo });
      const paired = await resposta(m);
      assert.equal(paired.type, 'paired');
      const token = paired.token;
      assert.ok(token);
      m.enviar({ v: 1, type: 'close_session' });
      assert.equal((await resposta(m)).type, 'error');
      m.enviar({ v: 1, type: 'register_mesario', nome: 'Mesaria Teste', matricula: 'SEL-1' });
      await resposta(m);
      await ateEstado(m, 'READY');
      m.enviar({ v: 1, type: 'close_session' });
      const fim = await resposta(m);
      assert.equal(fim.type, 'session_closed');
      assert.match(fim.zipUrl, /^\/api\/zip\?token=/);
      const semToken = await fetch(`http://127.0.0.1:${porta}/api/zip`);
      assert.equal(semToken.status, 401);
      const comToken = await fetch(`http://127.0.0.1:${porta}/api/zip?token=${token}`);
      assert.equal(comToken.status, 200);
      assert.equal(comToken.headers.get('content-type'), 'application/zip');
      assert.ok((await comToken.arrayBuffer()).byteLength > 1000);
      u.fechar();
      m.fechar();
    });
  });
});
