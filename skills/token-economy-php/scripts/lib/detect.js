'use strict';
// detect.js — определение режима проекта. Режим решает: какие каталоги пропускаются,
// как классифицируются пути и какие профильные операции доступны.
//   laravel — laravel/framework в composer.json (require/require-dev) или файл artisan.
//             Проверяется первым: composer.json — самый надёжный маркер, а имена каталогов
//             (local/, manager/) встречаются и во внесистемных проектах
//   bitrix  — каталог bitrix/ или local/ с типичным подкаталогом (components/templates/
//             modules/php_interface) в корне или типичном docroot (www, public_html, …)
//   modx    — Revolution: manager/ + connectors/ + core с кодом ядра (core/model/modx
//             либо core/src/Revolution); Evolution: manager/includes/ + assets/
//   generic — ни один маркер: универсальный режим, только общие операции PHP

const fs = require('fs');
const path = require('path');
const { bitrixMarkerAt, DOCROOTS } = require('./fsx');
const { detectLaravel } = require('./laravel');

/** Редакция MODX по структурным маркерам: 'revolution' | 'evolution' | null. */
function detectModx(root) {
  const isDir = (p) => { try { return fs.statSync(path.join(root, p)).isDirectory(); } catch (e) { return false; } };
  // Revolution: связка manager+connectors+core с кодом ядра; вложенный core/model/modx (2.x)
  // или core/src/Revolution (3.x) отличает её от проекта с такими же каталогами в корне
  if (isDir('manager') && isDir('connectors') && (isDir('core/model/modx') || isDir('core/src/Revolution'))) return 'revolution';
  // Evolution: includes лежит внутри manager (а не рядом в корне, как у самописных админок)
  if (isDir('manager/includes') && isDir('assets')) return 'evolution';
  return null;
}

function detectMode(root) {
  if (detectLaravel(root)) return 'laravel';
  if (bitrixMarkerAt(root, '')) return 'bitrix';
  for (const d of DOCROOTS) if (bitrixMarkerAt(root, d)) return 'bitrix';
  if (detectModx(root)) return 'modx';
  return 'generic';
}

module.exports = { detectMode, detectModx };
