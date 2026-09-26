#!/usr/bin/env node
// Post-hoc analysis of a run: per-arm summary, per-task deltas vs nocache,
// failure stage for cache arms (coverage / ranking / form-or-use), and
// per-note helped/hurt attribution.
//   node bench/analyze.js <runTag> [--repo click] [--tasks bench/tasks/click.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenize } from '../src/rank.js';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const [,, tag, ...rest] = process.argv;
const flags = {}; for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[i + 1], i++;
const repoName = flags.repo || 'click';
const spec = JSON.parse(fs.readFileSync(flags.tasks || path.join(HERE, 'tasks', `${repoName}.json`), 'utf8'));
const notesDir = flags['notes-dir'] || path.join(HERE, 'repos', repoName, '.thinker', 'notes');
const notes = fs.existsSync(notesDir) ? fs.readdirSync(notesDir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(notesDir, f), 'utf8'))) : [];
const dir = path.join(HERE, 'runs', tag);
const rows = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'summary.json').map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));

const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const score = r => typeof r.grade?.score === 'number' ? r.grade.score : NaN;
const arms = [...new Set(rows.map(r => r.arm))];

// per-arm summary with std error on score
console.log(`\n== ${tag}: ${rows.length} runs, ${notes.length} notes\n`);
console.log('arm         n  turns  tools  wall_s  cost   in_ktok  score  ±se   must');
for (const arm of arms) {
  const rs = rows.filter(r => r.arm === arm);
  const sc = rs.map(score).filter(x => !isNaN(x));
  const se = Math.sqrt(mean(sc.map(x => (x - mean(sc)) ** 2)) / (sc.length || 1));
  const must = rs.filter(r => r.grade?.mustTotal).map(r => r.grade.mustHit / r.grade.mustTotal);
  console.log(`${arm.padEnd(10)} ${String(rs.length).padStart(3)}  ${mean(rs.map(r => r.turns)).toFixed(1).padStart(5)}  ${mean(rs.map(r => r.tools?.calls || 0)).toFixed(1).padStart(5)}  ${(mean(rs.map(r => r.wall_ms)) / 1000).toFixed(0).padStart(6)}  ${mean(rs.map(r => r.cost || 0)).toFixed(3)}  ${(mean(rs.map(r => r.in_tokens)) / 1000).toFixed(0).padStart(7)}  ${mean(sc).toFixed(2)}  ${se.toFixed(2)}  ${mean(must).toFixed(2)}`);
}

// per-task table
console.log('\ntask                       ' + arms.map(a => a.padStart(22)).join(''));
const tasks = [...new Set(rows.map(r => r.task))];
for (const t of tasks) {
  const cells = arms.map(a => { const rs = rows.filter(r => r.task === t && r.arm === a); if (!rs.length) return '-'.padStart(22); return `${mean(rs.map(score)).toFixed(2)} ${mean(rs.map(r => r.turns)).toFixed(1)}t ${(mean(rs.map(r => r.in_tokens)) / 1000).toFixed(0)}k`.padStart(22); });
  console.log(t.padEnd(27) + cells.join(''));
}

// failure stages for cache-like arms: compare each cache run to the mean nocache score for the task
const base = {}; for (const t of tasks) base[t] = mean(rows.filter(r => r.task === t && r.arm === 'nocache').map(score));
function coverage(task) {
  const must = (task.must || []).map(m => m.toLowerCase());
  if (!must.length) return null;
  return notes.filter(n => { const txt = (n.body + ' ' + n.deps.map(d => d.symbol || '').join(' ')).toLowerCase(); return must.filter(m => txt.includes(m.toLowerCase())).length >= Math.ceil(must.length / 2); }).map(n => n.id);
}
console.log('\nfailure stages (cache arms scoring below the nocache mean for the task):');
const stages = {};
for (const r of rows.filter(r => r.arm !== 'nocache')) {
  const s = score(r); if (isNaN(s) || !(s < base[r.task] - 0.05)) continue;
  const task = spec.tasks.find(t => t.id === r.task) || {};
  const cov = coverage(task);
  const served = r.tools?.injected || [];
  let stage;
  if (cov && !cov.length) stage = 'coverage-miss';
  else if (cov && !cov.some(id => served.includes(id))) stage = served.length ? 'ranking-miss (served: ' + served.join(',') + ')' : 'ranking-miss (nothing served)';
  else stage = 'form-or-use (served: ' + served.join(',') + ')';
  stages[stage.split(' ')[0]] = (stages[stage.split(' ')[0]] || 0) + 1;
  console.log(`  ${r.id.padEnd(34)} ${s.toFixed(2)} vs ${base[r.task].toFixed(2)}  ${stage}`);
}
console.log('  totals:', JSON.stringify(stages));

// per-note helped/hurt attribution: delta score vs nocache baseline whenever the note was served
const attrib = {};
for (const r of rows.filter(r => r.arm !== 'nocache' && r.arm !== 'irrelevant')) {
  const s = score(r); if (isNaN(s) || isNaN(base[r.task])) continue;
  for (const id of r.tools?.injected || []) { const a = attrib[id] ||= { served: 0, helped: 0, hurt: 0, delta: 0 }; a.served++; a.delta += s - base[r.task]; if (s > base[r.task] + 0.05) a.helped++; if (s < base[r.task] - 0.05) a.hurt++; }
}
console.log('\nper-note attribution (served / helped / hurt / mean Δscore):');
for (const [id, a] of Object.entries(attrib).sort((x, y) => y[1].served - x[1].served)) console.log(`  ${id.padEnd(62)} ${String(a.served).padStart(2)} ${String(a.helped).padStart(2)} ${String(a.hurt).padStart(2)}  ${(a.delta / a.served).toFixed(2)}`);
