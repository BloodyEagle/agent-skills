# token-economy-php

[English version](README.md)

Скилл для агента Kilo Code: экономит токены при работе с PHP-проектами в четырёх режимах — универсальном (любой PHP-проект без CMS), 1С-Битрикс (старое API до D7 и D7), Laravel 8–13 и MODX (Revolution/Evolution, файловые элементы). Вместо чтения каталогов и десятков файлов агент вызывает скрипт `bx.js` и получает короткий ответ: где определён класс, кто подключает файл, какие страницы вызывают компонент, кто обрабатывает событие, где задано сообщение, какой файл обслуживает URL, какие маршруты и модели есть в Laravel, кто что рендерит и куда привязано в контейнере, какие файловые элементы вызывает шаблон MODX.

Правила для агента и примеры команд PowerShell — в `SKILL.md`. Правила и операции режимов, устройство индекса и подробные ограничения — в `references/bitrix.md` (Битрикс), `references/laravel.md` (Laravel) и `references/modx.md` (MODX).

## Требования

- **Node.js 18 или новее.** Проверки используют `node --test`; пакеты из npm и сеть не нужны.
- **PHP не нужен.** Разбор выполняет собственный лексер в `scripts/lib/php.js`, проект не запускается.
- **Проект:** обычный PHP, 1С-Битрикс (старое API и D7), Laravel 8–13 или MODX Revolution/Evolution (файловые элементы extras; элементы в БД недоступны). Сначала проверяются composer-пакеты Laravel/Lumen либо содержательный `artisan` со ссылкой на существующий `bootstrap/app.php`. Затем Битрикс: `bitrix/` или `local/` с типичным подкаталогом (`components`, `templates`, `modules`, `php_interface`) в корне или docroot (`www`, `public_html`, `httpdocs`, `web`, `public`, `htdocs`, `site`, `docroot`). MODX Revolution — `manager/` + `connectors/` + `core/model/modx` (или `core/src/Revolution`), Evolution — `manager/includes/` + `assets/`. Пустой `artisan`, голые `bitrix/`, `local/` и `manager/` не включают режим.
- **Git** не обязателен. С ним список файлов берётся из `git ls-files` (учитывается `.gitignore`), без него — обход каталогов.
- **Ядро Битрикса** (`bitrix/modules/main`, `iblock`…) в рабочей папке нужно только для операций с `"core":true`. Если ядра в репозитории нет, остальное работает без него.
- **Запуск** из корня проекта или с параметром `root`.
- **PowerShell:** команды — одной строкой, параметры argv-аргументами `ключ=значение`; кириллица через argv не портится (node читает командную строку через Unicode API Windows). Значения с пробелами — в одинарных кавычках, двойные кавычки в значениях не используй. Для правок с многострочными значениями — файл параметров (`@.bx-cache/payload.json`).
- **Права:** индексный кэш пишется в `.bx-cache` в корне проекта (внутри лежит `.gitignore` со звёздочкой); `hotspots` отдельно пишет `.git-signals.json` в корне, не трогая индекс. Cache endpoint `.git-signals.json` должен быть обычным файлом: внутренние, внешние и dangling-ссылки отвергаются. Публикация — через уникальный эксклюзивный tmp в реальном корне (корневой junction допустим), без гарантии crash-safe транзакции или изоляции от конкурентной подмены предков. `patch`, `patch_symbol` и `create` пишут также в указанный файл. `selftest` отдельно создаёт и удаляет временные проекты. Проверка realpath отклоняет выход через symlink/junction, включая отсутствующие предки. Уникальный tmp открывается эксклюзивно; `create` не перезаписывает параллельно созданный файл. Это не изоляция от процесса, который одновременно подменяет родительские каталоги; для `create` файловая система должна поддерживать hard link.

## Установка

Скопируй папку `token-economy-php` в каталог навыков агента:

    глобально в ZCode:      %USERPROFILE%\.zcode\skills\token-economy-php
    глобально в Kilo Code:  %USERPROFILE%\.kilocode\skills\token-economy-php
    локально в репозитории: .zcode\skills\token-economy-php (ZCode) или .kilo\skills\token-economy-php (Kilo Code)
    Linux и macOS:          ~/.config/kilo/skills/token-economy-php

Структура:

    token-economy-php/
      SKILL.md                правила и команды для агента
      README.md               this file (English)
      README.ru.md            Russian version
      references/bitrix.md    устройство индекса, ограничения, старое API
      references/laravel.md  устройство Laravel-части, ограничения
      references/modx.md     файловые элементы MODX, ограничения
      scripts/
        bx.js                 точка входа, все операции
        lib/                  лексер PHP, индекс, определение режима, классификация Битрикс/Laravel/MODX, кодировки

Проверка: `node scripts\bx.js op=info` в корне сайта выводит корень сайта, версию Битрикса, `utf_mode`, кодировки файлов, шаблоны, свои модули и компоненты; в Laravel — версию фреймворка, структуру каркаса (8–10 или 11+), число маршрутов, моделей и миграций. Git-сигналы «где болит»: `node scripts\bx.js op=hotspots top=10` (или `file=ПУТЬ` — один файл; в Битриксе `bitrix/modules` и `upload` не считаются относительно найденного docroot: например, `www/bitrix/modules` и `www/upload`; `www/local/modules/acme.module` остаётся). Исключения входят в ключ кэша. Пример вложенного сайта: `node scripts\bx.js op=hotspots file=www/local/modules/acme.module/include.php`.

## Что умеет

| Задача | Операция |
|---|---|
| Профиль проекта: корень сайта, версия, `utf_mode`, кодировки, шаблоны, модули, компоненты, стиль кода (D7 или старое API) | `info` |
| Где определён класс, метод (в том числе унаследованный от `CAll*`), функция, константа, таблица ORM | `symbol` |
| Оглавление: классы с диапазонами строк, сигнатуры, поля ORM-таблиц; список ограничен 60 строками объявлений — при усечении печатается точный count и `limit=0 — вывести все` (`limit=` задаёт предел; extras и inherit не входят); для страниц и шаблонов — вызванные компоненты, модули, ключи `$arResult` и `$arParams` | `outline` |
| Кто использует файл, что использует он, цепочка связей; `node` — объявления файла с итогами и пагинацией (страница 50, `limit`/`offset`) | `rdeps`, `deps`, `path`, `node`, `stats` |
| Где болит по git-истории: коммиты, churn, багфиксы, авторы, процентили (в Битриксе без `bitrix/modules` и `upload`) | `hotspots` |
| Файловая связанность и область воздействия: fan-in/out, dependents, impact, PageRank, percentile | `metrics` во всех четырёх режимах |
| Компонент: файлы, ключи параметров из `.parameters.php` (до 60), шаблоны и переопределения по сайтам, вызовы (до 30 с маркером остатка) | `component` |
| Обработчики событий (`AddEventHandler`, `registerEventHandler`, `RegisterModuleDependences`) и вызовы `GetModuleEvents` | `events` |
| Языковое сообщение по ключу или по тексту, где оно используется | `lang` |
| Какой файл обслуживает URL: физический файл или правило `urlrewrite.php`; в Laravel — `method=GET` по умолчанию, маршрут → контроллер и метод → найденный view | `route` |
| Схема таблицы: D7-класс и поля, `CREATE TABLE` из `install/db/mysql/install.sql`, где встречается | `table` |
| **Laravel:** каталог маршрутов с именами и middleware (группы, resource, `Route::controller(...)`), фильтры `uri`/`name`/`controller` | `routes` |
| **Laravel:** модель Eloquent — таблица, миграции с колонками и ключами, `fillable`/`casts`, связи и обратные связи, scopes, кто использует | `model` |
| **Laravel:** привязки контейнера (`bind`/`singleton`/`scoped`/`instance`, `when…needs…give`) и инжекции через конструктор | `container` |
| **Laravel:** Blade-шаблоны — директивы, переменные, наследование, откуда рендерится, неиспользуемые | `blade` |
| **Laravel:** artisan-команды и расписание с частотами (вывод ограничен 50 записями суммарно; `limit=` меняет кап, `limit=0` — всё, при усечении — маркер с числом скрытых записей) | `console` |
| Поиск по тексту с учётом кодировки | `search` |
| Правка тела метода/функции без чтения старого тела в контекст: сигнатура, комментарии, кодировка, BOM и EOL — байт в байт | `patch_symbol` |
| Чтение, правка и создание файлов с сохранением cp1251 / UTF-8 / UTF-16LE/BE, BOM и CRLF; чтение нескольких диапазонов строк за вызов (`ranges`) | `read`, `patch`, `create` |

## Файловые метрики

```text
node "<SCRIPTS_DIR>\bx.js" op=metrics file=src/Support/helpers.php depth=2
node "<SCRIPTS_DIR>\bx.js" op=metrics top=15
node "<SCRIPTS_DIR>\bx.js" op=metrics file=local/modules/acme.module/include.php
```

`file` **либо** `top` (вместе нельзя); `top` — положительное safe integer, default 15, без обоих тоже top-15. `depth` — строго целое 1..5, default 2 только для metrics (`deps`/`rdeps` остаются 1). `fan_in/out` — уникальные проектные соседи; `dependents` — обратная достижимость до depth; `impact` — вся обратная достижимость без ограничения, корень исключён. PageRank — 20 итераций, damping 0.85, равномерная dangling mass; percentile — midrank `(less + halfEqual)/N*100`, в тексте округлённый `pN`. Top: fan_in desc, pagerank desc, стабильный путь asc.

Все существующие типы связей входят во всех четырёх режимах; внешние endpoints не добавляются. `core=true` включает ядро с прежней семантикой, не отменяя vendor/cache и служебные фильтры; свои модули `local/modules/acme.module` входят без core. Это статический файловый граф, не символьный/full runtime call graph и не гарантия риска правки. Вывод — общий текст с `dependents(2)` и `impact`; неизвестный файл — exit1 с `op=stats` и прежней core-подсказкой, если применима; пустой граф показывает `.bx-cache/index.json`, цикл — `циклов: N` без подсказки `op=cycles`. Прогретые graph/parse-кэши не меняются. Полный контракт — в SKILL.md.

Связи в графе: класс, функция, `require`/`include`, `IncludeComponent` (на файл компонента и на шаблон), `IncludeFile` и `main.include`, класс или функция-обработчик события, `IncludeModule` (на `include.php` модуля), языковой файл. В Laravel дополнительно: `view('name')` и директивы Blade (`@extends`, `@include`, `@component`, `@each`) на файлы шаблонов, `__()`/`@lang` на языковые файлы. Старое API: глобальные классы, методы в базовых `CAll*`-классах, варианты `classes/mysql`, `mssql`, `oracle`, константы `BX_ROOT`, `SITE_DIR`, `SITE_TEMPLATE_PATH`, синтаксис PHP 5.

Скорость (синтетический проект на 3300 файлов): первая сборка индекса около 1,2 с, повторный запрос около 0,3 с. Пример экономии: сводка `component` занимает около 350 байт вместо примерно 1800 байт трёх файлов компонента.

## Чего скрипт не видит

- **Данные из базы:** свойства и типы инфоблоков, почтовые шаблоны, агенты, настройки модулей (`b_option`), обработчики, зарегистрированные в БД и не вписанные в код.
- **Маршруты и разделы:** D7-маршруты (`local/routes`), правила `.htaccess`, `.section.php`, меню (`$aMenuLinks`).
- **Динамические имена:** компонент или класс, заданный переменной; пути вида `"classes/".$DBType."/…"`; вызовы `$obj->method()`.
- **Типы в сигнатурах** параметров как самостоятельная связь (связь даёт их `use`-импорт).
- **`registerAutoLoadClasses` и `AddAutoloadClasses`** не разбираются: классы находятся по самим объявлениям в файлах.
- **SQL в коде:** запросы `$DB->Query("… FROM b_table")` связей в граф не дают, `table` лишь показывает файлы, где имя таблицы встречается текстом.
- **JS, CSS и не-PHP файлы** шаблонов (для них используй `search` с `ext`).
- **Laravel:** события (`Event::listen`, `$listen`), Livewire/Inertia, очереди и jobs, алиасы middleware из `bootstrap/app.php`, маршруты с переменными в URI/контроллерах. Подробности — `references/laravel.md`.

## Что учесть

- **Первый вызов за разговор — `info`.** Он покажет кодировку файлов и предупредит, если есть cp1251.
- **Кодировки.** Для cp1251 и UTF-16 используй `read`, `patch`, `create`. UTF-16LE/BE определяется по BOM и сохраняется с тем же порядком байтов. Некорректные входные байты UTF-16 и непарные суррогаты в новом представлении для `patch`, `create`, `patch_symbol` (включая dry) отклоняются до публикации; исходные байты при отказе не меняются. Это не PHP lint. Без BOM UTF-16 не угадывается. Непредставимый в cp1251 символ отменяет запись целиком.
- **Файловый payload:** `@payload` — UTF-8 JSON внутри `root`. Все argv разбираются до чтения: граница — последний явный `root=` либо cwd; относительный путь payload считается от неё. Существующий safe resolver проверяет lexical/realpath containment и обычный файл; внешние пути/ссылки, dangling links и каталоги отклоняются, внутренние ссылки и root-junction допустимы. `root` из файлового JSON игнорируется и не расширяет границу. Несколько `@` сливаются слева направо; явные argv приоритетнее JSON независимо от позиции. JSON из stdin сохраняется при отсутствии `op` после argv/payload; без файлового payload его `root` допустим, явные argv приоритетнее.
- **Поиск и чтение.** `search` по умолчанию показывает 30 совпавших строк (`limit=0` возвращает default); сниппеты до 120 символов содержимого плюс маркеры `…` (до двух), префикс номера строки не входит в лимит. `read` — `offset=1`, `limit=200` (`limit=0` тоже default). Кап 2000 строк действует только для `read ranges`, несовместимого с `offset`/`limit`; конец диапазона обрезается по EOF, начало за EOF — ошибка.
- **`patch_symbol` правит только тело** метода или функции и отказывается от правки при неоднозначности или сомнении: класс или функция в нескольких файлах, несколько одноимённых объявлений в одном файле, символ не найден, метод abstract или интерфейсный (унаследованные тела не правятся — правьте базовый класс), файл бинарный, новое тело несбалансировано по скобкам, `body_file` вне проекта, символ непредставим в cp1251. `file` должен совпадать с относительным путём из индекса; `body_file` читается как UTF-8 и не удаляется. Файл при отказе остаётся нетронутым; `dry=true` по умолчанию показывает отчёт без записи. Баланс скобок не является проверкой PHP-синтаксиса.
- **Ядро по умолчанию не индексируется.** В Битриксе: модули без точки в имени (`main`, `iblock`, `sale`…), компоненты `bitrix:*`, `bitrix/admin`, `bitrix/tools`, `bitrix/activities`, `bitrix/blocks`. В MODX: `core/model`, `core/src`, `core/lexicon`, `core/docs`, `manager/`, `connectors/`; extras в `core/components/` остаются своими. `core=true` включает ядро в индекс и поиск, но не отменяет исключения vendor/cache.
- **Исключаются:** `vendor/` в местах composer (`vendor`, `local/vendor`, `bitrix/vendor`), `upload`, `bitrix/cache`, `managed_cache`, `backup`, `updates` и подобные служебные каталоги, файлы больше 2 МБ; в Laravel — также `storage/` и `bootstrap/cache/`. Имя `vendor` в пространстве имён компонентов (`local/components/vendor/…`) не исключается.
- **Варианты под разные СУБД.** Классы из `classes/mssql` и `classes/oracle` скрыты, если есть основной вариант; `"all":true` в `symbol` показывает все.
- **`route`** переводит условия `urlrewrite.php` из PCRE в JavaScript. Простые выражения совпадают, сложные (именованные группы `(?P<…>)`, рекурсия, флаг `u`) могут отличаться.
- **Кэш.** Папка `.bx-cache` исключает себя из git сама. Свежесть определяется по списку файлов, mtime и size, не по хешу содержимого. `build` пересчитывает связи, но переиспользует разбор файлов с прежними mtime/size. Если ответы выглядят устаревшими после обновления скилла, удали эту папку.
- **Проверка.** Автономные регрессии и четыре генерируемых golden-фикстуры не требуют PHP, composer и npm. Команды из корня репозитория приведены ниже; реальные проекты всё равно стоит сверять с ответом `info` и профильных операций.

## Тесты в репозитории

```sh
node --test tests/token-economy-php/metrics.test.js
node --test tests/token-economy-php/audit.test.js tests/token-economy-php/golden.test.js tests/token-economy-php/task1-node-pagination.test.js tests/token-economy-php/task2-outline-limit.test.js tests/token-economy-php/task3-read-ranges.test.js tests/token-economy-php/task4-patch-symbol.test.js tests/token-economy-php/task5-console-cap.test.js
node skills/token-economy-php/scripts/bx.js op=selftest
node tests/token-economy-php/run-golden.js check
```

`node --test` из корня также подхватывает PHP-регрессии. Golden сам вызывает трекнутые `gen-*-fixture.js` в новых временных каталогах, проверяет stdout по `expected/*.txt` и коды завершения. Локальные `bitrix-site/`, `laravel-app/`, `modx-site/`, `plain-site/` и старые `golden/` не используются и не стираются. Порядок ручной генерации и обновления эталонов — в [README тестов](../../tests/token-economy-php/README.md).

## CodeGraph рядом

Если в проекте есть индекс CodeGraph (`.codegraph/`) и CLI CodeGraph доступен — `op=info` показывает это в `integrations.codegraph` — структурный вопрос сначала туда: `codegraph explore "<вопрос>"` отвечает «как работает X», «кто вызывает Y», «что заденет правка Z» одним вызовом вместо серии `search` и чтений. Чего у CodeGraph нет, остаётся своим: `sig`, замена тела, генерация, `outline`, точный поиск текста `search`, точные диапазоны `graph op=read` и паспорт проекта `op=info`. Координаты для правки из вывода explore не берутся; пусто или ошибка — один раз уйти в прежний путь; `codegraph index`/`init` без явной просьбы не запускается. Полное правило — в SKILL.md, раздел `CodeGraph рядом`.

| Вопрос | Первый инструмент |
|---|---|
| Как работает X, кто вызывает Y, что заденет правка | `codegraph explore "<вопрос>"` |
| Точные строки для правки или цитирования | `graph op=read` / Read |
| Сигнатуры сторонних API | `sig` |
| Точные вхождения текста | `search` |
| Паспорт проекта и детект CodeGraph | `op=info` → `integrations.codegraph` |
