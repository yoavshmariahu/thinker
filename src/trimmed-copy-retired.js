// The trimmed copy of AGENTS.md for one checkout (`thinker instructions --core`, 2026-10-19 to 2026-10-24: the kept
// sections written to AGENTS.override.md for Codex and CLAUDE.local.md for Claude Code, with CLAUDE.md skipped through
// claudeMdExcludes, and on request a .cursorignore with an always-on rule for Cursor) was dropped on 2026-10-24, the
// owner's decision: a second, checkout-local copy of the team's instructions that the team never sees, with a switch
// of its own per agent and none for most, and a page that could remove it but not make it. The route for a section
// is the pull request (instruction-edit.js, instruction-pr.js). A checkout where the copy was on would otherwise read
// thinker's copy for good, since nothing rewrites it any more: the prompt hook and `thinker instructions` take
// thinker's own files out once, each known by the marker it carries, and never a file a person wrote.
import fs from 'node:fs';
import path from 'node:path';

const MARK = '<!-- thinker: the sections of AGENTS.md kept for this checkout';
const IGNORE_MARK = '# thinker: AGENTS.md is read from .cursor/rules/thinker-agents-core.mdc';
const startsWith = (file, mark) => { try { return fs.readFileSync(file, 'utf8').startsWith(mark); } catch { return false; } };
const includes = (file, mark) => { try { return fs.readFileSync(file, 'utf8').includes(mark); } catch { return false; } };

// Returns what was taken out, nothing when the checkout never had the copy (the common case: four stats).
export function retireTrimmedCopy(store) {
  const repo = store.repo, removed = [];
  for (const [f, mark, is] of [['AGENTS.override.md', MARK, startsWith], ['CLAUDE.local.md', MARK, startsWith], ['.cursorignore', IGNORE_MARK, startsWith], [path.join('.cursor', 'rules', 'thinker-agents-core.mdc'), MARK, includes]]) {
    const p = path.join(repo, f);
    if (is(p, mark)) { fs.rmSync(p, { force: true }); removed.push(f); }
  }
  // CLAUDE.md was skipped for Claude Code while the copy stood in for it
  const settings = path.join(repo, '.claude', 'settings.local.json'), claude = path.join(repo, 'CLAUDE.md');
  try {
    const j = JSON.parse(fs.readFileSync(settings, 'utf8'));
    if (Array.isArray(j.claudeMdExcludes) && j.claudeMdExcludes.includes(claude)) {
      j.claudeMdExcludes = j.claudeMdExcludes.filter(f => f !== claude);
      if (!j.claudeMdExcludes.length) delete j.claudeMdExcludes;
      fs.writeFileSync(settings, JSON.stringify(j, null, 2) + '\n');
      removed.push('claudeMdExcludes in .claude/settings.local.json');
    }
  } catch {}
  // the kept titles, and the copy's own record
  const cfgFile = path.join(store.dir, 'config.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    if (cfg.instructions?.core) {
      delete cfg.instructions.core;
      if (!Object.keys(cfg.instructions).length) delete cfg.instructions;
      fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
      removed.push('instructions.core in .thinker/config.json');
    }
  } catch {}
  fs.rmSync(path.join(store.dir, 'state', 'instructions-core.json'), { force: true });
  if (removed.length) store.log({ op: 'instructions-core', state: 'retired', removed });
  return removed;
}
