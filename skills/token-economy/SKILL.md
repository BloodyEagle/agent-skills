---
name: token-economy
description: Четыре скрипта, которые экономят токены при каждом вызове — поиск, оглавление файла, граф зависимостей (TS, HTML, стили) и генерация Angular-сущностей через CLI. Все команды — PowerShell.
---

# Skill: token-economy

## Декларация инструментов (Kilo Code Agent Tool Schema)
```json
{
  "name": "token-economy",
  "description": "Запускает скрипты для минимизации контекста ИИ.",
  "parameters": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "description": "search | outline | graph | generate"
      },
      "payload": {
        "type": "object",
        "description": "JSON-объект с параметрами действия, передаётся через stdin."
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
4. Поиск места ОПРЕДЕЛЕНИЯ — сначала `graph` (op: `symbol` / `selector`): один точный ответ с файлом и номером строки вместо сниппетов использований. Работает для классов, интерфейсов, функций, пайпов (по имени пайпа), селекторов компонентов и директив, а также для переменных, миксинов и функций в SCSS/Sass/Less и custom-свойств CSS (`--name`).
5. Зависимости файла и его потребителей — `graph` (op: `deps` / `rdeps` / `path`). Перед правкой общего файла (сервис, модель, пайп, общий миксин или переменная стилей) вызови `rdeps`, чтобы понять, что заденет правка.
6. Вопрос «используется ли компонент / директива / пайп» — `graph` (op: `selector`, затем при необходимости `rdeps`): `usedInTemplates` показывает шаблоны, где он применён, `rdeps` — ещё и TS-импортёры. Пустые оба списка — повод проверить динамическое использование через `search`.
7. Новые Angular-сущности (компоненты, сервисы, пайпы, модули, директивы, гварды) — только через `generate`. Заготовки руками не пишутся: шаблонный код создаётся CLI локально, выходных токенов — ноль.
8. Правки вносит штатный инструмент редактирования (замена фрагмента / diff). Файл больше 50 строк при правке менее 30% целиком не перезаписывай: выходные токены должны тратиться только на изменённый фрагмент.
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

## Выполнение команд (PowerShell)

Каждая команда самодостаточна: сначала определи `$TE`, затем вызови скрипт. Payload передаётся через stdin в JSON.

Варианты пути `$TE`:

    глобально на Windows: "$env:USERPROFILE\.kilocode\skills\token-economy\scripts"
    локально в репозитории: ".kilo\skills\token-economy\scripts"
    pwsh на Linux/macOS: "$HOME/.config/kilo/skills/token-economy/scripts"

В Windows PowerShell 5.1 при кириллице в payload добавляй в начало команды `$OutputEncoding=[Text.Encoding]::UTF8;` (в PowerShell 7 кодировка UTF-8 по умолчанию).

Скрипты создают в корне проекта `graph-deps.json` и `.graph-deps-cache.json` — добавь их в `.gitignore`.

### search

    $TE="$env:USERPROFILE\.kilocode\skills\token-economy\scripts"; '{"query":"ИскомыйТекст","ext":".ts"}' | node "$TE\code-searcher.js"
    $TE="$env:USERPROFILE\.kilocode\skills\token-economy\scripts"; '{"query":"app-profile","ext":".html"}' | node "$TE\code-searcher.js"

Параметры: `query` (обязательный), `ext` (по умолчанию `.ts`), `root` (по умолчанию `src`).

### outline

    $TE="$env:USERPROFILE\.kilocode\skills\token-economy\scripts"; '{"file":"src/app/modules/ais/appeals/appeal-subservices.service.ts"}' | node "$TE\symbol-index.js"

### graph

Общий вид: `$TE="…"; '<payload>' | node "$TE\graph-tool.js"`. Параметры: `op` (обязательный), `root` (по умолчанию `src`), `depth` (1–5, для `deps`/`rdeps`), `specs` (включить `.spec.ts`).

Где определён символ (класс, интерфейс, пайп по имени, `$переменная`, миксин, `--custom-prop`):

    $TE="$env:USERPROFILE\.kilocode\skills\token-economy\scripts"; '{"op":"symbol","name":"UserService"}' | node "$TE\graph-tool.js"
    $TE="$env:USERPROFILE\.kilocode\skills\token-economy\scripts"; '{"op":"symbol","name":"$primary"}' | node "$TE\graph-tool.js"

Селектор компонента или директивы → файл и шаблоны, где он применён (`[appHighlight]` можно писать как `appHighlight`):

    $TE="$env:USERPROFILE\.kilocode\skills\token-economy\scripts"; '{"op":"selector","selector":"app-profile"}' | node "$TE\graph-tool.js"

Кто использует файл (обязательно перед правкой общего файла):

    $TE="$env:USERPROFILE\.kilocode\skills\token-economy\scripts"; '{"op":"rdeps","file":"src/app/services/auth.service.ts","depth":2}' | node "$TE\graph-tool.js"

Что использует файл:

    $TE="$env:USERPROFILE\.kilocode\skills\token-economy\scripts"; '{"op":"deps","file":"src/app/profile/profile.component.html"}' | node "$TE\graph-tool.js"

Цепочка связей между двумя файлами:

    $TE="$env:USERPROFILE\.kilocode\skills\token-economy\scripts"; '{"op":"path","from":"src/app/app.component.ts","to":"src/styles/_variables.scss"}' | node "$TE\graph-tool.js"

Прочие операции: `node` (сводка по файлу: сущности, импорты, потребители), `cycles` (циклические группы; большие показываются выборкой), `stats` (размер графа и самые востребованные файлы), `build` (принудительная пересборка).

В параметре `file` можно передать путь, часть пути или имя без расширения (`profile.component` — вернётся .ts-файл; чтобы получить шаблон или стиль, укажи расширение). При неоднозначности вернётся список кандидатов.

### generate

    $TE="$env:USERPROFILE\.kilocode\skills\token-economy\scripts"; '{"type":"component","name":"components/profile"}' | node "$TE\scaffold-helper.js"
