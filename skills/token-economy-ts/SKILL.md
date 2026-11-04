---
name: token-economy-ts
description: Обязательный навык для TypeScript-проектов: Angular, NestJS, Node (Express/Fastify/Koa) и чистый TS. Применять всегда, когда нужно [найти текст в коде (search); узнать, где определён класс/функция/$переменная/миксин (graph→symbol); кто использует файл и что он использует (graph→deps/rdeps); читать TS-файл от 300 строк (outline); сигнатуры сторонних библиотек (sig); заменить тело метода/функции (edit_symbol); создать Angular-сущность (generate)]. Тип проекта определяется автоматически (graph op=info → projectType); Angular-специфика подключается только для Angular (references/angular.md). Полностью заменяет встроенный поиск (search_files/ripgrep) и ручные заготовки.
---

# Skill: token-economy-ts

| Задача | Действие → скрипт |
|---|---|
| найти текст | search → code-searcher.js |
| где определено | graph symbol → graph-tool.js |
| кто/что использует | graph rdeps/deps → graph-tool.js |
| большой .ts | outline → symbol-index.js |
| API библиотеки | sig → sig-reader.js |
| заменить тело метода/функции | edit_symbol → edit-symbol.js |
| новая сущность (только Angular) | generate → scaffold-helper.js |

## Декларация инструментов (Kilo Code Agent Tool Schema)
```json
{
  "name": "token-economy-ts",
  "description": "Запускает скрипты для минимизации контекста ИИ.",
  "parameters": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "description": "search | outline | graph | generate | edit_symbol | sig"
      },
      "payload": {
        "type": "object",
        "description": "JSON-объект с параметрами действия; при вызове передаётся argv-аргументами ключ=значение (универсально) или одним JSON-аргументом (pwsh 7.3+)."
      }
    },
    "required": [
      "action"
    ]
  }
}
```

## Правила (строго)

0. Один раз за разговор, прежде чем читать или править файлы, вызови `graph` (op: `info`): он определяет тип проекта (`projectType`: `angular` / `nest` / `node` / `ts`), версии ключевых зависимостей, алиасы tsconfig, состав файлов по видам, самые большие файлы, предупреждения. Если `projectType=angular` — прочитай `references/angular.md` из каталога скилла (лежит рядом с `scripts`) и применяй его правила в дополнение к универсальным: там селекторы, пайпы, generate и Angular-часть графа. Для `nest`, `node` и `ts` дополнительных правил нет — достаточно универсальных ниже.
1. Файл меньше 300 строк читай напрямую стандартным инструментом — вызов скрипта дороже возможной экономии.
2. Файл от 300 строк — сначала `outline` (только .ts), затем точечное чтение нужного диапазона через Read(offset, limit).
3. Поиск мест ИСПОЛЬЗОВАНИЯ текста — `search`. Для html и стилей передавай `ext` (`.html`, `.scss`, `.less`, `.css`).
4. Встроенный поиск редактора/агента (search_files, ripgrep) не используй: в проекте могут быть файлы со строками длиннее 64 КБ (бандлы, source maps, base64), на которых ripgrep обрывается ошибкой «JSON record exceeded 65536 bytes». Весь поиск — только через code-searcher.js.
5. Поиск места ОПРЕДЕЛЕНИЯ — `graph` (op: `symbol`): один точный ответ с файлом и номером строки вместо сниппетов использований. Работает для классов, интерфейсов, функций, для переменных, миксинов и функций в SCSS/Sass/Less и custom-свойств CSS (`--name`), а также для методов и свойств классов и интерфейсов (в ответе — `owner`; при частом имени уточняй `in=ИмяКласса`). В Angular-проектах — также пайпы по имени и селекторы компонентов/директив (см. references/angular.md).
6. Зависимости файла и его потребителей — `graph` (op: `deps` / `rdeps` / `path`). Перед правкой общего файла (сервис, модель, утилита, общий миксин или переменная стилей) вызови `rdeps`, чтобы понять, что заденет правка.
7. Сигнатуры классов, интерфейсов, enum, функций (со всеми перегрузками) и их членов сторонних библиотек — `sig`: API rxjs, @nestjs/* и других пакетов узнаётся из node_modules без чтения .d.ts файлов. Файлы из node_modules штатными инструментами не читай и API не угадывай.
8. Правки вносит штатный инструмент редактирования (замена фрагмента / diff). Файл больше 50 строк при правке менее 30% целиком не перезаписывай: выходные токены должны тратиться только на изменённый фрагмент.
9. Граф строится и инкрементально обновляется скриптом автоматически при каждом вызове — это анализ, не компиляция, запуск разрешён всегда. Файлы `graph-deps.json` и `.graph-deps-cache.json` целиком НЕ читай: только ответы операций.
10. Компиляцию, линтер и тесты не запускай — проверки выполняет пользователь, об ошибках он сообщит сам.
11. Скрипты работают только с путями внутри рабочей директории; пути вне проекта отклоняй.

## Инструменты

### Чтение и поиск

search — поиск по проекту: имена файлов, номера строк и короткие сниппеты (по умолчанию до 30 совпадений, строка до 100 символов) вместо файлов целиком. Поиск по подстроке или регулярному выражению, несколько расширений за вызов (по умолчанию `.ts`, корень `src`; если в проекте код в другом корне — например `lib` — передай `root` явно, состав каталогов виден в op=info).

outline — оглавление .ts файла: классы, методы, свойства с номерами строк (~10–20% объёма файла). Для файлов от 300 строк, дальше — точечное чтение.

sig — сигнатуры сторонних библиотек из node_modules: классы, интерфейсы, enum, функции (со всеми перегрузками) и их члены. Резолв через package.json (exports/types) и реэкспорты; файлы .d.ts целиком не читаются.

### Навигация

graph — граф зависимостей с кэшем. Отвечает без чтения файлов: где определён символ (файл + строка → сразу Read с offset), кто использует файл, что использует файл, цепочка связей между файлами, циклы. Первый вызов строит граф (≈0,5 с на 4500 файлов), дальше — инкрементально; пересборка запускается сама при добавлении, удалении, переименовании и правке файлов, а также angular.json и tsconfig.json.

Универсальные связи (для любого типа проектов): `import` / `export … from` / `import()` в `.ts`/`.tsx` (без `.spec`/`.test` и `.d.ts`), алиасы из tsconfig `paths`; `<link rel="stylesheet">` в html; `@use`, `@forward`, `@import`, `@plugin` и партиалы (`_name`, `index`) в `.css`/`.scss`/`.sass`/`.less`. Направление ребра — «A зависит от B»: `deps` файла — что он подключает, `rdeps` — кто его подключает.

В Angular-проектах граф дополнительно связывает `templateUrl`/`styleUrl(s)`, компоненты, директивы и пайпы в шаблонах по селекторам и inline-`template` — полная таблица связей и ограничения графа в references/angular.md.

Общий вид: `node "<путь>\graph-tool.js" op=symbol name=UserService`. Параметры: `op` (обязательный), `root` (по умолчанию `src`), `depth` (1–5, для `deps`/`rdeps`), `specs` (`true` — включить `.spec.ts`), `why` (`true` — добавить `via`: номер строки импорта в `deps`/`rdeps`/`node`).

Где определён символ (класс, интерфейс, `$переменная`, миксин, `--custom-prop`):

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\graph-tool.js" op=symbol name=UserService
    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\graph-tool.js" op=symbol name='$primary'

Метод или свойство класса (файл + строка + класс-владелец; частое имя — с `in=`):

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\graph-tool.js" op=symbol name=ngOnInit in=UserListComponent

Кто использует файл (обязательно перед правкой общего файла); `why=1` добавляет `via` — номер строки импорта (только для ts-связей):

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\graph-tool.js" op=rdeps file=src/services/auth.service.ts depth=2
    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\graph-tool.js" op=rdeps file=src/services/auth.service.ts why=1

Что использует файл:

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\graph-tool.js" op=deps file=src/services/auth.service.ts

Цепочка связей между двумя файлами:

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\graph-tool.js" op=path from=src/app/app.component.ts to=src/styles/_variables.scss

Прочие операции: `info` (паспорт проекта: тип проекта, версии, алиасы tsconfig, состав файлов, крупнейшие файлы, предупреждения — один вызов в начале разговора), `node` (сводка по файлу: сущности, импорты, потребители), `cycles` (циклические группы; большие показываются выборкой), `stats` (размер графа и самые востребованные файлы), `build` (принудительная пересборка).

Паспорт проекта:

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\graph-tool.js" op=info

В параметре `file` можно передать путь, часть пути или имя без расширения (`profile.component` — вернётся .ts-файл; чтобы получить шаблон или стиль, укажи расширение). При неоднозначности вернётся список кандидатов.

### Изменение

edit_symbol — хирургическая замена тела функции или метода в .ts/.tsx: перезаписывается ТОЛЬКО содержимое между { и }; подпись, JSDoc, декораторы и остальной файл не меняются (CRLF и BOM сохраняются байт в байт). Файл не читается в контекст: агент передаёт только новое тело, в ответ приходит компактный JSON с диапазоном строк.

Символы: `save`, `UserService.save`, `UserService.constructor`, `get:prop` / `set:prop`, `UserService.get:prop`, arrow-свойства класса (`onClick = (e) => {…}`), `const fn = () => {…}` и `const fn = function () {…}`, `export function fn`. Перегрузки и abstract-сигнатуры (без тела) пропускаются — правится реализация. Стрелки с телом-выражением (`=> x * 2`, без {…}) не поддерживаются: у них нет внешних скобок для хирургической замены.

Движок: если в проекте есть пакет typescript — точные позиции Compiler API плюс синтаксическая проверка файла после подстановки; иначе fallback: маскирование строк/шаблонов/комментариев/regex, скобочный баланс и проверка отступов. Ноль зависимостей: typescript подгружается, только если уже установлен в проекте (typescript@7 без JS API пропускается).

Тело передаётся одним из способов: `body_file` (без значения — .kilo-edit-body.txt в корне проекта; рекомендуется для многострочных тел — PowerShell не передаёт переводы строк в argv; .txt в граф зависимостей не попадает; файл удаляется после успешной записи при body_file_delete=true), `body='…\n…'` (\n, \t, \r раскрываются) или `body_b64=`.

Безопасность: по умолчанию dry=true — файл НЕ перезаписывается, печатается отчёт; для записи передай dry=false. Запись атомарная (tmp+rename). При неоднозначности (несколько кандидатов), подозрительном разборе или синтаксической ошибке в новом теле скрипт отказывается от правки и возвращает список кандидатов/причину — файл остаётся нетронутым.

generate — обёртка над локальным Angular CLI; доступна только в Angular-проектах (projectType=angular). Параметры и примеры — в references/angular.md.

## Выполнение команд (PowerShell)

Команда — одна строка, параметры передаются argv-аргументами `ключ=значение` (разделитель значения — первый `=`):

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\code-searcher.js" query=ИскомыйТекст ext=.ts

Не используй пайп (`|`), `;`, `&`, `$()`, backtick, `>` и переносы строк — права среды их отклоняют, прежние вызовы через stdin-пайп больше не проходят. Права разрешают вызов по имени скрипта, поэтому полный путь в двойных кавычках допустим: команда выглядит как `node "<путь>\<скрипт>.js" ключ=значение…`.

Варианты пути до скриптов:

    глобально на Windows: "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts"
    агентские скиллы на Windows: "$env:USERPROFILE\.agents\skills\token-economy-ts\scripts"
    локально в репозитории: ".kilo\skills\token-economy-ts\scripts"
    pwsh на Linux/macOS: "$HOME/.config/kilo/skills/token-economy-ts/scripts"

Файл Angular-правил лежит в том же каталоге скилла, рядом со `scripts`: `<каталог скилла>\references\angular.md` (например, `"$env:USERPROFILE\.agents\skills\token-economy-ts\references\angular.md"`). Читай его стандартным инструментом чтения файлов.

Значения аргументов: с пробелами — в одинарных кавычках; апостроф внутри значения удваивается (`''`); значения, начинающиеся с `$`, тоже бери в одинарные кавычки, иначе PowerShell раскроет их как переменные; двойные кавычки `"` внутри значений не используй — PowerShell 5.1 их портит, ищи подстроку без кавычек. Кириллица через argv не портится: node читает командную строку через Unicode API Windows (раньше портилась только кодировка stdin-пайпа).

Скрипты создают в корне проекта `graph-deps.json` и `.graph-deps-cache.json` — добавь их в `.gitignore`. Временный файл тела `.kilo-edit-body.txt` тоже добавь в `.gitignore` (он удаляется сам после успешной записи edit_symbol).

### search

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\code-searcher.js" query=ИскомыйТекст ext=.ts
    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\code-searcher.js" query=app-profile ext=.html

Параметры: `query` (обязательный), `ext` (по умолчанию `.ts`; несколько через запятую — `ext=.ts,.html`), `root` (по умолчанию `src`; если в проекте нет каталога `src`, передай корень кода, например `root=lib`), `i=1` (без учёта регистра), `regex=1` (`query` — регулярное выражение), `limit` (по умолчанию 30), `files=1` (только список файлов со счётчиком совпадений).

Без учёта регистра и по нескольким расширениям сразу:

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\code-searcher.js" query=userName ext=.ts,.html i=1

Регулярное выражение и только файлы:

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\code-searcher.js" query=app-[a-z-]+ ext=.html regex=1 files=1

### outline

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\symbol-index.js" file=src/services/user.service.ts

### graph

Все примеры и параметры — в разделе «Навигация» выше.

### sig

API сторонних библиотек без чтения node_modules — класс целиком или один член:

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\sig-reader.js" name=rxjs#Observable
    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\sig-reader.js" name=rxjs#Observable member=subscribe

Функция — все перегрузки: `name=rxjs/operators#map`. Параметры: `name` (обязательный) — пакет с подпутем, член после `#`; `member` — можно задать отдельно; `limit` (по умолчанию 40) — максимум сигнатур в ответе. Если член не найден, ответ содержит `available` — доступные имена (экспорты файла или члены класса).

### edit_symbol

Запиши новое тело в файл (каждая строка — отдельный аргумент -Value; одинарные кавычки защищают $ и backtick от PowerShell), затем вызови скрипт:

    Set-Content -Path .kilo-edit-body.txt -Value '    const url = `/api/users/${id}`;', '    return this.http.put(url, { id });' -Encoding UTF8
    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\edit-symbol.js" file=src/services/user.service.ts symbol=UserService.save body_file dry=false

Однострочное тело можно передать прямо в аргументах (с \n):

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\edit-symbol.js" file=src/services/user.service.ts symbol=UserService.save body='return this.http.get(url);' dry=false

Параметры: `file`, `symbol` (обязательные); тело — `body_file` / `body` / `body_b64` (ровно один); `engine` (auto | ts | fallback, по умолчанию auto), `indent` (auto | 2 | 4 | tab | raw — по умолчанию наследуется отступ старого тела), `dry` (по умолчанию true), `body_file_delete` (по умолчанию true). Отступ нового тела указывай без базового уровня — скрипт выровняет его под старое тело автоматически; полное тело, обёрнутое во внешние {…}, разворачивается.

Самопроверка всех скриптов скилла на временном мини-проекте (проект не нужен):

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\graph-tool.js" op=selftest
