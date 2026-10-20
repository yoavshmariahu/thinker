// A trimmed AGENTS.md for this checkout, kept beside the team's own. Codex reads AGENTS.override.md in place of
// AGENTS.md when a directory holds both; thinker writes the sections the person keeps, verbatim, into that file,
// keeps it out of git (.git/info/exclude) and rewrites it whenever AGENTS.md changes, so the team's file is never
// touched and switching it off is deleting one file. Measured on PostHog with GPT-6 Astra (2026-10-19): the 8 core
// sections of 30 kept (~5k of ~10k tokens a model call), no judged pass lost on 8 real pull requests
// (posthog-astra-agentsmd-pilot-2026-10-19) or on 16 tasks that each need a repository skill
// (posthog-skills-sections-astra-2026-10-19). Off unless `instructions: { core: { keep: [...] } }` in
// .thinker/config.json (`thinker instructions --core`): which sections a repository needs always is the person's
// choice. A selection of the team's own text, never a rewrite of it.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { excludeFromGit } from './store.js';

export const SOURCE = 'AGENTS.md';
export const OVERRIDE = 'AGENTS.override.md';
export const MARK = '<!-- thinker: the sections of AGENTS.md kept for this checkout (`thinker instructions --off` removes this file; edit AGENTS.md, not this) -->';
const sha = s => createHash('sha256').update(s).digest('hex').slice(0, 16);

// Leaf sections: a "###" section on its own, a "##" one with the prose before its first "###"; the "#" title apart.
export function sections(text) {
  const out = []; let cur = null, parent = null; const head = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(/^(#{2,3}) (.+?)\s*$/);
    if (m) {
      if (cur) out.push(cur);
      if (m[1].length === 2) parent = m[2];
      cur = { title: m[2], parent: m[1].length === 3 ? parent : null, level: m[1].length, lines: [line] };
    } else if (cur) cur.lines.push(line); else head.push(line);
  }
  if (cur) out.push(cur);
  const all = out.map(s => ({ ...s, text: s.lines.join('\n').trim(), tokens: Math.ceil(s.lines.join('\n').length / 4) }));
  all.head = head.join('\n').trim();
  return all;
}

// The kept sections of `text`, in their order: a section is kept when its title (or "Parent: Title") is named; a
// "##" section whose own text is its heading alone comes along when one of its "###" sections is kept, so a kept
// subsection keeps its place in the outline.
export function buildCore(text, keep) {
  const want = new Set(keep.map(k => k.trim().toLowerCase()).filter(Boolean));
  const all = sections(text);
  const named = s => want.has(s.title.toLowerCase()) || (s.parent && want.has(`${s.parent}: ${s.title}`.toLowerCase()));
  const kept = all.filter(s => named(s) || (s.level === 2 && (want.has(s.title.toLowerCase()) || all.some(c => c.parent === s.title && named(c))) ));
  const keptIds = new Set(kept);
  // a "##" kept for its subsections contributes its heading line, and its own prose only when it was itself named
  const parts = kept.map(s => s.level === 2 && !named(s) ? s.lines[0] : s.text);
  const title = (all.head.match(/^# .+$/m) || [''])[0];
  const missing = [...want].filter(w => !all.some(s => s.title.toLowerCase() === w || (s.parent && `${s.parent}: ${s.title}`.toLowerCase() === w)));
  return { text: [MARK, title, ...parts].filter(Boolean).join('\n\n') + '\n', kept: kept.filter(s => named(s)).map(s => s.title), dropped: all.filter(s => !keptIds.has(s)).map(s => s.title), missing };
}

export const coreConfig = store => {
  const c = store.config().instructions?.core;
  return { enabled: Array.isArray(c?.keep) && c.keep.length > 0 && c.enabled !== false, keep: Array.isArray(c?.keep) ? c.keep : [] };
};
const thinkers = file => { try { return fs.readFileSync(file, 'utf8').startsWith(MARK); } catch { return false; } };

// Bring the checkout in line with the config: write the override when it is on and AGENTS.md or the kept list
// changed, remove thinker's override when it is off. Never touches an AGENTS.override.md the team wrote.
// Returns { state: 'written' | 'current' | 'removed' | 'off' | 'theirs' | 'no-source', ... }.
export function syncCore(store, { force = false } = {}) {
  const repo = store.repo, src = path.join(repo, SOURCE), dst = path.join(repo, OVERRIDE);
  const { enabled, keep } = coreConfig(store);
  const exists = fs.existsSync(dst);
  if (exists && !thinkers(dst)) return { state: 'theirs' };
  if (!enabled) {
    if (exists) { fs.rmSync(dst, { force: true }); store.log({ op: 'instructions-core', state: 'removed' }); return { state: 'removed' }; }
    return { state: 'off' };
  }
  let text; try { text = fs.readFileSync(src, 'utf8'); } catch { return { state: 'no-source' }; }
  const stateFile = path.join(store.dir, 'state', 'instructions-core.json');
  let st = {}; try { st = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  const key = sha(text + '\0' + keep.join('\n'));
  if (!force && exists && st.key === key) return { state: 'current' };
  const core = buildCore(text, keep);
  fs.writeFileSync(dst, core.text);
  excludeFromGit(repo, [OVERRIDE]);
  try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify({ key, at: new Date().toISOString(), kept: core.kept, missing: core.missing })); } catch {}
  store.log({ op: 'instructions-core', state: 'written', kept: core.kept.length, dropped: core.dropped.length, tokens: Math.ceil(core.text.length / 4), sourceTokens: Math.ceil(text.length / 4) });
  return { state: 'written', ...core, tokens: Math.ceil(core.text.length / 4), sourceTokens: Math.ceil(text.length / 4) };
}

// Turn it on with these sections, or off; the file follows at once.
export function setCore(store, keep) {
  const file = path.join(store.dir, 'config.json');
  let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  cfg.instructions ||= {};
  if (keep) cfg.instructions.core = { keep }; else delete cfg.instructions.core;
  if (!Object.keys(cfg.instructions).length) delete cfg.instructions;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  return syncCore(store, { force: true });
}
