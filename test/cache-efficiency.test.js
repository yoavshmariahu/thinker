// Serving less and invalidating less: the stemmer, the term rules, dependency narrowing, co-change
// notes as edit-time rules, and the distiller's view of what the cache already holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tokenize, stem, rank } from '../src/rank.js';
import { checkNote, hashDep, bodyIdentifiers, noteTerms } from '../src/deps.js';
import { Store } from '../src/store.js';
import { createNote, dropShadowedFileDeps, lateNotes, orient } from '../src/ops.js';
import { touchedFiles, relatedNotes, saveNotes } from '../src/distill.js';

process.env.THINKER_TELEMETRY = 'off';
const git = (repo, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
function gitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-eff-'));
  git(dir, 'init', '-q');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/a.js'), 'export function fetchRows() {\n  return 1;\n}\n\nexport function saveRows() {\n  return 2;\n}\n');
  fs.writeFileSync(path.join(dir, 'build.sh'), '#!/bin/sh\nnpm run build\necho done\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

test('the stemmer folds plurals and tenses without cutting words into other words', () => {
  assert.equal(stem('notes'), 'note', '"notes" was "not", a stop word');
  assert.equal(tokenize('the notes').join(), 'note');
  assert.equal(stem('status'), stem('statuses'));
  assert.equal(stem('share'), stem('shared'));
  assert.equal(stem('worktree'), stem('worktrees'));
  assert.equal(stem('verify'), stem('verified'));
  assert.equal(stem('running'), 'run');
  assert.equal(stem('entries'), 'entry');
  assert.equal(stem('class'), stem('classes'));
});

test('a two-word request is answered by notes holding both words; the body floor gates the long ones', () => {
  const run = { id: 'a', kind: 'howto', title: 'Running the test suite', answers: ['how to run the tests'], body: 'npm test runs test/*.test.js with THINKER_TEST=1', deps: [{ path: 'package.json' }], confidence: 0.9 };
  const other = { id: 'b', kind: 'howto', title: 'Benchmark harness tests', answers: ['test the benchmark'], body: 'node bench/run.js --smoke; the judge is mocked in tests', deps: [{ path: 'bench/run.js' }], confidence: 0.9 };
  const ids = q => rank([run, other], { query: q, mode: 'orient' }).map(r => r.note.id);
  assert.deepEqual(ids('ok run the tests'), ['a']);
  assert.ok(ids('status?').length === 0, 'one content word: nothing');
  // a long request that shares two words with a note out of many is not covered by it
  const far = 'investigate why the deploy pipeline uploads the tarball twice and the invalidation of the distribution is skipped on the second run';
  assert.deepEqual(ids(far), []);
});

test('a note acted on when served ranks above one never acted on, all else equal', () => {
  const mk = (id, attest) => ({ id, kind: 'gotcha', title: 'Hooks run the installed app', answers: ['which code do hooks run'], body: 'the hook command names ~/.thinker/app, not the checkout', deps: [{ path: 'src/cli.js' }], confidence: 0.8, attest });
  const filler = ['deploy', 'verify', 'phrase'].map(w => ({ id: w, kind: 'howto', title: `${w} notes`, answers: [`how to ${w}`], body: `thinker ${w} does it`, deps: [{ path: 'src/cli.js' }] }));
  const r = rank([mk('never', { confirmed: 0, unused: 7 }), mk('always', { confirmed: 7, unused: 0 }), ...filler], { query: 'which code do the hooks run', mode: 'orient' });
  assert.deepEqual(r.map(x => x.note.id).slice(0, 2), ['always', 'never']);
  assert.ok(r[0].score - r[1].score > 0.1);
});

test('a whole-file dep beside symbol deps on the same file is dropped', () => {
  const deps = dropShadowedFileDeps([{ path: 'src/a.js' }, { path: 'src/a.js', symbol: 'foo' }, { path: 'src/b.js' }]);
  assert.deepEqual(deps.map(d => `${d.path}:${d.symbol || ''}`), ['src/a.js:foo', 'src/b.js:']);
});

test('bodyIdentifiers and noteTerms pick the words code has, not the English around them', () => {
  assert.deepEqual(bodyIdentifiers('When `fetchRows()` returns, src/a.js:saveRows is called; the fileName is kept and the table grows'), ['fetchRows', 'saveRows', 'fileName']);
  const terms = noteTerms({ title: 'Build script', body: 'npm run build then echo done; it returns early', deps: [] });
  assert.ok(terms.has('build') && terms.has('echo') && terms.has('early') && !terms.has('then') && !terms.has('returns'), 'without the English, and without the words every body has');
});

test('a changed whole-file dep narrows to the definitions the note names when none of them changed', () => {
  const repo = gitRepo();
  const note = { id: 'n', kind: 'location', title: 'fetchRows returns one', body: 'src/a.js holds `fetchRows()`, which returns 1', deps: [hashDep(repo, { path: 'src/a.js' })], verifiedCommit: git(repo, 'rev-parse', 'HEAD') };
  fs.writeFileSync(path.join(repo, 'src/a.js'), fs.readFileSync(path.join(repo, 'src/a.js'), 'utf8').replace('return 2', 'return 3'));
  const plain = checkNote(repo, note);
  assert.deepEqual(plain.changed.map(c => c.reason), ['file changed'], 'without narrowing: stale, as before');
  const r = checkNote(repo, note, { narrow: true });
  assert.deepEqual(r.changed, []);
  assert.ok(r.upgraded);
  assert.deepEqual(r.deps.map(d => `${d.path}:${d.symbol}`), ['src/a.js:fetchRows']);
  // the named definition changes: stale on that definition, which the dep now names
  fs.writeFileSync(path.join(repo, 'src/a.js'), fs.readFileSync(path.join(repo, 'src/a.js'), 'utf8').replace('return 1', 'return 11'));
  const after = checkNote(repo, note, { narrow: true });
  assert.deepEqual(after.changed, [{ path: 'src/a.js', symbol: 'fetchRows', reason: 'symbol body changed' }]);
  assert.deepEqual(after.deps.map(d => `${d.path}:${d.symbol}`), ['src/a.js:fetchRows']);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('a whole-file dep with no named definition stays fresh while the diff touches none of the note\'s terms', () => {
  const repo = gitRepo();
  const note = { id: 'n', kind: 'howto', title: 'Build the package', body: 'run build.sh; it calls npm run build', deps: [hashDep(repo, { path: 'build.sh' })], verifiedCommit: git(repo, 'rev-parse', 'HEAD') };
  fs.appendFileSync(path.join(repo, 'build.sh'), 'echo finished\n');
  const r = checkNote(repo, note, { narrow: true });
  assert.deepEqual(r.changed, []);
  assert.ok(r.upgraded && !r.deps[0].symbol && r.deps[0].hash !== note.deps[0].hash, 'the file dep takes the new hash');
  fs.writeFileSync(path.join(repo, 'build.sh'), '#!/bin/sh\nnpm run build:prod\necho done\n');
  assert.deepEqual(checkNote(repo, note, { narrow: true }).changed.map(c => c.reason), ['file changed'], 'a changed line holds "build"');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('the edit hook names git co-change partners of an edited file, once per session; a rule note on the file is still served', async () => {
  const repo = gitRepo();
  fs.writeFileSync(path.join(repo, 'src/billing.js'), 'export function applyRates() {\n  return 1;\n}\n');
  fs.mkdirSync(path.join(repo, 'scripts')); fs.writeFileSync(path.join(repo, 'scripts/regen.sh'), 'echo regen\n');
  const store = new Store(repo).init();
  createNote(store, { title: 'Costs and the regen script change together', kind: 'rule', answers: ['what must change with the cost figures'], body: 'the cost figures change with the rates: src/billing.js:applyRates and scripts/regen.sh regenerate them', deps: [{ path: 'src/billing.js', symbol: 'applyRates' }, { path: 'scripts/regen.sh' }] });
  fs.writeFileSync(path.join(repo, '.thinker', 'cochange.json'), JSON.stringify({ commits: 5, totals: { 'src/billing.js': 5 }, pairs: { 'src/billing.js': { 'scripts/regen.sh': 4 } } }));
  const late = lateNotes(store, { session: 'e1', files: ['src/billing.js'], edited: true });
  assert.match(late.text, /src\/billing\.js usually changes with scripts\/regen\.sh \(80%, n=4\)/);
  assert.equal(lateNotes(store, { session: 'e1', files: ['src/billing.js'], edited: true }).text, '', 'told once');
  assert.ok(!/usually changes with/.test(lateNotes(store, { session: 'e2', files: ['scripts/regen.sh'], edited: true }).text), 'no partner above the floor; the rule note on the file is still served');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('the distiller is shown the notes on the files the session touched, and an extension merges into its note', () => {
  const repo = gitRepo();
  const store = new Store(repo).init();
  const n = createNote(store, { title: 'fetchRows returns one', kind: 'location', answers: ['what does fetchRows return'], body: 'src/a.js:fetchRows returns 1', deps: [{ path: 'src/a.js', symbol: 'fetchRows' }] }).note;
  createNote(store, { title: 'The build script', kind: 'howto', answers: ['how to build'], body: 'build.sh runs npm run build', deps: [{ path: 'build.sh' }] });
  const events = [{ t: 'prompt', text: 'x' }, { t: 'tool', name: 'Read', input: { file_path: path.join(repo, 'src/a.js') }, result: '' }, { t: 'tool', name: 'Bash', input: { command: 'cat build.sh' }, result: '' }];
  assert.deepEqual(touchedFiles(events, repo), ['src/a.js']);
  assert.deepEqual(relatedNotes(store, events).map(x => x.id), [n.id]);
  const s = saveNotes(store, [{ title: 'fetchRows returns one, saveRows two', kind: 'location', answers: ['what do fetchRows and saveRows return'], body: 'src/a.js:fetchRows returns 1 and src/a.js:saveRows returns 2', deps: [{ path: 'src/a.js', symbol: 'fetchRows' }, { path: 'src/a.js', symbol: 'saveRows' }], tags: [], confidence: 0.9, extends: n.id }], { source: { type: 'agent' } });
  assert.equal(s.merged.length, 1); assert.equal(s.saved.length, 0);
  const got = store.get(n.id);
  assert.match(got.body, /saveRows returns 2/);
  assert.equal(got.history.at(-1).reason, 'extended by a new session');
  fs.rmSync(repo, { recursive: true, force: true });
});
