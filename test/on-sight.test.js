// Understanding notes served on the first sight of a file (ops.js:onSightNotes): off by default, by file
// rather than by request, once per file, a few per session, and the files a tool's result names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { createNote, onSightNotes, onSightConfig, ON_SIGHT, rememberTask, lateNotes } from '../src/ops.js';
import { seenFiles } from '../src/clients.js';

process.env.THINKER_TELEMETRY = 'off';
const git = (repo, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
function gitRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-sight-')));
  git(dir, 'init', '-q');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/a.js'), 'export function fetchRows() {\n  return 1;\n}\n\nexport function saveRows() {\n  return 2;\n}\n');
  fs.writeFileSync(path.join(dir, 'src/b.js'), 'export function other() {\n  return 3;\n}\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
function withEnv(vars, fn) {
  const prev = {}; for (const k in vars) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  return Promise.resolve().then(fn).finally(() => { for (const k in prev) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } });
}
const logLines = store => fs.existsSync(path.join(store.dir, 'log.jsonl')) ? fs.readFileSync(path.join(store.dir, 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
const understanding = (store, title, deps, extra = {}) => createNote(store, { title, kind: 'map', answers: [title], body: `${title}: how it works`, deps, ...extra }, { source: { type: 'understanding', ref: deps[0].path } }).note;

test('on sight is off by default; the config or the env turns it on', () => withEnv({ THINKER_ON_SIGHT: undefined }, () => {
  const store = new Store(gitRepo()).init();
  understanding(store, 'rows are fetched then saved', [{ path: 'src/a.js' }]);
  assert.equal(onSightConfig(store).enabled, false);
  assert.deepEqual(onSightNotes(store, { session: 's1', client: 'claude', files: ['src/a.js'] }), { text: '', included: [] });
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ onSight: { enabled: true, perFile: 1 } }));
  assert.deepEqual(onSightConfig(store), { ...ON_SIGHT, enabled: true, perFile: 1 });
  process.env.THINKER_ON_SIGHT = 'off';
  assert.equal(onSightConfig(store).enabled, false);
  process.env.THINKER_ON_SIGHT = 'on';
  assert.equal(onSightNotes(store, { session: 's1', client: 'claude', files: ['src/a.js'] }).included.length, 1);
}));

test('a file in view serves its understanding notes once, by the request\'s relevance, never a note the session saw, a few per session', () => withEnv({ THINKER_ON_SIGHT: 'on' }, () => {
  const store = new Store(gitRepo()).init();
  const plain = understanding(store, 'a.js module map', [{ path: 'src/a.js' }]);
  const onTopic = understanding(store, 'saveRows writes rows through the generator', [{ path: 'src/a.js', symbol: 'saveRows' }]);
  const third = understanding(store, 'fetchRows reads rows', [{ path: 'src/a.js', symbol: 'fetchRows' }]);
  const other = understanding(store, 'b.js other', [{ path: 'src/b.js' }]);
  // a PR-mined note on the same file stays with the prompt and edit hooks
  const mined = createNote(store, { title: 'rows go with their index', kind: 'rule', answers: ['what changes with src/a.js'], body: 'src/a.js changes with its index', deps: [{ path: 'src/a.js' }] }, { source: { type: 'pr', ref: 'local#1' } }).note;
  rememberTask(store, 's1', 'change saveRows so it writes rows through the generator');
  const r = onSightNotes(store, { session: 's1', client: 'claude', files: ['src/a.js', 'README.md'], turn: 1 });
  assert.equal(r.included[0].id, onTopic.id, 'the note nearest the request comes first');
  assert.equal(r.included.length, 2, 'two per file');
  assert.ok(!r.included.some(n => n.id === mined.id || n.id === other.id));
  assert.match(r.text, /<thinker-cache>\nNotes about src\/a\.js, which just came into view/);
  const l = logLines(store).find(e => e.op === 'late' && e.on === 'sight');
  assert.deepEqual([l.files, l.served, l.turn, l.session], [['src/a.js'], r.included.map(n => n.id), 1, 's1']);
  assert.ok(store.get(onTopic.id).servedIn.includes('s1'));
  // the same file again: nothing, even though a third note was left
  assert.equal(onSightNotes(store, { session: 's1', client: 'claude', files: ['src/a.js'] }).included.length, 0);
  assert.equal(store.get(third.id).servedIn, undefined);
  // another session sees it afresh; a note that session already saw through the edit hook is not repeated
  rememberTask(store, 's2', 'what changes with src/a.js');
  const late = lateNotes(store, { session: 's2', client: 'claude', files: ['src/a.js'], edited: true });
  assert.ok(late.included.some(n => n.id === mined.id));
  const r2 = onSightNotes(store, { session: 's2', client: 'claude', files: ['src/b.js', 'src/a.js'] });
  assert.equal(r2.included.length, 3, 'one note on b.js, two of the three on a.js');
  assert.ok(r2.included.some(n => n.id === other.id) && !r2.included.some(n => n.id === mined.id));
  assert.ok(r2.text.startsWith('<thinker-cache>\nNotes about src/b.js, src/a.js,'), 'files in the order seen');
  // the per-session cap
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ onSight: { enabled: true, perSession: 1 } }));
  const s3 = new Store(store.repo);
  const r3 = onSightNotes(s3, { session: 's3', client: 'claude', files: ['src/a.js', 'src/b.js'] });
  assert.equal(r3.included.length, 1);
  assert.equal(onSightNotes(s3, { session: 's3', client: 'claude', files: ['src/b.js'] }).included.length, 0, 'the cap holds for the session');
  // ordinary code changes leave a note usable while it awaits verification
  fs.writeFileSync(path.join(store.repo, 'src/a.js'), fs.readFileSync(path.join(store.repo, 'src/a.js'), 'utf8').replace('return 1;', 'return 11;'));
  const s4 = new Store(store.repo);
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ onSight: { enabled: true, perFile: 5 } }));
  const r4 = onSightNotes(s4, { session: 's4', client: 'claude', files: ['src/a.js'] });
  assert.ok(r4.included.some(x => x.id === third.id && x.status === 'pending'), 'fetchRows changed: its note stays usable pending verification');
  assert.ok(r4.included.some(x => x.id === onTopic.id), 'saveRows did not: its note is served');
}));

test('seenFiles: the repository files a tool result names, in order, once each, capped', () => {
  const repo = gitRepo();
  const ev = { tool_name: 'Bash', tool_input: { command: 'rg -n saveRows' }, tool_response: { stdout: `src/a.js:5:export function saveRows() {\n./src/b.js:1:export function other\n${repo}/src/a.js:1: again\nsrc/missing.js:1:x\nnode_modules/x/y.js:1:z\n` } };
  assert.deepEqual(seenFiles(ev, repo), ['src/a.js', 'src/b.js']);
  assert.deepEqual(seenFiles({ tool_response: 'nothing here' }, repo), []);
  assert.deepEqual(seenFiles({ tool_output: [{ type: 'text', text: 'see src/b.js and src/a.js' }] }, repo, { max: 1 }), ['src/b.js']);
  assert.deepEqual(seenFiles({ output: `../${path.basename(repo)}/src/a.js` }, repo), [], 'a path outside the repository is not a sighting');
});
