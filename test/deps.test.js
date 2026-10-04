import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findSymbol, hashDep, checkNote, repoFile } from '../src/deps.js';
import { extractDeps, createNote, refresh } from '../src/ops.js';
import { Store } from '../src/store.js';
import { rank, pack, tokenize } from '../src/rank.js';
import { execFileSync } from 'node:child_process';

const PY = `import os\n\nclass Foo:\n    def bar(self, x):\n        return x + 1\n\n    def baz(self):\n        return 2\n\ndef bar():\n    return 0\n\n@decorator\ndef top():\n    pass\n`;
const JS = `export function foo(a) {\n  return a;\n}\nconst bar = (x) => {\n  return x;\n};\nexport class Baz {\n  qux() { return 1; }\n}\n`;

test('findSymbol python qualified and bare', () => {
  assert.deepEqual(findSymbol(PY, 'Foo.bar'), { start: 3, end: 5 });
  assert.deepEqual(findSymbol(PY, 'Foo.baz'), { start: 6, end: 8 });
  assert.equal(findSymbol(PY, 'bar').start, 3); // first definition
  assert.equal(findSymbol(PY, 'Nope.bar'), null);
  assert.equal(findSymbol(PY, 'top').start, 12); // includes decorator
});

test('findSymbol python multi-line signature and overloads', () => {
  const py = `import typing as t\nclass C:\n    @t.overload\n    def main(self, a: int) -> int: ...\n    @t.overload\n    def main(self, a: str) -> str: ...\n    def main(\n        self,\n        a,\n    ) -> t.Any:\n        x = (1,\n             2)\n        return x\n\n    def other(self):\n        pass\n`;
  const loc = findSymbol(py, 'C.main', 'indent');
  assert.equal(py.split('\n')[loc.start].trim(), 'def main(');
  assert.equal(py.split('\n')[loc.end - 1].trim(), 'return x');
});

test('findSymbol js', () => {
  assert.deepEqual(findSymbol(JS, 'foo'), { start: 0, end: 3 });
  assert.deepEqual(findSymbol(JS, 'bar'), { start: 3, end: 6 });
  assert.deepEqual(findSymbol(JS, 'Baz.qux'), { start: 7, end: 8 });
});

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.py'), PY);
  fs.writeFileSync(path.join(dir, 'src', 'b.js'), JS);
  return dir;
}

test('symbol hash changes only when the symbol body changes', () => {
  const repo = tmpRepo();
  const h1 = hashDep(repo, { path: 'src/a.py', symbol: 'Foo.bar' });
  fs.writeFileSync(path.join(repo, 'src/a.py'), PY.replace('return 2', 'return 3'));
  const h2 = hashDep(repo, { path: 'src/a.py', symbol: 'Foo.bar' });
  assert.equal(h1.hash, h2.hash);
  fs.writeFileSync(path.join(repo, 'src/a.py'), PY.replace('return x + 1', 'return x + 2'));
  const h3 = hashDep(repo, { path: 'src/a.py', symbol: 'Foo.bar' });
  assert.notEqual(h1.hash, h3.hash);
  const note = { deps: [h1] };
  assert.equal(checkNote(repo, note).changed[0].reason, 'symbol body changed');
  fs.unlinkSync(path.join(repo, 'src/a.py'));
  assert.equal(checkNote(repo, note).changed[0].reason, 'file removed');
});

test('note dependencies stay inside the repo and reject outward symlinks', () => {
  const repo = tmpRepo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'synthetic secret');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(repo, 'secret-link.txt'));
  assert.equal(repoFile(repo, '../' + path.basename(outside) + '/secret.txt'), null);
  assert.equal(repoFile(repo, 'secret-link.txt'), null);
  assert.equal(hashDep(repo, { path: 'secret-link.txt' }).missing, true);
});

test('extractDeps pulls pointers from body', () => {
  const repo = tmpRepo();
  const deps = extractDeps(repo, 'Calls `src/a.py:Foo.bar` then b.js:foo and `Baz.qux()`; ignores self.bar and ctx.params. Also `a.py:top`.', [{ path: 'src/b.js' }]);
  const keys = deps.map(d => `${d.path}:${d.symbol}`);
  assert.ok(keys.includes('src/a.py:Foo.bar'));
  assert.ok(keys.includes('src/b.js:foo'));
  assert.ok(keys.includes('src/b.js:Baz.qux'));
  assert.ok(keys.includes('src/a.py:top'));
  assert.ok(!keys.some(k => k.includes('self') || k.includes('ctx')));
});

test('createNote + refresh marks stale and recovers', () => {
  const repo = tmpRepo();
  const store = new Store(repo).init();
  const r = createNote(store, { title: 'Foo bar flow', kind: 'callpath', answers: ['how does foo bar'], body: 'src/a.py:Foo.bar returns x+1', deps: [{ path: 'src/a.py', symbol: 'Foo.bar' }] });
  assert.ok(r.note);
  assert.equal(refresh(store)[0].status, 'fresh');
  fs.writeFileSync(path.join(repo, 'src/a.py'), PY.replace('return x + 1', 'return x - 1'));
  assert.equal(refresh(store)[0].status, 'stale');
  fs.writeFileSync(path.join(repo, 'src/a.py'), PY);
  assert.equal(refresh(store)[0].status, 'fresh');
});

test('rank prefers matching notes and path affinity; pack respects budget', () => {
  const notes = [
    { id: 'a', title: 'How auth middleware validates tokens', kind: 'callpath', answers: ['where is auth checked'], body: 'x'.repeat(400), deps: [{ path: 'src/auth/mw.py' }], confidence: 0.9, status: 'fresh' },
    { id: 'b', title: 'How migrations run', kind: 'howto', answers: ['how to run migrations'], body: 'y'.repeat(400), deps: [{ path: 'db/migrate.py' }], confidence: 0.9, status: 'fresh' },
    { id: 'c', title: 'Token refresh gotcha', kind: 'gotcha', answers: ['token expiry'], body: 'z'.repeat(400), deps: [{ path: 'src/auth/refresh.py' }], confidence: 0.9, status: 'stale' },
  ];
  const ranked = rank(notes, { query: 'fix the auth token validation bug', file: 'src/auth/mw.py' });
  assert.equal(ranked[0].note.id, 'a');
  const packed = pack(ranked, 150);
  assert.ok(packed.tokens <= 150);
  assert.ok(packed.included.length >= 1);
  assert.deepEqual(tokenize('getUserById src/auth/mw.py'), ['get', 'user', 'id', 'src', 'auth', 'mw', 'py']);
});

test('rank serves nothing when no note covers the request, though one of them is the best', () => {
  // the other notes hold the request's words one at a time, as a real cache does
  const words = ['narrow', 'screen', 'duplicate', 'sidebar', 'copy', 'back', 'link', 'transfer', 'project', 'subscriptions', 'modal', 'illustration', 'text', 'wrong'];
  const filler = words.map((w, i) => ({ id: 'f' + i, title: `Topic${i} handler layout`, kind: 'location', answers: [`where is topic${i} handled`], body: `topic${i} is handled in handler${i}, next to the ${w}`, deps: [{ path: `src/t${i}.py` }], confidence: 0.9, status: 'fresh' }));
  const notes = [
    { id: 'order', title: 'Insight list default ordering must use an indexed column', kind: 'invariant', answers: ['how is the insight list page ordered when it opens'], body: 'the list endpoint orders by an indexed column; changing it needs a migration', deps: [{ path: 'api/insight.py' }], confidence: 0.9, status: 'fresh' },
    { id: 'invite', title: 'Bulk invite partial failure semantics', kind: 'gotcha', answers: ['what happens when some invites fail in a bulk invite'], body: 'a bulk invite sends each email on its own; failed invites are reported per address and the rest are still sent', deps: [{ path: 'api/invite.py' }], confidence: 0.9, status: 'fresh' },
    ...filler,
  ];
  const request = 'On a narrow screen, after I duplicate an insight the sidebar stays open over the copy. The back link on the transfer page opens the wrong project page. The subscriptions modal keeps its illustration beside the text.';
  assert.deepEqual(rank(notes, { query: request }).map(r => r.note.id), []);
  assert.equal(rank(notes, { query: request, cover: { body: 0, question: 0 } })[0]?.note.id, 'order');
  assert.equal(rank(notes, { query: 'When a bulk invite has some addresses that fail, the invites that failed are not reported and the rest are not sent' })[0].note.id, 'invite');
});

test('a hash that moved because the hasher changed, not the code, is brought up to date rather than marked stale', () => {
  const repo = tmpRepo();
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  git('init', '-q'); git('add', '-A'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const dep = hashDep(repo, { path: 'src/a.py', symbol: 'Foo.bar' });
  // an older hasher stored a different hash (and found a symbol this one does not) for the same, unchanged code
  const note = { verifiedCommit: head, deps: [{ ...dep, hash: 'sha256:old-hasher' }, { path: 'src/a.py', symbol: 'nosuch', hash: 'sha256:old-hasher-too' }] };
  const r = checkNote(repo, note);
  assert.deepEqual(r.changed, []);
  assert.equal(r.upgraded, true);
  assert.equal(r.deps[0].hash, dep.hash);
  assert.equal(r.deps[1].symbolMissing, true);
  // the same mismatch on code that did change since verification is still a change
  fs.writeFileSync(path.join(repo, 'src/a.py'), PY.replace('return x + 1', 'return x + 2'));
  assert.equal(checkNote(repo, note).changed[0].reason, 'symbol body changed');
  // and a note without a verifiedCommit is judged as before
  assert.equal(checkNote(repo, { deps: [{ ...dep, hash: 'sha256:old-hasher' }] }).changed[0].reason, 'symbol body changed');
});

test('a note may rest on an agent config file but not on build or run output', () => {
  const repo = tmpRepo();
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'bench', 'runs'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), '{"permissions":{}}');
  fs.writeFileSync(path.join(repo, 'bench', 'runs', 'r1.log'), '[DONE] x: 3s\n');
  fs.writeFileSync(path.join(repo, 'out.log'), 'noise\n');
  const store = new Store(repo).init();

  // the permission classifier is a real trap and .claude/ is the only place it rests on
  const cfg = createNote(store, {
    title: 'Deploy commands are refused in auto mode', kind: 'gotcha',
    answers: ['can I deploy'], body: 'The classifier refuses the upload.',
    deps: [{ path: '.claude/settings.local.json' }],
  });
  assert.ok(cfg.note, 'a note resting only on agent configuration is still created');
  assert.deepEqual(cfg.note.deps.map(d => d.path), ['.claude/settings.local.json']);

  // a benchmark log is rewritten by the next run and says nothing about the code
  const log = createNote(store, {
    title: 'Watch a benchmark run', kind: 'howto', answers: ['is the run done'],
    body: 'grep the log for [DONE].',
    deps: [{ path: 'bench/runs/r1.log' }, { path: 'out.log' }, { path: 'src/a.py', symbol: 'Foo.bar' }],
  });
  assert.deepEqual(log.note.deps.map(d => d.path), ['src/a.py'], 'run output is not an anchor');
  assert.deepEqual(log.dropped.map(d => d.path).sort(), ['bench/runs/r1.log', 'out.log']);
  for (const d of log.dropped) assert.match(d.reason, /build or run output/);

  // with nothing but run output to rest on, the note is refused rather than anchored to it
  const only = createNote(store, {
    title: 'Run output only', kind: 'howto', answers: ['q'], body: 'no code here.',
    deps: [{ path: 'bench/runs/r1.log' }],
  });
  assert.ok(!only.note);
  assert.match(only.error, /no resolvable dependencies/);
});
