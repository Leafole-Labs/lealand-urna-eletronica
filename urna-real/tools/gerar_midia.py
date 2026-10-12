#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Gerador de midia de votacao (formato UrnaEmu/SEL).

Gera um pacote como ``lealand-oficial.data`` (+ ``.data.js`` + ``manifest.json``)
e os lacres ``.pid`` externos como ``o02421ac-ce.pid`` /
``o02421ac00001-ca.pid``.

Uso tipico (regera midia identica a atual, so atualizando o timestamp)::

    python tools/gerar_midia.py

Uso com eleicao nova (PE/UF/turno/municipio/zona/secao + candidatos)::

    python tools/gerar_midia.py --pe 2421 --uf ac --turno 2 --municipio 1 \\
        --zona 1 --secao 1 --timestamp 202609101622 \\
        --candidatos candidatos.json --out-dir wasm/bases --id lealand-oficial

Formato dos arquivos
--------------------
* ``.data``: concatenacao dos arquivos do pacote; ``.data.js`` carrega o
  indice ``{filename, start, end}`` no FS do WASM (``carregarPacote``).
* ``.dat``: BER/DER (textos em Windows-1252). ``.pid``: DER
  ``SEQUENCE { INTEGER tipo, SEQUENCE escopo, GeneralString jez,
  NumericString timestamp, INTEGER 14 }``.
* ``.vsc``: assinatura (opaco, copiado do molde). ``serialv.dat``: serial.

Estrategia: usa uma midia existente como MOLDE estrutural (igual ao
``build-lealand-data.mjs`` que usa ``municipal-t2`` como molde) e reempacota.
Os ``.pid`` externos (``o*.pid``) sao derivados dos ``t*.pid`` internos com
o nome do ``.jez`` trocado de ``t`` para ``o`` (conteudo identico, verificado
byte a byte no molde atual).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

AQUI = Path(__file__).resolve().parent
RAIZ = AQUI.parent  # urna-real/
BASES_PADRAO = RAIZ / "wasm" / "bases"
DATA_PADRAO = "lealand-oficial.data"
JS_PADRAO = "lealand-oficial.data.js"

TAGS_TEXTO = (18, 19, 22, 27)  # NumericString, PrintableString, IA5String, UTF8/Generalized


# ---------------------------------------------------------------- BER/DER
class No:
    __slots__ = ("tag", "children", "text", "hex", "original", "snapshot")

    def __init__(self, tag, children=None, text=None, hex=None, original=None):
        self.tag = tag
        self.children = children
        self.text = text
        self.hex = hex
        self.original = original  # bytes originais (para re-emissao identica)
        self.snapshot = _snapshot(self)

    def __repr__(self):  # pragma: no cover
        if self.children is not None:
            return f"No(tag={self.tag:#x}, n={len(self.children)})"
        return f"No(tag={self.tag:#x}, text={self.text!r}, hex={self.hex!r})"


def _snapshot(n: "No") -> str:
    if n.children is not None:
        return json.dumps({"tag": n.tag, "children": [_snapshot(c) for c in n.children]},
                          ensure_ascii=False, sort_keys=True)
    if n.text is not None:
        return json.dumps({"tag": n.tag, "text": n.text}, ensure_ascii=False, sort_keys=True)
    return json.dumps({"tag": n.tag, "hex": n.hex}, ensure_ascii=False, sort_keys=True)


def ber_parse(buf: bytes) -> No:
    b = bytes(buf)
    n = len(b)
    at = 0
    count = 0

    def node(end: int, depth: int = 0) -> No:
        nonlocal at, count
        if depth > 64 or count > 100000:
            raise ValueError("Arquivo BER complexo demais")
        count += 1
        start = at
        if at + 2 > end:
            raise ValueError("Estrutura BER truncada")
        tag = b[at]
        at += 1
        if tag & 31 == 31:
            raise ValueError("Tag BER nao suportada")
        size = b[at]
        at += 1
        if size & 128:
            nb = size & 127
            if not nb or nb > 4 or at + nb > end:
                raise ValueError("Comprimento BER nao suportado")
            size = int.from_bytes(b[at:at + nb], "big")
            at += nb
        stop = at + size
        if stop > end:
            raise ValueError("Valor BER truncado")
        if tag & 32:
            children = []
            while at < stop:
                children.append(node(stop, depth + 1))
            return No(tag, children=children, original=b[start:at])
        raw = b[at:stop]
        at = stop
        if tag in TAGS_TEXTO:
            return No(tag, text=raw.decode("cp1252"), hex=raw.hex(), original=b[start:at])
        return No(tag, hex=raw.hex(), original=b[start:at])

    root = node(n)
    if at != n:
        raise ValueError("Dados sobrando depois da estrutura BER")
    return root


def ber_encode(n: No, depth: int = 0) -> bytes:
    if depth > 64 or not isinstance(n.tag, int) or n.tag < 0 or n.tag > 255 or (n.tag & 31) == 31:
        raise ValueError("No BER invalido")
    # Re-emissao byte-identica quando nada mudou (igual ao load-format.js).
    if n.original is not None and n.snapshot == _snapshot(n):
        return bytes(n.original)
    if n.children is not None:
        corpo = b"".join(ber_encode(c, depth + 1) for c in n.children)
    elif n.text is not None:
        corpo = n.text.encode("cp1252")
    else:
        corpo = bytes.fromhex(n.hex or "")
    tam = len(corpo)
    if tam < 128:
        return bytes([n.tag, tam]) + corpo
    a = []
    t = tam
    while t:
        a.insert(0, t & 255)
        t >>= 8
    return bytes([n.tag, 0x80 | len(a)]) + bytes(a) + corpo


def int_hex(n: int) -> str:
    if n < 0:
        raise ValueError("INTEGER negativo nao suportado aqui")
    h = format(n, "x")
    if len(h) % 2:
        h = "0" + h
    if int(h[:2], 16) & 0x80:
        h = "00" + h
    return h


def int_of(no: No) -> int:
    return int(no.hex or "0", 16)


def ascii_hex(s: str) -> str:
    return s.encode("ascii").hex()


def caminhar(no: No):
    yield no
    for c in no.children or []:
        yield from caminhar(c)


# ------------------------------------------------------- pacote .data/.js
def extrair_meta(js_texto: str) -> dict:
    m = re.search(r"carregarPacote\((\{.*?\})\)", js_texto, re.S)
    if not m:
        raise ValueError(".data.js sem chamada carregarPacote({...})")
    return json.loads(m.group(1))


def carregar_pacote(data_path: Path, js_path: Path) -> tuple[dict, dict[str, bytes], str]:
    meta = extrair_meta(js_path.read_text(encoding="utf-8"))
    blob = data_path.read_bytes()
    arquivos = {}
    for f in meta["files"]:
        arquivos[f["filename"]] = bytes(blob[f["start"]:f["end"]])
    head = js_path.read_text(encoding="utf-8")
    head = head[:head.rindex("carregarPacote(")]
    return meta, arquivos, head


def reempacotar(arquivos: dict[str, bytes], ordem: list[str],
                out_data: Path, out_js: Path, head_loader: str) -> dict:
    chunks = []
    indice = []
    at = 0
    for nome in ordem:
        if nome not in arquivos:
            raise KeyError(f"arquivo ausente no pack: {nome}")
        b = arquivos[nome]
        chunks.append(b)
        indice.append({"filename": nome, "start": at, "end": at + len(b)})
        at += len(b)
    blob = b"".join(chunks)
    out_data.write_bytes(blob)
    # JSON compacto (separators sem espaco), igual ao JSON.stringify do
    # builder original: o autoteste em urna.js extrai remote_package_size via regex.
    payload = json.dumps({"data": out_data.name, "remote_package_size": len(blob), "files": indice},
                         separators=(",", ":"))
    out_js.write_text(head_loader + "  carregarPacote(" + payload + ");\n})();\n", encoding="utf-8")
    return {"data": out_data.name, "remote_package_size": len(blob), "files": indice}


# ------------------------------------------------------------- candidatos
def _nome_base(path: str) -> str:
    return path[path.rindex("/") + 1:]


def _irmao(ca_path: str, kind: str) -> str:
    return ca_path[:-len("-ca.dat")] + f"-{kind}.dat"


def ler_cargos(arquivos: dict[str, bytes], ca_path: str) -> dict[int, dict]:
    prefixo = _nome_base(ca_path)[:6]  # ex. t02421 / o02421
    saida: dict[int, dict] = {}
    for path, blob in arquivos.items():
        if not re.search(rf"/{re.escape(prefixo)}[a-z]{{2}}-ce\.dat$", path):
            continue
        for cargo in ber_parse(blob).children[7].children:
            c = cargo.children
            detalhe = next((x for x in c if x.tag == 160), None)
            filhos = detalhe.children if detalhe else []
            nomes = next((x for x in filhos if x.tag == 48), None)
            nomes = nomes.children if nomes else []
            supl = [x for x in filhos if x.tag == 48]
            supl = supl[1].children if len(supl) > 1 else []
            papeis = []
            for s in supl:
                seq = next((x for x in s.children if x.tag == 48), None)
                papeis.append(seq.children[0].text if seq and seq.children else "Suplente")
            saida[int_of(c[0])] = {
                "nome": nomes[0].text if nomes else f"Cargo {int_of(c[0])}",
                "digitos": int_of(c[2]),
                "majoritario": int_of(c[1]) == 1,
                "suplentes": papeis,
            }
    return saida


def ler_pessoa(no: No) -> dict:
    c = no.children
    por_tag = {}
    for x in c:
        por_tag.setdefault(x.tag, x)
    enums = [x for x in c if x.tag == 10]
    data = next((x for x in c if x.tag == 18), None)
    inteiro = next((x for x in c if x.tag == 2), None)
    flag = next((x for x in c if x.tag == 1), None)
    return {
        "code": bytes.fromhex(por_tag[129].hex).decode("ascii"),
        "nome": c[1].text,
        "nomeUrna": c[2].text,
        "fonetico": bytes.fromhex(por_tag[131].hex).decode("cp1252") if 131 in por_tag else "",
        "nascimento": data.text if data else "",
        "genero": int_of(enums[0]) if len(enums) > 0 else 0,
        "situacao": int_of(enums[1]) if len(enums) > 1 else 12,
        "ordem": int_of(por_tag[133]) if 133 in por_tag else None,
        "extra": {"int": inteiro.hex if inteiro else "00", "flag": flag.hex if flag else "00"},
    }


def escrever_pessoa(p: dict) -> No:
    out = [
        No(129, hex=ascii_hex(str(p["code"]))),
        No(27, text=p["nome"]),
        No(27, text=p["nomeUrna"]),
    ]
    if p.get("fonetico"):
        out.append(No(131, hex=p["fonetico"].encode("cp1252").hex()))
    out += [
        No(18, text=p["nascimento"]),
        No(10, hex=int_hex(p["genero"])),
        No(10, hex=int_hex(p.get("situacao", 12))),
        No(2, hex=(p.get("extra") or {}).get("int", "00")),
    ]
    if p.get("ordem") is not None:
        out.append(No(133, hex=int_hex(p["ordem"])))
    out.append(No(1, hex=(p.get("extra") or {}).get("flag", "00")))
    return No(48, children=out)


def ler_eleicoes(arquivos: dict[str, bytes]) -> list[dict]:
    eleicoes = []
    for path in sorted(p for p in arquivos if p.endswith("-ca.dat")):
        raiz = ber_parse(arquivos[path])
        cargos = ler_cargos(arquivos, path)
        pa_path = _irmao(path, "pa")
        partidos = []
        if pa_path in arquivos:
            for p in ber_parse(arquivos[pa_path]).children[2].children:
                partidos.append({"number": int_of(p.children[0]),
                                 "sigla": p.children[1].text, "nome": p.children[2].text})
        gabinetes = []
        for cargo in raiz.children[2].children:
            code = int_of(cargo.children[0])
            info = cargos.get(code, {})
            cands = []
            for grupo in cargo.children[2].children:
                partido = int_of(grupo.children[0])
                cauda = ber_encode(grupo.children[2]).hex()
                for cand in grupo.children[1].children:
                    supl = cand.children[3].children if len(cand.children) > 3 else None
                    cands.append({
                        "party": partido,
                        "number": int_of(cand.children[0]),
                        "titular": ler_pessoa(cand.children[1]),
                        "label": cand.children[2].text,
                        "suplentes": [ler_pessoa(s) for s in supl] if supl is not None else None,
                        "groupTail": cauda,
                    })
            gabinetes.append({"code": code, "nome": info.get("nome", f"Cargo {code}"),
                              "digitos": info.get("digitos"), "extra": cargo.children[1].hex,
                              "candidacies": cands})
        eleicoes.append({"path": path, "parties": partidos, "offices": gabinetes})
    return eleicoes


def validar_eleicoes(eleicoes: list[dict]) -> list[str]:
    problemas = []
    codigos: set[str] = set()
    for e in eleicoes:
        numeros_partidos = set()
        for p in e["parties"]:
            onde = f"Partido {p['number']}"
            if not isinstance(p["number"], int) or p["number"] < 10 or p["number"] > 99:
                problemas.append(f"{onde}: numero do partido tem 2 digitos (10 a 99).")
            if p["number"] in numeros_partidos:
                problemas.append(f"{onde}: numero repetido.")
            numeros_partidos.add(p["number"])
        for o in e["offices"]:
            vistos = set()
            if not o["candidacies"]:
                problemas.append(f"{o['nome']}: o cargo precisa de ao menos uma candidatura.")
            for c in o["candidacies"]:
                onde = f"{o['nome']} {c['number']}"
                if c["party"] not in numeros_partidos:
                    problemas.append(f"{onde}: o partido {c['party']} nao existe.")
                if o.get("digitos") and len(str(c["number"])) != o["digitos"]:
                    problemas.append(f"{onde}: o numero tem {o['digitos']} digitos para este cargo.")
                if not str(c["number"]).startswith(str(c["party"])):
                    problemas.append(f"{onde}: o numero comeca com o numero do partido ({c['party']}).")
                if c["number"] in vistos:
                    problemas.append(f"{onde}: numero repetido no cargo.")
                vistos.add(c["number"])
                for pessoa, papel in [(c["titular"], "titular")] + [
                        (s, f"suplente {i+1}") for i, s in enumerate(c.get("suplentes") or [])]:
                    quem = f"{onde}, {papel}"
                    if not str(pessoa.get("nome") or "").strip():
                        problemas.append(f"{quem}: nome vazio.")
                    if not re.fullmatch(r"[1-9][0-9]*", str(pessoa.get("code") or "")):
                        problemas.append(f"{quem}: codigo do candidato invalido "
                                         f"({pessoa.get('code')!r}; deve ser numerico, sem zero a esquerda).")
                    try:
                        (pessoa.get("nomeUrna") or "").encode("cp1252")
                    except UnicodeEncodeError:
                        problemas.append(f"{quem}: caractere fora de Windows-1252.")
                    if not re.fullmatch(r"\d{8}", pessoa.get("nascimento") or ""):
                        problemas.append(f"{quem}: nascimento invalido (AAAAMMDD).")
                    if pessoa.get("genero") not in (2, 4):
                        problemas.append(f"{quem}: genero invalido (2/4).")
                    if pessoa.get("code") in codigos:
                        problemas.append(f"{quem}: codigo {pessoa.get('code')} repetido.")
                    codigos.add(pessoa.get("code"))
    return problemas


def escrever_eleicoes(arquivos: dict[str, bytes], eleicoes: list[dict],
                      fotos: dict[str, bytes] | None = None) -> dict[str, bytes]:
    fotos = fotos or {}
    problemas = validar_eleicoes(eleicoes)
    if problemas:
        raise ValueError("Candidaturas invalidas: " + " ".join(problemas))
    saida = dict(arquivos)
    for e in eleicoes:
        raiz = ber_parse(arquivos[e["path"]])
        gabinetes = []
        for o in sorted(e["offices"], key=lambda x: x["code"]):
            grupos: dict[int, dict] = {}
            for c in sorted(o["candidacies"], key=lambda x: x["number"]):
                filhos = [No(2, hex=int_hex(c["number"])), escrever_pessoa(c["titular"]),
                          No(27, text=c.get("label") or "")]
                if c.get("suplentes") is not None:
                    filhos.append(No(48, children=[escrever_pessoa(s) for s in c["suplentes"]]))
                grupos.setdefault(c["party"], {"tail": c.get("groupTail") or "3000", "list": []})
                grupos[c["party"]]["list"].append(No(48, children=filhos))
            gabinetes.append(No(48, children=[
                No(129, hex=int_hex(o["code"])),
                No(2, hex=o["extra"]),
                No(48, children=[
                    No(48, children=[
                        No(2, hex=int_hex(partido)),
                        No(48, children=g["list"]),
                        ber_parse(bytes.fromhex(g["tail"])),
                    ]) for partido, g in sorted(grupos.items())
                ]),
            ]))
        raiz.children[2].children = gabinetes
        saida[e["path"]] = ber_encode(raiz)
        pa_path = _irmao(e["path"], "pa")
        if pa_path in arquivos:
            pa = ber_parse(arquivos[pa_path])
            pa.children[2].children = [
                No(48, children=[No(2, hex=int_hex(p["number"])),
                                No(27, text=p["sigla"].strip()),
                                No(27, text=p["nome"].strip())])
                for p in sorted(e["parties"], key=lambda x: x["number"])]
            saida[pa_path] = ber_encode(pa)
        fo_path = _irmao(e["path"], "fo")
        if fo_path in arquivos:
            fo = ber_parse(arquivos[fo_path])
            existentes = {x.children[0].text: x for x in fo.children[2].children}
            desejados = []
            for o in e["offices"]:
                for c in o["candidacies"]:
                    desejados.append(c["titular"]["code"])
                    desejados.extend(s["code"] for s in c.get("suplentes") or [])
            desejados = sorted(set(desejados), key=Number)
            papel = {}  # codigo -> "titular" | "suplente"
            for o in e["offices"]:
                for c in o["candidacies"]:
                    papel.setdefault(c["titular"]["code"], "titular")
                    for s in c.get("suplentes") or []:
                        papel.setdefault(s["code"], "suplente")
            novos = []
            for code in desejados:
                if code in fotos:
                    esperado = FOTO_TITULAR if papel.get(code) == "titular" else FOTO_SUPLENTE
                    blob, mudou = ajustar_foto(bytes(fotos[code]), esperado, code)
                    if mudou:
                        atual = jpeg_tamanho(bytes(fotos[code]))
                        print(f"foto {code} ({papel.get(code)}): "
                              f"{atual[0]}x{atual[1]} -> {esperado[0]}x{esperado[1]} "
                              f"({len(fotos[code])} -> {len(blob)} bytes)")
                    novos.append(No(48, children=[
                        No(27, text=code),
                        No(48, children=[No(10, hex="01"), No(4, hex=blob.hex())]),
                    ]))
                elif code in existentes:
                    novos.append(existentes[code])
                else:
                    raise ValueError(f"Falta a foto do candidato de codigo {code}.")
            fo.children[2].children = novos
            saida[fo_path] = ber_encode(fo)
    return saida


# Tamanhos oficiais das fotos (candidates.js PHOTO_SIZE; conferem no molde:
# titular 161x225, vice/suplente 111x155).
FOTO_TITULAR = (161, 225)
FOTO_SUPLENTE = (111, 155)

try:
    from PIL import Image as _PILImage  # noqa: F401
    _PIL_OK = True
except ImportError:  # pragma: no cover
    _PIL_OK = False


def jpeg_tamanho(blob: bytes) -> tuple[int, int] | None:
    """Dimensoes (largura, altura) de um JPEG via marcadores SOF, sem dependencias."""
    if blob[:2] != b"\xff\xd8":
        return None
    i = 2
    while i + 4 <= len(blob):
        if blob[i] != 0xFF:
            i += 1
            continue
        marcador = blob[i + 1]
        if marcador in (0xD8, 0xD9) or 0xD0 <= marcador <= 0xD7 or marcador == 0x01:
            i += 2
            continue
        if i + 4 > len(blob):
            break
        tam = int.from_bytes(blob[i + 2:i + 4], "big")
        if tam < 2 or i + tam > len(blob):
            break
        # SOF0-SOF3, SOF5-SOF11, SOF13-SOF15 (exclui DHT/DAC etc.)
        if marcador in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                        0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            altura = int.from_bytes(blob[i + 5:i + 7], "big")
            largura = int.from_bytes(blob[i + 7:i + 9], "big")
            return (largura, altura)
        i += 2 + tam
    return None


def ajustar_foto(blob: bytes, tamanho: tuple[int, int], code: str = "?") -> tuple[bytes, bool]:
    """Ajusta um JPEG ao tamanho oficial (cover: preenche + corta centro).

    Retorna (bytes, redimensionado). Se ja esta no tamanho exato, devolve os
    bytes originais intocados (round-trip byte-identico).
    """
    atual = jpeg_tamanho(blob)
    if atual == tuple(tamanho):
        return blob, False
    if not _PIL_OK:
        raise ValueError(f"foto do codigo {code} tem {atual or '?'}; esperado "
                         f"{tamanho[0]}x{tamanho[1]}. Instale Pillow para redimensionar.")
    import io
    from PIL import Image
    img = Image.open(io.BytesIO(blob)).convert("RGB")
    larg_alvo, alt_alvo = tamanho
    escala = max(larg_alvo / img.width, alt_alvo / img.height)
    img = img.resize((max(1, round(img.width * escala)), max(1, round(img.height * escala))),
                     Image.LANCZOS)
    esq = (img.width - larg_alvo) // 2
    topo = (img.height - alt_alvo) // 2
    img = img.crop((esq, topo, esq + larg_alvo, topo + alt_alvo))
    saida = io.BytesIO()
    img.save(saida, "JPEG", quality=85)
    return saida.getvalue(), True


def Number(x: str) -> int:
    try:
        return int(x)
    except ValueError:
        return 0


# ------------------------------------------------------------- renomeacoes
def renomear_of(s: str) -> str:
    s = re.sub(r"(^|/)t(?=\d{5})", r"\1o", s)
    s = re.sub(r"infomidia-fv-(\d)-t\.", r"infomidia-fv-\1-o.", s)
    s = re.sub(r"scueconf-t(\d)\.", r"scueconf-o\1.", s)
    return s


def renomear_te(s: str) -> str:
    s = re.sub(r"(^|/)o(?=\d{5})", r"\1t", s)
    s = re.sub(r"infomidia-fv-(\d)-o\.", r"infomidia-fv-\1-t.", s)
    s = re.sub(r"scueconf-o(\d)\.", r"scueconf-t\1.", s)
    return s


def eh_id_pacote(n: No) -> bool:
    c = n.children or []
    return (n.tag == 48 and len(c) == 5 and c[0].tag == 10 and c[1].tag == 48
            and len(c[1].children or []) > 1 and c[1].children[1].tag == 10
            and c[2].tag == 27 and c[3].tag == 18 and c[4].tag == 10)


def forcar_fase(arquivos: dict[str, bytes], fase: str) -> dict[str, bytes]:
    """Converte o pack entre treinamento ('te', fase 03, prefixo t) e
    oficial ('of', fase 02, prefixo o)."""
    alvo = "02" if fase == "of" else "03"
    ren = renomear_of if fase == "of" else renomear_te
    saida: dict[str, bytes] = {}
    for caminho, blob in arquivos.items():
        destino = ren(caminho) if caminho.endswith(".dat") else caminho
        novo = blob
        if (caminho.endswith(".dat") and caminho != "/dsk/fi/serialv.dat"
                and not caminho.endswith("-rdj.dat") and blob):
            raiz = ber_parse(blob)
            for n in caminhar(raiz):
                if n.text is not None:
                    n.text = ren(n.text)
                if eh_id_pacote(n):
                    atual = n.children[1].children[1].hex
                    if atual not in ("02", "03"):
                        raise ValueError(f"fase inesperada em {caminho}: {atual}")
                    n.children[1].children[1].hex = alvo
            if caminho.endswith("-cp.dat"):
                txt = raiz.children[1].text or ""
                if fase == "of":
                    txt = re.sub(r"^Treinamento\s+", "", txt, flags=re.I)
                    if not txt.endswith(" - LEALAND"):
                        txt += " - LEALAND"
                raiz.children[1].text = txt
            novo = ber_encode(raiz)
        if destino in saida:
            raise ValueError(f"colisao ao converter fase: {destino}")
        saida[destino] = novo
    return saida


# ------------------------------------------------------------------- .pid
def pid_trocar_nome_timestamp(pid: bytes, novo_jez: str | None = None,
                              novo_ts: str | None = None) -> bytes:
    """Deriva um .pid trocando o nome do .jez e/ou o timestamp.

    O escopo (PE/UF/municipio...) e o tipo sao preservados byte a byte.
    """
    raiz = ber_parse(pid)
    if raiz.tag != 48 or len(raiz.children) != 5:
        raise ValueError(".pid com estrutura inesperada")
    if novo_jez is not None:
        raiz.children[2].text = novo_jez
    if novo_ts is not None:
        if not re.fullmatch(r"\d{12}", novo_ts):
            raise ValueError("timestamp do .pid deve ter 12 digitos (AAAAMMDDHHMM)")
        raiz.children[3].text = novo_ts
    # Nao atualizar .snapshot: o ber_encode re-emite os nos alterados e
    # mantem byte-identicos os intocados (igual ao load-format.js).
    return ber_encode(raiz)


def pid_info(pid: bytes) -> dict:
    raiz = ber_parse(pid)
    return {"tipo": int_of(raiz.children[0]),
            "jez": raiz.children[2].text,
            "timestamp": raiz.children[3].text,
            "trailer": int_of(raiz.children[4])}


def gerar_pids_externos(arquivos: dict[str, bytes], quais: list[str],
                        timestamp: str | None = None) -> dict[str, bytes]:
    """Gera os ``o*.pid`` externos a partir dos ``t*.pid`` internos.

    ``quais``: nomes base internos (ex. ``t02421ac-ce``). Para cada um, o
    ``.jez`` interno ``t....jez`` vira ``o....jez``.
    """
    saida = {}
    for base in quais:
        interno = f"/dsk/fi/estatico/{base}.pid"
        if interno not in arquivos:
            raise KeyError(f"{interno} ausente no pacote (molde sem esse pid)")
        externo_jez = "o" + base[1:] + ".jez" if base.startswith("t") else base + ".jez"
        externo_nome = "o" + base[1:] + ".pid" if base.startswith("t") else base + ".pid"
        saida[externo_nome] = pid_trocar_nome_timestamp(arquivos[interno], externo_jez, timestamp)
    return saida


# ------------------------------------------------------------------- main
def carregar_fotos(arquivos: dict[str, bytes], eleicao_path: str,
                   de_outro_pack: dict[str, bytes] | None = None,
                   de_outro_ca: str | None = None) -> dict[str, bytes]:
    fotos: dict[str, bytes] = {}
    fo = _irmao(eleicao_path, "fo")
    if fo in arquivos:
        for x in ber_parse(arquivos[fo]).children[2].children:
            fotos[x.children[0].text] = bytes.fromhex(x.children[1].children[1].hex)
    if de_outro_pack and de_outro_ca:
        fo2 = _irmao(de_outro_ca, "fo")
        if fo2 in de_outro_pack:
            for x in ber_parse(de_outro_pack[fo2]).children[2].children:
                fotos.setdefault(x.children[0].text, bytes.fromhex(x.children[1].children[1].hex))
    return fotos


def carregar_fotos_extras(mapa_path: str | None = None,
                          fotos_dir: str | None = None) -> dict[str, bytes]:
    """Carrega JPEGs extras: JSON {codigo: caminho} e/ou diretorio <codigo>.jpg."""
    extras: dict[str, bytes] = {}
    if fotos_dir:
        d = Path(fotos_dir)
        for img in sorted(d.iterdir()):
            if img.is_file() and img.suffix.lower() in (".jpg", ".jpeg") and img.stem.isdigit():
                extras[img.stem] = img.read_bytes()
    if mapa_path:
        mapa = json.loads(Path(mapa_path).read_text(encoding="utf-8"))
        base = Path(mapa_path).parent
        for code, rel in mapa.items():
            p = Path(rel)
            if not p.is_absolute():
                p = base / p
            extras[str(code)] = p.read_bytes()
    for code, blob in extras.items():
        if blob[:2] != b"\xff\xd8":
            raise ValueError(f"foto do codigo {code} nao e JPEG (SOI ausente).")
        if len(blob) > 512 * 1024:
            raise ValueError(f"foto do codigo {code} grande demais ({len(blob)} bytes).")
    return extras


def extrair_fotos(arquivos: dict[str, bytes], out_dir: Path) -> list[Path]:
    """Salva as fotos do molde em <out_dir>/<codigo>.jpg. Retorna os arquivos."""
    out_dir.mkdir(parents=True, exist_ok=True)
    gravados = []
    for path in sorted(p for p in arquivos if p.endswith("-fo.dat")):
        for x in ber_parse(arquivos[path]).children[2].children:
            dest = out_dir / f"{x.children[0].text}.jpg"
            dest.write_bytes(bytes.fromhex(x.children[1].children[1].hex))
            gravados.append(dest)
    return gravados


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Gera midia de votacao (.data + .pid).")
    ap.add_argument("--template-data", default=str(BASES_PADRAO / DATA_PADRAO))
    ap.add_argument("--template-js", default=str(BASES_PADRAO / JS_PADRAO))
    ap.add_argument("--out-dir", default=str(BASES_PADRAO))
    ap.add_argument("--id", default="lealand-oficial", help="id do cenario (nome base dos .data)")
    ap.add_argument("--label", default="Eleição de Lealand — Gerente (oficial)")
    ap.add_argument("--description", default="Mídia oficial de Lealand: fase oficial do motor (sem TREINAMENTO).")
    ap.add_argument("--fase", choices=["of", "te"], default="of")
    ap.add_argument("--pe", type=int, default=2400)
    ap.add_argument("--uf", default="ac")
    ap.add_argument("--turno", type=int, default=2)
    ap.add_argument("--municipio", type=int, default=1)
    ap.add_argument("--zona", type=int, default=1)
    ap.add_argument("--secao", type=int, default=1)
    ap.add_argument("--timestamp", default=None,
                    help="12 digitos AAAAMMDDHHMM para os .pid (padrao: mantem o do molde)")
    ap.add_argument("--candidatos", default=None,
                    help="JSON com {parties:[{number,sigla,nome}], candidacies:[{party,number,titular:{code,nome,nomeUrna,...},suplentes:[...]}]}")
    ap.add_argument("--fotos", default=None,
                    help="JSON {codigo: caminho.jpg} com JPEGs de reposicao (chave = codigo do candidato)")
    ap.add_argument("--fotos-dir", default=None,
                    help="diretorio com <codigo>.jpg de reposicao (ex. 1.jpg, 2.jpg)")
    ap.add_argument("--extrair-fotos", default=None,
                    help="extrai as fotos do molde para o diretorio indicado e sai (sem gerar midia)")
    ap.add_argument("--pids", default="t02421ac-ce,t02421ac00001-ca",
                    help="bases internas (sem .pid) para gerar os o*.pid externos, separadas por virgula")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    tpl_data = Path(args.template_data)
    tpl_js = Path(args.template_js)
    out_dir = Path(args.out_dir)
    meta, arquivos, head = carregar_pacote(tpl_data, tpl_js)
    ordem_tpl = [f["filename"] for f in meta["files"]]
    print(f"molde: {tpl_data.name} ({len(meta['files'])} arquivos, {tpl_data.stat().st_size} bytes)")

    if args.extrair_fotos:
        gravados = extrair_fotos(arquivos, Path(args.extrair_fotos))
        print(f"fotos extraidas: {len(gravados)} em {args.extrair_fotos}")
        for g in gravados:
            print(" ", g.name, g.stat().st_size, "bytes")
        return 0

    # ---- fotos extras (reposicao) ----
    extras = carregar_fotos_extras(args.fotos, args.fotos_dir)
    if extras:
        print(f"fotos de reposicao: {sorted(extras)}")

    # ---- candidatos/partidos opcionais ----
    if args.candidatos or extras:
        cfg = json.loads(Path(args.candidatos).read_text(encoding="utf-8")) if args.candidatos else {}
        eleicoes = ler_eleicoes(arquivos)
        alvo = next((e for e in eleicoes if e["path"].endswith("00001-ca.dat")), eleicoes[0])
        fotos = carregar_fotos(arquivos, alvo["path"])
        fotos.update(extras)  # reposicao prevalece sobre o molde
        if "parties" in cfg:
            alvo["parties"] = cfg["parties"]
        if "candidacies" in cfg:
            for c in cfg["candidacies"]:
                c.setdefault("label", "")
                c.setdefault("groupTail", "3000")
                c["titular"].setdefault("fonetico", "")
                c["titular"].setdefault("situacao", 12)
                c["titular"].setdefault("extra", {"int": "00", "flag": "00"})
                for s in c.get("suplentes") or []:
                    s.setdefault("fonetico", "")
                    s.setdefault("situacao", 12)
                    s.setdefault("extra", {"int": "00", "flag": "00"})
            alvo["offices"][0]["candidacies"] = cfg["candidacies"]
        arquivos = escrever_eleicoes(arquivos, eleicoes, fotos)
        print("candidaturas atualizadas:", [(c["number"], c["titular"]["nomeUrna"])
                                            for c in alvo["offices"][0]["candidacies"]])

    # ---- fase of/te ----
    arquivos = forcar_fase(arquivos, args.fase)

    # ---- cenario.json ----
    data_nome = f"{args.id}.data"
    js_nome = f"{args.id}.data.js"
    cenario = {
        "id": args.id, "scenario": "lealand", "label": args.label,
        "description": args.description, "fase": args.fase,
        "pe": args.pe, "uf": args.uf.lower(), "turno": args.turno,
        "municipio": args.municipio, "zona": args.zona, "secao": args.secao,
        "aliases": [
            {"source": "/dsk/fi/estatico", "target": "/dsk/fe/estatico"},
            {"source": "/dsk/fi/serialv.dat", "target": "/dsk/fe/serialv.dat"},
        ],
        "data": data_nome, "dataJs": js_nome,
    }
    arquivos["/cenario.json"] = json.dumps(cenario, ensure_ascii=False, indent=2).encode("utf-8")

    ordem = list(ordem_tpl)
    # normaliza a ordem para a fase pedida (t<->o) e garante /cenario.json primeiro
    ren = renomear_of if args.fase == "of" else renomear_te
    ordem = [ren(f) if f.endswith(".dat") else f for f in ordem]
    if "/cenario.json" in ordem:
        ordem.remove("/cenario.json")
    ordem.insert(0, "/cenario.json")
    for f in arquivos:
        if f not in ordem:
            ordem.append(f)

    # ---- guarda da sentinela (igual ao urna.js montarMidiaOficial) ----
    # PE/UF/fase do cenario precisam corresponder a arquivos reais do pack;
    # o conteudo interno dos .dat (escopos PE/UF) nao e reescrito por este
    # gerador, entao mudar PE/UF aqui sem trocar o molde quebra o boot.
    if not re.fullmatch(r"[A-Za-z]{2}", args.uf or ""):
        raise ValueError(f"UF invalida ({args.uf!r}; use 2 letras, ex. ac).")
    if args.turno not in (1, 2):
        raise ValueError(f"turno invalido ({args.turno!r}; use 1 ou 2).")
    for chave in ("pe", "municipio", "zona", "secao"):
        if getattr(args, chave) < 1:
            raise ValueError(f"{chave} invalido ({getattr(args, chave)!r}; use >= 1).")
    fase_letra = "o" if args.fase == "of" else "t"
    sentinela = f"/dsk/fi/estatico/{fase_letra}{args.pe:05d}{args.uf.lower()}-pu.dat"
    if sentinela not in arquivos:
        disponiveis = sorted(p for p in arquivos if p.endswith("-pu.dat"))
        raise ValueError(
            f"PE/UF/fase sem arquivos no pack (sentinela ausente: {sentinela}). "
            f"O molde so contem: {disponiveis}. "
            f"Mantenha PE/UF do molde ou troque o molde.")

    # ---- pids externos (o*.pid) ----
    bases = [b.strip() for b in args.pids.split(",") if b.strip()]
    # ajusta o prefixo das bases a fase (o molde oficial nao tem t*.pid p/ ce/ca;
    # ele tem t*.pid internos mesmo no pack oficial — mantem como esta)
    pids_ext = gerar_pids_externos(arquivos, bases, args.timestamp)
    for nome, blob in pids_ext.items():
        print(f"pid externo: {nome} {pid_info(blob)}")

    if args.dry_run:
        print("dry-run: nada gravado.")
        return 0

    out_dir.mkdir(parents=True, exist_ok=True)
    meta_nova = reempacotar(arquivos, ordem, out_dir / data_nome, out_dir / js_nome, head)
    for nome, blob in pids_ext.items():
        (out_dir / nome).write_bytes(blob)
    manifest = {"version": 1, "generatedAt": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
                "scenarios": [cenario]}
    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2),
                                           encoding="utf-8")
    print(f"OK: {data_nome} ({meta_nova['remote_package_size']} bytes, "
          f"{len(meta_nova['files'])} arquivos) + {len(pids_ext)} .pid + manifest.json em {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
