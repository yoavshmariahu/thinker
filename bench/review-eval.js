#!/usr/bin/env node
// Which way of reviewing a change against the cache catches bugs, and at what cost in false
// positives, dollars and time. Cases: bugs planted into the code (each a one-line edit a reviewer
// could miss), real fixes from the history reverted onto the base (the bug comes back), real
// non-fix commits and behaviour-preserving refactors as controls. Every case is reviewed under
// every strategy of review.js (nocache is the baseline: the same model, no notes).
//
//   node bench/review-eval.js run --repo <checkout> --cases bench/review-eval-cases.json \
//        --strategies nocache,notes,holistic --out bench/runs/review-eval/<name> [--only a,b] [--dry] [--max 12]
//        [--notes <dir>]   a noteset to review with (bench/notesets/<name>/notes) instead of the checkout's cache
//   node bench/review-eval.js report --out bench/runs/review-eval/<name>
//
// A hit: an error or warning finding in a file the bug touched, within 6 lines of it. A false
// positive: an error or warning on a control. Results append to results.jsonl and a rerun skips
// what is there, so a run can be stopped and resumed. Nothing is written to the checkout: cases
// are prepared in worktrees under <out>/wt and removed after.
process.env.THINKER_TELEMETRY = 'off';
process.env.THINKER_LOG = process.env.THINKER_LOG || 'local';
process.env.THINKER_CODEGRAPH = process.env.THINKER_CODEGRAPH || 'git';
process.env.THINKER_NO_LEARN = '1';
process.env.THINKER_NO_BG_VERIFY = '1';
// One provider for the whole run: after a failure llm.js otherwise sticks to the fallback provider,
// and a review labelled sonnet would be answered by another model. THINKER_LLM overrides.
process.env.THINKER_LLM = process.env.THINKER_LLM || 'claude';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const cmd = argv.shift();
const flags = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const k = argv[i].slice(2); flags[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
const out = path.resolve(flags.out || 'bench/runs/review-eval/latest');
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

export const STRATEGIES = {
  nocache: { mode: 'nocache' },
  'nocache-callers': { mode: 'nocache', callers: true },
  notes: {},
  'notes-direct': { related: false },
  'notes-callers': { callers: true },
  holistic: { mode: 'holistic' },
  'holistic-callers': { mode: 'holistic', callers: true },
  triage: { triage: true },
  'notes-haiku': { model: 'haiku' },
  'holistic-haiku': { mode: 'holistic', model: 'haiku' },
  'holistic-opus': { mode: 'holistic', model: 'opus' },
  ensemble: { mode: 'ensemble' },
  'ensemble-chunked': { mode: 'ensemble', chunks: 4 },
  'ensemble-chunked-verify': { mode: 'ensemble', chunks: 4, verify: true },
  'ensemble-verify': { mode: 'ensemble', verify: true },
  'holistic-verify': { mode: 'holistic', verify: true },
  'notes-verify': { verify: true },
  'nocache-opus': { mode: 'nocache', model: 'opus' },
};

// The cache every case is reviewed with: the checkout's shared and local notes, flat, as the
// benchmark arms take them (THINKER_NOTES_DIR); its co-change index beside them.
function buildCache(repo) {
  const dir = path.join(out, 'cache'), notes = path.join(dir, 'notes');
  fs.mkdirSync(notes, { recursive: true });
  let n = 0;
  for (const src of flags.notes ? [path.resolve(flags.notes)] : [path.join(repo, '.thinker', 'local', 'notes'), path.join(repo, '.thinker', 'notes')]) {
    if (!fs.existsSync(src)) continue;
    for (const f of fs.readdirSync(src)) if (f.endsWith('.json')) { fs.copyFileSync(path.join(src, f), path.join(notes, f)); n++; }
  }
  const co = flags.notes ? path.join(path.resolve(flags.notes), '..', 'cochange.json') : path.join(repo, '.thinker', 'cochange.json');
  if (fs.existsSync(co)) fs.copyFileSync(co, path.join(dir, 'cochange.json'));
  process.env.THINKER_NOTES_DIR = notes;
  return n;
}

function applyEdits(wt, edits) {
  const lines = {}, files = new Set();
  for (const e of edits) {
    const file = path.join(wt, e.file);
    let text = fs.readFileSync(file, 'utf8');
    files.add(e.file);
    if (e.deleteLineMatching) {
      const i = text.split('\n').findIndex(l => l.includes(e.deleteLineMatching));
      if (i < 0) throw new Error(`${e.file}: no line contains ${e.deleteLineMatching}`);
      const arr = text.split('\n'); arr.splice(i, 1); text = arr.join('\n');
      (lines[e.file] ||= []).push(i + 1);
    } else {
      if (!text.includes(e.find)) throw new Error(`${e.file}: not found: ${e.find.slice(0, 60)}`);
      const at = text.indexOf(e.find);
      text = e.all ? text.split(e.find).join(e.replace) : text.slice(0, at) + e.replace + text.slice(at + e.find.length);
      const line = text.slice(0, at).split('\n').length;
      (lines[e.file] ||= []).push(line, ...(e.replace ? Array.from({ length: e.replace.split('\n').length - 1 }, (_, k) => line + 1 + k) : []));
    }
    fs.writeFileSync(file, text);
  }
  return { files: [...files], lines };
}

// Lines a working-tree diff touched, per file (for a reverted fix: where the bug came back).
async function diffLines(wt, review) {
  const text = git(wt, ['diff', '--no-color', '-U0', 'HEAD', '--', '.', ':(exclude).thinker']);
  const lines = {}, files = [];
  for (const f of review.parseDiff(text)) { files.push(f.path); lines[f.path] = [...f.touched, ...f.removedAt]; }
  return { files, lines };
}

function prepare(repo, c, review) {
  const wt = path.join(out, 'wt', c.id);
  if (c.kind === 'commit') return { scope: review.resolveScope(repo, { ref: c.sha }), repo, expect: null };
  if (fs.existsSync(wt)) try { git(repo, ['worktree', 'remove', '--force', wt]); } catch {}
  try { git(repo, ['worktree', 'prune']); } catch {} // a registration left by a stopped run would refuse the path
  git(repo, ['worktree', 'add', '-f', '--detach', wt, c.base]);
  let expect = null;
  if (c.kind === 'planted' || c.kind === 'refactor') {
    const e = applyEdits(wt, c.edits);
    expect = c.kind === 'planted' ? { files: c.expectFiles || e.files, lines: e.lines, anyLine: !!c.anyLine } : null;
  } else if (c.kind === 'revert') {
    try { git(wt, ['-c', 'core.hooksPath=/dev/null', 'revert', '--no-commit', '--no-edit', c.sha]); }
    catch (err) { try { git(wt, ['revert', '--abort']); } catch {} git(repo, ['worktree', 'remove', '--force', wt]); throw new Error(`revert of ${c.sha} does not apply: ${String(err.stderr || err.message).split('\n')[0].slice(0, 120)}`); }
    try { git(wt, ['reset', '-q']); } catch {} // review the working tree, not the index
    expect = null; // filled from the diff once the reader exists
  }
  return { scope: review.resolveScope(wt), repo: wt, wt, expect };
}

const isHit = (f, expect) => (f.severity === 'error' || f.severity === 'warning') && expect.files.includes(f.file) && (expect.anyLine || (f.line > 0 && (expect.lines[f.file] || []).some(l => Math.abs(l - f.line) <= 6)));

async function run() {
  const repo = path.resolve(flags.repo || '.');
  const cases = JSON.parse(fs.readFileSync(path.resolve(flags.cases || 'bench/review-eval-cases.json'), 'utf8'));
  const only = flags.only ? String(flags.only).split(',') : null;
  const names = String(flags.strategies || 'nocache,notes').split(',').filter(Boolean);
  for (const s of names) if (!STRATEGIES[s]) throw new Error(`unknown strategy ${s}; have ${Object.keys(STRATEGIES).join(', ')}`);
  fs.mkdirSync(path.join(out, 'reports'), { recursive: true });
  const n = buildCache(repo);
  const review = await import('../src/review.js');
  const { Store } = await import('../src/store.js');
  const resultsFile = path.join(out, 'results.jsonl');
  const done = new Set(fs.existsSync(resultsFile) ? fs.readFileSync(resultsFile, 'utf8').split('\n').filter(Boolean).map(l => { const r = JSON.parse(l); return `${r.case}|${r.strategy}`; }) : []);
  const log = s => process.stderr.write(`[review-eval] ${s}\n`);
  log(`${n} notes in the cache; ${cases.cases.length} cases; strategies ${names.join(', ')}; out ${out}`);
  for (const c of cases.cases) {
    if (only && !only.includes(c.id)) continue;
    c.base = c.base || cases.base || 'HEAD';
    const todo = names.filter(s => !done.has(`${c.id}|${s}`));
    if (!todo.length) continue;
    let prep;
    try { prep = prepare(repo, c, review); } catch (e) { log(`skip ${c.id}: ${e.message}`); fs.appendFileSync(resultsFile, JSON.stringify({ case: c.id, kind: c.kind, skipped: e.message }) + '\n'); continue; }
    if (c.kind === 'revert') prep.expect = { ...(await diffLines(prep.wt, review)), anyLine: false };
    const store = new Store(prep.repo);
    for (const s of todo) {
      const strat = { ...STRATEGIES[s] }; const model = strat.model || flags.model; delete strat.model;
      const t0 = Date.now();
      let r;
      try { r = await review.review(store, { scope: prep.scope, max: Number(flags.max) || 12, model, dry: !!flags.dry, strategy: strat, concurrency: Number(flags.conc) || 4 }); }
      catch (e) { log(`${c.id} ${s}: failed: ${e.message}`); fs.appendFileSync(resultsFile, JSON.stringify({ case: c.id, kind: c.kind, strategy: s, failed: String(e.message).slice(0, 200) }) + '\n'); continue; }
      const ms = Date.now() - t0;
      if (r.empty) { log(`${c.id} ${s}: nothing to review (empty change)`); fs.appendFileSync(resultsFile, JSON.stringify({ case: c.id, kind: c.kind, strategy: s, failed: 'empty change' }) + '\n'); continue; }
      const text = review.renderReview(r, { verbose: true });
      fs.writeFileSync(path.join(out, 'reports', `${c.id}__${s}.txt`), text);
      fs.writeFileSync(path.join(out, 'reports', `${c.id}__${s}.json`), JSON.stringify(r, null, 1));
      const signal = r.findings.filter(f => f.severity !== 'info');
      const hits = prep.expect ? signal.filter(f => isHit(f, prep.expect)) : [];
      const noteSource = id => { try { const n = JSON.parse(fs.readFileSync(path.join(process.env.THINKER_NOTES_DIR, id + '.json'), 'utf8')); return `${n.source?.type || '?'}${n.source?.ref ? ':' + String(n.source.ref).slice(0, 40) : ''}`; } catch { return '?'; } };
      const hitNotes = [...new Set(hits.flatMap(f => f.notes?.length ? f.notes : f.note ? [f.note] : []))].map(id => ({ id, source: noteSource(id) }));
      const row = { case: c.id, kind: c.kind, pr: c.pr, strategy: s, hit: prep.expect ? hits.length > 0 : null, hitNotes, fromFixNote: !!(c.pr && hitNotes.some(h => /^pr:/.test(h.source) && h.source.includes(String(c.pr)))), hitBy: hits[0] ? `${hits[0].file}:${hits[0].line} ${hits[0].message.slice(0, 120)}` : null, hitSource: hits[0] ? (hits[0].notes?.length || hits[0].note ? 'note' : hits[0].basis ? 'deterministic' : 'code') : null,
        findings: signal.length, errors: r.counts.error, warnings: r.counts.warning, infos: r.counts.info, consulted: r.notes.consulted, assessed: r.notes.assessed, outdated: r.notes.outdated.length, modelErrors: r.errors.length, models: r.models, cost: Math.round(r.cost * 1000) / 1000, ms, dry: !!flags.dry || undefined };
      fs.appendFileSync(resultsFile, JSON.stringify(row) + '\n');
      log(`${c.id.padEnd(24)} ${s.padEnd(16)} ${prep.expect ? (row.hit ? 'HIT ' : 'miss') : `fp=${signal.length}`}  findings=${signal.length} cost=$${row.cost} ${Math.round(ms / 1000)}s`);
    }
    if (prep.wt) try { git(repo, ['worktree', 'remove', '--force', prep.wt]); } catch {}
  }
  report();
}

let cluster = x => x;
function report() {
  const file = path.join(out, 'results.jsonl');
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.strategy && !r.failed);
  // noise is counted after clustering nearby findings, the same way for every saved report
  for (const r of rows) {
    try {
      const rep = JSON.parse(fs.readFileSync(path.join(out, 'reports', `${r.case}__${r.strategy}.json`), 'utf8'));
      r.findings = cluster(rep.findings.filter(f => f.severity !== 'info')).length;
    } catch {}
  }
  const strategies = [...new Set(rows.map(r => r.strategy))];
  const bugs = rows.filter(r => r.hit !== null), controls = rows.filter(r => r.hit === null);
  const L = [`# review-eval: ${path.basename(out)}`, '', `${new Set(rows.map(r => r.case)).size} cases (${new Set(bugs.map(r => r.case)).size} bugs, ${new Set(controls.map(r => r.case)).size} controls), ${strategies.length} strategies. A hit is an error or warning within 6 lines of the bug; a false positive is an error or warning on a control.`, '',
    '| strategy | bugs caught | planted | reverted | controls clean | false positives | findings / review | $ / review | s / review |', '|---|---|---|---|---|---|---|---|---|'];
  const pct = (a, b) => b ? `${a}/${b} (${Math.round(100 * a / b)}%)` : '-';
  for (const s of strategies) {
    const b = bugs.filter(r => r.strategy === s), c = controls.filter(r => r.strategy === s), all = rows.filter(r => r.strategy === s);
    const by = kind => { const x = b.filter(r => r.kind === kind); return pct(x.filter(r => r.hit).length, x.length); };
    const avg = (xs, k) => xs.length ? xs.reduce((t, r) => t + (r[k] || 0), 0) / xs.length : 0;
    L.push(`| ${s} | ${pct(b.filter(r => r.hit).length, b.length)} | ${by('planted')} | ${by('revert')} | ${pct(c.filter(r => r.findings === 0).length, c.length)} | ${c.reduce((t, r) => t + r.findings, 0)} | ${avg(all, 'findings').toFixed(1)} | ${avg(all, 'cost').toFixed(2)} | ${Math.round(avg(all, 'ms') / 1000)} |`);
  }
  L.push('', '## Per case', '', `| case | kind | ${strategies.join(' | ')} |`, `|---|---|${strategies.map(() => '---').join('|')}|`);
  for (const id of [...new Set(rows.map(r => r.case))]) {
    const kind = rows.find(r => r.case === id).kind;
    L.push(`| ${id} | ${kind} | ${strategies.map(s => { const r = rows.find(x => x.case === id && x.strategy === s); if (!r) return '-'; if (r.hit === null) return r.findings ? `${r.findings} fp` : 'clean'; return r.hit ? `hit (${r.hitSource}${r.fromFixNote ? ', fix note' : ''})` : `miss (${r.findings})`; }).join(' | ')} |`);
  }
  const text = L.join('\n');
  fs.writeFileSync(path.join(out, 'SUMMARY.md'), text + '\n');
  process.stdout.write(text + '\n');
}

({ clusterFindings: cluster } = await import('../src/review.js'));
if (cmd === 'run') await run();
else if (cmd === 'report') report();
else { process.stderr.write('usage: review-eval.js run|report ...\n'); process.exit(1); }
