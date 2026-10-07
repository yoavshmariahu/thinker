import fs from 'node:fs';
import path from 'node:path';

const START = '<!-- thinker:workflow:start -->';
const END = '<!-- thinker:workflow:end -->';

// Own only the marked block. Prepending makes it visible even in long instruction
// files; removing it restores the user's bytes, including trailing whitespace.
export function updateInstructions(file, workflow) {
  let link = false;
  try { link = fs.lstatSync(file).isSymbolicLink(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (link) {
    if (!workflow) return false; // never remove or follow a user's symlink
    throw new Error(`Refusing to edit symlinked instructions: ${file}`);
  }
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  let rest = before;
  const start = rest.indexOf(START), end = rest.indexOf(END);
  if ((start < 0) !== (end < 0) || (start >= 0 && (end < start || rest.indexOf(START, start + START.length) >= 0 || rest.indexOf(END, end + END.length) >= 0))) {
    throw new Error(`Malformed Thinker instruction block: ${file}`);
  }
  if (start >= 0) {
    let after = end + END.length;
    if (rest.slice(after, after + 2) === '\n\n') after += 2;
    rest = rest.slice(0, start) + rest.slice(after);
  }
  const next = workflow ? `${START}\n${workflow}\n${END}\n\n${rest}` : rest;
  if (next === before) return false;
  if (!next) fs.unlinkSync(file);
  else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, next); }
  return true;
}
