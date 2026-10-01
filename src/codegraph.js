// One hop of the call graph around a symbol: where a name is referenced (callers, blast radius)
// and which repository symbols a definition calls (callees). Two engines answer, chosen per call
// by cbm.js:codegraphEngine: the graph of codebase-memory-mcp when the checkout is indexed
// (resolved calls, no false hits), else `git grep` without an index: approximate by design, word
// matches on the language family of the file, and good enough to say "6 call sites in 3 files"
// next to a pointer and to spare the agent its own greps.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { repoFile, symbolBlock } from './deps.js';
import { definitions, astReady } from './ast.js';
import { codegraphEngine, cbmProject, cbmNeighbors, cbmSearch, cbmOutline } from './cbm.js';

// The CBM project to ask, 'git' to grep instead, or null when CBM was demanded but has no index.
function graph(repo) {
  if (codegraphEngine(repo) !== 'cbm') return 'git';
  return cbmProject(repo) || (process.env.THINKER_CODEGRAPH === 'cbm' ? null : 'git');
}

const FAMILY = {
  py: ['py', 'pyi'], pyi: ['py', 'pyi'],
  js: ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'vue', 'svelte'], jsx: ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx'], mjs: ['js', 'mjs', 'cjs', 'ts'], cjs: ['js', 'mjs', 'cjs', 'ts'],
  ts: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte'], tsx: ['ts', 'tsx', 'js', 'jsx'], mts: ['ts', 'mts'], cts: ['ts', 'cts'],
  go: ['go'], rs: ['rs'], rb: ['rb', 'erb', 'rake'], java: ['java', 'kt'], kt: ['kt', 'java'], cs: ['cs'], php: ['php'], swift: ['swift'], scala: ['scala'],
  c: ['c', 'h'], h: ['c', 'h', 'cc', 'cpp', 'hpp'], cc: ['cc', 'cpp', 'h', 'hpp'], cpp: ['cc', 'cpp', 'h', 'hpp'], hpp: ['cc', 'cpp', 'h', 'hpp'], ex: ['ex', 'exs'], exs: ['ex', 'exs'], sh: ['sh', 'bash'],
};
export function familyOf(file) { const ext = String(file || '').split('.').pop().toLowerCase(); return FAMILY[ext] || (ext ? [ext] : []); }
const pathspecs = file => familyOf(file).map(e => `*.${e}`);

// Lines a definition regex recognizes, per family; the same shapes deps.js:findSymbol knows.
const DEF_WORDS = '(?:def|class|function\\*?|interface|type|enum|struct|trait|impl|fn|func|module|macro_rules!)';
const defLine = name => new RegExp(`^\\s*(?:export\\s+(?:default\\s+)?)?(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?(?:(?:${DEF_WORDS})\\s+${esc(name)}\\b|(?:const|let|var|static)\\s+${esc(name)}\\s*[=:]|func\\s*\\([^)]*\\)\\s*${esc(name)}\\s*\\(|${esc(name)}\\s*[:=]\\s*(?:async\\s*)?(?:\\([^)]*\\)\\s*=>|function\\b|class\\b))`);
const callLine = name => new RegExp(`(?:^|[^\\w.])${esc(name)}\\s*!?\\(|\\.${esc(name)}\\s*\\(`);
const importLine = /^\s*(?:import\b|from\b.*\bimport\b|use\b|require\(|#include)/;
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function gitGrep(repo, args, { maxBuffer = 16 * 1024 * 1024 } = {}) {
  try {
    return execFileSync('git', ['grep', '-n', '-I', '--untracked', '--no-color', ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer, timeout: 10_000 }).toString().split('\n').filter(Boolean);
  } catch (e) {
    if (e.status === 1) return []; // no match
    return null; // not a git repository, timeout, or git missing: unknown
  }
}
const isTestPath = p => /(^|\/)(tests?|__tests__|spec)\/|(^|\/)test_[^/]*$|\.(test|spec)\.\w+$|_test\.\w+$/.test(p);
const parseLine = l => { const m = /^(.+?):(\d+):(.*)$/.exec(l); return m ? { path: m[1], line: Number(m[2]), text: m[3] } : null; };

// Where `name` occurs in files of the family of `file` (every tracked file when there is none):
// {files, sites, lines: [{path, line, text, call, def, import}]} or null when git cannot say.
export function references(repo, name, { file, limit = 400, excludeTests = false } = {}) {
  const specs = pathspecs(file);
  const raw = gitGrep(repo, ['-F', '-w', '-e', name, '--', ...(specs.length ? specs : ['.']), ':(exclude).thinker', ':(exclude)*.json', ':(exclude)*.md', ':(exclude)*.lock']);
  if (!raw) return null;
  const isDef = defLine(name), isCall = callLine(name);
  const isTest = isTestPath;
  const lines = [];
  for (const l of raw) {
    const r = parseLine(l); if (!r) continue;
    if (excludeTests && isTest(r.path)) continue;
    r.def = isDef.test(r.text); r.call = !r.def && isCall.test(r.text); r.import = !r.def && importLine.test(r.text); r.test = isTest(r.path);
    lines.push(r);
  }
  const refs = lines.filter(r => !r.def);
  return { files: new Set(refs.map(r => r.path)).size, sites: refs.filter(r => r.call).length, total: refs.length, truncated: refs.length > limit, lines: lines.slice(0, limit) };
}

// Blast radius of a symbol-level dep: how many files refer to the name outside its own definition,
// and how many of those references are calls. The symbol's own file counts when it uses the name
// beyond the definition. Short or very common names are not counted (too many false hits to mean anything).
export function fanout(repo, dep) {
  if (!dep.symbol) return null;
  const g = graph(repo); if (g === null) return null;
  if (g !== 'git') {
    // resolved callers from the graph; a symbol it knows but sees no caller of (a method called on
    // an instance the resolver did not type, say) is counted by text below rather than as unused
    const c = callers(repo, dep);
    if (c?.length) return { files: new Set(c.map(x => x.path || x.qn.split('.').slice(0, -1).join('.'))).size, sites: c.length, refs: c.length, callers: true };
  }
  const name = dep.symbol.split('.').pop();
  if (name.length < 4 || COMMON.has(name)) return null;
  const r = references(repo, name, { file: dep.path, limit: 2000 });
  if (!r) return null;
  const refs = r.lines.filter(l => !l.def && !(l.path === dep.path && l.import));
  return { files: new Set(refs.map(l => l.path)).size, sites: refs.filter(l => l.call).length, refs: refs.length };
}

// The functions that call a symbol, from the graph: [{name, qn, path?, line?}], [] when the graph
// knows the symbol and sees no caller, null without a graph (or when it does not know the symbol).
export function callers(repo, dep) {
  const g = graph(repo); if (!g || g === 'git' || !dep.symbol) return null;
  const n = cbmNeighbors(g, dep, { repo });
  return n ? n.callers : null;
}
const COMMON = new Set(['main', 'init', 'test', 'setup', 'run', 'get', 'set', 'name', 'data', 'value', 'type', 'index', 'list', 'item', 'items', 'config', 'default', 'update', 'create', 'delete', 'remove', 'handle', 'handler', 'render', 'load', 'save', 'open', 'close', 'read', 'write', 'start', 'stop', 'send', 'call', 'apply', 'self', 'this', 'super', 'props', 'state', 'error', 'result', 'response', 'request', 'options', 'params', 'args', 'constructor', 'toString', 'length']);

// Attach fanout to the symbol-level deps of a note (at most `max` git greps). THINKER_FANOUT=off skips it.
export function annotateFanout(repo, deps, { max = 8 } = {}) {
  if (process.env.THINKER_FANOUT === 'off') return deps;
  let n = 0;
  return (deps || []).map(d => {
    if (!d.symbol || d.missing || d.symbolMissing || n >= max) return d;
    n++;
    const f = fanout(repo, d);
    const out = { ...d }; if (f) out.fanout = f; else delete out.fanout;
    return out;
  });
}
export { renderFanout } from './rank.js';

const KEYWORDS = new Set(`if for while switch return function def class catch print len range str int float bool list dict set tuple isinstance issubclass super require import typeof new await async elif with assert raise except yield lambda match case Some Ok Err None println format vec panic assert_eq unwrap expect into from as_ref as_mut clone to_string push pop map filter reduce forEach some every find includes join split slice splice concat keys values entries then catch finally resolve reject setTimeout setInterval parseInt parseFloat String Number Boolean Array Object Promise Error JSON Math console log warn error info debug test describe it expect beforeEach afterEach mock fn sorted enumerate zip getattr setattr hasattr type id hash iter next open repr any all min max sum abs round sort reverse append extend insert update get items strip lower upper replace startswith endswith decode encode make append cap copy delete close defer go select chan panic recover`.split(/\s+/));

// Identifiers the definition calls that are defined in this repository, resolved by one git grep
// for definition lines: [{name, path, line}], in order of first call, at most `limit`.
export function callees(repo, dep, { limit = 12 } = {}) {
  const g = graph(repo); if (g === null) return null;
  if (g !== 'git') {
    const n = cbmNeighbors(g, dep, { repo });
    if (n) return n.callees.filter(c => c.path).slice(0, limit).map(c => ({ name: c.name, defs: [{ path: c.path, line: c.line }] }));
  }
  const b = symbolBlock(repo, dep, 400);
  if (!b) return null;
  const self = (dep.symbol || '').split('.').pop();
  const code = b.text.replace(/\/\/.*$|#.*$/gm, '').replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""'); // comments and strings out, roughly
  const names = [], method = new Set(); // method: only ever called as `x.name(`, so a method definition is the match
  for (const m of code.matchAll(/(?<![\w.])([A-Za-z_]\w{2,})\s*!?\(|\.([A-Za-z_]\w{2,})\s*\(/g)) {
    const n = m[1] || m[2];
    if (n === self || KEYWORDS.has(n)) continue;
    if (!names.includes(n)) { names.push(n); if (m[2]) method.add(n); }
    if (m[1]) method.delete(n);
    if (names.length >= 40) break;
  }
  if (!names.length) return [];
  const alt = names.map(esc).join('|');
  const sp = '[[:space:]]';
  const specs = pathspecs(dep.path);
  const raw = gitGrep(repo, ['-E', '-e', `(def|class|function|fn|func|type|interface|struct|trait|enum)${sp}+(${alt})[^[:alnum:]_]`, '-e', `(const|let|var)${sp}+(${alt})${sp}*[=:]`, '-e', `func${sp}*\\([^)]*\\)${sp}*(${alt})${sp}*\\(`, '--', ...(specs.length ? specs : ['.']), ':(exclude).thinker']);
  if (!raw) return null;
  const found = new Map();
  for (const l of raw) {
    const r = parseLine(l); if (!r) continue;
    if (r.path === dep.path && r.line >= b.start && r.line <= b.start + b.total) continue; // the definition itself
    const m = r.text.match(new RegExp(`\\b(${alt})\\b`)); if (!m) continue;
    const n = m[1];
    // a method call resolves to a method: indented (or a Go receiver), never a const
    if (method.has(n) && ((!/^\s/.test(r.text) && !/^func\s*\(/.test(r.text)) || /\b(?:const|let|var)\s/.test(r.text))) continue;
    if (isTestPath(r.path) && !isTestPath(dep.path)) continue; // test helpers are not what production code calls
    if (!found.has(n)) found.set(n, []);
    if (found.get(n).length < 2) found.get(n).push({ path: r.path, line: r.line });
  }
  return names.filter(n => found.has(n)).slice(0, limit).map(n => ({ name: n, defs: found.get(n) }));
}

// Definitions of a bare name anywhere in the repository: [{path, line, text}], for a pointer without a file.
export function findDefinitions(repo, name, { limit = 10 } = {}) {
  const g = graph(repo); if (g === null) return null;
  if (g !== 'git') {
    const hits = cbmSearch(g, `^${esc(name)}$`, { limit: Math.max(limit, 20) });
    if (hits) return hits.filter(h => h.line).slice(0, limit).map(h => ({ path: h.path, line: h.line, text: `${h.label.toLowerCase()} ${h.qn.split('.').slice(-2).join('.')}` }));
  }
  const sp = '[[:space:]]';
  const raw = gitGrep(repo, ['-E', '-e', `(def|class|function|fn|func|type|interface|struct|trait|enum|impl)${sp}+${esc(name)}[^[:alnum:]_]`, '-e', `(const|let|var)${sp}+${esc(name)}${sp}*[=:]`, '-e', `func${sp}*\\([^)]*\\)${sp}*${esc(name)}${sp}*\\(`, '--', '.', ':(exclude).thinker', ':(exclude)*.md', ':(exclude)*.json']);
  if (!raw) return null;
  return raw.map(parseLine).filter(Boolean).slice(0, limit);
}

// The definitions a file holds: [{name, parent, kind, line, end}], by the parser when loaded (it
// reads the working tree, so it is exact), else from the graph, else by regex.
export function outline(repo, file, { limit = 80 } = {}) {
  const abs = repoFile(repo, file); if (!abs) return null;
  let text; try { text = fs.readFileSync(abs, 'utf8'); } catch { return null; }
  if (astReady(file)) { const d = definitions(text, file); if (d) return d.slice(0, limit).map(x => ({ name: x.name, parent: x.parent, kind: x.kind, line: x.start + 1, end: x.end })); }
  const g = graph(repo);
  if (g && g !== 'git') { const o = cbmOutline(g, file, { limit }); if (o?.length) return o; }
  const out = []; const lines = text.split('\n');
  const re = new RegExp(`^(\\s*)(?:export\\s+(?:default\\s+)?)?(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?(?:(${DEF_WORDS})\\s+([A-Za-z_]\\w*)|(?:const|let|var)\\s+([A-Za-z_]\\w*)\\s*[=:]\\s*(?:async\\s*)?(?:\\([^)]*\\)\\s*=>|function\\b|class\\b)|func\\s*\\([^)]*\\)\\s*([A-Za-z_]\\w*)\\s*\\()`);
  const parents = []; // [{name, indent}] for Python-style nesting
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const m = re.exec(lines[i]); if (!m) continue;
    const indent = m[1].length; const name = m[3] || m[4] || m[5]; const kind = m[2] || (m[5] ? 'method' : 'const');
    while (parents.length && parents[parents.length - 1].indent >= indent) parents.pop();
    out.push({ name, parent: parents.length ? parents[parents.length - 1].name : null, kind, line: i + 1 });
    if (/^(class|struct|impl|trait|interface|module|enum)$/.test(kind)) parents.push({ name, indent });
  }
  return out;
}
