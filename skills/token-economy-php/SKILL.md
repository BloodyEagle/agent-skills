---
name: token-economy-php
description: Экономия токенов в любых PHP-проектах. Универсальный режим (CMS не определена) — поиск определений, граф классов и функций, оглавления, безопасное чтение и правка файлов в cp1251. Режим 1С-Битрикс (старое API до D7 и D7) — компоненты, события, языковые сообщения, схема таблиц, маршруты. Режим Laravel 8–13 — маршруты, модели Eloquent, привязки контейнера, Blade, команды и расписание. Режим MODX (Revolution/Evolution) — файловые элементы, теги шаблонов. Все команды — PowerShell.
---

# Skill: token-economy-php

## Декларация инструментов (Kilo Code Agent Tool Schema)
```json
{
  "name": "token-economy-php",
  "description": "Запускает скрипт bx.js для минимизации контекста ИИ в PHP-проектах (универсальный режим, 1С-Битрикс, Laravel).",
  "parameters": {
    "type": "object",
    "properties": {
      "op": {
        "type": "string",
        "description": "info | search | symbol | deps | rdeps | path | node | stats | outline | component | events | lang | route | table | routes | model | container | blade | console | element | tpl | read | patch | create | build | selftest"
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

1. Один раз за разговор, прежде чем читать или править файлы, вызови `info`: он назовёт режим проекта (Битрикс / Laravel / «CMS не определена — универсальный»), кодировки и состав файлов.
2. Режим определяет доступные профильные операции: Битрикс — правила и операции Битрикса в `references/bitrix.md` (прочитай перед их использованием); Laravel — в `references/laravel.md`; MODX — в `references/modx.md` (сниппеты/чанки/шаблоны в БД файловому индексу недоступны — об этом предупреждает `info`); «CMS не определена» — универсальный режим: профильные операции не вызывай, работай общими (`search`, `outline`, `symbol`, `deps`, `rdeps`, `path`, `node`, `stats`, `read`, `patch`, `create`).
3. Если `info` показал файлы в cp1251, любые файлы с кириллицей читай только операцией `read`, правь только `patch`, создавай только `create`. Штатные инструменты чтения и записи портят cp1251 (кириллица превращается в мусор, и файл ломается).
4. Файл меньше 300 строк читай напрямую (в cp1251 — через `read`). Файл от 300 строк — сначала `outline`, затем точечное чтение диапазона (`read` с `offset` и `limit` либо Read(offset, limit)).
5. Где определён класс, метод, функция, константа или ORM-таблица — `symbol` (метод ищется и по цепочке наследования, в базовых классах). Где встречается текст — `search`.
6. Перед правкой общего файла (помощник, класс, подключаемый во многих местах) вызови `rdeps`: он покажет, кто использует файл (классы, require/include, вызовы, обработчики).
7. Правки штатным инструментом разрешены только в файлах UTF-8 (по `info`). Файл длиннее 50 строк при правке менее 30% целиком не перезаписывай: используй `patch` или штатную точечную замену.
8. Индекс строится и обновляется сам при каждом вызове — это анализ, не запуск проекта; запускать можно всегда. Папку `.bx-cache` не читай.
9. Не запускай `php -l`, `composer`, `artisan`, тесты и сборку — проверки выполняет пользователь.
10. Скрипт работает только с путями внутри рабочей директории; пути вне проекта отклоняй.

## Инструменты

### Обзор и чтение

info — паспорт проекта: режим (Битрикс / Laravel / универсальный), кодировки, стиль кода, число файлов, крупнейшие файлы. В Битриксе — корень сайта, версия, `utf_mode`, шаблоны сайта, свои модули и компоненты. В Laravel — версия из `composer.json`, структура каркаса (8–10 или 11+), пространство имён, число маршрутов, моделей, миграций и локалей.

search — поиск подстроки или регулярки с учётом кодировки (кириллица находится и в cp1251). Результат сгруппирован по файлам, до 30 совпадений.

outline — оглавление файла: классы с диапазонами строк, методы с сигнатурами, функции, константы, enum-кейсы. С `"inherit":true` добавляет методы предков. Принимает путь, часть пути или имя класса. В Битриксе дополнительно показывает ORM-таблицы, вызванные компоненты, ключи `$arResult`/`$arParams`, обработчики событий; в Laravel — директивы Blade, связи модели, миграции; подробности в references.

read — чтение файла с номерами строк с учётом кодировки (`offset`, `limit`).

### Навигация

symbol — где определено: класс, интерфейс, трейт, enum (по полному или короткому имени), `Класс::метод`, функция, константа. Вывод: `имя  вид  файл:строка_начала-строка_конца`.

deps / rdeps / path / node / stats — граф связей. Типы связей в выводе:

| Тип | Что значит | Где работает |
|---|---|---|
| class | `new`, `X::`, `extends`, `implements`, `use` (трейты и импорты) | во всех режимах |
| function | вызов функции, объявленной в проекте | во всех режимах |
| include | `require` / `include` со статически вычисляемым путём (`__DIR__`, `$_SERVER["DOCUMENT_ROOT"]`, …) | во всех режимах |
| component / template | `IncludeComponent("ns:name", …)` → файл компонента и шаблона | Битрикс |
| event handler / module / lang | обработчики событий, подключение модулей, языковые файлы | Битрикс |
| template / lang (Blade) | `view('name')`, `@extends`, `__('group.key')` → шаблоны и локали | Laravel |
| snippet / chunk / include | теги `[[!snippet]]`/`[[$chunk]]`, `runSnippet`/`getChunk`, Fenom `file:` → файловые элементы | MODX |

### Изменение

patch — точная замена фрагмента с сохранением кодировки (UTF-8 / cp1251), BOM и перевода строк (CRLF / LF). Ровно одно вхождение (`"all":true` — все). Символ, который нельзя записать в cp1251, отменяет запись целиком.

create — новый файл; кодировка по умолчанию — преобладающая в проекте (`enc` задаёт явно).

build — принудительная перестройка индекса.

## Выполнение команд (PowerShell)

Команда — одна строка, параметры передаются argv-аргументами `ключ=значение` (разделитель значения — первый `=`), обязательный параметр каждой операции — `op`:

    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=info

Не используй пайп (`|`), `;`, `&`, `$()`, backtick, `>` и переносы строк — права среды их отклоняют, прежние вызовы через stdin-пайп больше не проходят. Права разрешают вызов по имени скрипта, поэтому полный путь в двойных кавычках допустим: команда выглядит как `node "<путь>\bx.js" ключ=значение…`.

Варианты пути до скриптов:

    глобально на Windows: "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts"
    локально в репозитории: ".kilo\skills\token-economy-php\scripts"
    pwsh на Linux/macOS: "$HOME/.config/kilo/skills/token-economy-php/scripts"

Значения аргументов: с пробелами — в одинарных кавычках; апостроф внутри значения удваивается (`''`); значения, начинающиеся с `$`, тоже бери в одинарные кавычки, иначе PowerShell раскроет их как переменные; двойные кавычки `"` внутри значений не используй — PowerShell 5.1 их портит. Кириллица через argv не портится: node читает командную строку через Unicode API Windows. Для многострочных payload (`patch`/`create`) — файл параметров: запиши JSON штатным инструментом в `.bx-cache/payload.json` (папка вне git) и передай его через `@.bx-cache/payload.json`.

Общие параметры: `root` (рабочая папка, по умолчанию текущая), `core` (`true` — включить ядро Битрикса в индекс; актуально только в режиме Битрикса).

info:

    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=info

search (`ext` — по умолчанию `.php`; `regex`, `ignoreCase`, `path`, `limit` — по желанию):

    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=search query=getUserInfo path=src

symbol:

    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=symbol name=App\Services\Billing
    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=symbol name=Billing::recalc

rdeps / deps (`file` — путь, часть пути или имя класса; `depth` 1–5):

    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=rdeps file=src/Support/helpers.php depth=2
    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=deps file=index.php

path / node / stats:

    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=path from=index.php to=App\Core\Launcher

outline:

    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=outline file=src/Services/Billing.php

read:

    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=read file=src/bootstrap.php offset=1 limit=120

build (принудительная перестройка индекса):

    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=build

patch и create (`@`-файл параметров — единственный способ: многострочные значения в argv не передать; перевод строки внутри JSON-строк — `\n`):

    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" @.bx-cache/payload.json

Содержимое `.bx-cache/payload.json` для правки:

    {"op":"patch","file":"src/config.php","old":"define('SITE_TITLE', 'Сайт');","new":"define('SITE_TITLE', 'Мой сайт');"}

Для нового файла:

    {"op":"create","file":"src/Support/helpers2.php","text":"<?php\nfunction hello() {}\n"}

Примеры и правила для режимов фреймворков — в references: `references/bitrix.md` (Битрикс: правила, профильные операции, устройство индекса и ограничения), `references/laravel.md` (Laravel), `references/modx.md` (MODX). Режим текущего проекта называет `info`.

Самопроверка скрипта (индекс проекта не нужен):

    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=selftest
