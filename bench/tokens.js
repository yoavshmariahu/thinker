// Where do the tokens go? Per arm: what the agent read, how big it was, and how
// much of it was reached by following pointers from injected notes.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const [,, tag, notesDir, ...arms] = process.argv;
const projects = path.join(os.homedir(), '.claude', 'projects');
const dirs = fs.readdirSync(projects).filter(d => d.includes('bench-worktrees-posthog'));
const find = sid => { for (const d of dirs) { const f = path.join(projects, d, sid + '.jsonl'); if (fs.existsSync(f)) return f; } return null; };
const tasks = Object.fromEntries(JSON.parse(fs.readFileSync('bench/tasks/posthog-hard.json', 'utf8')).tasks.map(t => [t.id, t]));
let rows = fs.readdirSync(`bench/runs/${tag}`).filter(f => f.endsWith('.json') && f !== 'summary.json').map(f => JSON.parse(fs.readFileSync(`bench/runs/${tag}/${f}`, 'utf8'))).filter(r => r.turns > 1 && arms.includes(r.arm));
const common = [...new Set(rows.map(r => r.task))].filter(t => arms.every(a => rows.some(r => r.task === t && r.arm === a)));
rows = rows.filter(r => common.includes(r.task));
const rel = p => p.replace(/^.*?bench\/worktrees\/[^/]+\//, '');
for (const r of rows) {
  const f = find(r.session); const tx = fs.readFileSync(f, 'utf8').split('\n');
  const uses = new Map(); r.read = new Set(); r.byTool = {}; r.resChars = {}; r.injChars = 0; r.out = 0; r.cacheCreate = 0; r.cacheRead = 0; r.fresh = 0; r.apiCalls = 0; r.maxCtx = 0;
  for (const l of tx) { let j; try { j = JSON.parse(l); } catch { continue; }
    if (j.type === 'assistant' && j.message?.usage) { const u = j.message.usage; const id = j.message.id; if (!uses.has('u' + id)) { uses.set('u' + id, 1); r.apiCalls++; r.out += u.output_tokens || 0; r.cacheCreate += u.cache_creation_input_tokens || 0; r.cacheRead += u.cache_read_input_tokens || 0; r.fresh += u.input_tokens || 0; r.maxCtx = Math.max(r.maxCtx, (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)); } }
    const c = j.message?.content; if (!Array.isArray(c)) { if (typeof c === 'string' && c.includes('<thinker-cache>')) r.injChars += c.length; continue; }
    for (const b of c) {
      if (b.type === 'tool_use') { uses.set(b.id, b); r.byTool[b.name] = (r.byTool[b.name] || 0) + 1; if (b.name === 'Read' && b.input?.file_path) r.read.add(rel(b.input.file_path)); if (b.name === 'Bash') for (const m of String(b.input?.command || '').matchAll(/((?:[\w.@-]+\/)+[\w.@-]+\.\w{1,5})/g)) r.read.add(rel(m[1])); }
      else if (b.type === 'tool_result') { const u = uses.get(b.tool_use_id); const txt = typeof b.content === 'string' ? b.content : (b.content || []).map(x => x.text || '').join(''); if (u) r.resChars[u.name] = (r.resChars[u.name] || 0) + txt.length; }
      else if (b.type === 'text' && j.type === 'user' && b.text.includes('thinker-cache')) r.injChars += b.text.length;
    }
    if (j.type === 'attachment' || j.attachment) { const s = JSON.stringify(j); if (s.includes('thinker-cache')) r.injChars += (s.match(/thinker-cache/g) || []).length > 0 ? Math.min(s.length, 20000) : 0; }
  }
  const notes = r.tools.injected.map(id => { try { return JSON.parse(fs.readFileSync(path.join(notesDir, id + '.json'), 'utf8')); } catch { return null; } }).filter(Boolean);
  r.pointed = new Set(notes.flatMap(n => n.deps.map(d => d.path)));
  r.followed = [...r.read].filter(f => r.pointed.has(f)).length;
  const gold = new Set(tasks[r.task].goldFiles);
  r.pointedGold = [...r.pointed].filter(f => gold.has(f)).length;
  r.readGold = [...r.read].filter(f => gold.has(f)).length;
  r.nNotes = notes.length;
}
const m = (a, k) => a.reduce((s, r) => s + (k(r) || 0), 0) / a.length;
console.log(`${tag}: ${common.length} paired tasks`);
console.log('arm        n  api-calls  tool-calls  Read  Bash  Grep  files-seen  result-kchars  out-ktok  cache-write-k  cache-read-M  peak-ctx-k  $/run');
for (const a of arms) { const rs = rows.filter(r => r.arm === a); const rc = r => Object.values(r.resChars).reduce((s, x) => s + x, 0);
  console.log(`${a.padEnd(10)} ${rs.length}  ${m(rs, r => r.apiCalls).toFixed(0).padStart(8)}  ${m(rs, r => r.tools.calls).toFixed(0).padStart(9)}  ${m(rs, r => r.byTool.Read).toFixed(0).padStart(4)}  ${m(rs, r => r.byTool.Bash).toFixed(0).padStart(4)}  ${m(rs, r => r.byTool.Grep).toFixed(0).padStart(4)}  ${m(rs, r => r.read.size).toFixed(0).padStart(9)}  ${(m(rs, rc) / 1000).toFixed(0).padStart(12)}  ${(m(rs, r => r.out) / 1000).toFixed(1).padStart(8)}  ${(m(rs, r => r.cacheCreate) / 1000).toFixed(0).padStart(12)}  ${(m(rs, r => r.cacheRead) / 1e6).toFixed(2).padStart(11)}  ${(m(rs, r => r.maxCtx) / 1000).toFixed(0).padStart(9)}  ${m(rs, r => r.cost).toFixed(2)}`); }
console.log('\narm        notes-served  files-pointed-at  of-those-in-real-fix  pointed-files-the-agent-opened  real-fix-files-opened');
for (const a of arms) { const rs = rows.filter(r => r.arm === a); console.log(`${a.padEnd(10)} ${m(rs, r => r.nNotes).toFixed(1).padStart(8)}  ${m(rs, r => r.pointed.size).toFixed(1).padStart(15)}  ${m(rs, r => r.pointedGold).toFixed(1).padStart(18)}  ${m(rs, r => r.followed).toFixed(1).padStart(26)}  ${m(rs, r => r.readGold).toFixed(1).padStart(22)}`); }
console.log('\nper task: cost and peak context by arm');
for (const t of common.sort()) console.log(t.replace('-hard', '').padEnd(10), arms.map(a => { const r = rows.find(r => r.task === t && r.arm === a); return `${a}: $${r.cost.toFixed(2)} ${r.tools.calls}calls peak ${(r.maxCtx / 1000).toFixed(0)}k`; }).join('  |  '));
