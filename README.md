# A collection of useful tools for AI agents

[Русская версия](README.ru.md)

A set of tools that reduce the amount of code and data reaching the model's context. Instead of "read the whole file" — one command that answers a specific question with a short text: where is it defined, who uses it, what is slow, how big it is, where the error is.

The analysis scripts run locally and require no installation of their own dependencies — the directory is copied as a whole. Network actions are explicit: `skills.js check --manifest URL` downloads a manifest, and `automateskill` works with GitHub and Git when preparing and executing plans.

---

## What's inside

| Section | Purpose |
|---|---|
| [`skills/`](skills) | seven skills: six `token-economy-*` — one per language or data format — and `automateskill` |
| [`rules/`](rules) | common rules and the project passport; the stack rules live inside the skills themselves |
| [`docker-images/`](docker-images) | `docker-compose` for helper services (Hindsight) |
| [`tests/`](tests) | checks for the skills: self-tests and fixtures |

---

## Skills

All five token-economy skills share one optional bridge to [CodeGraph](https://github.com/colbymchenry/codegraph). If the project has a CodeGraph index (`.codegraph/`) and its CLI is on `PATH`, `op=info` reports it in `integrations.codegraph` (`available`, `cli_version`, `index`, `db_path`, `reason`). When it is available, structural questions — "how does X work", "who calls Y", "what does a change to Z affect" — go to `codegraph explore` first, while `sig`, `edit_symbol`, `generate`, `outline`, exact-text `search` and precise ranges (`graph op=read`) stay with the skill. CodeGraph is never required: no index or no CLI means the skills behave exactly as before. Detection runs `codegraph version` with a 2 s timeout and never runs `index`/`init`, reads the database, or caches the verdict.

### token-economy-ts — TypeScript / JavaScript / Angular

**Docs:** [skills/token-economy-ts/README.md](skills/token-economy-ts/README.md)

A mandatory skill for TypeScript, JavaScript and Angular projects: it replaces the built-in search and manual file reading. Supports React, Node.js, Express/Fastify/Koa, NestJS and the JS/TS files of Vue projects, ESM and CommonJS (`require`, `module.exports`); `.vue` SFC files are not parsed. Angular commands apply only when Angular is present.

- `search` — find text or a regex across the project, with an extension filter; batch — `requests=`/`requests_file=`;
- `graph symbol` — where a class, pipe, `$` variable or mixin is declared; `graph selector` — Angular selectors only;
- `graph deps` / `graph rdeps` / `graph path` — what a file uses, who uses it, link chains;
- `graph op=metrics` — file fan-in/out, local dependents, full impact, PageRank and percentile; a single answer is text, `json=1` and batch are JSON;
- `graph op=read` — reading several ranges of one file in one call (instead of a series of Reads); since 1.4.0 also the ready locator `ref=файл:N-M` or `ref=файл#LN-LM`. Without a range `ref=файл` reads only a file under 300 lines and within 1 MiB; Git refs are not read;
- `outline` — the outline of a TS/JS file, including JSX: instead of 800 lines — a list of symbols with numbers; `compact=1` gives `L<start>-<end>` ranges, `node` pages through the outline of large files;
- `sig` — signatures of third-party library functions and methods without reading their sources;
- `graph op=component` — where a React component is declared and where it is used in JSX (needs `react` ≥ 16); the React project rules — `references/react.md`;
- `edit_symbol` — replacing a method or function body by name, without rewriting the file;
- `graph hotspots` — git signals of "where it hurts": commits, churn, bugfixes, authors and p50/p90/p97 percentiles per file; the cache is validated against HEAD without running git;
- `generate` — creating Angular entities via the CLI.

All read commands (`graph`, `search`, `outline`, `sig`) support batch mode: one call — many requests, and `graph` does one graph pass per scope group (`metrics` included, `hotspots` not in batch). Compact outputs: `graph` — `compact=1` in batch (a path dictionary) and `format=table` for deps/rdeps, `search` — `format=grouped`/`runs`, `outline` — `compact=1`.

Requires Node.js. Before the first command read `references/typescript.md`, then run `graph op=info` in the root of the analyzed project. The profile `references/angular.md` / `references/react.md` are read after the corresponding type is determined or before the profile operation by its separate gate. The scripts in the `scripts/` directory: `code-searcher.js` (search), `graph-tool.js` (graph), `symbol-index.js` (outline), `sig-reader.js` (sig), `edit-symbol.js` (edit_symbol), `scaffold-helper.js` (generate).

### token-economy-py — Python

**Docs:** [skills/token-economy-py/README.md](skills/token-economy-py/README.md)

One script `te.py` on the standard library (Python 3.9+):

- `info` — the project passport in one call: Python version, dependencies, composition, largest files;
- `graph build` — a forced graph refresh;
- `graph` — who imports a module, which tests an edit will affect;
- `graph hotspots` — "where it hurts" by git history: commits, churn, bugfixes, authors, percentiles; the output format matches ts;
- `graph metrics` — file metrics over all internal imports, including lazy/types; a stdlib port without Node.js, LF text;
- `outline` — the outline of a large file;
- `search` — text across the project;
- `sig` — the signature of a function from an installed library without reading its sources.

Run: `python -I -B "<SCRIPTS_DIR>/te.py" …` from the project root; `<SCRIPTS_DIR>` — the absolute path to the trusted installed copy of the skill. Otherwise pass `--root ПУТЬ`. On Windows — `python`, not `python3`.

### token-economy-php — PHP

**Docs:** [skills/token-economy-php/README.md](skills/token-economy-php/README.md)

The `bx.js` script, four modes chosen by the project contents:

- **universal** — definition search, class and function graph, outlines, safe reading and editing of `cp1251` files;
- **1C-Bitrix** — components, events, language messages, table schema, routes via `urlrewrite.php` and physical files (not the D7 Router), the legacy API and D7;
- **Laravel 8–13** — routes, Eloquent models, container bindings, Blade, commands and the schedule;
- **MODX** (Revolution and Evolution) — file-based elements, template tags.

In all modes — `hotspots`: git signals of "where it hurts" (commits, churn, bugfixes, authors, percentiles); in Bitrix the `bitrix/modules` and `upload` directories relative to the detected docroot (`www/`, `public/` etc.) are not counted, the user's `local/modules` is kept.

`op=metrics` — file metrics in all four modes; all existing link kinds, user modules and the previous core/vendor/cache filters are kept.

### token-economy-java — Java 17+ / Spring Boot 3+

**Docs:** [skills/token-economy-java/README.md](skills/token-economy-java/README.md)

The `jv.js` script:

- definition search, class outline, interface implementations;
- link graph: inheritance, dependency injection, usage;
- `op=metrics` — file coupling, dependents/impact, PageRank and percentile;
- HTTP endpoints and beans, configuration with secret masking;
- JPA entities, repositories, a static catalog of tables and migration fragments (not the final DB schema after migrations);
- event and queue listeners;
- signatures of classes from `jar` without decompilation;
- `hotspots` — git signals of "where it hurts": commits, churn, bugfixes, authors, percentiles.

### token-economy-kt — Kotlin / Android

**Docs:** [skills/token-economy-kt/README.md](skills/token-economy-kt/README.md)

The `kt.js` script for projects on Jetpack Compose and XML Views, with Java interop:

- link graph: inheritance, Hilt/Dagger, Compose function calls, ViewBinding;
- `op=metrics` — file metrics of Kotlin/Java sources and XML manifests/layouts/navigation/values;
- manifest: components, permissions, intent filters, deep links, `exported` warnings;
- Room: entities, tables, SQL DAO methods;
- DI graph: modules, `@Provides`/`@Binds`, where a type is bound and who receives it;
- navigation: Compose and `nav-xml` routes, who navigates where;
- string resources by locale and missing translations;
- a catalog of Retrofit endpoints, Gradle configuration and version catalog analysis without running a build, resources and layout files;
- signatures of classes from `jar` and `aar` without decompilation;
- `hotspots` — git signals of "where it hurts": commits, churn, bugfixes, authors, percentiles.

The Java/Kotlin links are built by static heuristics: this is not resolution of all runtime calls, the Spring context, DI bindings or the result of the Android resource merger.

### The shared metrics contract

For the five language skills: a single `file` target **or** a `top` rating (a positive safe integer ≤ 9007199254740991, default 15; with neither target nor top — top-15); in Python the target is positional, top is `--top`. `depth` is an integer 1..5, default 2 **for metrics only**, the other operations keep their previous defaults.

`fan_in/out` counts unique project-file neighbors; `dependents(depth)` — backward reachability up to depth, `impact` — all unique backward reachability **without a depth limit**, the root excluded. PageRank: 20 iterations, damping 0.85, uniform dangling mass. Percentile: midrank `(less + halfEqual)/N*100`, the text rounds to `pN`. Top: fan_in desc, pagerank desc, stable path asc. Fields of the machine object: `fan_in`, `fan_out`, `dependents`, `impact`, `pagerank`, `percentile:{fan_in,pagerank}`, `depth`.

This is a static **file** graph, not a symbol-level or full runtime call graph; the metrics do not guarantee edit risk or safety. All existing internal link kinds and filters are kept, external endpoints are not added. TS single metrics prints text by default; `json=1` — `{perFile:[],total,cycles,depth,empty,scope,completeness,file?}` via emit, total/percentile/PageRank are computed on the full graph; batch is always JSON, compact encodes `perFile[].path` in a shared `paths`. TS errors and ambiguity stay JSON. Python is a stdlib port without Node.js/metrics.js, parity with JS at 1e-9 and LF text; metrics counts lazy/types, whereas `graph cycles` stays runtime-only. KT/Java/PHP show the cycle count without a hint for the nonexistent `op=cycles`. An empty graph prints the cache path, an unknown target — an error and a stats hint. Warmed graph/parse caches are not touched; a cold start legitimately builds the graph.

The four JS copies of `scripts/lib/metrics.js` (TS/KT/Java/PHP) must match byte for byte; Python is a port, not a fifth copy. `tests/metrics-copies.test.js` checks the SHA256 and identical formula tests; numeric parity of Python is checked by its own suite. Versions and the manifest are updated with the regular `skills.js bump` when releasing changes.

### token-economy-har — parsing captured network traffic

**Docs:** [skills/token-economy-har/README.md](skills/token-economy-har/README.md)

The `har.js` script (Node.js ≥ 18, no dependencies) for `.har` files that must not be opened in context: a 30–40 MB capture can take millions of tokens because of the captured response bodies and metadata. A body in HAR is stored as text or base64; base64 by itself does not mean compression.

- `info` — a summary: requests, pages, volume, p50/p95/p99 times, statuses, methods, domains, types;
- `domains` — grouping by domain with sorting by volume, request count or time;
- `slow` — the slowest with a phase breakdown (`blocked`, `dns`, `connect`, `ssl`, `send`, `wait`, `receive`);
- `errors` — statuses ≥ 400, interruptions, timeouts, empty responses;
- `content` — what weighs: categories and MIME, compressed vs uncompressed;
- `dup` — duplicates and near-duplicates by exact URL, normalized and by body hash;
- `search`, `entry` — selection and a single record with a body (only on explicit request and capped);
- `waterfall`, `diff` — starts and durations, comparison of two captures;
- `redact` — scrub `Authorization`, `Cookie` and tokens before handing the file over.

All commands support `--json`. For repetitive structures `--json --compact` returns a self-contained `har-compact-v1` only when it is shorter than the plain JSON; short and diagnostic answers stay in the legacy form. Lossless means reversibility relative to the already capped legacy JSON of the command, not preservation of the whole original HAR.

### automateskill — deferred tasks from a free-form description (ZCode only)

**Docs:** [skills/automateskill/README.md](skills/automateskill/README.md)

The only skill of the set without scripts: all the logic is an instruction to the agent. Works **only in ZCode**: it relies on `CronCreate` (persistent scheduled automations), `ListModels` and subagents from `.zcode/agents/` with models of the form `provider/model$level`. In other agents (Claude Code, Kilo Code, Codex, Gemini CLI) the skill will load but cannot execute the steps.

The user describes the task in one message ("at 03:00 in repository X analyze the code with model Y, write a fix plan, then execute it with model Z in branch Q and push"), the skill:

- extracts the schedule, target repository, executor models, branch; for a one-shot absolute time it agrees on a future calendar date in the local timezone; asks for what is missing; checks the named models for availability via the host's model list — an unavailable or unnamed model is shown as a full list for selection;
- before publishing the plan requires a confirmed `main` at the runner and the target and a compatible executor contract; it does not silently substitute another base branch — it stops and asks;
- checks push rights; on authorization problems asks the user to set up access (`gh auth login` / Git Credential Manager) and repeats the check; on confirmed absence of rights it offers a fork and creates it only after consent;
- writes a plan with frontmatter (`repo`/`repo-path`, `executor`, `branch`) into `tasks/input/<slug>/` of the runner repository `automatization`; the absence of overlaps with other automations is verified by their prompts, not assumed from the folder name;
- creates a dedicated `CronCreate` automation for the specified time: a relative delay — `delayMinutes`, "every N" intervals — `intervalUnit` + `interval`, a calendar schedule — a local `cron`; the executors are subagents from the `.zcode/agents` pool on the chosen models (a model outside the pool — the skill offers to create a new agent); the fallback is chosen explicitly per executor and may be absent: with it up to 6 attempts, without it — one attempt, regardless of the number of phases; per-item commits, a report into `tasks/done`, archiving, merge into `main` and push are provided by the executor definition, which must be checked in advance;
- plans can spawn further plans: the chain "analysis → fix plan → execution" runs in one launch (up to 10 plans per launch).

The plan and automation prompt templates — `references/plan-template.md` and `references/automation-prompt.md`.

---

## rules — rules for the agent

`rules/` contains three files: `RULES.md` (common rules), `project-passport.md` (the project passport) and `hindsight.md` (working with external memory). The stack rules live in the skill directories themselves and arrive with them: `skills/token-economy-ts/references/typescript.md` (+ `references/angular.md`), `skills/token-economy-php/references/php.md`, `skills/token-economy-java/references/java.md`, `skills/token-economy-py/references/python.md`, `skills/token-economy-kt/references/kotlin.md`.

## docker-images

`docker-images/hindsight/docker-compose.yml` — a compose file for a local Hindsight memory server. Copy `.env.example` to `.env` and fill in the provider parameters; `.env` is excluded from Git. Running Docker is not part of the local skill tests.

## mcp

`mcp/mcp.json` — an example Kilo Code configuration, not a universal config and not a mandatory part of the skills. Enable only the servers you need and check the commands before moving them into your client. The `npx` commands download packages from the network; this configuration is not launched automatically.

## Tests

From the repository root, Node.js 20/22 and Python 3.9+ (3.13 in CI), without `npm install`:

```sh
node skills.js verify
node --test
node skills/token-economy-php/scripts/bx.js op=selftest
node skills/token-economy-ts/scripts/graph-tool.js op=selftest
node skills/token-economy-kt/scripts/kt.js op=selftest
node skills/token-economy-java/scripts/jv.js op=selftest
python -I -B skills/token-economy-py/scripts/te.py selftest
node skills.js verify
```

`node --test` finds the CLI suites (`tests/*.test.js`) and the skill suites (`tests/token-economy-*/`), including regressions for paths, encodings and damaged input. For a single check name the file: `node --test tests/check-install.test.js`. Do not pass a directory (`node --test tests/`): that is incompatible with Windows. The tests work in temp directories; symlink checks are explicitly skipped when the OS forbids creating them.

Targeted metrics regressions (one command per skill; from the repository root):

```sh
node --test tests/token-economy-ts/metrics.test.js
node --test tests/token-economy-kt/metrics.test.js
node --test tests/token-economy-java/metrics.test.js
node --test tests/token-economy-php/metrics.test.js
node --test tests/token-economy-py/metrics.test.js
```

The Python skill does not require Node.js; here Node is only the test runner. The suites check the formulas, the text/CLI, errors, cycles and the unchanged SHA of the warmed graph. The check of the four JS copies — `tests/metrics-copies.test.js` at the final stage.

PHP fixtures and golden checks: [`tests/token-economy-php/README.md`](tests/token-economy-php/README.md). The full HAR benchmark runs separately; the bounded 100 MiB scrub regression is part of the regular set. The tests are not part of a skill directory: when copying into an agent only the contents of `skills/<skill>/` are transferred.

---

## Versions and updates

Each skill has a `VERSION` (one line, a canonical numeric triple `X.Y.Z`: no leading zeros, each component a non-negative safe integer) and a `version:` in the `SKILL.md` frontmatter; both lines and the content hash are recorded in `skills/manifest.json`. Prerelease/build metadata is not supported; overflow on bump is rejected before writing. The `skills.js` CLI (Node ≥ 18, no dependencies) answers the question "is what I have installed the same as in the repository, or has it fallen behind?":

    node skills.js check --dir ~/.hermes/skills

| Status | Meaning |
|---|---|
| `актуально` | the version and hash match the manifest |
| `изменён локально` | the version is the same, the files differ from the manifest |
| `устарело (1.2.0 → 1.3.0)` | the repository has a newer version |
| `новее манифеста (1.3.0 > 1.2.0)` | the installed version is newer than the one in the manifest |
| `не установлен` | the skill directory is missing in `--dir` |
| `неизвестно (установлен вручную)` | the directory exists, there is no `.installed.json` — copied without the CLI |
| `неизвестно (битый .installed.json)` | the installation mark is unreadable or contains invalid data |
| `неизвестно (небезопасный каталог установки)` | a non-excluded link is found instead of a regular directory or inside it |

The `устарело` and `новее манифеста` statuses are determined by the version in `.installed.json` before hashing files: they do not confirm the absence of local changes or links inside the installed skill.

Commands:

- `node skills.js install <name> --to PATH` — prepare a copy of the skill and replace the directory `<PATH>/<name>`, writing `.installed.json` (version, hash, date, commit). Reinstalling deletes old and locally added files inside that directory: save the edits you need first. If preparation fails, the previous copy stays untouched; links inside the skill and overlaps with the source are rejected;
- `node skills.js check [--dir PATH] [--manifest ПУТЬ|URL] [--json]` — a table of statuses; without `--manifest` it takes `skills/manifest.json` from this repository, `AGENT_SKILLS_DIR` sets the default installation directory;
- `node skills.js bump <name> <patch|minor|major>` — raise the version of a skill in the repository (VERSION, `version:`, the manifest in one command);
- `node skills.js verify` — repository consistency: `VERSION` = `version:` = the manifest, hashes, the file count and `requires` match; the `description` in the frontmatter is checked after decoding supported YAML, the length unit is Unicode code points, max 1024, a warning above 900; missing/empty/unsupported — an error. This is a local CLI contract, not a confirmation of compatibility with the external loaders ZCode/Claude Code; exit code 1 on a mismatch;
- `node skills.js manifest` — rebuild the manifest from the current `VERSION` (primary population);
- `node skills.js hash <name>` — the hash of a skill directory (for debugging).

`description` supports a single-line plain scalar, single quotes (a doubled apostrophe) and double quotes with YAML escape sequences, as well as the block scalar `|` / `>` with clip/strip/keep (`-` / `+`) and a single indent. Plain null/bool/numeric values do not count as a string description and are rejected; inside quotes they remain text. BOM/CRLF are normalized for parsing. Multi-line plain/quoted, an explicit indent indicator, deeper indentation inside a block, tags/anchors/collections are not guessed: the CLI emits unsupported diagnostics. A Unicode escape must represent a scalar: a non-BMP character is given as the raw character or `\U0001F600`, and surrogate escapes (including pairs `\uD83D\uDE00`) are rejected. The length limits apply to the decoded value, not to quotes, markers or the raw frontmatter.

The `requires` list is derived from file extensions (`node>=18`, `python>=3`), not from analyzing all runtime capabilities: precise minimum versions and the tools of individual operations are listed in the skill documentation.

The manifest carries `schemaVersion: 1`; reading the older format without this field is supported. `manifest` keeps the `updated` date of unchanged skills. `bump` prepares all files before replacing and rolls back what was written on an ordinary I/O error; it is not a transaction protected from power loss. Skill names are lowercase Latin letters, digits, `.`, `_`, `-`, starting with a letter or digit, no trailing dot, no path segments. Python bytecode, `.DS_Store`, `Thumbs.db`, `desktop.ini` and the other exclusions of `lib/hash.js` are not part of the hash or the installation. Loading `--manifest URL` is limited to 10 seconds.

Version bump rules: **patch** — fixes that do not change invocations; **minor** — a new command or flag; **major** — the syntax of existing commands changed. The audit fixes of 2026-11-18 keep the CLI syntax but tighten file security: external batch JSON / PHP `@payload` and links of cache endpoints are no longer accepted; this is a breaking effect for workflows that relied on the previous traversal of the declared boundaries. CI on every PR runs `verify`, all standalone tests and the self-tests on Linux and Windows with Node.js 20/22.

---

## How to connect

1. Copy the needed directory from `skills/` into the agent's skills directory (for example `~/.zcode/skills/` for ZCode or `~/.claude/skills/` for Claude Code; for other clients check their path); the tests from `tests/` are not copied. `automateskill` requires ZCode specifically.
2. Check the path to the scripts: in `SKILL.md` it is denoted `<SCRIPTS_DIR>` or `<SKILL_DIR>` and must point to the skill directory.
3. Put the rules from `rules/` nearby — only `RULES.md`, `project-passport.md` and `hindsight.md` are copied; the stack rules are not copied separately — they are already inside the skill directory in `references/` and arrive with it (including via `skills.js install`).

## Principles

- **One command instead of a file.** The script answers a question instead of handing over a source.
- **Short output.** Lists are cut, the rest goes into `--json` or a file.
- **No mandatory installation of the skill's dependencies.** The scripts use the standard library; individual operations need project tools or packages (Angular CLI, JDK, dependencies for signature reading), they are not installed automatically.
- **Explicit limitations.** `SKILL.md` describes the application area, the command limitations and the order of safe reading and editing; unsupported links and truncated output are not passed off as a full analysis.
