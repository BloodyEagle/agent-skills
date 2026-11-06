const fs = require('fs');
const path = require('path');

const SOURCE_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const IGNORED_DIRS = ['node_modules', 'dist', 'build', '.next', 'out', 'coverage', '.git', 'vendor', '.zcode', '.kilo', '.kilocode', '.angular'];
const ANGULAR_ERROR = 'Angular не найден в проекте: команда неприменима';

/**
 * Обходит исходники без повторного чтения дерева в пределах вызова.
 * @param {string} root Корень обхода.
 * @param {{ext?: string[], ignored?: string[]}} options Фильтры файлов и каталогов.
 * @returns {string[]} Абсолютные пути файлов.
 */
function walk(root, {ext = SOURCE_EXT, ignored = IGNORED_DIRS} = {}) {
    const skipped = new Set(ignored);
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
                if (!skipped.has(entry.name)) visit(file);
            } else if (entry.isFile() && ext.some(e => entry.name.endsWith(e))) {
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

module.exports = {SOURCE_EXT, IGNORED_DIRS, walk, isAngular, ANGULAR_ERROR};
