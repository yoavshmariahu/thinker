#!/usr/bin/env node
// Build one benchmark cache, started by Artemis as a detached job:
//   node bench/evals/build-cache.js <bench dir> <plan.json> <evals db>
// A checkout whose history stops at the anchor, the product's own mining, phrasing and relinking in
// it, and a receipt with what was built. Every step that fails, or an empty cache, marks the receipt
// failed; nothing falls back to another source.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cacheDir, notesDir, countNotes, hashNotes, noteSources, kindOf, KINDS } from './caches.js';
import { openDb } from './db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [benchDir, planFile, dbFile] = process.argv.slice(2);
const db = openDb(dbFile);  // the receipt is kept in the evals database, the system of record
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
const out = cacheDir(benchDir, plan.name);
const repo = path.join(out, 'repo');
const CLI = path.resolve(HERE, '..', '..', 'src', 'cli.js');
const prev = plan.resume ? db.getCache(plan.name) : null;
if (plan.resume && !prev) { console.error(`no receipt of ${plan.name} to resume`); process.exit(1); }
const receipt = prev ? { ...prev, status: 'building', error: undefined, resumed_at: [...(prev.resumed_at || []), Date.now()] } : { ...plan, status: 'building', created_at: Date.now(), steps_done: [] };
delete receipt.resume; delete receipt.done;
const done = step => receipt.steps_done.includes(step);
const kind = kindOf(plan);
const save = () => db.putCache(receipt);
const log = m => console.log(`[${new Date().toISOString()}] ${m}`);
const fail = m => { receipt.status = 'failed'; receipt.error = m; receipt.finished_at = Date.now(); save(); log('FAILED ' + m); process.exit(1); };

fs.mkdirSync(out, { recursive: true });
save();
if (prev) log(`resuming after ${receipt.steps_done.join(', ') || 'nothing'}`);

// 1. the snapshot: a clone of a temporary branch at the anchor, so later commits are not in it
const src = path.join(benchDir, 'repos', plan.repo);
const branch = `evals-anchor-${plan.name}`;
if (!done('snapshot')) {
  try {
    execFileSync('git', ['-C', src, 'branch', '-f', branch, plan.anchor], { stdio: 'ignore' });
    // shallow, but deep enough for mining to choose its changes (a 4.8 GB history is not copied whole), and
    // for an understanding build to rank files by the commits of its window (src/understand.js, 180 days)
    const shallow = kind === 'mined' ? ['--depth', String(Math.max(500, plan.limit * 10))]
      : [`--shallow-since=${new Date(Date.parse(plan.anchor_date) - 200 * 86_400_000).toISOString()}`];
    execFileSync('git', ['clone', '--quiet', '--single-branch', ...shallow, '--branch', branch, `file://${src}`, repo], { stdio: 'ignore' });
    execFileSync('git', ['-C', repo, 'remote', 'remove', 'origin'], { stdio: 'ignore' });
  } catch (e) { fail('snapshot: ' + e.message); }
  finally { try { execFileSync('git', ['-C', src, 'branch', '-D', branch], { stdio: 'ignore' }); } catch {} }
}
const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (head !== plan.anchor) fail(`snapshot is at ${head}, not the anchor ${plan.anchor}`);
if (!done('snapshot')) { receipt.steps_done.push('snapshot'); save(); log(`snapshot at ${head.slice(0, 10)}`); }

// A build spends more in an hour than a repository is meant to spend in a day: without lifting the
// daily cap, mining stops partway and the rest fail their checks (research/efficiency-simple/run.py).
fs.mkdirSync(path.join(repo, '.thinker'), { recursive: true });
fs.writeFileSync(path.join(repo, '.thinker', 'config.json'), JSON.stringify({ version: 1, maintain: { dailyTokens: 1_000_000_000 } }, null, 2) + '\n');

delete process.env.THINKER_NOTES_DIR;  // the build and the export work in the snapshot's own store
const env = {
  ...process.env, THINKER_TEST: '1', THINKER_TELEMETRY: 'off', THINKER_LOG: 'local', THINKER_NO_AUTO_UPDATE: '1', THINKER_HOLDOUT: 'off',
  THINKER_LLM: plan.llm, THINKER_LLM_MODEL: plan.model,
  ...(plan.effort ? { THINKER_CLAUDE_EFFORT: plan.effort, THINKER_CODEX_REASONING_EFFORT: plan.effort } : {}),
};
// a step's output is streamed to the log as it comes, and mining's "n/m processed" kept on the receipt,
// so the cache's page shows the build moving instead of a silent step
function runStep(label, args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args, '--repo', repo], { cwd: repo, env });
    let stdout = '', stderr = '', last = 0;
    const seen = chunk => {
      // "n/m processed", or "<part>: n/m processed" when a step has passes of its own (understand: reading code, instance views)
      const m = [...String(chunk).matchAll(/(?:([a-z][a-z ]*[a-z]): )?(\d+)\/(\d+) processed/g)].pop();
      if (m) { receipt.progress = { step: label, ...(m[1] ? { part: m[1] } : {}), done: Number(m[2]), total: Number(m[3]) }; if (Date.now() - last > 2000) { last = Date.now(); save(); } }
    };
    child.stdout.on('data', c => { stdout += c; process.stdout.write(c); seen(c); });
    child.stderr.on('data', c => { stderr += c; process.stderr.write(c); seen(c); });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

const build = kind === 'mined' ? ['mine-prs', ['mine-prs', '--git', '--limit', String(plan.limit)]]
  : ['understand', ['understand', '--top', String(plan.top), ...(plan.areas?.length ? ['--areas', plan.areas.join(',')] : ['--all'])]];
for (const [label, args] of [build, ['phrase', ['phrase']], ['relink', ['relink']]]) {
  if (done(label)) continue;
  log(`thinker ${args.join(' ')}`);
  receipt.progress = { step: label }; save();
  const r = await runStep(label, args);
  if (r.status !== 0) fail(`${label} exited ${r.status}`);
  if (label === 'mine-prs') {
    // mine-prs exits 0 when changes fail (they stay unmarked for a retry), so its own counts decide
    const all = (r.stdout || '') + (r.stderr || '');
    const m = [...all.matchAll(/(\d+)\/(\d+) processed · (\d+) notes? saved(?:[^\n]*?(\d+) failed)?/g)].pop();
    const processed = m ? Number(m[2]) : null, saved = m ? Number(m[3]) : null, failed = m ? Number(m[4] || 0) : null;
    receipt.mining = { processed, saved, failed, warning: (all.match(/Warning: [^\n]*/) || [null])[0] };
    if (processed == null) fail('mine-prs printed no summary: cannot tell what it mined');
    if (!saved) fail(`mine-prs saved no notes (${failed} of ${processed} changes failed${receipt.mining.warning ? '; ' + receipt.mining.warning : ''})`);
    if (failed / processed > 0.2) fail(`mine-prs failed on ${failed} of ${processed} changes${receipt.mining.warning ? '; ' + receipt.mining.warning : ''}`);
  }
  if (label === 'understand') {
    // understand exits 1 when more than a fifth of its calls failed; its summary line says what it read and saved
    const m = (r.stdout || '').match(/(\d+) files .*? · (\d+) calls · (\d+) notes saved(?: · (\d+) failed)?/);
    receipt.understanding = m ? { files: Number(m[1]), calls: Number(m[2]), saved: Number(m[3]), failed: Number(m[4] || 0) } : null;
    if (!receipt.understanding) fail('understand printed no summary: cannot tell what it read');
    if (!receipt.understanding.saved) fail(`understand saved no notes (${receipt.understanding.failed} of ${receipt.understanding.calls} calls failed)`);
  }
  receipt.steps_done.push(label); save();
}

// 5. export: every note whole, through the product's store, into the one directory an arm is served
const notes = notesDir(benchDir, plan.name);
{
  log('export the notes whole');
  const { Store } = await import(path.resolve(HERE, '..', '..', 'src', 'store.js'));
  const store = new Store(repo, { readonly: true });
  fs.rmSync(notes, { recursive: true, force: true });
  fs.mkdirSync(notes, { recursive: true });
  for (const n of store.list()) fs.writeFileSync(path.join(notes, n.id + '.json'), JSON.stringify(n, null, 2) + '\n');
  if (!done('export')) receipt.steps_done.push('export');
  save();
}

// what was built, from the cache and the product's own log
receipt.notes = countNotes(notes);
receipt.notes_hash = hashNotes(notes);
let described = 0;
for (const f of fs.existsSync(notes) ? fs.readdirSync(notes) : []) {
  try { const n = JSON.parse(fs.readFileSync(path.join(notes, f), 'utf8')); if (n.search || n.description || n.phrasings?.length) described++; } catch {}
}
receipt.described = described;
receipt.sources = noteSources(notes);
// what the build spent: every model call the product logged (op 'model', src/model-usage.js), by class; the
// steps' own totals are only counts (understand's lost its tokens under Codex, 2026-10-16: 0 for 15.1M read)
const usage = { tokens: 0, input: 0, cached: 0, output: 0, calls: 0, mined: 0, saved: 0 };
for (const file of ['log.jsonl', path.join('state', 'log.jsonl')]) {
  const p = path.join(repo, '.thinker', file);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.op === 'model') {
      const t = e.tokens || {};
      usage.calls++; usage.input += Number(t.inputTokens) || 0; usage.cached += Number(t.cacheReadTokens) || 0; usage.output += Number(t.outputTokens) || 0;
    } else if (e.op === 'mine-prs') { usage.mined += e.prs || 0; usage.saved += e.saved || 0; }
    else if (e.op === 'understand') { usage.files = (usage.files || 0) + (e.files || 0); usage.saved += e.saved || 0; }
  }
}
usage.tokens = usage.input + usage.output;
receipt.usage = usage;
receipt.finished_at = Date.now();
if (!receipt.notes) fail('the build saved no notes: an empty cache measures nothing');
{ const want = KINDS[kind].source, other = Object.entries(receipt.sources).filter(([k]) => k !== want).reduce((s, [, v]) => s + v, 0);
  if (other) fail(`${other} notes are not ${kind === 'mined' ? 'sourced from a mined PR' : 'read from the code'}`); }
receipt.status = 'ok';
delete receipt.progress;
save();
log(`done: ${receipt.notes} notes (${described} described), ${kind === 'mined' ? `${usage.mined} changes mined` : `${usage.files || 0} files read`}, hash ${receipt.notes_hash}`);
