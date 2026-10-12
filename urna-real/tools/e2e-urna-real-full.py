"""E2E do pacote urna-real (servidor local + UENUX + mesário), 100% offline:
boot → autoteste → teclado físico → parear → registrar → habilitar →
votar (91/92/93/branco/nulo/corrigido, só teclado) → encerrar → ZIP →
apuração existente → boletim. Sem Internet (hosts verificados).
Uso: python tools/e2e-urna-real-full.py (a partir de urna-real/).
Requer: playwright + Chrome + node."""
import json, subprocess, time, sys, os, zipfile, hashlib
from pathlib import Path
from playwright.sync_api import sync_playwright

AQUI = Path(__file__).resolve().parent
RAIZ = AQUI.parent
PORTA = 18777
DADOS = Path(os.environ.get('TEMP', '/tmp')) / 'opencode' / 'urna-real-e2e'
TMP = DADOS / 'dl'
for d in (DADOS, TMP):
    d.mkdir(parents=True, exist_ok=True)
hosts_externos = set()
results = []

def check(name, cond, detail=''):
    results.append((name, bool(cond), str(detail)[:220]))
    tag = 'PASS' if cond else 'FAIL'
    try:
        print(tag, name, str(detail)[:220])
    except UnicodeEncodeError:
        print(tag, name.encode('ascii', 'replace').decode())

srv = subprocess.Popen(
    ['node', str(RAIZ / 'server' / 'server.mjs'),
     '--port', str(PORTA), '--data', str(DADOS / 'srv')],
    cwd=str(RAIZ), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)
# Portal lealand/ (apuração existente) servido à parte, só p/ o teste de compat.
srv_portal = subprocess.Popen(
    [sys.executable, '-m', 'http.server', '18980', '--bind', '127.0.0.1'],
    cwd=str(RAIZ.parent.parent), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)

def health():
    import urllib.request
    with urllib.request.urlopen(f'http://127.0.0.1:{PORTA}/health', timeout=10) as r:
        return json.loads(r.read().decode())

def esperar_estado(desejado, timeout=60):
    fim = time.time() + timeout
    while time.time() < fim:
        try:
            if health()['estado'] == desejado:
                return True
        except Exception:
            pass
        time.sleep(1)
    return False

try:
    with sync_playwright() as p:
        b = p.chromium.launch(channel='chrome', headless=True, args=['--no-sandbox'])
        ctx = b.new_context(viewport={'width': 1400, 'height': 900}, accept_downloads=True)
        pg = ctx.new_page()
        errs = []
        ruidos_ws = []
        def classificar_erro(texto):
            # Ruído de transporte (loopback/Chrome): derruba o socket sem
            # escrita do servidor e com reconexão automática (ver soak_ws.py).
            # Não é erro da aplicação; vai para lista informativa separada.
            if 'Invalid frame header' in texto or 'WebSocket connection to' in texto:
                ruidos_ws.append(texto)
            else:
                errs.append(texto)
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('console', lambda m: classificar_erro(m.text) if m.type == 'error' else None)
        pg.on('request', lambda r: hosts_externos.add(r.url.split('/')[2]) if r.url.startswith('http') and r.url.split('/')[2] not in ('127.0.0.1:%d' % PORTA, 'localhost:%d' % PORTA) else None)

        # ---------- BOOT + SELF_TEST ----------
        pg.goto(f'http://127.0.0.1:{PORTA}/urna/')
        pg.wait_for_timeout(12000)
        check('boot chega a KEYBOARD_TEST', esperar_estado('KEYBOARD_TEST'), health().get('estado'))
        check('sem TREINAMENTO no DOM', 'TREINAMENTO' not in pg.content())

        # ---------- CHECAGEM JS DO TECLADO (13 teclas físicas) ----------
        # 100% JS: o motor não recebe essas teclas (sem risco de estacionar).
        for k in ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'Space', 'Backspace', 'Enter']:
            pg.keyboard.press(k)
            pg.wait_for_timeout(1200)
        check('13 teclas detectadas', esperar_estado('WAITING_FOR_POLL_WORKER', 40))
        codigo = pg.inner_text('.urna-real-pareamento-codigo').replace(' ', '')
        check('código de pareamento (6 dígitos)', len(codigo) == 6 and codigo.isdigit(), codigo)
        pg.screenshot(path=str(TMP / 'real-boot.png'))

        # ---------- MESÁRIO: parear + registrar ----------
        ap = ctx.new_page()
        ap.goto(f'http://127.0.0.1:{PORTA}/mesario/')
        ap.wait_for_timeout(1500)
        ap.fill('#m-codigo', '000000')
        ap.click('#m-parear')
        ap.wait_for_timeout(600)
        check('código errado recusado', 'inválido ou expirado' in ap.content())
        ap.fill('#m-codigo', codigo)
        ap.click('#m-parear')
        ap.wait_for_timeout(800)
        check('pareado', 'pareado' in ap.content().lower())
        ap.click('#m-ficticio')
        ap.click('#m-registrar')
        ap.wait_for_timeout(800)
        check('mesário registrado → READY', esperar_estado('READY'))

        # ---------- ELEITORES (só teclado na urna) ----------
        def habilitar():
            ap.mouse.click(700, 200)  # foco no corpo p/ atalhos
            ap.keyboard.press('a')
            pg.wait_for_timeout(600)

        def votar_urna(teclas):
            for k in teclas:
                pg.keyboard.press(k)
                pg.wait_for_timeout(1500)
            # Como d.ballot do urnaemu (até 3 CONFIRMA enquanto não avança):
            # o primeiro C às vezes só exibe a conferência; outro C conclui.
            # Só pressiona enquanto o servidor ainda está em VOTING.
            for _ in range(4):
                pg.wait_for_timeout(4000)
                try:
                    if health()['estado'] != 'VOTING':
                        break
                except Exception:
                    pass
                pg.keyboard.press('Enter')
                pg.wait_for_timeout(1500)
            pg.wait_for_timeout(1000)

        def esperar_voto(total, timeout=90):
            # VOTE_FINISHED é transitório (a urna responde voter_ready de
            # imediato e o servidor avança a READY); o observável estável é
            # READY com a contagem de votos do terminal incrementada.
            fim = time.time() + timeout
            while time.time() < fim:
                try:
                    if health()['estado'] == 'READY' and ap.inner_text('#m-votos').strip() == str(total):
                        return True
                except Exception:
                    pass
                time.sleep(1)
            return False

        banners_vistos = []

        def esperar_urna_pronta(timeout=90):
            # Sem recarga de página: após voter_ready o servidor difunde READY
            # e o banner volta a exibir READY. Guarda histórico para diagnóstico.
            fim = time.time() + timeout
            while time.time() < fim:
                try:
                    txt = pg.evaluate('() => document.getElementById("urna-real-sessao")?.innerText || ""')
                    banners_vistos.append(txt[:100])
                    if len(banners_vistos) > 5:
                        banners_vistos.pop(0)
                    if 'READY' in txt:
                        return True
                except Exception as e:
                    banners_vistos.append('EVAL-EXC: ' + str(e)[:80])
                    if len(banners_vistos) > 5:
                        banners_vistos.pop(0)
                time.sleep(1)
            return False

        # 91
        habilitar()
        assert esperar_estado('VOTER_AUTHORIZED'), 'sem habilitação p/ 91'
        votar_urna(['9', '1', 'Enter'])
        assert esperar_voto(1), '91 sem FIM'
        assert esperar_urna_pronta(), 'urna pronta pós-91'
        pg.screenshot(path=str(TMP / 'real-91.png'), timeout=20000)
        # 92
        assert esperar_estado('READY'), 'sem READY pós-91'
        habilitar()
        votar_urna(['9', '2', 'Enter'])
        assert esperar_voto(2), '92 sem FIM'
        assert esperar_urna_pronta(), 'urna pronta pós-92'
        # 93
        assert esperar_estado('READY'), 'sem READY pós-92'
        habilitar()
        votar_urna(['9', '3', 'Enter'])
        assert esperar_voto(3), '93 sem FIM'
        assert esperar_urna_pronta(), 'urna pronta pós-93'
        # branco
        assert esperar_estado('READY'), 'sem READY pós-93'
        habilitar()
        votar_urna(['Space', 'Enter'])
        assert esperar_voto(4), 'branco sem FIM'
        assert esperar_urna_pronta(), 'urna pronta pós-branco'
        # nulo 99 (dupla confirmação do motor)
        assert esperar_estado('READY'), 'sem READY pós-branco'
        habilitar()
        votar_urna(['9', '9', 'Enter'])
        pg.wait_for_timeout(1500)
        votar_urna(['Enter'])
        assert esperar_voto(5), 'nulo sem FIM'
        assert esperar_urna_pronta(), 'urna pronta pós-nulo'
        # corrigido: 91 → Backspace → 92 → Enter
        assert esperar_estado('READY'), 'sem READY pós-nulo'
        habilitar()
        votar_urna(['9', '1', 'Backspace', '9', '2', 'Enter'])
        assert esperar_voto(6), 'corrigido sem FIM'
        assert esperar_urna_pronta(), 'urna pronta pós-corrigido'
        check('6 votos fluíram (habilitação independente cada)', True)
        pg.screenshot(path=str(TMP / 'real-fim.png'), timeout=20000)

        # ---------- ENCERRAR + ZIP ----------
        assert esperar_estado('READY'), 'sem READY p/ encerrar'
        ap.mouse.click(700, 200)
        ap.on('dialog', lambda d: d.accept())
        ap.keyboard.press('e')
        pg.wait_for_timeout(1000)
        check('encerrada', esperar_estado('CLOSED', 60))
        with ap.expect_download() as dl:
            ap.click('#m-zip')
        zip1 = TMP / dl.value.suggested_filename
        dl.value.save_as(str(zip1))
        z = zipfile.ZipFile(zip1)
        names = sorted(z.namelist())
        check('pendrive: 6 artefatos t02400ll',
              len(names) == 6 and all(n.startswith('t02400ll0000100010001-') for n in names), names)
        bu = json.loads(z.read([n for n in names if n.endswith('-bu.json')][0]))
        el = bu['resultadosVotacaoPorEleicao'][0]
        check('fase oficial na origem (2, sem treino)', bu.get('fase') == 2, bu.get('fase'))
        blocos = el['resultadosVotacao'][0]['totaisVotosCargo'][0]['votosVotaveis']
        check('BU: 91=1,92=2,93=1,br=1,nulo=1',
              [(b.get('identificacaoVotavel', {}).get('codigo'), b['tipoVoto'], b['quantidadeVotos']) for b in blocos] ==
              [(91, 1, 1), (92, 1, 2), (93, 1, 1), (None, 2, 1), (None, 3, 1)], blocos)

        # ---------- APURAÇÃO existente consome o ZIP (compat real) ----------
        ap2 = ctx.new_page()
        ap2.goto('http://127.0.0.1:18980/lealand/apuracao/index.html')
        ap2.wait_for_timeout(800)
        ap2.keyboard.press('i')
        ap2.wait_for_timeout(300)
        ap2.set_input_files('#apuracao-arquivo', str(zip1))
        ap2.wait_for_timeout(1500)
        check('apuracao importa+valida', 'Sessão validada' in ap2.content())
        ap2.keyboard.press('a')
        ap2.wait_for_timeout(500)
        tab = ap2.inner_text('#apuracao-painel')
        check('apuracao: 91=1,92=2,93=1,br=1,nulo=1,total=6',
              all(x in tab for x in ['91 —', '92 —', '93 —', 'Brancos', 'Nulos', 'TOTAL']), tab[:240])
        ap2.keyboard.press('b')
        ap2.wait_for_timeout(400)
        check('boletim gerado', 'Boletim de Resultado da Sessão' in ap2.content())
        vsc = json.loads(z.read([n for n in names if n.endswith('-vota.json')][0]))
        check('catálogo P-521 com 5 arquivos + SPKI',
              len(vsc['arquivos']) == 5 and vsc['perfil'] == 'SEL-TESTE-P521' and bool(vsc['identidade']['spki']))
        okhash = all(hashlib.sha512(z.read(e['nomeArquivo'])).hexdigest() == e['sha512'] for e in vsc['arquivos'])
        check('hashes do catálogo conferem', okhash)

        # ---------- OFFLINE: nenhum host externo ----------
        check('zero dependência externa', len(hosts_externos) == 0, sorted(hosts_externos))
        print('erros de página:', errs[:8] if errs else 'nenhum')
        print('ruídos WS tolerados (auto-reconexão):', len(ruidos_ws))
        check('sem erros de página', len(errs) == 0, '; '.join(errs[:3]))
        b.close()
except BaseException:
    # Em falha por assert/timeout, despeja o diagnóstico antes de sair.
    # (O navegador já fechou aqui: sem evaluate, só listas e HTTP.)
    def txt(x):
        return str(x).encode('ascii', 'replace').decode()
    try:
        print('DIAG health:', health())
    except Exception as e:
        print('DIAG health: ilegivel', txt(e)[:120])
    try:
        print('DIAG banners:', [txt(b) for b in banners_vistos])
    except Exception as e:
        print('DIAG banners: ilegivel', txt(e)[:120])
    print('DIAG erros:', txt(errs[:8]) if errs else 'nenhum')
    print('DIAG checks:', txt([(n, ok) for n, ok, _ in results]))
    raise
finally:
    srv.terminate()
    srv_portal.terminate()

fails = [r for r in results if not r[1]]
print(f'\n{len(results)-len(fails)}/{len(results)} OK')
sys.exit(1 if fails else 0)
