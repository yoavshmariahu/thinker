import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROFILE, SECTIONS, observationSkills, ledgerText, skillTallyText, applyPatch, relatedCited, profileArm, profileTurn, profileArmOf, holdoutReport, exchanges, extractionInput, sessionDirs, tidyObservation, observationTimes, profileModels, completeProfile, appendObservations, readLedger, settle, compileDue, compileProfile, renderProfile, profileBlock, profileSession, readProfile, profileConfig, clean, compare, compareRates, recurrence, priorStatements, perExchange, ratioInterval, fitProfile, shownLines, lineReport, readLineVerdicts, appendLineVerdicts, LINE_VERDICTS, profileHoldoutRate } from '../src/profile.js';
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
const fakeObs = (over = {}) => ({ turn: 1, request: 'Add a --since flag', approach: 'added the flag as days', outcome: 'corrected', reaction: 'it should take a date, not a number of days', lesson: 'A --since flag takes a date, not a count of days', prefs: ['open the PR when done'], topics: ['report', 'cli'], ...over });
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
  const o = tidyObservation({ turn: '2', request: 'x', kind: 'feature', bug: 'a bug', outcome: 'abandoned', weight: 7, prefs: 'not a list', topics: ['a', 'a', 'b'] });
  assert.equal(o.turn, 2); assert.equal('kind' in o, false, 'kind went: nothing read it'); assert.equal('bug' in o, false, 'bug went with recentBugs'); assert.equal(o.outcome, 'unknown', 'an outcome outside the four is unknown'); assert.equal('weight' in o, false, 'nothing reads a weight, so none is kept'); assert.deepEqual(o.prefs, []); assert.deepEqual(o.topics, ['a', 'b']);
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
    { id: 'f', at: iso(now, 4), session: 's5', outcome: 'unknown', reaction: '', prefs: [], interrupts: 1 },
    { id: 'g', at: iso(now, 6), session: 's6', outcome: 'redirected', reaction: '', prefs: [] },
  ];
  const s = settle({
    workingOn: [{ text: 'current', obs: ['a', 'zzz'] }, { text: 'old', obs: ['c'] }, { text: 'uncited', obs: ['zzz'] }, { text: '', obs: ['a'] }],
    howWeWork: [{ text: 'never push main', obs: ['a', 'b', 'c'] }, { text: 'one correction, in words', obs: ['a', 'd'] }, { text: 'one session, inferred', obs: ['d'] }, { text: 'no headers', obs: ['e'] }, { text: 'interrupted once', obs: ['f'] }, { text: 'redirected, no words', obs: ['g'] }],
    whatFails: [{ when: 'gone', avoid: 'x', obs: ['a'] }],
  }, rows, { now });
  assert.deepEqual(s.workingOn.map(e => e.text), ['current'], 'an uncited entry, an empty one and a workstream past 21 days go');
  assert.deepEqual(s.workingOn[0].obs, ['a'], 'a citation the window does not hold is dropped');
  assert.deepEqual(s.howWeWork.map(e => e.text), ['never push main', 'one correction, in words', 'no headers', 'interrupted once'],
    'two sessions, or one stated preference, one correction with the person\'s words, or one interruption; two observations of one session are not two sessions; most sessions first, then newest');
  assert.equal(s.howWeWork[0].count, 3, 'count is distinct sessions among the citations'); assert.equal(s.howWeWork[0].firstSeen, iso(now, 30).slice(0, 10));
  assert.equal('whatFails' in s, false, 'a section that went is not settled');
  assert.deepEqual(Object.keys(s), SECTIONS);
  for (const k of SECTIONS) assert.ok(s[k].length <= PROFILE.perSection[k]);
});

test('render is the text alone, and fits the budget by dropping the oldest workstreams first and the ways of working last', () => {
  const profile = { compiledAt: '2026-11-07T00:00:00Z', window: { sessions: 12, days: 60, from: '2026-10-01', to: '2026-11-07' }, sections: {
    workingOn: Array.from({ length: 6 }, (_, i) => ({ text: `stream ${i} ${'x'.repeat(150)}`, firstSeen: '2026-11-01', lastSeen: `2026-11-0${6 - i}`, count: 1, obs: [] })),
    howWeWork: Array.from({ length: 5 }, (_, i) => ({ text: `way ${i} ${'y'.repeat(100)}`, count: 5 - i, obs: [] })),
    skills: [{ skill: 'dataviz', text: 'charts for the site', count: 3, used: 3, accepted: 2, corrected: 1, obs: [] }],
    whatFails: [{ when: 'gone', avoid: 'x', count: 1, obs: [] }],
  } };
  const full = renderProfile(profile);
  assert.match(full, /^About the person here, from 12 sessions in this repository\. Follow how they work; the rest is context\.\n\n## Working on\n- stream 0 x+\n/, 'one sentence of header; a line is its text');
  assert.match(full, /\n- way 0 y+\n/, 'no count on a rule'); assert.match(full, /\n## Skills\n- \/dataviz: charts for the site$/, 'no tally on a skill');
  assert.ok(!/\d{4}-\d{2}-\d{2}|\(\d+\)|sessions;/.test(full.replace(/^[^\n]*\n/, '')), 'no dates, counts or tallies anywhere in the served block');
  assert.ok(!full.includes('gone'), 'a section that went is not rendered');
  const small = renderProfile(profile, { maxChars: 1600 });
  assert.ok(small.length <= 1600);
  assert.match(small, /stream 0/); assert.ok(!small.includes('stream 5'), 'the oldest workstream goes first');
  assert.match(small, /way 0/); assert.match(small, /way 3/, 'the ways of working keep four lines while workingOn has more than three');
  assert.equal(renderProfile(null), '');
  assert.equal(renderProfile({ window: { sessions: 1 }, sections: { workingOn: [{ text: 'x', obs: [] }] } }).split('\n')[0], 'About the person here, from 1 session in this repository. Follow how they work; the rest is context.');
});

test('compile is due once a day when something new was read into the ledger, and first after one observation', t => {
  const { store } = tmpRepo(t);
  const now = Date.now();
  assert.equal(compileDue(store, { now }), false);
  appendObservations(store, [fakeObs()], { session: 's1', at: iso(now, 1), now });
  assert.equal(compileDue(store, { now }), true, 'one observation makes the first compile due');
  fs.mkdirSync(path.join(store.localDir, 'profile'), { recursive: true });
  fs.writeFileSync(path.join(store.localDir, 'profile', 'profile.json'), JSON.stringify({ compiledAt: new Date(now + 1).toISOString(), sections: {} }));
  assert.equal(compileDue(store, { now }), false, 'nothing new since the compile');
  appendObservations(store, [fakeObs({ turn: 4, at: iso(now, 20) })], { session: 's2', now: now + 60_000 });
  assert.equal(compileDue(store, { now: now + 60_000 }), false, 'a session read a minute after the compile waits: once a day (the owner\'s call)');
  assert.equal(compileDue(store, { now: now + 23 * 3600_000 }), false);
  assert.equal(compileDue(store, { now: now + PROFILE.compileHours * 3600_000 + 1 }), true, 'a day on, a session read after the compile is due, however old the session');
  fs.writeFileSync(path.join(store.localDir, 'profile', 'profile.json'), JSON.stringify({ compiledAt: new Date(now - 3 * DAY).toISOString(), sections: {} }));
  assert.equal(compileDue(store, { now }), true, 'and nothing new since an old compile is still nothing to do');
  fs.writeFileSync(path.join(store.localDir, 'profile', 'profile.json'), JSON.stringify({ compiledAt: new Date(now + 2 * DAY).toISOString(), sections: {} }));
  assert.equal(compileDue(store, { now: now + 3 * DAY }), false, 'nothing read since the compile, nothing due');
});

test('a patch is merged into the profile as it stands: silence keeps, update adds evidence and changes named fields, drop removes, add appends', () => {
  const previous = { sections: { workingOn: [{ id: 'w1', text: 'old stream', obs: ['a'] }], howWeWork: [{ id: 'h1', text: 'never push main', obs: ['a', 'b'] }, { id: 'h2', text: 'dup', obs: ['c'] }], skills: [{ id: 's1', skill: 'dataviz', text: 'charts', obs: ['a'] }], whatFails: [{ id: 'f1', when: 'flags', avoid: 'guessing', obs: ['a'] }] } };
  const out = applyPatch(previous, { keep: ['w1'], update: [{ id: 'h1', obs: ['d', 'a'] }, { id: 's1', text: 'charts for the site', obs: [] }, { id: 'zz', obs: ['x'] }], drop: [{ id: 'h2', reason: 'says what h1 says' }], add: { workingOn: [{ text: 'new stream', obs: ['d'] }], howWeWork: [], skills: [] } });
  assert.deepEqual(out.workingOn.map(e => e.text), ['old stream', 'new stream']);
  assert.deepEqual(out.howWeWork.map(e => e.text), ['never push main'], 'the drop removed the duplicate');
  assert.deepEqual(out.howWeWork[0].obs, ['a', 'b', 'd'], 'an update adds its observations once');
  assert.equal(out.skills[0].text, 'charts for the site'); assert.equal(out.skills[0].skill, 'dataviz', 'fields not named stay');
  assert.equal('whatFails' in out, false, 'a section that went is not carried');
  assert.deepEqual(applyPatch(null, { add: { workingOn: [{ text: 'x', obs: ['a'] }] } }).workingOn.length, 1, 'from nothing, every entry is an add');
  assert.deepEqual(applyPatch({ sections: { howWeWork: [{ text: 'no id', obs: ['a'] }] } }, {}).howWeWork.length, 0, 'an entry without an id cannot be kept by a patch (compileStep gives older profiles ids first)');
  const rows = [{ id: 'a', at: '2026-11-01T00:00:00Z', topics: ['proxy'], dirs: ['src'] }, { id: 'b', at: '2026-11-02T00:00:00Z', topics: ['site'], dirs: ['site'] }, { id: 'n', at: '2026-11-03T00:00:00Z', topics: ['Proxy'], dirs: [] }];
  assert.deepEqual(relatedCited(previous, [rows[2]], rows).map(r => r.id), ['a'], 'the evidence shown is what shares a topic or directory with the new rows');
});

test('a session end to end: observations into the ledger, a compile when due, the previous profile to history, and the block', async t => {
  const { dir, store } = tmpRepo(t, { learn: { mode: 'profile' } });
  assert.equal(profileConfig(store).enabled, true);
  const sections = { workingOn: [{ text: 'The report command grows a --since date flag', obs: [] }], howWeWork: [{ text: 'A --since flag takes a date, not a count of days', obs: [] }], skills: [] };
  let seen = null;
  const completeFn = async opts => {
    if (opts.schema?.properties?.observations) { seen = opts.prompt; return { json: { observations: [fakeObs(), fakeObs({ turn: 2, request: 'open the PR', outcome: 'accepted', reaction: 'good', lesson: '' }), fakeObs({ turn: 3, request: 'x', outcome: 'unknown' })] }, model: 'fake-opus', tokens: { totalTokens: 15 } }; }
    const ids = readLedger(store).map(r => r.id);
    assert.match(opts.prompt, /AGENTS\.md: Pull requests/, 'the compile sees the instruction files\' headings');
    assert.match(opts.prompt, /obs-[0-9a-f]{10} \| \d{4}-\d{2}-\d{2} \| outcome=corrected \| dirs=src,src\/commands/);
    assert.match(opts.prompt, /PROFILE SO FAR \(compiled never\)/);
    return { json: { keep: [], update: [], drop: [], add: { ...sections, workingOn: [{ ...sections.workingOn[0], obs: [ids[0]] }], howWeWork: [{ ...sections.howWeWork[0], obs: [ids[0]] }] } }, model: 'fake-opus', tokens: { totalTokens: 20 } };
  };
  const r = await profileSession(store, session, { session: 's1', client: 'claude', repoHint: dir, completeFn, have: ['claude'] });
  assert.equal(r.observations.length, 3);
  assert.ok(seen && !seen.includes('src/report.js') && seen.includes('[2] USER: No, it should take a date'), 'the extraction reads prompts and answers only');
  assert.ok(r.compiled, 'three observations make the first compile due');
  const p = readProfile(store);
  assert.equal(p.sections.workingOn.length, 1); assert.equal(p.sections.howWeWork[0].count, 1, 'one correction with the person\'s words carries a rule'); assert.equal(p.sections.howWeWork[0].id, 'h1'); assert.equal(p.window.sessions, 1); assert.equal(p.model, 'fake-opus'); assert.match(p.window.from, /^\d{4}-\d{2}-\d{2}$/);
  const block = profileBlock(store);
  assert.match(block.text, /^<thinker-profile>\n/); assert.match(block.text, /- A --since flag takes a date, not a count of days\n?/); assert.match(block.text, /from 1 session in this repository/);
  assert.deepEqual(block.ids, ['w1', 'h1'], 'the block names the entries it actually rendered');
  // a profile from before entries carried ids is patched all the same
  const v2 = readProfile(store); for (const s of SECTIONS) for (const e of v2.sections[s]) delete e.id;
  fs.writeFileSync(path.join(store.localDir, 'profile', 'profile.json'), JSON.stringify(v2));
  appendObservations(store, [fakeObs({ turn: 7, request: 'later' })], { session: 's2', now: Date.now() + 5000 });
  const v3 = await compileProfile(store, { now: Date.now() + 6000, completeFn: async opts => { assert.match(opts.prompt, /"id":"w1"/); return { json: { keep: ['w1', 'h1'], update: [], drop: [], add: { workingOn: [], howWeWork: [], skills: [] } }, model: 'fake-opus' }; }, have: ['claude'] });
  assert.equal(v3.profile.sections.workingOn.length, 1, 'the old entries are kept under the ids they were given');
  // nothing new since the compile: nothing to do, unless the whole window is asked for again
  assert.match((await compileProfile(store, { completeFn: async () => { throw new Error('not called'); }, have: ['claude'] })).skipped, /nothing new/);
  const c = await compileProfile(store, { full: true, completeFn: async () => ({ json: { keep: [], update: [], drop: [], add: { ...sections, workingOn: [], howWeWork: [] } }, model: 'fake-opus' }), have: ['claude'] });
  assert.equal(c.profile.sections.howWeWork.length, 0, 'a full compile starts from nothing');
  assert.equal(fs.readFileSync(path.join(store.localDir, 'profile', 'history.jsonl'), 'utf8').trim().split('\n').length, 2, 'each replaced profile is kept');
  const log = fs.readFileSync(path.join(dir, '.thinker', 'log.jsonl'), 'utf8');
  assert.match(log, /"op":"profile"/); assert.match(log, /"op":"profile-compile"/);
  assert.ok(!log.includes('takes a date'), 'the log carries counts, never the profile\'s text');
});

test('distillFile reads the session into the ledger; a turn-end batch waits for the end', async t => {
  const { dir, store } = tmpRepo(t, { learn: { mode: 'profile' } });
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, session.map(e => JSON.stringify(e)).join('\n') + '\n');
  const lines = [];
  const ctx = { repo: dir, store, out: l => lines.push(l) };
  let calls = 0, compiles = 0;
  const completeFn = async opts => { if (opts.schema?.properties?.observations) { calls++; return { json: { observations: [fakeObs()] }, model: 'fake-opus' }; } compiles++; return { json: { keep: [], update: [], drop: [], add: { workingOn: [], howWeWork: [], skills: [] } }, model: 'fake-opus' }; };
  await distillFile(ctx, file, { minExplore: 1, quiet: false, incremental: true, batch: true, session: 's9', completeFn });
  assert.equal(calls, 0, 'a batch at the end of a turn makes no call');
  await distillFile(ctx, file, { minExplore: 1, quiet: false, incremental: true, session: 's9', completeFn });
  assert.equal(calls, 1); assert.equal(compiles, 1, 'the first session with an observation compiles');
  assert.equal(readLedger(store).length, 1);
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
    const patch = first ? { keep: [], update: [], drop: [], add: { workingOn: [], howWeWork: [{ text: 'open the PR when done', obs: ids }], skills: [] } } : { keep: ['h1'], update: [{ id: 'h1', obs: ids }], drop: [], add: { workingOn: [], howWeWork: [], skills: [] } };
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
  await compileProfile(store, { now, have: ['claude'], completeFn: async () => ({ json: { keep: [], update: [], drop: [], add: { workingOn: [], howWeWork: [{ text: 'A --since flag takes a date', obs: readLedger(store).map(r => r.id) }], skills: [] } }, model: 'fake-opus' }) });
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n');
  const prev = process.env.THINKER_HOLDOUT; process.env.THINKER_HOLDOUT = '0'; t.after(() => { if (prev === undefined) delete process.env.THINKER_HOLDOUT; else process.env.THINKER_HOLDOUT = prev; });
  assert.equal(profileArm(store, 'any'), 'shown', 'no holdout: every session is shown');
  const first = profileTurn(store, 'sA', { transcript, client: 'claude' });
  assert.match(first, /^<thinker-profile>\n/); assert.match(first, /A --since flag takes a date/);
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
  assert.equal(h.shown.rate, 0.5, 'corrections stay on the report as a diagnostic');
  assert.equal(h.cost.verdict, 'too-early', 'with no priced session on either side there is nothing to compare');
  assert.equal(h.recurrence.verdict, 'too-early', 'and with no measured exchanges no recurrence either');
  // off: nothing, whatever the state
  fs.writeFileSync(path.join(dir, '.thinker', 'config.json'), '{}');
  assert.equal(profileTurn(new Store(dir), 'sD', {}), '', 'learn.mode off: no block');
});

// The profile's holdout is half the sessions, and the measure is the exchange (2026-11-08).
// The first question about a line is whether the agent used it (2026-11-08, the owner's ask).
test('a session is assessed per profile line it was shown: the ids it saw, the verdicts, and what applied', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-profile-lines-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.thinker'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.thinker', 'config.json'), JSON.stringify({ learn: { mode: 'profile' } }));
  const store = new Store(dir);
  const now = Date.now();
  appendObservations(store, [fakeObs()], { session: 's0', now });
  await compileProfile(store, { now, have: ['claude'], completeFn: async () => ({ json: { keep: [], update: [], drop: [], add: { workingOn: [{ text: 'Work in a worktree', obs: readLedger(store).map(r => r.id) }], howWeWork: [{ text: 'A --since flag takes a date', obs: readLedger(store).map(r => r.id) }], skills: [] } }, model: 'fake-opus' }) });
  // only what a session was actually shown may be judged on it
  const prev = process.env.THINKER_HOLDOUT; process.env.THINKER_HOLDOUT = '0';
  t.after(() => { if (prev === undefined) delete process.env.THINKER_HOLDOUT; else process.env.THINKER_HOLDOUT = prev; });
  const block = profileTurn(store, 'sA', { client: 'codex' });
  assert.match(block, /Work in a worktree/);
  assert.deepEqual(shownLines(store, 'sA').sort(), ['h1', 'w1'], 'the ids the session saw are kept on its state');
  assert.deepEqual(shownLines(store, 'never-served'), [], 'a session shown nothing has no lines');
  let asked = null;
  await profileSession(store, session, {
    session: 'sA', client: 'codex', compile: false, have: ['claude'],
    completeFn: async ({ prompt }) => { asked = prompt; return { json: { observations: [fakeObs()], lines: [
      { id: 'w1', verdict: 'followed', evidence: 'made a worktree first' },
      { id: 'h1', verdict: 'na', evidence: '' },
      { id: 'nope', verdict: 'followed', evidence: 'invented' },
      { id: 'w1', verdict: 'ignored', evidence: 'a second verdict on the same line' },
    ] }, model: 'fake-opus' }; },
  });
  assert.match(asked, /THE PROFILE THIS SESSION WAS SHOWN \(2 lines\)/, 'the call carries the lines it must judge');
  assert.match(asked, /\[w1\] - Work in a worktree/, 'with the id and the text the session saw');
  const v = readLineVerdicts(store);
  assert.deepEqual(v.map(r => [r.id, r.verdict]), [['w1', 'followed'], ['h1', 'na']], 'a line never shown is dropped, and the first verdict per line stands');
  assert.equal(v[0].session, 'sA'); assert.equal(v[0].evidence, 'made a worktree first');
  // the report: applied is the denominator, and 0 of 0 is untested, not failing
  appendLineVerdicts(store, [{ id: 'w1', verdict: 'ignored', evidence: 'did it in the main checkout' }, { id: 'h1', verdict: 'na' }], { session: 'sB', now });
  appendLineVerdicts(store, [{ id: 'w1', verdict: 'contradicted', evidence: 'the person had to say so' }], { session: 'sC', now });
  const rep = lineReport(store);
  const h1 = rep.lines.find(l => l.id === 'w1'), f1 = rep.lines.find(l => l.id === 'h1');
  assert.deepEqual([h1.shown, h1.followed, h1.ignored, h1.contradicted, h1.applied], [3, 1, 1, 1, 3]);
  assert.ok(Math.abs(h1.followRate - 1 / 3) < 1e-9, 'followed over the sessions the line applied in');
  assert.equal(f1.applied, 0); assert.equal(f1.followRate, null, '0 of 0 applied is an untested line, never a failing one');
  assert.equal(h1.section, 'workingOn'); assert.match(h1.text, /Work in a worktree/);
  assert.equal(h1.evidence.length, 3, 'the quotes behind every verdict that was not na');
  assert.equal(rep.sessions, 3); assert.equal(rep.applied, 3); assert.equal(rep.followed, 1);
  assert.ok(Math.abs(rep.followRate - 1 / 3) < 1e-9);
  // a line the profile no longer holds is marked, not dropped: its record is why it went
  assert.equal(h1.gone, false);
  appendLineVerdicts(store, [{ id: 'zz', verdict: 'ignored', evidence: 'x' }], { session: 'sD', now });
  assert.equal(lineReport(store).lines.find(l => l.id === 'zz').gone, true);
  // a session read again replaces its own rows, never counting a verdict twice
  appendLineVerdicts(store, [{ id: 'w1', verdict: 'followed' }], { session: 'sC', now });
  assert.equal(readLineVerdicts(store).filter(r => r.session === 'sC').length, 1);
  assert.deepEqual(LINE_VERDICTS, ['followed', 'ignored', 'contradicted', 'na']);
  // a session shown nothing is asked nothing about lines
  const r2 = await profileSession(store, session, { session: 'fresh', client: 'codex', compile: false, have: ['claude'], completeFn: async ({ prompt }) => { assert.ok(!/THE PROFILE THIS SESSION WAS SHOWN/.test(prompt)); return { json: { observations: [fakeObs()] }, model: 'fake-opus' }; } });
  assert.deepEqual(r2.lines, []);
});

// The lead metric: the person saying again what they said before (2026-11-08, the owner's call). Against the
// ledger and not the profile alone, since the profile is what survived the compile: a profile that learned nothing
// would be repeated against nothing and score perfectly.
test('recurrence is judged against everything said before, split by whether a line held it, and compared by arm', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-profile-recur-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.thinker'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.thinker', 'config.json'), JSON.stringify({ learn: { mode: 'profile' } }));
  const store = new Store(dir);
  const now = Date.now();
  // two earlier sessions: one preference the compile kept as a line, one lesson it never learned
  appendObservations(store, [fakeObs({ prefs: ['answer short and plain'], lesson: '' })], { session: 'old1', now: now - 2 * 86400_000 });
  appendObservations(store, [fakeObs({ prefs: [], lesson: 'Validate the fix in the installed app before calling it done' })], { session: 'old2', now: now - 86400_000 });
  await compileProfile(store, { now, have: ['claude'], completeFn: async () => ({ json: { keep: [], update: [], drop: [], add: { workingOn: [], howWeWork: [{ text: 'Answer short and plain', obs: readLedger(store).filter(r => r.session === 'old1').map(r => r.id) }], skills: [] } }, model: 'fake-opus' }) });
  const prior = priorStatements(store, { session: 'new', now });
  assert.equal(prior[0].id, 'h1'); assert.equal(prior[0].inProfile, true, 'the profile\'s lines come first');
  const lesson = prior.find(p => /installed app/.test(p.text));
  assert.ok(lesson && !lesson.inProfile, 'a statement the compile never learned is still something said before');
  assert.ok(!prior.some(p => /answer short and plain/i.test(p.text) && !p.inProfile), 'the same words are listed once, as the line');
  assert.deepEqual(priorStatements(store, { session: 'old1', now }).filter(p => p.id.startsWith('obs-')).map(p => p.text), [lesson.text], 'a session\'s own rows are not its own prior');
  // the extraction names what was said again, and the row keeps which kind
  let asked = null;
  const r = await profileSession(store, session, { session: 'new', client: 'codex', compile: false, have: ['claude'],
    completeFn: async ({ prompt }) => { asked = prompt; return { json: { observations: [
      fakeObs({ turn: 1, request: 'a', prefs: ['keep it short'], repeats: ['h1'] }),
      fakeObs({ turn: 2, request: 'b', lesson: 'test it in the real app', repeats: [lesson.id, 'made-up'] }),
      fakeObs({ turn: 3, request: 'c', repeats: [] }),
    ] }, model: 'fake-opus' }; } });
  assert.match(asked, /SAID BEFORE \(2;/, 'the call carries what was said before');
  assert.match(asked, /\[h1\] Answer short and plain/);
  assert.deepEqual(r.observations.map(o => o.repeats), [{ profile: ['h1'], ledger: [] }, { profile: [], ledger: [lesson.id] }, { profile: [], ledger: [] }], 'an id never offered is dropped');
  const rec = recurrence(r.observations);
  assert.deepEqual([rec.measured, rec.recurrences, rec.served, rec.unlearned], [3, 2, 1, 1]);
  assert.ok(Math.abs(rec.rate - 2 / 3) < 1e-9 && Math.abs(rec.servedRate - 1 / 3) < 1e-9);
  assert.equal(recurrence([{ repeats: { profile: ['h1'], ledger: ['x'] } }]).served, 1, 'a repeat of both kinds counts once, as served');
  assert.equal(recurrence(readLedger(store).filter(x => x.session === 'old1')).measured, 0, 'a row from before repeats were extracted is not measured');
  // the arms: served is the profile\'s to answer for, unlearned the compile\'s and the same on both sides
  const side = (n, served, unlearned) => ({ measured: n, servedRate: served / n, unlearnedRate: unlearned / n });
  assert.equal(compareRates(side(400, 20, 40), side(400, 60, 40)).verdict, 'fewer');
  assert.equal(compareRates(side(400, 60, 40), side(400, 20, 40)).verdict, 'more');
  assert.equal(compareRates(side(400, 40, 40), side(400, 44, 40)).verdict, 'inconclusive');
  assert.equal(compareRates(side(50, 2, 4), side(50, 10, 4)).verdict, 'too-early', 'the floor comes first');
  const c = compareRates(side(400, 20, 40), side(400, 60, 40));
  assert.ok(c.ci[0] < c.delta && c.delta < c.ci[1] && c.ci[1] < 0);
  assert.ok(Math.abs(c.relative + 2 / 3) < 1e-9, 'relative to the held-out rate');
  assert.deepEqual(c.unlearned, { shown: 0.1, holdout: 0.1 });
  const h = holdoutReport([...r.observations.map(o => ({ ...o, arm: 'shown', session: 'new' }))]);
  assert.equal(h.shown.recurrence.served, 1); assert.equal(h.recurrence.verdict, 'too-early');
});

test('the profile holdout is 50/50, and the report judges cost per exchange', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-profile-holdout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.thinker'), { recursive: true });
  const keep = { h: process.env.THINKER_HOLDOUT, p: process.env.THINKER_PROFILE_HOLDOUT };
  t.after(() => { for (const [k, v] of [['THINKER_HOLDOUT', keep.h], ['THINKER_PROFILE_HOLDOUT', keep.p]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  delete process.env.THINKER_HOLDOUT; delete process.env.THINKER_PROFILE_HOLDOUT;
  const store = d => { fs.writeFileSync(path.join(dir, '.thinker', 'config.json'), JSON.stringify(d)); return new Store(dir); };
  assert.equal(PROFILE.holdoutRate, 0.5, 'half, while it is being measured');
  assert.equal(profileHoldoutRate(store({})), 0.5, "not the notes' 15%");
  assert.equal(profileHoldoutRate(store({ holdout: 0.15 })), 0.5, "the notes' share does not reach the profile");
  assert.equal(profileHoldoutRate(store({ learn: { profileHoldout: 0.2 } })), 0.2, 'learn.profileHoldout moves it');
  assert.equal(profileHoldoutRate(store({ learn: { profileHoldout: false } })), 0, 'and false turns it off');
  process.env.THINKER_PROFILE_HOLDOUT = '0.3';
  assert.equal(profileHoldoutRate(store({ learn: { profileHoldout: 0.2 } })), 0.3, 'the variable wins over the config');
  process.env.THINKER_HOLDOUT = '0';
  assert.equal(profileHoldoutRate(store({})), 0, 'a harness turning every holdout off still turns this one off');
  delete process.env.THINKER_HOLDOUT; delete process.env.THINKER_PROFILE_HOLDOUT;
  // a share of sessions, both arms represented, and the same session always on the same side
  const s = store({});
  const arms = Array.from({ length: 400 }, (_, i) => profileArm(s, `sess-${i}`));
  const held = arms.filter(a => a === 'holdout').length;
  assert.ok(held > 150 && held < 250, `about half of 400 sessions held out, got ${held}`);
  assert.equal(profileArm(s, 'sess-7'), arms[7], 'the arm is the session\'s, every time it is asked');
  // a ratio of sums, never a mean of ratios: a cheap 1-exchange session may not outweigh a 9-exchange one
  const r = perExchange([{ exchanges: 1, tokens: 100, cost: 1, model: 'm' }, { exchanges: 9, tokens: 900, cost: 9, model: 'm' }]);
  assert.equal(r.tokens, 100, '1000 tokens over 10 exchanges, not the mean of 100 and 100');
  const skew = perExchange([{ exchanges: 1, tokens: 1000, cost: 1, model: 'm' }, { exchanges: 9, tokens: 900, cost: 9, model: 'm' }]);
  assert.equal(skew.tokens, 190, 'the ratio of the sums (1900/10); the mean of the ratios would be 550');
  // stratified by model and pooled by exchanges, so an arm's model mix cannot read as a saving
  const mix = perExchange([{ exchanges: 10, tokens: 1000, cost: 1, model: 'cheap' }, { exchanges: 10, tokens: 9000, cost: 9, model: 'dear' }]);
  assert.equal(mix.strata, 2); assert.equal(mix.tokens, 500, 'both strata weighted by their own exchanges');
  assert.equal(perExchange([{ exchanges: 2, tokens: 10, cost: 0, model: 'm' }]).cost, null, 'an unpriced stratum leaves no dollar figure, never a zero');
  assert.deepEqual(perExchange([]), { tokens: null, cost: null, exchanges: 0, strata: 0 });
  // the bootstrap resamples within a stratum, and is deterministic on a seed
  const units = Array.from({ length: 30 }, (_, i) => ({ exchanges: 3, tokens: 1000 + i * 100, cost: 1, model: i % 2 ? 'a' : 'b' }));
  const iv = ratioInterval(units, { boots: 400, seed: 3 });
  assert.ok(iv.se > 0 && iv.n === 400);
  assert.equal(ratioInterval(units, { boots: 400, seed: 3 }).se, iv.se, 'the same seed gives the same interval');
  assert.equal(ratioInterval([units[0]]), null, 'one session is no interval');
  // the verdict is the interval's, and the floor comes first
  const arm = (tokens, se, priced = 40) => ({ tokens, rate: null, priced, interval: { se } });
  assert.equal(compare(arm(100, 2), arm(130, 2)).verdict, 'cheaper');
  assert.equal(compare(arm(130, 2), arm(100, 2)).verdict, 'costlier', 'costing more per exchange is a result too');
  assert.equal(compare(arm(100, 20), arm(105, 20)).verdict, 'inconclusive', 'a straddling interval concludes nothing');
  assert.equal(compare(arm(100, 2, 5), arm(130, 2, 5)).verdict, 'too-early', 'the floor comes before the interval');
  const c = compare(arm(100, 2), arm(130, 2));
  assert.ok(c.ci[0] < c.delta && c.delta < c.ci[1] && c.ci[1] < 0, 'the interval brackets the difference');
  assert.ok(Math.abs(c.relative + 30 / 130) < 1e-9, 'relative is the difference over the held-out arm');
  assert.equal(compare(arm(null, null), arm(100, 2)).verdict, 'too-early', 'no measured arm, no verdict');
});

test('a full compile from nothing is due again after rebaseDays, and rebasedAt is carried by the patches between', async t => {
  const { store } = tmpRepo(t);
  const now = Date.now();
  const calls = [];
  const completeFn = async opts => { calls.push(/PROFILE SO FAR \(compiled never\)/.test(opts.prompt) ? 'full' : 'patch'); return { json: { keep: [], update: [], drop: [], add: { workingOn: [{ text: 'x', obs: readLedger(store).map(r => r.id) }], howWeWork: [], skills: [] } }, model: 'fake-opus' }; };
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
  await compileProfile(store, { now, have: ['claude'], completeFn: async () => ({ json: { keep: [], update: [], drop: [], add: { workingOn: [{ text: 'The report command grows a --since flag', obs: readLedger(store).map(r => r.id) }], howWeWork: [], skills: [] } }, model: 'fake-opus' }) });
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

test('skills: an exchange\'s Skill calls and typed skills ride with its observations, and a skills line rests on them', () => {
  const evs = [
    { t: 'prompt', text: '<command-name>/code-review</command-name>\n<command-message>code-review</command-message>\n<command-args>high</command-args>' },
    { t: 'say', text: 'Two findings.' },
    { t: 'prompt', text: '<command-name>/clear</command-name><command-message>clear</command-message><command-args></command-args>' },
    { t: 'prompt', text: 'now price the models' },
    { t: 'tool', name: 'Skill', input: { skill: 'claude-api', args: 'pricing' }, result: 'x' },
    { t: 'tool', name: 'Skill', input: { skill: 'claude-api' }, result: 'x' },
    { t: 'say', text: 'Priced.' },
    { t: 'prompt', text: 'now the chart' },
    { t: 'tool', name: 'skill', input: { name: 'dataviz' }, result: 'x' },
    { t: 'say', text: 'Charted.' },
    { t: 'prompt', text: 'thanks' }, { t: 'say', text: 'ok' },
  ];
  const xs = exchanges(evs);
  assert.deepEqual(xs.map(x => x.prompt), ['/code-review high', 'now price the models', 'now the chart', 'thanks'], 'a typed skill is a prompt of its own; a built-in command makes no exchange');
  assert.deepEqual(xs[0].skills, [{ name: 'code-review', by: 'person' }]);
  assert.deepEqual(xs[1].skills, [{ name: 'claude-api', by: 'agent' }], 'two calls of one skill in one exchange are one use');
  assert.deepEqual(xs[2].skills, [{ name: 'dataviz', by: 'agent' }], 'opencode\'s lowercase skill call, the skill in input.name');
  assert.match(extractionInput(xs), /SKILLS: \/claude-api \(called by the agent\)/);
  assert.ok(!extractionInput(xs).includes('pricing'), 'the call\'s arguments never reach the extraction');
  const obs = observationSkills([{ turn: 3, request: 'b' }, { turn: 2, request: 'a' }], xs);
  assert.deepEqual(obs.map(o => o.skills.map(k => k.name)), [['dataviz'], ['claude-api']], 'in the caller\'s order, each over the exchanges up to the next observation');
  assert.deepEqual(obs.map(o => o.interrupts), [0, 0]);
  const now = Date.now();
  const rows = [
    { id: 'a', at: iso(now, 3), session: 's1', outcome: 'accepted', request: 'r', skills: [{ name: 'claude-api', by: 'agent' }], prefs: [] },
    { id: 'b', at: iso(now, 2), session: 's2', outcome: 'corrected', request: 'r', skills: [{ name: 'claude-api', by: 'agent' }], prefs: [] },
    { id: 'c', at: iso(now, 1), session: 's3', outcome: 'unknown', request: 'r', skills: [], prefs: ['always run /code-review before a PR'] },
    { id: 'd', at: iso(now, 1), session: 's4', outcome: 'accepted', request: 'r', skills: [{ name: 'dataviz', by: 'agent' }], prefs: [] },
  ];
  const s = settle({ skills: [
    { skill: 'claude-api', text: 'pricing lookups', obs: ['a', 'b'] },
    { skill: '/code-review', text: 'wanted before every PR', obs: ['c'] },
    { skill: 'dataviz', text: 'charts', obs: ['d'] },
    { skill: 'made-up', text: 'x', obs: ['a'] },
  ] }, rows, { now });
  assert.deepEqual(s.skills.map(e => [e.id, e.skill, e.count, e.used, e.accepted, e.corrected]), [['s1', 'claude-api', 2, 2, 1, 1], ['s2', 'code-review', 1, 0, 0, 0]],
    'two sessions, or the person naming the skill; one session of use is not enough; a skill no cited observation ran or named does not exist');
  const text = renderProfile({ compiledAt: iso(now, 0), window: { sessions: 4 }, sections: { ...Object.fromEntries(SECTIONS.map(k => [k, []])), skills: s.skills } });
  assert.match(text, /## Skills\n- \/claude-api: pricing lookups\n- \/code-review: wanted before every PR$/, 'the served line is the text; the tallies are --why\'s');
  assert.deepEqual([s.skills[0].used, s.skills[0].accepted, s.skills[0].corrected], [2, 1, 1], 'and the tallies are still on the entry');
  assert.match(ledgerText(rows.slice(0, 1)), /skills: \/claude-api \(agent\)/);
  assert.match(skillTallyText(rows), /^- \/claude-api: 2 sessions, 2 observations; accepted 1, corrected 1$/m);
  assert.equal(applyPatch({ sections: { workingOn: [] } }, { add: { skills: [{ skill: 'x', text: 'y', obs: ['a'] }] } }).skills.length, 1, 'a profile from before the section takes adds to it');
});

// The person stopping the agent is the sharpest correction a session records, and until 2026-11-08 it arrived as a
// USER line the extractor was told was nobody speaking (216 of them in this checkout's transcripts).
test('an interruption marks the exchange it cut short, reaches the extraction, rides with the observation and carries a rule on its own', () => {
  const evs = [
    { t: 'prompt', text: 'rename the flag everywhere' },
    { t: 'say', text: 'Renaming in src and the docs…' },
    { t: 'interrupt', at: Date.parse('2026-11-01T10:00:00Z') },
    { t: 'prompt', text: 'no, only in src; the docs are generated' },
    { t: 'say', text: 'Done in src only.' },
    { t: 'prompt', text: '[Request interrupted by user for tool use]' },
    { t: 'prompt', text: 'good, now the test' },
    { t: 'say', text: 'Added.' },
  ];
  const xs = exchanges(evs);
  assert.deepEqual(xs.map(x => x.prompt), ['rename the flag everywhere', 'no, only in src; the docs are generated', 'good, now the test'], 'an interruption, as an event or as its marker text, is never an exchange');
  assert.deepEqual(xs.map(x => !!x.interrupted), [true, true, false]);
  assert.equal(xs[0].at, Date.parse('2026-11-01T10:00:00Z'), 'the interruption\'s stamp dates an unstamped exchange like any event');
  const text = extractionInput(xs);
  assert.match(text, /\[1\] USER: rename the flag everywhere\n    AGENT: Renaming in src and the docs…\n    INTERRUPTED: the person stopped the agent here, before it finished\n/);
  assert.equal((text.match(/INTERRUPTED/g) || []).length, 2);
  assert.ok(!text.includes('[Request interrupted'), 'the marker never reaches the extraction as words');
  const obs = observationSkills([{ turn: 1, request: 'rename' }, { turn: 3, request: 'test' }], xs);
  assert.deepEqual(obs.map(o => o.interrupts), [2, 0], 'attached by code over the exchanges the observation spans');
  assert.match(ledgerText([{ id: 'a', at: '2026-11-01T00:00:00Z', outcome: 'corrected', request: 'r', interrupts: 2 }]), /\| outcome=corrected \| interrupted by the person x2/);
  assert.ok(!ledgerText([{ id: 'a', at: '2026-11-01T00:00:00Z', outcome: 'accepted', request: 'r', interrupts: 0 }]).includes('interrupted'));
  assert.equal(exchanges([{ t: 'interrupt' }, { t: 'prompt', text: 'hi' }, { t: 'say', text: 'x' }]).length, 1, 'an interruption before any prompt is nothing');
});

// Directories are the repository's, whichever checkout the session ran in (2026-11-08): the store's own path was
// the only thing stripped, so worktree and scratch paths labelled rows `/Users` and `/private`.
test('session directories are relative to the repository across its worktrees, drop a worktree that is gone, and ignore other repositories', t => {
  const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-dirs-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
  const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
  const repo = mk(), other = mk(), nowhere = mk();
  git(repo, 'init', '-q'); git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(other, 'init', '-q');
  const wt = path.join(repo, '.worktrees', 'live');
  fs.mkdirSync(path.dirname(wt), { recursive: true }); git(repo, 'worktree', 'add', '-q', wt);
  const tool = p => ({ t: 'tool', name: 'Read', input: { file_path: p }, result: '' });
  const events = [
    tool(path.join(repo, 'src', 'a.js')),                               // the main checkout
    tool(path.join(wt, 'src', 'commands', 'b.js')),                     // a live worktree
    tool(path.join(repo, '.worktrees', 'gone', 'src', 'ui', 'c.js')),   // a worktree removed since the session
    tool(path.join(other, 'src', 'd.js')),                              // another repository
    tool(path.join(nowhere, 'scratch', 'e.js')),                        // no repository at all
    tool('test/f.test.js'),                                             // relative: the repository's own
    tool(path.join(repo, 'README.md')),                                 // not code
    { t: 'tool', name: 'Bash', input: { command: 'ls src/proxy' }, result: '' },
  ];
  assert.deepEqual(sessionDirs(events, repo), ['src', 'src/commands', 'src/ui', 'test']);
  assert.deepEqual(sessionDirs(events, wt), ['src', 'src/commands', 'src/ui', 'test'], 'the store may be the worktree itself: the repository is the same');
  assert.deepEqual(sessionDirs(events, fs.realpathSync(repo)), ['src', 'src/commands', 'src/ui', 'test'], 'real and given paths place alike');
  assert.deepEqual(sessionDirs([tool(path.join(other, 'src', 'd.js'))], other), ['src'], 'the other repository\'s own paths are its own');
  assert.deepEqual(sessionDirs(events), ['src', 'src/commands', 'src/ui', 'test'], 'with no repository given, any checkout places its own paths');
});
