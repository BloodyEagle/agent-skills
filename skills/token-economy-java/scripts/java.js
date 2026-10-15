'use strict';
// java.js — лёгкий разбор Java 17+ без зависимостей: пакет, импорты, типы (class, interface, enum, record,
// @interface), члены с аннотациями, внедрение зависимостей (конструкторы, @Autowired, Lombok), ссылки на типы,
// обращения к свойствам (@Value, @ConfigurationProperties), публикация событий и отправка сообщений.

const MODS = new Set(['public', 'protected', 'private', 'static', 'final', 'abstract', 'default', 'synchronized', 'native', 'transient', 'volatile', 'strictfp', 'sealed']);
const TYPE_KW = new Set(['class', 'interface', 'enum', 'record']);
const IGNORE_ANN = new Set(['Override', 'SuppressWarnings', 'SafeVarargs', 'FunctionalInterface', 'Nullable', 'NonNull', 'Nonnull', 'Deprecated', 'SuppressFBWarnings']);
const OPEN = { '(': ')', '[': ']', '{': '}' };
const PROP_ANN = new Set(['Value', 'ConfigurationProperties', 'ConditionalOnProperty']);

const isIdStart = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c >= 128;
const isIdChar = (c) => isIdStart(c) || (c >= 48 && c <= 57);

/**
 * Лексер: токены {k, v, s, e, l}; k — id, str, chr, num, op. Комментарии пропускаются, текстовые блоки """ поддержаны.
 * Знаки «<» и «>» всегда отдельные токены (удобно считать вложенность generics).
 */
function lex(src) {
  const T = [];
  const n = src.length;
  let i = 0, line = 1;
  const push = (k, v, s, e, l) => T.push({ k, v, s, e, l });
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 10) { line++; i++; continue; }
    if (c === 32 || c === 9 || c === 13 || c === 12) { i++; continue; }
    const c2 = src.charCodeAt(i + 1);
    if (c === 47 && c2 === 47) { while (i < n && src.charCodeAt(i) !== 10) i++; continue; }
    if (c === 47 && c2 === 42) {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let k = i; k < stop; k++) if (src.charCodeAt(k) === 10) line++;
      i = stop;
      continue;
    }
    if (c === 34) { // строка или текстовый блок
      const s = i, l0 = line;
      if (src.startsWith('"""', i)) {
        i += 3;
        let j = i;
        while (j < n && !(src.charCodeAt(j) === 34 && src.startsWith('"""', j))) { if (src.charCodeAt(j) === 92) j++; j++; }
        const raw = src.slice(i, j);
        for (let k = i; k < Math.min(j + 3, n); k++) if (src.charCodeAt(k) === 10) line++;
        i = Math.min(j + 3, n);
        push('str', raw, s, i, l0);
      } else {
        i++;
        let raw = '';
        while (i < n) {
          const d = src.charCodeAt(i);
          if (d === 92) { raw += src.slice(i, i + 2); i += 2; continue; }
          if (d === 34 || d === 10) break;
          raw += src[i];
          i++;
        }
        i++;
        push('str', raw.replace(/\\(["\\])/g, '$1'), s, i, l0);
      }
      continue;
    }
    if (c === 39) { // символьный литерал
      const s = i;
      i++;
      while (i < n && src.charCodeAt(i) !== 39 && src.charCodeAt(i) !== 10) { if (src.charCodeAt(i) === 92) i++; i++; }
      i++;
      push('chr', src.slice(s, i), s, i, line);
      continue;
    }
    if (isIdStart(c)) {
      const s = i;
      i++;
      while (i < n && isIdChar(src.charCodeAt(i))) i++;
      push('id', src.slice(s, i), s, i, line);
      continue;
    }
    if (c >= 48 && c <= 57) {
      const s = i;
      i++;
      while (i < n && /[0-9a-zA-Z_.]/.test(src[i]) && !(src[i] === '.' && !/[0-9]/.test(src[i + 1] || ''))) i++;
      push('num', src.slice(s, i), s, i, line);
      continue;
    }
    const two = src.substr(i, 2);
    if (two === '->' || two === '::') { push('op', two, i, i + 2, line); i += 2; continue; }
    if (src.startsWith('...', i)) { push('op', '...', i, i + 3, line); i += 3; continue; }
    push('op', src[i], i, i + 1, line);
    i++;
  }
  return T;
}

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
 * Разбор .java: возвращает «сырые» данные файла (см. поля ниже); связи между файлами строит index.js.
 */
function parseJava(src) {
  const T = lex(src);
  const match = matchBrackets(T);
  const isOp = (t, v) => !!t && t.k === 'op' && t.v === v;
  const isId = (t, v) => !!t && t.k === 'id' && (v === undefined || t.v === v);
  const out = { loc: src.split('\n').length, pkg: '', imports: [], statics: [], wild: [], decls: [], refs: [], hier: [], di: [], props: [], pub: [], snd: [] };
  const slice = (a, b) => src.slice(T[a].s, T[b].e);

  // ---------- пакет и импорты ----------
  let i = 0;
  const chain = (k) => { // a.b.C или a.b.* → {text, next}; идентификаторы должны чередоваться с точками
    let text = '';
    if (!isId(T[k])) return { text, next: k };
    text = T[k].v;
    k++;
    while (isOp(T[k], '.') && (isId(T[k + 1]) || isOp(T[k + 1], '*'))) { text += '.' + T[k + 1].v; k += 2; }
    return { text, next: k };
  };
  for (; i < T.length; i++) {
    const t = T[i];
    if (isId(t, 'package')) { const c = chain(i + 1); out.pkg = c.text; i = c.next; continue; }
    if (isId(t, 'import')) {
      let k = i + 1, st = false;
      if (isId(T[k], 'static')) { st = true; k++; }
      const c = chain(k);
      if (st) out.statics.push(c.text);
      else if (c.text.endsWith('.*')) out.wild.push(c.text.slice(0, -2));
      else out.imports.push(c.text);
      i = c.next;
      continue;
    }
    break;
  }

  // ---------- модификаторы и аннотации ----------
  function readMods(k) {
    const ann = [], mods = [];
    let sigStart = -1;
    for (;;) {
      const t = T[k];
      if (isOp(t, '@') && isId(T[k + 1]) && T[k + 1].v !== 'interface') {
        const c = chain(k + 1);
        const simple = c.text.split('.').pop();
        let j = c.next, args = '';
        if (isOp(T[j], '(') && match[j] > j) { args = collapse(src.slice(T[j].e, T[match[j]].s), 300); j = match[j] + 1; }
        if (!IGNORE_ANN.has(simple)) ann.push([simple, args, T[k].l]);
        k = j;
        continue;
      }
      if (t && t.k === 'id' && MODS.has(t.v)) { if (sigStart < 0) sigStart = k; mods.push(t.v); k++; continue; }
      if (isId(t, 'non') && isOp(T[k + 1], '-') && isId(T[k + 2], 'sealed')) { mods.push('non-sealed'); k += 3; continue; }
      break;
    }
    return { ann, mods, k, sigStart: sigStart < 0 ? k : sigStart };
  }

  const skipAngle = (k) => { // k указывает на «<»; возвращает индекс после парного «>»
    let d = 0;
    for (; k < T.length; k++) {
      if (isOp(T[k], '<')) d++;
      else if (isOp(T[k], '>')) { d--; if (d === 0) return k + 1; }
      else if (isOp(T[k], '{') || isOp(T[k], ';')) return k;
    }
    return k;
  };

  function parseParams(open) { // [{t: тип, n: имя, a: [аннотации]}]
    const close = match[open];
    const ps = [];
    let a = open + 1, angle = 0;
    const flush = (to) => {
      if (to <= a) return;
      const m = readMods(a);
      let end = to;
      while (end > m.k && !isId(T[end - 1])) end--;
      if (end - 1 < m.k) return;
      const name = T[end - 1].v;
      const typeText = end - 1 > m.k ? collapse(slice(m.k, end - 2), 120) : '';
      ps.push({ t: typeText, n: name, a: m.ann.map((x) => x[0]), av: m.ann.filter((x) => x[1]).map((x) => [x[0], x[1]]) });
    };
    for (let k = open + 1; k < close; k++) {
      const t = T[k];
      if (isOp(t, '<')) angle++;
      else if (isOp(t, '>')) angle = Math.max(0, angle - 1);
      else if (t.k === 'op' && OPEN[t.v] && match[k] > k) k = match[k];
      else if (isOp(t, ',') && angle === 0) { flush(k); a = k + 1; }
    }
    flush(close);
    return ps;
  }

  function typeList(k, stop) { // extends/implements/permits → имена и полный текст типов (с generics)
    const names = [], texts = [];
    let expect = true, from = -1, last = -1;
    const close = () => { if (from >= 0) texts.push(collapse(slice(from, last), 160)); from = -1; };
    while (k < stop && !isOp(T[k], '{')) {
      const t = T[k];
      if (isOp(t, '<')) { const nk = skipAngle(k); last = nk - 1; k = nk; continue; }
      if (isOp(t, ',')) { close(); expect = true; k++; continue; }
      if (isId(t) && !['extends', 'implements', 'permits'].includes(t.v)) {
        if (expect) { const c = chain(k); names.push(c.text); from = k; last = c.next - 1; k = c.next; expect = false; continue; }
      } else if (isId(t)) break;
      k++;
    }
    close();
    return { names, texts, k };
  }

  // ---------- типы ----------
  function parseType(k, ann, mods, outer, startLine) {
    let kw = T[k].v;
    if (isOp(T[k], '@')) { kw = '@interface'; k++; }
    const nameTok = T[k + 1];
    if (!nameTok || !isId(nameTok)) return k + 1;
    let j = k + 2;
    if (isOp(T[j], '<')) j = skipAngle(j);
    const d = {
      k: kw, n: nameTok.v, f: (out.pkg ? out.pkg + '.' : '') + (outer ? outer.f.slice(out.pkg ? out.pkg.length + 1 : 0) + '.' : '') + nameTok.v,
      l: startLine, e: nameTok.l, ann, mods, ext: [], impl: [], perm: [], mem: []
    };
    if (kw === 'record' && isOp(T[j], '(') && match[j] > j) { d.comps = parseParams(j); j = match[j] + 1; }
    while (j < T.length && !isOp(T[j], '{') && !isOp(T[j], ';')) {
      if (isId(T[j], 'extends') || isId(T[j], 'implements') || isId(T[j], 'permits')) {
        const w = T[j].v;
        const r = typeList(j + 1, T.length);
        if (w === 'extends') { d.ext.push(...r.names); (d.extT = d.extT || []).push(...r.texts); }
        else if (w === 'implements') { d.impl.push(...r.names); (d.implT = d.implT || []).push(...r.texts); }
        else d.perm.push(...r.names);
        j = r.k;
      } else j++;
    }
    out.decls.push(d);
    if (!isOp(T[j], '{') || match[j] < 0) return j + 1;
    const close = match[j];
    d.e = T[close].l;
    parseBody(j, close, d);
    deduce(d);
    return close + 1;
  }

  function parseBody(open, close, d) {
    let k = open + 1;
    if (d.k === 'enum') { // константы перечисления
      for (;;) {
        const m = readMods(k);
        k = m.k;
        if (!isId(T[k])) break;
        d.mem.push({ n: T[k].v, k: 'enumconst', l: T[k].l, e: T[k].l });
        k++;
        if (isOp(T[k], '(') && match[k] > k) k = match[k] + 1;
        if (isOp(T[k], '{') && match[k] > k) k = match[k] + 1;
        if (isOp(T[k], ',')) { k++; continue; }
        if (isOp(T[k], ';')) k++;
        break;
      }
    }
    while (k < close) {
      if (isOp(T[k], ';')) { k++; continue; }
      const m = readMods(k);
      const first = k;
      k = m.k;
      const startLine = m.ann.length ? m.ann[0][2] : T[Math.max(m.sigStart, first)].l;
      if (isOp(T[k], '{')) { k = (match[k] > k ? match[k] : k) + 1; continue; }
      if ((isId(T[k]) && TYPE_KW.has(T[k].v) && isId(T[k + 1])) || (isOp(T[k], '@') && isId(T[k + 1], 'interface'))) {
        k = parseType(k, m.ann, m.mods, d, startLine);
        continue;
      }
      // метод, конструктор или поле
      let j = k, angle = 0, lastId = -1, kind = null, paren = -1;
      while (j < close) {
        const t = T[j];
        if (t.k === 'op') {
          if (t.v === '<') angle++;
          else if (t.v === '>') angle = Math.max(0, angle - 1);
          else if (angle === 0 && t.v === '(') { if (lastId >= 0) { kind = 'm'; paren = j; } break; }
          else if (angle === 0 && (t.v === '=' || t.v === ';' || t.v === ',')) { if (lastId >= 0) kind = 'f'; break; }
          else if (angle === 0 && t.v === '{') { if (d.k === 'record' && lastId === k && T[k].v === d.n) kind = 'cc'; break; }
          else if (t.v === '[' && match[j] > j) { j = match[j] + 1; continue; }
          else if (t.v === '@') { j += 2; if (isOp(T[j], '(') && match[j] > j) j = match[j]; }
        } else if (t.k === 'id') lastId = j;
        j++;
      }
      if (kind === 'cc') { // компактный конструктор записи
        const e = match[j] > j ? match[j] : j;
        d.mem.push({ n: d.n, k: 'ctor', sig: 'compact constructor ' + d.n, l: startLine, e: T[e].l, ann: m.ann.map((x) => [x[0], x[1]]) });
        k = e + 1;
        continue;
      }
      if (kind === 'm') {
        const nameIdx = paren - 1;
        const isCtor = nameIdx === k && T[nameIdx].v === d.n;
        const ps = parseParams(paren);
        let q = match[paren] + 1;
        while (q < close && !isOp(T[q], '{') && !isOp(T[q], ';')) { if (T[q].k === 'op' && OPEN[T[q].v] && match[q] > q) q = match[q]; q++; }
        const hasBody = isOp(T[q], '{') && match[q] > q;
        const endTok = hasBody ? match[q] : q;
        const sig = collapse(slice(m.sigStart <= nameIdx ? m.sigStart : k, Math.max(q - 1, nameIdx)), 220);
        const mem = { n: T[nameIdx].v, k: isCtor ? 'ctor' : 'method', sig, l: startLine, e: T[Math.min(endTok, T.length - 1)].l };
        if (m.ann.length) mem.ann = m.ann.map((x) => [x[0], x[1]]);
        if (m.mods.length) mem.mods = m.mods;
        if (isCtor || m.ann.length) { mem.ps = ps.map((p) => ({ t: p.t, n: p.n, a: p.a, av: p.av })); }
        if (!isCtor && nameIdx > k) mem.ret = collapse(slice(k, nameIdx - 1), 100);
        d.mem.push(mem);
        k = Math.min(endTok, T.length - 1) + 1;
        continue;
      }
      if (kind === 'f') {
        const nameIdx = lastId;
        let q = j;
        while (q < close && !isOp(T[q], ';')) { if (T[q].k === 'op' && OPEN[T[q].v] && match[q] > q) q = match[q]; q++; }
        const mem = { n: T[nameIdx].v, k: 'field', t: nameIdx > k ? collapse(slice(k, nameIdx - 1), 100) : '', l: startLine, e: T[Math.min(q, T.length - 1)].l };
        if (m.ann.length) mem.ann = m.ann.map((x) => [x[0], x[1]]);
        if (m.mods.length) mem.mods = m.mods;
        if (isOp(T[j], '=')) {
          mem.init = true;
          if (m.mods.includes('static') && m.mods.includes('final')) { // строковая константа: "a" + "b"
            const parts = [];
            let ok = true;
            for (let r = j + 1; r < q; r++) {
              if (T[r].k === 'str') parts.push(T[r].v);
              else if (!isOp(T[r], '+')) { ok = false; break; }
            }
            if (ok && parts.length) mem.cv = parts.join('');
            else if (q > j + 1) mem.ie = collapse(slice(j + 1, q - 1), 120); // выражение вида BASE + "/users"
          }
        }
        d.mem.push(mem);
        k = Math.min(q, T.length - 1) + 1;
        continue;
      }
      k = j + 1;
    }
  }

  // внедрение зависимостей: типы, которые класс получает от контейнера
  function deduce(d) {
    const has = (names, a) => (a || []).some((x) => names.includes(x[0]));
    const types = [];
    const ctors = d.mem.filter((x) => x.k === 'ctor' && x.ps);
    let ctor = ctors.length === 1 ? ctors[0] : ctors.find((c) => has(['Autowired', 'Inject'], c.ann));
    const managed = d.ann.some((a) => ['ConfigurationProperties', 'Component', 'Service', 'Configuration', 'Repository', 'Controller', 'RestController'].includes(a[0]));
    if (d.k === 'record' && d.comps && managed) types.push(...d.comps.map((p) => p.t)); // запись — бин, а не DTO
    if (ctor) types.push(...ctor.ps.map((p) => p.t));
    for (const mem of d.mem) {
      if (mem.k === 'field' && has(['Autowired', 'Inject', 'Resource'], mem.ann)) types.push(mem.t);
      if (mem.k === 'method' && mem.ps && (has(['Bean', 'Autowired', 'Inject'], mem.ann))) types.push(...mem.ps.map((p) => p.t));
    }
    const lombok = d.ann.map((a) => a[0]);
    if (lombok.includes('RequiredArgsConstructor')) {
      for (const mem of d.mem) if (mem.k === 'field' && (mem.mods || []).includes('final') && !(mem.mods || []).includes('static') && !mem.init) types.push(mem.t);
    }
    if (lombok.includes('AllArgsConstructor')) {
      for (const mem of d.mem) if (mem.k === 'field' && !(mem.mods || []).includes('static')) types.push(mem.t);
    }
    if (types.length) d.di = types.filter(Boolean);
  }

  // ---------- верхний уровень ----------
  while (i < T.length) {
    if (isOp(T[i], ';')) { i++; continue; }
    const m = readMods(i);
    const k = m.k;
    const startLine = m.ann.length ? m.ann[0][2] : T[Math.max(m.sigStart, i)].l;
    if ((isId(T[k]) && TYPE_KW.has(T[k].v) && isId(T[k + 1])) || (isOp(T[k], '@') && isId(T[k + 1], 'interface'))) {
      i = parseType(k, m.ann, m.mods, null, startLine);
    } else i = Math.max(k, i) + 1;
  }

  // ---------- ссылки на типы и прочие обращения (линейный проход) ----------
  const simple = new Set(), qualified = new Set();
  for (let k = 0; k < T.length; k++) {
    const t = T[k];
    if (t.k === 'id' && !isOp(T[k - 1], '.')) {
      if (/^[A-Z]/.test(t.v) && t.v.length > 1) simple.add(t.v);
      else if (/^[a-z]/.test(t.v) && isOp(T[k + 1], '.') && isId(T[k + 2])) { // пакет.Класс
        const c = chain(k);
        const segs = c.text.split('.');
        const ui = segs.findIndex((s) => /^[A-Z]/.test(s));
        if (ui > 0 && segs.slice(0, ui).every((s) => /^[a-z_][\w]*$/.test(s))) qualified.add(segs.slice(0, ui + 1).join('.'));
      }
    }
    // свойства: @Value, @ConfigurationProperties, @ConditionalOnProperty
    if (isOp(t, '@') && isId(T[k + 1]) && PROP_ANN.has(T[k + 1].v)) {
      let j = k + 2;
      let args = '';
      if (isOp(T[j], '(') && match[j] > j) args = collapse(src.slice(T[j].e, T[match[j]].s), 300);
      out.props.push([T[k + 1].v, args, t.l]);
    }
    if (t.k === 'id' && (t.v === 'getProperty' || t.v === 'getRequiredProperty') && isOp(T[k + 1], '(') && T[k + 2] && T[k + 2].k === 'str' && isOp(T[k - 1], '.')) out.props.push(['getProperty', '"' + T[k + 2].v + '"', t.l]);
    // публикация событий и отправка сообщений
    if (t.k === 'id' && t.v === 'publishEvent' && isOp(T[k + 1], '(') && isOp(T[k - 1], '.')) {
      const a = T[k + 2], b = T[k + 3];
      out.pub.push([isId(a, 'new') && isId(b) ? b.v : '?', t.l]);
    }
    if (t.k === 'id' && /(kafka|rabbit|jms|stream|sqs|sns|amqp)/i.test(t.v) && isOp(T[k + 1], '.') && isId(T[k + 2]) &&
        ['send', 'convertAndSend', 'sendAndReceive', 'convertSendAndReceive', 'publish'].includes(T[k + 2].v) && isOp(T[k + 3], '(')) {
      const open = k + 3;
      const close = match[open];
      const args = [];
      let a = open + 1;
      for (let q = open + 1; q < close; q++) {
        if (T[q].k === 'op' && OPEN[T[q].v] && match[q] > q) { q = match[q]; continue; }
        if (isOp(T[q], ',')) { args.push([a, q - 1]); a = q + 1; }
      }
      if (close > a) args.push([a, close - 1]);
      const first = args[0] ? collapse(slice(args[0][0], args[0][1]), 60) : '';
      const second = args[1] ? collapse(slice(args[1][0], args[1][1]), 40) : '';
      out.snd.push([t.v, T[k + 2].v, first, second, t.l]);
    }
  }
  out.refs = [...simple, ...qualified];
  for (const d of out.decls) out.hier.push(...d.ext, ...d.impl, ...d.perm);
  out.hier = [...new Set(out.hier)];
  // «на диск» сохраняем компактные объявления
  for (const d of out.decls) {
    d.ann = d.ann.map((a) => [a[0], a[1]]);
    if (d.di) d.di = [...new Set(d.di)];
  }
  return out;
}

module.exports = { parseJava, lex, collapse };
