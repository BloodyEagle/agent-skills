const fs = require('fs');
const path = require('path');

function inside(root, file) {
    const rel = path.relative(root, file);
    return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

/**
 * Читает JSON запросов только из обычного файла внутри cwd по lexical и realpath границам.
 * Внутренние ссылки и cwd через junction допустимы; конкурентная подмена предков не исключена.
 * @param {string} file Путь requests_file.
 * @param {string} cwd Рабочая директория CLI.
 * @returns {unknown} Разобранный JSON; форму массива проверяет вызывающий CLI.
 */
function readRequestsFile(file, cwd = process.cwd()) {
    const root = path.resolve(cwd);
    const target = path.resolve(root, file);
    if (!inside(root, target))
        throw new Error('requests_file вне рабочей директории запрещён: ' + file);
    const realRoot = fs.realpathSync(root);
    const realTarget = fs.realpathSync(target);
    if (!inside(realRoot, realTarget))
        throw new Error('requests_file realpath вне рабочей директории запрещён: ' + file);
    if (!fs.statSync(realTarget).isFile())
        throw new Error('requests_file должен быть обычным файлом: ' + file);
    const fd = fs.openSync(realTarget, 'r');
    try {
        if (!fs.fstatSync(fd).isFile())
            throw new Error('requests_file должен быть обычным файлом: ' + file);
        return JSON.parse(fs.readFileSync(fd, 'utf8'));
    } finally {
        fs.closeSync(fd);
    }
}

module.exports = {readRequestsFile};
