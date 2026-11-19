# token-economy-ts

[Русская версия](README.ru.md)

Token-saving skill.

The skill is designed for agent CLIs (ZCode, Kilo Code): the section at the very beginning of SKILL.md bounded by `---` is mandatory — without it the agent will not see the skill.

The scripts run under Node.js and add no new npm dependencies. Supported: `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, ESM and CommonJS; `.vue` SFC files are not indexed. The React gate checks the major of the spec in package.json (≥ 16 or unrecognized); `graph op=component` shows JSX usages regardless of projectType. The Angular gate and projectType detection have differences described in SKILL.md.

## File metrics

`graph op=metrics` — metrics of the static file graph, not a symbol-level/full runtime call graph, and not a guarantee of edit risk. It counts all existing internal links with the previous `root`/`specs` and filters (including template/style) and does not add external endpoints.

```text
node "<SCRIPTS_DIR>\graph-tool.js" op=metrics file=src/db.ts depth=2
node "<SCRIPTS_DIR>\graph-tool.js" op=metrics top=15
node "<SCRIPTS_DIR>\graph-tool.js" op=metrics file=src/db.ts json=1
```

`file` **or** `top` (not both); `top` is a positive safe integer, default 15, with neither given also top-15. `depth` is a strict integer 1..5, default 2 for metrics only (`deps`/`rdeps` stay 1). `fan_in/out` — unique project neighbors; `dependents` — backward reachability up to depth; `impact` — the entire backward reachability without a limit, root excluded. PageRank — 20 iterations, damping 0.85, uniform dangling mass; percentile — midrank `(less + halfEqual)/N*100`, printed as rounded `pN`. Top: fan_in desc, pagerank desc, stable path asc.

The text output exists only for the new operation: `src/db.ts  fan-in 12 (p95)  fan-out 4  dependents(2) 27  impact 41  pagerank 0.0132 (p95)`. `json=1` via emit returns `{perFile:[{id,path,fan_in,fan_out,dependents,impact,pagerank,percentile:{fan_in,pagerank},depth}],total,cycles,depth,empty,scope,completeness,file?}`; total, percentile and PageRank refer to the whole graph, perFile — the target or top. Unknown file/bad arguments — JSON error/exit1 with `completeness.complete=false` and a stats hint for the file; ambiguous — JSON/exit0. Batch is always JSON (metrics included), `compact=1` encodes `perFile[].path` in a shared `paths` dictionary. An empty graph prints the path to `graph-deps.json`, cycles — `циклов: N (op=cycles)`, incompleteness — a warning. The full contract is in SKILL.md.

The JavaScript checks and TypeScript regressions live in the agent-skills repository, in `tests/token-economy-ts/`; they are not part of the skill itself. Run from the repository root:

```text
node --test tests/token-economy-ts/files.test.js
node --test tests/token-economy-ts/symbols.test.js
node --test tests/token-economy-ts/graph.test.js
node --test tests/token-economy-ts/search.test.js
node --test tests/token-economy-ts/ranges.test.js
node --test tests/token-economy-ts/angular.test.js
node --test tests/token-economy-ts/react-detect.test.js
node --test tests/token-economy-ts/react-component.test.js
node --test tests/token-economy-ts/ref-corpus.test.js
node --test tests/token-economy-ts/ref-read.test.js
node --test tests/token-economy-ts/edit-docs.test.js
node --test tests/token-economy-ts/hotspots.test.js
node --test tests/token-economy-ts/metrics.test.js
```

The whole set at once at the end:

```text
node --test tests/token-economy-ts/files.test.js tests/token-economy-ts/symbols.test.js tests/token-economy-ts/graph.test.js tests/token-economy-ts/search.test.js tests/token-economy-ts/ranges.test.js tests/token-economy-ts/angular.test.js tests/token-economy-ts/react-detect.test.js tests/token-economy-ts/react-component.test.js tests/token-economy-ts/ref-corpus.test.js tests/token-economy-ts/ref-read.test.js tests/token-economy-ts/edit-docs.test.js tests/token-economy-ts/hotspots.test.js tests/token-economy-ts/metrics.test.js
```

The tests create and delete their own temporary projects; `edit_symbol` in auto mode may load an already installed TypeScript (including one found from the script directory). `npm install` is not needed. The existing suites also cover signatures (`symbols.test.js`), realpath/junction confinement, root exports, missing-dependency fallback, Unicode, Windows case handling, phantoms from comments/templates, JSON completeness and two chains of 6200 files (linear and closed).

The built-in self-check of the skill:

```text
node skills/token-economy-ts/scripts/graph-tool.js op=selftest
```

Git signals «where it hurts» (a top table or one file):

```text
node skills/token-economy-ts/scripts/graph-tool.js op=hotspots top=10
node skills/token-economy-ts/scripts/graph-tool.js op=hotspots file=src/merge.ts since=90d
```

Before the first command read `references/typescript.md`, then run `graph op=info` once in the current project. The project type is detected automatically (`projectType`: `angular` / `react` / `nest` / `node` / `ts` — by angular.json, `@angular/core`, `react` (>= 16), `@nestjs/*`, server packages in package.json). The universal rules are in SKILL.md; after info read `references/angular.md` when `projectType=angular` or `references/react.md` when `projectType=react`. Before `selector`/`generate` read the Angular profile, before `component` — the React profile regardless of the type: the commands have separate gates. Look for component/directive selectors via `selector`, pipes by name and style symbols via `symbol`.

`requests_file` in all four CLIs — UTF-8 JSON in a regular file inside cwd by lexical and realpath boundaries; `root=` does not change this boundary. Internal links and a root junction are supported, external/dangling links, directories and traversal are rejected before batch. Concurrent substitution of ancestors is not excluded. `symbol` keeps all overloads and implementations with separate spans/owners; the JSX index of `component` excludes `.ts` while keeping `.tsx/.jsx` and JS. Structural batch errors of `deps/rdeps/path/metrics` keep scope/completeness even when a scope group fails, also with `compact=1`.

Compact forms and batch requests (all opt-in, the legacy output unchanged): search — `word=1`, `format=grouped|runs` (with `pathPrefix`), `context=N`, batch via `requests`/`requests_file`; outline — `compact=1` and batch; sig — literal whitespace preserved, `full=1`, clipping diagnostics, `offset` and batch (`full` is common, traversal limits stay); graph — declaration and body ranges in `symbol`/`node`, `op=read` via `file+ranges` or `ref=файл:N-M`, `format=table` for deps/rdeps, `node` pagination, batch and, batch-only, `compact=1` (a path dictionary). Reversibility is checked by the decoders in `search.test.js` and `ranges.test.js`; refs — in `ref-corpus.test.js`/`ref-read.test.js`. The graph cache checks sources by mtime/size, not by hash; sig uses no shared read/parse cache.

Skill scripts:

| Action | What it does | Savings                                  |
|---|---|-------------------------------------------|
| `search` | `code-searcher.js` — matches: file, line, short snippet | does not read the found files in full |
| `graph` | `graph-tool.js` — where a symbol is defined, who uses a file, link chains, range reading, React components | navigation answers instead of files in context; `read` returns the requested lines |
| `graph op=metrics` | file fan-in/out, dependents, impact, PageRank and percentile | coupling and the area to check without listing all dependent files |
| `outline` | `symbol-index.js` — a file outline with line numbers | instead of the whole file |
| `sig` | `sig-reader.js` — library signatures from `node_modules` | without reading `.d.ts` |
| `edit_symbol` | `edit-symbol.js` — replacing a function or method body | an edit without reading the file into context |
| `generate` | `scaffold-helper.js` — Angular entities via the local CLI | a short list of created files |
