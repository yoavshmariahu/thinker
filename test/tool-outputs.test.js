import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionOutputs, toolKey } from '../src/tool-outputs.js';

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
