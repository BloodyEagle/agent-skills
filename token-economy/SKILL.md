---
name: token-economy
description: Легковесный набор из 9 скриптов для сжатия, поиска, точечного патчинга и генерации кода. Каждый вызов гарантированно окупается экономией токенов, без оверхеда на коротких задачах. Все команды — PowerShell.
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
        "description": "git-check | compress | search | outline | schema | api | deps | diff | patch | generate"
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
    Поиск по кодовой базе — только через search. Перебор файлов с полным чтением запрещён.
    Структура данных → schema. HTTP-вызовы сервиса → api. Зависимости файла → deps.
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
