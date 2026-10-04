import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { learningPlan, evidencePacket, EVIDENCE_CHARS } from '../src/learning-evidence.js';
import { condense, distillEvents } from '../src/distill.js';
import { distillFile } from '../src/commands/learn.js';
import { Store } from '../src/store.js';
import { resetFallback } from '../src/llm.js';
const read = result => ({ t: 'tool', name: 'Read', input: { file_path: 'src/a.js' }, result });
const edit = { t: 'tool', name: 'Edit', input: { file_path: 'src/a.js', old_string: 'false', new_string: 'true' }, result: 'ok' };
const note = { id: 'note-a', kind: 'rule', title: 'A', body: 'src/a.js checks permission.', deps: [{ path: 'src/a.js' }] };
const quiet = [{ t: 'prompt', text: '<thinker-cache>note-a</thinker-cache> explain a' }, read('code'), { t: 'say', text: 'The code checks permission.' }];

test('cache hits and routine exploration do not buy discovery or assert usefulness', () => {
  assert.equal(learningPlan(quiet, { served: [note], auditRate: 0 }).mode, 'skip');
  assert.equal(learningPlan([...quiet, ...Array(100).fill(read('code'))], { served: [note], auditRate: 0 }).mode, 'skip');
  const discussed = [...quiet, { t: 'say', text: 'note-a was contradicted by the missing permission check.' }];
  const plan = learningPlan(discussed, { served: [note], auditRate: 0 });
  assert.equal(plan.mode, 'assessment'); assert.equal(plan.discover, false);
  assert.equal(learningPlan([...quiet, edit], { auditRate: 0 }).mode, 'evidence');
});

test('bounded evidence keeps a buried failure and the final fix instead of all reads', () => {
  const events = [quiet[0], ...Array(100).fill(read('x'.repeat(2000))),
    { t: 'tool', name: 'Bash', input: { command: 'npm test' }, result: 'FAILURE_MARKER: fatal permission bug' },
    ...Array(100).fill(read('y'.repeat(2000))), edit, { t: 'say', text: 'FIX_MARKER: src/a.js now rejects unauthorized callers.' }];
  const packet = evidencePacket(events);
  assert.ok(packet.length <= EVIDENCE_CHARS);
  assert.match(packet, /FAILURE_MARKER/); assert.match(packet, /FIX_MARKER/);
  assert.ok(!packet.includes('<thinker-cache>'));
  assert.ok(packet.length < condense(events).length / 4);
});

test('full-trace auditing is configurable and stable for each session', () => {
  const events = [...quiet, edit];
  assert.equal(learningPlan(events, { auditRate: 1, key: 'one' }).mode, 'audit');
  assert.equal(learningPlan(events, { auditRate: 0, key: 'one' }).mode, 'evidence');
  assert.equal(learningPlan(events, { key: 'same' }).mode, learningPlan(events, { key: 'same' }).mode);
});

test('compact assessment suppresses unsupported verdicts and cannot create notes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-evidence-'));
  const script = path.join(dir, 'model.cjs');
  const reply = { notes: [{ title: 'unrequested discovery' }], assessments: [
    { id: 'note-a', verdict: 'unused', evidence: 'not mentioned' },
    { id: 'other', verdict: 'confirmed', evidence: 'read code' },
    { id: 'note-a', verdict: 'confirmed', evidence: '' },
    { id: 'note-a', verdict: 'contradicted', evidence: 'missing check', correction: 'corrected body' }] };
  fs.writeFileSync(script, `process.stdin.resume();process.stdin.on('end',()=>console.log(${JSON.stringify(JSON.stringify(reply))}));`);
  const keys = ['THINKER_LLM_CMD', 'THINKER_LLM', 'THINKER_LOG'];
  const prev = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  process.env.THINKER_LLM_CMD = `node "${script}"`; process.env.THINKER_LLM = 'command'; process.env.THINKER_LOG = 'off';
  try {
    const r = await distillEvents(quiet, { compact: true, discover: false, served: [note], evidence: 'missing check' });
    assert.deepEqual(r.notes, []); assert.equal(r.assessments.length, 1);
    assert.equal(r.assessments[0].verdict, 'contradicted');
    fs.writeFileSync(script, `process.stdin.resume();process.stdin.on('end',()=>console.log('{"notes":[],"assessments":[]}'));`);
    const store = new Store(dir).init();
    fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ learn: { auditRate: 0 } }));
    store.put({ ...note, servedIn: ['s'] });
    const trace = path.join(dir, 'session.jsonl');
    fs.writeFileSync(trace, quiet.map(e => JSON.stringify(e)).join('\n') + '\n');
    const ctx = { repo: dir, store, out() {} };
    await distillFile(ctx, trace, { incremental: true, session: 's', minExplore: 1 });
    const statePath = path.join(store.dir, 'state', 'session.json');
    assert.equal(JSON.parse(fs.readFileSync(statePath)).line, quiet.length);
    assert.equal(store.get(note.id).attest, undefined, 'mere serving stays unassessed');
    // A later edit with no exploration must still be considered after a skipped chunk.
    fs.appendFileSync(trace, [edit, { t: 'say', text: 'Fixed src/a.js.' }].map(e => JSON.stringify(e)).join('\n') + '\n');
    await distillFile(ctx, trace, { incremental: true, session: 's', minExplore: 3 });
    const state = JSON.parse(fs.readFileSync(statePath));
    assert.equal(state.line, quiet.length + 2);
    assert.deepEqual(state.assessed, [], 'unselected notes are not marked assessed');
  } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    resetFallback(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
