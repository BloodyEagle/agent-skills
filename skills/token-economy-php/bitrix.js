'use strict';
// bitrix.js — понимание структуры 1С-Битрикс по пути файла (относительно корня сайта).

const CORE_AREAS = /^\/bitrix\/(admin|tools|activities|blocks|components\/bitrix)\//;

/**
 * Классифицирует файл по пути относительно корня сайта (начинается с «/»).
 * @returns {{origin: 'core'|'custom', comp: object|null, over: object|null, module: object|null, lang: object|null, tag: string}}
 */
function classify(p) {
  const r = { origin: 'custom', comp: null, over: null, module: null, lang: null, tag: '' };
  let m;

  // core: модули без точки в имени (main, iblock, sale…), компоненты bitrix:*, служебные каталоги
  if ((m = /^\/bitrix\/modules\/([^/]+)\//.exec(p))) {
    r.module = { id: m[1], loc: 'bitrix' };
    if (!m[1].includes('.')) r.origin = 'core';
  } else if (CORE_AREAS.test(p)) r.origin = 'core';
  if ((m = /^\/local\/modules\/([^/]+)\//.exec(p))) r.module = { id: m[1], loc: 'local' };

  // компонент: /bitrix|local/components/<ns>/<name>/<часть>
  if ((m = /^\/(bitrix|local)\/components\/([^/]+)\/([^/]+)\/(.+)$/.exec(p))) {
    r.comp = { id: m[2] + ':' + m[3], loc: m[1], part: m[4] };
    const tm = /^templates\/([^/]+)\//.exec(m[4]);
    if (tm) r.comp.tpl = tm[1];
  }
  // шаблон компонента, переопределённый в шаблоне сайта
  if ((m = /^\/(bitrix|local)\/templates\/([^/]+)\/components\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(p))) {
    r.over = { id: m[3] + ':' + m[4], tpl: m[5], site: m[2], loc: m[1], part: m[6] };
  }
  // языковой файл: <каталог>/lang/<код>/<путь>
  if ((m = /^(.*?)\/lang\/([a-z]{2})\/(.+)$/.exec(p))) r.lang = { dir: m[1], code: m[2], rest: m[3] };

  // метка для вывода
  if (r.lang) r.tag = 'lang';
  else if (r.over) r.tag = (r.over.part === 'template.php' ? 'template ' : r.over.part === 'result_modifier.php' ? 'result_modifier ' : 'tpl-file ') + r.over.id + '/' + r.over.tpl + ' @' + r.over.site;
  else if (r.comp) {
    const part = r.comp.part;
    if (r.comp.tpl) r.tag = (/\/template\.php$/.test(part) ? 'template ' : /\/result_modifier\.php$/.test(part) ? 'result_modifier ' : 'tpl-file ') + r.comp.id + '/' + r.comp.tpl;
    else if (part === 'class.php' || part === 'component.php') r.tag = 'component ' + r.comp.id;
    else r.tag = 'component-file ' + r.comp.id;
  } else if (r.module) {
    if (/\/install\/index\.php$/.test(p)) r.tag = 'module-install ' + r.module.id;
    else if (/\/include\.php$/.test(p)) r.tag = 'module-include ' + r.module.id;
    else r.tag = 'module ' + r.module.id;
  } else if (/\/php_interface\/init\.php$/.test(p)) r.tag = 'init';
  else if (/\/php_interface\//.test(p)) r.tag = 'php_interface';
  else if (/^\/(bitrix|local)\/templates\/[^/]+\/(header|footer)\.php$/.test(p)) r.tag = 'site-template';
  return r;
}

/**
 * Преобразует путь из require/include в путь относительно корня сайта.
 * @param {{b: string, r: string}} inc - база и остаток пути.
 * @param {string} fileDocRel - путь файла относительно корня сайта.
 */
function resolveInclude(inc, fileDocRel) {
  const dir = fileDocRel.replace(/\/[^/]*$/, '');
  const up = dir.replace(/\/[^/]*$/, '');
  let base;
  if (inc.b === 'doc') base = '';
  else if (inc.b === 'dir') base = dir;
  else if (inc.b === 'dirup') base = up;
  else if (inc.r.startsWith('/')) return null; // абсолютный путь файловой системы
  else base = dir;
  const raw = (base + '/' + inc.r).split('/');
  const stack = [];
  for (const seg of raw) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { stack.pop(); continue; }
    stack.push(seg);
  }
  return '/' + stack.join('/');
}

/**
 * Превращает PCRE-условие urlrewrite («#^/catalog/(.*)#i») в RegExp JavaScript.
 */
function pcreToRegExp(cond) {
  const d = cond[0];
  const end = cond.lastIndexOf(d);
  if (end <= 0) return null;
  const body = cond.slice(1, end);
  const flags = cond.slice(end + 1).replace(/[^imsu]/g, '');
  try { return new RegExp(body, flags.replace(/u/g, '')); } catch (e) { return null; }
}

module.exports = { classify, resolveInclude, pcreToRegExp };
