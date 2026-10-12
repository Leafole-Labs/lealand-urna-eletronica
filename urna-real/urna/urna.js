// Urna real de Lealand (pacote urna-real/): UENUX Screen + teclado físico com
// ciclo eleitoral completo dirigido pelo servidor local (sel-ws/1):
// BOOT → SELF_TEST → KEYBOARD_TEST → PREPARING → WAITING_FOR_POLL_WORKER →
// READY → VOTER_AUTHORIZED → VOTING → VOTE_FINISHED → READY … → CLOSING → CLOSED.
// Sem botões, sem teclado visual, sem mesário aqui. Motor em fase OFICIAL.
// Autoridade: o servidor (arquivo em disco). O navegador guarda só outbox
// efêmera para sobreviver a quedas de WebSocket durante a votação.
const TECLAS = { Enter: 'C', Backspace: 'D', Escape: 'D', ' ': 'B', b: 'B', B: 'B' };
const DIGITOS = '0123456789';
// Teclas físicas conferidas pelo teste JS (keydown detectado, sem motor).
const TECLAS_ENTREGA = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'B', 'D', 'C'];
const WASM_SHA256 = '8579ef8d1a93819152cecdbf52906d2e4dd0f57999cb2e1e8c0d1161cd1007e2';
const INTERVALO_MINIMO = 1100;

const params = new URLSearchParams(window.location.search);
const URNA_ID = params.get('urna') || 'urna-01';
const TOKEN_KEY = `sel-urna-token:${URNA_ID}`;

// Mapeamento tecla física → código do motor (ponto único, usado pelo
// documento pai e pelo quadro do motor).
function mapearTecla(crua) {
  if (typeof crua !== 'string' || !crua) return null;
  if (crua >= '0' && crua <= '9') return crua;
  return TECLAS[crua] || null;
}

// Entrada física só com mesário no comando — e nunca após encerrar:
// na checagem, só o teste JS (sem voto possível, sem tocar o motor);
// no voto, só com eleitor habilitado. Fora disso, a tecla é descartada.
function entradaAceita() {
  if (estadoServidor === 'KEYBOARD_TEST') return true;
  return (estadoServidor === 'VOTER_AUTHORIZED' || estadoServidor === 'VOTING') && !encerrado;
}

// Porta de entrada única do teclado físico (pai + quadro chamam aqui).
// Retorna true quando a tecla foi aceita (para preventDefault).
window.__urnaRealTeclaCrua = function (crua) {
  const tecla = mapearTecla(crua);
  if (!tecla || !entradaAceita()) return false;
  if (estadoServidor === 'KEYBOARD_TEST') {
    registrarCheckJs(tecla);
    return true;
  }
  teclaFisica(tecla);
  return true;
};

// ---------- quadro isolado do motor (motor.html) ----------
// O WASM vive num iframe filho recriável: entre eleitores, o quadro é
// descartado e um novo nasce (votaInit novo), SEM recarregar esta página.
// Todo acesso ao motor passa por ModMotor (Module do filho).
let quadroMotor = null;
let ModMotor = null;

function Mod() {
  if (!ModMotor || !ModMotor.ccall) throw new Error('Motor indisponível.');
  return ModMotor;
}

function aoEstadoMotor(event) {
  const atual = (event && event.detail) || null;
  if (atual && atual.cargo && atual.cargo.name) ultimoCargo = atual.cargo.name;
  window.__urnaRealEstado = atual;
  estadoMotorPronto = !!(atual && atual.cargo);
  observarConfirmacao(estadoAnterior, atual);
  estadoAnterior = atual;
  driverObservarMotor(atual);
  tick();
}

function aoFimMotor() {
  window.__urnaRealVotando = false;
  votoConcluidoNestaCarga = true;
}

async function criarQuadroMotor() {
  // Descarta a instância anterior (se houver) e nasce um WASM novo.
  try {
    if (quadroMotor) {
      quadroMotor.src = 'about:blank';
      quadroMotor.remove();
    }
  } catch (_) { /* segue para o novo quadro */ }
  quadroMotor = null;
  ModMotor = null;
  const montagem = document.getElementById('urna-real-motor');
  if (!montagem) throw new Error('Montagem do motor ausente.');
  const frame = document.createElement('iframe');
  frame.title = 'Motor da urna';
  frame.src = 'motor.html';
  frame.style.border = '0';
  frame.style.width = '100%';
  frame.style.height = '100%';
  frame.style.display = 'block';
  exibirQuadro(false);
  montagem.appendChild(frame);
  const limite = Date.now() + 60000;
  for (;;) {
    let pronto = false;
    try {
      const w = frame.contentWindow;
      const fs = (w && (w.FS || (w.Module && w.Module.FS))) || null;
      pronto = !!(w && w.__motorPronto && w.Module && w.Module.ccall && fs && fs.analyzePath);
    } catch (_) { pronto = false; }
    if (pronto) break;
    if (Date.now() > limite) throw new Error('Motor indisponível (quadro).');
    await new Promise((r) => setTimeout(r, 100));
  }
  const w = frame.contentWindow;
  w.removeEventListener('vota:state', aoEstadoMotor);
  w.removeEventListener('vota:done', aoFimMotor);
  w.addEventListener('vota:state', aoEstadoMotor);
  w.addEventListener('vota:done', aoFimMotor);
  quadroMotor = frame;
  ModMotor = w.Module;
  return ModMotor;
}

let ws = null;
let token = null;
let filaControle = [];
let estadoServidor = 'BOOT';
let sessionId = null;
let eleitorSeq = 0;
let habilitada = false;
let encerrado = false;
// Entregas físicas confirmadas ao motor (após votaPressKey resolvido).
let teclasEntregues = new Set();
let checkTecladoEnviado = false;
// Último estado nativo observado (driver semelhante a procedures.js).
let ultimoEstadoMotor = null;
let bufferDigitos = '';
let retratoConfirmacao = null;
let confirmacaoPendente = false;
let estadoAnterior = null;
let ultimoCargo = null;
let votoConcluidoNestaCarga = false;
let votoEnviadoNaoEncerrado = false;
let outbox = [];
let estadoMotorPronto = false;

function banner(texto) {
  const el = document.getElementById('urna-real-sessao');
  if (el) el.textContent = texto;
}

// Canvas do motor: visível SOMENTE durante o voto (eleitor habilitado).
// Nem antes do mesário assumir, nem em espera, nem no encerramento.
function exibirQuadro(mostrar) {
  const montagem = document.getElementById('urna-real-motor');
  const frame = (montagem && montagem.querySelector('iframe')) || quadroMotor;
  if (frame) frame.style.display = mostrar ? '' : 'none';
}

function exibirCanvas(mostrar) {
  exibirQuadro(mostrar);
}

function FSMotor() {
  const m = Mod();
  const fs = m.FS || (quadroMotor && quadroMotor.contentWindow && quadroMotor.contentWindow.FS);
  if (!fs || !fs.analyzePath) throw new Error('FS do motor indisponível.');
  return fs;
}

function etapaHtml() {
  const el = document.getElementById('urna-real-etapa');
  if (!el) return null;
  el.innerHTML = '';
  return el;
}

// ---------- WebSocket sel-ws/1 ----------
function wsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

function enviar(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ v: 1, urnaId: URNA_ID, ...(token ? { token } : {}), ...obj }));
    return;
  }
  // Sem conexão: enfileira controle (latest-wins por tipo) para descargar
  // na reconexão, logo após o hello. Sem isso, uma queda no instante exato
  // do voter_ready/vote_finished/key_test_complete/voting_started trava a
  // urna para sempre (o servidor nunca avança e a página nunca reenvia).
  // hello e vote_cast têm caminho próprio (vote_cast vai pelo outbox/sync).
  if (!obj || obj.type === 'hello' || obj.type === 'vote_cast') return;
  const i = filaControle.findIndex((q) => q.type === obj.type);
  if (i >= 0) filaControle[i] = obj;
  else filaControle.push(obj);
}

function descarregarFila() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !filaControle.length) return;
  const pendentes = filaControle.splice(0, filaControle.length);
  for (const obj of pendentes) {
    try {
      ws.send(JSON.stringify({ v: 1, urnaId: URNA_ID, ...(token ? { token } : {}), ...obj }));
    } catch { /* volta para a fila na próxima queda */ 
      filaControle.push(obj);
      break;
    }
  }
}

// Descarta controles obsoletos diante do estado atual (ex.: voter_ready
// quando o servidor já está em READY): evita erro fora-de-hora ao descargar.
function podarFila() {
  const passado = (estados) => estados.includes(estadoServidor);
  for (let i = filaControle.length - 1; i >= 0; i--) {
    const t = filaControle[i].type;
    if ((t === 'self_test_result' || t === 'key_test_complete') && passado(['PREPARING', 'WAITING_FOR_POLL_WORKER', 'READY', 'VOTER_AUTHORIZED', 'VOTING', 'VOTE_FINISHED', 'CLOSING', 'CLOSED'])) filaControle.splice(i, 1);
    else if (t === 'voting_started' && passado(['VOTING', 'VOTE_FINISHED', 'READY', 'CLOSING', 'CLOSED'])) filaControle.splice(i, 1);
    else if ((t === 'vote_finished' || t === 'voter_ready') && passado(['READY', 'VOTER_AUTHORIZED', 'CLOSING', 'CLOSED'])) filaControle.splice(i, 1);
  }
}

function conectar() {
  banner('Ligando… conectando ao servidor local.');
  try {
    token = token || sessionStorage.getItem(TOKEN_KEY);
  } catch { /* efêmero */ }
  ws = new WebSocket(wsUrl());
  ws.onopen = () => {
    enviar({ type: 'hello', role: 'urna', urnaId: URNA_ID });
    descarregarFila();
    if (outbox.length) {
      enviar({
        type: 'sync_push',
        votes: outbox.map((v) => ({ clientVoteId: v.clientVoteId, tipo: v.tipo, numero: v.numero, registradoEm: v.registradoEm }))
      });
    }
  };
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    aoReceber(msg);
  };
  ws.onclose = (ev) => {
    try {
      console.log('[WS] close', (ev && ev.code) || '?', String((ev && ev.reason) || '').slice(0, 80));
    } catch { /* diagnóstico best-effort */ }
    banner('Servidor desconectado — voto confirmado nunca se perde; aguardando reconexão…');
    setTimeout(conectar, 2000);
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch { /* o onclose reagenda */ }
  };
}

function aoReceber(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'error') {
    banner(`Servidor: ${msg.detalhe || msg.codigo}`);
    return;
  }
  if (msg.type === 'hello-ok') {
    if (msg.token) {
      token = msg.token;
      try {
        sessionStorage.setItem(TOKEN_KEY, token);
      } catch { /* efêmero */ }
    }
    if (msg.sessionId) sessionId = msg.sessionId;
    return;
  }
  if (msg.type === 'status') {
    aplicarStatus(msg);
    return;
  }
  if (msg.type === 'voter_authorized') {
    eleitorSeq = msg.eleitorSeq || eleitorSeq;
    // Sem recarga de página (o quadro do motor é recriado entre eleitores):
    // aqui só se prepara o próximo eleitor e se aguarda a autorização do
    // mesário — sem ela, nada é aceito.
    habilitada = true;
    bufferDigitos = '';
    confirmacaoPendente = false;
    retratoConfirmacao = null;
    votoConcluidoNestaCarga = false;
    window.__urnaRealVotando = false;
    renderEtapa();
    return;
  }
  if (msg.type === 'vote-ack') {
    outbox = outbox.filter((v) => v.clientVoteId !== msg.clientVoteId);
    enviar({ type: 'vote_finished' });
    return;
  }
  if (msg.type === 'sync-ack') {
    const recebidos = new Set((msg.acks || []).map(String));
    outbox = outbox.filter((v) => !recebidos.has(String(v.clientVoteId)));
    if (!outbox.length && votoEnviadoNaoEncerrado) {
      votoEnviadoNaoEncerrado = false;
      enviar({ type: 'vote_finished' });
    }
    return;
  }
  if (msg.type === 'session_closed') {
    encerrado = true;
    habilitada = false;
    renderEtapa();
  }
}

function aplicarStatus(st) {
  const antes = estadoServidor;
  estadoServidor = st.state || estadoServidor;
  if (st.sessionId) sessionId = st.sessionId;
  podarFila();
  if (antes === estadoServidor) return;
  if (estadoServidor === 'VOTE_FINISHED') {
    // Voto registrado no servidor: declara-se pronta de novo SEM recarregar
    // a página. O motor estaciona em CAguardaMensagem/done após o FIM, então
    // é re-inicializado pela API pública (votaInit) antes de liberar o
    // próximo eleitor. Aguarda o mesário autorizar antes de aceitar entradas.
    votoEnviadoNaoEncerrado = false;
    window.__urnaRealVotando = false;
    bufferDigitos = '';
    confirmacaoPendente = false;
    retratoConfirmacao = null;
    reiniciarMotor().then(() => {
      enviar({ type: 'voter_ready' });
    }).catch((e) => {
      banner('Falha ao reiniciar o motor para o próximo eleitor: ' + ((e && e.message) || e));
    });
    return;
  }
  if (estadoServidor === 'VOTER_AUTHORIZED' || estadoServidor === 'VOTING') {
    habilitada = true;
  }
  if (['READY', 'WAITING_FOR_POLL_WORKER', 'CLOSING', 'CLOSED'].includes(estadoServidor)) {
    habilitada = false;
  }
  renderEtapa();
  if (estadoServidor === 'WAITING_FOR_POLL_WORKER' && st.pareamento && st.pareamento.codigo) {
    mostrarPareamento(st.pareamento);
  }
  banner(`Sessão ${sessionId || '?'} · ${estadoServidor}` +
    (st.eleitorSeq ? ` · eleitor ${st.eleitorSeq}` : ''));
}

// ---------- telas de etapa (hospedeiras; o voto é sempre no canvas) ----------
function renderEtapa() {
  const el = document.getElementById('urna-real-etapa');
  // Canvas só durante o voto (após "Habilitar eleitor"): nem antes do
  // mesário assumir, nem em espera, nem no encerramento.
  exibirCanvas(['VOTER_AUTHORIZED', 'VOTING', 'VOTE_FINISHED'].includes(estadoServidor));
  if (!el) return;
  if (estadoServidor === 'WAITING_FOR_POLL_WORKER') return; // pareamento já desenhado
  el.innerHTML = '';
  const textos = {
    BOOT: 'Ligando…',
    SELF_TEST: 'Autotestes em andamento…',
    KEYBOARD_TEST: null,
    PREPARING: 'Preparando sessão…',
    READY: 'AGUARDANDO HABILITAÇÃO — digitar ainda não vota.',
    VOTER_AUTHORIZED: `ELEITOR ${eleitorSeq} HABILITADO — vote.`,
    VOTING: `Eleitor ${eleitorSeq} votando…`,
    VOTE_FINISHED: 'Voto concluído.',
    CLOSING: 'Encerrando sessão…',
    CLOSED: 'Sessão encerrada.'
  };
  if (estadoServidor === 'KEYBOARD_TEST') {
    renderCheckTeclado(el);
    return;
  }
  const p = document.createElement('p');
  p.className = 'urna-real-estado-linha';
  p.textContent = textos[estadoServidor] || estadoServidor;
  el.appendChild(p);
}

// Checagem do teclado 100% JS (sem UI de imitação do motor): instrução +
// contador factual. O motor NÃO recebe essas teclas.
function renderCheckTeclado(el) {
  const t = document.createElement('p');
  t.className = 'urna-real-estado-linha';
  t.textContent = 'CHECAGEM DO TECLADO — pressione cada tecla física uma vez: 0–9, Enter, Backspace, Espaço. (Teste funcional do teclado; a tela do motor aparece após o mesário assumir.)';
  el.appendChild(t);
  // Contador factual (diagnóstico): teclas detectadas pelo JS nesta carga.
  const c = document.createElement('p');
  c.className = 'urna-real-dica';
  c.textContent = `Detectadas: ${teclasEntregues.size}/13.`;
  el.appendChild(c);
}

// Checagem do teclado 100% JS (ordem do operador): cada tecla física
// pressionada marca um item; ao completar as 13, atesta ao servidor.
// O motor NÃO recebe essas teclas (antes elas caíam no fluxo de votação e
// podiam estacioná-lo). Não afirma aprovação pelo WASM.
function registrarCheckJs(tecla) {
  teclasEntregues.add(tecla);
  if (estadoServidor === 'KEYBOARD_TEST') renderEtapa();
  if (!checkTecladoEnviado && estadoServidor === 'KEYBOARD_TEST' &&
      TECLAS_ENTREGA.every((t) => teclasEntregues.has(t))) {
    checkTecladoEnviado = true;
    enviar({ type: 'key_test_complete', keys: [...teclasEntregues] });
  }
}

// ---------- drivers semelhantes a urnaemu/.../session/procedures.js ----------
// procedures.js:keyboardTest/zeresima/opening observam o estado NATIVO
// (operator(), keyboardTestExpectedKey(), booting()) e pressionam teclas via
// keypads; nada ali altera contadores. Aqui: observamos o motor pelo canal
// disponível (eventos vota:state + votaGetStateJson) e orientamos as teclas
// FÍSICAS (humano no teclado, como na urna real); o motor avança sozinho.
// O driver nunca marca conclusão: só registra o que o motor reportou.
const FAM_TESTE_MOTOR = /testeteclado|TesteTeclado|PreZeresima/i;
const FAM_ZERESIMA_MOTOR = /Zeresima|ZERESIMA/i;
const FAM_CONFIRMA_MOTOR = /QuerImprimir|QuerReimprimir|Reimprimir/i;
const FAM_BU_MOTOR = /ImprimindoBU|QuerImprimirBU|EmitirMaisBU|GeraBU|GerandoBU|ImprimirBU/i;

function resumoMotor(s) {
  if (!s) return 'sem-estado';
  return `${s.state || '?'} / ${s.substate || ''}`;
}

function driverObservarMotor(atual) {
  const antes = ultimoEstadoMotor ? resumoMotor(ultimoEstadoMotor) : null;
  ultimoEstadoMotor = atual;
  const agora = resumoMotor(atual);
  if (antes === agora) return;
  console.log('[DRIVER] motor:', agora);
  const texto = `${(atual && atual.state) || ''} ${(atual && atual.substate) || ''}`;
  // Estacionado aguardando operador (sem pump no web build): confirmar com
  // dígitos sem habilitação leva o motor para cá e nenhuma tecla o tira
  // (provado: C/D/9 não resgatam). Orientação honesta: recarregar a página
  // reinicia o motor; a sessão está preservada no servidor.
  if (/CAguardaMensagem/.test(texto) && atual && atual.done && !habilitada && !encerrado) {
    console.log('[DRIVER] motor estacionado (CAguardaMensagem/done, sem habilitação) — necessário recarregar a página');
    banner('Motor aguardando operador (estacionado). Recarregue a página para reiniciar o motor — a sessão está preservada no servidor.');
    return;
  }
  if (FAM_TESTE_MOTOR.test(texto)) {
    console.log('[DRIVER] tela de teste do motor — siga o canvas e pressione as teclas físicas pedidas');
  } else if (FAM_CONFIRMA_MOTOR.test(texto)) {
    console.log('[DRIVER] motor pede confirmação — pressione CONFIRMA (Enter) no teclado físico');
  } else if (FAM_ZERESIMA_MOTOR.test(texto)) {
    console.log('[DRIVER] zerésima do motor — valores no canvas; confirme no teclado físico quando o motor pedir');
  } else if (FAM_BU_MOTOR.test(texto)) {
    console.log('[DRIVER] boletim do motor — valores no canvas');
  }
}

// Leitura pontual do estado nativo (observação, sem efeito colateral).
async function lerEstadoMotor() {
  try {
    const raw = await ccallAsync('votaGetStateJson', 'string', [], []);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function mostrarPareamento(p) {
  const el = etapaHtml();
  if (!el) return;
  const box = document.createElement('div');
  box.className = 'urna-real-pareamento';
  const t = document.createElement('div');
  t.className = 'urna-real-pareamento-titulo';
  t.textContent = 'Pareie o terminal do mesário';
  const codigo = document.createElement('div');
  codigo.className = 'urna-real-pareamento-codigo';
  codigo.textContent = String(p.codigo).split('').join(' ');
  const exp = document.createElement('div');
  exp.className = 'urna-real-pareamento-exp';
  exp.textContent = 'Código temporário — informe no terminal do mesário.';
  box.append(t, codigo, exp);
  el.appendChild(box);
}

async function esperarWsAberto() {
  const limite = Date.now() + 30000;
  while (Date.now() < limite) {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('WebSocket indisponível');
}

// NOTA DE ARQUITETURA HONESTA (verificado no urnaemu):
// - WASM contém a máquina de estados: vota::testeteclado::CTesteTeclado
//   (vtable 1547140), estados Zeresima/Reimprimir, CInicioVotacao,
//   CEleitorVotando, encerramento, BU.
// - procedures.js do urnaemu (keyboardTest/zeresima/opening) NÃO é lógica
//   eleitoral duplicada: são DRIVERS que só observam o estado nativo
//   (operator(), keyboardTestExpectedKey(), booting()) e pressionam teclas
//   via keypads (voter/mesario) com votaPressKey. Nada ali altera contadores.
// - keyboardTestExpectedKey real (controller.js:514-524): lê
//   experiments.state.active, confere vtable==1547140 e decodifica
//   std::string do vetor em p+48/p+60 (layout short/long da libc++).
// - A urna-real NÃO possui esse harness (experiments/operator pump/
//   booting/clock/keypad-rule). Portanto: NATIVE_KEYBOARD_TEST = NOT PROVEN
//   até o harness ser portado. As teclas físicas seguem diretas ao WASM.

async function autoteste() {
  renderEtapa();
  const checks = [];
  try {
    const r = await fetch('../wasm/vota_web_wasm.wasm', { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await r.arrayBuffer()))]
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    checks.push({ id: 'wasm-sha256', ok: hash === WASM_SHA256, detail: hash.slice(0, 16) + '…' });
  } catch (e) {
    checks.push({ id: 'wasm-sha256', ok: false, detail: String(e?.message ?? e) });
  }
  try {
    const man = await (await fetch('../wasm/bases/manifest.json', { cache: 'no-store' })).json();
    const cen = (man.scenarios || []).find((s) => s.id === 'lealand-oficial');
    if (!cen) throw new Error('cenário lealand-oficial ausente');
    const meta = await (await fetch(`../wasm/bases/${cen.dataJs}`, { cache: 'no-store' })).text();
    const m = /"remote_package_size":(\d+)/.exec(meta);
    checks.push({ id: 'dataset-manifest', ok: true, detail: cen.id });
    checks.push({ id: 'dataset-size', ok: !!m, detail: m ? `${m[1]} bytes declarados` : 'tamanho ausente' });
  } catch (e) {
    checks.push({ id: 'dataset-manifest', ok: false, detail: String(e?.message ?? e) });
  }
  const el = document.getElementById('urna-real-etapa');
  if (el && estadoServidor !== 'KEYBOARD_TEST') {
    el.innerHTML = '';
    const ul = document.createElement('ul');
    ul.className = 'apuracao-checks';
    for (const c of checks) {
      const li = document.createElement('li');
      li.className = c.ok ? 'ok' : 'falha';
      li.textContent = `${c.ok ? '✓' : '✗'} ${c.id} — ${c.detail}`;
      ul.appendChild(li);
    }
    el.appendChild(ul);
  }
  await esperarWsAberto();
  // Só enviar autoteste de integridade quando o servidor ainda está na fase
  // de inicialização (evita "autoteste fora de hora"). É checagem de
  // hashes/tamanho, não o teste do motor.
  if (estadoServidor === 'BOOT' || estadoServidor === 'SELF_TEST') {
    enviar({ type: 'self_test_result', checks });
  }
  // Driver (semelhante a procedures.js): observa o motor e orienta teclas
  // físicas; nunca marca conclusão. Estado inicial registrado abaixo.
  const inicial = await lerEstadoMotor();
  console.log('[DRIVER] estado inicial do motor:', inicial ? `${inicial.state || '?'} / ${inicial.substate || ''}` : 'indisponível');
  driverObservarMotor(inicial);
}

// ---------- motor ----------
function ccallAsync(nome, tipoRetorno, tiposArg, args) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(Mod().ccall(nome, tipoRetorno, tiposArg, args));
      } catch (e) {
        reject(e);
      }
    }, 0);
  });
}

let tickEmCurso = false;
function tick() {
  if (tickEmCurso) return;
  let cc = null;
  try {
    cc = Mod().ccall;
  } catch (_) { return; }
  if (typeof cc !== 'function') return;
  tickEmCurso = true;
  ccallAsync('votaTick', 'number', [], []).finally(() => {
    tickEmCurso = false;
  });
}

function loadDataScript(src) {
  return new Promise((resolve, reject) => {
    const Module = Mod();
    const docMotor = (quadroMotor && quadroMotor.contentDocument) || document;
    const originalAdd = Module.addRunDependency && Module.addRunDependency.bind(Module);
    const originalRemove = Module.removeRunDependency && Module.removeRunDependency.bind(Module);
    const pending = new Set();
    let loaded = false;
    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      if (originalAdd) Module.addRunDependency = originalAdd;
      if (originalRemove) Module.removeRunDependency = originalRemove;
    };
    const finish = () => {
      if (!loaded || pending.size) return;
      restore();
      script.dataset.loaded = 'true';
      resolve();
    };
    if (originalAdd) {
      Module.addRunDependency = (id) => {
        pending.add(id);
        originalAdd(id);
      };
    }
    if (originalRemove) {
      Module.removeRunDependency = (id) => {
        originalRemove(id);
        pending.delete(id);
        finish();
      };
    }
    const script = docMotor.createElement('script');
    script.onload = () => {
      loaded = true;
      finish();
    };
    script.onerror = () => {
      restore();
      reject(new Error(`Falha ao carregar ${src}`));
    };
    script.src = src;
    docMotor.head.appendChild(script);
  });
}

let cenarioMotor = null;

async function bootMotor() {
  await criarQuadroMotor();
  const manifest = await (await fetch('../wasm/bases/manifest.json', { cache: 'no-store' })).json();
  const scenario = (manifest.scenarios || []).find((s) => s.id === 'lealand-oficial') || manifest.scenarios[0];
  if (!scenario) throw new Error('Sem dados eleitorais.');
  cenarioMotor = scenario;
  await loadDataScript(`../wasm/bases/${scenario.dataJs}`);
  await montarMidiaOficial(scenario);
  await iniciarMotorNativo(scenario);
}

// Re-inicialização pós-FIM SEM recarregar a página: o motor, após o FIM,
// estaciona em CAguardaMensagem/done aguardando o thread operador (ausente
// no build web); nenhuma tecla o tira (provado). A API pública votaInit o
// traz de volta ao prompt inicial, sobre a mídia já montada. A sessão do
// servidor (votos, pareamento) permanece intacta.
async function reiniciarMotor() {
  if (!cenarioMotor) throw new Error('Motor nunca inicializado.');
  // Quadro novo = instância WASM nova (votaInit volta a retornar 1).
  await criarQuadroMotor();
  await loadDataScript(`../wasm/bases/${cenarioMotor.dataJs}`);
  await montarMidiaOficial(cenarioMotor);
  await iniciarMotorNativo(cenarioMotor);
  const s = await lerEstadoMotor();
  console.log('[DRIVER] motor reiniciado:', s ? `${s.state || '?'} / ${s.substate || ''}` : 'indisponível');
}

async function montarMidiaOficial(scenario) {
  const FS = FSMotor();
  // Carregar .pid oficial que pode estar ausente do pacote .data
  try {
    const pidPath = `../wasm/bases/o02421ac-ce.pid`;
    const pidData = await fetch(pidPath).then(r => r.arrayBuffer());
    if (pidData) {
      const bytes = new Uint8Array(pidData);
      FS.writeFile('/dsk/fi/estatico/o02421ac-ce.pid', bytes);
    }
  } catch (_) {}
  // Carregar .pid de candidatura oficial
  try {
    const pidCaPath = `../wasm/bases/o02421ac00001-ca.pid`;
    const pidCaData = await fetch(pidCaPath).then(r => r.arrayBuffer());
    if (pidCaData) {
      const bytes = new Uint8Array(pidCaData);
      FS.writeFile('/dsk/fi/estatico/o02421ac00001-ca.pid', bytes);
    }
  } catch (_) { /* .pid pode já estar montado pelo .data */ }
  const fase = scenario.fase === 'of' ? 'o' : 't';
  const sentinela = `/dsk/fi/estatico/${fase}${String(scenario.pe || '').padStart(5, '0')}${String(scenario.uf || '').toLowerCase()}-pu.dat`;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (FS.analyzePath && FS.analyzePath(sentinela).exists) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!FS.analyzePath(sentinela).exists) {
    throw new Error('Dados não montados: ' + sentinela);
  }
  for (const alias of scenario.aliases || [
    { source: '/dsk/fi/estatico', target: '/dsk/fe/estatico' },
    { source: '/dsk/fi/serialv.dat', target: '/dsk/fe/serialv.dat' }
  ]) {
    if (!FS.analyzePath(alias.target).exists) {
      FS.mkdirTree(alias.target.replace(/\/[^/]+$/, '') || '/');
      FS.symlink(alias.source, alias.target);
    }
  }
}

async function iniciarMotorNativo(scenario) {
  const ok = await ccallAsync('votaInit', 'number', ['string'], [JSON.stringify({
    fase: 'oficial',
    pe: scenario.pe,
    turno: scenario.turno,
    uf: scenario.uf,
    municipio: scenario.municipio,
    zona: scenario.zona,
    secao: scenario.secao,
    audioEleitorHabilitado: false,
    reproduzirAudio: false
  })]);
  if (!ok) throw new Error('votaInit recusou a inicialização.');
  await ccallAsync('votaSetAudioEnabled', null, ['number'], [0]);
}

// ---------- estados do motor ----------
function modoDoEstado(s) {
  if (!s) return 'inicio';
  if (s.done) return 'fim';
  if (s.guide && s.guide.voteMode) return s.guide.voteMode;
  const sub = s.substate || '';
  if (sub.includes('Branco')) return 'branco';
  if (sub.includes('Nulo') || sub.includes('Inexistente') || sub.includes('Inapto') || sub.includes('Repetido')) return 'nulo';
  return 'nominal';
}

function ehPromptInicial(s) {
  const sub = (s && s.substate) || '';
  return sub.includes('CPedeProporcional') || sub.includes('CPedeMajoritario');
}

function registrarVotoConfirmado(anterior) {
  const retrato = retratoConfirmacao || {};
  retratoConfirmacao = null;
  const sub = (anterior && anterior.substate) || '';
  const guide = (anterior && anterior.guide) || {};
  let tipo = 'nulo';
  let numero = String(retrato.digits ?? bufferDigitos ?? '').slice(0, 2);
  const mode = retrato.mode || '';
  if (mode === 'nominal' && numero) {
    tipo = 'nominal';
  } else if (mode === 'branco' || guide.voteMode === 'branco' || sub.includes('Branco')) {
    tipo = 'branco';
    numero = '';
  } else if (!mode) {
    if ((guide.voteMode === 'nominal' && guide.confirmacao) || sub.includes('MajoritarioValido')) {
      tipo = numero ? 'nominal' : 'nulo';
    }
  }
  bufferDigitos = '';
  const voto = {
    clientVoteId: `${sessionId || 'sem-sessao'}-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`,
    tipo,
    numero: String(numero || ''),
    registradoEm: new Date().toISOString()
  };
  outbox.push(voto);
  votoEnviadoNaoEncerrado = true;
  enviar({ type: 'vote_cast', clientVoteId: voto.clientVoteId, vote: { tipo: voto.tipo, numero: voto.numero } });
}

function observarConfirmacao(anterior, atual) {
  if (!confirmacaoPendente) return;
  const avancou = !!(atual && atual.cargo && ehPromptInicial(atual) && anterior && !ehPromptInicial(anterior));
  if (!atual.done && !avancou) return;
  if (!atual.done && !(anterior && anterior.cargo)) return;
  confirmacaoPendente = false;
  registrarVotoConfirmado(anterior);
}

// ---------- entrada física (cadeia única, ritmada) ----------
let cadeiaTeclas = Promise.resolve();
let ultimaEntregaEm = 0;

function teclaFisica(tecla) {
  // Cadeia IMORTAL: uma rejeição (ex.: tecla durante a recriação do quadro,
  // com o motor ainda nulo) nunca pode matar as teclas seguintes. Sem isso,
  // um único Enter perdido travava a urna até recarregar a página.
  cadeiaTeclas = cadeiaTeclas.catch(() => {}).then(async () => {
    // Sem bloqueio: o motor decide o destino de cada tecla.
    // Snapshots de confirmação existem SOMENTE na votação autorizada, para
    // que teclas da checagem física nunca virem voto-fantasma no outbox.
    // E só o PRIMEIRO C de cada voto retrata (re-CONFIRMAs de avanço não
    // sobrescrevem: o motor pode exigir novo C e o retrato do meio do fluxo
    // — ex. voteMode 'gravando' — corromperia o tipo nominal).
    try {
      if (tecla === 'C' && encerrado) return;
    if (tecla === 'C' && habilitada && !encerrado && !confirmacaoPendente) {
      confirmacaoPendente = true;
      retratoConfirmacao = {
        mode: modoDoEstado(window.__urnaRealEstado || null),
        digits: bufferDigitos
      };
    }
    if (DIGITOS.includes(tecla)) {
      bufferDigitos = `${bufferDigitos}${tecla}`.slice(0, 5);
    }
    if (tecla === 'D') {
      bufferDigitos = '';
    }
    if (habilitada && window.__urnaRealVotando !== true) {
      window.__urnaRealVotando = true;
      enviar({ type: 'voting_started' });
    }
    const agora = Date.now();
    const espera = INTERVALO_MINIMO - (agora - ultimaEntregaEm);
    if (espera > 0) await new Promise((r) => setTimeout(r, espera));
    ultimaEntregaEm = Date.now();
    await ccallAsync('votaPressKey', null, ['string'], [tecla]);
    tick();
    } catch (e) {
      // Tecla perdida (ex.: motor em recriação): registra e segue — a cadeia
      // continua viva para as próximas teclas.
      console.log('[TECLA] descartada (' + ((e && e.message) || e) + ')');
    }
  });
  return cadeiaTeclas;
}

// ---------- boot da página ----------
function iniciar() {
  banner('Ligando…');
  exibirCanvas(false); // sem canvas antes do mesário assumir
  // Estados do motor chegam do quadro isolado (listeners anexados em
  // criarQuadroMotor, inclusive após cada recriação entre eleitores).

  document.addEventListener('keydown', (event) => {
    if (event.target instanceof Element &&
        event.target.closest('a, input, select, textarea, summary, [contenteditable]')) {
      return;
    }
    if (window.__urnaRealTeclaCrua(event.key)) event.preventDefault();
  });

  conectar();
  bootMotor().then(async () => {
    estadoMotorPronto = true;
    const carregando = document.getElementById('urna-real-carregando');
    if (carregando) carregando.style.display = 'none';
    const rAF = () => {
      tick();
      requestAnimationFrame(rAF);
    };
    requestAnimationFrame(rAF);
    await autoteste();
  }).catch((e) => {
    banner('Falha ao iniciar o motor: ' + ((e && e.message) || e));
    const carregando = document.getElementById('urna-real-carregando');
    if (carregando) {
      carregando.style.display = 'flex';
      carregando.textContent = 'Falha ao carregar a urna: ' + ((e && e.message) || e);
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', iniciar);
} else {
  iniciar();
}
