#!/usr/bin/env node
// A copy of a noteset in which the notes of the given kinds (default: the rules — invariant, fix,
// convention, gotcha, rule) are desired behaviors (kind behavior, mutable), for measuring the
// behavior lens of `thinker review` against the same content as notes.
//   node bench/promote-behaviors.js <notes dir> <out dir> [kinds,comma,separated]
import fs from 'node:fs';
import path from 'node:path';
const [src, out, kindsArg] = process.argv.slice(2);
const kinds = new Set((kindsArg || 'invariant,fix,convention,gotcha,rule').split(','));
fs.mkdirSync(out, { recursive: true });
let n = 0, total = 0;
for (const f of fs.readdirSync(src)) {
  if (!f.endsWith('.json')) continue;
  const note = JSON.parse(fs.readFileSync(path.join(src, f), 'utf8')); total++;
  if (kinds.has(note.kind)) { note.promotedFrom = note.kind; note.kind = 'behavior'; note.mutability = 'mutable'; n++; }
  fs.writeFileSync(path.join(out, f), JSON.stringify(note, null, 1) + '\n');
}
process.stderr.write(`${n} of ${total} notes are behaviors in ${out}\n`);
