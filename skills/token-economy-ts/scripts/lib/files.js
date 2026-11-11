const fs = require('fs');
const path = require('path');

const SOURCE_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const IGNORED_DIRS = ['node_modules', 'dist', 'build', '.next', 'out', 'coverage', '.git', 'vendor', '.zcode', '.kilo', '.kilocode', '.angular'];
const ANGULAR_ERROR = 'Angular не найден в проекте: команда неприменима';
const REACT_ERROR = 'React не найден в проекте: команда неприменима (требуется react >= 16 в package.json)';

/**
 * Обходит исходники без повторного чтения дерева в пределах вызова.
 * @param {string} root Корень обхода.
 * @param {{ext?: string[], ignored?: string[]}} options Фильтры файлов и каталогов.
 * @returns {string[]} Абсолютные пути файлов.
 */
function walk(root, {ext = SOURCE_EXT, ignored = IGNORED_DIRS} = {}) {
    const key = name => process.platform === 'win32' ? name.toLowerCase() : name;
    const skipped = new Set(ignored.map(key));
    const extensions = ext.map(key);
    const directories = new Map();
    const files = [];
    function visit(dir) {
        let entries = directories.get(dir);
        if (!entries) {
            try {
                entries = fs.readdirSync(dir, {withFileTypes: true});
            } catch (_) {
                return;
            }
            directories.set(dir, entries);
        }
        for (const entry of entries) {
            const file = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!skipped.has(key(entry.name))) visit(file);
            } else if (entry.isFile() && extensions.some(e => key(entry.name).endsWith(e))) {
                files.push(file);
            }
        }
    }
    visit(path.resolve(root));
    return files;
}

/**
 * Проверяет наличие Angular без загрузки зависимостей проекта.
 * @param {string} root Корень проекта.
 * @returns {boolean} Найден ли Angular.
 */
function isAngular(root) {
    if (fs.existsSync(path.join(root, 'angular.json'))) return true;
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        return ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
            .some(key => Boolean(pkg[key] && pkg[key]['@angular/core']));
    } catch (_) {
        return false;
    }
}

/**
 * major-версия из range-спецификатора package.json; null — распознать нельзя.
 * @param {string} spec Значение из package.json (например `^16.0.0`, `npm:react@18.3.1`).
 * @returns {number|null} Число или null, если версию распознать нельзя.
 */
function parseReactMajor(spec) {
    if (typeof spec !== 'string') return null;
    let s = spec.trim();
    if (s.startsWith('npm:')) s = s.slice(4).replace(/^[^@]*@/, '');
    s = s.replace(/^[\^~>=<\s*v]+/, '');
    const m = s.match(/^(\d+)/);
    return m ? Number(m[1]) : null;
}

/**
 * Проверяет наличие React 16+ без загрузки зависимостей проекта; нераспознанная
 * версия (`latest`, `next`, `*`, `workspace:*`) трактуется как react по присутствию пакета.
 * @param {string} root Корень проекта.
 * @returns {boolean} Найден ли React подходящей версии.
 */
function isReact(root) {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        const spec = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
            .map(key => pkg[key] && pkg[key].react).find(Boolean);
        if (!spec) return false;
        const major = parseReactMajor(spec);
        return major === null || major >= 16;
    } catch (_) {
        return false;
    }
}

module.exports = {SOURCE_EXT, IGNORED_DIRS, walk, isAngular, isReact, parseReactMajor, ANGULAR_ERROR, REACT_ERROR};
