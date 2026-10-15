'use strict';
// spring.js — Spring-специфичные выборки поверх индекса: HTTP-эндпоинты, бины, сущности JPA и репозитории,
// слушатели событий и очередей. Работает с аннотациями, сохранёнными парсером (имя и текст аргументов).

const ann = (list, ...names) => (list || []).find((a) => names.includes(a[0]));
const hasAnn = (list, ...names) => !!ann(list, ...names);

// ---------- аргументы аннотаций ----------
function splitArgs(text) {
  const parts = [];
  let depth = 0, q = null, cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { cur += ch; if (ch === q && text[i - 1] !== '\\') q = null; continue; }
    if (ch === '"') { q = ch; cur += ch; continue; }
    if ('({['.includes(ch)) depth++;
    else if (')}]'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => {
    const m = /^\s*([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]*)$/.exec(p);
    return m ? { k: m[1], v: m[2].trim() } : { k: null, v: p.trim() };
  });
}

/** Значение аргумента аннотации по именам (value/path/…); без имени берётся первый позиционный. */
function annArg(text, ...names) {
  if (!text) return null;
  const args = splitArgs(text);
  const named = args.find((a) => a.k && names.includes(a.k));
  if (named) return named.v;
  if (names.includes('value')) { const pos = args.find((a) => !a.k); if (pos) return pos.v; }
  return null;
}

// ---------- константы и выражения строк ----------
function constTable(idx) {
  const map = new Map();
  for (const n of idx.nodes) for (const d of n.decls) for (const m of d.mem) {
    if (m.k === 'field' && (m.cv !== undefined || m.ie)) map.set(d.n + '.' + m.n, { cv: m.cv, ie: m.ie, owner: d.n });
  }
  return map;
}

function evalExpr(expr, owner, consts, depth) {
  depth = depth || 0;
  const parts = [];
  let q = null, cur = '', paren = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (q) { cur += ch; if (ch === q && expr[i - 1] !== '\\') q = null; continue; }
    if (ch === '"') { q = ch; cur += ch; continue; }
    if (ch === '(') paren++; else if (ch === ')') paren--;
    if (ch === '+' && paren === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => {
    p = p.trim();
    const lit = /^"([\s\S]*)"$/.exec(p);
    if (lit) return lit[1];
    if (/^[A-Za-z_][\w.]*$/.test(p) && depth < 6) {
      const segs = p.split('.');
      const key = segs.length >= 2 ? segs.slice(-2).join('.') : owner + '.' + p;
      const c = consts.get(key);
      if (c) return c.cv !== undefined ? c.cv : evalExpr(c.ie, c.owner, consts, depth + 1);
    }
    return '{' + p + '}';
  }).join('');
}

function evalStrings(v, owner, consts) {
  if (v === null || v === undefined) return [];
  v = v.trim();
  if (v.startsWith('{') && v.endsWith('}')) return splitArgs(v.slice(1, -1)).map((a) => evalExpr(a.v, owner, consts)).filter((x) => x !== '');
  return [evalExpr(v, owner, consts)];
}

const joinPath = (a, b) => {
  const p = ('/' + a + '/' + b).replace(/\/+/g, '/');
  return p.length > 1 ? p.replace(/\/$/, '') : p;
};

// ---------- эндпоинты ----------
const MAPPING = { GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', DeleteMapping: 'DELETE', PatchMapping: 'PATCH', RequestMapping: '*',
  GetExchange: 'GET', PostExchange: 'POST', PutExchange: 'PUT', DeleteExchange: 'DELETE', PatchExchange: 'PATCH', HttpExchange: '*' };
const SECURITY = ['PreAuthorize', 'PostAuthorize', 'Secured', 'RolesAllowed'];
const PARAM_ANN = ['PathVariable', 'RequestParam', 'RequestBody', 'RequestHeader', 'ModelAttribute', 'RequestPart', 'CookieValue'];

function httpMethods(name, args) {
  const base = MAPPING[name];
  if (base !== '*') return [base];
  const found = [...String(args || '').matchAll(/RequestMethod\.(\w+)|"(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)"/g)].map((m) => m[1] || m[2]);
  return found.length ? [...new Set(found)] : ['ANY'];
}

function endpoints(idx, q) {
  const consts = constTable(idx);
  const rows = [];
  for (const n of idx.nodes) for (const d of n.decls) {
    const isCtl = hasAnn(d.ann, 'RestController', 'Controller');
    const isClient = hasAnn(d.ann, 'FeignClient') || d.mem.some((m) => hasAnn(m.ann, 'GetExchange', 'PostExchange', 'PutExchange', 'DeleteExchange', 'PatchExchange'));
    if (!isCtl && !isClient) continue;
    const clsMap = ann(d.ann, 'RequestMapping', 'HttpExchange');
    const clsPaths = clsMap ? evalStrings(annArg(clsMap[1], 'value', 'path', 'url'), d.n, consts) : [];
    const sec0 = ann(d.ann, ...SECURITY);
    for (const m of d.mem) {
      if (m.k !== 'method') continue;
      const mapping = (m.ann || []).find((a) => MAPPING[a[0]]);
      if (!mapping) continue;
      const paths = evalStrings(annArg(mapping[1], 'value', 'path', 'url'), d.n, consts);
      const sec = ann(m.ann, ...SECURITY) || sec0;
      const params = (m.ps || []).map((p) => (p.a.filter((x) => PARAM_ANN.includes(x)).map((x) => '@' + x + ' ').join('')) + p.t + ' ' + p.n).join(', ');
      for (const cp of clsPaths.length ? clsPaths : ['']) for (const mp of paths.length ? paths : ['']) {
        for (const http of httpMethods(mapping[0], mapping[1])) {
          rows.push({
            http, path: joinPath(cp, mp), cls: d.n, method: m.n, params, p: n.p, l: m.l, client: !isCtl,
            sec: sec ? sec[0] + (sec[1] ? '(' + (sec[1].length > 50 ? sec[1].slice(0, 49) + '…' : sec[1]) + ')' : '') : ''
          });
        }
      }
    }
  }
  rows.sort((a, b) => a.path.localeCompare(b.path) || a.http.localeCompare(b.http));
  const lq = (q || '').toLowerCase();
  return rows.filter((r) => !lq || `${r.http} ${r.path} ${r.cls}#${r.method}`.toLowerCase().includes(lq));
}

// ---------- бины ----------
const STEREO = ['SpringBootApplication', 'Configuration', 'RestController', 'Controller', 'ControllerAdvice', 'RestControllerAdvice', 'Service', 'Repository', 'Component', 'ConfigurationProperties', 'FeignClient', 'AutoConfiguration'];
const NOTE_ANN = ['Primary', 'Profile', 'Qualifier', 'ConditionalOnProperty', 'ConditionalOnMissingBean', 'ConditionalOnBean', 'ConditionalOnClass', 'Lazy', 'Scope', 'Order', 'ConditionalOnExpression'];
const TRIVIAL = new Set(['String', 'int', 'long', 'boolean', 'Integer', 'Long', 'Boolean', 'double', 'Double', 'float', 'Object', 'Optional']);

const baseName = (t) => t.replace(/<.*$/, '').replace(/\.\.\.$/, '').trim();
const notes = (list) => (list || []).filter((a) => NOTE_ANN.includes(a[0])).map((a) => '@' + a[0] + (a[1] ? '(' + a[1].slice(0, 40) + ')' : '')).join(' ');

function beans(idx, q) {
  const rows = [];
  for (const n of idx.nodes) for (const d of n.decls) {
    const st = ann(d.ann, ...STEREO);
    const repo = d.k === 'interface' && (d.extT || []).some((t) => /Repository\s*</.test(t));
    if (st || repo) {
      const inj = [...new Set((d.di || []).map(baseName).filter((t) => t && !TRIVIAL.has(t)))];
      rows.push({
        text: `@${st ? st[0] : 'Repository'} ${d.n}` + (d.impl.length ? `  implements ${d.impl.join(', ')}` : '') + (repo ? `  (${d.extT[0]})` : '') +
          (st && st[0] === 'ConfigurationProperties' ? `  prefix=${(annArg(st[1], 'prefix', 'value') || '').replace(/"/g, '')}` : '') +
          (notes(d.ann) ? '  ' + notes(d.ann) : ''),
        p: n.p, l: d.l, inj
      });
    }
    for (const m of d.mem) {
      if (m.k === 'method' && hasAnn(m.ann, 'Bean')) {
        const inj = [...new Set((m.ps || []).map((p) => baseName(p.t)).filter((t) => t && !TRIVIAL.has(t)))];
        rows.push({ text: `@Bean ${m.n} → ${m.ret || '?'}  (${d.n})` + (notes(m.ann) ? '  ' + notes(m.ann) : ''), p: n.p, l: m.l, inj });
      }
    }
  }
  const lq = (q || '').toLowerCase();
  return rows.filter((r) => !lq || (r.text + ' ' + r.inj.join(' ')).toLowerCase().includes(lq));
}

// ---------- JPA ----------
const snake = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const REL = ['OneToMany', 'ManyToOne', 'OneToOne', 'ManyToMany'];

function declByName(idx, name) {
  const simple = baseName(name).split('.').pop();
  for (const n of idx.nodes) for (const d of n.decls) if (d.n === simple) return [n, d];
  return null;
}

function entityFields(idx, d, depth) {
  const lines = [];
  for (const m of d.mem) {
    if (m.k !== 'field' || (m.mods || []).includes('static') || (m.mods || []).includes('transient') || hasAnn(m.ann, 'Transient')) continue;
    const tags = [];
    if (hasAnn(m.ann, 'Id', 'EmbeddedId')) tags.push('PK');
    if (hasAnn(m.ann, 'GeneratedValue')) tags.push('generated');
    if (hasAnn(m.ann, 'Version')) tags.push('version');
    const col = ann(m.ann, 'Column');
    const cname = col ? annArg(col[1], 'name') : null;
    if (cname) tags.push('col=' + cname.replace(/"/g, ''));
    if (col && /unique\s*=\s*true/.test(col[1])) tags.push('unique');
    if (col && /nullable\s*=\s*false/.test(col[1])) tags.push('not null');
    const rel = ann(m.ann, ...REL);
    if (rel) {
      const mb = rel[1] && rel[1].match(/mappedBy\s*=\s*"([^"]*)"/);
      tags.push(rel[0] + (mb ? ' mappedBy=' + mb[1] : ''));
      const jc = ann(m.ann, 'JoinColumn');
      if (jc && annArg(jc[1], 'name')) tags.push('join=' + annArg(jc[1], 'name').replace(/"/g, ''));
      const jt = ann(m.ann, 'JoinTable');
      if (jt && annArg(jt[1], 'name')) tags.push('table=' + annArg(jt[1], 'name').replace(/"/g, ''));
    }
    if (hasAnn(m.ann, 'Enumerated')) tags.push('enum');
    if (hasAnn(m.ann, 'Embedded')) tags.push('embedded');
    lines.push(`${m.n} ${m.t}` + (tags.length ? ' [' + tags.join(', ') + ']' : ''));
  }
  const parent = d.ext[0] && depth < 4 ? declByName(idx, d.ext[0]) : null;
  if (parent && hasAnn(parent[1].ann, 'MappedSuperclass', 'Entity')) {
    for (const l of entityFields(idx, parent[1], depth + 1)) lines.push(l + `  (от ${parent[1].n})`);
  }
  return lines;
}

function entities(idx, q) {
  const consts = constTable(idx);
  const repos = new Map();
  for (const n of idx.nodes) for (const d of n.decls) {
    if (d.k !== 'interface') continue;
    for (const t of d.extT || []) {
      const m = /Repository\s*<\s*([\w.]+)/.exec(t);
      if (m) { const k = m[1].split('.').pop(); if (!repos.has(k)) repos.set(k, []); repos.get(k).push({ d, n }); }
    }
  }
  const rows = [];
  for (const n of idx.nodes) for (const d of n.decls) {
    if (!hasAnn(d.ann, 'Entity', 'Embeddable', 'MappedSuperclass')) continue;
    const t = ann(d.ann, 'Table');
    const ent = ann(d.ann, 'Entity');
    let table = null;
    if (hasAnn(d.ann, 'Entity')) {
      const v = t ? annArg(t[1], 'name') : null;
      table = v ? evalStrings(v, d.n, consts)[0] : snake((ent && annArg(ent[1], 'name') ? annArg(ent[1], 'name').replace(/"/g, '') : d.n));
      if (!v) table += ' (по умолчанию)';
    }
    const kind = hasAnn(d.ann, 'Entity') ? 'entity' : hasAnn(d.ann, 'Embeddable') ? 'embeddable' : 'mapped-superclass';
    rows.push({ d, n, kind, table, repos: repos.get(d.n) || [] });
  }
  const lq = (q || '').toLowerCase();
  return rows.filter((r) => !lq || r.d.n.toLowerCase().includes(lq) || (r.table || '').toLowerCase().replace(' (по умолчанию)', '') === lq || (r.table || '').toLowerCase().includes(lq));
}

// ---------- слушатели и планировщик ----------
const LISTEN = ['EventListener', 'TransactionalEventListener', 'KafkaListener', 'RabbitListener', 'JmsListener', 'SqsListener', 'StreamListener', 'Scheduled', 'PostConstruct'];

function listeners(idx, q) {
  const consts = constTable(idx);
  const rows = [];
  const lq = (q || '').toLowerCase();
  for (const n of idx.nodes) {
    for (const d of n.decls) for (const m of d.mem) {
      if (m.k !== 'method') continue;
      for (const a of m.ann || []) {
        if (!LISTEN.includes(a[0]) || a[0] === 'PostConstruct') continue;
        let info = '';
        const ev = (m.ps && m.ps[0] && m.ps[0].t) || '';
        if (a[0] === 'EventListener' || a[0] === 'TransactionalEventListener') info = 'событие ' + (annArg(a[1], 'classes', 'value') || ev || '?');
        else if (a[0] === 'KafkaListener') info = 'topics=' + (evalStrings(annArg(a[1], 'topics', 'value'), d.n, consts).join(',') || annArg(a[1], 'topicPattern') || '?') + (annArg(a[1], 'groupId') ? ' group=' + evalStrings(annArg(a[1], 'groupId'), d.n, consts).join(',') : '');
        else if (a[0] === 'RabbitListener') info = 'queues=' + (evalStrings(annArg(a[1], 'queues', 'value'), d.n, consts).join(',') || a[1].slice(0, 60));
        else if (a[0] === 'Scheduled') info = a[1].slice(0, 60);
        else info = a[1].slice(0, 60);
        rows.push({ text: `@${a[0]} ${info}  → ${d.n}#${m.n}`, p: n.p, l: m.l });
      }
    }
    for (const [type, l] of n.pub || []) rows.push({ text: `publishEvent ${type}`, p: n.p, l });
    for (const [recv, meth, first, second, l] of n.snd || []) {
      const dest = first.startsWith('"') ? first.replace(/"/g, '') : evalExpr(first, '', consts);
      rows.push({ text: `${recv}.${meth}(${dest}${second ? ', ' + second : ''})`, p: n.p, l });
    }
  }
  return rows.filter((r) => !lq || r.text.toLowerCase().includes(lq));
}

module.exports = { TRIVIAL, annArg, splitArgs, evalExpr, evalStrings, constTable, endpoints, beans, entities, entityFields, listeners, hasAnn, ann, baseName, declByName };
