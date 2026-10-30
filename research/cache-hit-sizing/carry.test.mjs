import test from 'node:test';
import assert from 'node:assert/strict';
import { sections, requestsOf, estimateHit, totals, messageHash, overlappingTotal } from './carry.mjs';

const note = id => `### [rule] A fact (id: ${id}, confidence 80%)\nA useful constraint.\n→ pointers: src/a.js:f:L1`;
const req = (id, keep, tail, second = 1) => ({ type: 'api-request', id, keep, tail, timestamp: `2026-10-01T00:00:0${second}.000Z`, querySource: 'repl_main_thread' });
const blob = (hash, text) => ({ type: 'api-request-blob', hash, message: { role: 'user', content: [{ type: 'text', text }] } });
const response = id => ({ type: 'assistant', requestRef: id, message: { model: 'test-model', usage: { input_tokens: 10 } } });

test('counts a note in actual request prefixes, then stops when a request drops it', () => {
  const rows = [blob('a', note('n')), blob('b', 'summary without the note'),
    req('1', 0, ['a']), response('1'), response('1'),
    req('2', 1, [], 2), response('2'), req('3', 0, ['b'], 3), response('3')];
  const p = requestsOf(rows);
  assert.equal(p.requests.length, 3);
  assert.deepEqual(p.requests.map(r => r.notes.has('n')), [true, true, false]);
  const h = estimateHit({ id: 'n', t: '2026-10-01T00:00:00Z', est: [1, 1000] }, p.requests);
  assert.equal(h.requestsContainingNote, 2);
  assert.equal(h.netCarried, 2000 - 2 * sections(note('n'))[0].tokens);
});

test('repeated injection costs two copies but never credits two avoided read sets per request', () => {
  const p = requestsOf([blob('a', note('n')), req('1', 0, ['a', 'a']), response('1')]);
  const h = estimateHit({ id: 'n', t: '2026-10-01T00:00:00Z', est: [1, 1000] }, p.requests);
  assert.equal(h.repeatedCopyRequests, 1);
  assert.equal(h.grossCarried, 1000);
  assert.equal(h.noteInput, 2 * sections(note('n'))[0].tokens);
});

test('new-clear scenario stops avoided tool context while continuing to charge the surviving note', () => {
  const p = requestsOf([blob('a', note('n')), req('1', 0, ['a']), response('1'), req('2', 1, [], 2), response('2')]);
  const h = estimateHit({ id: 'n', t: '2026-10-01T00:00:00Z', est: [1, 1000] }, p.requests, [Date.parse('2026-10-01T00:00:01.500Z')]);
  assert.equal(h.requestsBeforeNewClear, 1);
  assert.equal(h.netStopAtClear, 1000 - h.noteInput);
  assert.equal(h.netQuarterReadStopAtClear, 250 - h.noteInput);
});

test('excludes failed/unmatched, sidechain, out-of-window and malformed requests', () => {
  const p = requestsOf([blob('a', note('n')), req('failed', 0, ['a']),
    req('side', 1, []), { ...response('side'), isSidechain: true },
    req('late', 1, [], 4), response('late'), req('bad', 9, [])], Date.parse('2026-10-01T00:00:03Z'));
  assert.equal(p.requests.length, 0);
  assert.equal(p.unmatched, 2);
  assert.equal(p.invalid, 1);
});

test('only complete rendered sections count; wrapper and adjacent notes do not become note text', () => {
  const ns = sections(`<thinker-cache>\nintro\n${note('n')}\n\n${note('m')}\n</thinker-cache>\nother instructions`);
  assert.deepEqual(ns.map(n => n.id), ['n', 'm']);
  assert.equal(ns[0].tokens, sections(note('n'))[0].tokens);
  assert.deepEqual(sections('id: n, confidence 80%'), []);
  assert.deepEqual(sections(JSON.stringify({ note: note('n') })), []);
  assert.equal(totals([]).meanCarry, null);
});

test('resolves omitted blobs only by canonical hash of an ordinary transcript message', () => {
  const message = { content: [{ text: note('n'), type: 'text' }], role: 'user' };
  const equivalent = { role: 'user', content: [{ type: 'text', text: note('n') }] };
  assert.equal(messageHash(message), messageHash(equivalent));
  const p = requestsOf([{ type: 'user', message }, req('1', 0, [messageHash(equivalent)]), response('1')]);
  assert.equal(p.invalid, 0);
  assert.equal(p.requests[0].notes.has('n'), true);
  const bad = requestsOf([{ type: 'user', message }, req('1', 0, ['wrong-hash']), response('1')]);
  assert.equal(bad.unresolvedRequests, 1);
  assert.equal(bad.requests[0].notes.size, 0);
});

test('a branched request uses its declared base, not the preceding request', () => {
  const p = requestsOf([blob('a', note('n')), blob('b', 'unrelated'),
    req('1', 0, ['a']), response('1'), req('2', 0, ['b'], 2), response('2'),
    { ...req('3', 1, [], 3), base: '1' }, response('3')]);
  assert.deepEqual(p.requests.map(r => r.notes.has('n')), [true, false, true]);
});

test('streamed assistant blocks and pre-rewrite tool inputs resolve by exact content hash', () => {
  const a = { type: 'text', text: note('n') }, b = { type: 'tool_use', id: 'tool1', name: 'Bash', input: { command: 'original command' } };
  const h = messageHash({ role: 'assistant', content: [a, b] });
  const p = requestsOf([
    { type: 'assistant', apiBlockIndex: 0, message: { id: 'm', role: 'assistant', content: [a] } },
    { type: 'assistant', apiBlockIndex: 1, wireToolInputs: { tool1: b.input }, message: { id: 'm', role: 'assistant', content: [{ ...b, input: { command: 'wrapped command' } }] } },
    req('1', 0, [h]), response('1')]);
  assert.equal(p.unresolvedRequests, 0);
  assert.equal(p.requests[0].notes.has('n'), true);
});

test('complete-overlap sensitivity charges both notes but credits only the largest retained read set', () => {
  const p = requestsOf([blob('a', note('n') + '\n' + note('m')), req('1', 0, ['a']), response('1')]);
  const ns = ['n', 'm'].map((id, i) => estimateHit({ id, t: '2026-10-01T00:00:00Z', est: [1, i ? 1000 : 800] }, p.requests));
  ns[1].newClearAt = '2026-10-01T00:00:01.000Z';
  const out = overlappingTotal(ns, p.requests), overhead = ns.reduce((s, h) => s + h.noteInput, 0);
  assert.equal(out.net, 1000 - overhead);
  assert.equal(out.netStopAtClear, 800 - overhead);
  assert.equal(out.quarterStopAtClear, 200 - overhead);
});
