const fs = require('fs');
const path = require('path');

let args = {};
try { args = JSON.parse(fs.readFileSync(0, 'utf-8').trim() || '{}'); } catch (e) { args = { file: process.env.TOKEN_FILE }; }

const filePath = path.resolve(process.cwd(), args.file || '');
if (!fs.existsSync(filePath) || !args.file) {
  console.log(JSON.stringify({ error: "Файл не найден" }));
  process.exit(1);
}

const stats = fs.statSync(filePath);
const content = fs.readFileSync(filePath, 'utf8');

// Грубая, но быстрая кроссплатформенная оценка (1 токен ~ 3.5 символа для кода)
const estimatedTokens = Math.ceil(content.length / 3.5); 

console.log(JSON.stringify({
  file: args.file,
  sizeBytes: stats.size,
  estimatedTokens: estimatedTokens,
  isSafeToRead: estimatedTokens < 8000, // Порог безопасности, настраивается под ваши задачи
  actionRecommended: estimatedTokens >= 8000 ? "Запрещено читать целиком! Используйте инструменты 'search' или 'compress'." : "Разрешено к чтению"
}));
