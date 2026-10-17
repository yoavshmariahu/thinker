// The `pinned` arm's context command (Artemis arm defined as data): the note chosen for this task by the Sonnet
// judge, pasted above the request in the same bundle the prompt hook writes, so the agent sees what the hook would
// show if retrieval were perfect. The task is found by its request (the runner sends {prompt} on stdin).
//   node pinned-context.mjs <pins.json>   pins.json: { "<request>": [note, ...] }  (make-pins.mjs writes it)
import fs from 'node:fs';
const THINKER = process.env.PINNED_THINKER || '/Users/yoavshmariahu/src/thinker-under-test';
const { renderNote } = await import(`${THINKER}/src/rank.js`);
const { cacheBundleIntro } = await import(`${THINKER}/src/cache-guidance.js`);
const pins = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
const notes = pins[String(input.prompt || '').trim()] || [];
if (notes.length) process.stdout.write(`<thinker-cache>\n${cacheBundleIntro({})}\n\n${notes.map(n => renderNote(n)).join('\n\n')}\n</thinker-cache>\n`);
