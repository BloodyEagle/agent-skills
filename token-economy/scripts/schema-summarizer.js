const fs = require('fs');
const path = require('path');

let args = {};
try { args = JSON.parse(fs.readFileSync(0, 'utf-8').trim() || '{}'); } catch (e) { args = { file: process.env.SCHEMA_FILE }; }

const filePath = path.resolve(process.cwd(), args.file || '');
if (!fs.existsSync(filePath) || !args.file) {
  console.log(JSON.stringify({ error: "Файл интерфейсов не найден" }));
  process.exit(1);
}

const content = fs.readFileSync(filePath, 'utf8');
const lines = content.replace(/\r\n?/g, '\n').split('\n');
const extracted = [];
let capture = false;
let braceCount = 0;

// Извлекаем только структуры данных (интерфейсы, типы, энумы)
lines.forEach(line => {
  if (line.match(/(export\s+)?(interface|enum|type)\s+\w+/)) {
    capture = true;
  }
  if (capture) {
    extracted.push(line.trimEnd());
    braceCount += (line.match(/\{/g) || []).length;
    braceCount -= (line.match(/\}/g) || []).length;
    if (braceCount === 0 && line.includes('}')) {
      capture = false;
      extracted.push(''); // Разделитель
    }
  }
});

console.log(JSON.stringify({ schema: extracted.join('\n').trim() }));
