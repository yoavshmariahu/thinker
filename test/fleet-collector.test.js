// The demo collector's three rules: an event is an upsert, a rate is a ratio of sums, and no dollar is
// made here (demo/collector/server.mjs). Skipped where `node:sqlite` is absent (Node under 22.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';

let openDb, putEvent, fleet, labelKeys, getConfig, setConfig;
let available = true;
try {
  await import('node:sqlite');
  ({ openDb, putEvent, fleet, labelKeys, getConfig, setConfig } = await import('../demo/collector/server.mjs'));
} catch { available = false; }

const at = iso => iso;
const event = (o = {}) => ({
  v: 1, at: at('2026-11-13T08:00:00.000Z'), install: 'i-1', session: 's1',
  labels: { tenant: 'acme' }, client: 'opencode', model: 'claude-opus-5',
  prompts: 10, tokens: 200_000, cleared: 100_000,
  cost: { saved: 0.15, rewrite: 0.02, reread: 0.01, net: 0.12, spend: 4, priced: true },
  ...o,
});

test('an event is an upsert keyed on install and session, and an older one never walks a figure back', { skip: !available && 'node:sqlite unavailable' }, () => {
  const db = openDb(':memory:');
  assert.equal(putEvent(db, event()), 'inserted');
  // the same session again, carrying more: the clearing's figure settles a few turns after the cut
  assert.equal(putEvent(db, event({ at: '2026-11-13T08:30:00.000Z', prompts: 20, cleared: 260_000, cost: { saved: 0.39, rewrite: 0.02, reread: 0.01, net: 0.36, spend: 7, priced: true } })), 'updated');
  // and an event that arrives late but was recorded earlier (a spool draining behind a live session)
  assert.equal(putEvent(db, event({ at: '2026-11-13T07:00:00.000Z', cost: { net: 999, spend: 999, priced: true } })), 'stale');

  const f = fleet(db, { by: 'tenant', days: 3650, now: Date.parse('2026-11-14T00:00:00.000Z') });
  assert.equal(f.rows.length, 1);
  const r = f.rows[0];
  assert.equal(r.sessions, 1, 'three events, one session');
  assert.equal(r.prompts, 20, 'the newest event is the session, never the sum of two');
  assert.equal(r.cleared, 260_000);
  assert.equal(Math.round(r.net * 100), 36, 'not 0.12 + 0.36, and not the stale 999');
});

test('a rate is a ratio of sums, and an unpriced session is counted as a session and in no dollar figure', { skip: !available && 'node:sqlite unavailable' }, () => {
  const db = openDb(':memory:');
  // two sessions of very different length: a mean of per-session rates would read them as equals
  putEvent(db, event({ session: 'a', prompts: 2, cost: { saved: 0, rewrite: 0, reread: 0, net: 0, spend: 1, priced: true } }));
  putEvent(db, event({ session: 'b', prompts: 38, cost: { saved: 0, rewrite: 0, reread: 0, net: 0, spend: 19, priced: true } }));
  putEvent(db, event({ session: 'c', prompts: 10, model: 'someone-elses', cost: { saved: 0, rewrite: 0, reread: 0, net: 0, spend: null, priced: false } }));

  const t = fleet(db, { by: 'tenant', days: 3650, now: Date.parse('2026-11-14T00:00:00.000Z') }).total;
  assert.equal(t.sessions, 3, 'the unpriced session is a session');
  assert.equal(t.spendSessions, 2);
  assert.equal(t.unpricedSessions, 1, 'and it is named');
  assert.equal(t.spend, 20);
  assert.equal(t.spendPerPrompt, 0.5, '20 / 40 priced prompts; the mean of the two rates would be 0.5 and 0.5 -> 0.5');
  assert.equal(t.spendPerSession, 10, '20 / 2 priced sessions, never 3');

  // a fleet with nothing priced has no cost per session: saying $0.00 would be a lie about the data
  const bare = openDb(':memory:');
  putEvent(bare, event({ session: 'x', cost: { saved: 0, rewrite: 0, reread: 0, net: 0, spend: null, priced: false } }));
  const bt = fleet(bare, { by: 'tenant', days: 3650, now: Date.parse('2026-11-14T00:00:00.000Z') }).total;
  assert.equal(bt.spendPerSession, null);
  assert.equal(bt.spendPerPrompt, null);
});

test('the page is offered the dimensions the fleet actually sent', { skip: !available && 'node:sqlite unavailable' }, () => {
  const db = openDb(':memory:');
  putEvent(db, event({ session: 'a', labels: { tenant: 'acme', harness: 'orbit-1' } }));
  putEvent(db, event({ session: 'b', install: 'i-2', labels: { tenant: 'globex', job: '17' } }));
  assert.deepEqual(labelKeys(db), ['harness', 'job', 'tenant']);

  // a session with no labels is grouped as such rather than dropped
  putEvent(db, event({ session: 'c', install: 'i-3', labels: {} }));
  const f = fleet(db, { by: 'tenant', days: 3650, now: Date.parse('2026-11-14T00:00:00.000Z') });
  assert.deepEqual(f.rows.map(r => r.dim).sort(), ['(unlabelled)', 'acme', 'globex']);
  assert.equal(f.total.installs, 3);
});

test('rubbish is rejected, never stored', { skip: !available && 'node:sqlite unavailable' }, () => {
  const db = openDb(':memory:');
  assert.equal(putEvent(db, null), 'rejected');
  assert.equal(putEvent(db, {}), 'rejected');
  assert.equal(putEvent(db, { install: 'i', session: 's' }), 'rejected', 'no timestamp is no event');
  assert.equal(putEvent(db, { install: 'i', session: 's', at: 'not a date' }), 'rejected');
  assert.equal(fleet(db, { by: 'tenant', days: 3650 }).rows.length, 0);
});

test('a setting is a revision, and the machine\'s own word is what says it took', { skip: !available && 'node:sqlite unavailable' }, () => {
  const db = openDb(':memory:');
  assert.deepEqual(getConfig(db, 'i-1'), { install: 'i-1', rev: 0, config: {}, at: null, by: null, seenRev: null, seenAt: null },
    'a machine nobody has set is on its own settings');

  const first = setConfig(db, 'i-1', { proxy: { trigger: 90_000 }, prices: { x: 1 } });
  assert.equal(first.rev, 1);
  assert.equal(first.changed, true);
  assert.deepEqual(first.config, { proxy: { trigger: 90_000 } });
  assert.deepEqual(first.dropped, ['prices'], 'what this build will not set is named, never swallowed');

  // the same settings again are not a new revision: a machine must not be told to re-apply what it runs
  assert.equal(setConfig(db, 'i-1', { proxy: { trigger: 90_000 } }).rev, 1);
  assert.equal(setConfig(db, 'i-1', { proxy: { trigger: 90_000 } }).changed, false);
  assert.equal(setConfig(db, 'i-1', { proxy: { trigger: 80_000 } }).rev, 2);

  // sent, and not yet taken: the page reads the difference, and only an event closes it
  assert.equal(getConfig(db, 'i-1').seenRev, null);
  putEvent(db, event({ session: 'a', managed: { rev: 1 } }));
  assert.equal(getConfig(db, 'i-1').seenRev, 1, 'running one revision behind, which is the truth until it reports again');
  putEvent(db, event({ session: 'b', managed: { rev: 2 } }));
  assert.equal(getConfig(db, 'i-1').seenRev, 2);
  assert.equal(getConfig(db, 'i-1').rev, 2, 'and what a machine says it runs never raises what was set');

  // a machine that reports before anyone sets anything is still only a reader of its own settings
  putEvent(db, event({ install: 'i-2', session: 'c', managed: { rev: 0 } }));
  assert.equal(getConfig(db, 'i-2').rev, 0);
});
