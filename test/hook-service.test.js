// thinker's hooks over HTTP (src/hook-service.js): the routes, the translation, and the real hook command behind them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { hookService, hookEvent, hookAnswer, workspaceFor, HOOK_EVENTS } from '../src/hook-service.js';
import { startProxy, PROXY_DEFAULTS } from '../src/proxy.js';
import { stopOutput, toolOutput } from '../src/clients.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-hooksvc-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const serve = (t, handle) => new Promise(resolve => {
  const s = http.createServer((req, res) => { handle(req, res); });
  t.after(() => s.close());
  s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${s.address().port}`));
});
const post = async (base, event, body) => { const r = await fetch(`${base}/thinker/hook/${event}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

test('an agent gets a checkout of its own: an empty git repository under thinker\'s home, by its name', t => {
  const home = tmp(t);
  const a = workspaceFor(home, 'Support Bot'), b = workspaceFor(home, 'support bot'), c = workspaceFor(home, 'research');
  assert.equal(a, path.join(home, 'agents', 'support-bot'));
  assert.equal(a, b, 'the same agent keeps its checkout');
  assert.notEqual(a, c);
  assert.ok(fs.existsSync(path.join(a, '.git')));
  assert.equal(workspaceFor(home, undefined), path.join(home, 'agents', 'agent'));
  assert.equal(workspaceFor(home, '../../etc'), path.join(home, 'agents', 'etc'), 'a name never leaves the agents directory');
});

test('the adapter\'s body becomes the event the hook command reads', () => {
  assert.deepEqual(hookEvent('prompt', { session: 's1', prompt: 'hi' }, '/w'), { session_id: 's1', cwd: '/w', prompt: 'hi' });
  assert.deepEqual(hookEvent('tool', { session: 's1', tool: 'search', input: { q: 'x' }, call_id: 'c1', output: 'found' }, '/w'),
    { session_id: 's1', cwd: '/w', tool_name: 'search', tool_input: { q: 'x' }, tool_use_id: 'c1', tool_response: 'found' });
  assert.equal(hookEvent('stop', { session: 's1', answer: 'done' }, '/w').last_assistant_message, 'done');
});

test('what a hook prints becomes the adapter\'s answer', () => {
  assert.deepEqual(hookAnswer('prompt', 'How this team works'), { context: 'How this team works' });
  assert.deepEqual(hookAnswer('prompt', ''), {});
  const denial = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'the report' } });
  assert.deepEqual(hookAnswer('pretool', denial), { decision: 'deny', reason: 'the report' });
  assert.deepEqual(hookAnswer('pretool', 'not json'), {});
  assert.deepEqual(hookAnswer('tool', 'anything'), {});
  // the hook command answers this client in plain text, which is what the routes above expect
  assert.equal(stopOutput('langchain', 'saved 3k'), 'saved 3k');
  assert.equal(toolOutput('langchain', 'x'), 'x');
});

test('the routes: health, the four hooks, and nothing else', async t => {
  const home = tmp(t), ran = [];
  const base = await serve(t, hookService({ cli: CLI, home, version: '9.9.9', run: async (what, ev) => { ran.push([what, ev]); return what === 'prompt' ? 'served text' : ''; } }));
  const health = await (await fetch(`${base}/thinker/health`)).json();
  assert.deepEqual(health, { ok: true, version: '9.9.9', hooks: HOOK_EVENTS });
  assert.deepEqual(await post(base, 'prompt', { session: 's1', name: 'demo', client: 'langchain', prompt: 'hello' }), { status: 200, body: { context: 'served text' } });
  assert.equal(ran[0][0], 'prompt');
  assert.equal(ran[0][1].cwd, path.join(home, 'agents', 'demo'), 'the hook runs in the agent\'s own checkout');
  assert.equal((await post(base, 'tool', { session: 's1', tool: 'search', output: 'x' })).status, 200);
  assert.equal((await post(base, 'prompt', { prompt: 'no session' })).status, 400);
  assert.equal((await post(base, 'install', { session: 's1' })).status, 404);
  assert.equal((await fetch(`${base}/thinker/hook/prompt`)).status, 404, 'a hook is a POST');
});

test('a hook that throws never fails the agent', async t => {
  const base = await serve(t, hookService({ cli: CLI, home: tmp(t), run: async () => { throw new Error('boom'); } }));
  assert.deepEqual(await post(base, 'stop', { session: 's1', answer: 'x' }), { status: 200, body: {} });
});

test('behind the routes is the real hook command: a run is recorded in the agent\'s checkout with no transcript', async t => {
  const home = tmp(t);
  // the hook command is a child process: it inherits this, as every child of a test must (AGENTS.md)
  const saved = { ...process.env };
  Object.assign(process.env, { THINKER_TEST: '1', THINKER_HOME: home, THINKER_LOG: 'local' });
  t.after(() => { for (const k of ['THINKER_TEST', 'THINKER_HOME', 'THINKER_LOG']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  const base = await serve(t, hookService({ cli: CLI, home }));
  const session = 'lc-run-1', common = { session, name: 'demo', client: 'langchain' };
  assert.equal((await post(base, 'prompt', { ...common, prompt: 'Find the cheapest kettle.' })).status, 200);
  assert.deepEqual((await post(base, 'pretool', { ...common, tool: 'browser_navigate', input: { url: 'http://x' }, call_id: 'c1' })).body, {}, 'no rule fires for this tool: the call goes through');
  assert.equal((await post(base, 'tool', { ...common, tool: 'browser_navigate', input: { url: 'http://x' }, call_id: 'c1', output: 'Page: kettles' })).status, 200);
  assert.equal((await post(base, 'stop', { ...common, answer: 'The Northgate kettle.' })).status, 200);
  const repo = path.join(home, 'agents', 'demo');
  const trace = fs.readFileSync(path.join(repo, '.thinker', 'state', `trace-${session}.jsonl`), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(trace.map(e => e.t), ['prompt', 'tool', 'say']);
  assert.equal(trace[0].text, 'Find the cheapest kettle.');
  assert.equal(trace[1].name, 'browser_navigate');
  assert.equal(trace[2].text, 'The Northgate kettle.');
  // and the prompt was logged as a request by this client, as any agent's is
  const log = fs.readFileSync(path.join(repo, '.thinker', 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const request = log.find(r => r.op === 'request');
  assert.equal(request.client, 'langchain');
  assert.equal(request.session, session);
});

test('the proxy serves the hooks on its own port and forwards nothing under /thinker/', async t => {
  const home = tmp(t);
  let forwarded = 0;
  const upstream = http.createServer((req, res) => { forwarded++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  t.after(() => upstream.close());
  const proxy = await new Promise(resolve => {
    const s = startProxy({ ...PROXY_DEFAULTS, upstream: `http://127.0.0.1:${upstream.address().port}`, port: 0 }, {
      logFile: path.join(home, 'proxy.jsonl'), routes: false,
      hooks: hookService({ cli: CLI, home, version: 't', run: async () => '' }),
      onListen: a => resolve({ s, base: `http://127.0.0.1:${a.port}` }),
    });
  });
  t.after(() => proxy.s.close());
  assert.equal((await (await fetch(`${proxy.base}/thinker/health`)).json()).ok, true);
  assert.equal((await post(proxy.base, 'stop', { session: 's', answer: 'x' })).status, 200);
  assert.equal(forwarded, 0);
  // without the option the proxy is as it was: the path goes upstream like any other
  const plain = await new Promise(resolve => { const s = startProxy({ ...PROXY_DEFAULTS, upstream: `http://127.0.0.1:${upstream.address().port}`, port: 0 }, { logFile: path.join(home, 'p2.jsonl'), routes: false, onListen: a => resolve({ s, base: `http://127.0.0.1:${a.port}` }) }); });
  t.after(() => plain.s.close());
  await fetch(`${plain.base}/thinker/health`);
  assert.equal(forwarded, 1);
});
