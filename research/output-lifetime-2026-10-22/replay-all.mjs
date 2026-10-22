// The machine-wide replay behind the README's table: every Claude Code session of the last 30 days over 20 KB, a
// grid of clearing policies (src/proxy-replay.js). Run from the repository: node research/output-lifetime-2026-10-22/replay-all.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replay } from '../../src/proxy-replay.js';

const root = path.join(process.env.HOME, '.claude', 'projects'), cutoff = Date.now() - 30 * 864e5, files = [];
for (const d of fs.readdirSync(root)) {
  const dir = path.join(root, d);
  let xs = []; try { xs = fs.readdirSync(dir); } catch { continue; }
  for (const f of xs) if (f.endsWith('.jsonl')) { const p = path.join(dir, f); try { const st = fs.statSync(p); if (st.mtimeMs > cutoff && st.size > 20000) files.push(p); } catch { /* gone */ } }
}
const policies = {};
for (const [t, c] of [[60000, 60000], [100000, 80000], [150000, 100000]]) {
  policies[`keep3 ${t / 1000}/${c / 1000}`] = { keep: 3, trigger: t, clearAtLeast: c };
  policies[`turn3 ${t / 1000}/${c / 1000}`] = { keep: 'turn', keepMin: 3, trigger: t, clearAtLeast: c };
  policies[`turn1 ${t / 1000}/${c / 1000}`] = { keep: 'turn', keepMin: 1, trigger: t, clearAtLeast: c };
}
const t0 = Date.now(), r = replay(files, policies);
const pct = x => `${(100 * x).toFixed(2)}%`, M = x => `${(x / 1e6).toFixed(0)}M`;
const show = (name, t) => {
  console.log(`\n${name}: ${t.sessions} sessions, ${M(t.base)} billed-eq, ceiling ${pct(t.ceiling)}`);
  for (const [k, p] of Object.entries(t.policies)) console.log(`  ${k.padEnd(16)} saves ${pct(p.saving).padStart(7)}  costlier ${String(p.costlier).padStart(4)}  clears ${String(p.clears).padStart(5)}  cleared ${M(p.cleared)}`);
};
console.log(`files ${files.length}, ${Date.now() - t0} ms (${path.basename(fileURLToPath(import.meta.url))})`);
show('All', r.all);
for (const [k, t] of Object.entries(r.byLength)) show(k, t);
