// The prompt hook's deadline for the cross-encoder (dense.js:CE_DEADLINE_MS, ops.js:orient `deadline`): past it the
// model is not loaded, and an inference it does not answer by is abandoned; the lexical ranking is served either way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { createNote, orient } from '../src/ops.js';
import { withDeadline, ceConfig, CE_DEFAULTS, CE_DEADLINE_MS } from '../src/dense.js';

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
const withEnv = async (vars, fn) => { const saved = {}; for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; } try { return await fn(); } finally { for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } } };
const cfgStore = cfg => ({ config: () => ({ ce: cfg }) });
function gitRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-ce-deadline-')));
  git(dir, 'init', '-q');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/a.js'), 'export function fetchRows(db) {\n  return db.query("select * from rows order by id");\n}\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

test('the deadline is 8 s by default; config and THINKER_CE_DEADLINE move it, off/0/false remove it', async () => {
  await withEnv({ THINKER_CE_DEADLINE: undefined }, () => {
    assert.equal(CE_DEADLINE_MS, 8000);
    assert.equal(CE_DEFAULTS.deadlineMs, CE_DEADLINE_MS);
    assert.equal(ceConfig(cfgStore(undefined)).deadlineMs, 8000);
    assert.equal(ceConfig(cfgStore({ deadlineMs: 3000 })).deadlineMs, 3000);
    assert.equal(ceConfig(cfgStore({ deadlineMs: false })).deadlineMs, null);
    assert.equal(ceConfig(cfgStore({ deadlineMs: 0 })).deadlineMs, null);
    assert.equal(ceConfig(cfgStore({ deadlineMs: 'soon' })).deadlineMs, null);
  });
  await withEnv({ THINKER_CE_DEADLINE: '2500' }, () => assert.equal(ceConfig(cfgStore({ deadlineMs: 9000 })).deadlineMs, 2500, 'the variable overrides the config'));
  for (const v of ['off', '0', 'none', 'false']) await withEnv({ THINKER_CE_DEADLINE: v }, () => assert.equal(ceConfig(cfgStore(undefined)).deadlineMs, null, v));
});

test('withDeadline answers with the value in time and timedOut past it; a rejection still rejects', async () => {
  assert.deepEqual(await withDeadline(Promise.resolve(7), 1000), { value: 7 });
  assert.deepEqual(await withDeadline(new Promise(() => {}), 5), { timedOut: true });
  assert.deepEqual(await withDeadline(new Promise(() => {}), 0), { timedOut: true }, 'nothing left: timed out at once');
  assert.deepEqual(await withDeadline(Promise.resolve('x'), Infinity), { value: 'x' }, 'no deadline waits for the answer');
  await assert.rejects(withDeadline(Promise.reject(new Error('boom')), 1000), /boom/);
  // the timer is cleared on an answer: the test process is not held open by it
  const slow = new Promise(r => setTimeout(() => r(1), 10));
  assert.deepEqual(await withDeadline(slow, 60_000), { value: 1 });
});

test('orient past its deadline skips the cross-encoder, serves the lexical ranking and says so on the orient line', async t => {
  const dir = gitRepo(); const store = new Store(dir).init();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await withEnv({ THINKER_CE: 'on', THINKER_LOG: 'local', THINKER_CE_DEADLINE: undefined }, async () => {
    createNote(store, { title: 'fetchRows reads the rows table in id order', kind: 'rule', answers: ['how are rows fetched', 'what order do rows come in'], body: 'src/a.js:fetchRows reads the rows table and returns the rows ordered by id; callers must not sort again.', deps: [{ path: 'src/a.js', symbol: 'fetchRows' }] });
    const task = 'how are rows fetched by fetchRows and in what order does the rows table come back';
    // the deadline already passed when orient is reached (0 ms since the process started): the model is never loaded
    const r = await orient(store, { task, session: 's1', client: 'claude', freshOnly: true, deadline: 0 });
    assert.equal(r.ceTimedOut, false, 'nothing was abandoned: the hook need not exit');
    assert.equal(r.included.length, 1, 'the lexical ranking serves the note');
    const lines = fs.readFileSync(path.join(store.dir, 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(l => l.op === 'orient');
    const line = lines[lines.length - 1];
    assert.equal(line.ceDeadline, 'skipped');
    assert.equal(line.ce, undefined, 'no cross-encoder scores: emptyReason never reads the skip as the ranker rejecting');
    assert.ok(line.sinceStartMs > 0 && typeof line.load === 'number', 'the line carries how late the hook was and the machine load');
    // no deadline: the option is absent for the agent's orient and the servers, and the line carries no deadline fields
    const r2 = await orient(store, { task, session: 's2', client: 'cli', recordUsage: true, deadline: undefined, maxNotes: 5, budget: 1000 });
    const l2 = fs.readFileSync(path.join(store.dir, 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(l => l.op === 'orient').pop();
    assert.equal(l2.ceDeadline, undefined);
    assert.equal(r2.ceTimedOut, false);
  });
});
