// A file's structure without reading the file: the definitions it holds, each with its line range, from a
// line scanner with no dependency (2026-11-12).
//
// Why no parser. thinker had a real one until 2026-11-08 (`src/ast.js`, web-tree-sitter with the grammars of
// tree-sitter-wasms, about 50 MB of wasm), removed with the knowledge notes it served. The outline is read by
// the delegation hook, which runs inside a tool call, so what it needs is a map of a file good enough to pick a
// range from, not a syntax tree: names, nesting and line ranges. A scanner gives that for the languages below
// in a few milliseconds and ships nothing. Where it is wrong it is wrong by omission -- a definition whose
// header the patterns do not match is left out, never invented -- and `coverage()` says how much of the file
// the outline accounts for, which is how a caller decides whether to trust it.
//
// What it is not: a symbol index (that was `src/symbols.js`, a persistent sharded table, also removed), and not
// a call graph. One file, one pass.
import fs from 'node:fs';
import path from 'node:path';

// Language by extension, and how a block ends: by indentation or by braces.
const PY = { lang: 'python', block: 'indent' };
const JS = { lang: 'js', block: 'brace' };
const GO = { lang: 'go', block: 'brace' };
const RS = { lang: 'rust', block: 'brace' };
const RB = { lang: 'ruby', block: 'keyword' };
const BR = { lang: 'brace', block: 'brace' };
export const LANGUAGES = Object.freeze({
  py: PY, pyi: PY, pyw: PY,
  js: JS, mjs: JS, cjs: JS, jsx: JS, ts: JS, mts: JS, cts: JS, tsx: JS,
  go: GO, rs: RS, rb: RB, rake: RB,
  java: BR, kt: BR, kts: BR, cs: BR, swift: BR, scala: BR, c: BR, h: BR, cc: BR, cpp: BR, cxx: BR, hpp: BR, m: BR, mm: BR, php: BR,
});
export function languageOf(file) {
  const ext = String(file || '').split('/').pop().split('.').pop().toLowerCase();
  return LANGUAGES[ext] || null;
}

// A container holds the definitions written inside it (a class, an impl block, a Go type is not one).
const CONTAINER = /^(class|interface|impl|trait|module|struct|enum|record|namespace)$/;
// A line that opens a block but defines nothing: without this every `if (x) {` reads as a method. Both sets are
// applied only to a pattern with no defining keyword of its own (`bare`, the JavaScript member and brace-language
// method patterns), which is why `fn new`, `def match` and `static of = …` survive: a language whose definitions
// all carry a keyword never meets them.
const LINE_WORD = new Set(['if', 'else', 'elif', 'for', 'while', 'switch', 'case', 'catch', 'try', 'do', 'return',
  'await', 'typeof', 'new', 'delete', 'throw', 'yield', 'with', 'except', 'finally', 'match', 'function', 'class',
  'def', 'fn', 'func', 'let', 'const', 'var', 'import', 'export', 'require', 'print', 'assert', 'raise', 'lambda',
  'use', 'mod', 'pub', 'unsafe', 'extern', 'go', 'defer', 'select', 'sizeof', 'super', 'in', 'of', 'is', 'and', 'or', 'not']);
// The same, as a name: the word the pattern captured. Narrower, because a method may legitimately be called
// `of`, `in`, `is`, `match` or `print`.
const NOT_A_NAME = new Set(['if', 'else', 'for', 'while', 'switch', 'case', 'catch', 'try', 'do', 'return', 'await',
  'typeof', 'new', 'delete', 'throw', 'yield', 'with', 'function', 'class', 'const', 'let', 'var', 'import',
  'export', 'require', 'sizeof', 'super']);

// The patterns, by language. Each gives [kind, name] and optionally a parent of its own (a Go receiver, a
// Rust impl type). `member: true` marks a pattern that may only match inside a container, which is what makes
// a JavaScript method (`foo() {`, no keyword at all) findable without reading it as a call.
const PATTERNS = {
  python: [
    [/^(\s*)class\s+([A-Za-z_]\w*)/, 'class'],
    [/^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/, 'function'],
  ],
  js: [
    [/^(\s*)(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
    [/^(\s*)(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, 'function'],
    [/^(\s*)(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, 'type'],
    // const f = (a) => , const f = async function, const f = function*
    [/^(\s*)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^()]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/, 'function'],
    [/^(\s*)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/, 'const'],
    // inside a class: `foo() {`, `static async foo() {`, `get foo() {`, `foo = (a) => {`
    [/^(\s*)(?:(?:static|public|private|protected|readonly|abstract|override|async|get|set)\s+)*\*?\s*([A-Za-z_$#][\w$]*)\s*(?:<[^>]*>)?\s*\(/, 'method', { member: true, bare: true }],
    [/^(\s*)(?:(?:static|public|private|protected|readonly|declare)\s+)*([A-Za-z_$#][\w$]*)\s*(?::[^=;]+)?=\s*(?:async\s*)?(?:\([^()]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/, 'method', { member: true, bare: true }],
  ],
  go: [
    [/^(\s*)func\s*\(\s*\w+\s+[*]?([A-Za-z_]\w*)[^)]*\)\s*([A-Za-z_]\w*)/, 'method', { receiver: true }],
    [/^(\s*)func\s+([A-Za-z_]\w*)/, 'function'],
    [/^(\s*)type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/, 'struct'],
    [/^(\s*)type\s+([A-Za-z_]\w*)/, 'type'],
    [/^(\s*)(?:const|var)\s+([A-Za-z_]\w*)\s*[=\s]/, 'const'],
  ],
  rust: [
    [/^(\s*)impl(?:\s*<[^>]*>)?\s+(?:[\w:<>, ]+\s+for\s+)?([A-Za-z_]\w*)/, 'impl'],
    [/^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/, 'function'],
    [/^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union|mod)\s+([A-Za-z_]\w*)/, 'struct'],
    [/^(\s*)(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)/, 'type'],
    [/^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+(?:mut\s+)?([A-Za-z_]\w*)/, 'const'],
  ],
  ruby: [
    [/^(\s*)(?:class|module)\s+([A-Z][\w:]*)/, 'class'],
    [/^(\s*)def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/, 'function'],
  ],
  brace: [
    [/^(\s*)(?:[\w@$<>[\].,]+\s+)*?(?:class|interface|struct|enum|record|namespace|protocol|trait)\s+([A-Za-z_]\w*)/, 'class'],
    // a typed declaration followed by a parameter list and no semicolon: a definition, not a call or a prototype
    [/^(\s*)(?:(?:public|private|protected|internal|static|final|abstract|virtual|override|async|unsafe|inline|explicit|const|extern|func|fun|def|sub|operator)\s+)+(?:[\w@$<>[\].,:*&]+\s+)*?([A-Za-z_~]\w*)\s*\([^;]*$/, 'method', { bare: true }],
    [/^(\s*)(?:[\w@$<>[\].,:*&]+\s+)+([A-Za-z_~]\w*)\s*\([^;)]*\)\s*(?:const\s*)?(?:->\s*[\w<>:*&\s]+)?\{/, 'method', { bare: true }],
  ],
};

// Comment and blank lines never end a block, and never start a definition.
const BLANK = /^\s*$/;
const COMMENT = /^\s*(#|\/\/|\/\*|\*|--|"""|''')/;

// Braces outside strings and line comments, since only a brace delimits a block: counting parentheses too made
// every regex literal open one. Not a parser: enough that a block's end line is right in ordinary code.
function braceDelta(line) {
  let d = 0, q = null, i = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '\\') { i++; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '/' && line[i + 1] === '/') break;
    if (c === '#') break;
    if (c === '/' && line[i + 1] === '*') { const e = line.indexOf('*/', i + 2); if (e < 0) break; i = e + 1; continue; }
    if (c === '{') d++;
    else if (c === '}') d--;
  }
  return d;
}
const indentOf = line => line.match(/^[ \t]*/)[0].replace(/\t/g, '        ').length;

/**
 * The definitions a text holds: [{ name, kind, parent, line, end }], line and end 1-based and inclusive, in
 * source order. `null` when the file's language has no patterns here. A definition the patterns miss is absent;
 * nothing is guessed.
 */
export function outlineText(text, file, { limit = 400 } = {}) {
  const lang = languageOf(file);
  if (!lang) return null;
  const pats = PATTERNS[lang.lang];
  if (!pats) return null;
  const lines = String(text).split('\n');
  const out = [];
  const open = []; // containers still open: { name, indent, depth, def }
  let depth = 0;   // brace depth, for brace languages
  let docQuote = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // a Python docstring or a heredoc can hold anything, including what looks like a definition
    if (lang.block === 'indent') {
      const q = line.match(/("""|''')/g);
      if (docQuote) { if (q && q.includes(docQuote)) docQuote = null; continue; }
      else if (q && q.length === 1) { docQuote = q[0]; continue; }
    }
    const before = depth;
    if (lang.block === 'brace') depth += braceDelta(line);
    if (BLANK.test(line) || COMMENT.test(line)) continue;
    const indent = indentOf(line);
    // close the containers this line has left
    while (open.length) {
      const top = open[open.length - 1];
      const left = lang.block === 'brace' ? before <= top.depth : indent <= top.indent;
      if (!left) break;
      top.def.end = lastCode(lines, i - 1, top.def.line);
      open.pop();
    }
    const top = open.length ? open[open.length - 1] : null;
    // a local inside a function body is not part of the file's map
    if (top && top.leaf) continue;
    const parent = top ? top.name : null;
    for (const [re, kind, opt = {}] of pats) {
      if (opt.member && !parent) continue;
      const m = re.exec(line);
      if (!m) continue;
      let name = m[2], own = parent;
      if (opt.receiver) { own = m[2]; name = m[3]; }
      if (!name || (opt.bare && NOT_A_NAME.has(name))) break;
      if (opt.bare && LINE_WORD.has(line.trim().split(/[\s(]/)[0])) break;
      const def = { name, kind: kind === 'function' && parent ? 'method' : kind, parent: own, line: i + 1, end: i + 1 };
      out.push(def);
      if (CONTAINER.test(def.kind)) open.push({ name, indent, depth: before, def });
      else if (lang.block === 'brace' ? opensBlock(lines, i, depth, before) : true) {
        // a body: its end is found the same way, but what it holds is local, so it is a leaf
        open.push({ name, indent, depth: before, def, leaf: true });
      }
      break;
    }
  }
  for (const o of open) o.def.end = lastCode(lines, lines.length - 1, o.def.line);
  return out.slice(0, limit);
}
// Whether the definition starting at `i` opens a block: a brace on its own line, or on one of the next few
// where a signature runs long. A declaration with no body (a prototype, an interface member) opens none.
function opensBlock(lines, i, depth, before) {
  if (depth > before) return true;
  for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
    const l = lines[j];
    if (BLANK.test(l) || COMMENT.test(l)) continue;
    if (/^\s*[})\]]*\s*\{/.test(l) || /\{\s*$/.test(l)) return true;
    if (/;\s*$/.test(l) || /^\s*(?:export|import|const|let|var|function|class|def|fn|func|type|interface)\b/.test(l)) return false;
  }
  return false;
}
function lastCode(lines, from, floor) {
  let j = Math.min(from, lines.length - 1);
  while (j > floor - 1 && (BLANK.test(lines[j]) || COMMENT.test(lines[j]))) j--;
  return Math.max(j + 1, floor);
}

/** What share of the file's lines fall inside a top-level definition: how much of it the outline accounts for. */
export function coverage(defs, lineCount) {
  if (!defs || !defs.length || !lineCount) return 0;
  const top = defs.filter(d => !d.parent);
  let covered = 0, end = 0;
  for (const d of top.slice().sort((a, b) => a.line - b.line)) {
    const from = Math.max(d.line, end + 1);
    if (d.end >= from) { covered += d.end - from + 1; end = d.end; }
  }
  return Math.min(1, covered / lineCount);
}

const KIND_WORD = { function: 'function', method: 'method', class: 'class', struct: 'struct', impl: 'impl', trait: 'trait', interface: 'interface', type: 'type', enum: 'enum', const: 'const', module: 'module', namespace: 'namespace', record: 'record' };

/**
 * The outline as the model reads it: one line a definition, its range first so a range read is the obvious next
 * move. Members are indented under their container. `maxLines` caps it; the biggest definitions are kept, since
 * a file too big to read is one whose large blocks are what the reader is deciding between.
 */
export function renderOutline({ file, defs, lineCount, cwd, maxLines = 120 }) {
  const rel = cwd ? path.relative(cwd, file) || file : file;
  let shown = defs, dropped = 0;
  if (defs.length > maxLines) {
    const keep = new Set(defs.slice().sort((a, b) => (b.end - b.line) - (a.end - a.line)).slice(0, maxLines).map(d => d.line));
    shown = defs.filter(d => keep.has(d.line));
    dropped = defs.length - shown.length;
  }
  const width = String(lineCount).length;
  const rows = shown.map(d => {
    const range = `${String(d.line).padStart(width)}-${String(d.end).padEnd(width)}`;
    const kind = KIND_WORD[d.kind] || d.kind;
    return `  ${range}  ${d.parent ? '  ' : ''}${kind} ${d.parent && d.kind !== 'method' ? `${d.parent}.` : ''}${d.name}`;
  });
  const head = `${rel}: ${lineCount} lines, ${defs.length} definition${defs.length === 1 ? '' : 's'}`;
  return [head, ...rows, dropped ? `  (${dropped} smaller definitions not listed)` : ''].filter(Boolean).join('\n');
}

/** The outline of a file on disk: { text, defs, lineCount, coverage }, or null where it cannot be outlined. */
export function outlineOf(file, { cwd, maxLines, minDefs = 3 } = {}) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const defs = outlineText(text, file);
  if (!defs || defs.length < minDefs) return null;
  const lineCount = text.split('\n').length;
  return { defs, lineCount, coverage: coverage(defs, lineCount), text: renderOutline({ file, defs, lineCount, cwd, maxLines }) };
}

/** Several files as one block, each outlined. Files that cannot be outlined are named in `missed`. */
export function outlineFiles(files, { cwd, maxLines } = {}) {
  const parts = [], missed = [];
  let defs = 0;
  for (const f of files) {
    const o = outlineOf(f, { cwd, maxLines });
    if (!o) { missed.push(path.relative(cwd || '', f) || f); continue; }
    parts.push(o.text); defs += o.defs.length;
  }
  return parts.length ? { text: parts.join('\n\n'), defs, missed } : null;
}
