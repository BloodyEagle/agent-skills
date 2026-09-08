const fs = require('fs');
const { execSync } = require('child_process');

let args = {};
try { args = JSON.parse(fs.readFileSync(0, 'utf-8').trim() || '{}'); } catch (e) { 
  args = { type: process.env.GEN_TYPE, name: process.env.GEN_NAME }; 
}

const type = args.type; // component, service, pipe, directive
const name = args.name;

if (!type || !name) {
  console.log(JSON.stringify({ error: "Необходимы параметры 'type' и 'name'" }));
  process.exit(1);
}

try {
  // Вызываем локальный Angular CLI с флагами пропуска тестов (если агент пишет их отдельно)
  const output = execSync(`npx ng g ${type} ${name} --skip-tests=true`, { encoding: 'utf8' });
  console.log(JSON.stringify({ success: true, log: output.trim().split('\n') }));
} catch (error) {
  const output = ((error.stdout || '') + (error.stderr || '')).trim() || error.message || 'Неизвестная ошибка Angular CLI';
  console.log(JSON.stringify({ success: false, error: output }));
}
