// The cut policy (src/cutting.js) and the desktop door (src/clear-door.js, which the clearing mod asks through
// `thinker hook clear`). Every seam here is a pure function over plain objects: the clock comes in as `now`, the
// machine config as `config`, the record's directory as a path. Nothing in this file reaches a network, a child
// process or the machine's own home.
import { tmp } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import nodeModule from 'node:module';
import { fileURLToPath } from 'node:url';
import { decideCut, freshCut, mergeCut, cutStore, cutResponse, priceCut, policyId, placeholder, cutInput, chargedRewrite, PAYBACK, COLD_MS } from '../src/cutting.js';
import { clearAnswer, clearPays, desktopPolicy, stampOf, HOLD_GROWTH, NEVER } from '../src/clear-door.js';
import { keptCalls, keepPatterns, writeKeep } from '../src/keep.js';
import { PROXY_DEFAULTS, resultTokens } from '../src/proxy.js';
import { SERVICE_HOLDOUT } from '../src/proxy-service.js';

const cfg = { ...PROXY_DEFAULTS };
const MOD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'integrations', 'claude-clear', 'hooks', 'register.tsx');
// a candidate as proxy.js:cutCandidates hands one over: the ids it would replace, what they come to, and what
// the rewrite would be. `rungs` makes the ladder, deepest last, which is the whole-set candidate.
const rung = (ids, tokens, recache) => ({ ids, tokens, recache });
const rungs = steps => ({ ...steps[steps.length - 1], steps });
const PAYS = rung(['a'], 30000, 20000);          // repaid in 12 later calls
const NEVER_PAYS = rung(['a'], 9000, 2000000);   // a small cut behind a huge tail

// a desktop conversation as the mod hands one over
const big = n => 'x'.repeat(n);
const said = text => ({ role: 'user', text, toolUses: [] });
const pair = (id, chars, tool = 'Read', input = {}) => [
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input }] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: big(chars) }] },
];
const BIG_RESULT = resultTokens(big(150000));
// two old results worth taking; newer ones the recency rule holds back, one too short to be worth a placeholder,
// and the running turn's, which is the model's working set
const conversation = [said('go'), ...pair('a', 150000), ...pair('b', 150000), ...pair('c', 100), ...pair('d', 300), ...pair('e', 300), said('now'), ...pair('f', 300)];
const small = [said('go'), ...pair('a', 300), ...pair('b', 300), ...pair('c', 300), ...pair('d', 300), said('now'), ...pair('e', 300)];

test('out of the box the cutting is on, and no session is held out of it', () => {
  assert.equal(PROXY_DEFAULTS.cut, true, 'every install cuts');
  assert.equal(SERVICE_HOLDOUT, 0, 'and no session is kept out of it to be compared: a cut is rare, and a holdout takes its share of exactly the few long sessions the saving is in');
  const d = decideCut(freshCut('s'), PROXY_DEFAULTS, { prompt: PROXY_DEFAULTS.trigger, turn: 1 }, { cand: PAYS });
  assert.equal(d.clear, true, 'the defaults alone cut a conversation past the trigger');
  assert.equal(d.reason, undefined, 'nothing refused it');
  assert.equal(clearAnswer({ op: 'start', session: 's' }, { config: {} }).auto, true, 'and the desktop door clears a session of its own accord');
  assert.equal(clearAnswer({ op: 'decide', from: 'auto', session: 's', tokens: 200000, messages: conversation }, { config: {} }).clear, true, 'with nothing in the machine config');
});

test('nothing is cut below the trigger, with too little to take, or with nothing finished, and the answer says which', () => {
  for (const [reason, prompt, cand] of [
    ['below-trigger', cfg.trigger - 1, PAYS],
    ['below-clear-minimum', cfg.trigger, rung(['a'], cfg.clearAtLeast - 1, 1000)],
    ['nothing-to-cut', cfg.trigger, null],
  ]) {
    const d = decideCut(freshCut('s'), cfg, { prompt, turn: 1 }, { cand });
    assert.equal(d.reason, reason, `a prompt of ${prompt} with ${cand ? cand.tokens : 0} to take`);
    assert.equal(d.clear, false, reason);
    assert.equal(d.cut.length, 0, reason);
  }
});

test('past the trigger at the start of a turn, a cut that pays is made', () => {
  const d = decideCut(freshCut('s'), cfg, { prompt: cfg.trigger, turn: 1 }, { cand: PAYS, now: 1e9 });
  assert.equal(d.clear, true);
  assert.ok(d.cut.includes('a'), 'the result it chose is in the set');
  assert.equal(d.turn, 1, 'the boundary is recorded, so the set cannot move again inside this turn');
  assert.equal(d.tokens, PAYS.tokens, 'the row says what left the prompt');
  assert.ok(d.payback <= PAYBACK, 'and that it repays inside the limit');
  assert.equal(d.cold, false);
});

test('a cut that would not repay inside the payback limit is refused, and says what it held back', () => {
  const d = decideCut(freshCut('s'), cfg, { prompt: 500000, turn: 1 }, { cand: NEVER_PAYS });
  assert.equal(d.reason, 'payback');
  assert.equal(d.clear, false);
  assert.equal(d.cut.length, 0);
  assert.equal(d.held.tokens, NEVER_PAYS.tokens, 'the rung it refused');
  assert.equal(d.held.pays, false);
  assert.ok(d.held.payback > PAYBACK, 'refused for the calls it would take to repay');
  assert.equal(d.candidate, NEVER_PAYS.tokens, 'and the log can still say what a cut was worth');
});

test('inside a turn the cut does not move', () => {
  const rec = { ...freshCut('s'), cut: ['old'], turn: 4 };
  const d = decideCut(rec, cfg, { prompt: 500000, turn: 4 }, { cand: PAYS });
  assert.equal(d.reason, 'mid-turn');
  assert.equal(d.clear, false);
  assert.deepEqual(d.cut, ['old'], 'the same set, so the request is the bytes it was');
  // the control: the very same request at the next boundary does cut
  assert.equal(decideCut(rec, cfg, { prompt: 500000, turn: 5 }, { cand: PAYS }).clear, true);
});

test('a stale copy of a conversation\'s record cannot undo a newer one', () => {
  const fresh = { ...freshCut('s'), cut: ['a', 'b'], turn: 3, calls: 9, clears: 2, saved: 500 };
  const stale = { ...freshCut('s'), cut: [], turn: 1, calls: 1, clears: 0, saved: 10 };
  const merged = mergeCut(fresh, stale);
  assert.deepEqual(merged.cut, ['a', 'b'], 'the set the furthest-on turn reserved');
  assert.equal(merged.turn, 3, 'the turn only rises');
  assert.equal(merged.calls, 9, 'and no counter falls');
  assert.deepEqual(mergeCut(fresh, { ...stale, turn: 3, cut: ['c'] }).cut, ['a', 'b', 'c'], 'two requests of one boundary take both sets');
  assert.deepEqual(mergeCut(fresh, { ...stale, session: 'other' }).cut, [], 'another conversation is its own record');
  // and the same through the store, where the two requests each hold their own clone
  const store = cutStore(tmp('cut'));
  store.write({ ...fresh });
  const back = store.write({ ...stale });
  assert.equal(back.cut.length, 2, 'the stale request is handed the set that stands');
  assert.equal(store.read('s').turn, 3);
});

test('when the answer to a cut lands, the record and the row say what left the prompt', () => {
  const rec = freshCut('s');
  const made = { turn: 2, cut: ['a'], clear: true, tokens: 30000, recache: 20000, cost: 35000, payback: 12, clientCut: { chars: 60000, tokens: 30000, cut: 3 } };
  const [ev] = cutResponse(rec, cfg, made, { read: 1, write: 2 }, { now: 1000 });
  assert.equal(ev.clear, true);
  assert.equal(ev.tokens, made.tokens, 'what the cut took out, which is the figure every saving is read from');
  assert.equal(ev.recache, made.recache, 'what it had written again');
  assert.equal(ev.cost, made.cost); assert.equal(ev.payback, made.payback);
  assert.equal(ev.results, 3, 'and how many results it was');
  assert.equal(rec.clears, 1, 'the record counts the clear');
  assert.ok(rec.saved > 0, 'the cut is worth a read of those tokens on this call and every later one');
  // an answer that arrives after a later request has reserved the next boundary cannot roll the set back
  assert.deepEqual(cutResponse(rec, cfg, { turn: 1, cut: [], clear: false }, { read: 1, write: 2 }, { now: 2000 }), []);
  assert.equal(rec.turn, 2); assert.deepEqual(rec.cut, ['a']);
});

test('a session picked up cold obeys the same trigger and size floor', () => {
  const now = 1e12;
  const cold = { ...freshCut('s'), at: now - COLD_MS - 1 };
  assert.equal(decideCut(cold, cfg, { prompt: cfg.trigger - 1, turn: 1 }, { cand: PAYS, now }).reason, 'below-trigger');
  assert.equal(decideCut(cold, cfg, { prompt: cfg.trigger, turn: 1 }, { cand: rung(['a'], cfg.clearAtLeast - 1, 10), now }).reason, 'below-clear-minimum');
  const d = decideCut(cold, cfg, { prompt: cfg.trigger, turn: 1 }, { cand: PAYS, now });
  assert.equal(d.clear, true, 'past both guards a resumed session is cut like a live one');
  assert.equal(d.cold, true, 'and the row says the cache had expired');
});

test('of the rungs that pay, the one that saves most is taken, not the deepest', () => {
  const ladder = rungs([rung(['a'], 9000, 10000), rung(['a', 'b'], 20000, 25000), rung(['a', 'b', 'c'], 30000, 300000)]);
  const d = decideCut(freshCut('s'), cfg, { prompt: 500000, turn: 1 }, { cand: ladder });
  assert.equal(d.clear, true);
  assert.deepEqual(d.cut, ['a', 'b'], 'the largest rung that repays');
  assert.equal(d.tokens, 20000);
  assert.equal(d.depth, 2, 'how far back it reached');
  assert.equal(d.rungs, 3, 'and that it had a choice');
});

test('with cutting switched off neither door cuts, both stamp it off, and both still say what they would have taken', () => {
  const off = { ...cfg, cut: false };
  const d = decideCut(freshCut('s'), off, { prompt: 500000, turn: 1 }, { cand: PAYS });
  assert.equal(d.reason, 'off');
  assert.equal(d.clear, false);
  assert.equal(d.candidate, PAYS.tokens, 'what this boundary gave up');
  assert.equal(d.policy, policyId(off), 'a saving under one policy is never pooled with the other');
  assert.notEqual(d.policy, policyId(cfg));
  const door = desktopPolicy({ proxy: { cut: false } });
  assert.equal(door.auto, false, 'the desktop door clears nothing either');
  assert.equal(stampOf(door), policyId({ ...PROXY_DEFAULTS, cut: false, cutInputs: false, cutImages: false, cutBreakpoint: false, cutThinking: false }));
  const a = clearAnswer({ op: 'decide', from: 'auto', session: 's', tokens: 500000, messages: conversation }, { config: { proxy: { cut: false } } });
  assert.equal(a.clear, false);
  assert.equal(a.reason, 'off');
  assert.equal(a.askAt, NEVER, 'and it is not asked again');
});

test('the newest copy of a file the person works from stays in the prompt', () => {
  const read = (id, file, more = {}) => ({ id, name: 'Read', input: { file_path: file, ...more } });
  const shell = (id, command) => ({ id, name: 'Bash', input: { command } });
  const calls = [
    read('md1', '/r/notes.md'), read('md2', '/r/notes.md'),            // a *.md read twice
    read('py1', '/r/core.py'), read('py2', '/r/core.py', { offset: 1, limit: 20 }),
    read('log1', '/r/run.log'), read('log2', '/r/run.log'),            // nobody's notes
    read('cut1', '/r/plan.txt'), read('cut2', '/r/plan.txt'),          // cut once, then read again
    shell('sh1', 'cat /r/README.md'), shell('sh2', 'cat /r/README.md | head -5'),
  ];
  const { ids, files } = keptCalls(calls, { prompts: ['have another look at core.py please'], cut: ['cut1'] });
  const why = Object.fromEntries(files.map(f => [f.id, f.why]));
  assert.equal(why.md2, 'pattern', 'notes are written to be carried from one call to the next');
  assert.equal(why.py1, 'named', 'the person named this one');
  assert.equal(why.cut2, 'reread', 'a file is lost at most once');
  assert.equal(why.sh1, 'pattern', 'the notes are kept however the model read them, a shell line included');
  assert.ok(!ids.has('md1'), 'an older copy of a kept file still goes');
  assert.ok(!ids.has('log1') && !ids.has('log2'), 'an ordinary read is the cut\'s to take');
  assert.ok(!ids.has('py2'), 'a few lines of a file never displace the whole read of it');
  assert.ok(!ids.has('sh2'), 'nor does a line that only passed a few of them on');
});

test('what the profile learned the person points at is kept, and each checkout\'s list is its own', () => {
  const dir = tmp('keep-home'), at = Date.now();
  const learned = ['plan.txt', 'https://site.com/insights'];
  assert.equal(writeKeep('/r/one', learned, { dir, now: at }), true, 'a list the profile learned is written');
  assert.equal(writeKeep('/r/one', learned, { dir, now: at }), false, 'and writing the same list again changes nothing');
  assert.equal(writeKeep('/r/two', ['other.txt'], { dir, now: at }), true);
  const patterns = keepPatterns({ dir, now: at + 2000 });
  for (const p of [...learned, 'other.txt']) assert.ok(patterns.includes(p), `${p} is read back, by whichever door asks`);
  const call = (id, name, input) => ({ id, name, input });
  const { ids } = keptCalls([call('p1', 'Bash', { command: 'cat /r/one/plan.txt' }),
    call('u1', 'WebFetch', { url: 'https://site.com/insights?range=7d' }), call('u2', 'Bash', { command: 'curl https://site.com/insights | jq .' })], { patterns });
  assert.ok(ids.has('p1'), 'a file the person points at is kept from then on');
  assert.ok(ids.has('u1'), 'so is a page they point at, and the pages under it');
  assert.ok(!ids.has('u2'), 'a fetch piped on somewhere else is no copy of the page');
  // a checkout's list is replaced on its own; what it no longer points at goes, and nobody else's list moves
  assert.equal(writeKeep('/r/one', ['plan.txt'], { dir, now: at }), true);
  const after = keepPatterns({ dir, now: at + 4000 });
  assert.ok(!after.includes('https://site.com/insights'), 'the address this checkout no longer points at');
  assert.ok(after.includes('other.txt'), 'and another checkout\'s is untouched');
});

test('the desktop door clears exactly where the proxy\'s pricing says a cut pays', () => {
  const p = desktopPolicy(null);
  let pays = 0, refuses = 0;
  for (const model of ['claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2']) {
    for (const tokens of [6000, 20000, 60000, 105472, 200000]) {
      // the last three are tails that repay on the very last call allowed, one for each read rate in the list:
      // a door whose arithmetic is a single call out agrees everywhere else and differs here
      for (const ratio of [0.5, 1, 1.21, 1.5, 1.94, 2.5, 4, 10, 1.342, 0.654, 0.323]) {
        const recache = Math.round(tokens * ratio);
        const proxy = priceCut(null, { tokens, recache }, { model }).pays;
        const door = clearPays(p, { dropped: tokens, recache, cleared: false, model });
        assert.ok(door === proxy, `${model}, a tail ${ratio}x a cut of ${tokens}: door ${door}, proxy ${proxy}`);
        proxy ? pays++ : refuses++;
      }
    }
  }
  assert.ok(pays > 0 && refuses > 0, 'the grid covers both sides of the decision');
  assert.equal(stampOf(p), policyId({ ...PROXY_DEFAULTS, cutInputs: false, cutImages: false, cutBreakpoint: false, cutThinking: false }), 'one policy, one name for it');
});

// Every key of the proxy's clearing policy must reach the desktop door, or say here why a mod inside a session
// cannot have it. The drift this stops: a key turned on in the proxy alone, with the suite green.
const DESKTOP_POLICY = {
  cut: { honoured: true },
  trigger: { honoured: true },
  clearAtLeast: { honoured: true },
  keepMin: { honoured: true },
  clearDeep: { honoured: true },
  holdout: { honoured: true, value: SERVICE_HOLDOUT },   // the service's share, so a held-out session stays held out
  upstream: { exempt: 'where the proxy forwards a request; a mod inside the session edits the conversation and sends nothing anywhere' },
  cutInputs: { exempt: 'in the desktop app a call\'s own text is a file path and not a heredoc, so there is nothing there worth taking' },
  cutImages: { exempt: 'the host hands a mod each tool result as its text alone, so a screenshot is not there for it to save or to take out' },
  cutBreakpoint: { exempt: 'a cache breakpoint is a field of the request to the API, which the proxy forwards and a mod inside the session never sees' },
  cutThinking: { exempt: 'a thinking block is part of the request to the API; the host hands a mod the tool results alone' },
  thinkingKeepTurns: { exempt: 'how many earlier turns keep their thinking, which a mod cannot leave out at all' },
};
test('every setting of the proxy\'s clearing is honoured by the desktop door or written down as one it cannot have', () => {
  const door = desktopPolicy(null);
  for (const key of Object.keys(PROXY_DEFAULTS)) {
    const d = DESKTOP_POLICY[key];
    assert.ok(d, `proxy.${key} is new and this door knows nothing about it: honour it in clear-door.js:desktopPolicy and add { honoured: true } here, or add { exempt: '<why a mod inside the session cannot have it>' }`);
    if (d.honoured) assert.equal(door[key], 'value' in d ? d.value : PROXY_DEFAULTS[key], `this door's ${key} is the proxy's`);
    else assert.ok(String(d.exempt).length > 40 && !(key in door), `proxy.${key} is exempt with a reason, and not half-honoured`);
  }
  for (const key of Object.keys(DESKTOP_POLICY)) assert.ok(key in PROXY_DEFAULTS, `${key} is no longer a setting of the proxy's`);
  assert.equal(desktopPolicy({ proxy: { trigger: 90000, clearAtLeast: 20000, keepMin: 5 } }).trigger, 90000, 'and the machine config moves this door with the proxy');
});

test('the desktop door clears a conversation that is mostly finished results, and names what goes', () => {
  const ev = { from: 'auto', session: 's', tokens: 200000, messages: conversation };
  const d = clearAnswer({ op: 'decide', ...ev }, { config: {} });
  assert.equal(d.clear, true, 'a context this far past the trigger, held up mostly by old results, pays');
  assert.equal(d.depth, 2, 'both of the old results');
  const a = clearAnswer({ op: 'apply', ...ev, depth: d.depth }, { config: {} });
  assert.equal(a.cleared, 2);
  assert.deepEqual(Object.keys(a.replace).sort(), ['a', 'b'], 'the two oldest results, by id');
  assert.ok(!('f' in a.replace), 'nothing of the turn the model is working in');
  assert.equal(a.tokens, 2 * BIG_RESULT, 'and what they came to');
  assert.equal(a.skip, undefined);
  // the floor is the automatic clear's; a person who asks for one gets it
  const auto = clearAnswer({ op: 'apply', from: 'auto', session: 's', messages: small }, { config: {} });
  assert.ok(auto.skip && auto.skip.includes('under'), 'too little to be worth a rewrite');
  const manual = clearAnswer({ op: 'apply', from: 'manual', session: 's', messages: small }, { config: {} });
  assert.equal(manual.skip, undefined);
  assert.ok(manual.cleared > 0, 'a hand-run clear takes what there is');
});

test('a session the proxy already serves, one held out, or a test is left alone, and the answer says which', () => {
  for (const [reason, ev, config] of [
    ['proxied', { baseUrl: 'http://127.0.0.1:4000' }, {}],
    ['test', { test: true }, {}],
    ['holdout', {}, { proxy: { holdout: 1 } }],
  ]) {
    const base = { session: 's', tokens: 500000, messages: conversation, ...ev };
    const d = clearAnswer({ op: 'decide', from: 'auto', ...base }, { config });
    assert.equal(d.clear, false, reason);
    assert.equal(d.reason, reason, reason);
    assert.equal(d.askAt, NEVER, `${reason}: and it is not asked again`);
    assert.equal(clearAnswer({ op: 'start', ...base }, { config }).auto, false, `${reason}: the session is told at its start`);
  }
  assert.equal(clearAnswer({ op: 'start', session: 's' }, { config: {} }).auto, true, 'an ordinary session is cleared by this door');
});

test('an attempt that cleared nothing is held until the context has grown, not asked again after every answer', () => {
  const base = { op: 'decide', from: 'auto', session: 's', messages: conversation };
  const below = clearAnswer({ ...base, tokens: cfg.trigger - 1 }, { config: {} });
  assert.equal(below.reason, 'below-trigger');
  assert.equal(below.askAt, cfg.trigger, 'the context to come back at');
  const held = clearAnswer({ ...base, tokens: 500000, holdUntil: 900000 }, { config: {} });
  assert.equal(held.clear, false);
  assert.equal(held.reason, 'held');
  assert.equal(held.askAt, 900000, 'while an attempt is held, nothing is asked until the context gets there');
  assert.equal(held.hold, HOLD_GROWTH, 'how far a failed attempt holds the next');
  assert.ok(HOLD_GROWTH > PROXY_DEFAULTS.clearAtLeast, 'the hold is a window of its own, not the size floor a session grows through in a turn');
});

test('what stands in a cut result\'s place says it was removed after use and how big it was, and a cut call keeps its arguments', () => {
  const said = placeholder(40000);
  assert.ok(said.includes('removed by thinker after use'), 'the model is told when it went, not that it never had it');
  assert.ok(said.includes('40000'), 'and what it was');
  const cut = cutInput({ command: big(500), description: 'list the files', file_path: '/r/a.js', all: true }, {});
  assert.deepEqual(Object.keys(cut.input).sort(), ['all', 'command', 'description', 'file_path'], 'every key the agent sent stays');
  assert.equal(cut.input.description, 'list the files', 'a short value stays verbatim');
  assert.equal(cut.input.file_path, '/r/a.js');
  assert.equal(cut.input.all, true);
  assert.ok(cut.input.command.includes('500'), 'only the long body goes, and says how long it was');
  assert.equal(cut.chars, 500);
  assert.equal(cutInput({ description: 'ls', file_path: '/r/a.js' }, {}), null, 'a call with nothing long in it is not touched');
});

test('a conversation\'s record outlives the proxy, and a request with no session writes nothing', () => {
  const dir = tmp('cut');
  const store = cutStore(dir);
  const rec = store.read('s1');
  rec.cut = ['a', 'b']; rec.turn = 2; rec.clears = 1;
  store.write(rec);
  const after = cutStore(dir);   // a proxy that was restarted reads the record off the disk
  assert.deepEqual(after.read('s1').cut, ['a', 'b']);
  assert.equal(after.read('s1').turn, 2);
  assert.equal(after.read('s2').cut.length, 0, 'a conversation with no record starts empty');
  const files = fs.readdirSync(dir).length;
  store.write({ ...freshCut(''), cut: ['x'] });
  assert.equal(fs.readdirSync(dir).length, files, 'a request thinker cannot name a session for leaves nothing behind');
});

// The mod is frozen for as long as a session stays open (an update never replaces the folder a running session
// loaded), so a policy inside it goes on deciding by the rules of the release the session was opened under.
test('the clearing mod decides nothing itself: it asks the installed thinker', () => {
  const src = fs.readFileSync(MOD, 'utf8');
  for (const name of ['TRIGGER', 'CLEAR_AT_LEAST', 'KEEP_MIN', 'HOLDOUT', 'PAYBACK', 'COLD_MS', 'MIN_CHARS', 'RESULT_WEIGHTS', 'TOKENS_PER_CHAR', 'KEEP_DEFAULT', 'POLICY_REV']) {
    assert.ok(!new RegExp(`\\b(const|let) ${name}\\b`).test(src), `${name} is the installed thinker's: a copy here is frozen for as long as a session stays open`);
  }
  for (const fn of ['policyId', 'clearPays', 'clearLadder', 'chooseDepth', 'keptOf', 'keepMatcher', 'heldOut', 'resultTokens', 'placeholder', 'readRate']) {
    assert.ok(!new RegExp(`\\b(function|const) ${fn}\\b`).test(src), `${fn} is decided by the installed thinker, not in the mod`);
  }
  assert.ok(src.includes("'hook', 'clear'"), 'the mod asks the CLI the settings name');
  for (const op of ['start', 'decide', 'apply']) {
    assert.ok(src.includes(`op: '${op}'`), `the mod asks "${op}"`);
    assert.ok(Object.keys(clearAnswer({ op, from: 'auto', session: 's', messages: [] }, { config: {} })).length > 1, `and the installed thinker answers "${op}"`);
  }
});

// What a clear cost is counted twice over, once in each door, and only this holds the two together: the mod's
// runner (`claude plugin test`) refuses an import from outside the plugin's folder, so the comparison can only be
// made here. The mod is transpiled and imported, which also fails where the file would not load at all -- #888
// left two `const answer` in one function and the mod did nothing in any session, with the suite green.
test('the clearing mod charges a clear what the proxy charges it', { skip: !nodeModule.stripTypeScriptTypes && 'this Node cannot strip types (22.13 or newer does); the release runs it' }, async () => {
  const warned = process.emitWarning;
  process.emitWarning = (...a) => { if (!String(a[0]).includes('stripTypeScriptTypes')) warned(...a); };
  let mod;
  try {
    const js = nodeModule.stripTypeScriptTypes(fs.readFileSync(MOD, 'utf8'), { mode: 'strip' });
    mod = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
  } finally { process.emitWarning = warned; }
  for (const [usage, why] of [
    [{ write: 150000, read: 12000 }, 'a warm prefix written again is the clear\'s to pay for'],
    [{ write: 150000, read: 0 }, 'a request that read nothing back found the cache gone, and that write was coming anyway'],
    [{ write: 0, read: 12000 }, 'a request that only read costs a clear nothing'],
    [{ write: 0, read: 0 }, 'nor one that did neither'],
  ]) {
    assert.equal(mod.chargedRewrite(usage), chargedRewrite(usage), why);
  }
  // and the running count, over the API's own field names, charged on the one request a clear changed
  const api = (write, read) => ({ cache_creation_input_tokens: write, cache_read_input_tokens: read });
  assert.deepEqual(mod.charge({ rewrites: 1, write: 100 }, api(150000, 12000)), { rewrites: 2, write: 150100 });
  assert.deepEqual(mod.charge(undefined, api(150000, 0)), { rewrites: 0, write: 0 }, 'a cold cache is nobody\'s cost');
  assert.deepEqual(mod.charge({ rewrites: 1, write: 100 }, api(150000, 12000), false), { rewrites: 1, write: 100 }, 'a rewrite on any later request was coming without the clear');
});
