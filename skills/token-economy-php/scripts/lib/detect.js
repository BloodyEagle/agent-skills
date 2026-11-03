'use strict';
// detect.js — определение режима проекта. Режим решает: какие каталоги пропускаются,
// как классифицируются пути и какие профильные операции доступны.
//   bitrix  — маркеры bitrix/ или local/ (в корне или типичном docroot: www, public_html, …)
//   laravel — artisan или laravel/framework в composer.json
//   generic — ни то ни другое: универсальный режим, только общие операции PHP

const fs = require('fs');
const path = require('path');
const { detectDocroot } = require('./fsx');
const { detectLaravel } = require('./laravel');

function detectMode(root) {
  const dr = detectDocroot(root);
  const base = path.join(root, dr || '');
  if (fs.existsSync(path.join(base, 'bitrix')) || fs.existsSync(path.join(base, 'local'))) return 'bitrix';
  return detectLaravel(root) ? 'laravel' : 'generic';
}

module.exports = { detectMode };
