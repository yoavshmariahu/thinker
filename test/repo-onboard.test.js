// The first session in a repository: the hooks set it up (what `thinker setup` would write for the
// repository) and, when there is history to read, tell the agent once to offer a warm-up; the stop
// offer is made once per repository on this machine, and nothing repeats it (repo-onboard.js). A cache
// that has notes from sessions but has not read its history is cold and is offered it too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, repoId } from '../src/store.js';
import { WARM_MINED, minedCount } from '../src/repo-onboard.js';
import { createNote } from '../src/ops.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-onboard-home-'));
const env = { ...process.env, THINKER_HOME: HOME, THINKER_LOG: 'local', THINKER_HOLDOUT: 'off', THINKER_NO_BG_VERIFY: '1', THINKER_NO_LEARN: '1', THINKER_CE: 'off', THINKER_TELEMETRY: 'off' };
const hook = (dir, kind, input, client = 'claude') => execFileSync('node', [CLI, 'hook', kind, '--client', client, '--repo', dir], { input: JSON.stringify(input), encoding: 'utf8', env });
const ops = dir => fs.readFileSync(path.join(dir, '.thinker/log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
function gitRepo(commits) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-onboard-')));
  const git = (...a) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...a], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
  fs.mkdirSync(path.join(dir, 'src')); fs.writeFileSync(path.join(dir, 'src/a.js'), 'export function fetchRows() {\n  return 1;\n}\n');
  git('add', '.'); git('commit', '-q', '-m', 'init');
  for (let i = 1; i < commits; i++) { fs.writeFileSync(path.join(dir, 'src/a.js'), `export function fetchRows() {\n  return ${i + 1};\n}\n`); git('commit', '-qam', `bump ${i}`); }
  return dir;
}

test('the first session in a repository with history sets it up and tells the agent once to offer a warm-up; nothing repeats it', () => {
  const dir = gitRepo(8);
  // an origin that is not GitHub: the repository is one across its clones, and the git history is what there is to read
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://git.example.com/acme/rows.git']);
  const out = hook(dir, 'prompt', { session_id: 'n1', prompt: 'where does fetchRows read the rows from' });
  assert.match(out, /<thinker-new-repository>/);
  assert.match(out, /ask the user whether they would like that/);
  assert.match(out, new RegExp(`thinker warmup --repos "${dir}" --yes --terminal`), 'the command names this checkout and asks nothing');
  assert.match(out, /commit history/, 'no GitHub remote: the git history is what there is to read');
  assert.doesNotMatch(out, /<thinker-cache>/, 'an empty cache serves no notes');
  // what setup would write for the repository: the git hooks that keep the cache fresh
  assert.match(fs.readFileSync(path.join(dir, '.git/hooks/post-commit'), 'utf8'), /# thinker:/);
  assert.match(fs.readFileSync(path.join(dir, '.git/hooks/post-merge'), 'utf8'), /# thinker:/);
  assert.ok(!fs.existsSync(path.join(dir, '.cursor')), 'Cursor\'s rule only for Cursor');
  const log = ops(dir);
  assert.deepEqual(log.find(e => e.op === 'repo-setup').done, ['git hooks']);
  assert.equal(log.find(e => e.op === 'warmup-offer').source, 'git');
  assert.ok(log.find(e => e.op === 'orient')?.empty, 'the request is still logged as unanswered');
  // once: the next prompt, in this session or another, says nothing
  assert.equal(hook(dir, 'prompt', { session_id: 'n1', prompt: 'and saveRows?' }).trim(), '');
  assert.equal(hook(dir, 'prompt', { session_id: 'n2', prompt: 'where does fetchRows read the rows from' }).trim(), '');
  assert.equal(ops(dir).filter(e => e.op === 'repo-setup').length, 1);
  // the stop notice does not say it again
  assert.equal(hook(dir, 'stop', { session_id: 'n1' }).trim(), '');
  // nor does another clone of the same repository: once is once per repository on this machine
  const clone = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-onboard-clone-')));
  execFileSync('git', ['clone', '-q', dir, path.join(clone, 'c')]);
  execFileSync('git', ['-C', path.join(clone, 'c'), 'remote', 'set-url', 'origin', 'https://git.example.com/acme/rows.git']);
  assert.equal(hook(path.join(clone, 'c'), 'prompt', { session_id: 'n3', prompt: 'where does fetchRows read the rows from' }).trim(), '');
  assert.ok(!ops(path.join(clone, 'c')).some(e => e.op === 'warmup-offer'));
  assert.ok(ops(path.join(clone, 'c')).some(e => e.op === 'repo-setup'), 'the clone is still set up');
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(HOME, 'state', 'warmup-suggested.json'), 'utf8'))).length, 1);
});

test('too little history, or a cache that has read its history, gets the setup but no offer', () => {
  const young = gitRepo(1);
  assert.equal(hook(young, 'prompt', { session_id: 'y1', prompt: 'hello' }).trim(), '');
  assert.ok(fs.existsSync(path.join(young, '.git/hooks/post-commit')), 'set up all the same');
  assert.ok(!ops(young).some(e => e.op === 'warmup-offer'));
  const warm = gitRepo(12);
  const store = new Store(warm).init();
  fs.writeFileSync(path.join(store.dir, 'prs.json'), JSON.stringify({ local: { mined: Array.from({ length: WARM_MINED }, (_, i) => `c${i}`) } }));
  createNote(store, { title: 'fetchRows reads the rows table', kind: 'rule', answers: ['how are rows fetched'], body: 'src/a.js:fetchRows reads the rows table', deps: [{ path: 'src/a.js', symbol: 'fetchRows' }] });
  assert.equal(minedCount(store), WARM_MINED);
  assert.equal(hook(warm, 'prompt', { session_id: 'w1', prompt: 'unrelated question about billing' }).trim(), '');
  assert.ok(!ops(warm).some(e => e.op === 'warmup-offer'), 'a cache that read its history is warm');
  assert.equal(hook(warm, 'stop', { session_id: 'w1' }).trim(), '');
});

test('a cold cache, notes from sessions and no history read, is offered a warm-up once, even after the empty-cache offer', () => {
  const dir = gitRepo(8);
  const store = new Store(dir).init();
  for (const [i, f] of ['fetchRows', 'saveRows', 'dropRows'].entries()) createNote(store, { title: `${f} touches the rows table`, kind: 'rule', answers: [`what does ${f} do`], body: `src/a.js:fetchRows ${f} ${i}`, deps: [{ path: 'src/a.js', symbol: 'fetchRows' }], source: { type: 'agent' } });
  // offered under the old rule, while the cache was empty: that record does not stop the cold-cache offer
  fs.mkdirSync(path.join(store.dir, 'state'), { recursive: true }); fs.writeFileSync(path.join(store.dir, 'state', 'warmup-offered'), 'x\n');
  fs.writeFileSync(path.join(HOME, 'state', 'warmup-offered.json'), JSON.stringify({ [repoId(dir)]: 'x' }));
  const out = hook(dir, 'prompt', { session_id: 'k1', prompt: 'unrelated question about billing' });
  assert.match(out, /<thinker-new-repository>/);
  assert.match(out, /is cold: it holds 3 notes from sessions and has not read the repository's history yet/);
  assert.match(out, new RegExp(`thinker warmup --repos "${dir}" --yes --terminal`));
  assert.equal(ops(dir).find(e => e.op === 'warmup-offer').notes, 3);
  assert.equal(hook(dir, 'prompt', { session_id: 'k2', prompt: 'another unrelated question about billing' }).trim(), '', 'once');
});

test('Cursor gets its always-on rule, kept out of git status', () => {
  const dir = gitRepo(2);
  hook(dir, 'prompt', { conversation_id: 'c1', prompt: 'hello' }, 'cursor');
  assert.ok(fs.existsSync(path.join(dir, '.cursor/rules/thinker.mdc')));
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir, encoding: 'utf8' });
  assert.ok(!status.includes('.cursor'), status);
  assert.deepEqual(ops(dir).find(e => e.op === 'repo-setup').done, ['git hooks', 'cursor rule']);
});
