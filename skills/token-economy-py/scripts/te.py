#!/usr/bin/env python3
"""te.py — token-economy для Python-проектов (агент Hermes и любой агент с терминалом).

Только стандартная библиотека, Python 3.9+. Вывод — компактный текст, не JSON.

    te.py graph symbol NAME [NAME…] | deps FILE | rdeps FILE | path A B | node FILE | cycles | stats | build
    te.py graph hotspots [--top N] [--file FILE] [--since 90d|YYYY-MM-DD] [--max-commits N]
    te.py outline FILE [--docs]
    te.py search QUERY [--ext .py,.yaml] [--re] [-i] [-l] [--path DIR] [--limit N]
    te.py sig dotted.name [--doc]
    te.py info
    te.py selftest

Общие параметры --root DIR и --src DIR (повторяемый) можно указывать до или после команды.
Граф хранится в .token-economy/ (внутри лежит .gitignore со «*», в git ничего не попадает).
Внутренние ошибки печатаются одной строкой; TE_DEBUG=1 показывает полный traceback.
"""
import argparse
import ast
import json
import math
import os
import re
import stat
import subprocess
import sys
from collections import deque
from datetime import datetime, timezone
from importlib.machinery import EXTENSION_SUFFIXES, PathFinder
from pathlib import Path

try:
    import tomllib  # Python 3.11+
except ImportError:  # 3.9–3.10: pyproject.toml разбирается упрощённо (см. _pyproject_deps)
    tomllib = None

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

VERSION = 2  # формат кэша и графа; при смене парсера/формата увеличить
MAX_BYTES = 1_000_000  # файлы крупнее в граф и поиск не берём
CACHE_DIR = ".token-economy"
EXCLUDE_DIRS = {
    ".git", ".hg", ".svn", "__pycache__", ".venv", "venv", ".env", ".tox", ".nox", "node_modules",
    "build", "dist", ".mypy_cache", ".pytest_cache", ".ruff_cache", "site-packages", ".eggs", CACHE_DIR,
}
# «env» исключается только при наличии pyvenv.cfg — чтобы не съесть настоящий пакет с именем env
COMPILED_EXTS = tuple(EXTENSION_SUFFIXES)  # .so, .pyd, .cpython-*.so …
KIND_RANK = {"r": 0, "l": 1, "t": 2}  # runtime > lazy (внутри функции) > только для типов

if hasattr(sys, "stdlib_module_names"):
    STDLIB = sys.stdlib_module_names
else:  # Python 3.9: sys.stdlib_module_names появился только в 3.10
    import sysconfig

    _libdir = sysconfig.get_path("stdlib") or ""
    _names = set(sys.builtin_module_names) | {"__future__"}
    try:
        for _f in os.listdir(_libdir):
            if _f.endswith(".py"):
                _names.add(_f[:-3])
            elif os.path.isdir(os.path.join(_libdir, _f)) and _f not in ("site-packages", "config"):
                _names.add(_f)
    except OSError:
        pass
    STDLIB = frozenset(_names)


def fail(msg):
    print("Ошибка: " + msg)
    sys.exit(1)


def posix(p):
    return str(p).replace("\\", "/")


def join(a, b):
    return b if not a else a + "/" + b


# ---------- файлы проекта ----------

def project_root(value):
    try:
        root = Path(value).resolve()
        if root.is_dir():
            return str(root)
    except (OSError, RuntimeError, ValueError):
        pass
    fail("корень проекта не существует или не является каталогом: " + str(value))


def project_path(root, value):
    """Реальный путь внутри root; разрешаем ссылки до обработки следующего сегмента, включая '..'."""
    base, path = Path(root).resolve(), Path(value)
    if path.drive and not path.is_absolute():
        raise ValueError("путь вне рабочей директории: " + str(value))
    current = Path(path.anchor) if path.is_absolute() else base
    parts = path.parts[1:] if path.is_absolute() else path.parts
    entered = current == base
    for part in parts:
        current = (current / part).resolve()
        inside = current == base or base in current.parents
        if entered and not inside:
            raise ValueError("путь вне рабочей директории: " + str(value))
        entered = entered or inside
    if current != base and base not in current.parents:
        raise ValueError("путь вне рабочей директории: " + str(value))
    return current


def safe_path(root, value):
    try:
        return project_path(root, value)
    except (OSError, RuntimeError, ValueError) as e:
        fail(str(e))


def _excluded(parts):
    return any(p in EXCLUDE_DIRS or p.endswith(".egg-info") for p in parts)


def _pyvenv_dirs(root, rels):
    """Родительские каталоги перечисленных файлов, в которых лежит pyvenv.cfg."""
    bad, checked = set(), set()
    for n in rels:
        parts = n.split("/")
        for i in range(1, len(parts)):
            d = "/".join(parts[:i])
            if d not in checked:
                checked.add(d)
                try:
                    if project_path(root, join(d, "pyvenv.cfg")).is_file():
                        bad.add(d)
                except (OSError, RuntimeError, ValueError):
                    bad.add(d)
    return bad


def project_files(root, exts=(".py",), aliases=None):
    """Канонические файлы проекта; aliases получает безопасные lexical→canonical пути."""
    root = project_root(root)
    base = Path(root)
    exts_l = tuple(e.lower() for e in exts) if exts else None
    rel = None
    try:
        r = subprocess.run(["git", "-C", root, "ls-files", "-co", "--exclude-standard", "-z"],
                           capture_output=True, timeout=30)
        if r.returncode == 0:
            rel = [n for n in r.stdout.decode("utf-8", "replace").split("\0") if n]
    except Exception:
        rel = None
    if rel is None:
        rel, ancestors = [], {}
        for dp, dns, fns in os.walk(root, followlinks=True):
            try:
                directory = project_path(root, dp)
            except (OSError, RuntimeError, ValueError):
                dns[:] = []
                continue
            parents = ancestors.pop(dp, set())
            if directory in parents:
                dns[:] = []
                continue
            parents = parents | {directory}
            keep = []
            for d in dns:
                try:
                    child = project_path(root, Path(dp, d))
                    parts = child.relative_to(base).parts
                    if (d not in EXCLUDE_DIRS and not d.endswith(".egg-info") and not _excluded(parts)
                            and child not in parents and not (child / "pyvenv.cfg").exists()):
                        keep.append(d)
                        ancestors[os.path.join(dp, d)] = parents
                except (OSError, RuntimeError, ValueError):
                    continue
            dns[:] = keep
            rel.extend(posix(os.path.relpath(os.path.join(dp, fn), root)) for fn in fns)
    out, paths, directory_aliases = [], {}, []
    for n in rel:
        n = posix(n).rstrip("/")
        if _excluded(n.split("/")[:-1]):
            continue
        try:
            p = project_path(root, n)
            canonical = posix(p.relative_to(base))
            if p.is_dir():
                if n != canonical and not _excluded(n.split("/")) and not _excluded(canonical.split("/")):
                    directory_aliases.append((n, canonical))
                continue
            if exts_l and not n.lower().endswith(exts_l):
                continue
            if _excluded(canonical.split("/")[:-1]):
                continue
            st = p.stat()
        except (OSError, RuntimeError, ValueError):
            continue
        if stat.S_ISREG(st.st_mode) and st.st_size <= MAX_BYTES:
            out.append(canonical)
            paths[n] = canonical
    for alias, target in directory_aliases:
        for canonical in set(paths.values()):
            if canonical.startswith(target + "/"):
                paths[alias + canonical[len(target):]] = canonical
    venv = _pyvenv_dirs(root, list(paths) + out)
    if venv:
        paths = {n: p for n, p in paths.items()
                 if not any(n.startswith(d + "/") or p.startswith(d + "/") for d in venv)}
    if aliases is not None:
        aliases.update(paths)
    return sorted(set(paths.values()))


def is_test_path(rel):
    name = rel.rsplit("/", 1)[-1]
    return (name.startswith("test_") or name.endswith("_test.py") or name == "conftest.py"
            or "/tests/" in "/" + rel or rel.startswith("test/"))


# ---------- разбор модуля ----------

def _is_type_checking(test):
    return (isinstance(test, ast.Name) and test.id == "TYPE_CHECKING") or \
           (isinstance(test, ast.Attribute) and test.attr == "TYPE_CHECKING")


class _Scan(ast.NodeVisitor):
    """Собирает импорты с видом: r — при загрузке модуля, l — внутри функции, t — под TYPE_CHECKING."""

    def __init__(self):
        self.imports = []
        self.func = 0
        self.typing = False

    def _kind(self):
        return "l" if self.func else ("t" if self.typing else "r")

    def visit_FunctionDef(self, n):
        self.func += 1
        self.generic_visit(n)
        self.func -= 1

    visit_AsyncFunctionDef = visit_FunctionDef
    visit_Lambda = visit_FunctionDef

    def visit_If(self, n):
        if _is_type_checking(n.test):
            prev, self.typing = self.typing, True
            for s in n.body:
                self.visit(s)
            self.typing = prev
            for s in n.orelse:
                self.visit(s)
        else:
            self.generic_visit(n)

    def visit_Import(self, n):
        for a in n.names:
            self.imports.append({"k": self._kind(), "lv": 0, "m": a.name, "n": None, "ln": n.lineno})

    def visit_ImportFrom(self, n):
        self.imports.append({"k": self._kind(), "lv": n.level, "m": n.module or "",
                             "n": [a.name for a in n.names], "ln": n.lineno})

    def visit_Call(self, n):
        f = n.func
        if isinstance(f, ast.Name):
            ok = f.id in ("__import__", "import_module")
        elif isinstance(f, ast.Attribute) and f.attr == "import_module":
            ok = "importlib" in ast.unparse(f.value)  # не ловим foo.import_module(...)
        else:
            ok = False
        if ok and n.args and isinstance(n.args[0], ast.Constant) \
                and isinstance(n.args[0].value, str) and not n.args[0].value.startswith("."):
            self.imports.append({"k": "l", "lv": 0, "m": n.args[0].value, "n": None, "ln": n.lineno})
        self.generic_visit(n)


_MATCH = getattr(ast, "Match", None)      # Python 3.10+
_TRYSTAR = getattr(ast, "TryStar", None)  # Python 3.11+


def _flat(body):
    """Операторы верхнего уровня, включая тела if/try/with/for/while (но не функций и классов)."""
    for st in body:
        yield st
        if isinstance(st, ast.If):
            yield from _flat(st.body)
            yield from _flat(st.orelse)
        elif isinstance(st, ast.Try):
            yield from _flat(st.body)
            for h in st.handlers:
                yield from _flat(h.body)
            yield from _flat(st.orelse)
            yield from _flat(st.finalbody)
        elif _TRYSTAR is not None and isinstance(st, _TRYSTAR):
            yield from _flat(st.body)
            for h in st.handlers:
                yield from _flat(h.body)
            yield from _flat(st.orelse)
            yield from _flat(st.finalbody)
        elif isinstance(st, (ast.With, ast.AsyncWith)):
            yield from _flat(st.body)
        elif isinstance(st, (ast.For, ast.AsyncFor, ast.While)):
            yield from _flat(st.body)
            yield from _flat(st.orelse)
        elif _MATCH is not None and isinstance(st, _MATCH):
            for case in st.cases:
                yield from _flat(case.body)


def _start(node):
    decos = getattr(node, "decorator_list", None)
    return min([d.lineno for d in decos] + [node.lineno]) if decos else node.lineno


def collect_entities(tree):
    """Определения: [имя, вид, строка_начала, строка_конца]. Методы — «Класс.метод»."""
    ents = []

    def walk(body, prefix, in_class):
        for st in _flat(body):
            if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef)):
                kind = ("async " if isinstance(st, ast.AsyncFunctionDef) else "") + ("method" if in_class else "function")
                ents.append([prefix + st.name, kind, _start(st), st.end_lineno or st.lineno])
            elif isinstance(st, ast.ClassDef):
                ents.append([prefix + st.name, "class", _start(st), st.end_lineno or st.lineno])
                walk(st.body, prefix + st.name + ".", True)
            elif not in_class and isinstance(st, (ast.Assign, ast.AnnAssign)):
                targets = st.targets if isinstance(st, ast.Assign) else [st.target]
                for t in targets:
                    if isinstance(t, ast.Name) and not (t.id.startswith("__") and t.id.endswith("__")):
                        ents.append([t.id, "constant" if t.id.isupper() else "variable", st.lineno, st.end_lineno or st.lineno])

    walk(tree.body, "", False)
    return ents


def _is_main_guard(test):
    """`__name__ == "__main__"` в любом порядке операндов."""
    if not (isinstance(test, ast.Compare) and len(test.ops) == 1 and isinstance(test.ops[0], ast.Eq)):
        return False
    vals = [test.left, *test.comparators]
    return (any(isinstance(v, ast.Name) and v.id == "__name__" for v in vals)
            and any(isinstance(v, ast.Constant) and v.value == "__main__" for v in vals))


def has_main_guard(tree):
    for st in _flat(tree.body):
        if isinstance(st, ast.If) and _is_main_guard(st.test):
            return True
    return False


def parse_file(path):
    data = Path(path).read_bytes()
    loc = data.count(b"\n") + 1
    try:
        tree = ast.parse(data)
    except (SyntaxError, ValueError) as e:
        return {"imports": [], "ents": [], "main": False, "loc": loc, "err": f"{type(e).__name__}: строка {getattr(e, 'lineno', '?')}"}
    sc = _Scan()
    sc.visit(tree)
    return {"imports": sc.imports, "ents": collect_entities(tree), "main": has_main_guard(tree), "loc": loc, "err": None}


# ---------- построение графа ----------

def load_json(root, rel):
    p = safe_path(root, rel)
    try:
        with p.open("r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def save_json(root, rel, obj):
    p = safe_path(root, rel)
    gi = safe_path(root, str(Path(rel).parent / ".gitignore"))
    tmp = safe_path(root, rel + ".tmp")
    p.parent.mkdir(parents=True, exist_ok=True)
    if not gi.exists():
        gi.write_text("*\n", encoding="utf-8")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, p)


def source_roots(root, extra):
    roots = []
    for s in list(extra or []) + (["src"] if os.path.isdir(os.path.join(root, "src")) else []):
        p = safe_path(root, s)
        s = posix(p.relative_to(Path(root)))
        if s == ".":
            s = ""
        if s and s not in roots:
            roots.append(s)
    return sorted(roots, key=lambda r: -len(r)) + [""]  # от глубоких к корню проекта


def module_name(rel, sroot):
    p = rel[len(sroot) + 1:] if sroot else rel
    if not p.endswith(".py"):
        return None
    p = p[:-3]
    if p.endswith("/__init__"):
        p = p[:-9]
    elif p == "__init__":
        return None
    return p.replace("/", ".") if p else None


def build_graph(root, extra_src):
    root = project_root(root)
    roots = source_roots(root, extra_src)
    aliases = {}
    files = project_files(root, aliases=aliases)
    cache = load_json(root, join(CACHE_DIR, "cache.json")) or {}
    if cache.get("v") != VERSION:
        cache = {}
    old = cache.get("files", {})
    new = {}
    nodes = []
    for rel in files:
        try:
            p = project_path(root, rel)
            st = p.stat()
            if not stat.S_ISREG(st.st_mode) or st.st_size > MAX_BYTES:
                continue
            m, s = st.st_mtime_ns, st.st_size
            c = old.get(rel)
            data = c["d"] if c and c["m"] == m and c["s"] == s else parse_file(p)
        except (OSError, RuntimeError, ValueError):
            continue
        new[rel] = {"m": m, "s": s, "d": data}
        nodes.append({"id": len(nodes) + 1, "path": rel, "m": m, "s": s, "raw": data})

    mods = {}
    path_id = {n["path"]: n["id"] for n in nodes}
    path_id.update({p: path_id[target] for p, target in aliases.items() if target in path_id})
    for n in nodes:
        n["names"] = []
    for p, node_id in path_id.items():
        n = nodes[node_id - 1]
        for sr in roots:
            if sr and not p.startswith(sr + "/"):
                continue
            nm = module_name(p, sr)
            if nm:
                if nm not in n["names"]:
                    n["names"].append(nm)
                mods.setdefault(nm, node_id)
    tops = {nm.split(".")[0] for nm in mods}

    def find_path_mod(base):
        return path_id.get(base + ".py") or path_id.get(join(base, "__init__.py"))

    for n in nodes:
        edges, ext = {}, set()

        def add(i, k, ln):
            if not i or i == n["id"]:
                return
            cur = edges.get(i)
            if cur is None or KIND_RANK[k] < KIND_RANK[cur[0]]:
                edges[i] = (k, ln)
            elif k == cur[0] and ln < cur[1]:
                edges[i] = (k, ln)

        def longest(m):
            parts = m.split(".")
            for j in range(len(parts), 0, -1):
                nm = ".".join(parts[:j])
                if nm in mods:
                    return mods[nm]
            return None

        for imp in n["raw"]["imports"]:
            k, m, names, lv, ln = imp["k"], imp["m"], imp["n"], imp["lv"], imp["ln"]
            if lv > 0:
                base = n["path"].rsplit("/", 1)[0] if "/" in n["path"] else ""
                for _ in range(lv - 1):
                    base = base.rsplit("/", 1)[0] if "/" in base else ""
                target = join(base, m.replace(".", "/")) if m else base
                modid = path_id.get(join(base, "__init__.py")) if not m else find_path_mod(target)
                for nm in names or []:
                    sub = None if nm == "*" else find_path_mod(join(target, nm))
                    add(sub or modid, k, ln)
                continue
            if names is None:
                hit = longest(m)
                if hit:
                    add(hit, k, ln)
                elif m.split(".")[0] not in tops and m.split(".")[0] not in STDLIB:
                    ext.add(m.split(".")[0])
                continue
            base_id = longest(m)
            if base_id is None and m.split(".")[0] not in tops and m.split(".")[0] not in STDLIB:
                ext.add(m.split(".")[0])
            for nm in names:
                sub = mods.get(m + "." + nm) if nm != "*" else None
                add(sub or base_id, k, ln)

        n["imports"] = sorted([i, k, ln] for i, (k, ln) in edges.items())
        n["ext"] = sorted(ext)

    for n in nodes:
        raw = n.pop("raw")
        n["loc"], n["err"], n["ents"] = raw["loc"], raw["err"], raw["ents"]
        n["kind"] = ("test" if is_test_path(n["path"]) else "package" if n["path"].endswith("__init__.py")
                     else "script" if raw["main"] else "module")

    graph = {"v": VERSION, "src": extra_src or [], "aliases": aliases, "nodes": nodes}
    save_json(root, join(CACHE_DIR, "graph.json"), graph)
    save_json(root, join(CACHE_DIR, "cache.json"), {"v": VERSION, "files": new})
    return graph


def ensure_graph(root, extra_src):
    root = project_root(root)
    source_roots(root, extra_src)
    g = load_json(root, join(CACHE_DIR, "graph.json"))
    if g and g.get("v") == VERSION and g.get("src") == (extra_src or []):
        aliases = {}
        files = project_files(root, aliases=aliases)
        have = {n["path"]: (n["m"], n["s"]) for n in g["nodes"]}
        fresh = len(files) == len(have) and g.get("aliases") == aliases
        if fresh:
            for rel in files:
                try:
                    st = project_path(root, rel).stat()
                except (OSError, RuntimeError, ValueError):
                    fresh = False
                    break
                if have.get(rel) != (st.st_mtime_ns, st.st_size):
                    fresh = False
                    break
        if fresh:
            return g
    return build_graph(root, extra_src)


# ---------- операции над графом ----------

def graph_query(root, query):
    q = posix(query).strip()
    p = safe_path(root, q)
    if p.exists() or "/" in q or Path(q).drive or q in (".", ".."):
        return posix(p.relative_to(Path(root)))
    return q  # имя модуля/файла или фрагмент пути; неоднозначность обработает find_node


def find_node(g, q, metrics=False):
    q = posix(q).strip()
    nodes = g["nodes"]
    for pred in (
        lambda n: n["path"] == q,
        lambda n: n["path"].endswith("/" + q),
        lambda n: q in n["names"],
        lambda n: n["path"].rsplit("/", 1)[-1] in (q, q + ".py"),
        lambda n: q.lower() in n["path"].lower(),
    ):
        hits = [n for n in nodes if pred(n)]
        if len(hits) == 1:
            return hits[0]
        if len(hits) > 1:
            lst = "\n".join("  " + h["path"] for h in hits[:15])
            fail(f"«{q}» неоднозначно, уточните путь:\n{lst}")
    fail(f"файл не найден в графе: {q}" + (" (op=stats: список файлов графа)" if metrics else ""))


def bfs(g, start, depth, reverse):
    nodes = g["nodes"]
    if reverse:
        rev = {}
        for n in nodes:
            for i, k, ln in n["imports"]:
                rev.setdefault(i, []).append((n["id"], k, ln))
        kids = lambda i: rev.get(i, [])
    else:
        kids = lambda i: nodes[i - 1]["imports"]
    seen, out, frontier = {start}, [], deque([(start, 0)])
    while frontier:
        cur, d = frontier.popleft()
        if d >= depth:
            continue
        for c, k, ln in sorted(kids(cur)):
            if c not in seen:
                seen.add(c)
                out.append((d + 1, nodes[c - 1], k, ln))
                frontier.append((c, d + 1))
    return out


def fmt_edges(items, limit=60, why=False):
    lines = []
    for lvl, n, k, ln in items[:limit]:
        tag = "" if k == "r" else " (lazy)" if k == "l" else " (types)"
        kind = "" if n["kind"] == "module" else f" [{n['kind']}]"
        pos = f"  L{ln}" if why else ""
        lines.append(f"{lvl} {n['path']}{kind}{tag}{pos}")
    if len(items) > limit:
        lines.append(f"… ещё {len(items) - limit}")
    return lines


def tarjan_runtime(nodes):
    """Циклы по runtime-связям (итеративный Тарьян, без рекурсии)."""
    n = len(nodes)
    adj = [[] for _ in range(n + 1)]
    for nd in nodes:
        adj[nd["id"]] = [i for i, k, ln in nd["imports"] if k == "r"]
    idx, low, on = [-1] * (n + 1), [0] * (n + 1), [False] * (n + 1)
    stack, sccs, counter = [], [], 0
    for s in range(1, n + 1):
        if idx[s] != -1:
            continue
        work = [(s, 0)]
        idx[s] = low[s] = counter
        counter += 1
        stack.append(s)
        on[s] = True
        while work:
            v, pi = work[-1]
            if pi < len(adj[v]):
                work[-1] = (v, pi + 1)
                w = adj[v][pi]
                if idx[w] == -1:
                    idx[w] = low[w] = counter
                    counter += 1
                    stack.append(w)
                    on[w] = True
                    work.append((w, 0))
                elif on[w]:
                    low[v] = min(low[v], idx[w])
            else:
                work.pop()
                if work:
                    u = work[-1][0]
                    low[u] = min(low[u], low[v])
                if low[v] == idx[v]:
                    comp = []
                    while True:
                        w = stack.pop()
                        on[w] = False
                        comp.append(w)
                        if w == v:
                            break
                    if len(comp) > 1:
                        sccs.append(sorted(nodes[i - 1]["path"] for i in comp))
    return sccs


# ---------- metrics (чистый порт scripts/lib/metrics.js, без Node.js) ----------

def metrics_percentile_ranks(values):
    ordered = sorted(enumerate(values), key=lambda pair: pair[1])
    ranks = [0.0] * len(values)
    start = 0
    while start < len(ordered):
        end = start + 1
        while end < len(ordered) and ordered[end][1] == ordered[start][1]:
            end += 1
        rank = (start + (end - start) / 2) / len(ordered) * 100
        for i in range(start, end):
            ranks[ordered[i][0]] = rank
        start = end
    return ranks


def metrics_cycles(outgoing, incoming):
    seen, order = set(), []
    for root in range(len(outgoing)):
        if root in seen:
            continue
        seen.add(root)
        stack = [[root, 0]]
        while stack:
            node, offset = stack[-1]
            if offset == len(outgoing[node]):
                order.append(node)
                stack.pop()
                continue
            nxt = outgoing[node][offset]
            stack[-1][1] += 1
            if nxt not in seen:
                seen.add(nxt)
                stack.append([nxt, 0])
    seen.clear()
    cycles = 0
    for root in reversed(order):
        if root in seen:
            continue
        stack, size = [root], 0
        seen.add(root)
        while stack:
            node = stack.pop()
            size += 1
            for nxt in incoming[node]:
                if nxt not in seen:
                    seen.add(nxt)
                    stack.append(nxt)
        if size > 1 or root in outgoing[root]:
            cycles += 1
    return cycles


def compute_metrics(data):
    """Метрики уникальных файловых связей; формулы совпадают с четырьмя JS-копиями."""
    files, edges, depth = data["files"], data["edges"], data.get("depth", 2)
    if type(depth) is not int or not 1 <= depth <= 5:
        raise ValueError("depth должен быть целым числом 1..5")
    indices = {file["id"]: i for i, file in enumerate(files)}
    if len(indices) != len(files):
        raise ValueError("Повторный id файла")
    outgoing, incoming = [dict() for _ in files], [dict() for _ in files]
    for edge in edges:
        src, dst = indices.get(edge["from"]), indices.get(edge["to"])
        if src is None or dst is None:
            continue
        outgoing[src][dst] = None
        incoming[dst][src] = None
    outgoing, incoming = [list(x) for x in outgoing], [list(x) for x in incoming]
    count = len(files)
    pagerank = [1 / count for _ in files]
    for _ in range(20 if count else 0):
        dangling = sum(pagerank[i] for i in range(count) if not outgoing[i])
        nxt = [(1 - 0.85) / count + 0.85 * dangling / count for _ in files]
        for src in range(count):
            if not outgoing[src]:
                continue
            share = 0.85 * pagerank[src] / len(outgoing[src])
            for dst in outgoing[src]:
                nxt[dst] += share
        pagerank = nxt
    fan_in_ranks = metrics_percentile_ranks([len(x) for x in incoming])
    pagerank_ranks = metrics_percentile_ranks(pagerank)
    per_file = []
    for root, file in enumerate(files):
        seen, queue, dependents = {root}, deque([(root, 0)]), 0
        while queue:
            node, level = queue.popleft()
            for dependent in incoming[node]:
                if dependent in seen:
                    continue
                seen.add(dependent)
                queue.append((dependent, level + 1))
                if level + 1 <= depth:
                    dependents += 1
        per_file.append({"id": file["id"], "path": file["path"], "fan_in": len(incoming[root]),
                         "fan_out": len(outgoing[root]), "dependents": dependents, "impact": len(seen) - 1,
                         "pagerank": pagerank[root], "percentile": {"fan_in": fan_in_ranks[root],
                         "pagerank": pagerank_ranks[root]}, "depth": depth})
    return {"perFile": per_file, "cycles": metrics_cycles(outgoing, incoming), "depth": depth}


def metrics_rows(metrics, file_id=None, top=15):
    rows = metrics["perFile"]
    if file_id is not None:
        return [row for row in rows if row["id"] == file_id]
    return sorted(rows, key=lambda row: (-row["fan_in"], -row["pagerank"], row["path"]))[:top]


def format_metrics(rows, depth=2, single=False, cycles=0, cycles_op=False, cache_path=""):
    lines = []
    for i, row in enumerate(rows):
        prefix = "" if single else f"{i + 1}. "
        fan_rank = int(row["percentile"]["fan_in"] + 0.5)
        page_rank = int(row["percentile"]["pagerank"] + 0.5)
        lines.append(f"{prefix}{row['path']}  fan-in {row['fan_in']} (p{fan_rank})  fan-out {row['fan_out']}"
                     f"  dependents({depth}) {row['dependents']}  impact {row['impact']}"
                     f"  pagerank {row['pagerank']:.4f} (p{page_rank})")
    if not rows:
        lines.append("Граф пуст" + (": " + cache_path if cache_path else ""))
    if cycles:
        lines.append(f"циклов: {cycles}" + (" (op=cycles)" if cycles_op else ""))
    return "\n".join(lines)


def cmd_graph(a):
    root = a.root
    if a.op == "hotspots":
        # hotspots не требует графа — git-сигналы отвечают до ensure_graph, кэш графа не трогается
        print(run_hotspots(root, a))
        return
    if a.op in ("deps", "rdeps", "node", "path", "metrics"):
        a.args = [graph_query(root, q) for q in a.args]
    if a.op == "metrics":
        if len(a.args) > 1 or a.args and a.top is not None:
            fail("укажите file либо top, не оба аргумента")
        if not 1 <= a.depth <= 5:
            fail("depth должен быть целым числом 1..5")
        if a.top is not None and not 1 <= a.top <= 9007199254740991:
            fail("top должен быть положительным целым числом")
    if a.op == "build":
        g = build_graph(root, a.src)
        print(f"граф построен: {len(g['nodes'])} файлов, {sum(len(n['imports']) for n in g['nodes'])} связей")
        return
    g = ensure_graph(root, a.src)
    nodes = g["nodes"]

    if a.op == "metrics":
        node = find_node(g, a.args[0], metrics=True) if a.args else None
        metrics = compute_metrics({"files": [{"id": n["id"], "path": n["path"]} for n in nodes],
                                   "edges": [{"from": n["id"], "to": target, "type": kind}
                                             for n in nodes for target, kind, _ in n["imports"]], "depth": a.depth})
        rows = metrics_rows(metrics, node["id"] if node else None, a.top if a.top is not None else 15)
        sys.stdout.reconfigure(newline="\n")
        print(format_metrics(rows, a.depth, bool(node), metrics["cycles"], True,
                             str(Path(root) / CACHE_DIR / "graph.json")))
        return

    if a.op == "symbol":
        if not a.args:
            fail("укажите имя: graph symbol NAME [NAME…]")
        queries = a.args
        hits = []
        for n in nodes:
            for nm, kind, ln, end in n["ents"]:
                if any(nm == q or nm.endswith("." + q) or any(f"{mn}.{nm}" == q for mn in n["names"]) for q in queries):
                    hits.append((n["path"], nm, kind, ln, end))
        if not hits:
            print(", ".join(queries) + ": не найдено")
            return
        for p, nm, kind, ln, end in hits[:20]:
            print(f"{nm}  {kind}  {p}:{ln}-{end}")
        if len(hits) > 20:
            print(f"… ещё {len(hits) - 20}")
        return

    if a.op in ("deps", "rdeps", "node"):
        if not a.args:
            fail(f"укажите файл: graph {a.op} FILE")
        n = find_node(g, a.args[0])
        if a.op == "node":
            print(f"{n['path']}  [{n['kind']}]  {n['loc']} строк  модуль: {', '.join(n['names']) or '-'}")
            if n["err"]:
                print("не разобран: " + n["err"])
            for nm, kind, ln, end in n["ents"][:50]:
                print(f"  {nm}  {kind}  {ln}-{end}")
            if len(n["ents"]) > 50:
                print(f"  … ещё {len(n['ents']) - 50}")
            print("импортирует:")
            print("\n".join(fmt_edges(bfs(g, n["id"], 1, False), 40, a.why)) or "  -")
            print("импортируют его:")
            print("\n".join(fmt_edges(bfs(g, n["id"], 1, True), 40, a.why)) or "  -")
            if n["ext"]:
                print("внешние пакеты: " + ", ".join(n["ext"]))
            return
        depth = max(1, min(a.depth, 5))
        items = bfs(g, n["id"], depth, a.op == "rdeps")
        what = "импортируют" if a.op == "rdeps" else "импортирует"
        print(f"{n['path']}: {what} — {len(items)} (глубина {depth})")
        print("\n".join(fmt_edges(items, 60, a.why)))
        if a.op == "deps" and n["ext"]:
            print("внешние пакеты: " + ", ".join(n["ext"]))
        return

    if a.op == "path":
        if len(a.args) < 2:
            fail("graph path FROM TO")
        s, t = find_node(g, a.args[0]), find_node(g, a.args[1])
        prev, kind_of = {s["id"]: None}, {}
        queue = deque([s["id"]])
        while queue:
            cur = queue.popleft()
            if cur == t["id"]:
                break
            for i, k, ln in nodes[cur - 1]["imports"]:
                if i not in prev:
                    prev[i] = cur
                    kind_of[i] = k
                    queue.append(i)
        if t["id"] not in prev:
            print(f"цепочки {s['path']} → {t['path']} нет")
            return
        chain, cur = [], t["id"]
        while cur is not None:
            chain.append((nodes[cur - 1]["path"], kind_of.get(cur)))
            cur = prev[cur]
        chain.reverse()
        parts = [chain[0][0]]
        for pth, k in chain[1:]:
            parts.append(pth + ("" if k in (None, "r") else " (lazy)" if k == "l" else " (types)"))
        print(" → ".join(parts))
        return

    if a.op == "cycles":
        cyc = tarjan_runtime(nodes)
        print(f"циклов (по runtime-импортам): {len(cyc)}")
        for c in cyc[:20]:
            print(("  " + ", ".join(c)) if len(c) <= 15 else f"  группа из {len(c)} файлов, например: " + ", ".join(c[:15]))
        return

    if a.op == "stats":
        kinds = {}
        for n in nodes:
            kinds[n["kind"]] = kinds.get(n["kind"], 0) + 1
        cnt = {}
        for n in nodes:
            for i, k, ln in n["imports"]:
                cnt[i] = cnt.get(i, 0) + 1
        ext = {}
        for n in nodes:
            for e in n["ext"]:
                ext[e] = ext.get(e, 0) + 1
        print(f"файлов: {len(nodes)}  строк: {sum(n['loc'] for n in nodes)}  "
              f"связей: {sum(len(n['imports']) for n in nodes)}  "
              + "  ".join(f"{k}: {v}" for k, v in sorted(kinds.items())))
        bad = [n["path"] for n in nodes if n["err"]]
        if bad:
            print(f"не разобраны ({len(bad)}): " + ", ".join(bad[:10]))
        print("самые импортируемые:")
        for i, c in sorted(cnt.items(), key=lambda x: -x[1])[:10]:
            print(f"  {c}  {nodes[i - 1]['path']}")
        scripts = [n["path"] for n in nodes if n["kind"] == "script"]
        if scripts:
            print("запускаемые скрипты (__main__): " + ", ".join(scripts[:15]) + (" …" if len(scripts) > 15 else ""))
        if ext:
            print(f"внешние пакеты ({len(ext)}): "
                  + ", ".join(f"{k}({v})" for k, v in sorted(ext.items(), key=lambda x: -x[1])[:15]))
        return
    fail("неизвестная операция графа")


# ---------- git-сигналы (graph hotspots) ----------
# Порт scripts/git-signals.js из token-economy-ts (план git-hotspots): те же формулы и тот же
# текстовый вывод, чтобы агент не переучивался между стеками. Источник идеи:
# defendend/Claude-ast-index-search, src/commands/git_signals.rs. Только чтение git-истории:
# граф и кэши скилла не трогаются; переименования не отслеживаются (--no-renames).

GIT_SIGNALS_VERSION = 1
GIT_SIGNALS_FILE = CACHE_DIR + "/git-signals.json"
SIZE_READ_CAP = 5 * 1024 * 1024  # чтение ради churn/стр: крупнее размер не определяется
MIN_LINES_FOR_RATIO = 50  # относительный churn имеет смысл для файлов от 50 строк
BUGFIX_RE = re.compile(r"\b(fix|fixes|bug|hotfix|hotfixes|исправ|баг)\b", re.I)


def _read_text(path):
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def _git_dir(root):
    """Каталог git-репозитория {dir, common} или None. Файловая проверка, без запуска git:
    обычный репозиторий, worktree и submodule (у них .git — файл с «gitdir: …»)."""
    dot = os.path.join(root, ".git")
    if os.path.isdir(dot):
        return {"dir": dot, "common": dot}
    if os.path.isfile(dot):
        m = re.search(r"^gitdir:\s*(.+)$", _read_text(dot) or "", re.M)
        if not m:
            return None
        p = m.group(1).strip()
        gdir = os.path.normpath(p if os.path.isabs(p) else os.path.join(root, p))
        common = gdir
        cd = _read_text(os.path.join(gdir, "commondir"))
        if cd and cd.strip():
            cd = cd.strip()
            common = os.path.normpath(cd if os.path.isabs(cd) else os.path.join(gdir, cd))
        return {"dir": gdir, "common": common}
    return None


def _read_head_sha(root):
    """SHA текущего HEAD файлами, без запуска git: .git/HEAD → loose-файл ветки → packed-refs."""
    g = _git_dir(root)
    if not g:
        return None
    head = (_read_text(os.path.join(g["dir"], "HEAD")) or "").strip()
    m = re.match(r"^ref:\s*(.+)$", head)
    if not m:
        return head if re.match(r"^[0-9a-f]{40}$|^[0-9a-f]{64}$", head) else None
    ref = m.group(1).strip()
    segments = ref.split("/")
    for base in (g["dir"], g["common"]):  # loose-файл: worktree, затем общий каталог
        v = _read_text(os.path.join(base, *segments))
        if v and v.strip():
            return v.strip()
    for base in (g["common"], g["dir"]):  # упакованная ветка
        packed = _read_text(os.path.join(base, "packed-refs"))
        for line in (packed or "").split("\n"):
            t = line.strip()
            if not t or t.startswith("#") or t.startswith("^"):
                continue
            sp = t.find(" ")
            if sp != -1 and t[sp + 1:] == ref:
                return t[:sp]
    return None


def _rev_parse_head(root):
    """Фолбэк: git rev-parse HEAD — только когда файловая раскладка не разобрана."""
    try:
        r = subprocess.run(["git", "-C", root, "rev-parse", "HEAD"], capture_output=True, timeout=60)
    except FileNotFoundError:
        fail("git не найден в PATH")
    if r.returncode != 0:
        return None
    return r.stdout.decode("utf-8", "replace").strip() or None


def _is_shallow(root):
    """Файл .git/shallow — то, что проверяет git rev-parse --is-shallow-repository, без спавна."""
    g = _git_dir(root)
    if not g:
        return False
    return any(os.path.isfile(os.path.join(base, "shallow")) for base in (g["dir"], g["common"]))


def _resolve_since(raw):
    """since: '<N>d' (дней от сегодня, по умолчанию 180) или дата YYYY-MM-DD. Дневная
    гранулярность делает ключ кэша стабильным в течение суток."""
    s = "180d" if raw in (None, "") else str(raw)
    m = re.match(r"^(\d+)d$", s)
    if m:
        days = int(m.group(1))
        if days < 1:
            fail("since — число дней ≥ 1 или дата YYYY-MM-DD, получено: " + s)
        return datetime.fromtimestamp(_now() - days * 86400, timezone.utc).strftime("%Y-%m-%d")
    if re.match(r"^\d{4}-\d{2}-\d{2}$", s):
        return s
    fail("since — число дней (<N>d) или дата YYYY-MM-DD, получено: " + s)


def _now():
    return datetime.now(timezone.utc).timestamp()


def _norm_rel(p):
    s = str(p).replace("\\", "/")
    while s.startswith("./"):
        s = s[2:]
    return s.rstrip("/")


def _plural_ru(n, forms):  # [«1», «2–4», «5+»]
    mod100, mod10 = n % 100, n % 10
    if 11 <= mod100 <= 14:
        return forms[2]
    if mod10 == 1:
        return forms[0]
    if 2 <= mod10 <= 4:
        return forms[1]
    return forms[2]


def collect_git_signals(root, since, max_commits, pathspec, head):
    """Один проход git log --numstat: на файл — commits, churn, authors, bugfix, binary, last."""
    args = ["git", "-C", root, "log", "--no-merges", "--no-renames", "--numstat", "--date=short",
            "--format=%x01%H%x09%an%x09%ad%x09%s", "--since=" + since, "-n", str(max_commits)]
    if pathspec:
        args += ["--"] + list(pathspec)
    try:
        r = subprocess.run(args, capture_output=True, timeout=300)
    except FileNotFoundError:
        fail("git не найден в PATH")
    out = r.stdout.decode("utf-8", "replace")
    err = r.stderr.decode("utf-8", "replace")
    # unborn-ветка (репозиторий без коммитов) — пустая история, а не сбой
    if r.returncode != 0 and "does not have any commits yet" not in err.lower():
        first = err.strip().split("\n")[0] if err.strip() else "код " + str(r.returncode)
        fail("git log завершился с ошибкой: " + first)
    files, cur, total = {}, None, 0
    for raw in out.split("\n"):
        line = raw.rstrip("\r")
        if line.startswith("\x01"):
            f = line[1:].split("\t")
            cur = {"an": f[1] if len(f) > 1 else "", "ad": f[2] if len(f) > 2 else "", "s": "\t".join(f[3:])}
            total += 1
            continue
        if cur is None or not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        path = "\t".join(parts[2:])
        binary = parts[0] == "-" and parts[1] == "-"
        e = files.setdefault(path, {"commits": 0, "churn": 0, "authors": set(), "bugfix": 0, "binary": False, "last": ""})
        e["commits"] += 1
        if binary:  # бинарник: коммит считается, churn не выдумывается
            e["binary"] = True
        else:
            e["churn"] += int(parts[0]) + int(parts[1])
        e["authors"].add(cur["an"])
        if BUGFIX_RE.search(cur["s"]):
            e["bugfix"] += 1
        if cur["ad"] > e["last"]:
            e["last"] = cur["ad"]
    return {
        "version": GIT_SIGNALS_VERSION,
        "head": head,
        "since": since,
        "maxCommits": max_commits,
        "pathspec": list(pathspec),
        "shallow": _is_shallow(root),
        "ceiling": total == max_commits,
        "collectedAt": datetime.now(timezone.utc).isoformat(),
        "commitsTotal": total,
        "files": {p: {"commits": e["commits"], "churn": e["churn"], "authors": len(e["authors"]),
                      "bugfix": e["bugfix"], "binary": e["binary"], "last": e["last"]} for p, e in files.items()},
    }


def _load_signals(root, since, max_commits, pathspec):
    """Сбор с кэшем: валидный .token-economy/git-signals.json (head + since + max_commits +
    pathspec + версия) отдаётся без запуска git; иначе один проход git log и запись кэша."""
    if _git_dir(root) is None:
        fail("не git-репозиторий (" + root + ")")
    head = _read_head_sha(root)
    if not head:
        head = _rev_parse_head(root)  # фолбэк, когда файловая раскладка не разобрана
    if not head:
        hf = (_read_text(os.path.join(_git_dir(root)["dir"], "HEAD")) or "").strip()
        m = re.match(r"^ref:\s*(.+)$", hf)
        if not m:
            fail("HEAD не определён: ни файлы .git, ни git rev-parse не помогли")
        head = "unborn:" + m.group(1).strip()  # unborn-ветка: коммитов нет, это пустая история
    cache = load_json(root, GIT_SIGNALS_FILE)
    valid = (isinstance(cache, dict) and cache.get("version") == GIT_SIGNALS_VERSION
             and cache.get("head") == head and cache.get("since") == since
             and cache.get("maxCommits") == max_commits
             and cache.get("pathspec") == list(pathspec)
             and isinstance(cache.get("files"), dict)
             and isinstance(cache.get("commitsTotal"), int))
    if valid:
        return cache, True
    data = collect_git_signals(root, since, max_commits, pathspec, head)
    try:
        save_json(root, GIT_SIGNALS_FILE, data)
    except OSError as e:
        print("Предупреждение: кэш не записан (" + str(e) + ")", file=sys.stderr)
    return data, False


def percentile_ranks(data):
    """Процентильные метки p50/p90/p97 по commits/churn/bugfix — внутри репозитория, не
    абсолютные числа. Метка — старшая граница, которой значение достигло (0 метки не получает);
    top — старшая метка файла по всем трём метрикам."""
    paths = list(data["files"].keys())
    metrics = ("commits", "churn", "bugfix")
    priority = {"p97": 3, "p90": 2, "p50": 1}
    bounds = {}
    for m in metrics:
        vals = sorted(data["files"][p][m] for p in paths)
        bounds[m] = {}
        for q in (50, 90, 97):
            idx = max(0, min(-(-q * len(vals) // 100) - 1, len(vals) - 1)) if vals else 0
            bounds[m]["p" + str(q)] = vals[idx] if vals else 0
    labels, top = {}, {}
    for p in paths:
        labels[p], best = {}, None
        for m in metrics:
            v = data["files"][p][m]
            if v <= 0:
                labels[p][m] = None
                continue
            if v >= bounds[m]["p97"]:
                mark = "p97"
            elif v >= bounds[m]["p90"]:
                mark = "p90"
            elif v >= bounds[m]["p50"]:
                mark = "p50"
            else:
                mark = None
            labels[p][m] = mark
            if mark and (best is None or priority[mark] > priority[best]):
                best = mark
        top[p] = best
    return {"labels": labels, "top": top}


def bugfix_ratio(entry):
    """Доля багфиксов в коммитах файла, %; Math.round-паритет: floor(x + 0.5)."""
    return math.floor(100 * entry["bugfix"] / entry["commits"] + 0.5) if entry["commits"] else 0


def _file_lines(root, rel):
    """Текущее число строк файла (чтение с потолком 5 МБ; крупнее или файл удалён — None)."""
    try:
        if os.stat(os.path.join(root, rel)).st_size > SIZE_READ_CAP:
            return None
        s = Path(os.path.join(root, rel)).read_bytes().decode("utf-8", "replace")
    except OSError:
        return None
    if not s:
        return 0
    return s.count("\n") + (0 if s.endswith("\n") else 1)


def _per_line(root, entry, rel):
    """churn/стр: None для бинарников, файлов < 50 строк и файлов без определённого размера."""
    if entry["binary"]:
        return None
    lines = _file_lines(root, rel)
    if lines is None or lines < MIN_LINES_FOR_RATIO:
        return None
    return entry["churn"] / lines


def _fmt2(x):
    # toFixed(2)-паритет: у JS из двух возможных n выбирается большее → половина округляется вверх
    return "{:.2f}".format(math.floor(x * 100 + 0.5) / 100)


def _cells(root, entry, rel, labels=None):
    per = _per_line(root, entry, rel)
    labels = labels or {}
    return [c for c in [
        "коммитов " + str(entry["commits"]) + ((" (" + labels["commits"] + ")") if labels.get("commits") else ""),
        "churn " + str(entry["churn"]) + ((" (" + labels["churn"] + ")") if labels.get("churn") else ""),
        "авторов " + str(entry["authors"]),
        "багфиксов " + str(entry["bugfix"]) + " (" + str(bugfix_ratio(entry)) + "%"
            + ((", " + labels["bugfix"]) if labels.get("bugfix") else "") + ")",
        ("churn/стр " + _fmt2(per)) if per is not None else None,
    ] if c is not None]


def _format_top(data, ranks, root, top_n):
    files = list(data["files"].keys())
    header = ("git-сигналы: " + str(data["commitsTotal"]) + " "
              + _plural_ru(data["commitsTotal"], ("коммит", "коммита", "коммитов"))
              + ", " + str(len(files)) + " " + _plural_ru(len(files), ("файл", "файла", "файлов"))
              + ", since " + data["since"])
    files.sort(key=lambda p: (-data["files"][p]["churn"], -data["files"][p]["commits"], p))
    shown = files[:max(1, top_n)]
    width = min(max([len(p) for p in shown] or [0]), 48)
    lines = [header]
    for i, p in enumerate(shown):
        cells = _cells(root, data["files"][p], p)  # в top пер-меточные метки не показываются
        if ranks["top"].get(p):
            cells.append(ranks["top"][p])
        lines.append(str(i + 1) + ". " + p.ljust(width) + "  " + "  ".join(cells))
    return "\n".join(lines)


def _format_file(data, ranks, rel, root):
    entry = data["files"].get(rel)
    if not entry:
        return None
    cells = _cells(root, entry, rel, ranks["labels"].get(rel))
    cells.append("последний " + (entry["last"] or "—"))
    return rel + "  " + "  ".join(cells)


def run_hotspots(root, a):
    """Точка вызова graph hotspots: аргументы argparse (--top/--file/--since/--max-commits)."""
    if a.top < 1:
        fail("top — целое ≥ 1, получено: " + str(a.top))
    if a.max_commits < 1:
        fail("max_commits — целое ≥ 1, получено: " + str(a.max_commits))
    since = _resolve_since(a.since)
    data, _ = _load_signals(root, since, a.max_commits, [])
    ranks = percentile_ranks(data)
    warn = []
    if data.get("shallow"):
        warn.append("ВНИМАНИЕ: shallow-клон, история неполная")
    if data.get("ceiling"):
        warn.append("просмотрено " + str(data["maxCommits"]) + " коммитов (потолок), история могла быть обрезана")
    if not data["commitsTotal"]:
        return "\n".join(warn + ["коммитов за период нет"])
    if a.file:
        rel = _norm_rel(a.file)
        line = _format_file(data, ranks, rel, root)
        if not line:
            return "\n".join(warn + ["нет данных: " + rel + " не менялся за период (since " + since + ")"])
        return "\n".join(warn + [line])
    return "\n".join(warn + [_format_top(data, ranks, root, a.top)])


# ---------- info (паспорт проекта одним вызовом) ----------

def _deps_name(req):
    return re.split(r"[<>=!~;\[\s]", req.strip(), maxsplit=1)[0]


def _pyproject_deps(root):
    """Зависимости и requires-python из pyproject.toml; без tomllib (3.9–3.10) — упрощённый разбор."""
    p = os.path.join(root, "pyproject.toml")
    if not os.path.exists(p):
        return None
    if tomllib is not None:
        try:
            with open(p, "rb") as f:
                proj = tomllib.load(f).get("project") or {}
        except Exception:
            return {"deps": [], "requires": None, "parsed": False}
        reqs = list(proj.get("dependencies") or [])
        for v in (proj.get("optional-dependencies") or {}).values():
            reqs.extend(v or [])
        return {"deps": sorted({_deps_name(r) for r in reqs if _deps_name(r)}),
                "requires": proj.get("requires-python"), "parsed": True}
    try:
        with open(p, "r", encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return None
    m = re.search(r'^dependencies\s*=\s*\[(.*?)\]', text, re.S | re.M)
    reqs = re.findall(r'["\']([^"\']+)["\']', m.group(1)) if m else []
    m = re.search(r'^requires-python\s*=\s*["\']([^"\']+)["\']', text, re.M)
    return {"deps": sorted({_deps_name(r) for r in reqs if _deps_name(r)}),
            "requires": m.group(1) if m else None, "parsed": True}


def _requirements_deps(root):
    names, files = [], []
    try:
        files = sorted(f for f in os.listdir(root) if f.startswith("requirements") and f.endswith(".txt"))
    except OSError:
        return names, files
    for fn in files:
        try:
            with open(os.path.join(root, fn), "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith(("#", "-")):
                        continue
                    name = _deps_name(line)
                    if name:
                        names.append(name)
        except OSError:
            continue
    return sorted(set(names)), files


def cmd_info(a):
    root = os.path.abspath(a.root)
    g = ensure_graph(root, a.src)
    nodes = g["nodes"]
    print(f"корень: {posix(root)}")
    venv = " (в venv)" if sys.prefix != getattr(sys, "base_prefix", sys.prefix) else ""
    print(f"python: {sys.version.split()[0]}{venv}  {sys.executable}")
    pp = _pyproject_deps(root)
    req_deps, req_files = _requirements_deps(root)
    if pp:
        deps = pp["deps"]
        tail = f"  требуется: {pp['requires']}" if pp.get("requires") else ""
        mark = "" if pp.get("parsed") else "  (файл не разобран)"
        print(f"зависимости: {len(deps)} из pyproject.toml{mark}{tail}")
    elif req_deps:
        deps = req_deps
        print(f"зависимости: {len(deps)} из {', '.join(req_files)}")
    else:
        deps = []
        print("зависимости: не найдены (нет pyproject.toml и requirements*.txt)")
    if deps:
        print("  " + ", ".join(deps[:15]) + (f" … ещё {len(deps) - 15}" if len(deps) > 15 else ""))
    kinds = {}
    for n in nodes:
        kinds[n["kind"]] = kinds.get(n["kind"], 0) + 1
    print(f"файлов: {len(nodes)}  строк: {sum(n['loc'] for n in nodes)}  "
          + "  ".join(f"{k}: {v}" for k, v in sorted(kinds.items())))
    roots = source_roots(root, a.src)[:-1]
    print("src-корни: " + (", ".join(roots) if roots else ". (корень проекта)"))
    ext = {}
    for n in nodes:
        for e in n["ext"]:
            ext[e] = ext.get(e, 0) + 1
    if ext:
        print(f"внешние пакеты ({len(ext)}): "
              + ", ".join(f"{k}({v})" for k, v in sorted(ext.items(), key=lambda x: -x[1])[:15]))
    print("крупнейшие файлы:")
    for n in sorted(nodes, key=lambda n: -n["loc"])[:10]:
        print(f"  {n['loc']:>5}  {n['path']}" + ("  [test]" if n["kind"] == "test" else ""))
    bad = [n["path"] for n in nodes if n["err"]]
    if bad:
        print(f"ВНИМАНИЕ: не разобраны ({len(bad)}): " + ", ".join(bad[:8]) + (" …" if len(bad) > 8 else ""))


# ---------- outline ----------

def _short(s, n):
    s = " ".join(s.split())
    return s if len(s) <= n else s[: n - 1] + "…"


def _sig(node):
    pre = "async " if isinstance(node, ast.AsyncFunctionDef) else ""
    ret = f" -> {ast.unparse(node.returns)}" if node.returns else ""
    return f"{pre}def {node.name}({ast.unparse(node.args)}){ret}"


def _decos(node):
    return " ".join("@" + _short(ast.unparse(d), 40) for d in node.decorator_list)


def _doc1(node):
    d = ast.get_docstring(node, clean=True)
    return _short(d.split("\n\n")[0], 100) if d else ""


def safe_file(root, f):
    p = safe_path(root, f)
    if not p.is_file():
        fail("файл не найден: " + f)
    return p


def cmd_outline(a):
    root = os.path.abspath(a.root)
    p = safe_file(root, a.file)
    if p.suffix.lower() not in (".py", ".pyi"):
        fail("outline работает только с .py/.pyi")
    data = p.read_bytes()
    try:
        tree = ast.parse(data)
    except SyntaxError as e:
        fail(f"SyntaxError в {a.file}: строка {e.lineno}: {e.msg}")
    nlines = data.count(b"\n") + 1
    print(f"{posix(p.relative_to(Path(root).resolve()))}  ({nlines} строк)")

    def line(st, text, depth, docnode=None):
        end = st.end_lineno or st.lineno
        extra = ""
        if a.docs and docnode is not None and _doc1(docnode):
            extra = "  # " + _doc1(docnode)
        print(f"L{_start(st)}-{end}".ljust(10) + "  " * depth + text + extra)

    def walk(body, depth):
        for st in _flat(body):
            if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef)):
                d = _decos(st)
                line(st, (d + " " if d else "") + _short(_sig(st), 140), depth, st)
            elif isinstance(st, ast.ClassDef):
                bases = ", ".join(ast.unparse(b) for b in st.bases)
                d = _decos(st)
                line(st, (d + " " if d else "") + f"class {st.name}" + (f"({_short(bases, 80)})" if bases else ""), depth, st)
                walk(st.body, depth + 1)
            elif depth == 0 and isinstance(st, (ast.Assign, ast.AnnAssign)):
                targets = st.targets if isinstance(st, ast.Assign) else [st.target]
                for t in targets:
                    if isinstance(t, ast.Name) and t.id.isupper() and not t.id.startswith("_"):
                        line(st, t.id, depth)
            elif depth == 0 and isinstance(st, ast.If) and _is_main_guard(st.test):
                line(st, "if __name__ == '__main__'", depth)

    walk(tree.body, 0)


# ---------- search ----------

def _decode(raw):
    """utf-8; если файл не в utf-8 — cp1251; иначе utf-8 с заменой символов."""
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        try:
            return raw.decode("cp1251")
        except UnicodeDecodeError:
            return raw.decode("utf-8", "replace")


def cmd_search(a):
    root = os.path.abspath(a.root)
    if a.path and os.path.isabs(a.path):
        fail("--path задайте относительно корня проекта")
    if a.ext == "*":
        exts = None
    else:
        exts = []
        for e in a.ext.split(","):
            e = e.strip().lower()
            if e:
                exts.append(e if e.startswith(".") else "." + e)
        exts = tuple(exts) or None
    flags = re.IGNORECASE if a.i else 0
    try:
        rx = re.compile(a.query if a.re else re.escape(a.query), flags)
    except re.error as e:
        fail("некорректное регулярное выражение: " + str(e))
    sub = posix(safe_path(root, a.path).relative_to(Path(root))) if a.path else ""
    if sub == ".":
        sub = ""
    files = [f for f in project_files(root, exts) if not sub or f == sub or f.startswith(sub + "/")]
    total, shown, nfiles = 0, 0, 0
    out, cur, hit_files = [], None, []
    for f in files:
        try:
            raw = project_path(root, f).read_bytes()
        except (OSError, RuntimeError, ValueError):
            continue
        if b"\0" in raw[:2048]:
            continue
        hit_here = False
        for no, ln in enumerate(_decode(raw).splitlines(), 1):
            m = rx.search(ln)
            if not m:
                continue
            total += 1
            if not hit_here:
                hit_here = True
                nfiles += 1
                hit_files.append(f)
            if not a.files and shown < a.limit:
                if cur != f:
                    out.append(f)
                    cur = f
                text = ln.strip()
                if len(text) > 120:
                    lead = len(ln) - len(ln.lstrip())
                    pos = max(m.start() - lead - 40, 0)
                    text = ("…" if pos else "") + text[pos: pos + 120] + "…"
                out.append(f"  {no}: {text}")
                shown += 1
    if not total:
        print(f"«{a.query}»: совпадений нет ({len(files)} файлов просмотрено)")
        return
    if a.files:
        print("\n".join(hit_files[:500]))
        if len(hit_files) > 500:
            print(f"… ещё {len(hit_files) - 500}")
        print(f"-- файлов: {nfiles}, совпадений: {total}")
        return
    print("\n".join(out))
    print(f"-- совпадений: {total}, файлов: {nfiles}" + (f", показано {shown}" if shown < total else ""))


# ---------- sig (сигнатуры установленных библиотек без чтения исходников) ----------

_parse_cache = {}
_EXTRA_SRC = []  # доп. корни пакетов из --src, учитываются в sig


def _is_compiled(p):
    return str(p).endswith(COMPILED_EXTS)


def parse_any(path):
    """AST файла (.py и .pyi); для каталога-пакета без __init__ — пустой модуль; None, если не разобрать."""
    key = str(path)
    if key in _parse_cache:
        return _parse_cache[key]
    tree = None
    try:
        p = Path(path)
        tree = ast.Module(body=[], type_ignores=[]) if p.is_dir() else ast.parse(p.read_bytes())
    except Exception:
        tree = None
    _parse_cache[key] = tree
    return tree


def search_paths(root):
    paths = []
    for base in [root, os.path.join(root, "src")] + [os.path.join(root, s) for s in _EXTRA_SRC]:
        if os.path.isdir(base):
            paths.append(base)
    for venv in (".venv", "venv", "env"):
        for pat in (("lib", "site-packages"), ("Lib", "site-packages")):
            sp = os.path.join(root, venv, *pat)
            if os.path.isdir(sp):
                paths.append(sp)
        lib = os.path.join(root, venv, "lib")
        if os.path.isdir(lib):
            for d in sorted(os.listdir(lib)):
                sp = os.path.join(lib, d, "site-packages")
                if os.path.isdir(sp):
                    paths.append(sp)
    here = os.path.dirname(os.path.abspath(__file__))
    paths += [p for p in sys.path if p and os.path.abspath(p) != here]
    return paths


def find_top(name, root):
    if not name:
        return None
    if name in sys.builtin_module_names:
        return "BUILTIN"
    try:
        spec = PathFinder.find_spec(name, search_paths(root))
    except Exception:
        return None
    if spec is None:
        return None
    if spec.origin and spec.origin not in ("built-in", "frozen", "namespace") and spec.origin.endswith(".py"):
        return Path(spec.origin)
    if spec.origin and spec.origin.endswith(COMPILED_EXTS):
        return "COMPILED"
    if spec.submodule_search_locations:
        return Path(list(spec.submodule_search_locations)[0])
    return "COMPILED"


def pkg_dir(p):
    p = Path(p)
    if p.is_dir():
        return p
    return p.parent if p.name in ("__init__.py", "__init__.pyi") else None


def sub_module(d, name):
    """Файл/каталог подмодуля: .py, .pyi, скомпилированное расширение, пакет, namespace-каталог."""
    for suf in (".py", ".pyi", *COMPILED_EXTS):
        f = Path(d, name + suf)
        if f.is_file():
            return f
    for init in ("__init__.py", "__init__.pyi"):
        f = Path(d, name, init)
        if f.is_file():
            return f
    p = Path(d, name)
    return p if p.is_dir() else None


def module_file(mod, level, cur, root):
    """Файл модуля по имени (абсолютному или относительному от cur); .so тоже возвращается."""
    if level > 0:
        cur = Path(cur)
        base = cur if cur.is_dir() else cur.parent
        for _ in range(level - 1):
            base = base.parent
        if not mod:
            init = base / "__init__.py"
            return init if init.is_file() else base
        last, d = None, base
        parts = mod.split(".")
        for i, part in enumerate(parts):
            last = sub_module(d, part)
            if last is None:
                return None
            if i < len(parts) - 1:
                d = pkg_dir(last)
                if d is None:
                    return None
        return last
    parts = mod.split(".")
    top = find_top(parts[0], root)
    if top in (None, "BUILTIN", "COMPILED"):
        return None
    last = top
    for part in parts[1:]:
        d = pkg_dir(last)
        nxt = sub_module(d, part) if d else None
        if nxt is None:
            return None
        last = nxt
    return last


def collect_aliases(tree):
    """Имя → список привязок ('from', модуль, исходное_имя, level) | ('import', модуль, None, 0); звёзды отдельно."""
    al, stars = {}, []

    def put(name, val):
        al.setdefault(name, []).append(val)

    for st in _flat(tree.body):
        if isinstance(st, ast.ImportFrom):
            for x in st.names:
                if x.name == "*":
                    stars.append((st.module or "", st.level))
                else:
                    put(x.asname or x.name, ("from", st.module or "", x.name, st.level))
        elif isinstance(st, ast.Import):
            for x in st.names:
                if x.asname:
                    put(x.asname, ("import", x.name, None, 0))
                else:
                    put(x.name.split(".")[0], ("import", x.name.split(".")[0], None, 0))
    return al, stars


def _plat_rank(mod):
    """У os.path две привязки (posixpath / ntpath): сначала та, что относится к текущей платформе."""
    good = ("posixpath", "posix") if os.name == "posix" else ("ntpath", "nt")
    return 0 if mod in good else 1


def literal_all(tree):
    for st in _flat(tree.body):
        if isinstance(st, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "__all__" for t in st.targets) \
                and isinstance(st.value, (ast.List, ast.Tuple)):
            return [e.value for e in st.value.elts if isinstance(e, ast.Constant) and isinstance(e.value, str)]
    return None


def find_def(body, name):
    for st in _flat(body):
        if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and st.name == name:
            return st
        if isinstance(st, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in st.targets):
            return st
        if isinstance(st, ast.AnnAssign) and isinstance(st.target, ast.Name) and st.target.id == name:
            return st
    return None


def resolve_from(cur, rest, root, depth=0, seen=None):
    """Идёт по цепочке имён внутри модуля cur. Возвращает (вид, узел, файл) или None.

    Вид: "module", "def" или "compiled"."""
    seen = seen or set()
    key = (str(cur), tuple(rest))
    if depth > 14 or key in seen:
        return None
    seen.add(key)
    if _is_compiled(cur):
        return ("compiled", None, Path(cur))
    if not rest:
        return ("module", None, Path(cur))
    tree = parse_any(cur)
    if tree is None:
        return None
    name, tail = rest[0], rest[1:]
    if not name:
        return None
    d = find_def(tree.body, name)
    if d is not None:
        if not tail:
            return ("def", d, Path(cur))
        if isinstance(d, ast.ClassDef):
            return find_member(d, cur, tail, root, depth + 1, seen)
        return None
    al, stars = collect_aliases(tree)
    if name in al:
        for kind, mod, orig, lv in sorted(al[name], key=lambda v: _plat_rank(v[1])):
            target = module_file(mod, lv, cur, root)
            if target is None:
                continue
            if kind == "import":
                r = resolve_from(target, tail, root, depth + 1, seen)
            else:
                r = resolve_from(target, [orig] + tail, root, depth + 1, seen)
                if r is None and pkg_dir(target) and sub_module(pkg_dir(target), orig) is not None:
                    r = resolve_from(sub_module(pkg_dir(target), orig), tail, root, depth + 1, seen)
            if r is not None:
                return r
        return None
    dd = pkg_dir(cur)
    if dd:
        sub = sub_module(dd, name)
        if sub is not None:
            r = resolve_from(sub, tail, root, depth + 1, seen)
            if r is not None:
                return r
    for mod, lv in stars:
        target = module_file(mod, lv, cur, root)
        if target is not None:
            r = resolve_from(target, rest, root, depth + 1, seen)
            if r is not None:
                return r
    return None


def find_member(cls, cur, tail, root, depth, seen):
    """Метод/атрибут класса, включая базовые классы, видимые по имени."""
    name, rest = tail[0], tail[1:]
    m = find_def(cls.body, name)
    if m is not None and not rest:
        return ("def", m, Path(cur))
    for b in cls.bases:
        if isinstance(b, ast.Name):
            r = resolve_from(cur, [b.id], root, depth + 1, set(seen))
            if r and r[0] == "def" and isinstance(r[1], ast.ClassDef):
                got = find_member(r[1], r[2], tail, root, depth + 1, seen)
                if got:
                    return got
    return None


def resolve_target(dotted, root):
    parts = dotted.split(".")
    top = find_top(parts[0], root)
    if top is None:
        return None, "не найден в проекте и в установленных пакетах"
    if top == "BUILTIN":
        return None, "встроенный модуль без исходников на Python"
    if top == "COMPILED":
        return None, "скомпилированный модуль (.so/.pyd), исходников нет"
    r = resolve_from(top, parts[1:], root)
    if r is None:
        return None, "имя не найдено (возможно, создаётся динамически или живёт в .so)"
    return r, None


def _doc_text(node, full):
    d = ast.get_docstring(node, clean=True)
    if not d:
        return ""
    if full:
        return d if len(d) <= 1500 else d[:1500] + "…"
    return _short(d.split("\n\n")[0], 300)


def builtin_sig(dotted, full):
    import importlib
    import inspect
    parts = dotted.split(".")
    try:
        obj = importlib.import_module(parts[0])
        for p in parts[1:]:
            obj = getattr(obj, p)
    except Exception:
        fail(f"{dotted}: имя не найдено во встроенном модуле")
    try:
        sig = str(inspect.signature(obj))
    except (TypeError, ValueError):
        sig = getattr(obj, "__text_signature__", None) or ""
    print(f"{dotted}  (встроенный, исходников на Python нет)")
    if sig:
        print(parts[-1] + sig)
    doc = inspect.getdoc(obj) or ""
    print(doc[:1500] if full else _short(doc.split("\n\n")[0], 300))


def cmd_sig(a):
    root = os.path.abspath(a.root)
    target = a.target.strip()
    _EXTRA_SRC[:] = [posix(os.path.normpath(s)) for s in (a.src or [])
                     if posix(os.path.normpath(s)) not in ("", ".")]
    if find_top(target.split(".")[0], root) == "BUILTIN":
        builtin_sig(target, a.doc)
        return
    res, err = resolve_target(target, root)
    if res is None:
        fail(f"{target}: {err}")
    kind, node, path = res
    where = str(path)
    try:
        where = posix(Path(path).resolve().relative_to(Path(root).resolve()))
    except ValueError:
        pass
    if kind == "compiled":
        print(f"{target}  (скомпилированный модуль .so/.pyd, исходников нет)  {where}")
        return
    if kind == "module":
        tree = parse_any(path)
        print(f"{target}  (модуль)  {where}")
        if tree is None:
            return
        doc = ast.get_docstring(tree, clean=True)
        if doc:
            print(_doc_text(tree, a.doc))
        pub = [s for s in _flat(tree.body) if isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
               and not s.name.startswith("_")]
        for s in pub[:60]:
            print("  " + (f"class {s.name}" if isinstance(s, ast.ClassDef) else _short(_sig(s), 150)))
        if len(pub) > 60:
            print(f"  … ещё {len(pub) - 60}")
        names = literal_all(tree)
        if names is None and Path(path).name in ("__init__.py", "__init__.pyi"):
            al, stars = collect_aliases(tree)
            names = [n for n, v in al.items() if v[0][0] == "from" and not n.startswith("_")]
            if stars and not names:
                names = ["* из " + ", ".join(("." * lv) + m for m, lv in stars)]
        if names:
            print("  экспорт: " + ", ".join(names[:40]) + (" …" if len(names) > 40 else ""))
        d = pkg_dir(path)
        if d:
            subs = sorted({p.stem if p.suffix in (".py", ".pyi") else p.name for p in d.iterdir()
                           if ((p.suffix in (".py", ".pyi") and p.stem != "__init__" and not p.stem.startswith("_"))
                               or (p.is_dir() and (p / "__init__.py").is_file() and not p.name.startswith("_")))})
            if subs:
                print("  подмодули: " + ", ".join(subs[:30]) + (" …" if len(subs) > 30 else ""))
        return
    ln = _start(node)
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        d = _decos(node)
        print(f"{target}  (функция)  {where}:{ln}")
        print((d + " " if d else "") + _sig(node))
        doc = _doc_text(node, a.doc)
        if doc:
            print(doc)
    elif isinstance(node, ast.ClassDef):
        bases = ", ".join(ast.unparse(b) for b in node.bases)
        print(f"{target}  (класс)  {where}:{ln}")
        print(f"class {node.name}" + (f"({_short(bases, 100)})" if bases else ""))
        doc = _doc_text(node, a.doc)
        if doc:
            print(doc)
        methods = [s for s in node.body if isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef))
                   and (not s.name.startswith("_") or s.name == "__init__")]
        for s in methods[:40]:
            d = _decos(s)
            print("  " + (d + " " if d else "") + _short(_sig(s), 150))
        if len(methods) > 40:
            print(f"  … ещё {len(methods) - 40}")
        print("  (унаследованные методы не показаны; сигнатуру нужного — sig " + target + ".имя)")
    else:
        print(f"{target}  (значение)  {where}:{ln}")
        print(_short(ast.unparse(node), 200))


# ---------- selftest ----------

def cmd_selftest(a):
    """Проверки на синтетическом проекте во временной папке: python3 te.py selftest."""
    import io
    import shutil
    import tempfile
    from contextlib import redirect_stderr, redirect_stdout

    def run(args):
        out, err = io.StringIO(), io.StringIO()
        old = sys.argv
        sys.argv = ["te.py"] + [str(x) for x in args]
        rc = 0
        try:
            with redirect_stdout(out), redirect_stderr(err):
                main()
        except SystemExit as e:
            rc = e.code if isinstance(e.code, int) else 1
        finally:
            sys.argv = old
        return rc, out.getvalue(), err.getvalue()

    bad = []

    def chk(name, cond, extra=""):
        print(("ok    " if cond else "FAIL  ") + name + ("" if cond else "  [" + " ".join(extra.split())[:300] + "]"))
        if not cond:
            bad.append(name)

    tmp = tempfile.mkdtemp(prefix="te-selftest-")
    try:
        root = os.path.join(tmp, "proj")
        for sub in ("app", "tests", "cyc", "envs"):
            os.makedirs(os.path.join(root, sub))

        def w(rel, text):
            Path(root, rel).write_text(text, encoding="utf-8")

        w("app/__init__.py", "from .core import Engine\nfrom . import util\n")
        w("app/core.py", "import os\nfrom typing import TYPE_CHECKING\n\nif TYPE_CHECKING:\n    from .models import User\n\n\ndef load():\n    import json\n\n\nclass Engine:\n    def run(self):\n        return 1\n")
        w("app/models.py", "class User:\n    pass\n")
        w("app/util.py", "import importlib\n\n\ndef dyn():\n    return importlib.import_module(\"app.core\")\n")
        w("main.py", "from app.core import Engine\n\nif __name__ == \"__main__\":\n    Engine().run()\n")
        w("run2.py", "if \"__main__\" == __name__:\n    pass\n")
        w("tests/test_core.py", "from app.core import Engine\n\n\ndef test_run():\n    assert Engine().run() == 1\n")
        w("cyc/a.py", "from . import b\n")
        w("cyc/b.py", "from . import a\n")
        w("envs/pyvenv.cfg", "home = /\n")
        w("envs/mod.py", "import os\n")
        w("notes.txt", "Engine mentions\n")
        Path(root, "ru.txt").write_bytes("функция test".encode("cp1251"))
        Path(root, "fakemod" + EXTENSION_SUFFIXES[0]).write_bytes(b"\x7fELF-fake")

        G = ["--root", root]

        rc, o, e = run(G + ["graph", "stats"])
        chk("graph stats", rc == 0 and "файлов: 9" in o, o + e)
        chk("папка с pyvenv.cfg исключена", "envs/mod.py" not in o)

        rc, o, e = run(G + ["graph", "deps", "app/core.py"])
        chk("связь (types)", rc == 0 and "app/models.py (types)" in o, o + e)

        rc, o, e = run(G + ["graph", "deps", "app/util.py"])
        chk("связь (lazy) через import_module", rc == 0 and "app/core.py (lazy)" in o, o + e)

        rc, o, e = run(G + ["graph", "rdeps", "app/core.py", "--why"])
        chk("rdeps: метки и номера строк", rc == 0 and "[test]" in o and "(lazy)" in o and "L1" in o, o + e)

        rc, o, e = run(G + ["graph", "symbol", "Engine", "User"])
        chk("symbol: несколько имён", rc == 0
            and "Engine  class  app/core.py" in o and "User  class  app/models.py" in o, o + e)

        rc, o, e = run(G + ["graph", "cycles"])
        chk("циклы", rc == 0 and "циклов (по runtime-импортам): 1" in o and "cyc/a.py" in o, o + e)

        rc, o, e = run(G + ["graph", "path", "main.py", "app/models.py"])
        chk("path с пометкой вида", rc == 0 and "app/models.py (types)" in o and "main.py" in o, o + e)

        rc, o, e = run(G + ["graph", "node", "run2.py"])
        chk("__main__-guard в любом порядке", rc == 0 and "[script]" in o, o + e)

        rc, o, e = run(["graph", "stats", "--root", root])  # общие опции после команды
        chk("опции после команды", rc == 0 and "файлов: 9" in o, o + e)

        rc, o, e = run(G + ["graph", "deps", "app/core.py", "--depth", "abc"])
        chk("нечисловой --depth: ошибка, не traceback", rc == 2 and "Traceback" not in e, e)

        rc, o, e = run(G + ["outline", "app/core.py"])
        chk("outline", rc == 0 and "class Engine" in o and "def load" in o, o + e)

        rc, o, e = run(G + ["search", "Engine"])
        chk("search", rc == 0 and "tests/test_core.py" in o and "совпадений" in o, o + e)

        rc, o, e = run(G + ["search", "Engine", "-l"])
        chk("search -l: только файлы", rc == 0 and "tests/test_core.py" in o
            and not any(ln.startswith("  ") for ln in o.splitlines()), o + e)

        rc, o, e = run(G + ["search", "Engine", "--ext", ".py, .txt"])
        chk("search --ext с пробелами", rc == 0 and "notes.txt" in o, o + e)

        rc, o, e = run(G + ["search", "функция", "--ext", ".txt"])
        chk("search: cp1251-фолбэк", rc == 0 and "ru.txt" in o, o + e)

        rc, o, e = run(G + ["search", "Eng. *", "--re"])
        chk("search --re", rc == 0 and "app/core.py" in o, o + e)

        rc, o, e = run(G + ["sig", "json.dumps"])
        chk("sig: stdlib-функция", rc == 0 and "(функция)" in o and "def dumps" in o, o + e)

        rc, o, e = run(G + ["sig", "os.path.join"])
        chk("sig: os.path.join через псевдоним", rc == 0 and "(функция)" in o, o + e)

        # math бывает builtin (Windows, локальные сборки) и разделяемым .so
        # (toolcache-сборки setup-python на Linux): в первом случае ждём
        # сигнатуру, во втором — честный отказ, но не молчание и не трейсбек.
        rc, o, e = run(G + ["sig", "math.sin"])
        if "math" in sys.builtin_module_names:
            chk("sig: встроенный модуль", rc == 0 and "sin(" in o, o + e)
        else:
            chk("sig: скомпилированный модуль честно помечен", rc == 1 and "скомпилирован" in (o + e), o + e)

        rc, o, e = run(G + ["sig", "fakemod"])
        chk("sig: .so честно помечен", rc == 1 and "скомпилирован" in o, o + e)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    if bad:
        print("\nпровалено: " + ", ".join(bad))
        sys.exit(1)
    print("\nвсе проверки пройдены")


# ---------- CLI ----------

def main():
    # --root/--src объявлены с default=SUPPRESS и в главном парсере, и в подкомандах.
    # В Python 3.13+ подкоманда разбирается в отдельный namespace, откуда затем
    # копируются ВСЕ поля, включая дефолты: обычный дефолт подкоманды затёр бы
    # значение, заданное до команды. С SUPPRESS поле появляется, только если опция
    # реально указана; недостающие значения по умолчанию проставляем после разбора.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--root", default=argparse.SUPPRESS)
    common.add_argument("--src", action="append", default=argparse.SUPPRESS)

    ap = argparse.ArgumentParser(prog="te.py", parents=[common], description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest="cmd", required=True)

    g = sp.add_parser("graph", parents=[common])
    g.add_argument("op", choices=["symbol", "deps", "rdeps", "path", "node", "cycles", "stats", "build", "hotspots", "metrics"])
    g.add_argument("args", nargs="*")
    g.add_argument("--depth", type=int, default=None)
    g.add_argument("--top", type=int)
    g.add_argument("--why", action="store_true")
    g.add_argument("--file", default="")
    g.add_argument("--since", default="")
    g.add_argument("--max-commits", type=int, default=2000)

    o = sp.add_parser("outline", parents=[common])
    o.add_argument("file")
    o.add_argument("--docs", action="store_true")

    s = sp.add_parser("search", parents=[common])
    s.add_argument("query")
    s.add_argument("--ext", default=".py")
    s.add_argument("--re", action="store_true")
    s.add_argument("-i", action="store_true")
    s.add_argument("-l", "--files", action="store_true")
    s.add_argument("--path", default="")
    s.add_argument("--limit", type=int, default=30)

    si = sp.add_parser("sig", parents=[common])
    si.add_argument("target")
    si.add_argument("--doc", action="store_true")

    sp.add_parser("info", parents=[common])

    sp.add_parser("selftest", parents=[common])

    a = ap.parse_args()
    if a.cmd == "graph" and a.depth is None:
        a.depth = 2 if a.op == "metrics" else 1
    if a.cmd == "graph" and a.op == "hotspots" and a.top is None:
        a.top = 15
    a.root = getattr(a, "root", ".")  # SUPPRESS не кладёт дефолты в namespace — ставим сами
    a.src = getattr(a, "src", None)
    try:
        a.root = project_root(a.root)
        {"graph": cmd_graph, "outline": cmd_outline, "search": cmd_search,
         "sig": cmd_sig, "info": cmd_info, "selftest": cmd_selftest}[a.cmd](a)
        sys.stdout.flush()
    except BrokenPipeError:  # читатель закрыл канал (например, `| head`) — это не ошибка
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
    except Exception as e:  # одна строка вместо traceback; TE_DEBUG=1 — показать целиком
        if os.environ.get("TE_DEBUG"):
            raise
        fail(f"внутренняя ошибка ({type(e).__name__}): {e}")


if __name__ == "__main__":
    main()