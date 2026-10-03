// Core operations shared by the MCP server and the CLI.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { Store, slugify, uniqueId, gitHead, KINDS } from './store.js';
import { hashDep, checkNote, symbolText, symbolBlock, repoFile } from './deps.js';
import { rank, pack, renderNote, renderPointers, estTokens } from './rank.js';
import { annotateFanout, fanout, callers, callees, references, findDefinitions, outline, renderFanout } from './codegraph.js';
import { servedFields } from './usage.js';
import { complete } from './llm.js';
import { loadCochange, renderCochange } from './cochange.js';
import { anchoringGuard, explicitIdents, existsInRepo } from './guard.js';
import { partners } from './cochange.js';

export { KINDS };

function normPath(repo, p) {
  if (!p) return p;
  let r = p.trim().replace(/^\.\//, '');
  if (path.isAbsolute(r)) r = path.relative(repo, r);
  return r.replace(/:\d+(:\d+)?$/, '');
}

// Resolve user/agent-provided deps: normalize paths, drop nonexistent files,
// downgrade unknown symbols to file-level deps. Returns {deps, dropped}.
export function resolveDeps(repo, deps) {
  const out = [], dropped = [];
  const seen = new Set();
  for (const d of deps || []) {
    const p = normPath(repo, d.path);
    const abs = p && repoFile(repo, p);
    if (!abs || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { dropped.push({ ...d, reason: 'outside repository, symlinked outside, or no such file' }); continue; }
    const key = p + '|' + (d.symbol || '');
    if (seen.has(key)) continue;
    seen.add(key);
    const h = hashDep(repo, { path: p, symbol: d.symbol || undefined });
    if (h.symbolMissing) { dropped.push({ ...d, reason: 'symbol not found; kept file-level dep' }); delete h.symbol; delete h.symbolMissing; }
    out.push(h);
  }
  return { deps: out, dropped };
}

// Pull `path/to/file.py:Symbol` (and bare `Class.method` / `func()` that exist in
// an already-listed file) pointers out of a note body so every claim is tracked.
export function extractDeps(repo, body, listed = []) {
  const out = [];
  const seen = new Set(listed.map(d => `${normPath(repo, d.path)}|${d.symbol || ''}`));
  const files = [...new Set(listed.map(d => normPath(repo, d.path)))];
  const add = (p, sym) => { const k = `${p}|${sym || ''}`; if (!seen.has(k)) { seen.add(k); out.push({ path: p, symbol: sym }); } };
  const ptr = /(?:^|[\s(`'"*])((?:[\w.-]+\/)*[\w.-]+\.(?:py|js|ts|tsx|jsx|go|rs|rb|java|kt|cs|php|c|h|cc|cpp|hpp|swift|scala|ex|exs|sh))(?::([A-Za-z_][\w.]*))?/g;
  let m;
  while ((m = ptr.exec(body))) {
    let p = m[1]; if (!fs.existsSync(path.join(repo, p))) { const hit = findFile(repo, p, files); if (!hit) continue; p = hit; }
    if (!files.includes(p)) files.push(p);
    add(p, m[2] && !/^\d/.test(m[2]) ? m[2].replace(/\.$/, '') : undefined);
  }
  // bare Class.method / module.func / func() mentions: attach to the file that defines them
  const bare = /(?<![\w/.])([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+|[A-Za-z_]\w*(?=\(\)))/g;
  while ((m = bare.exec(body))) {
    const sym = m[1];
    if (sym.length < 4 || /^(e\.g|i\.e|etc|vs)\b/i.test(sym) || /^\d/.test(sym)) continue;
    const parts = sym.split('.');
    if (parts.length >= 2 && /^(self|cls|this|ctx|state|args|kwargs|opts|params|value|obj|super|module|exports|process|window|document|console|std|t|os|sys|re|json|fs|path)$/.test(parts[0])) continue;
    let done = false;
    if (parts.length >= 2 && /^[a-z_]\w*$/.test(parts[0])) {
      // module.func: resolve module to a file
      for (const ext of ['py', 'js', 'ts', 'tsx', 'go', 'rb', 'rs']) {
        const f = findFile(repo, parts[0] + '.' + ext, files);
        if (f) { const h = hashDep(repo, { path: f, symbol: parts.slice(1).join('.') }); if (!h.missing && !h.symbolMissing) { if (!files.includes(f)) files.push(f); add(f, parts.slice(1).join('.')); } done = true; break; }
      }
      done = true; // lowercase receiver that is not a module: never guess
    }
    if (done) continue;
    for (const f of files) { const h = hashDep(repo, { path: f, symbol: sym }); if (!h.missing && !h.symbolMissing) { add(f, sym); break; } }
  }
  // a file-level dep only adds noise when the same file already has symbol-level deps
  const symFiles = new Set([...listed, ...out].filter(d => d.symbol).map(d => normPath(repo, d.path)));
  return out.filter(d => d.symbol || !symFiles.has(d.path));
  return out;
}

function findFile(repo, p, files) {
  // resolve a short path like `core.py` against the directories of listed files, then the repo
  const base = path.basename(p);
  for (const f of files) { const cand = path.join(path.dirname(f), p); if (fs.existsSync(path.join(repo, cand))) return cand; }
  for (const f of files) { const cand = path.join(path.dirname(f), base); if (fs.existsSync(path.join(repo, cand))) return cand; }
  try {
    const hits = execFileSync('git', ['ls-files', '--', `*${p}`], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n').filter(Boolean);
    if (hits.length === 1) return hits[0];
  } catch {}
  return null;
}

export function createNote(store, input, { source = { type: 'agent' }, reuseId = false } = {}) {
  const repo = store.repo;
  const extra = extractDeps(repo, String(input.body || ''), input.deps || []);
  const { deps: resolved, dropped } = resolveDeps(repo, [...(input.deps || []), ...extra]);
  if (!resolved.length) return { error: 'no resolvable dependencies; a note must point at at least one existing file', dropped };
  const deps = annotateFanout(repo, resolved); // blast radius of each symbol pointer, shown beside it when served
  const kind = KINDS.includes(input.kind) ? input.kind : 'location';
  const id = reuseId && input.id ? input.id : input.id && !store.get(input.id) ? slugify(input.id) : uniqueId(store, slugify(input.title));
  const now = new Date().toISOString();
  const note = {
    id, title: String(input.title).trim(), kind,
    answers: (input.answers || []).map(s => String(s).trim()).filter(Boolean),
    body: String(input.body).trim(),
    applies: input.applies ? String(input.applies).trim() : undefined,
    tags: (input.tags || []).map(t => String(t).toLowerCase()),
    deps, source, created: now, verified: now, verifiedCommit: gitHead(repo),
    confidence: Math.max(0, Math.min(1, Number(input.confidence ?? 0.7))),
    status: 'fresh', uses: 0,
  };
  store.put(note);
  try { linkNotes(store, note); } catch {}
  return { note, dropped };
}

// Recompute staleness for notes against the working tree. Persists status
// changes. Returns notes with fresh status.
export function refresh(store, notes = store.list(), { persist = true } = {}) {
  return notes.map(n => {
    if (n.status === 'invalid') return n;
    const { changed, deps, upgraded } = checkNote(store.repo, n);
    const wasStale = n.status === 'stale';
    if (changed.length) {
      const stale = { since: n.stale?.since || new Date().toISOString(), changed };
      const next = { ...n, status: 'stale', stale };
      if (persist && (!wasStale || JSON.stringify(n.stale?.changed) !== JSON.stringify(changed))) store.put(next);
      return next;
    }
    if (wasStale) { const next = { ...n, status: 'fresh', deps }; delete next.stale; if (persist) store.put(next); return next; }
    // the parser now hashes a dep the regex hashed, and both see the same block: keep the parser's hash
    if (upgraded) { const next = { ...n, deps }; if (persist) store.put(next); return next; }
    return n;
  });
}

// THINKER_NAIVE=1 disables invalidation entirely (notes are served as written,
// never re-hashed or flagged). Only for benchmarking what a naive cache does.
const NAIVE = process.env.THINKER_NAIVE === '1';

const RERANK_SCHEMA = { type: 'object', properties: { useful: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } }, required: ['useful', 'reason'] };

// Ask a small model which candidate notes would actually save work on this
// task. Returns the subset of ranked entries it picked (order preserved).
async function rerank(store, ranked, task, file, model) {
  const cands = ranked.slice(0, 8);
  // a single candidate is judged too: the best of a poor lot is still poor
  if (!cands.length) return cands;
  const list = cands.map((r, i) => `[${i + 1}] id=${r.note.id} kind=${r.note.kind}\n    title: ${r.note.title}\n    answers: ${(r.note.answers || []).join(' | ')}\n    body: ${r.note.body.slice(0, 350).replace(/\n/g, ' ')}`).join('\n');
  const res = await complete({ model, accounting: { store, purpose: 'rerank' }, schema: RERANK_SCHEMA, maxTokens: 300,
    system: 'You gate which cached notes about a codebase get injected into a coding agent\'s context at the start of a task. Injecting an irrelevant note costs tokens and misdirects the agent; injecting a relevant one saves it from re-exploring. Pick only notes whose content directly bears on what the task must touch or understand. Prefer one precise note over several loosely related ones. Picking none is correct when nothing applies.',
    prompt: `TASK: ${task}${file ? `\nCURRENT FILE: ${file}` : ''}\n\nCANDIDATE NOTES:\n${list}\n\nReturn the ids of the notes worth injecting (0-3).` });
  const pick = new Set((res.json?.useful || []).map(x => String(x).replace(/^\[?(\d+)\]?$/, (_, i) => cands[Number(i) - 1]?.note.id || x).replace(/^id=/, '')));
  if (process.env.THINKER_DEBUG) console.error('rerank:', JSON.stringify(res.json));
  return cands.filter(r => pick.has(r.note.id));
}

const ROUTE_SCHEMA = { type: 'object', properties: {
  request_type: { type: 'string', enum: ['specified', 'symptom', 'question', 'other'] },
  mode: { type: 'string', enum: ['full', 'pointers', 'none'] },
  ids: { type: 'array', items: { type: 'string' } },
  reason: { type: 'string' } }, required: ['request_type', 'mode', 'ids', 'reason'] };

// A small model decides what the cache says at the start of a task: which
// candidate notes (if any) and in what form. Falls back to the heuristic.
export async function route(store, ranked, task, file, model) {
  const cands = ranked.slice(0, 8);
  if (!cands.length) return { mode: 'none', picked: [], reason: 'no candidates' };
  const list = cands.map((r, i) => `[${i + 1}] id=${r.note.id} kind=${r.note.kind} confidence=${Math.round((r.note.confidence ?? 0.7) * 100)}%${r.note.status === 'stale' ? ' STALE' : ''}\n    title: ${r.note.title}\n    answers: ${(r.note.answers || []).slice(0, 3).join(' | ')}\n    first lines: ${r.note.body.slice(0, 260).replace(/\n/g, ' ')}`).join('\n');
  const res = await complete({ model, accounting: { store, purpose: 'route' }, schema: ROUTE_SCHEMA, maxTokens: 400,
    system: `You decide what a cache of notes about a codebase injects into a coding agent's context at the start of a task. Evidence from experiments you must apply:
- Notes with explanatory prose save the agent work when the request already says WHAT to change (it names code, components or the exact behavior change). Then mode=full.
- When the request only describes a symptom or a wish in product words, prose makes the agent commit to a narrower fix than it would have designed on its own. Locations alone still shorten the search. Then mode=pointers.
- Injecting a note that is not about what the task must touch costs tokens and can misdirect. If no candidate clearly concerns the feature or code the request is about, mode=none with no ids.
- Prefer one or two precise notes over three loosely related ones. Never pick a note only because it shares generic words with the request.
Classify the request (specified / symptom / question / other), choose the mode, and list the ids worth serving (0-3), best first.`,
    prompt: `REQUEST:\n${String(task).slice(0, 3000)}${file ? `\nCURRENT FILE: ${file}` : ''}\n\nCANDIDATE NOTES:\n${list}` });
  const j = res.json || {};
  const norm = x => String(x).replace(/^\[?(\d+)\]?$/, (_, i) => cands[Number(i) - 1]?.note.id || x).replace(/^id=/, '');
  const ids = (j.ids || []).map(norm);
  const picked = ids.map(id => cands.find(c => c.note.id === id)).filter(Boolean).slice(0, 3);
  const mode = picked.length ? (j.mode === 'none' ? 'pointers' : j.mode) : 'none';
  store.log({ op: 'route', type: j.request_type, mode, ids: picked.map(p => p.note.id), reason: String(j.reason || '').slice(0, 200), cost: res.cost, metered: true });
  return { mode, picked, type: j.request_type, reason: j.reason };
}

// How specific is the request? Count identifiers in it that exist in the repo.
export function specificity(repo, task) {
  let n = 0;
  for (const id of explicitIdents(String(task)).filter(x => x.length >= 5).slice(0, 12)) if (existsInRepo(repo, id) > 0) n++;
  return n;
}

// Tokens of notes a prompt hook serves. A note that does not fit is cut to its first line and its
// pointers; on PostHog two long notes need about 1500 to be served in full.
export const HOOK_BUDGET = 750;

// --- code behind the pointers ----------------------------------------------------------------------
// The definitions the served notes point at, inlined after the notes, so the agent does not open a
// 1,000-line file to see a 20-line function (the "file-read tax" the Qartez comparison measured).
// Per note the symbol-level pointers in order, at most `perNote` of them and `max` in all, each cut to
// `maxLines`; a snippet is added only when it fits the budget whole. Returns {text, tokens, shown}.
export const SNIPPET_BUDGET = Number(process.env.THINKER_SNIPPET_BUDGET) || 600;
export function codeSnippets(repo, notes, budget, { perNote = 2, max = 4, maxLines = 30, minLines = 8 } = {}) {
  const parts = [], shown = [], seen = new Set();
  let used = 0;
  for (const n of notes) {
    let k = 0;
    for (const d of (n.deps || []).filter(d => d.symbol && !d.missing && !d.symbolMissing)) {
      if (k >= perNote || shown.length >= max) break;
      const key = `${d.path}|${d.symbol}`; if (seen.has(key)) continue;
      const b = symbolBlock(repo, d, maxLines); if (!b) continue;
      seen.add(key);
      let lines = b.text.split('\n'); let text, t;
      // cut further when it does not fit, down to minLines; then skip it
      for (;;) {
        const cut = lines.length < b.total;
        const range = `L${b.start}–L${b.start + lines.length - 1}${cut ? ` of L${b.start}–L${b.start + b.total - 1}` : ''}`;
        text = `${d.path}:${d.symbol} (${range})\n\`\`\`\n${lines.join('\n')}${cut ? '\n…' : ''}\n\`\`\``;
        t = estTokens(text);
        if (used + t <= budget) break;
        if (lines.length <= minLines) { text = null; break; }
        lines = lines.slice(0, Math.max(minLines, Math.floor(lines.length / 2)));
      }
      if (!text) continue;
      parts.push(text); used += t; shown.push({ id: n.id, path: d.path, symbol: d.symbol }); k++;
    }
  }
  if (!parts.length) return { text: '', tokens: 0, shown };
  return { text: `### Code behind the pointers\n${parts.join('\n\n')}`, tokens: used, shown };
}

// early: 'full' (notes with prose), 'pointers' (titles + anchors only),
// 'auto' (full when the request names code that exists, else pointers), 'none'.
// maxNotes/relFloor: the prompt hooks serve two notes; a caller that names its own budget (the MCP
// tool) passes a higher maxNotes, and notes past the second must then reach relFloor of the best hit.
// snippets: inline the code behind the served pointers (codeSnippets) in what is left of the budget
// plus `snippets.budget` tokens (SNIPPET_BUDGET); the MCP tools pass it, the hooks do not.
export async function orient(store, { task, file, session, client, budget = HOOK_BUDGET, maxNotes = 2, relFloor = 0, refreshFirst = !NAIVE, recordUsage = true, backgroundVerify = true, rerankModel = store.config().rerank || process.env.THINKER_RERANK, early = process.env.THINKER_EARLY || store.config().early || 'full', snippets = false }) {
  const start = Date.now();
  if (early === 'none') return { text: '', included: [], omitted: [], tokens: 0 };
  const routerModel = early === 'router' ? (process.env.THINKER_ROUTER || store.config().router || 'haiku') : null;
  if (early === 'auto' || early === 'router') early = specificity(store.repo, task) >= 1 ? 'full' : 'pointers'; // heuristic, also the router's fallback
  let notes = store.list();
  if (NAIVE) notes = notes.map(n => { const c = { ...n, status: 'fresh' }; delete c.stale; return c; });
  if (refreshFirst) notes = refresh(store, notes);
  let ranked = rank(notes, { query: task, file: normPath(store.repo, file), mode: 'orient' });
  if (process.env.THINKER_FORCE === '1') ranked = rank(notes, { query: '', mode: 'orient' }).map(r => ({ ...r, rel: 1 })); // control arm: inject regardless of relevance
  let chosen = false;
  if (process.env.THINKER_FORCE !== '1' && rerankModel && ranked.length) { try { ranked = await rerank(store, ranked, task, file, rerankModel); chosen = true; } catch (e) { store.log({ op: 'rerank-error', error: String(e.message) }); } }
  let routed = null;
  if (routerModel && process.env.THINKER_FORCE !== '1') {
    try {
      const loose = rank(notes, { query: task, file: normPath(store.repo, file), mode: 'orient', loose: true });
      routed = await route(store, loose, task, file, routerModel);
      if (routed.mode === 'none') { store.log({ op: 'orient', session, client: client || 'cli', task: String(task).slice(0, 200), served: [], routed: 'none', durationMs: Date.now() - start }); return { text: '', included: [], omitted: [], tokens: 0, mode: 'none', routed }; }
      ranked = routed.picked.map(r => ({ ...r, rel: Math.max(r.rel, 0.5) })); early = routed.mode;
    } catch (e) { store.log({ op: 'route-error', error: String(e.message).slice(0, 200) }); }
  }
  let top = ranked.slice(0, maxNotes).filter((r, i) => i < 2 || r.rel >= relFloor * ranked[0].rel);
  if (routed) process.env.THINKER_NO_LINKS = '1'; // the router's selection is final
  // cross-note links: pull in one note linked from the best hit when it has
  // at least some lexical relevance of its own and is not already selected
  // what a model chose is final: a linked note it did not choose is not added
  if (top.length && !chosen && process.env.THINKER_NO_LINKS !== '1') {
    const rel = ranked.filter(r => (top[0].note.related || []).includes(r.note.id) && !top.includes(r) && r.rel >= 0.15)[0];
    // with more than two slots the linked note is added; with two slots it takes the second only if
    // slot 2 is missing, weak (<0.7 of the best hit), or less relevant than the linked note.
    if (rel) {
      if (maxNotes > 2 || top.length < maxNotes) {
        top = [...top, rel];
      } else if (top[1] && (top[1].rel < 0.7 * top[0].rel || rel.rel > top[1].rel)) {
        top = [top[0], rel];
      }
    }
  }
  const packed = pack(top, budget, { minRel: 0.35, pointers: early === 'pointers' });
  packed.mode = early;
  // relevant notes that were not served, so the caller can name them and the agent can ask for one
  packed.more = ranked.filter(r => !packed.included.includes(r.note) && r.rel >= 0.35).slice(0, 6).map(r => r.note);
  if (recordUsage) for (const n of packed.included) { n.uses = (n.uses || 0) + 1; n.lastUsed = new Date().toISOString(); if (session) n.servedIn = [...(n.servedIn || []), session].slice(-30); store.put(n); }
  if (recordUsage && session) trackTurn(store, session, packed.included.map(n => n.id));
  if (!NAIVE && backgroundVerify) scheduleVerify(store, packed.included.filter(n => n.status === 'stale'));
  // co-change edges for the files the served notes (and the current file) point at
  // co-change lines are carried through every later model call, so they are
  // off at the start by default; the end-of-task nudge uses them instead
  const cc = process.env.THINKER_EARLY_COCHANGE === '1' && process.env.THINKER_NO_COCHANGE !== '1' ? loadCochange(store.repo) : null;
  if (cc && packed.included.length) {
    const files = [...new Set([file, ...packed.included.flatMap(n => (n.deps || []).map(d => d.path))].filter(Boolean))].slice(0, 6);
    const block = renderCochange(cc, files);
    if (block) { packed.text += '\n\n' + block; packed.tokens += estTokens(block); packed.cochange = true; }
  }
  // anchoring guard: name what the request mentions that the notes do not cover
  if (packed.included.length && process.env.THINKER_NO_GUARD !== '1') {
    try { const g = anchoringGuard(store.repo, String(task), packed.included, { explicitOnly: process.env.THINKER_GUARD_PHRASES !== '1', max: 3 }); if (g.text) { packed.text += '\n\n' + g.text; packed.tokens += estTokens(g.text); packed.uncovered = g.uncovered.map(u => u.ident); } } catch {}
  }
  addSnippets(store, packed, budget, snippets, early === 'pointers');
  if (recordUsage) store.log({ op: 'orient', session, client: client || 'cli', task: String(task).slice(0, 200), file, served: packed.included.map(n => n.id), uncovered: packed.uncovered, snippets: packed.snippets?.length || undefined, stale: packed.included.filter(n => n.status === 'stale').map(n => n.id), durationMs: Date.now() - start, ...servedFields(store, packed.included, packed.text) });
  return packed;
}

// THINKER_SNIPPETS=off or `snippets: false` in .thinker/config.json leaves the code out everywhere.
export function snippetsOn(store) { return process.env.THINKER_SNIPPETS !== 'off' && store.config().snippets !== false; }
function addSnippets(store, packed, budget, snippets, pointersOnly) {
  if (!snippets || !packed.included.length || !snippetsOn(store)) return;
  const extra = typeof snippets === 'object' && snippets.budget != null ? snippets.budget : SNIPPET_BUDGET;
  const left = Math.max(0, budget - packed.tokens) + extra;
  // in pointers mode the notes are stubs; the code is then most of what is served, so fewer pieces
  const s = codeSnippets(store.repo, packed.included, left, pointersOnly ? { perNote: 1, max: 3 } : {});
  if (!s.text) return;
  packed.text += '\n\n' + s.text; packed.tokens += s.tokens; packed.snippets = s.shown;
}

// --- implicit feedback ---------------------------------------------------
// Apply the distiller's assessment of notes that were injected into a session.
// confirmed: the trace shows the agent used the pointer and nothing contradicted it.
// contradicted: the trace shows a claim was wrong; body is replaced by the correction.
// unused: served but not acted on; repeated unused servings decay confidence.
export function attest(store, assessments, { session, client, model } = {}) {
  const applied = [];
  for (const a of assessments || []) {
    const n = store.get(a.id); if (!n) continue;
    const now = new Date().toISOString();
    n.attest = n.attest || { confirmed: 0, contradicted: 0, unused: 0 };
    if (a.verdict === 'confirmed') { n.attest.confirmed++; n.confidence = Math.min(1, (n.confidence ?? 0.7) + 0.05); n.verified = now; }
    else if (a.verdict === 'contradicted') {
      n.attest.contradicted++;
      n.confidence = Math.max(0.05, (n.confidence ?? 0.7) - 0.25);
      if (a.correction && a.correction.trim().length > 40) { n.history = [...(n.history || []), { at: now, reason: 'contradicted in session ' + (session || '?') + ': ' + (a.evidence || ''), prevBody: n.body }].slice(-5); n.body = a.correction.trim(); n.verified = now; }
      if (n.confidence < 0.3) { n.status = 'invalid'; n.invalidReason = 'contradicted by later sessions'; }
    } else {
      n.attest.unused++;
      // Navigational notes (callpath, location, overview) decay slowly towards 0.4 after ≥5 unconfirmed servings.
      // Rule notes (invariant, convention, gotcha, howto, fix) represent enduring truths and do not decay on simple omission.
      const decays = ['callpath', 'location', 'overview'].includes(n.kind);
      if (decays && (n.attest.confirmed || 0) === 0 && n.attest.unused >= 5) {
        n.confidence = Math.max(0.4, (n.confidence ?? 0.7) - 0.03);
      }
    }
    store.put(n);
    applied.push({ id: n.id, verdict: a.verdict, confidence: n.confidence });
  }
  if (applied.length) store.log({ op: 'attest', session, client, model: model || undefined, applied });
  return applied;
}

// --- late, file-keyed injection ---------------------------------------------
// Rules about files the agent is changing (invariant, gotcha, convention, cochange),
// served when it edits them: each once per session, and only those that bear on the
// request. `on: 'read'` (THINKER_LATE=read) serves any note on a file as soon as the
// agent opens it, rules before maps of the code; an agent that gets those after every
// read was seen to read in smaller steps and make more calls.
const RULE_KINDS = ['invariant', 'gotcha', 'convention', 'cochange'];
const LATE_PRIORITY = { invariant: 0, gotcha: 1, convention: 2, cochange: 3, fix: 4, rationale: 5, howto: 6, callpath: 7, location: 8, overview: 9 };
function sessionState(store, session) {
  const f = path.join(store.dir, 'state', `session-${String(session).replace(/[^\w-]/g, '')}.json`);
  let st = { late: [], turn: [], nudged: false }; try { st = { ...st, ...JSON.parse(fs.readFileSync(f, 'utf8')) }; } catch {}
  return { st, save: () => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(st)); } };
}
// The notes served since the turn's stop hook last ran, for the summary it shows the user.
export function trackTurn(store, session, ids) {
  if (!session || !ids?.length || !store.exists()) return;
  locked(store, session, () => { const { st, save } = sessionState(store, session); st.turn = [...new Set([...(st.turn || []), ...ids])]; save(); });
}
export function takeTurn(store, session) {
  if (!session || !store.exists()) return [];
  return locked(store, session, () => { const { st, save } = sessionState(store, session); const ids = st.turn || []; if (!ids.length) return []; st.turn = []; save(); return ids; });
}
// Hooks of one session can run at the same moment. Unlocked, two of them read the same
// state and both serve, which is how a session got past its limit of late notes.
function locked(store, session, fn) {
  const lock = path.join(store.dir, 'state', `session-${String(session).replace(/[^\w-]/g, '')}.lock`);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (const until = Date.now() + 3000; ;) {
    try { fs.mkdirSync(lock); break; } catch (e) { if (e.code !== 'EEXIST' || Date.now() > until) break; } // a lock this old was left by a hook that died
    Atomics.wait(wait, 0, 0, 25);
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch {} }
}
// The request of a session, kept for the hooks that run later in it and are not given it
export function rememberTask(store, session, task) {
  if (!session || !String(task || '').trim() || !store.exists()) return;
  locked(store, session, () => { const { st, save } = sessionState(store, session); st.task = String(task).slice(0, 2000); save(); });
}
export function lateNotes(store, { session, client, files, edited = false, on = process.env.THINKER_LATE === 'read' ? 'read' : 'edit', perEvent = 2, perSession = on === 'read' ? 5 : 3, minRel = 0.35 }) {
  if (on === 'edit' && !edited) return { text: '', included: [] };
  const rel = [...new Set((files || []).map(f => normPath(store.repo, f)).filter(Boolean))];
  if (!rel.length) return { text: '', included: [] };
  return locked(store, session, () => lateLocked(store, { session, client, rel, on, perEvent, perSession, minRel }));
}
function lateLocked(store, { session, client, rel, on, perEvent, perSession, minRel }) {
  const { st, save } = sessionState(store, session);
  if (st.late.length >= perSession) return { text: '', included: [] };
  let notes = store.list().filter(n => n.status !== 'invalid' && !st.late.includes(n.id) && !(n.servedIn || []).includes(session) && (n.deps || []).some(d => rel.includes(d.path)));
  if (on === 'edit') {
    notes = notes.filter(n => RULE_KINDS.includes(n.kind));
    // relevance is measured among all notes: among these few the best one would always score 1
    if (st.task && notes.length) { const score = new Map(rank(store.list(), { query: st.task, mode: 'lookup' }).map(r => [r.note.id, r.rel])); notes = notes.filter(n => (score.get(n.id) || 0) >= minRel); }
  }
  if (!NAIVE) notes = refresh(store, notes);
  notes.sort((a, b) => (LATE_PRIORITY[a.kind] ?? 9) - (LATE_PRIORITY[b.kind] ?? 9) || (b.confidence ?? 0.7) - (a.confidence ?? 0.7));
  const pick = notes.slice(0, Math.min(perEvent, perSession - st.late.length));
  if (!pick.length) return { text: '', included: [] };
  for (const n of pick) { st.late.push(n.id); n.uses = (n.uses || 0) + 1; n.servedIn = [...(n.servedIn || []), session].slice(-30); store.put(n); }
  st.turn = [...new Set([...(st.turn || []), ...pick.map(n => n.id)])];
  save();
  const intro = on === 'edit'
    ? `Rules from previous sessions about code you are changing (${rel.join(', ')}). Check the change against them; they do not call for more reading.`
    : `Cached notes about ${rel.join(', ')} from previous sessions. They describe rules and context around this code; they are partial, so keep reading what the change needs.`;
  const text = `<thinker-cache>\n${intro}\n\n${pick.map(n => renderNote(n)).join('\n\n')}\n</thinker-cache>`;
  store.log({ op: 'late', on, session, client: client || 'cli', files: rel, served: pick.map(n => n.id), ...servedFields(store, pick, text) });
  return { included: pick, text };
}

// --- completeness nudge -------------------------------------------------------
// At the end of a session that edited files: co-change partners that were not
// touched, and rule notes on the edited files that were never served.
export function completenessNudge(store, { session, changed, cochange }) {
  const { st, save } = sessionState(store, session);
  if (st.nudged || !changed.length) return { text: '' };
  const lines = [];
  const isTest = f => /(^|\/)(tests?|__tests__)\/|(^|\/)test_[^/]*$|\.(test|spec)\.\w+$|_test\.\w+$/.test(f);
  if (cochange) for (const f of changed.filter(f => !isTest(f)).slice(0, 8)) {
    const miss = partners(cochange, f, { minSupport: 3, minConf: 0.5, limit: 3 }).filter(p => !changed.includes(p.file) && fs.existsSync(path.join(store.repo, p.file)));
    if (miss.length) lines.push(`${f} was edited; in past commits it changed together with ${miss.map(p => `${p.file} (${Math.round(p.conf * 100)}%, n=${p.support})`).join(', ')}, which you did not touch.`);
  }
  const rules = store.list().filter(n => ['invariant', 'cochange', 'convention', 'gotcha'].includes(n.kind) && n.status !== 'invalid' && !(n.servedIn || []).includes(session) && (n.deps || []).some(d => changed.includes(d.path))).slice(0, 3);
  for (const n of rules) { lines.push(`Rule not yet seen this session, [${n.kind}] ${n.title}: ${n.body.split('\n').slice(0, 4).join(' ').slice(0, 400)}`); n.servedIn = [...(n.servedIn || []), session].slice(-30); store.put(n); }
  if (!lines.length) return { text: '' };
  st.nudged = true; save();
  store.log({ op: 'nudge', session, changed, lines: lines.length });
  return { text: `Before finishing, check completeness against what this repository's history and notes say:\n- ${lines.slice(0, 6).join('\n- ')}\nFor each item decide whether your change needs it. Make the additional edits if so; if not, say why in one line, then finish.` };
}

// --- outcome signals -----------------------------------------------------
// Session-level outcome applied to every note served in that session. Weaker
// than a contradiction (the signal is noisy): -0.1 per negative, +0.03 per positive.
export function outcome(store, { session, positive, reason }) {
  const hit = store.list().filter(n => (n.servedIn || []).includes(session));
  for (const n of hit) {
    n.outcomes = n.outcomes || { positive: 0, negative: 0 };
    if (positive) { n.outcomes.positive++; n.confidence = Math.min(1, (n.confidence ?? 0.7) + 0.03); }
    else { n.outcomes.negative++; n.confidence = Math.max(0.05, (n.confidence ?? 0.7) - 0.1); if (n.confidence < 0.3) { n.status = 'invalid'; n.invalidReason = 'repeated negative outcomes'; } }
    store.put(n);
  }
  store.log({ op: 'outcome', session, positive, reason, notes: hit.map(n => n.id) });
  return hit.map(n => ({ id: n.id, confidence: n.confidence }));
}

// A follow-up prompt that reads as a correction of the previous turn.
const CORRECTION = /^(no[,.! ]|nope|wrong|that'?s (not|wrong|incorrect)|not (what|that|there|it)|incorrect|still (broken|fails|failing|wrong|doesn'?t|not)|doesn'?t work|didn'?t work|that (didn'?t|doesn'?t|broke)|revert|undo|you (broke|missed|changed the wrong)|this is (wrong|not))/i;
export function looksLikeCorrection(prompt) { return CORRECTION.test(String(prompt || '').trim()); }

// --- cross-note links -----------------------------------------------------
// Link notes that share a symbol-level dep, or several files, or overlap in
// their question side. Symmetric; each note keeps its top 4 links.
export function linkNotes(store, note, notes = store.list()) {
  const key = d => `${d.path}|${d.symbol || ''}`;
  const syms = new Set((note.deps || []).filter(d => d.symbol).map(key));
  const files = new Set((note.deps || []).map(d => d.path));
  const scored = [];
  for (const o of notes) {
    if (o.id === note.id || o.status === 'invalid') continue;
    let sc = 0;
    for (const d of o.deps || []) { if (d.symbol && syms.has(key(d))) sc += 2; else if (files.has(d.path)) sc += 0.5; }
    if (sc > 0) scored.push({ id: o.id, sc });
  }
  scored.sort((a, b) => b.sc - a.sc);
  const related = scored.filter(x => x.sc >= 1).slice(0, 4).map(x => x.id);
  note.related = related;
  store.put(note);
  for (const id of related) { const o = store.get(id); if (o && !(o.related || []).includes(note.id)) { o.related = [...(o.related || []), note.id].slice(-4); store.put(o); } }
  return related;
}


// Served a stale note: re-verify it in the background so the next caller gets
// a fresh or corrected version. At most one attempt per note per 10 minutes.
export function scheduleVerify(store, notes) {
  if (process.env.THINKER_NO_BG_VERIFY === '1') return;
  const now = Date.now();
  const ids = notes.filter(n => !n.verifying || now - Date.parse(n.verifying) > 10 * 60_000).map(n => n.id);
  if (!ids.length) return;
  for (const id of ids) { const n = store.get(id); if (n) { n.verifying = new Date(now).toISOString(); store.put(n); } }
  try {
    const cli = new URL('./cli.js', import.meta.url).pathname;
    const child = spawn('node', [cli, 'verify', ...ids, '--repo', store.repo], { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
    store.log({ op: 'bg-verify', ids });
  } catch (e) { store.log({ op: 'bg-verify-error', error: String(e.message) }); }
}

export function lookup(store, { query, client, budget = 2500, maxNotes = 3, snippets = false } = {}) {
  const start = Date.now();
  const notes = NAIVE ? store.list().map(n => { const c = { ...n, status: 'fresh' }; delete c.stale; return c; }) : refresh(store, store.list());
  // a note id (as listed by orient) returns that note
  const byId = notes.find(n => n.id === String(query).trim());
  const ranked = byId ? [{ note: byId, score: 1, rel: 1, aff: 0 }] : rank(notes, { query, mode: 'lookup' });
  const candidates = byId ? ranked : (maxNotes ? ranked.slice(0, maxNotes) : ranked);
  const packed = pack(candidates, budget, { minRel: 0.15 });
  addSnippets(store, packed, budget, snippets, false);
  store.log({ op: 'lookup', client: client || 'cli', query: String(query).slice(0, 200), served: packed.included.map(n => n.id), snippets: packed.snippets?.length || undefined, durationMs: Date.now() - start, ...servedFields(store, packed.included, packed.text) });
  return packed;
}

// --- drilldown: one pointer, everything around it ---------------------------------------------------
// `path:Symbol` (as orient and lookup print it; `:L12` may follow), `path` alone, or a bare `Symbol`
// found in the notes' pointers or in the code. Returns the definition with its lines, one hop of
// callers and callees (codegraph.js: the code graph when the checkout is indexed, else git grep),
// and the notes that rest on it: what the agent would otherwise collect with a read of the whole
// file and two or three greps.
export function parsePointer(raw) {
  const [p, ...rest] = String(raw).split(':');
  const out = { path: p, symbol: null, line: null };
  for (const r of rest) { if (/^L?\d+$/.test(r)) out.line = Number(r.replace(/^L/, '')); else if (/^[A-Za-z_$][\w.$]*$/.test(r) && !out.symbol) out.symbol = r; else return null; }
  return out;
}
export function drilldown(store, { pointer, client, budget = 1500 } = {}) {
  const start = Date.now(); const repo = store.repo;
  const raw = String(pointer || '').trim().replace(/^[`'"]|[`'"]$/g, '');
  if (!raw) return { error: 'drilldown needs a pointer: path:Symbol, a path, or a symbol name' };
  const notes = store.list().filter(n => n.status !== 'invalid');
  let file = null, symbol = null, others = null;
  const m = parsePointer(raw);
  if (m && /[/.]/.test(m.path) && repoFile(repo, normPath(repo, m.path)) && !fs.statSync(repoFile(repo, normPath(repo, m.path))).isDirectory()) { file = normPath(repo, m.path); symbol = m.symbol; }
  else if (/^[A-Za-z_$][\w.$]*$/.test(raw)) {
    symbol = raw;
    // the notes' pointers first (the most used note's), then the definitions in the code
    const byUse = notes.flatMap(n => (n.deps || []).filter(d => d.symbol === raw || d.symbol?.endsWith('.' + raw)).map(d => ({ d, uses: n.uses || 0 }))).sort((a, b) => b.uses - a.uses);
    if (byUse.length) { file = byUse[0].d.path; symbol = byUse[0].d.symbol; }
    else {
      const defs = findDefinitions(repo, raw.split('.').pop());
      if (defs === null) return { error: 'cannot search this checkout (not a git repository?); give the pointer as path:Symbol' };
      if (!defs.length) return { error: `no definition of ${raw} in the repository` };
      file = defs[0].path;
      if (defs.length > 1) others = defs.slice(1, 6).map(d => `${d.path}:L${d.line}`);
    }
  } else return { error: `not a pointer: ${raw}` };
  const dep = { path: file, symbol: symbol || undefined };
  const parts = [];
  let used = 0; const add = s => { parts.push(s); used += estTokens(s); };
  if (symbol) {
    const block = symbolBlock(repo, dep, 400);
    if (!block) {
      const defs = findDefinitions(repo, symbol.split('.').pop()) || [];
      return { error: `${symbol} is not defined in ${file}${defs.length ? `; defined in ${defs.slice(0, 4).map(d => `${d.path}:L${d.line}`).join(', ')}` : ''}` };
    }
    const fo = fanout(repo, dep);
    const code = block.text.split('\n'); const room = Math.max(10, Math.floor(budget * 0.65 * 3.6 / 40)); // ~40 chars a line
    const lines = code.slice(0, room); const cut = lines.length < block.total;
    add(`${file}:${symbol} (L${block.start}–L${block.start + block.total - 1}, ${block.total} lines${fo ? `; ${renderFanout(fo)}` : ''})\n\`\`\`\n${lines.join('\n')}${cut ? `\n… (${block.total - lines.length} more lines)` : ''}\n\`\`\``);
    const known = callers(repo, dep); // resolved by the graph when the checkout is indexed (cbm.js)
    const refs = known?.length ? null : references(repo, symbol.split('.').pop(), { file, limit: 400 });
    if (known?.length) {
      const nf = new Set(known.map(c => c.path || c.qn)).size;
      const show = known.slice(0, 12).map(c => `- ${c.path ? `${c.path}${c.line ? `:${c.name}:L${c.line}` : ` ${c.name}`}` : c.qn}`);
      add(`Callers (${known.length} in ${nf} file${nf === 1 ? '' : 's'}):\n${show.join('\n')}${known.length > show.length ? `\n- … ${known.length - show.length} more` : ''}`);
    } else if (refs) {
      const callers = refs.lines.filter(l => !l.def && !(l.path === file && l.line >= block.start && l.line < block.start + block.total)).sort((a, b) => (b.call - a.call) || (a.test - b.test));
      const show = callers.slice(0, 10).map(l => `- ${l.path}:L${l.line}  ${l.text.trim().slice(0, 100)}`);
      const nf = new Set(callers.map(l => l.path)).size; add(`Callers and other references${callers.length ? ` (${callers.length}${refs.truncated ? '+' : ''} in ${nf} file${nf === 1 ? '' : 's'}):\n${show.join('\n')}` : ': none'}${callers.length > show.length ? `\n- … ${callers.length - show.length} more (git grep -nw ${symbol.split('.').pop()})` : ''}`);
    }
    const ce = callees(repo, dep, { limit: 12 });
    if (ce?.length) add(`Calls into this repository: ${ce.map(c => `${c.name} (${c.defs.map(d => `${d.path}:L${d.line}`).join(', ')})`).join(', ')}`);
  } else {
    const o = outline(repo, file);
    if (!o) return { error: `cannot read ${file}` };
    add(`${file}: ${o.length} definitions\n${o.slice(0, 60).map(d => `- L${d.line} ${d.kind} ${d.parent ? d.parent + '.' : ''}${d.name}`).join('\n')}${o.length > 60 ? `\n- … ${o.length - 60} more` : ''}`);
  }
  // notes resting on the symbol, then on the file; the best one in full when the budget allows
  const name = symbol ? symbol.split('.').pop() : null;
  const onSym = symbol ? notes.filter(n => (n.deps || []).some(d => d.path === file && d.symbol && d.symbol.split('.').pop() === name)) : [];
  const onFile = notes.filter(n => !onSym.includes(n) && (n.deps || []).some(d => d.path === file));
  const rel = [...onSym, ...onFile].sort((a, b) => (b.confidence ?? 0.7) - (a.confidence ?? 0.7)).slice(0, 6);
  if (rel.length) {
    const first = renderNote(rel[0]);
    const list = rel.slice(1).map(n => `- [${n.kind}] ${n.title}  (id: ${n.id})`).join('\n');
    const full = used + estTokens(first) + estTokens(list) <= budget;
    add(`Cached notes about this code (lookup takes an id):\n${full ? first : `- [${rel[0].kind}] ${rel[0].title}  (id: ${rel[0].id})`}${list ? '\n' + list : ''}`);
    if (full) { rel[0].uses = (rel[0].uses || 0) + 1; rel[0].lastUsed = new Date().toISOString(); store.put(rel[0]); }
  } else add('No cached notes rest on this code.');
  if (others) add(`Also defined in: ${others.join(', ')} (pass path:Symbol to pick one).`);
  const text = parts.join('\n\n');
  store.log({ op: 'drilldown', client: client || 'cli', pointer: raw.slice(0, 200), file, symbol, notes: rel.map(n => n.id), durationMs: Date.now() - start, tokens: estTokens(text) });
  return { text, file, symbol, notes: rel, tokens: estTokens(text) };
}

// --- phrasings ------------------------------------------------------------------
// Notes are written in the words of the code; a request is written in the words of the product
// ("the sidebar stays open", not setScenePanelOpen). Ranking matches words, so each note gets a
// few lines of how a user would put it. They come from the note alone, never from a request.
const PHRASE_SCHEMA = { type: 'object', properties: { notes: { type: 'array', items: { type: 'object', properties: { n: { type: 'number' }, says: { type: 'array', items: { type: 'string' } } }, required: ['n', 'says'] } } }, required: ['notes'] };
export const phraseKey = n => `${n.title}\n${n.body}`.length + ':' + slugify(n.title).slice(0, 24);
export async function phraseNotes(store, notes, { model, max = 5, phase = 'maintenance' } = {}) {
  model = model || store.config().phraseModel || 'haiku';
  const list = notes.map((n, i) => `[${i + 1}] kind=${n.kind}\n    title: ${n.title}\n    answers: ${(n.answers || []).slice(0, 4).join(' | ')}\n    files: ${(n.deps || []).slice(0, 5).map(d => d.path + (d.symbol ? ':' + d.symbol : '')).join(', ')}\n    body: ${String(n.body).slice(0, 700).replace(/\n/g, ' ')}`).join('\n\n');
  const res = await complete({ model, accounting: { store, purpose: 'phrase', phase }, schema: PHRASE_SCHEMA, maxTokens: 2500,
    system: `You write search phrasings for notes about a codebase. Each note is written in the words of the code (function, file and type names). The people who will need it describe their problem in the words of the product: what they see on screen, what they clicked, what went wrong, what they want instead. For each note write up to ${max} short lines, each one a way a user or a product manager could report the fault or ask for the change that this note bears on.\nRules: plain product language, no identifiers, no file names; name the feature, screen or control as a user would call it; use different words in each line (synonyms, the symptom, the wish); 6 to 16 words per line; only what the note is really about, nothing generic such as "it does not work".`,
    prompt: `NOTES:\n\n${list}\n\nReturn one entry per note, with its number as n.` });
  const done = [];
  for (const e of res.json?.notes || []) {
    const n = notes[Number(e.n) - 1]; if (!n) continue;
    const says = [...new Set((e.says || []).map(x => String(x).trim()).filter(x => x.length > 8))].slice(0, max);
    if (!says.length) continue;
    const cur = store.get(n.id) || n;
    store.put({ ...cur, says, saysFor: phraseKey(cur) });
    done.push(n.id);
  }
  store.log({ op: 'phrase', ids: done, cost: res.cost, metered: true });
  return { done, cost: res.cost };
}

function gitDiffFor(repo, fromCommit, paths) {
  if (!fromCommit) return '';
  try {
    return execFileSync('git', ['diff', '--no-color', '-U3', fromCommit, '--', ...paths], { cwd: repo, maxBuffer: 8 * 1024 * 1024 }).toString().slice(0, 12000);
  } catch { return ''; }
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['still_valid', 'update', 'invalid'] },
    reason: { type: 'string' },
    body: { type: 'string', description: 'revised note body when verdict=update; else empty' },
    confidence: { type: 'number' },
  },
  required: ['verdict', 'reason', 'body', 'confidence'],
};

// Re-verify a stale note with a small model, using the diff of its changed
// dependencies plus the current text of each dependency symbol.
export async function verifyNote(store, note, { model } = {}) {
  const repo = store.repo;
  model = model || store.config().verifyModel || 'haiku';
  const changed = note.stale?.changed || [];
  const paths = [...new Set(changed.map(c => c.path))];
  const diff = gitDiffFor(repo, note.verifiedCommit, paths);
  const current = (note.deps || []).map(d => `--- ${d.path}${d.symbol ? ' :: ' + d.symbol : ''} ---\n${symbolText(repo, d, 120) ?? '(missing)'}`).join('\n\n');
  const system = 'You verify cached notes about a codebase after the code changed. Be strict: a note that is subtly wrong is worse than no note. Only answer still_valid when every concrete claim in the note (file paths, symbol names, call order, what must change together, commands) is still true given the current code shown. Answer update if the note is mostly right but some claim needs correction, and give the full corrected body (keep it as short as the original, keep file:symbol pointers). Answer invalid if the thing the note describes no longer exists or the approach changed fundamentally.';
  const prompt = `NOTE (kind=${note.kind}) "${note.title}"\n${note.body}\n\nDEPENDENCIES THAT CHANGED: ${changed.map(c => `${c.path}${c.symbol ? ':' + c.symbol : ''} (${c.reason})`).join(', ') || 'unknown'}\n\nGIT DIFF SINCE THE NOTE WAS VERIFIED (may be empty if changes are uncommitted):\n${diff || '(no diff available)'}\n\nCURRENT CODE OF EACH DEPENDENCY:\n${current.slice(0, 40000)}`;
  const res = await complete({ system, prompt, model, accounting: { store, purpose: 'verify' }, schema: VERIFY_SCHEMA });
  const v = res.json;
  const now = new Date().toISOString();
  let next;
  if (v.verdict === 'still_valid') {
    next = { ...note, deps: (note.deps || []).map(d => hashDep(repo, d)), status: 'fresh', verified: now, verifiedCommit: gitHead(repo), confidence: Math.min(1, (note.confidence ?? 0.7) + 0.05) };
    delete next.stale;
  } else if (v.verdict === 'update' && v.body && v.body.trim()) {
    next = { ...note, body: v.body.trim(), deps: (note.deps || []).map(d => hashDep(repo, d)), status: 'fresh', verified: now, verifiedCommit: gitHead(repo), confidence: Math.max(0.3, Math.min(1, Number(v.confidence) || note.confidence || 0.6)), history: [...(note.history || []), { at: now, reason: v.reason, prevBody: note.body }].slice(-5) };
    delete next.stale;
  } else {
    next = { ...note, status: 'invalid', invalidReason: v.reason, verified: now };
  }
  // drop deps whose files disappeared; count references again for the symbols that changed
  next.deps = (next.deps || []).filter(d => !d.missing);
  if (v.verdict !== 'invalid') { const ch = new Set(changed.map(c => `${c.path}|${c.symbol || ''}`)); next.deps = next.deps.map(d => ch.has(`${d.path}|${d.symbol || ''}`) ? annotateFanout(repo, [d], { max: 1 })[0] : d); }
  delete next.verifying;
  store.put(next);
  store.log({ op: 'verify', id: note.id, verdict: v.verdict, cost: res.cost, metered: true });
  return { note: next, verdict: v.verdict, reason: v.reason, cost: res.cost };
}

export function feedback(store, { id, useful, correction }) {
  const n = store.get(id);
  if (!n) return { error: 'no such note' };
  n.confidence = Math.max(0.05, Math.min(1, (n.confidence ?? 0.7) + (useful ? 0.05 : -0.2)));
  if (correction) { n.history = [...(n.history || []), { at: new Date().toISOString(), reason: 'agent correction', prevBody: n.body }].slice(-5); n.body = correction; n.verified = new Date().toISOString(); }
  if (!useful && n.confidence < 0.3) n.status = 'invalid', n.invalidReason = 'repeatedly reported wrong';
  store.put(n);
  store.log({ op: 'feedback', id, useful, corrected: !!correction });
  return { note: n };
}

export { renderNote, estTokens, Store };
