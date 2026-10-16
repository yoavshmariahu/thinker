// Step 1 of building understanding notes without knowing the tasks: which areas would area warming
// (src/areas.js:activityAreas) pick from the repository's history up to the base, and how much of the
// tasks' changed source would they cover? Repo-wide (every author), since a benchmark has no user.
// The gold files are read only to score coverage, never to choose.
// usage: node area-coverage.mjs <tasks.json> <base checkout>
import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
import { activityAreas } from '../../src/areas.js';

const [tasksFile, base] = process.argv.slice(2);
const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8')).tasks;
const now = new Date(Number(execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: base, encoding: 'utf8' }).trim()) * 1000);
const files = execFileSync('git', ['ls-files'], { cwd: base, encoding: 'utf8', maxBuffer: 1 << 28 }).trim().split('\n');
const isCode = f => /\.(py|ts|tsx|js)$/.test(f) && !/(^|\/)tests?\//.test(f);
const lines = f => { try { return fs.readFileSync(path.join(base, f), 'utf8').split('\n').length; } catch { return 0; } };
const outline = f => { try { return fs.readFileSync(path.join(base, f), 'utf8').split('\n').filter(l => /^\s*(class |def |async def |export (const|function|class) )/.test(l)).length; } catch { return 0; } };
const gold = t => (t.goldFiles || []).filter(f => !/(^|\/)tests?\/|test_|\.test\.|\.mdx?$/.test(f));
const totalCode = files.filter(isCode).reduce((s, f) => s + lines(f), 0);

console.log(`base ${now.toISOString().slice(0, 10)}; repo code ${Math.round(totalCode / 1000)}k lines (tests excluded)\n`);
for (const [depth, top, since] of [[2, 5, 180], [2, 10, 180], [3, 5, 180], [3, 10, 180], [3, 20, 180], [3, 10, 60]]) {
  const a = activityAreas(base, { email: '.', depth, top, since, now, noGitHub: true });
  const inArea = f => a.directories.some(d => f === d || f.startsWith(d + '/'));
  const areaFiles = files.filter(f => isCode(f) && inArea(f));
  const lc = areaFiles.reduce((s, f) => s + lines(f), 0), oc = areaFiles.reduce((s, f) => s + outline(f), 0);
  const per = tasks.map(t => { const g = gold(t); const hit = g.filter(inArea).length; return { id: t.id.slice(0, 7), g: g.length, hit }; });
  const full = per.filter(p => p.g && p.hit === p.g).length, any = per.filter(p => p.hit > 0).length;
  console.log(`depth ${depth} top ${top} since ${since}d: ${a.directories.length} areas, ${areaFiles.length} files, ${Math.round(lc / 1000)}k lines (${(100 * lc / totalCode).toFixed(1)}% of code; full read ≈ ${(lc * 20 / 1e6).toFixed(1)}M tokens, outlines ≈ ${(oc * 25 / 1e6).toFixed(2)}M)`);
  console.log(`  tasks with every changed source file covered ${full}/13, with some ${any}/13 | ${per.map(p => `${p.id}:${p.hit}/${p.g}`).join(' ')}`);
  console.log(`  areas: ${a.directories.join(', ')}`);
}
