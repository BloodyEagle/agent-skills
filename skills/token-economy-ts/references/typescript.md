# Правила стека: TypeScript / JavaScript (token-economy-ts)

## Код

- В TypeScript — строгая типизация: без `any`, явные типы возврата. В JavaScript не добавляй TS-аннотации; ранние возвраты вместо вложенных условий.
- Переменные, функции, методы, свойства — camelCase. Классы, интерфейсы, enum и типы — PascalCase. Файлы — kebab-case.
- JSDoc пиши только для публичного API (классы, методы, интерфейсы): краткое описание + `@param`/`@returns`. Примеры использования — только по моему запросу.

## Навигация и чтение

- Перед первой командой прочитай `references/typescript.md`, затем один раз вызови `graph op=info` в корне текущего проекта. После определения типа прочитай `references/angular.md` при `projectType=angular` или `references/react.md` при `projectType=react`. Перед `selector`/`generate` прочитай Angular-профиль, перед `component` — React-профиль независимо от projectType: эти команды имеют отдельные гейты.
- Где определён Angular-селектор компонента или директивы — `graph` (op: `selector`).
- Где определён пайп по имени, `$переменная`, миксин или другой стилевой символ — `graph` (op: `symbol`).
- `search` для html и стилей вызывай с `ext` (`.html`, `.scss`, `.less`, `.css`).
- Размер исходного файла (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`) заранее — `graph` (op: `node`, поле `loc`). Файл от 300 строк не читай целиком: сначала outline, затем Read(offset, limit).
- В JS-проектах React/Node.js/Express/Vue используй тот же скилл; `require` и `module.exports` поддерживаются графом. `selector`, `generate` и `scaffold` без Angular неприменимы.
- Использования с учётом тестов — `graph` со specs=true.

## Правки

- Тело метода или функции заменяй через `edit_symbol`, не переписывая файл целиком.
