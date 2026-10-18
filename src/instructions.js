// The repository's instruction files as a cost, and a slim core for them. Claude Code loads
// CLAUDE.md/AGENTS.md and .claude/rules/*.md into the context of every turn, and every turn re-reads
// that context: measured over the Artemis transcripts on 2026-10-18, the first-turn context was 63% of a
// 52-turn Opus session's input tokens on PostHog and 76–85% of 14-turn Sonnet ones, and PostHog's own
// files were 13k of its 41k prefix. Replacing its 10.4k-token AGENTS.md with a 2.4k core Sonnet wrote
// from it (and taking the rules out) cut the prefix by 10.9k a turn, with 5 of 6 passes against 3 of 6
// and five of six tasks cheaper (posthog-hard-opus-slim-2026-10-18). Here: what the files cost in this
// checkout from its own sessions, a proposed core the person reviews and commits, a budget to check in
// CI, and a watch that says when the file grew past it. The sections the core leaves out are kept
// beside it for serving on relevance, which is the next experiment, not this code.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readLog } from './usage.js';
import { complete } from './llm.js';

export const INSTRUCTIONS = {
  budget: 3000,  // tokens the core may take in every turn's context
  days: 30,      // sessions counted for the cost
  watch: true,   // maintenance says once when the file changed and is over budget
};
export function instructionsConfig(store, over = {}) {
  const c = store?.config?.().instructions;
  return { ...INSTRUCTIONS, ...(c && typeof c === 'object' ? c : {}), ...over };
}
export const tokensOf = text => Math.ceil(Buffer.byteLength(String(text), 'utf8') / 4);
const sha = text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
const DIR = store => path.join(store.dir, 'instructions');
const stateFile = store => path.join(DIR(store), 'state.json');
export const readSlimState = store => { try { return JSON.parse(fs.readFileSync(stateFile(store), 'utf8')); } catch { return null; } };

// The files Claude Code puts in the prefix of every turn in this checkout: the root memory file (CLAUDE.md,
// or AGENTS.md when CLAUDE.md is it or is missing), .claude/CLAUDE.md, and every .claude/rules/*.md. A
// symlink and its target count once. Nested CLAUDE.md files load when their directory is touched and are
// counted apart. Tokens are bytes/4, an estimate.
export function instructionFiles(repo) {
  const out = [], seen = new Set();
  const add = (rel, kind) => {
    const abs = path.join(repo, rel); let real, st;
    try { real = fs.realpathSync(abs); st = fs.statSync(abs); } catch { return; }
    if (!st.isFile() || seen.has(real)) return; seen.add(real);
    out.push({ file: rel, kind, bytes: st.size, tokens: Math.ceil(st.size / 4), link: real !== abs ? path.relative(repo, real) : undefined });
  };
  for (const f of ['CLAUDE.md', 'AGENTS.md', '.claude/CLAUDE.md']) add(f, 'core');
  const rules = path.join(repo, '.claude', 'rules');
  const walk = d => { let names = []; try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of names.sort((a, b) => a.name.localeCompare(b.name))) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.md$/i.test(e.name)) add(path.relative(repo, p), 'rule'); } };
  walk(rules);
  let nested = 0; try { nested = countNested(repo); } catch {}
  return { files: out, tokens: out.reduce((t, f) => t + f.tokens, 0), root: out.find(f => f.kind === 'core' && /^(CLAUDE|AGENTS)\.md$/.test(f.file))?.file || null, nested };
}
function countNested(repo, depth = 0) {
  if (depth > 6) return 0; let n = 0, names = [];
  try { names = fs.readdirSync(repo, { withFileTypes: true }); } catch { return 0; }
  for (const e of names) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
    const p = path.join(repo, e.name);
    if (e.isDirectory()) n += countNested(p, depth + 1);
    else if (depth > 0 && /^(CLAUDE|AGENTS)\.md$/.test(e.name)) n++;
  }
  return n;
}

// What the sessions here cost, from the `session` lines the stop hook logs: the last line of each session
// in the window carries its turns and input tokens over the whole transcript.
export function sessionStats(store, { days = INSTRUCTIONS.days, now = Date.now() } = {}) {
  const since = new Date(now - days * 86_400_000).toISOString();
  const last = new Map();
  for (const e of readLog(store)) if (e.op === 'session' && e.t >= since && e.session) last.set(e.session, e);
  const rows = [...last.values()].filter(e => e.turns > 0 && e.inputTokens > 0);
  const median = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
  return { sessions: rows.length, turns: median(rows.map(e => e.turns)), input: median(rows.map(e => e.inputTokens)), days };
}
export function instructionCost(store, { days, now } = {}) {
  const cfg = instructionsConfig(store);
  const f = instructionFiles(store.repo), s = sessionStats(store, { days: days || cfg.days, now });
  const share = s.sessions && s.turns && s.input ? Math.min(1, f.tokens * s.turns / s.input) : null;
  let rootHash = null; if (f.root) { try { rootHash = sha(fs.readFileSync(path.join(store.repo, f.root), 'utf8')); } catch {} }
  return { ...f, ...s, share, budget: cfg.budget, slim: readSlimState(store), rootHash };
}
const k = n => n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
export function renderInstructionCost(c) {
  const L = [];
  if (!c.files.length) return 'No instruction files here: no CLAUDE.md, AGENTS.md or .claude/rules. Nothing of yours is in the prefix of a session.';
  const rules = c.files.filter(f => f.kind === 'rule'), core = c.files.filter(f => f.kind === 'core');
  L.push(`Instruction files Claude Code loads into every turn of a session here: ${k(c.tokens)} tokens (bytes/4, an estimate).`);
  for (const f of core) L.push(`  ${f.file.padEnd(28)} ${k(f.tokens).padStart(6)} tokens${f.link ? ` (a link to ${f.link})` : ''}`);
  if (rules.length) L.push(`  .claude/rules (${rules.length} file${rules.length === 1 ? '' : 's'})${''.padEnd(Math.max(0, 28 - 15 - String(rules.length).length - (rules.length === 1 ? 6 : 7)))} ${k(rules.reduce((t, f) => t + f.tokens, 0)).padStart(6)} tokens`);
  if (c.nested) L.push(`  ${c.nested} nested CLAUDE.md/AGENTS.md files load when their directory is touched; not counted.`);
  if (c.sessions) L.push('', `Over the last ${c.days} days: ${c.sessions} session${c.sessions === 1 ? '' : 's'}, median ${c.turns} model turns and ${k(c.input)} input tokens a session, so these files are re-read ${c.turns} times: about ${Math.round(100 * c.share)}% of the input tokens a session bills.`);
  else L.push('', `No sessions logged here in the last ${c.days} days yet; the share of a session's input they take needs a few.`);
  const root = c.files.find(f => f.file === c.root);
  if (root) {
    L.push('', root.tokens > c.budget
      ? `Budget for the core: ${k(c.budget)} tokens; ${root.file} is ${k(root.tokens)}. \`thinker instructions slim\` proposes a core within it and keeps the rest for serving.`
      : `Budget for the core: ${k(c.budget)} tokens; ${root.file} is ${k(root.tokens)}, within it.`);
    if (c.slim?.at) L.push(`Last slim: ${c.slim.at.slice(0, 10)}, ${k(c.slim.tokensBefore)} → ${k(c.slim.tokensAfter)} tokens${c.slim.written ? ', written to the file' : `, proposed in ${c.slim.slimPath}`}${c.rootHash && c.slim.hash !== c.rootHash ? '; the file has changed since' : ''}.`);
  }
  return L.join('\n');
}

// --- the slim core ------------------------------------------------------------------------------------
export const SLIM_SYSTEM = 'You condense a repository\'s agent instruction file into the core a coding agent needs for one change. You keep the file\'s own wording and add nothing that is not in it. You output only Markdown.';
export const slimPrompt = (text, budget) => `Below is the repository's instruction file (about ${k(tokensOf(text))} tokens). Write the slim core a coding agent making one change needs, in at most ${budget} tokens of Markdown, keeping the file's own wording where you can.
- keep: the commands to run, test and lint; the codebase structure; the code style and architecture rules that decide whether a change is correct (imports, boundaries, naming, types, error handling, the conventions of each layer); security rules; rules about user-facing text.
- drop: anything about commits, pull requests, CI, reviews, agent automation, and process the agent does not perform while editing code.
- keep every heading you keep as it is written, so the sections left out can be told apart.
- do not add anything that is not in the file. Output only the Markdown, with no code fence around it.

--- instruction file ---
${text}`;
const unfence = s => String(s || '').trim().replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i, '$1').trim();
const sections = text => { const out = []; let cur = null; for (const line of text.split('\n')) { const m = /^(#{1,3})\s+(.*)$/.exec(line); if (m && m[1].length <= 2) { cur = { heading: m[2].trim(), lines: [line] }; out.push(cur); } else if (cur) cur.lines.push(line); } return out; };
const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Proposes the core: writes .thinker/instructions/<name>.slim.md beside <name>.full.md (the original, whole,
// for serving what the core condensed or left out later), records the source's hash, and with `write` puts
// the core in the person's file. Never writes the person's file otherwise.
export async function slimInstructions(store, { budget, model = 'sonnet', write = false, dry = false, phase = 'manual', completeFn = complete } = {}) {
  const cfg = instructionsConfig(store, budget ? { budget } : {});
  const f = instructionFiles(store.repo);
  if (!f.root) throw new Error('no CLAUDE.md or AGENTS.md at the root of this repository');
  const source = path.join(store.repo, f.root), text = fs.readFileSync(source, 'utf8');
  const before = tokensOf(text);
  if (dry) return { source: f.root, before, budget: cfg.budget, dry: true };
  const res = await completeFn({ system: SLIM_SYSTEM, prompt: slimPrompt(text, cfg.budget), model, maxTokens: Math.max(2000, cfg.budget * 3), thinkingTokens: 0, accounting: { store, purpose: 'instructions-slim', phase } });
  const slim = unfence(res?.text);
  if (!slim || tokensOf(slim) < 20) throw new Error('the model returned no core');
  const kept = new Set(sections(slim).map(s => norm(s.heading)));
  const dropped = sections(text).filter(s => !kept.has(norm(s.heading)));
  const base = path.basename(f.root, '.md');
  fs.mkdirSync(DIR(store), { recursive: true });
  const slimPath = path.join(DIR(store), `${base}.slim.md`), fullPath = path.join(DIR(store), `${base}.full.md`);
  fs.writeFileSync(slimPath, slim + '\n');
  // the original, whole, beside the core: what the core condensed or left out is read from here later
  fs.writeFileSync(fullPath, text);
  const after = tokensOf(slim);
  const shown = p => { const r = path.relative(store.repo, p); return r.startsWith('..') ? p : r; };
  const state = { source: f.root, hash: sha(text), slimHash: sha(slim), tokensBefore: before, tokensAfter: after, budget: cfg.budget, model: res?.model || model, at: new Date().toISOString(), slimPath: shown(slimPath), fullPath: shown(fullPath), dropped: dropped.map(s => s.heading), written: false };
  if (write) {
    fs.writeFileSync(source, slim + '\n');
    state.written = true; state.hash = sha(slim + '\n');
  }
  fs.writeFileSync(stateFile(store), JSON.stringify(state, null, 2) + '\n');
  store.log({ op: 'instructions-slim', source: f.root, before, after, budget: cfg.budget, dropped: dropped.length, written: write, model: state.model, tokens: res?.tokens });
  return { ...state, overBudget: after > cfg.budget, tokens: res?.tokens };
}
export function renderSlim(r) {
  if (r.dry) return `${r.source}: ${k(r.before)} tokens; the core would be written within ${k(r.budget)} tokens to .thinker/instructions/. Run without --dry to write it.`;
  const L = [`${r.source}: ${k(r.tokensBefore)} → ${k(r.tokensAfter)} tokens${r.overBudget ? ` (over the ${k(r.budget)} budget; run again or edit it down)` : ''}.`];
  L.push(r.written ? `Written to ${r.source}; the original is kept whole as ${r.fullPath}. Review the diff and commit it.` : `Proposed in ${r.slimPath}, the original kept whole as ${r.fullPath}. Review it, then \`thinker instructions slim --write\` puts it in ${r.source}, or copy what you want by hand.`);
  if (r.dropped?.length) L.push(`Sections left out of the core (${r.dropped.length}): ${r.dropped.join('; ')}. The sections kept are condensed; the original has every word.`);
  return L.join('\n');
}

// For CI: exit 1 when the core is over budget. No model call.
export function checkInstructions(store, { budget } = {}) {
  const cfg = instructionsConfig(store, budget ? { budget } : {});
  const f = instructionFiles(store.repo);
  const root = f.files.find(x => x.file === f.root);
  const over = root ? root.tokens > cfg.budget : false;
  return { ok: !over, root: f.root, tokens: root?.tokens || 0, budget: cfg.budget, total: f.tokens, line: root ? `${f.root}: ${k(root.tokens)} tokens, budget ${k(cfg.budget)}: ${over ? 'over budget' : 'ok'}` : 'no root instruction file' };
}

// Maintenance: once per content, when the root file changed since the last slim (or was never slimmed) and is
// over budget, a line for the person at the end of the next turn. No model call. Returns the lines to report.
export function watchInstructions(store, { now = Date.now() } = {}) {
  const cfg = instructionsConfig(store);
  if (!cfg.watch) return [];
  const f = instructionFiles(store.repo);
  const root = f.files.find(x => x.file === f.root);
  if (!root || root.tokens <= cfg.budget) return [];
  let text; try { text = fs.readFileSync(path.join(store.repo, f.root), 'utf8'); } catch { return []; }
  const hash = sha(text), st = readSlimState(store) || {};
  if (st.reportedHash === hash) return [];
  fs.mkdirSync(DIR(store), { recursive: true });
  fs.writeFileSync(stateFile(store), JSON.stringify({ ...st, reportedHash: hash, reportedAt: new Date(now).toISOString() }, null, 2) + '\n');
  const grew = st.hash && st.hash !== hash && st.tokensAfter ? ` (${k(st.tokensAfter)} when it was last slimmed)` : '';
  store.log({ op: 'instructions-watch', source: f.root, tokens: root.tokens, budget: cfg.budget });
  return [`${f.root} is ${k(root.tokens)} tokens${grew}, over the ${k(cfg.budget)}-token budget for what every turn re-reads: \`thinker instructions\` shows the cost, \`thinker instructions slim\` proposes a core.`];
}
