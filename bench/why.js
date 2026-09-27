// Why does success drop with notes? Compare exploration breadth and its relation to score.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const projects = path.join(os.homedir(), '.claude', 'projects');
const dirs = fs.readdirSync(projects).filter(d => d.includes('bench-worktrees-posthog'));
const find = sid => { for (const d of dirs) { const f = path.join(projects, d, sid + '.jsonl'); if (fs.existsSync(f)) return f; } return null; };
const load = tag => fs.readdirSync(`bench/runs/${tag}`).filter(f => f.endsWith('.json') && f !== 'summary.json').map(f => ({ tag, ...JSON.parse(fs.readFileSync(`bench/runs/${tag}/${f}`, 'utf8')) })).filter(r => r.turns > 1 && typeof r.grade?.score === 'number');
const rows = [...load('posthog-hard'), ...load('posthog-sym-v1').map(r => ({ ...r, arm: r.arm + ' (v1)' })), ...load('posthog-sym-v2').map(r => ({ ...r, arm: r.arm + ' (v2)' }))];
for (const r of rows) {
  const f = find(r.session); r.files = new Set(); r.searches = 0; r.outTok = r.out_tokens;
  if (!f) continue;
  for (const l of fs.readFileSync(f, 'utf8').split('\n')) { let j; try { j = JSON.parse(l); } catch { continue; } if (j.type !== 'assistant' || !Array.isArray(j.message?.content)) continue;
    for (const b of j.message.content) { if (b.type !== 'tool_use') continue; const i = b.input || {};
      if (b.name === 'Read' && i.file_path) r.files.add(i.file_path);
      if (b.name === 'Bash') for (const m of String(i.command || '').matchAll(/((?:[\w.@-]+\/)+[\w.@-]+\.\w{1,5})/g)) r.files.add(m[1]);
      if (b.name === 'Grep' || (b.name === 'Bash' && /\b(grep|rg)\b/.test(i.command || ''))) r.searches++; } }
  r.nfiles = r.files.size; r.edited = [...(r.diff || '').matchAll(/^diff --git a\/(.+?) b\//gm)].length; r.diffLines = (r.diff || '').split('\n').filter(l => /^[+-][^+-]/.test(l)).length;
}
const m = (a, k) => a.reduce((s, r) => s + (k(r) || 0), 0) / a.length;
console.log('arm                  n  files-inspected  searches  files-edited  diff-lines  success');
for (const arm of [...new Set(rows.map(r => r.arm))]) { const rs = rows.filter(r => r.arm === arm); console.log(`${arm.padEnd(20)} ${String(rs.length).padStart(2)}  ${m(rs, r => r.nfiles).toFixed(1).padStart(9)}  ${m(rs, r => r.searches).toFixed(1).padStart(12)}  ${m(rs, r => r.edited).toFixed(1).padStart(10)}  ${m(rs, r => r.diffLines).toFixed(0).padStart(10)}  ${m(rs, r => r.grade.score).toFixed(2).padStart(7)}`); }
// within-task relation: for the same task, do runs that inspected more files score higher?
const tasks = [...new Set(rows.map(r => r.task))]; let hi = [], lo = [];
for (const t of tasks) { const rs = rows.filter(r => r.task === t); const med = [...rs.map(r => r.nfiles)].sort((a, b) => a - b)[Math.floor(rs.length / 2)]; hi.push(...rs.filter(r => r.nfiles > med)); lo.push(...rs.filter(r => r.nfiles <= med)); }
console.log(`\nwithin each task, runs above the task's median files-inspected: n=${hi.length} success ${m(hi, r => r.grade.score).toFixed(2)};  at or below: n=${lo.length} success ${m(lo, r => r.grade.score).toFixed(2)}`);
// what the judge said was missing, by arm family
const fam = r => r.arm === 'nocache' || r.arm === 'prompt' ? 'no notes' : r.arm.startsWith('irrelevant') ? null : 'with notes';
for (const f of ['no notes', 'with notes']) { const rs = rows.filter(r => fam(r) === f && r.grade.score < 1); const txt = rs.map(r => (r.grade.reasons || [r.grade.reason]).join(' ')).join(' ').toLowerCase();
  const c = k => rs.filter(r => new RegExp(k).test((r.grade.reasons || [r.grade.reason]).join(' ').toLowerCase())).length;
  console.log(`${f}: ${rs.length} imperfect runs; judge mentions backend/server part missing: ${c('backend|server|api')}, wrong place: ${c('wrong (place|file|location)|did not (find|touch)|never (touch|edit)')}, incomplete/partial: ${c('incomplete|partial|only (part|half)|missing|does not (cover|handle)|left out')}, looser/stricter condition: ${c('looser|too broad|too narrow|stricter|condition|guard|eligib')}`); }
