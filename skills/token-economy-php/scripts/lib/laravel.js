'use strict';
// laravel.js — понимание проектов Laravel 8 … 13 по исходникам, без запуска composer/artisan.
// Маршруты (routes/*.php с группами, ресурсами и fluent-цепочками), Eloquent-модели (таблица,
// $fillable/$casts, связи, scopes), контейнер (bind/singleton/scoped/instance, контекстные
// привязки), миграции (Schema::create/table с колонками и ключами), вызовы view()/route()/__(),
// Blade-шаблоны (@extends/@include/@component/@section/@lang, переменные), языковые файлы
// (lang/<locale>/<group>.php), команды и расписание. Использует лексер из php.js.

const fs = require('fs');
const path = require('path');
const { lex, matchBrackets } = require('./php');

const isOpen = (t) => !!t && t.k === 'op' && (t.v === '(' || t.v === '[' || t.v === '{');
const isOp = (t, v) => !!t && t.k === 'op' && t.v === v;
const lc = (t) => (t && t.k === 'name' ? t.v : '');
// префикс пространства имён группы — только для короткого имени класса
const withNs = (nm, ns) => (nm && ns && !nm.includes('\\') && /^[A-Z]/.test(nm) ? ns + '\\' + nm : nm);

const RELS = new Set(['hasOne', 'hasMany', 'belongsTo', 'belongsToMany', 'hasManyThrough', 'hasOneThrough', 'morphMany', 'morphOne', 'morphTo', 'morphToMany', 'morphedByMany']);
const CONTAINER = new Set(['bind', 'singleton', 'scoped', 'instance', 'extend']);
const RES_ACTIONS = ['index', 'create', 'store', 'show', 'edit', 'update', 'destroy'];
const API_RES = ['index', 'store', 'show', 'update', 'destroy'];
const RES_MAP = {
  index: ['GET', ''], create: ['GET', '/create'], store: ['POST', ''],
  show: ['GET', '/{p}'], edit: ['GET', '/{p}/edit'], update: ['PUT', '/{p}'], destroy: ['DELETE', '/{p}'],
};

// ---------- определение проекта и версии ----------

function readComposer(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'composer.json'), 'utf8')); } catch (e) { return null; }
}

function detectLaravel(root) {
  try { if (fs.statSync(path.join(root, 'artisan')).isFile()) return true; } catch (e) { /* нет artisan */ }
  const c = readComposer(root);
  if (c) {
    const req = { ...(c.require || {}), ...(c['require-dev'] || {}) };
    if (req['laravel/framework'] || req['laravel/lumen-framework']) return true;
  }
  return false;
}

function composerFramework(root) {
  const c = readComposer(root);
  if (!c) return null;
  const req = { ...(c.require || {}), ...(c['require-dev'] || {}) };
  return req['laravel/framework'] || req['laravel/lumen-framework'] || null;
}

function composerNamespace(root) {
  const c = readComposer(root);
  if (c && c.autoload && c.autoload['psr-4']) {
    for (const [ns, dir] of Object.entries(c.autoload['psr-4'])) if (dir === 'app/' || dir === 'app' || dir === './app' || dir === './app/') return ns;
  }
  return 'App\\';
}

/** Структура каркаса: 11+ (bootstrap/app.php с withRouting) или 8–10 (app/Http/Kernel.php). */
function structureVersion(root) {
  try {
    const b = fs.readFileSync(path.join(root, 'bootstrap/app.php'), 'utf8');
    if (/withRouting|withMiddleware|withSchedule|withCommands|withExceptions/.test(b)) return '11+';
  } catch (e) { /* нет файла */ }
  if (fs.existsSync(path.join(root, 'app/Http/Kernel.php'))) return '8-10';
  if (fs.existsSync(path.join(root, 'artisan'))) return '11+';
  return null;
}

// ---------- классификация путей ----------

/**
 * Laravel-пути (относительно корня проекта, docroot обычно ''): тег вида файла и метаданные.
 * @returns {{tag?: string, view?: object, langlv?: object}}
 */
function laravelClassify(p) {
  let m;
  if ((m = /^\/resources\/views\/(.+)\.blade\.php$/i.exec(p))) return { tag: 'view', view: { name: m[1].replace(/\//g, '.') } };
  if ((m = /^\/(?:resources\/)?lang\/([a-z]{2}(?:[-_][A-Za-z]{2})?)\/([A-Za-z0-9_/.-]+)\.php$/i.exec(p))) {
    return { tag: 'lang-lv', langlv: { code: m[1], group: m[2].replace(/\//g, '.') } };
  }
  const rules = [
    [/^\/routes\/.+\.php$/, 'routes'],
    [/^\/config\/[^/]+\.php$/, 'config'],
    [/^\/database\/migrations\//, 'migration'],
    [/^\/database\/seeders\//, 'seeder'],
    [/^\/database\/factories\//, 'factory'],
    [/^\/app\/Http\/Controllers\//, 'controller'],
    [/^\/app\/Models\//, 'model'],
    [/^\/app\/Providers\//, 'provider'],
    [/^\/app\/Console\/Commands\//, 'command'],
    [/^\/app\/Http\/Middleware\//, 'middleware'],
    [/^\/app\/Http\/Requests\//, 'form-request'],
    [/^\/app\/Http\/Resources\//, 'api-resource'],
    [/^\/app\/Jobs\//, 'job'],
    [/^\/app\/Events\//, 'event'],
    [/^\/app\/Listeners\//, 'listener'],
    [/^\/app\/Policies\//, 'policy'],
    [/^\/app\/Observers\//, 'observer'],
    [/^\/app\/Rules\//, 'rule'],
    [/^\/app\/Console\/Kernel\.php$/, 'console-kernel'],
    [/^\/bootstrap\/app\.php$/, 'bootstrap'],
    [/^\/tests\//, 'test'],
    [/^\/public\/index\.php$/, 'public'],
  ];
  for (const [rx, tag] of rules) if (rx.test(p)) return { tag };
  return {};
}

// ---------- имена и соглашения ----------

const IRREG = { person: 'people', child: 'children', man: 'men', woman: 'women', tooth: 'teeth', foot: 'feet', mouse: 'mice', goose: 'geese' };

const snakeCase = (s) => s.replace(/(.)([A-Z][a-z]+)/g, '$1_$2').replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase();

function pluralize(s) {
  if (IRREG[s.toLowerCase()]) return IRREG[s.toLowerCase()];
  if (/(s|x|z|ch|sh)$/i.test(s)) return s + 'es';
  if (/[^aeiou]y$/i.test(s)) return s.slice(0, -1) + 'ies';
  return s + 's';
}

function singularize(s) {
  const low = s.toLowerCase();
  for (const [a, b] of Object.entries(IRREG)) if (b === low) return a;
  if (/ies$/i.test(s)) return s.slice(0, -3) + 'y';
  if (/(ses|xes|zes|ches|shes)$/i.test(s)) return s.slice(0, -2);
  if (/s$/i.test(s)) return s.slice(0, -1);
  return s;
}

/** Имя таблицы по соглашению: App\Models\OrderItem → order_items. */
const modelTable = (clsName) => pluralize(snakeCase(String(clsName).split('\\').pop()));

/** 'layouts.app' → '/resources/views/layouts/app.blade.php' (именованные view::x не разрешаются). */
const viewNameToDoc = (name) => '/resources/views/' + String(name).replace(/\./g, '/') + '.blade.php';

/** '/users/{user}/posts/{post?}' → RegExp для сопоставления URL. */
function routeUriToRegExp(uri) {
  let u = String(uri);
  if (!u.startsWith('/')) u = '/' + u;
  const segs = u.split('/').filter((s) => s !== '');
  const parts = segs.map((s) => {
    if (/^\{[\w.]+\?\}$/.test(s)) return '(?:/([^/]*))?';
    if (/^\{[\w.]+\}$/.test(s)) return '/([^/]+)';
    if (s === '*') return '/.*';
    return '/' + s.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
  });
  try { return new RegExp('^' + parts.join('') + '/?$'); } catch (e) { return null; }
}

// ---------- общие помощники по токенам ----------

function callArgs(T, match, open) {
  const close = match[open];
  if (close < 0) return [];
  const args = [];
  let a = open + 1;
  for (let k = open + 1; k < close; k++) {
    if (isOpen(T[k]) && match[k] > k) { k = match[k]; continue; }
    if (isOp(T[k], ',')) { if (k > a) args.push([a, k - 1]); a = k + 1; }
  }
  if (close > a) args.push([a, close - 1]);
  return args;
}

/** Первая строка аргумента либо null. */
const strAt = (T, r) => (r && T[r[0]] && T[r[0]].k === 'str' ? T[r[0]].v : null);

/** Значение аргумента: {s} строка | {c} класс/выражение | {fn} замыкание | null. */
function argValue(T, r) {
  if (!r) return null;
  const t = T[r[0]];
  if (!t) return null;
  if (t.k === 'str') return { s: t.v };
  if (t.k === 'name' && (t.v === 'function' || t.v === 'fn' || t.v === 'static')) return { fn: 1 };
  if (t.k === 'name' && t.v === 'new' && T[r[0] + 1] && T[r[0] + 1].k === 'name') return { c: T[r[0] + 1].v };
  if (t.k === 'name' && isOp(T[r[0] + 1], '::') && lc(T[r[0] + 2]) === 'class') return { c: t.v };
  if (t.k === 'name' && isOp(T[r[0] + 1], '(')) return { c: t.v + '(…)' }; // config(…), app(…)
  if (t.k === 'name') return { c: t.v };
  if (t.k === 'num') return { s: t.v };
  return null;
}

/** Все строки аргументов верхнего уровня: 'auth' или ['auth','api']. */
function strList(T, match, args) {
  const res = [];
  for (const r of args) {
    const t = T[r[0]];
    if (!t) continue;
    if (t.k === 'str') { res.push(t.v); continue; }
    if (isOp(t, '[')) {
      for (let k = r[0] + 1; k < match[r[0]]; k++) if (T[k].k === 'str') res.push(T[k].v);
    } else if (t.k === 'name' && /^array$/i.test(t.v) && isOp(T[r[0] + 1], '(')) {
      for (let k = r[0] + 2; k < match[r[0] + 1]; k++) if (T[k].k === 'str') res.push(T[k].v);
    }
  }
  return res;
}

// ---------- разбор PHP-файла в Laravel-проекте ----------

const TERM = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'any', 'match', 'view', 'redirect', 'fallback', 'resource', 'apiresource', 'group']);
const FLU = new Set(['prefix', 'middleware', 'name', 'namespace', 'domain', 'controller']);

/**
 * Один проход по токенам файла: маршруты, привязки контейнера, модели Eloquent,
 * миграции, команды, расписание, вызовы view()/route()/__()/trans().
 * Функции с доступом к T/match объявлены внутри, как в php.js.
 */
function parseLaravelPhp(src) {
  const T = lex(src);
  const match = matchBrackets(T);
  const out = { routes: [], binds: [], ctxBinds: [], models: [], migs: [], views: [], routeRefs: [], langRefs: [], cmds: [], sched: [] };
  let ns = '';
  let lastClass = '';
  const argsOf = (open) => callArgs(T, match, open);
  const strArgs = (args) => strList(T, match, args);

  const routeActionArg = (r, nsp, ctrl) => {
    if (!r) return null;
    const t = T[r[0]];
    if (!t) return null;
    if (t.k === 'str') {
      if (/^[A-Z]/.test(t.v)) return withNs(t.v, nsp); // 'Ctrl@method' или invokable
      return ctrl ? withNs(ctrl, nsp) + '@' + t.v : t.v; // имя метода при Route::controller(...)
    }
    if (isOp(t, '[')) {
      const close = match[r[0]];
      let cls = null, method = null;
      for (let k = r[0] + 1; k < close; k++) {
        if (isOpen(T[k]) && match[k] > k) { k = match[k]; continue; }
        if (T[k].k === 'name' && isOp(T[k + 1], '::') && lc(T[k + 2]) === 'class') { cls = T[k].v; k += 2; continue; }
        if (T[k].k === 'str') method = T[k].v;
      }
      return cls ? withNs(cls, nsp) + (method ? '@' + method : '') : null;
    }
    if (t.k === 'name' && isOp(T[r[0] + 1], '::') && lc(T[r[0] + 2]) === 'class') return withNs(t.v, nsp);
    if (t.v === 'function' || t.v === 'fn' || t.v === 'static') return 'Closure';
    if (t.k === 'name') return withNs(t.v, nsp);
    return null;
  };

  const normUri = (u) => ('/' + String(u).replace(/^\/+|\/+$/g, '')).replace(/\/+/g, '/') || '/';

  // атрибуты группы из массива: ['prefix' => 'admin', 'middleware' => [...], 'as' => 'admin.', 'namespace' => '...']
  function readGroupArray(open, g) {
    const close = match[open];
    for (let k = open + 1; k < close - 2; k++) {
      if (T[k].k !== 'str' || !isOp(T[k + 1], '=>')) continue;
      const key = T[k].v.toLowerCase();
      let v = k + 2;
      const vals = [];
      if (T[v].k === 'str') { vals.push(T[v].v); v = v; }
      else if (isOp(T[v], '[')) {
        for (let q = v + 1; q < match[v]; q++) if (T[q].k === 'str') vals.push(T[q].v);
        k = match[v] - 1;
      } else if (T[v].k === 'name' && /^array$/i.test(T[v].v) && isOp(T[v + 1], '(')) {
        for (let q = v + 2; q < match[v + 1]; q++) if (T[q].k === 'str') vals.push(T[q].v);
        k = match[v + 1] - 1;
      } else continue;
      if (key === 'prefix') g.prefix.push(...vals);
      else if (key === 'middleware') g.mw.push(...vals);
      else if (key === 'namespace') g.ns.push(...vals);
      else if (key === 'as' || key === 'name') g.name.push(...vals);
    }
  }

  // тело замыкания из диапазона аргумента: [open..close] токенов 'function … { … }'
  function closureBody(r) {
    for (let k = r[0]; k <= r[1]; k++) {
      if (T[k].k === 'name' && (T[k].v === 'function' || T[k].v === 'static')) {
        let j = k + 1;
        if (isOp(T[j], '&')) j++;
        while (j <= r[1] && !isOp(T[j], '{')) { if (isOpen(T[j]) && match[j] > j) j = match[j]; j++; }
        if (isOp(T[j], '{') && match[j] > j) return [j + 1, match[j] - 1];
      }
      if (T[k].k === 'name' && T[k].v === 'fn') return null; // стрелочная — тела-блока нет
    }
    return null;
  }
  const isFnArg = (r) => { for (let k = r[0]; k <= r[1]; k++) if (T[k].k === 'name' && (T[k].v === 'function' || T[k].v === 'static')) return true; return false; };

  // ---------- маршруты: Route::… ----------
  function handleRoute(i, stack) {
    const calls = [];
    let k = i + 2, end = i + 2;
    while (k < T.length) {
      if (T[k].k !== 'name' || !isOp(T[k + 1], '(') || match[k + 1] < 0) break;
      calls.push({ name: T[k].v, low: T[k].v.toLowerCase(), args: argsOf(k + 1), i: k });
      const after = match[k + 1] + 1;
      end = after;
      if (isOp(T[after], '->') || isOp(T[after], '?->')) { k = after + 1; continue; }
      break;
    }
    const fl = { prefix: '', mw: [], name: '', ns: '', ctrl: '', only: null, except: null };
    let term = null;
    for (const c of calls) {
      if (TERM.has(c.low) && !term) term = c;
      else if (FLU.has(c.low)) {
        const vals = strArgs(c.args);
        if (c.low === 'middleware') fl.mw.push(...vals);
        else if (c.low === 'prefix' && vals[0]) fl.prefix = vals[0];
        else if (c.low === 'name' && vals[0]) fl.name = vals[0];
        else if (c.low === 'namespace' && vals[0]) fl.ns = vals[0];
        else if (c.low === 'controller') { const av = argValue(T, c.args[0]); if (av && (av.c || av.s)) fl.ctrl = av.c || av.s; }
      } else if (c.low === 'only' || c.low === 'except') {
        const v = strArgs(c.args);
        if (v.length) fl[c.low] = v;
      }
    }
    if (!term) return end;
    const mergedNs = stack.ns.concat(fl.ns ? [fl.ns] : []).join('\\');
    const mergedCtrl = fl.ctrl || (stack.ctrl && stack.ctrl.length ? stack.ctrl[stack.ctrl.length - 1] : '');
    const gPrefix = stack.prefix.concat(fl.prefix ? [fl.prefix] : []);
    if (term.low === 'group') {
      const g = { prefix: [], mw: [], name: [], ns: [] };
      if (term.args[0] && isOp(T[term.args[0][0]], '[')) readGroupArray(term.args[0][0], g);
      const ns2 = {
        prefix: gPrefix.concat(g.prefix),
        mw: stack.mw.concat(fl.mw, g.mw),
        name: stack.name.concat(fl.name ? [fl.name] : [], g.name),
        ns: stack.ns.concat(fl.ns ? [fl.ns] : [], g.ns),
        ctrl: stack.ctrl.concat(fl.ctrl ? [fl.ctrl] : []),
      };
      for (const r of term.args) {
        if (!isFnArg(r)) continue;
        const body = closureBody(r);
        if (body) walk(body[0], body[1] + 1, ns2);
      }
      return end;
    }
    const gName = stack.name.concat(fl.name ? [fl.name] : []).join('');
    const gMw = stack.mw.concat(fl.mw);
    const uriIdx = term.low === 'match' ? 1 : 0;
    const uri = term.args[uriIdx] && T[term.args[uriIdx][0]].k === 'str' ? T[term.args[uriIdx][0]].v : null;
    if (term.low === 'resource' || term.low === 'apiresource') {
      const rn = strAt(T, term.args[0]);
      if (!rn) return end;
      const ctrl = argValue(T, term.args[1]);
      const base = term.low === 'apiresource' ? API_RES : RES_ACTIONS;
      const acts = (fl.only ? fl.only.filter((a) => base.includes(a)) : base.filter((a) => !(fl.except || []).includes(a)));
      const param = singularize(rn.split('/').pop().replace(/\./g, ''));
      for (const a of acts) {
        const [verb, tail] = RES_MAP[a];
        out.routes.push({
          v: verb, u: normUri(gPrefix.join('/') + '/' + rn.replace(/\./g, '/') + tail.replace('{p}', '{' + param + '}')),
          a: ctrl && ctrl.c ? withNs(ctrl.c, mergedNs) + '@' + a : '?', n: gName + rn.replace(/\//g, '.').replace(/\./g, '.') + '.' + a,
          mw: gMw, l: T[term.i].l, res: rn,
        });
      }
      return end;
    }
    if (uri === null) return end; // динамический адрес — пропускаем
    let verbs = [term.low.toUpperCase()];
    if (term.low === 'match' && term.args[0] && isOp(T[term.args[0][0]], '[')) {
      const vv = [];
      for (let q = term.args[0][0] + 1; q < match[term.args[0][0]]; q++) if (T[q].k === 'str') vv.push(T[q].v.toUpperCase());
      if (vv.length) verbs = vv;
    }
    let action = null;
    if (term.low === 'view') {
      const vn = strAt(T, term.args[1]);
      action = 'view: ' + (vn || '?');
      if (vn) out.views.push([vn, T[term.i].l, '']);
    } else if (term.low === 'redirect') {
      action = 'redirect: ' + (strAt(T, term.args[1]) || '?');
    } else {
      action = routeActionArg(term.args[term.low === 'match' ? 2 : 1], mergedNs, mergedCtrl);
    }
    for (const v of verbs) {
      out.routes.push({ v, u: normUri(gPrefix.join('/') + '/' + uri), a: action || '?', n: fl.name ? gName : '', mw: gMw, l: T[term.i].l, res: null });
    }
    // действие-замыкание может рендерить view() — обходим его тем же проходом
    for (const r of term.args) {
      if (isFnArg(r)) {
        const body = closureBody(r);
        if (body) { walk(body[0], body[1] + 1, stack, ''); continue; }
      }
      walk(r[0], r[1] + 1, stack, ''); // стрелочная функция или прочее выражение
    }
    return end;
  }

  // ---------- миграции: Schema::… ----------
  function handleSchema(i) {
    const verb = lc(T[i + 2]).toLowerCase();
    if (!isOp(T[i + 3], '(')) return i + 4;
    const args = argsOf(i + 3);
    const line = T[i].l;
    if (verb === 'create' || verb === 'table') {
      const table = strAt(T, args[0]);
      const body = args[1] ? closureBody(args[1]) : null;
      if (!table || !body) return i + 4;
      // имя переменной Blueprint: первый $var в параметрах замыкания
      let bp = 'table';
      for (let q = args[1][0]; q <= args[1][1] && q < body[0]; q++) if (T[q].k === 'var') { bp = T[q].v; break; }
      const cols = [], fks = [];
      let k = body[0];
      const NOT_COL = new Set(['foreign', 'primary', 'unique', 'index', 'fulltext', 'spatialindex', 'dropcolumn', 'dropforeign', 'dropunique', 'dropindex', 'dropprimary', 'renamecolumn', 'droptimestamps', 'dropsoftdeletes', 'macro']);
      while (k <= body[1]) {
        if (T[k].k === 'var' && T[k].v === bp && isOp(T[k + 1], '->') && T[k + 2] && T[k + 2].k === 'name' && isOp(T[k + 3], '(') && match[k + 3] > k) {
          const type = T[k + 2].v;
          const cargs = argsOf(k + 3);
          const first = strAt(T, cargs[0]);
          // модификаторы после вызова: ->constrained() ->unique() ->references('id')->on('users')
          let m = match[k + 3] + 1;
          const mods = [];
          while (isOp(T[m], '->') && T[m + 1] && T[m + 1].k === 'name') {
            const mn = T[m + 1].v;
            let mstr = '';
            if (isOp(T[m + 2], '(') && match[m + 2] > m) {
              mstr = strAt(T, argsOf(m + 2)[0]) || '';
              mods.push(mn + (mstr ? '(' + mstr + ')' : ''));
              m = match[m + 2] + 1;
            } else { mods.push(mn); m += 2; }
          }
          if (!NOT_COL.has(type.toLowerCase())) {
            let names = [];
            if (first) names = [first];
            else if (type === 'id' || /^(big|small|medium)?increments$/i.test(type)) names = ['id'];
            else if (type === 'uuid' || type === 'ulid') names = [type];
            else if (/^timestamps(Tz)?$/i.test(type)) names = ['created_at', 'updated_at'];
            else if (/^softDeletes(Tz)?$/i.test(type)) names = ['deleted_at'];
            else if (type === 'rememberToken') names = ['remember_token'];
            else if (type === 'foreignIdFor') {
              const av = argValue(T, cargs[0]);
              names = [av && av.c ? snakeCase(av.c.split('\\').pop()) + '_id' : 'foreign_id'];
            } else names = ['(' + type + ')'];
            for (const nname of names) if (cols.length < 40) cols.push(nname + ' ' + type + (mods.length ? ' [' + mods.join(',') + ']' : ''));
            if (mods.some((x) => x.startsWith('constrained'))) {
              const refStr = (mods.find((x) => x.startsWith('constrained')) || '').replace(/[()]/g, '').split('constrained')[1];
              const refTable = refStr || (first ? pluralize(singularize(first.replace(/_id$/, ''))) : null);
              if (refTable) fks.push(first + ' → ' + refTable);
            }
          } else if (type === 'foreign') {
            const refs = (mods.find((x) => x.startsWith('references')) || '').replace(/[()]/g, '').split('references')[1] || 'id';
            const on = (mods.find((x) => x.startsWith('on')) || '').replace(/[()]/g, '').split('on')[1] || '?';
            if (first) fks.push(first + ' → ' + on + '.' + refs);
          } else if (['primary', 'unique', 'index'].includes(type.toLowerCase()) && first) {
            cols.push('[' + type.toLowerCase() + ': ' + first + ']');
          }
          k = m;
          continue;
        }
        k++;
      }
      out.migs.push({ t: table, op: verb === 'create' ? 'create' : 'alter', cols, fks: fks.slice(0, 12), l: line });
      return match[i + 3] + 1;
    }
    if (verb === 'drop' || verb === 'dropifexists') {
      const table = strAt(T, args[0]);
      if (table) out.migs.push({ t: table, op: 'drop', cols: [], fks: [], l: line });
    } else if (verb === 'rename') {
      const a = strAt(T, args[0]), b = strAt(T, args[1]);
      if (a && b) out.migs.push({ t: b, op: 'rename:' + a, cols: [], fks: [], l: line });
    }
    return i + 4;
  }

  // ---------- контейнер ----------
  const receiverIsApp = (i) => { // T[i] — имя метода; проверяем $this->app / $app / app(…) слева
    if (!isOp(T[i - 1], '->') && !isOp(T[i - 1], '?->')) return false;
    const p = T[i - 2];
    if (p && (p.k === 'name' || p.k === 'var') && /^app$/i.test(p.v)) return true;
    if (p && isOp(p, ')') && i - 3 >= 0 && match[i - 3] === i - 2) {
      const q = T[i - 4];
      if (q && q.k === 'name' && /^app$/i.test(q.v)) return true;
    }
    return false;
  };

  function collectBind(i) {
    const args = argsOf(i + 1);
    if (!isOp(T[i + 1], '(') || match[i + 1] < 0) return;
    const a0 = argValue(T, args[0]);
    const a1 = argValue(T, args[1]);
    if (!a0 || (!a0.c && !a0.s)) return;
    out.binds.push({
      k: T[i].v, a: a0.c || a0.s,
      i: !a1 ? '(self)' : a1.fn ? '(closure)' : (a1.c || a1.s || '(?)'),
      l: T[i].l, cls: lastClass,
    });
  }

  function collectWhen(i) {
    const args = argsOf(i + 1);
    const a0 = argValue(T, args[0]);
    if (!a0) return;
    let need = null, give = null;
    let k = match[i + 1] + 1;
    for (let n = 0; n < 40 && k < T.length; n++, k++) {
      if (T[k].k !== 'name' || !isOp(T[k + 1], '(')) continue;
      const v = argValue(T, argsOf(k + 1)[0]);
      if (T[k].v === 'needs' && need === null) need = v;
      if (T[k].v === 'give' && give === null) give = v;
      if (give !== null) break;
    }
    out.ctxBinds.push({
      a: a0.c || a0.s,
      need: need ? (need.c || need.s || '(?)') : '?',
      give: give ? (give.fn ? '(closure)' : (give.c || give.s || '(?)')) : '?',
      l: T[i].l, cls: lastClass,
    });
  }

  // ---------- расписание ----------
  function collectSched(i, what) {
    const args = argsOf(i + 1);
    const a0 = argValue(T, args[0]);
    let cmd = '(closure)';
    if (what === 'command') cmd = a0 ? (a0.s || a0.c + '::class') : '(?)';
    else if (what === 'exec' || what === 'job') cmd = a0 ? (a0.s || a0.c || '(?)') : '(?)';
    const parts = [];
    let k = match[i + 1] + 1;
    while (k < T.length && !isOp(T[k], ';') && parts.length < 8) {
      if (isOp(T[k], '->') && T[k + 1] && T[k + 1].k === 'name' && isOp(T[k + 2], '(')) {
        const s = strAt(T, argsOf(k + 2)[0]);
        parts.push(T[k + 1].v + (s ? "('" + s + "')" : ''));
        k = match[k + 2] + 1;
        continue;
      }
      k++;
    }
    out.sched.push({ cmd, freq: parts.join(' ').slice(0, 100) || '(без частоты)', l: T[i].l, cls: lastClass });
  }

  // ---------- классы: модели, команды ----------
  function parseClass(i) {
    const name = T[i + 1] && T[i + 1].k === 'name' ? T[i + 1].v : '';
    lastClass = name;
    let j = i + 2, mode = '';
    const ext = [], impl = [];
    while (j < T.length && !isOp(T[j], '{') && !isOp(T[j], ';')) {
      const w2 = lc(T[j]).toLowerCase();
      if (T[j].k === 'name') {
        if (w2 === 'extends' || w2 === 'implements') mode = w2;
        else if (mode === 'extends') ext.push(T[j].v);
        else if (mode === 'implements') impl.push(T[j].v);
      }
      j++;
    }
    if (!isOp(T[j], '{') || match[j] < 0) return j + 1;
    const close = match[j];
    // методы: имя + диапазон тела
    const methods = [];
    let k = j + 1;
    while (k < close) {
      if (lc(T[k]).toLowerCase() === 'function') {
        let m = k + 1;
        if (isOp(T[m], '&')) m++;
        if (T[m] && T[m].k === 'name' && isOp(T[m + 1], '(') && match[m + 1] > m) {
          let b = match[m + 1] + 1;
          while (b < close && !isOp(T[b], '{') && !isOp(T[b], ';')) { if (isOpen(T[b]) && match[b] > b) b = match[b]; b++; }
          let bodyOpen = -1, bodyClose = -1, end = b;
          if (isOp(T[b], '{') && match[b] > b) { bodyOpen = b; bodyClose = match[b]; end = bodyClose + 1; }
          methods.push({ name: T[m].v, bodyOpen, bodyClose, line: T[k].l, from: k, to: end - 1 });
          k = end;
          continue;
        }
      }
      k++;
    }
    // свойства уровня класса вне методов: $table, $fillable, $casts, $signature…
    const inMethod = new Array(close - j).fill(false);
    for (const m of methods) for (let q = m.from - j; q <= m.to - j && q < inMethod.length; q++) inMethod[q] = true;
    const props = {};
    for (let q = j + 1; q < close; q++) {
      if (inMethod[q - j]) { continue; }
      if (T[q].k === 'var' && isOp(T[q + 1], '=') && T[q + 2]) {
        const vn = T[q].v;
        const v0 = T[q + 2];
        if (v0.k === 'str') { props[vn] = v0.v; q += 2; continue; }
        if (isOp(v0, '[') || (v0.k === 'name' && /^array$/i.test(v0.v) && isOp(T[q + 3], '('))) {
          const open = isOp(v0, '[') ? q + 2 : q + 3;
          if (match[open] < 0) continue;
          if (vn === 'casts') {
            const pairs = {};
            for (let w = open + 1; w < match[open] - 2; w++) {
              if (T[w].k === 'str' && isOp(T[w + 1], '=>') && T[w + 2] && T[w + 2].k === 'str') { pairs[T[w].v] = T[w + 2].v; w += 2; }
              if (isOpen(T[w]) && match[w] > w) w = match[w];
            }
            props[vn] = pairs;
          } else {
            const strs = [];
            for (let w = open + 1; w < match[open]; w++) if (T[w].k === 'str') strs.push(T[w].v);
            props[vn] = strs;
          }
          q = match[open];
        }
      }
    }
    // отношения Eloquent в телах методов
    const rels = [], scopes = [];
    for (const m of methods) {
      if (m.name.length > 5 && m.name.startsWith('scope')) scopes.push(m.name[5].toLowerCase() + m.name.slice(6));
      if (m.bodyOpen < 0) continue;
      for (let q = m.bodyOpen + 1; q < m.bodyClose; q++) {
        if (T[q].k === 'var' && T[q].v === 'this' && (isOp(T[q + 1], '->') || isOp(T[q + 1], '?->')) && T[q + 2] && T[q + 2].k === 'name' && RELS.has(T[q + 2].v) && isOp(T[q + 3], '(')) {
          const cargs = argsOf(q + 3);
          const av = argValue(T, cargs[0]);
          const fk = strAt(T, cargs[1]);
          let r = av ? (av.s || av.c) : null;
          if (!r) r = T[q + 2].v === 'morphTo' ? '?' : (T[q + 2].v === 'belongsTo' || T[q + 2].v === 'belongsToMany' ? m.name[0].toUpperCase() + m.name.slice(1).replace(/s$/, '') : m.name[0].toUpperCase() + singularize(m.name.slice(1)));
          if (rels.length < 60) rels.push({ m: m.name, t: T[q + 2].v, r, fk: fk || undefined, l: T[q + 2].l });
        }
      }
    }
    // это модель?
    const extish = (x) => { const s = x.split('\\').pop(); return s === 'Model' || s === 'Authenticatable' || s === 'Pivot' || (s.length > 5 && s.endsWith('Model')); };
    if (ext.some(extish) || rels.length || props.table || props.fillable) {
      out.models.push({
        cls: name, fqn: (ns ? ns + '\\' : '') + name, ext: ext.join(','),
        table: props.table || null, pk: props.primaryKey || null,
        fillable: props.fillable || [], casts: props.casts || {}, hidden: props.hidden || [], appends: props.appends || [],
        rels, scopes, l: T[i].l,
      });
    }
    if (props.signature) out.cmds.push({ sig: props.signature, desc: props.description || '', cls: name, l: T[i].l });
    // тела методов обходим тем же проходом: там view(), привязки, расписание
    for (const m of methods) if (m.bodyOpen >= 0) walk(m.bodyOpen + 1, m.bodyClose + 1, { prefix: [], mw: [], name: [], ns: [], ctrl: [] }, (lastClass ? lastClass + '::' : '') + m.name);
    return close + 1;
  }

  // ---------- основной проход ----------
  function walk(from, to, stack, ctxName) {
    const ctx = ctxName || '';
    const record = (kind, name, line) => {
      if (kind === 'view') { if (out.views.length < 60) out.views.push([name, line, ctx]); }
      else if (kind === 'route') { if (out.routeRefs.length < 40) out.routeRefs.push([name, line]); }
      else { if (out.langRefs.length < 80) out.langRefs.push([name, line]); }
    };
    let i = from;
    while (i < to) {
      const t = T[i];
      if (t.k === 'name') {
        const prev = T[i - 1], next = T[i + 1];
        const viaAccess = isOp(prev, '->') || isOp(prev, '?->') || isOp(prev, '::');
        const w = t.v;
        if (w === 'namespace' && next && next.k === 'name' && !viaAccess) { ns = next.v; i += 2; continue; }
        if (['class', 'interface', 'trait', 'enum'].includes(w.toLowerCase()) && next && next.k === 'name' && !viaAccess && !['new', 'instanceof'].includes(lc(prev).toLowerCase())) { i = parseClass(i); continue; }
        if (w === 'Route' && isOp(next, '::') && T[i + 2] && T[i + 2].k === 'name') { i = handleRoute(i, stack); continue; }
        if (w === 'Schema' && isOp(next, '::') && T[i + 2] && T[i + 2].k === 'name' && isOp(T[i + 3], '(')) { i = handleSchema(i); continue; }
        if ((w === 'Schedule' || w === 'Artisan') && isOp(next, '::') && T[i + 2] && T[i + 2].k === 'name' && ['command', 'call', 'job', 'exec'].includes(T[i + 2].v)) {
          if (w === 'Artisan' && T[i + 2].v === 'command') {
            const a = argsOf(i + 3);
            const s = strAt(T, a[0]);
            if (s) out.cmds.push({ sig: s, desc: '', cls: '', l: T[i].l });
            i = i + 3;
          } else { collectSched(i + 2, T[i + 2].v); i = i + 3; }
          continue;
        }
        if (CONTAINER.has(w) && receiverIsApp(i)) { collectBind(i); i++; continue; }
        if (w === 'when' && receiverIsApp(i)) { collectWhen(i); i++; continue; }
        if (isOp(prev, '->') && ['command', 'call', 'job', 'exec'].includes(w) && T[i - 2] && T[i - 2].k === 'var' && /^schedule$/i.test(T[i - 2].v) && isOp(T[i + 1], '(')) { collectSched(i, w); i++; continue; }
        if (isOp(next, '(')) {
          if (!isOp(prev, '->') && !isOp(prev, '?->')) {
            if (w === 'view' || w === 'route' || w === '__' || w === 'trans' || w === 'trans_choice') {
              const s = strAt(T, argsOf(i + 1)[0]);
              if (s) record(w === 'view' ? 'view' : w === 'route' ? 'route' : 'lang', s, t.l);
              i++; continue;
            }
          } else if (w === 'route') { // redirect()->route('users.index')
            const s = strAt(T, argsOf(i + 1)[0]);
            if (s) record('route', s, t.l);
            i++; continue;
          }
        }
        if (w === 'View' && isOp(next, '::') && T[i + 2] && T[i + 2].v === 'make' && isOp(T[i + 3], '(')) {
          const s = strAt(T, argsOf(i + 3)[0]);
          if (s) record('view', s, t.l);
          i += 3; continue;
        }
        if (w === 'Lang' && isOp(next, '::') && T[i + 2] && T[i + 2].v === 'get' && isOp(T[i + 3], '(')) {
          const s = strAt(T, argsOf(i + 3)[0]);
          if (s) record('lang', s, t.l);
          i += 3; continue;
        }
        i++; continue;
      }
      if (isOpen(t) && match[i] > i) {
        if (t.v === '{') walk(i + 1, match[i] + 1, stack, ctx); // замыкания, if, collect — всё обходим
        i = match[i] + 1;
        continue;
      }
      i++;
    }
  }

  walk(0, T.length, { prefix: [], mw: [], name: [], ns: [], ctrl: [] }, '');
  for (const key of Object.keys(out)) if (!out[key].length) delete out[key];
  return out;
}

// ---------- Blade ----------

/**
 * Директивы Blade: extends, include/includeIf/..., component, each, section, yield, lang
 * и переменные {{ $x }} / {!! $x !!}.
 * @returns {{ext: [string, number][], inc: [], comp: [], each: [], sec: [], yld: [], langs: [], vars: string[], loc: number}}
 */
function parseBlade(src) {
  const out = { ext: [], inc: [], comp: [], each: [], sec: [], yld: [], langs: [], vars: [] };
  const lineAt = (idx) => src.slice(0, idx).split('\n').length;
  const re = /@(extends|include|includeIf|includeWhen|includeFirst|component|components|each|section|yield|hasSection|sectionMissing|lang|choice)\s*\(\s*(['"])([^'"]+?)\2/g;
  let m;
  while ((m = re.exec(src))) {
    const d = m[1], name = m[3], l = lineAt(m.index);
    if (d === 'extends') out.ext.push([name, l]);
    else if (d === 'section') out.sec.push([name, l]);
    else if (d === 'yield' || d === 'hasSection' || d === 'sectionMissing') out.yld.push([name, l]);
    else if (d === 'lang' || d === 'choice') out.langs.push([name, l]);
    else if (d === 'component' || d === 'components') out.comp.push([name, l]);
    else if (d === 'each') out.each.push([name, l]);
    else out.inc.push([name, l]); // include / includeIf / includeWhen / includeFirst
  }
  const echoRe = /\{\{\s*([\s\S]*?)\s*\}\}|\{!!\s*([\s\S]*?)\s*!!\}/g;
  while ((m = echoRe.exec(src))) {
    for (const vm of (m[1] || m[2] || '').matchAll(/\$([a-zA-Z_]\w*)/g)) {
      if (!out.vars.includes(vm[1]) && out.vars.length < 60) out.vars.push(vm[1]);
    }
  }
  return { ...out, loc: src.split('\n').length };
}

// ---------- языковые файлы Laravel ----------

/**
 * lang/<locale>/<group>.php: return ['key' => 'текст', 'nested' => ['k' => 'v']] →
 * [[group.key, значение, строка]] (без префикса group — он в классификации узла).
 */
function parseLaravelLang(src) {
  const T = lex(src);
  const match = matchBrackets(T);
  const res = [];
  function walkArr(open, close, prefix) {
    let k = open + 1;
    while (k < close) {
      if (T[k].k === 'str' && isOp(T[k + 1], '=>')) {
        const v = T[k + 2];
        if (v && v.k === 'str') {
          if (res.length < 400) res.push([prefix + T[k].v, v.v.length > 120 ? v.v.slice(0, 119) + '…' : v.v, T[k].l]);
          k += 2;
        } else if (v && isOp(v, '[')) {
          walkArr(k + 2, match[k + 2], T[k].v + '.');
          k = match[k + 2];
        } else if (v && v.k === 'name' && /^array$/i.test(v.v) && isOp(T[k + 3], '(')) {
          walkArr(k + 3, match[k + 3], T[k].v + '.');
          k = match[k + 3];
        }
      } else if (isOpen(T[k]) && match[k] > k) k = match[k];
      k++;
    }
  }
  for (let i = 0; i < T.length - 1; i++) {
    if (lc(T[i]).toLowerCase() === 'return' && isOp(T[i + 1], '[') && match[i + 1] > i) {
      walkArr(i + 1, match[i + 1], '');
      break;
    }
  }
  return res;
}

module.exports = {
  detectLaravel, composerFramework, composerNamespace, structureVersion, laravelClassify,
  snakeCase, pluralize, singularize, modelTable, viewNameToDoc, routeUriToRegExp,
  parseBlade, parseLaravelPhp, parseLaravelLang,
};
