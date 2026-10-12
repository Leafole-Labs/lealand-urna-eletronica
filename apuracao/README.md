# Urna Eletrônica de Lealand — Supremo Eleitoral de Lealand (SEL)

Site estático independente (sem build): servir `lealand/` por HTTP e abrir `index.html`.

```sh
cd lealand
python -m http.server 8080
# http://127.0.0.1:8080/index.html  (nunca file://)
```

Fluxo oficial: Sessões → nova sessão → Urna (votar) → Sessões → encerrar →
exportar pendrive (ZIP) → Apuração → importar → validar → apurar → boletim.
Cargo único: **Gerente** (91 Tibúrcio Lemos, 92 Dagoberto Sales, 93 Quitéria
Vasconcellos — nomes fictícios incomuns).

## Estrutura (responsabilidades separadas)

```text
lealand/
├── index.html          # portal SEL: Urna · Urna Real · Sessões · Apuração
├── urna/               # SOMENTE o emulador do eleitor
│   ├── index.html      # tela de votação (sem réplica de teclado)
│   ├── urna.js         # cola do motor + registro na sessão (teclado físico)
│   └── urna.css + eleitor-escolhas.css
├── urna-real/          # URNA REAL: só UENUX Screen + teclado físico
│   ├── index.html      # canvas + sessão (zero botões, zero teclado visual)
│   ├── urna-real.js    # boot do motor + cadeia única de teclado + sessão
│   └── urna-real.css
├── sessoes/
│   └── index.html      # gerente de sessões: nova, abrir urna, encerrar,
│                       # inspecionar artefatos, exportar pendrive (ZIP)
├── apuracao/
│   ├── index.html      # IMPORTA o ZIP (teclas I/A/B/E/L/V)
│   └── apuracao.js     # valida → apura → boletim → exporta boletim
├── shared/
│   ├── js/sel-zip.js               # codec ZIP STORED + CRC32/SHA-256 (sem deps)
│   ├── js/sel-election-config.js   # rol eleitoral (cruzado com o .data)
│   ├── js/sel-session-store.js     # persistência das sessões (localStorage)
│   ├── js/sel-result-files.js      # BU/RDV/log/impresso/vota (cadeia SHA-512,
│   │                               # assinatura ECDSA P-521 reais)
│   ├── js/sel-verify-results.js    # port de verify.js do urnaemu (checagens)
│   ├── js/sel-navigation.js + sel-sem-libras.js
│   ├── css/ + brand/ (brasão, bandeira) + images/urna.svg + fonts/
├── wasm/               # MOTOR VOTA intacto + dataset lealand-gerente
└── tools/              # build-lealand-data, verify, test-result-files,
                        # e2e-lealand (urna/), e2e-urna-real (urna-real/)
```

A urna não contém: mesário, terminal, apuração, exportadores, ferramentas,
testes ou docs. Sem réplica visual de teclado: vota-se pelo teclado físico
(0–9, Enter=CONFIRMA, Backspace=CORRIGE, Espaço=BRANCO); um marcador oculto
`data-vota-key="noop"` + `Module.uenuxExternalKeyboard` informa o motor de
que o adaptador é dono do teclado (sem ele, cada tecla chegava 2× ao motor).

## Urna real (`urna-real/`)

A urna física dentro do computador: **somente UENUX Screen + teclado físico**.
Zero botões HTML, zero teclado visual/virtual, zero mesário/apuração.
Reutiliza o canvas `#uenux-screen`, o motor WASM, o dataset, a sessão
(`sel-session-store`) e a guarda anti-Libras — nada duplicado do `urna/`
além da cola mínima (`urna-real.js`: boot do motor + cadeia única de
teclado + registro de votos; `postRun` + `votaInit` idênticos em conceito).

Entrada: `keydown → votaPressKey → tick`, com cadência mínima de 1100ms entre
entregas (medido: o motor perde transições abaixo de ~1s; a ordem é preservada
pela cadeia). Fila interna do motor neutralizada no host (array real com
`push` descartado e contado) para entrega exatamente única — motor intacto.
Pós-FIM, Enter chama o próximo eleitor (mesma sessão). Sem sessão aberta, os
votos são recusados com mensagem. Requer ainda um `<pre id="mt" hidden>`:
o motor escreve nele via `js_mt_set` (detalhe de integração, sem UI).

## Sessão eleitoral real (espelho do `urnaemu`)

Sessão = `{sessionId: sel-AAAAMMDD-HHMMSS-xxx, urna, inicio, fim,
estado: aberta|encerrada, votos:[{seq, cargo, tipo, numero, registradoEm}],
eventos, candidatos, artefatos}` em `localStorage["sel-lealand-sessoes-v1"]`
(gravada a cada voto/evento — nunca só em memória).

Ao encerrar, a sessão gera os artefatos do pendrive, com prefixo
`t02400ll0000100010001` (`t` + pleito + seção `ll0000100010001`, gramática do
`native-savd.js`; seção/fase/carga documentados como sintéticos de Lealand):

| Arquivo | Espelho urnaemu | Conteúdo real |
|---|---|---|
| `<P>-bu.json` | `EntidadeBoletimUrna` | cabeçalho, fase 3, seção, urna, abertura/encerramento (DataHoraJE), eleição 2421, blocos com `ordemGeracaoHash`+`hash`, `ultimoHash`, assinatura P-521, comparecimento |
| `<P>-rdv.json` | `EntidadeResultadoRDV` | 1 voto por eleitor/cargo em ordem (`tipoVoto` 2/3/4 + `digitacao`) |
| `<P>-log.zip` | `-log.jez` | `logd.dat` (DATA HORA·INFO·SEL-0001·SESSAO·evento) |
| `<P>-bu.txt` | BU impresso | `Boletim de Urna`, `--Gerente--`, `Partido: N`, nominais, `Brancos/Nulos/Total Apurado` (parseável por `parsePrintedBu`) |
| `<P>-vota.json` | `vota.vsc` | catálogo: tamanho + SHA-512 + assinatura P-521 por arquivo; SPKI embutida; perfil `SEL-TESTE-P521` |
| `<P>-candidaturas.json` | (sistema de candidaturas) | rol 91/92/93 p/ o boletim (extensão SEL documentada) |

Cadeia com a matemática exata de `verify.js` (semente `pleito|eleição|
município|zona|seção|carga-24-espaços`, blocos `HEX|seq|cargo|tipo|qtd…`,
SHA-512 real). Identidade de teste P-521 persistida (JWK, espelho de
`identity-store`); autoverificação a cada assinatura. Divergências honestas
do TSE: JSON em vez de BER/DER, sem X.509/CEPESC/SAVD/hardware.

## Apuração (equipamento separado, só arquivos)

`sessoes/` exporta `pendrive-lealand-<prefixo>-<sessionId>.zip` (6 arquivos no
raiz, como `DadosDeUrna_*.zip`). A apuração importa o ZIP e valida (cadeia,
final, assinatura P-521, catálogo, totais RDV↔BU, ordenação, impresso×BU,
seção, pleito, fase, urna, cargo 11, formatos `sel-{bu,rdv,vota,candidaturas}/1`).
Pacote ruim → erros listados, sem boletim falso. Teclas: **I** importar,
**A** apurar, **B** boletim, **E** exportar boletim, **L** descartar,
**V** urna (ignoradas em campos). Boletim: SEL, eleição, seção, período,
carga, cadeia, candidaturas (nome/vice/partido/votos), brancos, nulos, total,
hashes; exportado como HTML standalone imprimível e reaberto em teste.

## Dataset — `wasm/bases/lealand-gerente.data` (514484 bytes)

Cargo 11 majoritário 2 dígitos; partidos 91 PGL, 92 PUL, 93 PCL; 6 JPEGs;
localidade Lealand. Códigos `pe 2400/uf ac/turno 2/fase te` herdados do molde.

## Identidade

Branding oficial (fundo `#e9efe6`, verdes, Arial; `shared/brand/`). Brasão =
logo institucional a 56px no cabeçalho; GIF de Libras removido (guarda +
camada neutralizada, 0 `<img>`); relevo brasileiro removido do SVG;
zero TSE/Justiça Eleitoral/Prefeito/Vereador na apresentação.

## Testes e resultados

- `verify-lealand.mjs` → estrutura (incl. `urna-real/`), urna limpa, dataset,
  identidade, arquitetura.
- `test-result-files.mjs` → **17/17** (codec, cadeia, assinatura, 10 rejeições,
  zerada, impresso, canonização).
- `e2e-lealand.py` (Chrome real, `urna/`) → fluxo votar→encerrar→ZIP→importar→
  apurar→boletim com sessão real.
- `e2e-urna-real.py` (Chrome real, só teclado físico) → **18/18**: zero
  botões, UENUX, entrega exata (91 fica 91; dígito único não conclui),
  91/92/93, branco, nulo99, Backspace corrige, sessão com 6 votos exatos,
  ZIP válido, apuração isolada, totais e boletim conferem.
- `urnaemu/` e `meu/` intocados (só leitura); motor WASM intacto.

## Limitações

CORRIGE pós-nulo tem semântica de buffer do motor (apagar por dígito);
nulo exige dupla confirmação; `TREINAMENTO`/`Município/Zona/Seção` do WASM;
BU impresso preservado na camada mesário; sem X.509/BER (JSON honesto).
