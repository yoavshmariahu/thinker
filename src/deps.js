// Dependency resolution and hashing. A dep is {path, symbol?}. We hash the
// symbol's definition block when we can find it, else the whole file, so a
// note about `authenticate()` does not go stale when an unrelated function in
// the same file changes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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
  const defRe = new RegExp(
    `^\\s*(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?(?:` +
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
  let s = start;
  while (s > 0 && /^\s*(@|#\[|\/\/|\/\*|\*)/.test(lines[s - 1])) s--;
  return { start: s, end: blockEnd(lines, start, lang) };
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

export function hashDep(repo, dep) {
  const abs = repoFile(repo, dep.path);
  if (!abs) return { ...dep, hash: null, missing: true };
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { return { ...dep, hash: null, missing: true }; }
  if (dep.symbol) {
    const loc = findSymbol(text, dep.symbol, langOf(dep.path));
    if (loc) {
      const block = text.split('\n').slice(loc.start, loc.end).join('\n');
      return { ...dep, hash: sha(norm(block)), line: loc.start + 1, missing: false };
    }
    // symbol not found: hash the file and flag so verification can decide.
    return { ...dep, hash: sha(norm(text)), symbolMissing: true, missing: false };
  }
  return { ...dep, hash: sha(norm(text)), missing: false };
}

// Re-hash all deps of a note against the working tree. Returns
// {changed: [{path, symbol, reason}], deps: freshDeps}.
export function checkNote(repo, note) {
  const changed = [];
  const deps = (note.deps || []).map(d => {
    const now = hashDep(repo, d);
    if (now.missing) changed.push({ path: d.path, symbol: d.symbol, reason: 'file removed' });
    else if (now.symbolMissing && !d.symbolMissing) changed.push({ path: d.path, symbol: d.symbol, reason: 'symbol not found' });
    else if (d.hash && now.hash !== d.hash) changed.push({ path: d.path, symbol: d.symbol, reason: d.symbol && !now.symbolMissing ? 'symbol body changed' : 'file changed' });
    return now;
  });
  return { changed, deps };
}

export function symbolText(repo, dep, maxLines = 200) {
  try {
    const abs = repoFile(repo, dep.path);
    if (!abs) return null;
    const text = fs.readFileSync(abs, 'utf8');
    if (dep.symbol) {
      const loc = findSymbol(text, dep.symbol, langOf(dep.path));
      if (loc) return text.split('\n').slice(loc.start, Math.min(loc.end, loc.start + maxLines)).join('\n');
    }
    return text.split('\n').slice(0, maxLines).join('\n');
  } catch { return null; }
}
