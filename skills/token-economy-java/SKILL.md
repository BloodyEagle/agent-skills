---
name: token-economy-java
version: 1.0.3
description: Экономия токенов в проектах на Java 17+ и Spring Boot 3+ — поиск определений, статический граф связей (наследование, эвристики внедрения зависимостей, использование), оглавление класса, реализации интерфейса, HTTP-эндпоинты, бины, конфигурация с маскированием секретов, JPA-поля и репозитории, каталог таблиц и фрагментов миграций, слушатели событий и очередей, сигнатуры классов библиотек из jar без декомпиляции. Все команды — PowerShell. Правила стека — references/java.md.
---

# Skill: token-economy-java

Правила стека — `references/java.md` в этом же каталоге скилла: прочитай перед первой командой сессии. Путь относительный от каталога скилла, а не от корня агента.

## Декларация инструментов (Kilo Code Agent Tool Schema)
```json
{
  "name": "token-economy-java",
  "description": "Запускает скрипт jv.js для минимизации контекста ИИ в Java / Spring Boot проектах.",
  "parameters": {
    "type": "object",
    "properties": {
      "op": {
        "type": "string",
        "description": "info | search | symbol | deps | rdeps | path | node | stats | outline | impls | beans | endpoints | config | entities | table | listeners | sig | read | patch | create | build | selftest"
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

1. Один раз за разговор, прежде чем читать или править файлы, вызови `info`: версии Spring Boot и Java, модули, главный класс, профили, кодировка файлов.
2. Файл короче 300 строк читай напрямую. Файл от 300 строк — сначала `outline`, затем точечное чтение диапазона (Read(offset, limit)); диапазоны строк есть в выводе `outline` и `symbol`.
3. Где определён класс, интерфейс, метод, поле или таблица БД — `symbol`. Где встречается текст — `search` (для yml, properties, sql, xml передавай `ext`).
4. Перед правкой общего класса (интерфейс сервиса, сущность, DTO, конфигурация) вызови `rdeps`: он покажет статические использования, эвристические связи внедрения (`inject`) и тесты в пределах индекса. Реализации и наследники — `impls`; роль `service`/`repository` не доказывает активацию бина.
5. Вопросы по Spring решай профильными операциями, а не чтением файлов:
   - какие есть HTTP-эндпоинты, какой метод обслуживает URL — `endpoints`;
   - какие бины есть, что внедряется куда, что создаёт `@Bean` — `beans`;
   - где задано и где используется свойство — `config` (значения паролей, токенов и ключей скрыты; не читай `application*.yml` ради них и не выводи секреты в ответе);
   - поля сущности, таблица, репозиторий и его запросы — `entities`; колонки и миграции таблицы — `table`;
   - кто слушает событие, топик или очередь, что выполняется по расписанию — `listeners`.
6. Сигнатуры классов и методов библиотек (Spring, Jackson, Hibernate…) узнавай через `sig` по полному имени класса. Не угадывай API, не открывай jar и не декомпилируй.
7. Lombok-код (геттеры, сеттеры, конструкторы, билдеры) в исходниках отсутствует: не ищи такие методы через `symbol`, смотри аннотации класса в `outline`.
8. Правки штатным инструментом разрешены только в файлах UTF-8. Если `info` показал файлы не в UTF-8, читай их операцией `read`, правь `patch`, создавай `create`.
9. Если `info` предупредил про `javax.*` при Spring Boot 3, новые файлы пиши с `jakarta.*`.
10. Индекс строится и обновляется сам при каждом вызове — это анализ, не запуск проекта. Папку `.jv-cache` не читай.
11. Не запускай `mvn`, `gradle`, тесты и приложение — проверки выполняет пользователь.
12. Пути `read`/`patch`/`create`, исходники индекса и путь кэша ограничены корнем проекта (`root`, по умолчанию cwd): проверяются реальные пути и существующие предки. Внешние и неразрешимые symlink/junction отклоняются; внутренние ссылки и имя `..foo.java` разрешены. `sig` отдельно читает библиотеки из документированных внешних Maven/Gradle/JV_JARS-каталогов.

## Инструменты

### Обзор и поиск

info — сборка (Maven или Gradle, модули), версии Spring Boot и Java, главный класс, зависимости (стартеры и ключевые библиотеки), конфигурационные файлы и профили, состав проекта по ролям (controller, service, repository, entity…), кодировки, предупреждения (javax при Boot 3, файлы не в UTF-8).

search — поиск подстроки или регулярки (`regex=true`), по умолчанию с учётом регистра; `i=true` или `ignoreCase=true` отключает учёт регистра. `query` обязателен, `ext=.java`, `limit=30`; `path` — точный относительный путь или префикс каталога от `root`. Результат сгруппирован по файлам; итог считает все совпавшие строки, лимит ограничивает только вывод. В `application*.yml|yaml|properties` и `bootstrap*` значения чувствительных ключей маскируются как в `config`, в том числе во вложенных структурах и продолжениях строк. Совпадения и их номера считаются по исходнику; маскирование применяется до сокращения сниппета. Остальные файлы выводятся без маскирования: `search` не является универсальным сканером секретов. Не передавай секретное значение как `query`: сообщение об отсутствии совпадений повторяет запрос.

outline — оглавление: класс с аннотациями, поля, методы с сигнатурами и аннотациями (в том числе `@GetMapping("/{id}")`, `@Transactional`), диапазоны строк, список эвристических зависимостей (`inject`). `inherit=true` добавляет не-private методы по первой цепочке `extends` главного типа: до пяти предков, до 40 методов каждого; интерфейсы из `implements` не разворачиваются. `fields=false` скрывает поля. `file` (или `target`) принимает путь, имя класса (`UserController`) или полное имя.

read — чтение точного пути `file` внутри `root` с номерами строк и учётом кодировки: `offset=1` (1-based), `limit=200` по умолчанию. Ограничение размера индексируемых файлов не является ограничением прямого `read`; большие файлы читай диапазонами.

### Навигация

symbol — где определено: класс, интерфейс, enum, record (по простому или полному имени), `Класс#метод`, поле, имя таблицы БД. Имена членов (методов и полей) сравниваются с учётом регистра. Вывод: `имя  вид  файл:начало-конец`.

deps / rdeps / path / node / stats — граф связей между файлами. Типы связей в выводе:

| Тип | Что значит |
|---|---|
| extends/implements | наследование, реализация интерфейса, `permits` (sealed-иерархия) |
| inject | эвристика по типам: единственный конструктор без проверки, что класс — бин; `@Autowired`/`@Inject` на конструкторах и методах, `@Autowired`/`@Inject`/`@Resource` на полях, параметры `@Bean`, Lombok (`@RequiredArgsConstructor`, `@AllArgsConstructor`), компоненты record-бинов |
| uses | любое другое использование типа: поле, вызов, аннотация, generic, статический импорт |

Граф файловый и содержит только типы проекта. `deps`/`rdeps` требуют `file`, `depth=1` (диапазон 1–5), выводят до 60 файлов; `path` требует `from`/`to` и ищет направленную кратчайшую цепочку. `node` требует `file` и показывает до 40 прямых соседей в каждом направлении; `stats` — счётчики и 10 наиболее востребованных файлов. Пустой результат не доказывает отсутствия runtime-связи.

impls — наследники и реализации в индексируемых файлах (с глубиной `depth=3`, диапазон 1–6), до 60 результатов с ролью (service, repository…) и пометкой abstract. Принимает `name` или `file`; наличие роли не подтверждает попадание в Spring-контекст.

### Spring

beans — стереотипные классы (`@Service`, `@Component`, `@Repository`, `@Controller`, `@Configuration`, `@ConfigurationProperties`, `@FeignClient`…), репозитории Spring Data и `@Bean`-методы с типом результата, условиями (`@Profile`, `@Primary`, `@ConditionalOn…`) и внедряемыми зависимостями. Фильтр — `query`.

endpoints — HTTP-эндпоинты: метод, полный путь (путь класса + путь метода, константы вида `ApiPaths.USERS` разворачиваются), контроллер и метод с параметрами (`@PathVariable`, `@RequestBody`…), ограничения (`@PreAuthorize`, `@PostAuthorize`, `@Secured`, `@RolesAllowed`). Включает декларативные клиенты (`@HttpExchange`, `@FeignClient`) с пометкой `[client]`. Фильтр — `query` (часть пути, метода HTTP или имени).

config — ключи из `application*.yml|yaml|properties` и `bootstrap*` по всем профилям: значение, профиль, файл и строка. Секреты (password, passwd, pwd, secret, token, credential, private-key, api-key, access-key, client-secret, salt) показываются как `***`, чистые ссылки `${ENV}` без значения по умолчанию — как есть. `${ENV:секрет}` скрывается; inline-контейнер с чувствительным ключом маскируется целиком. Для каждого ключа показано, где он используется: `@Value`, `@ConfigurationProperties(prefix)`, `@ConditionalOnProperty`, `getProperty`/`getRequiredProperty`. Поиск не зависит от регистра и вида записи (`page-size`, `pageSize`, `page_size` совпадают). Без `query` — сводка по файлам, профилям и префиксам.

entities — JPA-сущности (`@Entity`, `@Embeddable`, `@MappedSuperclass`): таблица (явная или эвристическая snake_case), поля с типами и пометками (PK, generated, колонка, unique, связи с `mappedBy` и `join`), поля до четырёх проектных предков `@Entity`/`@MappedSuperclass`, репозиторий с методами и `@Query`. Это field-based разбор, не JPA metamodel: аннотации на геттерах и физическая naming strategy не вычисляются.

table — таблица БД по `name` (или `query`): JPA-сущность, `CREATE TABLE` из отобранных SQL-файлов с колонками и ключами, отдельные выдержки `ALTER TABLE`, упоминания `tableName` в Liquibase. Порядок миграций и итоговая схема после ALTER не вычисляются; область SQL и лимиты вывода — в `references/spring.md`.

listeners — слушатели `@EventListener`, `@TransactionalEventListener`, `@KafkaListener` (топики, группа), `@RabbitListener`, `@JmsListener`, `@SqsListener`, `@StreamListener`, `@Scheduled`, а также публикации `publishEvent(new X())` и отправка сообщений через шаблоны kafka/rabbit/jms/sqs/sns/amqp (`send`, `convertAndSend`, …) и `streamBridge`. Фильтр — `query` (имя события, топика, класса).

### Библиотеки

sig — сигнатуры класса из jar или готового `.class`, без загрузки кода библиотеки. Предварительная сборка не обязательна, если jar уже доступны. Источники: Maven `~/.m2/repository` (`localRepository` из `~/.m2/settings.xml`), Gradle (`GRADLE_USER_HOME` или `~/.gradle`)/`caches/modules-2/files-2.1`, `lib/` корня проекта, `jars` либо `JV_JARS`, затем корневые `target/classes` и `build/classes/java/main`. Списки `jars`/`JV_JARS` разделяются системным разделителем путей (`;` в Windows, `:` в Unix); `jars` заменяет `JV_JARS`, но не остальные источники. Относительные внешние каталоги разрешаются от cwd, не `root`. JDK нужен только для fallback `java.*`/`javax.*` через внешний `javap -public` (параметры `member`/`all` на этот fallback не действуют).

Принимает полное имя, член через `#` или `member`; короткое имя разрешается по первому обычному импорту в проекте, не по wildcard. При отсутствующем/битом parse-кэше импорты читаются из актуальных исходников. Выводит public/protected члены с generics, `throws` и `@Deprecated`; `all=true` добавляет private/package-private, но не synthetic/bridge и `<clinit>`. `member` сравнивается без учёта регистра; вывод ограничен 120 строками описания. Имена параметров видны при наличии `MethodParameters` (обычно `-parameters`). Кандидаты сортируются по числовым фрагментам полного пути, не по Maven dependency resolution; `jar` — регистронезависимая подстрока полного пути. Повреждённые архивы/классы пропускаются с предупреждением; если найденный class невозможно разобрать — exit 1, обычный no-match — текст и exit 0. Форматы и лимиты — в `references/spring.md`.

### Изменение

patch — точная замена непустого фрагмента с сохранением кодировки и BOM. `old`/`new` приводятся к преобладающему LF/CRLF файла. По умолчанию ровно одно вхождение; `all=true` — все. Операция пишет сразу, dry-run нет. Для UTF-8 предпочитай штатный точечный Edit.

create — новый файл (`file`, `text`), существующий файл отклоняется; пишет сразу, dry-run нет. Кодировка UTF-8 без BOM; для не-ASCII текста без `enc` выбирается cp1251, только если её файлов .java больше, чем файлов с меткой `utf8` (ASCII не входит в это сравнение). Явно: `enc=utf8` или `enc=cp1251`; любое другое непустое значение тоже выбирает UTF-8, валидации имени кодировки нет. LF по умолчанию, `eol=crlf` — CRLF; завершающий перенос не добавляется.

## Выполнение команд (PowerShell)

Команда — одна строка, параметры передаются argv-аргументами `ключ=значение` (разделитель значения — первый `=`), обязательный параметр каждой операции — `op`:

    node "<SCRIPTS_DIR>\jv.js" op=info

Не используй пайп (`|`), `;`, `&`, `$()`, backtick, `>` и переносы строк — права среды их отклоняют, прежние вызовы через stdin-пайп больше не проходят. Права разрешают вызов по имени скрипта, поэтому полный путь в двойных кавычках допустим: команда выглядит как `node "<SCRIPTS_DIR>\jv.js" ключ=значение…`.

`<SCRIPTS_DIR>` — папка `scripts` этого скилла: возьми полный путь этого SKILL.md и замени имя файла на `scripts`. Каталог скиллов агента: ZCode — `%USERPROFILE%\.zcode\skills\…` (в репозитории проекта — `.zcode\skills\…`), Kilo Code — `%USERPROFILE%\.kilocode\skills\…` (в репозитории — `.kilo\skills\…`, Linux/macOS — `~/.config/kilo/skills/…`).

Значения `query` всегда заключай в одинарные кавычки; значения с пробелами, `$` или другими спецсимволами PowerShell — тоже. Апостроф внутри значения удваивается (`''`); двойные кавычки `"` внутри значений не используй — PowerShell 5.1 их портит. Кириллица через argv не портится: node читает командную строку через Unicode API Windows. Для многострочных payload (`patch`/`create`) запиши UTF-8 JSON штатным инструментом в `.jv-cache/payload.json` и передай отдельным аргументом `'@.jv-cache/payload.json'`. Это рекомендуемый способ, не единственный интерфейс CLI: `op`, `file`, `old`, `new`, `text` принимаются и через argv. `@`-файл читается относительно cwd до применения `root` и не ограничивается `safePath`; используй только доверенный локальный JSON внутри проекта.

Общий параметр: `root` (корень проекта, по умолчанию текущая папка; для многомодульных проектов запускай из корня репозитория).

info:

    node "<SCRIPTS_DIR>\jv.js" op=info

symbol / outline / rdeps / impls:

    node "<SCRIPTS_DIR>\jv.js" op=symbol name=UserService
    node "<SCRIPTS_DIR>\jv.js" op=symbol name=UserController#get
    node "<SCRIPTS_DIR>\jv.js" op=outline file=UserController
    node "<SCRIPTS_DIR>\jv.js" op=rdeps file=UserService depth=2
    node "<SCRIPTS_DIR>\jv.js" op=impls name=UserService

search (для ресурсов — `ext`):

    node "<SCRIPTS_DIR>\jv.js" op=search query='findByEmail' path=src/main
    node "<SCRIPTS_DIR>\jv.js" op=search query='user-events' ext=.java,.yml,.properties

Spring:

    node "<SCRIPTS_DIR>\jv.js" op=endpoints query='/api/users'
    node "<SCRIPTS_DIR>\jv.js" op=beans query='Security'
    node "<SCRIPTS_DIR>\jv.js" op=config query='app.mail'
    node "<SCRIPTS_DIR>\jv.js" op=entities query='User'
    node "<SCRIPTS_DIR>\jv.js" op=table name=users
    node "<SCRIPTS_DIR>\jv.js" op=listeners query='UserCreatedEvent'

sig:

    node "<SCRIPTS_DIR>\jv.js" op=sig name=org.springframework.web.client.RestClient
    node "<SCRIPTS_DIR>\jv.js" op=sig name=org.springframework.web.client.RestClient#get

read / patch / create (для не-UTF-8; `read` доступен и для UTF-8, `patch`/`create` записывают сразу):

    node "<SCRIPTS_DIR>\jv.js" '@.jv-cache/payload.json'

Содержимое `.jv-cache/payload.json` для правки:

    {"op":"patch","file":"src/main/java/com/acme/Foo.java","old":"return 1;","new":"return 2;"}

Подробности про индекс, определение ролей и ограничения: `references/spring.md`.

Самопроверка скрипта (индекс проекта не нужен):

    node "<SCRIPTS_DIR>\jv.js" op=selftest

