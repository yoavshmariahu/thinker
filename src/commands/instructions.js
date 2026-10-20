// `thinker instructions`: the sections of AGENTS.md, with their tokens, and the trimmed copy this checkout's agents
// read in its place (instructions-core.js). --core "<Title>, <Title>" keeps those sections, --off removes the copy.
import { sections, setCore, coreConfig, syncCore, SOURCE, OVERRIDE } from '../instructions-core.js';
import fs from 'node:fs';
import path from 'node:path';

async function instructionsCommand({ store, repo, flags, out }) {
  if (flags.off) { const r = setCore(store, null); out(r.state === 'removed' ? `Removed ${OVERRIDE}${r.claude === 'removed' ? ' and CLAUDE.local.md' : ''}: agents here read ${SOURCE} whole again.` : r.state === 'theirs' ? `${OVERRIDE} here is not thinker's; left as it is.` : `Nothing to remove: thinker keeps no ${OVERRIDE} here.`); return; }
  if (flags.core !== undefined && flags.core !== true) {
    const keep = String(flags.core).split(',').map(s => s.trim()).filter(Boolean);
    const r = setCore(store, keep);
    if (r.state === 'theirs') { out(`${OVERRIDE} here was written by someone else; thinker leaves it alone and wrote nothing.`); return; }
    if (r.state === 'no-source') { out(`No ${SOURCE} in this checkout to trim.`); return; }
    out(`Wrote ${OVERRIDE} (kept out of git): ${r.kept.length} section${r.kept.length === 1 ? "" : "s"} of ${SOURCE}, ~${r.tokens} tokens of ~${r.sourceTokens}. Codex reads it in place of ${SOURCE} from its next session; ${SOURCE} itself is unchanged.`);
    out(r.claude === 'written' ? `Claude Code reads the same sections from CLAUDE.local.md (kept out of git)${fs.existsSync(path.join(repo, 'CLAUDE.md')) ? ', with CLAUDE.md skipped through claudeMdExcludes in .claude/settings.local.json, as it is AGENTS.md' : ''}, from its next session.`
      : r.claude === 'theirs' ? 'Claude Code: CLAUDE.local.md here is your own, so thinker left Claude Code reading the whole file.'
      : r.claude === 'skipped' ? 'Claude Code: CLAUDE.md here has text of its own, so thinker left Claude Code reading it whole.' : '');
    if (r.missing.length) out(`Not found in ${SOURCE}, so not kept: ${r.missing.join(', ')}.`);
    out(`Left out: ${r.dropped.join(', ')}. \`thinker instructions --off\` puts the whole file back.`);
    return;
  }
  let text; try { text = fs.readFileSync(path.join(repo, SOURCE), 'utf8'); } catch { out(`No ${SOURCE} in this checkout.`); return; }
  const { enabled, keep } = coreConfig(store), r = enabled ? syncCore(store) : null;
  const kept = new Set(keep.map(k => k.toLowerCase()));
  out(`${SOURCE}: ~${Math.ceil(text.length / 4)} tokens, read on every model call.${enabled ? ` ${OVERRIDE} keeps ${keep.length} sections (${r.state === 'theirs' ? `but ${OVERRIDE} here is not thinker's` : 'up to date'}).` : ''}\n`);
  for (const s of sections(text)) out(`  ${kept.has(s.title.toLowerCase()) || kept.has(`${s.parent}: ${s.title}`.toLowerCase()) ? '*' : ' '} ${String(s.tokens).padStart(5)}  ${s.parent ? `${s.parent}: ` : ''}${s.title}`);
  out(`\n${enabled ? '* kept. ' : ''}\`thinker instructions --core "Title, Title"\` keeps those sections in ${OVERRIDE}, which Codex reads instead of ${SOURCE}; --off removes it.`);
}

export const commands = { instructions: instructionsCommand };
