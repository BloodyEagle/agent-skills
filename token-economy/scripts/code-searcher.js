const fs = require('fs');
const path = require('path');

let args = {};
try {
  const inputData = fs.readFileSync(0, 'utf-8').trim();
  if (inputData) args = JSON.parse(inputData);
} catch (e) {
  args = {
    query: process.env.SEARCH_QUERY,
    ext: process.env.SEARCH_EXT
  };
}

const query = args.query;
const ext = args.ext || '.ts';
const root = args.root || 'src';

if (!query) {
  console.log(JSON.stringify({ error: "Не указан поисковый запрос (query)" }));
  process.exit(1);
}

function searchInDir(dir, results = []) {
  if (!fs.existsSync(dir)) return results;
  fs.readdirSync(dir).forEach(file => {
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      if (!['node_modules', '.git', 'dist'].some(p => file.includes(p))) searchInDir(filePath, results);
    } else if (file.endsWith(ext)) {
      const lines = fs.readFileSync(filePath, 'utf8').replace(/\r\n?/g, '\n').split('\n');
      lines.forEach((line, index) => {
        if (line.includes(query)) {
          results.push({
            file: path.relative(process.cwd(), filePath),
            line: index + 1,
            text: line.trim().replace(/\r/g, '').substring(0, 100)
          });
        }
      });
    }
  });
  return results;
}

const matches = searchInDir(path.resolve(process.cwd(), root));
console.log(JSON.stringify({ count: matches.length, matches: matches.slice(0, 30) }));
