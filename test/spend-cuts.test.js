// Spending less on learning and upkeep: quiet sessions are not distilled, the distiller is not
// asked for kinds this checkout archives, and a verification answers with a verdict and a sentence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store, KINDS } from '../src/store.js';
import { VERIFY_SCHEMA, VERIFY_MAX_TOKENS, distillKinds, REVIEW_KINDS } from '../src/ops.js';
import { sessionStakes, quietSession, distillSpec, saveNotes, QUIET_MIN_EXPLORE } from '../src/distill.js';

process.env.THINKER_TELEMETRY = 'off';
const CLI = new URL('../src/cli.js', import.meta.url).pathname;
const tool = (name, input, result = '') => ({ t: 'tool', name, input, result });
const reads = n => Array.from({ length: n }, (_, i) => tool('Read', { file_path: `src/f${i}.js` }, 'export const x = 1;'));

test('what a session put at stake: edits, failed tool calls, corrections', () => {
  const quiet = [{ t: 'prompt', text: 'where is the ranking?' }, ...reads(3), { t: 'say', text: 'in rank.js' }];
  assert.deepEqual(sessionStakes(quiet), { edits: 0, failures: 0, corrections: 0, any: false });
  assert.equal(sessionStakes([...quiet, tool('Edit', { file_path: 'src/rank.js', old_string: 'a', new_string: 'b' })]).edits, 1);
  assert.equal(sessionStakes([...quiet, tool('Bash', { command: "sed -i '' 's/a/b/' src/rank.js" })]).edits, 1, 'a shell command that writes a file in place');
  assert.equal(sessionStakes([...quiet, tool('Bash', { command: 'npm test' }, 'TypeError: x is not a function\n    at ...')]).failures, 1);
  assert.equal(sessionStakes([...quiet, { t: 'prompt', text: 'no, that is the wrong file' }]).corrections, 1);
  assert.equal(sessionStakes([{ t: 'prompt', text: 'No, revert that' }]).corrections, 0, 'the first prompt corrects nothing');
});

test('a quiet session is one with nothing served, nothing at stake and little exploration', () => {
  const quiet = [{ t: 'prompt', text: 'where is the ranking?' }, ...reads(3), { t: 'say', text: 'in rank.js' }];
  assert.equal(QUIET_MIN_EXPLORE, 8);
  assert.equal(quietSession(quiet), true);
  assert.equal(quietSession(quiet, { served: 1 }), false, 'served notes need their assessment');
  assert.equal(quietSession([...quiet, ...reads(6)]), false, 'nine exploration calls is a session worth distilling');
  assert.equal(quietSession([...quiet, tool('Write', { file_path: 'x' })]), false);
  assert.equal(quietSession(quiet, { minExplore: 0 }), false, '0 keeps every session');
});

test('the distiller is not asked for archived kinds, and a note of one is not saved', () => {
  const all = distillSpec({});
  assert.deepEqual(all.schema.properties.notes.items.properties.kind.enum, KINDS.filter(k => k !== 'behavior')); // a desired behavior is a person's (behavior.js)
  assert.ok(!/Do not produce notes of these kinds/.test(all.system));
  const some = distillSpec({ kinds: KINDS.filter(k => k !== 'map') });
  assert.deepEqual(some.schema.properties.notes.items.properties.kind.enum, ['howto', 'rule']);
  assert.match(some.system, /Do not produce notes of these kinds: map\./);
  // what a checkout with the default archive asks for: everything but location; review reads the
  // rules from the archive, so they are still distilled
  const dir0 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-spend-')));
  const s0 = new Store(dir0).init();
  assert.deepEqual(distillKinds(s0), ['map', 'howto', 'rule']); // no kind is archived by default
  assert.ok(REVIEW_KINDS.includes('rule'));
  fs.writeFileSync(path.join(s0.dir, 'config.json'), JSON.stringify({ archive: { kinds: ['overview'] } })); // the old name means map
  assert.deepEqual(distillKinds(new Store(dir0)), ['howto', 'rule']);
  fs.writeFileSync(path.join(s0.dir, 'config.json'), JSON.stringify({ archive: false }));
  assert.deepEqual(distillKinds(new Store(dir0)), KINDS.filter(k => k !== 'behavior'));
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-spend-')));
  fs.mkdirSync(path.join(dir, 'src')); fs.writeFileSync(path.join(dir, 'src/a.js'), 'export function f() {}\n');
  const store = new Store(dir).init();
  const note = kind => ({ title: `${kind} note about f`, kind, answers: [`${kind} of f`], body: 'src/a.js:f does it', deps: [{ path: 'src/a.js', symbol: 'f' }], tags: [], confidence: 0.8 });
  const r = saveNotes(store, [note('location'), note('gotcha')], { source: { type: 'agent', ref: 't' }, kinds: KINDS.filter(k => k !== 'map') }); // the old names are the new kinds
  assert.equal(r.saved.length, 1); assert.equal(r.saved[0].kind, 'rule');
  assert.equal(r.skipped.length, 1); assert.match(r.skipped[0].reason, /kind map is not served/);
  const r2 = saveNotes(store, [note('location')], { source: { type: 'agent', ref: 't' } });
  assert.equal(r2.saved.length, 1, 'with no kinds given every kind is saved, as before');
});

test('the hooks skip a quiet session, with a log line, and distill one with an edit', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-spend-')));
  fs.mkdirSync(path.join(dir, 'src')); fs.writeFileSync(path.join(dir, 'src/a.js'), 'export function f() {}\n');
  const store = new Store(dir).init();
  const env = { ...process.env, THINKER_LOG: 'local', THINKER_TELEMETRY: 'off', THINKER_LLM_CMD: `node ${path.join(path.dirname(CLI), '..', 'test', 'fixtures', 'mock-llm.mjs')}` };
  const transcript = path.join(dir, 'q1.jsonl');
  const row = (role, content) => JSON.stringify({ type: role, message: { role, content } });
  fs.writeFileSync(transcript, [row('user', 'where is f?'), row('assistant', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/a.js' } }]), row('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'export function f' }]), row('assistant', [{ type: 'text', text: 'in src/a.js' }])].join('\n') + '\n');
  const o = execFileSync('node', [CLI, 'distill', transcript, '--incremental', '--session', 'q1', '--repo', dir], { encoding: 'utf8', env });
  assert.match(o, /no learning evidence/);
  const log = fs.readFileSync(path.join(store.dir, 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(log.some(l => l.op === 'distill-skipped' && l.reason === 'no-learning-evidence'));
  assert.ok(!log.some(l => l.op === 'model'), 'no model call');
  // the same by hand (not incremental) is distilled
  const o2 = execFileSync('node', [CLI, 'distill', transcript, '--session', 'q1', '--repo', dir], { encoding: 'utf8', env });
  assert.match(o2, /distilled \d+ events/);
  // with learn.quietExplore 0 the hooks distill it too
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ learn: { quietExplore: 0 } }));
  fs.rmSync(path.join(store.dir, 'state'), { recursive: true, force: true });
  const o3 = execFileSync('node', [CLI, 'distill', transcript, '--incremental', '--session', 'q2', '--repo', dir], { encoding: 'utf8', env });
  assert.match(o3, /distilled \d+ events/);
});

test('a verification asks for a verdict and a sentence, with a body only for update, under a cap', () => {
  assert.deepEqual(VERIFY_SCHEMA.required, ['verdict', 'reason']);
  assert.equal(VERIFY_MAX_TOKENS, 1500);
  assert.match(VERIFY_SCHEMA.properties.body.description, /only when verdict=update/);
});
