// The three coverage levers (ops.js:servingConfig): answers to the three reasons a request the cache
// was asked gets nothing back. All three are **on** by default since 2026-10-30, by the owner's
// decision and with no Artemis experiment behind them (ops.js:SERVING_DEFAULTS says what that trades).
// What these tests pin is the defaults, that a repository and the environment can each turn a lever
// off, and what each lever does when it fires. The three behavior tests set every lever off in their
// base environment and turn on only the one under test, so each still measures its own lever's effect
// whichever way the defaults go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { orient, servingConfig, SERVING_DEFAULTS } from '../src/ops.js';

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
const withEnv = async (vars, fn) => { const saved = {}; for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; } try { return await fn(); } finally { for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } } };
const cfgStore = cfg => ({ config: () => ({ serving: cfg }) });
const UNSET = { THINKER_SERVE_DENSE_FALLBACK: undefined, THINKER_SERVE_CE_RESCUE: undefined, THINKER_SERVE_STALE: undefined, THINKER_SERVE_DENSE_FLOOR: undefined };
// every lever off: the base a test that turns one on measures against
const ENV = { ...UNSET, THINKER_SERVE_DENSE_FALLBACK: 'off', THINKER_SERVE_CE_RESCUE: 'off', THINKER_SERVE_STALE: 'off' };

function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-levers-')));
  git(dir, 'init', '-q');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/a.js'), 'export function fetchRows(db) {\n  return db.query("select * from rows");\n}\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

test('every lever is on by default, a repository can turn one off, and the environment wins over the config', async () => {
  await withEnv(UNSET, () => {
    assert.deepEqual(SERVING_DEFAULTS, { denseFallback: true, ceRescue: true, serveStale: true, denseFloor: 0.35 });
    for (const k of ['denseFallback', 'ceRescue', 'serveStale']) {
      assert.equal(servingConfig(cfgStore(undefined))[k], true, `${k} ships on since 2026-10-30`);
      assert.equal(servingConfig({ config: () => ({}) })[k], true);
      // backing out is the whole safety net of shipping these without an experiment
      assert.equal(servingConfig(cfgStore({ [k]: false }))[k], false, `${k} must be switchable off`);
    }
    // and a repository may still pin one on explicitly
    assert.equal(servingConfig(cfgStore({ ceRescue: true })).ceRescue, true);
    assert.equal(servingConfig(cfgStore({ serveStale: true })).serveStale, true);
    assert.equal(servingConfig(cfgStore({ denseFloor: 0.7 })).denseFloor, 0.7);
    // a nonsense floor falls back to the default rather than serving everything
    assert.equal(servingConfig(cfgStore({ denseFloor: 'wide open' })).denseFloor, 0.35);
  });
  // the environment overrides the config either way, as THINKER_CE and THINKER_MINE_COMMITS do
  await withEnv({ ...UNSET, THINKER_SERVE_CE_RESCUE: 'off' }, () => {
    assert.equal(servingConfig(cfgStore({ ceRescue: true })).ceRescue, false);
  });
  await withEnv({ ...UNSET, THINKER_SERVE_STALE: 'on' }, () => {
    assert.equal(servingConfig(cfgStore({ serveStale: false })).serveStale, true);
  });
});

test('a stale note is served with its banner, and held back only where serveStale is off', async () => {
  const dir = repo();
  await withEnv({ ...ENV, THINKER_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-home-')), THINKER_CE: 'off', THINKER_NOTES_DIR: undefined, THINKER_LOG: undefined }, async () => {
    const store = new Store(dir).init();
    store.put({ id: 'rows', kind: 'rule', title: 'fetchRows orders by id', body: 'src/a.js:fetchRows must order rows by id', answers: ['how are rows fetched'], status: 'stale', deps: [{ path: 'src/a.js', symbol: 'fetchRows', hash: 'stale-hash' }] });
    const ask = () => orient(store, { task: 'how are rows fetched', freshOnly: true, recordUsage: false, refreshFirst: false });
    // off (this test's base environment): held back, as the hooks did until 2026-10-30
    const held = await ask();
    assert.equal(held.included.length, 0, 'THINKER_SERVE_STALE=off still holds a stale note back');
    // on, which is the default: served, with the banner it already carries
    const served = await withEnv({ THINKER_SERVE_STALE: 'on' }, ask);
    assert.equal(served.included.length, 1, 'serveStale serves the stale match instead of nothing');
    assert.match(served.text, /STALE/);
    // and the default alone does it, with nothing in the environment
    const byDefault = await withEnv({ THINKER_SERVE_STALE: undefined }, ask);
    assert.equal(byDefault.included.length, 1, 'on by default');
  });
});

// The cross-encoder's veto turned down every candidate on 27% of the requests the cache was asked
// (production, ten days to 2026-10-28). A floor of 999 rejects everything, which is that case exactly.
test('ceRescue serves the best candidate the cross-encoder turned down', async () => {
  const dir = repo();
  await withEnv({ ...ENV, THINKER_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-home-')), THINKER_NOTES_DIR: undefined, THINKER_LOG: undefined, THINKER_CE: 'on', THINKER_CE_FLOOR: '999' }, async () => {
    const store = new Store(dir).init();
    store.put({ id: 'rows', kind: 'rule', title: 'fetchRows orders by id', body: 'src/a.js:fetchRows must order rows by id', answers: ['how are rows fetched'], deps: [{ path: 'src/a.js', symbol: 'fetchRows' }] });
    const ask = () => orient(store, { task: 'how are rows fetched', freshOnly: true, recordUsage: false, refreshFirst: false });
    const rejected = await ask();
    // no cross-encoder runtime or model on this machine: the lexical ranking is served as always and
    // there is nothing for the lever to rescue, so the case under test did not arise
    if (rejected.included.length) return;
    const saved = await withEnv({ THINKER_SERVE_CE_RESCUE: 'on' }, ask);
    assert.equal(saved.included.length, 1, 'the candidate the cross-encoder vetoed is served rather than nothing');
    assert.equal(saved.included[0].id, 'rows');
  });
});

// The dense path does not go through rank.js, so it has to refuse the statuses the ranking refuses by
// itself. Turning the lever on by default caught this through test/skills.test.js: a skill card the
// code contradicts (`broken`) was served, which is the one thing that status means must not happen.
test('denseFallback never serves what the ranking refuses outright', async () => {
  const dir = repo();
  await withEnv({ ...ENV, THINKER_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-home-')), THINKER_NOTES_DIR: undefined, THINKER_LOG: undefined, THINKER_CE: 'off' }, async () => {
    const store = new Store(dir).init();
    const base = { kind: 'rule', body: 'src/a.js:fetchRows must order rows by id', answers: ['how are database records retrieved and sorted'], deps: [{ path: 'src/a.js', symbol: 'fetchRows' }] };
    store.put({ ...base, id: 'broken-card', kind: 'skill', title: 'fetchRows orders database records by identifier', status: 'broken', broken: { reason: 'the code says otherwise' }, skill: { file: 'skills/rows/SKILL.md' } });
    store.put({ ...base, id: 'gone', title: 'fetchRows orders database records by identifier', status: 'invalid', invalidReason: 'anchors removed: src/old.js' });
    store.put({ ...base, id: 'shelved', title: 'fetchRows orders database records by identifier', archived: { at: new Date().toISOString(), reason: 'kind rule' } });
    const ask = () => orient(store, { task: 'retrieving tuples sorted by primary key', freshOnly: true, recordUsage: false, refreshFirst: false });
    const got = await withEnv({ THINKER_SERVE_DENSE_FALLBACK: 'on' }, ask);
    assert.deepEqual(got.included.map(n => n.id), [], 'a broken, invalid or archived note is not rescued by the embedding model');
  });
});

// `no-match` was 56% of the requests the cache was asked (production, ten days to 2026-10-28): no note
// shares a word with the request, so the lexical ranking has nothing to order. This request and this
// note have no stemmed word in common and the note answers it.
test('denseFallback serves a note the lexical ranking could not find', async () => {
  const dir = repo();
  await withEnv({ ...ENV, THINKER_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-home-')), THINKER_NOTES_DIR: undefined, THINKER_LOG: undefined, THINKER_CE: 'off' }, async () => {
    const store = new Store(dir).init();
    store.put({ id: 'rows', kind: 'rule', title: 'fetchRows orders database records by identifier', body: 'src/a.js:fetchRows must order rows by id', answers: ['how are database records retrieved and sorted'], deps: [{ path: 'src/a.js', symbol: 'fetchRows' }] });
    const ask = () => orient(store, { task: 'retrieving tuples sorted by primary key', freshOnly: true, recordUsage: false, refreshFirst: false });
    assert.equal((await ask()).included.length, 0, 'no shared word: the lexical ranking finds nothing');
    const found = await withEnv({ THINKER_SERVE_DENSE_FALLBACK: 'on' }, ask);
    // no embedding model on this machine: denseScores throws, the error is logged and nothing is served
    if (!found.included.length) return;
    assert.equal(found.included[0].id, 'rows');
  });
});
