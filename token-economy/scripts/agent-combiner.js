const fs = require('fs');
const path = require('path');

function getFiles(dir, extensions, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  fs.readdirSync(dir).forEach(file => {
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      if (!['node_modules', '.git', 'dist', '.kilocode'].some(p => file.includes(p))) {
        getFiles(filePath, extensions, fileList);
      }
    } else if (extensions.some(ext => file.endsWith(ext) && !file.endsWith('.spec.ts'))) {
      fileList.push(filePath);
    }
  });
  return fileList;
}

try {
  const appDir = path.join(process.cwd(), 'src', 'app');
  if (!fs.existsSync(appDir)) {
    console.log(JSON.stringify({ error: "Папка src/app не найдена. Запускайте из корня Angular-проекта." }));
    process.exit(1);
  }

  const allFiles = getFiles(appDir, ['.ts', '.html', '.scss', '.css']);
  const tsFiles = allFiles.filter(f => f.endsWith('.ts'));

  const unusedImports = {};
  const components = [];
  const services = [];

  tsFiles.forEach(file => {
    const content = fs.readFileSync(file, 'utf8');
    const relPath = path.relative(process.cwd(), file);

    // Сбор импортов: имя считается неиспользуемым, если вне строки импорта
    // оно не встречается как целое слово (защита от подстрок вида User в UserService)
    const importRegex = /import\s+\{([^}]+)\}\s+from\s+['"][^'"]*['"]/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const importText = match[0];
      const body = content.replace(importText, ' ');
      match[1].split(',').forEach(raw => {
        const name = raw.trim().split(/\s+as\s+/).pop().trim();
        if (!name) return;
        const re = new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
        if (!re.test(body)) {
          if (!unusedImports[relPath]) unusedImports[relPath] = [];
          unusedImports[relPath].push(name);
        }
      });
    }

    // Сбор компонентов (безопасный парсинг без падений на RegExp)
    if (content.includes('selector')) {
      const parts = content.split('selector');
      if (parts.length > 1) {
        const rightSide = parts[1].split('\n')[0];
        const cleanSelector = rightSide.replace(/[^a-zA-Z0-9-]/g, '');
        const classParts = content.split('export class ');
        if (classParts.length > 1) {
          const className = classParts[1].split(' ')[0].split('{')[0].trim();
          components.push({ selector: cleanSelector, className: className, filePath: relPath });
        }
      }
    }

    // Сбор сервисов
    if (content.includes('@Injectable')) {
      const classParts = content.split('export class ');
      if (classParts.length > 1) {
        const className = classParts[1].split(' ')[0].split('{')[0].trim();
        services.push({ className: className, filePath: relPath });
      }
    }
  });

  // Фильтрация неиспользуемых компонентов
  const unusedComponents = components.filter(comp => {
    let isUsed = false;
    for (const file of allFiles) {
      if (file.endsWith(comp.filePath)) continue;
      const content = fs.readFileSync(file, 'utf8');
      if (file.match(/routing|routes/) && content.includes(comp.className)) { isUsed = true; break; }
      if (content.includes(comp.selector) || content.includes(comp.className)) { isUsed = true; break; }
    }
    return !isUsed;
  }).map(c => ({ class: c.className, file: c.filePath }));

  // Фильтрация неиспользуемых сервисов
  const unusedServices = services.filter(srv => {
    let isUsed = false;
    for (const file of tsFiles) {
      if (file.endsWith(srv.filePath)) continue;
      const content = fs.readFileSync(file, 'utf8');
      if (content.includes(srv.className)) { isUsed = true; break; }
    }
    return !isUsed;
  }).map(s => ({ class: s.className, file: s.filePath }));

  console.log(JSON.stringify({
    summary: {
      totalFilesChecked: allFiles.length,
      unusedImportsCount: Object.keys(unusedImports).length,
      deadComponentsCount: unusedComponents.length,
      deadServicesCount: unusedServices.length
    },
    actionableItems: {
      removeImportsFrom: unusedImports,
      deleteComponents: unusedComponents,
      deleteServices: unusedServices
    }
  }));
  process.exit(0);
} catch (err) {
  console.log(JSON.stringify({ error: err.message }));
  process.exit(1);
}
