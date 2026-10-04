// Dependency resolution and hashing. A dep is {path, symbol?}. We hash the
// symbol's definition block when we can find it, else the whole file, so a
// note about `authenticate()` does not go stale when an unrelated function in
// the same file changes.
//
// The block is found by tree-sitter when its grammars are installed (ast.js; `thinker ast install`)
// and by the regex heuristics below otherwise. A dep hashed by the parser carries `engine: "ast"`;
// one without it was hashed by the regex, and checkNote upgrades it in place when the regex block
// is unchanged, so installing the parser does not mark every note stale.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { astFindSymbol, astReady, extendUp } from './ast.js';
import { stem } from './rank.js';

const sha = s => 'sha256:' + crypto.createHash('sha256').update(s).digest('hex').slice(0, 24);
const norm = s => s.replace(/[ \t]+$/gm, '').replace(/\r\n/g, '\n');

// Dependency paths must stay inside the checkout, including after symlink resolution.
export function repoFile(repo, file) {
  const root = path.resolve(repo);
  const candidate = path.resolve(root, file);
  const rel = path.relative(root, candidate);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  try {
    const real = fs.realpathSync(candidate);
    const realRel = path.relative(fs.realpathSync(root), real);
    if (!realRel || realRel === '..' || realRel.startsWith(`..${path.sep}`) || path.isAbsolute(realRel)) return null;
    return real;
  } catch { return null; }
}

function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Returns {start, end} line indexes (end exclusive) of the symbol's definition, or null.
const INDENT_EXT = new Set(['py', 'pyi', 'rb', 'nim', 'yaml', 'yml', 'coffee']);
export function langOf(file) { const ext = (file || '').split('.').pop().toLowerCase(); return INDENT_EXT.has(ext) ? 'indent' : /^(js|jsx|ts|tsx|mjs|cjs|go|rs|java|kt|cs|c|h|cc|cpp|hpp|swift|scala|php|dart)$/.test(ext) ? 'brace' : 'auto'; }

export function findSymbol(text, symbol, lang = 'auto') {
  const lines = text.split('\n');
  const name = symbol.includes('.') ? symbol.split('.').pop() : symbol;
  const n = esc(name);
  // a line that starts with a keyword is a use, not a definition: `return foo(` is not a C-like `Type foo(`
  const defRe = new RegExp(
    `^(?!\\s*(?:return|await|yield|throw|new|else|case|if|elif|while|for|with|not|and|or|in|is|raise|assert|del|lambda|print|switch|typeof|delete|void|do|try|catch|finally|import|from|as|pass|break|continue|match|echo|unless|until|when|then)\\b)` +
    `\\s*(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?(?:` +
    `(?:def|class|function\\*?|interface|type|enum|struct|trait|impl|fn|func|module)\\s+${n}\\b` +      // py/js/ts/rs/go/rb
    `|(?:const|let|var)\\s+${n}\\s*[=:]` +                                                            // js/ts consts
    `|func\\s*\\([^)]*\\)\\s*${n}\\s*\\(` +                                                            // go methods
    (lang === 'indent' ? '' : `|(?:public|private|protected|static|final|abstract|\\s)*[\\w<>\\[\\],\\s]+\\s+${n}\\s*\\(`) +      // java/c#/c-like methods; in Python an indented `validate(ctx)` is a call
    `|${n}\\s*[:=]\\s*(?:async\\s*)?(?:\\([^)]*\\)\\s*=>|function\\b|class\\b)` +                     // obj-prop / arrow fns
    `|${n}\\s*=\\s*)`);
  let candidates = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.includes(name) && defRe.test(l)) candidates.push(i);
  }
  // Python typing overload stubs share the name with the implementation;
  // hash the implementation, not the first stub.
  const isOverload = i => { let j = i - 1; while (j >= 0 && /^\s*@/.test(lines[j])) { if (/@(?:t\.|typing\.)?overload\b/.test(lines[j])) return true; j--; } return false; };
  const impl = candidates.filter(i => !isOverload(i));
  if (impl.length) candidates = impl;
  if (!candidates.length) return null;
  // Prefer a candidate that matches the qualified parent (Class.method) if given.
  let start = candidates[0];
  if (symbol.includes('.')) {
    // Qualified name: the parent (class/struct/module) must be defined in this
    // file and the member must sit inside its block, else no match.
    const parent = symbol.split('.').slice(-2)[0];
    const pRe = new RegExp(`^\\s*(?:export\\s+(?:default\\s+)?)?(?:abstract\\s+)?(?:class|interface|struct|impl(?:<[^>]*>)?(?:\\s+\\w+\\s+for)?|module|object|trait|enum)\\s+${esc(parent)}\\b`);
    let pLine = -1;
    for (let i = 0; i < lines.length; i++) if (pRe.test(lines[i])) { pLine = i; break; }
    if (pLine < 0) return null;
    const pEnd = blockEnd(lines, pLine, lang);
    const c = candidates.find(c => c > pLine && c < pEnd);
    if (c === undefined) return null;
    start = c;
  }
  // Include decorators / doc comments directly above.
  return { start: extendUp(lines, start), end: blockEnd(lines, start, lang) };
}

// findSymbol with the parser when it is loaded for the file's language, the regex otherwise (also
// when the parser does not find the name: object properties and the like). Adds `engine`.
export function locateSymbol(text, symbol, file, { engine } = {}) {
  if (engine !== 'regex' && file && astReady(file)) {
    const loc = astFindSymbol(text, symbol, file);
    if (loc) return { ...loc, engine: 'ast' };
  }
  const loc = findSymbol(text, symbol, langOf(file));
  return loc ? { ...loc, engine: 'regex' } : null;
}

function blockEnd(lines, start, lang = 'auto') {
  const first = lines[start];
  const indent = first.match(/^\s*/)[0].length;
  const braceLang = lang === 'brace' || (lang === 'auto' && (/[{]\s*$/.test(first) || /\)\s*(?:->\s*[\w<>\[\]:, ]+)?\s*[{]/.test(first) || /=>\s*[{]?\s*$/.test(first) || (!/:\s*(#.*)?$/.test(first) && /[{(]/.test(first))));
  if (lang === 'indent' && !braceLang) {
    // skip a multi-line signature: advance until brackets balance and the line ends the header
    let depth = 0, i = start;
    for (; i < lines.length; i++) {
      for (const ch of lines[i]) { if ('([{'.includes(ch)) depth++; else if (')]}'.includes(ch)) depth--; }
      if (depth <= 0) break;
    }
    start = i;
  }
  if (braceLang) {
    // brace matching
    let depth = 0, seen = false;
    for (let i = start; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === '{' || ch === '(' || ch === '[') { depth++; seen = true; }
        else if (ch === '}' || ch === ')' || ch === ']') depth--;
      }
      if (seen && depth <= 0) return Math.min(i + 1, lines.length);
    }
    return lines.length;
  }
  // indentation-based (python, ruby-ish fallback)
  let i = start + 1;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') continue;
    if (l.match(/^\s*/)[0].length <= indent) break;
  }
  while (i > start + 1 && lines[i - 1].trim() === '') i--; // drop trailing blank lines
  return i;
}

// engine: 'regex' forces the heuristics (to compare against a dep hashed before the parser was installed).
export function hashDep(repo, dep, { engine } = {}) {
  const abs = repoFile(repo, dep.path);
  if (!abs) return { ...dep, hash: null, missing: true };
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { return { ...dep, hash: null, missing: true }; }
  return hashText(text, dep, { engine });
}

// Shared by working-tree and commit validation; no filesystem reads.
export function hashText(text, dep, { engine } = {}) {
  dep = { ...dep };
  delete dep.symbolMissing;
  if (dep.symbol) {
    const loc = locateSymbol(text, dep.symbol, dep.path, { engine });
    if (loc) {
      const lines = text.split('\n');
      const out = { ...dep, hash: sha(norm(lines.slice(loc.start, loc.end).join('\n'))), line: loc.start + 1, missing: false };
      delete out.engine; delete out.hashRegex;
      if (loc.engine === 'ast') {
        // the regex hash too, so a checkout without the parser can tell this block unchanged (checkNote)
        out.engine = 'ast';
        const rx = findSymbol(text, dep.symbol, langOf(dep.path));
        if (rx) out.hashRegex = sha(norm(lines.slice(rx.start, rx.end).join('\n')));
      }
      return out;
    }
    // symbol not found: hash the file and flag so verification can decide.
    const out = { ...dep, hash: sha(norm(text)), symbolMissing: true, missing: false }; delete out.engine; delete out.hashRegex; return out;
  }
  const out = { ...dep, hash: sha(norm(text)), missing: false }; delete out.engine; delete out.hashRegex; return out;
}

// Git paths are repository-relative, never filesystem paths or revision expressions.
export function validDepPath(file) {
  return typeof file === 'string' && !!file && !file.startsWith('/') &&
    !file.includes('\\') && !file.includes('\0') && !/^[A-Za-z]:/.test(file) &&
    !file.split('/').some(p => !p || p === '.' || p === '..');
}

export function hashDepAt(repo, dep, ref, opts = {}) {
  if (!validDepPath(dep.path)) return { ...dep, hash: null, missing: true };
  try {
    // Reject symlinks: git show would otherwise hash the link target as file content.
    const entry = execFileSync('git', ['ls-tree', ref, '--', dep.path], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (!/^100(?:644|755) blob /.test(entry)) return { ...dep, hash: null, missing: true };
    const text = execFileSync('git', ['show', `${ref}:${dep.path}`], { cwd: repo, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return hashText(text, dep, opts);
  } catch { return { ...dep, hash: null, missing: true }; }
}

// Read the index rather than the working tree: a pre-commit hook must validate
// exactly the code being committed, including partially staged files.
export function hashDepAtIndex(repo, dep, opts = {}) {
  if (!validDepPath(dep.path)) return { ...dep, hash: null, missing: true };
  try {
    const entry = execFileSync('git', ['ls-files', '--stage', '--', dep.path], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (!/^100(?:644|755) [a-f0-9]+ 0\t/.test(entry) || entry.trim().split('\n').length !== 1) return { ...dep, hash: null, missing: true };
    const text = execFileSync('git', ['show', `:${dep.path}`], { cwd: repo, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return hashText(text, dep, opts);
  } catch { return { ...dep, hash: null, missing: true }; }
}

// Re-hash all deps of a note against the working tree. Returns
// {changed: [{path, symbol, reason}], deps: freshDeps, upgraded}; upgraded is set when a dep hashed
// by the regex was re-hashed by the parser with its block unchanged (the note should be saved).
// narrow: a changed whole-file dep is judged against what the note names (narrowFileDep), which costs
// git calls per changed file. Maintenance and `thinker check` pass it and persist the outcome; the
// per-prompt refresh does not, and sees the deps they stored.
export function checkNote(repo, note, { ref, index = false, narrow = false } = {}) {
  const changed = [];
  let upgraded = false;
  // A stored hash that no longer matches is not always the code moving: the hasher moves too.
  // When `findSymbol` is changed, every symbol it now cuts differently hashes differently on code
  // nobody touched (33 of 692 notes of one cache went stale on an identical checkout after one such
  // change). The current hasher applied to the code as it was at `verifiedCommit` settles it: the
  // same hash then and now means the code is as it was verified, and the record is simply
  // brought up to date, as when the parser arrives.
  const unchangedSinceVerified = (d, now) => {
    if (!d.symbol || !note.verifiedCommit || !now.hash) return false;
    const then = hashDepAt(repo, { path: d.path, symbol: d.symbol }, note.verifiedCommit);
    return !then.missing && then.hash === now.hash;
  };
  // `deps` is safe to store whatever the outcome: a dep the change altered keeps its stored record
  // (its hash from the last verification), so a stale note's deps can be persisted without the
  // change disappearing from the next check; the others take their present hash
  const deps = (note.deps || []).flatMap(d => {
    let now = index ? hashDepAtIndex(repo, d) : ref ? hashDepAt(repo, d, ref) : hashDep(repo, d);
    const before = changed.length;
    if (now.missing) changed.push({ path: d.path, symbol: d.symbol, reason: 'file removed' });
    else if (now.symbolMissing && !d.symbolMissing) {
      // the current hasher does not find the symbol now; if it did not find it at verification either, it never
      // went away since, an older hasher recorded it, and the record follows the hasher as above
      if (unchangedSinceVerified(d, now)) upgraded = true;
      else changed.push({ path: d.path, symbol: d.symbol, reason: 'symbol not found' });
    }
    else if (d.hash && now.hash !== d.hash) {
      // the parser and the regex cut different blocks; the block is unchanged when the regex hashes agree
      if (d.symbol && now.engine === 'ast' && !d.engine && now.hashRegex === d.hash) upgraded = true; // the parser arrived here: store its hash
      else if (d.symbol && !now.engine && d.engine === 'ast' && d.hashRegex === now.hash) now = { ...d }; // no parser here: keep the record of the checkout that has one
      else if (!d.symbol && narrow && !ref && !index) {
        // the file changed somewhere. When the note names definitions in it, the dep narrows to those
        // definitions: the note is stale only on the ones that changed, and the narrowed deps are kept
        // either way (`persist`), so the next check and the verification see symbols, not the file.
        // When it names none, the change is still unrelated if no changed line holds a term of the note.
        const narrowed = narrowFileDep(repo, d, note);
        if (narrowed) {
          upgraded = true;
          for (const c of narrowed.changed) changed.push({ path: d.path, symbol: c, reason: 'symbol body changed' });
          return narrowed.deps;
        }
        changed.push({ path: d.path, symbol: d.symbol, reason: 'file changed' });
      }
      else if (unchangedSinceVerified(d, now)) upgraded = true; // the hasher changed, the code did not: store its hash
      else changed.push({ path: d.path, symbol: d.symbol, reason: d.symbol && !now.symbolMissing ? 'symbol body changed' : 'file changed' });
    }
    if (changed.length > before) return [{ ...d }];
    if (d.fanout) now.fanout = d.fanout; // reference counts (codegraph.js) are kept until the note is re-verified
    return [now];
  });
  return { changed, deps, upgraded };
}

// Identifiers a note body could be naming: words of an identifier's shape, four characters or more,
// that are not English. findSymbol decides which of them are definitions in the file.
const NOT_IDENT = new Set('this that with from when where which must only also into then than they them have been were does each file files note notes line lines change changed changes should would could before after under over same other every call calls called return returns string number value values array object true false null none list dict test tests check checks run runs running hook hooks path paths repo'.split(' '));
export function bodyIdentifiers(body, max = 40) {
  const out = [];
  for (const m of String(body || '').matchAll(/(?<![\w.])([A-Za-z_][\w]{3,})(?![\w])/g)) {
    const w = m[1];
    if (NOT_IDENT.has(w.toLowerCase()) || out.includes(w)) continue;
    // a shape only code has, or a plain word the text uses as a name (`foo()`, backticks)
    const ctx = body.slice(Math.max(0, m.index - 1), m.index + w.length + 1);
    if (/[A-Z_]/.test(w) || /\d/.test(w) || ctx.startsWith('`') || ctx.endsWith('(') || ctx.endsWith('`')) out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

// A whole-file dep whose file changed since the note was verified. When the body names definitions
// in that file, the dep becomes those definitions: {deps, changed} with each definition hashed as
// it was at the verified commit when it changed since (so it still reads as changed, and a
// verification sees that symbol rather than the file) and as it is now when it did not; `changed`
// names the ones that changed. On a repository with two hundred commits a week, a whole-file dep on
// a hub file was stale by construction: 74 of 137 stale notes here rested on nothing else. Null when
// nothing can be told (no named definition, no verified commit): the note is then stale as before,
// unless the changed lines hold no term of the note. Working tree only; commit checks
// (share --check) keep file hashes.
export function narrowFileDep(repo, dep, note, { max = 4 } = {}) {
  if (dep.symbol || !note?.verifiedCommit) return null;
  const abs = repoFile(repo, dep.path);
  if (!abs) return null;
  let text; try { text = fs.readFileSync(abs, 'utf8'); } catch { return null; }
  const syms = [], changedSyms = [];
  for (const name of bodyIdentifiers(note.body)) {
    const now = hashText(text, { path: dep.path, symbol: name });
    if (now.symbolMissing) continue; // not a definition in this file
    const then = hashDepAt(repo, { path: dep.path, symbol: name }, note.verifiedCommit);
    if (then.missing || then.symbolMissing || then.hash !== now.hash) { syms.push(then.missing || then.symbolMissing ? { path: dep.path, symbol: name, hash: 'changed' } : then); changedSyms.push(name); }
    else syms.push(now);
    if (syms.length >= max) break;
  }
  if (syms.length) return { deps: syms, changed: changedSyms };
  // no definition named: the file is read as a whole (a script, a config, a switch of cases). The
  // change is still unrelated when no changed line holds a term the note uses; the dep then keeps
  // the file and takes the new hash. The diff is from the verified commit, so later changes are
  // judged against everything since, not just the latest edit.
  const diff = diffSince(repo, note.verifiedCommit, dep.path);
  if (diff === null) return null;
  const terms = noteTerms(note);
  if (!terms.size) return null;
  for (const line of diff.split('\n')) {
    if (!/^[+-]/.test(line) || /^(\+\+\+|---)/.test(line)) continue;
    for (const w of line.toLowerCase().match(/[a-z_][a-z0-9_]{3,}/g) || []) if (terms.has(stem(w))) return null;
  }
  return { deps: [hashText(text, { path: dep.path })], changed: [] };
}

// At creation: a whole-file dep on a code file whose definitions the note's body names becomes
// those symbol deps, so the note starts anchored to what it talks about rather than to a file that
// every unrelated commit changes. Deps on files that are not code (configs, scripts, docs), and on
// code files the body names nothing in, stay as they are. Of this repository's live notes, 44 had
// a whole-file dep that could have been narrowed this way when they were written.
export function narrowAtCreation(repo, deps, body, { max = 4 } = {}) {
  return deps.flatMap(d => {
    if (d.symbol || langOf(d.path) === 'auto') return [d];
    const abs = repoFile(repo, d.path);
    let text; try { text = fs.readFileSync(abs, 'utf8'); } catch { return [d]; }
    const syms = [];
    for (const name of bodyIdentifiers(body)) {
      const h = hashText(text, { path: d.path, symbol: name });
      if (h.symbolMissing) continue;
      syms.push(h);
      if (syms.length >= max) break;
    }
    return syms.length ? syms : [d];
  });
}

function diffSince(repo, commit, file) {
  try { return execFileSync('git', ['diff', '--no-color', '-U0', commit, '--', file], { cwd: repo, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
}

// The words a note is about: identifiers and words of four letters or more from its title, body and
// pointers, lowercased, without the English the body is written in.
const TERM_STOP = new Set('this that with from when where which must only also into then than they them have been were does each file files note notes line lines should would could before after under over same other every about there their these those what while because through without within between during against since until using used uses call calls called return returns returned true false null none value values default option options'.split(' '));
export function noteTerms(note) {
  const out = new Set();
  const text = `${note.title || ''}\n${note.body || ''}\n${(note.deps || []).map(d => d.symbol || '').join(' ')}`;
  for (const w of text.toLowerCase().match(/[a-z_][a-z0-9_]{3,}/g) || []) if (!TERM_STOP.has(w)) out.add(stem(w));
  return out;
}

// The definition behind a dep, with its place in the file: {text, start, end, total, truncated}
// (lines are 1-based, end inclusive). A file-level dep gives the head of the file.
export function symbolBlock(repo, dep, maxLines = 200) {
  try {
    const abs = repoFile(repo, dep.path);
    if (!abs) return null;
    const text = fs.readFileSync(abs, 'utf8');
    const lines = text.split('\n');
    let loc = dep.symbol ? locateSymbol(text, dep.symbol, dep.path) : null;
    if (dep.symbol && !loc) return null;
    if (!loc) loc = { start: 0, end: lines.length };
    const end = Math.min(loc.end, loc.start + maxLines);
    return { text: lines.slice(loc.start, end).join('\n'), start: loc.start + 1, end, total: loc.end - loc.start, truncated: end < loc.end, engine: loc.engine };
  } catch { return null; }
}

export function symbolText(repo, dep, maxLines = 200) {
  const b = symbolBlock(repo, dep, maxLines);
  if (b) return b.text;
  // symbol not found: the head of the file, as before
  return symbolBlock(repo, { path: dep.path }, maxLines)?.text ?? null;
}
