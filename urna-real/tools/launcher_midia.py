#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Launcher com interface para alterar e gerar a midia de votacao.

Abre uma janela (tkinter, sem dependencias externas) sobre o
``tools/gerar_midia.py``: carrega o molde (.data), edita eleicao,
partidos e candidaturas, e gera ``.data`` + ``.data.js`` + ``o*.pid``.

Uso:
    python tools/launcher_midia.py
"""

from __future__ import annotations

import json
import re
import tempfile
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

import gerar_midia as G

AQUI = Path(__file__).resolve().parent
RAIZ = AQUI.parent
BASES = RAIZ / "wasm" / "bases"


# ------------------------------------------------------------- dialogs
class FormDialog(tk.Toplevel):
    def __init__(self, master, titulo, campos, inicial=None):
        """campos: [(chave, rotulo, largura)]. Retorna dict ou None."""
        super().__init__(master)
        self.title(titulo)
        self.result = None
        self.vars = {}
        inicial = inicial or {}
        for i, (ch, rot, larg) in enumerate(campos):
            ttk.Label(self, text=rot).grid(row=i, column=0, sticky="e", padx=6, pady=3)
            v = tk.StringVar(value=str(inicial.get(ch, "")))
            ent = ttk.Entry(self, textvariable=v, width=larg)
            ent.grid(row=i, column=1, sticky="w", padx=6, pady=3)
            self.vars[ch] = v
        bar = ttk.Frame(self)
        bar.grid(row=len(campos), column=0, columnspan=2, pady=8)
        ttk.Button(bar, text="OK", command=self._ok).pack(side="left", padx=6)
        ttk.Button(bar, text="Cancelar", command=self.destroy).pack(side="left", padx=6)
        self.transient(master)
        self.grab_set()
        self.wait_window(self)

    def _ok(self):
        self.result = {k: v.get().strip() for k, v in self.vars.items()}
        self.destroy()


CAMPOS_PARTIDO = [("number", "Numero (10-99)", 8),
                  ("sigla", "Sigla", 12),
                  ("nome", "Nome", 40)]

CAMPOS_PESSOA = [("code", "Codigo", 8),
                 ("nome", "Nome completo", 40),
                 ("nomeUrna", "Nome na urna", 24),
                 ("nascimento", "Nasc. AAAAMMDD", 12),
                 ("genero", "Genero 2=M 4=F", 6)]


# ---------------------------------------------------------------- app
class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Midia de votacao — launcher")
        self.geometry("920x720")
        self.arquivos = None
        self.head = ""
        self.meta = None
        self._cand_data = {}
        self._fotos: dict[str, bytes] = {}  # codigo -> JPEG de reposicao
        self._build()

    # -- construcao -------------------------------------------------
    def _build(self):
        nb = ttk.Notebook(self)
        nb.pack(fill="both", expand=True, padx=8, pady=8)
        self.tab_ele = ttk.Frame(nb)
        self.tab_par = ttk.Frame(nb)
        self.tab_cand = ttk.Frame(nb)
        nb.add(self.tab_ele, text="Eleicao / arquivos")
        nb.add(self.tab_par, text="Partidos")
        nb.add(self.tab_cand, text="Candidaturas")

        self.e = {}
        def campo(parent, chave, rot, padrao="", larg=40, row=None):
            r = row if row is not None else len(self.e)
            ttk.Label(parent, text=rot).grid(row=r, column=0, sticky="e", padx=6, pady=2)
            v = tk.StringVar(value=str(padrao))
            ttk.Entry(parent, textvariable=v, width=larg).grid(row=r, column=1, sticky="w", padx=6, pady=2)
            self.e[chave] = v
            return r + 1

        f = self.tab_ele
        r = 0
        r = campo(f, "template_data", "Molde .data", str(BASES / "lealand-oficial.data"), 60, r)
        r = campo(f, "template_js", "Molde .data.js", str(BASES / "lealand-oficial.data.js"), 60, r)
        r = campo(f, "out_dir", "Destino", str(BASES), 60, r)
        ttk.Button(f, text="…", width=3, command=lambda: self._browse_dir()).grid(row=2, column=2)
        r = campo(f, "id", "ID cenario", "lealand-oficial", 30, r)
        r = campo(f, "label", "Rotulo", "Eleição de Lealand — Gerente (oficial)", 60, r)
        r = campo(f, "description", "Descricao", "Mídia oficial de Lealand: fase oficial do motor (sem TREINAMENTO).", 60, r)
        ttk.Label(f, text="Fase").grid(row=r, column=0, sticky="e", padx=6, pady=2)
        self.e["fase"] = tk.StringVar(value="of")
        ttk.Combobox(f, textvariable=self.e["fase"], values=["of", "te"], width=6, state="readonly").grid(row=r, column=1, sticky="w", padx=6, pady=2)
        r += 1
        linha = ttk.Frame(f)
        linha.grid(row=r, column=0, columnspan=3, sticky="w", padx=6, pady=2)
        for chave, rot, pad in [("pe", "PE", "2400"), ("uf", "UF", "ac"), ("turno", "Turno", "2"),
                                ("municipio", "Mun", "1"), ("zona", "Zona", "1"), ("secao", "Secao", "1")]:
            ttk.Label(linha, text=rot).pack(side="left", padx=(8, 2))
            v = tk.StringVar(value=pad)
            ttk.Entry(linha, textvariable=v, width=7).pack(side="left")
            self.e[chave] = v
        r += 1
        r = campo(f, "timestamp", "Timestamp AAAAMMDDHHMM", "202609101622", 20, r)
        r = campo(f, "pids", "PIDs internos", "t02421ac-ce,t02421ac00001-ca", 60, r)
        self.sync_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(f, text="Sincronizar CANDIDATES no servidor (exige reiniciar o node)",
                        variable=self.sync_var).grid(row=r, column=0, columnspan=3,
                                                     sticky="w", padx=6, pady=2)
        r += 1

        bar = ttk.Frame(f)
        bar.grid(row=r, column=0, columnspan=3, pady=10)
        ttk.Button(bar, text="Carregar molde", command=self.carregar).pack(side="left", padx=4)
        ttk.Button(bar, text="Validar", command=self.validar).pack(side="left", padx=4)
        ttk.Button(bar, text="Gerar midia", command=self.gerar).pack(side="left", padx=4)
        ttk.Button(bar, text="Exportar candidatos JSON", command=self.exportar_json).pack(side="left", padx=4)
        ttk.Button(bar, text="Importar candidatos JSON", command=self.importar_json).pack(side="left", padx=4)

        # partidos
        self.tree_par = ttk.Treeview(self.tab_par, columns=("numero", "sigla", "nome"), show="headings", height=15)
        for c, t, w in [("numero", "Numero", 80), ("sigla", "Sigla", 120), ("nome", "Nome", 480)]:
            self.tree_par.heading(c, text=t)
            self.tree_par.column(c, width=w)
        self.tree_par.pack(fill="both", expand=True, padx=8, pady=8)
        bp = ttk.Frame(self.tab_par)
        bp.pack(pady=4)
        ttk.Button(bp, text="Adicionar", command=self.par_add).pack(side="left", padx=4)
        ttk.Button(bp, text="Editar", command=self.par_edit).pack(side="left", padx=4)
        ttk.Button(bp, text="Remover", command=self.par_del).pack(side="left", padx=4)

        # candidaturas
        self.tree_cand = ttk.Treeview(self.tab_cand, columns=("numero", "partido", "urna", "nome", "vice", "foto"),
                                      show="headings", height=15)
        for c, t, w in [("numero", "Numero", 70), ("partido", "Part.", 60), ("urna", "Urna", 140),
                        ("nome", "Titular", 230), ("vice", "Vice", 190), ("foto", "Foto*", 60)]:
            self.tree_cand.heading(c, text=t)
            self.tree_cand.column(c, width=w)
        self.tree_cand.pack(fill="both", expand=True, padx=8, pady=8)
        ttk.Label(self.tab_cand, text="Foto* = ● quando há JPEG de reposição para titular/vice.").pack()
        bc = ttk.Frame(self.tab_cand)
        bc.pack(pady=4)
        ttk.Button(bc, text="Adicionar", command=self.cand_add).pack(side="left", padx=4)
        ttk.Button(bc, text="Editar", command=self.cand_edit).pack(side="left", padx=4)
        ttk.Button(bc, text="Remover", command=self.cand_del).pack(side="left", padx=4)
        ttk.Button(bc, text="Foto titular…", command=lambda: self.trocar_foto("titular")).pack(side="left", padx=4)
        ttk.Button(bc, text="Foto vice…", command=lambda: self.trocar_foto("vice")).pack(side="left", padx=4)
        ttk.Button(bc, text="Extrair fotos…", command=self.extrair_fotos_ui).pack(side="left", padx=4)
        ttk.Button(bc, text="Limpar fotos", command=self.limpar_fotos).pack(side="left", padx=4)

        self.log = tk.Text(self, height=8)
        self.log.pack(fill="x", padx=8, pady=(0, 8))

    # -- util -------------------------------------------------------
    def _browse_dir(self):
        d = filedialog.askdirectory(initialdir=self.e["out_dir"].get())
        if d:
            self.e["out_dir"].set(d)

    def msg(self, txt):
        self.log.insert("end", txt + "\n")
        self.log.see("end")

    def _partidos(self):
        out = []
        for iid in self.tree_par.get_children():
            num, sig, nom = self.tree_par.item(iid, "values")
            out.append({"number": int(num), "sigla": sig, "nome": nom})
        return out

    def _candidaturas(self):
        return [self._cand_data[iid] for iid in self.tree_cand.get_children()
                if iid in self._cand_data]

    def _marca_foto(self, c: dict) -> str:
        codigos = {c["titular"]["code"]} | {s["code"] for s in c.get("suplentes") or []}
        return "●" if codigos & set(self._fotos) else ""

    def _linha_cand(self, c: dict) -> tuple:
        vice = (c.get("suplentes") or [{}])[0]
        return (c["number"], c["party"], c["titular"]["nomeUrna"],
                c["titular"]["nome"], vice.get("nomeUrna", ""), self._marca_foto(c))

    def _atualizar_marca_foto(self, iid):
        if iid in self._cand_data:
            c = self._cand_data[iid]
            vals = list(self.tree_cand.item(iid, "values"))
            while len(vals) < 6:
                vals.append("")
            vals[5] = self._marca_foto(c)
            self.tree_cand.item(iid, values=tuple(vals))

    # -- molde ------------------------------------------------------
    def carregar(self):
        try:
            meta, arq, head = G.carregar_pacote(Path(self.e["template_data"].get()),
                                                Path(self.e["template_js"].get()))
        except Exception as ex:
            messagebox.showerror("Molde", str(ex))
            return
        self.meta, self.arquivos, self.head = meta, arq, head
        els = G.ler_eleicoes(arq)
        alvo = next((x for x in els if x["path"].endswith("00001-ca.dat")), els[0])
        self.tree_par.delete(*self.tree_par.get_children())
        for p in sorted(alvo["parties"], key=lambda x: x["number"]):
            self.tree_par.insert("", "end", values=(p["number"], p["sigla"], p["nome"]))
        self.tree_cand.delete(*self.tree_cand.get_children())
        self._cand_data = {}
        self._fotos = {}
        for c in sorted(alvo["offices"][0]["candidacies"], key=lambda x: x["number"]):
            iid = self.tree_cand.insert("", "end", values=self._linha_cand(c))
            self._cand_data[iid] = c
        self.msg(f"molde: {len(meta['files'])} arquivos; eleicao {alvo['path']} "
                 f"com {len(alvo['parties'])} partidos e {len(alvo['offices'][0]['candidacies'])} candidaturas.")

    # -- partidos ---------------------------------------------------
    def par_add(self):
        d = FormDialog(self, "Partido", CAMPOS_PARTIDO)
        if d.result:
            try:
                num = int(d.result["number"])
            except ValueError:
                messagebox.showerror("Partido", "Numero invalido.")
                return
            self.tree_par.insert("", "end", values=(num, d.result["sigla"], d.result["nome"]))

    def par_edit(self):
        sel = self.tree_par.selection()
        if not sel:
            return
        vals = self.tree_par.item(sel[0], "values")
        d = FormDialog(self, "Partido", CAMPOS_PARTIDO,
                       {"number": vals[0], "sigla": vals[1], "nome": vals[2]})
        if d.result:
            self.tree_par.item(sel[0], values=(int(d.result["number"]), d.result["sigla"], d.result["nome"]))

    def par_del(self):
        for iid in self.tree_par.selection():
            self.tree_par.delete(iid)

    # -- candidaturas -----------------------------------------------
    def _dialog_candidatura(self, titulo, inicial=None):
        ini = inicial or {}
        tit0 = ini.get("titular", {})
        vic0 = (ini.get("suplentes") or [{}])[0] if ini.get("suplentes") else {}
        d1 = FormDialog(self, titulo + " — titular",
                        [("party", "Partido (nº ou sigla)", 12), ("number", "Numero", 8)] + CAMPOS_PESSOA,
                        {"party": ini.get("party", ""), "number": ini.get("number", ""), **tit0})
        if not d1.result:
            return None
        d2 = FormDialog(self, titulo + " — vice",
                        [("code", "Codigo vice", 8)] + CAMPOS_PESSOA[1:],
                        {"code": vic0.get("code", ""), **{k: vic0.get(k, "") for k, _, _ in CAMPOS_PESSOA[1:]}})
        if not d2.result:
            return None
        try:
            titular = {"code": d1.result["code"], "nome": d1.result["nome"],
                       "nomeUrna": d1.result["nomeUrna"], "fonetico": "",
                       "nascimento": d1.result["nascimento"], "genero": int(d1.result["genero"]),
                       "situacao": 12, "ordem": None, "extra": {"int": "00", "flag": "00"}}
            vice = {"code": d2.result["code"], "nome": d2.result["nome"],
                    "nomeUrna": d2.result["nomeUrna"], "fonetico": "",
                    "nascimento": d2.result["nascimento"], "genero": int(d2.result["genero"]),
                    "situacao": 12, "ordem": 1, "extra": {"int": "00", "flag": "00"}}
            party = self._resolve_party(d1.result["party"])
            number = int(d1.result["number"])
        except ValueError:
            messagebox.showerror(titulo, "Partido deve ser o numero (ex. 91) ou a sigla cadastrada; "
                                        "Numero e Genero devem ser inteiros (genero 2 ou 4).")
            return None
        return {"party": party, "number": number,
                "titular": titular, "label": "", "suplentes": [vice],
                "groupTail": ini.get("groupTail", "3000")}

    def _resolve_party(self, raw: str) -> int:
        raw = (raw or "").strip()
        if re.fullmatch(r"\d{1,2}", raw):
            return int(raw)
        for p in self._partidos():
            if p["sigla"].strip().upper() == raw.upper():
                return p["number"]
        raise ValueError(f"partido desconhecido: {raw!r}")

    def cand_add(self):
        c = self._dialog_candidatura("Nova candidatura")
        if c:
            iid = self.tree_cand.insert("", "end", values=self._linha_cand(c))
            self._cand_data[iid] = c

    def cand_edit(self):
        sel = self.tree_cand.selection()
        if not sel:
            return
        c = self._dialog_candidatura("Editar candidatura", self._cand_data[sel[0]])
        if c:
            self._cand_data[sel[0]] = c
            self.tree_cand.item(sel[0], values=self._linha_cand(c))

    def cand_del(self):
        for iid in self.tree_cand.selection():
            self.tree_cand.delete(iid)
            self._cand_data.pop(iid, None)

    # -- json --------------------------------------------------------
    def exportar_json(self):
        p = filedialog.asksaveasfilename(defaultextension=".json", filetypes=[("JSON", "*.json")])
        if p:
            Path(p).write_text(json.dumps({"parties": self._partidos(),
                                           "candidacies": self._candidaturas()},
                                          ensure_ascii=False, indent=2), encoding="utf-8")
            self.msg(f"candidatos exportados: {p}")

    def importar_json(self):
        p = filedialog.askopenfilename(filetypes=[("JSON", "*.json")])
        if not p:
            return
        cfg = json.loads(Path(p).read_text(encoding="utf-8"))
        self.tree_par.delete(*self.tree_par.get_children())
        for x in cfg.get("parties", []):
            self.tree_par.insert("", "end", values=(x["number"], x["sigla"], x["nome"]))
        self.tree_cand.delete(*self.tree_cand.get_children())
        self._cand_data = {}
        self._fotos = {}
        for c in cfg.get("candidacies", []):
            iid = self.tree_cand.insert("", "end", values=self._linha_cand(c))
            self._cand_data[iid] = c
        self.msg(f"candidatos importados: {p}")

    # -- fotos -------------------------------------------------------
    def trocar_foto(self, papel: str):
        sel = self.tree_cand.selection()
        if not sel:
            messagebox.showinfo("Foto", "Selecione uma candidatura primeiro.")
            return
        c = self._cand_data[sel[0]]
        pessoa = c["titular"] if papel == "titular" else (c.get("suplentes") or [{}])[0]
        code = pessoa.get("code", "?")
        p = filedialog.askopenfilename(title=f"JPEG do {papel} (codigo {code})",
                                       filetypes=[("JPEG", "*.jpg *.jpeg"), ("Todos", "*.*")])
        if not p:
            return
        blob = Path(p).read_bytes()
        if blob[:2] != b"\xff\xd8":
            messagebox.showerror("Foto", "O arquivo nao e JPEG (magic FFD8 ausente).")
            return
        if len(blob) > 512 * 1024:
            messagebox.showerror("Foto", f"JPEG grande demais ({len(blob)} bytes, max 512 KiB).")
            return
        alvo = G.FOTO_TITULAR if papel == "titular" else G.FOTO_SUPLENTE
        tam = G.jpeg_tamanho(blob)
        self._fotos[str(code)] = blob
        self._atualizar_marca_foto(sel[0])
        if tam == tuple(alvo):
            self.msg(f"foto {papel} codigo {code}: {tam[0]}x{tam[1]}, {len(blob)} bytes "
                     f"de {Path(p).name} (ja no tamanho oficial).")
        else:
            self.msg(f"foto {papel} codigo {code}: {tam[0]}x{tam[1]} -> "
                     f"{alvo[0]}x{alvo[1]} ao gerar (cover, sem distorcer).")

    def limpar_fotos(self):
        self._fotos = {}
        for iid in self.tree_cand.get_children():
            self._atualizar_marca_foto(iid)
        self.msg("fotos de reposicao descartadas.")

    def extrair_fotos_ui(self):
        if self.arquivos is None:
            try:
                self.arquivos = G.carregar_pacote(Path(self.e["template_data"].get()),
                                                  Path(self.e["template_js"].get()))[1]
            except Exception as ex:
                messagebox.showerror("Fotos", str(ex))
                return
        d = filedialog.askdirectory(title="Diretorio para extrair <codigo>.jpg")
        if not d:
            return
        gravados = G.extrair_fotos(self.arquivos, Path(d))
        self.msg(f"{len(gravados)} fotos extraidas em {d}.")
        messagebox.showinfo("Fotos", f"{len(gravados)} fotos extraidas em {d}.")

    # -- validar / gerar --------------------------------------------
    def _cfg_temp(self):
        fd, p = tempfile.mkstemp(suffix=".json")
        with open(fd, "w", encoding="utf-8") as f:
            json.dump({"parties": self._partidos(), "candidacies": self._candidaturas()},
                      f, ensure_ascii=False)
        return p

    def validar(self):
        els = [{"path": "x-ca.dat", "parties": self._partidos(),
                "offices": [{"code": 11, "nome": "Gerente", "digitos": 2, "extra": "01",
                             "candidacies": self._candidaturas()}]}]
        probs = G.validar_eleicoes(els)
        if probs:
            messagebox.showwarning("Validacao", "\n".join(probs[:20]))
            self.msg("validacao: " + "; ".join(probs[:10]))
        else:
            messagebox.showinfo("Validacao", "OK: partidos e candidaturas consistentes.")
            self.msg("validacao OK.")

    def gerar(self):
        tem_dados = bool(self.tree_par.get_children() and self.tree_cand.get_children())
        if not tem_dados and not self._fotos:
            if not messagebox.askyesno("Gerar", "Sem partidos/candidaturas na interface. Regerar molde puro?"):
                return
            cfg_path = None
        else:
            cfg_path = self._cfg_temp() if tem_dados else None
        # Avisa quando PE/UF/turno/fase divergem do molde: o conteudo interno
        # dos .dat nao e reescrito, entao o boot (sentinela *-pu.dat) quebra.
        try:
            raw_cen = bytes((self.arquivos or {}).get("/cenario.json", b"{}"))
            molde_cen = json.loads(raw_cen.decode("utf-8"))
        except Exception:
            molde_cen = {}
        diverg = [k for k in ("pe", "uf", "turno", "fase")
                  if str(molde_cen.get(k, "")) != str(self.e[k].get().strip().lower()
                                                     if k == "uf" else self.e[k].get().strip())]
        if molde_cen and diverg:
            if not messagebox.askyesno(
                    "Gerar",
                    "PE/UF/turno/fase diferentes do molde (" + ", ".join(diverg) + ").\n"
                    "O gerador nao reescreve o conteudo interno dos .dat,\n"
                    "entao a urna pode nao montar a midia. Continuar mesmo assim?"):
                if cfg_path:
                    Path(cfg_path).unlink(missing_ok=True)
                return
        tmpdir = None
        mapa_fotos = None
        if self._fotos:
            tmpdir = Path(tempfile.mkdtemp(prefix="midia-fotos-"))
            mapa = {}
            for code, blob in self._fotos.items():
                dest = tmpdir / f"{code}.jpg"
                dest.write_bytes(blob)
                mapa[str(code)] = str(dest)
            mapa_fotos = tmpdir / "fotos.json"
            mapa_fotos.write_text(json.dumps(mapa, ensure_ascii=False), encoding="utf-8")
        argv = ["--template-data", self.e["template_data"].get(),
                "--template-js", self.e["template_js"].get(),
                "--out-dir", self.e["out_dir"].get(),
                "--id", self.e["id"].get(),
                "--label", self.e["label"].get(),
                "--description", self.e["description"].get(),
                "--fase", self.e["fase"].get(),
                "--pe", self.e["pe"].get(), "--uf", self.e["uf"].get(),
                "--turno", self.e["turno"].get(), "--municipio", self.e["municipio"].get(),
                "--zona", self.e["zona"].get(), "--secao", self.e["secao"].get(),
                "--pids", self.e["pids"].get()]
        ts = self.e["timestamp"].get().strip()
        if ts:
            argv += ["--timestamp", ts]
        if cfg_path:
            argv += ["--candidatos", cfg_path]
        if mapa_fotos:
            argv += ["--fotos", str(mapa_fotos)]
        sincronizar = bool(self.sync_var.get() and cfg_path)
        if not sincronizar:
            argv += ["--no-sync-config"]
        try:
            self.msg("$ gerar_midia.py " + " ".join(argv))
            rc = G.main(argv)
        except SystemExit as ex:
            rc = ex.code
        except Exception as ex:  # noqa: BLE001
            messagebox.showerror("Gerar", str(ex))
            self.msg("ERRO: " + str(ex))
            return
        finally:
            if cfg_path:
                Path(cfg_path).unlink(missing_ok=True)
        self.msg(f"concluido (rc={rc}).")
        if rc == 0:
            if sincronizar:
                messagebox.showinfo("Gerar", "Midia gerada e CANDIDATES sincronizado.\n"
                                             "Reinicie o servidor (node server/server.mjs) para valer.")
            else:
                messagebox.showinfo("Gerar", "Midia gerada com sucesso.")


if __name__ == "__main__":
    App().mainloop()
