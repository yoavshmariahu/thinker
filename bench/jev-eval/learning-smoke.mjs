// Explicit live smoke: only fictional constants below leave the process.
// No repository notes, transcripts, diffs, or source files are read.
import fs from 'node:fs';
import { jevKey, JEV_ENDPOINT } from '../../src/jev.js';
import { prepareNotes } from '../../src/note-learning.js';
import { refineLearningPlan } from '../../src/learning-evidence.js';

if (process.env.THINKER_TEST !== '1' || !process.argv.includes('--live')) throw new Error('THINKER_TEST=1 and --live required');
const key = jevKey(); if (!key) throw new Error('personal key required');
const model = 'jev-1.13.0', events = [], requests = [];
const cfg = { enabled: true, key, model, searchTimeoutMs: 5000, fetchImpl: async (url, options) => {
  if (url !== JEV_ENDPOINT || url !== 'https://api.typesafe.ai/v1/systemone') throw new Error('unexpected destination');
  const start = performance.now(), response = await fetch(url, options);
  if (!response.ok) throw new Error(`Jev HTTP ${response.status}`);
  const json = await response.json();
  if (json.model !== model) throw new Error(`invalid comparison: ${json.model} != ${model}`);
  requests.push({ durationMs: Math.round(performance.now() - start), usage: json.usage, answers: json.answers });
  return { ok: true, json: async () => json };
} };
const old = { id: 'payment-reuse', title: 'Payment reuse', kind: 'rule', status: 'fresh', deps: [],
  body: 'payments.js:charge returns the saved receipt when an idempotency key has already been seen.' };
const evidence = `Observed source file payments.js:\nfunction charge(merchantId, key) {\n  const cacheKey = merchantId + ':' + key;\n  if (receipts.has(cacheKey)) return receipts.get(cacheKey);\n  const receipt = createCharge();\n  receipts.set(cacheKey, receipt);\n  return receipt;\n}\nTest: a repeated key for the same merchant returns the same receipt and calls createCharge once. Different merchants using the same key get separate receipts.`;
const store = { config: () => ({ jev: cfg, maintain: { dailyTokens: 0 } }), list: () => [old], log: event => events.push(event) };
const cases = [
  { name: 'covered', note: { ...old, id: undefined }, expected: 'covered' },
  { name: 'extension', note: { ...old, id: undefined, body: old.body + '\nIdempotency keys are scoped by merchant ID.' }, expected: 'extension' },
  { name: 'contradiction', note: { ...old, id: undefined, body: 'payments.js:charge always creates a second charge when the same merchant repeats an idempotency key.' }, expected: 'deferred' },
  { name: 'unsupported', note: { title: 'Transient failure retries', kind: 'rule', body: 'The billing transport retries failed network requests exactly three times.' }, expected: 'deferred' },
];
const rows = [];
for (let repeat = 0; repeat < 2; repeat++) {
  for (const c of cases) {
    const result = await prepareNotes(store, [c.note], { evidence });
    const actual = result.deferred.length ? 'deferred' : result.skipped.length ? 'covered' : result.notes[0]?.extends === old.id ? 'extension' : 'new';
    const row = { repeat, case: c.name, expected: c.expected, actual, passed: actual === c.expected, reasons: result.deferred.map(d => d.reason) };
    rows.push(row); console.log(JSON.stringify(row));
  }
  const transcript = [
    { t: 'prompt', text: 'Investigate duplicate charges.' },
    { t: 'say', text: 'I am starting the investigation.' },
    { t: 'tool', name: 'read', input: { path: 'payments.js' }, result: evidence },
    { t: 'say', text: 'The test confirms idempotency keys must include merchant ID; reusing across merchants leaks receipts.' },
    { t: 'say', text: 'The terminal font size is fourteen.' },
  ];
  const plan = await refineLearningPlan(store, transcript, { mode: 'evidence', discover: true, served: [], trace: 'fallback' });
  const selection = { repeat, case: 'transcript-evidence', passed: plan.evidenceSelection.status === 'selected' && plan.trace.includes('receipts.has(cacheKey)'), selection: plan.evidenceSelection };
  rows.push(selection); console.log(JSON.stringify(selection));
}
const report = { model, reasoningEffort: 'not configurable for Jev', data: 'fictional hard-coded constants only', rows, requests,
  tokens: events.reduce((sum, e) => sum + (e.tokens?.totalTokens || 0), 0) };
fs.mkdirSync('bench/runs/jev-learning', { recursive: true });
fs.writeFileSync('bench/runs/jev-learning/synthetic-smoke.json', JSON.stringify(report, null, 2));
if (rows.some(r => !r.passed)) process.exitCode = 1;
