// `thinker instructions`: the sections of AGENTS.md with their tokens, and a change to some of them as a diff
// (instruction-edit.js): --remove / --compress <ids>, --pr for a pull request with it, --apply for the working tree.
import { sections } from '../instruction-value.js';
import { previewEdit, applyEdit } from '../instruction-edit.js';
import { retireTrimmedCopy } from '../trimmed-copy-retired.js';
import fs from 'node:fs';
import path from 'node:path';

const SOURCE = 'AGENTS.md';

async function instructionsCommand({ store, repo, flags, out }) {
  // a trimmed copy an older version kept here goes (trimmed-copy-retired.js)
  const retired = retireTrimmedCopy(store);
  if (retired.length) out(`Removed the trimmed copy of ${SOURCE} an older thinker kept for this checkout (${retired.join(', ')}): agents here read ${SOURCE} whole; a change to it is a pull request (--compress, --remove with --pr).\n`);
  // --remove / --compress <section id>: the diff of that change; --pr opens a pull request with it (instruction-pr.js), --apply
  // writes it to the working tree (instruction-edit.js)
  for (const action of ['remove', 'compress']) {
    if (typeof flags[action] !== 'string') continue;
    // one section id, or several separated by commas
    const r = await previewEdit(store, flags[action], action);
    if (r.error) { out(r.error); return; }
    for (const x of r.sections) {
      out(`${action === 'remove' ? 'Remove' : 'Compress'} "${x.title}" in ${r.file}: ~${x.tokensBefore} → ~${x.tokensAfter} tokens\n`);
      for (const [k, l] of x.diff) if (k !== ' ' || x.diff.length < 40) out(`${k} ${l}`);
      out('');
    }
    if (r.sections.length > 1) out(`In all: ~${r.tokensBefore} → ~${r.tokensAfter} tokens in every model call.`);
    // --pr: a commit on a branch of its own, pushed, and a pull request (instruction-pr.js); --apply: the working tree
    if (flags.pr) { const { openEditPr } = await import('../instruction-pr.js'); const pr = await openEditPr(store, r.key); out(pr.said || pr.error); return; }
    const ap = flags.apply ? applyEdit(store, r.key) : null;
    out(ap ? (ap.said || ap.error) : `Nothing written. Add --pr to open a pull request with it, or --apply to write it to ${r.file} (uncommitted; git diff to review).`);
    return;
  }
  if (flags.core !== undefined || flags.off) { out('The trimmed copy for a checkout (--core, --off) is no longer supported: a change to the file is a pull request (--compress or --remove <ids> --pr), and the team\'s file is what every agent reads.'); return; }
  let text; try { text = fs.readFileSync(path.join(repo, SOURCE), 'utf8'); } catch { out(`No ${SOURCE} in this checkout.`); return; }
  out(`${SOURCE}: ~${Math.ceil(text.length / 4)} tokens, read on every model call.\n`);
  for (const s of sections(text)) out(`  ${String(s.tokens).padStart(5)}  ${s.parent ? `${s.parent}: ` : ''}${s.title}`);
  out(`\n\`thinker instructions --compress <id>\` or \`--remove <id>\` shows the diff of a change; --pr opens a pull request with it.`);
}

export const commands = { instructions: instructionsCommand };
