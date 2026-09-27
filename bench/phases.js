// Where do the turns go? For each run: tool calls until the agent first opens a
// gold file (localization), until its first edit (diagnosis+design), and after.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const [,, tag, tasksFile] = process.argv;
const tasks = Object.fromEntries(JSON.parse(fs.readFileSync(tasksFile, 'utf8')).tasks.map(t => [t.id, t]));
const projects = path.join(os.homedir(), '.claude', 'projects');
const dirs = fs.readdirSync(projects).filter(d => d.includes('bench-worktrees'));
const find = sid => { for (const d of dirs) { const f = path.join(projects, d, sid + '.jsonl'); if (fs.existsSync(f)) return f; } return null; };
const rows = fs.readdirSync(`bench/runs/${tag}`).filter(f => f.endsWith('.json') && f !== 'summary.json').map(f => JSON.parse(fs.readFileSync(`bench/runs/${tag}/${f}`, 'utf8'))).filter(r => r.turns > 1);
const out = {};
for (const r of rows) {
  const f = find(r.session); if (!f) continue;
  const gold = (tasks[r.task]?.goldFiles || []);
  let n = 0, firstGold = null, firstEdit = null, distinctFiles = new Set();
  for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (j.type !== 'assistant' || !Array.isArray(j.message?.content)) continue;
    for (const b of j.message.content) {
      if (b.type !== 'tool_use') continue;
      n++;
      const s = JSON.stringify(b.input || {});
      if (b.name === 'Read' && b.input?.file_path) distinctFiles.add(b.input.file_path);
      if (firstGold === null && gold.some(g => s.includes(g) || s.includes(path.basename(g)))) firstGold = n;
      if (firstEdit === null && (b.name === 'Edit' || b.name === 'Write')) firstEdit = n;
    }
  }
  (out[r.arm] ||= []).push({ total: n, firstGold: firstGold ?? n, firstEdit: firstEdit ?? n, files: distinctFiles.size, score: r.grade?.score });
}
const m = (a, k) => (a.reduce((s, x) => s + x[k], 0) / a.length).toFixed(1);
console.log(`${tag}\narm          n  calls  to-first-gold-file  to-first-edit  after-first-edit  files-read`);
for (const [arm, a] of Object.entries(out).sort()) console.log(`${arm.padEnd(11)} ${String(a.length).padStart(2)}  ${m(a, 'total').padStart(5)}  ${m(a, 'firstGold').padStart(12)}  ${m(a, 'firstEdit').padStart(14)}  ${(m(a, 'total') - m(a, 'firstEdit')).toFixed(1).padStart(14)}  ${m(a, 'files').padStart(9)}`);
