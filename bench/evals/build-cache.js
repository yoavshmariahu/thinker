#!/usr/bin/env node
// Build one benchmark cache, started by the evals app as a detached job:
//   node bench/evals/build-cache.js <bench dir> <plan.json>
// A checkout whose history stops at the anchor, the product's own mining, phrasing and relinking in
// it, and a receipt with what was built. Every step that fails, or an empty cache, marks the receipt
// failed; nothing falls back to another source.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cacheDir, notesDir, countNotes, hashNotes, noteSources } from './caches.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [benchDir, planFile] = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
const out = cacheDir(benchDir, plan.name);
const repo = path.join(out, 'repo');
const CLI = path.resolve(HERE, '..', '..', 'src', 'cli.js');
const receiptFile = path.join(out, 'receipt.json');
const receipt = { ...plan, status: 'building', created_at: Date.now(), steps_done: [] };
const save = () => fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n');
const log = m => console.log(`[${new Date().toISOString()}] ${m}`);
const fail = m => { receipt.status = 'failed'; receipt.error = m; receipt.finished_at = Date.now(); save(); log('FAILED ' + m); process.exit(1); };

fs.mkdirSync(out, { recursive: true });
save();

// 1. the snapshot: a clone of a temporary branch at the anchor, so later commits are not in it
const src = path.join(benchDir, 'repos', plan.repo);
const branch = `evals-anchor-${plan.name}`;
try {
  execFileSync('git', ['-C', src, 'branch', '-f', branch, plan.anchor], { stdio: 'ignore' });
  execFileSync('git', ['clone', '--quiet', '--single-branch', '--branch', branch, `file://${src}`, repo], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'remote', 'remove', 'origin'], { stdio: 'ignore' });
} catch (e) { fail('snapshot: ' + e.message); }
finally { try { execFileSync('git', ['-C', src, 'branch', '-D', branch], { stdio: 'ignore' }); } catch {} }
const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (head !== plan.anchor) fail(`snapshot is at ${head}, not the anchor ${plan.anchor}`);
receipt.steps_done.push('snapshot'); save(); log(`snapshot at ${head.slice(0, 10)}`);

// A build spends more in an hour than a repository is meant to spend in a day: without lifting the
// daily cap, mining stops partway and the rest fail their checks (research/efficiency-simple/run.py).
fs.mkdirSync(path.join(repo, '.thinker'), { recursive: true });
fs.writeFileSync(path.join(repo, '.thinker', 'config.json'), JSON.stringify({ version: 1, maintain: { dailyTokens: 1_000_000_000 } }, null, 2) + '\n');

const env = {
  ...process.env, THINKER_TEST: '1', THINKER_TELEMETRY: 'off', THINKER_LOG: 'local', THINKER_NO_AUTO_UPDATE: '1', THINKER_HOLDOUT: 'off',
  THINKER_LLM: plan.llm, THINKER_LLM_MODEL: plan.model,
  ...(plan.effort ? { THINKER_CLAUDE_EFFORT: plan.effort, THINKER_CODEX_REASONING_EFFORT: plan.effort } : {}),
};
delete env.THINKER_NOTES_DIR;
for (const [label, args] of [['mine-prs', ['mine-prs', '--git', '--limit', String(plan.limit)]], ['phrase', ['phrase']], ['relink', ['relink']]]) {
  log(`thinker ${args.join(' ')}`);
  const r = spawnSync(process.execPath, [CLI, ...args, '--repo', repo], { cwd: repo, env, encoding: 'utf8', maxBuffer: 64 << 20 });
  process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || '');
  if (r.status !== 0) fail(`${label} exited ${r.status}`);
  if (label === 'mine-prs') {
    // mine-prs exits 0 when changes fail (they stay unmarked for a retry), so its own counts decide
    const all = (r.stdout || '') + (r.stderr || '');
    const m = [...all.matchAll(/(\d+)\/(\d+) processed · (\d+) notes? saved(?: · (\d+) failed)?/g)].pop();
    const processed = m ? Number(m[2]) : null, saved = m ? Number(m[3]) : null, failed = m ? Number(m[4] || 0) : null;
    receipt.mining = { processed, saved, failed, warning: (all.match(/Warning: [^\n]*/) || [null])[0] };
    if (processed == null) fail('mine-prs printed no summary: cannot tell what it mined');
    if (!saved) fail(`mine-prs saved no notes (${failed} of ${processed} changes failed${receipt.mining.warning ? '; ' + receipt.mining.warning : ''})`);
    if (failed / processed > 0.2) fail(`mine-prs failed on ${failed} of ${processed} changes${receipt.mining.warning ? '; ' + receipt.mining.warning : ''}`);
  }
  receipt.steps_done.push(label); save();
}

// what was built, from the cache and the product's own log
const notes = notesDir(benchDir, plan.name);
receipt.notes = countNotes(notes);
receipt.notes_hash = hashNotes(notes);
let described = 0;
for (const f of fs.existsSync(notes) ? fs.readdirSync(notes) : []) {
  try { const n = JSON.parse(fs.readFileSync(path.join(notes, f), 'utf8')); if (n.search || n.description || n.phrasings?.length) described++; } catch {}
}
receipt.described = described;
receipt.sources = noteSources(notes);
const usage = { tokens: 0, mined: 0, saved: 0 };
for (const file of ['log.jsonl', path.join('state', 'log.jsonl')]) {
  const p = path.join(repo, '.thinker', file);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.op === 'mine-prs') { usage.mined += e.prs || 0; usage.saved += e.saved || 0; usage.tokens += Number(e.tokens?.total ?? e.tokens) || 0; }
    else if (e.op === 'phrase' && e.cost) usage.tokens += Number(e.cost.tokens ?? e.cost.total ?? 0) || 0;
  }
}
receipt.usage = usage;
receipt.finished_at = Date.now();
if (!receipt.notes) fail('the build saved no notes: an empty cache measures nothing');
if (receipt.sources.other) fail(`${receipt.sources.other} notes are not sourced from a mined PR`);
receipt.status = 'ok';
save();
log(`done: ${receipt.notes} notes (${described} described), ${usage.mined} changes mined, hash ${receipt.notes_hash}`);
