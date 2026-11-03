'use strict';
// detect.js — определение режима проекта. Режим решает: какие каталоги пропускаются,
// как классифицируются пути и какие профильные операции доступны.
//   bitrix  — маркеры bitrix/ или local/ (в корне или типичном docroot: www, public_html, …)
//   modx    — Revolution: core/ + manager/ + connectors/; Evolution: manager/ + includes/ + assets/
//   laravel — artisan или laravel/framework в composer.json
//   generic — ни один маркер: универсальный режим, только общие операции PHP

const fs = require('fs');
const path = require('path');
const { detectDocroot } = require('./fsx');
const { detectLaravel } = require('./laravel');

/** Редакция MODX по маркерам каталогов: 'revolution' | 'evolution' | null. */
function detectModx(root) {
  const has = (p) => fs.existsSync(path.join(root, p));
  if (has('core') && has('manager') && has('connectors')) return 'revolution';
  if (has('manager') && has('includes') && has('assets')) return 'evolution';
  return null;
}

function detectMode(root) {
  const dr = detectDocroot(root);
  const base = path.join(root, dr || '');
  if (fs.existsSync(path.join(base, 'bitrix')) || fs.existsSync(path.join(base, 'local'))) return 'bitrix';
  if (detectModx(root)) return 'modx';
  return detectLaravel(root) ? 'laravel' : 'generic';
}

module.exports = { detectMode, detectModx };
