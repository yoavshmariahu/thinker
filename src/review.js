// Review of a change against the knowledge cache: which notes the change touches or bears on,
// whether it breaks what they state, and what the git history says should have changed with it.
//
// The cache is evidence, not truth. Every note consulted is first checked against the code as it
// was before the change (`staleBefore`), so drift of the cache is reported as drift and never as a
// fault of the change; the model that assesses a note is told to argue from the code shown and to
// say `note_outdated` when the note is what is wrong. Two findings need no model: a partner file
// the git history says changes along with a changed file and is not in the change, and a symbol
// the change removes that the rest of the checkout still refers to.
//
// Scopes: the working tree against HEAD (default), the index (`staged`), a branch against its
// base (`base`), a commit (`ref`), or no change at all (`state`: the current code of some files
// against the notes resting on them). Everything reads code through one reader for the scope, so
// a review of a commit never looks at the working tree.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { hashText, locateSymbol, repoFile, validDepPath } from './deps.js';
import { outlineText, references, countable } from './codegraph.js';
import { buildIndex, bm25, tokenize } from './rank.js';
import { loadCochange, partners } from './cochange.js';
import { complete } from './llm.js';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const CODE_EXT = /\.(py|pyi|js|jsx|mjs|cjs|ts|tsx|mts|cts|go|rs|rb|java|kt|cs|php|c|h|cc|cpp|hpp|swift|scala|ex|exs|sh|bash|vue|svelte|sql|dart|lua|zig)$/i;
const MAX_FILE = 200 * 1024;
// Raw output: file contents must come back byte for byte (a stripped final newline would change every hash).
const git = (repo, args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
const tryGit = (repo, args) => { try { return git(repo, args); } catch { return null; } };
const gitLine = (repo, args) => { const o = tryGit(repo, args); return o === null ? null : o.trim(); };
const resolve = (repo, ref) => git(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
const depKey = d => `${d.path}|${d.symbol || ''}`;
const ptr = d => `${d.path}${d.symbol ? ':' + d.symbol : ''}`;
const SEV = { error: 0, warning: 1, info: 2 };
// How much a note of each kind has to say about a change: rules and traps first, maps last.
const KIND_WEIGHT = { invariant: 1.3, convention: 1.3, gotcha: 1.3, cochange: 1.2, fix: 1.2, rationale: 1.1, callpath: 1, location: 0.8, howto: 0.7, overview: 0.6 };

// What is reviewed: {base: commit|null, head: 'worktree'|'index'|commit, label}. `base` is where the
// change starts; with a branch base it is the merge base, so the review covers the branch's work.
export function resolveScope(repo, { base, staged = false, ref, state = false } = {}) {
  if (state) return { base: null, head: 'worktree', label: 'current code', state: true };
  if (ref) {
    const head = resolve(repo, ref);
    const start = base ? gitLine(repo, ['merge-base', resolve(repo, base), head]) : gitLine(repo, ['rev-parse', '--verify', `${head}^`]);
    return { base: start || EMPTY_TREE, head, label: `commit ${head.slice(0, 10)}${base ? ` since ${base}` : ''}` };
  }
  const headCommit = gitLine(repo, ['rev-parse', '--verify', 'HEAD']);
  const start = base && headCommit ? gitLine(repo, ['merge-base', resolve(repo, base), headCommit]) : headCommit;
  return { base: start || EMPTY_TREE, head: staged ? 'index' : 'worktree', label: `${staged ? 'staged changes' : 'working tree'}${base ? ` since ${base}` : headCommit ? ' against HEAD' : ''}` };
}

// One way to read a file on either side of the change; null when it is not there.
export function makeReader(repo, scope) {
  const cache = new Map();
  const memo = (key, fn) => { if (!cache.has(key)) cache.set(key, fn()); return cache.get(key); };
  const show = spec => tryGit(repo, ['show', spec]);
  const work = p => { const abs = repoFile(repo, p); if (!abs) return null; try { return fs.statSync(abs).isFile() ? fs.readFileSync(abs, 'utf8') : null; } catch { return null; } };
  return {
    before: p => validDepPath(p) ? memo(`b:${p}`, () => scope.state ? work(p) : scope.base ? show(`${scope.base}:${p}`) : null) : null,
    after: p => validDepPath(p) ? memo(`a:${p}`, () => scope.head === 'worktree' ? work(p) : scope.head === 'index' ? show(`:${p}`) : show(`${scope.head}:${p}`)) : null,
  };
}

// A unified diff as [{path, oldPath, status, binary, hunks, touched, removedAt, added, removed}]; `touched`
// is the set of line numbers in the new file the change wrote, `removedAt` where in the new file
// lines were taken out (the line that now follows them).
export function parseDiff(text) {
  const files = []; let f = null, h = null, nl = 0;
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*?) b\/(.*)$/.exec(line);
      f = { path: m ? m[2] : '', oldPath: m ? m[1] : '', status: 'M', binary: false, hunks: [], touched: new Set(), removedAt: new Set(), added: 0, removed: 0 }; files.push(f); h = null; continue;
    }
    if (!f) continue;
    if (!h) {
      if (line.startsWith('new file mode')) f.status = 'A';
      else if (line.startsWith('deleted file mode')) f.status = 'D';
      else if (line.startsWith('rename from ')) { f.status = 'R'; f.oldPath = line.slice(12); }
      else if (line.startsWith('rename to ')) f.path = line.slice(10);
      else if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) f.binary = true;
      else if (line.startsWith('+++ b/')) f.path = line.slice(6);
      else if (line.startsWith('--- a/')) f.oldPath = line.slice(6);
    }
    if (line.startsWith('@@ ')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line); if (!m) continue;
      h = { oldStart: +m[1], oldLines: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newLines: m[4] === undefined ? 1 : +m[4], header: m[5].trim(), lines: [] };
      f.hunks.push(h); nl = h.newStart; continue;
    }
    if (!h) continue;
    if (line.startsWith('+')) { h.lines.push(line); f.touched.add(nl); f.added++; nl++; }
    else if (line.startsWith('-')) { h.lines.push(line); f.removedAt.add(nl); f.removed++; }
    else if (line.startsWith('\\')) h.lines.push(line);
    else { h.lines.push(line); nl++; }
  }
  return files.filter(f => f.path);
}

const renderHunks = f => f.hunks.map(h => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@ ${h.header}\n${h.lines.join('\n')}`).join('\n');
const renderFileDiff = f => `--- ${f.status === 'A' ? '/dev/null' : 'a/' + f.oldPath}\n+++ ${f.status === 'D' ? '/dev/null' : 'b/' + f.path}\n${renderHunks(f)}`;

// The change in the scope: the diff parsed, plus (working tree) untracked code files as additions.
// `.thinker/` is left out: notes changing is not code changing. `paths` narrows it.
export function collectChange(repo, scope, { paths = [] } = {}) {
  if (scope.state) return { files: [], text: '', paths };
  const pathspec = ['--', ...(paths.length ? paths : ['.']), ':(exclude).thinker'];
  const args = scope.head === 'worktree' ? [scope.base] : scope.head === 'index' ? ['--cached', scope.base] : [scope.base, scope.head];
  const text = tryGit(repo, ['diff', '--no-color', '-U3', '-M', '--no-ext-diff', ...args, ...pathspec]) || '';
  const files = parseDiff(text);
  if (scope.head === 'worktree') {
    const untracked = (tryGit(repo, ['ls-files', '--others', '--exclude-standard', '-z', ...pathspec]) || '').split('\0').filter(Boolean);
    for (const p of untracked) {
      if (!CODE_EXT.test(p) || files.some(f => f.path === p)) continue;
      const abs = repoFile(repo, p); if (!abs) continue;
      let body; try { if (fs.statSync(abs).size > MAX_FILE) continue; body = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      if (body.includes('\0')) continue;
      const lines = body.replace(/\n$/, '').split('\n');
      const f = { path: p, oldPath: p, status: 'A', binary: false, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, header: '', lines: lines.map(l => '+' + l) }], touched: new Set(lines.map((_, i) => i + 1)), removedAt: new Set(), added: lines.length, removed: 0, untracked: true };
      files.push(f);
    }
  }
  return { files, text: files.map(renderFileDiff).join('\n'), paths };
}

// The definitions a change touched and the ones it removed, per file: [{path, changed: [qualified
// names], removed: [{name, qualified, parent}]}]. Innermost definitions only (a method, not its class).
function rangeOf(text, def, file) {
  if (def.end) return { start: def.line, end: def.end };
  const loc = locateSymbol(text, def.parent ? `${def.parent}.${def.name}` : def.name, file);
  return loc ? { start: loc.start + 1, end: loc.end } : { start: def.line, end: def.line };
}
const qualified = d => d.parent ? `${d.parent}.${d.name}` : d.name;
export function changedSymbols(change, reader) {
  const out = [];
  for (const f of change.files) {
    if (f.binary || !CODE_EXT.test(f.path)) continue;
    const after = f.status === 'D' ? null : reader.after(f.path), before = f.status === 'A' ? null : reader.before(f.oldPath || f.path);
    const defsAfter = after ? outlineText(after, f.path, { limit: 400 }) || [] : [];
    const defsBefore = before ? outlineText(before, f.oldPath || f.path, { limit: 400 }) || [] : [];
    // a line written inside the definition, or lines taken out inside it: a deletion just before a
    // definition sits at its first line in the new file and is not a change of it
    const hit = defsAfter.map(d => ({ d, r: rangeOf(after, d, f.path) })).filter(({ r }) => { for (let l = r.start; l <= r.end; l++) if (f.touched.has(l) || (l > r.start && f.removedAt.has(l))) return true; return false; });
    const inner = hit.filter(({ d, r }) => !hit.some(o => o.d !== d && o.r.start >= r.start && o.r.end <= r.end && (o.r.start > r.start || o.r.end < r.end)));
    const namesAfter = new Set(defsAfter.map(qualified));
    const removed = defsBefore.filter(d => !namesAfter.has(qualified(d))).map(d => ({ name: d.name, qualified: qualified(d), parent: d.parent }));
    out.push({ path: f.path, changed: [...new Set(inner.map(({ d }) => qualified(d)))], removed });
  }
  return out;
}

// Where a note stands against the change: which of its deps the change altered (`touched`), which
// already differed from the note's record before it (`staleBefore`: drift of the cache, not a fault
// of the change), and which are gone after it.
export function noteExposure(note, change, reader) {
  const changed = new Set(change.files.flatMap(f => [f.path, f.oldPath]));
  const touched = [], staleBefore = [], missingAfter = [];
  for (const d of note.deps || []) {
    if (!validDepPath(d.path)) continue;
    const before = reader.before(d.path);
    const hB = before === null ? null : hashText(before, d);
    if (d.hash) {
      if (hB === null) staleBefore.push({ path: d.path, symbol: d.symbol, reason: 'file missing before the change' });
      else if (hB.symbolMissing && !d.symbolMissing) staleBefore.push({ path: d.path, symbol: d.symbol, reason: 'symbol not found before the change' });
      else if (hB.hash !== d.hash && !(d.engine === 'ast' && d.hashRegex === hB.hash) && !(hB.engine === 'ast' && hB.hashRegex === d.hash)) staleBefore.push({ path: d.path, symbol: d.symbol, reason: d.symbol && !hB.symbolMissing ? 'symbol body changed' : 'file changed' });
    }
    if (!changed.has(d.path)) continue;
    if (change.state) { touched.push({ ...d, reason: 'under audit' }); continue; }
    const after = reader.after(d.path);
    const hA = after === null ? null : hashText(after, d);
    if (hA === null) { touched.push({ ...d, reason: 'file removed' }); missingAfter.push({ path: d.path, symbol: d.symbol, reason: 'file removed' }); }
    else if (hA.symbolMissing && !(hB && hB.symbolMissing)) { touched.push({ ...d, reason: 'symbol not found' }); missingAfter.push({ path: d.path, symbol: d.symbol, reason: 'symbol not found' }); }
    else if (!hB || hA.hash !== hB.hash) touched.push({ ...d, reason: !hB ? 'file added' : d.symbol && !hA.symbolMissing ? 'symbol body changed' : 'file changed' });
  }
  return { touched, staleBefore, missingAfter };
}

// Identifiers the change writes, as a query over the notes: the paths, the definitions touched and
// the most frequent names in the added lines.
function changeQuery(change, symbols) {
  const freq = new Map();
  for (const f of change.files) for (const h of f.hunks) for (const l of h.lines) {
    if (!l.startsWith('+')) continue;
    const code = l.slice(1).replace(/\/\/.*$|#.*$/, '').replace(/(["'`])(?:\\.|(?!\1).)*\1/g, ' ');
    for (const m of code.matchAll(/[A-Za-z_][A-Za-z0-9_]{3,}/g)) freq.set(m[0], (freq.get(m[0]) || 0) + 1);
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([w]) => w);
  return [...change.files.map(f => f.path), ...symbols.flatMap(s => s.changed), ...top].join(' ');
}

// Notes to consult: `direct` rest on code the change altered; `related` share enough identifiers
// with it to have a say (a convention written against other files, say).
export function selectNotes(notes, change, reader, { relatedMax = 6 } = {}) {
  const live = notes.filter(n => n.status !== 'invalid');
  const symbols = changedSymbols(change, reader);
  const direct = [], exposures = new Map();
  for (const n of live) {
    const e = noteExposure(n, change, reader);
    exposures.set(n.id, e);
    if (e.touched.length) direct.push(n);
  }
  const weight = n => (KIND_WEIGHT[n.kind] || 1) * (0.5 + 0.5 * (n.confidence ?? 0.7));
  direct.sort((a, b) => weight(b) - weight(a));
  let related = [];
  if (!change.state && change.files.length) {
    const idx = buildIndex(live);
    const qtoks = tokenize(changeQuery(change, symbols));
    const Q = bm25(idx.q, qtoks), B = bm25(idx.b, qtoks);
    const maxQ = Math.max(1e-9, ...Q.scores.values()), maxB = Math.max(1e-9, ...B.scores.values());
    const taken = new Set(direct.map(n => n.id));
    related = live.filter(n => !taken.has(n.id) && ((Q.matched.get(n.id) || 0) >= 2 || (B.matched.get(n.id) || 0) >= 3))
      .map(n => ({ n, s: (0.6 * (Q.scores.get(n.id) || 0) / maxQ + 0.4 * (B.scores.get(n.id) || 0) / maxB) * weight(n) }))
      .sort((a, b) => b.s - a.s).slice(0, relatedMax).map(x => x.n);
  }
  return { direct, related, exposures, symbols };
}

// Findings that need no model. From git history: a file that usually changes with a changed file
// and is not in the change. From the checkout: a definition the change removed that is still
// referred to (working tree and index only; a commit's references cannot be grepped).
export function deterministicFindings(repo, change, symbols, reader, { cochange = loadCochange(repo), minConf = 0.5, minSupport = 3 } = {}) {
  const findings = [];
  if (change.state) return findings;
  const changed = new Set(change.files.flatMap(f => [f.path, f.oldPath]));
  for (const f of change.files) {
    if (f.status === 'D') continue;
    for (const p of partners(cochange, f.path, { minSupport, minConf, limit: 6 })) {
      if (changed.has(p.file) || reader.after(p.file) === null) continue;
      findings.push({ severity: p.conf >= 0.75 ? 'warning' : 'info', category: 'cochange', file: f.path, line: 0, message: `${p.file} changed together with ${f.path} in ${Math.round(p.conf * 100)}% of its commits (n=${p.support}) and is not in this change`, basis: 'git history' });
    }
  }
  if (change.head !== 'commit') {
    for (const s of symbols) for (const r of s.removed) {
      if (!countable(r.name)) continue;
      const refs = references(repo, r.name, { file: s.path, limit: 2000 });
      if (!refs || refs.lines.some(l => l.def)) continue; // defined elsewhere now (moved or renamed with its uses)
      const sites = refs.lines.filter(l => !l.def);
      if (!sites.length) continue;
      const shown = sites.slice(0, 5).map(l => `${l.path}:${l.line}`).join(', ');
      findings.push({ severity: r.parent ? 'warning' : 'error', category: 'broken-reference', file: sites[0].path, line: sites[0].line, message: `${r.qualified} was removed from ${s.path} and is no longer defined anywhere, but is still referenced at ${shown}${sites.length > 5 ? ` (+${sites.length - 5} more)` : ''}`, basis: r.parent ? 'git grep by name; a method of the same name elsewhere would match too' : 'git grep' });
    }
  }
  return findings;
}

const ASSESS_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['violation', 'note_outdated', 'consistent', 'unrelated'] },
    reason: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['error', 'warning', 'info'] },
          file: { type: 'string' },
          line: { type: 'integer', description: 'line in the file after the change; 0 when unknown' },
          message: { type: 'string' },
          evidence: { type: 'string', description: 'the lines of code or diff that show it' },
          confidence: { type: 'number' },
        },
        required: ['severity', 'file', 'line', 'message', 'evidence', 'confidence'],
      },
    },
    noteCorrection: { type: 'string', description: 'when note_outdated: the corrected note body; else empty' },
  },
  required: ['verdict', 'reason', 'findings', 'noteCorrection'],
};

const SYSTEM = `You review a code change against one note from a cache of knowledge about the repository. The note was written earlier, possibly before other changes, and may itself be out of date: the code is the ground truth and the note is a claim about it that you must check.

Give one verdict:
- violation: the change breaks or contradicts something the note states (an invariant, a convention, an ordering, a co-change rule, a trap), and the code shown still supports the note's claim. Report each such problem as a finding with the file and line after the change and quote the evidence.
- note_outdated: the code, before or after the change, disagrees with the note in a way that makes the note wrong, so the change is not at fault. Give a corrected body.
- consistent: the change respects what the note says.
- unrelated: the note has nothing to say about this change.

Also report a bug you can see in the changed code shown (a wrong call order, a missing update the note says must accompany this one, a name that no longer exists), but only when the evidence is in the code or diff shown, never inferred from the note alone. Give each finding a confidence between 0 and 1 and quote the evidence. Prefer no finding over a speculative one; a reviewer who cries wolf is ignored.`;

const STATE_SYSTEM = SYSTEM.replace('You review a code change against one note', 'You audit the current code against one note');

function codeOf(text, d, maxLines = 120) {
  if (text === null) return '(missing)';
  const lines = text.split('\n');
  if (!d.symbol) return lines.slice(0, maxLines).join('\n').slice(0, 6000);
  const loc = locateSymbol(text, d.symbol, d.path);
  if (!loc) return `(symbol ${d.symbol} not found; head of file)\n` + lines.slice(0, 40).join('\n').slice(0, 3000);
  return `(lines ${loc.start + 1}-${Math.min(loc.end, loc.start + maxLines)})\n` + lines.slice(loc.start, Math.min(loc.end, loc.start + maxLines)).join('\n').slice(0, 6000);
}

// One note against the change: the note with how the cache stands on it, the diff of the files it
// rests on (the whole change for a related note), and the code after the change behind each dep.
export async function assessNote(store, note, exposure, change, reader, { model, related = false } = {}) {
  const depPaths = new Set((note.deps || []).map(d => d.path));
  const own = change.files.filter(f => depPaths.has(f.path) || depPaths.has(f.oldPath));
  const diff = (related || !own.length ? change.text : own.map(renderFileDiff).join('\n')).slice(0, 14000);
  const code = (note.deps || []).slice(0, 8).map(d => `--- ${ptr(d)} ---\n${codeOf(reader.after(d.path), d)}`).join('\n\n').slice(0, 36000);
  const state = [
    exposure.staleBefore.length ? `Already differing from the note's record BEFORE this change (the note may be out of date): ${exposure.staleBefore.map(c => `${ptr(c)} (${c.reason})`).join(', ')}` : 'Every dependency matched the note\'s record before this change.',
    exposure.touched.length ? `Altered BY this change: ${exposure.touched.map(c => `${ptr(c)} (${c.reason})`).join(', ')}` : 'The change alters none of the note\'s dependencies; it was selected because it shares identifiers with the note.',
    note.verified ? `Last verified ${String(note.verified).slice(0, 10)}${note.verifiedCommit ? ` at commit ${String(note.verifiedCommit).slice(0, 10)}` : ''}.` : 'Never verified.',
  ].join('\n');
  const prompt = change.state
    ? `NOTE ${note.id} (kind=${note.kind}, confidence ${Math.round((note.confidence ?? 0.7) * 100)}%)\n"${note.title}"\n${note.body}${note.applies ? `\nApplies: ${note.applies}` : ''}\n\nCACHE STATE:\n${state}\n\nThere is no change under review: audit the current code against the note. A violation is code that contradicts an invariant or convention the note states and that the rest of the code shown still supports.\n\nCURRENT CODE OF EACH DEPENDENCY:\n${code}`
    : `NOTE ${note.id} (kind=${note.kind}, confidence ${Math.round((note.confidence ?? 0.7) * 100)}%)\n"${note.title}"\n${note.body}${note.applies ? `\nApplies: ${note.applies}` : ''}\n\nCACHE STATE:\n${state}\n\nTHE CHANGE (${related || !own.length ? 'whole diff' : 'diff of the files the note rests on'}):\n${diff || '(empty)'}\n\nCODE AFTER THE CHANGE, FOR EACH DEPENDENCY:\n${code}`;
  const res = await complete({ system: change.state ? STATE_SYSTEM : SYSTEM, prompt, model, maxTokens: 3000, accounting: { store, purpose: 'review', phase: 'review' }, schema: ASSESS_SCHEMA });
  const v = res.json || {};
  const findings = (Array.isArray(v.findings) ? v.findings : []).filter(f => f && typeof f.message === 'string' && (Number(f.confidence) || 0) >= 0.5).map(f => {
    const file = change.files.find(x => x.path === f.file || x.path.endsWith('/' + f.file))?.path || (reader.after(f.file) !== null ? f.file : '');
    const line = Math.max(0, Math.floor(Number(f.line) || 0));
    return { severity: SEV[f.severity] !== undefined ? f.severity : 'warning', category: v.verdict === 'violation' ? 'violation' : 'bug', file, line, message: f.message.trim(), evidence: String(f.evidence || '').trim().slice(0, 600), confidence: Math.min(1, Number(f.confidence) || 0), note: note.id, inChange: !!(file && change.files.find(x => x.path === file)?.touched.has(line)) };
  });
  return { id: note.id, verdict: v.verdict || 'unrelated', reason: String(v.reason || '').trim(), findings, noteCorrection: v.verdict === 'note_outdated' ? String(v.noteCorrection || '').trim() : '', cost: res.cost || 0 };
}

// The review. `assess` is the model step (injected by tests). Returns the report as data; render()
// prints it. Nothing in the cache is rewritten: a note the review finds outdated is reported for
// `thinker verify`, since the change under review may never be merged.
export async function review(store, { scope, paths = [], max = 12, model, dry = false, concurrency = 4, assess = assessNote, cochange } = {}) {
  const repo = store.repo;
  scope = scope || resolveScope(repo);
  const reader = makeReader(repo, scope);
  const change = collectChange(repo, scope, { paths });
  change.state = !!scope.state; change.head = scope.head === 'worktree' || scope.head === 'index' ? scope.head : 'commit';
  const notes = store.list();
  const report = { scope: scope.label, state: !!scope.state, files: change.files.map(f => ({ path: f.path, status: f.status, added: f.added, removed: f.removed })), notes: { consulted: 0, direct: 0, related: 0, assessed: 0, staleBefore: [], outdated: [], uncovered: [] }, verdicts: [], findings: [], cost: 0, model: model || store.config().reviewModel || 'sonnet', errors: [] };
  if (scope.state) {
    // the current code of the given files (every file the notes rest on when none is named)
    const pathSet = new Set(paths.map(p => p.replace(/^\.\//, '')));
    change.files = [...new Set(notes.filter(n => n.status !== 'invalid').flatMap(n => (n.deps || []).map(d => d.path)))].filter(p => !pathSet.size || pathSet.has(p) || [...pathSet].some(dir => p.startsWith(dir.replace(/\/$/, '') + '/'))).filter(p => reader.after(p) !== null).map(p => ({ path: p, oldPath: p, status: 'M', binary: false, hunks: [], touched: new Set(), removedAt: new Set(), added: 0, removed: 0 }));
    report.files = change.files.map(f => ({ path: f.path, status: 'state' }));
  }
  if (!change.files.length) { report.empty = true; return report; }
  const { direct, related, exposures, symbols } = selectNotes(notes, change, reader);
  report.symbols = symbols.filter(s => s.changed.length || s.removed.length).map(s => ({ path: s.path, changed: s.changed, removed: s.removed.map(r => r.qualified) }));
  report.findings.push(...deterministicFindings(repo, change, symbols, reader, cochange ? { cochange } : {}));
  const consulted = [...direct, ...related];
  report.notes.consulted = consulted.length; report.notes.direct = direct.length; report.notes.related = related.length;
  for (const n of consulted) { const e = exposures.get(n.id); if (e.staleBefore.length) report.notes.staleBefore.push({ id: n.id, title: n.title, changed: e.staleBefore }); }
  const covered = new Set(direct.flatMap(n => (n.deps || []).map(d => d.path)));
  report.notes.uncovered = change.files.filter(f => f.status !== 'D' && CODE_EXT.test(f.path) && !covered.has(f.path)).map(f => f.path);
  const queue = consulted.slice(0, max);
  report.notes.assessed = dry ? 0 : queue.length;
  report.notes.skipped = consulted.length - queue.length;
  report.toAssess = queue.map(n => ({ id: n.id, title: n.title, kind: n.kind, why: direct.includes(n) ? exposures.get(n.id).touched.map(ptr).join(', ') : 'shares identifiers with the change' }));
  if (!dry) {
    const results = [];
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => {
      while (queue.length) {
        const n = queue.shift();
        try { results.push(await assess(store, n, exposures.get(n.id), change, reader, { model: report.model, related: related.includes(n) })); }
        catch (e) { report.errors.push({ id: n.id, error: String(e.message || e).slice(0, 200) }); }
      }
    }));
    for (const r of results) {
      report.cost += r.cost || 0;
      report.verdicts.push({ id: r.id, verdict: r.verdict, reason: r.reason });
      report.findings.push(...r.findings);
      if (r.verdict === 'note_outdated') report.notes.outdated.push({ id: r.id, reason: r.reason, correction: r.noteCorrection });
    }
  }
  report.findings.sort((a, b) => (SEV[a.severity] ?? 1) - (SEV[b.severity] ?? 1) || (b.confidence || 1) - (a.confidence || 1));
  report.counts = { error: report.findings.filter(f => f.severity === 'error').length, warning: report.findings.filter(f => f.severity === 'warning').length, info: report.findings.filter(f => f.severity === 'info').length };
  store.log({ op: 'review', scope: scope.label, files: change.files.length, consulted: consulted.length, assessed: report.notes.assessed, findings: report.counts, outdated: report.notes.outdated.map(o => o.id), cost: report.cost, metered: true, dry: dry || undefined });
  return report;
}

export function renderReview(r, { verbose = false } = {}) {
  const L = [];
  if (r.empty) return `thinker review: nothing to review (${r.scope})`;
  const n = r.notes;
  L.push(`thinker review: ${r.scope}, ${r.files.length} file${r.files.length === 1 ? '' : 's'}; ${n.consulted} note${n.consulted === 1 ? '' : 's'} consulted (${n.direct} on the changed code, ${n.related} related)${r.toAssess?.length && !n.assessed ? `, ${r.toAssess.length} to assess` : n.assessed ? `, ${n.assessed} assessed with ${r.model}${r.cost ? ` ($${r.cost.toFixed(2)})` : ''}` : ''}${n.skipped ? `, ${n.skipped} left out (--max)` : ''}`);
  if (r.findings.length) {
    L.push('', `Findings: ${r.counts.error} error${r.counts.error === 1 ? '' : 's'}, ${r.counts.warning} warning${r.counts.warning === 1 ? '' : 's'}, ${r.counts.info} info`);
    for (const f of r.findings) {
      const where = f.file ? `${f.file}${f.line ? ':' + f.line : ''}` : '(no file)';
      L.push(`  ${f.severity.padEnd(8)} ${where}  ${f.message}${f.note ? `  [note ${f.note}${f.confidence ? `, ${Math.round(f.confidence * 100)}%` : ''}]` : f.basis ? `  [${f.basis}]` : ''}`);
      if (f.evidence) L.push(`           evidence: ${f.evidence.split('\n').map(s => s.trim()).filter(Boolean).join(' | ').slice(0, 300)}`);
    }
  } else L.push('', n.assessed || r.toAssess?.length === 0 ? 'No findings.' : 'No findings without the model (dry run).');
  const cache = [];
  if (n.staleBefore.length) cache.push(`${n.staleBefore.length} consulted note${n.staleBefore.length === 1 ? ' was' : 's were'} already stale before this change (their claims were weighed accordingly): ${n.staleBefore.map(s => `${s.id} (${s.changed.map(c => `${ptr(c)}: ${c.reason}`).join('; ')})`).join('; ')}`);
  if (n.outdated.length) cache.push(`${n.outdated.length} note${n.outdated.length === 1 ? '' : 's'} the review found outdated: ${n.outdated.map(o => `${o.id} (${o.reason})`).join('; ')}`);
  const fix = [...new Set([...n.staleBefore.map(s => s.id), ...n.outdated.map(o => o.id)])];
  if (fix.length) cache.push(`re-check them: thinker verify ${fix.join(' ')}`);
  if (n.uncovered.length) cache.push(`no cached knowledge rests on: ${n.uncovered.slice(0, 8).join(', ')}${n.uncovered.length > 8 ? ` (+${n.uncovered.length - 8} more)` : ''}; the review is blind there beyond git history`);
  if (r.errors.length) cache.push(`${r.errors.length} note${r.errors.length === 1 ? '' : 's'} could not be assessed: ${r.errors.map(e => `${e.id} (${e.error})`).join('; ')}`);
  if (cache.length) { L.push('', 'Cache state:'); for (const c of cache) L.push(`  - ${c}`); }
  if (verbose || !n.assessed) {
    if (r.toAssess?.length && !n.assessed) { L.push('', 'Notes to assess:'); for (const t of r.toAssess) L.push(`  - [${t.kind}] ${t.title} (${t.id}): ${t.why}`); }
    if (r.verdicts.length) { L.push('', 'Verdicts:'); for (const v of r.verdicts) L.push(`  ${v.verdict.padEnd(14)} ${v.id}: ${v.reason}`); }
  }
  return L.join('\n');
}
