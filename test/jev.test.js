// Jev serving reranker. Every call here uses a fake fetch: no test ever contacts the API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ACCESS_MODES, accessFile, jevAccess, jevAsked, recordAccess, JEV_DEFAULTS, buildRequest, forgetKey, jevConfig, jevKey, jevRerank, jevScores, jevStatus, keyFile, hostedCredential, proxyFile, noteRecord, saveKey, selectByJev, testNetworkAllowed, jevEvaluate } from '../src/jev.js';

const note = (id, over = {}) => ({ id, kind: 'rule', title: `t ${id}`, answers: [`q ${id}`], body: `line one about ${id}\nline two`, deps: [{ path: 'src/a.js', symbol: 'f' }], status: 'fresh', ...over });
const withHome = async fn => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-')); const prev = process.env.THINKER_HOME; process.env.THINKER_HOME = dir;
  const keep = { k: process.env.THINKER_JEV_KEY, j: process.env.JEV_API_KEY, t: process.env.TYPESAFE_API_KEY };
  delete process.env.THINKER_JEV_KEY; delete process.env.JEV_API_KEY; delete process.env.TYPESAFE_API_KEY;
  try { return await fn(dir); } finally { prev === undefined ? delete process.env.THINKER_HOME : (process.env.THINKER_HOME = prev);
    for (const [k, v] of [['THINKER_JEV_KEY', keep.k], ['JEV_API_KEY', keep.j], ['TYPESAFE_API_KEY', keep.t]]) v === undefined ? delete process.env[k] : (process.env[k] = v);
    fs.rmSync(dir, { recursive: true, force: true }); } };
const okFetch = scores => async () => ({ ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', answers: Object.fromEntries(scores.map((s, i) => [`rel${i}`, { type: 'noul', noul: s }])), usage: { input_tokens: 10, output_tokens: 0 } }) });

test('selectByJev keeps those at or above the floor, best first, at most maxNotes', () => {
  const rows = [{ id: 'a', jev: 0.9 }, { id: 'b', jev: 0.4 }, { id: 'c', jev: 0.7 }];
  assert.deepEqual(selectByJev(rows, { floor: 0.5, maxNotes: 2 }).map(r => r.id), ['a', 'c']);
  assert.deepEqual(selectByJev(rows, { floor: 0.5, maxNotes: 1 }).map(r => r.id), ['a']);
});

test('selectByJev serves nothing when nothing clears the floor (no fallback, unlike the cross-encoder)', () => {
  assert.deepEqual(selectByJev([{ id: 'a', jev: 0.2 }, { id: 'b', jev: 0.1 }], { floor: 0.5 }), []);
});

test('noteRecord gives Jev named fields, not a prose blob', () => {
  const r = noteRecord(note('n1', { status: 'stale' }), 3);
  assert.equal(r.index, 3);
  assert.equal(r.kind, 'rule');
  assert.equal(r.freshness, 'stale');
  assert.deepEqual(r.code_it_points_at, ['src/a.js:f']);
  assert.deepEqual(r.answers_the_questions, ['q n1']);
  assert.ok(r.claim.includes('line one'));
});

test('buildRequest asks one noul per candidate, keyed by index', () => {
  const b = buildRequest('do a thing', [note('a'), note('b')]);
  assert.equal(b.model, JEV_DEFAULTS.model);
  assert.deepEqual(Object.keys(b.questions), ['rel0', 'rel1']);
  assert.equal(b.questions.rel0.type, 'noul');
  assert.equal(b.questions.rel0.instructions.request, 'do a thing');
  assert.equal(b.state.developer_request, 'do a thing');
  assert.equal(b.state.candidate_notes.length, 2);
});

test('jevScores returns one probability per note, in order', async () => {
  const s = await jevScores('q', [note('a'), note('b')], { key: 'k', fetchImpl: okFetch([0.8, 0.2]) });
  assert.deepEqual(s, [0.8, 0.2]);
});

test('jevScores throws on a failed call, an empty body, or a missing answer, so serving falls back', async () => {
  await assert.rejects(jevScores('q', [note('a')], { key: 'k', fetchImpl: async () => ({ ok: false, status: 429 }) }), /jev 429/);
  await assert.rejects(jevScores('q', [note('a')], { key: 'k', fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }), /missing answers/);
  await assert.rejects(jevScores('q', [note('a'), note('b')], { key: 'k', fetchImpl: okFetch([0.8]) }), /missing or invalid rel1/);
  await assert.rejects(jevScores('q', [note('a')], { key: null }), /network disabled in tests/);
});

test('jevRerank scores only the first k and returns the selection', async () => {
  let seen = 0;
  const fetchImpl = async (_u, o) => { seen = JSON.parse(o.body).state.candidate_notes.length; return (await okFetch([0.9, 0.6, 0.1])()); };
  const ranked = [note('a'), note('b'), note('c'), note('d')].map(n => ({ note: n }));
  const out = await jevRerank(ranked, 'q', { key: 'k', k: 3, floor: 0.5, maxNotes: 2, fetchImpl });
  assert.equal(seen, 3);
  assert.deepEqual(out.map(r => r.note.id), ['a', 'b']);
  assert.equal(out[0].jev, 0.9);
});

test('a key round-trips through the thinker home and is owner-readable only', () => withHome(() => {
  assert.equal(jevKey(), null);
  const where = saveKey('  secret-key  ');
  assert.equal(jevKey(), 'secret-key');
  assert.equal(where, keyFile());
  if (process.platform !== 'win32') assert.equal(fs.statSync(where).mode & 0o777, 0o600);
  assert.equal(forgetKey(), true);
  assert.equal(jevKey(), null);
}));

test('the key is never written into the repository', () => withHome(dir => {
  assert.ok(saveKey('k').startsWith(dir), 'key must live under THINKER_HOME');
}));

test('auto selects hosted or direct credentials but never enables model calls implicitly in tests', () => withHome(() => {
  const store = { config: () => ({}) };
  assert.equal(jevConfig(store).enabled, false);
  assert.equal(jevStatus(store).mode, 'hosted');
  saveKey('k');
  assert.equal(jevConfig(store).enabled, false);
  assert.equal(jevStatus(store).key, true);
}));

test('config and environment override the defaults', () => withHome(() => {
  assert.equal(jevConfig({ config: () => ({ jev: false }) }).enabled, false);
  saveKey('k');
  assert.equal(jevConfig({ config: () => ({ jev: { floor: 0.9, maxNotes: 1 } }) }).floor, 0.9);
  process.env.THINKER_JEV = 'off';
  assert.equal(jevConfig({ config: () => ({}) }).enabled, false);
  process.env.THINKER_JEV = 'on';
  process.env.THINKER_JEV_FLOOR = '0.25';
  process.env.THINKER_JEV_MAX = '3';
  const c = jevConfig({ config: () => ({}) });
  assert.equal(c.enabled, true); assert.equal(c.floor, 0.25); assert.equal(c.maxNotes, 3);
  delete process.env.THINKER_JEV; delete process.env.THINKER_JEV_FLOOR; delete process.env.THINKER_JEV_MAX;
}));

test('an environment key is preferred over the file and reported as such', () => withHome(() => {
  saveKey('from-file');
  process.env.THINKER_JEV_KEY = 'from-env';
  assert.equal(jevKey(), 'from-env');
  assert.equal(jevStatus({ config: () => ({}) }).source, 'environment');
  delete process.env.THINKER_JEV_KEY;
}));

test('jevRerank reports every candidate score through onScores, not just the selected ones', async () => {
  const seen = [];
  const ranked = [note('a'), note('b'), note('c')].map(n => ({ note: n }));
  const out = await jevRerank(ranked, 'q', { key: 'k', floor: 0.5, maxNotes: 2, fetchImpl: okFetch([0.9, 0.1, 0.6]), onScores: rows => seen.push(...rows.map(r => r.jev)) });
  assert.deepEqual(seen, [0.9, 0.1, 0.6], 'every candidate is reported');
  assert.deepEqual(out.map(r => r.note.id), ['a', 'c'], 'only those above the floor are served');
});

test('a key on the machine never switches Jev on inside the test suite', () => withHome(() => {
  saveKey('k');
  const store = { config: () => ({}) };
  process.env.THINKER_TEST = '1';
  assert.equal(jevConfig(store).enabled, false, 'auto must stay off under THINKER_TEST');
  assert.equal(jevConfig({ config: () => ({ jev: { enabled: true } }) }).enabled, true, 'an explicit opt-in still wins');
  process.env.THINKER_JEV = 'on';
  assert.equal(jevConfig(store).enabled, true, 'THINKER_JEV=on still wins');
  delete process.env.THINKER_JEV;
}));

test('status says when test mode is what turned Jev off, not merely that it is off', () => withHome(() => {
  // A run that ranks with the local fallback looks exactly like one that chose to; the reason is
  // what tells a benchmark it is not measuring the shipped ranker.
  saveKey('k');
  const store = { config: () => ({}) };
  process.env.THINKER_TEST = '1';
  const before = process.env.THINKER_JEV;
  delete process.env.THINKER_JEV;
  try {
    const off = jevStatus(store);
    assert.equal(off.enabled, false);
    assert.equal(off.offForTests, true, 'test mode is the reason and must be reported');
    process.env.THINKER_JEV = 'off';
    assert.equal(jevStatus(store).offForTests, false, 'an explicit off is a choice, not test mode');
    process.env.THINKER_JEV = 'on';
    assert.equal(jevStatus(store).offForTests, false, 'nothing to explain when it is on');
  } finally { before === undefined ? delete process.env.THINKER_JEV : (process.env.THINKER_JEV = before); }
}));

test('test mode opens direct Jev only for an explicit, fully credentialed benchmark run', () => {
  // A benchmark measures the shipped ranker from the agent's own child process, where a transport
  // cannot be injected. One flag opens that path; nothing less does, so an ordinary test or a
  // forgotten variable cannot reach the service.
  const cases = [
    [{}, false, 'nothing set'],
    [{ THINKER_JEV_ALLOW_NETWORK: '1' }, false, 'the flag alone'],
    [{ THINKER_JEV: 'on' }, false, 'Jev on without the flag'],
    [{ THINKER_JEV_ALLOW_NETWORK: '1', THINKER_JEV: 'off' }, false, 'explicitly off'],
    [{ THINKER_JEV_ALLOW_NETWORK: '1', THINKER_JEV: 'on' }, true, 'the flag, Jev on and a key'],
  ];
  for (const [env, want, why] of cases) assert.equal(testNetworkAllowed('k', env), want, why);
  assert.equal(testNetworkAllowed('', { THINKER_JEV_ALLOW_NETWORK: '1', THINKER_JEV: 'on' }), false, 'no key, no network');
});

test('without that flag a real call is refused in tests rather than reaching the API', async () => {
  process.env.THINKER_TEST = '1';
  const before = { allow: process.env.THINKER_JEV_ALLOW_NETWORK, on: process.env.THINKER_JEV };
  delete process.env.THINKER_JEV_ALLOW_NETWORK; delete process.env.THINKER_JEV;
  try {
    await assert.rejects(() => jevEvaluate({ a: 1 }, { rel0: { type: 'noul', question: 'q' } }, { key: 'k' }),
      /jev network disabled in tests/);
  } finally {
    for (const [k, v] of [['THINKER_JEV_ALLOW_NETWORK', before.allow], ['THINKER_JEV', before.on]]) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
});

test('hosted Jev registers once, stores an owner-only token and reuses it', () => withHome(async () => {
  let enrollments = 0, evaluations = 0;
  const token = `tp_${'b'.repeat(64)}`;
  const fetchImpl = async (url, options) => {
    if (String(url).endsWith('/v1/enroll')) {
      enrollments++; assert.equal(options.body, '{}');
      return { ok: true, json: async () => ({ token, expiresAt: Date.now() / 1000 + 3600 }) };
    }
    evaluations++;
    assert.equal(options.headers.authorization, `Bearer ${token}`);
    return (await okFetch([0.9])());
  };
  assert.deepEqual(await jevScores('q', [note('a')], { key: null, fetchImpl }), [0.9]);
  assert.deepEqual(await jevScores('q', [note('a')], { key: null, fetchImpl }), [0.9]);
  assert.equal(enrollments, 1); assert.equal(evaluations, 2);
  assert.equal(fs.statSync(proxyFile()).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(proxyFile())).token, token);
}));

test('personal keys bypass enrollment and never go to the hosted proxy', () => withHome(async () => {
  await jevScores('q', [note('a')], { key: 'personal-key', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(options.headers.authorization, 'Bearer personal-key');
    return (await okFetch([0.7])());
  } });
  assert.equal(fs.existsSync(proxyFile()), false);
}));

test('invalid registration, revoked tokens and invalid probabilities fail for local fallback', () => withHome(async () => {
  await assert.rejects(hostedCredential({ fetchImpl: async () => ({ ok: true, json: async () => ({ token: 'bad', expiresAt: 1 }) }) }), /invalid jev registration/);
  for (const value of [NaN, Infinity, -0.1, 1.1, '0.5']) {
    await assert.rejects(jevScores('q', [note('a')], { key: 'k', fetchImpl: okFetch([value]) }), /invalid rel0/);
  }
  const token = `tp_${'b'.repeat(64)}`;
  await hostedCredential({ fetchImpl: async () => ({ ok: true, json: async () => ({ token, expiresAt: Date.now() / 1000 + 3600 }) }) });
  let calls = 0;
  await assert.rejects(jevScores('q', [note('a')], { key: null, fetchImpl: async url => {
    calls++; assert.ok(String(url).endsWith('/v1/systemone')); return { ok: false, status: 401 };
  } }), /jev 401/);
  assert.equal(calls, 1, 'revocation must not trigger automatic re-enrollment');
}));

test('a slow response is aborted within the configured budget', async () => {
  let aborted = false;
  await assert.rejects(jevScores('q', [note('a')], { key: 'k', timeoutMs: 15,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
    }),
  }), /aborted/);
  assert.equal(aborted, true);
});

test('hosted credentials cannot be sent to HTTP or a URL containing credentials', () => withHome(async () => {
  for (const endpoint of ['http://example.com/v1/systemone', 'https://user:pass@example.com/v1/systemone']) {
    await assert.rejects(hostedCredential({ endpoint, fetchImpl: async () => { throw new Error('must not fetch'); } }), /invalid jev proxy endpoint/);
  }
}));


test('the access choice round-trips and rejects an unknown mode', () => withHome(() => {
  assert.equal(jevAccess(), null);
  assert.equal(jevAsked(), false);
  for (const m of ACCESS_MODES) { recordAccess(m); assert.equal(jevAccess().mode, m); assert.equal(jevAsked(), true); }
  assert.ok(jevAccess().at, 'records when it was chosen');
  if (process.platform !== 'win32') assert.equal(fs.statSync(accessFile()).mode & 0o777, 0o600);
  assert.throws(() => recordAccess('whatever'), /unknown jev access mode/);
}));

test('saving a key is itself the answer, so nothing asks again', () => withHome(() => {
  assert.equal(jevAsked(), false);
  saveKey('k');
  assert.equal(jevAccess().mode, 'key', 'a saved key records the choice');
  assert.equal(jevAsked(), true);
}));

test('choosing off keeps Jev off, and the config or environment still overrides it', () => withHome(() => {
  const t = process.env.THINKER_TEST; delete process.env.THINKER_TEST;   // resolve as a real machine would
  try {
  recordAccess('off');
  assert.equal(jevConfig({ config: () => ({}) }).enabled, false, 'the choice is honoured');
  assert.equal(jevConfig({ config: () => ({ jev: { enabled: true } }) }).enabled, true, 'the repository config is more specific');
  process.env.THINKER_JEV = 'on';
  assert.equal(jevConfig({ config: () => ({}) }).enabled, true, 'the environment is more specific');
  delete process.env.THINKER_JEV;
  recordAccess('proxy');
  assert.equal(jevConfig({ config: () => ({}) }).enabled, true, 'choosing the proxy leaves it on');
  } finally { t === undefined ? delete process.env.THINKER_TEST : (process.env.THINKER_TEST = t); }
}));

test('a machine that was never asked is reported as such, and keeps the hosted default', () => withHome(() => {
  const t = process.env.THINKER_TEST; delete process.env.THINKER_TEST;   // resolve as a real machine would
  try {
  const st = jevStatus({ config: () => ({}) });
  assert.equal(st.asked, false);
  assert.equal(st.access, null);
  assert.equal(st.mode, 'hosted', 'hosted access is the default until someone picks');
  assert.equal(st.enabled, true);
  } finally { t === undefined ? delete process.env.THINKER_TEST : (process.env.THINKER_TEST = t); }
}));

test('configureJev discloses without recording when there is no terminal, so the next one still asks', async () => await (async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jevcfg-'));
  const prevHome = process.env.THINKER_HOME, prevTest = process.env.THINKER_TEST;
  process.env.THINKER_HOME = home; delete process.env.THINKER_TEST;
  try {
    const { configureJev } = await import('../src/setup/steps.js');
    const lines = [];
    const mode = await configureJev({ store: { config: () => ({}) }, out: l => lines.push(String(l)),
      hostedCredentialFn: async () => ({ token: 'tp_' + 'a'.repeat(64) }), stdin: { isTTY: false } });
    assert.equal(mode, 'hosted');
    assert.equal(jevAsked(), false, 'nothing is recorded without a terminal');
    const said = lines.join('\n');
    assert.match(said, /leave this machine|go to Thinker/i, 'it says what leaves the machine');
    assert.match(said, /--jev-key/, 'and how to use your own key');
  } finally {
    prevHome === undefined ? delete process.env.THINKER_HOME : (process.env.THINKER_HOME = prevHome);
    prevTest === undefined ? delete process.env.THINKER_TEST : (process.env.THINKER_TEST = prevTest);
    fs.rmSync(home, { recursive: true, force: true });
  }
})());
