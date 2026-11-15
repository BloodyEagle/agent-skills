// refs.js — единая грамматика refs для `graph op=read ref=...` (этап W3 плана 20+21 v3).
// Грамматика согласована с MegaMemory src/refs.ts (classifyRef/parseRef): распознанные
// виды совпадают на обеих сторонах моста. Распознанный вид ≠ поддержанный способ чтения:
// git-виды здесь распознаются, чтобы отказать явно (unsupported_ref_kind), а не интерпретировать
// их как локальный путь. Без сети, без запуска git, без подмены working tree.
//
// Поддерживаемые read-виды (файлы рабочей директории):
//   path          — весь файл (только для малого файла: <300 строк и в байтовом лимите)
//   path:N        — одна строка
//   path:N-M      — включительный 1-based диапазон
//   path#LN       — legacy-локатор GitHub-стиля, тот же результат, что path:N
//   path#LN-LM    — legacy-локатор, тот же результат, что path:N-M
// Распознаваемые, но не поддержанные read-виды:
//   git:tag:<name> / git:commit:<sha> / git:branch:<name> — git_ref
//   HEAD:<path> / <6..40-hex>:<path>                      — git_blob

// <rev>:<path> — git blob; путь с буквой диска (C:\…) не совпадает: префикс до ':'
// обязан быть HEAD или 6..40 hex-символами. Контракт MegaMemory src/refs.ts (GIT_REF_RE).
const GIT_REF_RE = /^(HEAD|[0-9a-fA-F]{6,40}):(.+)$/;

// git:tag:<name> / git:commit:<sha> / git:branch:<name>. Имя без пробелов и управляющих
// символов, без "..", не начинается с "-" или "." (безопасность аргумента git на стороне
// MegaMemory; здесь то же распознавание, чтобы грамматика была единой).
const GIT_SCHEME_RE = /^git:(tag|commit|branch):([^\s~^:?*\[\\]+)$/;

// Хвост-локатор «:12» / «:12-30»: только цифры и один дефис.
const LINE_RANGE_RE = /^\d+(?:-\d+)?$/;
// Хвост-локатор «#L12» / «#L12-L30» (GitHub-стиль).
const L_LOCATOR_RE = /^L(\d+)(?:-L(\d+))?$/;

/** Виды, которые `graph op=read` умеет читать (файлы рабочей директории). */
const SUPPORTED_READ_KINDS = ['path', 'path:N', 'path:N-M', 'path#LN', 'path#LN-LM'];

/**
 * Отрезать конечный файловый локатор. Сначала «:N(-M)» (последнее двоеточие),
 * затем «#L12(-L30)» (последняя решётка). Индексы 0/1 не режутся: «C:\…» —
 * буква диска, «\\srv\share» — UNC; «#L12» целиком — имя файла, а не ссылка с
 * локатором. Хвост, не похожий на локатор («a:b.ts», «src/db.ts:abc»), оставляет
 * строку как есть — двоеточие/решётка могут быть частью имени.
 */
function splitFileLocator(ref) {
    const colon = ref.lastIndexOf(':');
    if (colon > 1) {
        const tail = ref.slice(colon + 1);
        if (LINE_RANGE_RE.test(tail)) {
            return {path: ref.slice(0, colon), locator: tail};
        }
    }
    const hash = ref.lastIndexOf('#');
    if (hash > 0) {
        const m = ref.slice(hash + 1).match(L_LOCATOR_RE);
        if (m) {
            return {path: ref.slice(0, hash), locator: m[2] ? m[1] + '-' + m[2] : m[1]};
        }
    }
    return {path: ref, locator: null};
}

/**
 * Разобрать сырой ref в вид + координаты. Возвращает:
 *   {kind: 'file', path, start?, end?, locator?}  — локатор снят, координаты 1-based
 *     (end < start или 0-е строки — семантическая ошибка диапазона, её проверяет чтение);
 *   {kind: 'git_ref', scheme, name}               — git-схема распознана;
 *   {kind: 'git_blob', rev, path}                 — blob-форма распознана.
 * Порядок проверок — как в MegaMemory parseRef: git-формы первыми, «git:tag:2026»
 * не превращается в путь «git:tag» с локатором «2026».
 */
function parseRefLocator(raw) {
    const ref = String(raw);
    const scheme = ref.match(GIT_SCHEME_RE);
    if (scheme) {
        const name = scheme[2];
        // Имя не может начинаться с "-", "." и не содержит ".." — иначе это не git-ref.
        if (!name.startsWith('-') && !name.startsWith('.') && !name.includes('..')) {
            return {kind: 'git_ref', scheme: scheme[1], name};
        }
        // невалидное имя git-ref — по грамматике MegaMemory classifyRef это file
    }
    const blob = ref.match(GIT_REF_RE);
    if (blob) return {kind: 'git_blob', rev: blob[1], path: blob[2]};
    const {path, locator} = splitFileLocator(ref);
    if (locator === null) return {kind: 'file', path};
    const m = locator.match(/^(\d+)(?:-(\d+))?$/);
    const start = Number(m[1]);
    return {kind: 'file', path, start, end: m[2] === undefined ? start : Number(m[2]), locator};
}

module.exports = {parseRefLocator, splitFileLocator, SUPPORTED_READ_KINDS};
