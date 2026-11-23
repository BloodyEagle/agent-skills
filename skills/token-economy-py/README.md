# token-economy-py

[Русская версия](README.ru.md)

A skill for any agent with a terminal: it saves tokens when working with Python projects. Instead of reading whole files and library sources, the agent calls the `te.py` script and gets a short text answer: where a function is defined, who imports a module, the outline of a large file, the signature of a function from an installed library.

Rules for the agent and the command table — in `SKILL.md`. The graph design and detailed limitations — in `references/graph.md`.

## Requirements

- **Python 3.9 or newer.** The script uses `ast.unparse` (3.9+) and `end_lineno` (3.8+). Tested on Python 3.12.
- **Standard library only.** No pip packages, no network.
- **Git** is optional. With it the file list comes from `git ls-files` (`.gitignore` respected), without it — directory traversal excluding virtual environments and caches.
- **Run** the trusted script by absolute path: `python -I -B "<SCRIPTS_DIR>\te.py" … --root ПУТЬ`. `-I` excludes the script directory and cwd from the import search, `-B` prevents bytecode writing. For an untrusted project keep cwd outside its directory. On Windows call `python`, not `python3`.
- **For `sig`** the package in question must be installed in the interpreter running the script, or in the project's `.venv` / `venv` / `env` (picked up automatically).
- **Permissions:** analysis operations write the cache only into the `.token-economy` folder in the project root (it contains a `.gitignore` with a single asterisk). `selftest` separately creates and deletes a synthetic project in a temp directory. The project's Python sources and library code are read by the analyzer, never executed; for modules from `sys.builtin_module_names` `sig` uses import and `inspect`.

## Install

Copy the `token-economy-py` folder into the agent's skills directory:

    globally in ZCode:      %USERPROFILE%\.zcode\skills\token-economy-py
    globally in Kilo Code:  %USERPROFILE%\.kilocode\skills\token-economy-py
    locally in a repo:      .zcode\skills\token-economy-py (ZCode) or .kilo\skills\token-economy-py (Kilo Code)
    Linux and macOS:        ~/.config/kilo/skills/token-economy-py

Layout:

    token-economy-py/
      SKILL.md                rules and commands for the agent
      README.md               this file (English)
      README.ru.md            Russian version
      references/graph.md     graph design, link kinds, limitations
      scripts/
        te.py                 the single script: graph, outline, search, sig, info

Manual check: `python -I -B "<SCRIPTS_DIR>\te.py" graph stats --root ПУТЬ` prints the number of files and links, the most imported modules, runnable scripts and external packages. `<SCRIPTS_DIR>` is the absolute path to the `scripts` directory of the installed skill. Git signals of «where it hurts»: `python -I -B "<SCRIPTS_DIR>\te.py" graph hotspots --top 10` (or `--file ПУТЬ` — one file with personal percentile labels; the output format matches `op=hotspots` of token-economy-ts).

## What it does

| Task | Command |
|---|---|
| Where a class, function, method or constant is defined (`Engine`, `Engine.run`, `app.models.User`) | `graph symbol` |
| What a file imports, who imports a file (with `--depth`), the chain between two files | `graph deps`, `graph rdeps`, `graph path` |
| Per-file summary, cyclic imports, project overview | `graph node`, `graph cycles`, `graph stats` |
| Where it hurts by git history: commits, churn, bugfixes, authors, percentiles | `graph hotspots` (`--top`, `--file`, `--since`, `--max-commits`) |
| File coupling and impact area: fan-in/out, dependents, impact, PageRank, percentile | `graph metrics` |
| File outline with line ranges (`L126-160`), decorators and signatures | `outline` (`--docs` adds the first docstring paragraph) |
| Substring or regex search, results grouped by file | `search` (`--ext`, `--re`, `-i`, `--path`, `--limit`) |
| Signature, docstring and source path of a function or class from the stdlib and installed packages | `sig` (`--doc` — full docstring, up to 1500 chars) |
| Project passport: python, dependencies, file composition and largest files | `info` |

## File metrics

```text
python -I -B "<SCRIPTS_DIR>\te.py" graph metrics src/app/core.py --depth 2
python -I -B "<SCRIPTS_DIR>\te.py" graph metrics --top 15
```

Positional `file` **or** `--top` (not both); top is a positive safe integer, default 15, with neither given also top-15. `--depth` is a strict integer 1..5, default 2 for metrics only (`deps`/`rdeps` stay 1). `fan_in/out` — unique project neighbors; `dependents` — backward reachability up to depth; `impact` — the entire backward reachability without a limit, root excluded. PageRank — 20 iterations, damping 0.85, uniform dangling mass; percentile — midrank `(less + halfEqual)/N*100`, printed as rounded `pN`. Top: fan_in desc, pagerank desc, stable path asc.

Metrics is a stdlib port inside `te.py`, no Node.js/metrics.js; numeric parity with JS is checked with a 1e-9 tolerance. The CLI prints plain LF text (not JSON), including `dependents(2)` and `impact`. All existing internal links are counted, **including lazy/types**, with the previous `--root`/`--src` filters; external endpoints are not added. The `циклов: N` number here may differ from `graph cycles`, which stays runtime-only. This is a static file graph, not a symbol-level/full runtime call graph and not a guarantee of edit risk. Unknown target — exit1 with the `op=stats` hint (the `graph stats` command); an empty graph prints `.token-economy/graph.json`; the cyclic hint `op=cycles` refers to the existing `graph cycles` command with its runtime-only filter. Warmed graph/AST caches are not touched. The full contract is in SKILL.md.

## Metrics regression tests

From the repository root: `node --test tests/token-economy-py/metrics.test.js`. Node is needed only by the test runner, not by the skill itself. It checks the formulas, JS parity at 1e-9, LF text, the CLI, lazy/types, arguments and the immutability of the warmed cache.

Graph links come in three kinds: a static import at module load, a lazy import inside a function (`(lazy)`) and a static import under `TYPE_CHECKING` outside functions (`(types)`). Recognized dynamic calls are always marked `(lazy)`, even at module level. Only runtime edges participate in `graph cycles`: cycles through lazy/types are not shown by that operation; `graph metrics` counts all three kinds. Files are marked `[test]`, `[script]` (has `__main__`) and `[package]`, and `rdeps` shows the tests that statically import the module being changed.

`sig` does not import Python code: it finds the source file via `sys.path`, the project and the virtual environment and parses it with `ast`. It follows re-exports (`from .api import get`), star imports, module aliases (`os.path`) and base classes given by a simple name (including imported ones). For modules from `sys.builtin_module_names` it uses import and `inspect`.

Savings examples: the outline of `subprocess.py` (88 KB, 2216 lines) takes about 4.6 KB, i.e. about 5% of the file; the signature of `subprocess.run` — about 230 bytes. Speed: on the Python 3.12 standard library (572 files) the first graph build takes about 2.5 s, a repeated query about 0.09 s.

## What the script does not see

- **Dynamic imports** with a non-constant or relative first argument are not counted. String constants in `importlib.import_module("pkg.mod")`, `__import__("pkg.mod")` and bare `import_module("pkg.mod")` are recognized; name binding is not checked. All such edges are `(lazy)`, including module-level calls. Details — `references/graph.md`.
- **Attributes created at runtime:** `sig` will not find them; lazy modules via `__getattr__` are not supported.
- **Registration via decorators and configuration** (Flask and FastAPI routes, plugins via entry points): no link until there is an explicit import.
- **Nested functions and class attributes:** `symbol` covers classes, functions, methods, module-level variables and constants; local functions and instance attributes are not included.
- **Compiled modules** (`.so`, `.pyd`): they have no sources, `sig` will report that.
- **Other files:** `.pyi`, Jupyter notebooks, configs and templates are not in the graph (use `search` with `--ext` for them).
- **`from x import *`:** the link is made to module `x`, not to individual names.

## Notes

- **Package roots.** The project itself and `src/` (if present) are the roots. Other roots are set by `--src FOLDER` (repeatable); pass it on every call, otherwise imports of those packages count as external.
- **Editing files.** The skill has no edit operations: use the agent's native tool. For a file longer than 50 lines with an edit under 30%, do not rewrite the whole file.
- **Search.** By default `.py`, up to 30 matched lines (`--limit` changes the number of lines, not occurrences); snippets are cut around the first match to 120 characters of content plus `…` markers; the line-number prefix does not count into this limit. `-l`/`--files` lists up to 500 files and ignores `--limit`. `graph`/`search` skip files larger than 1 000 000 bytes, and `search` also skips a file with a NUL byte in the first 2048 bytes.
- **Encodings.** The outline and the graph read files as bytes (the PEP 263 encoding declaration is respected), while `search` decodes files as UTF-8, on failure tries cp1251 and only then replaces unreadable characters: in cp1251 files Cyrillic is found and printed correctly, in more exotic encodings it may be distorted.
- **Which interpreter.** `sig` looks for packages in the `sys.path` of the Python that ran the script, plus the project's `.venv`, `venv` and `env`. If dependencies live in an environment with another name, run the script with its interpreter.
- **Built-in modules** from `sys.builtin_module_names`: for them `sig` imports the module and takes the description via `inspect`. `math` can be built-in or a compiled extension — it depends on the Python build; in the latter case the signature is unavailable.
- **`.pyi` in `sig`.** Stubs are used for submodules and `__init__`; a neighboring `.py` wins. A top-level module or package available only as `.pyi` is not found.
- **Python versions below 3.10.** The set of standard modules is determined via `sys.stdlib_module_names`; 3.9 lacks it, and the list is approximately reconstructed from `sys.builtin_module_names` and the contents of the standard library directory.
- **Cache.** The `.token-economy` folder excludes itself from git on its own. Internal/external symlink/junction of this folder, links to cache files (including dangling and hard links) and links to `.gitignore` are rejected before read/write; links to sources and a root junction are still allowed. The graph, AST cache, Python hotspots and `.gitignore` are published through a unique exclusive tmp in the verified real cache directory; fixed `*.tmp` files are not touched. A failure before publication keeps the previous cache file and source bytes; no crash-safe transaction or protection from hostile concurrent ancestor substitution is promised. Freshness is determined by the file list, mtime_ns, size and alias paths, not by content hash. The graph is rebuilt on a detected change; only files with changed mtime_ns/size are re-parsed. `graph build` recomputes links but reuses the AST of unchanged files from cache.
- **Verification.** The skill was tested on test projects and on the Python 3.12 standard library on Linux. Python 3.9 and Windows were not tested: before using it, run `graph stats` and `outline` on your project and compare the result with the code.

## CodeGraph nearby

With a project index (`.codegraph/`) and `info` reporting `available=true` and `index=true` in `integrations.codegraph`, structural questions go first to `"<absolute-path-from-integrations.codegraph.executable>" explore "<question>"`: use the returned absolute path, not bare `codegraph`. What CodeGraph lacks stays with the skill: `sig`, body replacement, generation, `outline`, exact text `search`, precise ranges via `graph op=read` and the project passport via `info`. Coordinates for edits are not taken from the explore output; on a miss or error fall back to the regular path once; `codegraph index`/`init` is never run without an explicit request. The full CodeGraph bridge rule is in SKILL.md.

`integrations.codegraph` preserves `available`, `cli_version`, `index`, `db_path`, `reason` and adds absolute full-path `executable`, `source` (`path` or `home`) and nullable `hint`. Lookup checks `PATH` first; only if no candidate exists does it check home `.local/bin` (`os.homedir()` in JavaScript, `os.path.expanduser('~')` in Python). Names: `codegraph.cmd`, `codegraph.bat`, `codegraph.exe` on Windows; `codegraph` on POSIX. A broken `PATH` candidate is not masked. Selected `executable`/`source` survive a failed version probe; `hint` is populated only after a successful home probe. Detection only runs `version` with a 2 s timeout: no `index`/`init`, database-content reads or detection cache. No CLI means `reason=not_installed`; no index means `reason=no_index`: use the regular skill workflow, not structural `explore`.

With `available=true` and `index=true`, a home CLI works immediately even outside `PATH`. Agents must show a non-null `hint` in the conversation's language, translating it when needed. It explains optional manual home `.local/bin` addition to `PATH` and a full application restart for new terminals. No automatic changes to process/user `PATH`, profiles or the registry.

| Question | First tool |
|---|---|
| How does X work, who calls Y, what does a change affect | `"<absolute-path-from-integrations.codegraph.executable>" explore "<question>"` |
| Exact lines to edit or quote | `graph op=read` / Read |
| Third-party API signatures | `sig` |
| Exact text occurrences | `search` |
| Project passport and CodeGraph detection | `op=info` → `integrations.codegraph` |
