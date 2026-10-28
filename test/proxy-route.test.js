import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { routeEvidence, shellRoute, envRoute, foreignAuth, cloudOn, BASE_URL_VAR } from '../src/proxy-route.js';
import { authWatch, forwardsToAnthropic, AUTH_REFUSALS } from '../src/proxy.js';

const OURS = 'http://127.0.0.1:6901';
const isOwn = u => String(u).replace(/\/+$/, '') === OURS;

// a home to scan: THINKER_ROUTE_HOME is what lets the scan read it in test mode, CLAUDE_CONFIG_DIR the
// settings directory
function fakeHome(files = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-route-'));
  for (const [rel, text] of Object.entries(files)) {
    const f = path.join(home, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  return { home, env: { THINKER_ROUTE_HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') }, rm: () => fs.rmSync(home, { recursive: true, force: true }) };
}

test('a route exported by the shell is found, thinker\'s own URL is not a route', () => {
  const m = fakeHome({ '.zshrc': `# ${BASE_URL_VAR}=https://commented.out\nexport ANTHROPIC_AUTH_TOKEN=gw-token\nexport ${BASE_URL_VAR}="https://gw.corp/v1"\n` });
  try {
    const found = routeEvidence({ env: m.env, isOwn });
    assert.equal(found.length, 1);
    assert.equal(found[0].where, '~/.zshrc');
    assert.match(found[0].what, /ANTHROPIC_BASE_URL is set to https:\/\/gw\.corp\/v1/);
  } finally { m.rm(); }
  const ours = fakeHome({ '.zshrc': `export ${BASE_URL_VAR}=${OURS}\n` });
  try { assert.deepEqual(routeEvidence({ env: ours.env, isOwn }), [], 'the proxy\'s own URL is no evidence of anything'); } finally { ours.rm(); }
});

test('a wrapper or an alias around claude counts, a comment and an unrelated line do not', () => {
  assert.match(shellRoute('claude() { ANTHROPIC_BASE_URL=https://router.internal command claude "$@"; }', { isOwn }), /https:\/\/router\.internal/);
  assert.match(shellRoute('export CLAUDE_CODE_USE_BEDROCK=1', { isOwn }), /CLAUDE_CODE_USE_BEDROCK is set/);
  assert.equal(shellRoute('  # export ANTHROPIC_BASE_URL=https://gw.corp', { isOwn }), null);
  assert.equal(shellRoute('export EDITOR=vim\nalias gs="git status"', { isOwn }), null);
  assert.equal(shellRoute(`export ANTHROPIC_BASE_URL=${OURS}`, { isOwn }), null, 'ours');
});

test('the user\'s settings.local.json and a project\'s own settings are read too', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-route-repo-'));
  const m = fakeHome({ '.claude/settings.local.json': JSON.stringify({ env: { [BASE_URL_VAR]: 'https://local.gw' } }) });
  try {
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), JSON.stringify({ env: { [BASE_URL_VAR]: 'https://project.gw' } }));
    const found = routeEvidence({ env: m.env, isOwn, repos: [repo] });
    assert.deepEqual(found.map(f => f.what), ['ANTHROPIC_BASE_URL is https://project.gw', 'ANTHROPIC_BASE_URL is https://local.gw'], 'the files that outrank thinker\'s first');
  } finally { m.rm(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test('nothing outside the test\'s own directories is read in test mode', () => {
  assert.deepEqual(routeEvidence({ env: {}, isOwn }), [], 'no THINKER_ROUTE_HOME: the real home is left alone');
});

test('an env block: a cloud route, a URL, and what is off', () => {
  assert.equal(envRoute({ [BASE_URL_VAR]: OURS }, { isOwn }), null);
  assert.match(envRoute({ [BASE_URL_VAR]: 'https://gw.corp' }, { isOwn }), /is https:\/\/gw\.corp/);
  assert.match(envRoute({ CLAUDE_CODE_USE_VERTEX: '1' }, { isOwn }), /vertex/);
  assert.equal(envRoute({ CLAUDE_CODE_USE_VERTEX: '0' }, { isOwn }), null);
  assert.equal(envRoute(null, { isOwn }), null);
  assert.equal(cloudOn(''), false);
});

test('credentials that are not Anthropic\'s', () => {
  assert.equal(foreignAuth({ 'x-api-key': 'sk-ant-api03-xxx' }), false);
  assert.equal(foreignAuth({ authorization: 'Bearer sk-ant-oat01-xxx' }), false);
  assert.equal(foreignAuth({ authorization: 'Bearer eyJhbGciOi.gateway.token' }), true);
  assert.equal(foreignAuth({ 'x-api-key': 'gw_live_123' }), true);
  assert.equal(foreignAuth({ authorization: 'Bearer gw_live_123', 'x-api-key': 'sk-ant-api03-xxx' }), false, 'one of Anthropic\'s is enough');
  assert.equal(foreignAuth({}), false, 'no credentials says nothing');
});

test('the proxy only doubts credentials it forwards to Anthropic', () => {
  assert.equal(forwardsToAnthropic('https://api.anthropic.com'), true);
  assert.equal(forwardsToAnthropic('http://127.0.0.1:4000'), false);
  assert.equal(forwardsToAnthropic('https://gw.corp/anthropic'), false);
  assert.equal(forwardsToAnthropic('not a url'), false);
});

test('the watch stands the proxy down once: foreign credentials at once, refusals after three in a row', () => {
  const seen = [];
  const foreign = authWatch(r => seen.push(r));
  foreign.request({ authorization: 'Bearer gw_live_123' });
  foreign.request({ authorization: 'Bearer gw_live_123' });
  assert.equal(seen.length, 1, 'once, whatever follows');
  assert.match(seen[0], /not Anthropic's/);

  const refused = [];
  const w = authWatch(r => refused.push(r));
  for (let i = 0; i < AUTH_REFUSALS - 1; i++) w.response(401);
  assert.deepEqual(refused, [], 'a token that just expired, or one bad request, is not a routed harness');
  w.response(200);
  for (let i = 0; i < AUTH_REFUSALS - 1; i++) w.response(401);
  assert.deepEqual(refused, [], 'an answer in between starts the count again');
  w.response(403);
  assert.equal(refused.length, 1);
  assert.match(refused[0], /refused the agent's credentials on 3 requests running \(HTTP 403\)/);
  assert.equal(w.stoodDown, true);

  const off = authWatch(() => assert.fail('nothing to stand down'), { on: false });
  off.request({ authorization: 'Bearer gw_live_123' });
  for (let i = 0; i < 5; i++) off.response(401);
});
