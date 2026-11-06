Скилл для экономии токенов.

Скилл рассчитан на агентные CLI (ZCode, Kilo Code): секция в самом начале SKILL.md, ограниченная `---`, обязательна — без неё агент не увидит скилл.

Скрипты написаны для запуска через Node.js, без новых npm-зависимостей. Поддерживаются `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, ESM и CommonJS; Angular-команды без Angular неприменимы.

Проверки JavaScript и регрессий TypeScript находятся в репозитории agent-skills, в каталоге `tests/token-economy-ts/`; в сам скилл они не входят. Запуск из корня репозитория:

```text
node --test tests/token-economy-ts/files.test.js
node --test tests/token-economy-ts/symbols.test.js
node --test tests/token-economy-ts/graph.test.js
node --test tests/token-economy-ts/angular.test.js
node --test tests/token-economy-ts/edit-docs.test.js
```

Весь набор один раз в конце:

```text
node --test tests/token-economy-ts/files.test.js tests/token-economy-ts/symbols.test.js tests/token-economy-ts/graph.test.js tests/token-economy-ts/angular.test.js tests/token-economy-ts/edit-docs.test.js
```

Тесты создают и удаляют только собственные временные проекты; зависимости проекта не загружаются.

Тип проекта определяется автоматически при `graph op=info` (`projectType`: `angular` / `nest` / `node` / `ts` — по angular.json, `@angular/*`, `@nestjs/*`, серверным пакетам в package.json). Универсальные правила — в SKILL.md; Angular-специфика (селекторы, пайпы, generate) вынесена в references/angular.md и подключается только для Angular.

Скрипты скилла:

| Действие | Что делает | Экономия                                  |
|---|---|-------------------------------------------|
