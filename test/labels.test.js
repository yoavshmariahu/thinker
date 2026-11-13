import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { LABEL_LIMITS, parseLabels, normalizeLabels, readLabels, labelBlock } from '../src/labels.js';
import { buildTelemetryPayload } from '../src/telemetry.js';
import { Store } from '../src/store.js';

const removeTree = d => fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-labels-home-'));
const writeConfig = (home, cfg) => {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg));
};

test('parseLabels reads JSON objects and k=v pairs, and never throws on rubbish', () => {
  assert.deepEqual(parseLabels('{"tenant":"acme"}'), { tenant: 'acme' });
  assert.deepEqual(parseLabels('tenant=acme,harness=orbit'), { tenant: 'acme', harness: 'orbit' });
  // a value may hold an `=`; the first one splits
  assert.deepEqual(parseLabels('token=a=b'), { token: 'a=b' });
  // malformed is empty, not an error: a hook may not fail a tool call over a label
  assert.deepEqual(parseLabels('{"tenant":'), {});
  assert.deepEqual(parseLabels('["acme"]'), {});
  assert.deepEqual(parseLabels(''), {});
  assert.deepEqual(parseLabels(undefined), {});
  assert.deepEqual(parseLabels(null), {});
});

test('normalizeLabels keeps names a dashboard can group by and drops the rest', () => {
  assert.deepEqual(normalizeLabels({ tenant: 'acme', job: 42, canary: true }),
    { canary: 'true', job: '42', tenant: 'acme' }, 'numbers and booleans are written out, keys sorted');
  // a label is one line
  assert.deepEqual(normalizeLabels({ note: 'two\nlines  here' }), { note: 'two lines here' });
  // not names
  assert.deepEqual(normalizeLabels({ 'has space': 'x', 'quote"': 'y', '': 'z', '.leading': 'w' }), {});
  // nothing structured, nothing empty
  assert.deepEqual(normalizeLabels({ nested: { a: 1 }, list: [1], empty: '', nil: null }), {});
  // too long is dropped, never truncated into something that reads like another value
  assert.deepEqual(normalizeLabels({ tenant: 'a'.repeat(LABEL_LIMITS.value + 1) }), {});
  assert.deepEqual(normalizeLabels({ ['k'.repeat(LABEL_LIMITS.key + 1)]: 'v' }), {});
  // the cap is a count, and the keys that survive are the first in sorted order
  const many = Object.fromEntries(Array.from({ length: LABEL_LIMITS.keys + 4 }, (_, i) => [`k${i}`, 'v']));
  assert.equal(Object.keys(normalizeLabels(many)).length, LABEL_LIMITS.keys);
});

test('readLabels merges the environment over the machine config, per key', () => {
  const home = tmpHome();
  try {
    writeConfig(home, { labels: { tenant: 'acme', harness: 'orbit-1' } });
    assert.deepEqual(readLabels({ home, env: {} }), { harness: 'orbit-1', tenant: 'acme' });
    assert.deepEqual(readLabels({ home, env: { THINKER_LABELS: 'harness=orbit-2,job=17' } }),
      { harness: 'orbit-2', job: '17', tenant: 'acme' }, 'the container overrides the image, key by key');
    // a config that is not a label set leaves no labels and no error
    writeConfig(home, { labels: 'nonsense' });
    assert.deepEqual(readLabels({ home, env: {} }), {});
    writeConfig(home, {});
    assert.deepEqual(readLabels({ home, env: {} }), {}, 'no labels is the normal case');
  } finally { removeTree(home); }
});

test('labelBlock adds a key only where a label is set', () => {
  const home = tmpHome();
  try {
    writeConfig(home, {});
    assert.deepEqual(labelBlock({ home, env: {} }), {}, 'a session row on an unlabelled machine is unchanged');
    assert.deepEqual(labelBlock({ home, env: { THINKER_LABELS: 'tenant=acme' } }), { labels: { tenant: 'acme' } });
  } finally { removeTree(home); }
});

test('the telemetry payload always carries a labels block, empty where none is set', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-labels-repo-'));
  const home = tmpHome();
  const before = process.env.THINKER_LABELS;
  try {
    const store = new Store(repo).init();

    delete process.env.THINKER_LABELS;
    writeConfig(home, {});
    // empty says "no label set"; absent would say "too old to carry one", and a fleet must tell them apart
    assert.deepEqual(buildTelemetryPayload(store, { home, days: 1, all: false }).labels, {});

    process.env.THINKER_LABELS = '{"tenant":"acme","harness":"orbit"}';
    const payload = buildTelemetryPayload(store, { home, days: 1, all: false });
    assert.deepEqual(payload.labels, { harness: 'orbit', tenant: 'acme' });
    // and they survive the trip a report actually makes
    assert.deepEqual(JSON.parse(JSON.stringify(payload)).labels, { harness: 'orbit', tenant: 'acme' });
  } finally {
    if (before === undefined) delete process.env.THINKER_LABELS; else process.env.THINKER_LABELS = before;
    removeTree(repo);
    removeTree(home);
  }
});
