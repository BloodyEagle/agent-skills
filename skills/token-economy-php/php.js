'use strict';
// php.js — лёгкий лексер и разбор PHP без зависимостей (в проекте нет composer/php-parser).
// Работает с файлами, где PHP вперемешку с HTML (template.php, страницы), короткими тегами <? ?> и <?=.
// Результат parsePhp — «сырые» данные файла; связи между файлами строит index.js.

const KEYWORDS = new Set(('self static parent array string int float bool callable iterable object mixed void null true false new return echo ' +
  'print if else elseif endif foreach endforeach for endfor while endwhile switch endswitch case default break continue function fn use ' +
  'namespace class interface trait enum extends implements instanceof as try catch finally throw global const public private protected ' +
  'abstract final readonly var list isset unset empty exit die include require include_once require_once clone yield match and or xor declare goto').split(' '));
const MODS = new Set(['public', 'protected', 'private', 'static', 'abstract', 'final', 'readonly', 'var']);
const OPEN = { '(': ')', '[': ']', '{': '}' };

const isNameStart = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 92 || c >= 128;
const isNameChar = (c) => isNameStart(c) || (c >= 48 && c <= 57);

/**
 * Лексер: PHP-вставки превращаются в токены {k, v, s, e, l}; HTML пропускается.
 * k: name (идентификатор, в т.ч. с обратными слэшами), var, str, num, op.
 */
function lex(src) {
  const T = [];
  const n = src.length;
  let i = 0, line = 1;
  const push = (k, v, s, e, l) => T.push({ k, v, s, e, l });
  const reOpen = /<\?(?:php(?=\s|$)|=)?/gi;
  while (i < n) {
    reOpen.lastIndex = i;
    let m, found = null;
    while ((m = reOpen.exec(src))) {
      if (/^<\?xml/i.test(src.slice(m.index, m.index + 5)) && m[0] === '<?') continue;
      found = m;
      break;
    }
    if (!found) break;
    for (let k = i; k < found.index; k++) if (src.charCodeAt(k) === 10) line++;
    i = found.index + found[0].length;
    if (found[0] === '<?=') push('name', 'echo', found.index, i, line);
    while (i < n) {
      const c = src.charCodeAt(i);
      if (c === 10) { line++; i++; continue; }
      if (c === 32 || c === 9 || c === 13) { i++; continue; }
      const c2 = src.charCodeAt(i + 1);
      if (c === 63 && c2 === 62) { // ?>
        i += 2;
        if (src.charCodeAt(i) === 10) { line++; i++; } else if (src.charCodeAt(i) === 13 && src.charCodeAt(i + 1) === 10) { line++; i += 2; }
        push('op', ';', i, i, line);
        break;
      }
      if ((c === 47 && c2 === 47) || (c === 35 && c2 !== 91)) { // // и # комментарии
        while (i < n) {
          const d = src.charCodeAt(i);
          if (d === 10 || (d === 63 && src.charCodeAt(i + 1) === 62)) break;
          i++;
        }
        continue;
      }
      if (c === 47 && c2 === 42) { // /* */
        const end = src.indexOf('*/', i + 2);
        const stop = end === -1 ? n : end + 2;
        for (let k = i; k < stop; k++) if (src.charCodeAt(k) === 10) line++;
        i = stop;
        continue;
      }
      if (c === 39 || c === 34 || c === 96) { // строки '…' "…" `…`
        const s = i, l0 = line;
        i++;
        let raw = '';
        while (i < n) {
          const d = src.charCodeAt(i);
          if (d === 92) { raw += src.slice(i, i + 2); if (src.charCodeAt(i + 1) === 10) line++; i += 2; continue; }
          if (d === c) break;
          if (d === 10) line++;
          raw += src[i];
          i++;
        }
        i++;
        let v = raw;
        if (c === 39) v = raw.replace(/\\(['\\])/g, '$1');
        else if (c === 34) v = raw.replace(/\\(["\\])/g, '$1');
        push('str', v, s, i, l0);
        continue;
      }
      if (c === 60 && c2 === 60 && src.charCodeAt(i + 2) === 60) { // heredoc/nowdoc
        const hm = /^<<<[ \t]*(["']?)([A-Za-z_]\w*)\1\r?\n/.exec(src.slice(i, i + 200));
        if (hm) {
          const s = i, l0 = line;
          const bodyStart = i + hm[0].length;
          const re = new RegExp('\\r?\\n[ \\t]*' + hm[2] + '\\b', 'g');
          re.lastIndex = bodyStart - 1;
          const em = re.exec(src);
          const stop = em ? em.index + em[0].length : n;
          const raw = src.slice(bodyStart, em ? em.index : n);
          for (let k = i; k < stop; k++) if (src.charCodeAt(k) === 10) line++;
          i = stop;
          push('str', raw, s, i, l0);
          continue;
        }
      }
      if (c === 36 && isNameStart(c2) && c2 !== 92) { // $var
        const s = i;
        i++;
        while (i < n && isNameChar(src.charCodeAt(i)) && src.charCodeAt(i) !== 92) i++;
        push('var', src.slice(s + 1, i), s, i, line);
        continue;
      }
      if (isNameStart(c)) {
        const s = i;
        i++;
        while (i < n && isNameChar(src.charCodeAt(i))) i++;
        push('name', src.slice(s, i), s, i, line);
        continue;
      }
      if (c >= 48 && c <= 57) {
        const s = i;
        i++;
        while (i < n && /[0-9a-zA-Z_.]/.test(src[i]) && !(src[i] === '.' && !/[0-9]/.test(src[i + 1] || ''))) i++;
        push('num', src.slice(s, i), s, i, line);
        continue;
      }
      const three = src.substr(i, 3), two = src.substr(i, 2);
      if (three === '...') { push('op', '...', i, i + 3, line); i += 3; continue; }
      if (three === '?->') { push('op', '?->', i, i + 3, line); i += 3; continue; }
      if (two === '::' || two === '->' || two === '=>' || two === '#[') { push('op', two, i, i + 2, line); i += 2; continue; }
      push('op', src[i], i, i + 1, line);
      i++;
    }
  }
  return T;
}

/**
 * Парные скобки (), [], {}: match[i] — индекс парной скобки или -1.
 */
function matchBrackets(T) {
  const match = new Array(T.length).fill(-1);
  const stack = [];
  for (let i = 0; i < T.length; i++) {
    const t = T[i];
    if (t.k !== 'op') continue;
    if (OPEN[t.v]) stack.push(i);
    else if (t.v === ')' || t.v === ']' || t.v === '}') {
      while (stack.length) {
        const o = stack.pop();
        if (OPEN[T[o].v] === t.v) { match[o] = i; match[i] = o; break; }
      }
    }
  }
  return match;
}

const collapse = (s, max) => {
  s = s.replace(/\s+/g, ' ').trim();
  return max && s.length > max ? s.slice(0, max - 1) + '…' : s;
};

/**
 * Разбор PHP-файла: объявления, импорты, ссылки на классы и функции, подключения,
 * вызовы IncludeComponent, includeModule, обработчики событий, языковые ключи.
 * @param {string} src - текст файла (уже в UTF-8).
 * @returns {object} сырые данные файла.
 */
function parsePhp(src) {
  const T = lex(src);
  const match = matchBrackets(T);
  const lc = (t) => (t && t.k === 'name' ? t.v.toLowerCase() : '');
  const isOp = (t, v) => !!t && t.k === 'op' && t.v === v;
  const out = {
    loc: src.split('\n').length, ns: '', imports: [], decls: [], funcs: [], consts: [],
    refs: [], calls: [], comps: [], mods: [], events: [], fires: [], incs: [], msgs: [], ark: [], apk: [], params: []
  };
  const slice = (a, b) => src.slice(T[a].s, T[b].e);

  // ---------- структура: namespace, use, классы, функции, константы ----------
  const uses = new Map(); // псевдоним (нижний регистр) → полное имя
  const traitNames = [];
  let ns = '';

  const fq = (name) => (ns ? ns + '\\' + name : name);

  function parseUse(i) { // use A\B; use A\B as C; use A\{B, C as D}; use function …
    let j = i + 1;
    let kind = 'class';
    if (lc(T[j]) === 'function' || lc(T[j]) === 'const') { kind = lc(T[j]); j++; }
    const end = (() => { let k = j; while (k < T.length && !isOp(T[k], ';')) { if (match[k] > k && T[k].k === 'op' && OPEN[T[k].v]) k = match[k]; k++; } return k; })();
    const one = (prefix, a, b) => { // a..b — токены одного импорта
      if (T[a] && T[a].k === 'name') {
        const full = (prefix + T[a].v).replace(/^\\/, '');
        let alias = full.split('\\').pop();
        if (lc(T[a + 1]) === 'as' && T[a + 2]) alias = T[a + 2].v;
        if (kind === 'class') { uses.set(alias.toLowerCase(), full); out.imports.push([full, T[a].l]); }
      }
    };
    let k = j;
    while (k < end) {
      if (T[k].k === 'name' && isOp(T[k + 1], '{') && T[k].v.endsWith('\\')) { // групповой импорт
        const prefix = T[k].v;
        const close = match[k + 1];
        let m = k + 2;
        while (m < close) { one(prefix, m, close); while (m < close && !isOp(T[m], ',')) m++; m++; }
        k = close + 1;
        continue;
      }
      one('', k, end);
      while (k < end && !isOp(T[k], ',')) k++;
      k++;
    }
    return end;
  }

  function params(open) { // текст параметров между скобками
    return open >= 0 && match[open] > open ? collapse(slice(open, match[open]), 160) : '()';
  }

  function parseFunction(i, cls) {
    let j = i + 1;
    if (isOp(T[j], '&')) j++;
    if (!T[j] || T[j].k !== 'name') return null; // closure
    const nameTok = T[j];
    let open = j + 1;
    if (!isOp(T[open], '(')) return null;
    // начало: модификаторы слева
    let start = i;
    const mods = [];
    for (let m = i - 1; m >= 0 && MODS.has(lc(T[m])); m--) { mods.unshift(lc(T[m])); start = m; }
    // конец заголовка: { или ;
    let k = match[open] + 1;
    while (k < T.length && !isOp(T[k], '{') && !isOp(T[k], ';')) { if (T[k].k === 'op' && OPEN[T[k].v] && match[k] > k) k = match[k]; k++; }
    const bodyOpen = isOp(T[k], '{') ? k : -1;
    let endTok = bodyOpen >= 0 ? match[bodyOpen] : k;
    if (endTok < 0 || endTok >= T.length) endTok = T.length - 1;
    const hdrEnd = Math.min(k - 1, T.length - 1);
    const sig = collapse(slice(start, hdrEnd >= start ? hdrEnd : i), 200);
    return {
      f: { name: nameTok.v, vis: mods.find((m) => ['public', 'protected', 'private'].includes(m)) || 'public',
        st: mods.includes('static'), ab: mods.includes('abstract'), sig, line: T[start].l, end: T[endTok].l },
      bodyOpen, bodyClose: bodyOpen >= 0 ? endTok : -1, next: bodyOpen >= 0 ? endTok + 1 : k + 1
    };
  }

  function tableInfo(cls, bodies) { // ORM: getTableName / getMap
    const gt = bodies.gettablename;
    if (gt) {
      for (let k = gt[0]; k < gt[1]; k++) if (lc(T[k]) === 'return' && T[k + 1] && T[k + 1].k === 'str') { cls.table = T[k + 1].v; break; }
    }
    const gm = bodies.getmap;
    if (gm) {
      const fields = [];
      for (let k = gm[0]; k < gm[1] && fields.length < 80; k++) {
        const t = T[k];
        if (t.k === 'name' && lc(T[k - 1]) === 'new' && isOp(T[k + 1], '(') && T[k + 2] && T[k + 2].k === 'str') {
          const short = t.v.split('\\').pop();
          fields.push(T[k + 2].v + ':' + short.replace(/Field$/, '').toLowerCase());
        } else if (t.k === 'str' && isOp(T[k + 1], '=>') && isOp(T[k + 2], '[')) {
          const close = match[k + 2];
          for (let m = k + 3; m < close; m++) {
            if (T[m].k === 'str' && T[m].v === 'data_type' && isOp(T[m + 1], '=>') && T[m + 2] && T[m + 2].k === 'str') { fields.push(t.v + ':' + T[m + 2].v); break; }
          }
          k = close;
        }
      }
      if (fields.length) cls.fields = fields;
    }
  }

  function parseClass(i) {
    const kind = lc(T[i]);
    const nameTok = T[i + 1];
    let j = i + 2;
    const cls = { kind, name: nameTok.v, fqn: fq(nameTok.v), line: T[i].l, end: T[i].l, ext: [], impl: [], mods: [], members: [] };
    for (let m = i - 1; m >= 0 && ['abstract', 'final', 'readonly'].includes(lc(T[m])); m--) { cls.mods.unshift(lc(T[m])); cls.line = T[m].l; }
    let mode = '';
    while (j < T.length && !isOp(T[j], '{') && !isOp(T[j], ';')) {
      const w = lc(T[j]);
      if (w === 'extends' || w === 'implements') mode = w;
      else if (T[j].k === 'name') { if (mode === 'extends') cls.ext.push(T[j].v); else if (mode === 'implements') cls.impl.push(T[j].v); }
      j++;
    }
    if (!isOp(T[j], '{')) { out.decls.push(cls); return j + 1; }
    const close = match[j];
    cls.end = close >= 0 ? T[close].l : T[j].l;
    const bodies = {};
    let k = j + 1;
    while (k < close) {
      const t = T[k];
      const w = lc(t);
      if (w === 'function') {
        const r = parseFunction(k, cls);
        if (r) {
          cls.members.push({ n: r.f.name, k: 'method', v: r.f.vis, s: r.f.st ? 1 : 0, a: r.f.ab ? 1 : 0, sig: r.f.sig, l: r.f.line, e: r.f.end });
          if (r.bodyOpen >= 0) bodies[r.f.name.toLowerCase()] = [r.bodyOpen, r.bodyClose];
          k = r.next;
          continue;
        }
      } else if (w === 'const') {
        let m = k + 1;
        while (m < close && !isOp(T[m], ';')) {
          if (T[m].k === 'name' && isOp(T[m + 1], '=')) cls.members.push({ n: T[m].v, k: 'const', l: T[m].l, e: T[m].l });
          if (T[m].k === 'op' && OPEN[T[m].v] && match[m] > m) m = match[m];
          m++;
        }
        k = m + 1;
        continue;
      } else if (w === 'case' && kind === 'enum' && T[k + 1] && T[k + 1].k === 'name') {
        cls.members.push({ n: T[k + 1].v, k: 'case', l: t.l, e: t.l });
      } else if (w === 'use') {
        let m = k + 1;
        while (m < close && !isOp(T[m], ';') && !isOp(T[m], '{')) { if (T[m].k === 'name') traitNames.push(T[m].v); m++; }
        if (isOp(T[m], '{') && match[m] > 0) m = match[m];
        k = m + 1;
        continue;
      } else if (t.k === 'op' && OPEN[t.v] && match[k] > k) { k = match[k]; }
      k++;
    }
    tableInfo(cls, bodies);
    out.decls.push(cls);
    return close + 1;
  }

  const isDeclKeyword = (i) => {
    const w = lc(T[i]), prev = T[i - 1], nx = T[i + 1];
    if (!['class', 'interface', 'trait', 'enum'].includes(w)) return false;
    if (isOp(prev, '::') || isOp(prev, '->') || isOp(prev, '?->') || ['new', 'instanceof'].includes(lc(prev))) return false;
    if (!nx || nx.k !== 'name' || KEYWORDS.has(lc(nx))) return false;
    if (w === 'enum') return isOp(T[i + 2], '{') || isOp(T[i + 2], ':') || lc(T[i + 2]) === 'implements';
    return true;
  };

  for (let i = 0; i < T.length;) {
    const t = T[i];
    if (t.k !== 'name') { i++; continue; }
    const w = lc(t);
    const prev = T[i - 1];
    const afterAccess = isOp(prev, '->') || isOp(prev, '?->') || isOp(prev, '::');
    if (w === 'namespace' && !afterAccess && T[i + 1] && (T[i + 1].k === 'name' || isOp(T[i + 1], '{'))) {
      if (T[i + 1].k === 'name') { ns = T[i + 1].v.replace(/^\\/, ''); if (!out.ns) out.ns = ns; }
      else ns = '';
      i += 2;
      continue;
    }
    if (w === 'use' && !afterAccess && T[i + 1] && T[i + 1].k === 'name') { i = parseUse(i) + 1; continue; }
    if (isDeclKeyword(i)) {
      i = parseClass(i);
      continue;
    }
    if (w === 'function' && !afterAccess) {
      const r = parseFunction(i, null);
      if (r) {
        out.funcs.push({ n: r.f.name, f: fq(r.f.name), sig: r.f.sig, l: r.f.line, e: r.f.end });
        i = r.next;
        continue;
      }
    }
    if (w === 'const' && !afterAccess && T[i + 1] && T[i + 1].k === 'name' && isOp(T[i + 2], '=') && (!prev || isOp(prev, ';') || isOp(prev, '{') || isOp(prev, '}'))) {
      out.consts.push([fq(T[i + 1].v), T[i].l]);
    }
    if (w === 'define' && isOp(T[i + 1], '(') && T[i + 2] && T[i + 2].k === 'str') out.consts.push([T[i + 2].v, T[i].l]);
    i++;
  }
  out.imports = out.imports.slice(0, 200);

  // ---------- ссылки на классы и функции ----------
  const seenRef = new Set(), seenCall = new Set();
  const cands = (name) => {
    if (name.startsWith('\\')) return [name.slice(1).toLowerCase()];
    const parts = name.split('\\');
    const first = parts[0].toLowerCase();
    if (uses.has(first)) return [[uses.get(first)].concat(parts.slice(1)).join('\\').toLowerCase()];
    if (first === 'namespace') return [fq(parts.slice(1).join('\\')).toLowerCase()];
    const r = [];
    if (out.ns) r.push((out.ns + '\\' + name).toLowerCase());
    r.push(name.toLowerCase());
    return r;
  };
  const addRef = (name) => {
    if (!name || KEYWORDS.has(name.toLowerCase())) return;
    const c = cands(name).join('|');
    if (!seenRef.has(c) && seenRef.size < 400) { seenRef.add(c); out.refs.push(c); }
  };
  for (const r of traitNames) addRef(r);
  for (const [full] of out.imports) { const c = full.toLowerCase(); if (!seenRef.has(c)) { seenRef.add(c); out.refs.push(c); } }
  for (const d of out.decls) for (const x of d.ext.concat(d.impl)) addRef(x);
  for (const d of out.decls) d.extc = d.ext.map((x) => cands(x).join('|')); // предки с учётом namespace и use

  const callArgs = (open) => { // диапазоны токенов аргументов вызова
    const close = match[open];
    if (close < 0) return [];
    const args = [];
    let a = open + 1;
    for (let k = open + 1; k < close; k++) {
      if (T[k].k === 'op' && OPEN[T[k].v] && match[k] > k) { k = match[k]; continue; }
      if (isOp(T[k], ',')) { if (k > a) args.push([a, k - 1]); a = k + 1; }
    }
    if (close > a) args.push([a, close - 1]);
    return args;
  };
  const argStr = (r) => (r && r[0] === r[1] && T[r[0]].k === 'str' ? T[r[0]].v : null);
  const argText = (r, max) => (r ? collapse(slice(r[0], r[1]), max || 100) : '');

  // вычисление пути в require/include: {b: 'doc'|'dir'|'dirup'|'rel', r: 'путь'} или null
  function evalPath(a, b) {
    const segs = [];
    let cur = [];
    for (let k = a; k <= b; k++) {
      if (isOp(T[k], '.')) { segs.push(cur); cur = []; continue; }
      cur.push(T[k]);
      if (T[k].k === 'op' && OPEN[T[k].v] && match[k] > k) { for (let m = k + 1; m <= match[k]; m++) cur.push(T[m]); k = match[k]; }
    }
    segs.push(cur);
    let base = null, rel = '';
    for (let si = 0; si < segs.length; si++) {
      const p = segs[si];
      if (!p.length) return null;
      const t0 = p[0];
      if (p.length === 1 && t0.k === 'str') { rel += t0.v; continue; }
      // константы старого API: BX_ROOT, SITE_DIR, SITE_TEMPLATE_PATH
      const cname = p.length === 1 && t0.k === 'name' ? t0.v.toUpperCase() : '';
      if (cname === 'BX_ROOT' || cname === 'BX_PERSONAL_ROOT') { if (si === 0) base = 'doc'; rel += '/bitrix'; continue; }
      if (cname === 'SITE_DIR') { if (si === 0) base = 'doc'; rel += '/'; continue; }
      if (cname === 'SITE_TEMPLATE_PATH') { if (si === 0) base = 'doc'; rel += '{TPL}'; continue; }
      if (si > 0) return null;
      if (p.length === 1 && t0.k === 'name' && /^__dir__$/i.test(t0.v)) { base = 'dir'; continue; }
      if (t0.k === 'name' && /^dirname$/i.test(t0.v)) {
        const inner = p.slice(2, -1).map((t) => t.v).join('');
        if (/^__file__$/i.test(inner)) { base = 'dir'; continue; }
        if (/^__dir__$/i.test(inner)) { base = 'dirup'; continue; }
        return null;
      }
      if (t0.k === 'var' && t0.v === '_SERVER' && p.some((t) => t.k === 'str' && t.v === 'DOCUMENT_ROOT')) { base = 'doc'; continue; }
      if (p.some((t) => t.k === 'name' && /getdocumentroot$/i.test(t.v))) { base = 'doc'; continue; }
      if (p.length === 1 && t0.k === 'var' && /^(documentroot|docroot|_docroot)$/i.test(t0.v)) { base = 'doc'; continue; }
      return null;
    }
    if (base === null && !rel) return null;
    return { b: base || 'rel', r: rel };
  }

  const BUILTIN_CALLS = new Set(('strlen count define defined function_exists dirname basename file_exists is_array is_string is_numeric is_null in_array array_merge array_keys ' +
  'array_values array_map array_filter array_key_exists array_push array_pop array_shift array_unshift array_slice array_splice array_unique array_search array_reverse array_diff ' +
  'array_intersect array_sum array_column array_combine array_flip array_fill array_key_first array_key_last sprintf printf implode explode trim rtrim ltrim str_replace substr ' +
  'strpos strrpos strtolower strtoupper json_encode json_decode intval floatval strval boolval htmlspecialchars print_r var_dump var_export date time mktime strtotime ' +
  'preg_match preg_match_all preg_replace preg_replace_callback preg_split number_format round floor ceil min max abs sizeof is_int is_bool is_float is_object is_callable ' +
  'method_exists class_exists get_class call_user_func call_user_func_array file_get_contents file_put_contents mb_strlen mb_substr mb_strtolower mb_strtoupper mb_strpos md5 sha1 ' +
  'uniqid rand mt_rand random_int header session_start setcookie range compact extract ksort asort usort uasort sort rsort str_contains str_starts_with str_ends_with ucfirst nl2br ' +
  'strip_tags addslashes urlencode urldecode http_build_query parse_str parse_url is_file is_dir mkdir unlink fopen fclose fwrite fgets array_walk iterator_to_array spl_autoload_register ' +
  'trigger_error error_log set_error_handler ini_set error_reporting ob_start ob_get_clean ob_end_clean ucwords lcfirst str_repeat str_pad strcmp strcasecmp strrev wordwrap ' +
  'array_rand shuffle array_multisort array_chunk array_pad array_fill_keys array_count_values array_product current key next reset end prev each define constant').split(' '));
  const noCall = new Set(['array', 'list', 'isset', 'unset', 'empty', 'exit', 'die', 'echo', 'print', 'if', 'elseif', 'while', 'for', 'foreach', 'switch', 'catch', 'match', 'fn', 'function', 'use', 'declare', 'return', 'include', 'require', 'include_once', 'require_once', 'new', 'and', 'or']);
  const seenArk = new Set(), seenApk = new Set(), seenMsg = new Set();
  for (let i = 0; i < T.length; i++) {
    const t = T[i];
    if (t.k === 'var' && (t.v === 'arResult' || t.v === 'arParams') && isOp(T[i + 1], '[') && T[i + 2] && T[i + 2].k === 'str' && isOp(T[i + 3], ']')) {
      const set = t.v === 'arResult' ? seenArk : seenApk;
      if (!set.has(T[i + 2].v) && set.size < 80) { set.add(T[i + 2].v); (t.v === 'arResult' ? out.ark : out.apk).push(T[i + 2].v); }
      continue;
    }
    if (t.k !== 'name') continue;
    const w = t.v.toLowerCase();
    const prev = T[i - 1], next = T[i + 1];
    const viaObj = isOp(prev, '->') || isOp(prev, '?->');
    const viaStatic = isOp(prev, '::');
    const bare = w.split('\\').pop();

    if (isOp(next, '(')) {
      const args = callArgs(i + 1);
      const fn = bare;
      if (fn === 'includefile' && args.length) { // $APPLICATION->IncludeFile(SITE_DIR."include/x.php")
        const pr = evalPath(args[0][0], args[0][1]);
        if (pr) out.incs.push({ b: pr.b, r: pr.r, l: t.l });
      } else if (fn === 'includecomponent' && args.length) {
        const id = argStr(args[0]);
        out.comps.push([id || '?', args[1] ? (argStr(args[1]) !== null ? argStr(args[1]) : '?') : '', t.l]);
        if (id && id.toLowerCase() === 'bitrix:main.include' && args[2]) { // включаемая область: параметр PATH
          const r2 = args[2];
          for (let k = r2[0]; k < r2[1]; k++) {
            if (T[k].k === 'str' && T[k].v === 'PATH' && isOp(T[k + 1], '=>')) {
              let j = k + 2;
              while (j < r2[1] && !isOp(T[j], ',')) { if (T[j].k === 'op' && OPEN[T[j].v] && match[j] > j) j = match[j]; j++; }
              const pr = j - 1 >= k + 2 ? evalPath(k + 2, j - 1) : null;
              if (pr) out.incs.push({ b: pr.b, r: pr.r, l: t.l });
              break;
            }
          }
        }
      } else if (['includemodule', 'requiremodule', 'includesharewaremodule', 'isinstalled'].includes(fn) && args.length && argStr(args[0]) && fn !== 'isinstalled') {
        out.mods.push([argStr(args[0]), t.l]);
      } else if (['addeventhandler', 'addeventhandlercompatible'].includes(fn) && args.length >= 3) {
        out.events.push({ m: argStr(args[0]) || argText(args[0], 40), e: argStr(args[1]) || argText(args[1], 40), c: argText(args[2], 100), k: 'add', l: t.l });
      } else if (['registereventhandler', 'registereventhandlercompatible', 'registermoduledependences'].includes(fn) && args.length >= 4) {
        const cls = argStr(args[3]) || argText(args[3], 50);
        const meth = args[4] ? (argStr(args[4]) || argText(args[4], 40)) : '';
        out.events.push({ m: argStr(args[0]) || argText(args[0], 40), e: argStr(args[1]) || argText(args[1], 40), c: (cls + (meth ? '::' + meth : '')).slice(0, 100), k: 'register', l: t.l });
      } else if (fn === 'getmoduleevents' && args.length >= 2) {
        out.fires.push({ m: argStr(args[0]) || argText(args[0], 40), e: argStr(args[1]) || argText(args[1], 40), l: t.l });
      } else if (fn === 'getmessage' && args.length && argStr(args[0])) {
        const key = argStr(args[0]);
        if (!seenMsg.has(key) && seenMsg.size < 200) { seenMsg.add(key); out.msgs.push([key, t.l]); }
      }
    }
    if (['require', 'include', 'require_once', 'include_once'].includes(w) && !viaObj && !viaStatic) {
      let a = i + 1, b = a;
      if (isOp(T[a], '(') && match[a] > a && (match[a] + 1 >= T.length || isOp(T[match[a] + 1], ';'))) { b = match[a] - 1; a++; }
      else { while (b < T.length && !isOp(T[b], ';')) { if (T[b].k === 'op' && OPEN[T[b].v] && match[b] > b) b = match[b]; b++; } b--; }
      const p = a <= b ? evalPath(a, b) : null;
      if (p) out.incs.push({ b: p.b, r: p.r, l: t.l });
      continue;
    }
    // ссылки на классы
    if (!KEYWORDS.has(w) && !viaObj) {
      const prevW = lc(prev);
      if (isOp(next, '::') && !viaStatic) addRef(t.v);
      else if (prevW === 'new' || prevW === 'instanceof') addRef(t.v);
      else if (isOp(prev, '(') && lc(T[i - 2]) === 'catch') addRef(t.v);
      else if (isOp(next, '(') && !viaStatic && !noCall.has(w) && !BUILTIN_CALLS.has(w) && prevW !== 'function' && prevW !== 'class') {
        const nm = w.replace(/^\\/, '');
        if (!seenCall.has(nm) && seenCall.size < 300) {
          seenCall.add(nm);
          out.calls.push(out.ns && !t.v.includes('\\') ? [(out.ns + '\\' + t.v).toLowerCase(), nm] : [nm]);
        }
      }
    }
  }
  out.refs = [...new Set(out.refs)];
  return out;
}

/**
 * Языковой файл: $MESS['KEY'] = 'текст'; → [[ключ, значение(до 120 симв.), строка]].
 */
function parseLang(src) {
  const T = lex(src);
  const res = [];
  for (let i = 0; i + 5 < T.length; i++) {
    const t = T[i];
    if (t.k === 'var' && t.v === 'MESS' && T[i + 1].v === '[' && T[i + 2].k === 'str' && T[i + 3].v === ']' && T[i + 4].v === '=' && T[i + 5].k === 'str') {
      res.push([T[i + 2].v, collapse(T[i + 5].v, 120), t.l]);
    }
  }
  return res;
}

/**
 * Правила urlrewrite.php: [{c: условие, r: правило, id, p: путь, s: порядок}].
 */
function parseUrlRewrite(src) {
  const T = lex(src);
  const rules = [];
  for (let i = 0; i < T.length; i++) {
    if (T[i].k === 'str' && T[i].v === 'CONDITION' && T[i + 1] && T[i + 1].v === '=>' && T[i + 2] && T[i + 2].k === 'str') {
      const rule = { c: T[i + 2].v, r: '', id: '', p: '', l: T[i].l };
      for (let j = i + 3; j < Math.min(T.length, i + 40); j++) {
        if (T[j].k === 'str' && T[j].v === 'CONDITION') break;
        if (T[j].k === 'str' && T[j + 1] && T[j + 1].v === '=>' && T[j + 2] && T[j + 2].k === 'str') {
          if (T[j].v === 'RULE') rule.r = T[j + 2].v;
          else if (T[j].v === 'ID') rule.id = T[j + 2].v;
          else if (T[j].v === 'PATH') rule.p = T[j + 2].v;
        }
      }
      rules.push(rule);
    }
  }
  return rules;
}

/**
 * Ключи верхнего уровня массива PARAMETERS в .parameters.php компонента.
 */
function parseComponentParams(src) {
  const T = lex(src);
  const match = matchBrackets(T);
  for (let i = 0; i < T.length - 3; i++) {
    if (T[i].k !== 'str' || T[i].v !== 'PARAMETERS' || T[i + 1].v !== '=>') continue;
    let open = -1;
    if (T[i + 2].v === '[') open = i + 2;
    else if (T[i + 2].k === 'name' && /^array$/i.test(T[i + 2].v) && T[i + 3].v === '(') open = i + 3;
    if (open < 0 || match[open] < 0) continue;
    const keys = [];
    for (let k = open + 1; k < match[open]; k++) {
      if (T[k].k === 'str' && T[k + 1] && T[k + 1].v === '=>') keys.push(T[k].v);
      if (T[k].k === 'op' && OPEN[T[k].v] && match[k] > k) k = match[k];
    }
    return keys;
  }
  return [];
}

module.exports = { lex, parsePhp, parseLang, parseUrlRewrite, parseComponentParams, collapse };
