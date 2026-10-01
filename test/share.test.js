import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, sharedContent } from '../src/store.js';
import { hashDep, hashDepAt } from '../src/deps.js';
import { planShare, share, validateShare, validatePush, reconcileLocal, readyToShareNotice, contentErrors } from '../src/share.js';
import { saveNotes } from '../src/distill.js';
import { installGitHooks, uninstallGitHooks, prePushHook } from '../src/git-hooks.js';
import { exportCache, importCache } from '../src/transfer.js';

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

test('promotion gates trust, freshness, content and duplicates; strips local fields and agent references', t => {
  const { store, note, repo } = fixture(t);
  store.put(note('value', { source: { type: 'agent', ref: '/Users/someone/session.jsonl' }, related: ['private'], uses: 8, attest: { confirmed: 0 } }));
  assert.equal(planShare(store).ready.length, 0);
  assert.equal(planShare(store, { all: true }).ready.length, 1);
  assert.equal(share(store, { ids: ['value'], dry: true }).ready.length, 1);
  assert.equal(store.isShared('value'), false);
  share(store, { ids: ['value'] });
  const content = store.sharedFile('value');
  assert.equal(content.source.ref, undefined);
  assert.equal(content.uses, undefined);
  assert.equal(content.attest, undefined);
  assert.equal(content.confidence, 0.88);
  assert.deepEqual(content.related, []);
  assert.equal(store.get('value').uses, 8);
  store.put(note('duplicate'));
  assert.match(planShare(store, { all: true }).skipped[0].reasons.join(' '), /near-duplicate/);
  store.put(note('secret', { title: 'Credential handling unique instruction', body: 'sk-ant-' + 'a'.repeat(30) }));
  assert.match(planShare(store, { ids: ['secret'] }).skipped[0].reasons.join(' '), /secret/);
  fs.writeFileSync(path.join(repo, 'code.js'), 'export function value() { return 2; }\n');
  assert.match(planShare(store, { all: true }).skipped.find(n => n.id === 'duplicate').reasons.join(' '), /changed/);
});

test('confirmed notes and trusted sources are eligible; shared updates and retirements are explicit', t => {
  const { store, note } = fixture(t);
  store.put(note('value', { source: { type: 'agent' }, attest: { confirmed: 1 } }));
  assert.equal(planShare(store).ready.length, 1);
  share(store);
  const before = store.sharedFile('value');
  store.put({ ...store.get('value'), body: 'Updated code.js:value guidance.' });
  assert.deepEqual(store.sharedFile('value'), before);
  assert.equal(planShare(store).ready[0].action, 'update');
  share(store);
  assert.equal(store.sharedFile('value').body, 'Updated code.js:value guidance.');
  store.put({ ...store.get('value'), status: 'invalid' });
  assert.ok(store.sharedFile('value'));
  assert.equal(share(store).ready[0].action, 'remove');
  assert.equal(store.get('value'), null);
});

test('distillation merges a shared note through its overlay without deleting or altering the shared file', t => {
  const { store, note } = fixture(t);
  store.put(note()); share(store);
  const before = fs.readFileSync(path.join(store.notesDir, 'value.json'), 'utf8');
  const result = saveNotes(store, [note('ignored', { body: 'A new convention about code.js:value.' })], { source: { type: 'agent' } });
  assert.equal(result.merged.length, 1);
  assert.equal(result.merged[0].id, 'value');
  assert.equal(fs.readFileSync(path.join(store.notesDir, 'value.json'), 'utf8'), before);
  assert.equal(store.pending('value').body, 'A new convention about code.js:value.');
});

test('validation hashes the pushed commit, ignores dirty files, warns on stale unchanged notes and errors with strict', t => {
  const { repo, store, note, commit, git } = fixture(t);
  const base = git('rev-parse', 'HEAD');
  store.put(note()); share(store); const first = commit();
  fs.writeFileSync(path.join(repo, 'code.js'), 'export function value() { return 2; }\n');
  assert.equal(validateShare(repo, { ref: first, base }).errors.length, 0);
  const second = commit();
  const warning = validateShare(repo, { ref: second, base: first });
  assert.equal(warning.errors.length, 0);
  assert.match(warning.warnings[0].message, /changed/);
  assert.equal(validateShare(repo, { ref: second, base: first, strict: true }).errors.length, 1);
  // Making the working tree match the note cannot hide stale content in the commit.
  fs.writeFileSync(path.join(repo, 'code.js'), 'export function value() { return 1; }\n');
  assert.equal(validateShare(repo, { ref: second, base }).errors.length, 1);
  assert.equal(hashDepAt(repo, note().deps[0], first).hash, note().deps[0].hash);
});

test('validation rejects invalid JSON, filename/id mismatch, missing deps, secrets, duplicates and oversize notes', t => {
  const { repo, store, note, git, commit } = fixture(t);
  const base = git('rev-parse', 'HEAD');
  const write = (id, value) => fs.writeFileSync(path.join(store.notesDir, `${id}.json`), typeof value === 'string' ? value : JSON.stringify(value));
  write('bad-json', '{');
  write('wrong', note('other'));
  write('value', sharedContent(note()));
  write('duplicate', sharedContent(note('duplicate')));
  write('missing', { id: 'missing', title: 'Missing', body: 'Body', kind: 'location' });
  write('secret', sharedContent(note('secret', { title: 'Secret', body: 'ghp_' + 'x'.repeat(30) })));
  write('large', sharedContent(note('large', { title: 'Large', body: 'x'.repeat(12001) })));
  const ref = commit();
  const messages = validateShare(repo, { ref, base }).errors.map(e => e.message).join('\n');
  for (const pattern of [/invalid JSON/, /invalid id/, /missing deps/, /possible secret/, /near-duplicate/, /exceeds/]) assert.match(messages, pattern);
  assert.match(contentErrors(note('machine', { body: '/Users/joe/project' })).join(' '), /home path/);
  assert.match(contentErrors(note('machine', { body: 'C:\\Users\\joe\\project' })).join(' '), /home path/);
});

test('legacy state changes only warn, while normalizing content removes state without changing meaning', t => {
  const { repo, store, note, commit } = fixture(t);
  fs.writeFileSync(path.join(store.notesDir, 'value.json'), JSON.stringify(note()));
  const base = commit();
  const n = note('value', { uses: 10 });
  fs.writeFileSync(path.join(store.notesDir, 'value.json'), JSON.stringify(n));
  const ref = commit();
  const result = validateShare(repo, { ref, base });
  assert.equal(result.errors.length, 0);
  assert.match(result.warnings[0].message, /legacy/);
  share(store);
  assert.equal(store.sharedFile('value').uses, undefined);
});

test('pre-push validates every ref, handles deletions and new branches against remote default', t => {
  const { repo, store, note, git, commit } = fixture(t);
  const base = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', base);
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  store.put(note()); share(store); const good = commit();
  fs.writeFileSync(path.join(repo, 'code.js'), 'export function value() { return 3; }\n');
  const bad = commit(), zero = '0'.repeat(40);
  const result = validatePush(repo, `refs/heads/a ${good} refs/heads/a ${zero}\nrefs/heads/b ${bad} refs/heads/b ${zero}\n(delete) ${zero} refs/heads/c ${base}\n`);
  assert.equal(result.length, 2);
  assert.equal(result[0].errors.length, 0);
  assert.equal(result[1].errors.length, 1);
  assert.equal(result[0].base, base);
});

test('hooks preserve custom hooks, uninstall only ours, and only validation failures block pushes', t => {
  const { repo } = fixture(t);
  const hooks = path.join(repo, '.git', 'hooks');
  fs.writeFileSync(path.join(hooks, 'post-commit'), '#!/bin/sh\n# custom hook mentioning thinker\n');
  installGitHooks(repo, cli, true);
  assert.match(fs.readFileSync(path.join(hooks, 'post-commit'), 'utf8'), /custom/);
  assert.match(fs.readFileSync(path.join(hooks, 'post-merge'), 'utf8'), /maintain/);
  const fake = path.join(repo, "fake ' cli.cjs");
  const hook = path.join(hooks, 'pre-push');
  fs.writeFileSync(hook, prePushHook(fake));
  const run = () => spawnSync('sh', [hook, 'origin'], { cwd: repo, encoding: 'utf8' }).status;
  assert.equal(run(), 0); // missing CLI
  fs.writeFileSync(fake, "throw new Error('broken');"); assert.equal(run(), 0);
  fs.writeFileSync(fake, 'process.exit(2);'); assert.equal(run(), 1);
  fs.writeFileSync(fake, 'process.exit(0);'); assert.equal(run(), 0);
  uninstallGitHooks(repo);
  assert.equal(fs.existsSync(path.join(hooks, 'post-commit')), true);
  assert.equal(fs.existsSync(path.join(hooks, 'post-merge')), false);
  assert.equal(fs.existsSync(hook), false);
});

test('local collisions keep shared content, preserve usage, and readiness notices only repeat for new content', t => {
  const { store, note } = fixture(t);
  store.put(note()); share(store);
  fs.writeFileSync(path.join(store.localNotesDir, 'value.json'), JSON.stringify(note('value', { body: 'old local content', uses: 12 })));
  store.put(note('duplicate'));
  assert.equal(reconcileLocal(store).length, 2);
  assert.equal(store.get('value').body, 'Use code.js:value for the value.');
  assert.equal(store.get('value').uses, 12);
  assert.equal(store.localNotes().length, 0);
  store.put(note('new', { title: 'Independent package installation map', answers: [], kind: 'howto' }));
  assert.match(readyToShareNotice(store), /1 note is ready/);
  assert.equal(readyToShareNotice(store), '');
  store.put({ ...store.get('new'), uses: 1, confidence: 0.95, verified: new Date().toISOString() });
  assert.equal(readyToShareNotice(store), '');
});

test('archives round-trip both caches through local storage without touching committed files', t => {
  const { repo, store, note } = fixture(t);
  store.put(note()); share(store);
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

test('CLI handles flags before IDs, validates without touching the checkout, and returns validation exit codes', t => {
  const { repo, store, note, git, commit } = fixture(t);
  const base = git('rev-parse', 'HEAD');
  store.put(note('value', { source: { type: 'agent' } }));
  const env = { ...process.env, THINKER_TELEMETRY: 'off', THINKER_TEST: '1', THINKER_LOG: 'local', THINKER_NO_AUTO_UPDATE: '1', THINKER_NO_LEARN: '1', THINKER_AST: 'off', THINKER_HOME: path.join(repo, 'home') };
  const run = (args, input) => spawnSync(process.execPath, [cli, ...args, '--repo', repo], { cwd: repo, encoding: 'utf8', env, input });
  const dry = run(['share', '--dry', 'value']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /would add value/);
  assert.equal(store.isShared('value'), false);
  assert.equal(run(['share', 'value']).status, 0);
  const good = commit();
  fs.writeFileSync(path.join(repo, 'code.js'), 'export function value() { return 2; }\n');
  const bad = commit();
  const before = git('status', '--porcelain');
  const result = run(['share', '--check', '--base', base, '--ref', good]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git('status', '--porcelain'), before);
  assert.equal(run(['share', '--check', '--base', base, '--ref', bad]).status, 2);
  const warning = run(['share', '--check', '--base', good, '--ref', bad]);
  assert.equal(warning.status, 0); assert.match(warning.stdout, /warning/);
  assert.equal(run(['share', '--check', '--base', good, '--strict']).status, 2);
  assert.equal(run(['share', '--check', '--pre-push'], `refs/heads/a ${bad} refs/heads/a ${base}\n`).status, 2);
});

test('legacy trailing-hyphen IDs stay readable and flat benchmark stores remain unchanged', t => {
  const { store, note } = fixture(t);
  const legacy = note('old-generated-id-');
  store.put(legacy);
  assert.equal(store.get(legacy.id).id, legacy.id);
  share(store);
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
    assert.throws(() => share(flat), /THINKER_NOTES_DIR/);
  } finally {
    if (previous === undefined) delete process.env.THINKER_NOTES_DIR;
    else process.env.THINKER_NOTES_DIR = previous;
  }
});

test('commit validation preserves AST/regex compatibility and rejects missing symbols and symlink deps', t => {
  const { repo, store, note, git, commit } = fixture(t);
  const base = git('rev-parse', 'HEAD');
  const n = note();
  n.deps[0] = { ...n.deps[0], engine: 'ast', hashRegex: n.deps[0].hash, hash: 'sha256:' + '0'.repeat(24) };
  fs.writeFileSync(path.join(store.notesDir, 'value.json'), JSON.stringify(sharedContent(n)));
  const ref = commit();
  assert.equal(validateShare(repo, { ref, base }).errors.length, 0);
  n.deps[0].symbol = 'missing';
  fs.writeFileSync(path.join(store.notesDir, 'value.json'), JSON.stringify(sharedContent(n)));
  assert.match(validateShare(repo, { ref: commit(), base }).errors[0].message, /symbol not found/);
  fs.symlinkSync('code.js', path.join(repo, 'link.js'));
  n.deps = [hashDep(repo, { path: 'link.js' })];
  fs.writeFileSync(path.join(store.notesDir, 'value.json'), JSON.stringify(sharedContent(n)));
  assert.match(validateShare(repo, { ref: commit(), base }).errors[0].message, /removed/);
});

test('imports reject archive symlinks before modifying a receiver', t => {
  const { repo, store, note } = fixture(t);
  store.put(note()); share(store);
  const archiveDir = path.join(repo, 'archive'); fs.mkdirSync(archiveDir);
  fs.symlinkSync(store.notesDir, path.join(archiveDir, 'notes'));
  const archive = path.join(repo, 'unsafe.tgz');
  execFileSync('tar', ['-czf', archive, '-C', archiveDir, 'notes']);
  const before = store.sharedFile('value');
  assert.throws(() => importCache(store, archive), /links or special files/);
  assert.deepEqual(store.sharedFile('value'), before);
});
