import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROFILE, SECTIONS, exchanges, extractionInput, sessionDirs, tidyObservation, observationTimes, profileModels, completeProfile, appendObservations, readLedger, settle, compileDue, compileProfile, renderProfile, profileBlock, profileSession, readProfile, profileConfig, clean } from '../src/profile.js';
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

test('compile is due after ten new observations or three days with any, and first after three', t => {
  const { store } = tmpRepo(t);
  const now = Date.now();
  assert.equal(compileDue(store, { now }), false);
  appendObservations(store, [fakeObs(), fakeObs({ turn: 2 }), fakeObs({ turn: 3 })], { session: 's1', at: iso(now, 1), now });
  assert.equal(compileDue(store, { now }), true);
  fs.mkdirSync(path.join(store.localDir, 'profile'), { recursive: true });
  fs.writeFileSync(path.join(store.localDir, 'profile', 'profile.json'), JSON.stringify({ compiledAt: iso(now, 0.5), sections: {} }));
  assert.equal(compileDue(store, { now }), false, 'nothing new since the compile');
  appendObservations(store, [fakeObs({ turn: 4 })], { session: 's2', at: iso(now, 0.1), now });
  assert.equal(compileDue(store, { now }), false, 'one new observation, hours old');
  assert.equal(compileDue(store, { now: now + 3 * DAY }), true, 'three days on, anything new is due');
  appendObservations(store, Array.from({ length: 10 }, (_, i) => fakeObs({ turn: 10 + i })), { session: 's3', at: iso(now, 0.1), now });
  assert.equal(compileDue(store, { now }), true);
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
    return { json: { sections: { ...sections, workingOn: [{ ...sections.workingOn[0], obs: [ids[0]] }], whatFails: [{ ...sections.whatFails[0], obs: [ids[0]] }] } }, model: 'fake-opus', tokens: { totalTokens: 20 } };
  };
  const r = await profileSession(store, session, { session: 's1', client: 'claude', repoHint: dir, completeFn, have: ['claude'] });
  assert.equal(r.observations.length, 3);
  assert.ok(seen && !seen.includes('src/report.js') && seen.includes('[2] USER: No, it should take a date'), 'the extraction reads prompts and answers only');
  assert.ok(r.compiled, 'three observations make the first compile due');
  const p = readProfile(store);
  assert.equal(p.sections.workingOn.length, 1); assert.equal(p.sections.whatFails[0].count, 1); assert.equal(p.window.sessions, 1); assert.equal(p.model, 'fake-opus'); assert.match(p.window.from, /^\d{4}-\d{2}-\d{2}$/);
  const block = profileBlock(store);
  assert.match(block, /^<thinker-profile>\n/); assert.match(block, /When adding a flag: avoid guessing its unit/); assert.match(block, /Learned from 1 sessions/);
  // nothing new since the compile: nothing to do, unless the whole window is asked for again
  assert.match((await compileProfile(store, { completeFn: async () => { throw new Error('not called'); }, have: ['claude'] })).skipped, /nothing new/);
  const c = await compileProfile(store, { full: true, completeFn: async () => ({ json: { sections: { ...sections, workingOn: [], whatFails: [] } }, model: 'fake-opus' }), have: ['claude'] });
  assert.equal(c.profile.sections.whatFails.length, 0);
  assert.equal(fs.readFileSync(path.join(store.localDir, 'profile', 'history.jsonl'), 'utf8').trim().split('\n').length, 1, 'the previous profile is kept');
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
  let calls = 0;
  const completeFn = async () => { calls++; return { json: { observations: [fakeObs()] }, model: 'fake-opus' }; };
  await distillFile(ctx, file, { minExplore: 1, quiet: false, incremental: true, batch: true, session: 's9', completeFn });
  assert.equal(calls, 0, 'a batch at the end of a turn makes no call in profile mode');
  await distillFile(ctx, file, { minExplore: 1, quiet: false, incremental: true, session: 's9', completeFn });
  assert.equal(calls, 1);
  assert.equal(readLedger(store).length, 1);
  assert.equal(store.list().length, 0, 'no note is written');
  assert.ok(lines.some(l => /read 3 exchanges → 1 observations/.test(l)), lines.join('\n'));
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
    const ids = [...new Set([...opts.prompt.matchAll(/obs-[0-9a-f]{10}/g)].map(m => m[0]))]; // the rows shown and the previous profile's own citations
    return { json: { sections: { workingOn: [], howWeWork: [{ text: 'open the PR when done', obs: ids }], whatFails: [], recentBugs: [] } }, model: 'fake-opus', tokens: { totalTokens: 7 } };
  };
  const r = await compileProfile(store, { now, completeFn, have: ['claude'] });
  assert.equal(r.steps, 3); assert.equal(prompts.length, 3); assert.equal(r.tokens, 21);
  assert.match(prompts[0], /PREVIOUS PROFILE \(compiled never\)/); assert.ok(!prompts[0].includes('OBSERVATIONS THE PREVIOUS PROFILE CITES'));
  assert.match(prompts[1], /OBSERVATIONS THE PREVIOUS PROFILE CITES \(2\)/); assert.match(prompts[1], /NEW OBSERVATIONS \(2, from 2 sessions/);
  assert.match(prompts[2], /OBSERVATIONS THE PREVIOUS PROFILE CITES \(2\)/, 'the cited rows shown are capped at a batch; the citations themselves are kept through the previous profile');
  assert.match(prompts[0], /request 0/); assert.ok(!prompts[0].includes('request 2'), 'the oldest batch goes first');
  assert.equal(r.profile.sections.howWeWork[0].count, 5, 'the last step re-cites everything the earlier ones found');
  assert.equal(r.profile.window.observations, 5);
  assert.equal(compileDue(store, { now }), false);
  appendObservations(store, [fakeObs({ turn: 9, at: iso(now, 40) })], { session: 's9', now: now + 1000 });
  const d = await compileProfile(store, { now: now + 2000, completeFn, have: ['claude'], dry: true });
  assert.equal(d.pending, 1, 'an old session read today is new to the profile'); assert.equal(d.steps, 1);
});
