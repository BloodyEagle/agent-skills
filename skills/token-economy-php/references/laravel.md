# token-economy-php: Laravel — устройство и ограничения

Открывай этот файл, только если ответ скрипта непонятен или нужно понять, чего он не видит в Laravel-проекте. Устройство общего индекса — в `references/bitrix.md`.

## Как распознаётся проект и версия

Laravel-режим включается, если в корне есть `artisan` или в `composer.json` (`require` и `require-dev`) указан `laravel/framework` / `laravel/lumen-framework`. Простые PHP и Битрикс-проекты работают как раньше — на них Laravel-ветки не влияют.

`info` показывает версию из `composer.json` и структуру каркаса:

- **8–10**: есть `app/Http/Kernel.php` (middleware и группы), `app/Console/Kernel.php` (команды и расписание), локали в `resources/lang/`.
- **11–12**: каркас у́же — `bootstrap/app.php` с `withRouting`/`withMiddleware`/`withSchedule`, расписание в `routes/console.php`, локали в `lang/`.

Разбор не различает версии: оба каркаса дают одинаковые данные, расположение файлов подбирается по факту. Lumen-специфика (роутер, отсутствие фасадов по умолчанию) не учитывается отдельно.

## Что индексируется

PHP-файлы проекта и Blade-шаблоны `resources/views/**/*.blade.php`; языковые файлы `lang/<код>/<группа>.php` (и старое `resources/lang/...`). Исключаются `vendor/`, `storage/`, `bootstrap/cache/`, `node_modules`, файлы больше 2 МБ. Классификация тегами: `view` (имя = путь с точками: `layouts.app`), `lang-lv` (код локали + группа), `routes`, `config`, `migration`, `seeder`, `factory`, `controller`, `model`, `provider`, `command`, `middleware`, `form-request`, `api-resource`, `job`, `event`, `listener`, `policy`, `observer`, `rule`, `console-kernel`, `bootstrap`, `test`, `public`.

## Откуда берутся данные операций

- **routes** — проход по `Route::` в `routes/*.php` (и в любом другом файле). Поддержаны: `get`/`post`/`put`/`patch`/`delete`/`options`/`any`/`match`, `view`, `redirect`, `fallback`, `resource` и `apiResource` (с `only`/`except`, генерируются маршруты всех действий), вложенные `group` с атрибутами массивом (`['prefix' => …, 'middleware' => …, 'as' => …, 'namespace' => …]`) и fluent-цепочками `prefix`/`middleware`/`name`/`namespace`/`domain`/`controller`. `Route::controller(X::class)->group(...)` и `Route::controller(X::class)->get('/x', 'method')` резолвят имя контроллера для строк-методов. URI собирается из префиксов групп; `{параметры}` и `{параметр?}` учитываются в `route` (соответствие URL), ключи привязки (`{user:slug}`) сохраняются в URI как есть.
- **model** — классы с `extends Model`/`Authenticatable`/`Pivot` либо со свойствами `$table`/`$fillable` или методами-связями. Таблица без `$table` — по соглашению (`App\Models\OrderItem` → `order_items`; исключения: person/people, child/children и т. п.). Связи берутся из `$this->hasOne/hasMany/belongsTo/belongsToMany/…(Model::class, 'fk')` в телах методов; `morphTo` без аргумента помечается `?`; обратные связи ищутся по фактическим целям, а не по именам. Миграции — `Schema::create/table` (колонки: имя + тип + модификаторы `->constrained()`, `->nullable()`, `->default()`, `->cascadeOnDelete()` и др.), `foreignIdFor(X::class)` даёт колонку `<x>_id`, внешние ключи из `constrained`, `foreign(...)->references(...)->on(...)`, индексы в квадратных скобках.
- **container** — `$this->app->…`, `$app->…`, `app()->…` с методами `bind`, `singleton`, `scoped`, `instance`, `extend`; контекстные привязки `$this->app->when(A)->needs(B)->give(C)`. Замыкания-реализации показываются как `(closure)`, повторная привязка к себе — `(self)`. Инжекции через конструктор ищутся по сигнатуре `__construct` с параметром данного типа.
- **blade** — директивы `@extends`, `@include` (+`If`/`When`/`First`), `@component`, `@each`, `@section`, `@yield` (+`hasSection`/`sectionMissing`), `@lang`, `@choice`; переменные из `{{ $x }}` и `{!! $x !!}` (до 60). Имя view = путь от `resources/views` с точками.
- **console** — команды из классов с `$signature` (`$description` рядом) и из `Artisan::command('name {…}', …)` (в том числе в `routes/console.php`); расписание — `Schedule::command/job/exec/call` (L11+) и `$schedule->command(...)->dailyAt('02:00')...` в `app/Console/Kernel.php`.
- **lang** — файлы `lang/<код>/<группа>.php` (`return ['key' => 'текст', 'nested' => [...]]`, ключи с точками); использование: `__('group.key')`, `trans(...)`, `trans_choice`, `Lang::get`, `@lang`, `@choice`. Ключ в поиске — с префиксом группы: `auth.failed`, `nav.home`.

## Дополнительные рёбра графа

- `view('name')` в коде (в том числе `View::make`) → файл шаблона; для Blade-шаблонов — `@extends`/`@include`/`@component`/`@each` → родительские шаблоны.
- `__('group.key')` и `@lang('group.key')` → файл локали этой группы (приоритет `ru`, иначе первый).
- Классы, функции, `require`/`include` — как в Битриксе (см. `references/bitrix.md`).

## Чего скрипт не видит

- **Динамические маршруты**: URI и контроллеры из переменных; маршруты, заданные в `bootstrap/app.php` через `->withRouting(...)` напрямую (ссылки на файлы `routes/*.php` разбираются сами), и алиасы middleware из `withMiddleware` — смотри `read` по `bootstrap/app.php`.
- **`route` не проверяет middleware и имя**: URL сопоставляется только по методу и URI; при нескольких совпадениях показываются и остальные.
- **События Laravel** (`Event::listen`, `protected $listen` в провайдерах) не разбираются — ищи через `search` или `outline`.
- **Livewire/Inertia/Volt**: PHP-части индексируются как обычные классы, компоненты и Blade-ответы (`Route::get(..., Inertia::render)` на конкретный view) не связываются.
- **Очереди и jobs**: классы заданий в индексе есть, но подписки (`dispatch`, `ShouldQueue`) не дают рёбер — используй `rdeps`/`search`.
- **Отношения только по коду**: `hasMany` с явной моделью в переменной, мульти-морф (`morphToMany` с модификаторами) упрощаются; accessor/mutator/casting-классы не собираются.
- **Миграции**: `Schema::*` с невалидными вызовами пропускаются, модификаторы-макросы не читаются; колонки после 40 штук обрезаются.
- **`storage/`, кэш, скомпилированные Blade** (`storage/framework/views`) исключены.

## Кэш

Тот же `.bx-cache` (формат индекса — версия 2). После обновления скилла при подозрении на устаревший разбор удали папку или вызови `build`. В Laravel-проекте кэш лежит в корне проекта, в git он не попадает (внутри `.gitignore` со звёздочкой).
