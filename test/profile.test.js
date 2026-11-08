import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROFILE, SECTIONS, applyPatch, relatedCited, profileArm, profileTurn, profileArmOf, holdoutReport, exchanges, extractionInput, sessionDirs, tidyObservation, observationTimes, profileModels, completeProfile, appendObservations, readLedger, settle, compileDue, compileProfile, renderProfile, profileBlock, profileSession, readProfile, profileConfig, clean } from '../src/profile.js';
import { distillFile } from '../src/commands/learn.js';
import { Store } from '../src/store.js';

const DAY = 86400_000;
const iso = (now, daysAgo) => new Date(now - daysAgo * DAY).toISOString();
function tmpRepo(t, config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-profile-'));
  execFileSync('git', ['init', '-q', dir]);
  fs.mkdirSync(path.join(dir, '.thinker'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.thinker', 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Working here\n\n## Pull requests\n\nNever push main.\n');
  const store = new Store(dir); store.init();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, store };
}
const session = [
  { t: 'prompt', text: '<thinker-cache>\nnote stuff\n</thinker-cache>\n\nAdd a --since flag to the report command' },
  { t: 'tool', name: 'Read', input: { file_path: 'src/report.js' }, result: 'code' },
  { t: 'say', text: 'I added --since to report.js and a test. Tests pass.' },
  { t: 'prompt', text: 'No, it should take a date, not a number of days. Redo it.' },
  { t: 'tool', name: 'Edit', input: { file_path: 'src/commands/report.js' }, result: 'ok' },
  { t: 'say', text: 'Changed: --since now takes an ISO date.' },
  { t: 'prompt', text: 'good. now open the PR' },
  { t: 'say', text: 'Opened PR #12.' },
];
const fakeObs = (over = {}) => ({ turn: 1, request: 'Add a --since flag', kind: 'feature', approach: 'added the flag as days', outcome: 'corrected', reaction: 'it should take a date, not a number of days', lesson: 'A --since flag takes a date, not a count of days', prefs: ['open the PR when done'], topics: ['report', 'cli'], bug: '', ...over });
const fakeComplete = ({ observations, sections }) => async opts => {
  if (opts.schema?.properties?.observations) return { json: { observations: observations || [fakeObs()] }, model: 'fake-opus', usage: { input_tokens: 10, output_tokens: 5 }, tokens: { totalTokens: 15 } };
  return { json: { sections }, model: 'fake-opus', tokens: { totalTokens: 20 } };
};

test('exchanges pair each prompt with the answers until the next prompt, which is where the outcome is read', () => {
  const xs = exchanges(session);
  assert.equal(xs.length, 3);
  assert.equal(xs[0].prompt, 'Add a --since flag to the report command', 'what the hook injected is not what the person said');
  assert.deepEqual(xs[0].answers, ['I added --since to report.js and a test. Tests pass.']);
  assert.match(xs[0].next, /^No, it should take a date/);
  assert.equal(xs[2].next, null);
  assert.equal(clean('<system-reminder>x</system-reminder>hi <thinker-profile>p</thinker-profile>'), 'hi');
  const text = extractionInput(xs);
  assert.match(text, /\[1\] USER: Add a --since/); assert.match(text, /\[2\] USER: No, it should/);
  assert.ok(!text.includes('src/report.js'), 'tool calls never reach the extraction');
  const huge = extractionInput([{ turn: 1, prompt: 'p', answers: ['x'.repeat(500_000)], next: null }], { maxChars: 10_000 });
  assert.ok(huge.length < 12_000, 'a long answer loses its middle');
  assert.deepEqual(sessionDirs(session), ['src', 'src/commands'], 'directories come from the tool calls\' paths alone');
  assert.equal(xs[0].at, null, 'a transcript without stamps gives no time');
  const t0 = Date.parse('2026-11-01T10:00:00Z');
  const stamped = exchanges([{ t: 'prompt', text: 'a', at: t0 }, { t: 'say', text: 'x' }, { t: 'prompt', text: 'b' }, { t: 'tool', name: 'Read', input: {}, at: t0 + 60_000 }, { t: 'say', text: 'y' }, { t: 'prompt', text: 'c' }, { t: 'say', text: 'z' }]);
  assert.deepEqual(stamped.map(x => x.at), [t0, t0 + 60_000, t0 + 60_000], 'an unstamped prompt takes the first stamp after it, else the last before it');
  const timed = observationTimes([{ turn: 2, request: 'r' }, { turn: 9, request: 'late' }], stamped);
  assert.equal(timed[0].at, new Date(t0 + 60_000).toISOString()); assert.equal(timed[1].at, new Date(t0 + 60_000).toISOString(), 'a turn with no stamp takes the session\'s last');
});

test('a model\'s observation is held to the ledger\'s shape', () => {
  assert.equal(tidyObservation({ request: '' }), null);
  const o = tidyObservation({ turn: '2', request: 'x', kind: 'nonsense', outcome: 'abandoned', weight: 7, prefs: 'not a list', topics: ['a', 'a', 'b'] });
  assert.equal(o.turn, 2); assert.equal(o.kind, 'other'); assert.equal(o.outcome, 'unknown', 'an outcome outside the four is unknown'); assert.equal('weight' in o, false, 'nothing reads a weight, so none is kept'); assert.deepEqual(o.prefs, []); assert.deepEqual(o.topics, ['a', 'b']);
});

test('the model is Opus and nothing else; the config pins another; a failed rung falls to the next', async () => {
  assert.deepEqual(profileModels({ have: ['claude', 'codex', 'gemini'] }), ['claude-opus-5-5'], 'no GPT or Gemini rung (the owner\'s call, 2026-11-07)');
  assert.deepEqual(profileModels({ have: ['codex'] }), [], 'no claude login, no profile');
  assert.deepEqual(profileModels({ have: ['anthropic', 'claude'] }), ['claude-opus-5-5'], 'the API key and the CLI are one rung');
  assert.deepEqual(profileModels({ have: ['codex'], config: { model: 'gpt-7' } }), ['gpt-7']);
  const tried = [];
  await assert.rejects(completeProfile({ prompt: 'p' }, { have: ['claude', 'codex'], completeFn: async o => { tried.push(o.model); throw new Error('limit reached'); } }), /limit reached/);
  assert.deepEqual(tried, ['claude-opus-5-5'], 'Opus fails, nothing else is tried');
  await assert.rejects(completeProfile({ prompt: 'p' }, { have: [], completeFn: async () => ({}) }), /no model available/);
});

test('the ledger keeps the window, names the session and its directories, and replaces a session\'s repeat', t => {
  const { store } = tmpRepo(t);
  const now = Date.now();
  appendObservations(store, [fakeObs()], { session: 's1', client: 'claude', dirs: ['src'], at: iso(now, 70), now });
  assert.equal(readLedger(store, { now }).length, 0, 'an observation older than the window is not in it');
  appendObservations(store, [fakeObs()], { session: 's1', client: 'claude', dirs: ['src'], at: iso(now, 1), now });
  appendObservations(store, [fakeObs()], { session: 's1', client: 'claude', dirs: ['src'], at: iso(now, 0), now });
  const rows = readLedger(store, { now });
  assert.equal(rows.length, 1, 'the same session\'s same observation is written once');
  assert.equal(rows[0].session, 's1'); assert.deepEqual(rows[0].dirs, ['src']); assert.match(rows[0].id, /^obs-[0-9a-f]{10}$/);
  assert.equal(rows[0].seen, new Date(now).toISOString(), 'seen is when the row was written');
  appendObservations(store, [fakeObs({ turn: 7, at: iso(now, 9) })], { session: 's2', at: iso(now, 0), now });
  const r7 = readLedger(store, { now }).find(r => r.turn === 7);
  assert.equal(r7.at, iso(now, 9), 'an observation\'s own time (the session\'s clock) beats the fallback');
});

test('settle holds the profile to the ledger: citations, evidence floors by session, recency, counts from the observations', () => {
  const now = Date.now();
  const rows = [
    { id: 'a', at: iso(now, 1), session: 's1', outcome: 'corrected', reaction: 'wrong', prefs: [] },
    { id: 'b', at: iso(now, 5), session: 's2', outcome: 'accepted', reaction: 'ok', prefs: [] },
    { id: 'c', at: iso(now, 30), session: 's3', outcome: 'accepted', reaction: '', prefs: [] },
    { id: 'd', at: iso(now, 2), session: 's1', outcome: 'unknown', reaction: '', prefs: [] },
    { id: 'e', at: iso(now, 3), session: 's4', outcome: 'unknown', reaction: '', prefs: ['no headers'] },
  ];
  const s = settle({
    workingOn: [{ text: 'current', obs: ['a', 'zzz'] }, { text: 'old', obs: ['c'] }, { text: 'uncited', obs: ['zzz'] }, { text: '', obs: ['a'] }],
    howWeWork: [{ text: 'never push main', obs: ['a', 'b', 'c'] }, { text: 'one session, inferred', obs: ['a', 'd'] }, { text: 'no headers', obs: ['e'] }],
    whatFails: [{ when: 'flags', avoid: 'guessing the unit', instead: 'ask the unit', obs: ['a'] }, { when: 'tests', avoid: 'z', obs: ['d'] }, { when: 'two sessions', avoid: 'y', obs: ['b', 'c'] }, { when: 'one session, no words', avoid: 'x', obs: ['b'] }],
    recentBugs: [{ text: 'fresh', obs: ['a'] }, { text: 'stale', obs: ['c'] }],
  }, rows, { now });
  assert.deepEqual(s.workingOn.map(e => e.text), ['current'], 'an uncited entry, an empty one and a workstream past 21 days go');
  assert.deepEqual(s.workingOn[0].obs, ['a'], 'a citation the window does not hold is dropped');
  assert.deepEqual(s.howWeWork.map(e => e.text), ['never push main', 'no headers'], 'two sessions, or one stated preference; two observations of one session are not two sessions');
  assert.equal(s.howWeWork[0].count, 3, 'count is distinct sessions among the citations'); assert.equal(s.howWeWork[0].firstSeen, iso(now, 30).slice(0, 10));
  assert.deepEqual(s.whatFails.map(e => e.when), ['two sessions', 'flags'], 'two sessions, or one correction in the person\'s words; most sessions first');
  assert.equal(s.whatFails[1].instead, 'ask the unit');
  assert.deepEqual(s.recentBugs.map(e => e.text), ['fresh']);
  for (const k of SECTIONS) assert.ok(s[k].length <= PROFILE.perSection[k]);
});

test('render fits the budget by dropping the oldest workstreams first and the ways of working last', () => {
  const profile = { compiledAt: '2026-11-07T00:00:00Z', window: { sessions: 12, days: 60, from: '2026-10-01', to: '2026-11-07' }, sections: {
    workingOn: Array.from({ length: 6 }, (_, i) => ({ text: `stream ${i} ${'x'.repeat(150)}`, firstSeen: '2026-11-01', lastSeen: `2026-11-0${6 - i}`, count: 1, obs: [] })),
    howWeWork: Array.from({ length: 5 }, (_, i) => ({ text: `way ${i} ${'y'.repeat(100)}`, count: 5 - i, obs: [] })),
    whatFails: [{ when: 'flags', avoid: 'guessing the unit', instead: 'ask', count: 1, obs: [] }],
    recentBugs: [{ text: 'a bug', lastSeen: '2026-11-06', obs: [] }],
  } };
  const full = renderProfile(profile);
  assert.match(full, /## Working on/); assert.match(full, /When flags: avoid guessing the unit; instead: ask \(1\)/); assert.match(full, /Learned from 12 sessions in this repository, 2026-10-01 to 2026-11-07/);
  assert.ok(full.indexOf('## How this person works') < full.indexOf('## What went wrong before'));
  const small = renderProfile(profile, { maxChars: 1500 });
  assert.ok(small.length <= 1500);
  assert.match(small, /stream 0/); assert.ok(!small.includes('stream 5'), 'the oldest workstream goes first');
  assert.match(small, /way 0/); assert.match(small, /way 3/, 'the ways of working keep four lines while workingOn has more than three');
  assert.equal(renderProfile(null), '');
});

test('compile is due whenever something new was read into the ledger, and first after one observation', t => {
  const { store } = tmpRepo(t);
  const now = Date.now();
  assert.equal(compileDue(store, { now }), false);
  appendObservations(store, [fakeObs()], { session: 's1', at: iso(now, 1), now });
  assert.equal(compileDue(store, { now }), true, 'one observation makes the first compile due');
  fs.mkdirSync(path.join(store.localDir, 'profile'), { recursive: true });
  fs.writeFileSync(path.join(store.localDir, 'profile', 'profile.json'), JSON.stringify({ compiledAt: new Date(now + 1).toISOString(), sections: {} }));
  assert.equal(compileDue(store, { now }), false, 'nothing new since the compile');
  appendObservations(store, [fakeObs({ turn: 4, at: iso(now, 20) })], { session: 's2', now: now + 60_000 });
  assert.equal(compileDue(store, { now: now + 60_000 }), true, 'a session read after the compile is due, however old the session');
});

test('a patch is merged into the profile as it stands: silence keeps, update adds evidence and changes named fields, drop removes, add appends', () => {
  const previous = { sections: { workingOn: [{ id: 'w1', text: 'old stream', obs: ['a'] }], howWeWork: [{ id: 'h1', text: 'never push main', obs: ['a', 'b'] }, { id: 'h2', text: 'dup', obs: ['c'] }], whatFails: [{ id: 'f1', when: 'flags', avoid: 'guessing', obs: ['a'] }], recentBugs: [] } };
  const out = applyPatch(previous, { keep: ['w1'], update: [{ id: 'h1', obs: ['d', 'a'] }, { id: 'f1', instead: 'ask', obs: [] }, { id: 'zz', obs: ['x'] }], drop: [{ id: 'h2', reason: 'says what h1 says' }], add: { workingOn: [{ text: 'new stream', obs: ['d'] }], howWeWork: [], whatFails: [], recentBugs: [] } });
  assert.deepEqual(out.workingOn.map(e => e.text), ['old stream', 'new stream']);
  assert.deepEqual(out.howWeWork.map(e => e.text), ['never push main'], 'the drop removed the duplicate');
  assert.deepEqual(out.howWeWork[0].obs, ['a', 'b', 'd'], 'an update adds its observations once');
  assert.equal(out.whatFails[0].instead, 'ask'); assert.equal(out.whatFails[0].avoid, 'guessing', 'fields not named stay');
  assert.deepEqual(applyPatch(null, { add: { workingOn: [{ text: 'x', obs: ['a'] }] } }).workingOn.length, 1, 'from nothing, every entry is an add');
  assert.deepEqual(applyPatch({ sections: { howWeWork: [{ text: 'no id', obs: ['a'] }] } }, {}).howWeWork.length, 0, 'an entry without an id cannot be kept by a patch (compileStep gives older profiles ids first)');
  const rows = [{ id: 'a', at: '2026-11-01T00:00:00Z', topics: ['proxy'], dirs: ['src'] }, { id: 'b', at: '2026-11-02T00:00:00Z', topics: ['site'], dirs: ['site'] }, { id: 'n', at: '2026-11-03T00:00:00Z', topics: ['Proxy'], dirs: [] }];
  assert.deepEqual(relatedCited(previous, [rows[2]], rows).map(r => r.id), ['a'], 'the evidence shown is what shares a topic or directory with the new rows');
});

test('a session end to end: observations into the ledger, a compile when due, the previous profile to history, and the block', async t => {
  const { dir, store } = tmpRepo(t, { learn: { mode: 'profile' } });
  assert.equal(profileConfig(store).enabled, true);
  const sections = { workingOn: [{ text: 'The report command grows a --since date flag', obs: [] }], howWeWork: [], whatFails: [{ when: 'adding a flag', avoid: 'guessing its unit; the person asked for a date', obs: [] }], recentBugs: [] };
  let seen = null;
  const completeFn = async opts => {
    if (opts.schema?.properties?.observations) { seen = opts.prompt; return { json: { observations: [fakeObs(), fakeObs({ turn: 2, request: 'open the PR', outcome: 'accepted', reaction: 'good', lesson: '' }), fakeObs({ turn: 3, request: 'x', outcome: 'unknown' })] }, model: 'fake-opus', tokens: { totalTokens: 15 } }; }
    const ids = readLedger(store).map(r => r.id);
    assert.match(opts.prompt, /AGENTS\.md: Pull requests/, 'the compile sees the instruction files\' headings');
    assert.match(opts.prompt, /obs-[0-9a-f]{10} \| \d{4}-\d{2}-\d{2} \| feature \| outcome=corrected \| dirs=src,src\/commands/);
    assert.match(opts.prompt, /PROFILE SO FAR \(compiled never\)/);
    return { json: { keep: [], update: [], drop: [], add: { ...sections, workingOn: [{ ...sections.workingOn[0], obs: [ids[0]] }], whatFails: [{ ...sections.whatFails[0], obs: [ids[0]] }] } }, model: 'fake-opus', tokens: { totalTokens: 20 } };
  };
  const r = await profileSession(store, session, { session: 's1', client: 'claude', repoHint: dir, completeFn, have: ['claude'] });
  assert.equal(r.observations.length, 3);
  assert.ok(seen && !seen.includes('src/report.js') && seen.includes('[2] USER: No, it should take a date'), 'the extraction reads prompts and answers only');
  assert.ok(r.compiled, 'three observations make the first compile due');
  const p = readProfile(store);
  assert.equal(p.sections.workingOn.length, 1); assert.equal(p.sections.whatFails[0].count, 1); assert.equal(p.sections.whatFails[0].id, 'f1'); assert.equal(p.window.sessions, 1); assert.equal(p.model, 'fake-opus'); assert.match(p.window.from, /^\d{4}-\d{2}-\d{2}$/);
  const block = profileBlock(store);
  assert.match(block, /^<thinker-profile>\n/); assert.match(block, /When adding a flag: avoid guessing its unit/); assert.match(block, /Learned from 1 sessions/);
  // a profile from before entries carried ids is patched all the same
  const v2 = readProfile(store); for (const s of SECTIONS) for (const e of v2.sections[s]) delete e.id;
  fs.writeFileSync(path.join(store.localDir, 'profile', 'profile.json'), JSON.stringify(v2));
  appendObservations(store, [fakeObs({ turn: 7, request: 'later' })], { session: 's2', now: Date.now() + 5000 });
  const v3 = await compileProfile(store, { now: Date.now() + 6000, completeFn: async opts => { assert.match(opts.prompt, /"id":"w1"/); return { json: { keep: ['w1', 'f1'], update: [], drop: [], add: { workingOn: [], howWeWork: [], whatFails: [], recentBugs: [] } }, model: 'fake-opus' }; }, have: ['claude'] });
  assert.equal(v3.profile.sections.workingOn.length, 1, 'the old entries are kept under the ids they were given');
  // nothing new since the compile: nothing to do, unless the whole window is asked for again
  assert.match((await compileProfile(store, { completeFn: async () => { throw new Error('not called'); }, have: ['claude'] })).skipped, /nothing new/);
  const c = await compileProfile(store, { full: true, completeFn: async () => ({ json: { keep: [], update: [], drop: [], add: { ...sections, workingOn: [], whatFails: [] } }, model: 'fake-opus' }), have: ['claude'] });
  assert.equal(c.profile.sections.whatFails.length, 0, 'a full compile starts from nothing');
  assert.equal(fs.readFileSync(path.join(store.localDir, 'profile', 'history.jsonl'), 'utf8').trim().split('\n').length, 2, 'each replaced profile is kept');
  const log = fs.readFileSync(path.join(dir, '.thinker', 'log.jsonl'), 'utf8');
  assert.match(log, /"op":"profile"/); assert.match(log, /"op":"profile-compile"/);
  assert.ok(!log.includes('guessing its unit'), 'the log carries counts, never the profile\'s text');
});

test('in profile mode distillFile reads the session into the ledger and writes no note; a turn-end batch waits for the end', async t => {
  const { dir, store } = tmpRepo(t, { learn: { mode: 'profile' } });
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, session.map(e => JSON.stringify(e)).join('\n') + '\n');
  const lines = [];
  const ctx = { repo: dir, store, out: l => lines.push(l) };
  let calls = 0, compiles = 0;
  const completeFn = async opts => { if (opts.schema?.properties?.observations) { calls++; return { json: { observations: [fakeObs()] }, model: 'fake-opus' }; } compiles++; return { json: { keep: [], update: [], drop: [], add: { workingOn: [], howWeWork: [], whatFails: [], recentBugs: [] } }, model: 'fake-opus' }; };
  await distillFile(ctx, file, { minExplore: 1, quiet: false, incremental: true, batch: true, session: 's9', completeFn });
  assert.equal(calls, 0, 'a batch at the end of a turn makes no call in profile mode');
  await distillFile(ctx, file, { minExplore: 1, quiet: false, incremental: true, session: 's9', completeFn });
  assert.equal(calls, 1); assert.equal(compiles, 1, 'the first session with an observation compiles');
  assert.equal(readLedger(store).length, 1);
  assert.equal(store.list().length, 0, 'no note is written');
  assert.ok(lines.some(l => /read 3 exchanges → 1 observations; profile compiled/.test(l)), lines.join('\n'));
  const state = JSON.parse(fs.readFileSync(path.join(store.dir, 'state', 'session.json'), 'utf8'));
  assert.equal(state.line, 8, 'the transcript\'s lines are marked read, as for a distillation');
  await distillFile(ctx, file, { minExplore: 1, quiet: true, incremental: true, session: 's9', completeFn });
  assert.equal(calls, 1, 'nothing new in the transcript, no call');
});

test('a backlog is compiled in steps, each shown the profile so far and the observations it cites', async t => {
  const { store } = tmpRepo(t);
  const now = Date.now();
  const was = PROFILE.compileBatch; PROFILE.compileBatch = 2; t.after(() => { PROFILE.compileBatch = was; });
  for (let i = 0; i < 5; i++) appendObservations(store, [fakeObs({ turn: i + 1, request: `request ${i}`, at: iso(now, 5 - i) })], { session: `s${i}`, now: now - 1000 });
  const prompts = [];
  const completeFn = async opts => {
    prompts.push(opts.prompt);
    const ids = [...opts.prompt.matchAll(/^(obs-[0-9a-f]{10}) \|/gm)].map(m => m[1]); // the rows shown
    const first = /PROFILE SO FAR \(compiled never\)/.test(opts.prompt);
    const patch = first ? { keep: [], update: [], drop: [], add: { workingOn: [], howWeWork: [{ text: 'open the PR when done', obs: ids }], whatFails: [], recentBugs: [] } } : { keep: ['h1'], update: [{ id: 'h1', obs: ids }], drop: [], add: { workingOn: [], howWeWork: [], whatFails: [], recentBugs: [] } };
    return { json: patch, model: 'fake-opus', tokens: { totalTokens: 7 } };
  };
  const r = await compileProfile(store, { now, completeFn, have: ['claude'] });
  assert.equal(r.steps, 3); assert.equal(prompts.length, 3); assert.equal(r.tokens, 21);
  assert.match(prompts[0], /PROFILE SO FAR \(compiled never\)/); assert.ok(!prompts[0].includes('OBSERVATIONS BEHIND'));
  assert.match(prompts[1], /OBSERVATIONS BEHIND THE ENTRIES THESE MIGHT TOUCH \(2\)/, 'the fake observations share their topics'); assert.match(prompts[1], /NEW OBSERVATIONS \(2, from 2 sessions/);
  assert.match(prompts[1], /"id":"h1"/, 'the profile so far carries entry ids for the patch');
  assert.deepEqual(r.changes, { kept: 2, updated: 2, dropped: 0, added: 1 });
  assert.match(prompts[0], /request 0/); assert.ok(!prompts[0].includes('request 2'), 'the oldest batch goes first');
  assert.equal(r.profile.sections.howWeWork[0].count, 5, 'each update adds its evidence to the entry');
  assert.equal(r.profile.window.observations, 5);
  assert.equal(compileDue(store, { now }), false);
  appendObservations(store, [fakeObs({ turn: 9, at: iso(now, 40) })], { session: 's9', now: now + 1000 });
  const d = await compileProfile(store, { now: now + 2000, completeFn, have: ['claude'], dry: true });
  assert.equal(d.pending, 1, 'an old session read today is new to the profile'); assert.equal(d.steps, 1);
});

test('the block goes into a shown session\'s first prompt and again after a compaction; a held-out session gets nothing and is logged once; rows carry the arm', async t => {
  const { dir, store } = tmpRepo(t, { learn: { mode: 'profile' } });
  const now = Date.now();
  appendObservations(store, [fakeObs()], { session: 's0', now });
  await compileProfile(store, { now, have: ['claude'], completeFn: async () => ({ json: { keep: [], update: [], drop: [], add: { workingOn: [], howWeWork: [], whatFails: [{ when: 'adding a flag', avoid: 'guessing its unit', obs: readLedger(store).map(r => r.id) }], recentBugs: [] } }, model: 'fake-opus' }) });
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n');
  const prev = process.env.THINKER_HOLDOUT; process.env.THINKER_HOLDOUT = '0'; t.after(() => { if (prev === undefined) delete process.env.THINKER_HOLDOUT; else process.env.THINKER_HOLDOUT = prev; });
  assert.equal(profileArm(store, 'any'), 'shown', 'no holdout: every session is shown');
  const first = profileTurn(store, 'sA', { transcript, client: 'claude' });
  assert.match(first, /^<thinker-profile>\n/); assert.match(first, /When adding a flag: avoid guessing its unit/);
  assert.equal(profileTurn(store, 'sA', { transcript, client: 'claude' }), '', 'told once');
  fs.appendFileSync(transcript, JSON.stringify({ type: 'system', subtype: 'compact_boundary' }) + '\n' + JSON.stringify({ type: 'user', message: { role: 'user', content: 'again' } }) + '\n');
  assert.match(profileTurn(store, 'sA', { transcript, client: 'claude' }), /^<thinker-profile>/, 'a compaction brings it back');
  assert.equal(profileTurn(store, 'sA', { transcript, client: 'claude' }), '', 'and once only');
  assert.equal(profileArmOf(store, 'sA'), 'shown');
  // every session held out
  process.env.THINKER_HOLDOUT = '1';
  assert.equal(profileArm(store, 'sB'), 'holdout');
  assert.equal(profileTurn(store, 'sB', { client: 'codex' }), ''); assert.equal(profileTurn(store, 'sB', { client: 'codex' }), '');
  assert.equal(profileArmOf(store, 'sB'), 'holdout');
  const log = fs.readFileSync(path.join(dir, '.thinker', 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.op === 'profile-served');
  assert.deepEqual(log.map(e => [e.session, e.arm, e.afterCompaction || false, e.chars > 0]), [['sA', 'shown', false, true], ['sA', 'shown', true, true], ['sB', 'holdout', false, false]], 'one row per injection, one for a held-out session; never the text');
  // the session's observations carry its arm
  const r = await profileSession(store, session, { session: 'sB', client: 'codex', compile: false, have: ['claude'], completeFn: async () => ({ json: { observations: [fakeObs()] }, model: 'fake-opus' }) });
  assert.equal(r.observations[0].arm, 'holdout');
  const h = holdoutReport([...readLedger(store), { id: 'x', session: 'sC', arm: 'shown', outcome: 'accepted' }, { id: 'y', session: 'sC', arm: 'shown', outcome: 'corrected' }]);
  assert.equal(h.holdout.sessions, 1); assert.equal(h.holdout.corrected, 1); assert.equal(h.shown.observations, 2); assert.equal(h.shown.corrected, 0.5); assert.equal(h.unknown.observations, 1, 's0 was read before any arm');
  // off: nothing, whatever the state
  fs.writeFileSync(path.join(dir, '.thinker', 'config.json'), '{}');
  assert.equal(profileTurn(new Store(dir), 'sD', {}), '', 'learn.mode off: no block');
});

test('a full compile from nothing is due again after rebaseDays, and rebasedAt is carried by the patches between', async t => {
  const { store } = tmpRepo(t);
  const now = Date.now();
  const calls = [];
  const completeFn = async opts => { calls.push(/PROFILE SO FAR \(compiled never\)/.test(opts.prompt) ? 'full' : 'patch'); return { json: { keep: [], update: [], drop: [], add: { workingOn: [{ text: 'x', obs: readLedger(store).map(r => r.id) }], howWeWork: [], whatFails: [], recentBugs: [] } }, model: 'fake-opus' }; };
  appendObservations(store, [fakeObs()], { session: 's1', now });
  const a = await compileProfile(store, { now, completeFn, have: ['claude'] });
  assert.equal(a.full, true); assert.equal(a.profile.rebasedAt, new Date(now).toISOString());
  appendObservations(store, [fakeObs({ turn: 2 })], { session: 's2', now: now + 1000 });
  const b = await compileProfile(store, { now: now + 2000, completeFn, have: ['claude'] });
  assert.equal(b.full, false); assert.equal(b.profile.rebasedAt, a.profile.rebasedAt, 'a patch keeps the last rebase');
  appendObservations(store, [fakeObs({ turn: 3 })], { session: 's3', now: now + 31 * DAY });
  const c = await compileProfile(store, { now: now + 31 * DAY + 1000, completeFn, have: ['claude'] });
  assert.equal(c.full, true, 'a month on, the compile starts from nothing'); assert.equal(c.profile.rebasedAt, new Date(now + 31 * DAY + 1000).toISOString());
  assert.deepEqual(calls, ['full', 'patch', 'full']);
});

test('through the hooks: the prompt hook puts the block ahead of everything else on the first prompt, and the stop hook\'s session row names the arm', async t => {
  const { dir, store } = tmpRepo(t, { learn: { mode: 'profile' } });
  const now = Date.now();
  appendObservations(store, [fakeObs()], { session: 's0', now });
  await compileProfile(store, { now, have: ['claude'], completeFn: async () => ({ json: { keep: [], update: [], drop: [], add: { workingOn: [{ text: 'The report command grows a --since flag', obs: readLedger(store).map(r => r.id) }], howWeWork: [], whatFails: [], recentBugs: [] } }, model: 'fake-opus' }) });
  const CLI = new URL('../src/cli.js', import.meta.url).pathname;
  const env = { ...process.env, THINKER_LOG: 'local', THINKER_HOLDOUT: '0', THINKER_NO_LEARN: '1', THINKER_TELEMETRY: 'off', THINKER_CE: 'off' };
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: 'add the flag' }, timestamp: new Date(now).toISOString() }) + '\n' + JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 10, output_tokens: 2 } }, timestamp: new Date(now).toISOString() }) + '\n');
  const run = (sub, input) => execFileSync('node', [CLI, 'hook', sub, '--repo', dir], { input: JSON.stringify(input), encoding: 'utf8', env });
  const first = run('prompt', { session_id: 'h1', prompt: 'add the flag', transcript_path: transcript });
  assert.match(first, /<thinker-profile>/); assert.match(first, /The report command grows a --since flag/);
  const second = run('prompt', { session_id: 'h1', prompt: 'and the test', transcript_path: transcript });
  assert.ok(!second.includes('<thinker-profile>'), 'once a session');
  run('stop', { session_id: 'h1', transcript_path: transcript });
  const rows = fs.readFileSync(path.join(dir, '.thinker', 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(rows.find(e => e.op === 'session' && e.session === 'h1')?.profile, 'shown');
  assert.equal(rows.filter(e => e.op === 'profile-served').length, 1);
});
