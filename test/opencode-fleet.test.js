// What the fleet e2e (demo/e2e) found on its first container run, held so it cannot come back. Every
// test here is a thing that was silently broken for an agent that is not Claude Code: a route the cut
// could never see, a session nobody attributed, a session event that never shipped, and a session with
// no figures on it. The run is in the PR; these are the four facts it rests on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { startProxy, PROXY_DEFAULTS } from '../src/proxy.js';
import { sessionsOf } from '../src/delivery.js';
import { usageBySession } from '../src/compression.js';
import { wireAgents, isOwnUrl, urlFor } from '../src/proxy-service.js';

const at = n => new Date(Date.now() - n * 36e5).toISOString();

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-opencode-fleet-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The proxy's own rows, as it writes them: `input` is the API's fresh input_tokens, with the cache
// halves beside it, which is not the shape `prices.js:costOf` takes.
function proxyRows(dir, rows) {
  const f = path.join(dir, 'state', 'proxy.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, rows.map(r => JSON.stringify({ op: 'proxy', status: 200, ...r })).join('\n') + '\n');
  return f;
}

test('OpenCode is pointed at the proxy with the /v1 its SDK posts `messages` to, and thinker still knows that route as its own', t => {
  const dir = home(t);
  const cfgDir = path.join(dir, 'config');
  const env = { XDG_CONFIG_HOME: cfgDir };
  const f = path.join(cfgDir, 'opencode', 'opencode.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ model: 'anthropic/claude-sonnet-5-5' }));
  // the service state names the port, which is what `isOwnUrl` compares against
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state', 'proxy-service.json'), JSON.stringify({ enabled: true, port: 4020, ports: [4020] }));
  const old = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = cfgDir;
  t.after(() => { if (old === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = old; });

  wireAgents(urlFor(4020), { home: dir, env, agents: ['opencode'] });
  const wired = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(wired.provider.anthropic.options.baseURL, 'http://127.0.0.1:4020/v1',
    'the Vercel AI SDK posts `${baseURL}/messages`, and the proxy only cuts /v1/messages: without the suffix every OpenCode request went through untouched');
  assert.equal(wired.model, 'anthropic/claude-sonnet-5-5', 'the rest of the person\'s config is left alone');

  assert.equal(isOwnUrl('http://127.0.0.1:4020/v1', dir), true, 'thinker has to know that URL as its own, or it reads its own route as somebody else\'s');
  assert.equal(isOwnUrl('http://127.0.0.1:4020', dir), true);
  assert.equal(isOwnUrl('http://127.0.0.1:4020/openrouter/v1', dir), true);
  assert.equal(isOwnUrl('https://api.anthropic.com/v1', dir), false, 'and somebody else\'s as theirs');

  // and taking it off puts the file back
  wireAgents(null, { home: dir, env, agents: ['opencode'] });
  const off = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(off.provider?.anthropic?.options?.baseURL, undefined, 'off removes the route it wrote');
});

test('a session with no transcript of its own is priced from the proxy\'s rows for that session', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-opencode-prs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir).init();
  const h = path.join(dir, 'home');
  // An OpenCode session: the Stop hook has only thinker's own trace to read, which carries no usage,
  // so the row names the client and nothing else. This is every agent that keeps no transcript.
  store.log({ op: 'session', t: at(2), session: 'ses_oc1', client: 'opencode' });
  proxyRows(h, [
    { at: at(2), session: 'ses_oc1', model: 'claude-sonnet-5-5', input: 1000, read: 4000, write: 500, out: 100 },
    { at: at(2), session: 'ses_oc1', model: 'claude-sonnet-5-5', input: 2000, read: 8000, write: 0, out: 200 },
    { at: at(2), session: 'ses_oc1', model: 'claude-sonnet-5-5', status: 500, input: 9, read: 9, write: 9, out: 9 },
  ]);

  const u = usageBySession(path.join(h, 'state', 'proxy.jsonl'), {});
  assert.deepEqual(u.get('ses_oc1').usage, { input: 15500, cacheRead: 12000, cacheWrite: 500, cacheWrite1h: 0, output: 300 },
    'the whole input, with the cache halves kept beside it the way costOf takes them');
  assert.equal(u.get('ses_oc1').calls, 2, 'an answer that was not an answer is not a call');

  const x = sessionsOf(store, { home: h }).get('ses_oc1');
  assert.equal(x.usageFrom, 'proxy');
  assert.equal(x.servedCalls, 2, 'how many answers the proxy saw, so a partial route is visible');
  assert.equal(x.prompts, 2);
  assert.equal(x.tokens, 15800, 'input and output, as the transcript path reports them');
  assert.ok(x.cost.spend > 0, 'and it has a cost, where before it had none at all');
  assert.equal(x.model, 'claude-sonnet-5-5', 'the model off the proxy\'s own rows');
});

test('a transcript always wins over the proxy, so nothing is counted twice', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-opencode-prs2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir).init();
  const h = path.join(dir, 'home');
  store.log({ op: 'session', t: at(2), session: 'sClaude', client: 'claude', model: 'claude-opus-5', turns: 7, totalTokens: 50_000, tokenCoverage: 'complete', inputTokens: 40_000, outputTokens: 10_000 });
  proxyRows(h, [{ at: at(2), session: 'sClaude', model: 'claude-opus-5', input: 1, read: 1, write: 1, out: 1 }]);
  const x = sessionsOf(store, { home: h }).get('sClaude');
  assert.equal(x.ownTokens, 50_000, 'the agent\'s own account of the session stands');
  assert.equal(x.usageFrom, undefined);
  assert.equal(x.prompts, 7);
});


// ---------------------------------------------------------------------------------------------------
// The proxy attributes a request to a session by the client's own header. OpenCode sends four of them.
const SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":30,"cache_read_input_tokens":900,"cache_creation_input_tokens":20,"output_tokens":1}}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

test('the proxy knows whose session a request is, for a client that is not Claude Code', async t => {
  const up = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const e of SSE) res.write(e);
      res.end();
    });
  });
  await new Promise(r => up.listen(0, '127.0.0.1', r));
  t.after(() => up.close());
  const logFile = path.join(home(t), 'proxy.jsonl');
  const px = await new Promise(r => {
    const s = startProxy({ ...PROXY_DEFAULTS, upstream: `http://127.0.0.1:${up.address().port}` }, { logFile, onListen: a => r({ server: s, port: a.port }) });
  });
  t.after(() => px.server.close());

  const send = headers => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: px.port, path: '/v1/messages?beta=true', method: 'POST',
      headers: { 'content-type': 'application/json', ...headers } }, res => { res.resume(); res.on('end', resolve); });
    req.on('error', reject);
    req.end(JSON.stringify({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'hi' }], stream: true }));
  });

  // what OpenCode 2.3.0 actually sends, checked live in demo/e2e
  await send({ 'x-opencode-session': 'ses_abc', 'x-opencode-session-id': 'ses_abc', 'x-session-id': 'ses_abc', 'x-session-affinity': 'ses_abc' });
  await send({ 'x-claude-code-session-id': 'cc-1', 'x-session-id': 'ses_other' });
  await send({});
  const rows = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.op === 'proxy');
  assert.deepEqual(rows.map(r => r.session), ['ses_abc', 'cc-1', null],
    'OpenCode\'s own id, Claude Code\'s in preference to a generic one, and nothing invented where no client said');
  assert.ok(rows[0].input >= 30 && rows[0].read === 900, 'and the usage is on the row, which is what makes the session priceable');
});

// ---------------------------------------------------------------------------------------------------
// The Stop hook records the session from whatever account of it exists. Claude Code has a transcript;
// the others have the trace thinker's own hooks wrote.
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('a client with no transcript still gets a session row, read from thinker\'s own trace', t => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-oc-stop-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', d]);
  const store = new Store(d).init();
  const h = path.join(d, 'home');
  fs.mkdirSync(path.join(h, 'state'), { recursive: true });
  // the trace the hooks write for an agent that keeps no transcript (transcripts.js:traceFile)
  const trace = path.join(store.dir, 'state', 'trace-ses_oc9.jsonl');
  fs.mkdirSync(path.dirname(trace), { recursive: true });
  fs.writeFileSync(trace, [
    JSON.stringify({ t: 'prompt', text: 'read the modules under src/', at: at(2) }),
    JSON.stringify({ t: 'tool', name: 'Read', input: { path: 'src/a.py' }, result: 'x'.repeat(2000) }),
    JSON.stringify({ t: 'say', text: 'they are queue handlers' }),
  ].join('\n') + '\n');
  const env = { ...process.env, HOME: d, THINKER_HOME: h, THINKER_TEST: '1', THINKER_HOOKS: 'on', THINKER_TELEMETRY: 'off',
    THINKER_LOG: 'local', THINKER_NO_LEARN: '1', THINKER_NO_BG_VERIFY: '1', THINKER_HOLDOUT: 'off', THINKER_CE: 'off' };
  execFileSync('node', [CLI, 'hook', 'stop', '--client', 'opencode', '--repo', d],
    { input: JSON.stringify({ session_id: 'ses_oc9', cwd: d, hook_event_name: 'SessionEnd' }), encoding: 'utf8', env });

  const rows = fs.readFileSync(path.join(store.dir, 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.op === 'session');
  assert.equal(rows.length, 1, 'one session row, where before there was none and so no event could ship');
  assert.equal(rows[0].session, 'ses_oc9');
  assert.equal(rows[0].client, 'opencode');
});
