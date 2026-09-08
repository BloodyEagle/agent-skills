const { execSync } = require('child_process');

let args = {};
try { args = JSON.parse(require('fs').readFileSync(0, 'utf-8').trim() || '{}'); } catch (e) { args = {}; }

if (!args.file) {
  console.log(JSON.stringify({ error: "Укажите payload.file (путь к .spec.ts)" }));
  process.exit(1);
}

const spec = args.file.replace(/\\/g, '/');
const browsers = args.browsers || 'ChromeHeadless';
const timeout = args.timeout || 180000;

const cmd = `npx ng test --watch=false --browsers=${browsers} --include="${spec}"`;

try {
  const out = execSync(cmd, { encoding: 'utf8', timeout, maxBuffer: 20 * 1024 * 1024 });
  const tail = out.split('\n').filter(l => /SUCCESS|FAILED|Executed|TOTAL/i.test(l)).slice(-10).join('\n');
  console.log(JSON.stringify({ file: spec, passed: true, summary: tail || out.slice(-500) }));
} catch (err) {
  const all = ((err.stdout || '') + (err.stderr || '')).trim();
  const failures = all.split('\n').filter(l => /FAILED|Expected|Error:|at /.test(l)).slice(0, 40).join('\n');
  console.log(JSON.stringify({ file: spec, passed: false, summary: failures || all.slice(-800) }));
}
