#!/usr/bin/env node
// One table over several review-eval runs of the same case file (different notesets or arms), the
// bugs split by whether the cache held a note mined from the fix (`noted` in the case file).
//   node bench/review-eval-combine.js --cases bench/review-eval-cases-posthog-reverts.json --runs dirA,dirB
import fs from 'node:fs';
import path from 'node:path';
import { clusterFindings } from '../src/review.js';
const argv = process.argv.slice(2), flags = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const k = argv[i].slice(2); flags[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
const cases = JSON.parse(fs.readFileSync(path.resolve(flags.cases), 'utf8')).cases;
const byId = new Map(cases.map(c => [c.id, c]));
const rows = [];
for (const dir of String(flags.runs).split(',')) {
  const f = path.join(path.resolve(dir), 'results.jsonl'); if (!fs.existsSync(f)) continue;
  for (const l of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(l); if (!r.strategy || r.failed || r.dry) continue;
    try { const rep = JSON.parse(fs.readFileSync(path.join(path.resolve(dir), 'reports', `${r.case}__${r.strategy}.json`), 'utf8')); r.findings = clusterFindings(rep.findings.filter(x => x.severity !== 'info')).length; r.consulted = rep.notes.consulted; r.direct = rep.notes.direct; } catch {}
    rows.push({ ...r, noted: !!(byId.get(r.case)?.noted?.length), run: path.basename(dir) });
  }
}
const strategies = [...new Set(rows.map(r => r.strategy))];
const pct = (a, b) => b ? `${a}/${b} (${Math.round(100 * a / b)}%)` : '-';
const L = [`| strategy | bugs caught | cache knows the fix | cache does not | controls clean | findings / review | $ / review | s / review |`, '|---|---|---|---|---|---|---|---|'];
for (const s of strategies) {
  const all = rows.filter(r => r.strategy === s), bugs = all.filter(r => r.hit !== null), ctrl = all.filter(r => r.hit === null);
  const part = xs => pct(xs.filter(r => r.hit).length, xs.length);
  const avg = k => all.length ? all.reduce((t, r) => t + (r[k] || 0), 0) / all.length : 0;
  L.push(`| ${s} | ${part(bugs)} | ${part(bugs.filter(r => r.noted))} | ${part(bugs.filter(r => !r.noted))} | ${ctrl.length ? pct(ctrl.filter(r => !r.findings).length, ctrl.length) : '-'} | ${avg('findings').toFixed(1)} | ${avg('cost').toFixed(2)} | ${Math.round(avg('ms') / 1000)} |`);
}
L.push('', `| case | noted | ${strategies.join(' | ')} |`, `|---|---|${strategies.map(() => '---').join('|')}|`);
for (const c of cases) {
  const rs = rows.filter(r => r.case === c.id); if (!rs.length) continue;
  L.push(`| ${c.id} | ${c.noted?.length ? c.noted.join(',') : '-'} | ${strategies.map(s => { const r = rs.find(x => x.strategy === s); if (!r) return '-'; if (r.hit === null) return r.findings ? `${r.findings} fp` : 'clean'; return r.hit ? `hit (${r.hitSource}${r.fromFixNote ? ', fix note' : ''}; ${r.findings}f)` : `miss (${r.findings}f)`; }).join(' | ')} |`);
}
process.stdout.write(L.join('\n') + '\n');
