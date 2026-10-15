# token-economy-java: устройство и ограничения

Открывай этот файл, только если ответ скрипта непонятен или нужно понять, чего он не видит.

## Какие файлы входят в индекс

Файлы `.java` из `git ls-files` (учитывается `.gitignore`), без git — обход каталогов. Пропускаются `module-info.java`, `package-info.java`, файлы больше 2 МБ, а также каталоги сборки `target`, `build`, `out`, `bin` вне `src` (пакет с таким именем внутри `src` пропущен не будет), `.gradle`, `.idea`, `node_modules`. Тесты (`src/test`) входят в индекс с пометкой `test`. Конфигурация (`application*.yml|yaml|properties`, `bootstrap*`) и SQL читаются на лету, без кэша.

## Как определяется роль файла (метка в квадратных скобках)

По аннотациям главного типа файла: `controller` (`@RestController`, `@Controller`), `advice` (`@ControllerAdvice`), `service`, `repository` (`@Repository` или интерфейс, наследующий `…Repository<…>`), `config` (`@Configuration`, `@SpringBootApplication`), `entity` (`@Entity`, `@Embeddable`, `@MappedSuperclass`), `properties` (`@ConfigurationProperties`), `client` (`@FeignClient`, `@HttpExchange`), `mapper` (`@Mapper`), `component`, `test` (путь `src/test` или тестовые аннотации Spring). Иначе — вид типа: `class`, `interface`, `enum`, `record`, `@interface`.

## Как строятся связи

- Типы: имена из заголовков (`extends`, `implements`, `permits`), аннотаций, полей, параметров, generics и тела кода разрешаются по явным импортам, пакету файла и импортам с `*`; полные имена с пакетом (`com.acme.Foo`) разрешаются напрямую, вложенные типы приводятся к файлу внешнего класса. Статический импорт даёт связь на класс.
- Внедрение (`inject`): параметры единственного конструктора (или конструктора с `@Autowired`/`@Inject`), поля с `@Autowired`/`@Inject`/`@Resource`, параметры `@Bean`-методов, компоненты record-бинов (`@ConfigurationProperties` и стереотипы), поля Lombok `@RequiredArgsConstructor` (final без инициализатора) и `@AllArgsConstructor`.
- Если одно и то же отношение встречается разными способами, берётся самое сильное: extends/implements, затем inject, затем uses.

## Эндпоинты и константы

Путь собирается из пути класса (`@RequestMapping`, `@HttpExchange`) и пути метода (`@GetMapping`, `@PostMapping`, `@PutMapping`, `@DeleteMapping`, `@PatchMapping`, `@RequestMapping(method=…)`, `@GetExchange` и аналоги). Строковые константы вида `ApiPaths.USERS` и выражения `BASE + "/users"` разворачиваются, если константа `static final String` объявлена в проекте (поиск по имени `Класс.ИМЯ`). Неразрешённые части остаются в виде `{выражение}`.

## Конфигурация

YAML разбирается как подмножество: вложенные ключи, списки (`key[0]`), несколько документов через `---` (профиль берётся из `spring.config.activate.on-profile` или `spring.profiles`), блочные скаляры. Профиль также определяется по имени файла (`application-dev.yml`). Ключи сопоставляются без учёта регистра и разделителей. Не учитываются: переменные окружения, Config Server, `spring.config.import`, значения из командной строки.

Скрываются значения ключей с `password`, `passwd`, `pwd`, `secret`, `token`, `credential`, `private-key`, `api-key`, `access-key`, `client-secret`, `salt`, кроме ссылок на переменные окружения `${…}`.

## sig

Источник — `.class` внутри jar. Пакеты каждого jar индексируются один раз и кэшируются в `.jv-cache/jars.json` (первый вызов на большом репозитории `~/.m2` может занять несколько секунд). Вложенные классы указываются через точку (`Outer.Inner`) или `$`. Не показываются: приватные члены, синтетические и bridge-методы, `<clinit>`; `"all":true` включает приватные. Классы самого JDK (`java.*`) читаются через `javap`, если он доступен. Код библиотеки не загружается и не исполняется.

## Чего скрипт не видит

- Конфигурация бинов через XML, `@Import`, `@ComponentScan` с ограничениями и автоконфигурации: `beans` перечисляет все аннотированные классы проекта, не проверяя, попадают ли они в контекст.
- `@Bean`-методы в классах без `@Configuration` показываются, но условия их активации не вычисляются.
- Функциональные маршруты (`RouterFunction`), Kotlin и Groovy, сгенерированный код (MapStruct, QueryDSL, Lombok, `target/generated-sources`).
- Использование типов в строках (имена классов в XML, `Class.forName`, SpEL).
- Миграции Liquibase разбираются только как упоминания `tableName`; схема из `CREATE TABLE` — только для SQL-миграций.
- Несколько деклараторов в одном поле (`int a, b;`) записываются как одно поле (первое имя).

## Кэш

`.jv-cache/index.json` и `cache.json` (внутри `.gitignore` со звёздочкой). Индекс пересобирается сам при добавлении, удалении, переименовании и изменении файлов; заново разбираются только изменённые. Принудительно: `{"op":"build"}`. Если ответ выглядит устаревшим после обновления скилла, удали папку `.jv-cache`.
