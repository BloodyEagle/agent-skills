# token-economy-php: MODX — правила, профильные операции, устройство и ограничения

Этот раздел — фреймворк-часть SKILL.md: он актуален, только когда `info` определил режим MODX.

## Правило (строго)

Вопросы про MODX решай так: файловые элементы — профильными операциями (`element`, `tpl`), элементы в БД — штатным `search` по тегам. Файловый разбор не запускает MODX и не читает БД.

**Главное ограничение**: сниппеты, плагины, чанки и шаблоны MODX по умолчанию хранятся в БД (`modSnippet`, `modPlugin`, `modChunk`, `modTemplate`) — файловому индексу они недоступны. В файлах видны только: файловые элементы extras (`core/components/<ns>/elements/…`, `assets/components/…`), статические элементы (файлы, на которые ссылаются элементы БД) и всё PHP-ядро/код extras. Об этом `info` предупреждает явно.

## Детект и состав индекса

- **Revolution**: `manager/` + `connectors/` + код ядра в `core/` (`core/model/modx` для 2.x, `core/src/Revolution` для 3.x); версия — из `core/composer.json`.
- **Evolution**: `manager/includes/` + `assets/` (includes — внутри manager); версия — из `manager/includes/version.inc.php`.

Каталоги `manager/`, `core/` и `connectors/` в корне без кода ядра MODX маркерами не считаются — так самописный сайт или админка с такими же именами не примет режим MODX.

В индекс входят `.php` и `.tpl`. Ядро по умолчанию вне индекса и поиска: `core/model`, `core/src`, `core/lexicon`, `core/docs`, `manager/`, `connectors/`; `core=true` включает его. `vendor/`, `core/vendor/`, `core/cache/`, `core/packages/` и `setup/` исключены всегда. Свои: `core/components/*` (включая лексиконы extras), `assets/components/*`, `templates/*`, корневые `.php`.

## Классификация и рёбра

- Файловые элементы: `core/components/<ns>/elements/snippets|chunks|plugins|templates/<имя>.<ext>` и то же в `assets/components/`. Метка в выводе: `snippet acme:hello`, `chunk acme:header`, `plugin …`, `template …`.
- `.tpl` разбирается на теги: `[[!snippet? &п=…]]` (вызов сниппета), `[[$chunk]]`, `[[++настройка]]`, `[[*TV]]`, `[[+плейсхолдер]]` и Fenom `{include 'file:…'}`, `{extends file=…}`.
- Рёбра: вызов тегом или из PHP (`runSnippet('x')`, `getChunk('x')`/`parseChunk`) → файловый элемент (вид связи `snippet`/`chunk`); Fenom `file:` → файл по точному пути или суффиксу (вид `include`).
- Вызовы несуществующих в файлах имён (элементы из БД) остаются в выводе `tpl`/`outline`, но ребра не дают.

## Профильные операции

element — файловый элемент по имени (`hello` или `acme:hello`): расположение, диапазон объявления, кто вызывает (теги и PHP-вызовы).

tpl — шаблон/чанк-файл (`name=templates/base.tpl` или путь): все теги с строками (сниппеты, чанки, настройки, TV, плейсхолдеры), Fenom-включения, кто связан с файлом.

Общие операции: `outline` по `.tpl` показывает теги; `symbol`/`deps`/`rdeps` работают по классам PHP (`rdeps file=acme:hello` — по элементу); `search` ищет в `.php` и `.tpl` (укажи `ext=.tpl,.php` для совместного поиска).

## Примеры команд

    node "<SCRIPTS_DIR>\bx.js" op=info
    node "<SCRIPTS_DIR>\bx.js" op=element name=hello
    node "<SCRIPTS_DIR>\bx.js" op=tpl name=templates/base.tpl
    node "<SCRIPTS_DIR>\bx.js" op=search query='[[$' ext=.tpl,.php
    node "<SCRIPTS_DIR>\bx.js" op=search query=runSnippet
    node "<SCRIPTS_DIR>\bx.js" op=rdeps file=acme:hello
    node "<SCRIPTS_DIR>\bx.js" op=outline file=core/components/acme/elements/snippets/hello.php

## Чего скрипт не видит

- **Элементы в БД**: их содержимое и имена недоступны; `route` отказывает (URL → ресурс — таблица `modx_site_content` в БД).
- **Лексиконы**: свои файлы `core/components/*/lexicon/<код>/….php` индексируются по умолчанию; ядро `core/lexicon/` — только с `core=true`. Разбор `$_lang` не делается — ищи тексты через `search`.
- **События**: регистрации плагинов на события хранятся в БД; `invokeEvent('OnX')` в коде видно через `search`, но связи на плагин нет.
- **Системные настройки** — в БД; видны только вызовы `[[++x]]` в tpl.
- **Fenom без `file:`**: `{include '…'}` и переменные Fenom не разрешаются в файлы; `{block}`/наследование pdoTemplates не разбирается.
- Динамические имена: `runSnippet($var)`, тег, собранный из переменных, — не разрешаются.
