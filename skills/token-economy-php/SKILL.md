---
name: token-economy-php
description: Экономия токенов в PHP-проектах и на 1С-Битрикс, включая старое API (до D7) и D7: поиск определений, граф связей (классы, include, компоненты, шаблоны, модули, события, языковые файлы), оглавление файла с наследованием, сводка по компоненту, обработчики событий, языковые сообщения, схема таблиц БД, маршрут по URL, безопасное чтение и правка файлов в cp1251. Все команды — PowerShell.
---

# Skill: token-economy-php

## Декларация инструментов (Kilo Code Agent Tool Schema)
```json
{
  "name": "token-economy-php",
  "description": "Запускает скрипт bx.js для минимизации контекста ИИ в PHP / 1С-Битрикс проектах.",
  "parameters": {
    "type": "object",
    "properties": {
      "op": {
        "type": "string",
        "description": "info | search | symbol | deps | rdeps | path | node | stats | outline | component | events | lang | route | table | read | patch | create | build | selftest"
      },
      "payload": {
        "type": "object",
        "description": "JSON-объект с параметрами операции; при вызове передаётся argv-аргументами ключ=значение (универсально), одним JSON-аргументом (pwsh 7.3+) или @файлом с JSON."
      }
    },
    "required": [
      "op"
    ]
  }
}
```

## Правила (строго)

1. Один раз за разговор, прежде чем читать или править файлы, вызови `info`: он покажет корень сайта, кодировку файлов, шаблоны, свои модули и компоненты.
2. Если `info` показал файлы в cp1251, любые файлы с кириллицей читай только операцией `read`, правь только `patch`, создавай только `create`. Штатные инструменты чтения и записи портят cp1251 (кириллица превращается в мусор, и файл ломается).
3. Файл меньше 300 строк читай напрямую (в cp1251 — через `read`). Файл от 300 строк — сначала `outline`, затем точечное чтение диапазона (`read` с `offset` и `limit` либо Read(offset, limit)).
4. Где определён класс, метод, функция, константа или таблица ORM — `symbol`. Метод ищется и в базовых классах: `CIBlockElement::GetList` вернёт `CAllIBlockElement::GetList`. Где встречается текст — `search`.
5. Перед правкой общего файла (класс модуля, помощник из init.php, шаблон, который могут использовать страницы) вызови `rdeps`: он покажет, кто использует файл (страницы через IncludeComponent, require, классы, обработчики событий).
6. Вопросы про Битрикс решай профильными операциями, а не чтением каталогов:
   - компонент (файлы, параметры, шаблоны, переопределения в шаблоне сайта, где вызывается) — `component`;
   - кто обрабатывает событие или какие события есть — `events`;
   - где задан или используется текст сообщения — `lang` (ищет и по ключу, и по самому тексту);
   - какой файл обслуживает URL — `route`;
   - таблица БД (колонки, ключи, где встречается в коде) — `table`.
7. Ядро Битрикса (`bitrix/modules/main`, `bitrix/components/bitrix` и т. п.) по умолчанию в индекс не входит. Сигнатуру класса ядра или параметры штатного компонента смотри с `"core":true` через `outline` / `symbol` / `component`. Файлы ядра целиком не читай.
8. Файл шаблона компонента целиком не читай, пока не понадобилась его вёрстка: `outline` покажет, какие ключи `$arResult` и `$arParams` он использует и какие компоненты вызывает.
9. Правки штатным инструментом разрешены только в файлах UTF-8 (по `info`). Файл длиннее 50 строк при правке менее 30% целиком не перезаписывай: используй `patch` или штатную точечную замену.
10. Индекс строится и обновляется сам при каждом вызове — это анализ, не запуск проекта; запускать можно всегда. Папку `.bx-cache` не читай.
11. Не запускай `php -l`, composer, тесты и сборку — проверки выполняет пользователь.
12. Скрипт работает только с путями внутри рабочей директории; пути вне проекта отклоняй.

## Инструменты

### Обзор и чтение

info — профиль проекта: корень сайта, версия Битрикса, `utf_mode`, число файлов в UTF-8 и cp1251, шаблоны сайта, свои модули и пространства компонентов.

search — поиск подстроки или регулярки с учётом кодировки (кириллица находится и в cp1251). Результат сгруппирован по файлам, до 30 совпадений.

outline — оглавление: классы с диапазонами строк, методы с сигнатурами, таблица и поля ORM-классов (`getTableName` / `getMap`), функции, константы. С `"inherit":true` добавляет методы предков (в старом API основные методы лежат в `CAll*`-классах). Для страниц и шаблонов — вызванные компоненты, подключённые модули, ключи `$arResult` и `$arParams`, обработчики событий. Принимает путь, имя класса или идентификатор компонента.

read — чтение файла с номерами строк с учётом кодировки (`offset`, `limit`).

### Навигация

symbol — где определено: класс, интерфейс, трейт (по полному или короткому имени), `Класс::метод`, функция, константа, имя таблицы БД. Вывод: `имя  вид  файл:строка_начала-строка_конца`.

deps / rdeps / path / node / stats — граф связей. Типы связей в выводе:

| Тип | Что значит |
|---|---|
| class | `new`, `X::`, `extends`, `implements`, `use` (трейты и импорты) |
| function | вызов функции, объявленной в проекте |
| include | `require` / `include`, `$APPLICATION->IncludeFile(...)` и параметр `PATH` компонента `bitrix:main.include`, если путь вычисляется статически (`__DIR__`, `dirname(__FILE__)`, `$_SERVER["DOCUMENT_ROOT"]`, `BX_ROOT`, `SITE_DIR`, `SITE_TEMPLATE_PATH`) |
| component | `IncludeComponent("ns:name", …)` → файл компонента (`class.php` / `component.php`) |
| template | тот же вызов → `template.php` из компонента или переопределение в шаблоне сайта |
| event handler | класс или функция, указанные строкой (`"CClass"`, `"CClass::Method"`, `"имя_функции"`), `X::class` или массивом в `AddEventHandler`, `registerEventHandler`, `RegisterModuleDependences` |
| module | `CModule::IncludeModule("x")` / `Loader::includeModule('x')` → `include.php` модуля |
| lang | языковой файл `lang/ru/<тот же путь>` |

### Битрикс

component — идентификатор вида `ns:name` (можно без пространства имён, если имя уникально). Показывает расположение, файлы, параметры из `.parameters.php`, класс, шаблоны (собственные и переопределённые по сайтам), все вызовы с указанием шаблона. Для штатных компонентов без `core` работает по переопределениям и вызовам.

events — обработчики событий и вызовы `GetModuleEvents`: `модуль:Событие  вид  обработчик  файл:строка`. Без `query` — сводка по событиям, с `query` — фильтр по части события, класса или пути. Находит регистрации в коде и в `install/index.php` модулей.

lang — по ключу (`CAT_LIST_TITLE`) или по тексту (`список товаров`): значения во всех языках, файлы и места использования.

route — какой файл обслуживает URL: физический файл или подходящие правила `urlrewrite.php`.

table — имя таблицы БД: D7-класс и поля (`getTableName` / `getMap`), схема из `install/db/mysql/install.sql` модулей (колонки и ключи), файлы, где имя таблицы встречается. Без точного совпадения подскажет похожие имена.

### Старое API (до D7) и D7

Оба стиля поддерживаются в одном индексе. Для старого API учтено: глобальные классы без `namespace` (`CIBlockElement`), методы в базовых `CAll*`-классах, варианты классов под разные СУБД (`classes/mysql`, `mssql`, `oracle`: основным считается не-mssql/oracle, остальные скрыты, `"all":true` в `symbol` показывает все), синтаксис PHP 5 (`Array()`, `var`, `&`-возвраты, конструкторы по имени класса, альтернативный синтаксис `if: endif;`, короткие теги `<? ?>`), модули с `include.php`, подключаемые области сайта.

### Изменение

patch — точная замена фрагмента с сохранением кодировки (UTF-8 / cp1251), BOM и перевода строк (CRLF / LF). Ровно одно вхождение (`"all":true` — все). Символ, который нельзя записать в cp1251, отменяет запись целиком.

create — новый файл; кодировка по умолчанию — преобладающая в проекте (`enc` задаёт явно).

## Выполнение команд (PowerShell)

Команда — одна строка, параметры передаются argv-аргументами `ключ=значение` (разделитель значения — первый `=`), обязательный параметр каждой операции — `op`:

    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=info

Не используй пайп (`|`), `;`, `&`, `$()`, backtick, `>` и переносы строк — права среды их отклоняют, прежние вызовы через stdin-пайп больше не проходят. Права разрешают вызов по имени скрипта, поэтому полный путь в двойных кавычках допустим: команда выглядит как `node "<путь>\bx.js" ключ=значение…`.

Варианты пути до скриптов:

    глобально на Windows: "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts"
    локально в репозитории: ".kilo\skills\token-economy-php\scripts"
    pwsh на Linux/macOS: "$HOME/.config/kilo/skills/token-economy-php/scripts"

Значения аргументов: с пробелами — в одинарных кавычках; апостроф внутри значения удваивается (`''`); значения, начинающиеся с `$`, тоже бери в одинарные кавычки, иначе PowerShell раскроет их как переменные; двойные кавычки `"` внутри значений не используй — PowerShell 5.1 их портит. Кириллица через argv не портится: node читает командную строку через Unicode API Windows. Для многострочных payload (`patch`/`create`) — файл параметров: запиши JSON штатным инструментом в `.bx-cache/payload.json` (папка вне git) и передай его через `@.bx-cache/payload.json`.

Общие параметры: `root` (рабочая папка, по умолчанию текущая), `core` (`true` — включить ядро Битрикса в индекс). Корень сайта определяется сам (папка с `bitrix/` или `local/`, в том числе `www`, `public_html`, `httpdocs`).

info:

    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=info

search (`ext` — по умолчанию `.php`; `regex`, `ignoreCase`, `path`, `limit` — по желанию):

    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=search query=OnAfterIBlockElementAdd path=local

symbol:

    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=symbol name=Vendor\Catalog\ProductTable
    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=symbol name=Handlers::onAdd
    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=symbol name=b_vendor_product

rdeps / deps (`file` — путь, часть пути, имя класса или идентификатор компонента; `depth` 1–5):

    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=rdeps file=local/php_interface/include/helpers.php depth=2
    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=deps file=index.php

path / node / stats:

    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=path from=index.php to=Vendor\Catalog\ProductTable

outline:

    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=outline file=local/components/vendor/cat.list/class.php
    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=outline file=Bitrix\Main\Loader core=true

symbol и outline для старого API (метод из базового класса, с предками):

    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=symbol name='CIBlockElement::GetList' core=true
    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=outline file=CIBlockElement inherit=true core=true

table:

    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=table name=b_acme_item

component / events / lang / route:

    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=component id=bitrix:news.list
    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=events query=OnSaleOrderSaved
    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=lang query='Добавить в корзину'
    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=route url=/catalog/item-1/

read:

    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=read file=local/php_interface/init.php offset=1 limit=120

build (принудительная перестройка индекса):

    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=build

patch и create (`@`-файл параметров — единственный способ: многострочные значения в argv не передать; перевод строки внутри JSON-строк — `\n`):

    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" @.bx-cache/payload.json

Содержимое `.bx-cache/payload.json` для правки:

    {"op":"patch","file":"local/php_interface/init.php","old":"define('SITE_TITLE', 'Сайт');","new":"define('SITE_TITLE', 'Мой сайт');"}

Для нового файла:

    {"op":"create","file":"local/php_interface/include/helpers2.php","text":"<?php\nfunction hello() {}\n"}

Подробности про устройство индекса, классификацию файлов и ограничения: `references/bitrix.md`.

Самопроверка скрипта (индекс проекта не нужен):

    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=selftest

