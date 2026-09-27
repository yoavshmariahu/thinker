// Were the served notes about the right code? Anchor precision = share of served
// notes whose deps touch a file the merged patch changed (or its directory).
import fs from 'node:fs'; import path from 'node:path';
const tasks = Object.fromEntries(JSON.parse(fs.readFileSync('bench/tasks/posthog-hard.json', 'utf8')).tasks.map(t => [t.id, t]));
const noteFrom = (dir, id) => { try { return JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8')); } catch { return null; } };
const sets = [['posthog-hard', 'bench/notesets/posthog-v1/notes', ['hook']], ['posthog-sym-v1', 'bench/notesets/posthog-v1/notes', null], ['posthog-sym-v2', 'bench/notesets/posthog-v2/notes', null]];
const m = (a, k) => a.length ? a.reduce((s, r) => s + (k(r) || 0), 0) / a.length : NaN;
console.log('arm                  n  notes/run  on-target(file)  on-target(dir)  off-target  by source agent/pr   success: all-on-target  some-off-target');
const all = [];
for (const [tag, nd, only] of sets) {
  const rows = fs.readdirSync(`bench/runs/${tag}`).filter(f => f.endsWith('.json') && f !== 'summary.json').map(f => JSON.parse(fs.readFileSync(`bench/runs/${tag}/${f}`, 'utf8'))).filter(r => r.turns > 1 && typeof r.grade?.score === 'number' && (!only || only.includes(r.arm)));
  for (const arm of [...new Set(rows.map(r => r.arm))]) {
    const rs = rows.filter(r => r.arm === arm);
    for (const r of rs) {
      const gold = tasks[r.task].goldFiles; const gdirs = new Set(gold.map(g => path.dirname(g)));
      r.notes = r.tools.injected.map(id => noteFrom(nd, id)).filter(Boolean);
      r.file = r.notes.filter(n => n.deps.some(d => gold.includes(d.path))).length;
      r.dir = r.notes.filter(n => !n.deps.some(d => gold.includes(d.path)) && n.deps.some(d => gdirs.has(path.dirname(d.path)))).length;
      r.off = r.notes.length - r.file - r.dir; r.label = `${arm} (${nd.includes('v2') ? 'v2' : 'v1'})`;
      r.pr = r.notes.filter(n => n.source?.type === 'pr').length;
      all.push(r);
    }
    const withN = rs.filter(r => r.notes.length);
    const clean = withN.filter(r => r.off === 0), dirty = withN.filter(r => r.off > 0);
    console.log(`${rs[0].label.padEnd(20)} ${String(rs.length).padStart(2)}  ${m(rs, r => r.notes.length).toFixed(1).padStart(7)}  ${(100 * m(withN, r => r.file / r.notes.length)).toFixed(0).padStart(12)}%  ${(100 * m(withN, r => r.dir / r.notes.length)).toFixed(0).padStart(12)}%  ${(100 * m(withN, r => r.off / r.notes.length)).toFixed(0).padStart(9)}%  ${String(withN.reduce((s, r) => s + r.notes.length - r.pr, 0)).padStart(8)}/${withN.reduce((s, r) => s + r.pr, 0)}        ${clean.length ? m(clean, r => r.grade.score).toFixed(2) + ' (n=' + clean.length + ')' : '-'}   ${dirty.length ? m(dirty, r => r.grade.score).toFixed(2) + ' (n=' + dirty.length + ')' : '-'}`);
  }
}
const withN = all.filter(r => r.notes.length);
const g = (f) => { const a = withN.filter(f); return `${m(a, r => r.grade.score).toFixed(2)} (n=${a.length})`; };
console.log(`\npooled over all note arms:  every served note on-target: ${g(r => r.off === 0)}   |   at least one off-target: ${g(r => r.off > 0)}   |   majority off-target: ${g(r => r.off > r.notes.length / 2)}`);
console.log(`runs where a PR-mined note was served: ${g(r => r.pr > 0)}   |   only agent-derived notes: ${g(r => r.pr === 0)}`);

// control for task difficulty: score minus the same task's no-cache mean
const baseRows = fs.readdirSync('bench/runs/posthog-hard').filter(f => f.includes('-nocache-') || f.includes('-prompt-')).map(f => JSON.parse(fs.readFileSync('bench/runs/posthog-hard/' + f, 'utf8'))).filter(r => r.turns > 1 && typeof r.grade?.score === 'number');
const base = {}; for (const t of Object.keys(tasks)) base[t] = m(baseRows.filter(r => r.task === t), r => r.grade.score);
const d = f => { const a = withN.filter(f); const mu = m(a, r => r.grade.score - base[r.task]); const se = Math.sqrt(m(a, r => (r.grade.score - base[r.task] - mu) ** 2) / a.length); return `${mu >= 0 ? '+' : ''}${mu.toFixed(2)} ±${se.toFixed(2)} (n=${a.length})`; };
console.log('\nΔ success vs the same task without notes:');
console.log('  PR-mined note served:        ', d(r => r.pr > 0));
console.log('  agent-derived notes only:    ', d(r => r.pr === 0));
console.log('  all served notes on-target:  ', d(r => r.off === 0));
console.log('  some served note off-target: ', d(r => r.off > 0));
console.log('  prose served (full/late):    ', d(r => !r.label.startsWith('pointers')));
console.log('  pointers only:               ', d(r => r.label.startsWith('pointers')));
// per-note: Δ when served, for notes served in >= 4 runs
const per = {};
for (const r of withN) for (const n of r.notes) { const p = per[n.id] ||= { n: 0, d: 0, kind: n.kind, src: n.source?.type, title: n.title }; p.n++; p.d += r.grade.score - base[r.task]; }
const list = Object.entries(per).filter(([, p]) => p.n >= 4).map(([id, p]) => ({ id, ...p, mean: p.d / p.n })).sort((a, b) => a.mean - b.mean);
console.log('\nworst notes (served ≥4 times):'); for (const p of list.slice(0, 8)) console.log(`  ${p.mean.toFixed(2).padStart(6)}  n=${String(p.n).padStart(2)}  ${p.src}/${p.kind.padEnd(10)} ${p.title.slice(0, 80)}`);
console.log('best notes:'); for (const p of list.slice(-5).reverse()) console.log(`  ${(p.mean >= 0 ? '+' : '') + p.mean.toFixed(2)}  n=${String(p.n).padStart(2)}  ${p.src}/${p.kind.padEnd(10)} ${p.title.slice(0, 80)}`);
fs.writeFileSync('bench/runs/posthog-note-attribution.json', JSON.stringify(list, null, 1));
