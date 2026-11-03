# Angular — token-economy-ts

- Angular не ниже версии 15.
- Именование — как создаёт Angular CLI (см. Typescript.md); файлы — kebab-case по соглашению CLI.

## Навигация и чтение

- Вопрос «используется ли компонент / директива / пайп» — `graph` (op: `selector`, затем при необходимости `rdeps`).
- Перед правкой сервиса, пайпа, общего миксина или переменной стилей вызови `graph` (op: `rdeps`) — узнай, что заденет правка.

## Правки

- Сущности Angular (компоненты, сервисы, пайпы, модули, директивы, гварды) создавай только через `generate`, заготовки руками не пиши: component, service, pipe, directive, guard, module, interface, enum, class, resolver, interceptor — только generate.
