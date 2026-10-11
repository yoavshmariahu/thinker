import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { hashText, locateSymbol, repoFile, validDepPath, noteTerms, symbolBlock } from './deps.js';
import { outlineText, references, countable, findDefinitions } from './codegraph.js';
import { buildIndex, bm25, tokenize, stem } from './rank.js';

// A change and the code around it, with no model call: the scope (working tree, index, a branch
// against its base, one commit), the parsed diff, readers for the before and after of a file, the
// definitions the hunks touched, which notes rest on them (noteExposure, selectNotes), what the changed
// definitions use one hop down (usedContext), and renderings of the change for a prompt. These were the
// model-free half of `thinker review`, kept for the diff-keyed serving of notes and for a review built
// around the user's own coding agent; the review command itself was removed on 2026-10-11.

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
const KIND_WEIGHT = { behavior: 1.4, rule: 1.3, map: 0.9, howto: 0.7 };

// What is reviewed: {base: commit|null, head: 'worktree'|'index'|commit, label}. `base` is where the
// change starts; with a branch base it is the merge base, so the review covers the branch's work.
export function resolveScope(repo, { base, staged = false, ref, state = false } = {}) {
  if (state) return { base: null, head: 'worktree', label: 'current code', state: true };
  if (ref) {
    const head = resolve(repo, ref);
    const start = base ? gitLine(repo, ['merge-base', resolve(repo, base), head]) : gitLine(repo, ['rev-parse', '--verify', `${head}^`]);
    return { base: start || EMPTY_TREE, head, label: `commit ${head.slice(0, 10)}${base ? ` since ${/^[a-f0-9]{40}$/.test(base) ? base.slice(0, 10) : base}` : ''}` };
  }
  const headCommit = gitLine(repo, ['rev-parse', '--verify', 'HEAD']);
  const start = base && headCommit ? gitLine(repo, ['merge-base', resolve(repo, base), headCommit]) : headCommit;
  return { base: start || EMPTY_TREE, head: staged ? 'index' : 'worktree', label: `${staged ? 'staged changes' : 'working tree'}${base ? ` since ${base}` : headCommit ? ' against HEAD' : ''}` };
}

// Whether the change edits a note's own file (`.thinker/` is never part of the reviewed change): a
// mutable behavior is revised only by a change that also rewrites its note.
export function noteFileChanged(repo, scope, id) {
  if (scope.state) return false;
  const file = `.thinker/notes/${id}.json`;
  const inBase = scope.base && scope.base !== EMPTY_TREE && tryGit(repo, ['cat-file', '-e', `${scope.base}:${file}`]) !== null;
  if (scope.head === 'worktree') {
    const abs = repoFile(repo, file); let onDisk = false; try { onDisk = !!abs && fs.statSync(abs).isFile(); } catch {}
    if (!onDisk) return false;
    if (!inBase) return true;
    return !!gitLine(repo, ['diff', '--name-only', scope.base, '--', file]);
  }
  if (scope.head === 'index') {
    if (!inBase) return tryGit(repo, ['cat-file', '-e', `:${file}`]) !== null;
    return !!gitLine(repo, ['diff', '--name-only', '--cached', scope.base, '--', file]);
  }
  if (!inBase) return tryGit(repo, ['cat-file', '-e', `${scope.head}:${file}`]) !== null;
  return !!gitLine(repo, ['diff', '--name-only', scope.base, scope.head, '--', file]);
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
// Notes are left out; the verification contract is included because it defines the gate.
export function collectChange(repo, scope, { paths = [] } = {}) {
  if (scope.state) return { files: [], text: '', paths };
  const pathspec = ['--', ...(paths.length ? paths : ['.']), ':(exclude).thinker'];
  const args = scope.head === 'worktree' ? [scope.base] : scope.head === 'index' ? ['--cached', scope.base] : [scope.base, scope.head];
  const contract = '.thinker/verification.json';
  const includeContract = !paths.length || paths.some(p => contract === p || contract.startsWith(p.replace(/\/$/, '') + '/'));
  const diffArgs = ['diff', '--no-color', '-U3', '-M', '--no-ext-diff', '--no-textconv', ...args];
  const text = (tryGit(repo, [...diffArgs, ...pathspec]) || '') + (includeContract ? (tryGit(repo, [...diffArgs, '--', contract]) || '') : '');
  const files = parseDiff(text);
  if (scope.head === 'worktree') {
    const untracked = ((tryGit(repo, ['ls-files', '--others', '--exclude-standard', '-z', ...pathspec]) || '') + (includeContract ? (tryGit(repo, ['ls-files', '--others', '--exclude-standard', '-z', '--', contract]) || '') : '')).split('\0').filter(Boolean);
    for (const p of untracked) {
      if ((!CODE_EXT.test(p) && p !== contract && !/^\.github\/workflows\//.test(p)) || files.some(f => f.path === p)) continue;
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

// How much of the change fell inside the definitions a note rests on, and whether those lines name
// what the note names: the changed lines inside each touched symbol (added lines by the new text's
// range, removed lines by the old text's), and a term of the note among them (terms that a sixth
// of the cache's notes share are not counted). A note on a hub definition (`cli.js:main`) is
// `touched` by nearly every commit; on the last ten commits here 30 to 60 notes were, and with a
// dozen consulted per review the ones about the change must come first.
function specificity(note, exposure, change, reader, common) {
  const terms = new Set([...noteTerms(note)].filter(t => !common.has(t)));
  let lines = 0, term = false;
  for (const d of exposure.touched) {
    if (!d.symbol) continue;
    const f = change.files.find(f => f.path === d.path || f.oldPath === d.path);
    if (!f) continue;
    const after = reader.after(f.path), before = reader.before(f.oldPath || f.path);
    const rA = after ? locateSymbol(after, d.symbol, f.path) : null, rB = before ? locateSymbol(before, d.symbol, f.oldPath || f.path) : null;
    for (const h of f.hunks) {
      let ln = h.newStart, lo = h.oldStart;
      for (const l of h.lines) {
        const inside = l.startsWith('+') ? rA && ln >= rA.start && ln <= rA.end : l.startsWith('-') ? rB && lo >= rB.start && lo <= rB.end : false;
        if (inside) { lines++; if (!term) for (const w of l.toLowerCase().match(/[a-z_][a-z0-9_]{3,}/g) || []) if (terms.has(stem(w))) { term = true; break; } }
        if (!l.startsWith('-')) ln++;
        if (!l.startsWith('+')) lo++;
      }
    }
  }
  return { lines, term };
}
export function commonTerms(notes, share = 1 / 6) {
  const df = new Map();
  for (const n of notes) for (const t of noteTerms(n)) df.set(t, (df.get(t) || 0) + 1);
  return new Set([...df].filter(([, c]) => c >= 3 && c / Math.max(1, notes.length) > share).map(([t]) => t)); // in a small cache no term is common
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
  // a note whose symbol-level dep the change altered speaks to it; one that rests on a whole file
  // the change touched somewhere is a weaker lead, and goes after the related notes
  const strong = n => exposures.get(n.id).touched.some(d => d.symbol || d.reason === 'file removed' || d.reason === 'file added');
  // among the strong ones: first those whose touched definitions took lines naming what the note
  // names, then by how many lines of the change fell inside them, then by kind and confidence
  const common = commonTerms(live);
  for (const n of direct) if (strong(n) && !change.state) exposures.get(n.id).specific = specificity(n, exposures.get(n.id), change, reader, common);
  const spec = n => exposures.get(n.id).specific || { lines: 0, term: false };
  direct.sort((a, b) => Number(strong(b)) - Number(strong(a)) || Number(spec(b).term) - Number(spec(a).term) || spec(b).lines - spec(a).lines || weight(b) - weight(a));
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
  const order = orderConsulted(direct, related, strong);
  return { direct, related, exposures, symbols, order, strong };
}

// A strong direct note first, then the related ones, then the direct notes resting on a whole file.
export const orderConsulted = (direct, related, strong) =>
  [...direct.filter(strong), ...related, ...direct.filter(n => !strong(n))];


// The finding that needs no model: a definition the change removed that is still referred to
// (working tree and index only; a commit's references cannot be grepped).
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function deterministicFindings(repo, change, symbols, reader) {
  const findings = [];
  if (change.state) return findings;
  if (change.head !== 'commit') {
    for (const s of symbols) for (const r of s.removed) {
      if (!countable(r.name)) continue;
      const refs = references(repo, r.name, { file: s.path, limit: 2000 });
      if (!refs || refs.lines.some(l => l.def)) continue; // defined elsewhere now (moved or renamed with its uses)
      // a top-level definition is not referenced by a property of the same name (`items.push(x)` for a removed `push`)
      const bare = new RegExp(`(?<![.\\w$])${esc(r.name)}(?![\\w$])`);
      const sites = refs.lines.filter(l => !l.def && (r.parent || bare.test(l.text)));
      if (!sites.length) continue;
      const shown = sites.slice(0, 5).map(l => `${l.path}:${l.line}`).join(', ');
      findings.push({ severity: r.parent ? 'warning' : 'error', category: 'broken-reference', file: sites[0].path, line: sites[0].line, message: `${r.qualified} was removed from ${s.path} and is no longer defined anywhere, but is still referenced at ${shown}${sites.length > 5 ? ` (+${sites.length - 5} more)` : ''}`, basis: r.parent ? 'git grep by name; a method of the same name elsewhere would match too' : 'git grep' });
    }
  }
  return findings;
}

// One hop of callers of the definitions the change touched, by text search over the checkout
// (so never for a commit scope): "path:line: text" lines, at most `perSymbol` for each.
export function callersContext(repo, symbols, change, { perSymbol = 8, maxSymbols = 6 } = {}) {
  if (change.head === 'commit') return '';
  const out = [];
  for (const s of symbols) for (const q of s.changed.slice(0, maxSymbols)) {
    const name = q.split('.').pop();
    if (!countable(name)) continue;
    const r = references(repo, name, { file: s.path, limit: 200 });
    if (!r) continue;
    const lines = r.lines.filter(l => !l.def && !l.import && !(l.path === s.path && change.files.find(f => f.path === s.path)?.touched.has(l.line))).slice(0, perSymbol);
    if (lines.length) out.push(`${s.path}:${q} is called from:
${lines.map(l => `  ${l.path}:${l.line}: ${l.text.trim().slice(0, 160)}`).join('\n')}${r.total > lines.length ? `
  (+${r.total - lines.length} more references)` : ''}`);
  }
  return out.join('\n\n');
}

// What the changed definitions use, one hop down: the definitions they call (callees, resolved by
// git grep to this repository) and, for every `self.x`/`this.x` field the hunks mention, the other
// lines of the same file that read or write it, assignments first. The reviewer declines most often
// with "the type of X is not shown" or "what f does with it is not shown"; this is that code.
const USED_SKIP = new Set('print len range str int float bool list dict set tuple isinstance issubclass super getattr setattr hasattr type repr iter next open sorted enumerate zip min max sum abs round any all format join split strip append extend get items keys values pop cast Optional Union require console log warn error push map filter reduce forEach some every find includes slice splice concat then catch resolve reject Error String Number Boolean Array Object Promise JSON Math setTimeout assert raise'.split(' '));
export function usedContext(repo, symbols, change, { maxDefs = 8, defLines = 60, maxFields = 6, perField = 10, max = 14000 } = {}) {
  if (change.head === 'commit') return '';
  const out = [], seen = new Set();
  const base = p => String(p).split('/').pop().replace(/\.[^.]+$/, '').toLowerCase();
  const dir = p => String(p).split('/').slice(0, -1).join('/');
  // 1. the definitions the hunks call, resolved by name with the qualifier as the tie-breaker: a same-file
  //    definition, a module whose name is the qualifier (compat.migrate_flow -> compat.py), the same
  //    directory, or the only definition in the repository; an ambiguous bare name is left out
  for (const f of change.files) {
    if (f.binary || f.status === 'D' || !CODE_EXT.test(f.path)) continue;
    const calls = new Map();
    for (const h of f.hunks) for (const l of h.lines) if (!l.startsWith('\\')) for (const m of l.slice(1).matchAll(/(?<![\w.])((?:[A-Za-z_]\w*\.)*)([A-Za-z_]\w{2,})\s*\(/g)) {
      const name = m[2]; if (USED_SKIP.has(name) || calls.has(name)) continue;
      calls.set(name, m[1].replace(/\.$/, '').split('.').pop().toLowerCase());
    }
    for (const [name, qual] of calls) {
      if (out.length >= maxDefs) break;
      let defs; try { defs = (findDefinitions(repo, name, { limit: 12 }) || []).filter(d => !isTestFile(d.path)); } catch { defs = []; }
      if (!defs.length) continue;
      const score = d => (d.path === f.path ? 3 : 0) + (qual && base(d.path) === qual ? 3 : 0) + (dir(d.path) === dir(f.path) ? 1 : 0);
      const best = defs.slice().sort((a, b) => score(b) - score(a))[0];
      if (!score(best) && defs.length > 1) continue;
      const key = `${best.path}:${name}`; if (seen.has(key)) continue; seen.add(key);
      const b = symbolBlock(repo, { path: best.path, symbol: name }, defLines);
      if (b && !(best.path === f.path && [...f.touched].some(n => n >= b.start && n <= b.end))) out.push(`--- ${best.path}:${name} (called in ${f.path}; lines ${b.start}-${b.end}${b.truncated ? ', truncated' : ''}) ---\n${b.text}`);
    }
  }
  // 2. the class line of every class a changed method belongs to, and of its bases defined here (one hop
  //    each, three deep): what a `self.x` the file never assigns is, mostly
  const classes = [];
  for (const s of symbols) for (const q of s.changed) {
    const cls = q.includes('.') ? q.split('.').slice(0, -1).pop() : null; if (!cls) continue;
    let name = cls, path = s.path;
    for (let hop = 0; hop < 3 && name; hop++) {
      const key = `class:${name}`; if (seen.has(key)) break; seen.add(key);
      let defs; try { defs = (findDefinitions(repo, name, { limit: 12 }) || []).filter(d => !isTestFile(d.path) && /^\s*(?:export\s+)?(?:abstract\s+)?class\b/.test(d.text)); } catch { defs = []; }
      const d = defs.find(x => x.path === path) || defs.find(x => dir(x.path) === dir(path)) || (defs.length === 1 ? defs[0] : null); if (!d) break;
      classes.push(`${d.path}:${d.line}: ${d.text.trim().slice(0, 200)}`);
      const m = /class\s+\w+\s*(?:\(([^)]*)\)|extends\s+([\w.]+))/.exec(d.text);
      name = (m?.[1] || m?.[2] || '').split(',')[0].trim().split('.').pop() || null; path = d.path;
    }
  }
  if (classes.length) out.push(`CLASS LINES (the classes the changed methods belong to, and their bases):\n${classes.join('\n')}`);
  const fields = [];
  for (const f of change.files) {
    if (f.binary || f.status === 'D') continue;
    const names = new Set();
    for (const h of f.hunks) for (const l of h.lines) for (const m of l.matchAll(/\b(?:self|this)\.([A-Za-z_]\w*)\b(?!\s*\()/g)) names.add(m[1]);
    for (const name of [...names].slice(0, maxFields)) {
      if (!countable(name)) continue;
      const r = references(repo, name, { file: f.path, limit: 400 });
      if (!r) continue;
      const own = r.lines.filter(l => l.path === f.path && !l.def && !f.touched.has(l.line) && !f.removedAt.has(l.line) && new RegExp(`\\b(?:self|this)\\.${name}\\b`).test(l.text));
      const assign = new RegExp(`\\b(?:self|this)\\.${name}\\b\\s*(?::[^=]*)?=[^=]`);
      const lines = [...own.filter(l => assign.test(l.text)), ...own.filter(l => !assign.test(l.text))].slice(0, perField);
      if (lines.length) fields.push(`${f.path}: self.${name} elsewhere in the file:\n${lines.map(l => `  ${l.line}: ${l.text.trim().slice(0, 160)}`).join('\n')}${own.length > lines.length ? `\n  (+${own.length - lines.length} more)` : ''}`);
    }
  }
  const text = [...out, ...fields].join('\n\n');
  return text.length > max ? text.slice(0, max) + '\n(truncated)' : text;
}

const isTestFile = p => /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[jt]sx?$|_test\.(py|go)$|^test_/.test(p);

// Every file in the change, with status and size: what the model needs to judge "X is not in this
// change" when the hunks shown are not all of them.
export function changeInventory(change, { max = 300 } = {}) {
  const f = change.files;
  return `FILES IN THE CHANGE (${f.length}): ${f.slice(0, max).map(x => `${x.path} (${x.status}${x.added || x.removed ? `, +${x.added} -${x.removed}` : ''})`).join(', ')}${f.length > max ? ` (+${f.length - max} more)` : ''}`;
}

// The diff within a character budget: the files in `priority` first, then the rest; says what was
// left out rather than cutting a hunk mid-way. Returns {text, shown, total}.
export function renderChange(change, { priority = new Set(), max = 16000 } = {}) {
  const order = [...change.files.filter(f => priority.has(f.path)), ...change.files.filter(f => !priority.has(f.path))];
  const parts = []; let used = 0, shown = 0;
  for (const f of order) {
    const t = renderFileDiff(f);
    if (used + t.length > max) { if (!shown) { parts.push(t.slice(0, max)); shown++; } break; }
    parts.push(t); used += t.length; shown++;
  }
  const left = order.slice(shown).map(f => f.path);
  return { text: parts.join('\n') + (left.length ? `\n\n(diff truncated: ${shown} of ${order.length} files shown; also in this change, not shown: ${left.slice(0, 40).join(', ')}${left.length > 40 ? ` (+${left.length - 40} more)` : ''})` : ''), shown, total: order.length };
}

// The change split into chunks of files that fit a call each, priority files first; at most
// `maxChunks`, the rest left to the inventory line.
function chunkChange(change, { priority = new Set(), size = 24000, maxChunks = 3 } = {}) {
  const order = [...change.files.filter(f => priority.has(f.path)), ...change.files.filter(f => !priority.has(f.path))];
  const chunks = []; let cur = [], used = 0;
  for (const f of order) {
    const t = renderFileDiff(f);
    if (cur.length && used + t.length > size) { chunks.push(cur); cur = []; used = 0; }
    cur.push(f); used += t.length;
  }
  if (cur.length) chunks.push(cur);
  return chunks.slice(0, maxChunks).map(files => ({ ...change, files, text: files.map(renderFileDiff).join('\n') }));
}

// The code after the change of every definition the change touched (for the nocache baseline).
function changedCode(symbols, reader, { maxSymbols = 10, maxLines = 80 } = {}) {
  const parts = [];
  for (const s of symbols) {
    const text = reader.after(s.path); if (text === null) continue;
    for (const q of s.changed) { if (parts.length >= maxSymbols) break; parts.push(`--- ${s.path}:${q} ---
${codeOf(text, { path: s.path, symbol: q }, maxLines)}`); }
  }
  return parts.join('\n\n').slice(0, 36000);
}

function codeOf(text, d, maxLines = 120) {
  if (text === null) return '(missing)';
  const lines = text.split('\n');
  if (!d.symbol) return lines.slice(0, maxLines).join('\n').slice(0, 6000);
  const loc = locateSymbol(text, d.symbol, d.path);
  if (!loc) return `(symbol ${d.symbol} not found; head of file)\n` + lines.slice(0, 40).join('\n').slice(0, 3000);
  return `(lines ${loc.start + 1}-${Math.min(loc.end, loc.start + maxLines)})\n` + lines.slice(loc.start, Math.min(loc.end, loc.start + maxLines)).join('\n').slice(0, 6000);
}
