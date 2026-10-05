import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, sharedContent } from '../src/store.js';
import { hashDep, hashDepAt } from '../src/deps.js';
import { saveNotes } from '../src/distill.js';
import { installGitHooks, uninstallGitHooks, preCommitHook } from '../src/git-hooks.js';
import { exportCache, importCache } from '../src/transfer.js';
import { checkNote } from '../src/deps.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
function fixture(t) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-share-')));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'code.js'), 'export function value() { return 1; }\n');
  const commit = () => { git('add', '.'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  commit();
  const store = new Store(repo).init();
  const note = (id = 'value', extra = {}) => ({ id, title: 'Value computation convention', kind: 'convention', body: 'Use code.js:value for the value.', answers: ['How is the value computed?'], deps: [hashDep(repo, { path: 'code.js', symbol: 'value' })], source: { type: 'human' }, confidence: 0.87654, status: 'fresh', ...extra });
  return { repo, git, store, note, commit };
}

test('store tiers migrate tracked/untracked notes, preserve runtime state, and reset old overlays after a pull', t => {
  const { repo, store, note, git } = fixture(t);
  fs.rmSync(store.localDir, { recursive: true });
  fs.writeFileSync(path.join(store.notesDir, 'value.json'), JSON.stringify(note('value', { uses: 4 })));
  fs.writeFileSync(path.join(store.notesDir, 'local.json'), JSON.stringify(note('local')));
  git('add', '.thinker/notes/value.json');
  const s = new Store(repo);
  assert.equal(s.list().length, 2);
  assert.equal(s.get('value').uses, 4);
  assert.equal(s.isShared('value'), true);
  assert.equal(s.isShared('local'), false);
  assert.equal(fs.existsSync(path.join(store.notesDir, 'local.json')), false);
  assert.match(git('check-ignore', '.thinker/local/notes/local.json'), /local/);
  const committed = fs.readFileSync(path.join(store.notesDir, 'value.json'), 'utf8');
  s.put({ ...s.get('value'), body: 'Local correction', uses: 8, confidence: 0.4, status: 'stale' });
  assert.equal(fs.readFileSync(path.join(store.notesDir, 'value.json'), 'utf8'), committed);
  assert.equal(s.pending('value').body, 'Local correction');
  fs.writeFileSync(path.join(store.notesDir, 'value.json'), JSON.stringify(sharedContent(note('value', { body: 'Pulled correction' }))));
  assert.equal(s.get('value').body, 'Pulled correction');
  assert.equal(s.get('value').status, 'fresh');
  assert.equal(s.get('value').confidence, 0.87654);
  assert.equal(s.get('value').uses, 8);
  assert.deepEqual(s.pending('value'), {});
});

test('readonly inventory never migrates and non-git legacy notes become local', t => {
  const { repo, store, note } = fixture(t);
  fs.rmSync(path.join(repo, '.git'), { recursive: true });
  fs.rmSync(store.localDir, { recursive: true });
  fs.writeFileSync(path.join(store.notesDir, 'value.json'), JSON.stringify(note()));
  const read = new Store(repo, { readonly: true });
  assert.equal(read.list().length, 1);
  assert.equal(fs.existsSync(store.localDir), false);
  assert.throws(() => read.put(note()), /readonly/);
  const write = new Store(repo);
  assert.equal(write.list().length, 1);
  assert.equal(write.isShared('value'), false);
  assert.equal(fs.existsSync(path.join(store.localNotesDir, 'value.json')), true);
});

test('distillation merges a shared note through its overlay without deleting or altering the shared file', t => {
  const { store, note } = fixture(t);
  store.put(note()); store.promote(store.list()[0]);
  const before = fs.readFileSync(path.join(store.notesDir, 'value.json'), 'utf8');
  const result = saveNotes(store, [note('ignored', { body: 'A new convention about code.js:value.' })], { source: { type: 'agent' } });
  assert.equal(result.merged.length, 1);
  assert.equal(result.merged[0].id, 'value');
  assert.equal(fs.readFileSync(path.join(store.notesDir, 'value.json'), 'utf8'), before);
  assert.equal(store.pending('value').body, 'A new convention about code.js:value.');
});

test('archives round-trip both caches through local storage without touching committed files', t => {
  const { repo, store, note } = fixture(t);
  store.put(note()); store.promote(store.list()[0]);
  store.put(note('local', { title: 'Unique installation map', kind: 'howto' }));
  store.put({ ...store.get('value'), uses: 6 });
  const archive = path.join(repo, 'cache.tgz');
  assert.equal(exportCache(store, archive).notes, 2);
  const other = path.join(repo, 'receiver'); fs.mkdirSync(other);
  const receiver = new Store(other).init();
  assert.equal(importCache(receiver, archive).notes, 2);
  assert.equal(receiver.list().length, 2);
  assert.equal(receiver.get('value').uses, 6);
  assert.equal(receiver.isShared('value'), false);
  assert.deepEqual(fs.readdirSync(receiver.notesDir), []);
  const before = fs.readFileSync(path.join(store.notesDir, 'value.json'), 'utf8');
  importCache(store, archive);
  assert.equal(fs.readFileSync(path.join(store.notesDir, 'value.json'), 'utf8'), before);
});

test('legacy trailing-hyphen IDs stay readable and flat benchmark stores remain unchanged', t => {
  const { store, note } = fixture(t);
  const legacy = note('old-generated-id-');
  store.put(legacy);
  assert.equal(store.get(legacy.id).id, legacy.id);
  store.promote(store.list()[0]);
  assert.equal(store.get(legacy.id).id, legacy.id);
  const merged = saveNotes(store, [legacy], { source: { type: 'agent' } });
  assert.equal(merged.merged[0].id, legacy.id);
  assert.equal(store.list().length, 1);
  const previous = process.env.THINKER_NOTES_DIR;
  const flatDir = path.join(store.repo, 'benchmark-notes');
  process.env.THINKER_NOTES_DIR = flatDir;
  try {
    const flat = new Store(store.repo).init();
    flat.put(note('benchmark', { uses: 7 }));
    assert.equal(JSON.parse(fs.readFileSync(path.join(flatDir, 'benchmark.json'))).uses, 7);
    assert.equal(flat.get('benchmark').uses, 7);
    assert.equal(flat.list().length, 1);
    assert.equal(flat.isShared('benchmark'), false);
  } finally {
    if (previous === undefined) delete process.env.THINKER_NOTES_DIR;
    else process.env.THINKER_NOTES_DIR = previous;
  }
});

test('imports reject archive symlinks before modifying a receiver', t => {
  const { repo, store, note } = fixture(t);
  store.put(note()); store.promote(store.list()[0]);
  const archiveDir = path.join(repo, 'archive'); fs.mkdirSync(archiveDir);
  fs.symlinkSync(store.notesDir, path.join(archiveDir, 'notes'));
  const archive = path.join(repo, 'unsafe.tgz');
  execFileSync('tar', ['-czf', archive, '-C', archiveDir, 'notes']);
  const before = store.sharedFile('value');
  assert.throws(() => importCache(store, archive), /links or special files/);
  assert.deepEqual(store.sharedFile('value'), before);
});


test('a conflicted or malformed note file is named as unreadable instead of vanishing', t => {
  const { store, note, repo } = fixture(t);
  store.put(note()); store.promote(store.list()[0]);
  const good = fs.readFileSync(path.join(store.notesDir, 'value.json'), 'utf8');
  fs.writeFileSync(path.join(store.notesDir, 'value.json'), `<<<<<<< HEAD\n${good}=======\n${good}>>>>>>> origin/main\n`);
  fs.writeFileSync(path.join(store.localNotesDir, 'broken.json'), '{');
  fs.writeFileSync(path.join(store.notesDir, 'renamed.json'), JSON.stringify(sharedContent(note('other'))));
  assert.equal(store.list().length, 0);
  const bad = store.unreadable().sort((a, b) => a.file.localeCompare(b.file));
  assert.deepEqual(bad.map(u => [path.relative(repo, u.file), u.tier, u.reason]), [
    ['.thinker/local/notes/broken.json', 'local', 'invalid JSON'],
    ['.thinker/notes/renamed.json', 'shared', 'id does not match the file name'],
    ['.thinker/notes/value.json', 'shared', 'unresolved merge conflict'],
  ]);
  const env = { ...process.env, THINKER_TELEMETRY: 'off', THINKER_TEST: '1', THINKER_LOG: 'local', THINKER_NO_AUTO_UPDATE: '1', THINKER_NO_LEARN: '1', THINKER_AST: 'off', THINKER_HOME: path.join(repo, 'home') };
  const list = spawnSync(process.execPath, [cli, 'list', '--repo', repo], { cwd: repo, encoding: 'utf8', env });
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /warning: \.thinker\/notes\/value\.json is not served: unresolved merge conflict/);
  assert.match(spawnSync(process.execPath, [cli, 'check', '--repo', repo], { cwd: repo, encoding: 'utf8', env }).stdout, /unresolved merge conflict/);
  fs.writeFileSync(path.join(store.notesDir, 'value.json'), good);
  assert.equal(store.list().length, 1);
});

test('opt-in staged review blocks commits on review failure and index changes, even with learning off', t => {
  const { repo, git } = fixture(t);
  const fake = path.join(repo, 'review-cli.cjs'), calls = path.join(repo, 'calls.jsonl');
  const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, preCommitHook(fake), { mode: 0o755 });
  fs.writeFileSync(fake, `const fs = require('node:fs');
    const args = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args)+'\\n');
    if (args[0] === 'review') {
      if (process.env.TEST_CHANGE_INDEX) {
        fs.writeFileSync('during-review.txt', 'new staged change');
        require('node:child_process').execFileSync('git', ['add', 'during-review.txt']);
      }
      process.exit(Number(process.env.TEST_REVIEW_STATUS || 0));
    }
    process.exit(1); // unexpected command
  `);
  const run = (extra = {}) => spawnSync('git', ['commit', '--allow-empty', '-qm', 'review gate test'], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, THINKER_TELEMETRY: 'off', THINKER_TEST: '0', ...extra },
  });
  assert.equal(run({ TEST_REVIEW_STATUS: '2' }).status, 0, 'review is off by default');
  git('config', '--local', 'thinker.reviewBeforeCommit', 'true');
  for (const status of ['1', '2']) {
    const head = git('rev-parse', 'HEAD');
    assert.notEqual(run({ TEST_REVIEW_STATUS: status, THINKER_NO_LEARN: '1' }).status, 0);
    assert.equal(git('rev-parse', 'HEAD'), head, 'failed review must not create a commit');
  }
  assert.equal(run().status, 0, 'successful review allows commit');
  const args = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse).filter(a => a[0] === 'review');
  assert.ok(args.length >= 3);
  assert.ok(args.every(a => a.includes('--staged') && a.includes('--strict')));
  const changed = run({ TEST_CHANGE_INDEX: '1' });
  assert.notEqual(changed.status, 0); assert.match(changed.stderr, /changed during review/);
});
