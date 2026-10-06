// Usage: THINKER_TEST=1 node bench/jev-eval/catalog-eval.mjs --notes FILE --out DIR [--live]
// The source snapshot is read-only. --live uses a personal Jev key directly, never hosted telemetry.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { jevKey } from '../../src/jev.js';
import { relatedNotes } from '../../src/distill.js';
import { MODEL, POLICY, batches, catalogRequest, relationRequest, readScores, readRelations } from './catalog.mjs';

if (process.env.THINKER_TEST !== '1') throw new Error('THINKER_TEST=1 is required');
const { values } = parseArgs({ options: { notes: { type: 'string' }, out: { type: 'string' }, live: { type: 'boolean' } } });
if (!values.notes || !values.out) throw new Error('--notes FILE --out DIR required');
const notes = JSON.parse(fs.readFileSync(values.notes, 'utf8')).filter(n => n.status !== 'invalid').sort((a, b) => a.id.localeCompare(b.id));
if (new Set(notes.map(n => n.id)).size !== notes.length) throw new Error('duplicate note ids');
const cases = JSON.parse(fs.readFileSync(new URL('./catalog-cases.json', import.meta.url), 'utf8'));
for (const c of cases) for (const id of [...Object.keys(c.targets), ...(c.unrelated || [])])
  if (!notes.some(n => n.id === id)) throw new Error(`missing labelled target: ${id}`);
const out = path.resolve(values.out); fs.mkdirSync(out, { recursive: true });
const key = values.live ? jevKey() : null;
if (values.live && !key) throw new Error('a personal Jev key is required for this experiment');
const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const manifest = { policy: POLICY, model: MODEL, reasoning: 'not applicable (typed decisions)',
  generator: 'existing stored search descriptions, unchanged in both arms; body fallback where absent',
  judge: 'fixed manual text-relation fixtures; no model judge', corpusHash: hash(notes), casesHash: hash(cases),
  notes: notes.length, withSearch: notes.filter(n => n.search).length, floor: 0.5, maxNotes: 4, repeats: 2,
  corpusScope: 'all non-invalid notes including archived; no lexical gate',
  limits: 'Constructed observations, not actual held-out sessions or merged PRs. Positive labels are incomplete for the broad corpus. Measures known-target recall, not precision or final note quality.' };
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest));

async function ask(body, repeat) {
  const cache = path.join(out, `${hash({ policy: POLICY, body, repeat })}.json`);
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache));
  if (!values.live) throw new Error('cache miss: re-run with --live to make explicit model calls');
  const start = performance.now();
  const response = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Jev HTTP ${response.status}; experiment stopped without fallback`);
  const json = await response.json();
  if (json.model !== MODEL) throw new Error(`invalid comparison: ${json.model} != ${MODEL}`);
  const result = { json, ms: Math.round(performance.now() - start) };
  fs.writeFileSync(cache, JSON.stringify(result)); return result;
}

const rows = [];
for (let repeat = 0; repeat < 2; repeat++) for (const c of cases) {
  // Same observation for every arm. No touched-file hint is supplied in this fixture cohort.
  const baseline = relatedNotes({ list: () => notes, repo: '' }, [{ t: 'prompt', text: c.observation }], { max: 4 }).map(n => n.id);
  rows.push({ repeat, case: c.id, arm: 'current-top4', selected: baseline, hits: Object.keys(c.targets).filter(id => baseline.includes(id)).length });
  // Alternate representation order between repeats to reduce warm-up/order effects.
  for (const representation of repeat ? ['search', 'body'] : ['body', 'search']) {
    const start = performance.now(); let input = 0, output = 0, serviceMs = 0;
    const scores = [];
    for (const batch of batches(notes, representation)) {
      const r = await ask(catalogRequest(c.observation, batch, representation), repeat);
      input += r.json.usage?.input_tokens || 0; output += r.json.usage?.output_tokens || 0; serviceMs += r.ms;
      scores.push(...readScores(r.json, batch));
    }
    const selected = scores.filter(s => s.probability >= 0.5).sort((a, b) => b.probability - a.probability || a.id.localeCompare(b.id)).slice(0, 4).map(s => s.id);
    const row = { repeat, case: c.id, arm: `jev-${representation}`, selected, scores,
      hits: Object.keys(c.targets).filter(id => selected.includes(id)).length, input, output, serviceMs, replayOrWallMs: Math.round(performance.now() - start) };
    rows.push(row);
    fs.writeFileSync(path.join(out, 'rows.json'), JSON.stringify(rows, null, 2));
    console.log(JSON.stringify({ ...row, scores: undefined }));
  }
}

// Separate relationship accuracy from retrieval: fixed known pairs, full bodies in both repeats.
const relations = [];
for (let repeat = 0; repeat < 2; repeat++) for (const c of cases) {
  const expected = { ...c.targets, ...Object.fromEntries((c.unrelated || []).map(id => [id, 'unrelated'])) };
  const selected = Object.keys(expected).map(id => notes.find(n => n.id === id));
  const r = await ask(relationRequest(c.observation, selected), repeat);
  relations.push(...readRelations(r.json, selected).map(a => ({ repeat, case: c.id, ...a, expected: expected[a.id], correct: a.relation === expected[a.id] })));
}
const summary = { ...manifest, arms: [] };
for (const arm of ['current-top4', 'jev-body', 'jev-search']) for (let repeat = 0; repeat < 2; repeat++) {
  const group = rows.filter(r => r.arm === arm && r.repeat === repeat);
  const lat = group.map(r => r.serviceMs || 0).sort((a, b) => a - b);
  summary.arms.push({ arm, repeat, knownTargetsFound: group.reduce((s, r) => s + r.hits, 0),
    knownTargets: cases.reduce((s, c) => s + Object.keys(c.targets).length, 0),
    selected: group.reduce((s, r) => s + r.selected.length, 0),
    inputTokens: group.reduce((s, r) => s + (r.input || 0), 0),
    medianServiceMs: lat[Math.floor(lat.length / 2)],
    noTargetSelections: group.filter(r => !Object.keys(cases.find(c => c.id === r.case).targets).length).map(r => ({ case: r.case, selected: r.selected })) });
}
summary.relations = { correct: relations.filter(r => r.correct).length, total: relations.length, rows: relations };
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
