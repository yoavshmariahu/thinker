import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { desktopApps, handoffUrl, handoffMessage, openHandoff, handoffProgress } from '../src/desktop-handoff.js';
import { handOff, warmupCommand } from '../src/commands/warmup.js';
import { stripAnsi } from '../src/setup/ui.js';

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const support = home => path.join(home, 'Library', 'Application Support');

test('desktop apps: installed by bundle, signed in by the presence of a token, macOS only', () => {
  const home = tmp('handoff-home-');
  const bundles = new Set(['/Applications/Claude.app', path.join(home, 'Applications', 'Cursor.app')]);
  const existsFn = p => bundles.has(p);
  fs.mkdirSync(path.join(support(home), 'Claude'), { recursive: true });
  fs.writeFileSync(path.join(support(home), 'Claude', 'config.json'), JSON.stringify({ 'oauth:tokenCacheV2': 'x' }));
  const sql = [];
  const execFn = (cmd, args) => { sql.push(args.at(-1)); return /accessToken/.test(args.at(-1)) ? '1\n' : '"me@example.com"\n'; };
  assert.deepEqual(desktopApps({ home, existsFn, execFn }), [
    { app: 'claude', name: 'Claude Desktop', signedIn: true },
    { app: 'cursor', name: 'Cursor', signedIn: true, account: 'me@example.com' },
  ]);
  assert.ok(sql.every(q => !/select value from ItemTable where key = 'cursorAuth\/accessToken'/.test(q)), 'the token itself is never read');
  // signed out: no token cache, no access token
  fs.writeFileSync(path.join(support(home), 'Claude', 'config.json'), JSON.stringify({ locale: 'en' }));
  assert.deepEqual(desktopApps({ home, existsFn, execFn: () => '0\n' }).map(a => a.signedIn), [false, false]);
  // no state database (sqlite3 fails): not signed in, not an error
  assert.equal(desktopApps({ home, existsFn, execFn: () => { throw new Error('no db'); } })[1].signedIn, false);
  assert.deepEqual(desktopApps({ home, existsFn, execFn, platform: 'linux' }), []);
  assert.deepEqual(desktopApps({ existsFn, execFn }), [], 'the suite sees none of the machine\'s apps');
});

test('the hand-off link opens the repository with a plain message that names one command', () => {
  const msg = handoffMessage('cursor', 'web');
  assert.match(msg, /does not change any code/);
  assert.match(msg, /`thinker warmup --answer warm --client cursor`/);
  assert.doesNotMatch(msg, /\$\(/, 'no shell substitutions in what the person reads');
  const c = new URL(handoffUrl('claude', '/src/my web'));
  assert.equal(c.protocol + c.host + c.pathname, 'claude:code/new');
  assert.equal(c.searchParams.get('folder'), '/src/my web');
  assert.equal(c.searchParams.get('q'), handoffMessage('claude', 'my web'));
  const u = new URL(handoffUrl('cursor', '/src/web'));
  assert.equal(u.host + u.pathname, 'anysphere.cursor-deeplink/prompt');
  assert.equal(u.searchParams.get('workspace'), 'web');
  assert.throws(() => handoffUrl('codex', '/src/web'));
});

test('opening: Cursor opens the repository window before the prompt link; a failed open throws', async () => {
  const calls = [];
  await openHandoff('cursor', '/src/web', { spawnFn: (cmd, args) => { calls.push(args); return { status: 0 }; }, wait: async () => calls.push('wait') });
  assert.deepEqual(calls.slice(0, 2), [['-a', 'Cursor', '/src/web'], 'wait']);
  assert.match(calls[2][0], /^cursor:\/\//);
  await assert.rejects(openHandoff('claude', '/src/web', { spawnFn: () => ({ status: 1 }) }), /open exited 1/);
});

test('progress: started once the session ran the answer, working once its subagent takes a call', () => {
  const repo = tmp('handoff-repo-'), state = path.join(repo, '.thinker', 'state'), q = path.join(state, 'session-llm');
  const since = Date.now();
  assert.equal(handoffProgress(repo, since), 'none');
  fs.mkdirSync(q, { recursive: true });
  fs.writeFileSync(path.join(q, 'build.json'), JSON.stringify({ pid: 1, started: new Date(since - 60_000).toISOString() }));
  assert.equal(handoffProgress(repo, since), 'none', 'an earlier build is not this one');
  fs.writeFileSync(path.join(q, 'build.json'), JSON.stringify({ pid: 1, started: new Date(since + 10).toISOString() }));
  fs.writeFileSync(path.join(q, 'a.req.json'), '{}');
  fs.writeFileSync(path.join(state, 'warmup.log'), 'PR mining: 0/12 processed · working on commit dbf4d14c…\n');
  assert.equal(handoffProgress(repo, since), 'started', 'calls queued and none taken: the click stall of 2026-10-16');
  fs.renameSync(path.join(q, 'a.req.json'), path.join(q, 'a.claimed.json'));
  assert.equal(handoffProgress(repo, since), 'working');
  fs.rmSync(path.join(q, 'a.claimed.json'));
  fs.appendFileSync(path.join(state, 'warmup.log'), 'PR mining: 3/12 processed\n');
  assert.equal(handoffProgress(repo, since), 'working');
});

test('hand-off: shows the message, asks, opens each repository and tells reading from stalled from unsent', async () => {
  const chosen = [{ name: 'web', checkout: '/src/web' }, { name: 'api', checkout: '/src/api' }, { name: 'cli', checkout: '/src/cli' }];
  const lines = [], opened = [];
  let clock = 0;
  const now = Date.now; Date.now = () => clock;
  try {
    const progress = { '/src/web': () => clock > 10 ? 'working' : 'started', '/src/api': () => 'started', '/src/cli': () => 'none' };
    const r = await handOff('claude', chosen, {
      out: s => lines.push(stripAnsi(s)), ask: async () => '',
      openFn: async (app, repo) => opened.push([app, repo]),
      progressFn: repo => progress[repo](), waitMs: 100, workMs: 50, pollMs: 5, sleep: async ms => { clock += ms; },
    });
    const text = lines.join('\n');
    assert.match(text, /a new session for each of the 3 repositories/);
    assert.match(text, /│ Please run `thinker warmup --answer warm --client claude`/);
    assert.match(text, /Nothing runs until you press Enter in Claude Desktop/);
    assert.deepEqual(opened.map(o => o[1]), ['/src/web', '/src/api', '/src/cli']);
    assert.deepEqual([r.started, r.stalled, r.waiting].map(l => l.map(x => x.name)), [['web'], ['api'], ['cli']]);
    assert.match(text, /✓ web: the warm-up is reading in Claude Desktop/);
    assert.match(text, /⚠ api: the session in Claude Desktop ran the warm-up but nothing is reading it/);
    assert.match(text, /cli: not started yet\. The message waits in Claude Desktop/);
    assert.doesNotMatch(text, /✓ api/, 'a session that only ran the answer is not reported as warming');
  } finally { Date.now = now; }
  // declined: nothing opens
  const none = await handOff('cursor', chosen, { out: () => {}, ask: async () => 'n', openFn: async () => { throw new Error('must not open'); } });
  assert.equal(none.started.length, 0);
});

test('thinker warmup: a signed-in app leads when no CLI is signed in, a signed-in CLI leads otherwise', async () => {
  const rows = [{ name: 'web', checkout: '/src/web', canMine: true, estimates: { full: { seconds: 1, prs: 1 } } }];
  const apps = () => [{ app: 'cursor', name: 'Cursor', signedIn: true }];
  const run = async (authenticated) => {
    const did = [];
    await warmupCommand({ flags: { terminal: true, yes: true, repos: 'web' }, store: {}, out: () => {}, HERE: '/app' }, {
      candidatesFn: () => rows, appsFn: apps, checkAuthFn: () => ({ authenticated }),
      handOffFn: async (app, chosen) => { did.push(`handoff:${app}:${chosen.map(r => r.name)}`); return { started: chosen, waiting: [] }; },
      selectAgentFn: async () => { did.push('cli'); return { ok: true, agent: 'claude' }; },
      spawnFn: () => { did.push('build'); return { status: 0 }; },
    });
    return did;
  };
  assert.deepEqual(await run(false), ['handoff:cursor:web']);
  assert.deepEqual(await run(true), ['cli', 'build']);
  // an app that is not signed in is never offered
  const did = [];
  await warmupCommand({ flags: { terminal: true, yes: true, repos: 'web' }, store: {}, out: () => {}, HERE: '/app' }, {
    candidatesFn: () => rows, appsFn: () => [{ app: 'claude', name: 'Claude Desktop', signedIn: false }],
    handOffFn: async () => { throw new Error('signed-out app offered'); },
    selectAgentFn: async () => { did.push('cli'); return { ok: false, error: 'cancelled' }; }, spawnFn: () => ({ status: 0 }),
  });
  assert.deepEqual(did, ['cli']);
});
