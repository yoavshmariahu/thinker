// Session events: one line a session, out to whatever sink the machine was given (src/events.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { EVENTS, eventsTarget, isTestShipBlocked, sessionEvent, emitSession, decisionsOf } from '../src/events.js';

const ago = ms => new Date(Date.now() - ms).toISOString();

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-events-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir).init();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  return { store, home, dir };
}
const config = (home, cfg) => fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg));

// A session that ended an hour ago, with its counters complete, and a clear behind it.
function session(store, home, { id = 's1', tokens = 300_000, turns = 12, cleared = 120_000 } = {}) {
  store.log({ op: 'session', t: ago(3600_000), session: id, client: 'opencode', model: 'claude-opus-5', turns, totalTokens: tokens, tokenCoverage: 'complete', inputTokens: 280_000, outputTokens: 20_000, cacheReadTokens: 200_000, cacheWriteTokens: 40_000 });
  if (cleared) {
    const dir = path.join(home, 'state', 'compression');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ session: id, saved: cleared, requests: 4, firstAt: ago(7200_000), lastAt: ago(3600_000) }));
  }
  return id;
}

test('eventsTarget reads the environment over the config, and nowhere is the default', t => {
  const { home } = fixture(t);
  assert.equal(eventsTarget({ env: {}, home }), null, 'a machine exports when asked, not by itself');

  config(home, { events: { url: 'http://collector.internal/v1/sessions' } });
  assert.deepEqual(eventsTarget({ env: {}, home }), { kind: 'http', url: 'http://collector.internal/v1/sessions' });
  assert.deepEqual(eventsTarget({ env: { THINKER_EVENTS: 'stdout' }, home }), { kind: 'stdout' }, 'the container overrides the image');
  assert.deepEqual(eventsTarget({ env: { THINKER_EVENTS: 'off' }, home }), null);

  config(home, { events: false });
  assert.equal(eventsTarget({ env: {}, home }), null);

  config(home, {});
  assert.deepEqual(eventsTarget({ env: { THINKER_EVENTS: '/var/log/thinker/sessions.jsonl' }, home }).kind, 'file');
  assert.equal(eventsTarget({ env: { THINKER_EVENTS: 'http://[notaurl' }, home }), null, 'rubbish is no sink, not a crash');
});

test('a test may ship to its own loopback and nowhere else', () => {
  const env = { THINKER_TEST: '1' };
  assert.equal(isTestShipBlocked({ kind: 'http', url: 'http://127.0.0.1:9123/v1/sessions' }, env), false);
  assert.equal(isTestShipBlocked({ kind: 'http', url: 'https://metrics.example.com/v1' }, env), true);
  assert.equal(isTestShipBlocked({ kind: 'stdout' }, env), false, 'a local sink is never a leak');
  assert.equal(isTestShipBlocked({ kind: 'http', url: 'https://metrics.example.com/v1' }, {}), false, 'outside a test nothing is blocked');
});

test('the event carries the session as the one pricing door measured it, and nothing of the repository', t => {
  const { store, home, dir } = fixture(t);
  session(store, home, { id: 's1' });

  const ev = sessionEvent(store, { session: 's1', home, env: { THINKER_LABELS: 'tenant=acme,harness=orbit-1' } });
  assert.ok(ev, 'the session that just ended is there');
  assert.equal(ev.v, EVENTS.schemaVersion);
  assert.equal(ev.session, 's1');
  assert.equal(ev.client, 'opencode');
  assert.equal(ev.model, 'claude-opus-5');
  assert.equal(ev.prompts, 12);
  assert.equal(ev.tokens, 300_000);
  assert.equal(ev.cleared, 120_000);
  assert.deepEqual(ev.labels, { harness: 'orbit-1', tenant: 'acme' }, 'the only part somebody chose');
  assert.ok(ev.install, 'the machine names itself');

  // dollars, and the identity the netted figure is defined by (delivery.js): net = saved - rewrite - reread
  assert.equal(ev.cost.priced, true);
  assert.ok(ev.cost.saved > 0, 'a cleared token saved a cache read');
  assert.equal(ev.cost.net, ev.cost.saved - ev.cost.rewrite - ev.cost.reread);
  assert.ok(ev.cost.spend > 0, 'what the session itself cost, counters being complete');

  // nothing in the line says where the work was
  const line = JSON.stringify(ev);
  assert.equal(line.includes(dir), false, 'no path');
  assert.equal(line.includes('branch'), false, 'no branch');
});

test('an unknown session is no event, and an unpriced model is an event without dollars', t => {
  const { store, home } = fixture(t);
  assert.equal(sessionEvent(store, { session: 'unknown', home }), null);
  assert.equal(sessionEvent(store, { session: 'never-seen', home }), null);

  store.log({ op: 'session', t: ago(3600_000), session: 's2', client: 'opencode', model: 'someone-elses-model', turns: 3, totalTokens: 1000, tokenCoverage: 'complete' });
  const ev = sessionEvent(store, { session: 's2', home });
  assert.equal(ev.cost.priced, false, 'a model with no list price is named, never guessed at');
  assert.equal(ev.cost.spend, null);
});

test('a sink that is down spools the session, and the next one drains it', async t => {
  const { store, home } = fixture(t);
  session(store, home, { id: 's1' });
  const target = { kind: 'http', url: 'http://127.0.0.1:9/v1/sessions' };
  const spool = path.join(home, 'state', 'events-spool.jsonl');

  let refuse = true;
  const sent = [];
  const fetchFn = async (url, opts) => { if (refuse) throw new Error('ECONNREFUSED'); sent.push(opts.body); return { ok: true }; };

  const first = await emitSession(store, { session: 's1', home, env: {}, target, fetchFn });
  assert.equal(first.shipped, 0);
  assert.equal(first.spooled, 1, 'the figure waits rather than being lost');
  assert.equal(fs.readFileSync(spool, 'utf8').trim().split('\n').length, 1);

  refuse = false;
  session(store, home, { id: 's3' });
  const second = await emitSession(store, { session: 's3', home, env: {}, target, fetchFn });
  assert.equal(second.shipped, 2, 'the one that waited goes out beside the new one');
  assert.equal(second.spooled, 0);
  assert.equal(fs.existsSync(spool), false, 'an empty spool is removed, not left as a stub');
  const lines = sent[0].trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines.map(l => l.session), ['s1', 's3'], 'oldest first');
});

test('a sink that refuses the request keeps the line; a 2xx takes it', async t => {
  const { store, home } = fixture(t);
  session(store, home, { id: 's1' });
  const target = { kind: 'http', url: 'http://127.0.0.1:9/v1/sessions' };

  const refused = await emitSession(store, { session: 's1', home, env: {}, target, fetchFn: async () => ({ ok: false, status: 503 }) });
  assert.equal(refused.shipped, 0);
  assert.equal(refused.spooled, 1, 'a 503 is the sink\'s business, not a lost session');

  const taken = await emitSession(store, { session: 's1', home, env: {}, target, fetchFn: async () => ({ ok: true }) });
  assert.equal(taken.shipped, 2, 'the spooled line and this one');
});

test('a file sink is appended as newline JSON, and no sink does nothing at all', async t => {
  const { store, home, dir } = fixture(t);
  session(store, home, { id: 's1' });
  const file = path.join(dir, 'sessions.jsonl');

  await emitSession(store, { session: 's1', home, env: {}, target: { kind: 'file', path: file } });
  await emitSession(store, { session: 's1', home, env: {}, target: { kind: 'file', path: file } });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, 'one line a shipment, appended');
  assert.equal(JSON.parse(lines[0]).session, 's1');

  const none = await emitSession(store, { session: 's1', home, env: {} });
  assert.deepEqual(none, { shipped: 0, skipped: 'no-target' }, 'the default costs a session nothing');
});

test('the per-call series is the session as it ran, thinned but never truncated', t => {
  const { store, home } = fixture(t);
  session(store, home, { id: 's1' });
  // a proxy log of this session: a long climb, one cut near the end
  const log = path.join(home, 'state', 'proxy.jsonl');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const rows = [];
  for (let i = 0; i < 400; i++) {
    const cut = i === 380;
    rows.push(JSON.stringify({
      at: new Date(Date.now() - (400 - i) * 60_000).toISOString(), op: 'proxy', session: 's1',
      model: 'claude-opus-5', status: 200, turn: Math.floor(i / 40) + 1,
      input: 500, read: i * 400, write: cut ? 90_000 : 0, out: 300,
      ...(cut ? { clear: { tokens: 55_000, cold: false }, policy: 'r1-t140k-f60k-p25-deep', cleared: 55_000 } : { reason: i % 3 ? 'mid-turn' : 'below-trigger' }),
    }));
  }
  fs.writeFileSync(log, rows.join('\n') + '\n');

  const d = decisionsOf({ session: 's1', home, env: { THINKER_PROXY_LOG: log } });
  assert.equal(d.calls, 400, 'every call is counted');
  assert.ok(d.series.length <= EVENTS.seriesMax, 'a long session is thinned to fit');
  assert.ok(d.series.length > 50, 'and still has a shape');
  assert.equal(d.series.filter(p => p.cut).length, 1, 'the cut is always kept — it is the thing being shown');
  assert.equal(d.series[d.series.length - 1].c, 400, 'the line ends where the session did');
  assert.equal(d.cuts, 1);
  assert.ok(d.refusals['mid-turn'] > 0 && d.refusals['below-trigger'] > 0, 'and why nothing was cut on the rest');

  // carried is the whole input of the call, and a priced call carries its own cost. Any surviving point
  // will do: thinning drops calls, it never rewrites the ones it keeps.
  const p = d.series.find(x => !x.cut && x.c > 1);
  assert.equal(p.carried, 500 + (p.c - 1) * 400, 'fresh + cache read + cache write');
  assert.ok(p.cost > 0);
});
