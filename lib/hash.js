'use strict';
// Единое правило хеширования каталога скилла: его используют check, bump, verify и manifest.
// Хеш не зависит от порядка обхода и mtime: файлы сортируются, содержимое читается целиком.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Исключения из хеша: системные и временные каталоги, локальные метки установки.
const EXCLUDED_NAMES = new Set(['.git', 'node_modules', 'dist', '__pycache__', '.installed.json']);
const SYSTEM_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
const EXCLUDED_DIR_PATHS = new Set(['test/fixtures']); // пары сегментов «каталог/каталог»

function isExcluded(rel) {
    const seg = rel.split('/');
    const name = seg[seg.length - 1];
    if (seg.some((s) => EXCLUDED_NAMES.has(s))) return true;
    if (SYSTEM_FILES.has(name.toLowerCase()) || /\.py[co]$/i.test(name)) return true;
    for (let i = 1; i < seg.length; i++) {
        if (EXCLUDED_DIR_PATHS.has(seg[i - 1] + '/' + seg[i])) return true;
    }
    return false;
}

// Относительные posix-пути (разделитель «/») — чтобы хеш совпадал на Windows и Linux.
function listFiles(dir) {
    const out = [];
    const walk = (rel) => {
        for (const e of fs.readdirSync(path.join(dir, rel), {withFileTypes: true})) {
            const r = rel ? rel + '/' + e.name : e.name;
            if (isExcluded(r)) continue;
            if (e.isSymbolicLink()) {
                const error = new Error(`ссылки внутри скилла не поддерживаются: ${r}`);
                error.code = 'UNSAFE_SKILL_LINK';
                throw error;
            }
            if (e.isDirectory()) walk(r);
            else if (e.isFile()) out.push(r);
        }
    };
    walk('');
    return out.sort();
}

// sha256 от конкатенации строк sha256(путь + "\n" + содержимое) по отсортированному списку файлов.
function hashDir(dir, contents = new Map()) {
    const files = listFiles(dir);
    const h = crypto.createHash('sha256');
    for (const rel of files) {
        const per = crypto.createHash('sha256')
            .update(rel + '\n')
            .update(contents.has(rel) ? contents.get(rel) : fs.readFileSync(path.join(dir, rel)))
            .digest('hex');
        h.update(per);
    }
    return {hash: h.digest('hex'), files: files.length};
}

// Требования скилла к среде — выводятся из состава файлов, а не пишутся руками.
function requiresOf(dir) {
    const files = listFiles(dir);
    const req = [];
    if (files.some((f) => f.endsWith('.js'))) req.push('node>=18');
    if (files.some((f) => f.endsWith('.py'))) req.push('python>=3');
    return req;
}

module.exports = {hashDir, listFiles, requiresOf, isExcluded};
