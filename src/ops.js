// Core operations shared by the MCP server and the CLI.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { Store, slugify, uniqueId, gitHead, KINDS } from './store.js';
import { hashDep, checkNote, symbolText } from './deps.js';
import { rank, pack, renderNote, estTokens } from './rank.js';
import { complete } from './llm.js';
import { loadCochange, renderCochange } from './cochange.js';
import { anchoringGuard } from './guard.js';

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
    if (!p || !fs.existsSync(path.join(repo, p)) || fs.statSync(path.join(repo, p)).isDirectory()) { dropped.push({ ...d, reason: 'no such file' }); continue; }
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

export function createNote(store, input, { source = { type: 'agent' } } = {}) {
  const repo = store.repo;
  const extra = extractDeps(repo, String(input.body || ''), input.deps || []);
  const { deps, dropped } = resolveDeps(repo, [...(input.deps || []), ...extra]);
  if (!deps.length) return { error: 'no resolvable dependencies; a note must point at at least one existing file', dropped };
  const kind = KINDS.includes(input.kind) ? input.kind : 'location';
  const id = input.id && !store.get(input.id) ? slugify(input.id) : uniqueId(store, slugify(input.title));
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
    const { changed } = checkNote(store.repo, n);
    const wasStale = n.status === 'stale';
    if (changed.length) {
      const stale = { since: n.stale?.since || new Date().toISOString(), changed };
      const next = { ...n, status: 'stale', stale };
      if (persist && (!wasStale || JSON.stringify(n.stale?.changed) !== JSON.stringify(changed))) store.put(next);
      return next;
    }
    if (wasStale) { const next = { ...n, status: 'fresh' }; delete next.stale; if (persist) store.put(next); return next; }
    return n;
  });
}

// THINKER_NAIVE=1 disables invalidation entirely (notes are served as written,
// never re-hashed or flagged). Only for benchmarking what a naive cache does.
const NAIVE = process.env.THINKER_NAIVE === '1';

const RERANK_SCHEMA = { type: 'object', properties: { useful: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } }, required: ['useful', 'reason'] };

// Ask a small model which candidate notes would actually save work on this
// task. Returns the subset of ranked entries it picked (order preserved).
async function rerank(ranked, task, file, model) {
  const cands = ranked.slice(0, 6);
  if (cands.length <= 1) return cands;
  const list = cands.map((r, i) => `[${i + 1}] id=${r.note.id} kind=${r.note.kind}\n    title: ${r.note.title}\n    answers: ${(r.note.answers || []).join(' | ')}\n    body: ${r.note.body.slice(0, 350).replace(/\n/g, ' ')}`).join('\n');
  const res = await complete({ model, schema: RERANK_SCHEMA, maxTokens: 300,
    system: 'You gate which cached notes about a codebase get injected into a coding agent\'s context at the start of a task. Injecting an irrelevant note costs tokens and misdirects the agent; injecting a relevant one saves it from re-exploring. Pick only notes whose content directly bears on what the task must touch or understand. Prefer one precise note over several loosely related ones. Picking none is correct when nothing applies.',
    prompt: `TASK: ${task}${file ? `\nCURRENT FILE: ${file}` : ''}\n\nCANDIDATE NOTES:\n${list}\n\nReturn the ids of the notes worth injecting (0-3).` });
  const pick = new Set((res.json?.useful || []).map(x => String(x).replace(/^\[?(\d+)\]?$/, (_, i) => cands[Number(i) - 1]?.note.id || x).replace(/^id=/, '')));
  if (process.env.THINKER_DEBUG) console.error('rerank:', JSON.stringify(res.json));
  return cands.filter(r => pick.has(r.note.id));
}

export async function orient(store, { task, file, session, budget = 1000, maxNotes = 3, refreshFirst = !NAIVE, rerankModel = store.config().rerank || process.env.THINKER_RERANK }) {
  let notes = store.list();
  if (NAIVE) notes = notes.map(n => { const c = { ...n, status: 'fresh' }; delete c.stale; return c; });
  if (refreshFirst) notes = refresh(store, notes);
  let ranked = rank(notes, { query: task, file: normPath(store.repo, file), mode: 'orient' });
  if (process.env.THINKER_FORCE === '1') ranked = rank(notes, { query: '', mode: 'orient' }).map(r => ({ ...r, rel: 1 })); // control arm: inject regardless of relevance
  else if (rerankModel && ranked.length) { try { ranked = await rerank(ranked, task, file, rerankModel); } catch (e) { store.log({ op: 'rerank-error', error: String(e.message) }); } }
  let top = ranked.slice(0, maxNotes);
  // cross-note links: pull in one note linked from the best hit when it has
  // at least some lexical relevance of its own and is not already selected
  if (top.length && process.env.THINKER_NO_LINKS !== '1') {
    const rel = ranked.filter(r => (top[0].note.related || []).includes(r.note.id) && !top.includes(r) && r.rel >= 0.15)[0];
    if (rel) top = [...top.slice(0, maxNotes - 1), rel];
  }
  const packed = pack(top, budget, { minRel: 0.35 });
  for (const n of packed.included) { n.uses = (n.uses || 0) + 1; n.lastUsed = new Date().toISOString(); if (session) n.servedIn = [...(n.servedIn || []), session].slice(-30); store.put(n); }
  if (!NAIVE) scheduleVerify(store, packed.included.filter(n => n.status === 'stale'));
  // co-change edges for the files the served notes (and the current file) point at
  const cc = process.env.THINKER_NO_COCHANGE === '1' ? null : loadCochange(store.repo);
  if (cc && packed.included.length) {
    const files = [...new Set([file, ...packed.included.flatMap(n => (n.deps || []).map(d => d.path))].filter(Boolean))].slice(0, 6);
    const block = renderCochange(cc, files);
    if (block) { packed.text += '\n\n' + block; packed.tokens += estTokens(block); packed.cochange = true; }
  }
  // anchoring guard: name what the request mentions that the notes do not cover
  if (packed.included.length && process.env.THINKER_NO_GUARD !== '1') {
    try { const g = anchoringGuard(store.repo, String(task), packed.included); if (g.text) { packed.text += '\n\n' + g.text; packed.tokens += estTokens(g.text); packed.uncovered = g.uncovered.map(u => u.ident); } } catch {}
  }
  store.log({ op: 'orient', session, task: String(task).slice(0, 200), file, served: packed.included.map(n => n.id), uncovered: packed.uncovered, stale: packed.included.filter(n => n.status === 'stale').map(n => n.id) });
  return packed;
}

// --- implicit feedback ---------------------------------------------------
// Apply the distiller's assessment of notes that were injected into a session.
// confirmed: the trace shows the agent used the pointer and nothing contradicted it.
// contradicted: the trace shows a claim was wrong; body is replaced by the correction.
// unused: served but not acted on; repeated unused servings decay confidence.
export function attest(store, assessments, { session } = {}) {
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
      // served ≥5 times with nothing ever confirming it: slow decay towards 0.4
      if ((n.attest.confirmed || 0) === 0 && n.attest.unused >= 5) n.confidence = Math.max(0.4, (n.confidence ?? 0.7) - 0.03);
    }
    store.put(n);
    applied.push({ id: n.id, verdict: a.verdict, confidence: n.confidence });
  }
  if (applied.length) store.log({ op: 'attest', session, applied });
  return applied;
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

export function lookup(store, { query, budget = 2500 }) {
  const notes = NAIVE ? store.list().map(n => { const c = { ...n, status: 'fresh' }; delete c.stale; return c; }) : refresh(store, store.list());
  const ranked = rank(notes, { query, mode: 'lookup' });
  const packed = pack(ranked, budget, { minRel: 0.15 });
  store.log({ op: 'lookup', query: String(query).slice(0, 200), served: packed.included.map(n => n.id) });
  return packed;
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
  const res = await complete({ system, prompt, model, schema: VERIFY_SCHEMA });
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
  // drop deps whose files disappeared
  next.deps = (next.deps || []).filter(d => !d.missing);
  delete next.verifying;
  store.put(next);
  store.log({ op: 'verify', id: note.id, verdict: v.verdict, cost: res.cost });
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
