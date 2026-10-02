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
    `|(?:public|private|protected|static|final|abstract|\\s)*[\\w<>\\[\\],\\s]+\\s+${n}\\s*\\(` +      // java/c#/c-like methods
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
export function checkNote(repo, note, { ref, index = false } = {}) {
  const changed = [];
  let upgraded = false;
  const deps = (note.deps || []).map(d => {
    let now = index ? hashDepAtIndex(repo, d) : ref ? hashDepAt(repo, d, ref) : hashDep(repo, d);
    if (now.missing) changed.push({ path: d.path, symbol: d.symbol, reason: 'file removed' });
    else if (now.symbolMissing && !d.symbolMissing) changed.push({ path: d.path, symbol: d.symbol, reason: 'symbol not found' });
    else if (d.hash && now.hash !== d.hash) {
      // the parser and the regex cut different blocks; the block is unchanged when the regex hashes agree
      if (d.symbol && now.engine === 'ast' && !d.engine && now.hashRegex === d.hash) upgraded = true; // the parser arrived here: store its hash
      else if (d.symbol && !now.engine && d.engine === 'ast' && d.hashRegex === now.hash) now = { ...d }; // no parser here: keep the record of the checkout that has one
      else changed.push({ path: d.path, symbol: d.symbol, reason: d.symbol && !now.symbolMissing ? 'symbol body changed' : 'file changed' });
    }
    if (d.fanout) now.fanout = d.fanout; // reference counts (codegraph.js) are kept until the note is re-verified
    return now;
  });
  return { changed, deps, upgraded };
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
