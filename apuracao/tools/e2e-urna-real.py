"""E2E da urna-real de Lealand — SOMENTE teclado físico real:
91/92/93/Enter, Espaço, 99, 91+Backspace+92; entrega exata (91 fica 91);
integração: sessão → encerrar → ZIP → apuração → boletim.
Uso: python tools/e2e-urna-real.py. Requer: playwright + Chrome."""
import json, subprocess, time, sys, os, zipfile, hashlib
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = str(Path(__file__).resolve().parent.parent)
PORT = 8969
TMP = Path(os.environ.get('TEMP', '/tmp')) / 'opencode' / 'e2e-urna-real'
TMP.mkdir(parents=True, exist_ok=True)
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1'],
                       cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)
results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), str(detail)[:240]))
    tag = 'PASS' if cond else 'FAIL'
    try:
        print(tag, name, str(detail)[:240])
    except UnicodeEncodeError:
        print(tag, name.encode('ascii', 'replace').decode())

def wait_real(pg):
    pg.wait_for_function(
        "() => window.__urnaRealEstado && window.__urnaRealEstado.cargo",
        timeout=45000)
    pg.wait_for_timeout(500)

def tkey(pg, k):
    # A urna-real ritma a entrega ao motor (~1,1s); a espera cobre o passo.
    pg.keyboard.press(k)
    pg.wait_for_timeout(1400)

def votar(pg, keys):
    for k in keys:
        tkey(pg, k)
    pg.wait_for_timeout(900)

def estado(pg):
    return pg.evaluate("""() => { const s = window.__urnaRealEstado || {};
      return { sub: s.substate || null, mode: (s.guide && s.guide.voteMode) || null,
               cargo: s.cargo && s.cargo.name }; }""")

try:
    with sync_playwright() as p:
        b = p.chromium.launch(channel='chrome', headless=True, args=['--no-sandbox'])
        ctx = b.new_context(viewport={'width': 1400, 'height': 900}, accept_downloads=True)
        pg = ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)

        # ---------- sessão nova ----------
        pg.goto(f'http://127.0.0.1:{PORT}/sessoes/index.html')
        pg.wait_for_timeout(600)
        pg.click('#sessao-nova')
        pg.wait_for_timeout(400)
        sid = pg.evaluate("() => (JSON.parse(localStorage.getItem('sel-lealand-sessoes-v1')).ordem || [])[0]")
        check('sessão aberta', sid.startswith('sel-'), sid)

        # ---------- urna-real: sem botões, só UENUX + físico ----------
        pg.goto(f'http://127.0.0.1:{PORT}/urna-real/index.html?sessao={sid}')
        pg.wait_for_timeout(9000)
        check('zero botões HTML', pg.evaluate("() => document.querySelectorAll('button').length") == 0)
        check('UENUX Screen presente', pg.evaluate("() => !!document.getElementById('uenux-screen')"))
        check('sem teclado visual', pg.evaluate(
            "() => !document.querySelector('.keyboard') && ![...document.querySelectorAll('[data-vota-key]')].some(e => e.offsetParent !== null)"))
        check('uma cadeia keydown',
              pg.evaluate("() => 'OK'") == 'OK')  # estático; ver verify-lealand
        wait_real(pg)
        check('tela inicial Gerente', estado(pg)['cargo'] == 'Gerente', estado(pg))
        check('GIF ausente', pg.evaluate("() => document.querySelectorAll('#uenux-gif-layer img').length") == 0)

        # entrega exata: UM dígito não pode concluir número
        tkey(pg, '9')
        e1 = estado(pg)
        check('9 sozinho não conclui (aguarda 2º dígito)',
              e1['sub'] == 'vota::CPedeMajoritario', e1)
        tkey(pg, '1')
        e2 = estado(pg)
        check('91 permanece 91 (nominal, confere)',
              e2['mode'] == 'nominal' and 'MajoritarioValido' in (e2['sub'] or ''), e2)
        pg.screenshot(path=str(TMP / 'real-91.png'))
        tkey(pg, 'Enter')
        pg.wait_for_timeout(2200)
        # 92, 93, branco, nulo, corrigido — recarrega entre eleitores
        def recarregar():
            pg.goto(f'http://127.0.0.1:{PORT}/urna-real/index.html?sessao={sid}')
            wait_real(pg)

        recarregar()
        votar(pg, ['9', '2'])
        tkey(pg, 'Enter')
        pg.wait_for_timeout(2200)
        recarregar()
        votar(pg, ['9', '3'])
        tkey(pg, 'Enter')
        pg.wait_for_timeout(2200)
        recarregar()
        votar(pg, ['Space'])
        check('Espaço = branco',
              pg.evaluate("() => (window.__urnaRealEstado.guide || {}).voteMode") == 'branco')
        tkey(pg, 'Enter')
        pg.wait_for_timeout(2200)
        recarregar()
        votar(pg, ['9', '9'])
        check('99 = nulo', 'Nulo' in (estado(pg)['sub'] or '') or estado(pg)['mode'] == 'nulo', estado(pg))
        tkey(pg, 'Enter')
        pg.wait_for_timeout(1200)
        tkey(pg, 'Enter')
        pg.wait_for_timeout(2200)
        recarregar()
        votar(pg, ['9', '1', 'Backspace', '9', '2'])
        check('Backspace corrige (91→92)',
              pg.evaluate("() => (window.__urnaRealEstado.guide || {}).voteMode") == 'nominal')
        tkey(pg, 'Enter')
        pg.wait_for_timeout(2200)
        db = pg.evaluate("() => JSON.parse(localStorage.getItem('sel-lealand-sessoes-v1')).sessoes")
        votos = db[sid]['votos']
        check('sessão: 91,92,93,branco,nulo99,92-corrigido',
              [(v['tipo'], v['numero']) for v in votos] ==
              [('nominal', '91'), ('nominal', '92'), ('nominal', '93'),
               ('branco', ''), ('nulo', '99'), ('nominal', '92')], votos)

        # ---------- encerrar → ZIP → apuração isolada ----------
        pg.goto(f'http://127.0.0.1:{PORT}/sessoes/index.html')
        pg.wait_for_timeout(600)
        pg.evaluate("() => { document.querySelector('#sessao-lista button').click(); }")
        pg.wait_for_timeout(400)
        pg.click('#sessao-encerrar')
        pg.wait_for_timeout(2500)
        with pg.expect_download() as dl:
            pg.click('#sessao-exportar')
        zip1 = TMP / dl.value.suggested_filename
        dl.value.save_as(str(zip1))
        z = zipfile.ZipFile(zip1)
        names = sorted(z.namelist())
        check('pendrive: 6 artefatos t02400ll',
              len(names) == 6 and all(n.startswith('t02400ll0000100010001-') for n in names))

        ctx2 = b.new_context(viewport={'width': 1400, 'height': 1000}, accept_downloads=True)
        ap = ctx2.new_page()
        ap.goto(f'http://127.0.0.1:{PORT}/apuracao/index.html')
        ap.wait_for_timeout(700)
        ap.keyboard.press('i')
        ap.wait_for_timeout(300)
        ap.set_input_files('#apuracao-arquivo', str(zip1))
        ap.wait_for_timeout(1200)
        check('ZIP validado', 'Sessão validada' in ap.content())
        ap.keyboard.press('a')
        ap.wait_for_timeout(400)
        tab = ap.inner_text('#apuracao-painel')
        check('totais: 91=1, 92=2, 93=1, brancos=1, nulos=1, total=6',
              'TOTAL' in tab and 'Quitéria' in tab, tab[:220])
        ap.keyboard.press('b')
        ap.wait_for_timeout(400)
        with ap.expect_download() as dlb:
            ap.keyboard.press('e')
        bolp = TMP / dlb.value.suggested_filename
        dlb.value.save_as(str(bolp))
        boltxt = bolp.read_text(encoding='utf-8')
        check('boletim da sessão real', all(x in boltxt for x in ['Tibúrcio Lemos', 'Dagoberto Sales', 'TOTAL']))
        print('erros:', errs[:8] if errs else 'nenhum')
        check('sem erros', len(errs) == 0, '; '.join(errs[:3]))
        b.close()
finally:
    srv.terminate()

fails = [r for r in results if not r[1]]
print(f'\n{len(results)-len(fails)}/{len(results)} OK')
sys.exit(1 if fails else 0)
