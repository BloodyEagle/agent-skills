# Правила для React-проектов (projectType=react)

Этот файл читается ТОЛЬКО когда `graph op=info` вернул `projectType: react` (react >= 16; при react < 16 скилл этот файл не подключает). Универсальные правила — в SKILL.md; здесь — React-дополнения к ним, применяются вместе с универсальными.

## Дополнительные правила

1. Место ОПРЕДЕЛЕНИЯ компонента или хука — `graph` (op: `symbol`): файл, строка и диапазон объявления (`startLine`/`endLine` → точечное чтение) вместо сниппетов использований. Компонент виден как функция или класс, отдельного `kind=component` нет; метод класс-компонента уточняй владельцем (`in=`).
2. Вопрос «где компонент использован в JSX» — `graph` (op: `component`): `definedIn` (файл + строки определения), `usedIn` (файл + строка каждого открывающего тега `<Имя`, сортировка по файлу и строке), `usedTotal`. Ничего не найдено — `found:false`, код 0. Команда требует react >= 16: без него — «React не найден в проекте: команда неприменима» и код 1. Ограничения: имя точное, без fuzzy (в отличие от `symbol`); считаются только открывающие теги — закрывающие `</Имя`, member-теги `<Foo.Bar`, строчные DOM-теги и `<T,`-дженерики не индексируются; вхождения в строках и комментариях не считаются; использования в собственном файле компонента входят в `usedIn`.
3. Перед правкой общего хука, контекста или утилиты — `rdeps`, как и в универсальных правилах: покажет файлы, которые их импортируют.
4. Стили подключаются импортами и уже в графе: `import './App.css'` (side-effect) и `import styles from './X.module.css'` дают рёбра ts → style; они видны в `deps` импортирующего файла и в `rdeps` стиля. CSS-классы внутри стилей граф не связывает — поиск через `search`.
5. Новый компонент или хук — штатным редактированием файлов (замена тела существующего — `edit_symbol`); generate из Angular в React-проекте неприменим.
6. projectType=react устанавливается только при react >= 16 в `package.json` (нераспознанная версия — по присутствию пакета, с предупреждением в `info`); при react 15 и ниже действуют универсальные правила без этого файла.

Использования компонента в JSX (файл + строка каждого `<UserCard`, `usedTotal`):

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\graph-tool.js" op=component name=UserCard

Определение компонента и хука; метод класс-компонента — с владельцем (`in=`):

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\graph-tool.js" op=symbol name=UserCard
    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\graph-tool.js" op=symbol name=useFetch
    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\graph-tool.js" op=symbol name=handleClick in=UserCard

## Граф: связи React-файлов

К универсальным связям (импорты ts/js, `@use`/`@import` в стилях) в React-проекте:

| Тип | Расширения | Что связывается |
|---|---|---|
| ts/js | `.ts`, `.tsx`, `.js`, `.jsx` (без `.spec`/`.test` и `.d.ts`) | `import` / `export … from` / `import()` / `require()`; алиасы из tsconfig `paths`; импорты компонентов, хуков и контекстов |
| style | `.css`, `.scss`, `.sass`, `.less` | импорты из ts/tsx/js/jsx — `import './App.css'` (side-effect) и `import styles from './X.module.css'` как рёбра ts → style; `@use`, `@forward`, `@import` между стилями |

Bare-импорты пакетов (`react`, `react-dom/client`, `next`, `styled-components` и другие) попадают в `external` и узлов не создают.

Направление ребра — «A зависит от B»: `deps` файла — его импорты (компоненты, хуки, контексты, стили); `rdeps` компонента, хука или стиля — файлы, которые его импортируют.

Что граф не видит: JSX-применение компонента не создаёт отдельного ребра (ребро уже есть из импорта) — где именно применён компонент, отвечает `op=component`; рендер по имени из реестра или фабрики (компонент из словаря или переменной, `<C />`) граф не видит — `search`.

## sig для React-пакетов

Типы React живут в `@types/react` и `@types/react-dom`: сами пакеты `react`/`react-dom` деклараций не содержат, `sig` по имени `react` не отвечает. Формы работают при установленных `@types/react` / `@types/react-dom` (стандартно ставятся вместе с react в TS-проектах; чтение из node_modules, без сети):

    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\sig-reader.js" name=@types/react#useState
    node "$env:USERPROFILE\.kilocode\skills\token-economy-ts\scripts\sig-reader.js" name=@types/react-dom/client#createRoot
