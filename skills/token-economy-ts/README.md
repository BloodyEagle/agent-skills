Скилл для экономии токенов.

Скилл рассчитан на агентные CLI (ZCode, Kilo Code): секция в самом начале SKILL.md, ограниченная `---`, обязательна — без неё агент не увидит скилл.

Скрипты написаны для запуска через Node.js, без новых npm-зависимостей. Поддерживаются `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, ESM и CommonJS; Angular-команды без Angular неприменимы.

Проверки JavaScript и регрессий TypeScript находятся в репозитории agent-skills, в каталоге `tests/token-economy-ts/`; в сам скилл они не входят. Запуск из корня репозитория:

```text
node --test tests/token-economy-ts/files.test.js
node --test tests/token-economy-ts/symbols.test.js
node --test tests/token-economy-ts/graph.test.js
node --test tests/token-economy-ts/search.test.js
node --test tests/token-economy-ts/ranges.test.js
node --test tests/token-economy-ts/angular.test.js
node --test tests/token-economy-ts/edit-docs.test.js
```

Весь набор один раз в конце:

```text
node --test tests/token-economy-ts/files.test.js tests/token-economy-ts/symbols.test.js tests/token-economy-ts/graph.test.js tests/token-economy-ts/search.test.js tests/token-economy-ts/ranges.test.js tests/token-economy-ts/angular.test.js tests/token-economy-ts/edit-docs.test.js
```

Тесты создают и удаляют только собственные временные проекты; зависимости проекта не загружаются. `npm install` не нужен. В существующих suites проверяются также сигнатуры (`symbols.test.js`), realpath/junction confinement, root exports, missing-dependency fallback, Unicode, Windows-регистр, фантомы из комментариев/шаблонов, JSON completeness и две цепочки по 6200 файлов (линейная и замкнутая).

Штатная самопроверка скилла:

```text
node skills/token-economy-ts/scripts/graph-tool.js op=selftest
```

Тип проекта определяется автоматически при `graph op=info` (`projectType`: `angular` / `nest` / `node` / `ts` — по angular.json, `@angular/*`, `@nestjs/*`, серверным пакетам в package.json). Универсальные правила — в SKILL.md; Angular-специфика (селекторы, пайпы, generate) вынесена в references/angular.md и подключается только для Angular.

Компактные формы и пакетные запросы (всё opt-in, legacy-выдача не изменена): search — `word=1`, `format=grouped|runs` (с `pathPrefix`), `context=N`, batch через `requests`/`requests_file`; outline — `compact=1` и batch; sig — сохранение literal whitespace, `full=1`, диагностика обрезки, `offset` и batch; graph — диапазоны объявлений и тел в `symbol`/`node`, `op=read` (пакетное чтение диапазонов), `format=table` для deps/rdeps, пагинация `node`, batch и `compact=1` (словарь путей). Обратимость проверяется декодерами в `search.test.js` и `ranges.test.js`.

Скрипты скилла:

| Действие | Что делает | Экономия                                  |
|---|---|-------------------------------------------|
