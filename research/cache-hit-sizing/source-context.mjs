// Candidate source context, not context proven necessary to derive a note.
// THINKER_TEST=1 node research/cache-hit-sizing/source-context.mjs REPO TRANSCRIPT_DIR NOTE_ID...
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseTranscript } from '../../src/transcripts.js';
import { toolKey } from '../../src/tool-outputs.js';
import { savingOf } from '../../src/usage.js';
if (process.env.THINKER_TEST !== '1') throw new Error('Run with THINKER_TEST=1');
const [repo, dir, ...ids] = process.argv.slice(2);
if (!repo || !dir || !ids.length) throw new Error('Expected REPO TRANSCRIPT_DIR NOTE_ID...');
const readers = new Set(['Read', 'Bash:sed', 'Bash:cat', 'Bash:head', 'Bash:tail', 'Bash:grep', 'Bash:rg', 'Grep']);
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
const results = ids.map(id => {
  const rawNote = fs.readFileSync(path.join(repo, '.thinker/local/notes', id + '.json'), 'utf8');
  const n = JSON.parse(rawNote);
  if (n.source?.type !== 'agent' || !n.source.ref) return { id, excluded: 'not an agent note with a source' };
  const file = path.join(dir, path.basename(n.source.ref) + '.jsonl');
  if (!fs.existsSync(file)) return { id, excluded: 'source transcript unavailable' };
  const p = parseTranscript(file), deps = [...new Set(n.deps.map(d => d.path))];
  let totalTools = 0, toolsBeforeCreation = 0, untimedTools = 0;
  const candidates = [];
  for (const [i, e] of p.events.entries()) {
    if (e.t !== 'tool') continue;
    totalTools++;
    if (!e.at) { untimedTools++; continue; }
    if (e.at > Date.parse(n.created)) continue;
    toolsBeforeCreation++;
    const key = toolKey(e.name, e.input), input = JSON.stringify(e.input);
    if (!readers.has(key)) continue;
    const named = deps.filter(d => input.includes(d));
    if (named.length) candidates.push({ event: i, tool: key, named, tokens: Math.ceil(String(e.result || '').length / 4) });
  }
  return { id, noteSha256: hash(rawNote), transcriptSha256: hash(fs.readFileSync(file)), format: p.format,
    model: p.model, totalTools, toolsBeforeCreation, untimedTools, currentFileEstimate: savingOf(repo, n).tokens,
    candidateReadCalls: candidates.length, candidateReadTokens: candidates.reduce((s, x) => s + x.tokens, 0), candidates };
});
console.log(JSON.stringify({ warning: 'Purposive examples. Path substring matching can include unrelated output and miss indirect reads. Current deps may differ from original deps. No necessity, sufficiency, or savings claim.', results }, null, 2));
