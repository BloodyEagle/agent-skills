# token-economy-php: устройство и ограничения

Открывай этот файл, только если ответ скрипта непонятен или нужно понять, чего он не видит.

## Какие файлы входят в индекс

Файлы `.php` из `git ls-files` (учитывается `.gitignore`), без git — обход каталогов. Корень сайта определяется сам: папка с `bitrix/` или `local/` (текущая, затем `www`, `public_html`, `httpdocs`, `web`, `public`, `htdocs`, `site`, `docroot`). Файлы вне корня сайта не индексируются.

Всегда исключаются: `node_modules`, `vendor/`, `local/vendor/`, `bitrix/vendor/` (composer), `upload/`, `bitrix/cache`, `managed_cache`, `stack_cache`, `backup`, `updates`, `tmp`, `html_pages`, `js`, `images`, `fonts`, `wizards`, `themes`, `gadgets`. Файлы больше 2 МБ пропускаются.

Ядро (`origin: core`) по умолчанию не индексируется: модули без точки в имени (`bitrix/modules/main`, `iblock`, `sale`…), компоненты `bitrix:*` из `bitrix/components/bitrix`, `bitrix/admin`, `bitrix/tools`. Параметр `"core":true` включает всё. Шаблоны сайта, `php_interface`, компоненты других пространств имён и модули с точкой в имени (`vendor.module`) считаются своими.

## Метки файлов в выводе

`component ns:name` (главный файл компонента), `component-file …` (прочие файлы компонента), `template ns:name/шаблон` (шаблон самого компонента), `template ns:name/шаблон @сайт` (переопределение в `templates/<сайт>/components/…`), `result_modifier …`, `module <id>`, `module-install <id>` (`install/index.php`), `module-include <id>`, `init` (`php_interface/init.php`), `php_interface`, `site-template` (`header.php`, `footer.php`), `lang`, `page` (файл вне `bitrix/` и `local/`), `class` / `interface` / `trait` / `enum` (файл с объявлением).

## Как определяются связи

- Классы: имена из `new`, `X::`, `extends`, `implements`, `instanceof`, `catch`, трейтов и `use`-импортов приводятся к полному имени (с учётом `namespace` и псевдонимов) и ищутся среди объявлений проекта без учёта регистра. Типы в сигнатурах параметров отдельной связью не считаются, но их `use`-импорт даёт связь. Если класс объявлен под несколько СУБД (`classes/mysql`, `classes/mssql`, `classes/oracle`), связь идёт на основной вариант (без mssql и oracle).
- Функции: вызов по имени, если функция объявлена в проекте (в том числе внутри `if (!function_exists(...))`). Распространённые встроенные функции отбрасываются.
- `require` / `include` / `IncludeFile` / `main.include` (параметр `PATH`): поддерживаются `__DIR__`, `dirname(__FILE__)`, `dirname(__DIR__)`, `$_SERVER["DOCUMENT_ROOT"]`, `Application::getDocumentRoot()`, константы `BX_ROOT`, `BX_PERSONAL_ROOT`, `SITE_DIR`, `SITE_TEMPLATE_PATH` (для файла в `templates/<шаблон>/` это его собственный шаблон) и литералы, склеенные через точку. Пути с произвольными переменными не разрешаются.
- Компоненты: первый аргумент `IncludeComponent` — идентификатор (литерал). Второй — шаблон: пустая строка означает `.default`, переменная — шаблон неизвестен (связь только на компонент).
- События: обработчик берётся из строки или массива: класс (`'\Vendor\Class'`, `Class::class`, `"Class::method"`) либо имя функции (`"my_handler"`). Связь ведёт на файл, где объявлены класс или функция.
- Модули: `CModule::IncludeModule("x")` и `Loader::includeModule('x')` дают связь на `include.php` модуля (в `local/modules/x` или `bitrix/modules/x`), если он в индексе.
- Языковые файлы: для файла `X` связь на `…/lang/ru/X` (если нет `ru`, то на первый найденный язык).

## Кодировки

Каждый файл читается как UTF-8; если байты не образуют корректный UTF-8, как windows-1251. Чистый ASCII в обеих кодировках одинаков, такие файлы помечаются `ascii`. Операции `patch` и `create` пишут обратно в той же кодировке с тем же BOM и переводом строк. В файл, который целиком ASCII, кириллица добавляется в кодировке, преобладающей в проекте (по числу файлов), либо в той, что задана параметром `enc` (`utf8` или `cp1251`).

## Старое API (до D7)

- Классы старого API глобальные, поэтому находятся по короткому имени. Методы чаще лежат в базовом `CAll*`-классе (`CIBlockElement extends CAllIBlockElement`): `symbol Класс::метод` поднимается по цепочке предков (до 6 уровней), `outline` с `"inherit":true` печатает методы предков.
- `CModule::AddAutoloadClasses` в `include.php` не разбирается: классы находятся по самим объявлениям в файлах (`classes/general`, `classes/mysql`…).
- Схема таблиц модуля — в `install/db/mysql/install.sql` (`table` читает `CREATE TABLE`; диалекты mssql и oracle пропускаются, если нашлась версия для mysql).
- SQL в коде (`$DB->Query("… FROM b_table …")`) связей в граф не даёт; `table` показывает до 8 файлов, где имя таблицы встречается текстом.
- Имена классов и путей, собранные в рантайме (`"classes/".$DBType."/…"`, переменные в `IncludeComponent`), не разрешаются.
- Старые меню и разделы (`.section.php`, `.top.menu.php`, `$aMenuLinks`) не разбираются.

## Чего скрипт не видит

- Данные из базы: свойства и типы инфоблоков, почтовые шаблоны, агенты, настройки модулей (`b_option`), обработчики, зарегистрированные раньше и не вписанные в код. Для регистрации в коде ищи через `events` и `search`.
- Маршруты D7 (`local/routes`), правила `.htaccess`, `.section.php` и меню.
- Динамические имена: компонент или класс, заданный переменной; `Loader::registerAutoLoadClasses` как источник путей (индекс находит классы по самим объявлениям, поэтому это не мешает).
- Вызовы методов через объект (`$obj->method()`), типы в сигнатурах, содержимое строк (кроме перечисленных выше случаев).
- JS, CSS и не-PHP файлы шаблонов (используй `search` с `ext`).

## Кэш

`.bx-cache/index.json` и `cache.json`; внутри `.gitignore` со звёздочкой. Индекс пересобирается сам при добавлении, удалении, переименовании и изменении файлов; заново разбираются только изменённые. Принудительно: `{"op":"build"}`. Если ответ выглядит устаревшим после правки парсера, удали папку `.bx-cache`.

## Маршрут по URL (route)

Порядок проверки в Битриксе: физический файл (`…/index.php`, `….php`), затем правила `urlrewrite.php` по порядку (срабатывает первое подходящее). Условия переводятся из PCRE в JavaScript: простые выражения совпадают, сложные (именованные группы, `\h`, рекурсия, флаг `u`) могут отличаться.

---

# Битрикс: правила и профильные операции

Этот раздел — фреймворк-часть SKILL.md: он актуален, только когда `info` определил режим Битрикса.

## Правила Битрикса (строго)

1. Вопросы про Битрикс решай профильными операциями, а не чтением каталогов:
   - компонент (файлы, параметры, шаблоны, переопределения в шаблоне сайта, где вызывается) — `component`;
   - кто обрабатывает событие или какие события есть — `events`;
   - где задан или используется текст сообщения — `lang` (ищет и по ключу, и по самому тексту);
   - какой файл обслуживает URL — `route`;
   - таблица БД (колонки, ключи, где встречается в коде) — `table`.
2. Ядро Битрикса (`bitrix/modules/main`, `bitrix/components/bitrix` и т. п.) по умолчанию в индекс не входит. Сигнатуру класса ядра или параметры штатного компонента смотри с `"core":true` через `outline` / `symbol` / `component`. Файлы ядра целиком не читай.
3. Файл шаблона компонента целиком не читай, пока не понадобилась его вёрстка: `outline` покажет, какие ключи `$arResult` и `$arParams` он использует и какие компоненты вызывает.

## Старое API (до D7) и D7

Оба стиля поддерживаются в одном индексе. Для старого API учтено: глобальные классы без `namespace` (`CIBlockElement`), методы в базовых `CAll*`-классах, варианты классов под разные СУБД (`classes/mysql`, `mssql`, `oracle`: основным считается не-mssql/oracle, остальные скрыты, `"all":true` в `symbol` показывает все), синтаксис PHP 5 (`Array()`, `var`, `&`-возвраты, конструкторы по имени класса, альтернативный синтаксис `if: endif;`, короткие теги `<? ?>`), модули с `include.php`, подключаемые области сайта.

## Операции

component — идентификатор вида `ns:name` (можно без пространства имён, если имя уникально). Показывает расположение, файлы, параметры из `.parameters.php`, класс, шаблоны (собственные и переопределённые по сайтам), все вызовы с указанием шаблона. Для штатных компонентов без `core` работает по переопределениям и вызовам.

events — обработчики событий и вызовы `GetModuleEvents`: `модуль:Событие  вид  обработчик  файл:строка`. Без `query` — сводка по событиям, с `query` — фильтр по части события, класса или пути. Находит регистрации в коде и в `install/index.php` модулей.

lang — по ключу (`CAT_LIST_TITLE`) или по тексту (`список товаров`): значения во всех языках, файлы и места использования.

route — какой файл обслуживает URL: физический файл или подходящие правила `urlrewrite.php`.

table — имя таблицы БД: D7-класс и поля (`getTableName` / `getMap`), схема из `install/db/mysql/install.sql` модулей (колонки и ключи), файлы, где имя таблицы встречается. Без точного совпадения подскажет похожие имена. В Laravel-режиме `table` показывает Eloquent-модель и миграции.

## Примеры команд

    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=search query=OnAfterIBlockElementAdd path=local
    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=symbol name=Vendor\Catalog\ProductTable
    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=symbol name='CIBlockElement::GetList' core=true
    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=outline file=local/components/vendor/cat.list/class.php
    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=outline file=CIBlockElement inherit=true core=true
    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=table name=b_acme_item
    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=component id=bitrix:news.list
    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=events query=OnSaleOrderSaved
    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=lang query='Добавить в корзину'
    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=route url=/catalog/item-1/
    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=rdeps file=local/php_interface/include/helpers.php depth=2
    node "$env:USERPROFILE\.kilocode\skills\token-economy-php\scripts\bx.js" op=read file=local/php_interface/init.php offset=1 limit=120
