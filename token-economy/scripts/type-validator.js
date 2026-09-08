const { execSync } = require('child_process');
const path = require('path');

try {
  const tsConfig = path.join(process.cwd(), 'tsconfig.json');
  execSync(`npx tsc --project "${tsConfig}" --noEmit`, { encoding: 'utf8' });
  console.log(JSON.stringify({ valid: true, message: "TypeScript успешно скомпилирован, ошибок нет!" }));
} catch (error) {
  // Исправлено: безопасное слияние потоков вывода во всех консолях
  const output = (error.stdout || '') + (error.stderr || '');
  
  const errors = output.split('\n')
    .filter(line => line.includes('error TS') || line.includes(': error'))
    .map(line => line.trim())
    .slice(0, 10); // Отдаем только первые 10 строк

  console.log(JSON.stringify({ 
    valid: false, 
    count: errors.length || 1, 
    errors: errors.length ? errors : [output.substring(0, 300)] 
  }));
}
