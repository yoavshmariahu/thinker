import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionOutputs, toolKey, aggregateOutputs, recordKey, splitKey } from '../src/tool-outputs.js';

const prompt = text => ({ t: 'prompt', text });
const sh = (command, result) => ({ t: 'tool', name: 'Bash', input: { command }, result });
const edit = (file_path, old_string) => ({ t: 'tool', name: 'Edit', input: { file_path, old_string, new_string: 'z' }, result: 'ok' });
const body = 'export function parse(input) { return input.trim().split("\\n"); }\n', T = Math.ceil(body.length / 4);

test('a result costs every model call after it, and is wasted after the agent last used it', () => {
  // five tool calls, one model call each: the sed result (call 0) is read by calls 1..4; the Edit (call 2) copies its text
  const events = [prompt('fix parse'), sh('sed -n 1,40p src/a.js', body), sh('git status', 'clean'), edit('/r/src/a.js', body.trim()), sh('npm test', 'ok'), sh('git diff', '')];
  const by = sessionOutputs(events, 0);
  const sed = by['Bash:sed'];
  assert.equal(sed.calls, 1);
  assert.equal(sed.tokens, T);
  assert.equal(sed.input, T * 5, 'read by itself and the four calls after it');
  assert.equal(sed.unneeded, T * 2, 'the two calls after the edit that copied its text');
  // the git status result (call 1) is never used again: every read but the first is unneeded
  assert.equal(by['Bash:git status'].unneeded, Math.ceil('clean'.length / 4) * 3);
  assert.equal(by['Bash:git status'].input, Math.ceil('clean'.length / 4) * 4);
});

test('a later call on the same file counts as use; the next turn does not', () => {
  const events = [prompt('look'), sh('sed -n 1,40p src/a.js', body), sh('grep -n parse src/a.js', '1:export'), sh('ls', 'a'), prompt('now b'), sh('sed -n 1,9p src/a.js', body), sh('ls', 'b')];
  const by = sessionOutputs(events, 0);
  // first sed (call 0 of 5): used by the grep on a.js (call 1); the second turn's sed on a.js (call 3) is not its use
  assert.equal(by['Bash:sed'].input, T * 5 + T * 2);
  assert.equal(by['Bash:sed'].unneeded, T * 3 + T * 1);
});

test('a compaction stops the reads of the results before it', () => {
  const events = [prompt('a'), sh('cat x.txt', body), sh('ls', 'a'), sh('ls', 'b'), sh('ls', 'c')];
  // compaction after event 2 (the cat and the first ls are before it): the cat is read by itself and the first ls only
  const by = sessionOutputs(events, 0, [3]);
  assert.equal(by['Bash:cat'].input, T * 2);
  assert.equal(by['Bash:cat'].unneeded, T * 1);
  assert.equal(sessionOutputs(events, 0)['Bash:cat'].input, T * 4, 'without one, every call after it');
});

test('several tool calls in one model call scale the reads down', () => {
  const events = [prompt('a'), sh('cat x.txt', body), sh('ls', 'a'), sh('ls', 'b'), sh('ls', 'c')];
  const by = sessionOutputs(events, 2); // 4 tool calls over 2 model calls: each tool call left counts 2/5 of a read
  assert.equal(by['Bash:cat'].input, Math.round(T * Math.max(1, 4 * 0.4)));
  assert.equal(by['Bash:cat'].unneeded, Math.round(T * 3 * 0.4));
});

test('tool keys: a shell command by its program, an MCP server as one', () => {
  assert.equal(toolKey('Bash', { command: 'cd x && sed -n 1,5p a' }), 'Bash:sed');
  assert.equal(toolKey('mcp__artemis__get_session', {}), 'mcp:artemis');
});

// A tool's results are measured under the compression setting they ran with: `Bash:sed` for calls made with none,
// `Bash:sed@moderate` for calls made while it was set to moderate (diet.js:dietTimeline gives levelAt)
const T0 = Date.parse('2026-10-22T12:00:00Z'), SET = Date.parse('2026-10-22T20:00:00Z');
const levelAt = (key, at) => key === 'Bash:sed' && at >= SET ? 'moderate' : null;
test('a call is keyed by the compression its tool had when it was made', () => {
  const events = [prompt('a'), { ...sh('sed -n 1,40p a.js', body), at: T0 }, { ...sh('sed -n 1,40p b.js', body), at: SET + 1 }, { ...sh('ls', 'x'), at: SET + 2 }];
  const by = sessionOutputs(events, 0, [], { levelAt });
  assert.deepEqual(Object.keys(by).sort(), ['Bash:ls', 'Bash:sed', 'Bash:sed@moderate']);
  assert.equal(by['Bash:sed'].calls, 1); assert.equal(by['Bash:sed@moderate'].calls, 1);
  // a call without a time is given to the caller's levelAt as undefined: the caller takes the session's time
  assert.deepEqual(Object.keys(sessionOutputs([prompt('a'), sh('sed -n 1p a', body)], 0, [], { levelAt: (k, at) => at === undefined ? 'high' : null })), ['Bash:sed@high']);
  assert.deepEqual(splitKey(recordKey('Bash:sed', 'moderate')), { name: 'Bash:sed', level: 'moderate' });
  assert.deepEqual(splitKey('mcp:artemis'), { name: 'mcp:artemis', level: null });
});

test('aggregateOutputs: a row per tool and setting, each over the sessions that ran under it, linked to the tool\'s other rows', () => {
  const rec = (at, by) => ({ at, t: at, by });
  const sed = (input, unneeded = 0) => ({ calls: 1, tokens: 100, input, unneeded, saveModerate: 0, saveHigh: 0 });
  // three sessions before the setting, two after; the second session after it called sed twice as one record
  const recs = [rec(T0, { 'Bash:sed': sed(1000, 800) }), rec(T0 + 1, { 'Bash:sed': sed(2000, 1600) }), rec(T0 + 2, { 'Bash:ls': { calls: 1, tokens: 10, input: 40, unneeded: 30, saveModerate: 0, saveHigh: 0 } }),
    rec(SET + 1, { 'Bash:sed@moderate': sed(300, 100) }), rec(SET + 2, { 'Bash:sed@moderate': { ...sed(500, 100), calls: 2 } })];
  const r = aggregateOutputs(recs, { levelAt });
  const before = r.tools.find(t => t.name === 'Bash:sed' && t.level === null), after = r.tools.find(t => t.name === 'Bash:sed' && t.level === 'moderate');
  assert.equal(r.sessions, 5);
  assert.deepEqual([before.sessions, before.usedIn, before.perSession, before.wasted, before.from, before.to], [3, 2, 1000, 800, T0, T0 + 2], 'the three sessions until the setting, two of which called it');
  assert.deepEqual([after.sessions, after.usedIn, after.perSession, after.wasted, after.calls, after.from, after.to], [2, 2, 400, 100, 1.5, SET + 1, SET + 2], 'the two sessions since');
  assert.deepEqual(after.others.map(o => [o.level, o.sessions, o.perSession]), [[null, 3, 1000]]);
  assert.deepEqual(before.others.map(o => [o.level, o.sessions, o.perSession]), [['moderate', 2, 400]]);
  assert.deepEqual(r.tools.find(t => t.name === 'Bash:ls').others, []);
  // the totals are over every session, whatever the settings: (1000 + 2000 + 40 + 300 + 500) / 5
  assert.equal(r.perSession, 768); assert.equal(r.wasted, Math.round((800 + 1600 + 30 + 100 + 100) / 5));
  // without a timeline, one row a tool over every session, as before
  const plain = aggregateOutputs(recs.map(x => ({ ...x, by: Object.fromEntries(Object.entries(x.by).map(([k, v]) => [splitKey(k).name, v])) })));
  assert.deepEqual(plain.tools.filter(t => t.name === 'Bash:sed').map(t => [t.level, t.sessions]), [[null, 5]]);
});
