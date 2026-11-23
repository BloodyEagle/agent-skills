# token-economy-php

[Русская версия](README.ru.md)

A skill for the Kilo Code agent: it saves tokens when working with PHP projects in four modes — universal (any PHP project without a CMS), 1C-Bitrix (the legacy pre-D7 API and D7), Laravel 8–13 and MODX (Revolution/Evolution, file-based elements). Instead of reading directories and dozens of files, the agent calls the `bx.js` script and gets a short answer: where a class is defined, who includes a file, which pages call a component, who handles an event, where a message is defined, which file serves a URL, which routes and models exist in Laravel, who renders what and what is bound in the container, which file-based elements a MODX template calls.

Rules for the agent and PowerShell command examples — in `SKILL.md`. Mode rules and operations, the index design and detailed limitations — in `references/bitrix.md` (Bitrix), `references/laravel.md` (Laravel) and `references/modx.md` (MODX).

## Requirements

- **Node.js 18 or newer.** The checks use `node --test`; no npm packages, no network.
- **PHP is not needed.** Parsing is done by the script's own lexer in `scripts/lib/php.js`, the project is never run.
- **Project:** plain PHP, 1C-Bitrix (legacy API and D7), Laravel 8–13 or MODX Revolution/Evolution (file-based extras; elements in the DB are unavailable). Laravel/Lumen composer packages or a meaningful `artisan` referencing an existing `bootstrap/app.php` are checked first. Then Bitrix: `bitrix/` or `local/` with a typical subdirectory (`components`, `templates`, `modules`, `php_interface`) in the root or docroot (`www`, `public_html`, `httpdocs`, `web`, `public`, `htdocs`, `site`, `docroot`). MODX Revolution — `manager/` + `connectors/` + `core/model/modx` (or `core/src/Revolution`), Evolution — `manager/includes/` + `assets/`. An empty `artisan`, bare `bitrix/`, `local/` and `manager/` do not enable a mode.
- **Git** is optional. With it the file list comes from `git ls-files` (`.gitignore` respected), without it — directory traversal.
- **The Bitrix core** (`bitrix/modules/main`, `iblock`…) in the working folder is needed only for operations with `"core":true`. Without the core in the repository, everything else works.
- **Run** from the project root or with the `root` parameter.
- **PowerShell:** commands on one line, parameters as argv arguments `key=value`; Cyrillic survives argv (node reads the Windows command line through the Unicode API). Values with spaces — in single quotes, do not use double quotes inside values. For edits with multi-line values — a parameter file (`@.bx-cache/payload.json`).
- **Permissions:** the index cache is written into `.bx-cache` in the project root (with a `.gitignore` with a single asterisk inside); `hotspots` separately writes `.git-signals.json` into the root without touching the index. The cache endpoint `.git-signals.json` must be a regular file: internal, external and dangling links are rejected. Publication goes through a unique exclusive tmp in the real root (a root junction is allowed), with no crash-safe transaction or isolation from concurrent ancestor substitution guaranteed. `patch`, `patch_symbol` and `create` also write to the given file. `selftest` separately creates and deletes temp projects. The realpath check rejects leaving via symlink/junction, including missing ancestors. The unique tmp is opened exclusively; `create` does not overwrite a file created concurrently. This is not isolation from a process that swaps parent directories at the same time; `create` requires a file system that supports hard links.

## Install

Copy the `token-economy-php` folder into the agent's skills directory:

    globally in ZCode:      %USERPROFILE%\.zcode\skills\token-economy-php
    globally in Kilo Code:  %USERPROFILE%\.kilocode\skills\token-economy-php
    locally in a repo:      .zcode\skills\token-economy-php (ZCode) or .kilo\skills\token-economy-php (Kilo Code)
    Linux and macOS:        ~/.config/kilo/skills/token-economy-php

Layout:

    token-economy-php/
      SKILL.md                rules and commands for the agent
      README.md               this file (English)
      README.ru.md            Russian version
      references/php.md       PHP stack rules
      references/bitrix.md    index design, limitations, legacy API
      references/laravel.md  design of the Laravel part, limitations
      references/modx.md     MODX file-based elements, limitations
      scripts/
        bx.js                 entry point, all operations
        lib/                  PHP lexer, index, mode detection, Bitrix/Laravel/MODX classification, encodings

Check: `node scripts\bx.js op=info` in the site root prints the site root, the Bitrix version, `utf_mode`, file encodings, templates, custom modules and components; in Laravel — the framework version, the skeleton structure (8–10 or 11+), the number of routes, models and migrations. Git signals of «where it hurts»: `node scripts\bx.js op=hotspots top=10` (or `file=ПУТЬ` — one file; in Bitrix `bitrix/modules` and `upload` are counted relative to the found docroot: for example, `www/bitrix/modules` and `www/upload`; `www/local/modules/acme.module` stays). Exclusions are part of the cache key. Example of a nested site: `node scripts\bx.js op=hotspots file=www/local/modules/acme.module/include.php`.

## What it does

| Task | Operation |
|---|---|
| Project profile: site root, version, `utf_mode`, encodings, templates, modules, components, code style (D7 or legacy API) | `info` |
| Where a class, method (including inherited from `CAll*`), function, constant or ORM table is defined | `symbol` |
| Outline: classes with line ranges, signatures, ORM-table fields; the list is capped at 60 declaration lines — on truncation the exact count and `limit=0 — show all` are printed (`limit=` sets the cap; extras and inherit are not included); for pages and templates — called components, modules, `$arResult` and `$arParams` keys | `outline` |
| Who uses a file, what it uses, link chains; `node` — the file's declarations with totals and pagination (page 50, `limit`/`offset`) | `rdeps`, `deps`, `path`, `node`, `stats` |
| Where it hurts by git history: commits, churn, bugfixes, authors, percentiles (in Bitrix without `bitrix/modules` and `upload`) | `hotspots` |
| File coupling and impact area: fan-in/out, dependents, impact, PageRank, percentile | `metrics` in all four modes |
| Component: files, parameter keys from `.parameters.php` (up to 60), templates and per-site overrides, calls (up to 30 with a remainder marker) | `component` |
| Event handlers (`AddEventHandler`, `registerEventHandler`, `RegisterModuleDependences`) and `GetModuleEvents` calls | `events` |
| A language message by key or by text, where it is used | `lang` |
| Which file serves a URL: a physical file or a `urlrewrite.php` rule; in Laravel — `method=GET` by default, route → controller and method → found view | `route` |
| Table schema: the D7 class and fields, `CREATE TABLE` from `install/db/mysql/install.sql`, where it occurs | `table` |
| **Laravel:** route catalog with names and middleware (groups, resource, `Route::controller(...)`), filters `uri`/`name`/`controller` | `routes` |
| **Laravel:** an Eloquent model — table, migrations with columns and keys, `fillable`/`casts`, relations and inverse relations, scopes, who uses it | `model` |
| **Laravel:** container bindings (`bind`/`singleton`/`scoped`/`instance`, `when…needs…give`) and constructor injections | `container` |
| **Laravel:** Blade templates — directives, variables, inheritance, who renders it, unused ones | `blade` |
| **Laravel:** artisan commands and the schedule with frequencies (output capped at 50 records in total; `limit=` changes the cap, `limit=0` — everything, on truncation a marker with the number of hidden records) | `console` |
| **MODX:** a file element (snippet/chunk/plugin/template) by name — location and links | `element` |
| **MODX:** a `.tpl` template/chunk — snippet and chunk calls with line numbers, settings, TV and placeholder names | `tpl` |
| Text search with encoding awareness | `search` |
| Editing a method/function body without reading the old body into context: signature, comments, encoding, BOM and EOL — byte for byte | `patch_symbol` |
| Reading, editing and creating files keeping cp1251 / UTF-8 / UTF-16LE/BE, BOM and CRLF; reading several line ranges in one call (`ranges`) | `read`, `patch`, `create` |

## File metrics

```text
node "<SCRIPTS_DIR>\bx.js" op=metrics file=src/Support/helpers.php depth=2
node "<SCRIPTS_DIR>\bx.js" op=metrics top=15
node "<SCRIPTS_DIR>\bx.js" op=metrics file=local/modules/acme.module/include.php
```

`file` **or** `top` (not both); `top` is a positive safe integer, default 15, with neither given also top-15. `depth` is a strict integer 1..5, default 2 for metrics only (`deps`/`rdeps` stay 1). `fan_in/out` — unique project neighbors; `dependents` — backward reachability up to depth; `impact` — the entire backward reachability without a limit, root excluded. PageRank — 20 iterations, damping 0.85, uniform dangling mass; percentile — midrank `(less + halfEqual)/N*100`, printed as rounded `pN`. Top: fan_in desc, pagerank desc, stable path asc.

All existing link kinds are counted in all four modes; external endpoints are not added. `core=true` includes the core with the previous semantics without canceling vendor/cache and service filters; custom modules `local/modules/acme.module` are included without core. This is a static file graph, not a symbol-level/full runtime call graph and not a guarantee of edit risk. The output is plain text with `dependents(2)` and `impact`; unknown file — exit1 with `op=stats` and the previous core hint if applicable; an empty graph prints `.bx-cache/index.json`, a cycle — `циклов: N` without an `op=cycles` hint. Warmed graph/parse caches are not touched. The full contract is in SKILL.md.

Graph links: class, function, `require`/`include`, `IncludeComponent` (to the component file and to the template), `IncludeFile` and `main.include`, the class or function handling an event, `IncludeModule` (to the module's `include.php`), the language file. In Laravel additionally: `view('name')` and Blade directives (`@extends`, `@include`, `@component`, `@each`) to template files, `__()`/`@lang` to language files. Legacy API: global classes, methods in base `CAll*` classes, the `classes/mysql`, `mssql`, `oracle` variants, the `BX_ROOT`, `SITE_DIR`, `SITE_TEMPLATE_PATH` constants, PHP 5 syntax.

Speed (a synthetic project of 3300 files): the first index build about 1.2 s, a repeated query about 0.3 s. Savings example: a `component` summary takes about 350 bytes instead of roughly 1800 bytes of the component's three files.

## What the script does not see

- **Database data:** infoblock properties and types, mail templates, agents, module settings (`b_option`), handlers registered in the DB and not written into code.
- **Routes and sections:** D7 routes (`local/routes`), `.htaccess` rules, `.section.php`, menus (`$aMenuLinks`).
- **Dynamic names:** a component or class given by a variable; paths like `"classes/".$DBType."/…"`; `$obj->method()` calls.
- **Parameter types in signatures** as a standalone link (the link comes from their `use` import).
- **`registerAutoLoadClasses` and `AddAutoloadClasses`** are not parsed: classes are found by the declarations themselves in files.
- **SQL in code:** `$DB->Query("… FROM b_table")` queries produce no graph links, `table` only shows files where the table name occurs as text.
- **JS, CSS and non-PHP files** of templates (use `search` with `ext` for them).
- **Laravel:** events (`Event::listen`, `$listen`), Livewire/Inertia, queues and jobs, middleware aliases from `bootstrap/app.php`, routes with variables in URIs/controllers. Details — `references/laravel.md`.

## Notes

- **The first call of a conversation is `info`.** It will show the file encoding and warn if cp1251 is present.
- **Encodings.** For cp1251 and UTF-16 use `read`, `patch`, `create`. UTF-16LE/BE is detected by BOM and saved with the same byte order. Invalid UTF-16 input bytes and unpaired surrogates in the new representation for `patch`, `create`, `patch_symbol` (including dry) are rejected before publication; on rejection the original bytes stay untouched. This is not a PHP lint. Without a BOM, UTF-16 is not guessed. A character not representable in cp1251 cancels the whole write.
- **File payload:** `@payload` — UTF-8 JSON inside `root`. All argv are parsed before reading: the boundary is the last explicit `root=` or cwd; a relative payload path is resolved from it. The existing safe resolver checks lexical/realpath containment and a regular file; external paths/links, dangling links and directories are rejected, internal links and a root junction are allowed. A `root` from the file JSON is ignored and does not widen the boundary. Several `@` merge left to right; explicit argv take priority over JSON regardless of position. JSON from stdin is accepted when no `op` remains after argv/payload; without a file payload its `root` is allowed, explicit argv take priority.
- **Search and reading.** `search` shows 30 matched lines by default (`limit=0` returns the default); snippets up to 120 characters of content plus `…` markers (up to two), the line-number prefix does not count into the limit. `read` — `offset=1`, `limit=200` (`limit=0` also the default). The 2000-line cap applies only to `read ranges`, which is incompatible with `offset`/`limit`; the range end is cut to EOF, a start beyond EOF is an error.
- **`patch_symbol` edits only the body** of a method or function and refuses to edit on ambiguity or doubt: the class or function exists in several files, several same-name declarations in one file, the symbol is not found, the method is abstract or interface-only (inherited bodies are not edited — edit the base class), the file is binary, the new body is unbalanced in braces, `body_file` outside the project, the symbol is not representable in cp1251. `file` must match the relative path from the index; `body_file` is read as UTF-8 and is not deleted. On rejection the file stays untouched; `dry=true` by default shows a report without writing. Brace balance is not a PHP syntax check.
- **The core is not indexed by default.** In Bitrix: modules without a dot in the name (`main`, `iblock`, `sale`…), components `bitrix:*`, `bitrix/admin`, `bitrix/tools`, `bitrix/activities`, `bitrix/blocks`. In MODX: `core/model`, `core/src`, `core/lexicon`, `core/docs`, `manager/`, `connectors/`; extras in `core/components/` stay theirs. `core=true` includes the core in the index and search but does not cancel the vendor/cache exclusions.
- **Excluded:** `vendor/` at composer locations (`vendor`, `local/vendor`, `bitrix/vendor`), `upload`, `bitrix/cache`, `managed_cache`, `backup`, `updates` and similar service directories, files over 2 MB; in Laravel also `storage/` and `bootstrap/cache/`. The name `vendor` in component namespaces (`local/components/vendor/…`) is not excluded.
- **DBMS variants.** Classes from `classes/mssql` and `classes/oracle` are hidden when the main variant exists; `"all":true` in `symbol` shows all.
- **`route`** translates `urlrewrite.php` conditions from PCRE to JavaScript. Simple expressions match, complex ones (named groups `(?P<…>)`, recursion, the `u` flag) may differ.
- **Cache.** The `.bx-cache` folder excludes itself from git on its own. Freshness is determined by the file list, mtime and size, not by content hash. `build` recomputes links but reuses the parsing of files with the same mtime/size. If answers look stale after a skill update, delete that folder.
- **Verification.** Standalone regressions and four generated golden fixtures require no PHP, composer or npm. The commands from the repository root are below; real projects should still be cross-checked against `info` and the profile operations.

## Tests in the repository

```sh
node --test tests/token-economy-php/metrics.test.js
node --test tests/token-economy-php/audit.test.js tests/token-economy-php/golden.test.js tests/token-economy-php/task1-node-pagination.test.js tests/token-economy-php/task2-outline-limit.test.js tests/token-economy-php/task3-read-ranges.test.js tests/token-economy-php/task4-patch-symbol.test.js tests/token-economy-php/task5-console-cap.test.js
node --test tests/token-economy-php/hotspots.test.js tests/token-economy-php/payload.test.js tests/token-economy-php/codegraph.test.js
node skills/token-economy-php/scripts/bx.js op=selftest
node tests/token-economy-php/run-golden.js check
```

`node --test` from the root also picks up the PHP regressions. Golden itself invokes the tracked `gen-*-fixture.js` in fresh temp directories, checks stdout against `expected/*.txt` and the exit codes. Local `bitrix-site/`, `laravel-app/`, `modx-site/`, `plain-site/` and the old `golden/` are unused and not wiped. The order of manual generation and reference updates — in the [tests README](../../tests/token-economy-php/README.md).

## CodeGraph nearby

With a project index (`.codegraph/`) and `info` reporting `available=true` and `index=true` in `integrations.codegraph`, structural questions go first to `"<absolute-path-from-integrations.codegraph.executable>" explore "<question>"`: use the returned absolute path, not bare `codegraph`. What CodeGraph lacks stays with the skill: `outline`, exact text `search`, precise ranges via `read`, the project passport via `info`, method/function body replacement via `patch_symbol`, file edits via `patch`/`create` and the mode-specific operations (Bitrix components, events, lang, URL routes, tables; Laravel routes, models, container, Blade, console; MODX elements and templates). Coordinates for edits are not taken from the explore output; on a miss or error fall back to the regular path once; `codegraph index`/`init` is never run without an explicit request. The full CodeGraph bridge rule is in SKILL.md.

`integrations.codegraph` preserves `available`, `cli_version`, `index`, `db_path`, `reason` and adds absolute full-path `executable`, `source` (`path` or `home`) and nullable `hint`. Lookup checks `PATH` first; only if no candidate exists does it check home `.local/bin` (`os.homedir()` in JavaScript, `os.path.expanduser('~')` in Python). Names: `codegraph.cmd`, `codegraph.bat`, `codegraph.exe` on Windows; `codegraph` on POSIX. A broken `PATH` candidate is not masked. Selected `executable`/`source` survive a failed version probe; `hint` is populated only after a successful home probe. Detection only runs `version` with a 2 s timeout: no `index`/`init`, database-content reads or detection cache. No CLI means `reason=not_installed`; no index means `reason=no_index`: use the regular skill workflow, not structural `explore`.

With `available=true` and `index=true`, a home CLI works immediately even outside `PATH`. Agents must show a non-null `hint` in the conversation's language, translating it when needed. It explains optional manual home `.local/bin` addition to `PATH` and a full application restart for new terminals. No automatic changes to process/user `PATH`, profiles or the registry.

| Question | First tool |
|---|---|
| How does X work, who calls Y, what does a change affect | `"<absolute-path-from-integrations.codegraph.executable>" explore "<question>"` |
| Exact lines to edit or quote | `op=read` / Read |
| Exact text occurrences | `search` |
| Project passport and CodeGraph detection | `op=info` → `integrations.codegraph` |
