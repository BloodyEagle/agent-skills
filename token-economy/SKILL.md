---
name: token-economy
description: Легковесный набор из 10 скриптов для сжатия, поиска, точечного патчинга и генерации кода. Каждый вызов гарантированно окупается экономией токенов, без оверхеда на коротких задачах. Все команды — PowerShell.
---

# Skill: token-economy

## Декларация инструментов (Kilo Code Agent Tool Schema)
```json
{
  "name": "token-economy",
  "description": "Запускает скрипты для минимизации контекста ИИ.",
  "parameters": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "description": "git-check | compress | search | outline | schema | api | graph | diff | patch | generate"
      },
      "payload": {
        "type": "object",
        "description": "JSON-объект с параметрами действия, передаётся через stdin."
      }
    },
    "required": [
      "action"
    ]
  }
}
```

## Правила (строго)

    В начале любой задачи вызывай git-check. Он вернёт список файлов с незакоммиченными правками — независимо от их количества вывод остаётся компактным. Это стартовая карта состояния рабочей директории.
    Если файл из списка git-check предстоит патчить — сначала прочитай его актуальную версию (через compress, если от 100 строк): oldChunk должен соответствовать текущему состоянию файла, а не последнему коммиту.
    Новые сущности Angular (компоненты, сервисы, пайпы, модули, директивы, гварды) — только через generate. Заготовки руками не пишутся: шаблонный код создаётся CLI локально, выходных токенов — ноль.
    Правки, затрагивающие менее 30% файла (при файле больше 50 строк), — только через patch. Полная перезапись в этих условиях запрещена: выходные токены должны тратиться только на диф.
    Файл от 100 строк читай только после compress. Файл от 300 строк — сначала outline, затем точечное чтение нужного диапазона через Read(offset, limit).
    Поиск по кодовой базе — только через search. Но если ищешь, ГДЕ ОПРЕДЕЛЁН символ, класс или селектор — сначала graph (op: symbol / selector): один точный ответ с файлом и номером строки вместо сниппетов использований. search — для мест ИСПОЛЬЗОВАНИЯ текста.
	Зависимости файла и его потребителей — graph (op: deps / rdeps / path). Заменяет полный обход репозитория.
	Граф строится и инкрементально обновляется скриптом автоматически при каждом вызове — это анализ, не компиляция, запуск разрешён всегда. Файл graph-deps.json целиком НЕ читай: только ответы операций.
	Селекторы компонентов в HTML-шаблонах граф не отслеживает (только TS-импортёры): вопрос «используется ли компонент» закрывай через search по *.html.
    diff — только когда правок немного: он возвращает все изменённые строки сразу. При большом количестве незакоммиченных правок ограничивайся git-check и точечным чтением нужных файлов.
    Файлы меньше 100 строк читай напрямую стандартным инструментом — вызов скрипта дороже возможной экономии.
    Компиляцию, линтер и тесты не запускай — проверки выполняет пользователь, об ошибках он сообщит сам.
    Скрипты работают только с путями внутри рабочей директории; пути вне проекта отклоняй.

## Инструменты

### Состояние репозитория

git-check — список файлов с незакоммиченными правками. Стоимость вызова не зависит от объёма правок: десяток строк вывода и при одной правке, и при пятидесяти. Первый вызов в любой задаче.

diff — сжатый git diff: статистика + только изменённые строки, без контекста. Выгоден при малом количестве правок; при большом — замени на git-check.

### Чтение

compress — срезает комментарии, пустые строки и лишние пробелы. Контекст сжимается в 2–3 раза. Для файлов от 100 строк.

search — поиск по проекту: имена файлов, номера строк и короткие сниппеты вместо файлов целиком. Экономия 50–90%.

outline — оглавление .ts файла: классы, методы, свойства с номерами строк (~10% объёма файла). Для файлов от 300 строк, дальше — точечное чтение.

schema — только интерфейсы, типы и enum без логики. Для понимания DTO и моделей. Экономия 60–80%.

api — HTTP-вызовы сервисов: URL и сигнатуры методов без реализаций.

deps — граф импортов: что импортирует файл и кто импортирует его. Заменяет греп по всему репозиторию.

### Навигация

graph — граф зависимостей с кэшем. Отвечает без чтения файлов: где определён символ (файл + строка → сразу Read с offset), кто импортирует файл (влияние правки), цепочка импортов между файлами, циклы. Первый вызов строит граф (1–3 с на 500 файлов), дальше — инкрементально. Экономия 50–90% на навигационных вопросах.

### Изменение

patch — точечная замена фрагмента кода. Выходные токены тратятся на диф, а не на весь файл. Экономия до 90% выходных токенов на правке.

generate — обёртка над Angular CLI. Шаблонный код не проходит через модель вообще.

### Выполнение команд (PowerShell)

Каждая команда самодостаточна: сначала определи $TE, затем вызови скрипт. Payload передаётся через stdin в JSON.

Варианты пути $TE:

    глобально на Windows: "$env:USERPROFILE\.kilocode\skills\token-economy\scripts"
    локально в репозитории: ".kilo\skills\token-economy\scripts"
    pwsh на Linux/macOS: "$HOME/.config/kilo/skills/token-economy/scripts"

В Windows PowerShell 5.1 при кириллице в payload добавляй в начало команды $OutputEncoding=[Text.Encoding]::UTF8; (в PowerShell 7 кодировка UTF-8 по умолчанию).

git-check:

$TE="$env:USERPROFILE\.kilocode\skills\token-economy\scripts"; node "$TE\git-safety.js"

compress:

$TE="$env:USERPROFILE\.kilocode\skills\token-economy\scripts"; '{"file":"src/app/app.component.ts"}' | node "$TE\token-compressor.js"

graph (где определён символ):
 $TE="$env:USERPROFILE\.kilocode\skills\token-economy\scripts"; '{"op":"symbol","name":"UserService"}' | node "$TE\graph-tool.js"

graph (кто импортирует файл — обязательно перед правкой):
 $TE="$env:USERPROFILE\.kilocode\skills\token-economy\scripts"; '{"op":"rdeps","file":"src/app/services/auth.service.ts","depth":2}' | node "$TE\graph-tool.js"

graph (что импортирует файл):
 $TE="$env:USERPROFILE\.kilocode\skills\token-economy\scripts"; '{"op":"deps","file":"src/app/core/auth.service.ts"}' | node "$TE\graph-tool.js"

graph (селектор → файл / цепочка связей):
 $TE="$env:USERPROFILE\.kilocode\skills\token-economy\scripts"; '{"op":"selector","selector":"app-profile"}' | node "$TE\graph-tool.js"
 $TE="$env:USERPROFILE\.kilocode\skills\token-economy\scripts"; '{"op":"path","from":"src/app/app.component.ts","to":"src/app/models/user.ts"}' | node "$TE\graph-tool.js"

search:

$TE="$env:USERPROFILE\.kilocode\skills\token-economy\scripts"; '{"query":"ИскомыйТекст","ext":".ts"}' | node "$TE\code-searcher.js"

outline:

$TE="$env:USERPROFILE\.kilocode\skills\token-economy\scripts"; '{"file":"src/app/modules/ais/appeals/appeal-subservices.service.ts"}' | node "$TE\symbol-index.js"

schema:

$TE="$env:USERPROFILE\.kilocode\skills\token-economy\scripts"; '{"file":"src/app/models/user.ts"}' | node "$TE\schema-summarizer.js"

api:

$TE="$env:USERPROFILE\.kilocode\skills\token-economy\scripts"; '{"file":"src/app/modules/ais/appeals/appeal-subservices.service.ts"}' | node "$TE\endpoint-extract.js"

deps:

$TE="$env:USERPROFILE\.kilocode\skills\token-economy\scripts"; '{"file":"src/app/modules/ais/appeals/appeal-subservices.service.ts"}' | node "$TE\import-graph.js"

diff:

$TE="$env:USERPROFILE\.kilocode\skills\token-economy\scripts"; node "$TE\diff-summary.js"

patch (многострочный код — here-строка; переводы строк внутри JSON-строк экранируй как \n):

$TE = "$env:USERPROFILE\.kilocode\skills\token-economy\scripts"@'{  "file": "src/app/services/auth.service.ts",  "oldChunk": "getCurrentUser() {\n  return this.http.get('/user');\n}",  "newChunk": "getCurrentUser() {\n  return this.http.get('/user', { headers: this.authHeaders });\n}"}'@ | node "$TE\chunk-patcher.js"

generate:

$TE="$env:USERPROFILE\.kilocode\skills\token-economy\scripts"; '{"type":"component","name":"components/profile"}' | node "$TE\scaffold-helper.js"
