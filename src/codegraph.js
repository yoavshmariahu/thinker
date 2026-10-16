// One hop of the call graph around a symbol: where a name is referenced (callers, blast radius)
// and which repository symbols a definition calls (callees). Everything is answered by `git grep`
// without an index: approximate by design, word matches on the language family of the file, and
// good enough to say "6 call sites in 3 files" next to a pointer and to spare the agent its own
// greps. A graph engine (codebase-memory-mcp) was measured against this on click and kept only as
// the benchmarks' baseline (bench/eval-support/cbm.js, research/cbm-comparison).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repoFile, symbolBlock, locateSymbol, blockEnd, langOf } from './deps.js';
import { definitions, astReady } from './ast.js';
import { tokenize } from './rank.js';

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
const NORM_KIND = { def: 'function', fn: 'function', func: 'function', 'function*': 'function', 'macro_rules!': 'macro' };
const defLine = name => new RegExp(`^\\s*(?:export\\s+(?:default\\s+)?)?(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?(?:(?:${DEF_WORDS})\\s+${esc(name)}\\b|(?:const|let|var|static)\\s+${esc(name)}\\s*[=:]|func\\s*\\([^)]*\\)\\s*${esc(name)}\\s*\\(|${esc(name)}\\s*[:=]\\s*(?:async\\s*)?(?:\\([^)]*\\)\\s*=>|function\\b|class\\b))`);
const callLine = name => new RegExp(`(?:^|[^\\w.])${esc(name)}\\s*!?\\(|\\.${esc(name)}\\s*\\(`);
const importLine = /^\s*(?:import\b|from\b.*\bimport\b|use\b|require\(|#include)/;
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Untracked files a search must still reach (a file the agent just wrote), listed once a second per
// checkout: `git grep --untracked` walks every ignored directory to find them, 4.6 s of a 12 s scan on
// PostHog for its 6 untracked entries (2026-10-16), where listing them takes 0.3 s.
const untrackedSeen = new Map();
function untrackedFiles(repo) {
  const hit = untrackedSeen.get(repo);
  if (hit && Date.now() - hit.at < 1000) return hit.files;
  let files = [];
  try { files = execFileSync('git', ['ls-files', '-o', '--exclude-standard', '-z'], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 << 20, timeout: 10_000 }).toString().split('\0').filter(f => f && !f.endsWith('/')); } catch { files = null; }  // a trailing slash: a nested checkout, not this repository's code
  untrackedSeen.set(repo, { at: Date.now(), files });
  return files;
}
// The pathspecs git grep takes here, matched in JS for the untracked files: `.`, a path or prefix, a
// `*.ext` glob (any directory, as git matches it), and `:(exclude)` of either.
const specMatcher = specs => {
  const re = g => new RegExp('^' + g.split('*').map(esc).join('.*') + '(/|$)');
  const inc = [], exc = [];
  for (const sp of specs) { const m = /^:\(exclude\)(.*)$/.exec(sp); (m ? exc : inc).push(m ? m[1] : sp); }
  const test = (g, f) => g === '.' || (g.includes('*') ? re(g).test(f) : f === g || f.startsWith(g.replace(/\/$/, '') + '/'));
  return f => (!inc.length || inc.some(g => test(g, f))) && !exc.some(g => test(g, f));
};
function gitGrep(repo, args, { maxBuffer = 16 * 1024 * 1024 } = {}) {
  const dash = args.indexOf('--');
  const pats = dash >= 0 ? args.slice(0, dash) : args, specs = dash >= 0 ? args.slice(dash + 1) : [];
  const run = argv => {
    try { return execFileSync('git', argv, { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer, timeout: 10_000 }).toString().split('\n').filter(Boolean); }
    catch (e) { if (e.status === 1) return []; return null; } // 1: no match; else not a repository, a timeout, or git missing
  };
  const tracked = run(['grep', '-n', '-I', '--no-color', ...args]);
  if (tracked === null) return null;
  const extra = untrackedFiles(repo);
  if (extra === null) { const all = run(['grep', '-n', '-I', '--untracked', '--no-color', ...args]); return all === null ? null : dropNested(repo, all); }
  const files = extra.filter(specMatcher(specs.length ? specs : ['.']));
  if (!files.length) return tracked;
  const more = [];
  for (let k = 0; k < files.length; k += 500) { const part = run(['grep', '--no-index', '-n', '-I', '--no-color', ...pats, '--', ...files.slice(k, k + 500)]); if (part === null) return null; more.push(...part); }
  return [...tracked, ...dropNested(repo, more)];
}
// a checkout nested under this one (a benchmark's clone, a worktree left in a run directory) is not this
// repository's code; judged once per directory per call
function dropNested(repo, lines) {
  const nested = new Map();
  const inNested = file => {
    const seen = []; let dir = path.posix.dirname(file), hit = false;
    for (; dir && dir !== '.' && dir !== '/'; dir = path.posix.dirname(dir)) {
      if (nested.has(dir)) { hit = nested.get(dir); break; }
      seen.push(dir);
      if (fs.existsSync(path.join(repo, dir, '.git'))) { hit = true; break; }
    }
    for (const d of seen) nested.set(d, hit);
    return hit;
  };
  return lines.filter(l => !inNested(l.slice(0, l.indexOf(':'))));
}
export const isTestPath = p => /(^|\/)(tests?|__tests__|__mocks__|spec)\/|(^|\/)test_[^/]*$|\.(test|spec)\.\w+$|_test\.\w+$/.test(p);
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
  const name = dep.symbol.split('.').pop();
  if (!countable(name)) return null;
  const r = references(repo, name, { file: dep.path, limit: 2000 });
  if (!r) return null;
  const refs = r.lines.filter(l => !l.def && !(l.path === dep.path && l.import));
  return { files: new Set(refs.map(l => l.path)).size, sites: refs.filter(l => l.call).length, refs: refs.length };
}

const COMMON = new Set(['main', 'init', 'test', 'setup', 'run', 'get', 'set', 'name', 'data', 'value', 'type', 'index', 'list', 'item', 'items', 'config', 'default', 'update', 'create', 'delete', 'remove', 'handle', 'handler', 'render', 'load', 'save', 'open', 'close', 'read', 'write', 'start', 'stop', 'send', 'call', 'apply', 'self', 'this', 'super', 'props', 'state', 'error', 'result', 'response', 'request', 'options', 'params', 'args', 'constructor', 'toString', 'length']);

// Attach fanout to the symbol-level deps of a note (at most `max` git greps).
export function annotateFanout(repo, deps, { max = 8 } = {}) {
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
// The one definition an identifier from a request names, or how many there are when it names several.
// `Class.method` needs the class in the same file (CliRunner.invoke is not Context.invoke); a dotted owner
// that is no definition at all is a module (click.option), and the name alone decides. Tests never count.
export function definitionOf(repo, ident) {
  if (!/^[A-Za-z_][\w.]*$/.test(String(ident || ''))) return { def: null, count: 0 };
  const parts = ident.split('.'), bare = parts.pop(), owner = parts.pop();
  let defs = (findDefinitions(repo, bare, { limit: 10 }) || []).filter(d => !isTestPath(d.path));
  if (owner) { const files = new Set((findDefinitions(repo, owner, { limit: 10 }) || []).map(d => d.path)); if (files.size) defs = defs.filter(d => files.has(d.path)); }
  return { def: defs.length === 1 ? defs[0] : null, count: defs.length };
}

// The definitions of each name: one fixed-string, whole-word git grep for all of them, the definition
// patterns matched here on the lines it returns. A regex scan per name took 5 s on PostHog's 53,000 files and,
// under load, ran into the 10 s timeout and answered nothing (find replayed 2026-10-16: every exact match lost,
// 10-55 s a query); the literal scan takes about 1.4 s for any number of names.
const DEF_KEYWORDS = '(?:def|class|function|fn|func|type|interface|struct|trait|enum|impl)';
const defPatterns = name => { const n = esc(name); return [new RegExp(`${DEF_KEYWORDS}\\s+${n}(?![A-Za-z0-9_])`), new RegExp(`(?:const|let|var)\\s+${n}\\s*[=:]`), new RegExp(`func\\s*\\([^)]*\\)\\s*${n}\\s*\\(`)]; };
export function findDefinitionsMany(repo, names, { limit = 10 } = {}) {
  const want = [...new Set((names || []).filter(n => /^[A-Za-z_$][\w$]*$/.test(n)))];
  const out = new Map(want.map(n => [n, []]));
  if (!want.length) return out;
  const raw = gitGrep(repo, ['-F', '-w', ...want.flatMap(n => ['-e', n]), '--', '.', ':(exclude).thinker', ':(exclude)*.md', ':(exclude)*.json']);
  if (!raw) return raw === null ? null : out;
  const pats = new Map(want.map(n => [n, defPatterns(n)]));
  for (const l of raw) {
    const r = parseLine(l); if (!r) continue;
    for (const n of want) { const list = out.get(n); if (list.length < limit && r.text.includes(n) && pats.get(n).some(p => p.test(r.text))) list.push(r); }
  }
  return out;
}
export function findDefinitions(repo, name, { limit = 10 } = {}) {
  const m = findDefinitionsMany(repo, [name], { limit });
  return m ? m.get(name) || [] : null;  // [] when the name has no definition, null when the search failed
}

// Definitions that carry the words of a query, in their name or in their body: find("flag default
// parser") lists Option.__init__, Option.add_to_parser, Option.get_default, … with their lines, so
// the agent need not grep for the words and read around every hit. One git grep counts the words
// per file (fixed strings, so a large checkout answers in a second or two), the lines of the files
// with most mentions are attributed to the definition that encloses them (outline: parser, graph or
// regex), and the graph adds definitions named by the words when the checkout is indexed. Ranked by
// how many of the words a definition covers, name matches above body mentions; tests last. A single
// identifier is matched as a name first. `scope` keeps paths that contain it (or match it as a glob).
// Returns {hits: [{path, name, parent, symbol, kind, line, end, score, mentions}], toks,
// more} or null when the checkout cannot be searched.
export const CODE_EXT = new Set([...Object.keys(FAMILY), 'vue', 'svelte', 'dart', 'lua', 'zig', 'm', 'mm', 'erb', 'rake']);
const EXCLUDES = [':(exclude).thinker', ':(exclude)*.min.js', ':(exclude)*.d.ts', ':(exclude)**/node_modules/**', ':(exclude)**/vendor/**', ':(exclude)**/dist/**', ':(exclude)**/build/**', ':(exclude)**/coverage/**', ':(exclude)**/__pycache__/**', ':(exclude)**/.next/**'];
const extOf = p => String(p).split('.').pop().toLowerCase();
const globRe = g => new RegExp('(^|/)' + g.split('**').map(p => p.split('*').map(esc).join('[^/]*')).join('.*') + (/\*$|\/$/.test(g) ? '' : '(/|$)'));
export function findSymbols(repo, query, { scope, limit = 12, files: maxFiles = 50 } = {}) {
  const q = String(query || '').trim();
  const ident = /^[A-Za-z_$][\w$]*$/.test(q) ? q : null;
  const inScope = scope ? (/[*?]/.test(scope) ? (re => p => re.test(p))(globRe(scope)) : p => p.includes(scope)) : () => true;
  // the identifiers the query names, by their own definitions (exactFirst); one that has them is searched
  // below as itself (its callers and tests), not split into words: get_parameter_source as "get", "paramet",
  // "sourc" matched most of the checkout, and common words made the scan 8 s on PostHog
  const first = exactFirst(repo, q, ident, { inScope, scope });
  const found = new Set(first.flatMap(e => [e.name, e.parent].filter(Boolean)));
  const terms = q.split(/[\s,()]+/).filter(Boolean);
  const words = terms.flatMap(t => { const n = t.split('.').pop(); return found.has(n) || found.has(t) ? [n.toLowerCase()] : tokenize(t); });
  const toks = [...new Set([...(ident ? [ident.toLowerCase()] : []), ...words])].filter(t => t.length >= 3).slice(0, 12);
  if (!toks.length) return { hits: [], toks, more: false };
  const specs = [...CODE_EXT].map(e => `*.${e}`);
  // 1. the files that mention the words, most first (tests count for less)
  const counted = gitGrep(repo, ['-c', '-F', '-i', ...toks.flatMap(t => ['-e', t]), '--', ...specs, ...EXCLUDES], { maxBuffer: 64 * 1024 * 1024 });
  if (!counted) return null;
  const files = counted.map(l => { const m = /^(.+):(\d+)$/.exec(l); return m && CODE_EXT.has(extOf(m[1])) && inScope(m[1]) ? { path: m[1], n: Number(m[2]) } : null; }).filter(Boolean)
    .sort((a, b) => (isTestPath(a.path) ? 0.3 : 1) * b.n * 0 + ((isTestPath(b.path) ? 0.3 : 1) * b.n - (isTestPath(a.path) ? 0.3 : 1) * a.n)).slice(0, maxFiles);
  // 2. their matching lines, attributed to the enclosing definition
  const cands = new Map(); // path|symbol -> candidate
  const cand = (path, d) => { const key = `${path}|${d.parent ? d.parent + '.' : ''}${d.name}`; if (!cands.has(key)) cands.set(key, { path, name: d.name, parent: d.parent || null, symbol: d.parent ? `${d.parent}.${d.name}` : d.name, kind: d.kind || 'definition', line: d.line, end: d.end || null, body: new Map(), mentions: 0 }); return cands.get(key); };
  const has = (text, t) => text.toLowerCase().includes(t);
  const lineCount = new Map(); // lines mentioning each word: common words weigh less below
  if (files.length) {
    const lines = gitGrep(repo, ['-F', '-i', ...toks.flatMap(t => ['-e', t]), '--', ...files.map(f => f.path)], { maxBuffer: 64 * 1024 * 1024 }) || [];
    const byFile = new Map();
    for (const l of lines.slice(0, 40000)) { const r = parseLine(l); if (r) { if (!byFile.has(r.path)) byFile.set(r.path, []); byFile.get(r.path).push(r); } }
    for (const rows of byFile.values()) for (const r of rows) for (const t of toks) if (has(r.text, t)) lineCount.set(t, (lineCount.get(t) || 0) + 1);
    for (const [file, rows] of byFile) {
      try { if (fs.statSync(repoFile(repo, file)).size > 400_000 ) continue; } catch { continue; } // generated or vendored: not where a definition is looked for
      const defs = (outline(repo, file, { limit: 5000 }) || []).slice().sort((a, b) => a.line - b.line);
      if (!defs.length) continue;
      // the regex outline gives no end: the block by brace or indentation matching, else until the next
      // definition. Taking the next definition always gave a one-line const the lines after it (the
      // CLI's help text after `const mcpEntry = () => ...`), and it came first for unrelated queries.
      // The block matcher is thrown off by braces in strings, so the block also ends before the next
      // definition indented no deeper than this one.
      let lines = null; try { lines = fs.readFileSync(repoFile(repo, file), 'utf8').split('\n'); } catch {}
      const indent = d => lines ? /^\s*/.exec(lines[d.line - 1] || '')[0].length : 0;
      // ends are found only for the definitions a matching line could sit in, the nearest first: matching
      // every definition's block in the 50 files cost 5 s a query on PostHog (2026-10-16)
      const endOf = i => {
        if (defs[i].end) return defs[i].end;
        const sibling = defs.slice(i + 1).find(d => d.line > defs[i].line && indent(d) <= indent(defs[i]));
        const cap = sibling ? sibling.line - 1 : Infinity;
        // the block from the line the outline gave: locating the name again rescanned the whole file per definition
        const end = lines && defs[i].line >= 1 ? blockEnd(lines, defs[i].line - 1, langOf(file)) : null;
        return (defs[i].end = Number.isFinite(end) && end >= defs[i].line - 1 ? Math.min(end, cap) : (i + 1 < defs.length ? defs[i + 1].line - 1 : Infinity));
      };
      for (const d of defs) cand(file, d);
      for (const r of rows) {
        let enc = null; // the innermost definition enclosing the line: the latest-starting one whose block reaches it
        let k = defs.length - 1; while (k >= 0 && defs[k].line > r.line) k--;
        for (; k >= 0; k--) if (r.line <= endOf(k)) { enc = defs[k]; break; }
        if (enc) cand(file, enc).end = enc.end;
        if (!enc) continue;
        const c = cand(file, enc); c.mentions++;
        for (const t of toks) if (has(r.text, t)) c.body.set(t, (c.body.get(t) || 0) + 1);
      }
    }
  }
  // 4. score: a word in the name above one in the body above one in the path; a word on few lines
  // weighs more than one on hundreds; a definition that covers more of the words comes first
  const weight = t => 1 / (1 + Math.log(1 + (lineCount.get(t) || 0) / 20));
  let scored = [];
  for (const c of cands.values()) {
    const nl = c.name.toLowerCase(), nt = new Set(tokenize(c.name)), pt = new Set(tokenize(c.path)), par = (c.parent || '').toLowerCase();
    let s = 0, cover = 0;
    for (const t of toks) {
      const w = 0.4 + 0.6 * weight(t);
      const base = nt.has(t) ? 3 : nl.includes(t) ? 1.5 : par.includes(t) ? 1.5 : c.body.has(t) ? 1.2 * (1 + Math.min(1, Math.log10(c.body.get(t)))) : pt.has(t) ? 0.5 : 0;
      if (!base) continue;
      s += base * w; cover += weight(t);
    }
    if (!cover) continue;
    const span = c.end && c.end !== Infinity ? c.end - c.line + 1 : 50;
    if (span > 1500) continue; // a generated blob, not a definition anyone reads
    s += 2.5 * cover + Math.min(1, c.mentions * 0.1);
    if (c.kind === 'class' || c.kind === 'interface' || c.kind === 'struct') s -= 1.5; // its header mentions everything its methods do
    if (ident && nl === ident.toLowerCase()) s += 5;
    if (c.kind === 'const' || c.kind === 'variable' || c.kind === 'field' || c.kind === 'property') s -= 0.5;
    s -= Math.min(8, Math.max(0, 1.2 * Math.log2(span / 100))); // a 400-line body mentions everything
    s -= Math.min(1, c.path.split('/').length * 0.05) + Math.min(1, c.name.length / 60);
    if (isTestPath(c.path)) s *= 0.4;
    scored.push({ ...c, score: Math.round(s * 100) / 100 });
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line);
  // The identifiers the query names come first, each by its own definitions, whatever their size: the word
  // search splits convert_type into "convert" and "type" and ranks File.convert above it, and skips files over
  // 400 kB and bodies over 1,500 lines (find SqlAlchemyStore on mlflow). Replaying 73 real agent queries
  // (2026-10-16), 43 named identifiers, often several at once ("get_pager_file echo_via_pager"); only 26 of
  // the 69 came back first. A class named beside a member name ("to_info_dict Option Parameter") puts that
  // member of the class first (Option.to_info_dict), then the class.
  if (first.length) {
    const top = (scored[0]?.score || 0) + 10 + first.length;
    const keys = new Set(first.map(e => `${e.path}|${e.symbol}`));
    scored = [...first.map((e, k) => ({ ...e, score: top - k })), ...scored.filter(c => !keys.has(`${c.path}|${c.symbol}`))];
  }
  const hits = scored.slice(0, limit).map(h => { const o = { ...h }; delete o.body; return o; });
  for (const h of hits) { const b = symbolBlock(repo, { path: h.path, symbol: h.symbol }, 1); if (b) { h.line = b.start; h.end = b.start + b.total - 1; } else if (h.end === Infinity) h.end = null; } // exact spans for what is shown
  return { hits, toks, more: scored.length > hits.length };
}
// The definitions a query names by identifier, in the query's order: a member of a class the query also
// names first, then each identifier's own definitions, then the classes. Terms that look like code
// (snake_case, camelCase, PascalCase, Owner.member), or the whole query when it is one identifier. Tests count
// only under a test path. At most four definitions a name.
const CLASSY = new Set(['class', 'interface', 'struct', 'trait', 'enum', 'type']);
function exactFirst(repo, q, ident, { inScope, scope }) {
  const terms = q.split(/[\s,()]+/).filter(Boolean);
  const looksLikeCode = w => /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)?$/.test(w) && (/_/.test(w) || /[a-z][A-Z]/.test(w) || /^[A-Z]/.test(w) || w.includes('.'));
  const named = ident ? [ident] : [...new Set(terms.filter(looksLikeCode))];
  if (!named.length) return [];
  const testsOk = Boolean(scope) && /test/i.test(scope);
  // member names a named class is asked for: the identifiers, and plain words too ("Group invoke" is Group.invoke,
  // "Option init" Option.__init__), compared without case or underscores
  const norm = w => w.toLowerCase().replace(/_/g, '');
  const bare = new Set([...named.map(t => norm(t.split('.').pop())), ...terms.filter(w => /^[a-z_]\w{2,}$/i.test(w)).map(norm)]);
  const outlines = new Map(), outlineOf = f => { if (!outlines.has(f)) outlines.set(f, outline(repo, f, { limit: 5000 }) || []); return outlines.get(f); };
  const all = findDefinitionsMany(repo, [...new Set(named.flatMap(t => t.split('.')))], { limit: 10 }) || new Map();  // one scan for every name
  const defsOf = name => (all.get(name) || []).filter(d => CODE_EXT.has(extOf(d.path)) && inScope(d.path) && (testsOk || !isTestPath(d.path)));
  const entry = (path, o) => ({ path, name: o.name, parent: o.parent || null, symbol: o.parent ? `${o.parent}.${o.name}` : o.name, kind: o.kind || 'definition', line: o.line, end: o.end || null, mentions: 0 });
  const members = [], own = [], classes = [];
  for (const term of named) {
    const parts = term.split('.'), name = parts.pop(), owner = parts.pop();
    if (owner) { // Owner.member: the member inside the owner's own definitions
      for (const d of defsOf(owner).slice(0, 4)) for (const o of outlineOf(d.path)) if (o.parent === owner && o.name === name) members.push(entry(d.path, o));
      continue;
    }
    for (const d of defsOf(name).slice(0, 4)) {
      const o = outlineOf(d.path).find(x => x.line === d.line && x.name === name) || { name, line: d.line, kind: /\b(class|struct|interface|trait|enum)\b/.test(d.text) ? 'class' : 'definition' };
      if (CLASSY.has(o.kind)) {
        classes.push(entry(d.path, o));
        // the members the query names, inside this class (found through the outline, so methods with no keyword count)
        for (const m of outlineOf(d.path)) if (m.parent === name && bare.has(norm(m.name)) && m.name !== name) members.push(entry(d.path, m));
      } else own.push(entry(d.path, o));
    }
  }
  const seen = new Set(), out = [];
  for (const e of [...members, ...own, ...classes]) { const k = `${e.path}|${e.symbol}`; if (!seen.has(k)) { seen.add(k); out.push(e); } }
  return out;
}
const SKIP_KINDS = new Set(['section', 'file', 'folder', 'module', 'package', 'resource', 'branch', 'repository', 'route']);
const ci = s => s.replace(/[A-Za-z]/g, c => `[${c.toLowerCase()}${c.toUpperCase()}]`);

// The definitions a file holds: [{name, parent, kind, line, end}], by the parser when loaded (it
// reads the working tree, so it is exact), else from the graph, else by regex.
export function outline(repo, file, { limit = 80 } = {}) {
  const abs = repoFile(repo, file); if (!abs) return null;
  let text; try { text = fs.readFileSync(abs, 'utf8'); } catch { return null; }
  if (astReady(file)) { const d = outlineText(text, file, { limit }); if (d) return d; }
  return outlineText(text, file, { limit });
}

// The same over a text that is not (or not yet) in the working tree: the parser when loaded for
// the file's language, else the regex. `end` (inclusive, 1-based) is only known from the parser.
export function outlineText(text, file, { limit = 80 } = {}) {
  if (astReady(file)) { const d = definitions(text, file); if (d) return d.slice(0, limit).map(x => ({ name: x.name, parent: x.parent, kind: x.kind, line: x.start + 1, end: x.end })); }
  const out = []; const lines = text.split('\n');
  const re = new RegExp(`^(\\s*)(?:export\\s+(?:default\\s+)?)?(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?(?:(${DEF_WORDS})\\s+([A-Za-z_]\\w*)|(?:const|let|var)\\s+([A-Za-z_]\\w*)\\s*[=:]\\s*(?:async\\s*)?(?:\\([^)]*\\)\\s*=>|function\\b|class\\b)|func\\s*\\([^)]*\\)\\s*([A-Za-z_]\\w*)\\s*\\()`);
  const parents = []; // [{name, indent}] for Python-style nesting
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const m = re.exec(lines[i]); if (!m) continue;
    const indent = m[1].length; const name = m[3] || m[4] || m[5]; let kind = NORM_KIND[m[2]] || m[2] || (m[5] ? 'method' : 'const');
    while (parents.length && parents[parents.length - 1].indent >= indent) parents.pop();
    const parent = parents.length ? parents[parents.length - 1].name : null;
    if (kind === 'function' && parent) kind = 'method';
    out.push({ name, parent, kind, line: i + 1 });
    if (/^(class|struct|impl|trait|interface|module|enum)$/.test(kind)) parents.push({ name, indent });
  }
  return out;
}

// Whether a name is worth counting references of: short or very common ones hit too much to mean anything.
export function countable(name) { return typeof name === 'string' && name.length >= 4 && !COMMON.has(name); }
