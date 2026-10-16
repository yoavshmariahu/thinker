// Files ranked by recency-weighted commits up to the base (half-life 30 days, 180 days read), the
// top N read in full: how many of the tasks' changed source files they include, and the reading cost.
// The gold files only score coverage. usage: node file-coverage.mjs <tasks.json> <base checkout>
import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
const [tasksFile, base] = process.argv.slice(2);
const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8')).tasks;
const now = Number(execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: base, encoding: 'utf8' }).trim()) * 1000;
const log = execFileSync('git', ['log', '--since=180.days.ago', `--until=${new Date(now).toISOString()}`, '--name-only', '--format=%x00%ct', '--no-merges'], { cwd: base, encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, GIT_COMMITTER_DATE: new Date(now).toISOString() } });
const isCode = f => /\.(py|ts|tsx|js)$/.test(f) && !/(^|\/)tests?\/|(^|\/)test_|\.test\.|(^|\/)dev\//.test(f);
const w = {}, commits = [];
for (const b of log.split('\x00').slice(1)) {
  const [t, ...fs_] = b.split('\n').map(s => s.trim()).filter(Boolean);
  const k = Math.pow(0.5, Math.max(0, now - Number(t) * 1000) / 86_400_000 / 30);
  const code = fs_.filter(isCode); commits.push(code);
  for (const f of code) w[f] = (w[f] || 0) + k;
}
const exists = f => fs.existsSync(path.join(base, f));
const ranked = Object.keys(w).filter(exists).sort((a, b) => w[b] - w[a]);
const lines = f => fs.readFileSync(path.join(base, f), 'utf8').split('\n').length;
const gold = t => (t.goldFiles || []).filter(f => isCode(f) && exists(f));
console.log(`${ranked.length} code files changed in the 180 days before the base\n`);
for (const n of [25, 50, 100, 200, 400]) {
  const top = new Set(ranked.slice(0, n)); const lc = [...top].reduce((s, f) => s + lines(f), 0);
  const per = tasks.map(t => { const g = gold(t); return { id: t.id.slice(2, 7), g: g.length, hit: g.filter(f => top.has(f)).length }; });
  console.log(`top ${String(n).padStart(3)} files: ${Math.round(lc / 1000)}k lines, full read ≈ ${(lc * 20 / 1e6).toFixed(1)}M tokens | every changed file covered ${per.filter(p => p.g && p.hit === p.g).length}/13, some ${per.filter(p => p.hit).length}/13, changed files ${per.reduce((s, p) => s + p.hit, 0)}/${per.reduce((s, p) => s + p.g, 0)}`);
  console.log(`   ${per.map(p => `${p.id}:${p.hit}/${p.g}`).join(' ')}`);
}
