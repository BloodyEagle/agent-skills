# Тесты и benchmark

Перед запуском/изменением тестов или benchmark прочитай этот файл и получи разрешение пользователя на запуск.

Тесты, фикстуры и benchmark находятся в репозитории разработки, в `tests/token-economy-har/`; в скопированный скилл они не входят. `<REPO_DIR>` означает корень репозитория `agent-skills`. Node.js >= 18; `npm install` не нужен. На Windows передавай файлы поимённо, не каталог.

```powershell
node --test "<REPO_DIR>\tests\token-economy-har\har.test.js" "<REPO_DIR>\tests\token-economy-har\parse.test.js" "<REPO_DIR>\tests\token-economy-har\redact.test.js"
node --test "<REPO_DIR>\tests\token-economy-har\compact-list.test.js" "<REPO_DIR>\tests\token-economy-har\compact-entry.test.js" "<REPO_DIR>\tests\token-economy-har\compact-values.test.js" "<REPO_DIR>\tests\token-economy-har\compact-cli.test.js" "<REPO_DIR>\tests\token-economy-har\compact-format.test.js" "<REPO_DIR>\tests\token-economy-har\compact-analysis.test.js" "<REPO_DIR>\tests\token-economy-har\compact-budget.test.js" "<REPO_DIR>\tests\token-economy-har\compact-combinations.test.js" "<REPO_DIR>\tests\token-economy-har\compact-docs.test.js"
```

Регрессии включают scaling 16/32/64 KiB и длинные/malformed токены в отдельных процессах (таймаут 8 с, широкий лимит обработки 1 с вместо 5 мс), а также искусственный HAR не менее 100 MiB с JSON/base64-телами. E2E запускает `redact --stream` с таймаутом 120 с, проверяет все очищенные тела, сохранность blobs и размеров, выводит время/размеры и удаляет временные файлы. Отдельный запуск после разрешения:

```powershell
node --test --test-name-pattern="bounded 100 MiB" "<REPO_DIR>\tests\token-economy-har\har.test.js"
```

Воспроизводимый benchmark без npm создаёт временные искусственные HAR, измеряет CLI в отдельных процессах, сравнивает первые 100 записей и удаляет свои файлы. `--real` задаёт реальный HAR для замеров `info/slow`; без него используется искусственный файл 34 MiB. `--temp` задаёт родительский каталог для нового временного подкаталога; скрипт не валидирует его отдельно, ошибки создания/доступа отклоняются файловой системой. Искусственный файл по умолчанию 300 MiB (`--size N`, конечное число ≥ 1); при меньшем `--size` вспомогательный файл также меньше 34 MiB. Не используй `--real` без отдельного разрешения.

```powershell
node "<REPO_DIR>\tests\token-economy-har\benchmark.js" --temp "<TEMP_DIR>" --real "capture.har"
```

Для compact-замеров `compact-measure.js` использует только искусственные search-payload, весь JSON envelope и отдельно UTF-8 bytes; проверяет 0/1/5/30/195 строк и уникальные/повторяющиеся URL, домены и MIME, round-trip и fallback. Текущий скрипт не подключает tokenizer (`tokenizer:null`) и не измеряет tokens, headers, Unicode или сочетания `null`/`0` — такие проверки есть в compact-test suites выше. Дополнительный token-замер возможен только уже доступным локальным tokenizer; не устанавливай его и не отправляй HAR/вывод внешнему сервису без согласования. Время/память не называй экономией токенов.
