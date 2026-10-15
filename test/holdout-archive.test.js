// Measuring what the notes do, and serving less of what they showed does nothing: the holdout
// (a share of prompts the hooks serve nothing), the per-turn session stats behind the comparison, and
// archiving notes out of serving and upkeep while review keeps them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { rank } from '../src/rank.js';
import { createNote, orient, lookup, lateNotes, rememberTask, outcome, holdoutDecision, beginTurn, holdoutTurn, holdoutRate, archiveNotes, archiveReason, ARCHIVE_DEFAULTS } from '../src/ops.js';
import { maintain, pickStale, DEFAULTS, MAINTENANCE_INTERVAL_MS } from '../src/maintain.js';
import { holdoutSummary, renderHoldout, summarize, renderUsage, weeklyNotice, weeklyLine, isoWeek } from '../src/usage.js';
import { parseTranscript } from '../src/transcripts.js';
import { holdoutMetrics, buildTelemetryPayload } from '../src/telemetry.js';

process.env.THINKER_TELEMETRY = 'off';
const CLI = new URL('../src/cli.js', import.meta.url).pathname;
const git = (repo, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
function gitRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-holdout-')));
  git(dir, 'init', '-q');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/a.js'), 'export function fetchRows() {\n  return 1;\n}\n\nexport function saveRows() {\n  return 2;\n}\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
function withEnv(vars, fn) {
  const prev = {}; for (const k in vars) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  return Promise.resolve().then(fn).finally(() => { for (const k in prev) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } });
}
const logLines = store => fs.existsSync(path.join(store.dir, 'log.jsonl')) ? fs.readFileSync(path.join(store.dir, 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];

test('the holdout is a deterministic share of turns, opened by the prompt hook and read by the later hooks; off by env or config; never for an unknown session', () => withEnv({ THINKER_HOLDOUT: undefined }, () => {
  const store = new Store(gitRepo()).init();
  assert.equal(holdoutRate(store), 0.15);
  const turns = []; for (let s = 0; s < 20; s++) for (let t = 1; t <= 10; t++) turns.push([`session-${s}`, t]);
  const held = turns.filter(([s, t]) => holdoutDecision(store, s, t));
  assert.ok(held.length > 10 && held.length < 50, `about 15%: ${held.length} of 200`);
  assert.deepEqual(turns.filter(([s, t]) => holdoutDecision(store, s, t)), held, 'the same turns every time');
  assert.ok(held.some(([s, t]) => t > 1) && held.some(([, t]) => t === 1), 'turns, not sessions, are held out');
  const bySession = new Map(); for (const [s] of held) bySession.set(s, (bySession.get(s) || 0) + 1);
  assert.ok([...bySession.values()].every(n => n < 10), 'no session is held out whole');
  assert.equal(holdoutDecision(store, 'unknown', 1), false); assert.equal(holdoutDecision(store, undefined, 1), false); assert.equal(holdoutDecision(store, 'x', 0), false);
  // the prompt hook opens a turn; the tool and stop hooks of that turn read the same decision
  process.env.THINKER_HOLDOUT = '1';
  assert.deepEqual(beginTurn(store, 's'), { turn: 1, holdout: true });
  assert.deepEqual(holdoutTurn(store, 's'), { turn: 1, holdout: true });
  process.env.THINKER_HOLDOUT = 'off'; assert.equal(holdoutRate(store), 0);
  assert.deepEqual(beginTurn(store, 's'), { turn: 2, holdout: false });
  assert.deepEqual(holdoutTurn(store, 's'), { turn: 2, holdout: false }, 'a turn is what the prompt hook left');
  assert.deepEqual(holdoutTurn(store, 'never-prompted'), { turn: 0, holdout: false });
  assert.deepEqual(beginTurn(store, 'unknown'), { turn: 0, holdout: false });
  delete process.env.THINKER_HOLDOUT;
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ holdout: false }));
  assert.equal(holdoutRate(new Store(store.repo)), 0);
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ holdout: 0.5 }));
  assert.equal(holdoutRate(new Store(store.repo)), 0.5);
}));

test('a held-out orient serves nothing, marks nothing served, and logs what it withheld with the turn', () => withEnv({ THINKER_LOG: 'local', THINKER_HOLDOUT: undefined, THINKER_NO_BG_VERIFY: '1' }, async () => {
  const store = new Store(gitRepo()).init();
  createNote(store, { title: 'fetchRows reads the rows table', kind: 'callpath', answers: ['how are rows fetched', 'where does fetchRows read from'], body: 'src/a.js:fetchRows reads the rows table and returns them', deps: [{ path: 'src/a.js', symbol: 'fetchRows' }] });
  const task = 'where does fetchRows read the rows from';
  const held = await orient(store, { task, session: 's1', client: 'claude', holdout: true, turn: 3 });
  assert.equal(held.text, ''); assert.equal(held.included.length, 0); assert.equal(held.holdout, true);
  assert.equal(held.withheld.length, 1, 'what would have been served is known');
  const n = store.list()[0];
  assert.equal(n.uses || 0, 0, 'not counted as served'); assert.deepEqual(n.servedIn || [], []);
  const line = logLines(store).find(l => l.op === 'orient');
  assert.equal(line.holdout, true); assert.equal(line.turn, 3); assert.deepEqual(line.served, []); assert.deepEqual(line.withheld, [n.id]);
  // the same request on a served turn of another session gets the note
  const served = await orient(store, { task, session: 's2', client: 'claude', turn: 1 });
  assert.equal(served.included.length, 1);
  assert.equal(logLines(store).filter(l => l.op === 'orient').pop().turn, 1);
}));

test('the hooks of a held-out turn serve nothing, and every stop logs the session stats with the turn number', () => withEnv({ THINKER_LOG: 'local', THINKER_HOLDOUT: '1', THINKER_NO_BG_VERIFY: '1', THINKER_NO_LEARN: '1' }, async () => {
  const dir = gitRepo(); const store = new Store(dir).init();
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ ...store.config(), minNotes: 1 })); // one note serves here (ops.js:SERVE_MIN_NOTES)
  createNote(store, { title: 'fetchRows reads the rows table', kind: 'gotcha', answers: ['how are rows fetched'], body: 'src/a.js:fetchRows reads the rows table; saveRows must run after it', deps: [{ path: 'src/a.js', symbol: 'fetchRows' }] });
  const env = { ...process.env };
  const transcript = path.join(dir, 'h1.jsonl');
  const row = j => JSON.stringify(j) + '\n';
  const turn = (prompt, answer, input) => row({ type: 'user', message: { role: 'user', content: prompt } })
    + row({ type: 'assistant', message: { model: 'claude-test-1', usage: { input_tokens: input, cache_read_input_tokens: 900 }, content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/a.js' } }] } })
    + row({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'export function fetchRows' }] } })
    + row({ type: 'assistant', message: { model: 'claude-test-1', usage: { input_tokens: 50, cache_read_input_tokens: 1950 }, content: [{ type: 'text', text: answer }] } });
  const prompt = execFileSync('node', [CLI, 'hook', 'prompt', '--repo', dir], { input: JSON.stringify({ session_id: 'h1', prompt: 'where does fetchRows read the rows from' }), encoding: 'utf8', env });
  assert.equal(prompt.trim(), '', 'nothing injected');
  const tool = execFileSync('node', [CLI, 'hook', 'tool', '--repo', dir], { input: JSON.stringify({ session_id: 'h1', tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/a.js') } }), encoding: 'utf8', env });
  assert.equal(tool.trim(), '', 'no late notes either');
  fs.writeFileSync(transcript, turn('where does fetchRows read the rows from', 'it reads the rows table', 100));
  execFileSync('node', [CLI, 'hook', 'stop', '--no-distill', '--repo', dir], { input: JSON.stringify({ session_id: 'h1', transcript_path: transcript }), encoding: 'utf8', env });
  // a second turn, served (the share is 1, so held out again): the stop line carries the cost so far and turn 2
  execFileSync('node', [CLI, 'hook', 'prompt', '--repo', dir], { input: JSON.stringify({ session_id: 'h1', prompt: 'and saveRows?' }), encoding: 'utf8', env });
  fs.appendFileSync(transcript, turn('and saveRows?', 'after it', 500));
  execFileSync('node', [CLI, 'hook', 'stop', '--no-distill', '--repo', dir], { input: JSON.stringify({ session_id: 'h1', transcript_path: transcript }), encoding: 'utf8', env });
  const lines = logLines(store);
  const o = lines.find(l => l.op === 'orient'); assert.equal(o.holdout, true); assert.equal(o.turn, 1); assert.equal(o.withheld.length, 1);
  const s = lines.filter(l => l.op === 'session');
  assert.equal(s.length, 2, 'a session line per stop');
  assert.equal(s[0].turn, 1); assert.equal(s[0].holdout, true); assert.equal(s[0].model, 'claude-test-1');
  assert.equal(s[0].toolCalls, 1); assert.equal(s[0].turns, 2); assert.equal(s[0].inputTokens, 3000, 'input, cache reads and cache writes of every turn');
  assert.equal(s[1].turn, 2); assert.equal(s[1].toolCalls, 2); assert.equal(s[1].inputTokens, 6400, 'the session so far, not the turn');
  const stats = parseTranscript(transcript).stats;
  assert.deepEqual(stats, { toolCalls: 2, turns: 4, inputTokens: 6400, outputTokens: null, cacheReadTokens: 5700, cacheWriteTokens: null, totalTokens: null, tokenCoverage: 'partial' });
  // the comparison reads the two turns: turn 1 cost 3000, turn 2 cost 3400
  const h = summarize(store, {}).holdout;
  assert.equal(h.heldOut.prompts, 1, 'turn 2 withheld nothing new (the note was withheld on turn 1 and is not served twice): on neither side');
  assert.equal(h.noNotes, 1);
  assert.deepEqual(h.heldOut.sums, { toolCalls: 1, turns: 2, inputTokens: 3000, outputTokens: 0 });
}));

test('usage compares served and held-out turns by what the transcript grew by, and says when there are too few', () => {
  const lines = new Map(), turns = new Map();
  // 12 sessions of 4 turns; the hooks held out turn 3 of every third session; a held-out turn costs twice a served one
  for (let i = 0; i < 12; i++) {
    const k = `o|s${i}`, L = new Map(), T = new Map();
    let cost = 0;
    for (let t = 1; t <= 4; t++) {
      const holdout = i % 3 === 0 && t === 3;
      const c = holdout ? 2_000_000 : 1_000_000;
      cost += c;
      L.set(t, { op: 'session', session: `s${i}`, model: t === 4 ? 'n' : 'm', toolCalls: 10 * t + (i % 3 === 0 && t >= 3 ? 10 : 0), inputTokens: cost, turns: 5 * t });
      T.set(t, { served: holdout ? 0 : 2, withheld: holdout ? 2 : 0, holdout, corrected: holdout && i === 0 });
    }
    lines.set(k, L); turns.set(k, T);
  }
  // a turn with nothing to serve either way; a turn whose stop line is missing; a turn whose previous line is missing
  turns.get('o|s1').set(5, { served: 0, withheld: 0, holdout: true });
  turns.get('o|s2').set(5, { served: 1, withheld: 0, holdout: false });
  turns.get('o|s4').set(6, { served: 1, withheld: 0, holdout: false }); lines.get('o|s4').set(6, { model: 'm', toolCalls: 99, inputTokens: 9e9, turns: 1 });
  const h = holdoutSummary(lines, turns);
  assert.equal(h.served.prompts, 44); assert.equal(h.heldOut.prompts, 4); assert.equal(h.sessions, 12);
  assert.equal(h.noNotes, 1, 'nothing to serve: on neither side'); assert.equal(h.unmeasured, 2, 'a missing stop line, and a missing previous line');
  assert.equal(h.served.perPrompt.inputTokens, 1_000_000); assert.equal(h.heldOut.perPrompt.inputTokens, 2_000_000);
  assert.equal(h.served.perPrompt.toolCalls, 10, 'the turn\'s own tool calls, not the session\'s');
  assert.equal(h.heldOut.perPrompt.toolCalls, 20);
  assert.equal(h.deltaPct.inputTokens, -50); assert.equal(h.deltaPct.toolCalls, -50);
  assert.equal(h.saved.inputTokens, 44_000_000, '(held-out − served) per prompt × served prompts');
  assert.equal(h.heldOut.corrected, 1); assert.equal(h.served.corrected, 0);
  assert.deepEqual(Object.keys(h.byModel).sort(), ['m', 'n']); assert.equal(h.byModel.n.served.prompts, 12); assert.equal(h.byModel.n.heldOut.prompts, 0);
  assert.equal(h.enough, false);
  const text = renderHoldout(h).join('\n');
  assert.match(text, /too few to compare yet: at least 20 prompts/); assert.match(text, /44 served notes, 4 held out with notes withheld, in 12 sessions/);
  // sixteen more held-out turns and both sides have twenty
  for (let i = 12; i < 28; i++) {
    const k = `o|s${i}`;
    lines.set(k, new Map([[1, { model: 'm', toolCalls: 20, inputTokens: 2_000_000, turns: 5 }]]));
    turns.set(k, new Map([[1, { served: 0, withheld: 1, holdout: true }]]));
  }
  const h2 = holdoutSummary(lines, turns);
  assert.equal(h2.enough, true); assert.equal(h2.heldOut.prompts, 20);
  const t2 = renderHoldout(h2).join('\n');
  assert.match(t2, /tool calls\s+10 per prompt served vs 20 held out \(-50% with notes\)/);
  assert.match(t2, /input tokens\s+1M per prompt served vs 2M held out \(-50% with notes\)/);
  assert.match(t2, /saved\s+about 44M input tokens less across the 44 served prompts/);
  assert.match(t2, /corrections\s+0% of served prompts were followed by a correction, 5% of held-out/);
  assert.match(t2, /^  m\s+32 vs 20 prompts/m);
});

test('usage reads turn, session and outcome lines from the log into the summary', () => withEnv({ THINKER_LOG: 'local', THINKER_HOLDOUT: undefined, THINKER_NO_BG_VERIFY: '1' }, async () => {
  const store = new Store(gitRepo()).init();
  createNote(store, { title: 'fetchRows reads the rows table', kind: 'callpath', answers: ['how are rows fetched'], body: 'src/a.js:fetchRows reads the rows table', deps: [{ path: 'src/a.js', symbol: 'fetchRows' }] });
  await orient(store, { task: 'how are rows fetched by fetchRows', session: 'a', client: 'claude', turn: 1 });
  store.log({ op: 'session', session: 'a', turn: 1, model: 'm', toolCalls: 3, inputTokens: 1000, turns: 2 });
  await orient(store, { task: 'how are rows fetched by fetchRows', session: 'a', client: 'claude', turn: 2, holdout: true });
  outcome(store, { session: 'a', turn: 1, positive: false, reason: 'correction prompt: no, the other one' });
  store.log({ op: 'session', session: 'a', turn: 2, model: 'm', toolCalls: 9, inputTokens: 4000, turns: 6 });
  const u = summarize(store, {});
  assert.equal(u.holdout.served.prompts, 1); assert.equal(u.holdout.heldOut.prompts, 1); assert.equal(u.holdout.sessions, 1);
  assert.equal(u.holdout.served.perPrompt.toolCalls, 3); assert.equal(u.holdout.heldOut.perPrompt.toolCalls, 6, 'turn 2 less turn 1');
  assert.equal(u.holdout.heldOut.perPrompt.inputTokens, 3000);
  assert.equal(u.holdout.served.corrected, 1, 'the correction was about turn 1');
  assert.match(renderUsage(u, {}), /Holdout/);
  assert.equal(u.servings.prompt, 1, 'a withheld note is not a serving');
}));

test('telemetry carries the holdout as sums and prompt counts per side over 30 days, and nothing from an opted-out repository', () => withEnv({ THINKER_LOG: 'local', THINKER_HOLDOUT: undefined, THINKER_NO_BG_VERIFY: '1' }, async () => {
  const store = new Store(gitRepo()).init();
  createNote(store, { title: 'fetchRows reads the rows table', kind: 'callpath', answers: ['how are rows fetched'], body: 'src/a.js:fetchRows reads the rows table', deps: [{ path: 'src/a.js', symbol: 'fetchRows' }] });
  for (const [session, holdout] of [['a', false], ['b', true], ['c', false]]) await orient(store, { task: 'how are rows fetched by fetchRows', session, client: 'claude', holdout, turn: 1 });
  store.log({ op: 'session', session: 'a', turn: 1, client: 'claude', model: 'm', toolCalls: 3, inputTokens: 1000, outputTokens: 10, turns: 2 });
  store.log({ op: 'session', session: 'b', turn: 1, client: 'claude', model: 'm', toolCalls: 6, inputTokens: 3000, outputTokens: 30, turns: 4 });
  store.log({ op: 'session', session: 'c', turn: 1, client: 'copilot', model: 'n', toolCalls: 5, inputTokens: null, outputTokens: null, turns: 1 }); // a transcript without usage
  const h = holdoutMetrics(store, { all: false });
  assert.equal(h.schemaVersion, 2); assert.equal(h.unit, 'prompt'); assert.equal(h.windowDays, 30);
  assert.deepEqual(h.served, { prompts: 2, sessions: 2, corrected: 0, sums: { toolCalls: 8, turns: 3, inputTokens: 1000, outputTokens: 10 }, measured: { toolCalls: 2, turns: 2, inputTokens: 1, outputTokens: 1 } });
  assert.deepEqual(h.heldOut, { prompts: 1, sessions: 1, corrected: 0, sums: { toolCalls: 6, turns: 4, inputTokens: 3000, outputTokens: 30 }, measured: { toolCalls: 1, turns: 1, inputTokens: 1, outputTokens: 1 } });
  assert.deepEqual(Object.keys(h.byModel).sort(), ['m', 'n']);
  assert.equal(h.byModel.m.heldOut.sums.inputTokens, 3000); assert.equal(h.byModel.n.served.measured.inputTokens, 0);
  assert.deepEqual(Object.keys(h.byClientModel).sort(), ['claude|m', 'copilot|n'], 'harness and model together');
  assert.equal(h.byClientModel['claude|m'].served.prompts, 1); assert.equal(h.byClientModel['claude|m'].heldOut.prompts, 1);
  // numbers and model names only
  assert.doesNotMatch(JSON.stringify(h), /fetchRows|thinker-holdout-|"a"|"b"/);
  assert.deepEqual(buildTelemetryPayload(store, { all: false, home: path.join(store.repo, 'home') }).holdout, h);
  assert.equal(holdoutMetrics(store, { all: false, now: Date.now() + 31 * 86400_000 }).served.prompts, 0, 'older than the window');
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ telemetry: false }));
  const off = holdoutMetrics(store, { all: false });
  assert.equal(off.served.prompts, 0); assert.equal(off.heldOut.prompts, 0);
}));

test('archiving: kinds the sessions never acted on, and notes unserved for a month; rank, lookup, late notes and verification skip them; review keeps them', () => withEnv({ THINKER_LOG: 'local', THINKER_NO_BG_VERIFY: '1' }, async () => {
  const store = new Store(gitRepo()).init();
  const loc = createNote(store, { title: 'fetchRows is defined in src/a.js', kind: 'location', answers: ['where is fetchRows defined'], body: 'src/a.js:fetchRows is the reader', deps: [{ path: 'src/a.js', symbol: 'fetchRows' }] }).note;
  const rule = createNote(store, { title: 'saveRows must run after fetchRows', kind: 'gotcha', answers: ['order of saveRows and fetchRows'], body: 'src/a.js:saveRows after src/a.js:fetchRows, or rows are lost', deps: [{ path: 'src/a.js', symbol: 'saveRows' }] }).note;
  const old = createNote(store, { title: 'fetchRows returns one', kind: 'callpath', answers: ['what fetchRows returns'], body: 'src/a.js:fetchRows returns 1', deps: [{ path: 'src/a.js', symbol: 'fetchRows' }] }).note;
  const oldUsed = createNote(store, { title: 'saveRows returns two', kind: 'callpath', answers: ['what saveRows returns'], body: 'src/a.js:saveRows returns 2', deps: [{ path: 'src/a.js', symbol: 'saveRows' }] }).note;
  const month = 31 * 86400_000;
  for (const n of [old, oldUsed]) { n.created = new Date(Date.now() - month).toISOString(); store.put(n); }
  oldUsed.uses = 1; store.put(oldUsed);
  assert.deepEqual(ARCHIVE_DEFAULTS.kinds, []); // since the kinds were collapsed to four, no kind is archived by default
  const byKind = { ...ARCHIVE_DEFAULTS, kinds: ['map'] };
  assert.equal(archiveReason(loc, byKind), 'kind map');
  assert.equal(archiveReason(store.get(rule.id), byKind), null, 'a rule stays in serving');
  assert.equal(archiveReason(store.get(old.id), ARCHIVE_DEFAULTS), 'not served in 30 days');
  assert.equal(archiveReason(store.get(oldUsed.id), ARCHIVE_DEFAULTS), null, 'served once: kept');
  const dry = archiveNotes(store, { dry: true });
  assert.deepEqual(dry.map(d => d.id), [old.id]);
  assert.ok(!store.get(old.id).archived, 'dry run writes nothing');
  const done = archiveNotes(store, {});
  assert.equal(done.length, 1);
  assert.equal(store.get(old.id).archived.reason, 'not served in 30 days');
  archiveNotes(store, { ids: [loc.id] }); // by request, for the checks below
  assert.equal(archiveNotes(store, {}).length, 0, 'idempotent');
  assert.equal(logLines(store).filter(l => l.op === 'archive').length, 2); // the rules once, the request once
  // out of ranking and orientation
  const ranked = rank(store.list(), { query: 'where is fetchRows defined', mode: 'orient' });
  assert.ok(!ranked.some(r => r.note.id === loc.id), 'archived note is not ranked');
  const o = await orient(store, { task: 'where is fetchRows defined', session: 's', client: 'claude' });
  assert.ok(!o.included.some(n => n.id === loc.id) && !o.more.some(n => n.id === loc.id));
  // lookup by its id still answers; lookup by words does not find it
  assert.equal((await lookup(store, { query: loc.id })).included[0]?.id, loc.id);
  assert.ok(!(await lookup(store, { query: 'where is fetchRows defined' })).included.some(n => n.id === loc.id));
  // the edit hook does not serve an archived rule note
  const cc = createNote(store, { title: 'rows go with their index', kind: 'rule', answers: ['what changes with src/a.js'], body: 'src/a.js changes with its index through the generator', deps: [{ path: 'src/a.js' }] }).note;
  archiveNotes(store, { ids: [cc.id] });
  rememberTask(store, 'e1', 'change saveRows and what changes with src/a.js');
  const late = lateNotes(store, { session: 'e1', client: 'claude', files: ['src/a.js'], edited: true });
  assert.ok(!late.included.some(n => n.id === cc.id), 'archived rule note not served on edit');
  // maintenance does not re-verify or phrase it
  for (const id of [loc.id, rule.id]) { const n = store.get(id); n.status = 'stale'; n.stale = { changed: [] }; n.uses = 1; n.lastUsed = new Date().toISOString(); store.put(n); }
  const { stale } = pickStale(store.list(), DEFAULTS);
  assert.deepEqual(stale.map(n => n.id), [rule.id]);
  // review's view: store.list() still carries it (review.js filters only `invalid`)
  assert.ok(store.list().some(n => n.id === loc.id && n.archived));
  // restore
  const back = archiveNotes(store, { restore: true, ids: [loc.id] });
  assert.deepEqual(back.map(d => d.id), [loc.id]); assert.ok(!store.get(loc.id).archived);
  // by request, any kind; archive: false in the config stops the rules but not an explicit id
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ archive: false }));
  const s2 = new Store(store.repo);
  assert.equal(archiveNotes(s2, {}).length, 0);
  assert.equal(archiveNotes(s2, { ids: [rule.id] })[0].reason, 'by request');
}));

test('archived is this checkout\'s state: a shared note keeps its committed file and the state lives in the overlay', () => withEnv({ THINKER_LOG: 'off' }, () => {
  const dir = gitRepo(); const store = new Store(dir).init();
  const n = createNote(store, { title: 'fetchRows is defined in src/a.js', kind: 'location', answers: ['where is fetchRows'], body: 'src/a.js:fetchRows', deps: [{ path: 'src/a.js', symbol: 'fetchRows' }] }).note;
  // make it a shared (committed) note
  fs.mkdirSync(path.join(store.dir, 'notes'), { recursive: true });
  const shared = JSON.parse(fs.readFileSync(path.join(store.localNotesDir, n.id + '.json'), 'utf8'));
  for (const k of ['status', 'stale', 'uses', 'servedIn']) delete shared[k];
  fs.writeFileSync(path.join(store.dir, 'notes', n.id + '.json'), JSON.stringify(shared, null, 2) + '\n');
  fs.rmSync(path.join(store.localNotesDir, n.id + '.json'));
  git(dir, 'add', '.thinker/notes'); git(dir, 'commit', '-q', '-m', 'share');
  const s2 = new Store(dir);
  assert.ok(s2.isShared(n.id));
  archiveNotes(s2, { kinds: ['map'] });
  assert.ok(s2.get(n.id).archived);
  assert.ok(!JSON.parse(fs.readFileSync(path.join(s2.dir, 'notes', n.id + '.json'), 'utf8')).archived, 'the committed file is untouched');
  assert.equal(git(dir, 'status', '--porcelain', '--', '.thinker/notes'), '', 'nothing to commit');
}));

test('maintenance archives by the rules, counts it, and tells the user once', () => withEnv({ THINKER_LOG: 'off' }, async () => {
  const dir = gitRepo(); const store = new Store(dir).init();
  createNote(store, { title: 'fetchRows is defined in src/a.js', kind: 'location', answers: ['where is fetchRows'], body: 'src/a.js:fetchRows', deps: [{ path: 'src/a.js', symbol: 'fetchRows' }] });
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ archive: { kinds: ['map'] } }));
  const r = await maintain(store, dir, { fns: { spentToday: () => 0, verify: async () => ({ verdict: 'still_valid' }), phrase: async () => ({ done: [], cost: 0 }), } });
  assert.equal(r.archived, 1);
  const { maintenanceNotice, renderMaintain } = await import('../src/maintain.js');
  assert.match(renderMaintain(r), /1 archived/);
  assert.match(maintenanceNotice(store), /1 archived/);
  assert.equal(maintenanceNotice(store), '', 'said once');
  const r2 = await maintain(store, dir, { now: Date.now() + MAINTENANCE_INTERVAL_MS, fns: { spentToday: () => 0, verify: async () => ({ verdict: 'still_valid' }), phrase: async () => ({ done: [], cost: 0 }), } });
  assert.equal(r2.archived, 0);
}));

test('the archive command lists, archives, dry-runs and restores', () => withEnv({ THINKER_LOG: 'off', THINKER_NO_LEARN: '1' }, () => {
  const dir = gitRepo(); const store = new Store(dir).init();
  const n = createNote(store, { title: 'fetchRows is defined in src/a.js', kind: 'location', answers: ['where is fetchRows'], body: 'src/a.js:fetchRows', deps: [{ path: 'src/a.js', symbol: 'fetchRows' }] }).note;
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ archive: { kinds: ['map'] } }));
  const run = (...a) => execFileSync('node', [CLI, 'archive', ...a, '--repo', dir], { encoding: 'utf8', env: process.env });
  assert.match(run('--dry'), /would archive  .*\[map\]/); assert.ok(!store.get(n.id).archived);
  assert.match(run(), /1 note archived/); assert.ok(new Store(dir).get(n.id).archived);
  assert.match(run('--list'), /map\s+\S+\s+\d{4}-\d\d-\d\d\s+kind map/);
  assert.match(execFileSync('node', [CLI, 'list', '--repo', dir], { encoding: 'utf8', env: process.env }), /archived\s+map/);
  assert.match(run('--restore', n.id), /1 note restored/); assert.ok(!new Store(dir).get(n.id).archived);
}));

test('once a week the stop hook tells the user what the notes saved over the last 30 days, nothing under the floor', () => withEnv({ THINKER_LOG: 'local', THINKER_HOLDOUT: undefined, THINKER_NO_BG_VERIFY: '1', THINKER_NO_LEARN: '1' }, async () => {
  const dir = gitRepo(); const store = new Store(dir).init();
  const home = path.join(dir, 'home');
  const now = Date.parse('2026-10-14T10:00:00Z');  // a Wednesday of 2026-W42
  assert.equal(isoWeek(new Date(now)), '2026-W42'); assert.equal(isoWeek(new Date('2026-10-11T12:00:00')), '2026-W41'); assert.equal(isoWeek(new Date('2027-01-01T12:00:00')), '2026-W53');
  assert.equal(weeklyNotice(store, { now, home }), '', 'no data: nothing');
  // 25 sessions, each a served turn 1 and a held-out turn 2 twice the cost
  const t = new Date(now - 86400_000).toISOString();
  for (let i = 0; i < 25; i++) {
    store.log({ t, op: 'orient', session: `s${i}`, turn: 1, client: 'claude', served: ['n1'], holdout: undefined });
    store.log({ t, op: 'session', session: `s${i}`, turn: 1, model: 'm', toolCalls: 5, inputTokens: 1_000_000, turns: 3 });
    store.log({ t, op: 'orient', session: `s${i}`, turn: 2, client: 'claude', served: [], holdout: true, withheld: ['n1'] });
    store.log({ t, op: 'session', session: `s${i}`, turn: 2, model: 'm', toolCalls: 12, inputTokens: 3_000_000, turns: 8 });
  }
  const line = weeklyNotice(store, { now, home });
  assert.equal(line, '🧠 thinker, last 30 days: about 25M fewer input tokens across 25 prompts with notes (1M per prompt vs 2M on 25 held out, -50%; tool calls 5 vs 7).');
  assert.equal(weeklyNotice(store, { now: now + 3 * 86400_000, home }), '', 'shown once a week');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'state', 'weekly-notice.json'), 'utf8')).week, '2026-W42');
  assert.match(weeklyNotice(store, { now: now + 7 * 86400_000, home }), /^🧠 thinker, last 30 days: about 25M fewer/, 'and again the next week');
  assert.equal(weeklyNotice(store, { now: now + 40 * 86400_000, home }), '', 'the turns have left the window');
  // a negative saving reads "more", with the same numbers
  const h = summarize(store, {}).holdout; const flipped = { ...h, saved: { inputTokens: -5_000_000 }, deltaPct: { inputTokens: 20 } };
  assert.match(weeklyLine(flipped), /about 5M more input tokens across 25 prompts with notes \(1M per prompt vs 2M on 25 held out, \+20%/);
  assert.equal(weeklyLine({ ...h, enough: false }), '');
  // through the stop hook: the user's message, once, and not on a held-out turn
  fs.rmSync(path.join(home, 'state'), { recursive: true, force: true });
  const env = { ...process.env, THINKER_HOME: home };
  const stop = () => execFileSync('node', [CLI, 'hook', 'stop', '--no-distill', '--repo', dir], { input: JSON.stringify({ session_id: 'w1' }), encoding: 'utf8', env }).trim();
  const first = stop();
  assert.match(JSON.parse(first).systemMessage, /^🧠 thinker, last 30 days: about 25M fewer input tokens/);
  assert.equal(stop(), '', 'the same week: nothing');
  fs.rmSync(path.join(home, 'state'), { recursive: true, force: true });
  execFileSync('node', [CLI, 'hook', 'prompt', '--repo', dir], { input: JSON.stringify({ session_id: 'w2', prompt: 'hi' }), encoding: 'utf8', env: { ...env, THINKER_HOLDOUT: '1' } });
  assert.equal(execFileSync('node', [CLI, 'hook', 'stop', '--no-distill', '--repo', dir], { input: JSON.stringify({ session_id: 'w2' }), encoding: 'utf8', env }).trim(), '', 'a held-out turn shows nothing');
}));
