// Which of a note's own texts the lexical index should read for understanding notes: today title, answers, tags and
// says; `applies` (the kinds of task a note bears on) and `searchInstances` (the concrete names it covers) are written
// at build time and read only by the cross-encoder, or not at all. Each variant appends them to the question side.
import fs from 'node:fs';
import path from 'node:path';
import { BASE, evaluate } from './trace.mjs';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const SHORT = JSON.parse(fs.readFileSync(path.join(HERE, 'prompts.json'), 'utf8'));
const UNCOVERED = ['PR26252-hard', 'PR26265-hard', 'PR26311-hard'];
const FORMS = { full: r => r, 'first sentence': r => r.split(/(?<=[.!?])\s+/)[0], 'one line': (r, t) => SHORT[t.id] || r };
const add = (...keys) => n => ({ ...n, answers: [...(n.answers || []), ...keys.map(k => String(n[k] || ''))] });
const MAPS = { today: null, '+applies': add('applies'), '+instances': add('searchInstances'), '+applies +instances': add('applies', 'searchInstances') };
const SERVE = { 'today (search, floor 0)': { views: 'search', floor: 0 }, 'pool (multi, floor -4)': { views: 'multi', floor: -4 } };
for (const [form, q] of Object.entries(FORMS)) for (const [m, mapNote] of Object.entries(MAPS)) for (const [sv, s] of Object.entries(SERVE)) {
  const r = await evaluate({ ...BASE, query: q, ceQuery: q, k: 8, maxNotes: 1, ...s, ...(mapNote ? { mapNote } : {}) });
  const noise = r.out.filter(o => UNCOVERED.includes(o.task) && o.served.length).length;
  console.log(`${form.padEnd(15)} ${m.padEnd(20)} ${sv.padEnd(24)} target ${r.hit2}/${r.has2} useful ${r.useful} precision ${r.precision?.toFixed(2)} noise ${noise}/3`);
}
