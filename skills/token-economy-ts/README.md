Скилл для экономии токенов.

Скилл рассчитан на агентные CLI (ZCode, Kilo Code): секция в самом начале SKILL.md, ограниченная `---`, обязательна — без неё агент не увидит скилл.

Скрипты написаны для запуска через Node.js, без новых npm-зависимостей. Поддерживаются `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, ESM и CommonJS; `.vue` SFC не индексируются. React-гейт проверяет major спецификатора в package.json (≥ 16 либо нераспознанный); `graph op=component` показывает JSX-использования независимо от projectType. Angular-гейт и детект projectType имеют различия, описанные в SKILL.md.

## Файловые метрики

`graph op=metrics` — метрики статического файлового графа, не символьного/full runtime call graph и не гарантия риска правки. Учитывает все существующие внутренние связи с прежними `root`/`specs` и фильтрами (включая template/style), внешние endpoints не добавляет.

```text
node "<SCRIPTS_DIR>\graph-tool.js" op=metrics file=src/db.ts depth=2
node "<SCRIPTS_DIR>\graph-tool.js" op=metrics top=15
node "<SCRIPTS_DIR>\graph-tool.js" op=metrics file=src/db.ts json=1
```

`file` **либо** `top` (вместе нельзя); `top` — положительное safe integer, default 15, без обоих тоже top-15. `depth` — строго целое 1..5, default 2 только для metrics (`deps`/`rdeps` остаются 1). `fan_in/out` — уникальные проектные соседи; `dependents` — обратная достижимость до depth; `impact` — вся обратная достижимость без ограничения, корень исключён. PageRank — 20 итераций, damping 0.85, равномерная dangling mass; percentile — midrank `(less + halfEqual)/N*100`, в тексте округлённый `pN`. Top: fan_in desc, pagerank desc, стабильный путь asc.

Текст по умолчанию только для новой операции: `src/db.ts  fan-in 12 (p95)  fan-out 4  dependents(2) 27  impact 41  pagerank 0.0132 (p95)`. `json=1` через emit выдаёт `{perFile:[{id,path,fan_in,fan_out,dependents,impact,pagerank,percentile:{fan_in,pagerank},depth}],total,cycles,depth,empty,scope,completeness,file?}`; total, percentile и PageRank относятся ко всему графу, perFile — цель или top. Неизвестный файл/неверные аргументы — JSON error/exit1 с `completeness.complete=false` и stats-подсказкой для файла; ambiguous — JSON/exit0. Batch всегда JSON (metrics включён), `compact=1` кодирует `perFile[].path` в общем `paths`. Пустой граф показывает путь к `graph-deps.json`, циклы — `циклов: N (op=cycles)`, неполнота — предупреждение. Полный контракт — в SKILL.md.

Проверки JavaScript и регрессий TypeScript находятся в репозитории agent-skills, в каталоге `tests/token-economy-ts/`; в сам скилл они не входят. Запуск из корня репозитория:

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

Весь набор один раз в конце:

```text
node --test tests/token-economy-ts/files.test.js tests/token-economy-ts/symbols.test.js tests/token-economy-ts/graph.test.js tests/token-economy-ts/search.test.js tests/token-economy-ts/ranges.test.js tests/token-economy-ts/angular.test.js tests/token-economy-ts/react-detect.test.js tests/token-economy-ts/react-component.test.js tests/token-economy-ts/ref-corpus.test.js tests/token-economy-ts/ref-read.test.js tests/token-economy-ts/edit-docs.test.js tests/token-economy-ts/hotspots.test.js tests/token-economy-ts/metrics.test.js
```

Тесты создают и удаляют собственные временные проекты; `edit_symbol` в режиме auto может загрузить уже установленный TypeScript (в том числе найденный от каталога скрипта). `npm install` не нужен. В существующих suites проверяются также сигнатуры (`symbols.test.js`), realpath/junction confinement, root exports, missing-dependency fallback, Unicode, Windows-регистр, фантомы из комментариев/шаблонов, JSON completeness и две цепочки по 6200 файлов (линейная и замкнутая).

Штатная самопроверка скилла:

```text
node skills/token-economy-ts/scripts/graph-tool.js op=selftest
```

Git-сигналы «где болит» (таблица top или один файл):

```text
node skills/token-economy-ts/scripts/graph-tool.js op=hotspots top=10
node skills/token-economy-ts/scripts/graph-tool.js op=hotspots file=src/merge.ts since=90d
```

Тип проекта определяется автоматически при `graph op=info` (`projectType`: `angular` / `react` / `nest` / `node` / `ts` — по angular.json, `@angular/core`, `react` (>= 16), `@nestjs/*`, серверным пакетам в package.json). Универсальные правила — в SKILL.md; Angular-специфика (селекторы, пайпы, generate) вынесена в references/angular.md, React-специфика (использования компонентов в JSX через `op=component`, хуки, стили-импорты) — в references/react.md; читай профиль своего `projectType`, а перед `op=component` — React-профиль даже при другом типе: применимость команды определяется отдельным React-гейтом.

Компактные формы и пакетные запросы (всё opt-in, legacy-выдача не изменена): search — `word=1`, `format=grouped|runs` (с `pathPrefix`), `context=N`, batch через `requests`/`requests_file`; outline — `compact=1` и batch; sig — сохранение literal whitespace, `full=1`, диагностика обрезки, `offset` и batch (`full` общий, пределы обхода сохраняются); graph — диапазоны объявлений и тел в `symbol`/`node`, `op=read` через `file+ranges` или `ref=файл:N-M`, `format=table` для deps/rdeps, пагинация `node`, batch и только в batch `compact=1` (словарь путей). Обратимость проверяется декодерами в `search.test.js` и `ranges.test.js`; refs — в `ref-corpus.test.js`/`ref-read.test.js`. Graph-кэш проверяет исходники по mtime/size, не по хешу; sig не использует общий read/parse-кэш.

Скрипты скилла:

| Действие | Что делает | Экономия                                  |
|---|---|-------------------------------------------|
| `search` | `code-searcher.js` — совпадения: файл, строка, короткий сниппет | не читает найденные файлы целиком |
| `graph` | `graph-tool.js` — где определён символ, кто использует файл, цепочки связей, чтение диапазонов, React-компоненты | навигационные ответы вместо файлов в контексте; `read` отдаёт запрошенные строки |
| `graph op=metrics` | файловые fan-in/out, dependents, impact, PageRank и percentile | связанность и область проверки без выдачи всех зависимых файлов |
| `outline` | `symbol-index.js` — оглавление файла с номерами строк | вместо файла целиком |
| `sig` | `sig-reader.js` — сигнатуры библиотек из `node_modules` | без чтения `.d.ts` |
| `edit_symbol` | `edit-symbol.js` — замена тела функции или метода | правка без чтения файла в контекст |
| `generate` | `scaffold-helper.js` — Angular-сущности через локальный CLI | краткий список созданных файлов |
