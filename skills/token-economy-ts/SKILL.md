---
name: token-economy-ts
description: Обязательный навык для этого Angular-проекта. Применять всегда, когда нужно [найти текст в коде (search); узнать, где определён класс/пайп/селектор/$переменная/миксин (graph-> symbol/selector); кто использует файл и что он использует (graph-> deps/ rdeps/deps); читать TS-файл от 300 строк (outline); создать любую Angular-сущность (generate); заменить тело функции или метода (edit_symbol)]. Полностью заменяет встроенный поиск (search_files/ripgrep) и ручные заготовки.
---

# Skill: token-economy-ts
| Задача | Действие → скрипт |
|---|---|
| найти текст | search → code-searcher.js |
| где определено | graph symbol/selector → graph-tool.js |
| кто/что использует | graph rdeps/deps → graph-tool.js |
| большой .ts | outline → symbol-index.js |
| новая сущность | generate → scaffold-helper.js |
| заменить тело метода/функции | edit_symbol → edit-symbol.js |

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
        "description": "search | outline | graph | generate | edit_symbol"
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

1. Файл меньше 300 строк читай напрямую стандартным инструментом — вызов скрипта дороже возможной экономии.
2. Файл от 300 строк — сначала `outline` (только .ts), затем точечное чтение нужного диапазона через Read(offset, limit).
3. Поиск мест ИСПОЛЬЗОВАНИЯ текста — `search`. Для html и стилей передавай `ext` (`.html`, `.scss`, `.less`, `.css`).
3а. Встроенный поиск редактора/агента (search_files, ripgrep) не используй:    в проекте есть файлы со строками длиннее 64 КБ (бандлы, source maps, base64),    на которых ripgrep обрывается ошибкой «JSON record exceeded 65536 bytes».    Весь поиск — только через code-searcher.js.
4. Поиск места ОПРЕДЕЛЕНИЯ — сначала `graph` (op: `symbol` / `selector`): один точный ответ с файлом и номером строки вместо сниппетов использований. Работает для классов, интерфейсов, функций, пайпов (по имени пайпа), селекторов компонентов и директив, а также для переменных, миксинов и функций в SCSS/Sass/Less и custom-свойств CSS (`--name`).
5. Зависимости файла и его потребителей — `graph` (op: `deps` / `rdeps` / `path`). Перед правкой общего файла (сервис, модель, пайп, общий миксин или переменная стилей) вызови `rdeps`, чтобы понять, что заденет правка.
6. Вопрос «используется ли компонент / директива / пайп» — `graph` (op: `selector`, затем при необходимости `rdeps`): `usedInTemplates` показывает шаблоны, где он применён, `rdeps` — ещё и TS-импортёры. Пустые оба списка — повод проверить динамическое использование через `search`.
7. Новые Angular-сущности (компоненты, сервисы, пайпы, модули, директивы, гварды) — только через `generate`. Заготовки руками не пишутся: шаблонный код создаётся CLI локально, выходных токенов — ноль.
8. Правки вносит штатный инструмент редактирования (замена фрагмента / diff). Файл больше 50 строк при правке менее 30% целиком не перезаписывай: выходные токены должны тратиться только на изменённый фрагмент. Целиком заменить тело функции или метода — edit_symbol (edit-symbol.js): правится только содержимое {…}, подпись, декораторы и остальной файл не читаются и не переписываются.
9. Граф строится и инкрементально обновляется скриптом автоматически при каждом вызове — это анализ, не компиляция, запуск разрешён всегда. Файлы `graph-deps.json` и `.graph-deps-cache.json` целиком НЕ читай: только ответы операций.
10. Компиляцию, линтер и тесты не запускай — проверки выполняет пользователь, об ошибках он сообщит сам.
11. Скрипты работают только с путями внутри рабочей директории; пути вне проекта отклоняй.

## Инструменты

### Чтение и поиск

search — поиск по проекту: имена файлов, номера строк и короткие сниппеты (до 30 совпадений, строка до 100 символов) вместо файлов целиком. Поиск по подстроке с учётом регистра, одно расширение за вызов (по умолчанию `.ts`, корень `src`).

outline — оглавление .ts файла: классы, методы, свойства с номерами строк (~10–20% объёма файла). Для файлов от 300 строк, дальше — точечное чтение.

### Навигация

graph — граф зависимостей с кэшем. Отвечает без чтения файлов: где определён символ (файл + строка → сразу Read с offset), кто использует файл, что использует файл, цепочка связей между файлами, циклы. Первый вызов строит граф (≈0,5 с на 4500 файлов), дальше — инкрементально; пересборка запускается сама при добавлении, удалении, переименовании и правке файлов, а также angular.json и tsconfig.json.

В граф входят файлы трёх типов:

| Тип | Расширения | Что связывается |
|---|---|---|
| ts | `.ts`, `.tsx` (без `.spec`/`.test` и `.d.ts`) | `import` / `export … from` / `import()`; алиасы из tsconfig `paths`; `templateUrl`, `styleUrl(s)`; применение компонентов, директив и пайпов в inline-`template` |
| template | .html | компоненты и директивы по selector (элемент, [атрибут], tag[атрибут], .класс), пайпы по имени; <link rel="stylesheet">; корневой index.html входит в граф |
| style | `.css`, `.scss`, `.sass`, `.less` | `@use`, `@forward`, `@import`, `@plugin`; партиалы (`_name`), `index`, `includePaths` из angular.json; пакеты (`@angular/material`, `~pkg`) попадают в `external` |

Направление ребра — «A зависит от B», поэтому:
- `deps` шаблона — компоненты, директивы, пайпы и стили, которые он использует;
- `rdeps` компонента — родительские TS-файлы и шаблоны, где он применён;
- `rdeps` стиля — компоненты и стили, которые его подключают.

Что граф не видит: динамически собранные шаблоны и селекторы, использование через `ComponentFactory`/`ViewContainerRef` по имени класса без импорта, определения CSS-классов (ищи через `search`), глобальные стили из `angular.json` (`styles`), значения атрибутов в селекторах (учитывается только наличие атрибута), `:not()` в селекторах. Применение компонента в его собственном шаблоне (рекурсия, например дерево) в граф не заносится — иначе возникает ложный цикл ts↔html.

### Изменение

generate — обёртка над локальным Angular CLI (`node_modules/.bin/ng`, без обращения к сети). Допустимые `type`: component, service, pipe, directive, guard, module, interface, enum, class, resolver, interceptor. Возвращает только список созданных и изменённых файлов.

edit_symbol — хирургическая замена тела функции или метода в .ts/.tsx: перезаписывается ТОЛЬКО содержимое между { и }; подпись, JSDoc, декораторы и остальной файл не меняются (CRLF и BOM сохраняются байт в байт). Файл не читается в контекст: агент передаёт только новое тело, в ответ приходит компактный JSON с диапазоном строк.

Символы: `save`, `UserService.save`, `UserService.constructor`, `get:prop` / `set:prop`, `UserService.get:prop`, arrow-свойства класса (`onClick = (e) => {…}`), `const fn = () => {…}` и `const fn = function () {…}`, `export function fn`. Перегрузки и abstract-сигнатуры (без тела) пропускаются — правится реализация. Стрелки с телом-выражением (`=> x * 2`, без {…}) не поддерживаются: у них нет внешних скобок для хирургической замены.

Движок: если в проекте есть пакет typescript — точные позиции Compiler API плюс синтаксическая проверка файла после подстановки; иначе fallback: маскирование строк/шаблонов/комментариев/regex, скобочный баланс и проверка отступов. Ноль зависимостей: typescript подгружается, только если уже установлен в проекте (typescript@7 без JS API пропускается).

Тело передаётся одним из способов: `body_file` (без значения — .kilo-edit-body.txt в корне проекта; рекомендуется для многострочных тел — PowerShell не передаёт переводы строк в argv; .txt в граф зависимостей не попадает; файл удаляется после успешной записи при body_file_delete=true), `body='…\n…'` (\n, \t, \r раскрываются) или `body_b64=`.

Безопасность: по умолчанию dry=true — файл НЕ перезаписывается, печатается отчёт; для записи передай dry=false. Запись атомарная (tmp+rename). При неоднозначности (несколько кандидатов), подозрительном разборе или синтаксической ошибке в новом теле скрипт отказывается от правки и возвращает список кандидатов/причину — файл остаётся нетронутым.

## Выполнение команд (PowerShell)

Команда — одна строка, параметры передаются argv-аргументами `ключ=значение` (разделитель значения — первый `=`):

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\code-searcher.js" query=ИскомыйТекст ext=.ts

Не используй пайп (`|`), `;`, `&`, `$()`, backtick, `>` и переносы строк — права среды их отклоняют, прежние вызовы через stdin-пайп больше не проходят. Права разрешают вызов по имени скрипта, поэтому полный путь в двойных кавычках допустим: команда выглядит как `node "<путь>\<скрипт>.js" ключ=значение…`.

Варианты пути до скриптов:

    глобально на Windows: "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts"
    локально в репозитории: ".kilo\skills\token-economy-ts\scripts"
    pwsh на Linux/macOS: "$HOME/.config/kilo/skills/token-economy-ts/scripts"

Значения аргументов: с пробелами — в одинарных кавычках; апостроф внутри значения удваивается (`''`); значения, начинающиеся с `$`, тоже бери в одинарные кавычки, иначе PowerShell раскроет их как переменные; двойные кавычки `"` внутри значений не используй — PowerShell 5.1 их портит, ищи подстроку без кавычек. Кириллица через argv не портится: node читает командную строку через Unicode API Windows (раньше портилась только кодировка stdin-пайпа).

Скрипты создают в корне проекта `graph-deps.json` и `.graph-deps-cache.json` — добавь их в `.gitignore`. Временный файл тела `.kilo-edit-body.txt` тоже добавь в `.gitignore` (он удаляется сам после успешной записи edit_symbol).

### search

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\code-searcher.js" query=ИскомыйТекст ext=.ts
    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\code-searcher.js" query=app-profile ext=.html

Параметры: `query` (обязательный), `ext` (по умолчанию `.ts`), `root` (по умолчанию `src`).

### outline

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\symbol-index.js" file=src/app/modules/ais/appeals/appeal-subservices.service.ts

### graph

Общий вид: `node "<путь>\graph-tool.js" op=symbol name=UserService`. Параметры: `op` (обязательный), `root` (по умолчанию `src`), `depth` (1–5, для `deps`/`rdeps`), `specs` (`true` — включить `.spec.ts`).

Где определён символ (класс, интерфейс, пайп по имени, `$переменная`, миксин, `--custom-prop`):

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\graph-tool.js" op=symbol name=UserService
    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\graph-tool.js" op=symbol name='$primary'

Селектор компонента или директивы → файл и шаблоны, где он применён (`[appHighlight]` можно писать как `appHighlight`):

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\graph-tool.js" op=selector selector=app-profile

Кто использует файл (обязательно перед правкой общего файла):

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\graph-tool.js" op=rdeps file=src/app/services/auth.service.ts depth=2

Что использует файл:

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\graph-tool.js" op=deps file=src/app/profile/profile.component.html

Цепочка связей между двумя файлами:

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\graph-tool.js" op=path from=src/app/app.component.ts to=src/styles/_variables.scss

Прочие операции: `node` (сводка по файлу: сущности, импорты, потребители), `cycles` (циклические группы; большие показываются выборкой), `stats` (размер графа и самые востребованные файлы), `build` (принудительная пересборка).

В параметре `file` можно передать путь, часть пути или имя без расширения (`profile.component` — вернётся .ts-файл; чтобы получить шаблон или стиль, укажи расширение). При неоднозначности вернётся список кандидатов.

### generate

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\scaffold-helper.js" type=component name=components/profile

### edit_symbol

Запиши новое тело в файл (каждая строка — отдельный аргумент -Value; одинарные кавычки защищают $ и backtick от PowerShell), затем вызови скрипт:

    Set-Content -Path .kilo-edit-body.txt -Value '    const url = `/api/users/${id}`;', '    return this.http.put(url, { id });' -Encoding UTF8
    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\edit-symbol.js" file=src/app/services/user.service.ts symbol=UserService.save body_file dry=false

Однострочное тело можно передать прямо в аргументах (с \n):

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\edit-symbol.js" file=src/app/services/user.service.ts symbol=UserService.save body='return this.http.get(url);' dry=false

Параметры: `file`, `symbol` (обязательные); тело — `body_file` / `body` / `body_b64` (ровно один); `engine` (auto | ts | fallback, по умолчанию auto), `indent` (auto | 2 | 4 | tab | raw — по умолчанию наследуется отступ старого тела), `dry` (по умолчанию true), `body_file_delete` (по умолчанию true). Отступ нового тела указывай без базового уровня — скрипт выровняет его под старое тело автоматически; полное тело, обёрнутое во внешние {…}, разворачивается.
