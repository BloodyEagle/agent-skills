'use strict';
// build.js — сведения о сборке: инструмент, версии Java и Spring Boot, модули, стартеры и ключевые библиотеки.
// Разбор текстовый (регулярные выражения): Maven и Gradle (Groovy и Kotlin DSL), без запуска сборки.

const fs = require('fs');
const path = require('path');
const { listFiles, readText } = require('./fsx');

const NOTABLE = ['kafka', 'amqp', 'rabbit', 'jms', 'flyway', 'liquibase', 'lombok', 'mapstruct', 'postgresql', 'mysql', 'mariadb', 'h2', 'mongodb', 'redis',
  'openfeign', 'resilience4j', 'springdoc', 'testcontainers', 'oauth2', 'jwt', 'querydsl', 'jooq', 'mybatis', 'hibernate', 'cache', 'quartz', 'batch', 'graphql', 'grpc'];

function read(root, rel) { try { return readText(path.join(root, rel)).text; } catch (e) { return ''; } }

/**
 * @returns {{tool: string, boot: string|null, java: string|null, modules: string[], libs: string[], encoding: string|null}}
 */
function buildInfo(root) {
  const poms = listFiles(root, ['pom.xml']);
  const gradles = listFiles(root, ['build.gradle', 'build.gradle.kts']);
  const settings = listFiles(root, ['settings.gradle', 'settings.gradle.kts']);
  const res = { tool: poms.length ? 'Maven' : gradles.length ? 'Gradle' : 'не определён', boot: null, java: null, modules: [], libs: new Set(), encoding: null };
  const addArtifact = (a) => {
    if (a === 'spring-boot-starter-parent') return;
    if (/^spring-boot-starter-/.test(a)) res.libs.add(a.replace('spring-boot-starter-', ''));
    else if (/^spring-(cloud|kafka|security|data|amqp|batch|integration)/.test(a)) res.libs.add(a);
    else for (const n of NOTABLE) if (a.toLowerCase().includes(n)) { res.libs.add(a.replace(/^.*?(?=[a-z])/, '')); break; }
  };
  for (const rel of poms) {
    const t = read(root, rel);
    const dir = path.posix.dirname(rel);
    if (!res.boot) {
      const pm = /<parent>[\s\S]*?<artifactId>spring-boot-starter-parent<\/artifactId>\s*<version>([^<]+)<\/version>/.exec(t);
      if (pm) res.boot = pm[1].trim();
      const dm = /<artifactId>spring-boot-dependencies<\/artifactId>\s*<version>([^<]+)<\/version>/.exec(t);
      if (!res.boot && dm) res.boot = dm[1].trim();
    }
    if (!res.java) {
      const jm = /<(?:java\.version|maven\.compiler\.release|maven\.compiler\.source|release)>\s*([\d.]+)\s*</.exec(t);
      if (jm) res.java = jm[1];
    }
    if (!res.encoding) { const em = /<project\.build\.sourceEncoding>([^<]+)</.exec(t); if (em) res.encoding = em[1].trim(); }
    for (const m of t.matchAll(/<module>([^<]+)<\/module>/g)) res.modules.push(path.posix.join(dir === '.' ? '' : dir, m[1].trim()));
    for (const m of t.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)) addArtifact(m[1].trim());
  }
  for (const rel of gradles) {
    const t = read(root, rel);
    if (!res.boot) {
      const m = /id\s*\(?\s*["']org\.springframework\.boot["']\s*\)?\s*version\s*["']([^"']+)["']/.exec(t) || /springBootVersion\s*=\s*["']([^"']+)["']/.exec(t) || /spring-boot-gradle-plugin:([\d.A-Za-z-]+)/.exec(t);
      if (m) res.boot = m[1];
    }
    if (!res.java) {
      const m = /JavaLanguageVersion\.of\(\s*(\d+)\s*\)/.exec(t) || /(?:sourceCompatibility|targetCompatibility)\s*=\s*['"]?(?:JavaVersion\.VERSION_)?([\d._]+)/.exec(t) || /jvmToolchain\(\s*(\d+)\s*\)/.exec(t);
      if (m) res.java = m[1].replace('_', '.');
    }
    for (const m of t.matchAll(/["']([\w.-]+):([\w.-]+)(?::[^"']*)?["']/g)) addArtifact(m[2]);
  }
  for (const rel of settings) {
    for (const m of read(root, rel).matchAll(/include\s*\(?\s*((?:["'][^"']+["']\s*,?\s*)+)/g)) {
      for (const x of m[1].matchAll(/["']:?([^"']+)["']/g)) res.modules.push(x[1].replace(/:/g, '/'));
    }
  }
  res.modules = [...new Set(res.modules)];
  res.libs = [...res.libs].sort();
  return res;
}

module.exports = { buildInfo };
