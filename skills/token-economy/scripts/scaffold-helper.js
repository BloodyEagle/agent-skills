// scaffold-helper.js — обёртка над локальным Angular CLI (`ng generate`).
// Шаблонный код создаётся CLI на диске и не проходит через модель.
const fs = require('fs');
const path = require('path');
const {execSync} = require('child_process');

let args = {};
try {
    args = JSON.parse(fs.readFileSync(0, 'utf-8').trim() || '{}');
} catch (e) {
    args = {type: process.env.GEN_TYPE, name: process.env.GEN_NAME};
}

const ALLOWED_TYPES = ['component', 'service', 'pipe', 'directive', 'guard', 'module', 'interface', 'enum', 'class', 'resolver', 'interceptor'];
// Схематики с опцией --skip-tests: они по умолчанию создают spec-файлы.
// У module / interface / enum флага нет — спеки они не генерируют,
// а CLI падает с "Unknown option" на незнакомом флаге.
const SKIP_TESTS_TYPES = new Set(['component', 'service', 'pipe', 'directive', 'guard', 'class', 'resolver', 'interceptor']);
const type = args.type; // component, service, pipe, directive, guard, ...
const name = args.name; // например "components/profile"

const out = (obj) => console.log(JSON.stringify(obj));

if (!type || !name) {
    out({success: false, error: "Необходимы параметры 'type' и 'name'"});
    process.exit(1);
}
// Значения попадают в командную строку — пропускаем только безопасные символы
if (!ALLOWED_TYPES.includes(type)) {
    out({success: false, error: "Недопустимый type. Разрешены: " + ALLOWED_TYPES.join(', ')});
    process.exit(1);
}
// Ведущий '/' превращает name в абсолютный путь — отклоняем
if (!/^[A-Za-z0-9_\-./@]+$/.test(name) || name.includes('..') || name.startsWith('/')) {
    out({success: false, error: "Недопустимое name: разрешены буквы, цифры, _ - . / @, без '..' и ведущего '/'"});
    process.exit(1);
}

// Локальный бинарник вместо `npx`: npx может полезть в сеть за пакетом и зависнуть за прокси
const bin = path.join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'ng.cmd' : 'ng');
if (!fs.existsSync(bin)) {
    out({success: false, error: "Локальный Angular CLI не найден (node_modules/.bin/ng). Выполните npm install."});
    process.exit(1);
}

// CLI валидирует опции ДО генерации: при "Unknown option" файлы не создаются,
// поэтому повтор без флага безопасен.
function generate(extra) {
    return execSync(`"${bin}" generate ${type} ${name}${extra}`, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
}

const skipFlag = SKIP_TESTS_TYPES.has(type) ? ' --skip-tests=true' : '';

try {
    let output;
    try {
        output = generate(skipFlag);
    } catch (e) {
        // Защита от расхождений версий CLI: если схематик не знает флага —
        // генерируем без него (со spec-файлом) вместо падения.
        const txt = ((e.stderr || '') + (e.stdout || ''));
        if (skipFlag && /unknown option[\s\S]*skip-tests/i.test(txt)) output = generate('');
        else throw e;
    }
    const lines = output.trim().split('\n').map((l) => l.trim()).filter(Boolean);
    const changed = lines.filter((l) => /^(CREATE|UPDATE)\b/.test(l));
    out({success: true, files: changed.length ? changed : lines.slice(-5)});
} catch (error) {
    const text = ((error.stdout || '') + (error.stderr || '')).trim() || error.message || 'Неизвестная ошибка Angular CLI';
    out({success: false, error: text.split('\n').slice(-10).join('\n')});
}
