---
name: token-economy-ts
version: 1.3.1
description: Обязательный навык для TypeScript/JavaScript/Angular-проектов, включая React, Node.js (Express/Fastify/Koa), NestJS и Vue. Применять всегда для поиска текста (search, в том числе пакетно: requests=/requests_file=), определений и связей ESM/CommonJS (graph symbol/deps/rdeps/selector/path), точечного чтения диапазонов (graph op=read), оглавления больших TS/JS-файлов (outline, с диапазонами L<start>-<end> и пагинацией node), сигнатур сторонних библиотек (sig), использования React-компонентов в JSX (graph op=component), замены тела метода/функции (edit_symbol) и создания Angular-сущностей (generate). Все читающие команды — graph, search, outline, sig — поддерживают batch: один вызов, много запросов, общий scope и один проход по графу; compact=1 даёт компактный вывод со словарём путей. Тип проекта определяется автоматически (graph op=info → projectType); Angular- и React-специфика подключаются по типу проекта (references/angular.md, references/react.md). Полностью заменяет встроенный поиск (search_files/ripgrep) и ручные заготовки.
---

# Skill: token-economy-ts

## Когда применять

TypeScript/JavaScript/Angular, а также React, Node.js (Express/Fastify/Koa), NestJS и Vue-проекты на JS. Исходники: `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`. Тип проекта (`projectType`: `angular` / `react` / `nest` / `node` / `ts`) определяется автоматически при `graph op=info`.

| Задача | Действие → скрипт |
|---|---|
| найти текст | search → code-searcher.js |
| где определено | graph symbol/selector → graph-tool.js |
| кто/что использует | graph rdeps/deps → graph-tool.js |
| кто вызывает `require('./util')` | graph rdeps → graph-tool.js |
| где объявлен экспорт `module.exports.name` | graph symbol → graph-tool.js |
| большой TS/JS-файл | outline → symbol-index.js |
| где React-компонент и где он в JSX | graph op=component → graph-tool.js |
| точное чтение нескольких диапазонов | graph op=read → graph-tool.js |
| API библиотеки | sig → sig-reader.js |
| новая Angular-сущность | generate → scaffold-helper.js |
| заменить тело метода/функции | edit_symbol → edit-symbol.js |

## MegaMemory и scope

При доступной MegaMemory применяй общий порядок из `rules/RULES.md`, раздел «megamemory»: релевантная память → квалификация → актуальная навигация → необходимые диапазоны → проверенная запись. Без памяти действуй обычным путём. Декларация action/payload ниже не является executable dispatcher. Cwd — корень анализируемого проекта, каталог scripts задаётся независимо абсолютным путём.

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

0. Один раз за разговор, прежде чем читать или править файлы, вызови `graph` (op: `info`): он определяет тип проекта (`projectType`: `angular` / `react` / `nest` / `node` / `ts`), версии ключевых зависимостей, алиасы tsconfig, состав файлов по видам, самые большие файлы, предупреждения. Если `projectType=angular` — прочитай `references/angular.md` из каталога скилла (лежит рядом со `scripts`) и применяй его правила в дополнение к универсальным: там селекторы, пайпы, generate и Angular-часть графа. Если `projectType=react` — прочитай `references/react.md` и применяй его правила в дополнение к универсальным: использования компонентов в JSX (`op=component`), хуки, стили-импорты в графе. Для `nest`, `node` и `ts` дополнительных правил нет — достаточно универсальных ниже.
1. Файл меньше 300 строк читай напрямую стандартным инструментом — вызов скрипта дороже возможной экономии.
2. Файл от 300 строк — сначала `outline` (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`), затем точечное чтение нужного диапазона через Read(offset, limit). Для диапазона объявления используй `compact=1` в outline (`L<start>-<end>`) или `graph symbol`/`node` (поля `startLine`/`endLine`): `limit = end - start + 1`; несколько диапазонов одного файла — `graph op=read` одним вызовом.
3. Поиск мест ИСПОЛЬЗОВАНИЯ текста — `search`. Для html и стилей передавай `ext` (`.html`, `.scss`, `.less`, `.css`).
4. Встроенный поиск редактора/агента (search_files, ripgrep) не используй: в проекте могут быть файлы со строками длиннее 64 КБ (бандлы, source maps, base64), на которых ripgrep обрывается ошибкой «JSON record exceeded 65536 bytes». Весь поиск — только через code-searcher.js.
5. Поиск места ОПРЕДЕЛЕНИЯ — сначала `graph` (op: `symbol`): один точный ответ с файлом и номером строки вместо сниппетов использований. Работает для классов, интерфейсов, функций, для переменных, миксинов и функций в SCSS/Sass/Less и custom-свойств CSS (`--name`), а также для методов и свойств классов и интерфейсов (в ответе — `owner`; при частом имени уточняй `in=ИмяКласса`). В Angular-проектах — также пайпы по имени и селекторы компонентов/директив (см. references/angular.md). В React-проектах — также использования компонента в JSX через `op=component` (см. references/react.md).
6. Зависимости файла и его потребителей — `graph` (op: `deps` / `rdeps` / `path`). Перед правкой общего файла (сервис, модель, утилита, пайп, общий миксин или переменная стилей) вызови `rdeps`, чтобы понять, что заденет правка.
7. Сигнатуры классов, интерфейсов, enum, функций (со всеми перегрузками) и их членов сторонних библиотек — `sig`: API rxjs, Material, ngrx, @nestjs/* и других пакетов узнаётся из node_modules без чтения .d.ts файлов. Файлы из node_modules штатными инструментами не читай и API не угадывай.
8. Правки вносит штатный инструмент редактирования (замена фрагмента / diff). Файл больше 50 строк при правке менее 30% целиком не перезаписывай: выходные токены должны тратиться только на изменённый фрагмент.
9. Граф строится и инкрементально обновляется скриптом автоматически при каждом вызове — это анализ, не компиляция, запуск разрешён всегда. Файлы `graph-deps.json` и `.graph-deps-cache.json` целиком НЕ читай: только ответы операций.
10. Компиляцию, линтер и тесты не запускай — проверки выполняет пользователь, об ошибках он сообщит сам.
11. Прямые пути работают только внутри рабочей директории; пути вне проекта отклоняй. `sig` проверяет также `realpath` (symlink/junction не обходят границу). Для bare-имени установленного пакета разрешено только чтение деклараций из найденного `node_modules`, включая родительский workspace и ссылку на пакет: относительные реэкспорты ограничены реальным корнем пакета, другие зависимости ищутся по bare-имени от импортёра вверх.

## Инструменты

### Чтение и поиск

search — поиск по проекту: имена файлов, номера строк и короткие сниппеты (по умолчанию до 30 совпадений, строка до 100 символов) вместо файлов целиком. Поиск по подстроке или регулярному выражению; по умолчанию `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, явный `ext=` заменяет список. Корень — `src`, если он существует, иначе `.`. Каталоги зависимостей, сборки и кэшей не обходятся.

Опциональные режимы search (дефолтная выдача не меняется):
- `word=1` — совпадение по границам TS/JS-идентификатора (класс продолжения `[$\u200C\u200D\p{ID_Continue}]`): `save` не совпадает с `saved` и `$save`, совпадает с `my-save`. Это raw text, не разрешение ссылок: escaped-идентификаторы и вхождения в строках/комментариях находятся наравне с кодом. С `regex=1` не сочетается.
- `format=grouped` / `format=runs` — обратимые компактные формы: путь передаётся один раз на файл (`{groups:[{file,hits:[{line,text}]}]}`); `runs` дополнительно кодирует подряд идущие строки как `{startLine,texts[]}`. Все сниппеты и порядок сохраняются; `count` — полное число совпавших строк, `shownMatches` — показанных. Множество путей с общим префиксом передаётся как `pathPrefix` + суффиксы (полный путь = конкатенация). Один хит может дать overhead — форма по потребности, выигрыш не гарантирован.
- `context=N` — код соседних строк блоками на файл: `{files:[{file,blocks:[{startLine,lines[],hits[]}]}]}`. Перекрывающиеся и вплотную соседние окна объединяются; текст строк полный (строка может быть длинной). `N` строк не заменяют чтение файла, если нужны семантика или полная структура.
- `requests=[{query,...},…]` или `requests_file=файл` (UTF-8 JSON внутри проекта) — пакетный поиск: у каждого запроса свои параметры и хиты, no-match одного не влияет на другой. Ответ: `{batch,total,failed,results:[…|{index,error}]}`; exit 0 при хотя бы одном выполненном запросе, 1 — если все завершились ошибками (`failed>0` при exit 0 означает частичный провал). Запросы не заменяются объединением `A|B`: оно теряет идентичность запросов и лимиты.

outline — оглавление TS/JS-файла: классы, функции, стрелки (включая generic), CommonJS-экспорты, методы и свойства с номерами строк. Arrow-свойства класса отмечаются как методы; Unicode-идентификаторы поддерживаются в outline, graph symbol и sig. Приватные `#`-члены отмечаются отдельно, JSX-теги не являются символами. По умолчанию до 60 строк символов (`limit=` меняет предел; `count` содержит полное число); для больших файлов дальше читай нужный диапазон. Минифицированный код не предназначен для outline — используй search с `regex=1`. `compact=1` — компактный формат без выравнивания, для объявлений с известным концом — `L<start>-<end>` (полный span объявления, как `endLine` в graph). Пакетный режим — `requests=[{file,...},…]` / `requests_file=`, конверт как у search.

На Windows расширения исходников и исключаемые каталоги сравниваются без учёта регистра; регистр исходного пути сохраняется в ответе. Комментарии, строковые части шаблонов и regex не создают объявления; деление не маскируется как regex. Лексическая маска не заменяет полный TS/JS-парсер.

sig — сигнатуры сторонних библиотек из node_modules: классы, интерфейсы, enum, функции (со всеми перегрузками) и их члены. Резолв через package.json (exports/types) и реэкспорты; файлы .d.ts целиком не читаются. Пробелы внутри строковых literal types сохраняются дословно (`'a  b'` не превращается в `'a b'`). Сигнатуры по умолчанию обрезаются на 200 символах: обрезка помечается (`clippedSignatures` — индексы в `signatures`, `declClipped`/`clipped`/`clippedMembers` на элементах деклараций); `full=1` возвращает сигнатуры целиком. `offset` — доступ к хвосту списков сигнатур (карточка класса, перегрузки, список деклараций). Пакетный режим — `requests=[{name,...},…]` / `requests_file=`; у каждого запроса свой traversal-состояние, чтение файлов кэшируется. JSDoc/deprecated-заметки в sig не переносятся: для вопросов о назначении API читай декларацию точечно.

### Навигация

graph — граф зависимостей с кэшем. Отвечает без чтения файлов: где определён символ (файл + строка → сразу Read с offset), кто использует файл, что использует файл, цепочка связей между файлами, циклы. Первый вызов строит граф (≈0,5 с на 4500 файлов), дальше — инкрементально; пересборка запускается сама при добавлении, удалении, переименовании и правке файлов, а также angular.json, tsconfig.json и package.json.

Диапазоны в `symbol` и `node`: когда разбор надёжен, сущности и члены несут `startLine`/`endLine` (полное объявление) и `bodyStartLine`/`bodyEndLine` (тело). Это 1-based координаты источника; для точечного чтения через Read: `offset = startLine`, `limit = endLine - startLine + 1` (если нужен только код — от `bodyStartLine`). Декораторы и JSDoc в span не входят (`startLine` — строка ключевого слова; у Angular-сущностей `line` — строка декоратора). Скептический fallback без TypeScript Compiler API: где границу надёжно определить нельзя, поля конца нет вовсе — отсутствие `endLine` означает «нужно чтение», а не «конец равен началу строки». Сигнатура, перегрузки и инициализатор входят в span; смежные комментарии — нет.

TS ESM explicit `.js` разрешается в `.ts`, затем `.tsx`, затем существующий `.js`; для JS-импортёра существующий JS имеет приоритет. Extensionless сохраняет TS-first/JS-first по импортёру. `.mjs/.cjs` поддерживаются как реальные исходники; подстановка в `.mts/.cts` не реализована, эти расширения исключены. Alias и reexport используют тот же resolver. `baseUrl` без `paths` разрешает bare specifier через тот же ESM resolver; если локального source target нет, пакет остаётся external. Поддерживается локальный относительный `tsconfig extends` внутри cwd; package/absolute extends, `moduleSuffixes/rootDirs/customConditions` отмечаются неполнотой, не обещается полный TypeScript Compiler API resolution.

Кэш учитывает canonical cwd/root/specs, present/missing и SHA256 конфигов, включая прочитанные локальные extends. Создание/изменение/удаление config перестраивает связи даже с прежним mtime. При ошибке записи кэша используется свежий in-memory результат с явной неполнотой. Старый/повреждённый кэш и кэш прежней версии парсера перестраиваются; перед reuse проверяются обязательные parsed поля и specifiers по типу файла, повреждённые entries перепарсиваются из source при сохранённых mtime/size.

Существующие локальные `.json` импорты (также через alias/baseUrl и с query) считаются ресурсами, не source-узлами: не увеличивают `unresolved`, их создание/удаление обновляет полноту без правки импортёра. Отсутствующий или ведущий вне cwd JSON остаётся unresolved. Поиск циклов итеративный и не зависит от глубины JS call stack; крупные SCC выводятся выборкой.

В граф входят файлы трёх типов:

| Тип | Расширения | Что связывается |
|---|---|---|
| ts / js | `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs` (без `.spec`/`.test` и `.d.ts`) | `import` / `export … from` / `import()` / `require()` / `module.exports`; алиасы из tsconfig `paths`; Angular-шаблоны и стили |
| template | .html | компоненты и директивы по selector (элемент, [атрибут], tag[атрибут], .класс), пайпы по имени; <link rel="stylesheet">; корневой index.html входит в граф |
| style | `.css`, `.scss`, `.sass`, `.less` | `@use`, `@forward`, `@import`, `@plugin`; партиалы (`_name`), `index`, `includePaths` из angular.json; пакеты (`@angular/material`, `~pkg`) попадают в `external` |

Направление ребра — «A зависит от B», поэтому:
- `deps` шаблона — компоненты, директивы, пайпы и стили, которые он использует;
- `rdeps` компонента — родительские TS/JS-файлы и шаблоны, где он применён;
- `rdeps` стиля — компоненты и стили, которые его подключают.

Что граф не видит: динамически собранные шаблоны и селекторы, использование через `ComponentFactory`/`ViewContainerRef` по имени класса без импорта, определения CSS-классов (ищи через `search`), глобальные стили из `angular.json` (`styles`), значения атрибутов в селекторах (учитывается только наличие атрибута), `:not()` в селекторах. Применение компонента в его собственном шаблоне (рекурсия, например дерево) в граф не заносится — иначе возникает ложный цикл ts↔html. В Angular-проектах действуют дополнительные правила (селекторы, пайпы, generate) — см. references/angular.md.

`op=component name=<Имя>` — где объявлен React-компонент и где он применён в JSX. Требует `react` >= 16 в `package.json` (иначе «React не найден в проекте», код 1). Ответ: `{found, definedIn:[{file, kind, line, startLine, endLine}], usedTotal, usedIn:[{file, line}], scope, completeness}`. `usedIn` собирается по открывающим тегам `<Имя`; строки, комментарии и шаблонные литералы замаскированы и использованиями не считаются, поэтому `<Имя>` внутри строки или комментария в ответ не попадает. Использование в собственном файле компонента тоже считается. Правила React-проектов — references/react.md.

### Изменение

Angular-команды в проекте без Angular неприменимы: `graph selector`, `generate` и `scaffold` выводят «Angular не найден в проекте: команда неприменима» и завершаются с кодом 1. Angular определяется по `angular.json` или `@angular/core` в `package.json` (в `op=info` это `projectType=angular`). Остальные команды работают без Angular.

`op=component` требует React 16+ (определяется по `react` в `package.json`); без него — «React не найден в проекте» и код 1.

generate (scaffold) — обёртка над локальным Angular CLI (`node_modules/.bin/ng`, без обращения к сети); доступна только в Angular-проектах (`projectType=angular`). Допустимые `type`: component, service, pipe, directive, guard, module, interface, enum, class, resolver, interceptor. Возвращает только список созданных и изменённых файлов. Параметры и примеры — в references/angular.md.

edit_symbol — хирургическая замена тела функции или метода в `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`: перезаписывается ТОЛЬКО содержимое между { и }; подпись, JSDoc, декораторы и остальной файл не меняются (CRLF и BOM сохраняются байт в байт). Файл не читается в контекст: агент передаёт только новое тело, в ответ приходит компактный JSON с диапазоном строк.

Символы: `save`, `UserService.save`, `UserService.constructor`, `get:prop` / `set:prop`, `UserService.get:prop`, arrow-свойства класса (`onClick = (e) => {…}`), `const fn = () => {…}` и `const fn = function () {…}`, `export function fn`. Перегрузки и abstract-сигнатуры (без тела) пропускаются — правится реализация. Стрелки с телом-выражением (`=> x * 2`, без {…}) не поддерживаются: у них нет внешних скобок для хирургической замены.

Движок: если в проекте есть пакет typescript — точные позиции Compiler API плюс синтаксическая проверка файла после подстановки; иначе fallback: маскирование строк/шаблонов/комментариев/regex, скобочный баланс и проверка отступов. Ноль зависимостей: typescript подгружается, только если уже установлен в проекте (typescript@7 без JS API пропускается).

Тело передаётся одним из способов: `body_file` (без значения — .kilo-edit-body.txt в корне проекта; рекомендуется для многострочных тел — PowerShell не передаёт переводы строк в argv; .txt в граф зависимостей не попадает; файл удаляется после успешной записи при body_file_delete=true), `body='…\n…'` (\n, \t, \r раскрываются) или `body_b64=`.

Безопасность: по умолчанию dry=true — файл НЕ перезаписывается, печатается отчёт; для записи передай dry=false. Запись атомарная (tmp+rename). При неоднозначности (несколько кандидатов), подозрительном разборе или синтаксической ошибке в новом теле скрипт отказывается от правки и возвращает список кандидатов/причину — файл остаётся нетронутым.

## Выполнение команд (PowerShell)

Команда — одна строка, параметры передаются argv-аргументами `ключ=значение` (разделитель значения — первый `=`):

    node "<SCRIPTS_DIR>\code-searcher.js" query=ИскомыйТекст ext=.ts

Не используй пайп (`|`), `;`, `&`, `$()`, backtick, `>` и переносы строк — права среды их отклоняют, прежние вызовы через stdin-пайп больше не проходят. Права разрешают вызов по имени скрипта, поэтому полный путь в двойных кавычках допустим: команда выглядит как `node "<SCRIPTS_DIR>\<скрипт>.js" ключ=значение…`.

`<SCRIPTS_DIR>` — папка `scripts` этого скилла: возьми полный путь этого SKILL.md и замени имя файла на `scripts`. Каталог скиллов агента: ZCode — `%USERPROFILE%\.zcode\skills\…` (в репозитории проекта — `.zcode\skills\…`), Kilo Code — `%USERPROFILE%\.kilocode\skills\…` (в репозитории — `.kilo\skills\…`, Linux/macOS — `~/.config/kilo/skills/…`).

Файл Angular-правил лежит в том же каталоге скилла, рядом со `scripts`: `<каталог скилла>\references\angular.md`. Читай его стандартным инструментом чтения файлов. Рядом лежит и файл React-правил: `<каталог скилла>\references\react.md` — читается при `projectType=react`.

Значения аргументов: с пробелами — в одинарных кавычках; апостроф внутри значения удваивается (`''`); значения, начинающиеся с `$`, тоже бери в одинарные кавычки, иначе PowerShell раскроет их как переменные; двойные кавычки `"` внутри значений не используй — PowerShell 5.1 их портит, ищи подстроку без кавычек. Кириллица через argv не портится: node читает командную строку через Unicode API Windows (раньше портилась только кодировка stdin-пайпа).

Скрипты создают в корне проекта `graph-deps.json` и `.graph-deps-cache.json` — добавь их в `.gitignore`. Временный файл тела `.kilo-edit-body.txt` тоже добавь в `.gitignore` (он удаляется сам после успешной записи edit_symbol).

### search

    node "<SCRIPTS_DIR>\code-searcher.js" query=ИскомыйТекст ext=.ts
    node "<SCRIPTS_DIR>\code-searcher.js" query=app-profile ext=.html

Параметры: `query` (обязательный), `ext` (по умолчанию `.ts,.tsx,.js,.jsx,.mjs,.cjs`; явный список заменяет дефолт), `root` (по умолчанию `src`, при его отсутствии `.`), `i=1` (без учёта регистра), `regex=1` (`query` — регулярное выражение), `word=1` (границы идентификатора; с `regex=1` не сочетается), `limit` (по умолчанию 30), `files=1` (только список файлов со счётчиком совпадений), `format=grouped|runs` (компактная форма: путь один раз на файл), `context=N` (соседний код блоками), `requests`/`requests_file` (пакетный поиск). Компактные формы и context включаются по потребности и не обещают выигрыш на каждом ответе.

Без учёта регистра и по нескольким расширениям сразу:

    node "<SCRIPTS_DIR>\code-searcher.js" query=userName ext=.ts,.html i=1

Регулярное выражение и только файлы:

    node "<SCRIPTS_DIR>\code-searcher.js" query=app-[a-z-]+ ext=.html regex=1 files=1

### outline

    node "<SCRIPTS_DIR>\symbol-index.js" file=src/app/modules/ais/appeals/appeal-subservices.service.ts
    node "<SCRIPTS_DIR>\symbol-index.js" file=src/App.jsx limit=60

### graph

Общий вид: `node "<SCRIPTS_DIR>\graph-tool.js" op=symbol name=UserService`. Параметры: `op` (обязательный), `root` (по умолчанию `src`, при его отсутствии `.`), `depth` (1–5, для `deps`/`rdeps`), `specs` (`true` — включить `.spec`/`.test` исходники TS/JS), `why` (`true` — добавить `via`: номер строки импорта в `deps`/`rdeps`/`node`). Неразрешённые локальные пути учитываются в `unresolved`, внешние пакеты — отдельно в `external`.

JS-пример:

    node "<SCRIPTS_DIR>\graph-tool.js" op=rdeps file=app.js root=.
    node "<SCRIPTS_DIR>\graph-tool.js" op=deps file=src/App.jsx

Где определён символ (класс, интерфейс, пайп по имени, `$переменная`, миксин, `--custom-prop`):

    node "<SCRIPTS_DIR>\graph-tool.js" op=symbol name=UserService
    node "<SCRIPTS_DIR>\graph-tool.js" op=symbol name='$primary'

Селектор компонента или директивы → файл и шаблоны, где он применён (`[appHighlight]` можно писать как `appHighlight`; только в Angular-проектах — см. references/angular.md):

    node "<SCRIPTS_DIR>\graph-tool.js" op=selector selector=app-profile

Метод или свойство класса (файл + строка + класс-владелец; частое имя — с `in=`):

    node "<SCRIPTS_DIR>\graph-tool.js" op=symbol name=ngOnInit in=UserListComponent

Кто использует файл (обязательно перед правкой общего файла); `why=1` добавляет `via` — номер строки импорта (только для ts-связей):

    node "<SCRIPTS_DIR>\graph-tool.js" op=rdeps file=src/app/services/auth.service.ts depth=2
    node "<SCRIPTS_DIR>\graph-tool.js" op=rdeps file=src/app/services/auth.service.ts why=1

Что использует файл:

    node "<SCRIPTS_DIR>\graph-tool.js" op=deps file=src/app/profile/profile.component.html

Цепочка связей между двумя файлами:

    node "<SCRIPTS_DIR>\graph-tool.js" op=path from=src/app/app.component.ts to=src/styles/_variables.scss

Где определён React-компонент и где он использован в JSX (файл + строка каждого `<Имя`; только в React-проектах):

    node "<SCRIPTS_DIR>\graph-tool.js" op=component name=UserCard

Прочие операции: `info` (паспорт проекта: тип проекта, версии, алиасы tsconfig, состав файлов, крупнейшие файлы, предупреждения — один вызов в начале разговора), `node` (сводка по файлу: сущности, импорты, потребители; `importsTotal`/`importedByTotal`/`entitiesTotal`, `offset`/`limit` для страниц `entities`/`importedBy` — imports выводятся целиком), `cycles` (циклические группы; большие показываются выборкой), `stats` (размер графа и самые востребованные файлы), `read` (точное чтение диапазонов одного файла: `ranges=10-20,30-40` либо массив [[10,20],…]; перекрытия и вплотную соседние объединяются, зазор — нет; BOM снят, EOL нормализованы в `\n`; диапазоны сверяются с фактическим файлом, суммарный запрос >2000 строк — явный отказ, а не усечка), `build` (принудительная пересборка), `component` (определение и JSX-использования компонента; только в React-проектах). Неизвестный `op` отклоняется до записи графа и кэша. Дубли selector в разных файлах отмечаются `warnings` в `info`/`selector` и причиной `duplicate-selectors` в структурной `completeness`; возвращённый `selector.file` не доказывает уникальности.

Пакетный режим graph: `requests=[{"op":"symbol","name":"A"},{"op":"rdeps","file":"src/b.ts","depth":2},…]` или `requests_file=` (UTF-8 JSON внутри проекта; удобно для PowerShell 5.1). Разрешены только read-операции (`info/node/deps/rdeps/symbol/selector/path/component/cycles/stats/read`); write-операции в batch не входят. Запросы группируются по scope (`root`+`specs`): граф и reverse index строятся один раз на группу, разные scope не объединяются молча. Ответ: `{batch,total,failed,results:[…|{index,error}]}`; `found:false` и `ambiguous` — ответы, а не ошибки; exit-код 0 при хотя бы одном выполненном запросе, 1 — при полном провале. `compact=1` — opt-in словарь путей (`paths` + числовые индексы в документированных позициях: `file`/`from`/`to`, `.file` в списках рёбер/определений, `chain`/`usedInTemplates`) и hoist `scope`/`completeness` наверх при точном равенстве у всех успешных ответов; декодер восстанавливает одиночные ответы.

Паспорт проекта:

    node "<SCRIPTS_DIR>\graph-tool.js" op=info

`file`, `from`, `to` с сегментами/слешами или абсолютный путь — только нормализованный exact match внутри cwd, без basename fallback; отсутствующий/внешний путь — exit1 JSON error. Только непутевое имя/фрагмент (например `profile.component`) сохраняет fuzzy lookup; при неоднозначности — exit0 `ambiguous:true`, не найденный результат.

Deps/rdeps/path возвращают `scope:{root,scanRoot,specs}` и `completeness:{complete,reasons?,samples?,samplesTruncated?,reasonsTruncated?,truncated?}`. `complete:true` относится к статическому графу в объявленном scope, а не ко всем runtime-связям/файлам проекта. Unresolved по всему scope, неподдерживаемые configs, пропущенные `.mts/.cts`/файлы >1MiB, недоступные каталоги/symlinks и cache-write error делают ответ неполным. Samples/reasons/unresolvedPaths ограничены пятью (счётчики `*Truncated`), deps/rdeps — 60 элементов (`completeness.truncated` — число опущенных). `format=table` для deps/rdeps кодирует однородные списки рёбер строками-массивами с общей схемой `columns:["file","kind","level","via"]` (отсутствующий `via` — `null`; декодер восстанавливает объекты). Пустой rdeps или `chain:null` при complete=false не доказывает отсутствия связи. Ошибки запроса complete=false/exit1; неоднозначность complete=false/exit0.

Search возвращает JSON `count/matches`, полный no-match в обследованном scope — `count:0,matches:[]`, exit0. Усечение списка определяется как `count > matches.length` (для files=1: `filesTotal > files.length`); отдельного `truncated` нет. Ошибки аргументов — JSON error/exit1; отсутствие stdout не является no-match. Snippet text ограничен 100 UTF-16 позициями без разрыва суррогатной пары и без отдельного флага, поэтому для quality oracle проверяй file/line и нужный диапазон источника. Graph symbol no-match — `definedIn:[]`, exit0. Для benchmark передавай literal argv `query={query}` в code-searcher, но graph path всегда получает два endpoint, не свободный query.

### sig

API сторонних библиотек без чтения node_modules — класс целиком или один член:

    node "<SCRIPTS_DIR>\sig-reader.js" name=rxjs#Observable
    node "<SCRIPTS_DIR>\sig-reader.js" name=rxjs#Observable member=subscribe
    node "<SCRIPTS_DIR>\sig-reader.js" name=@angular/common/http#HttpClient member=get

Функция — все перегрузки: `name=rxjs/operators#map`. Параметры: `name` (обязательный) — пакет с подпутем, член после `#`; `member` — можно задать отдельно; `limit` (по умолчанию 40) — максимум сигнатур в ответе. Если член не найден, ответ содержит `available` — доступные имена (экспорты файла или члены класса).

Резолв поддерживает `exports["."]`, корневой shorthand/условия и subpath exports, затем `types`/`typings` и прямые пробы. Runtime targets `.js/.mjs/.cjs` используются только для поиска соседних деклараций (`.d.ts/.d.mts/.d.cts`): сам runtime-файл не прекращает fallback к `types`/`typings`/`index.d.ts`. Поиск установленного пакета идёт по `node_modules` от импортёра вверх; чтение не исполняет код зависимостей. Прямое `name=./types.d.ts` или абсолютное имя допускается только внутри cwd и его realpath. У пакета относительные реэкспорты и `exports/types` не могут выйти за реальный корень пакета; ссылка на сам установленный пакет допустима. С `member` проходятся именованные и `export *` реэкспорты, без него — `export *`, если текущий файл не содержит деклараций. Отсутствующая dependency в реэкспорте пропускается для fallback, прямой запрос отсутствующего пакета даёт JSON error/exit1.

### generate

Только в Angular-проектах (`projectType=angular`); параметры и примеры — в references/angular.md:

    node "<SCRIPTS_DIR>\scaffold-helper.js" type=component name=components/profile

### edit_symbol

Запиши новое тело в файл (каждая строка — отдельный аргумент -Value; одинарные кавычки защищают $ и backtick от PowerShell), затем вызови скрипт:

    Set-Content -Path .kilo-edit-body.txt -Value '    const url = `/api/users/${id}`;', '    return this.http.put(url, { id });' -Encoding UTF8
    node "<SCRIPTS_DIR>\edit-symbol.js" file=src/app/services/user.service.ts symbol=UserService.save body_file dry=false

Однострочное тело можно передать прямо в аргументах (с \n):

    node "<SCRIPTS_DIR>\edit-symbol.js" file=src/app/services/user.service.ts symbol=UserService.save body='return this.http.get(url);' dry=false

Параметры: `file`, `symbol` (обязательные); тело — `body_file` / `body` / `body_b64` (ровно один); `engine` (auto | ts | fallback, по умолчанию auto), `indent` (auto | 2 | 4 | tab | raw — по умолчанию наследуется отступ старого тела), `dry` (по умолчанию true), `body_file_delete` (по умолчанию true). Отступ нового тела указывай без базового уровня — скрипт выровняет его под старое тело автоматически; полное тело, обёрнутое во внешние {…}, разворачивается.

Самопроверка всех скриптов скилла на временном мини-проекте (проект не нужен):

    node "<SCRIPTS_DIR>\graph-tool.js" op=selftest
