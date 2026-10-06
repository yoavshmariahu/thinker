// A live integration smoke using ONLY fictional, hard-coded notes. No repository
// notes, sessions or diffs are read. Requires explicit --live and a personal key.
import fs from 'node:fs';
import { jevSearch, jevKey, JEV_ENDPOINT } from '../../src/jev.js';
import { phraseKey } from '../../src/note-search.js';
import { rank } from '../../src/rank.js';

if (process.env.THINKER_TEST !== '1' || !process.argv.includes('--live')) throw new Error('THINKER_TEST=1 and --live required');
const key = jevKey(); if (!key) throw new Error('personal Jev key required');
const model = 'jev-1.13.0';
const make = (id, body, search) => {
  const n = { id, title: id, kind: 'rule', answers: [], body, search, deps: [], status: 'fresh' };
  n.saysFor = phraseKey(n); return n;
};
const notes = Array.from({ length: 80 }, (_, i) => make(`catalog-display-${i}`, `Shelf ${i} displays at most twelve items in alphabetical order.`, `Catalogue shelf ${i} has twelve alphabetically sorted entries.`));
notes.push(make('request-identity', 'A repeated operation with an already-seen idempotency key must reuse its prior payment outcome. Creating a second charge for that key is forbidden.', 'Repeated idempotency keys reuse the original payment outcome; they must never create another charge.'));
const cases = [
  { query: 'Stop shoppers getting billed twice when they press the checkout button again.', expected: 'request-identity' },
  { query: 'How should audio resampling preserve fractional phase between packets?', expected: null },
];
const rows = [];
for (let repeat = 0; repeat < 2; repeat++) for (const c of cases) {
  let inputTokens = 0, outputTokens = 0, requests = 0;
  const started = performance.now();
  const result = await jevSearch(notes, c.query, { key, model, searchTimeoutMs: 5000, maxNotes: 3,
    fetchImpl: async (url, options) => {
      if (url !== JEV_ENDPOINT || url !== 'https://api.typesafe.ai/v1/systemone') throw new Error('unexpected destination');
      const r = await fetch(url, options);
      if (!r.ok) throw new Error(`Jev HTTP ${r.status}`);
      const json = await r.json();
      if (json.model !== model) throw new Error(`invalid comparison: ${json.model} != ${model}`);
      requests++; inputTokens += json.usage?.input_tokens || 0; outputTokens += json.usage?.output_tokens || 0;
      return { ok: true, json: async () => json };
    } });
  const selected = result.map(r => ({ id: r.note.id, probability: r.jev }));
  const expected = c.expected ? [c.expected] : [];
  const row = { repeat, query: c.query, expected, selected, lexical: rank(notes, { query: c.query, mode: 'lookup' }).slice(0, 3).map(r => r.note.id),
    passed: JSON.stringify(selected.map(n => n.id)) === JSON.stringify(expected), requests, inputTokens, outputTokens, durationMs: Math.round(performance.now() - started) };
  rows.push(row); console.log(JSON.stringify(row));
}
fs.mkdirSync('bench/runs/jev-catalog', { recursive: true });
fs.writeFileSync('bench/runs/jev-catalog/synthetic-smoke.json', JSON.stringify({ model, notes: notes.length, data: 'fictional hard-coded notes only', rows }, null, 2));
if (rows.some(r => !r.passed)) process.exitCode = 1;
