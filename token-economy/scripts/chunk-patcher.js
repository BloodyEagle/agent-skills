const fs = require('fs');
const path = require('path');

let args = {};
try {
  const inputData = fs.readFileSync(0, 'utf-8').trim();
  if (inputData) args = JSON.parse(inputData);
} catch (e) {
  args = {
    file: process.env.PATCH_FILE,
    oldChunk: process.env.PATCH_OLD,
    newChunk: process.env.PATCH_NEW
  };
}

const filePath = path.resolve(process.cwd(), args.file || '');
const oldChunk = args.oldChunk;
const newChunk = args.newChunk;

if (!fs.existsSync(filePath) || !oldChunk || newChunk === undefined) {
  console.log(JSON.stringify({ success: false, error: "Неверный путь или отсутствуют oldChunk / newChunk" }));
  process.exit(1);
}

let content = fs.readFileSync(filePath, 'utf8');

const parts = content.split(oldChunk);
if (parts.length === 1) {
  console.log(JSON.stringify({ success: false, error: "Оригинальный фрагмент кода (oldChunk) не найден в файле" }));
  process.exit(1);
}
if (parts.length > 2) {
  console.log(JSON.stringify({ success: false, error: "oldChunk встречается " + (parts.length - 1) + " раз. Уточните фрагмент, чтобы он был уникальным." }));
  process.exit(1);
}
fs.writeFileSync(filePath, parts.join(newChunk), 'utf8');

console.log(JSON.stringify({ success: true, message: "Патч успешно применен к файлу!" }));
