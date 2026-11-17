// git-signals.js — сбор git-сигналов по файлам (churn, багфиксы, авторы) и кэш .git-signals.json.
// Источник идеи: defendend/Claude-ast-index-search, src/commands/git_signals.rs (агрегация
// git log --numstat и процентили); оттуда не берутся окна rev-list, параллельные git-процессы
// и SQLite-хранилище. План: git-hotspots (F1–F3) в tasks/obs.
//
// Модуль самодостаточный (только node core): вызывающий (graph-tool.js / kt.js / jv.js / bx.js)
// передаёт args и опциональные hooks. Только чтение git-истории; граф и его кэши не трогаются.
// Переименования не отслеживаются (--no-renames: rename приходит как удаление + добавление).

const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');

const CACHE_FILE = '.git-signals.json';
const CACHE_VERSION = 1;
// Чтение файла ради «churn/стр»: крупнее 5 МБ размер не определяется (null, без чтения).
const SIZE_READ_CAP = 5 * 1024 * 1024;
// Относительный churn (churn/стр) имеет смысл только для файлов от 50 строк.
const MIN_LINES_FOR_RATIO = 50;
// Формула из плана. Замечание: \b в JS — ASCII-граница слова, поэтому ветки «исправ|баг»
// на чисто кириллических subject не срабатывают (кириллица не входит в \w); фикс формулы —
// отдельное решение владельца, здесь она воспроизводится как написана.
const BUGFIX_RE = /\b(fix|fixes|bug|hotfix|hotfixes|исправ|баг)\b/i;

class SigError extends Error {}

/**
 * Каталог git-репозитория для root: {dir, commonDir} или null, если root не репозиторий.
 * Файловая проверка, без запуска git: обычный репозиторий, worktree и submodule
 * (у них .git — файл с «gitdir: …») разбираются одинаково.
 */
function gitDirOf(root) {
    const dot = path.join(root, '.git');
    let st;
    try {
        st = fs.statSync(dot);
    } catch (e) {
        return null;
    }
    if (st.isDirectory()) return {dir: dot, commonDir: dot};
    try {
        const m = fs.readFileSync(dot, 'utf8').match(/^gitdir:\s*(.+)\s*$/m);
        if (!m) return null;
        const p = m[1].trim();
        const dir = path.normalize(path.isAbsolute(p) ? p : path.join(root, p));
        let commonDir = dir;
        try {
            const cd = fs.readFileSync(path.join(dir, 'commondir'), 'utf8').trim();
            if (cd) commonDir = path.normalize(path.isAbsolute(cd) ? cd : path.join(dir, cd));
        } catch (e) {
            // commondir есть только у worktree — обычный репозиторий оставляем как есть
        }
        return {dir, commonDir};
    } catch (e) {
        return null;
    }
}

/**
 * SHA текущего HEAD, читается файлами (без запуска git): .git/HEAD → loose-файл ветки →
 * packed-refs. Detached HEAD — содержимое и есть sha. Работает для worktree (commondir).
 */
function readHeadSha(root) {
    const g = gitDirOf(root);
    if (!g) return null;
    let head;
    try {
        head = fs.readFileSync(path.join(g.dir, 'HEAD'), 'utf8').trim();
    } catch (e) {
        return null;
    }
    const m = head.match(/^ref:\s*(.+)$/);
    if (!m) return /^[0-9a-f]{40}$/.test(head) || /^[0-9a-f]{64}$/.test(head) ? head : null;
    const ref = m[1].trim();
    const segments = ref.split('/');
    // loose-файл: сначала каталог конкретного worktree, затем общий каталог репозитория
    for (const base of [g.dir, g.commonDir]) {
        try {
            const v = fs.readFileSync(path.join.apply(path, [base].concat(segments)), 'utf8').trim();
            if (v) return v;
        } catch (e) {
            // нет loose-файла в этом каталоге
        }
    }
    // упакованная ветка: packed-refs (commonDir, затем dir — порядок не важен, ссылка одна)
    for (const base of [g.commonDir, g.dir]) {
        try {
            const packed = fs.readFileSync(path.join(base, 'packed-refs'), 'utf8');
            for (const line of packed.split('\n')) {
                const t = line.trim();
                if (!t || t.startsWith('#') || t.startsWith('^')) continue;
                const sp = t.indexOf(' ');
                if (sp !== -1 && t.slice(sp + 1) === ref) return t.slice(0, sp);
            }
        } catch (e) {
            // packed-refs нет
        }
    }
    return null;
}

/** Fallback: git rev-parse HEAD — только когда файловая раскладка не разобрана (см. план). */
function revParseHead(root) {
    const r = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], {maxBuffer: 1024 * 1024});
    if (r.error && r.error.code === 'ENOENT') throw new SigError('git не найден в PATH');
    if (r.status !== 0) return null;
    return String(r.stdout || '').trim() || null;
}

/** shallow-клон: файл .git/shallow — то, что git rev-parse --is-shallow-repository проверяет сам. */
function isShallow(root) {
    const g = gitDirOf(root);
    if (!g) return false;
    for (const base of [g.dir, g.commonDir]) {
        try {
            if (fs.statSync(path.join(base, 'shallow')).isFile()) return true;
        } catch (e) {
            // файла нет — не shallow в этом каталоге
        }
    }
    return false;
}

/**
 * Аргумент since: '<N>d' (число дней от сегодня) или дата YYYY-MM-DD. По умолчанию 180 дней.
 * Возвращается календарная дата — дневная гранулярность делает ключ кэша стабильным в течение суток.
 */
function resolveSince(raw) {
    const s = raw === undefined || raw === null || raw === '' ? '180d' : String(raw);
    const m = s.match(/^(\d+)d$/);
    if (m) {
        const days = parseInt(m[1], 10);
        if (days < 1) throw new SigError('since — число дней ≥ 1 или дата YYYY-MM-DD, получено: ' + s);
        return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    throw new SigError('since — число дней (<N>d) или дата YYYY-MM-DD, получено: ' + s);
}

function intArg(raw, def, name) {
    if (raw === undefined || raw === null || raw === '') return def;
    const n = parseInt(raw, 10);
    if (String(n) !== String(raw) || n < 1) throw new SigError(name + ' — целое ≥ 1, получено: ' + raw);
    return n;
}

/** Путь к posix-виду (git отдаёт пути через '/'), без ведущего './' и хвостовых слешей. */
function normRel(p) {
    let s = String(p).replace(/\\/g, '/');
    while (s.startsWith('./')) s = s.slice(2);
    return s.replace(/\/+$/, '');
}

function pluralRu(n, forms) { // [«1», «2–4», «5+»]
    const mod100 = n % 100;
    const mod10 = n % 10;
    if (mod100 >= 11 && mod100 <= 14) return forms[2];
    if (mod10 === 1) return forms[0];
    if (mod10 >= 2 && mod10 <= 4) return forms[1];
    return forms[2];
}

/**
 * Один проход git log --numstat: на каждый файл — commits, churn (+/− строки), authors,
 * bugfix (subject по BUGFIX_RE), binary (numstat дал «-»), last (дата последнего касания).
 * pathspec — дополнительные аргументы git после «--» (например, исключения Битрикса).
 */
function collectGitSignals(root, opts) {
    const args = ['-C', root, 'log', '--no-merges', '--no-renames', '--numstat', '--date=short',
        '--format=%x01%H%x09%an%x09%ad%x09%s', '--since=' + opts.since, '-n', String(opts.maxCommits)];
    if (opts.pathspec && opts.pathspec.length) args.push.apply(args, ['--'].concat(opts.pathspec));
    const r = spawnSync('git', args, {maxBuffer: 256 * 1024 * 1024});
    if (r.error && r.error.code === 'ENOENT') throw new SigError('git не найден в PATH');
    const out = String(r.stdout || '');
    const err = String(r.stderr || '');
    // unborn-ветка (репозиторий без коммитов) — git log ошибается, это пустая история, а не сбой
    if (r.status !== 0 && !/does not have any commits yet/i.test(err)) {
        throw new SigError('git log завершился с ошибкой: ' + (err.trim().split('\n')[0] || ('код ' + r.status)));
    }
    const files = new Map();
    let cur = null;
    let commitsTotal = 0;
    for (const raw of out.split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (line.startsWith('\x01')) {
            const f = line.slice(1).split('\t');
            cur = {an: f[1], ad: f[2], s: f.slice(3).join('\t')};
            commitsTotal++;
            continue;
        }
        if (!cur || !line.trim()) continue;
        const parts = line.split('\t');
        if (parts.length < 3) continue;
        const p = parts.slice(2).join('\t');
        const binary = parts[0] === '-' && parts[1] === '-';
        let e = files.get(p);
        if (!e) {
            e = {commits: 0, churn: 0, authors: new Set(), bugfix: 0, binary: false, last: ''};
            files.set(p, e);
        }
        e.commits++;
        if (binary) e.binary = true;
        else e.churn += parseInt(parts[0], 10) + parseInt(parts[1], 10);
        e.authors.add(cur.an);
        if (BUGFIX_RE.test(cur.s)) e.bugfix++;
        if (cur.ad > e.last) e.last = cur.ad;
    }
    const serialized = {};
    for (const [p, e] of files) {
        serialized[p] = {commits: e.commits, churn: e.churn, authors: e.authors.size,
            bugfix: e.bugfix, binary: e.binary, last: e.last};
    }
    return {
        version: CACHE_VERSION,
        head: opts.head,
        since: opts.since,
        maxCommits: opts.maxCommits,
        pathspec: opts.pathspec || [],
        shallow: isShallow(root),
        ceiling: commitsTotal === opts.maxCommits,
        collectedAt: new Date().toISOString(),
        commitsTotal,
        files: serialized,
    };
}

/**
 * Сбор с кэшем: валидный .git-signals.json (head + since + maxCommits + pathspec + версия)
 * отдаётся без запуска git вообще; иначе один проход git log и запись кэша (best-effort).
 */
function loadSignals(root, opts) {
    if (!gitDirOf(root)) throw new SigError('не git-репозиторий (' + root + ')');
    let head = readHeadSha(root);
    if (!head) head = revParseHead(root); // фолбэк, когда файловая раскладка не разобрана
    if (!head) {
        // unborn-ветка: коммитов ещё нет, HEAD ссылается на несуществующий ref — это
        // «пустая история» (exit 0), а не сбой; в ключ кэша идёт пометка с именем ref.
        const g = gitDirOf(root);
        let hf = '';
        try {
            hf = fs.readFileSync(path.join(g.dir, 'HEAD'), 'utf8').trim();
        } catch (e) {
            // HEAD не читается выше readHeadSha — сюда почти не доходим
        }
        const m = hf.match(/^ref:\s*(.+)$/);
        if (!m) throw new SigError('HEAD не определён: ни файлы .git, ни git rev-parse не помогли');
        head = 'unborn:' + m[1].trim();
    }
    const cachePath = path.join(root, CACHE_FILE);
    let cache = null;
    try {
        cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch (e) {
        cache = null; // нет кэша или повреждён — пересбор
    }
    const valid = cache && cache.version === CACHE_VERSION && cache.head === head
        && cache.since === opts.since && cache.maxCommits === opts.maxCommits
        && JSON.stringify(cache.pathspec || []) === JSON.stringify(opts.pathspec || [])
        && cache.files && typeof cache.files === 'object' && Number.isFinite(cache.commitsTotal);
    if (valid) return {data: cache, fromCache: true};
    const data = collectGitSignals(root, {since: opts.since, maxCommits: opts.maxCommits, pathspec: opts.pathspec, head});
    try {
        fs.writeFileSync(cachePath, JSON.stringify(data));
    } catch (e) {
        process.stderr.write('Предупреждение: кэш не записан (' + e.message + ')\n');
    }
    return {data, fromCache: false};
}

/**
 * Процентильные метки p50/p90/p97 по commits, churn, bugfix — внутри репозитория, не абсолютные
 * числа. Метка файла по метрике — старшая граница, которой значение достигло (0 не получает
 * метку); topLabel — старшая метка файла по всем трём метрикам.
 */
function percentileRanks(data) {
    const paths = Object.keys(data.files);
    const metrics = ['commits', 'churn', 'bugfix'];
    const priority = {p97: 3, p90: 2, p50: 1};
    const bounds = {};
    for (const m of metrics) {
        const vals = paths.map((p) => data.files[p][m]).sort((a, b) => a - b);
        bounds[m] = {};
        for (const q of [50, 90, 97]) {
            const idx = Math.ceil((q / 100) * vals.length) - 1; // ближайший ранг
            bounds[m]['p' + q] = vals.length ? vals[Math.max(0, Math.min(idx, vals.length - 1))] : 0;
        }
    }
    const labels = {};
    const topLabel = {};
    for (const p of paths) {
        labels[p] = {};
        let best = null;
        for (const m of metrics) {
            const v = data.files[p][m];
            const l = v > 0 ? (v >= bounds[m].p97 ? 'p97' : v >= bounds[m].p90 ? 'p90' : v >= bounds[m].p50 ? 'p50' : null) : null;
            labels[p][m] = l;
            if (l && (!best || priority[l] > priority[best])) best = l;
        }
        topLabel[p] = best;
    }
    return {labels, topLabel};
}

/** Доля багфиксов в коммитах файла, % (округление до целого); без коммитов — 0. */
function bugfixRatio(entry) {
    return entry.commits ? Math.round((100 * entry.bugfix) / entry.commits) : 0;
}

/** Текущее число строк файла (чтение с потолком 5 МБ; крупнее или файл удалён — null). */
function fileLines(root, rel) {
    const abs = path.join(root, rel);
    let st;
    try {
        st = fs.statSync(abs);
    } catch (e) {
        return null;
    }
    if (st.size > SIZE_READ_CAP) return null;
    let s;
    try {
        s = fs.readFileSync(abs, 'utf8');
    } catch (e) {
        return null;
    }
    if (!s) return 0;
    const n = s.split('\n').length;
    return s.endsWith('\n') ? n - 1 : n;
}

/**
 * Размер для «churn/стр»: если в графе скилла есть loc, вызывающий передаёт hooks.sizes
 * (Map или объект путь → строки); иначе чтение файла. Источник размера назван в SKILL.md.
 */
function sizeLinesOf(root, rel, hooks) {
    if (hooks && hooks.sizes) {
        const s = hooks.sizes;
        const v = typeof s.get === 'function' ? s.get(rel) : s[rel];
        if (v !== undefined && v !== null) return v;
    }
    return fileLines(root, rel);
}

/** churn/стр: null для бинарников, файлов < 50 строк и файлов, чей размер не определён. */
function perLine(root, entry, rel, hooks) {
    if (entry.binary) return null;
    const lines = sizeLinesOf(root, rel, hooks);
    if (lines === null || lines < MIN_LINES_FOR_RATIO) return null;
    return entry.churn / lines;
}

function cellsFor(root, entry, rel, hooks, labels) {
    const per = perLine(root, entry, rel, hooks);
    return {
        commits: 'коммитов ' + entry.commits + (labels && labels.commits ? ' (' + labels.commits + ')' : ''),
        churn: 'churn ' + entry.churn + (labels && labels.churn ? ' (' + labels.churn + ')' : ''),
        authors: 'авторов ' + entry.authors,
        bugfix: 'багфиксов ' + entry.bugfix + ' (' + bugfixRatio(entry) + '%' + (labels && labels.bugfix ? ', ' + labels.bugfix : '') + ')',
        per: per !== null ? 'churn/стр ' + per.toFixed(2) : null,
        last: 'последний ' + (entry.last || '—'),
    };
}

/**
 * Таблица top (сортировка по churn, при равенстве — по коммитам, затем по пути).
 * Возвращается тело отчёта без строк-предупреждений (shallow/потолок добавляет runHotspots).
 */
function formatTop(data, ranks, root, hooks, topN) {
    const files = Object.keys(data.files);
    const header = 'git-сигналы: ' + data.commitsTotal + ' ' + pluralRu(data.commitsTotal, ['коммит', 'коммита', 'коммитов'])
        + ', ' + files.length + ' ' + pluralRu(files.length, ['файл', 'файла', 'файлов']) + ', since ' + data.since;
    files.sort((a, b) => data.files[b].churn - data.files[a].churn
        || data.files[b].commits - data.files[a].commits
        || (a < b ? -1 : a > b ? 1 : 0));
    const shown = files.slice(0, Math.max(1, topN));
    const width = Math.min(Math.max.apply(null, shown.map((p) => p.length).concat([0])), 48);
    const lines = [header];
    shown.forEach((p, i) => {
        // в таблице top пер-меточные метки не показываются — только хвостовая pNN (формат плана)
        const c = cellsFor(root, data.files[p], p, hooks, null);
        const cells = [c.commits, c.churn, c.authors, c.bugfix, c.per, ranks.topLabel[p]].filter(Boolean);
        lines.push((i + 1) + '. ' + p.padEnd(width) + '  ' + cells.join('  '));
    });
    return lines.join('\n');
}

/** Одна строка по file=: метрики с персональными процентильными метками и датой последнего касания. */
function formatFile(data, ranks, rel, root, hooks) {
    const entry = data.files[rel];
    if (!entry) return null;
    const c = cellsFor(root, entry, rel, hooks, ranks.labels[rel]);
    const cells = [c.commits, c.churn, c.authors, c.bugfix, c.per, c.last].filter(Boolean);
    return rel + '  ' + cells.join('  ');
}

/** Точка вызова у скиллов: args = {top, file, since, max_commits}; возвращает {text, exit}. */
function runHotspots(root, args, hooks) {
    hooks = hooks || {};
    try {
        const top = intArg(args.top, 15, 'top');
        const maxCommits = intArg(args.max_commits, 2000, 'max_commits');
        const since = resolveSince(args.since);
        const {data} = loadSignals(root, {since, maxCommits, pathspec: hooks.pathspec || []});
        const ranks = percentileRanks(data);
        const warn = [];
        if (data.shallow) warn.push('ВНИМАНИЕ: shallow-клон, история неполная');
        if (data.ceiling) warn.push('просмотрено ' + data.maxCommits + ' коммитов (потолок), история могла быть обрезана');
        if (!data.commitsTotal) return {text: warn.concat(['коммитов за период нет']).join('\n'), exit: 0};
        if (args.file) {
            const rel = normRel(args.file);
            const line = formatFile(data, ranks, rel, root, hooks);
            if (!line) return {text: warn.concat(['нет данных: ' + rel + ' не менялся за период (since ' + since + ')']).join('\n'), exit: 0};
            return {text: warn.concat([line]).join('\n'), exit: 0};
        }
        return {text: warn.concat([formatTop(data, ranks, root, hooks, top)]).join('\n'), exit: 0};
    } catch (e) {
        return {text: 'Ошибка: ' + (e && e.message ? e.message : String(e)), exit: 1};
    }
}

module.exports = {
    BUGFIX_RE,
    CACHE_FILE,
    CACHE_VERSION,
    SigError,
    bugfixRatio,
    collectGitSignals,
    fileLines,
    formatFile,
    formatTop,
    gitDirOf,
    isShallow,
    loadSignals,
    normRel,
    percentileRanks,
    perLine,
    pluralRu,
    readHeadSha,
    resolveSince,
    revParseHead,
    runHotspots,
    sizeLinesOf,
};
