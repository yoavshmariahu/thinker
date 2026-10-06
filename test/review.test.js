import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { hashDep } from '../src/deps.js';
import { parseDiff, resolveScope, makeReader, collectChange, changedSymbols, noteExposure, selectNotes, deterministicFindings, review, renderReview, clusterFindings, blindSpot } from '../src/review.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
// reviews log a line each; from a test that line must not land in the machine's log (~/.thinker/log.jsonl)
process.env.THINKER_LOG = 'local';
process.env.THINKER_TELEMETRY = 'off';
const CORE = `import os\n\nclass Command:\n    def invoke(self, ctx):\n        validate(ctx)\n        return self.main(ctx)\n\n    def main(self, ctx):\n        return run_callback(ctx)\n\ndef validate(ctx):\n    if ctx is None:\n        raise ValueError("ctx")\n\ndef run_callback(ctx):\n    return ctx\n`;
const CLI = `from core import Command, run_callback, validate\n\ndef entry(ctx):\n    validate(ctx)\n    cmd = Command()\n    return cmd.invoke(ctx)\n`;
const TYPES = `def convert(value):\n    return str(value)\n`;

function fixture(t) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-review-')));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  const write = (f, s) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), s); };
  write('src/core.py', CORE); write('src/cli.py', CLI); write('src/types.py', TYPES);
  const commit = msg => { git('add', '-A'); git('commit', '-qm', msg || 'fixture'); return git('rev-parse', 'HEAD'); };
  commit('init');
  const store = new Store(repo).init();
  const dep = (p, symbol) => hashDep(repo, { path: p, symbol });
  const notes = {
    invariant: { id: 'validate-before-main', title: 'Command.invoke must validate ctx before main', kind: 'invariant', answers: ['why does invoke call validate first'], body: 'core.py:Command.invoke calls core.py:validate before core.py:Command.main; main assumes a non-None ctx. Every entry point (cli.py:entry) relies on invoke doing this.', deps: [dep('src/core.py', 'Command.invoke'), dep('src/core.py', 'validate'), dep('src/cli.py', 'entry')], source: { type: 'human' }, confidence: 0.9, status: 'fresh', verified: '2026-01-01T00:00:00.000Z' },
    pair: { id: 'cli-and-core-change-together', title: 'cli.py entry changes with core.py Command', kind: 'rule', answers: ['what changes with Command'], body: 'When core.py:Command gains or loses a method, cli.py:entry must be updated to match.', deps: [dep('src/core.py', 'Command'), dep('src/cli.py', 'entry')], source: { type: 'human' }, confidence: 0.8, status: 'fresh' },
    convention: { id: 'convert-returns-str', title: 'Type conversion always returns str', kind: 'convention', answers: ['what does convert return'], body: 'types.py:convert returns str for every input; callers compare against string literals, so never return None or int from convert.', deps: [dep('src/types.py', 'convert')], source: { type: 'human' }, confidence: 0.85, status: 'fresh' },
    unrelated: { id: 'how-to-run-tests', title: 'How to run the test suite', kind: 'howto', answers: ['how do I run tests'], body: 'Run pytest from the repository root; see README.md.', deps: [{ path: 'README.md', hash: 'sha256:000000000000000000000000' }], source: { type: 'human' }, confidence: 0.7, status: 'fresh' },
  };
  for (const n of Object.values(notes)) store.put(n);
  return { repo, git, store, write, commit, notes };
}

const silent = async () => ({ verdict: 'consistent', reason: 'ok', findings: [], noteCorrection: '', cost: 0 });

test('parseDiff reads files, statuses, hunks and the lines the change touched', () => {
  const text = `diff --git a/a.py b/a.py\nindex 1..2 100644\n--- a/a.py\n+++ b/a.py\n@@ -1,4 +1,4 @@\n def f():\n-    return 1\n+    return 2\n     pass\n@@ -10,2 +10,3 @@ def g():\n     x\n+    y\n     z\ndiff --git a/b.py b/b.py\nnew file mode 100644\n--- /dev/null\n+++ b/b.py\n@@ -0,0 +1,2 @@\n+a\n+b\ndiff --git a/c.py b/c.py\ndeleted file mode 100644\n--- a/c.py\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\ndiff --git a/old.py b/new.py\nsimilarity index 90%\nrename from old.py\nrename to new.py\n`;
  const files = parseDiff(text);
  assert.deepEqual(files.map(f => [f.path, f.status]), [['a.py', 'M'], ['b.py', 'A'], ['c.py', 'D'], ['new.py', 'R']]);
  assert.deepEqual([...files[0].touched].sort((x, y) => x - y), [2, 11]);
  assert.equal(files[0].hunks.length, 2); assert.equal(files[0].hunks[1].header, 'def g():');
  assert.equal(files[0].added, 2); assert.equal(files[0].removed, 1);
  assert.deepEqual([...files[1].touched], [1, 2]);
  assert.equal(files[3].oldPath, 'old.py');
});

test('scopes: working tree, index, a commit, a branch since its base; the reader never mixes sides', t => {
  const { repo, git, write, commit } = fixture(t);
  const first = git('rev-parse', 'HEAD');
  write('src/types.py', TYPES.replace('str(value)', 'int(value)'));
  const second = commit('types');
  write('src/cli.py', CLI + '\ndef extra():\n    return 1\n');
  let scope = resolveScope(repo);
  assert.equal(scope.base, second); assert.equal(scope.head, 'worktree');
  let change = collectChange(repo, scope);
  assert.deepEqual(change.files.map(f => f.path), ['src/cli.py']);
  git('add', 'src/cli.py');
  write('src/cli.py', CLI + '\ndef extra():\n    return 2\n');
  scope = resolveScope(repo, { staged: true });
  const reader = makeReader(repo, scope);
  assert.match(reader.after('src/cli.py'), /return 1/); // the index, not the working tree
  assert.match(reader.before('src/cli.py'), /^from core/); assert.doesNotMatch(reader.before('src/cli.py'), /extra/);
  scope = resolveScope(repo, { ref: second });
  assert.equal(scope.base, first); assert.equal(scope.head, second);
  change = collectChange(repo, scope);
  assert.deepEqual(change.files.map(f => f.path), ['src/types.py']);
  assert.match(makeReader(repo, scope).after('src/types.py'), /int\(value\)/);
  git('checkout', '-q', '-b', 'feature');
  commit('feature work');
  write('src/core.py', CORE + '\ndef more():\n    return 3\n');
  scope = resolveScope(repo, { base: 'main' });
  assert.equal(scope.base, second); // merge base with main
  change = collectChange(repo, scope);
  assert.deepEqual(change.files.map(f => f.path).sort(), ['src/cli.py', 'src/core.py']);
  write('src/fresh.py', 'def brand_new():\n    return 1\n');
  change = collectChange(repo, resolveScope(repo));
  const fresh = change.files.find(f => f.path === 'src/fresh.py');
  assert.equal(fresh.status, 'A'); assert.equal(fresh.untracked, true); assert.deepEqual([...fresh.touched], [1, 2]);
  assert.match(change.text, /\+def brand_new/);
  assert.equal(resolveScope(repo, { state: true }).state, true);
});

test('changed and removed symbols, and what each note is exposed to: touched by the change versus stale before it', t => {
  const { repo, store, write, notes } = fixture(t);
  // the change: validate() is removed from invoke and from the module; convert is untouched
  write('src/core.py', CORE.replace('        validate(ctx)\n', '').replace('def validate(ctx):\n    if ctx is None:\n        raise ValueError("ctx")\n\n', ''));
  const scope = resolveScope(repo), reader = makeReader(repo, scope);
  const change = collectChange(repo, scope);
  const symbols = changedSymbols(change, reader);
  assert.deepEqual(symbols[0].changed, ['Command.invoke']);
  assert.deepEqual(symbols[0].removed.map(r => r.qualified), ['validate']);
  const e = noteExposure(store.get('validate-before-main'), change, reader);
  assert.deepEqual(e.touched.map(d => `${d.symbol}:${d.reason}`), ['Command.invoke:symbol body changed', 'validate:symbol not found']);
  assert.deepEqual(e.missingAfter.map(d => d.symbol), ['validate']);
  assert.equal(e.staleBefore.length, 0);
  assert.equal(noteExposure(store.get('convert-returns-str'), change, reader).touched.length, 0);
  // a note whose record no longer matches the code before the change: drift of the cache, not of the change
  const drifted = { ...notes.convention, id: 'drifted', deps: [{ ...notes.convention.deps[0], hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaa' }] };
  const d = noteExposure(drifted, change, reader);
  assert.equal(d.touched.length, 0);
  assert.deepEqual(d.staleBefore, [{ path: 'src/types.py', symbol: 'convert', reason: 'symbol body changed' }]);
  const { direct, related } = selectNotes(store.list(), change, reader);
  assert.deepEqual(direct.map(n => n.id), ['validate-before-main', 'cli-and-core-change-together']); // the invariant, with more specific pointers, first
  assert.ok(!related.some(n => n.id === 'how-to-run-tests'));
});

test('findings without a model: a removed symbol still referenced', t => {
  const { repo, store, write } = fixture(t);
  write('src/core.py', CORE.replace('        validate(ctx)\n', '').replace('def validate(ctx):\n    if ctx is None:\n        raise ValueError("ctx")\n\n', ''));
  const scope = resolveScope(repo), reader = makeReader(repo, scope);
  const change = collectChange(repo, scope);
  const symbols = changedSymbols(change, reader);
  const findings = deterministicFindings(repo, change, symbols, reader);
  const broken = findings.find(f => f.category === 'broken-reference');
  assert.equal(broken.severity, 'error');
  assert.match(broken.message, /validate was removed from src\/core.py/);
  assert.match(broken.message, /src\/cli.py:1/); // the import
  assert.match(broken.message, /src\/cli.py:4/); // the call
  assert.equal(findings.length, 1);
  // moved, not removed: validate defined in another file now
  write('src/checks.py', 'def validate(ctx):\n    return ctx\n');
  const again = deterministicFindings(repo, collectChange(repo, scope), changedSymbols(collectChange(repo, scope), reader), makeReader(repo, scope));
  assert.ok(!again.some(f => f.category === 'broken-reference'));
  // a commit cannot be grepped for references
  assert.equal(deterministicFindings(repo, { ...change, head: 'commit' }, symbols, reader).some(f => f.category === 'broken-reference'), false);
  void store;
});

test('findings without a model: a property of the same name is not a reference to a removed top-level definition', t => {
  const { repo, git, write } = fixture(t);
  write('src/queue.js', 'export function push(item) { return item; }\n');
  write('src/use.js', 'const items = [];\nexport function add(x) { items.push(x); return items?.push(x); }\n');
  git('add', '.'); git('commit', '-qm', 'queue');
  fs.rmSync(path.join(repo, 'src/queue.js'));
  const scope = resolveScope(repo), reader = makeReader(repo, scope);
  const first = deterministicFindings(repo, collectChange(repo, scope), changedSymbols(collectChange(repo, scope), reader), reader);
  assert.ok(!first.some(f => f.category === 'broken-reference'), JSON.stringify(first));
  write('src/use.js', 'const items = [];\nexport function add(x) { items.push(x); return push(x); }\n');
  const second = deterministicFindings(repo, collectChange(repo, scope), changedSymbols(collectChange(repo, scope), reader), reader);
  const broken = second.find(f => f.category === 'broken-reference');
  assert.match(broken.message, /push was removed from src\/queue.js .* src\/use.js:2$/);
});

test('review assembles the report: model findings carry the note and the line, outdated notes are cache state, nothing is rewritten', async t => {
  const { repo, store, write, notes } = fixture(t);
  write('src/core.py', CORE.replace('        validate(ctx)\n', ''));
  const calls = [];
  const assess = async (s, note, exposure, change, reader, opts) => {
    calls.push({ id: note.id, related: opts.related, touched: exposure.touched.map(d => d.symbol) });
    if (note.id === 'validate-before-main') return { id: note.id, verdict: 'violation', reason: 'invoke no longer validates', findings: [{ severity: 'error', category: 'violation', file: 'src/core.py', line: 5, message: 'Command.invoke skips validate(ctx); main dereferences ctx', evidence: '-        validate(ctx)', confidence: 0.9, note: note.id, inChange: true }], noteCorrection: '', cost: 0.01 };
    if (note.id === 'cli-and-core-change-together') return { id: note.id, verdict: 'note_outdated', reason: 'entry no longer depends on Command methods', findings: [], noteCorrection: 'cli.py:entry only calls invoke.', cost: 0.01 };
    if (note.id === 'duplicate-view') return { id: note.id, verdict: 'violation', reason: 'same problem', findings: [{ severity: 'error', category: 'violation', file: 'src/core.py', line: 5, message: 'invoke skips validate', evidence: 'x', confidence: 0.6, note: note.id }], noteCorrection: '', cost: 0.01 };
    return silent();
  };
  store.put({ ...notes.invariant, id: 'duplicate-view', title: 'Invoke validates first', kind: 'gotcha', confidence: 0.6 });
  const before = JSON.stringify(store.list());
  const r = await review(store, { strategy: { mode: 'per-note' }, assess });
  assert.ok(r.impact.recorded);
  assert.ok(r.impact.events.some(e => e.op === 'impact-review' && e.runId === r.runId && e.findings[0].id === r.findings[0].id));
  assert.match(r.findings[0].id, /^f-/);
  assert.deepEqual(calls.map(c => c.id).sort(), ['cli-and-core-change-together', 'duplicate-view', 'validate-before-main']);
  // two notes saw the same problem at the same line: one finding, the surer wording, both notes named
  assert.equal(r.findings.length, 1); assert.deepEqual(r.findings[0].notes, ['validate-before-main', 'duplicate-view']); assert.equal(r.findings[0].confidence, 0.9);
  assert.match(renderReview(r), /\[notes validate-before-main, duplicate-view, 90%\]/);
  assert.deepEqual(r.files.map(f => f.path), ['src/core.py']);
  assert.equal(r.notes.direct, 3);
  assert.equal(r.findings[0].severity, 'error'); assert.equal(r.findings[0].note, 'validate-before-main'); assert.equal(r.findings[0].line, 5);
  assert.deepEqual(r.counts, { error: 1, warning: 0, info: 0 });
  assert.deepEqual(r.notes.outdated.map(o => o.id), ['cli-and-core-change-together']);
  assert.equal(Math.round(r.cost * 100), 3);
  assert.equal(JSON.stringify(store.list()), before); // the cache is not touched by a review
  const text = renderReview(r);
  assert.match(text, /Findings: 1 error/);
  assert.match(text, /error +src\/core.py:5 +Command.invoke skips validate/);
  assert.match(text, /evidence: -\s+validate\(ctx\)/);
  assert.match(text, /1 note the review found outdated: cli-and-core-change-together/);
  assert.match(text, /thinker verify cli-and-core-change-together/);
  const log = fs.readFileSync(path.join(repo, '.thinker', 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).find(e => e.op === 'review');
  assert.equal(log.assessed, 3); assert.deepEqual(log.outdated, ['cli-and-core-change-together']);
});

test('a note already stale before the change is reported as drift, assessed anyway, and failures of the model do not hide the rest', async t => {
  const { repo, store, write, notes } = fixture(t);
  store.put({ ...notes.invariant, deps: [{ ...notes.invariant.deps[0], hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbb' }, ...notes.invariant.deps.slice(1)] });
  write('src/core.py', CORE.replace('return self.main(ctx)', 'return self.main(ctx)  # dispatch'));
  const seen = [];
  const assess = async (s, note, exposure) => { seen.push({ id: note.id, stale: exposure.staleBefore.map(d => d.symbol) }); if (note.id === 'validate-before-main') throw new Error('model down'); return silent(); };
  const r = await review(store, { strategy: { mode: 'per-note' }, assess });
  assert.deepEqual(seen.find(s => s.id === 'validate-before-main').stale, ['Command.invoke']);
  assert.deepEqual(r.notes.staleBefore.map(s => s.id), ['validate-before-main']);
  assert.deepEqual(r.errors, [{ id: 'validate-before-main', error: 'model down' }]);
  assert.equal(r.verdicts.length, 1);
  const text = renderReview(r);
  assert.match(text, /already stale before this change/);
  assert.match(text, /could not be assessed: validate-before-main \(model down\)/);
  void repo;
});

test('dry run lists what would be assessed without calling the model; --max leaves notes out', async t => {
  const { store, write } = fixture(t);
  write('src/core.py', CORE.replace('return self.main(ctx)', 'return self.main(ctx)  # dispatch'));
  let called = 0;
  const r = await review(store, { strategy: { mode: 'per-note' }, assess: async () => { called++; return silent(); }, dry: true });
  assert.equal(called, 0); assert.equal(r.notes.assessed, 0);
  assert.deepEqual(r.toAssess.map(x => x.id), ['validate-before-main', 'cli-and-core-change-together']);
  assert.match(renderReview(r), /Notes to assess:/);
  const capped = await review(store, { strategy: { mode: 'per-note' }, assess: async () => { called++; return silent(); }, max: 1 });
  assert.equal(called, 1); assert.equal(capped.notes.skipped, 1);
  assert.match(renderReview(capped), /1 left out \(--max\)/);
});

test('state mode audits the current code of the given paths against the notes resting on it, with no diff', async t => {
  const { repo, store, write } = fixture(t);
  write('src/types.py', TYPES.replace('str(value)', 'int(value)')); // the convention is broken in the checkout itself
  const seen = [];
  const assess = async (s, note, exposure, change) => { seen.push({ id: note.id, state: change.state, touched: exposure.touched.map(d => d.path), stale: exposure.staleBefore.map(d => d.symbol) }); return { id: note.id, verdict: 'violation', reason: 'convert returns int', findings: [{ severity: 'error', file: 'src/types.py', line: 2, message: 'convert returns int', evidence: 'return int(value)', confidence: 0.9, note: note.id }], noteCorrection: '', cost: 0 }; };
  const r = await review(store, { scope: resolveScope(repo, { state: true }), paths: ['src/types.py'], strategy: { mode: 'per-note' }, assess });
  assert.deepEqual(seen, [{ id: 'convert-returns-str', state: true, touched: ['src/types.py'], stale: ['convert'] }]);
  assert.equal(r.state, true);
  assert.equal(r.findings[0].file, 'src/types.py');
  assert.match(renderReview(r), /current code/);
  // a directory covers the files under it; nothing named audits every file the notes rest on
  const all = await review(store, { scope: resolveScope(repo, { state: true }), strategy: { mode: 'per-note' }, assess: silent });
  assert.deepEqual(all.files.map(f => f.path).sort(), ['src/cli.py', 'src/core.py', 'src/types.py']);
});

test('the CLI renders the report and --strict exits 2 on an error finding', t => {
  const { repo, write } = fixture(t);
  write('src/core.py', CORE.replace('        validate(ctx)\n', '').replace('def validate(ctx):\n    if ctx is None:\n        raise ValueError("ctx")\n\n', ''));
  const env = { ...process.env, THINKER_TELEMETRY: 'off', THINKER_LOG: 'local', THINKER_AST: 'off' };
  const dry = spawnSync('node', [cli, 'review', '--dry', '--repo', repo], { encoding: 'utf8', env });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /validate was removed from src\/core.py/);
  assert.match(dry.stdout, /Notes to assess:/);
  const strict = spawnSync('node', [cli, 'review', '--dry', '--strict', '--repo', repo], { encoding: 'utf8', env });
  assert.equal(strict.status, 2);
  const json = spawnSync('node', [cli, 'review', '--dry', '--json', 'src/core.py', '--repo', repo], { encoding: 'utf8', env });
  const r = JSON.parse(json.stdout);
  assert.equal(r.findings[0].category, 'broken-reference');
  assert.deepEqual(r.files.map(f => f.path), ['src/core.py']);
});

test('kinds narrows the review to the desired behaviors: one call per behavior in play, nothing else consulted, no baseline call', async t => {
  const { repo, store, write, notes } = fixture(t);
  store.put({ ...notes.invariant, id: 'invoke-validates', kind: 'behavior', mutability: 'fixed', title: 'invoke validates ctx before main', source: { type: 'human' } });
  write('src/core.py', CORE.replace('        validate(ctx)\n', ''));
  const seen = [];
  const assess = async (s, note, exposure) => { seen.push(note.id); return { id: note.id, verdict: 'violation', reason: 'invoke no longer validates', findings: [{ severity: 'error', category: 'violation', file: 'src/core.py', line: 5, message: 'invoke skips validate', evidence: '-        validate(ctx)', confidence: 0.9, note: note.id, inChange: true }], noteCorrection: '', cost: 0.01 }; };
  const r = await review(store, { kinds: ['behavior'], assess });
  assert.deepEqual(seen, ['invoke-validates']); // the invariant and the other rule rest on the same code and were not consulted
  assert.equal(r.strategy.mode, 'per-note'); // the default for a kinds review: a verdict per behavior, no no-notes baseline
  assert.deepEqual(r.kinds, ['behavior']);
  assert.equal(r.notes.consulted, 1);
  assert.deepEqual(r.behaviors.map(b => [b.id, b.outcome]), [['invoke-validates', 'violated']]);
  assert.deepEqual(r.behaviors[0].source, { type: 'human' });
  assert.deepEqual(r.toAssess[0].source, { type: 'human' });
  assert.equal(r.findings[0].severity, 'error');
  const text = renderReview(r);
  assert.match(text, /1 desired behavior consulted/);
  assert.match(text, /violated +\[fixed\] invoke validates ctx before main/);
  const env = { ...process.env, THINKER_TELEMETRY: 'off', THINKER_LOG: 'local', THINKER_CODEGRAPH: 'git', THINKER_AST: 'off' };
  const dry = spawnSync('node', [cli, 'review', '--dry', '--kinds', 'behavior', '--json', '--repo', repo], { encoding: 'utf8', env });
  assert.equal(dry.status, 0, dry.stderr);
  const j = JSON.parse(dry.stdout);
  assert.deepEqual(j.toAssess.map(x => x.id), ['invoke-validates']);
  assert.deepEqual(j.behaviors.map(b => b.outcome), ['consulted']);
});

test('findings resting on one note at several files become one finding with locations; unrelated ones stay apart', () => {
  const fs = [
    { severity: 'warning', file: 'a/model.py', line: 10, message: 'guard removed', evidence: '', confidence: 0.8, note: 'n1', category: 'violation', inChange: true },
    { severity: 'error', file: 'a/serializer.py', line: 40, message: 'field dropped from the response', evidence: 'x', confidence: 0.9, note: 'n1', category: 'violation', inChange: true },
    { severity: 'warning', file: 'tests/test_model.py', line: 0, message: 'the regression test was deleted', evidence: '', confidence: 0.85, note: 'n1', category: 'violation', inChange: false },
    { severity: 'warning', file: 'a/model.py', line: 12, message: 'same place, other note', evidence: '', confidence: 0.7, note: 'n2', category: 'violation', inChange: true },
    { severity: 'warning', file: 'b/other.py', line: 5, message: 'unrelated, from the code', evidence: '', confidence: 0.6, inChange: true },
  ];
  const out = clusterFindings(fs);
  assert.equal(out.length, 2);
  const one = out.find(f => f.notes.includes('n1'));
  assert.equal(one.file, 'a/serializer.py'); assert.equal(one.severity, 'error'); // placed where the model was surest
  assert.deepEqual(one.notes.sort(), ['n1', 'n2']); // the nearby finding of n2 joined within the file first
  assert.deepEqual(one.locations.map(l => l.file).sort(), ['a/model.py', 'tests/test_model.py']);
  assert.equal(out.find(f => f.file === 'b/other.py').locations, undefined);
  // idempotent: clustering a clustered report keeps the notes and locations
  const again = clusterFindings(out);
  assert.equal(again.length, 2); assert.deepEqual(again.find(f => f.notes.includes('n1')).notes.sort(), ['n1', 'n2']); assert.equal(again.find(f => f.notes.includes('n1')).locations.length, 2);
  // transitive: a finding citing two notes joins the clusters of both
  const tri = clusterFindings([
    { severity: 'warning', file: 'x.py', line: 1, message: 'A', confidence: 0.7, note: 'a', inChange: true },
    { severity: 'warning', file: 'y.py', line: 1, message: 'B', confidence: 0.7, note: 'b', inChange: true },
    { severity: 'error', file: 'z.py', line: 1, message: 'A and B', confidence: 0.9, notes: ['a', 'b'], note: 'a', inChange: true },
  ]);
  assert.equal(tri.length, 1); assert.equal(tri[0].file, 'z.py'); assert.deepEqual(tri[0].locations.map(l => l.file).sort(), ['x.py', 'y.py']);
  const text = renderReview({ scope: 'x', files: [{ path: 'a/model.py', status: 'M' }], notes: { consulted: 1, direct: 1, related: 0, assessed: 1, staleBefore: [], outdated: [], uncovered: [] }, findings: out, counts: { error: 1, warning: 1, info: 0 }, errors: [], verdicts: [], strategy: { mode: 'ensemble' } });
  assert.match(text, /also at: a\/model.py:10 \(guard removed\); tests\/test_model.py/);
});

test('the blind spot is said up front when most changed code files carry no note, and never for the baseline', () => {
  const base = { files: [{ path: 'a.py', status: 'M' }, { path: 'b.py', status: 'A' }, { path: 'README.md', status: 'M' }, { path: 'gone.py', status: 'D' }], notes: { consulted: 2, direct: 0, related: 2, assessed: 2, staleBefore: [], outdated: [], uncovered: ['a.py', 'b.py'] }, findings: [], counts: { error: 0, warning: 0, info: 0 }, errors: [], verdicts: [], scope: 'x' };
  const b = blindSpot({ ...base, strategy: { mode: 'ensemble' } });
  assert.equal(b.blind, 2); assert.equal(b.code, 2);
  assert.match(b.text, /^Blind on all 2 changed code files: no note rests on them, so there the review is the model reading the diff alone\./);
  assert.match(blindSpot({ ...base, kinds: ['behavior'], strategy: { mode: 'per-note' } }).text, /no desired behavior rests on them, so nothing checks them/);
  assert.equal(blindSpot({ ...base, strategy: { mode: 'nocache' } }), null);
  assert.equal(blindSpot({ ...base, notes: { ...base.notes, uncovered: [] }, strategy: {} }), null);
  assert.equal(blindSpot({ ...base, files: [...base.files, { path: 'c.py', status: 'M' }, { path: 'd.py', status: 'M' }, { path: 'e.py', status: 'M' }], strategy: {} }), null, 'two of five is not most of the change');
  assert.match(renderReview({ ...base, strategy: { mode: 'ensemble' } }), /\n⚠ Blind on all 2 changed code files/);
});
