// Mine reusable notes from the ten preselected Autoscaler fix PRs.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../../../../src/store.js';
import { distillPr } from '../../../../src/prs.js';
import { saveNotes } from '../../../../src/distill.js';

const [repo, casesFile, output] = process.argv.slice(2);
if (!repo || !casesFile || !output) throw new Error('usage: node build-notes.mjs <fixed-worktree> <cases.json> <output.json>');
if (process.env.THINKER_TEST !== '1' || process.env.THINKER_LLM !== 'gemini' || process.env.THINKER_LLM_MODEL !== 'gemini-3.1-pro-high') throw new Error('Model, effort, and test-mode pins are required');
const cases = JSON.parse(fs.readFileSync(casesFile, 'utf8')).cases;
const store = new Store(repo).init();
const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const rows = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : [];
for (const c of cases) {
  const prior = rows.findIndex(row => row.id === c.id);
  if (prior >= 0 && !rows[prior].error) continue;
  const row = { id: c.id, pr: c.pr, source: `kubernetes/autoscaler#${c.pr}` };
  try {
    const meta = JSON.parse(execFileSync('gh', ['pr', 'view', String(c.pr), '--repo', 'kubernetes/autoscaler', '--json', 'title,body,url,mergedAt'], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }));
    row.title = meta.title;
    row.url = meta.url;
    row.mergedAt = meta.mergedAt;
    const diff = git(['diff', c.parent, c.sha]);
    const mined = await distillPr('kubernetes/autoscaler', { number: c.pr, prNumber: c.pr, hash: c.sha, title: meta.title, body: meta.body, diff, comments: [], isGitCommit: true }, { model: 'gemini-3.1-pro-high', repo, accounting: { store, purpose: 'mine-prs', phase: 'init', pr: c.pr } });
    const saved = saveNotes(store, mined.notes, { source: { type: 'pr', ref: row.source } });
    row.proposed = mined.notes.map(n => ({ title: n.title, kind: n.kind }));
    row.saved = [...saved.saved, ...saved.merged].map(n => ({ id: n.id, title: n.title, kind: n.kind, body: n.body, deps: n.deps?.map(d => ({ path: d.path, symbol: d.symbol })) }));
    row.skipped = saved.skipped.length;
    row.tokens = mined.tokens;
  } catch (error) {
    row.error = String(error.message || error).slice(0, 500);
  }
  if (prior >= 0) rows[prior] = row;
  else rows.push(row);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(rows, null, 2) + '\n');
  console.log(`${row.id} ${row.error ? `ERROR ${row.error}` : `${row.saved.length} notes saved${row.proposed.length !== row.saved.length ? ` (${row.proposed.length} proposed)` : ''}`}`);
}
