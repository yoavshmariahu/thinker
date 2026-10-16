// One stage changed at a time against the shipped path (trace.mjs:BASE), scored on the hand labels.
import { BASE, evaluate, show } from './trace.mjs';

const firstSentences = (r, n) => r.split(/(?<=[.!?])\s+/).slice(0, n).join(' ');
const desired = r => { const i = r.search(/Desired behavior|should|must/i); return i > 0 ? r.slice(i) : r; };
// the second note only when the cross-encoder puts it near the first
const margin = m => s => s.filter((x, i) => i === 0 || x.ce >= s[0].ce - m);
// the lexical order decides among the notes the cross-encoder does not reject
const lexOrder = s => [...s].sort((a, b) => a.lexRank - b.lexRank);

const VARIANTS = {
  'shipped': BASE,
  // no cross-encoder: the lexical order alone
  'lexical top 2': { ...BASE, k: 2, floor: -Infinity },
  'lexical top 1': { ...BASE, k: 1, floor: -Infinity, maxNotes: 1 },
  // the floor
  'floor -1': { ...BASE, floor: -1 },
  'floor -2': { ...BASE, floor: -2 },
  'floor -4': { ...BASE, floor: -4 },
  // fewer candidates
  'k 4': { ...BASE, k: 4 },
  'k 3': { ...BASE, k: 3 },
  // which texts the cross-encoder reads
  'views search': { ...BASE, views: 'search' },
  'views search+inst': { ...BASE, views: 'search+inst' },
  'views answers': { ...BASE, views: 'answers' },
  'views applies': { ...BASE, views: 'applies' },
  'views title': { ...BASE, views: 'title' },
  'views multi+answers': { ...BASE, views: 'multi+answers' },
  'views answers+applies': { ...BASE, views: 'answers+applies' },
  'answers, lex1 + ce 2nd ≥0': { ...BASE, views: 'answers', floor: -Infinity, prefer: s => { const lex1 = s.find(x => x.lexRank === 1); const rest = s.filter(x => x !== lex1 && x.ce >= 0).sort((a, b) => b.ce - a.ce); return lex1 ? [lex1, ...rest] : rest; } },
  // how much of the request it reads
  'query 60 tokens': { ...BASE, queryTokens: 60 },
  'query 250 tokens': { ...BASE, queryTokens: 250 },
  'query 400 tokens': { ...BASE, queryTokens: 400 },
  'ce query: 2 sentences': { ...BASE, ceQuery: r => firstSentences(r, 2) },
  'ce query: desired part': { ...BASE, ceQuery: desired },
  // selection: rank by lexical among those the cross-encoder keeps; a second note only near the first
  'lexical order, floor -2': { ...BASE, floor: -2, prefer: lexOrder },
  'lexical order, floor -4': { ...BASE, floor: -4, prefer: lexOrder },
  'margin 1': { ...BASE, prefer: margin(1) },
  'floor -2, margin 1': { ...BASE, floor: -2, prefer: margin(1) },
  'floor -4, k 3, margin 1.5': { ...BASE, floor: -4, k: 3, prefer: margin(1.5) },
  'lexical top 1 + ce 2nd ≥0': { ...BASE, floor: -Infinity, prefer: s => { const lex1 = s.find(x => x.lexRank === 1); const rest = s.filter(x => x !== lex1 && x.ce >= 0).sort((a, b) => b.ce - a.ce); return lex1 ? [lex1, ...rest] : rest; } },
  // the cross-encoder's best of the lexical top k always takes the first slot; a second only at the floor
  'best always + 2nd ≥0': { ...BASE, floor: -Infinity, prefer: s => s.filter((x, i) => i === 0 || x.ce >= 0) },
  'best always + 2nd ≥1': { ...BASE, floor: -Infinity, prefer: s => s.filter((x, i) => i === 0 || x.ce >= 1) },
  'best always, one note': { ...BASE, floor: -Infinity, maxNotes: 1 },
  'best ≥-4 + 2nd ≥0': { ...BASE, floor: -Infinity, prefer: s => s.filter((x, i) => (i === 0 && x.ce >= -4) || x.ce >= 0) },
  'best ≥-3 + 2nd ≥0': { ...BASE, floor: -Infinity, prefer: s => s.filter((x, i) => (i === 0 && x.ce >= -3) || x.ce >= 0) },
};

const only = process.argv.slice(2);
for (const [name, cfg] of Object.entries(VARIANTS)) {
  if (only.length && !only.includes(name)) continue;
  show(name, await evaluate(cfg));
}
