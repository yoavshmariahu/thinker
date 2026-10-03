import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, logFile } from '../src/store.js';
import { summarize, renderUsage, savingOf, cacheHitSavings, formatTokens, formatSeconds, cacheHitNotice, turnNotice, SECONDS_PER_READ } from '../src/usage.js';

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

test('assessments are logged under the session id, and older ones under a file name still match', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { recordEvent, traceFile } = await import('../src/transcripts.js');
  const { sessionKey } = await import('../src/usage.js');
  const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
  assert.equal(sessionKey('trace-abc.jsonl'), 'abc');
  assert.equal(sessionKey('rollout-2026-09-27T10-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'), '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b');
  assert.equal(sessionKey('session-1.json'), 'session-1');
  assert.equal(sessionKey('8c1552c5-1ea2-4551-946c-25fea13d296d'), '8c1552c5-1ea2-4551-946c-25fea13d296d');

  const home = tmp('thinker-home-');
  const store = repoWith({ n1: ['a.js'] });
  execFileSync('git', ['init', '-q'], { cwd: store.repo });
  const env = { THINKER_HOME: home, THINKER_LOG: undefined, THINKER_NOTES_DIR: undefined, THINKER_NO_LEARN: undefined };
  // a session of an agent that gives no transcript: the hooks recorded it, and served n1 in it
  withEnv(env, () => {
    store.put({ ...store.get('n1'), servedIn: ['sess-1'] });
    store.log({ op: 'orient', session: 'sess-1', task: 't', served: ['n1'], tokens: 10, est: [[1, 1000]] });
    recordEvent(store.dir, 'sess-1', { t: 'prompt', text: 'where is a' });
    for (let i = 0; i < 3; i++) recordEvent(store.dir, 'sess-1', { t: 'tool', name: 'Read', input: { file_path: 'a.js' }, result: 'x' });
    recordEvent(store.dir, 'sess-1', { t: 'say', text: 'it is in a.js' });
  });
  const model = path.join(home, 'model.js');
  fs.writeFileSync(model, `process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ notes: [], assessments: [{ id: 'n1', verdict: 'confirmed', evidence: 'read a.js', correction: '' }] })));`);
  const childEnv = { ...process.env, THINKER_HOME: home, THINKER_LLM_CMD: `node ${model}` };
  for (const k of ['THINKER_LOG', 'THINKER_NOTES_DIR', 'THINKER_NO_LEARN', 'THINKER_LLM', 'ANTHROPIC_API_KEY']) delete childEnv[k];
  execFileSync('node', [CLI, 'distill', traceFile(store.dir, 'sess-1'), '--incremental', '--quiet', '--session', 'sess-1', '--repo', store.repo], { env: childEnv, stdio: 'pipe' });
  withEnv(env, () => {
    const log = fs.readFileSync(path.join(home, 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(log.find(e => e.op === 'attest').session, 'sess-1');
    const u = summarize(store);
    assert.deepEqual(u.assessed, { confirmed: 1, contradicted: 0, unused: 0, pending: 0 });
    assert.deepEqual({ calls: u.saved.calls, tokens: u.saved.tokens }, { calls: 1, tokens: 1000 });
    // an assessment written before the fix, under the trace's file name
    store.log({ op: 'orient', session: 'sess-2', task: 't', served: ['n1'], tokens: 10, est: [[1, 1000]] });
    store.log({ op: 'attest', session: 'trace-sess-2', applied: [{ id: 'n1', verdict: 'confirmed' }] });
    assert.equal(summarize(store).saved.calls, 2);
  });
});

test('the notice names the notes and the code they point at, not a saving', () => {
  assert.equal(formatTokens(450), '450');
  assert.equal(formatTokens(1500), '1.5k');
  assert.equal(formatTokens(10000), '10k');
  assert.equal(formatTokens(24500), '25k');
  assert.equal(formatSeconds(8), '8s');
  assert.equal(formatSeconds(60), '1min');
  assert.equal(formatSeconds(90), '1.5min');

  const one = repoWith({ n1: ['a.js', 'b.js'], n2: ['a.js'] });
  assert.deepEqual(cacheHitSavings(one.repo, [one.get('n1'), one.get('n2')]), { calls: 2, tokens: 7000, seconds: 2 * SECONDS_PER_READ });
  // a note whose files are missing still stands for one read's worth of time
  assert.equal(cacheHitSavings(one.repo, [{ id: 'x', body: 'some body', deps: [{ path: 'gone.js' }] }]).seconds, SECONDS_PER_READ);

  assert.equal(cacheHitNotice(one.repo, []), '');

  assert.equal(cacheHitNotice(one.repo, [one.get('n2')]), '🧠 thinker: 1 note (pointing at ~1k tokens of code)');
  assert.equal(cacheHitNotice(one.repo, [one.get('n1'), one.get('n2')]), '🧠 thinker: 2 notes (pointing at ~7k tokens of code)');
  for (const text of [cacheHitNotice(one.repo, [one.get('n1')]), turnNotice(one.repo, [one.get('n1')])]) assert.doesNotMatch(text, /saved|hit/, 'nothing is known to be saved when a note is served');
});

test('turn notice sums what the whole turn served', () => {
  const one = repoWith({ n1: ['a.js', 'b.js'], n2: ['a.js'] });
  assert.equal(turnNotice(one.repo, []), '');
  assert.equal(turnNotice(one.repo, [one.get('n1'), one.get('n2')]), '🧠 thinker: 2 notes this turn (pointing at 2 files, ~7k tokens of code)');
  assert.equal(turnNotice(one.repo, [one.get('n2')]), '🧠 thinker: 1 note this turn (pointing at 1 file, ~1k tokens of code)');
});

test('both sides of the balance are priced at the model of the session, and what has no price is said', () => {
  const home = tmp('thinker-home-');
  withEnv({ THINKER_HOME: home, THINKER_LOG: undefined, THINKER_NOTES_DIR: undefined }, () => {
    const store = repoWith({ n1: ['b.js'], n2: ['b.js'], n3: ['b.js'] });
    // a Claude Code session: 6,000 tokens of reading avoided at Fable's $10/M, 500 tokens injected
    store.log({ op: 'orient', session: 'fable', client: 'claude', task: 't', served: ['n1'], tokens: 500, est: [[1, 6000]] });
    store.log({ op: 'attest', session: 'fable', client: 'claude', model: 'claude-fable-5-1', applied: [{ id: 'n1', verdict: 'confirmed' }] });
    // a Codex session on a model with no price: confirmed, counted in tokens, not in dollars
    store.log({ op: 'orient', session: 'codex', client: 'codex', task: 't', served: ['n2'], tokens: 300, est: [[1, 6000]] });
    store.log({ op: 'attest', session: 'codex', client: 'codex', model: 'gpt-6-sol', applied: [{ id: 'n2', verdict: 'confirmed' }] });
    // an assessment that named no model
    store.log({ op: 'orient', session: 'old', task: 't', served: ['n3'], tokens: 200, est: [[1, 6000]] });
    store.log({ op: 'attest', session: 'old', applied: [{ id: 'n3', verdict: 'confirmed' }] });
    // model work: reported, priced from tokens, and unpriceable
    store.log({ op: 'model', purpose: 'verify', phase: 'maintenance', provider: 'claude', model: 'claude-haiku-4-5', cost: 0.04, tokens: { inputTokens: 10000, outputTokens: 1000, totalTokens: 11000 } });
    store.log({ op: 'model', purpose: 'verify', phase: 'maintenance', provider: 'claude', model: 'claude-haiku-4-5', cost: null, tokens: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1_000_000 } });
    store.log({ op: 'model', purpose: 'distill', phase: 'learning', provider: 'codex', model: 'gpt-6-sol', cost: null, tokens: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 } });

    const u = summarize(store);
    assert.equal(u.saved.servings, 3); assert.equal(u.saved.tokens, 18000);
    assert.equal(u.saved.pricedServings, 1); assert.equal(u.saved.usd, 0.06);
    assert.deepEqual(u.saved.byModel, { 'claude-fable-5-1': { servings: 1, tokens: 6000, usd: 0.06 } });
    assert.equal(u.saved.unpricedServings, 2); assert.equal(u.saved.unpricedTokens, 12000);
    assert.equal(u.injected.usd, 0.005); assert.equal(u.injected.pricedTokens, 500); assert.equal(u.injected.unpricedTokens, 500);
    assert.equal(u.spending.reportedCost, 0.04); assert.equal(u.spending.estimatedCost, 1); assert.equal(u.spending.unpricedCalls, 1);
    assert.equal(u.spending.cost, 1.04);
    assert.equal(Math.round(u.saved.netUsd * 1000) / 1000, 0.06 - 0.005 - 1.04);
    assert.equal(u.saved.pricingComplete, false);
    const text = renderUsage(u);
    assert.match(text, /in dollars\s+\$0\.06 at the input price .* \$0\.06 on claude-fable-5-1 \(1 servings\)/);
    assert.match(text, /2 servings \(12,000 tokens\) not priced/);
    assert.match(text, /\$1\.00 for the 1 unreported records on a model with a known price/);
    assert.match(text, /in dollars\s+−\$0\.98 = \$0\.06 reading avoided − \$0\.01 notes injected − \$1\.04 model work \(\$0\.04 reported \+ \$1\.00 priced from tokens\)/);
    assert.match(text, /Not in this balance.*2 confirmed servings, 500 injected tokens, 1 model records/);

    // with the vendor's price given, the Codex session and record are priced too
    fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ prices: { 'gpt-6-sol': { input: 5, output: 20 } } }));
    const v = summarize(store);
    assert.equal(v.saved.pricedServings, 2); assert.equal(v.saved.byModel['gpt-6-sol'].usd, 0.03);
    assert.equal(v.spending.unpricedCalls, 0); assert.equal(Math.round(v.spending.estimatedCost * 1000) / 1000, 1.007);
  });
});
