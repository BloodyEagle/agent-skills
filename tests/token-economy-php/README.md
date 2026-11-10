# Тесты token-economy-php

Только Node.js stdlib; PHP, composer, npm и сеть не нужны. Команды ниже выполняются из корня репозитория и подходят для Windows, Linux и macOS.

## Регрессии и CI

```sh
node --test tests/token-economy-php/audit.test.js tests/token-economy-php/golden.test.js
node skills/token-economy-php/scripts/bx.js op=selftest
```

`node --test` из корня тоже включает оба файла. Не передавайте каталог вместо имени файла: `node --test tests/token-economy-php/` на некоторых версиях Node/Windows не работает.

- `audit.test.js`: атрибуты/скобки/прогресс PHP-парсера, realpath и junction, Laravel HTTP-методы и view, MODX core, атомарная запись, исчезновение файла между обходом и stat/read, кодировки, PCRE, маркеры проекта.
- Потенциальные зависания запускаются в дочернем Node с heap 64 MiB и timeout 2 с; CLI — 5 с. Фикстуры создаются через `mkdtemp` и удаляются только после теста.
- На Windows junction проверяется без прав администратора. Если создание файлового symlink запрещено ОС (`EPERM`), соответствующий тест помечается skip; junction-тесты продолжают работать.
- `golden.test.js`: четыре фикстуры, 37 CLI-вызовов, точное сравнение stdout и кодов завершения; отдельно проверяется отказ генераторов стирать непустой каталог. Нормализуются только CRLF/LF.

## Golden

```sh
node tests/token-economy-php/run-golden.js check
```

Для shell доступна эквивалентная обёртка без `cygpath` и `MSYS_NO_PATHCONV`:

```sh
sh tests/token-economy-php/run-golden.sh check
```

Порядок автоматический: **генераторы → новые временные проекты → CLI → сравнение с `expected/*.txt` → очистка собственных временных каталогов**. Генераторы и эталоны не игнорируются git; всё необходимое есть в репозитории. Локальные `bitrix-site/`, `laravel-app/`, `modx-site/`, `plain-site/` и старые снимки `golden/before`, `golden/after` не нужны и не изменяются.

Снимок без изменения эталонов:

```sh
node tests/token-economy-php/run-golden.js before
node tests/token-economy-php/run-golden.js after
```

Каждый вызов печатает путь нового каталога `golden/<метка>-<уникальный суффикс>/`; старые снимки не перезаписываются. После намеренного изменения вывода сравните новые `.txt` с `expected/*.txt`, проверьте различия и только затем точечно обновите эталоны. Автоматического «принять всё» нет.

## Ручная генерация

Первый аргумент каждого генератора — отдельный новый или пустой каталог назначения:

```sh
node tests/token-economy-php/gen-bitrix-fixture.js /absolute/empty/bitrix
node tests/token-economy-php/gen-laravel-fixture.js /absolute/empty/laravel
node tests/token-economy-php/gen-modx-fixture.js /absolute/empty/modx
node tests/token-economy-php/gen-plain-fixture.js /absolute/empty/plain
node skills/token-economy-php/scripts/bx.js op=info root=/absolute/empty/laravel
```

В Windows используйте, например, `C:/temp/php-fixtures/laravel`; пути с пробелами заключайте в кавычки. Без аргумента используются прежние локальные имена каталогов, но **непустой каталог всегда вызывает отказ, никогда не удаляется**. MODX-генератор включает 1800 синтетических vendor-файлов для проверки исключений; golden разбирает только проектные файлы.
