// Hold cached retrieval/context fixed while redacting the selected note text.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { Store } from '../../../../src/store.js';
import { review, resolveScope, renderReview, parseDiff } from '../../../../src/review.js';

const [repo, casesFile, sourceNotes, out] = process.argv.slice(2);
if (![repo, casesFile, sourceNotes, out].every(Boolean)) throw new Error('usage: node run-pairs.mjs <autoscaler-clone> <cases.json> <notes-dir> <output-dir>');
if (process.env.THINKER_TEST !== '1' || process.env.THINKER_LLM !== 'codex' || process.env.THINKER_LLM_MODEL !== 'gpt-6.1-sol' || process.env.THINKER_CODEX_REASONING_EFFORT !== 'high' || process.env.THINKER_REDACT_NOTE_TEXT !== '1') throw new Error('Model, effort, redaction, and test-mode pins are required');
const manifest = JSON.parse(fs.readFileSync(casesFile, 'utf8'));
const cases = manifest.cases;
const git = (cwd, args, input) => execFileSync('git', args, { cwd, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
const runDir = path.resolve(out);
const notesDir = path.join(runDir, 'cache', 'notes');
const wtDir = path.join(runDir, 'wt');
fs.mkdirSync(notesDir, { recursive: true });
fs.mkdirSync(wtDir, { recursive: true });
for (const file of fs.readdirSync(sourceNotes).filter(f => f.endsWith('.json'))) fs.copyFileSync(path.join(sourceNotes, file), path.join(notesDir, file));
process.env.THINKER_NOTES_DIR = notesDir;
const resultsFile = path.join(runDir, 'results.json');
const rows = fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile, 'utf8')) : [];
const save = () => fs.writeFileSync(resultsFile, JSON.stringify(rows, null, 2) + '\n');
const pinned = r => !r.errors.length && r.models?.['codex/gpt-6.1-sol'] === 1 && Object.keys(r.models).length === 1;

for (const c of cases) {
  if (rows.some(r => r.id === c.id && r.redacted?.validModel)) continue;
  const wt = path.join(wtDir, c.id);
  const arms = [['redacted', { mode: 'holistic', related: true }]];
  const row = { ...(rows.find(r => r.id === c.id) || {}), id: c.id, pr: c.pr, source: `https://github.com/kubernetes/autoscaler/pull/${c.pr}`, sha: c.sha, base: manifest.base, intervention: 'redact selected note title/body/applies/id in model prompt; preserve slots, retrieval, dependency state, selected code, system, schema', model: 'gpt-6.1-sol', reasoningEffort: 'high' };
  delete row.error;
  try {
    git(repo, ['worktree', 'add', '--detach', wt, manifest.base]);
    const fix = git(repo, ['diff', '--binary', c.parent, c.sha]);
    git(wt, ['apply', '--reverse'], fix);
    const changed = git(wt, ['diff', '--no-color', '-U0', 'HEAD']);
    row.expect = Object.fromEntries(parseDiff(changed).map(f => [f.path, [...new Set([...f.touched, ...f.removedAt])].sort((a, b) => a - b)]));
    const store = new Store(wt).init();
    for (const [arm, strategy] of arms) {
      if (row[arm]?.validModel) continue;
      const start = performance.now();
      const report = await review(store, { scope: resolveScope(wt), strategy, model: 'gpt-6.1-sol', max: 12 });
      row[arm] = { elapsedMs: Math.round(performance.now() - start), tokens: report.tokens, models: report.models, notes: report.notes, toAssess: report.toAssess, findings: report.findings, verdicts: report.verdicts, intentEvidence: report.intentEvidence, criterionSupport: report.criterionSupport, errors: report.errors, validModel: pinned(report) };
      fs.writeFileSync(path.join(runDir, `${c.id}-${arm}.txt`), renderReview(report) + '\n');
      save();
      if (!row[arm].validModel) throw new Error(`${arm} model mismatch/error: ${JSON.stringify({ models: report.models, errors: report.errors })}`);
    }
  } catch (error) {
    row.error = String(error.message || error).slice(0, 1000);
  } finally {
    try { git(repo, ['worktree', 'remove', '--force', wt]); } catch {}
    const old = rows.findIndex(r => r.id === c.id);
    if (old >= 0) rows[old] = row; else rows.push(row);
    save();
    console.log(JSON.stringify({ id: row.id, notes: row.redacted?.notes?.consulted, redacted: row.redacted?.findings?.map(f => `${f.severity}:${f.file}:${f.line} ${f.message?.slice(0, 110)}`), tokens: row.redacted?.tokens, error: row.error || null }));
  }
}
