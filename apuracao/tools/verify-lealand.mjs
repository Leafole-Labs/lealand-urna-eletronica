// Verificação de integridade da Urna Eletrônica de Lealand.
// Uso: node tools/verify-lealand.mjs  (a partir de lealand/)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (cond, label, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// 1. Estrutura por responsabilidade: urna | sessoes | apuracao | shared | tools.
for (const f of ['index.html',
  'urna/index.html', 'urna/urna.js', 'urna/urna.css', 'urna/eleitor-escolhas.css',
  'sessoes/index.html',
  'apuracao/index.html', 'apuracao/apuracao.js',
  'shared/js/sel-zip.js', 'shared/js/sel-election-config.js', 'shared/js/sel-session-store.js',
  'shared/js/sel-result-files.js', 'shared/js/sel-verify-results.js',
  'shared/js/sel-navigation.js', 'shared/js/sel-sem-libras.js',
  'shared/css/vota-wasm.css', 'shared/css/eleitor-escolhas.css',
  'shared/brand/brand-coat.png', 'shared/brand/brand-flag.png',
  'shared/images/urna.svg',
  'wasm/vota_web_wasm.js', 'wasm/vota_web_wasm.wasm',
  'wasm/vota_web_wasm.data', 'wasm/vota_web_wasm.version', 'wasm/bases/manifest.json',
  'wasm/bases/lealand-gerente.data', 'wasm/bases/lealand-gerente.data.js',
  'tools/build-lealand-data.mjs', 'tools/test-result-files.mjs']) {
  ok(fs.existsSync(path.join(ROOT, f)), 'existe ' + f);
}

// 1b. Urna real: somente UENUX Screen + teclado físico.
for (const f of ['urna-real/index.html', 'urna-real/urna-real.js', 'urna-real/urna-real.css']) {
  ok(fs.existsSync(path.join(ROOT, f)), 'existe ' + f);
}
const realHtml = fs.readFileSync(path.join(ROOT, 'urna-real/index.html'), 'utf8');
const realJs = fs.readFileSync(path.join(ROOT, 'urna-real/urna-real.js'), 'utf8');
ok(realHtml.includes('id="uenux-screen"'), 'urna-real tem UENUX Screen');
ok(!/<button[\s>]/.test(realHtml), 'urna-real sem botões HTML');
ok(!realHtml.includes('class="keyboard"'), 'urna-real sem teclado visual');
ok(!/botao-(branco|corrige|confirma|[0-9])\.svg/.test(realHtml), 'urna-real sem SVGs de teclas');
ok((realJs.match(/addEventListener\(['"]keydown['"]/g) || []).length === 1, 'urna-real com UMA cadeia de teclado');
for (const w of ['mesario', 'Mesario', 'apuracao', 'Apuração', 'tools/', 'data-vota-key="1"', '[data-key]']) {
  ok(!realJs.includes(w) && !realHtml.includes(w), `urna-real sem "${w}"`);
}
ok(realJs.includes('sel-session-store.js'), 'urna-real integrada à sessão');
ok(realHtml.includes('uenuxExternalKeyboard') && realHtml.includes('data-vota-key="noop"'), 'urna-real sem listener duplicado');

// 2. Urna limpa: sem teclado visual, sem mesário, sem apuração, sem ferramentas.
const urnaHtml = fs.readFileSync(path.join(ROOT, 'urna/index.html'), 'utf8');
const urnaJs = fs.readFileSync(path.join(ROOT, 'urna/urna.js'), 'utf8');
ok(!urnaHtml.includes('class="keyboard"') && !/button[^>]*data-vota-key/.test(urnaHtml), 'urna sem teclado visual');
ok(urnaHtml.includes('data-vota-key="noop"') && urnaHtml.includes('uenuxExternalKeyboard'), 'urna informa o motor sem réplica visual');
ok(!/botao-(branco|corrige|confirma|0|1|2|3|4|5|6|7|8|9)\.svg/.test(urnaHtml + urnaJs), 'urna sem SVGs de teclas');
for (const w of ['mesario', 'Mesario', 'MESARIO', 'apuracao', 'Apuração', 'sel-export', 'verificar', 'tools/']) {
  ok(!urnaJs.includes(w), `urna sem "${w}"`);
}
ok(urnaJs.includes('sel-session-store.js'), 'urna registra na sessão persistente');
ok(urnaHtml.includes('urna-teclas') && urnaHtml.includes('Enter') && urnaHtml.includes('BRANCO'), 'urna documenta o teclado físico');

// 3. Dataset: cenário único, Gerente 91/92/93, sem cargos BR.
const loader = fs.readFileSync(path.join(ROOT, 'wasm/bases/lealand-gerente.data.js'), 'utf8');
const tail = loader.slice(loader.lastIndexOf('carregarPacote(') + 'carregarPacote('.length);
const meta = JSON.parse(tail.slice(0, tail.indexOf(']});') + 2));
const data = fs.readFileSync(path.join(ROOT, 'wasm/bases/lealand-gerente.data'));
ok(meta.remote_package_size === data.length, '.data íntegro', `${data.length} bytes`);
const blob = data.toString('latin1');
for (const w of ['Tibúrcio', 'Dagoberto', 'Quitéria', 'Zulmira', 'Hermínia', 'Agenor', 'Gerente', 'Vice-Gerente']) {
  ok(blob.includes(w), `.data contém "${w}"`);
}
const get = (fn) => {
  const f = meta.files.find((x) => x.filename === fn);
  return data.subarray(f.start, f.end).toString('latin1');
};
for (const w of ['Prefeito', 'Vereador', 'Deputado', 'Governador']) {
  const hit = ['/dsk/fi/estatico/t02421ac-ce.dat', '/dsk/fi/estatico/t02421ac00001-ca.dat', '/dsk/fi/estatico/t02421ac00001-pa.dat']
    .some((fn) => get(fn).includes(w));
  ok(!hit, `ca/ce/pa sem "${w}"`);
}
for (const w of ['Aline', 'Bruno', 'Carla', 'Diego', 'Elisa', 'Fabio', 'Fábio']) {
  ok(!blob.includes(w), `nome antigo "${w}" fora do dataset`);
}
// Rol do config confere com o dataset.
const { CANDIDATES } = await import('../shared/js/sel-election-config.js');
for (const c of CANDIDATES) {
  ok(blob.includes(c.titular.nome) && blob.includes(c.vice.nome), `config × dataset: ${c.numero}`);
}

// 4. Apresentação SEL, sem identidade brasileira (comentários ignorados).
const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
const present = strip(['index.html', 'urna/index.html', 'sessoes/index.html', 'apuracao/index.html',
  'urna/urna.js', 'apuracao/apuracao.js', 'shared/css/vota-wasm.css']
  .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n'));
for (const w of ['municipal-t1', 'municipal-t2', 'Justiça Eleitoral', 'TSE', 'Eleições Municipais',
  'Eleições Gerais', 'Vereador', 'Prefeito', 'Presidente', 'Governador', 'Deputado',
  'progress-navigation.js', 'eleitor-escolhas.html', 'vota-wasm.html']) {
  ok(!present.includes(w), `apresentação sem "${w}"`);
}
for (const w of ['Supremo Eleitoral de Lealand', 'Tibúrcio', 'Dagoberto', 'Quitéria']) {
  ok(present.includes(w), `apresentação contém "${w}"`);
}
for (const w of ['sel-lealand-sessoes-v1', 'sel-lealand-colinha', 'sessoes/index.html', 'apuracao/index.html', 'urna/index.html']) {
  ok(present.includes(w), `arquitetura presente "${w}"`);
}
// Relevo brasileiro removido do gabinete; logo SEL no tamanho do branding.
const urnaSvg = fs.readFileSync(path.join(ROOT, 'shared/images/urna.svg'), 'utf8');
ok(!urnaSvg.includes('id="g575"') && !urnaSvg.includes('id="g576"'), 'relevo JE fora do urna.svg');
const css = fs.readFileSync(path.join(ROOT, 'shared/css/vota-wasm.css'), 'utf8');
ok(/\.brand-row \.sel-brand img\s*\{[^}]*width:\s*56px/.test(css), 'logo SEL 56px no cabeçalho');
// GIF de Libras neutralizado (motor intacto).
ok(css.includes('#uenux-gif-layer') && css.includes('display: none'), 'gif-layer neutralizada');
ok(fs.readFileSync(path.join(ROOT, 'urna/index.html'), 'utf8').includes('sel-sem-libras.js'), 'guarda anti-Libras na urna');

// 5. Arquitetura de sessão: apuração isolada, exportação nas sessões.
const apJs = fs.readFileSync(path.join(ROOT, 'apuracao/apuracao.js'), 'utf8');
ok(!apJs.includes('sel-lealand-sessao') && !apJs.includes('sel-session-store'), 'apuração isolada do simulador');
ok(apJs.includes('verifyResultFiles'), 'apuração valida os artefatos');
const sesHtml = fs.readFileSync(path.join(ROOT, 'sessoes/index.html'), 'utf8');
ok(sesHtml.includes('Exportar pendrive (ZIP)') && sesHtml.includes('Encerrar sessão'), 'sessões encerram e exportam');
const ap = fs.readFileSync(path.join(ROOT, 'apuracao/index.html'), 'utf8');
for (const k of ['<kbd>I</kbd>', '<kbd>A</kbd>', '<kbd>B</kbd>', '<kbd>E</kbd>', '<kbd>L</kbd>', '<kbd>V</kbd>']) {
  ok(ap.includes(k), `apuração documenta "${k}"`);
}

// 6. Sintaxe JS.
import { execFileSync } from 'node:child_process';
for (const f of ['urna/urna.js', 'urna-real/urna-real.js', 'apuracao/apuracao.js', 'shared/js/sel-zip.js',
  'shared/js/sel-election-config.js', 'shared/js/sel-session-store.js',
  'shared/js/sel-result-files.js', 'shared/js/sel-verify-results.js',
  'shared/js/sel-navigation.js', 'shared/js/sel-sem-libras.js',
  'tools/build-lealand-data.mjs', 'tools/verify-lealand.mjs', 'tools/test-result-files.mjs']) {
  try {
    execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' });
    ok(true, 'sintaxe ' + f);
  } catch (e) { ok(false, 'sintaxe ' + f, (e.stderr || e.message || '').toString().slice(0, 160)); }
}

console.log(failures ? `\n${failures} FALHA(S)` : '\nTUDO OK');
process.exit(failures ? 1 : 0);
