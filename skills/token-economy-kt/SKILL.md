---
name: token-economy-kt
version: 1.3.3
description: 'Экономный анализ Kotlin/Android-проектов (Jetpack Compose, XML Views, Java interop) скриптом kt.js — без чтения файлов целиком. Звать для поиска определений, статического графа (наследование, Hilt/Dagger, Compose-вызовы, ViewBinding), файловых метрик, git-хотспотов, оглавлений классов и функций, разбора исходного манифеста (компоненты, разрешения, intent-фильтры, deep link), Room, DI-модулей, Retrofit-эндпоинтов, Gradle-модулей и version catalog без сборки, строк по локалям с отсутствующими переводами, сигнатур jar и classes.jar из aar. Правила стека — references/kotlin.md.'
---
# Skill: token-economy-kt

## Режим планирования

В режиме планирования разрешены аналитические команды скилла и построение/обновление графа, включая создание и обновление штатных служебных файлов (кэши, индексы и данные графа). Это артефакты анализа, а не правки исходников проекта; запись этих файлов сама по себе не запрещает запуск команды.

Разрешение ограничено служебными артефактами анализа: оно не включает редактирование исходников или пользовательской конфигурации, генерацию сущностей, установку, компиляцию и тесты. Соблюдай ограничения путей и кэша. Если сам харнесс блокирует инструмент, не обходи блокировку: сообщи о ней пользователю; текст скилла не отменяет системные ограничения.

Правила стека — `references/kotlin.md` в этом же каталоге скилла: прочитай перед первой командой сессии. Путь относительный от каталога скилла, а не от корня агента.
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
"description": "info | search | symbol | deps | rdeps | path | node | stats | metrics | outline | impls | manifest | room | di | nav | res | api | sig | read | patch | create | hotspots | selftest"
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

**CodeGraph рядом.** `info` сохраняет поля `integrations.codegraph` (`available`, `cli_version`, `index`, `db_path`, `reason`) и добавляет полный абсолютный `executable`, `source` (`path` или `home`), `hint` (строка или `null`). CLI ищется сначала в `PATH`; только при отсутствии кандидата — в домашнем `.local/bin` (`os.homedir()` в JavaScript, `os.path.expanduser('~')` в Python). Имена: `codegraph.cmd`, `codegraph.bat`, `codegraph.exe` на Windows; `codegraph` на POSIX. Неработающий кандидат в `PATH` не маскируется; выбранные `executable`/`source` сохраняются при ошибке проверки версии. Детект запускает лишь `version` с таймаутом 2 с: без `index`/`init`, чтения содержимого базы и кэша детекта. Нет CLI — `reason=not_installed`; нет индекса — `reason=no_index`: прежний путь, не структурный `explore`.

`hint` заполняется только после успешной домашней проверки. Если он не `null`, обязательно покажи его на языке разговора, при необходимости переведи. Подсказка объясняет необязательное ручное добавление домашнего `.local/bin` в `PATH` и полный перезапуск приложения для новых терминалов. Не меняй автоматически `PATH` процесса/пользователя, профили оболочки или реестр. Домашний CLI работает сразу только при `available=true` и `index=true`, даже если команда `codegraph` без пути отсутствует в `PATH`.

Если в проекте есть `.codegraph/` и CLI CodeGraph доступен (`op=info` показывает `available=true` и `index=true` в `integrations.codegraph`), структурный вопрос — сначала `"<absolute-path-from-integrations.codegraph.executable>" explore "<question>"`: обязательно подставь возвращённый абсолютный `executable`, а не вызывай `codegraph` без пути. Примеры структурных вопросов: как работает X, кто вызывает Y, что заденет правка Z, обзор незнакомой подсистемы — один вызов вместо серии `search` и чтений. Свои операции остаются на то, чего у CodeGraph нет: `sig` (сигнатуры классов из jar/aar без декомпиляции), `outline`, точный поиск текста (`search`: конфигурация и ресурсы), точные диапазоны (`op=read`), паспорт проекта (`op=info`), правки и создание файлов (`patch`/`create`), а также профильные Android-операции (`manifest`, `room`, `di`, `nav`, `res`, `api`, `impls`). Точные строки для правки или цитирования — не из вывода explore: он для понимания, координаты берутся `graph op=read` или штатным чтением файла. Пусто или ошибка — уйти в прежний путь один раз: не повторять вызов с другой формулировкой и не объяснять пользователю, что «граф не нашёл». `codegraph index`/`init` без явной просьбы не запускать: это перестройка индекса на минуты и запись в проект. Нет `integrations.codegraph.available` в ответе `info` — правило не действует, работаем как раньше.

2. Файл короче 300 строк читай напрямую. Файл от 300 строк — сначала `outline`, затем точечное чтение диапазона (Read(offset, limit)); диапазоны строк есть в выводе `outline` и `symbol`.
3. Где определён класс, интерфейс, объект, функция, поле, таблица Room, layout, id или строковый ресурс — `symbol`. Где встречается текст — `search` (для xml, kts, toml, properties передавай `ext`).
4. Перед правкой общего класса (интерфейс репозитория, сущность, ViewModel, DI-модуль) вызови `rdeps`: он покажет, кто его использует, кто внедряет (`inject`), кто реализует и какие файлы затронуты. Какой класс реализует интерфейс — `impls`.
5. Вопросы по манифесту решай операцией `manifest`, а не чтением AndroidManifest.xml:
- какие компоненты есть, какой класс обслуживает имя — `manifest`;
- разрешения, intent-фильтры, deep link'и, exported — там же;
- фильтры: `kind` (activity|service|receiver|provider), `query` (часть имени, действия, категории или разрешения), `module`.
6. Сигнатуры классов и методов библиотек (Compose, Room, Retrofit, OkHttp, Android SDK…) узнавай через `sig` по полному имени класса. Не угадывай API, не открывай jar/aar и не декомпилируй.
7. Compose-функции — это функции, а не классы: не ищи их в списке классов, смотри `outline` файла (пометки composable/preview) и рёбра `calls` в `deps`/`rdeps`. Сгенерированный код (Room `UserDao_Impl`, Hilt-компоненты, `build/`) в индекс не входит — его имена не ищи.
8. Вопросы предметных областей решай профильной операцией, а не комбинацией search/symbol/outline: структура базы и обращения к таблице — `room` (параметры `table`, `cls`); где интерфейс связан и кто его получает — `di` (параметр `type`); маршруты и переходы — `nav` (параметр `route`); значения строки в локалях и отсутствующие переводы — `res` (параметры `name`, `missing=1`); endpoint'ы сети — `api` (параметры `url`, `cls`).
9. Kotlin генерирует члены: у data-класса геттеры/equals/copy в исходниках отсутствуют, у property с делегатом `by` и кастомным `get()` тело не индексируется — смотри объявление в `outline`, а не ищи сгенерированные методы.
10. Правки штатным инструментом разрешены только в файлах UTF-8. Если `info` показал файлы не в UTF-8 (cp1251), читай их операцией `read`, правь `patch`, создавай `create`.
11. Индекс строится и обновляется сам при каждом вызове — это анализ, не запуск проекта. Папку `.kt-cache` не читай.
12. Не запускай `gradle`, `gradlew`, `adb`, эмулятор, тесты и приложение — сборку и проверки выполняет пользователь.
13. Пути исходников, `read`/`patch`/`create` и кэша проверяются относительно корня проекта (`root`): выход через symlink/junction отклоняется, регистр Windows учитывается. Обход исходников ссылки пропускает. Исключение для чтения библиотек — `sig` (`jars`, `KT_JARS`, Gradle-кэш). `@`-файл параметров должен находиться внутри текущей рабочей директории.
## Инструменты

| Задача | Операция → скрипт |
|---|---|
| Файловая связанность и область воздействия | metrics → kt.js |

### Обзор и поиск
info — Gradle (wrapper-версия, модули из settings.gradle), версии AGP/Kotlin/библиотек только из `gradle/libs.versions.toml` относительно `root` (прочие TOML не являются catalog), namespace, compileSdk/minSdk/targetSdk, compose/viewBinding, buildTypes, flavors, зависимости модулей, манифест в цифрах, состав по ролям (activity, fragment, viewmodel, repository, dao, entity, api, di, usecase, database…), функции (верхнеуровневые, composable, preview), layout/строки/id, таблицы Room, маршруты, кодировки, предупреждения (exported без permission, компоненты вне манифеста, файлы не в UTF-8).
search — поиск с учётом регистра: `query` (или `q`), `ext=.kt`, `limit=30`, `path` — подстрока относительного пути. Для XML/Gradle/Java и других файлов задавай `ext` явно строчными буквами. `regex=true` принудительно включает регулярку; иначе сначала ищется буквальная подстрока, а при no-match и метасимволах в запросе выполняется regex-fallback. Вывод сгруппирован по файлам, сниппет до 160 символов; поиск останавливается на лимите, `Совпадений` — число показанных строк, не полный total. Значения не маскируются; no-match относится только к обследованной области.
outline — оглавление Kotlin-файла: классы/объекты, аннотации, супертипы, primary-конструктор, эвристические `inject`, свойства и методы, enum-записи, верхнеуровневые функции/свойства (`@Composable`/`@Preview`, расширения), typealias и диапазоны строк. В Java разбор базовый (record находится через `symbol`, но `outline` его не выводит). XML-режимы: layout (id/строки/binding-класс), navigation (destinations), манифест. `file` — путь/фрагмент имени файла; класс указывай через `name`. Даже с `name` выводится весь файл; `inherit=true` добавляет методы проектных супертипов только в этом режиме, не с `file`. `fields=false` скрывает свойства, но не параметры конструктора. Диапазоны некоторых expression-body деклараций приблизительные.
read — чтение с номерами строк и учётом кодировки: `file` обязателен, `offset=1` (1-based), `limit=400` по умолчанию. Точный путь внутри `root` имеет приоритет; при его отсутствии используется поиск по индексу. Прямой `read` не ограничен размером файлов индекса — большой файл читай диапазонами.
### Навигация
symbol — где определено: класс, интерфейс, объект, enum (по простому или полному имени), `Класс#метод`, `Класс.поле`, верхнеуровневая функция, расширение, typealias, запись enum, таблица Room, layout-файл, binding-класс, id представления, строковый ресурс, маршрут навигации. Имена членов сравниваются с учётом регистра. Вывод: `имя  вид  файл:начало-конец`.
deps / rdeps / path / node / stats / metrics — граф связей между файлами. Типы связей в выводе:
| Тип | Что значит |
|---|---|
| extends/implements | наследование и реализация интерфейса |
| inject | эвристика: все параметры primary-конструктора без проверки `@Inject`, `@Inject`-поля и параметры непосредственных методов `@Provides`/`@Binds` в `@Module`; провайдеры companion разворачиваются операцией `di`, но не как `inject`-рёбра |
| uses | любое другое упоминание типа: import, поле, вызов, аннотация, generic |
| calls | вызов верхнеуровневой функции, включая `@Composable` с trailing-lambda (`Name { }`) |
| binding | использование binding-класса layout-файла (ViewBinding) |
Граф файловый, только для типов/функций проекта; разрешение пакетов, alias и перегрузок для `uses`/`calls` не моделируется. `deps`/`rdeps` принимают `file` либо `name`, показывают только прямых соседей (до 40 каждого вида), `depth` для них не используется. `path` — направленная кратчайшая цепочка (`a`/`b` либо `from`/`to`, `undirected=true` для обеих сторон). `node` показывает счётчики и до 10 входящих рёбер; `stats` — счётчики и топ-10. Внутрифайловые рёбра скрыты; no-match не доказывает отсутствия runtime-связи.
impls — наследники и реализации типа (`name` или `file` как имя класса, `depth=3` по умолчанию), с ролью и пометкой abstract; сопоставление супертипов по имени, не анализ компилятора.
### Git-сигналы
hotspots — «где болит» по git-истории, только чтение истории, индекс Kotlin не строится (`.kt-cache` не трогается). По каждому файлу, менявшемуся за период: `коммитов`, `churn` (сумма добавленных и удалённых строк; бинарники — коммит считается, churn нет), `авторов`, `багфиксов` (subject по `/\b(fix|fixes|bug|hotfix|hotfixes|исправ|баг)\b/i`; `\b` в JS — ASCII-граница, кириллические ветки на практике не срабатывают) и `churn/стр` (только файлы от 50 текущих строк; размер — текущее число строк файла, чтение с потолком 5 МБ). Процентили `p50/p90/p97` считаются внутри репозитория: метка `pNN` — «значение достигло NN-процентильной границы по этой метке»; в таблице top у файла печатается старшая из его меток. Аргументы: `top` (по умолчанию 15), `file=ПУТЬ` (один файл: персональные метки и дата последнего касания), `since` (`<N>d` или `YYYY-MM-DD`, по умолчанию 180d), `max_commits` (потолок прохода, по умолчанию 2000, упор отмечается «история могла быть обрезана»). Сбор — один проход `git log --no-merges --no-renames`: переименования не отслеживаются (rename приходит как удаление + добавление), merge-коммиты не считаются. shallow-клон помечается «история неполная»; пустая история — «коммитов за период нет» (exit 0); каталог без git — «Ошибка: не git-репозиторий» (exit 1). Кэш — `.git-signals.json` в корне проекта; HEAD читается файлами `.git`, поэтому валидный кэш отдаётся даже без git в PATH.

### Метрики файлового графа

`metrics` принимает `file=<путь>` **либо** `top=<N>`; вместе запрещены. `top` — положительное safe integer (≤ 9007199254740991), default 15; без обоих аргументов — top-15. `depth` — строго целое 1..5, default 2 **только для metrics**; `deps`/`rdeps` по-прежнему показывают прямых соседей и не используют depth.

- `fan_in` / `fan_out` — уникальные проектные файлы по входящим/исходящим рёбрам; разные типы одной пары дедуплицируются.
- `dependents(depth)` — уникально достижимые обратным BFS файлы не дальше `depth`; `impact` — все обратнодостижимые файлы **без ограничения глубины**. Корень исключён из обоих счётчиков.
- `pagerank` — 20 итераций, damping 0.85, dangling mass распределяется равномерно. `percentile` — midrank `(less + halfEqual) / N * 100`, округлённый в тексте до `pN`; вычисляется на всём графе.
- Top: `fan_in` desc, затем `pagerank` desc, затем стабильный путь asc.

Учитываются исходники Kotlin/Java и XML manifests/layouts/navigation/values, в том числе изолированные ресурсы; произвольные XML и Gradle-файлы не добавляются. Все существующие типы связей (`extends/implements`, `inject`, `uses`, `calls`, `binding`) входят с прежними фильтрами индекса, внешние endpoints исключаются. Это статический **файловый** граф, не символьный или полный runtime call graph и не гарантия риска правки. `calls` остаётся существующей эвристикой межфайловых связей, а не полной моделью вызовов.

Вывод — общий текст: `src/Foo.kt  fan-in 12 (p95)  fan-out 4  dependents(2) 27  impact 41  pagerank 0.0132 (p95)`. Неизвестный файл — `Ошибка`, exit1, подсказка `op=stats`; пустой граф — `Граф пуст: <root>/.kt-cache/index.json`; цикл — `циклов: N` без подсказки `op=cycles` (такой операции нет). На прогретом индексе metrics не меняет кэш; холодный вызов законно строит его.

### Android
manifest — манифест по модулям: application (label, theme, allowBackup, класс), компоненты с резолвом в классы проекта (`файл:строка`), intent-фильтры (actions, categories, deep link `scheme://host`), exported (явный или вычисленный по intent-filter), provider authorities, `uses-permission`/`uses-feature`, предупреждения об exported без permission. Фильтры: `kind`, `query`, `module`. Фильтры `kind`/`query` применяются к компонентам, не к global permissions/application; namespace требуется явно из конфигурации модуля. Анализируется исходный XML, не merged manifest; неявный exported — эвристика по intent-filter, а не проверка Android API-level.
room — база Room без чтения исходников: все `@Entity` (таблицы), `@Dao` и `@Database` (сущности, версия, DAO-методы). `table=имя` — сущность с колонками (PK из primary-конструктора), ForeignKey/индексы и все DAO-методы, трогающие таблицу (SQL `@Query` склеивается из конкатенации строк; `@Insert`/`@Update`/`@Delete`/`@Upsert` сопоставляются по типу параметра, включая `List<Entity>`). `cls=Имя` — методы DAO с SQL и списком таблиц.
di — граф внедрения зависимостей (Hilt/Dagger): `@Module` с `@InstallIn`, методы `@Provides`/`@Binds` (включая companion object) со scope-аннотациями, классы с `@Inject constructor` и их параметры, точки входа `@HiltViewModel`/`@AndroidEntryPoint`/`@HiltAndroidApp`/`@HiltWorker`. `type=Имя` — где тип связан (binding), его `@Inject`-конструктор и все, кто его получает: конструкторы, `@Inject`-поля, параметры провайдеров.
nav — навигация целиком: nav-xml (start, destinations, локальные actions по XML-вложенности, отдельные global actions корневого navigation, deep link) и маршруты Compose (`composable("…")`, `startDestination`), все вызовы `navigate("маршрут")` и `navigate(R.id.dest)` с файлами и строками. `route=имя` — где маршрут объявлен, кто на него переходит и какие action ведут на него.
res — строковые ресурсы: атрибуты `<string>` не зависят от порядка и одинарных/двойных кавычек, XML-комментарии исключаются; файлы values по квалификаторам с числом ключей; `name=ключ` — значение в каждой локали (escaped-последовательности раскрываются, `translatable=false` помечается) и все места использования (`R.string.` в коде, `@string/` в xml); `missing=1` — ключи без перевода в какой-либо локали и ключи, отсутствующие в default. Поддержаны `values-en`, `values-en-rGB`, BCP47 `values-b+es`/`values-b+sr+Latn+RS`; в `missing=1` весь набор ключей и локалей берётся только из default и настоящих локалей, конфигурационные и смешанные квалификаторы (`night`, `land`, `en-night`…) отфильтровываются.
api — каталог Retrofit-endpoint'ов: интерфейсы с HTTP-методами (`@GET`/`@POST`/`@PUT`/`@DELETE`/`@PATCH`/`@HEAD`/`@OPTIONS`/`@HTTP`), URL, параметры с маркерами `@Path`/`@Query`/`@Body`/`@Header`/`@Field`/`@Part`/`@Url` (и их Map-варианты `@QueryMap`/`@HeaderMap`/`@PartMap`), возвращаемые типы, найденный `baseUrl` из `Retrofit.Builder`. Фильтры: `url=подстрока`, `cls=Интерфейс`; `base=0` — не искать baseUrl.
### Библиотеки
sig — сигнатуры из доступных jar/aar без JDK и загрузки кода библиотек. Каталоги: `jars` (через запятую), `KT_JARS` (системный разделитель путей), `libs/` модулей, `~/.gradle/caches/modules-2/files-2.1`; относительные каталоги — от cwd. `GRADLE_USER_HOME` и Android SDK автоматически не ищутся: для `android.*` передай каталог с `android.jar` через `jars`. Из AAR читается только `classes.jar`, не вложенные `libs/*.jar`. Полное JVM-имя предпочтительно; короткое разрешается по обычным/wildcard/alias-импортам. Вложенный JVM-класс указывай с `$` и одинарными кавычками.

Выводит public/protected члены с generic-типами и `[deprecated]`, параметры — `arg0`, `arg1`; generic-параметры заголовка класса/метода и `throws` в вывод не переносятся. `Class#method` фильтрует только методы с учётом регистра; поля и конструкторы остаются, отдельные `member`/`all` не поддержаны. Вывод до 30 полей (без маркера остатка) и 60 методов (с маркером). Из найденных кандидатов до первых 30 исправных сортируются эвристически по версии; `jar` — регистронезависимая подстрока полного пути, не dependency resolution Gradle. Повреждённые архивы/классы пропускаются с предупреждением; даже если все повреждены — текстовый no-match и exit 0. Подробные лимиты — в `references/android.md`.
### Изменение
patch — точная замена непустого строкового `old` на `new` с сохранением кодировки/BOM (включая UTF-16BE). Ровно одно вхождение, `all=true` — все; пустой `old` отклоняется. При no-match в CRLF-файле пробует LF→CRLF для заменяемого фрагмента; уже совпавший `new` автоматически не нормализуется. Пишет сразу, неатомарно, dry-run нет. cp1251 заменяет непредставимые символы на `?`: перед записью проверь текст. Для UTF-8 предпочитай штатный точечный Edit.
create — новый файл (`file`, `text`), существующий отклоняется. Добавляет завершающий LF; по умолчанию UTF-8 (cp1251 для не-ASCII текста, если она преобладает среди kt/java), EOL — преобладающий среди kt/java. `enc=utf-8|cp1251|utf-16le|utf-16be`, UTF-16 с BOM; неизвестная кодировка отклоняется. Параметр `eol` не обрабатывается. Запись сразу, dry-run нет; cp1251 может заменить неподдерживаемые символы на `?`.
## Выполнение команд (PowerShell)
Команда — одна строка, параметры через argv `ключ=значение`; примеры ниже — отдельные команды, не единый сценарий. `op` выбирает операцию. Без `op` CLI печатает список операций и завершает работу успешно; это не `info`.

Не используй pipe, `;`, `&`, `$()`, backtick, redirect и переносы внутри команды. `<SCRIPTS_DIR>` — абсолютный путь к папке `scripts` установленного скилла. `root` — корень анализируемого проекта (cwd по умолчанию).

`query` всегда заключай в одинарные кавычки, значения с пробелами, `$` и другими спецсимволами — тоже; апостроф внутри удваивается (`''`). Двойные кавычки внутри значений избегай в PowerShell 5.1. `#` внутри `Class#method` — часть аргумента. Кириллица через argv не портится. Для многострочных `patch`/`create` рекомендуется UTF-8 JSON штатным инструментом и отдельный аргумент `'@.kt-cache/payload.json'`; это не единственный интерфейс, `old`/`new`/`text` принимаются и через argv. `@`-файл ограничен cwd (не `root`), должен содержать JSON-объект.

Каталоги скилла: ZCode — `%USERPROFILE%\.zcode\skills\…` или `.zcode\skills\…` проекта; Kilo Code — `%USERPROFILE%\.kilocode\skills\…` или `.kilo\skills\…`; Linux/macOS — `~/.config/kilo/skills/…`.

Обзор и навигация:

    node "<SCRIPTS_DIR>\kt.js" op=info
    node "<SCRIPTS_DIR>\kt.js" op=symbol name=LoginViewModel
    node "<SCRIPTS_DIR>\kt.js" op=symbol name=ShopApi#login
    node "<SCRIPTS_DIR>\kt.js" op=symbol name=btn_login
    node "<SCRIPTS_DIR>\kt.js" op=outline name=UserRepositoryImpl inherit=true
    node "<SCRIPTS_DIR>\kt.js" op=rdeps file=UserRepository
    node "<SCRIPTS_DIR>\kt.js" op=impls name=UserRepository
    node "<SCRIPTS_DIR>\kt.js" op=search query='findByLogin' ext=.kt,.java,.xml
    node "<SCRIPTS_DIR>\kt.js" op=search query='compileSdk' ext=.kts,.toml

Android:

    node "<SCRIPTS_DIR>\kt.js" op=manifest
    node "<SCRIPTS_DIR>\kt.js" op=manifest kind=receiver
    node "<SCRIPTS_DIR>\kt.js" op=manifest query='BOOT_COMPLETED'
    node "<SCRIPTS_DIR>\kt.js" op=room
    node "<SCRIPTS_DIR>\kt.js" op=room table=users
    node "<SCRIPTS_DIR>\kt.js" op=room cls=UserDao
    node "<SCRIPTS_DIR>\kt.js" op=di
    node "<SCRIPTS_DIR>\kt.js" op=di type=UserRepository
    node "<SCRIPTS_DIR>\kt.js" op=nav
    node "<SCRIPTS_DIR>\kt.js" op=nav route=home
    node "<SCRIPTS_DIR>\kt.js" op=res
    node "<SCRIPTS_DIR>\kt.js" op=res name=login_title
    node "<SCRIPTS_DIR>\kt.js" op=res missing=1
    node "<SCRIPTS_DIR>\kt.js" op=api
    node "<SCRIPTS_DIR>\kt.js" op=api url=auth

Граф и библиотеки:

    node "<SCRIPTS_DIR>\kt.js" op=deps name=LoginViewModel
    node "<SCRIPTS_DIR>\kt.js" op=node file=UserDao
    node "<SCRIPTS_DIR>\kt.js" op=path a=MainActivity b=UserDao undirected=true
    node "<SCRIPTS_DIR>\kt.js" op=stats
    node "<SCRIPTS_DIR>\kt.js" op=hotspots top=10
    node "<SCRIPTS_DIR>\kt.js" op=hotspots file=app/src/main/java/com/acme/Foo.kt
    node "<SCRIPTS_DIR>\kt.js" op=metrics file=app/src/main/java/com/acme/UserDao.kt depth=2
    node "<SCRIPTS_DIR>\kt.js" op=metrics top=15
    node "<SCRIPTS_DIR>\kt.js" op=sig name=androidx.room.RoomDatabase
    node "<SCRIPTS_DIR>\kt.js" op=sig name=retrofit2.Retrofit jar=retrofit

read / patch / create (для legacy-кодировок; `read` доступен и для UTF-8, запись без dry-run):

    node "<SCRIPTS_DIR>\kt.js" op=read file=legacy/Cp1251Notes.java offset=5 limit=20
    node "<SCRIPTS_DIR>\kt.js" '@.kt-cache/payload.json'

Содержимое `.kt-cache/payload.json`:

    {"op":"patch","file":"app/src/main/java/com/acme/Foo.kt","old":"return 1;","new":"return 2;"}

Подробности про индекс, определение ролей, кодировки и ограничения: `references/android.md`.

Самопроверка скрипта (индекс проекта не нужен):

    node "<SCRIPTS_DIR>\kt.js" op=selftest

