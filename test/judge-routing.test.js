import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { providerOfModel } from '../src/llm.js';
import { normalize } from '../bench/evals/normalize.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a model id names its provider; a tier name does not', () => {
  assert.equal(providerOfModel('gpt-6-luna'), 'codex');
  assert.equal(providerOfModel('gemini-3.8-flash-high'), 'gemini');
  assert.equal(providerOfModel('claude-sonnet-5-5'), 'claude');
  for (const tier of ['sonnet', 'haiku', 'opus', 'fable', undefined]) assert.equal(providerOfModel(tier), null);
});

test('a model id is answered by its provider or not at all: no other CLI grades under its name', () => {
  // fake claude and codex CLIs, first on PATH (llm.js:findBin looks there before any install location)
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-bin-'));
  for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho called > ${path.join(bin, name + '.called')}\nexit 1\n`, { mode: 0o755 });
  const script = `import('${ROOT}/src/llm.js').then(m => m.complete({ model: 'gpt-6-luna', prompt: 'x' })).then(() => console.log('answered'), e => console.log('refused: ' + e.message))`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: bin, THINKER_TEST: '1', THINKER_QUIET: '1' }, encoding: 'utf8' });
  assert.match(out, /^refused: codex/);
  assert.equal(fs.existsSync(path.join(bin, 'codex.called')), true, 'codex was asked');
  assert.equal(fs.existsSync(path.join(bin, 'claude.called')), false, 'and when it failed, the claude CLI was not asked instead');
  fs.rmSync(bin, { recursive: true, force: true });
});

test('an answer passes at the judge\'s full score, and the grade names its judge', () => {
  const rec = s => ({ id: 'E1-a-0', task: 'E1', arm: 'a', rep: 0, result: 'x', grade: { score: s, judge: 'gpt-6-luna', mustHit: 1, mustTotal: 1 } });
  assert.equal(normalize(rec(1), { run: 'r' }).pass, 1);
  assert.equal(normalize(rec(0.5), { run: 'r' }).pass, 0);
  assert.equal(normalize(rec(1), { run: 'r' }).judge, 'gpt-6-luna');
  assert.equal(normalize(rec(1), { run: 'r' }).outcome_source, 'answer-judge');
});

test('regrade.js grades recorded answers with the named judge and keeps the grade it replaces', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regrade-'));
  const tasks = path.join(dir, 'tasks.json');
  fs.writeFileSync(tasks, JSON.stringify({ tasks: [{ id: 'E1', prompt: 'Where?', gold: 'In core.py', must: ['core.py'] }, { id: 'P1', type: 'change', prompt: 'Fix', testCmd: 'true' }] }));
  fs.writeFileSync(path.join(dir, 'E1-a-0.json'), JSON.stringify({ id: 'E1-a-0', task: 'E1', arm: 'a', rep: 0, result: 'see core.py', grade: { score: 0.5, judge: 'sonnet' } }));
  fs.writeFileSync(path.join(dir, 'E1-b-0.json'), JSON.stringify({ id: 'E1-b-0', task: 'E1', arm: 'b', rep: 0, result: 'see core.py', grade: { error: 'judge failed' } }));
  fs.writeFileSync(path.join(dir, 'P1-a-0.json'), JSON.stringify({ id: 'P1-a-0', task: 'P1', arm: 'a', rep: 0, result: 'done', grade: { tests: 'pass' } }));
  const answer = path.join(dir, 'answer.json');
  fs.writeFileSync(answer, JSON.stringify({ score: 1, missing: [], wrong: [], reason: 'all there' }));
  const out = execFileSync(process.execPath, [path.join(ROOT, 'bench', 'regrade.js'), dir, tasks, 'gpt-6-luna', '2'],
    { env: { ...process.env, THINKER_TEST: '1', THINKER_LOG: 'off', THINKER_LLM: 'command', THINKER_LLM_CMD: `cat > /dev/null; cat "${answer}"` }, encoding: 'utf8' });
  assert.match(out, /regrading 2 answers with gpt-6-luna/);
  const a = JSON.parse(fs.readFileSync(path.join(dir, 'E1-a-0.json'), 'utf8'));
  assert.equal(a.grade.score, 1); assert.equal(a.grade.judge, 'gpt-6-luna'); assert.equal(a.grade.mustHit, 1);
  assert.deepEqual(a.grade.gradedBefore.map(g => [g.score, g.judge]), [[0.5, 'sonnet']]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'E1-b-0.json'), 'utf8')).grade.score, 1, 'a failed grade is graded again');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'P1-a-0.json'), 'utf8')).grade, { tests: 'pass' }, 'a task graded by its tests is left alone');
  // already graded by this judge: nothing to do
  assert.match(execFileSync(process.execPath, [path.join(ROOT, 'bench', 'regrade.js'), dir, tasks, 'gpt-6-luna'], { env: { ...process.env, THINKER_TEST: '1', THINKER_LLM: 'command', THINKER_LLM_CMD: 'false' }, encoding: 'utf8' }), /regrading 0 answers/);
  fs.rmSync(dir, { recursive: true, force: true });
});
