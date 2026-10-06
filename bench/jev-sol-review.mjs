// Five previously measured review cases, rerun with current Jev note selection and step gates.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Store} from '../src/store.js';
import {review, resolveScope, parseDiff, renderReview} from '../src/review.js';

if (process.env.THINKER_TEST !== '1' || process.env.THINKER_LLM !== 'codex' ||
    process.env.THINKER_LLM_MODEL !== 'gpt-6.1-sol' || process.env.THINKER_JEV !== 'on' ||
    process.env.THINKER_CODEX_REASONING_EFFORT !== 'high') {
  throw new Error('Test mode, exact Sol model/provider and Jev-on must be pinned');
}
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const protocol = JSON.parse(fs.readFileSync(path.join(root, 'research/jev-sol-opus-ten/protocol.json')));
const out = path.join(root, 'bench/runs/jev-sol-review-20261006');
const original = JSON.parse(fs.readFileSync(path.join(root, 'research/autoscaler-reviews/cohorts/sol/results/results.json')));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'research/autoscaler-reviews/cases.json')));
const repo = protocol.sol.repo_path;
fs.mkdirSync(out, {recursive: true});
const git = (cwd, args, input) => execFileSync('git', args, {cwd, input, encoding: 'utf8', maxBuffer: 64 << 20});
const records = [];
for (const item of manifest.cases.slice(0, 5)) {
  const outputFile = path.join(out, item.id + '.json');
  if (fs.existsSync(outputFile)) { records.push(JSON.parse(fs.readFileSync(outputFile))); continue; }
  const cwd = path.join(root, 'bench/worktrees', 'jev-sol-review-' + item.id);
  const notesDir = path.join(out, 'notes', item.id);
  fs.cpSync(path.join(root, 'research/jev-sol-opus-ten/sol-notes'), notesDir, {recursive: true});
  process.env.THINKER_NOTES_DIR = notesDir;
  process.env.THINKER_LOG = path.join(out, item.id + '.thinker.jsonl');
  const row = {id: item.id, pr: item.pr, model: 'gpt-6.1-sol', effort: 'high', base: manifest.base,
    historical: original.find(r => r.id === item.id)};
  git(repo, ['worktree', 'add', '--detach', cwd, manifest.base]);
  try {
    const fix = git(repo, ['diff', '--binary', item.parent, item.sha]);
    git(cwd, ['apply', '--reverse'], fix);
    const diff = git(cwd, ['diff', '--no-color', '-U0', 'HEAD']);
    fs.writeFileSync(path.join(out, item.id + '.patch'), diff);
    row.expect = Object.fromEntries(parseDiff(diff).map(f => [f.path, [...new Set([...f.touched, ...f.removedAt])].sort((a, b) => a - b)]));
    if (JSON.stringify(row.expect) !== JSON.stringify(row.historical.expect)) throw new Error('Historical change scope differs');
    const store = new Store(cwd).init();
    const start = performance.now();
    const report = await review(store, {scope: resolveScope(cwd), strategy: {mode: 'holistic', related: true}, model: 'gpt-6.1-sol', max: 12});
    row.elapsedMs = Math.round(performance.now() - start);
    row.report = report;
    const log = fs.readFileSync(process.env.THINKER_LOG, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    row.retrievalErrors = log.filter(e => ['jev-error', 'ce-error'].includes(e.op));
    row.valid = !report.errors.length && !row.retrievalErrors.length &&
      Object.keys(report.models || {}).every(m => m === 'codex/gpt-6.1-sol') &&
      log.filter(e => e.op === 'model').every(e => e.provider === 'codex' && e.model === 'gpt-6.1-sol' && !e.failed) && Boolean(report.gates);
    fs.writeFileSync(path.join(out, item.id + '.txt'), renderReview(report) + '\n');
    if (!row.valid) throw new Error('Model/retrieval error; retained as invalid');
  } catch (error) {
    row.error = error.message;
    row.valid = false;
  } finally {
    fs.writeFileSync(outputFile, JSON.stringify(row, null, 2));
    records.push(row);
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(records, null, 2));
    git(repo, ['worktree', 'remove', '--force', cwd]);
  }
  console.log(JSON.stringify({id: row.id, valid: row.valid, notes: row.report?.notes.consulted,
    tokens: row.report?.tokens, elapsedMs: row.elapsedMs, models: row.report?.models, gates: row.report?.gates, error: row.error}));
  if (!row.valid) throw new Error('Stopping after invalid case ' + item.id);
}
