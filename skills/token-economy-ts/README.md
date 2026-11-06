Скилл для экономии токенов.

Скилл рассчитан на агентные CLI (ZCode, Kilo Code): секция в самом начале SKILL.md, ограниченная `---`, обязательна — без неё агент не увидит скилл.

Скрипты написаны для запуска через Node.js, без новых npm-зависимостей. Поддерживаются `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, ESM и CommonJS; Angular-команды без Angular неприменимы.

Проверки JavaScript и регрессий TypeScript находятся в `test/`; запуск из каталога скилла:

```text
node --test test/files.test.js
node --test test/symbols.test.js
node --test test/graph.test.js
node --test test/angular.test.js
node --test test/edit-docs.test.js
```

Весь набор один раз в конце:

```text
node --test test/files.test.js test/symbols.test.js test/graph.test.js test/angular.test.js test/edit-docs.test.js
```

Тесты создают и удаляют только собственные временные проекты; зависимости проекта не загружаются.

Скрипты скилла:

| Действие | Что делает | Экономия                                  |
|---|---|-------------------------------------------|
