import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deferLearning, safeLearningAssessments } from '../src/learning-pending.js';

test('session contradictions are reviewable and repeated discovery does not duplicate or mutate notes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-pending-'));
  try {
    const note = { id: 'rule', kind: 'rule', body: 'Never retry charges without an idempotency key.' };
    const behavior = { id: 'human', kind: 'behavior', body: 'Keep the human requirement.' };
    const store = { dir, get: id => ({ rule: note, human: behavior })[id] };
    const assessment = { id: 'rule', verdict: 'contradicted', correction: 'Always retry charges.' };
    const { accepted, deferred } = safeLearningAssessments(store, [assessment, { id: 'human', verdict: 'unused' }, { id: 'rule', verdict: 'confirmed' }]);
    assert.deepEqual(accepted, [{ id: 'rule', verdict: 'confirmed' }]);
    assert.equal(deferred.length, 1);
    const options = { source: { type: 'agent', ref: 'session-a' }, evidenceRef: '/recorded/session.jsonl' };
    const first = deferLearning(store, deferred, options);
    assert.deepEqual(deferLearning(store, deferred, options), first);
    assert.equal(fs.readdirSync(path.dirname(first[0])).length, 1);
    const saved = JSON.parse(fs.readFileSync(first[0], 'utf8'));
    assert.equal(saved.assessment.correction, assessment.correction);
    assert.equal(saved.evidenceRef, options.evidenceRef);
    assert.equal(note.body, saved.existing.body);
    const shown = { ...note };
    note.body = 'A concurrent session changed this rule.';
    assert.deepEqual(safeLearningAssessments(store, [{ id: 'rule', verdict: 'confirmed' }], [shown]), { accepted: [], deferred: [] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a contradiction a session reported holds its note back until maintenance verifies it with the evidence', async () => {
  const { execFileSync } = await import('node:child_process');
  const { Store } = await import('../src/store.js');
  const { createNote, refresh, verifyNote } = await import('../src/ops.js');
  const { takeContradictions } = await import('../src/learning-pending.js');
  const { pickStale, DEFAULTS } = await import('../src/maintain.js');
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-contra-')));
  const prev = { log: process.env.THINKER_LOG, llm: process.env.THINKER_LLM, cmd: process.env.THINKER_LLM_CMD };
  try {
    const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, stdio: 'ignore' });
    git('init', '-q'); fs.mkdirSync(path.join(repo, 'src')); fs.writeFileSync(path.join(repo, 'src/a.js'), 'export function charge() { return retry(); }\n'); git('add', '.'); git('commit', '-qm', 'i');
    process.env.THINKER_LOG = 'local';
    const store = new Store(repo).init();
    createNote(store, { title: 'charge never retries', kind: 'rule', answers: ['does charge retry'], body: 'src/a.js:charge never retries a failed charge', deps: [{ path: 'src/a.js', symbol: 'charge' }] });
    createNote(store, { title: 'charge lives in a.js', kind: 'map', answers: ['where is charge'], body: 'src/a.js:charge is the charge entry point', deps: [{ path: 'src/a.js', symbol: 'charge' }] });
    const [rule, other] = ['charge-never-retries', 'charge-lives-in-a-js'].map(id => store.list().find(n => n.title.startsWith(id.split('-').slice(0, 2).join(' '))));
    const defer = (note, body = note.body) => deferLearning(store, [{ reason: 'contradiction requires investigation', assessment: { id: note.id, verdict: 'contradicted', evidence: 'charge calls retry() on failure' }, existing: { id: note.id, body } }], { source: { type: 'agent', ref: 's1' } });
    defer(rule); defer(other, 'an older body');
    assert.deepEqual(takeContradictions(store), { marked: [rule.id], moot: 1 }, 'a note rewritten since the finding is moot');
    assert.deepEqual(fs.readdirSync(path.join(store.dir, 'state', 'learning-pending')), [], 'every record leaves the queue');
    let n = store.get(rule.id);
    assert.equal(n.status, 'stale'); assert.match(n.contradicted.evidence, /retry/);
    n = refresh(store, [n])[0];
    assert.equal(n.status, 'stale', 'no code change does not clear a contradiction');
    const { stale } = pickStale(store.list().map(x => x.id === other.id ? { ...x, status: 'stale', uses: 50, lastUsed: new Date().toISOString() } : x), { ...DEFAULTS, verifyServedDays: 7, verifyPerRun: 1 });
    assert.deepEqual(stale.map(x => x.id), [rule.id], 'verified first, though never served recently');
    const seen = path.join(repo, 'prompt.txt');
    process.env.THINKER_LLM = 'command'; process.env.THINKER_LLM_CMD = `cat > "${seen}"; echo '{"verdict":"invalid","reason":"charge retries"}'`;
    const v = await verifyNote(store, store.get(rule.id), {});
    assert.equal(v.verdict, 'invalid');
    assert.match(fs.readFileSync(seen, 'utf8'), /REPORTED THIS NOTE CONTRADICTED[\s\S]*charge calls retry\(\) on failure/);
    assert.equal(store.get(rule.id).contradicted, undefined);
  } finally {
    for (const [k, e] of [['log', 'THINKER_LOG'], ['llm', 'THINKER_LLM'], ['cmd', 'THINKER_LLM_CMD']]) { if (prev[k] === undefined) delete process.env[e]; else process.env[e] = prev[k]; }
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
