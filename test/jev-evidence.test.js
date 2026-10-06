import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidencePassages, evidencePacket, refineLearningPlan } from '../src/learning-evidence.js';
import { condense } from '../src/distill.js';

const read = result => ({ t: 'tool', name: 'Read', input: { file_path: 'src/cache.js' }, result });
const plan = (events, served = []) => ({ mode: 'evidence', discover: true, served, trace: evidencePacket(events) });
const scored = probability => async (_store, request) => ({ status: 'ok', answers: Object.fromEntries(
  request.state.passages.map((p, i) => [`passage${i}`, { type: 'noul', noul: probability(p) }])) });

test('Jev finds a buried discovery and copies numbered source passages with adjacent context', async () => {
  const events = [{ t: 'prompt', text: '<thinker-cache>untrusted injected note</thinker-cache> Inspect cache behavior.' },
    ...Array.from({ length: 70 }, () => read('Routine lookup. '.repeat(35)))];
  events[35] = read('DISCOVERY: refresh replaces a generation, while existing readers retain the previous snapshot.');
  events[36] = { t: 'say', text: 'The subsequent check confirms existing readers finish on their original snapshot.' };
  const base = plan(events);
  assert.ok(!base.trace.includes('DISCOVERY'));
  const selected = await refineLearningPlan({}, events, base, { judge: scored(p => p.text.includes('DISCOVERY') ? .97 : .1) });
  assert.equal(selected.evidenceSelection.status, 'selected');
  assert.match(selected.trace, /event 35/);
  assert.match(selected.trace, /DISCOVERY: refresh replaces a generation/);
  assert.match(selected.trace, /subsequent check confirms/);
  assert.doesNotMatch(selected.trace, /untrusted injected note/);
  assert.equal(selected.compact, true);
  assert.equal(selected.discover, base.discover);
});

test('long individual tool results are split so a discovery past the condensation cutoff survives', async () => {
  const events = [read('Routine line.\n'.repeat(500) + 'DEEP_DISCOVERY: invalidation follows symbol hashes, preserving unrelated cache entries.')];
  const passages = evidencePassages(events);
  assert.ok(passages.length > 4);
  const note = { id: 'cache-note', deps: [{ path: 'src/cache.js' }] };
  const selected = await refineLearningPlan({}, events, plan(events, [note]), {
    judge: scored(p => p.text.includes('DEEP_DISCOVERY') ? .95 : .1), maxChars: 3000,
  });
  assert.match(selected.trace, /DEEP_DISCOVERY/);
  assert.match(selected.trace, /recorded event metadata:.*src\/cache.js/);
  assert.deepEqual(selected.served, [note]);
  assert.ok(!selected.evidenceSelection.selected.includes(0), 'file identity survives without the first span');
  assert.ok(selected.trace.length <= 3000);
});

test('disabled, failed and uncertain Jev selection preserve full explicit distillation behavior', async () => {
  const events = Array.from({ length: 40 }, () => read('Original source detail. '.repeat(80)));
  const base = { ...plan(events), mode: 'full', trace: condense(events) };
  assert.ok(base.trace.length > 12000);
  for (const judge of [async () => ({ status: 'disabled' }), async () => ({ status: 'unavailable', reason: 'offline' }), scored(() => .5)]) {
    const result = await refineLearningPlan({}, events, base, { judge });
    assert.equal(result.trace, base.trace);
    assert.equal(result.compact, false);
    assert.deepEqual(result.served, base.served);
    assert.equal(result.discover, base.discover);
  }
});

test('large Unicode transcripts use bounded batches spread across the entire chronology', async () => {
  const events = Array.from({ length: 1000 }, (_, i) => read(`record ${i}: ${'界'.repeat(600)}`));
  const seen = [];
  const judge = async (_store, request) => {
    assert.ok(Object.keys(request.questions).length <= 32);
    assert.ok(Buffer.byteLength(JSON.stringify({ model: 'jev-latest', state: request.state, questions: request.questions })) <= 30000);
    seen.push(...request.state.passages);
    return scored(p => p.event === 999 ? .95 : .1)(_store, request);
  };
  const selected = await refineLearningPlan({}, events, plan(events), { judge, maxCandidates: 48, maxChars: 2000 });
  assert.equal(seen.length, 48);
  assert.equal(seen[0].event, 0);
  assert.equal(seen.at(-1).event, 999);
  assert.ok(seen.some(p => p.event > 400 && p.event < 600));
  assert.equal(selected.evidenceSelection.sampled, true);
  assert.equal(selected.evidenceSelection.totalPassages, 1000);
  assert.match(selected.trace, /record 999/);
  assert.ok(selected.trace.length <= 2000);
});

test('uncertain judgments, partial batch failures, malformed answers, and cap exhaustion retain baseline evidence', async () => {
  const events = Array.from({ length: 50 }, () => read('Details '.repeat(100)));
  const base = plan(events);
  let calls = 0;
  const partialFailure = async (store, request) => ++calls === 1
    ? scored(() => .95)(store, request) : { status: 'unavailable', reason: 'dailyTokens' };
  for (const judge of [scored(() => .51), partialFailure, async () => ({ status: 'disabled', reason: 'jev disabled' }),
    async () => ({ status: 'ok', answers: {} }), async () => { throw new Error('offline'); }]) {
    const result = await refineLearningPlan({}, events, base, { judge });
    assert.notEqual(result.evidenceSelection.status, 'selected');
    assert.equal(result.trace, base.trace);
    assert.equal(result.discover, base.discover);
  }
  assert.equal(calls, 2);
});

test('audits and skipped sessions bypass Jev without changing coverage or eligibility', async () => {
  const judge = async () => { assert.fail('Jev must not run'); };
  for (const mode of ['audit', 'skip']) {
    const base = { ...plan([read('source')]), mode };
    assert.equal(await refineLearningPlan({}, [], base, { judge }), base);
  }
});

test('assessment-only plans stay assessment-only and notes omitted from evidence remain unknown', async () => {
  const events = [...Array.from({ length: 20 }, () => read('Routine read.')),
    { t: 'say', text: 'REUSABLE: note-visible explains that src/cache.js keeps immutable snapshots.' }];
  const visible = { id: 'note-visible', deps: [] };
  const missing = { id: 'note-hidden', deps: [{ path: 'src/other.js' }] };
  const base = { ...plan(events, [visible, missing]), mode: 'assessment', discover: false };
  const selected = await refineLearningPlan({}, events, base, { judge: scored(p => p.text.includes('REUSABLE') ? .98 : .1) });
  assert.deepEqual(selected.served, [visible]);
  assert.equal(selected.discover, false);
  assert.equal(selected.compact, true);
  assert.match(selected.trace, /never infer non-use or contradiction from absence/);
});

test('selection and fallback both honor a smaller text budget without cutting a selected passage', async () => {
  const events = Array.from({ length: 30 }, () => read('source '.repeat(200)));
  const base = plan(events);
  const selected = await refineLearningPlan({}, events, base, { judge: scored(() => .95), maxChars: 1600 });
  assert.ok(selected.trace.length <= 1600);
  const fallback = await refineLearningPlan({}, events, base, { judge: scored(() => .95), maxChars: 256 });
  assert.equal(fallback.evidenceSelection.status, 'fallback');
  assert.ok(fallback.trace.length <= 256);
});

test('a cancelled selection does not accept partial judgments or call another batch', async () => {
  const events = Array.from({ length: 50 }, () => read('source '.repeat(100)));
  const controller = new AbortController();
  let calls = 0;
  const judge = async (store, request, cfg) => {
    calls++; controller.abort();
    assert.equal(cfg.signal.aborted, true);
    return scored(() => .95)(store, request);
  };
  const base = plan(events);
  const result = await refineLearningPlan({}, events, base, { judge, cfg: { signal: controller.signal } });
  assert.equal(result.evidenceSelection.status, 'unavailable');
  assert.equal(result.trace, base.trace);
  assert.equal(calls, 1);
});
