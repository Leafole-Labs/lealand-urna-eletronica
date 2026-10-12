// Terminal do mesário — fala sel-ws/1 com o servidor local.
// Só fluxo administrativo: parear, registrar, habilitar, encerrar.
// NUNCA recebe nem envia conteúdo de voto (o servidor filtra por construção).
const TOKEN_KEY = 'sel-mesario-token';

let ws = null;
let token = null;
let estado = 'desconectado';
let zipToken = null;

try {
  token = sessionStorage.getItem(TOKEN_KEY);
} catch { /* efêmero */ }

const $ = (id) => document.getElementById(id);

function aviso(t) {
  $('m-aviso').textContent = t || '';
}

function enviar(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ v: 1, ...(token ? { token } : {}), ...obj }));
  }
}

function renderEstado(st) {
  estado = st;
  $('m-estado').textContent = st;
  const pronta = st === 'READY';
  $('m-habilitar').disabled = !pronta;
  $('m-encerrar').disabled = !pronta;
}

function renderStatus(s) {
  renderEstado(s.state || '?');
  $('m-sessao').textContent = s.sessionId || '—';
  $('m-urna').textContent = s.urnaConectada ? (s.urnaId || 'conectada') : 'desconectada';
  $('m-mesario').textContent = s.mesario ? `${s.mesario.nome} (${s.mesario.matricula})` : 'não registrado';
  $('m-eleitor').textContent = s.eleitorSeq
    ? `nº ${s.eleitorSeq}${s.state === 'VOTING' ? ' — VOTANDO' : ''}${s.state === 'VOTE_FINISHED' ? ' — VOTO CONCLUÍDO' : ''}`
    : '—';
  $('m-votos').textContent = String(s.votosCount ?? '—');
  const ul = $('m-eventos');
  ul.innerHTML = '';
  for (const e of (s.eventos || []).slice(-12).reverse()) {
    const li = document.createElement('li');
    li.textContent = `${e.t} · ${e.tipo} ${e.detalhe || ''}`;
    ul.appendChild(li);
  }
}

function aoReceber(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'error') {
    aviso(`Erro: ${msg.detalhe || msg.codigo}`);
    return;
  }
  if (msg.type === 'hello-ok') {
    if (msg.token) {
      token = msg.token;
      try {
        sessionStorage.setItem(TOKEN_KEY, token);
      } catch { /* efêmero */ }
    }
    if (!msg.pareamentoNecessario) aviso('');
    return;
  }
  if (msg.type === 'paired') {
    token = msg.token;
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
    } catch { /* efêmero */ }
    aviso('Terminal pareado. Registre o mesário.');
    return;
  }
  if (msg.type === 'status') {
    renderStatus(msg);
    return;
  }
  if (msg.type === 'voter_authorized') {
    aviso(`Eleitor nº ${msg.eleitorSeq} habilitado.`);
    return;
  }
  if (msg.type === 'registered') {
    aviso('Mesário registrado.');
    return;
  }
  if (msg.type === 'session_closed') {
    aviso('Sessão encerrada. Baixe o pendrive abaixo.');
    const zip = $('m-zip');
    const m = /token=([^&]+)/.exec(msg.zipUrl || '');
    zipToken = m ? m[1] : token;
    zip.hidden = false;
    return;
  }
}

function conectar() {
  $('mesario-conexao').textContent = 'conectando…';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${window.location.host}/ws`);
  ws.onopen = () => {
    $('mesario-conexao').textContent = 'conectado';
    enviar({ type: 'hello', role: 'mesario' });
  };
  ws.onmessage = (ev) => {
    try {
      aoReceber(JSON.parse(ev.data));
    } catch { /* ignora quadro inválido */ }
  };
  const cair = () => {
    $('mesario-conexao').textContent = 'desconectado — tentando de novo…';
    setTimeout(conectar, 2000);
  };
  ws.onclose = cair;
  ws.onerror = () => {
    try {
      ws.close();
    } catch { /* cair() reagenda */ }
  };
}

function emCampoTexto() {
  const el = document.activeElement;
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelector('#m-zip').addEventListener('click', (ev) => {
    ev.currentTarget.href = `/api/zip?token=${encodeURIComponent(zipToken || token || '')}`;
  });
  $('m-parear').addEventListener('click', () => {
    const code = $('m-codigo').value.replace(/\D/g, '');
    if (code.length !== 6) {
      aviso('Informe os 6 dígitos do código exibido na urna.');
      return;
    }
    enviar({ type: 'pair', code });
  });
  $('m-ficticio').addEventListener('click', () => {
    $('m-nome').value = 'Mesaria Teste da Silva';
    $('m-matricula').value = 'SEL-TESTE-0001';
    aviso('Identidade fictícia preenchida (não use dados reais).');
  });
  const registrar = () => {
    enviar({ type: 'register_mesario', nome: $('m-nome').value, matricula: $('m-matricula').value });
  };
  $('m-registrar').addEventListener('click', registrar);
  const habilitar = () => {
    if ($('m-habilitar').disabled) {
      aviso('Habilitação só com a urna em READY.');
      return;
    }
    enviar({ type: 'authorize_voter' });
  };
  $('m-habilitar').addEventListener('click', habilitar);
  const encerrar = () => {
    if ($('m-encerrar').disabled) {
      aviso('Encerramento só com a urna em READY.');
      return;
    }
    if (window.confirm('Encerrar a sessão eleitoral? Não será possível votar depois.')) {
      enviar({ type: 'close_session' });
    }
  };
  $('m-encerrar').addEventListener('click', encerrar);

  document.addEventListener('keydown', (event) => {
    if (emCampoTexto()) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const k = event.key.toLowerCase();
    if (k === 'a') {
      event.preventDefault();
      document.activeElement?.blur?.();
      habilitar();
    } else if (k === 'e') {
      event.preventDefault();
      document.activeElement?.blur?.();
      encerrar();
    }
  });

  conectar();
});
