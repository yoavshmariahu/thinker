import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, logFile } from '../src/store.js';
import { summarize, renderUsage, savingOf } from '../src/usage.js';

const tmp = p => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
// run with the environment set as given (undefined removes a variable), then put it back
function withEnv(vars, fn) {
  const prev = {}; for (const k in vars) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally { for (const k in prev) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
}
function repoWith(notes) {
  const dir = tmp('thinker-usage-');
  fs.writeFileSync(path.join(dir, 'a.js'), 'x'.repeat(3600));
  fs.writeFileSync(path.join(dir, 'b.js'), 'x'.repeat(360000));
  const store = new Store(dir).init();
  for (const [id, deps] of Object.entries(notes)) store.put({ id, kind: 'location', title: id, body: 'body', deps: deps.map(p => ({ path: p })) });
  return store;
}

test('usage is kept in one log for the machine and summarized across repositories', () => {
  const home = tmp('thinker-home-');
  withEnv({ THINKER_HOME: home, THINKER_LOG: undefined, THINKER_NOTES_DIR: undefined }, () => {
    const one = repoWith({ n1: ['a.js', 'b.js', 'gone.js'], n2: ['a.js'], n3: ['a.js'] });
    const two = repoWith({ m1: ['a.js'] });
    assert.deepEqual(savingOf(one.repo, one.get('n1')), { calls: 2, tokens: 1000 + 6000 });
    assert.equal(logFile(one), path.join(home, 'log.jsonl'));
    assert.match(renderUsage(summarize(one, { all: true })), /No usage recorded on this machine/);

    // what this repository logged locally before the log was shared is moved into the machine's log
    fs.writeFileSync(path.join(one.dir, 'log.jsonl'), JSON.stringify({ t: '2026-01-01T00:00:00.000Z', op: 'lookup', query: 'q', served: ['n2'] }) + '\n');
    one.log({ op: 'orient', session: 's1', task: 't', served: ['n1', 'n2'], tokens: 500, est: [[2, 7000], [1, 1000]] });
    one.log({ op: 'late', session: 's1', files: ['a.js'], served: ['n3'], tokens: 100, est: [[1, 1000]] });
    one.log({ op: 'orient', session: 's1', task: 't2', served: ['n1'], tokens: 300, est: [[2, 7000]] });   // same note, same session: counted once
    one.log({ op: 'orient', task: 'nothing found', served: [] });
    one.log({ op: 'attest', session: 's1', applied: [{ id: 'n1', verdict: 'confirmed' }, { id: 'n2', verdict: 'unused' }] });
    one.log({ op: 'distill', transcript: 'x', saved: ['n4'], merged: ['n1'], cost: 0.05 });
    one.log({ op: 'mine-prs', slug: 'o/r', prs: 3, saved: 2, cost: 0.2 });
    one.log({ op: 'verify', id: 'n1', verdict: 'still_valid', cost: 0.01 });
    // the same session id in another repository is another session
    two.log({ op: 'orient', session: 's1', task: 't', served: ['m1'], tokens: 50, est: [[1, 1000]] });
    two.log({ op: 'attest', session: 's1', applied: [{ id: 'm1', verdict: 'confirmed' }] });

    assert.equal(fs.readFileSync(path.join(home, 'log.jsonl'), 'utf8').trim().split('\n').length, 11);
    assert.equal(fs.existsSync(path.join(one.dir, 'log.jsonl')), false);
    assert.equal(fs.existsSync(path.join(one.dir, 'state', 'log-before-shared.jsonl')), true);
    assert.equal(fs.existsSync(path.join(two.dir, 'log.jsonl')), false);

    const here = summarize(one);
    assert.equal(here.requests, 4); assert.equal(here.answered, 3); assert.equal(here.sessions, 1);
    assert.deepEqual(here.servings, { prompt: 3, file: 1, lookup: 1 });
    assert.deepEqual(here.assessed, { confirmed: 1, contradicted: 0, unused: 1, pending: 2 });
    assert.deepEqual({ calls: here.saved.calls, tokens: here.saved.tokens, servings: here.saved.servings }, { calls: 2, tokens: 7000, servings: 1 });
    assert.deepEqual(here.learned, { sessions: 1, notes: 1, merged: 1, prs: 3, prNotes: 2 });
    assert.equal(here.spent, 0.26);
    assert.equal(here.top.find(t => t.id === 'n1').served, 2);
    assert.match(renderUsage(here), /about 2 reads avoided/);

    // from either repository, the machine's view is the same
    for (const s of [one, two]) {
      const all = summarize(s, { all: true });
      assert.equal(all.requests, 5); assert.equal(all.sessions, 2);
      assert.deepEqual({ calls: all.saved.calls, tokens: all.saved.tokens }, { calls: 3, tokens: 8000 });
      assert.deepEqual(all.repos.map(r => [r.repo, r.notes, r.served, r.calls]), [[one.repo, 3, 5, 2], [two.repo, 1, 1, 1]]);
      const text = renderUsage(all);
      assert.match(text, /on this machine, 2 repositories/);
      assert.match(text, /By repository/);
      assert.match(text, /An estimate, not a measurement/);
    }
  });
});

test('experiments and THINKER_LOG keep events out of the machine log', () => {
  const home = tmp('thinker-home-');
  const store = repoWith({});
  withEnv({ THINKER_HOME: home, THINKER_LOG: undefined, THINKER_NOTES_DIR: tmp('thinker-noteset-') }, () => {
    assert.equal(logFile(store), path.join(store.dir, 'log.jsonl'));
    store.log({ op: 'orient', task: 't', served: [] });
  });
  withEnv({ THINKER_HOME: home, THINKER_LOG: 'local', THINKER_NOTES_DIR: undefined }, () => store.log({ op: 'orient', task: 't', served: [] }));
  withEnv({ THINKER_HOME: home, THINKER_LOG: 'off', THINKER_NOTES_DIR: undefined }, () => { assert.equal(logFile(store), null); store.log({ op: 'orient', task: 't', served: [] }); });
  const other = path.join(home, 'elsewhere', 'x.jsonl');
  withEnv({ THINKER_HOME: home, THINKER_LOG: other, THINKER_NOTES_DIR: undefined }, () => store.log({ op: 'orient', task: 't', served: [] }));
  assert.equal(fs.existsSync(path.join(home, 'log.jsonl')), false);
  assert.equal(fs.readFileSync(path.join(store.dir, 'log.jsonl'), 'utf8').trim().split('\n').length, 2);
  assert.equal(JSON.parse(fs.readFileSync(other, 'utf8')).repo, store.repo);
});

test('a repository is its origin: clones and worktrees count together', async () => {
  const { repoId, normalizeOrigin } = await import('../src/store.js');
  const { execFileSync } = await import('node:child_process');
  for (const u of ['git@github.com:Owner/Repo.git', 'https://github.com/Owner/Repo', 'https://user:pw@github.com/owner/repo.git/', 'ssh://git@github.com/owner/repo.git', 'ssh://git@github.com:22/owner/repo'])
    assert.equal(normalizeOrigin(u), 'github.com/owner/repo', u);
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  const mk = origin => { const d = tmp('thinker-origin-'); git(d, 'init', '-q'); if (origin) git(d, 'remote', 'add', 'origin', origin); fs.writeFileSync(path.join(d, 'a.js'), 'x'); git(d, 'add', '.'); git(d, 'commit', '-q', '-m', 'x'); return d; };
  const clone = mk('git@github.com:Owner/Repo.git'), again = mk('https://github.com/owner/repo'), bare = mk(), other = mk('https://github.com/owner/other.git');
  const wt = path.join(tmp('thinker-wt-'), 'w'); git(clone, 'worktree', 'add', '-q', '--detach', wt);
  assert.equal(repoId(clone), 'github.com/owner/repo');
  assert.equal(repoId(again), 'github.com/owner/repo');
  assert.equal(repoId(wt), 'github.com/owner/repo');
  assert.equal(repoId(bare), bare);

  const home = tmp('thinker-home-');
  withEnv({ THINKER_HOME: home, THINKER_LOG: undefined, THINKER_NOTES_DIR: undefined }, () => {
    const a = new Store(clone).init(), w = new Store(wt), o = new Store(other), b = new Store(bare);
    a.put({ id: 'n1', kind: 'location', title: 'n1', body: 'b', deps: [{ path: 'a.js' }] });
    a.log({ op: 'orient', session: 's1', task: 't', served: ['n1'], tokens: 10, est: [[1, 1]] });
    w.log({ op: 'orient', session: 's2', task: 't', served: ['n1'], tokens: 10, est: [[1, 1]] });
    w.log({ op: 'verify', id: 'n1', verdict: 'still_valid' });     // an event's own id is kept
    o.log({ op: 'orient', session: 's3', task: 't', served: [] });
    b.log({ op: 'orient', session: 's4', task: 't', served: [] });
    // an event written before the origin was recorded is placed by its checkout
    fs.appendFileSync(path.join(home, 'log.jsonl'), JSON.stringify({ t: new Date().toISOString(), repo: again, op: 'orient', task: 't', served: [] }) + '\n');
    const lines = fs.readFileSync(path.join(home, 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(lines[1].origin, 'github.com/owner/repo'); assert.equal(lines[1].repo, wt); assert.equal(lines[2].id, 'n1');

    const all = summarize(a, { all: true });
    assert.deepEqual(all.repos.map(r => [r.repo, r.requests, r.served, r.notes]).sort(), [[bare, 1, 0, 0], ['github.com/owner/other', 1, 0, 0], ['github.com/owner/repo', 3, 2, 1]].sort());
    assert.equal(all.repos.find(r => r.repo === 'github.com/owner/repo').checkouts.length, 3);
    // --here from the worktree covers every checkout of the repository
    const here = summarize(w);
    assert.equal(here.requests, 3); assert.equal(here.scope, 'github.com/owner/repo');
    assert.match(renderUsage(here), /^thinker usage for github.com\/owner\/repo,/);
    assert.match(renderUsage(all), /github\.com\/owner\/repo +1 +3 +2/);
  });
});
