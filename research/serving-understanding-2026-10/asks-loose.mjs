// Phrasings with the lexical gate loosened (any shared word lets a note through) and the cross-encoder reading the
// phrasings over more candidates: whether the gate, not the wording, holds the targets back on short prompts.
import fs from 'node:fs';
import path from 'node:path';
import { BASE, evaluate } from './trace.mjs';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const SHORT = JSON.parse(fs.readFileSync(path.join(HERE, 'prompts.json'), 'utf8'));
const ASKS = JSON.parse(fs.readFileSync(path.join(HERE, 'asks.json'), 'utf8'));
const UNCOVERED = ['PR26252-hard', 'PR26265-hard', 'PR26311-hard'];
const FORMS = { full: r => r, 'first sentence': r => r.split(/(?<=[.!?])\s+/)[0], 'one line': (r, t) => SHORT[t.id] || r };
const withAsks = n => ({ ...n, asks: ASKS[n.id] || [], says: [...(n.says || []), ...(ASKS[n.id] || [])] });
for (const [form, q] of Object.entries(FORMS)) for (const k of [8, 16, 32]) for (const views of ['multi', 'multi+asks', 'asks']) for (const floor of [0, -4]) {
  const r = await evaluate({ ...BASE, query: q, ceQuery: q, gate: 'all', k, views, floor, maxNotes: 1, mapNote: withAsks });
  const noise = r.out.filter(o => UNCOVERED.includes(o.task) && o.served.length).length;
  console.log(`${form.padEnd(15)} loose+asks k${String(k).padEnd(3)} ${views.padEnd(11)} floor ${String(floor).padEnd(3)} target ${r.hit2}/${r.has2} useful ${r.useful} precision ${r.precision?.toFixed(2)} noise ${noise}/3`);
}
