// scaffold-helper.js — обёртка над локальным Angular CLI (`ng generate`).
// Шаблонный код создаётся CLI на диске и не проходит через модель.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let args = {};
try { args = JSON.parse(fs.readFileSync(0, 'utf-8').trim() || '{}'); } catch (e) {
  args = { type: process.env.GEN_TYPE, name: process.env.GEN_NAME };
}

const ALLOWED_TYPES = ['component', 'service', 'pipe', 'directive', 'guard', 'module', 'interface', 'enum', 'class', 'resolver', 'interceptor'];
const type = args.type; // component, service, pipe, directive, guard, ...
const name = args.name; // например "components/profile"

const out = (obj) => console.log(JSON.stringify(obj));

if (!type || !name) {
  out({ success: false, error: "Необходимы параметры 'type' и 'name'" });
  process.exit(1);
}
// Значения попадают в командную строку — пропускаем только безопасные символы
if (!ALLOWED_TYPES.includes(type)) {
  out({ success: false, error: "Недопустимый type. Разрешены: " + ALLOWED_TYPES.join(', ') });
  process.exit(1);
}
if (!/^[A-Za-z0-9_\-./@]+$/.test(name) || name.includes('..')) {
  out({ success: false, error: "Недопустимое name: разрешены буквы, цифры, _ - . / @, без '..'" });
  process.exit(1);
}

// Локальный бинарник вместо `npx`: npx может полезть в сеть за пакетом и зависнуть за прокси
const bin = path.join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'ng.cmd' : 'ng');
if (!fs.existsSync(bin)) {
  out({ success: false, error: "Локальный Angular CLI не найден (node_modules/.bin/ng). Выполните npm install." });
  process.exit(1);
}

try {
  const output = execSync(`"${bin}" generate ${type} ${name} --skip-tests=true`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = output.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const changed = lines.filter((l) => /^(CREATE|UPDATE)\b/.test(l));
  out({ success: true, files: changed.length ? changed : lines.slice(-5) });
} catch (error) {
  const text = ((error.stdout || '') + (error.stderr || '')).trim() || error.message || 'Неизвестная ошибка Angular CLI';
  out({ success: false, error: text.split('\n').slice(-10).join('\n') });
}
