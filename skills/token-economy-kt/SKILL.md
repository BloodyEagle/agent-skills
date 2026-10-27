---
name: token-economy-kt
description: Экономия токенов в Android-проектах на Kotlin (Jetpack Compose и XML Views, Java interop): поиск определений, граф связей (наследование, внедрение зависимостей Hilt/Koin, использование, вызовы Compose-функций, ViewBinding), оглавление класса и Compose-функций, реализации интерфейса, манифест (компоненты, разрешения, intent-фильтры, deep link, exported-предупреждения), Room (сущности, таблицы, SQL-методы DAO), граф DI Hilt (модули, @Provides/@Binds, где связан тип, кто его получает), навигация (маршруты Compose и nav-xml, кто куда переходит), строковые ресурсы по локалям и отсутствующие переводы, каталог Retrofit-endpoint'ов, Gradle-сборка (модули, sdk, версии из version catalog), ресурсы и layout-файлы, id, строки, сигнатуры классов из jar и aar без декомпиляции. Все команды — PowerShell.
---
# Skill: token-economy-kt
## Декларация инструментов (Kilo Code Agent Tool Schema)
```json
{
"name": "token-economy-kt",
"description": "Запускает скрипт kt.js для минимизации контекста ИИ в Kotlin / Android проектах (Compose и XML Views).",
"parameters": {
"type": "object",
"properties": {
"op": {
"type": "string",
"description": "info | search | symbol | deps | rdeps | path | node | stats | outline | impls | manifest | room | di | nav | res | api | sig | read | patch | create"
},
"payload": {
"type": "object",
"description": "JSON-объект с параметрами операции; при вызове передаётся argv-аргументами ключ=значение (универсально) или @файлом с JSON."
}
},
"required": [
"op"
]
}
}
```
## Правила (строго)
1. Один раз за разговор, прежде чем читать или править файлы, вызови `info`: модули, версии AGP/Kotlin/библиотек, sdk, compose/viewBinding, состав по ролям, кодировки, предупреждения.
2. Файл короче 300 строк читай напрямую. Файл от 300 строк — сначала `outline`, затем точечное чтение диапазона (Read(offset, limit)); диапазоны строк есть в выводе `outline` и `symbol`.
3. Где определён класс, интерфейс, объект, функция, поле, таблица Room, layout, id или строковый ресурс — `symbol`. Где встречается текст — `search` (для xml, kts, toml, properties передавай `ext`).
4. Перед правкой общего класса (интерфейс репозитория, сущность, ViewModel, DI-модуль) вызови `rdeps`: он покажет, кто его использует, кто внедряет (`inject`), кто реализует и какие файлы затронуты. Какой класс реализует интерфейс — `impls`.
5. Вопросы по манифесту решай операцией `manifest`, а не чтением AndroidManifest.xml:
- какие компоненты есть, какой класс обслуживает имя — `manifest`;
- разрешения, intent-фильтры, deep link'и, exported — там же;
- фильтры: `kind` (activity|service|receiver|provider), `query` (часть имени/действия/разрешения), `module`.
6. Сигнатуры классов и методов библиотек (Compose, Room, Retrofit, OkHttp, Android SDK…) узнавай через `sig` по полному имени класса. Не угадывай API, не открывай jar/aar и не декомпилируй.
7. Compose-функции — это функции, а не классы: не ищи их в списке классов, смотри `outline` файла (пометки composable/preview) и рёбра `calls` в `deps`/`rdeps`. Сгенерированный код (Room `UserDao_Impl`, Hilt-компоненты, `build/`) в индекс не входит — его имена не ищи.
8. Вопросы предметных областей решай профильной операцией, а не комбинацией search/symbol/outline: структура базы и обращения к таблице — `room` (параметры `table`, `cls`); где интерфейс связан и кто его получает — `di` (параметр `type`); маршруты и переходы — `nav` (параметр `route`); значения строки в локалях и отсутствующие переводы — `res` (параметры `name`, `missing=1`); endpoint'ы сети — `api` (параметры `url`, `cls`).
9. Kotlin генерирует члены: у data-класса геттеры/equals/copy в исходниках отсутствуют, у property с делегатом `by` и кастомным `get()` тело не индексируется — смотри объявление в `outline`, а не ищи сгенерированные методы.
10. Правки штатным инструментом разрешены только в файлах UTF-8. Если `info` показал файлы не в UTF-8 (cp1251), читай их операцией `read`, правь `patch`, создавай `create`.
11. Индекс строится и обновляется сам при каждом вызове — это анализ, не запуск проекта. Папку `.kt-cache` не читай.
12. Не запускай `gradle`, `gradlew`, `adb`, эмулятор, тесты и приложение — сборку и проверки выполняет пользователь.
13. Скрипт работает только с путями внутри рабочей директории; пути вне проекта отклоняй.
## Инструменты
### Обзор и поиск
info — Gradle (wrapper-версия, модули из settings.gradle), версии AGP/Kotlin/библиотек из libs.versions.toml, namespace, compileSdk/minSdk/targetSdk, compose/viewBinding, buildTypes, flavors, зависимости модулей, манифест в цифрах, состав по ролям (activity, fragment, viewmodel, repository, dao, entity, api, di, usecase, database…), функции (верхнеуровневые, composable, preview), layout/строки/id, таблицы Room, маршруты, кодировки, предупреждения (exported без permission, компоненты вне манифеста, файлы не в UTF-8).
search — поиск подстроки или регулярки, результат сгруппирован по файлам, до 30 совпадений. По умолчанию `.kt`, для других файлов — `ext` (.xml, .kts, .toml, .properties, .java, .gradle, .md). Параметры: `query`, `ext`, `path`, `limit`.
outline — оглавление файла или класса: классы и объекты с аннотациями и супертипами, primary-конструктор, список внедряемых зависимостей (`inject`), поля, методы с сигнатурами и аннотациями, записи enum, диапазоны строк. Верхнеуровневые функции и свойства (в том числе `@Composable` и `@Preview`, расширения), typealias. Работает и для .java (смешанные проекты), и для XML: layout (id, строки, binding-класс, где используется), navigation (destinations), манифест (см. `manifest`). Параметры: `file` или `name`, `"inherit":true` — добавить методы проектных супертипов, `"fields":false` — скрыть свойства.
read — чтение файла с номерами строк с учётом кодировки (`offset`, `limit`).
### Навигация
symbol — где определено: класс, интерфейс, объект, enum (по простому или полному имени), `Класс#метод`, `Класс.поле`, верхнеуровневая функция, расширение, typealias, запись enum, таблица Room, layout-файл, binding-класс, id представления, строковый ресурс, маршрут навигации. Имена членов сравниваются с учётом регистра. Вывод: `имя  вид  файл:начало-конец`.
deps / rdeps / path / node / stats — граф связей между файлами. Типы связей в выводе:
| Тип | Что значит |
|---|---|
| extends/implements | наследование и реализация интерфейса |
| inject | параметры primary-конструктора, `@Inject`-поля, параметры `@Provides`/`@Binds` в Hilt-модулях (DI-провайдеры) |
| uses | любое другое упоминание типа: import, поле, вызов, аннотация, generic |
| calls | вызов верхнеуровневой функции, включая `@Composable` с trailing-lambda (`Name { }`) |
| binding | использование binding-класса layout-файла (ViewBinding) |
impls — все наследники и реализации типа (с глубиной `depth`, по умолчанию 3), с ролью и пометкой abstract.
### Android
manifest — манифест по модулям: application (label, theme, allowBackup, класс), компоненты с резолвом в классы проекта (`файл:строка`), intent-фильтры (actions, categories, deep link `scheme://host`), exported (явный или вычисленный по intent-filter), provider authorities, `uses-permission`/`uses-feature`, предупреждения об exported без permission. Фильтры: `kind`, `query`, `module`. Имена `.Foo` разворачиваются через namespace модуля.
room — база Room без чтения исходников: все `@Entity` (таблицы), `@Dao` и `@Database` (сущности, версия, DAO-методы). `table=имя` — сущность с колонками (PK из primary-конструктора), ForeignKey/индексы и все DAO-методы, трогающие таблицу (SQL `@Query` склеивается из конкатенации строк; `@Insert`/`@Update`/`@Delete`/`@Upsert` сопоставляются по типу параметра, включая `List<Entity>`). `cls=Имя` — методы DAO с SQL и списком таблиц.
di — граф внедрения зависимостей (Hilt/Dagger): `@Module` с `@InstallIn`, методы `@Provides`/`@Binds` (включая companion object) со scope-аннотациями, классы с `@Inject constructor` и их параметры, точки входа `@HiltViewModel`/`@AndroidEntryPoint`/`@HiltAndroidApp`/`@HiltWorker`. `type=Имя` — где тип связан (binding), его `@Inject`-конструктор и все, кто его получает: конструкторы, `@Inject`-поля, параметры провайдеров.
nav — навигация целиком: nav-xml (start, destinations, actions, deep link) и маршруты Compose (`composable("…")`, `startDestination`), все вызовы `navigate("маршрут")` и `navigate(R.id.dest)` с файлами и строками. `route=имя` — где маршрут объявлен, кто на него переходит и какие action ведут на него.
res — строковые ресурсы: файлы values по квалификаторам с числом ключей; `name=ключ` — значение в каждой локали (escaped-последовательности раскрываются, `translatable=false` помечается) и все места использования (`R.string.` в коде, `@string/` в xml); `missing=1` — ключи без перевода в какой-либо локали и ключи, отсутствующие в default (конфигурации night/land/w600dp отфильтровываются, локали — только `values-en`, `values-en-rGB` и т.п.).
api — каталог Retrofit-endpoint'ов: интерфейсы с HTTP-методами (`@GET`/`@POST`/`@PUT`/`@DELETE`/`@PATCH`/`@HEAD`/`@OPTIONS`/`@HTTP`), URL, параметры с маркерами `@Path`/`@Query`/`@Body`/`@Header`/`@Field`/`@Part`/`@Url`, возвращаемые типы, найденный `baseUrl` из `Retrofit.Builder`. Фильтры: `url=подстрока`, `cls=Интерфейс`; `base=0` — не искать baseUrl.
### Библиотеки
sig — сигнатуры класса из jar/aar без JDK и без запуска кода: Gradle-кэш `~/.gradle/caches/modules-2`, `libs/` модулей, каталоги из `KT_JARS` или параметра `jars`. AAR вскрывается как zip (классы берутся из `classes.jar`). Принимает `org.springframework`-подобное полное имя (`androidx.room.RoomDatabase`), член через `#` (`RoomDatabase#get`) или короткое имя, если класс импортирован в проекте. Выводит public/protected поля и методы с generics (из Signature-атрибута), `final/static/abstract`, пометкой `[deprecated]`; имена параметров не восстанавливаются (arg0, arg1…). Если версий несколько, берётся старшая (`jar` задаёт подстроку имени файла).
### Изменение
patch — точная замена фрагмента с сохранением кодировки, BOM и перевода строк. Ровно одно вхождение (`"all":true` — все). Нужен только для файлов не в UTF-8.
create — новый файл; кодировка по умолчанию UTF-8 (или преобладающая в проекте, если в тексте есть не-ASCII и в проекте больше файлов в cp1251), перевод строк — преобладающий.
## Выполнение команд (PowerShell)
Команда — одна строка, параметры передаются argv-аргументами `ключ=значение` (разделитель значения — первый `=`), обязательный параметр каждой операции — `op`:
node "$env:USERPROFILE\.kilocode\skills\token-economy-kt\scripts\kt.js" op=info
Не используй пайп (`|`), `;`, `&`, `$()`, backtick, `>` и переносы строк — права среды их отклоняют. Права разрешают вызов по имени скрипта, поэтому полный путь в двойных кавычках допустим: команда выглядит как `node "<путь>\kt.js" ключ=значение…`.
Варианты пути до скриптов:
глобально на Windows: "$env:USERPROFILE\.kilocode\skills\token-economy-kt\scripts"
локально в репозитории: ".kilo\skills\token-economy-kt\scripts"
pwsh на Linux/macOS: "$HOME/.config/kilo/skills/token-economy-kt/scripts"
Значения аргументов: с пробелами — в одинарных кавычках; апостроф внутри значения удваивается (`''`); значения, начинающиеся с `$`, тоже бери в одинарные кавычки, иначе PowerShell раскроет их как переменные; двойные кавычки `"` внутри значений не используй — PowerShell 5.1 их портит. `#` внутри значения (`Class#method`) — часть аргумента, экранировать не нужно. Кириллица через argv не портится. Для многострочных payload (`patch`/`create`) — файл параметров: запиши JSON штатным инструментом в `.kt-cache/payload.json` (папка вне git) и передай его через `@.kt-cache/payload.json`.
Общий параметр: `root` (корень проекта, по умолчанию текущая папка; для многомодульных проектов запускай из корня репозитория).
info:
node "$env:USERPROFILE\.kilocode\skills\token-economy-kt\scripts\kt.js" op=info
symbol / outline / rdeps / impls:
node "$env:USERPROFILE\.kilocode\skills\token-economy-kt\scripts\kt.js" op=symbol name=LoginViewModel
node "$env:USERPROFILE\.kilocode\skills\token-economy-kt\scripts\kt.js" op=symbol name=ShopApi#login
node "$env:USERPROFILE\.kilocode\skills\token-economy-kt\scripts\kt.js" op=symbol name=btn_login
node "$env:USERPROFILE\.kilocode\skills\token-economy-kt\scripts\kt.js" op=outline file=UserRepositoryImpl
node "$env:USERPROFILE\.kilocode\skills\token-economy-kt\scripts\kt.js" op=outline name=UserRepositoryImpl inherit=true
node "$env:USERPROFILE\.kilocode\skills\token-economy-kt\scripts\kt.js" op=rdeps file=UserRepository
node "$env:USERPROFILE\.kilocode\skills\token-economy-kt\scripts\kt.js" op=impls name=UserRepository
search (для ресурсов — `ext`):
node "$env:USERPROFILE\.kilocode\skills\token-economy-kt\scripts\kt.js" op=search query=findByLogin ext=.kt,.java,.xml
node "$env:USERPROFILE\.kilocode\skills\token-economy-kt\scripts\kt.js" op=search query=compileSdk ext=.kts,.toml
манифест:
node "$env:USERPROFILE\.kilocode\skills\token-economy-kt\scripts\kt.js" op=manifest
node "$env:USERPROFILE\.kilocode\skills\token-economy-kt\scripts\kt.js" op=manifest kind=receiver
node "$env:USERPROFILE\.kilocode\skills\token-economy-kt\scripts\kt.js" op=manifest query=BOOT_COMPLETED
room / di / nav / res / api:
node "$env:USERPROFILE\.kilocode\skills\token-economy-kt\scripts\kt.js" op=room
node "$env:USERPROFILE\.kilocode\skills\token-economy-kt\scripts\kt.js" op=room table=users
node "$env:USERPROFILE\.kilocode\skills\token-economy-kt\scripts\kt.js" op=room cls=UserDao
node "$env:USERPROFILE\.kilocode\skills\token-economy-kt\scripts\kt.js" op=di
node "$env:USERPROFILE\.kilocode\skills\token-economy-kt\scripts\kt.js" op=di type=UserRepository
node "$env:USERPROFILE\.kilocode\skills\token-economy-kt\scripts\kt.js" op=nav
node "$env:USERPROFILE\.kilocode\skills\token-economy-kt\scripts\kt.js" op=nav route=home
node "$env:USERPROFILE\.kilocode\skills\token-economy-kt\scripts\kt.js" op=res
node "$env:USERPROFILE\.kilocode\skills\token-economy-kt\scripts\kt.js" op=res name=login_title
node "$env:USERPROFILE\.kilocode\skills\token-economy-kt\scripts\kt.js" op=res missing=1
node "$env:USERPROFILE\.kilocode\skills\token-economy-kt\scripts\kt.js" op=api
node "$env:USERPROFILE\.kilocode\skills\token-economy-kt\scripts\kt.js" op=api url=auth
граф:
node "$env:USERPROFILE\.kilocode\skills\token-economy-kt\scripts\kt.js" op=deps name=LoginViewModel
node "$env:USERPROFILE\.kilocode\skills\token-economy-kt\scripts\kt.js" op=node file=UserDao
node "$env:USERPROFILE\.kilocode\skills\token-economy-kt\scripts\kt.js" op=path a=MainActivity b=UserDao undirected=true
node "$env:USERPROFILE\.kilocode\skills\token-economy-kt\scripts\kt.js" op=stats
sig:
node "$env:USERPROFILE\.kilocode\skills\token-economy-kt\scripts\kt.js" op=sig name=androidx.room.RoomDatabase
node "$env:USERPROFILE\.kilocode\skills\token-economy-kt\scripts\kt.js" op=sig name=retrofit2.Retrofit#get jar=retrofit
read / patch / create (для файлов не в UTF-8; для patch и create — `@`-файл параметров, единственный способ: многострочные значения в argv не передать):
node "$env:USERPROFILE\.kilocode\skills\token-economy-kt\scripts\kt.js" op=read file=legacy/Cp1251Notes.java offset=5 limit=20
node "$env:USERPROFILE\.kilocode\skills\token-economy-kt\scripts\kt.js" @.kt-cache/payload.json
Содержимое `.kt-cache/payload.json` для правки:
{"op":"patch","file":"app/src/main/java/com/acme/Foo.kt","old":"return 1;","new":"return 2;"}
Подробности про индекс, определение ролей, кодировки и ограничения: `references/android.md`.
