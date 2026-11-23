# token-economy-kt

[Русская версия](README.ru.md)

A skill for the Kilo Code agent: it saves tokens when working with Android projects on Kotlin (Jetpack Compose and XML Views, Java interop). Instead of reading directories and dozens of files, the agent calls the `kt.js` script and gets a short answer: where a class or Compose function is defined, who injects a dependency, what the manifest contains, what a Room database looks like, where an interface is bound in Hilt, who navigates to which route, where a string is localized and where a translation is missing, which endpoints a Retrofit client has, signatures of classes from jar/aar.

Rules for the agent and PowerShell command examples — in `SKILL.md`. The index design, roles, encodings and detailed limitations — in `references/android.md`.

## Requirements

- **Node.js 18 or newer.** Standard library only, no npm packages, no network. The project is never run — everything is parsed by the script's own source analyzer.
- **Project:** Kotlin, Android (Compose and/or XML Views), multi-module Gradle, Kotlin+Java. Without the Android structure, navigation, graph, outline and sig remain; `room`/`di` can work from Kotlin annotations without the manifest. Gradle files and the version catalog are analyzed as text, without running a build and without evaluating all DSL expressions.
- **No build needed:** `gradle`/`gradlew`, `adb`, the emulator and tests are never launched — the user runs the checks.
- **Libraries for `sig`:** already available jar/aar are needed; the script downloads nothing. `jars` — comma-separated directories, `KT_JARS` — separated by the system path separator; relative paths are from cwd. `libs/` of modules and `~/.gradle/caches/modules-2/files-2.1` are searched automatically, not `GRADLE_USER_HOME` and not the Android SDK. For `android.*` pass the directory with `android.jar` explicitly.
- **Run** from the project root or with the `root` parameter (for multi-module — from the repository root).
- **PowerShell:** commands on one line, parameters as argv arguments `key=value`; Cyrillic survives argv. Values with spaces — in single quotes, do not use double quotes inside values. For edits with multi-line values — a parameter file (`@.kt-cache/payload.json`).
- **Permissions:** the index cache is created inside the project root in `.kt-cache` (with a `.gitignore` with a single asterisk inside); `hotspots` separately writes `.git-signals.json` into the root without touching the index. The cache endpoint `.git-signals.json` must be a regular file: internal, external and dangling links are rejected. Publication goes through a unique exclusive tmp in the real root (a root junction is allowed), with no crash-safe transaction or isolation from concurrent ancestor substitution guaranteed. `patch` and `create` modify the given file. The check takes realpath and the Windows case into account. Source traversal skips symlink/junction; targeted `read`/`patch`/`create` allow internal links but reject leaving the root. For `sig` external libraries are read from the explicitly given directories and the Gradle cache.

## Install

Copy the `token-economy-kt` folder into the agent's skills directory:

    globally in ZCode:      %USERPROFILE%\.zcode\skills\token-economy-kt
    globally in Kilo Code:  %USERPROFILE%\.kilocode\skills\token-economy-kt
    locally in a repo:      .zcode\skills\token-economy-kt (ZCode) or .kilo\skills\token-economy-kt (Kilo Code)
    Linux and macOS:        ~/.config/kilo/skills/token-economy-kt

Layout:

    token-economy-kt/
      SKILL.md                rules and commands for the agent
      README.md               this file (English)
      README.ru.md            Russian version
      references/kotlin.md    Kotlin stack rules
      references/android.md   index design, roles, limitations
      scripts/kt.js           entry point, all operations

## What it does

| Task | Operation |
|---|---|
| Project passport: Gradle, modules, AGP/Kotlin/library versions, sdk, compose, composition by role, warnings | `info` |
| Where a class, object, function, Room table, layout, id, string resource or route is defined | `symbol` |
| Outline of a file or class: methods, properties, Compose functions, inject | `outline` |
| Who uses a file, what it uses, link chains, interface implementations | `rdeps`, `deps`, `path`, `node`, `stats`, `impls` |
| Where it hurts by git history: commits, churn, bugfixes, authors, percentiles | `hotspots` |
| File coupling and impact area: fan-in/out, dependents, impact, PageRank, percentile | `metrics` |
| Manifest: components, permissions, intent filters, deep links, exported warnings | `manifest` |
| Room: entities, tables, DAO methods with SQL | `room` |
| DI (Hilt/Dagger): modules, providers, where a type is bound, who receives it | `di` |
| Navigation: Compose and nav-xml routes, who navigates where | `nav` |
| String resources by locale, missing translations | `res` |
| Catalog of Retrofit endpoints with baseUrl | `api` |
| Signatures of classes from jar/aar without decompilation | `sig` |
| Text search with encoding awareness | `search` |
| Reading, editing and creating files keeping cp1251 / UTF-8 / UTF-16LE/BE, BOM and CRLF | `read`, `patch`, `create` |

## File metrics

```text
node "<SCRIPTS_DIR>\kt.js" op=metrics file=app/src/main/java/com/acme/UserDao.kt depth=2
node "<SCRIPTS_DIR>\kt.js" op=metrics top=15
```

`file` **or** `top` (not both); `top` is a positive safe integer, default 15, with neither given also top-15. `depth` is a strict integer 1..5, default 2 for metrics only; `deps`/`rdeps` stay direct. `fan_in/out` — unique project neighbors; `dependents` — backward reachability up to depth; `impact` — the entire backward reachability without a limit, root excluded. PageRank — 20 iterations, damping 0.85, uniform dangling mass; percentile — midrank `(less + halfEqual)/N*100`, printed as rounded `pN`. Top: fan_in desc, pagerank desc, stable path asc.

Kotlin/Java and XML manifests/layouts/navigation/values are counted with the previous filters and all existing link kinds; arbitrary XML/Gradle files and external endpoints are not added. This is a static file graph, not a symbol-level/full runtime call graph and not a guarantee of edit risk. The output is plain text with `dependents(2)` and `impact`; unknown file — exit1 with `op=stats`, an empty graph prints `.kt-cache/index.json`, a cycle — `циклов: N` without an `op=cycles` hint. The warmed index is not touched. The full contract is in SKILL.md.

## Metrics regression tests

From the repository root: `node --test tests/token-economy-kt/metrics.test.js`. The formulas match TS; the CLI, the XML universe, typed deduplication, strict arguments and the immutability of the cache after warm-up are checked.

Graph links: `extends`/`implements`, `inject` (a heuristic over constructors, `@Inject` and immediate `@Provides`/`@Binds` methods), `uses`, `calls` (top-level/Compose functions), `binding` (ViewBinding). This is a file-level graph by names, not import/overload resolution and not a Hilt context. `deps`/`rdeps` show direct neighbors, up to 40 of each kind; for chains — `path`. `outline inherit=true` works only with `name=Class`, not `file=…`.

Check from the root of the analyzed project: `node "<SCRIPTS_DIR>\kt.js" op=info`, where `<SCRIPTS_DIR>` is the absolute path to the installed skill. Git signals of «where it hurts»: `node "<SCRIPTS_DIR>\kt.js" op=hotspots top=10` (or `file=ПУТЬ` — one file with personal percentile labels). `op=selftest` — built-in checks without a project; their number is not a stable contract.

Developer regressions from the repository root: `node --test tests/token-economy-kt/audit.test.js`. Git-signals and CodeGraph-detection regressions: `node --test tests/token-economy-kt/hotspots.test.js tests/token-economy-kt/codegraph.test.js`. The checks run the real CLI in temp projects with a separate HOME, a timeout and a heap limit; real Gradle caches and tracked fixtures are not touched. Creating a file symlink may be unavailable on Windows — that check is marked skipped.

Damaged and unsupported JAR/AAR/.class files are skipped with a warning; if no class was read, a no-match with exit 0 is printed. `sig` picks a version heuristically among the first 30 healthy candidates, not via Gradle dependency resolution; an AAR contains only `classes.jar` for it. `Class#method` filters methods, not fields/constructors. The cache is verified by SHA-256 of content, size and mtime; a change rebuilds the whole index, there is no incremental parsing.

`patch`/`create` write immediately, no dry-run; `patch` is not atomic. UTF-16LE/BE is recognized by BOM. When writing cp1251, non-representable characters are replaced with `?` instead of failing; for new Unicode text choose `enc=utf-8` explicitly. `read` shows 400 lines by default; read large files with `offset`/`limit`. Manifest, Room, DI and resources are static selections, not the result of the manifest/resource merger or of running Android/Gradle.

## CodeGraph nearby

With a project index (`.codegraph/`) and `info` reporting `available=true` and `index=true` in `integrations.codegraph`, structural questions go first to `"<absolute-path-from-integrations.codegraph.executable>" explore "<question>"`: use the returned absolute path, not bare `codegraph`. What CodeGraph lacks stays with the skill: `sig` (class signatures from jar/aar without decompilation), `outline`, exact text `search`, precise ranges via `read`, the project passport via `info`, file edits via `patch`/`create` and the Android operations (`manifest`, `room`, `di`, `nav`, `res`, `api`, `impls`). Coordinates for edits are not taken from the explore output; on a miss or error fall back to the regular path once; `codegraph index`/`init` is never run without an explicit request. The full CodeGraph bridge rule is in SKILL.md.

`integrations.codegraph` preserves `available`, `cli_version`, `index`, `db_path`, `reason` and adds absolute full-path `executable`, `source` (`path` or `home`) and nullable `hint`. Lookup checks `PATH` first; only if no candidate exists does it check home `.local/bin` (`os.homedir()` in JavaScript, `os.path.expanduser('~')` in Python). Names: `codegraph.cmd`, `codegraph.bat`, `codegraph.exe` on Windows; `codegraph` on POSIX. A broken `PATH` candidate is not masked. Selected `executable`/`source` survive a failed version probe; `hint` is populated only after a successful home probe. Detection only runs `version` with a 2 s timeout: no `index`/`init`, database-content reads or detection cache. No CLI means `reason=not_installed`; no index means `reason=no_index`: use the regular skill workflow, not structural `explore`.

With `available=true` and `index=true`, a home CLI works immediately even outside `PATH`. Agents must show a non-null `hint` in the conversation's language, translating it when needed. It explains optional manual home `.local/bin` addition to `PATH` and a full application restart for new terminals. No automatic changes to process/user `PATH`, profiles or the registry.

| Question | First tool |
|---|---|
| How does X work, who calls Y, what does a change affect | `"<absolute-path-from-integrations.codegraph.executable>" explore "<question>"` |
| Exact lines to edit or quote | `op=read` / Read |
| Third-party API signatures | `sig` |
| Exact text occurrences | `search` |
| Project passport and CodeGraph detection | `op=info` → `integrations.codegraph` |
