// Retrospective policy evaluation: inject only when the prompt's own identifiers
// match the anchors of the notes that would be served ("anchor match").
import fs from 'node:fs';
import { explicitIdents } from '../src/guard.js';
const sets = [
  ['mitm PR-body', 'mitm-v2', 'bench/tasks/mitmproxy.json', 'bench/repos/mitmproxy/.thinker/notes'],
  ['mitm symptom', 'mitm-hard', 'bench/tasks/mitmproxy-hard.json', 'bench/repos/mitmproxy/.thinker/notes'],
  ['posthog PR-body', 'posthog-v1', 'bench/tasks/posthog.json', 'bench/repos/posthog/.thinker/notes'],
  ['posthog symptom', 'posthog-hard', 'bench/tasks/posthog-hard.json', 'bench/repos/posthog/.thinker/notes'],
];
const m = (a, k) => a.length ? a.reduce((s, r) => s + (k(r) || 0), 0) / a.length : NaN;
console.log('setting            tasks gated-on |  nocache tok/score |  always-hook tok/score |  gated policy tok/score');
for (const [name, tag, tf, nd] of sets) {
  const tasks = JSON.parse(fs.readFileSync(tf, 'utf8')).tasks;
  const rows = fs.readdirSync(`bench/runs/${tag}`).filter(f => f.endsWith('.json') && f !== 'summary.json').map(f => JSON.parse(fs.readFileSync(`bench/runs/${tag}/${f}`, 'utf8'))).filter(r => r.turns > 1 && typeof r.grade?.score === 'number');
  const note = id => { try { return JSON.parse(fs.readFileSync(`${nd}/${id}.json`, 'utf8')); } catch { return null; } };
  let on = 0; const pol = [], hook = [], base = [];
  for (const t of tasks) {
    const h = rows.filter(r => r.task === t.id && r.arm === 'hook'), b = rows.filter(r => r.task === t.id && r.arm === 'nocache');
    if (!h.length || !b.length) continue;
    const served = [...new Set(h.flatMap(r => r.tools.injected))].map(note).filter(Boolean);
    const anchors = served.map(n => `${n.title} ${n.body} ${(n.deps || []).map(d => d.path + ' ' + (d.symbol || '')).join(' ')}`).join(' ').toLowerCase();
    const ids = explicitIdents(t.prompt.split('\n\n').slice(1).join('\n\n')).filter(x => x.length >= 5);
    const match = ids.filter(x => anchors.includes(x.toLowerCase()) || anchors.includes(x.split('.').pop().toLowerCase()));
    const gate = match.length >= 1;
    if (gate) on++;
    hook.push(...h); base.push(...b); pol.push(...(gate ? h : b));
  }
  const f = a => `${(m(a, r => r.in_tokens) / 1000).toFixed(0).padStart(4)}k / ${m(a, r => r.grade.score).toFixed(2)}`;
  console.log(`${name.padEnd(18)} ${String(tasks.length).padStart(3)}   ${String(on).padStart(3)}     |  ${f(base)}      |  ${f(hook)}          |  ${f(pol)}`);
}
