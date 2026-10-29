// Learning inside a desktop app: the hooks queue jobs instead of running an agent CLI, and an app session's
// prompt hook starts one runner whose model calls a subagent of the session answers (session-work.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { enqueueJob, pendingJobs, startSessionWork, runSessionWork, markAppSession, recentAppSession, RUN_EVERY_MS, MAX_ATTEMPTS } from '../src/session-work.js';
import { maintenanceNotice } from '../src/maintain.js';
import { anyDesktopApp } from '../src/app-host.js';
import { subagentPrompt } from '../src/session-llm.js';
// Ranking is not what these tests check, so the cross-encoder (dense.js) stays out of the hook spawns:
// it has its own test, and loading an ONNX session in each spawn is most of what they cost.
process.env.THINKER_CE = 'off';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-session-work-'));
  execFileSync('git', ['init', '-q', d]);
  return new Store(fs.realpathSync(d)).init();
}

test('jobs queue once per key, oldest first, and a run takes a few of them in order', () => {
  const store = repo();
  enqueueJob(store, 'distill-s1', ['distill', '/t/s1.jsonl', '--session', 's1']);
  enqueueJob(store, 'learn', ['learn', '--quiet']);
  enqueueJob(store, 'distill-s1', ['distill', '/t/s1.jsonl', '--session', 's1']);
  assert.deepEqual(pendingJobs(store).map(j => j.key), ['distill-s1', 'learn']);
  const ran = [];
  const n = runSessionWork(store, { cli: '/x/cli.js', limit: 1, out: () => {}, spawnFn: (bin, args) => { ran.push(args.slice(1)); return { status: 0 }; } });
  assert.equal(n, 1); assert.deepEqual(ran, [['distill', '/t/s1.jsonl', '--session', 's1']]);
  assert.deepEqual(pendingJobs(store).map(j => j.key), ['learn']);
});

test('an app session\'s prompt hook starts one runner with the session provider and asks for a subagent, at most every half hour', () => {
  const store = repo();
  let spawned = [];
  const spawnFn = (bin, args, o) => { spawned.push({ args, env: o.env }); return { pid: process.pid, unref() {} }; };
  assert.equal(startSessionWork(store, { cli: '/x/cli.js', harness: 'claude', spawnFn }), '', 'no jobs: nothing');
  enqueueJob(store, 'learn', ['learn', '--quiet']);
  assert.equal(startSessionWork(store, { cli: '/x/cli.js', harness: null, spawnFn }), '', 'a client with no subagents: nothing');
  const said = startSessionWork(store, { cli: '/x/cli.js', harness: 'claude', spawnFn });
  assert.match(said, /run_in_background/); assert.match(said, /learn_next/); assert.match(said, /not a CLI/);
  assert.deepEqual(spawned[0].args.slice(1), ['session-work', '--repo', store.repo]);
  assert.equal(spawned[0].env.THINKER_LLM, 'session'); assert.equal(spawned[0].env.THINKER_SESSION_QUEUE, path.join(store.dir, 'state', 'session-llm'));
  // running (its pid is alive): not again; nor within the half hour once it has ended
  assert.equal(startSessionWork(store, { cli: '/x/cli.js', harness: 'codex', spawnFn }), '');
  fs.writeFileSync(path.join(store.dir, 'state', 'session-llm', 'build.json'), JSON.stringify({ pid: 2 ** 22 + 12345 }));
  assert.equal(startSessionWork(store, { cli: '/x/cli.js', harness: 'codex', spawnFn }), '');
  assert.match(startSessionWork(store, { cli: '/x/cli.js', harness: 'codex', spawnFn, now: Date.now() + RUN_EVERY_MS + 1000 }), /spawn_agent/);
});

test('a repository worked in an app queues the maintenance a commit starts; the session runner runs it', () => {
  const store = repo();
  assert.equal(recentAppSession(store), null);
  markAppSession(store, 'Claude Desktop');
  assert.equal(recentAppSession(store), 'Claude Desktop');
  assert.equal(recentAppSession(store, { now: Date.now() + 25 * 3600_000 }), null);
  const env = { ...process.env, THINKER_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-home-')), THINKER_TELEMETRY: 'off', THINKER_LOG: 'local' };
  delete env.THINKER_LLM;
  const said = execFileSync('node', [CLI, 'maintain', '--repo', store.repo], { encoding: 'utf8', env });
  assert.match(said, /queued for the next session in Claude Desktop/);
  assert.deepEqual(pendingJobs(store).map(j => j.args), [['maintain', '--quiet', '--repo', store.repo]]);
  // session-work refuses to run outside the session provider
  assert.throws(() => execFileSync('node', [CLI, 'session-work', '--repo', store.repo], { encoding: 'utf8', env, stdio: 'pipe' }), e => e.status === 2 && /runs only as started by an app session/.test(e.stdout));
});

test('any desktop app by env or process; a terminal is none', () => {
  assert.equal(anyDesktopApp({ env: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }, ancestry: [] }), 'Claude Desktop');
  assert.equal(anyDesktopApp({ env: {}, ancestry: ['/Applications/Cursor.app/Contents/MacOS/Cursor'] }), 'Cursor');
  assert.equal(anyDesktopApp({ env: {}, ancestry: ['-zsh', '/Applications/iTerm.app/Contents/MacOS/iTerm2'] }), null);
});

test('failed jobs survive, back off across repeated hooks, and are acknowledged after success', () => {
  const store = repo(), now = Date.now();
  enqueueJob(store, 'distill-s1', ['distill', '/t/s1.jsonl']);
  const run = options => runSessionWork(store, { cli: '/unused', out: () => {}, now, ...options });
  assert.equal(run({ spawnFn: () => ({ status: 1 }) }), 1);
  let job = pendingJobs(store)[0];
  assert.equal(job.attempts, 1); assert.match(job.lastError, /exited with 1/);
  assert.equal(Date.parse(job.nextAttemptAt), now + RUN_EVERY_MS);
  enqueueJob(store, 'distill-s1', ['distill', '/t/s1.jsonl']);
  assert.equal(pendingJobs(store).length, 1);
  assert.equal(pendingJobs(store)[0].attempts, 1);
  assert.equal(run({ spawnFn: () => assert.fail('backoff must survive enqueue') }), 0);
  assert.equal(startSessionWork(store, { cli: '/unused', harness: 'codex', now, spawnFn: () => assert.fail('no eligible work') }), '');
  run({ now: now + RUN_EVERY_MS, spawnFn: () => ({ status: 2 }) });
  job = pendingJobs(store)[0];
  assert.equal(job.attempts, 2);
  assert.equal(Date.parse(job.nextAttemptAt), now + 3 * RUN_EVERY_MS);
  run({ now: Date.parse(job.nextAttemptAt), spawnFn: () => ({ status: 0 }) });
  assert.deepEqual(pendingJobs(store), []);
});

// A job that fails for a reason retrying does not fix retried for ever with a 24-hour backoff and
// told nobody: one on a user's machine reached ten attempts before a person reading the state file
// found it. It is given up on instead, and said once at the end of a turn.
test('a job that keeps failing is given up on after MAX_ATTEMPTS and named once', () => {
  const store = repo();
  enqueueJob(store, 'distill-s1', ['distill', '/t/s1.jsonl']);
  let time = Date.now(), lines = [];
  const run = () => runSessionWork(store, { cli: '/unused', out: l => lines.push(l), now: () => time, spawnFn: () => ({ status: 1 }) });
  for (let i = 1; i < MAX_ATTEMPTS; i++) {
    assert.equal(run(), 1, `attempt ${i} runs`);
    const job = pendingJobs(store)[0];
    assert.equal(job.attempts, i);
    time = Date.parse(job.nextAttemptAt);
  }
  assert.equal(run(), 1, 'the last attempt runs');
  assert.deepEqual(pendingJobs(store), [], 'given up on: the job is gone, not waiting for ever');
  assert.match(lines.at(-1), new RegExp(`failed ${MAX_ATTEMPTS} times; given up on`));
  const notice = maintenanceNotice(store);
  assert.match(notice, /given up on/);
  assert.match(notice, /distill/);
  assert.equal(maintenanceNotice(store), '', 'said once');
  // the work itself is not lost: the next session's hook queues it again
  enqueueJob(store, 'distill-s1', ['distill', '/t/s1.jsonl']);
  assert.equal(pendingJobs(store).length, 1);
  assert.equal(pendingJobs(store)[0].attempts, undefined, 'and it starts over');
});

test('signals and spawn errors retain jobs, while unrelated ready jobs still run', () => {
  for (const failure of [() => ({ status: null, signal: 'SIGTERM' }), () => ({ error: new Error('spawn ENOENT') }), () => { throw new Error('spawn failed'); }]) {
    const store = repo();
    enqueueJob(store, 'a-fail', ['distill', 'a']); enqueueJob(store, 'b-ok', ['distill', 'b']);
    const n = runSessionWork(store, { cli: '/unused', out: () => {}, spawnFn: (bin, args) => args.at(-1) === 'a' ? failure() : { status: 0 } });
    assert.equal(n, 2); assert.equal(pendingJobs(store).length, 1);
    assert.match(pendingJobs(store)[0].lastError, /SIGTERM|spawn/);
  }
});

test('retry backoff starts when a slow attempt fails, not when the batch started', () => {
  const store = repo(); let time = Date.now();
  enqueueJob(store, 'slow', ['distill', 'fixture']);
  runSessionWork(store, { cli: '/unused', out: () => {}, now: () => time, spawnFn: () => { time += 2 * RUN_EVERY_MS; return { status: 1 }; } });
  assert.equal(Date.parse(pendingJobs(store)[0].nextAttemptAt), time + RUN_EVERY_MS);
});

test('a live claim cannot be taken twice, and success preserves work enqueued during the attempt', () => {
  const store = repo();
  enqueueJob(store, 'distill-s1', ['distill', 'old']);
  runSessionWork(store, { cli: '/unused', out: () => {}, spawnFn: () => {
    assert.equal(runSessionWork(store, { cli: '/unused', spawnFn: () => assert.fail('already claimed') }), 0);
    enqueueJob(store, 'distill-s1', ['distill', 'new']);
    return { status: 0 };
  } });
  assert.deepEqual(pendingJobs(store).map(j => j.args), [['distill', 'new']]);
});

test('a process dying after claiming leaves durable work that another runner recovers', () => {
  const store = repo();
  enqueueJob(store, 'distill-s1', ['distill', 'fixture']);
  const source = `import { Store } from ${JSON.stringify(new URL('../src/store.js', import.meta.url).href)};
    import { runSessionWork } from ${JSON.stringify(new URL('../src/session-work.js', import.meta.url).href)};
    runSessionWork(new Store(process.argv[1]), { cli: '/unused', out: () => {}, spawnFn: () => process.exit(19) });`;
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', source, store.repo], { env: { ...process.env, THINKER_TEST: '1' }, stdio: 'pipe' }), e => e.status === 19);
  assert.equal(pendingJobs(store).length, 1);
  assert.equal(pendingJobs(store)[0].running, false);
  let calls = 0;
  runSessionWork(store, { cli: '/unused', out: () => {}, spawnFn: () => { calls++; return { status: 0 }; } });
  assert.equal(calls, 1); assert.deepEqual(pendingJobs(store), []);
});

test('catch-up reports a failed session to the queue instead of acknowledging the batch', () => {
  const store = repo();
  fs.writeFileSync(path.join(store.repo, 'a.js'), 'export const value = 1;');
  const trace = path.join(store.dir, 'state', 'trace-catchup.jsonl');
  fs.mkdirSync(path.dirname(trace), { recursive: true });
  const events = [{ t: 'prompt', text: 'fix value' },
    ...[1, 2, 3].map(() => ({ t: 'tool', name: 'Read', input: { file_path: 'a.js' }, result: 'export const value = 1;' })),
    { t: 'tool', name: 'Edit', input: { file_path: 'a.js', old_string: '0', new_string: '1' }, result: 'ok' },
    { t: 'say', text: 'Fixed value in a.js.' }];
  fs.writeFileSync(trace, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  const env = { ...process.env, HOME: store.repo, THINKER_HOME: path.join(store.repo, 'home'), THINKER_LLM: 'session', THINKER_NO_LEARN: '0', THINKER_LOG: 'local', THINKER_TEST: '1' };
  delete env.THINKER_SESSION_QUEUE; // fail immediately, with no real model/network call
  const r = spawnSync(process.execPath, [CLI, 'learn', '--quiet', '--idle-min', '0', '--repo', store.repo], { env, encoding: 'utf8', timeout: 15_000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /failed:.*session provider needs/);
  assert.equal(fs.existsSync(path.join(store.dir, 'state', 'trace-catchup.json')), false, 'failure did not advance the distillation checkpoint');
});

test('hooks ignore the queue-worker subagent itself and only queue distill at session end (or when batchDue)', () => {
  const store = repo();
  const env = { ...process.env, HOME: store.repo, THINKER_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-home-')), THINKER_TELEMETRY: 'off', THINKER_LOG: 'local', THINKER_TEST: '1', THINKER_HOOKS: 'on', THINKER_NO_LEARN: '0', CURSOR_AGENT: '1' };
  const hook = (what, ev) => execFileSync('node', [CLI, 'hook', what, '--client', 'cursor', '--record', '--repo', store.repo], { input: JSON.stringify(ev), encoding: 'utf8', env });
  const workerPrompt = subagentPrompt(store.repo);
  assert.deepEqual(JSON.parse(hook('prompt', { conversation_id: 'w-sub', prompt: workerPrompt })), { continue: true });
  hook('tool', { conversation_id: 'w-sub', tool_name: 'MCP:learn_next', tool_input: { cwd: store.repo }, tool_output: 'Nothing has come yet' });
  assert.deepEqual(JSON.parse(hook('stop', { conversation_id: 'w-sub', hook_event_name: 'sessionEnd', prompt: workerPrompt })), {});
  assert.equal(fs.existsSync(path.join(store.dir, 'state', 'trace-w-sub.jsonl')), false, 'worker session leaves no trace');
  assert.deepEqual(pendingJobs(store).filter(j => j.key.includes('w-sub')), [], 'worker session is never queued for distillation');

  // Regular user session: turn-end `stop` does not queue an unbatched per-turn distill; `sessionEnd` does,
  // even when Cursor injected <dynamic_tool_catalog> listing learn_next
  const tr = path.join(store.dir, 'u-main.jsonl');
  fs.writeFileSync(tr, [
    JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<dynamic_tool_catalog><namespace name="user-thinker" tools="orient, lookup, learn_next" /></dynamic_tool_catalog>\n<user_query>\ninvestigate src/a.js\n</user_query>' }] } }),
    JSON.stringify({ role: 'assistant', message: { content: [{ type: 'tool_use', id: '1', name: 'Read', input: { path: 'src/a.js' } }, { type: 'text', text: 'done' }] } }),
  ].join('\n') + '\n');
  hook('prompt', { conversation_id: 'u-main', prompt: 'investigate src/a.js' });
  hook('stop', { conversation_id: 'u-main', hook_event_name: 'stop', transcript_path: tr });
  assert.equal(fs.existsSync(path.join(store.dir, 'state', 'trace-u-main.jsonl')), true, 'user session trace is preserved across stop when dynamic_tool_catalog is present');
  assert.deepEqual(pendingJobs(store).filter(j => j.key === 'distill-u-main'), [], 'turn-end stop leaves small backlog for sessionEnd');
  hook('stop', { conversation_id: 'u-main', hook_event_name: 'sessionEnd', transcript_path: tr });
  assert.deepEqual(pendingJobs(store).filter(j => j.key === 'distill-u-main').map(j => j.key), ['distill-u-main']);
  hook('prompt', { conversation_id: 'u-main', prompt: 'continue investigating src/a.js' });
  assert.equal(fs.existsSync(path.join(store.dir, 'state', 'session-work.last')), false, 'test mode never starts a real queue worker');
  assert.deepEqual(pendingJobs(store).map(j => j.key), ['distill-u-main'], 'test mode also keeps catch-up learning disabled');
});
