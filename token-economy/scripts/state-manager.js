const fs = require('fs');
const path = require('path');

const stateFile = path.join(process.cwd(), '.kilocode', 'state.json');

// Гарантируем наличие папки для состояния
if (!fs.existsSync(path.dirname(stateFile))) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
}

let args = {};
try {
  const inputData = fs.readFileSync(0, 'utf-8').trim();
  if (inputData) args = JSON.parse(inputData);
} catch (e) {
  args = { operation: process.env.STATE_OP, key: process.env.STATE_KEY, value: process.env.STATE_VAL };
}

const operation = args.operation; // 'init', 'read', 'update', 'clear'

function loadState() {
  if (!fs.existsSync(stateFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8') || '{}');
  } catch (e) {
    return {};
  }
}

const state = loadState();

if (operation === 'init') {
  const newState = {
    current_task: args.task || "Optimization",
    step: 1,
    pending_files: args.pending_files || [],
    completed_files: [],
    errors: [],
    updated_at: new Date().toISOString()
  };
  fs.writeFileSync(stateFile, JSON.stringify(newState, null, 2), 'utf8');
  console.log(JSON.stringify({ success: true, state: newState }));
  process.exit(0);
}

if (operation === 'read') {
  if (!state) {
    console.log(JSON.stringify({ initialized: false, state: null, message: "Состояние не инициализировано. Сначала вызовите operation: 'init'." }));
  } else {
    console.log(JSON.stringify({ initialized: true, state }));
  }
  process.exit(0);
}

if (operation === 'update') {
  const st = state || { current_task: args.task || "Optimization", step: 0, pending_files: [], completed_files: [], errors: [] };
  if (args.completed_file) {
    if (!Array.isArray(st.completed_files)) st.completed_files = [];
    st.completed_files.push(args.completed_file);
    st.pending_files = (st.pending_files || []).filter(f => f !== args.completed_file);
    st.step = (st.step || 0) + 1;
  }
  if (args.error) {
    if (!Array.isArray(st.errors)) st.errors = [];
    st.errors.push(args.error);
  }
  st.updated_at = new Date().toISOString();

  fs.writeFileSync(stateFile, JSON.stringify(st, null, 2), 'utf8');
  console.log(JSON.stringify({ success: true, updated_state: st }));
  process.exit(0);
}

if (operation === 'clear') {
  if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
  console.log(JSON.stringify({ success: true, message: "Состояние сброшено" }));
  process.exit(0);
}

console.log(JSON.stringify({ error: "Неизвестная операция" }));
process.exit(1);
