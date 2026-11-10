# Правила для Angular-проектов (projectType=angular)

Этот файл читается ТОЛЬКО когда `graph op=info` вернул `projectType: angular`. Универсальные правила — в SKILL.md; здесь — Angular-дополнения к ним, применяются вместе с универсальными.

## Дополнительные правила

1. Поиск места ОПРЕДЕЛЕНИЯ компонента, директивы или пайпа — `graph` (op: `selector` по селектору или `symbol` по имени пайпа): один точный ответ с файлом и номером строки вместо сниппетов использований.
2. Вопрос «используется ли компонент / директива / пайп» — `graph` (op: `selector`, затем при необходимости `rdeps`): `usedInTemplates` показывает шаблоны, где он применён, `rdeps` — ещё и TS-импортёры. Пустые оба списка — повод проверить `completeness` в rdeps, scope и динамическое использование через `search`; selector сам по себе полноту не удостоверяет.
3. Новые Angular-сущности (компоненты, сервисы, пайпы, модули, директивы, гварды) — только через `generate`. Заготовки руками не пишутся: шаблонный код создаётся CLI локально, выходных токенов — ноль.
4. Перед правкой общего файла (сервис, модель, пайп, общий миксин или переменная стилей) — `rdeps`, как и в универсальных правилах; в Angular это дополнительно покажет шаблоны, где файл применён через селектор или `templateUrl`.

Селектор компонента или директивы → файл и шаблоны, где он применён (`[appHighlight]` можно писать как `appHighlight`):

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\graph-tool.js" op=selector selector=app-profile

Пайп — по имени через `symbol`:

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\graph-tool.js" op=symbol name=bold

## Граф: связи Angular-файлов

К универсальным связям (импорты ts, `<link>` в html, `@use`/`@import` в стилях) в Angular-проекте добавляются:

| Тип | Расширения | Что связывается |
|---|---|---|
| ts | `.ts`, `.tsx` (без `.spec`/`.test` и `.d.ts`) | `import` / `export … from` / `import()`; алиасы из tsconfig `paths`; `templateUrl`, `styleUrl(s)`; применение компонентов, директив и пайпов в inline-`template` |
| template | .html | компоненты и директивы по selector (элемент, [атрибут], tag[атрибут], .класс), пайпы по имени; <link rel="stylesheet">; корневой index.html входит в граф |
| style | `.css`, `.scss`, `.sass`, `.less` | `@use`, `@forward`, `@import`, `@plugin`; партиалы (`_name`), `index`, includePaths из angular.json; пакеты (`@angular/material`, `~pkg`) попадают в `external` |

Направление ребра — «A зависит от B», поэтому:

- `deps` шаблона — компоненты, директивы, пайпы и стили, которые он использует;
- `rdeps` компонента — родительские TS-файлы и шаблоны, где он применён;
- `rdeps` стиля — компоненты и стили, которые его подключают.

Что граф не видит: динамически собранные шаблоны и селекторы, использование через `ComponentFactory`/`ViewContainerRef` по имени класса без импорта, определения CSS-классов (ищи через `search`), глобальные стили из `angular.json` (`styles`), значения атрибутов в селекторах (учитывается только наличие атрибута), `:not()` в селекторах. Применение компонента в его собственном шаблоне (рекурсия, например дерево) в граф не заносится — иначе возникает ложный цикл ts↔html.

Дубли одного selector в разных файлах видны в `warnings` у `info` и `selector`; структурные ответы получают `completeness.complete=false` с причиной `duplicate-selectors`. Поле `selector.file` сохраняет прежний выбор одного файла и не означает уникальность. Связи шаблона сохраняются со всеми статически совпавшими компонентами/директивами.

## generate

Обёртка над локальным Angular CLI (`node_modules/.bin/ng`, без обращения к сети). Допустимые `type`: component, service, pipe, directive, guard, module, interface, enum, class, resolver, interceptor. Возвращает только список созданных и изменённых файлов.

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\scaffold-helper.js" type=component name=components/profile

## sig для Angular-пакетов

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\sig-reader.js" name=@angular/common/http#HttpClient member=get
