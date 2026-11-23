// The chat: the one place the person talks to thinker. They ask what it did, tell it how to behave, and have it
// do, leave or take back a thing. The model returns words and a list of actions from a short fixed set; the code
// checks every action, carries it out, and says what happened in its own words.
//
// The model is an argument here (`completeFn`), so no model is called: it is given the call thinker would have
// made and answers `{ json: { reply, actions } }`. The repository work an action reaches goes through the same
// injected report, pull-request check and spawn as upkeep's own tests.
import { tmp, repo } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.js';
import { chatSend, chatAnswerPending, chatView, chatContext, renderChat, refOf, CHAT } from '../src/chat.js';
import { behaviorOf, upkeepCheck, upkeepPending, readUpkeep, BEHAVIOR, STEER } from '../src/upkeep.js';
import { changeHistory, VIA } from '../src/context-suggest.js';
import { savingsDetail, savingsNet, dayKey, RECENT_DAYS } from '../src/accountant.js';
import { STAGES } from '../src/factory.js';

const DAY = 86_400_000;
const NOW = Date.now() - 30 * DAY;

// Two checkouts for the file, as the page names them. Each test gets its own caches and its own machine home, so
// nothing one test says to thinker reaches another.
const CHECKOUTS = ['api', 'web'].map(name => ({ id: `github.com/acme/${name}`, name: `acme/${name}`, dir: repo() }));
const fresh = (n = 1) => ({
  home: tmp('home'),
  repos: CHECKOUTS.slice(0, n).map(c => {
    fs.rmSync(path.join(c.dir, '.thinker'), { recursive: true, force: true });
    return { id: c.id, name: c.name, store: new Store(c.dir).init() };
  }),
});
// A model that answers what the test gives it, in turn, and keeps the calls it was asked to make.
const model = (...answers) => {
  const asked = [];
  let i = 0;
  const fn = async o => { asked.push(o); return { json: answers[Math.min(i++, answers.length - 1)], model: 'test' }; };
  fn.asked = asked;
  return fn;
};
const say = (text, opts) => chatSend(text, { now: NOW, ...opts });
const answer = r => r.messages.at(-1);

// what a check reads about the repository, and the process a section change would start
const RATE = 5e-6, WINDOW = 7;
const section = id => ({ id, file: 'AGENTS.md', title: id, tokens: 2000, wasted: 30_000, wastedWindow: (10 * WINDOW) / RATE, waste: 'high', usedShare: 0.02, text: `About ${id}.` });
const report = (...ids) => () => ({ days: WINDOW, sessions: 40, rate: { perToken: RATE }, instructions: { sessions: 40, sections: ids.map(section) }, skills: [], outputs: { tools: [] }, tools: [] });
const spawner = () => { const calls = []; return { calls, spawn: (cmd, args) => { calls.push(args); return { pid: process.pid, on() {}, unref() {} }; } }; };

test('a question changes nothing', async () => {
  const { home, repos } = fresh();
  const before = JSON.stringify(behaviorOf(repos[0].store, { home }));
  const r = await say('what have you been up to?', { repos, about: repos[0].id, home, completeFn: model({ reply: 'Nothing in the last fortnight.', actions: [] }) });
  assert.equal(r.messages.length, 2);
  assert.equal(answer(r).role, 'thinker');
  assert.equal(answer(r).did, undefined, 'nothing was carried out');
  assert.equal(JSON.stringify(behaviorOf(repos[0].store, { home })), before);
  assert.equal(fs.existsSync(path.join(home, 'config.json')), false, 'no setting was written');
  assert.deepEqual(changeHistory(repos[0].store, { now: NOW }), []);
});

test('an action thinker has no way of doing is dropped and said so', async () => {
  const { home, repos } = fresh();
  const fn = model({ reply: 'Doing all of that.', actions: [{ type: 'delete', id: 'main' }, 'rm -rf /', { type: 'push' }, { type: 'set', key: 'batchEveryDays', value: '30' }] });
  const r = await say('tidy up for me', { repos, about: repos[0].id, home, completeFn: fn });
  assert.deepEqual(answer(r).did.map(d => [d.type, d.ok]), [['delete', false], ['push', false], ['set', true]], 'the text it invented is not an action at all');
  assert.match(answer(r).did[0].text, /no action called delete/);
  assert.equal(behaviorOf(repos[0].store, { home }).batchEveryDays, 30, 'the one real action still went through');
});

test('a setting thinker does not have, or a value it cannot take, never lands', async () => {
  const { home, repos } = fresh();
  const fn = model({ reply: 'Right you are.', actions: [
    { type: 'set', key: 'recklessness', value: 'max' },
    { type: 'set', key: 'level', value: 'yolo' },
    { type: 'set', key: 'minPerDay', value: 'lots' },
    { type: 'set', key: 'level', value: 'ask' },
  ] });
  const r = await say('go wild', { repos, about: repos[0].id, home, completeFn: fn });
  const did = answer(r).did;
  assert.deepEqual(did.map(d => d.ok), [false, false, false, true]);
  assert.match(did[0].text, /no setting called/);
  assert.match(did[1].text, /cannot be/);
  assert.match(did[2].text, /cannot be/);
  const b = behaviorOf(repos[0].store, { home });
  assert.equal(b.level, 'ask', 'the good one in the same answer went through');
  assert.equal(b.minPerDay, BEHAVIOR.minPerDay, 'the bar was left where it was');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).upkeep), ['level'], 'nothing unknown was written');
});

test('an action that blows up is reported as not done, and the ones after it still run', async () => {
  const { home, repos } = fresh();
  // this repository's config cannot be written: the wish aimed at it throws where it is written down
  const blocked = path.join(repos[0].store.dir, 'config.json');
  fs.rmSync(blocked, { force: true });
  fs.mkdirSync(blocked);
  const fn = model({ reply: 'Both of those, then.', actions: [{ type: 'set', repo: 'r1', key: 'prs', value: 'false' }, { type: 'set', key: 'batchEveryDays', value: '30' }] });
  const r = await say('no pull requests here, and once a month everywhere', { repos, about: repos[0].id, home, completeFn: fn });
  const did = answer(r).did;
  assert.deepEqual(did.map(d => d.ok), [false, true], 'the one that blew up is not reported as done');
  assert.match(did[0].text, /directory/, 'and it carries what went wrong');
  assert.equal(behaviorOf(repos[0].store, { home }).prs, true, 'nothing was written for the repository');
  assert.equal(behaviorOf(repos[0].store, { home }).batchEveryDays, 30, 'and the wish after it still landed');
});

test('a wish for one repository stays there, a wish for none is the whole machine, and "less of these" moves the bar one step', async () => {
  const { home, repos } = fresh(2);
  const [api, web] = repos;
  const aimed = model({ reply: 'Will do.', actions: [{ type: 'set', repo: 'r2', key: 'prs', value: 'false' }, { type: 'set', key: 'batchEveryDays', value: '30' }] });
  const r = await say('no more pull requests in web, and once a month elsewhere', { repos, about: api.id, home, completeFn: aimed });
  assert.deepEqual(answer(r).did.map(d => d.ok), [true, true]);
  assert.deepEqual([behaviorOf(web.store, { home }).prs, behaviorOf(api.store, { home }).prs], [false, true], 'one repository only');
  assert.deepEqual([behaviorOf(api.store, { home }).batchEveryDays, behaviorOf(web.store, { home }).batchEveryDays], [30, 30], 'and the whole machine');
  // "less of these" is a step the code picks from its own ladder, never a number the model chose
  const steps = STEER.minPerDay.steps;
  const steered = model({ reply: 'Fewer of those, then.', actions: [{ type: 'steer', kind: 'changes', direction: 'less' }] });
  const s = await say('you do that too often', { repos, about: api.id, home, completeFn: steered });
  assert.equal(answer(s).did[0].ok, true);
  const was = BEHAVIOR.minPerDay, bar = behaviorOf(api.store, { home }).minPerDay;
  assert.equal(bar, steps[steps.indexOf(was) + 1], 'one step up the ladder');
});

test('an unknown repository, thing or undo id is refused', async () => {
  const { home, repos } = fresh();
  const fn = model({ reply: 'On it.', actions: [
    { type: 'set', repo: 'r9', key: 'prs', value: 'false' },
    { type: 'do', repo: 'r1', id: 'change:nothing-like-that' },
    { type: 'undo', repo: 'r1', id: 'h:nothing-like-that' },
    { type: 'do', repo: 'r1' },
  ] });
  const r = await say('do all of it', { repos, about: repos[0].id, home, completeFn: fn });
  const did = answer(r).did;
  assert.deepEqual(did.map(d => d.ok), [false, false, false, false]);
  assert.match(did[0].text, /no repository is called/);
  assert.match(did[1].text, /nothing is waiting/);
  assert.match(did[2].text, /no such decision/);
  assert.match(did[3].text, /needs an item/);
  assert.equal(fs.existsSync(path.join(home, 'config.json')), false);
});

test('told to do a thing, to leave one and to take one back, thinker does each once', async () => {
  const { home, repos } = fresh();
  const [api] = repos;
  const sp = spawner();
  const fns = { view: report('releases', 'ports'), prAvailable: () => ({ ok: true }), spawn: sp.spawn };
  await upkeepCheck(api.store, { now: NOW, home, act: false, fns });
  const key = id => `change:section:AGENTS.md:${id}`;
  // do: started once, and recorded as the person's word
  const did = await say('go ahead with the releases one', { repos, about: api.id, home, fns, completeFn: model({ reply: "I'll put that one up now.", actions: [{ type: 'do', repo: 'r1', id: key('releases') }] }) });
  assert.equal(answer(did).did[0].ok, true);
  assert.equal(sp.calls.length, 1, 'one job started');
  assert.deepEqual(changeHistory(api.store, { now: NOW }).map(e => e.key), ['section:AGENTS.md:releases']);
  // leave: not done, and not come back to
  const left = await say('never mind the ports one', { repos, about: api.id, home, fns, completeFn: model({ reply: 'Leaving it.', actions: [{ type: 'leave', repo: 'r1', id: key('ports') }] }) });
  assert.equal(answer(left).did[0].ok, true);
  assert.ok(readUpkeep(api.store).dismissed[key('ports')]);
  const st = JSON.parse(fs.readFileSync(path.join(api.store.dir, 'state', 'context-suggest.json'), 'utf8'));
  for (const e of st.history) if (e.job) e.job = { ...e.job, state: 'done' };
  fs.writeFileSync(path.join(api.store.dir, 'state', 'context-suggest.json'), JSON.stringify(st));
  const later = NOW + 8 * DAY;
  const next = await upkeepCheck(api.store, { now: later, home, fns });
  assert.deepEqual(next.did, [], 'the next check does not do what it was told to leave');
  assert.equal(sp.calls.length, 1);
  assert.deepEqual(upkeepPending(api.store, { now: later, home }).pending, []);
  assert.equal(changeHistory(api.store, { now: later }).some(e => e.key === 'section:AGENTS.md:ports' && e.decision !== 'dismissed'), false);
  // undo: the pull request of a change is closed
  const at = new Date(NOW - DAY).toISOString();
  st.history.push({ id: 'p9', at, via: VIA.thinker, key: 'section:AGENTS.md:legacy', kind: 'section', title: 'AGENTS.md · Legacy', saving: 1200, total: 1200, days: WINDOW, act: 'compress', decision: 'pull request', pr: { number: 12, state: 'open', url: 'https://github.com/o/r/pull/12', branch: 'thinker/legacy', at } });
  fs.writeFileSync(path.join(api.store.dir, 'state', 'context-suggest.json'), JSON.stringify(st));
  const closed = [];
  const back = await say('take that legacy one back', { repos, about: api.id, home, fns: { ...fns, prs: { closePr: (dir, number, o) => { closed.push([number, o.branch]); return {}; } } }, completeFn: model({ reply: 'Taking it back.', actions: [{ type: 'undo', repo: 'r1', id: 'h:p9' }] }) });
  assert.equal(answer(back).did[0].ok, true);
  assert.deepEqual(closed, [[12, 'thinker/legacy']]);
});

test('an answer that needs the sessions costs one more model call and only one', async () => {
  const { home, repos } = fresh();
  const asked = [];
  const evidence = (store, q) => {
    asked.push(q);
    return { stage: q.stage, loop: q.loop, days: q.days, money: true, measured: 3, hit: 2, cost: 10, tokens: 1000, rework: 4, reworkTokens: 400, kinds: [],
      sessions: [{ id: 's1', at: new Date(NOW).toISOString(), sub: false, title: 'fix the build', model: 'opus', cost: 5, tokens: 500, rework: 2, reworkTokens: 200, loops: [], moreLoops: 0 }] };
  };
  const fn = model({ reply: 'Let me look at those.', actions: [{ type: 'read', stage: 'merge', days: '14' }] }, { reply: 'Here is what they show.', actions: [{ type: 'read', stage: 'merge' }] });
  const r = await say('why so much rework at merge lately?', { repos, about: repos[0].id, home, fns: { evidence }, completeFn: fn });
  assert.equal(fn.asked.length, 2, 'one more call, and the second may not ask again');
  assert.equal(asked.length, 1, 'the sessions were read once');
  assert.equal(asked[0].stage, 'merge');
  assert.deepEqual(answer(r).did.map(d => [d.type, d.ok]), [['read', true]]);
  assert.equal(answer(r).text, 'Here is what they show.', 'the second answer is the one kept');
  assert.ok(fn.asked[1].prompt.includes('fix the build'), 'and it is asked again about the sessions that were read');
});

test('a model that cannot answer leaves the message and says why', async () => {
  const { home, repos } = fresh();
  const broken = async () => { throw new Error('the model timed out\nand a second line nobody needs'); };
  const r = await say('what did you do?', { repos, about: repos[0].id, home, completeFn: broken });
  const [mine, said] = r.messages;
  assert.deepEqual([mine.role, mine.text], ['you', 'what did you do?'], 'the message is kept');
  assert.equal(said.failed, 'the model timed out', 'the first line of the reason, and only that');
  assert.deepEqual([said.text, said.did], ['', undefined], 'nothing was said and nothing was carried out');
  assert.equal(fs.existsSync(path.join(home, 'config.json')), false);
  assert.equal(chatView({ home }).messages.length, 2, 'and the conversation holds both');
});

test('with no model on this machine the message waits for a session and is answered later', async () => {
  const { home, repos } = fresh();
  const queued = [];
  const r = await say('what did you do this week?', { repos, about: repos[0].id, home, have: [], enqueue: (store, kind, args) => queued.push([kind, args.slice(0, 2)]) });
  assert.equal(r.pending, true);
  assert.equal(answer(r).pending, true);
  assert.equal(answer(r).text, '');
  assert.deepEqual(queued, [['chat', ['chat', '--answer']]]);
  const n = await chatAnswerPending({ repos, home, now: NOW + 60_000, completeFn: model({ reply: 'Caught up: two sections shortened.', actions: [] }) });
  assert.equal(n, 1);
  const last = chatView({ home }).messages.at(-1);
  assert.equal(last.text, 'Caught up: two sections shortened.');
  assert.equal(last.pending, undefined, 'it is no longer waiting');
  assert.equal(await chatAnswerPending({ repos, home, now: NOW + 120_000, completeFn: model({ reply: 'again', actions: [] }) }), 0, 'and not answered twice');
});

test('one answer may change only so much', async () => {
  const { home, repos } = fresh();
  const actions = Array.from({ length: CHAT.actions + 3 }, (_, i) => ({ type: 'set', key: 'batchEveryDays', value: String(i + 2) }));
  const r = await say('change everything you can', { repos, about: repos[0].id, home, completeFn: model({ reply: 'Done.', actions }) });
  assert.equal(answer(r).did.length, CHAT.actions);
  assert.equal(behaviorOf(repos[0].store, { home }).batchEveryDays, CHAT.actions + 1, 'the ones past the limit never ran');
});

test('what thinker is given to say about savings is the accountant\'s own count', async () => {
  const { home, repos } = fresh();
  const store = repos[0].store;
  const cell = n => ({ cost: n, tokens: n * 200_000, unpricedTokens: 0, cleared: { cost: n * 0.6, tokens: n * 120_000 }, delegated: { cost: n * 0.3, tokens: n * 60_000 }, repeated: { cost: n * 0.1, tokens: n * 20_000 } });
  const ledger = { at: NOW, day: dayKey(NOW), today: cell(2), recent: { ...cell(40), rewrite: 3, reread: 1, net: 36 }, recentDays: RECENT_DAYS, lifetime: cell(190), from: '2026-10-01T00:00:00.000Z' };
  fs.mkdirSync(path.join(store.dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(store.dir, 'state', 'savings.json'), JSON.stringify(ledger));
  const { text } = chatContext(repos, { now: NOW, home });
  for (const [window, c] of [['the fortnight', ledger.recent], ['today', ledger.today], ['lifetime', ledger.lifetime]]) {
    assert.ok(savingsDetail(c).length > 20, `${window} splits into something to say`);
    assert.ok(text.includes(savingsDetail(c)), `${window} is split by what did the saving, as the accountant splits it`);
  }
  assert.ok(text.includes(savingsNet(ledger.recent)), 'and the fortnight carries the accountant\'s net');
});

test('the conversation stays on this machine: the file is the person\'s alone and the log holds no words', async () => {
  const { home, repos } = fresh();
  const secret = 'ship the acme migration before the board call';
  await say(secret, { repos, about: repos[0].id, home, completeFn: model({ reply: 'Noted.', actions: [] }) });
  assert.equal(fs.statSync(path.join(home, 'state', 'chat.json')).mode & 0o777, 0o600);
  const text = fs.readFileSync(path.join(repos[0].store.dir, 'log.jsonl'), 'utf8');
  assert.equal(text.includes(secret), false, 'the words are nowhere in the log');
  assert.equal(text.includes('Noted.'), false);
  const rows = text.trim().split('\n').map(JSON.parse).filter(e => e.op === 'chat');
  assert.deepEqual(rows.map(e => [e.chars, e.actions]), [[secret.length, 0]], 'counts, not words');
});

test('a card attached to a message carries only what the page may send', () => {
  const good = { kind: 'action', id: 'h:a1', text: 'shortened a section' };
  const cases = [
    ['a link that is not https is dropped', { ...good, url: 'javascript:alert(1)' }, good],
    ['an id nobody wrote is dropped', { ...good, id: 'h:../../etc/passwd' }, { kind: 'action', text: good.text }],
    ['a stage the Factory does not have is no card at all', { kind: 'stage', id: 'invented', text: 'x' }, null],
    ['a card with nothing on it is no card at all', { kind: 'action', id: 'h:a1' }, null],
    ['a stage it does have comes through', { kind: 'stage', id: STAGES[0][0], text: 'x' }, { kind: 'stage', id: STAGES[0][0], text: 'x' }],
    ['a link that is https comes through', { ...good, url: 'https://github.com/o/r/pull/3' }, { ...good, url: 'https://github.com/o/r/pull/3' }],
  ];
  for (const [name, card, expected] of cases) assert.deepEqual(refOf(card), expected, name);
});


test('chat calls the normal provider path without pinning the profile model', async () => {
  const { home, repos } = fresh();
  const other = model({ reply: 'Answered through the configured provider.', actions: [] });
  const r = await say('hello', { repos, home, have: ['codex'], fns: { complete: other } });
  assert.equal(answer(r).text, 'Answered through the configured provider.');
  assert.equal(other.asked.length, 1);
  assert.equal(other.asked[0].model, 'opus', 'a tier leaves routing to the normal provider selection');
});

test('authentication failures keep the message and expose recovery for the chosen provider', async () => {
  for (const reason of [
    'claude -p exited 1: Failed to authenticate: OAuth session expired and could not be refreshed',
    'codex exec exited 1: token expired',
    'agent -p exited 1: not logged in',
    'gemini -p exited 1: authentication failed',
  ]) {
    const { home, repos } = fresh();
    const queued = [];
    const r = await say('hello', { repos, home, completeFn: async () => { throw new Error(reason); }, enqueue: (...args) => queued.push(args) });
    assert.equal(queued.length, 0, 'a login failure is actionable, not silently queued');
    assert.equal(r.messages.filter(m => m.text === 'hello').length, 1);
    const failed = answer(r).failed;
    assert.ok(failed.startsWith(reason));
    assert.ok(failed.includes('THINKER_LLM=<agent> thinker ui'));
    for (const provider of ['codex', 'claude', 'cursor', 'gemini']) assert.ok(failed.includes(provider));
    assert.ok(failed.includes('thinker chat "your message"'));
    assert.equal(answer(r).pending, undefined);
    assert.equal(chatView({ home }).messages.at(-1).failed, failed, 'the page receives the full guidance');
    assert.ok(renderChat(r.messages).join('\n').includes(failed), 'the CLI receives the same guidance');
  }
});
