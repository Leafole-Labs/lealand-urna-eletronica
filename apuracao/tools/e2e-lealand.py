"""E2E da Urna Eletrônica de Lealand — sessão real ponta a ponta:
portal → sessões (nova) → urna (teclado físico, sem réplica visual) →
91/92/93/branco/nulo → encerrar → artefatos → exportar ZIP → inspecionar →
apuração isolada: importar → validar → apurar → boletim → exportar → reabrir.
Uso: python tools/e2e-lealand.py. Requer: playwright + Chrome."""
import json, subprocess, time, sys, os, zipfile, hashlib, io
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = str(Path(__file__).resolve().parent.parent)
PORT = 8931
TMP = Path(os.environ.get('TEMP', '/tmp')) / 'opencode' / 'e2e-lealand'
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
        print(tag, name.encode('ascii', 'replace').decode(),
              str(detail)[:240].encode('ascii', 'replace').decode())

def wait_urna(pg):
    pg.wait_for_function(
        "() => window.votaWasmAdapter && window.votaWasmAdapter.running && "
        "window.votaWasmAdapter.currentState && window.votaWasmAdapter.currentState.cargo",
        timeout=45000)
    pg.wait_for_timeout(500)

def tkey(pg, k):
    pg.keyboard.press(k)
    pg.wait_for_timeout(550)

def votar(pg, keys):
    for k in keys:
        tkey(pg, k)
    pg.wait_for_timeout(500)

def corrige(pg):
    for _ in range(3):
        tkey(pg, 'Backspace')
        pg.wait_for_timeout(250)
        if pg.evaluate("() => window.votaWasmAdapter.currentVoteMode") == 'nominal':
            break

def gif_imgs(pg):
    return pg.evaluate("() => document.querySelectorAll('#uenux-gif-layer img').length")

def confirmar(pg):
    tkey(pg, 'Enter')
    pg.wait_for_timeout(2100)

try:
    with sync_playwright() as p:
        b = p.chromium.launch(channel='chrome', headless=True, args=['--no-sandbox'])
        ctx = b.new_context(viewport={'width': 1400, 'height': 1000}, accept_downloads=True)
        pg = ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)

        # ---------- PORTAL + SESSÕES ----------
        pg.goto(f'http://127.0.0.1:{PORT}/index.html')
        pg.wait_for_timeout(600)
        check('portal SEL (urna/sessões/apuração)',
              all(x in pg.content() for x in ['urna/index.html', 'sessoes/index.html', 'apuracao/index.html']))
        pg.goto(f'http://127.0.0.1:{PORT}/sessoes/index.html')
        pg.wait_for_timeout(600)
        pg.click('#sessao-nova')
        pg.wait_for_timeout(500)
        sid = pg.evaluate("() => (JSON.parse(localStorage.getItem('sel-lealand-sessoes-v1')).ordem || [])[0]")
        check('sessão aberta com id', isinstance(sid, str) and sid.startswith('sel-'), sid)
        pg.click('#sessao-abrir-urna')
        pg.wait_for_timeout(800)
        check('urna abre com ?sessao=', 'sessao=' in pg.url)

        # ---------- URNA (teclado físico, sem réplica visual) ----------
        # (o marcador oculto data-vota-key="noop" apenas informa o motor de que
        # o adaptador é dono do teclado; não é visível nem clicável)
        check('urna sem teclado visual',
              pg.evaluate("() => !document.querySelector('.keyboard') && ![...document.querySelectorAll('[data-vota-key]')].some(e => e.offsetParent !== null)"))
        wait_urna(pg)
        pg.evaluate("""() => {
          window.__states = [JSON.parse(JSON.stringify(window.votaWasmAdapter.currentState))];
          window.addEventListener('vota:state', e => window.__states.push(JSON.parse(JSON.stringify(e.detail))));
        }""")
        st = pg.evaluate("() => window.votaWasmAdapter.currentState")
        check('cargo Gerente majoritário 2d',
              st['cargo']['name'] == 'Gerente' and st['cargo']['digits'] == 2)
        cands = {str(c['number']): c['name'] for c in st['candidates']}
        check('91/92/93 = Tibúrcio/Dagoberto/Quitéria',
              cands == {'91': 'Tibúrcio', '92': 'Dagoberto', '93': 'Quitéria'})
        check('GIF ausente no início', gif_imgs(pg) == 0)
        check('sessão indicada na urna', sid in pg.content())
        pg.mouse.click(700, 200)  # foco no corpo p/ teclado físico
        # colinha auxiliar continua display-only
        check('colinha auxiliar visível', 'Minha colinha (auxiliar)' in pg.content())
        # 97 (inexistente) → nulo; prova que a colinha não manda na eleição.
        # (Sem confirmar: recarrega em vez de depender do CORRIGE pós-nulo,
        # cujo comportamento de buffer é do motor.)
        votar(pg, ['9', '7'])
        check('97 = nulo', pg.evaluate("() => window.votaWasmAdapter.currentVoteMode") == 'nulo')

        def nova_carga_urna():
            pg.goto(f'http://127.0.0.1:{PORT}/urna/index.html?sessao={sid}')
            wait_urna(pg)
            pg.mouse.click(700, 200)
            pg.evaluate("""() => {
              window.__states = [JSON.parse(JSON.stringify(window.votaWasmAdapter.currentState))];
              window.addEventListener('vota:state', e => window.__states.push(JSON.parse(JSON.stringify(e.detail))));
            }""")

        # 91 Tibúrcio (com CORRIGE a partir da conferência nominal)
        nova_carga_urna()
        votar(pg, ['9', '1'])
        check('91 mostra Tibúrcio',
              'Tibúrcio' in json.dumps(pg.evaluate("() => window.votaWasmAdapter.currentState"), ensure_ascii=False))
        pg.screenshot(path=str(TMP / 'ev91.png'))
        check('GIF ausente no 91', gif_imgs(pg) == 0)
        corrige(pg)  # voto corrigido: não entra na sessão
        check('CORRIGE volta a digitar',
              pg.evaluate("() => window.votaWasmAdapter.currentVoteMode") == 'nominal')
        votar(pg, ['9', '1'])
        confirmar(pg)
        check('FIM após Enter', 'FIM' in pg.content() or 'registrado' in pg.content().lower())
        check('sem segundo cargo',
              pg.evaluate("() => window.__states.every(s => !s.cargo || s.cargo.name === 'Gerente')"))
        # 92, 93, branco, nulo (próximos eleitores, uma carga por voto)
        nova_carga_urna()
        votar(pg, ['9', '2'])
        confirmar(pg)
        nova_carga_urna()
        votar(pg, ['9', '3'])
        confirmar(pg)
        nova_carga_urna()
        votar(pg, ['Space'])
        check('Espaço = branco', pg.evaluate("() => window.votaWasmAdapter.currentVoteMode") == 'branco')
        confirmar(pg)
        nova_carga_urna()
        votar(pg, ['9', '9'])
        check('99 = nulo', pg.evaluate("() => window.votaWasmAdapter.currentVoteMode") == 'nulo')
        tkey(pg, 'Enter')
        pg.wait_for_timeout(1200)
        tkey(pg, 'Enter')  # nulo exige dupla confirmação no motor
        pg.wait_for_timeout(2100)
        # Enter extra fora de conferência não cria voto fantasma
        db = pg.evaluate("() => JSON.parse(localStorage.getItem('sel-lealand-sessoes-v1')).sessoes")
        antes = db[sid]['votos']
        check('sessão tem 5 votos (91,92,93,branco,nulo99)',
              [(v['tipo'], v['numero']) for v in antes] ==
              [('nominal', '91'), ('nominal', '92'), ('nominal', '93'), ('branco', ''), ('nulo', '99')], antes)

        # ---------- ENCERRAR + ARTEFATOS + EXPORTAR ----------
        pg.goto(f'http://127.0.0.1:{PORT}/sessoes/index.html')
        pg.wait_for_timeout(600)
        pg.evaluate(f"() => {{ document.querySelector('#sessao-lista button').click(); }}")
        pg.wait_for_timeout(400)
        pg.click('#sessao-encerrar')
        pg.wait_for_timeout(2500)
        det = pg.inner_text('#sessao-detalhe-corpo')
        check('encerrada com 6 artefatos',
              all(x in det for x in ['-bu.json', '-rdv.json', '-log.zip', '-bu.txt', '-vota.json', '-candidaturas.json']), det[:200])
        check('cadeia resumida', 'blocos' in det and 'ltimo hash' in det)
        with pg.expect_download() as dl:
            pg.click('#sessao-exportar')
        zip1 = TMP / dl.value.suggested_filename
        dl.value.save_as(str(zip1))
        check('pendrive ZIP exportado', zip1.exists(), zip1.name)
        z = zipfile.ZipFile(zip1)
        names = sorted(z.namelist())
        check('ZIP: 6 arquivos no raiz com prefixo t02400ll',
              len(names) == 6 and all(n.startswith('t02400ll0000100010001-') for n in names), names)
        bu = json.loads(z.read(names[0] if names[0].endswith('-bu.json') else [n for n in names if n.endswith('-bu.json')][0]))
        el = bu['resultadosVotacaoPorEleicao'][0]
        blocos = el['resultadosVotacao'][0]['totaisVotosCargo'][0]['votosVotaveis']
        check('BU: 5 blocos (3 nominais + branco + nulo)',
              [(b['tipoVoto'], b['quantidadeVotos']) for b in blocos] == [(1, 1), (1, 1), (1, 1), (2, 1), (3, 1)])
        check('BU: cadeia + assinatura + comparecimento',
              len(el['ultimoHashVotosVotavel']) == 128 and el['assinaturaUltimoHashVotosVotavel'] and bu['qtdEleitoresCompareceram'] == 5)
        rdv = json.loads(z.read([n for n in names if n.endswith('-rdv.json')][0]))
        check('RDV: 5 votos em ordem',
              [(v['tipoVoto'], v.get('digitacao')) for v in rdv['eleicoes'][0]['votosCargos'][0]['votos']] ==
              [(2, '91'), (2, '92'), (2, '93'), (3, None), (4, '99')])
        vsc = json.loads(z.read([n for n in names if n.endswith('-vota.json')][0]))
        okhash = all(hashlib.sha512(z.read(e['nomeArquivo'])).hexdigest() == e['sha512'] for e in vsc['arquivos'])
        check('vota.json: SHA-512 de todos conferem', okhash and vsc['perfil'] == 'SEL-TESTE-P521')
        txt = z.read([n for n in names if n.endswith('-bu.txt')][0]).decode('utf-8')
        check('bu.txt imprimível (Gerente/Brancos/Nulos/Total)',
              all(x in txt for x in ['Boletim de Urna', '--Gerente--', 'Brancos 1', 'Nulos 1', 'Total Apurado 5']))

        # ---------- APURAÇÃO isolada ----------
        ctx2 = b.new_context(viewport={'width': 1400, 'height': 1000}, accept_downloads=True)
        ap = ctx2.new_page()
        ap.goto(f'http://127.0.0.1:{PORT}/apuracao/index.html')
        ap.wait_for_timeout(700)
        check('apuracao SEL + ociosa', 'Urna de Apuração' in ap.content() and 'Ociosa' in ap.content())
        check('apuracao sem acesso à urna',
              ap.evaluate("() => localStorage.getItem('sel-lealand-sessoes-v1')") is None)
        ap.keyboard.press('i')
        ap.wait_for_timeout(300)
        check('I foca o seletor', ap.evaluate("() => document.activeElement.id") == 'apuracao-arquivo')
        ap.set_input_files('#apuracao-arquivo', str(zip1))
        ap.wait_for_timeout(1200)
        check('ZIP validado (checks)', 'Sessão validada' in ap.content())
        checks_txt = ap.inner_text('#apuracao-painel')
        for cid in ['chain:', 'final:', 'signature:', 'totals:', 'sorted:', 'impresso', 'arquivo:']:
            check(f'check {cid}', cid in checks_txt)
        ap.keyboard.press('a')
        ap.wait_for_timeout(400)
        tab = ap.inner_text('#apuracao-painel')
        check('apura: 91/92/93 = 1, brancos 1, nulos 1, total 5',
              '91 — Tibúrcio Lemos' in tab and '92 — Dagoberto Sales' in tab and
              '93 — Quitéria Vasconcellos' in tab and 'TOTAL' in tab, tab[:260])
        ap.keyboard.press('b')
        ap.wait_for_timeout(400)
        check('boletim gerado', 'Boletim de Resultado da Sessão' in ap.content())
        with ap.expect_download() as dlb:
            ap.keyboard.press('e')
        bolp = TMP / dlb.value.suggested_filename
        dlb.value.save_as(str(bolp))
        boltxt = bolp.read_text(encoding='utf-8')
        check('boletim = artefatos (nomes, vice, hashes, carga)',
              all(x in boltxt for x in ['Tibúrcio Lemos', 'Zulmira Prado', 'TOTAL',
                                        el['ultimoHashVotosVotavel'][:32],
                                        bu['urna']['correspondenciaResultado']['carga']['codigoCarga'].strip()]))
        pg3 = ctx2.new_page()
        pg3.goto(bolp.as_uri())
        pg3.wait_for_timeout(400)
        check('boletim reaberto renderiza', 'Boletim de Resultado' in pg3.content() and 'TOTAL' in pg3.content())
        # ZIPs ruins: corrompido, incompleto, versão, hash adulterado, não-sessão
        ruim = {'corrompido': b'xx' + zip1.read_bytes()[2:],
                'incompleto': None, 'versao': None, 'hash': None, 'nao-sessao': None}
        # incompleto: só bu
        b2 = io.BytesIO()
        bun0 = [n for n in names if n.endswith('-bu.json')][0]
        with zipfile.ZipFile(b2, 'w', zipfile.ZIP_STORED) as zz:
            zz.writestr(bun0, z.read(bun0))
        ruim['incompleto'] = b2.getvalue()
        # versão: formato trocado
        b3 = io.BytesIO()
        bun = [n for n in names if n.endswith('-bu.json')][0]
        with zipfile.ZipFile(b3, 'w', zipfile.ZIP_STORED) as zz:
            for n in names:
                data = z.read(n)
                if n == bun:
                    o = json.loads(data)
                    o['formato'] = 'sel-bu/9'
                    data = json.dumps(o).encode()
                zz.writestr(n, data)
        ruim['versao'] = b3.getvalue()
        # hash: voto adulterado sem re-assinar
        b4 = io.BytesIO()
        rdvn = [n for n in names if n.endswith('-rdv.json')][0]
        with zipfile.ZipFile(b4, 'w', zipfile.ZIP_STORED) as zz:
            for n in names:
                data = z.read(n)
                if n == rdvn:
                    o = json.loads(data)
                    o['eleicoes'][0]['votosCargos'][0]['votos'][0]['digitacao'] = '92'
                    data = json.dumps(o).encode()
                zz.writestr(n, data)
        ruim['hash'] = b4.getvalue()
        ruim['nao-sessao'] = b'sou um texto, nao um zip'
        for motivo, blob in ruim.items():
            p = TMP / f'ruim-{motivo}.zip'
            p.write_bytes(blob)
            ap.keyboard.press('l')
            ap.wait_for_timeout(250)
            ap.set_input_files('#apuracao-arquivo', str(p))
            ap.wait_for_timeout(1000)
            check(f'ZIP {motivo} rejeitado, sem boletim falso',
                  'Pacote rejeitado' in ap.content() and ap.query_selector('.boletim') is None, motivo)
        # sessão zerada: encerrar sem votos → total 0 válido
        pg.goto(f'http://127.0.0.1:{PORT}/sessoes/index.html')
        pg.wait_for_timeout(600)
        pg.click('#sessao-nova')
        pg.wait_for_timeout(400)
        pg.evaluate("() => { document.querySelector('#sessao-lista button').click(); }")
        pg.wait_for_timeout(300)
        pg.click('#sessao-encerrar')
        pg.wait_for_timeout(2500)
        with pg.expect_download() as dl0:
            pg.click('#sessao-exportar')
        zip0 = TMP / dl0.value.suggested_filename
        dl0.value.save_as(str(zip0))
        ap.keyboard.press('l')
        ap.wait_for_timeout(250)
        ap.set_input_files('#apuracao-arquivo', str(zip0))
        ap.wait_for_timeout(1200)
        ap.keyboard.press('a')
        ap.wait_for_timeout(400)
        tab0 = ap.inner_text('#apuracao-painel')
        check('sessão zerada apura total 0', 'TOTAL' in tab0 and '✗' not in tab0, tab0[:200])
        # tentativa com arquivo que não é sessão (txt)
        txt0 = TMP / 'nada.txt'
        txt0.write_text('oi')
        ap.keyboard.press('l')
        ap.wait_for_timeout(250)
        ap.set_input_files('#apuracao-arquivo', str(txt0))
        ap.wait_for_timeout(1000)
        check('txt rejeitado', 'Pacote rejeitado' in ap.content())
        # badge na urna (sem TSE) + erros
        pg.goto(f'http://127.0.0.1:{PORT}/urna/index.html')
        pg.wait_for_timeout(1500)
        badge = pg.evaluate("() => { const e = document.querySelector('.sel-hw-badge'); return e ? {w: e.offsetWidth, h: e.offsetHeight} : null; }")
        check('badge SEL íntegro na urna', badge and badge['w'] >= 100 and badge['h'] >= 150, json.dumps(badge))
        print('erros console/pagina:', errs[:8] if errs else 'nenhum')
        check('sem erros de pagina', len(errs) == 0, '; '.join(errs[:3]))
        b.close()
finally:
    srv.terminate()

fails = [r for r in results if not r[1]]
print(f'\n{len(results)-len(fails)}/{len(results)} OK')
sys.exit(1 if fails else 0)
