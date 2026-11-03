'use strict';
// modx.js — понимание проектов MODX Revolution / Evolution по исходникам.
// Файловые элементы (сниппеты, чанки, плагины, шаблоны в core/components/*/elements и assets/components)
// индексируются; элементы в БД (modSnippet и т. п.) файловому индексу недоступны — это объявляет info.

const KIND_MAP = { snippets: 'snippet', chunks: 'chunk', plugins: 'plugin', templates: 'template' };

/**
 * Классификация пути (относительно корня проекта, начинается с «/»).
 * @returns {{origin: 'core'|'custom', el: object|null, tag: string}}
 */
function classifyModx(p) {
  const r = { origin: 'custom', el: null, tag: '' };
  let m;
  if (/^\/core\/(model|src|lexicon|vendor|cache|packages|docs)\//.test(p) || /^\/connectors\//.test(p) || /^\/manager\//.test(p) || /^\/setup\//.test(p)) r.origin = 'core';
  if ((m = /^\/(?:core|assets)\/components\/([^/]+)\/(?:elements\/)?(snippets|chunks|plugins|templates)\/(.+)$/.exec(p))) {
    const name = m[3].replace(/\.[a-z]+$/i, '');
    r.el = { ns: m[1], kind: KIND_MAP[m[2]], name, id: m[1] + ':' + name };
    r.tag = r.el.kind + ' ' + r.el.id;
  } else if ((m = /^\/assets\/components\/([^/]+)\//.exec(p))) r.tag = 'extra ' + m[1];
  else if ((m = /^\/templates\/(.+)\.tpl$/i.exec(p))) r.tag = 'tpl ' + m[1];
  else if (/\.tpl$/i.test(p)) r.tag = 'tpl';
  return r;
}

/**
 * Разбор .tpl: теги MODX и Fenom-директивы.
 * Возвращает только непустые массивы: snippets, chunks, placeholders, settings, tvs, tags, fenomInc, fenomExt — [имя, строка].
 * Сниппеты/чанки из БД остаются в списках, но связь строится только на файловые элементы.
 */
function parseTpl(text) {
  const snippets = [], chunks = [], placeholders = [], settings = [], tvs = [], tags = [], fenomInc = [], fenomExt = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((ln, i) => {
    const line = i + 1;
    for (const m of ln.matchAll(/\[\[(!?)([^\[\]]+?)\]\]/g)) {
      tags.push([m[0], line]);
      const body = m[2];
      const q = body.indexOf('?');
      const head = (q >= 0 ? body.slice(0, q) : body).trim();
      if (/^\+\+/.test(head)) settings.push([head.slice(2).trim(), line]);
      else if (/^\+/.test(head)) placeholders.push([head.slice(1).trim(), line]);
      else if (/^\$/.test(head)) chunks.push([head.slice(1).trim(), line]);
      else if (/^\*/.test(head)) tvs.push([head.slice(1).trim(), line]);
      else if (head) snippets.push([head, line]);
    }
    for (const fm of ln.matchAll(/\{include\s+['"]file:([^'"}]+?)['"]/g)) fenomInc.push([fm[1], line]);
    for (const fe of ln.matchAll(/\{extends\s+(?:file=)?['"]([^'"}]+?)['"]/g)) fenomExt.push([fe[1], line]);
  });
  const r = { loc: lines.length };
  const put = (k, v) => { if (v.length) r[k] = v; };
  put('snippets', snippets); put('chunks', chunks); put('placeholders', placeholders); put('settings', settings);
  put('tvs', tvs); put('tags', tags); put('fenomInc', fenomInc); put('fenomExt', fenomExt);
  return r;
}

/**
 * Разбор PHP в режиме MODX: вызовы файловых элементов по имени.
 * Возвращает только непустые: snipCalls (runSnippet), chunkCalls (getChunk/parseChunk) — [имя, строка].
 */
function parseModxPhp(text) {
  const snipCalls = [], chunkCalls = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((ln, i) => {
    for (const m of ln.matchAll(/\brunSnippet\s*\(\s*['"]([\w-]+)['"]/g)) snipCalls.push([m[1], i + 1]);
    for (const m of ln.matchAll(/\b(?:getChunk|parseChunk)\s*\(\s*['"]([\w-]+)['"]/g)) chunkCalls.push([m[1], i + 1]);
  });
  const r = {};
  if (snipCalls.length) r.snipCalls = snipCalls;
  if (chunkCalls.length) r.chunkCalls = chunkCalls;
  return r;
}

module.exports = { classifyModx, parseTpl, parseModxPhp };
