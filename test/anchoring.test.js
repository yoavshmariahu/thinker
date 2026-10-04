// Notes anchored to definitions rather than to whole files: at creation, and when a whole-file dep's
// file changes; the deps of a stale note can be persisted without hiding the change; fix commits
// are picked out of git history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { createNote, refresh } from '../src/ops.js';
import { checkNote, narrowFileDep, narrowAtCreation, hashDep } from '../src/deps.js';
import { FIX_LIKE } from '../src/prs.js';

process.env.THINKER_TELEMETRY = 'off';
process.env.THINKER_LOG = 'off';
process.env.THINKER_AST = 'off';
const git = (repo, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
const A = 'export function fetchRows() {\n  return 1;\n}\n\nexport function saveRows() {\n  return 2;\n}\n\nexport function other() {\n  return 3;\n}\n';
function gitRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-anchor-')));
  git(dir, 'init', '-q');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/a.js'), A);
  fs.writeFileSync(path.join(dir, 'build.sh'), '#!/bin/sh\nnpm run build\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

test('at creation a whole-file dep on a code file becomes the definitions the body names; configs and unnamed code stay whole', () => {
  const dir = gitRepo(); const store = new Store(dir).init();
  const named = createNote(store, { title: 'fetchRows then saveRows', kind: 'gotcha', answers: ['order of fetchRows and saveRows'], body: 'Call `fetchRows` before `saveRows` in src/a.js, or rows are lost.', deps: [{ path: 'src/a.js' }] }).note;
  assert.deepEqual(named.deps.map(d => d.symbol).sort(), ['fetchRows', 'saveRows'], 'two symbol deps, no whole-file dep');
  assert.ok(named.deps.every(d => d.hash && d.hash !== hashDep(dir, { path: 'src/a.js' }).hash));
  const unnamed = createNote(store, { title: 'a.js is the data layer', kind: 'overview', answers: ['what is in a.js'], body: 'src/a.js holds the data layer: reading and writing rows.', deps: [{ path: 'src/a.js' }] }).note;
  assert.deepEqual(unnamed.deps.map(d => d.symbol), [undefined], 'nothing named: the file');
  const script = createNote(store, { title: 'building', kind: 'howto', answers: ['how to build'], body: 'Run `build.sh`, which calls `npm run build`; fetchRows is not involved.', deps: [{ path: 'build.sh' }] }).note;
  assert.deepEqual(script.deps.map(d => d.path), ['build.sh'], 'a script is read whole');
  assert.equal(narrowAtCreation(dir, [{ path: 'src/a.js' }], 'nothing here').length, 1);
});

test('a changed whole-file dep narrows to the named definitions, stale only on the one that changed, and the narrowed deps are kept', () => {
  const dir = gitRepo(); const store = new Store(dir).init();
  // a note written with a whole-file dep (as older notes were), naming two definitions
  const n = createNote(store, { title: 'rows', kind: 'gotcha', answers: ['rows'], body: 'Call `fetchRows` before `saveRows`, or rows are lost.', deps: [{ path: 'src/a.js' }] }).note;
  n.deps = [hashDep(dir, { path: 'src/a.js' })]; store.put(n);
  // an unrelated definition changes: the note is not stale, and now rests on its two definitions
  fs.writeFileSync(path.join(dir, 'src/a.js'), A.replace('return 3', 'return 33'));
  git(dir, 'commit', '-q', '-am', 'other');
  let r = checkNote(dir, store.get(n.id), { narrow: true });
  assert.deepEqual(r.changed, []); assert.equal(r.upgraded, true);
  assert.deepEqual(r.deps.map(d => d.symbol).sort(), ['fetchRows', 'saveRows']);
  let [fresh] = refresh(store, [store.get(n.id)], { narrow: true });
  assert.equal(fresh.status, 'fresh'); assert.deepEqual(store.get(n.id).deps.map(d => d.symbol).sort(), ['fetchRows', 'saveRows'], 'persisted');
  // back to a whole-file dep, then a named definition changes: stale on that symbol, deps narrowed and kept
  n.deps = [hashDep(dir, { path: 'src/a.js' })]; n.status = 'fresh'; delete n.stale; n.verifiedCommit = git(dir, 'rev-parse', 'HEAD'); store.put(n);
  fs.writeFileSync(path.join(dir, 'src/a.js'), A.replace('return 3', 'return 33').replace('return 2', 'return 22'));
  r = checkNote(dir, store.get(n.id), { narrow: true });
  assert.deepEqual(r.changed, [{ path: 'src/a.js', symbol: 'saveRows', reason: 'symbol body changed' }]);
  assert.equal(r.upgraded, true);
  const [stale] = refresh(store, [store.get(n.id)], { narrow: true });
  assert.equal(stale.status, 'stale');
  const stored = store.get(n.id);
  assert.deepEqual(stored.deps.map(d => d.symbol).sort(), ['fetchRows', 'saveRows'], 'narrowed deps persisted while stale');
  // the change is not hidden: the next check still sees saveRows changed, and fetchRows as it is
  const again = checkNote(dir, stored, { narrow: true });
  assert.deepEqual(again.changed.map(c => c.symbol), ['saveRows']);
  assert.equal(again.upgraded, false);
  // nothing named in the body: the term rule as before, and null when the diff holds a term of the note
  const plain = { ...n, body: 'The data layer returns rows.', deps: [{ ...hashDep(dir, { path: 'src/a.js' }), hash: 'old' }], verifiedCommit: git(dir, 'rev-parse', 'HEAD') };
  const nf = narrowFileDep(dir, plain.deps[0], plain);
  assert.ok(nf === null || nf.changed.length === 0);
});

test('a symbol dep the change altered keeps its stored hash in the deps checkNote returns, so persisting them cannot hide the change', () => {
  const dir = gitRepo(); const store = new Store(dir).init();
  const n = createNote(store, { title: 'saveRows returns two', kind: 'callpath', answers: ['saveRows'], body: 'src/a.js:saveRows returns 2', deps: [{ path: 'src/a.js', symbol: 'saveRows' }] }).note;
  const before = n.deps.find(d => d.symbol === 'saveRows').hash;
  fs.writeFileSync(path.join(dir, 'src/a.js'), A.replace('return 2', 'return 22'));
  const r = checkNote(dir, n, { narrow: true });
  assert.equal(r.changed.length, 1);
  assert.equal(r.deps.find(d => d.symbol === 'saveRows').hash, before, 'the stored record, not the new hash');
  const [stale] = refresh(store, [n], { narrow: true });
  assert.equal(stale.status, 'stale');
  assert.equal(checkNote(dir, store.get(n.id), { narrow: true }).changed.length, 1, 'still seen as changed');
});

test('fix-like commit messages', () => {
  for (const s of ['fix: the hook double-served', 'Fixes #12: crash on empty prompt', 'regression in rank since 0.1.9', 'serving: a stale note was served twice (fixed)', 'flaky test on CI']) assert.ok(FIX_LIKE.test(s), s);
  for (const s of ['docs: holdout', 'bench: posthog runs', 'release thinker 0.1.10', 'setup: one command sets a repository up', 'Serve no stale note from the prompt hooks', 'revert "notes: faster"']) assert.ok(!FIX_LIKE.test(s), s);
});

test('a rewritten body loses the framing it echoes', async () => {
  const { cleanBody } = await import('../src/ops.js');
  assert.equal(cleanBody('NOTE (kind=invariant) "Codex hook state"\nCodex matches hooks by hash.\n- key', 'Codex hook state'), 'Codex matches hooks by hash.\n- key');
  assert.equal(cleanBody('## Codex hook state\n\nCodex matches hooks by hash.', 'Codex hook state'), 'Codex matches hooks by hash.');
  assert.equal(cleanBody('Codex matches hooks by hash.', 'Codex hook state'), 'Codex matches hooks by hash.');
  assert.equal(cleanBody('', 'x'), '');
});

test('the agent path asks more of a note: a body floor of its own', async () => {
  const { rank, MIN_COVER } = await import('../src/rank.js');
  const { orient } = await import('../src/ops.js');
  assert.equal(MIN_COVER.agentBody, 0.30);
  const note = { id: 'n', kind: 'gotcha', title: 'fetchRows reads the rows table', answers: ['how are rows fetched'], body: 'src/a.js:fetchRows reads the rows table and returns them in order', deps: [{ path: 'src/a.js', symbol: 'fetchRows' }], confidence: 0.9, status: 'fresh' };
  const q = 'how are rows fetched by fetchRows and what does the table hold';
  const [r] = rank([note], { query: q, mode: 'orient', minBody: 0 });
  assert.ok(r && r.cover > 0, 'served with no floor; its body cover is measured');
  assert.equal(rank([note], { query: q, mode: 'orient', minBody: r.cover + 0.01 }).length, 0, 'a floor just above its cover keeps it out');
  assert.equal(rank([note], { query: q, mode: 'orient', minBody: Math.max(0, r.cover - 0.01) }).length, 1, 'just below lets it through');
  // through orient: the hook's two notes use the hook floor, the agent's five the agent floor
  const dir = gitRepo(); const store = new Store(dir).init();
  createNote(store, { title: 'fetchRows reads the rows table', kind: 'gotcha', answers: ['how are rows fetched'], body: 'src/a.js:fetchRows reads the rows table and returns them in order', deps: [{ path: 'src/a.js', symbol: 'fetchRows' }] });
  const weak = 'rows and tables and order, plus many other words about dashboards, panels, alerts, folders and users';
  const hook = await orient(store, { task: weak, recordUsage: false, backgroundVerify: false });
  const agent = await orient(store, { task: weak, budget: 1000, maxNotes: 5, relFloor: 0.7, recordUsage: false, backgroundVerify: false });
  assert.ok(hook.included.length >= agent.included.length, 'the agent path serves no more than the hook on a weak request');
});
