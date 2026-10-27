---
name: token-economy-ts
description: Обязательный навык для этого Angular-проекта. Применять всегда, когда нужно [узнать проект одним вызовом — версии, алиасы, состав файлов (graph: info); найти текст в коде (search); узнать, где определён класс/пайп/селектор/$переменная/миксин (graph-> symbol/selector); кто использует файл и что он использует (graph-> deps/ rdeps/deps); читать TS-файл от 300 строк (outline); узнать API сторонней библиотеки — сигнатуры классов, функций и их членов из node_modules (sig); создать любую Angular-сущность (generate)]. Полностью заменяет встроенный поиск (search_files/ripgrep) и ручные заготовки.
---

# Skill: token-economy-ts
| Задача | Действие → скрипт |
|---|---|
| найти текст | search → code-searcher.js |
| где определено | graph symbol/selector → graph-tool.js |
| кто/что использует | graph rdeps/deps → graph-tool.js |
| большой .ts | outline → symbol-index.js |
| новая сущность | generate → scaffold-helper.js |

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
        "description": "search | outline | graph | generate | sig"
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

1. Один раз за разговор, прежде чем читать или править файлы, вызови `graph` (op: `info`): версии Angular и ключевых зависимостей, алиасы tsconfig, состав файлов по видам, самые большие файлы, предупреждения.
2. Файл меньше 300 строк читай напрямую стандартным инструментом — вызов скрипта дороже возможной экономии.
3. Файл от 300 строк — сначала `outline` (только .ts), затем точечное чтение нужного диапазона через Read(offset, limit).
4. Поиск мест ИСПОЛЬЗОВАНИЯ текста — `search`. Для html и стилей передавай `ext` (`.html`, `.scss`, `.less`, `.css`).
4а. Встроенный поиск редактора/агента (search_files, ripgrep) не используй:    в проекте есть файлы со строками длиннее 64 КБ (бандлы, source maps, base64),    на которых ripgrep обрывается ошибкой «JSON record exceeded 65536 bytes».    Весь поиск — только через code-searcher.js.
5. Поиск места ОПРЕДЕЛЕНИЯ — сначала `graph` (op: `symbol` / `selector`): один точный ответ с файлом и номером строки вместо сниппетов использований. Работает для классов, интерфейсов, функций, пайпов (по имени пайпа), селекторов компонентов и директив, для переменных, миксинов и функций в SCSS/Sass/Less и custom-свойств CSS (`--name`), а также для методов и свойств классов и интерфейсов (в ответе — `owner`; при частом имени уточняй `in=ИмяКласса`).
6. Зависимости файла и его потребителей — `graph` (op: `deps` / `rdeps` / `path`). Перед правкой общего файла (сервис, модель, пайп, общий миксин или переменная стилей) вызови `rdeps`, чтобы понять, что заденет правка.
7. Вопрос «используется ли компонент / директива / пайп» — `graph` (op: `selector`, затем при необходимости `rdeps`): `usedInTemplates` показывает шаблоны, где он применён, `rdeps` — ещё и TS-импортёры. Пустые оба списка — повод проверить динамическое использование через `search`.
8. Сигнатуры классов, интерфейсов, enum, функций (со всеми перегрузками) и их членов сторонних библиотек — `sig`: API rxjs, Material, ngrx и других пакетов узнаётся из node_modules без чтения .d.ts файлов. Файлы из node_modules штатными инструментами не читай и API не угадывай.
9. Новые Angular-сущности (компоненты, сервисы, пайпы, модули, директивы, гварды) — только через `generate`. Заготовки руками не пишутся: шаблонный код создаётся CLI локально, выходных токенов — ноль.
10. Правки вносит штатный инструмент редактирования (замена фрагмента / diff). Файл больше 50 строк при правке менее 30% целиком не перезаписывай: выходные токены должны тратиться только на изменённый фрагмент.
11. Граф строится и инкрементально обновляется скриптом автоматически при каждом вызове — это анализ, не компиляция, запуск разрешён всегда. Файлы `graph-deps.json` и `.graph-deps-cache.json` целиком НЕ читай: только ответы операций.
12. Компиляцию, линтер и тесты не запускай — проверки выполняет пользователь, об ошибках он сообщит сам.
13. Скрипты работают только с путями внутри рабочей директории; пути вне проекта отклоняй.

## Инструменты

### Чтение и поиск

search — поиск по проекту: имена файлов, номера строк и короткие сниппеты (по умолчанию до 30 совпадений, строка до 100 символов) вместо файлов целиком. Поиск по подстроке или регулярному выражению, несколько расширений за вызов (по умолчанию `.ts`, корень `src`).

outline — оглавление .ts файла: классы, методы, свойства с номерами строк (~10–20% объёма файла). Для файлов от 300 строк, дальше — точечное чтение.

sig — сигнатуры сторонних библиотек из node_modules: классы, интерфейсы, enum, функции (со всеми перегрузками) и их члены. Резолв через package.json (exports/types) и реэкспорты; файлы .d.ts целиком не читаются.

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

## Выполнение команд (PowerShell)

Команда — одна строка, параметры передаются argv-аргументами `ключ=значение` (разделитель значения — первый `=`):

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\code-searcher.js" query=ИскомыйТекст ext=.ts

Не используй пайп (`|`), `;`, `&`, `$()`, backtick, `>` и переносы строк — права среды их отклоняют, прежние вызовы через stdin-пайп больше не проходят. Права разрешают вызов по имени скрипта, поэтому полный путь в двойных кавычках допустим: команда выглядит как `node "<путь>\<скрипт>.js" ключ=значение…`.

Варианты пути до скриптов:

    глобально на Windows: "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts"
    локально в репозитории: ".kilo\skills\token-economy-ts\scripts"
    pwsh на Linux/macOS: "$HOME/.config/kilo/skills/token-economy-ts/scripts"

Значения аргументов: с пробелами — в одинарных кавычках; апостроф внутри значения удваивается (`''`); значения, начинающиеся с `$`, тоже бери в одинарные кавычки, иначе PowerShell раскроет их как переменные; двойные кавычки `"` внутри значений не используй — PowerShell 5.1 их портит, ищи подстроку без кавычек. Кириллица через argv не портится: node читает командную строку через Unicode API Windows (раньше портилась только кодировка stdin-пайпа).

Скрипты создают в корне проекта `graph-deps.json` и `.graph-deps-cache.json` — добавь их в `.gitignore`.

### search

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\code-searcher.js" query=ИскомыйТекст ext=.ts
    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\code-searcher.js" query=app-profile ext=.html

Параметры: `query` (обязательный), `ext` (по умолчанию `.ts`; несколько через запятую — `ext=.ts,.html`), `root` (по умолчанию `src`), `i=1` (без учёта регистра), `regex=1` (`query` — регулярное выражение), `limit` (по умолчанию 30), `files=1` (только список файлов со счётчиком совпадений).

Без учёта регистра и по нескольким расширениям сразу:

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\code-searcher.js" query=userName ext=.ts,.html i=1

Регулярное выражение и только файлы:

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\code-searcher.js" query=app-[a-z-]+ ext=.html regex=1 files=1


### outline

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\symbol-index.js" file=src/app/modules/ais/appeals/appeal-subservices.service.ts

### graph

Общий вид: `node "<путь>\graph-tool.js" op=symbol name=UserService`. Параметры: `op` (обязательный), `root` (по умолчанию `src`), `depth` (1–5, для `deps`/`rdeps`), `specs` (`true` — включить `.spec.ts`), `why` (`true` — добавить `via`: номер строки импорта в `deps`/`rdeps`/`node`).

Где определён символ (класс, интерфейс, пайп по имени, `$переменная`, миксин, `--custom-prop`):

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\graph-tool.js" op=symbol name=UserService
    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\graph-tool.js" op=symbol name='$primary'

Селектор компонента или директивы → файл и шаблоны, где он применён (`[appHighlight]` можно писать как `appHighlight`):

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\graph-tool.js" op=selector selector=app-profile

Метод или свойство класса (файл + строка + класс-владелец; частое имя — с `in=`):

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\graph-tool.js" op=symbol name=ngOnInit in=UserListComponent


Кто использует файл (обязательно перед правкой общего файла); `why=1` добавляет `via` — номер строки импорта (только для ts-связей):

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\graph-tool.js" op=rdeps file=src/app/services/auth.service.ts depth=2
    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\graph-tool.js" op=rdeps file=src/app/services/auth.service.ts why=1


Что использует файл:

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\graph-tool.js" op=deps file=src/app/profile/profile.component.html

Цепочка связей между двумя файлами:

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\graph-tool.js" op=path from=src/app/app.component.ts to=src/styles/_variables.scss

Прочие операции: `info` (паспорт проекта: версии, алиасы tsconfig, состав файлов, крупнейшие файлы, предупреждения — один вызов в начале разговора), `node` (сводка по файлу: сущности, импорты, потребители), `cycles` (циклические группы; большие показываются выборкой), `stats` (размер графа и самые востребованные файлы), `build` (принудительная пересборка).

Паспорт проекта:

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\graph-tool.js" op=info


В параметре `file` можно передать путь, часть пути или имя без расширения (`profile.component` — вернётся .ts-файл; чтобы получить шаблон или стиль, укажи расширение). При неоднозначности вернётся список кандидатов.

### sig

API сторонних библиотек без чтения node_modules — класс целиком или один член:

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\sig-reader.js" name=rxjs#Observable
    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\sig-reader.js" name=rxjs#Observable member=subscribe
    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\sig-reader.js" name=@angular/common/http#HttpClient member=get

Функция — все перегрузки: `name=rxjs/operators#map`. Параметры: `name` (обязательный) — пакет с подпутем, член после `#`; `member` — можно задать отдельно; `limit` (по умолчанию 40) — максимум сигнатур в ответе. Если член не найден, ответ содержит `available` — доступные имена (экспорты файла или члены класса).

### generate

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\scaffold-helper.js" type=component name=components/profile
