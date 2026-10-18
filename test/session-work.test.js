// Learning inside a desktop app: the hooks queue jobs instead of running an agent CLI, and an app session's
// prompt hook starts one runner whose model calls a subagent of the session answers (session-work.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { enqueueJob, pendingJobs, startSessionWork, runSessionWork, markAppSession, recentAppSession, RUN_EVERY_MS } from '../src/session-work.js';
import { anyDesktopApp } from '../src/app-host.js';
import { subagentPrompt } from '../src/session-llm.js';

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
  assert.match(said, /run_in_background/); assert.match(said, /warmup_next/); assert.match(said, /not a CLI/);
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

test('hooks ignore the queue-worker subagent itself and only queue distill at session end (or when batchDue)', () => {
  const store = repo();
  const env = { ...process.env, THINKER_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-home-')), THINKER_TELEMETRY: 'off', THINKER_LOG: 'local', THINKER_TEST: '0', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' };
  const hook = (what, ev) => execFileSync('node', [CLI, 'hook', what, '--client', 'cursor', '--record', '--repo', store.repo], { input: JSON.stringify(ev), encoding: 'utf8', env });
  const workerPrompt = subagentPrompt(store.repo);
  assert.deepEqual(JSON.parse(hook('prompt', { conversation_id: 'w-sub', prompt: workerPrompt })), { continue: true });
  hook('tool', { conversation_id: 'w-sub', tool_name: 'MCP:warmup_next', tool_input: { cwd: store.repo }, tool_output: 'Nothing has come yet' });
  assert.deepEqual(JSON.parse(hook('stop', { conversation_id: 'w-sub', hook_event_name: 'sessionEnd', prompt: workerPrompt })), {});
  assert.equal(fs.existsSync(path.join(store.dir, 'state', 'trace-w-sub.jsonl')), false, 'worker session leaves no trace');
  assert.deepEqual(pendingJobs(store).filter(j => j.key.includes('w-sub')), [], 'worker session is never queued for distillation');

  // Regular user session: turn-end `stop` does not queue an unbatched per-turn distill; `sessionEnd` does
  const tr = path.join(store.dir, 'u-main.jsonl');
  fs.writeFileSync(tr, [
    JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'investigate src/a.js' }] } }),
    JSON.stringify({ role: 'assistant', message: { content: [{ type: 'tool_use', id: '1', name: 'Read', input: { path: 'src/a.js' } }, { type: 'text', text: 'done' }] } }),
  ].join('\n') + '\n');
  hook('stop', { conversation_id: 'u-main', hook_event_name: 'stop', transcript_path: tr });
  assert.deepEqual(pendingJobs(store).filter(j => j.key === 'distill-u-main'), [], 'turn-end stop leaves small backlog for sessionEnd');
  hook('stop', { conversation_id: 'u-main', hook_event_name: 'sessionEnd', transcript_path: tr });
  assert.deepEqual(pendingJobs(store).filter(j => j.key === 'distill-u-main').map(j => j.key), ['distill-u-main']);
});
