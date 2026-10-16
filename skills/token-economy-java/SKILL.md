---
name: token-economy-java
description: Экономия токенов в проектах на Java 17+ и Spring Boot 3+: поиск определений, граф связей (наследование, внедрение зависимостей, использование), оглавление класса, реализации интерфейса, HTTP-эндпоинты, бины, конфигурация с маскированием секретов, JPA-сущности и репозитории, схема таблиц, слушатели событий и очередей, сигнатуры классов библиотек из jar без декомпиляции. Все команды — PowerShell.
---

# Skill: token-economy-java

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
        "description": "info | search | symbol | deps | rdeps | path | node | stats | outline | impls | beans | endpoints | config | entities | table | listeners | sig | read | patch | create | build"
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

1. Один раз за разговор, прежде чем читать или править файлы, вызови `info`: версии Spring Boot и Java, модули, главный класс, профили, кодировка файлов.
2. Файл короче 300 строк читай напрямую. Файл от 300 строк — сначала `outline`, затем точечное чтение диапазона (Read(offset, limit)); диапазоны строк есть в выводе `outline` и `symbol`.
3. Где определён класс, интерфейс, метод, поле или таблица БД — `symbol`. Где встречается текст — `search` (для yml, properties, sql, xml передавай `ext`).
4. Перед правкой общего класса (интерфейс сервиса, сущность, DTO, конфигурация) вызови `rdeps`: он покажет, кто его использует, кто внедряет (`inject`) и какие тесты затронуты. Какой класс реализует интерфейс и попадёт в контекст как бин — `impls`.
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
12. Скрипт работает только с путями внутри рабочей директории; пути вне проекта отклоняй.

## Инструменты

### Обзор и поиск

info — сборка (Maven или Gradle, модули), версии Spring Boot и Java, главный класс, зависимости (стартеры и ключевые библиотеки), конфигурационные файлы и профили, состав проекта по ролям (controller, service, repository, entity…), кодировки, предупреждения (javax при Boot 3, файлы не в UTF-8).

search — поиск подстроки или регулярки, результат сгруппирован по файлам, до 30 совпадений. По умолчанию `.java`, для других файлов — `ext`.

outline — оглавление: класс с аннотациями, поля, методы с сигнатурами и аннотациями (в том числе `@GetMapping("/{id}")`, `@Transactional`), диапазоны строк, список внедряемых зависимостей (`inject`). С `"inherit":true` добавляет методы предков из проекта. С `"fields":false` скрывает поля. Принимает путь, имя класса (`UserController`) или полное имя.

read — чтение файла с номерами строк с учётом кодировки (`offset`, `limit`).

### Навигация

symbol — где определено: класс, интерфейс, enum, record (по простому или полному имени), `Класс#метод`, поле, имя таблицы БД. Имена членов (методов и полей) сравниваются с учётом регистра. Вывод: `имя  вид  файл:начало-конец`.

deps / rdeps / path / node / stats — граф связей между файлами. Типы связей в выводе:

| Тип | Что значит |
|---|---|
| extends/implements | наследование и реализация интерфейса |
| inject | внедрение зависимости: параметр единственного конструктора, `@Autowired`, `@Inject`, `@Resource`, параметры `@Bean`-методов, конструктор Lombok (`@RequiredArgsConstructor`, `@AllArgsConstructor`), компоненты record-бинов |
| uses | любое другое использование типа: поле, вызов, аннотация, generic, статический импорт |

impls — все наследники и реализации типа (с глубиной `depth`, по умолчанию 3), с ролью (service, repository…) и пометкой abstract.

### Spring

beans — стереотипные классы (`@Service`, `@Component`, `@Repository`, `@Controller`, `@Configuration`, `@ConfigurationProperties`, `@FeignClient`…), репозитории Spring Data и `@Bean`-методы с типом результата, условиями (`@Profile`, `@Primary`, `@ConditionalOn…`) и внедряемыми зависимостями. Фильтр — `query`.

endpoints — HTTP-эндпоинты: метод, полный путь (путь класса + путь метода, константы вида `ApiPaths.USERS` разворачиваются), контроллер и метод с параметрами (`@PathVariable`, `@RequestBody`…), ограничения (`@PreAuthorize`, `@Secured`, `@RolesAllowed`). Включает декларативные клиенты (`@HttpExchange`, `@FeignClient`) с пометкой `[client]`. Фильтр — `query` (часть пути, метода HTTP или имени).

config — ключи из `application*.yml|yaml|properties` и `bootstrap*` по всем профилям: значение, профиль, файл и строка. Секреты (ключи с password, secret, token, key, credential) показываются как `***`, ссылки вида `${ENV}` — как есть. Для каждого ключа показано, где он используется: `@Value`, `@ConfigurationProperties(prefix)`, `@ConditionalOnProperty`, `getProperty`. Поиск не зависит от регистра и вида записи (`page-size`, `pageSize`, `page_size` совпадают). Без `query` — сводка по файлам, профилям и префиксам.

entities — JPA-сущности (`@Entity`, `@Embeddable`, `@MappedSuperclass`): таблица (явная или по умолчанию), поля с типами и пометками (PK, generated, колонка, unique, связи с `mappedBy` и `join`), унаследованные поля, репозиторий с методами и `@Query`.

table — таблица БД по имени: JPA-сущность, `CREATE TABLE` из SQL-миграций (Flyway и аналогичные) с колонками и ключами, последующие `ALTER TABLE`, упоминания в Liquibase.

listeners — слушатели `@EventListener`, `@TransactionalEventListener`, `@KafkaListener` (топики, группа), `@RabbitListener`, `@JmsListener`, `@Scheduled`, а также публикации `publishEvent(new X())` и отправка сообщений через `kafkaTemplate.send(...)`, `rabbitTemplate.convertAndSend(...)`. Фильтр — `query` (имя события, топика, класса).

### Библиотеки

sig — сигнатуры класса из jar: Maven `~/.m2` (учитывается `localRepository` из `settings.xml`), Gradle `~/.gradle/caches`, `lib/` проекта, каталоги из `JV_JARS` или параметра `jars`, а также `target/classes` и `build/classes`. Работает без JDK и без запуска кода: разбирает `.class` напрямую. Принимает `org.springframework.web.client.RestClient`, член через `#` (`RestClient#get`) или параметр `member`; короткое имя допустимо, если класс импортирован в проекте. Выводит публичные и protected члены с generics, `throws` и пометкой `@Deprecated`; имена параметров показываются, если библиотека собрана с `-parameters`. Если в репозитории несколько версий, берётся старшая (`jar` задаёт подстроку имени jar).

### Изменение

patch — точная замена фрагмента с сохранением кодировки, BOM и перевода строк. Ровно одно вхождение (`"all":true` — все). Нужен только для файлов не в UTF-8.

create — новый файл; кодировка по умолчанию UTF-8 (или преобладающая в проекте, если в тексте есть не-ASCII и в проекте больше файлов в cp1251).

## Выполнение команд (PowerShell)

Команда — одна строка, параметры передаются argv-аргументами `ключ=значение` (разделитель значения — первый `=`), обязательный параметр каждой операции — `op`:

    node "$env:USERPROFILE\.kilocode\skills\token-economy-java\scripts\jv.js" op=info

Не используй пайп (`|`), `;`, `&`, `$()`, backtick, `>` и переносы строк — права среды их отклоняют, прежние вызовы через stdin-пайп больше не проходят. Права разрешают вызов по имени скрипта, поэтому полный путь в двойных кавычках допустим: команда выглядит как `node "<путь>\jv.js" ключ=значение…`.

Варианты пути до скриптов:

    глобально на Windows: "$env:USERPROFILE\.kilocode\skills\token-economy-java\scripts"
    локально в репозитории: ".kilo\skills\token-economy-java\scripts"
    pwsh на Linux/macOS: "$HOME/.config/kilo/skills/token-economy-java/scripts"

Значения аргументов: с пробелами — в одинарных кавычках; апостроф внутри значения удваивается (`''`); значения, начинающиеся с `$`, тоже бери в одинарные кавычки, иначе PowerShell раскроет их как переменные; двойные кавычки `"` внутри значений не используй — PowerShell 5.1 их портит. Кириллица через argv не портится: node читает командную строку через Unicode API Windows. Для многострочных payload (`patch`/`create`) — файл параметров: запиши JSON штатным инструментом в `.jv-cache/payload.json` (папка вне git) и передай его через `@.jv-cache/payload.json`.

Общий параметр: `root` (корень проекта, по умолчанию текущая папка; для многомодульных проектов запускай из корня репозитория).

info:

    node "$env:USERPROFILE\.kilocode\skills\token-economy-java\scripts\jv.js" op=info

symbol / outline / rdeps / impls:

    node "$env:USERPROFILE\.kilocode\skills\token-economy-java\scripts\jv.js" op=symbol name=UserService
    node "$env:USERPROFILE\.kilocode\skills\token-economy-java\scripts\jv.js" op=symbol name=UserController#get
    node "$env:USERPROFILE\.kilocode\skills\token-economy-java\scripts\jv.js" op=outline file=UserController
    node "$env:USERPROFILE\.kilocode\skills\token-economy-java\scripts\jv.js" op=rdeps file=UserService depth=2
    node "$env:USERPROFILE\.kilocode\skills\token-economy-java\scripts\jv.js" op=impls name=UserService

search (для ресурсов — `ext`):

    node "$env:USERPROFILE\.kilocode\skills\token-economy-java\scripts\jv.js" op=search query=findByEmail path=src/main
    node "$env:USERPROFILE\.kilocode\skills\token-economy-java\scripts\jv.js" op=search query=user-events ext=.java,.yml,.properties

Spring:

    node "$env:USERPROFILE\.kilocode\skills\token-economy-java\scripts\jv.js" op=endpoints query=/api/users
    node "$env:USERPROFILE\.kilocode\skills\token-economy-java\scripts\jv.js" op=beans query=Security
    node "$env:USERPROFILE\.kilocode\skills\token-economy-java\scripts\jv.js" op=config query=app.mail
    node "$env:USERPROFILE\.kilocode\skills\token-economy-java\scripts\jv.js" op=entities query=User
    node "$env:USERPROFILE\.kilocode\skills\token-economy-java\scripts\jv.js" op=table name=users
    node "$env:USERPROFILE\.kilocode\skills\token-economy-java\scripts\jv.js" op=listeners query=UserCreatedEvent

sig:

    node "$env:USERPROFILE\.kilocode\skills\token-economy-java\scripts\jv.js" op=sig name=org.springframework.web.client.RestClient
    node "$env:USERPROFILE\.kilocode\skills\token-economy-java\scripts\jv.js" op=sig name=org.springframework.web.client.RestClient#get

read / patch / create (только для файлов не в UTF-8; для patch и create — `@`-файл параметров, единственный способ: многострочные значения в argv не передать):

    node "$env:USERPROFILE\.kilocode\skills\token-economy-java\scripts\jv.js" @.jv-cache/payload.json

Содержимое `.jv-cache/payload.json` для правки:

    {"op":"patch","file":"src/main/java/com/acme/Foo.java","old":"return 1;","new":"return 2;"}

Подробности про индекс, определение ролей и ограничения: `references/spring.md`.
