// Alternative phrasing experiment: a `search` text that opens with the mechanism the note sits on,
// in domain words (which code path, which kinds of requests or changes go through it), then the
// note's specific rule. Written to a sidecar file, the notesets stay as they are.
//   node rephrase.mjs  → scratchpad/search2.json  { noteId: { search, says } }
import fs from 'node:fs'; import path from 'node:path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const OUT = path.join(ROOT, 'bench', 'serving', 'search2.json');
const { Store } = await import(path.join(ROOT, 'src/store.js'));
const { complete } = await import(path.join(ROOT, 'src/llm.js'));
const SCHEMA = { type: 'object', properties: { notes: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' }, search: { type: 'string' }, says: { type: 'array', items: { type: 'string' } } }, required: ['n', 'search'] } } }, required: ['notes'] };
const SYSTEM = `You write search descriptions for notes about a codebase, so that a ranking model can match them to task requests. A request describes a feature or bug in product words (what the user sends, sees or wants) and almost never names the specific rule a note records. A note is useful for many requests that touch the same code path, not only the one that produced it.

For each note write \`search\`, two to four sentences:
1. First sentence: the mechanism in domain words. Name the area and the code path or chokepoint the note sits on, and the kinds of requests, inputs or changes that go through it (for example: "Chat requests to the AI Gateway for Anthropic and Claude on Vertex AI are translated into the provider's request format in AnthropicAdapter.chat_to_model; fields the provider does not accept are dropped or renamed there."). Include the product nouns a user would use (the feature, the provider, the setting, the page) and the main symbol names.
2. Then the specific rule, invariant or fix pattern the note records, in one or two sentences, with the concrete symbols.
3. If the note names a failure, one sentence with the observable symptom in product words.
Use only what the note says or directly implies; never invent behavior. Keep every sentence concrete.

Also write \`says\`: up to four short lines, each a way a user or product manager might describe a task that this note would help with, in product words, covering different tasks on the same mechanism, not only the original bug.`;
const out = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
let cost = 0, tokens = 0;
for (const [clone, notesDir] of [['bench/repos/mlflow', 'bench/notesets/mlflow-v1/notes'], ['bench/repos/mlflow-b2', 'bench/notesets/mlflow-v2/notes']]) {
  process.env.THINKER_NOTES_DIR = path.join(ROOT, notesDir);
  const notes = new Store(path.join(ROOT, clone), { readonly: true }).list().filter(n => !out[n.id]);
  const groups = []; for (let i = 0; i < notes.length; i += 8) groups.push(notes.slice(i, i + 8));
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (groups.length) {
      const g = groups.shift();
      const list = g.map((n, i) => `[${i + 1}] kind=${n.kind}\n    title: ${n.title}\n    answers: ${(n.answers || []).slice(0, 4).join(' | ')}\n    files: ${(n.deps || []).slice(0, 6).map(d => d.path + (d.symbol ? ':' + d.symbol : '')).join(', ')}\n    applies: ${n.applies || '(not specified)'}\n    body: ${String(n.body).replace(/\n/g, ' ')}`).join('\n\n');
      try {
        const r = await complete({ model: 'haiku', system: SYSTEM, prompt: `NOTES:\n\n${list}\n\nReturn one entry per note with its number as n.`, schema: SCHEMA, maxTokens: 6000, cache: false });
        cost += r.cost || 0; tokens += (r.usage?.input_tokens || 0) + (r.usage?.output_tokens || 0);
        for (const e of r.json?.notes || []) { const n = g[Number(e.n) - 1]; if (n && String(e.search || '').length >= 40) out[n.id] = { search: String(e.search).trim().slice(0, 1500), says: (e.says || []).map(String).slice(0, 4) }; }
        fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
        console.log(`${Object.keys(out).length} phrased`);
      } catch (e) { console.log('batch failed: ' + e.message.slice(0, 120)); }
    }
  }));
}
console.log(`done: ${Object.keys(out).length} notes, $${cost.toFixed(2)}, ${tokens} tokens`);
