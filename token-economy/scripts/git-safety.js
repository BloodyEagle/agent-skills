const { execSync } = require('child_process');

try {
  const status = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
  if (!status) {
    console.log(JSON.stringify({ clean: true, message: "Репозиторий чист." }));
  } else {
    console.log(JSON.stringify({ 
      clean: false, 
      message: "Обнаружены незакоммиченные изменения", 
      files: status.split('\n').map(f => f.trim()) 
    }));
  }
} catch (err) {
  console.log(JSON.stringify({ error: "Проект не использует Git либо утилита заблокирована." }));
}
