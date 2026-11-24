// What thinker looks after between sessions: what it finds in a repository, what it asks the person about before it
// changes anything (the default), what it is willing to change without being asked where it was told to act on its
// own, what it will not touch, and what it takes back a week later.
//
// Everything a check reaches outside the repository is handed to it: the kept Context report (`fns.view`), whether
// a pull request can be opened (`fns.prAvailable`), the process a change would start (`fns.spawn`), the kept
// Report's rows (`fns.report`) and a change's undo (`fns.revert`, `fns.prs`). So no model, no `gh`, no child.
import { tmp, repo } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.js';
import { UPKEEP, BEHAVIOR, worthOf, setBehavior, behaviorOf, upkeepCheck, upkeepPending, upkeepDo, upkeepUndo, upkeepView, upkeepFeed, upkeepDetail, mergeUpkeepViews, readUpkeep, askOffer, askWaiting, answerAsk } from '../src/upkeep.js';
import { formatTokens } from '../src/model-usage.js';
import { changeHistory, VIA } from '../src/context-suggest.js';
import { maintain, MAINTENANCE_INTERVAL_MS } from '../src/maintain.js';

const DAY = 86_400_000;
const NOW = Date.now() - 30 * DAY;

// One checkout for the file; each test gets its own cache and machine settings, so none reaches another.
// Most of the file is about what thinker does where it was told to act on its own, so a test's machine is set to
// `auto` unless it asks for the settings as they come (`level: null`: asked first, the default).
const CHECKOUT = repo({ 'AGENTS.md': '# Guide\n\n## Releases\nHow releases go.\n\n## Ports\nHow ports go.\n' });
const fresh = ({ level = 'auto' } = {}) => {
  fs.rmSync(path.join(CHECKOUT, '.thinker'), { recursive: true, force: true });
  const home = tmp('home');
  if (level) fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ upkeep: { level } }));
  return { store: new Store(CHECKOUT).init(), home };
};
const off = (store, upkeep) => fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ version: 1, upkeep }));
const stateFile = (store, name) => path.join(store.dir, 'state', name);
const write = (store, name, value) => { fs.mkdirSync(path.join(store.dir, 'state'), { recursive: true }); fs.writeFileSync(stateFile(store, name), JSON.stringify(value)); };
// the decisions' history as a job's finish or a second failure would leave it
const patchHistory = (store, fn) => { const st = JSON.parse(fs.readFileSync(stateFile(store, 'context-suggest.json'), 'utf8')); st.history.forEach(fn); write(store, 'context-suggest.json', st); };
const jobsDone = store => patchHistory(store, e => { if (e.job) e.job = { ...e.job, state: 'done' }; });

// A kept Context report, all a check knows about what the agents left behind. A part's waste is dollars a day:
// its unused tokens over the window, at what an input token costs here, per day.
const RATE = 5e-6, WINDOW = 7;
const tokensFor = dollars => (dollars * WINDOW) / RATE;
const section = (id, { dollars = 10, waste = 'high', usedShare = 0.02 } = {}) =>
  ({ id, file: 'AGENTS.md', title: id, tokens: 2000, wasted: 30_000, wastedWindow: tokensFor(dollars), waste, usedShare, text: `About ${id}.` });
const builtinTool = (name, { dollars = 10, used = 0, loaded = 40, off: switched = false, usedShare } = {}) =>
  ({ name, kind: 'tool', group: 'builtin', client: 'claude', key: `builtin:${name}`, label: `${name} tool`, used, loaded, tokens: 3000, wasted: 20_000, wastedWindow: tokensFor(dollars), waste: 'high', ...(switched ? { off: true } : {}), ...(usedShare == null ? {} : { usedShare }) });
const report = ({ sections = [], tools = [], sessions = 40 } = {}) => () =>
  ({ days: WINDOW, sessions, rate: { perToken: RATE }, instructions: { sessions, sections }, skills: [], outputs: { tools: [] }, tools });

const spawner = () => { const calls = []; return { calls, spawn: (cmd, args) => { calls.push(args); return { pid: process.pid, on() {}, unref() {} }; } }; };
const given = (view, { canPr = true, spawn, ...rest } = {}) => ({ view, prAvailable: () => ({ ok: canPr }), ...(spawn ? { spawn } : {}), ...rest });
const ONE = report({ sections: [section('releases')] });
const batchEveryDays = (store, home) => upkeepView(store, { now: NOW, home, log: [] }).behavior.batchEveryDays;

test('told to stay off, thinker does not even look', async () => {
  const { store, home } = fresh();
  off(store, false);
  const sp = spawner();
  let looked = 0;
  const r = await upkeepCheck(store, { now: NOW, home, fns: given(() => { looked++; return null; }, { spawn: sp.spawn }) });
  assert.deepEqual(r, { skipped: 'off' });
  assert.equal(looked, 0, 'the report was never read');
  assert.equal(sp.calls.length, 0);
  assert.equal(fs.existsSync(stateFile(store, 'upkeep.json')), false, 'nothing was written down');
  assert.equal(upkeepView(store, { now: NOW, home, log: [] }).level, 'off');
});

test('left as it comes, thinker asks first: what is worth doing is put to the person, and only a yes ships it', async () => {
  const { store, home } = fresh({ level: null });
  assert.equal(behaviorOf(store, { home }).level, 'ask', 'asking is what everybody starts with');
  const sp = spawner();
  const fns = given(report({ sections: [section('releases'), section('ports', { dollars: 8 }), section('style', { dollars: 1 })] }), { spawn: sp.spawn });
  const r = await upkeepCheck(store, { now: NOW, home, fns });
  assert.deepEqual(r.did, []);
  assert.equal(r.asking, 2, 'the two that clear the bar, and not the cheap one');
  assert.equal(sp.calls.length, 0, 'no change was started');
  assert.deepEqual(changeHistory(store, { now: NOW }), []);
  const { pending, batch } = upkeepPending(store, { now: NOW, home });
  assert.deepEqual(pending.map(i => i.id), ['change:section:AGENTS.md:releases', 'change:section:AGENTS.md:ports']);
  assert.match(pending[0].why, /asks you/);
  assert.equal(batch.ask, true);
  assert.match(upkeepView(store, { now: NOW, home, log: [] }).summary, /2 changes .* asks you about/);
  assert.equal(askWaiting(store, { now: NOW, home }), true, 'the answer\'s tool is offered from here on');
  // nobody at the session: nothing is asked, and the question keeps for one who is
  assert.equal(askOffer(store, { client: 'claude', now: NOW, home, env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' } }), '');
  // the next prompt has the person's agent ask, with its own question tool, each change under its number
  const block = askOffer(store, { client: 'claude', now: NOW, home, env: {} });
  assert.match(block, /AskUserQuestion/);
  assert.match(block, /header "thinker"/);
  assert.match(block, /1\. AGENTS\.md · releases: put up a PR to shorten it/i);
  assert.match(block, /2\. AGENTS\.md · ports/i);
  assert.doesNotMatch(block, /style/, 'what does not clear the bar is not asked about');
  assert.match(block, /None of these/);
  assert.match(block, /`changes` tool/);
  assert.equal(askOffer(store, { client: 'claude', now: NOW, home, env: {} }), '', 'asked once');
  assert.match(upkeepPending(store, { now: NOW, home }).batch.why, /waits for your answer/);
  assert.equal(sp.calls.length, 0, 'asking changed nothing');
  // an answer that names no line leaves the question standing
  assert.match(await answerAsk(store, 'the first one', { now: NOW, home, fns }), /still waiting/);
  // they chose the second: that one goes, as a pull request, by their word and not thinker's
  const said = await answerAsk(store, '2', { now: NOW + 60_000, home, fns });
  assert.match(said, /Sent a batch of 1 change/);
  assert.equal(sp.calls.length, 1);
  assert.equal(sp.calls[0].filter(a => a === '--pr').length, 1, 'a pull request, never the working tree');
  const h = changeHistory(store, { now: NOW + 60_000 });
  assert.deepEqual(h.map(e => [e.key, e.via]), [['section:AGENTS.md:ports', VIA.session]]);
  assert.equal(readUpkeep(store).done.find(d => d.kind === 'batch').by, 'you');
  assert.match(await answerAsk(store, '1', { now: NOW + 120_000, home, fns }), /no thinker question waiting/, 'one answer a question');
  assert.equal(sp.calls.length, 1);
});

test('a no changes nothing, and thinker does not ask again inside the week', async () => {
  const { store, home } = fresh({ level: null });
  const sp = spawner();
  const fns = given(ONE, { spawn: sp.spawn }), every = behaviorOf(store, { home }).batchEveryDays;
  await upkeepCheck(store, { now: NOW, home, fns });
  assert.match(askOffer(store, { client: 'pi', now: NOW, home, env: {} }), /ask the user in chat/, 'an agent with no question tool asks in the chat');
  assert.match(await answerAsk(store, 'none', { now: NOW, home, fns }), /Nothing was changed/);
  assert.equal(sp.calls.length, 0);
  assert.deepEqual(changeHistory(store, { now: NOW }), [], 'and nothing was decided: it is not left alone for good');
  const soon = NOW + (every - 1) * DAY;
  assert.equal((await upkeepCheck(store, { now: soon, home, fns })).asking, undefined);
  assert.match(upkeepPending(store, { now: soon, home }).batch.why, /asks at most every/);
  assert.equal(askOffer(store, { client: 'claude', now: soon, home, env: {} }), '');
  const due = NOW + (every + 1) * DAY;
  assert.equal((await upkeepCheck(store, { now: due, home, fns })).asking, 1, 'the week up, it may ask again');
  // told meanwhile to act on its own, the question kept is not put: the batch goes at the next check instead
  setBehavior(store, 'level', 'auto', { home });
  assert.equal(askOffer(store, { client: 'claude', now: due, home, env: {} }), '');
  assert.deepEqual((await upkeepCheck(store, { now: due + 3600_000, home, fns })).did.map(d => d.kind), ['batch']);
  assert.equal(sp.calls.length, 1);
});

test('thinker changes a thing by itself only where the case is strong', () => {
  const b = { ...BEHAVIOR };
  const pr = extra => ({ chore: 'context', kind: 'pr', waste: 'high', perDay: b.minPerDay, ...extra });
  const inUse = Math.ceil(UPKEEP.clearUse * 40);
  const cases = [
    ['a high-waste section at the bar goes', pr(), true, null],
    ['a hair under the bar is left alone', pr({ perDay: b.minPerDay - 0.01 }), false, /must save/],
    ['waste the report grades medium is left alone', pr({ perDay: b.minPerDay * 4, waste: 'medium' }), false, /not high/],
    ['waste the report has not graded is left alone', pr({ perDay: b.minPerDay * 4, waste: null }), false, /not graded/],
    ['what nothing here can price is left alone', pr({ perDay: null }), false, /price/],
    ['a tool plainly in use is left alone whatever it costs', { ...pr({ kind: 'do', perDay: b.minPerDay * 20 }), ref: true, use: { used: inUse, loaded: 40 } }, false, /plainly of use/],
    ['a tool nobody calls goes', { ...pr({ kind: 'do' }), ref: true, use: { used: 0, loaded: 40 } }, true, null],
    ['a tool the report has not counted yet waits', { ...pr({ kind: 'do' }), ref: true, use: { used: null, loaded: 0 } }, false, /does not say yet/],
  ];
  for (const [name, item, ok, why] of cases) {
    const w = worthOf(item, b);
    assert.equal(w.ok, ok, name);
    if (why) assert.match(w.why, why, name);
  }
  // the bar is the person's: lower it and the same change is worth making
  assert.deepEqual([worthOf(pr({ perDay: 2 }), b).ok, worthOf(pr({ perDay: 2 }), { ...b, minPerDay: 1 }).ok], [false, true], 'the bar is where the setting puts it');
});

test('thinker takes the gentlest change that gets the saving', async () => {
  const { store, home } = fresh();
  const enough = UPKEEP.removeSessions;
  const actOf = async (view, now) => { await upkeepCheck(store, { now, home, act: false, fns: given(view) }); return Object.fromEntries(upkeepPending(store, { now, home }).pending.map(i => [i.id.replace('change:section:AGENTS.md:', ''), i.data.act])); };
  const both = [section('releases', { usedShare: 0 }), section('ports', { usedShare: 0.02 })];
  // no prompt of the window needed it, over enough sessions to say so: removed; anything else: shortened
  assert.deepEqual(await actOf(report({ sections: both, sessions: enough }), NOW), { releases: 'remove', ports: 'compress' });
  assert.deepEqual(await actOf(report({ sections: both, sessions: enough - 1 }), NOW + DAY), { releases: 'compress', ports: 'compress' }, 'too few sessions to say nobody needs it');
  off(store, { remove: false });
  assert.deepEqual(await actOf(report({ sections: both, sessions: enough }), NOW + 2 * DAY), { releases: 'compress', ports: 'compress' }, 'told to shorten and never remove');
  // a tool that can only be switched off outright, never made a reference, waits for a clearer case
  const b = { ...BEHAVIOR };
  const mcp = extra => worthOf({ chore: 'context', kind: 'do', waste: 'high', perDay: b.minPerDay * 10, ref: false, ...extra }, b);
  assert.match(mcp({ use: { used: 1, loaded: 40 } }).why, /switched off outright/);
  assert.match(mcp({ use: { used: 0, loaded: enough - 1 } }).why, /too few/);
  assert.equal(mcp({ use: { used: 0, loaded: enough } }).ok, true, 'nobody called it, over enough sessions');
});

test('a second setting keeps the first', async () => {
  const { store, home } = fresh({ level: null });
  for (const scope of ['machine', 'repo']) {
    const where = scope === 'machine' ? path.join(home, 'config.json') : path.join(store.dir, 'config.json');
    assert.equal(setBehavior(store, 'batchEveryDays', '30', { scope, home }).value, 30);
    assert.equal(setBehavior(store, 'skills', 'on', { scope, home }).value, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(where, 'utf8')).upkeep, { batchEveryDays: 30, skills: true }, `${scope}: the second wish did not wipe the first`);
  }
  assert.deepEqual([behaviorOf(store, { home }).batchEveryDays, behaviorOf(store, { home }).skills], [30, true]);
});

test('what a batch did is one line of the activity, and that line is how it is taken back', async () => {
  const { store, home } = fresh();
  const sp = spawner();
  const seen = { now: NOW, home, log: [], report: { rows: [], rate: RATE } };
  await upkeepCheck(store, { now: NOW, home, fns: given(report({ sections: [section('releases'), section('ports')] }), { spawn: sp.spawn }) });
  const id = `b:${readUpkeep(store).done.find(d => d.kind === 'batch').id}`;
  const lineOf = () => { const ls = upkeepFeed(store, seen).filter(f => f.id === id); assert.equal(ls.length, 1, 'one line for the whole batch'); return ls[0]; };
  const made = lineOf();
  assert.equal(made.batch.changes, 2);
  assert.ok(made.impactSaid, 'the line says what it came to');
  assert.match(made.text, /shorten/i);
  assert.doesNotMatch(made.text, /remov/i, 'it shortened them, and says so');
  assert.equal(made.undo, undefined, 'nothing to take back while it is still being made');
  assert.match((await upkeepUndo(store, id, { now: NOW })).error, /taken back/);
  const at = new Date(NOW).toISOString(); // its job finished and opened one pull request over both sections
  patchHistory(store, e => { e.job = { ...e.job, state: 'done' }; e.tokens = { before: 2000, after: 400 }; e.pr = { number: 12, state: 'open', url: 'https://github.com/o/r/pull/12', branch: 'thinker/batch', at }; });
  const open = lineOf();
  assert.equal(open.undo, id);
  assert.equal(open.url, 'https://github.com/o/r/pull/12', 'the line carries the link while it is in review');
  const facts = upkeepDetail(store, id, seen).join('\n');
  assert.ok(facts.includes(formatTokens(400)), 'the chat can be told what the batch was, and what it left behind');
  // and the id takes all of it back at once: one pull request closed, both sections reverted
  const closed = [];
  const took = await upkeepUndo(store, id, { now: NOW + DAY, fns: { prs: { closePr: (dir, number) => { closed.push(number); return {}; } } } });
  assert.equal(took.error, undefined);
  assert.deepEqual(closed, [12], 'closed once, not once per section');
  assert.equal(changeHistory(store, { now: NOW + DAY }).every(e => e.revertedAt), true);
  assert.equal(lineOf().undone, true);
  // read beside a repository that could not be read at all, the line is still there
  const view = upkeepView(store, seen);
  const all = mergeUpkeepViews([{ repo: 'a', name: 'o/a', view }, { repo: 'b', name: 'o/b', view: null }]);
  assert.equal(all.level, view.level);
  assert.equal(all.feed.filter(f => f.id === id).length, 1);
});

test('the changes worth making go out together, as one job and one pull request', async () => {
  const { store, home } = fresh();
  const sp = spawner();
  const view = report({ sections: [section('releases'), section('ports'), section('style', { dollars: 1 })] });
  const r = await upkeepCheck(store, { now: NOW, home, fns: given(view, { spawn: sp.spawn }) });
  assert.deepEqual(r.did.map(d => d.kind), ['batch']);
  assert.equal(r.did[0].changes, 2);
  assert.equal(sp.calls.length, 1, 'one background job for the whole batch');
  assert.equal(sp.calls[0].filter(a => a === '--pr').length, 1, 'one pull request');
  const h = changeHistory(store, { now: NOW });
  assert.equal(h.length, 2);
  assert.equal(new Set(h.map(e => e.batch)).size, 1, 'one batch');
  assert.equal(new Set(h.map(e => e.group)).size, 1, 'one job');
  assert.deepEqual([...new Set(h.map(e => e.via))], [VIA.thinker]);
  assert.deepEqual(upkeepPending(store, { now: NOW, home }).passed.map(i => i.id), ['change:section:AGENTS.md:style'], 'the cheap one was left where it was');
});

test('where no pull request can be opened, the file is not thinker\'s to change', async () => {
  const { store, home } = fresh();
  const before = fs.readFileSync(path.join(CHECKOUT, 'AGENTS.md'), 'utf8');
  const sp = spawner();
  const r = await upkeepCheck(store, { now: NOW, home, fns: given(ONE, { canPr: false, spawn: sp.spawn }) });
  assert.deepEqual(r.did, []);
  assert.equal(sp.calls.length, 0);
  assert.deepEqual(upkeepPending(store, { now: NOW, home }).pending, [], 'not even held: it is not thinker\'s to make');
  assert.equal(fs.readFileSync(path.join(CHECKOUT, 'AGENTS.md'), 'utf8'), before, 'the working tree is untouched');
  // found when one could be opened, it is asked again at the moment of the change and refused
  await upkeepCheck(store, { now: NOW + DAY, home, act: false, fns: given(ONE) });
  const said = await upkeepDo(store, 'change:section:AGENTS.md:releases', { now: NOW + DAY, home, fns: given(ONE, { canPr: false, spawn: sp.spawn }) });
  assert.match(said.error, /no pull request/);
  assert.equal(sp.calls.length, 0);
});

test('the same thing is never done twice', async () => {
  const { store, home } = fresh();
  const sp = spawner();
  const fns = given(ONE, { spawn: sp.spawn });
  assert.equal((await upkeepCheck(store, { now: NOW, home, fns })).did.length, 1);
  // its job finished and its pull request is in review, so nothing is waiting on a run any more; and long
  // enough has passed that another batch would be due, so only the decision itself holds it back
  patchHistory(store, e => { e.job = { ...e.job, state: 'done' }; e.pr = { number: 7, state: 'open', url: 'https://github.com/o/r/pull/7', branch: 'thinker/releases', at: new Date(NOW).toISOString() }; });
  const later = NOW + (batchEveryDays(store, home) + 1) * DAY;
  assert.deepEqual((await upkeepCheck(store, { now: later, home, fns })).did, []);
  assert.equal(sp.calls.length, 1, 'started once, not twice');
  assert.equal(changeHistory(store, { now: later }).length, 1);
});

test('a batch waits its turn: never over a change still being made, never twice inside the week', async () => {
  const { store, home } = fresh();
  const sp = spawner();
  assert.equal((await upkeepCheck(store, { now: NOW, home, fns: given(ONE, { spawn: sp.spawn }) })).did.length, 1);
  const more = report({ sections: [section('releases'), section('ports')] });
  // while its job runs, nothing else goes
  await upkeepCheck(store, { now: NOW + 3600_000, home, fns: given(more, { spawn: sp.spawn }) });
  assert.match(upkeepPending(store, { now: NOW + 3600_000, home }).batch.why, /still being made/);
  assert.equal(sp.calls.length, 1);
  jobsDone(store);
  const soon = NOW + (batchEveryDays(store, home) - 1) * DAY;
  assert.deepEqual((await upkeepCheck(store, { now: soon, home, fns: given(more, { spawn: sp.spawn }) })).did, [], 'inside the days between batches');
  assert.match(upkeepPending(store, { now: soon, home }).batch.why, /one batch every/);
  assert.equal(sp.calls.length, 1);
  const due = NOW + (batchEveryDays(store, home) + 1) * DAY;
  assert.equal((await upkeepCheck(store, { now: due, home, fns: given(more, { spawn: sp.spawn }) })).did.length, 1, 'the week up, the next batch goes');
  assert.equal(sp.calls.length, 2);
});

test('a week on, a change that backfired is taken back and not tried again', async () => {
  const { store, home } = fresh();
  const made = new Date(NOW - 10 * DAY).toISOString();
  // two tools made references ten days ago: one in a batch of thinker's own, one in a batch the person asked for
  const entry = (id, batch, name) => ({ id, batch, at: made, via: VIA.thinker, key: `claude:builtin:${name}`, kind: 'tool', title: `${name} tool`, saving: 3000, total: 3000, days: WINDOW, act: 'off', action: 'Create tool reference', decision: 'approved' });
  write(store, 'context-suggest.json', { history: [entry('t1', 'b1', 'Workflow'), entry('t2', 'b2', 'Agent')] });
  const batch = (id, by) => ({ id, at: made, item: 'batch', chore: 'context', kind: 'batch', title: 'A batch of 1 change', said: 'Sent a batch', by, kept: true, batch: { keys: [], perDay: 9 } });
  write(store, 'upkeep.json', { done: [batch('b1', 'thinker'), batch('b2', 'you')] });
  // both are still being called, so both backfired; only thinker's own is thinker's to take back
  const stillCalled = report({ tools: [builtinTool('Workflow', { off: true, usedShare: UPKEEP.needShare * 2 }), builtinTool('Agent', { off: true, usedShare: UPKEEP.needShare * 2 })] });
  const reverted = [];
  const fns = given(stillCalled, { spawn: spawner().spawn, report: () => ({ rows: [] }), revert: async (s, id) => { reverted.push(id); return { said: 'turned back on' }; } });
  const r = await upkeepCheck(store, { now: NOW, home, fns });
  assert.deepEqual(r.did.map(d => d.kind), ['did']);
  assert.match(r.did[0].said, /Turned Workflow tool back on/);
  assert.match(r.did[0].said, /still called/);
  assert.deepEqual(reverted, ['t1'], 'what the person asked for is not thinker\'s to undo');
  const kept = readUpkeep(store);
  assert.deepEqual([kept.followed.t1.verdict, kept.followed.t2], ['undone', undefined]);
  assert.ok(kept.dismissed['change:claude:builtin:Workflow'], 'and it is left alone from now on');
  // and it is judged once: the next check looks at nothing again
  assert.deepEqual((await upkeepCheck(store, { now: NOW + 3600_000, home, fns })).did, []);
  assert.deepEqual(reverted, ['t1']);
});

test('a pull request the person closed without merging is a no', async () => {
  const { store, home } = fresh();
  const at = new Date(NOW - DAY).toISOString();
  write(store, 'context-suggest.json', { history: [
    { id: 'p1', at, via: VIA.thinker, key: 'section:AGENTS.md:releases', kind: 'section', title: 'AGENTS.md · Releases', saving: 1200, total: 1200, days: WINDOW, act: 'compress', decision: 'pull request', pr: { number: 12, state: 'closed', at } },
  ] });
  const both = report({ sections: [section('releases'), section('ports')] });
  await upkeepCheck(store, { now: NOW, home, act: false, fns: given(both) });
  assert.deepEqual(upkeepPending(store, { now: NOW, home }).pending.map(i => i.id), ['change:section:AGENTS.md:ports'], 'the refused section is not offered again');
  const later = NOW + (UPKEEP.dismissDays + 1) * DAY;
  await upkeepCheck(store, { now: later, home, act: false, fns: given(both) });
  assert.deepEqual(upkeepPending(store, { now: later, home }).pending.map(i => i.id).sort(), ['change:section:AGENTS.md:ports', 'change:section:AGENTS.md:releases'], 'long enough after, it may be put up again');
});

test('a check calls no model', async () => {
  // The change a batch starts does call a model, in a job of its own. This is about the check: everything it
  // reads was measured already, by code or by the one pass a session gets when it ends.
  const { store, home } = fresh();
  const dir = tmp('llm');
  const marker = path.join(dir, 'called'), cmd = path.join(dir, 'model.sh');
  fs.writeFileSync(cmd, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\necho '{}'\n`);
  fs.chmodSync(cmd, 0o755);
  Object.assign(process.env, { THINKER_LLM: 'command', THINKER_LLM_CMD: cmd });
  try { assert.equal((await upkeepCheck(store, { now: NOW, home, fns: given(ONE, { spawn: spawner().spawn }) })).did.length, 1, 'it did its work'); }
  finally { delete process.env.THINKER_LLM; delete process.env.THINKER_LLM_CMD; }
  assert.equal(fs.existsSync(marker), false, 'no model was asked anything');
});

test('a change of its own that failed is tried again a day later, a few times, then left', async () => {
  const { store, home } = fresh();
  const failedAt = NOW - 3 * DAY, at = new Date(failedAt).toISOString();
  write(store, 'context-suggest.json', { history: [
    { id: 'j1', group: 'g1', batch: 'b1', at, via: VIA.thinker, key: 'section:AGENTS.md:releases', kind: 'section', title: 'AGENTS.md · Releases', file: 'AGENTS.md', section: 'releases', saving: 1200, total: 1200, days: WINDOW, act: 'compress', decision: 'pull request', job: { state: 'failed', action: 'compress', pr: true, startedAt: at, finishedAt: at, error: 'the model timed out' } },
  ] });
  const failAgain = when => patchHistory(store, e => { e.job = { ...e.job, state: 'failed', error: 'the model timed out', finishedAt: new Date(when).toISOString() }; });
  const sp = spawner();
  const fns = given(report(), { spawn: sp.spawn });
  // the hour after it failed is too soon
  assert.deepEqual((await upkeepCheck(store, { now: failedAt + 3600_000, home, fns })).did, []);
  assert.match(upkeepPending(store, { now: failedAt + 3600_000, home }).pending[0].why, /a day after it failed/);
  let now = failedAt, retried = 0;
  for (let i = 0; i < UPKEEP.retries + 2; i++) {
    now += DAY + 3600_000;
    const r = await upkeepCheck(store, { now, home, fns });
    if (!r.did.length) continue;
    retried++;
    failAgain(now + 60_000);
  }
  assert.equal(retried, UPKEEP.retries - 1, 'tried until it had been attempted as often as thinker will');
  assert.equal(sp.calls.length, retried);
  assert.match(upkeepPending(store, { now, home }).pending[0].why, /failed \d+ times/);
});

test('what the person took back thinker does not do again', async () => {
  const { store, home } = fresh();
  const at = new Date(NOW - DAY).toISOString();
  write(store, 'context-suggest.json', { history: [
    { id: 'p1', at, via: VIA.thinker, key: 'section:AGENTS.md:releases', kind: 'section', title: 'AGENTS.md · Releases', saving: 1200, total: 1200, days: WINDOW, act: 'compress', decision: 'pull request', pr: { number: 12, state: 'open', url: 'https://github.com/o/r/pull/12', branch: 'thinker/releases', at } },
  ] });
  const closed = [];
  const took = await upkeepUndo(store, 'h:p1', { now: NOW, fns: { prs: { closePr: (dir, number, o) => { closed.push([number, o.branch]); return {}; } } } });
  assert.equal(took.error, undefined);
  assert.deepEqual(closed, [[12, 'thinker/releases']], 'its pull request was closed');
  assert.ok(readUpkeep(store).dismissed['change:section:AGENTS.md:releases']);
  const sp = spawner();
  const r = await upkeepCheck(store, { now: NOW + DAY, home, fns: given(ONE, { spawn: sp.spawn }) });
  assert.deepEqual(r.did, []);
  assert.equal(sp.calls.length, 0);
  assert.deepEqual(upkeepPending(store, { now: NOW + DAY, home }).pending, []);
});

test('maintenance looks on its own clock and not before, and a look from the page changes nothing', async () => {
  const { store, home } = fresh();
  const looks = [];
  const fns = { containers: () => null, upkeep: async (s, o) => { looks.push(o.now); return { did: [{ id: 'batch', kind: 'batch', said: 'Sent a batch of 2 changes' }], pending: 1, errors: [] }; } };
  const first = await maintain(store, CHECKOUT, { now: NOW, fns });
  assert.equal(first.upkeepDid, 1);
  assert.equal(first.upkeepPending, 1);
  assert.equal(looks.length, 1);
  assert.equal((await maintain(store, CHECKOUT, { now: NOW + 3600_000, fns })).skipped, 'not-due');
  assert.equal(looks.length, 1, 'not before its four hours are up');
  await maintain(store, CHECKOUT, { now: NOW + MAINTENANCE_INTERVAL_MS + 1000, fns });
  assert.equal(looks.length, 2);
  // told to stay off, maintenance's check writes nothing down at all
  const quiet = fresh();
  off(quiet.store, false);
  const r = await maintain(quiet.store, CHECKOUT, { now: NOW, fns: { containers: () => null } });
  assert.equal(r.upkeepDid, undefined);
  assert.equal(fs.existsSync(stateFile(quiet.store, 'upkeep.json')), false);
  // a look is all a visit to the page ever starts: it finds and keeps, and does nothing
  const seen = fresh();
  const sp = spawner();
  const look = await upkeepCheck(seen.store, { now: NOW, home: seen.home, act: false, fns: given(ONE, { spawn: sp.spawn }) });
  assert.deepEqual(look.did, []);
  assert.equal(sp.calls.length, 0);
  assert.equal(look.pending, 1, 'it knows what is waiting');
  assert.ok(upkeepView(seen.store, { now: NOW, home: seen.home, log: [] }).lastCheck);
});
