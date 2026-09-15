// graph-watch.js — пересборка графа при изменении .ts в src.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const TOOL = path.join(__dirname, 'graph-tool.js');
let timer = null;

fs.watch(path.resolve(process.cwd(), 'src'), { recursive: true }, (event, file) => {
  if (!file || !/\.tsx?$/.test(file)) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    console.log('[graph] rebuild:', file);
    spawn(process.execPath, [TOOL, 'build'], { stdio: 'inherit' });
  }, 400);
});
console.log('[graph] watching src/ …');