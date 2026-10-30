// Review-only render of the existing Report aggregate token card. No product code changes.
// Uses the page's actual CSS, formatting, escaping, and card renderer with the matched audit cohort.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

if (process.env.THINKER_TEST !== '1') throw new Error('Run with THINKER_TEST=1');
const output = process.argv[2];
if (!output) throw new Error('Expected output directory');
const page = fs.readFileSync(new URL('../../src/ui/page.html', import.meta.url), 'utf8');
const data = JSON.parse(fs.readFileSync(new URL('./carry.json', import.meta.url), 'utf8'));
const style = page.match(/<style>([\s\S]*?)<\/style>/)[1];
const escCode = page.match(/^const esc = .*$/m)[0];
const fmtCode = page.match(/^const fmt = .*$/m)[0];
const cardCode = page.slice(page.indexOf('function card('), page.indexOf('\n}\n', page.indexOf('function card(')) + 3);
const render = vm.runInNewContext(`${escCode}\n${fmtCode}\n${cardCode}\n({card,fmt})`);
const sessions = data.sessions.filter(s => s.hits).length;
const before = render.card('Tokens saved', render.fmt(data.covered.baseline), 'tokens of code the agents did not read', null, true);
const after = render.card('Estimated input tokens saved', render.fmt(data.covered.netStopAtClear),
  'Avoided reading and subsequent re-reads, minus cached-note context.',
  [['Hits with lifetime data', String(data.covered.hits)], ['Sessions', String(sessions)]], true);
fs.mkdirSync(output, { recursive: true });

function document(mode) {
  const isAfter = mode === 'after';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Thinker savings · ${isAfter ? 'proposed' : 'before'} preview</title>
  <style>${style}
  #capture { max-width:1040px; margin:0 auto; }
  .preview { max-width:1000px; padding:2.1rem 2rem 2.2rem; }
  .preview-flag { font-size:.72rem; color:#475569; background:#f1f5f9; border-bottom:1px solid #e2e8f0; padding:.6rem 2rem; }
  .preview-title { display:flex; align-items:center; justify-content:space-between; margin-bottom:1.7rem; }
  .preview-title a { color:#444; text-decoration:none; font-size:.8rem; padding:.4rem .7rem; border:1px solid #e5e7eb; border-radius:6px; }
  .preview-caption { font-size:.85rem; color:#6b7280; line-height:1.6; margin-top:.5rem; }
  .preview-card { width:390px; max-width:100%; }
  .preview-card .card { min-height:238px; }
  .preview-note { margin-top:1.35rem; font-size:.8rem; color:#6b7280; line-height:1.6; max-width:690px; }
  .preview-footer { margin-top:1.8rem; padding-top:1rem; border-top:1px solid #f0f0f0; font-size:.76rem; color:#6b7280; }
  </style>
  <div id="capture"><div class="preview-flag">COMPARISON PREVIEW · Same ${data.covered.hits} audited hits in ${sessions} sessions · Not the full live report</div>
  <nav><div class="brand"><span class="wordmark">thinker</span><span class="brand-sub">local</span></div><div class="nav-right"><span class="nav-link">Find Savings</span><span class="nav-link active">View Report</span><span class="nav-link">Recent activity</span></div></nav>
  <main class="preview"><div class="preview-title"><div><h1>View Report</h1><p class="preview-caption">Existing aggregate token-savings card · ${isAfter ? 'proposed calculation and wording' : 'current calculation and wording'}</p></div><a href="/${isAfter ? 'before' : 'after'}.html">${isAfter ? 'See before' : 'See proposed'}</a></div>
  <div class="kicker">${isAfter ? 'After · proposed' : 'Before · current'}</div><div class="preview-card">${isAfter ? after : before}</div>
  <p class="preview-note">${isAfter ? 'Includes continuing input savings while the note is carried. This example stops hypothetical code retention at observed new-clearing boundaries and subtracts carried note text. Reading avoided remains estimated.' : 'Counts each confirmed note’s estimated avoided file reading once. Subsequent prompts carrying that context are not included.'}</p>
  <div class="preview-footer">${isAfter ? 'Exact scenario total: 43,770,253 input tokens. The existing UI formatter rounds this to 44M.' : 'Exact comparison total: 444,660 tokens. The existing UI formatter rounds this to 445k.'}<br>Preview only. Other report cards, dollar figures and hit counts are outside this comparison.</div>
  </main></div></html>`;
}
for (const mode of ['before', 'after']) fs.writeFileSync(path.join(output, mode + '.html'), document(mode));
console.log(JSON.stringify({ output, before: data.covered.baseline, after: data.covered.netStopAtClear, hits: data.covered.hits, sessions }));
