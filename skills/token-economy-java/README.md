# token-economy-java

[Русская версия](README.ru.md)

A skill for the Kilo Code agent: it saves tokens when working with Java 17+ and Spring Boot 3+ projects. Instead of reading dozens of files, the agent calls the `jv.js` script and gets a short answer: where a class is defined, who uses it, which endpoints and beans exist, where a property is set, how a table is structured, which methods a library class has.

Rules for the agent and PowerShell command examples — in `SKILL.md`. The index design and detailed limitations — in `references/spring.md`.

## Requirements

- **Node.js 18 or newer.** The code uses only the standard library, tested on Node 22. No npm packages, no network.
- **Project:** Java 17+, Spring Boot 3+, Maven or Gradle build (Groovy and Kotlin DSL). On Spring Boot 2.x the script works, but `info` will warn that the skill targets Boot 3+ (`jakarta.*`).
- **Git** is optional. With it the file list comes from `git ls-files` (`.gitignore` respected), without it — directory traversal excluding build folders.
- **No JDK needed.** Only `sig` over the JDK's own classes (`java.*`, `javax.*`) requires `javap`.
- **For `sig` over libraries** accessible jars are needed, but building the project first is not required: a local Maven (`~/.m2/repository`, `localRepository` from `~/.m2/settings.xml`), Gradle (`GRADLE_USER_HOME` or `~/.gradle`), the project's `lib/` or `jars`/`JV_JARS` all work. Already compiled classes are additionally read from root `target/classes` and `build/classes/java/main`. `sig` downloads nothing.
- **Run** from the project root (for multi-module — from the repository root) or with the `root` parameter.
- **PowerShell:** commands on one line, parameters as argv arguments `key=value`; Cyrillic survives argv (node reads the Windows command line through the Unicode API). Values with spaces — in single quotes, do not use double quotes inside values.
- **Permissions:** the index and jar cache are written into the `.jv-cache` folder in the project root (it contains a `.gitignore` with a single asterisk); `hotspots` separately writes `.git-signals.json` into the root without touching the index. The cache endpoint `.git-signals.json` must be a regular file: internal, external and dangling links are rejected. Publication goes through a unique exclusive tmp in the real root (a root junction is allowed), with no crash-safe transaction or isolation from concurrent ancestor substitution guaranteed. `patch` and `create` write to the given file. Project sources and jars are only read during analysis; library code is not loaded or executed.

## Install

Copy the `token-economy-java` folder into the agent's skills directory:

    globally in ZCode:      %USERPROFILE%\.zcode\skills\token-economy-java
    globally in Kilo Code:  %USERPROFILE%\.kilocode\skills\token-economy-java
    locally in a repo:      .zcode\skills\token-economy-java (ZCode) or .kilo\skills\token-economy-java (Kilo Code)
    Linux and macOS:        ~/.config/kilo/skills/token-economy-java

Layout:

    token-economy-java/
      SKILL.md                rules and commands for the agent
      README.md               this file (English)
      README.ru.md            Russian version
      references/java.md      Java stack rules
      references/spring.md    index design, limitations
      scripts/
        jv.js                 entry point, all operations
        lib/                  Java parsing, index, Spring, configuration, jar and class files

Check from the root of the analyzed project: `node "<SCRIPTS_DIR>\jv.js" op=info` (`<SCRIPTS_DIR>` — absolute path to the installed skill). It prints the Boot and Java versions, modules, profiles and project composition. Git signals of «where it hurts»: `node "<SCRIPTS_DIR>\jv.js" op=hotspots top=10` (or `file=ПУТЬ` — one file with personal percentile labels).

## What it does

| Task | Operation |
|---|---|
| Project profile: versions, modules, main class, dependencies, profiles, encodings | `info` |
| Where a class, interface, method, field or DB table is defined | `symbol` |
| Class outline with annotations, signatures and line ranges (with ancestors via `inherit`) | `outline` |
| Who uses a file, what it uses, link chains | `rdeps`, `deps`, `path`, `node`, `stats` |
| Where it hurts by git history: commits, churn, bugfixes, authors, percentiles | `hotspots` |
| File coupling and impact area: fan-in/out, dependents, impact, PageRank, percentile | `metrics` |
| Implementations and descendants of an interface | `impls` |
| HTTP endpoints: method, full path, handler, access restrictions | `endpoints` |
| Beans, injected dependencies, `@Bean` methods | `beans` |
| Properties: values per profile, where they are used (secrets masked) | `config` |
| JPA entities, fields, links, repositories and `@Query` | `entities` |
| Table columns and migrations (`CREATE TABLE`, `ALTER TABLE`) | `table` |
| Event listeners, Kafka, RabbitMQ, JMS, SQS/SNS, `@Scheduled`, publications and sends | `listeners` |
| Signatures of library classes from jars without decompilation | `sig` |
| Text search with encoding awareness | `search` |
| Reading, editing and creating non-UTF-8 files | `read`, `patch`, `create` |

## File metrics

```text
node "<SCRIPTS_DIR>\jv.js" op=metrics file=src/main/java/com/acme/UserService.java depth=2
node "<SCRIPTS_DIR>\jv.js" op=metrics top=15
```

`file` **or** `top` (not both); `top` is a positive safe integer, default 15, with neither given also top-15. `depth` is a strict integer 1..5, default 2 for metrics only (`deps`/`rdeps` stay 1). `fan_in/out` — unique project neighbors; `dependents` — backward reachability up to depth; `impact` — the entire backward reachability without a limit, root excluded. PageRank — 20 iterations, damping 0.85, uniform dangling mass; percentile — midrank `(less + halfEqual)/N*100`, printed as rounded `pN`. Top: fan_in desc, pagerank desc, stable path asc.

All existing link kinds and the filters of the Java index are counted, including project tests; external endpoints are not added. This is a static file graph, not a symbol-level/full runtime call graph, not a Spring-context check and not a guarantee of edit risk. The output is plain text with `dependents(2)` and `impact`; unknown file — exit1 with `op=stats`, an empty graph prints `.jv-cache/index.json`, a cycle — `циклов: N` without an `op=cycles` hint. Warmed graph/parse caches are not touched. The full contract is in SKILL.md.

Graph links come in three types: `extends/implements`, `inject` (a heuristic over constructors, `@Autowired`/`@Inject`, Lombok and `@Bean` parameters) and `uses`. Tests from `src/test` are included with the `[test]` mark. `rdeps` shows one level by default (up to 60 files, `depth=1–5`); these are the static dependencies of the index, not the full list of affected runtime tests.

The index is built automatically; on size/mtime changes only the changed files are re-parsed. Exact timings depend on the project and environment; they are not guaranteed here.

## What the script does not see

- **Bean configuration outside annotations:** XML, `@Import`, `@ComponentScan` restrictions, autoconfigurations. `beans` lists all annotated classes of the project and does not check whether they land in the context.
- **Activation conditions:** `@Bean` methods are shown together with `@Profile` and `@ConditionalOn…`, but the conditions are not evaluated.
- **Generated code:** Lombok methods (getters, setters, constructors, builders), MapStruct, QueryDSL, `target/generated-sources`.
- **Functional routes** (`RouterFunction`), Kotlin and Groovy code.
- **Property sources outside files:** environment variables, Config Server, `spring.config.import`, command-line arguments.
- **Types in strings:** class names in XML, `Class.forName`, SpEL.
- **Liquibase:** only `tableName` mentions; the schema is reconstructed from SQL migrations (`CREATE TABLE`).
- **JPA/SQL:** a table without `@Table(name)` is estimated via snake_case, the naming strategy is not evaluated. Fields are read by field annotations, not property access. `table` shows `CREATE TABLE`, separate `ALTER TABLE` excerpts and Liquibase mentions, not the resulting schema after migrations.
- **Several fields in one declaration** (`int a, b;`): only the first name is recorded.
- **Library method parameter names** in `sig`: visible only if the library was built with `-parameters`; otherwise only types are shown.

## Notes

- **The first call of a conversation is `info`.** It reports versions, profiles and encodings, and warns about `javax.*` on Spring Boot 3 and about non-UTF-8 files.
- **Encodings.** For cp1251 use `read`/`patch`; Java does not support UTF-16. `patch` keeps BOM/encoding and normalizes the replaced lines to the prevailing LF/CRLF; a character not representable in cp1251 cancels the write. `create` makes a new file without BOM, with LF by default (`eol=crlf` for CRLF), adds no trailing newline and picks UTF-8 or cp1251 by the rules in `SKILL.md`. Both operations write immediately, no dry-run. Edit UTF-8 with the native targeted Edit.
- **Secrets.** `config` and `search` over `application*.yml|yaml|properties`/`bootstrap*` mask sensitive values: password/passwd/pwd, secret, token, credential, private-key, api-key, access-key, client-secret, salt. Nested keys, lists, block and multi-line YAML scalars, `.properties` continuations and escaped keys are handled. A clean reference `${MAIL_PASSWORD}` stays visible, `${MAIL_PASSWORD:секрет}` is masked. An inline container with sensitive keys is masked as a whole. Search keeps the original line numbers, the match count and the limit; a match by a secret value does not reveal it. This is not a universal scrub of arbitrary sources/comments. Never pass a secret as `query`: no-match repeats the query. Do not read configuration directly for passwords.
- **Lombok.** Methods generated by Lombok do not exist in the sources. `symbol` will not find them: look at the class annotations in `outline`.
- **The first `sig` call** indexes jars in the local repositories and can take several seconds on large `~/.m2` repositories; the result is cached in `.jv-cache/jars.json`. With several versions, candidates are sorted by the numeric fragments of the full path, not by build dependencies; `jar` filters by a case-insensitive substring of the full path. Broken archives/classes are skipped with a warning, a fully damaged found class gives a clear error. EOCD, central and local headers, boundaries, unpacked size and CRC32 are checked. ZIP64/multi-volume ZIP is not supported; limits are 64 MiB for the directory, 16 MiB for a class, 128 levels of generic nesting.
- **Paths.** `..foo.java` is allowed. Traversal and external/unresolvable symlink/junction, including ancestors of a new file and `.jv-cache`, are rejected; internal links are allowed. Write temp files are unique and created exclusively. The check does not protect against another process substituting directories between the check and the write.
- **Cache.** The `.jv-cache` folder creates a `.gitignore` with a single asterisk; this does not remove previously tracked files from git. Freshness of Java and jars is determined by the file list, size and mtime, not by content hash. Changing build files by itself does not invalidate a warm Java index; `op=build` rebuilds nodes/links but reuses the parse cache of files with matching size/mtime. For a full re-parse after an analyzer update, delete `.jv-cache`.
- **Multi-module projects.** Run from the repository root: then the graph covers all modules and `info` lists the modules.
- **Role marks** (`controller`, `service`, `repository`, `entity`, `config`, `test`…) are derived from annotations. Non-standard composed annotations are not unfolded.
- **Verification.** Besides `selftest`, the repository has `node --test` regressions: class/JAR fixtures are created by the stdlib without a JDK, malformed parsing runs in child processes with a timeout and heap limit. Integration tests cover the index, injection/rdeps, endpoints/beans/config, JPA/SQL and listeners. Files and Maven/Gradle homes are isolated in temp directories. On Windows junction checks run; the file symlink test is skipped if the OS forbids creating one.

## Regression tests

From the root of the `agent-skills` repository (Node 18+, no npm dependencies; the commands also work on Windows):

```text
node skills/token-economy-java/scripts/jv.js op=selftest
node --test tests/token-economy-java/metrics.test.js
node --test tests/token-economy-java/classfile.test.js tests/token-economy-java/jar.test.js tests/token-economy-java/paths.test.js tests/token-economy-java/cache.test.js tests/token-economy-java/config.test.js tests/token-economy-java/integration.test.js
node --test tests/token-economy-java/hotspots.test.js tests/token-economy-java/codegraph.test.js
```

The tests do not run Maven/Gradle, use no network and do not touch real user caches. The YAML format stays a subset, not a full YAML parser; unknown tags and alias/merge computations are not interpreted.

## CodeGraph nearby

With a project index (`.codegraph/`) and `info` reporting `available=true` and `index=true` in `integrations.codegraph`, structural questions go first to `"<absolute-path-from-integrations.codegraph.executable>" explore "<question>"`: use the returned absolute path, not bare `codegraph`. What CodeGraph lacks stays with the skill: `sig` (class signatures from jars without decompilation), `outline`, exact text `search`, precise ranges via `read`, the project passport via `info`, file edits via `patch`/`create` and the Spring operations (`endpoints`, `beans`, `config`, `entities`, `table`, `listeners`, `impls`). Coordinates for edits are not taken from the explore output; on a miss or error fall back to the regular path once; `codegraph index`/`init` is never run without an explicit request. The full CodeGraph bridge rule is in SKILL.md.

`integrations.codegraph` preserves `available`, `cli_version`, `index`, `db_path`, `reason` and adds absolute full-path `executable`, `source` (`path` or `home`) and nullable `hint`. Lookup checks `PATH` first; only if no candidate exists does it check home `.local/bin` (`os.homedir()` in JavaScript, `os.path.expanduser('~')` in Python). Names: `codegraph.cmd`, `codegraph.bat`, `codegraph.exe` on Windows; `codegraph` on POSIX. A broken `PATH` candidate is not masked. Selected `executable`/`source` survive a failed version probe; `hint` is populated only after a successful home probe. Detection only runs `version` with a 2 s timeout: no `index`/`init`, database-content reads or detection cache. No CLI means `reason=not_installed`; no index means `reason=no_index`: use the regular skill workflow, not structural `explore`.

With `available=true` and `index=true`, a home CLI works immediately even outside `PATH`. Agents must show a non-null `hint` in the conversation's language, translating it when needed. It explains optional manual home `.local/bin` addition to `PATH` and a full application restart for new terminals. No automatic changes to process/user `PATH`, profiles or the registry.

| Question | First tool |
|---|---|
| How does X work, who calls Y, what does a change affect | `"<absolute-path-from-integrations.codegraph.executable>" explore "<question>"` |
| Exact lines to edit or quote | `op=read` / Read |
| Third-party API signatures | `sig` |
| Exact text occurrences | `search` |
| Project passport and CodeGraph detection | `op=info` → `integrations.codegraph` |
