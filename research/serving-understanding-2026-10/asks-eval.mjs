// The request-style phrasings (asks.json, asks.mjs) against the three forms of each request: on the lexical index
// (beside `says`, which it reads already) and as a fourth text the cross-encoder reads, under today's rule and the
// understanding pool's. Same labels, targets and noise as sweep.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { BASE, evaluate } from './trace.mjs';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const SHORT = JSON.parse(fs.readFileSync(path.join(HERE, 'prompts.json'), 'utf8'));
const ASKS = JSON.parse(fs.readFileSync(path.join(HERE, 'asks.json'), 'utf8'));
const UNCOVERED = ['PR26252-hard', 'PR26265-hard', 'PR26311-hard'];
const FORMS = { full: r => r, 'first sentence': r => r.split(/(?<=[.!?])\s+/)[0], 'one line': (r, t) => SHORT[t.id] || r };
const withAsks = n => ({ ...n, asks: ASKS[n.id] || [], says: [...(n.says || []), ...(ASKS[n.id] || [])] });
const asksOnly = n => ({ ...n, asks: ASKS[n.id] || [] });  // the cross-encoder may read them; the index does not
const VARIANTS = {
  'today':                           { views: 'search', floor: 0 },
  'pool':                            { views: 'multi', floor: -4 },
  'asks indexed · today':            { views: 'search', floor: 0, mapNote: withAsks },
  'asks indexed · pool':             { views: 'multi', floor: -4, mapNote: withAsks },
  'asks indexed+scored · floor 0':   { views: 'multi+asks', floor: 0, mapNote: withAsks },
  'asks indexed+scored · pool':      { views: 'multi+asks', floor: -4, mapNote: withAsks },
  'asks scored only · pool':         { views: 'multi+asks', floor: -4, mapNote: asksOnly },
};
const rows = [];
for (const [form, q] of Object.entries(FORMS)) for (const [name, v] of Object.entries(VARIANTS)) {
  const r = await evaluate({ ...BASE, query: q, ceQuery: q, k: 8, maxNotes: 1, ...v });
  const noise = r.out.filter(o => UNCOVERED.includes(o.task) && o.served.length).length;
  rows.push({ form, variant: name, target: r.hit2, of: r.has2, useful: r.useful, precision: r.precision, noise, served: Object.fromEntries(r.out.map(o => [o.task, o.served.map(s => `${s.id}(${s.rating})`)])) });
  console.log(`${form.padEnd(15)} ${name.padEnd(32)} target ${r.hit2}/${r.has2} useful ${r.useful} precision ${r.precision?.toFixed(2)} noise ${noise}/3`);
}
fs.writeFileSync(path.join(HERE, 'asks-results.json'), JSON.stringify(rows, null, 1));
