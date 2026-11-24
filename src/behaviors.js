// The behavior graph (2026-11-23, the owner's design; off until `behaviors: { enabled: true }`).
//
// A repository names what it does in one file, BEHAVIORS.md: a list of behaviors, each a dotted id and one
// sentence. The dots are the graph's first kind of edge (`cart.total.discount` is a sub-behavior of `cart.total`,
// which is part of the feature `cart`); `(uses: pricing.round)` after a sentence is the second, for a behavior
// that rests on one in another branch.
//
// Code and tests say which behavior they belong to with one comment line, `behavior: <id>`, which covers
// everything beneath it until the next such line. So the link from a line of code to a behavior, and from a
// behavior to its tests, is written by whoever writes the code, kept beside it, and read here by a scanner:
// no build graph, no coverage run, no model. The owner's rules, which `checkFile` holds a file to:
//   - a top-level id is a FEATURE and everything beneath one is a BEHAVIOR, which may have sub-behaviors;
//   - a test names exactly ONE behavior, so that it stays light;
//   - a test of a whole feature is an end-to-end test, names the feature, and is kept apart under e2e/;
//   - code is tied to a behavior too (`behavior: none` is the mark for plumbing that is no behavior).
//
// A change is then read off the graph (`changesOf`): the behaviors whose code changed (modified), the ids new
// to the file (added) and the ids gone from it (deleted). `selectTests` turns that into the tests to run: the
// changed behaviors' own, their sub-behaviors', the end-to-end tests of the features above them, and the tests
// of whatever says it uses them. Everything here is a pure read of the checkout and git; the hooks that put it
// in front of an agent are in behavior-hooks.js.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const BEHAVIORS_FILE = 'BEHAVIORS.md';
export const NONE = 'none';
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // git's empty tree: the base of a repository with no commit

// ---- the file: `- cart.total: The total is the sum of price times quantity (uses: pricing.round)` ----
const ID = '[a-z0-9][a-z0-9_-]*(?:\\.[a-z0-9][a-z0-9_-]*)*';
const NODE_LINE = new RegExp(`^\\s*[-*+]\\s+\`?(${ID})\`?\\s*:\\s*(.+?)\\s*$`);
const USES = /\s*\(uses:\s*([^)]*)\)\s*$/i;

/** BEHAVIORS.md as a graph: `nodes` by id (text, parent, children, uses, line) and what is wrong with the file. */
export function parseTree(text) {
  const nodes = new Map(), errors = [];
  String(text || '').split('\n').forEach((raw, i) => {
    const m = raw.match(NODE_LINE);
    if (!m) return;
    const id = m[1];
    let say = m[2], uses = [];
    const u = say.match(USES);
    if (u) { uses = u[1].split(/[,\s]+/).filter(Boolean); say = say.slice(0, u.index).trim(); }
    if (id === NONE) { errors.push({ line: i + 1, say: '"none" marks code that is no behavior; it cannot name one' }); return; }
    if (nodes.has(id)) { errors.push({ line: i + 1, say: `${id} is named twice` }); return; }
    nodes.set(id, { id, text: say, uses, line: i + 1, parent: id.includes('.') ? id.slice(0, id.lastIndexOf('.')) : null, children: [] });
  });
  for (const n of nodes.values()) {
    if (n.parent) { const p = nodes.get(n.parent); if (p) p.children.push(n.id); else errors.push({ line: n.line, say: `${n.id} has no parent: name \`${n.parent}\` in the file first` }); }
    for (const u of n.uses) if (!nodes.has(u) || u === n.id) errors.push({ line: n.line, say: `${n.id} says it uses ${u}, which ${u === n.id ? 'is itself' : 'is not in the file'}` });
  }
  return { nodes, errors };
}
export const readTree = repo => { try { return parseTree(fs.readFileSync(path.join(repo, BEHAVIORS_FILE), 'utf8')); } catch { return parseTree(''); } };
/** A feature is a top-level id; what a light test may name is anything beneath one. */
export const isFeature = (tree, id) => tree.nodes.has(id) && !tree.nodes.get(id).parent;
const ancestors = (tree, id) => { const out = []; for (let p = tree.nodes.get(id)?.parent; p; p = tree.nodes.get(p)?.parent) out.push(p); return out; };
const descendants = (tree, id) => (tree.nodes.get(id)?.children || []).flatMap(c => [c, ...descendants(tree, c)]);

// ---- which files are code, which are tests, and which tests are the heavy kind ----
const CODE = /\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kts?|swift|cc?|h|cpp|hpp|cs|php|scala|sh|lua|exs?|dart|vue|svelte)$/i;
const TEST = /(?:^|\/)(?:tests?|__tests__|specs?|e2e)\/|(?:^|\/)test_[^/]+\.py$|[._-](?:test|spec|e2e)\.[^/]+$|_test\.(?:go|py|rb)$/i;
const E2E = /(?:^|\/)e2e\/|[._-]e2e\.[^/]+$/i;
export const isCode = rel => CODE.test(rel);
export const isTest = rel => CODE.test(rel) && TEST.test(rel);
export const isE2e = rel => isTest(rel) && E2E.test(rel);
/** The comment a tag is written with in this file's language. */
export const commentOf = rel => (/\.(?:py|rb|sh|exs?)$/i.test(rel) ? '#' : /\.lua$/i.test(rel) ? '--' : '//');

// ---- one file: its tags and, in a test file, its tests ----
const TAG = /^\s*(?:\/\/+|#+|\/\*+|\*|--|;+)\s*behavior:\s*([A-Za-z0-9._-]+)\s*(?:\*\/)?\s*$/;
// where a test starts, by language: [files, the line, the group holding its name]. An attribute (`#[test]`,
// `@Test`) names the function on a later line.
const DECLS = [
  [/\.(?:[cm]?[jt]sx?|vue|svelte)$/i, /^\s*(?:test|it)(?:\.\w+)*\s*\(\s*(?:(['"`])(.*?)\1)?/, 2],
  [/\.py$/i, /^\s*(?:async\s+)?def\s+(test\w*)\s*\(/, 1],
  [/\.go$/i, /^func\s+(Test\w*)\s*\(/, 1],
  [/\.rb$/i, /^\s*(?:(?:it|test|specify)\s+(['"])(.*?)\1|def\s+(test_\w+))/, 2],
  [/\.rs$/i, /^\s*#\[(?:\w+::)*test\b/, 0],
  [/\.(?:java|kts?|scala|cs)$/i, /^\s*(?:@(?:Test|ParameterizedTest)\b|\[(?:Test|Fact|Theory)\])/, 0],
];
const NAMED_LATER = /\b(?:fn|fun|void|def|func)\s+(\w+)|(\w+)\s*\(/;

/** A file's `behavior:` lines and its test declarations, each with its 1-based line. */
export function scan(rel, text) {
  const lines = String(text ?? '').split('\n'), tags = [], tests = [];
  if (lines.length > 1 && lines.at(-1) === '') lines.pop(); // the newline that ends the file is not a line of it
  const decl = isTest(rel) ? DECLS.find(([files]) => files.test(rel)) : null;
  lines.forEach((l, i) => {
    const t = l.match(TAG);
    if (t) { tags.push({ line: i + 1, id: t[1] }); return; }
    const d = decl && l.match(decl[1]);
    if (!d) return;
    let name = decl[2] ? d[decl[2]] || d[3] : null;
    if (!name && !decl[2]) for (let k = i + 1; k < Math.min(lines.length, i + 4) && !name; k++) { const n = lines[k].match(NAMED_LATER); name = n && (n[1] || n[2]); }
    tests.push({ line: i + 1, name: name || `line ${i + 1}` });
  });
  return { lines, tags, tests };
}
/** The tag a line sits under: the nearest above it (or on it), since a tag covers what is beneath it. */
export const tagAt = (tags, line) => { let hit = null; for (const t of tags) { if (t.line > line) break; hit = t; } return hit; };
// the tests a set of lines falls in: a test runs from its declaration to the next one, and a tag belongs to the
// test under it
function testsAt(s, lines) {
  const out = new Set();
  for (const l of lines) {
    const tagLine = s.tags.some(t => t.line === l);
    const t = tagLine ? s.tests.find(x => x.line > l) : [...s.tests].reverse().find(x => x.line <= l);
    if (t) out.add(t);
  }
  return [...out].sort((a, b) => a.line - b.line);
}
const blank = l => !String(l || '').trim();
// Lines that are nobody's behavior wherever they sit, so an edit to them is never "code tied to nothing": an
// import, a comment, a lone bracket. Without this every file's first lines would need a tag of their own.
export const PLUMBING = /^\s*(?:(?:\/\/|#|\/\*|\*|--).*|import\b.*|from\s+\S+\s+import\b.*|export\s+(?:\*|\{[^}]*\})\s+from\b.*|(?:const|let|var)\s+[\w{},\s]+=\s*require\(.*|require\(.*|use\s+[\w:]+.*;|package\s+[\w.]+;?|#include\b.*|using\s+[\w.]+;|['"]use strict['"];?|[\])}({\[;,]+)\s*$/;

/**
 * What is wrong with a file under the rules, as `{ rel, line, kind, ... }`. `lines` (a Set) narrows it to what
 * an edit touched: a repository takes the rules up one change at a time, so a file is held to them where it is
 * being written, and its untouched lines are left for the curation pass.
 */
export function checkFile(rel, text, tree, { lines = null } = {}) {
  const s = scan(rel, text), out = [], known = id => tree.nodes.has(id);
  if (isTest(rel)) {
    for (const t of lines ? testsAt(s, lines) : s.tests) {
      const tag = tagAt(s.tags, t.line);
      if (!tag) out.push({ rel, line: t.line, kind: 'untagged-test', name: t.name });
      else if (tag.id === NONE) out.push({ rel, line: tag.line, kind: 'test-of-nothing', name: t.name });
      else if (!known(tag.id)) out.push({ rel, line: tag.line, kind: 'unknown', id: tag.id });
      else if (isE2e(rel) && !isFeature(tree, tag.id)) out.push({ rel, line: tag.line, kind: 'e2e-on-behavior', id: tag.id, name: t.name });
      else if (!isE2e(rel) && isFeature(tree, tag.id)) out.push({ rel, line: tag.line, kind: 'light-on-feature', id: tag.id, name: t.name });
    }
    // two tags with nothing between them: one test naming two behaviors
    s.tags.forEach((a, i) => {
      const b = s.tags[i + 1];
      if (!b || (lines && !lines.has(a.line) && !lines.has(b.line))) return;
      if (s.lines.slice(a.line, b.line - 1).every(blank)) out.push({ rel, line: b.line, kind: 'two-behaviors', id: `${a.id}, ${b.id}` });
    });
  } else {
    for (const tag of s.tags) if ((!lines || lines.has(tag.line)) && tag.id !== NONE && !known(tag.id)) out.push({ rel, line: tag.line, kind: 'unknown', id: tag.id });
    // changed code under no tag at all, as runs of lines
    const loose = lines ? [...lines].sort((a, b) => a - b).filter(l => !blank(s.lines[l - 1]) && !PLUMBING.test(s.lines[l - 1]) && !tagAt(s.tags, l)) : [];
    for (let i = 0; i < loose.length;) { let j = i; while (j + 1 < loose.length && loose[j + 1] - loose[j] <= 3) j++; out.push({ rel, line: loose[i], to: loose[j], kind: 'untied' }); i = j + 1; }
  }
  const seen = new Set();
  return out.filter(v => { const k = `${v.kind}:${v.line}:${v.id || ''}`; return seen.has(k) ? false : seen.add(k); });
}

/** A violation in words, with the fix: what the agent reads when an edit is refused or a turn is held. */
export function sayViolation(v) {
  const c = commentOf(v.rel), at = `${v.rel}:${v.line}${v.to && v.to !== v.line ? `-${v.to}` : ''}`;
  switch (v.kind) {
    case 'untagged-test': return `${at} test "${v.name}" names no behavior. Put the line \`${c} behavior: <id>\` above it, with the one id from ${BEHAVIORS_FILE} it proves.`;
    case 'test-of-nothing': return `${at} test "${v.name}" is under \`behavior: none\`. A test proves a behavior: name the one it proves.`;
    case 'unknown': return `${at} names \`${v.id}\`, which is not in ${BEHAVIORS_FILE}. Use an id that is there, or add \`- ${v.id}: <one sentence>\` to ${BEHAVIORS_FILE} first.`;
    case 'e2e-on-behavior': return `${at} test "${v.name}" is an end-to-end test of \`${v.id}\`, which is one behavior. End-to-end tests cover a whole feature (a top-level id): name the feature, or move the test out of e2e.`;
    case 'light-on-feature': return `${at} test "${v.name}" names \`${v.id}\`, a whole feature. A light test proves one behavior beneath it: name that one, or move the test under e2e/ if it runs the whole feature.`;
    case 'two-behaviors': return `${at} stacks two behaviors (${v.id}) on one test. One test, one behavior: split it in two.`;
    case 'untied': return `${at} is code tied to no behavior. Put the line \`${c} behavior: <id>\` above it: an id from ${BEHAVIORS_FILE}, a new one added there first, or \`none\` for plumbing that is no behavior.`;
    default: return `${at} ${v.kind}`;
  }
}

// ---- what an edit would leave in the file, and which of its lines are new ----
/** `{ abs, before, after }` for an Edit, Write or MultiEdit; null where the tool would fail by itself. */
export function editOf(toolName, input = {}, cwd = '') {
  const file = input.file_path || input.path;
  if (!file || !/^(?:Edit|Write|MultiEdit)$/.test(toolName)) return null;
  const abs = path.resolve(cwd, file);
  let before = null; try { before = fs.readFileSync(abs, 'utf8'); } catch {}
  if (toolName === 'Write') return { abs, before, after: String(input.content ?? '') };
  let after = before ?? '';
  for (const e of toolName === 'MultiEdit' ? input.edits || [] : [input]) {
    const from = String(e.old_string ?? ''), to = String(e.new_string ?? '');
    if (!from) { after = after || to; continue; }
    if (!after.includes(from)) return null;
    after = e.replace_all ? after.split(from).join(to) : after.replace(from, () => to);
  }
  return { abs, before, after };
}
/**
 * The 1-based lines of `after` that are not in `before`. `edges` adds the two lines around a pure removal, so
 * taking a tag off a test still counts as touching the test.
 */
export function changedLines(before, after, { edges = false } = {}) {
  const b = String(after ?? '').split('\n');
  if (before == null) return new Set(b.map((_, i) => i + 1));
  const a = before.split('\n');
  let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0; while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const old = new Map(); for (let i = s; i < a.length - e; i++) old.set(a[i], (old.get(a[i]) || 0) + 1);
  const out = new Set();
  for (let i = s; i < b.length - e; i++) { const n = old.get(b[i]) || 0; if (n) old.set(b[i], n - 1); else out.add(i + 1); }
  if (edges && !out.size && a.length !== b.length) { if (s >= 1) out.add(s); if (s + 1 <= b.length) out.add(s + 1); }
  return out;
}

// ---- git: what changed since a base commit ----
const git = (cwd, args) => { try { return execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }); } catch { return null; } };
/** The commit a session's changes are counted from: HEAD as it stood, or the empty tree where there is none. */
export const baseOf = repo => (git(repo, ['rev-parse', '--verify', '-q', 'HEAD']) || '').trim() || EMPTY_TREE;
const lineCount = file => { try { return fs.readFileSync(file, 'utf8').split('\n').length; } catch { return 0; } };

/** Every file that differs from `base`, committed or not: `{ rel, was, now, added, deleted }`, lines 1-based. */
export function diffOf(repo, base) {
  const files = new Map();
  const at = rel => files.get(rel) || files.set(rel, { rel, was: [], now: [], gaps: [], added: false, deleted: false }).get(rel);
  let cur = null, old = null;
  for (const line of (git(repo, ['diff', '--unified=0', '--no-color', '--no-ext-diff', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', base, '--', '.']) || '').split('\n')) {
    if (line.startsWith('diff --git ')) { cur = null; old = null; continue; }
    // a name with a space in it ends in a tab on these two lines
    if (line.startsWith('--- ')) { old = line === '--- /dev/null' ? null : line.slice(6).replace(/\t$/, ''); continue; }
    if (line.startsWith('+++ ')) { const now = line === '+++ /dev/null' ? null : line.slice(6).replace(/\t$/, ''); cur = at(now || old); cur.added = !old; cur.deleted = !now; continue; }
    const h = cur && line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!h) continue;
    const n = v => (v === undefined ? 1 : Number(v));
    for (let i = 0; i < n(h[2]); i++) cur.was.push(Number(h[1]) + i);
    for (let i = 0; i < n(h[4]); i++) cur.now.push(Number(h[3]) + i);
    if (n(h[4]) === 0) cur.gaps.push(Number(h[3]), Number(h[3]) + 1); // a pure removal: the lines either side of it
  }
  for (const rel of (git(repo, ['ls-files', '--others', '--exclude-standard', '-z']) || '').split('\0').filter(Boolean)) {
    const f = at(rel); f.added = true; f.now = Array.from({ length: lineCount(path.join(repo, rel)) }, (_, i) => i + 1);
  }
  return [...files.values()].sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

/**
 * A change, read off the graph: the behaviors whose code or sentence changed (`modified`), whose tests alone
 * changed (`tests`), that are new to BEHAVIORS.md (`added`) or gone from it (`deleted`); the changed code under
 * no behavior (`untied`); what the changed files break (`violations`); and `sig`, a hash of the changed files as
 * they stand, which is how a later look knows whether anything moved since a test run.
 */
export function changesOf(repo, base, tree = readTree(repo)) {
  const before = parseTree(git(repo, ['show', `${base}:${BEHAVIORS_FILE}`]) || '');
  const added = [...tree.nodes.keys()].filter(id => !before.nodes.has(id));
  const deleted = [...before.nodes.keys()].filter(id => !tree.nodes.has(id));
  const touched = new Map(); // id -> { files, code, tests, reworded }
  const touch = (id, rel, how) => { if (!tree.nodes.has(id)) return; const t = touched.get(id) || touched.set(id, { files: new Set() }).get(id); t.files.add(rel); t[how] = true; };
  for (const [id, n] of tree.nodes) { const was = before.nodes.get(id); if (was && (was.text !== n.text || was.uses.join() !== n.uses.join())) touch(id, BEHAVIORS_FILE, 'reworded'); }
  const violations = [], sig = crypto.createHash('sha1');
  for (const f of diffOf(repo, base)) {
    if (!isCode(f.rel) && f.rel !== BEHAVIORS_FILE) continue;
    let nowText = null; if (!f.deleted) { try { nowText = fs.readFileSync(path.join(repo, f.rel), 'utf8'); } catch {} }
    sig.update(`${f.rel}\0${nowText ?? '\u0001gone'}\0`);
    if (f.rel === BEHAVIORS_FILE) continue;
    const how = isTest(f.rel) ? 'tests' : 'code';
    const read = (text, lines, gaps = []) => {
      const s = scan(f.rel, text);
      if (how === 'tests') for (const t of testsAt(s, [...lines, ...gaps])) { const tag = tagAt(s.tags, t.line); if (tag) touch(tag.id, f.rel, how); }
      else for (const l of lines) { const tag = !blank(s.lines[l - 1]) && tagAt(s.tags, l); if (tag) touch(tag.id, f.rel, how); }
    };
    if (nowText != null) { read(nowText, f.now, f.gaps); violations.push(...checkFile(f.rel, nowText, tree, { lines: new Set([...f.now, ...(how === 'tests' ? f.gaps : [])]) })); }
    // what was taken out belonged to a behavior as well: read from the file as it was
    if (!f.added && f.was.length) { const wasText = git(repo, ['show', `${base}:${f.rel}`]); if (wasText != null) read(wasText, f.was); }
  }
  const ids = how => [...touched].filter(([id, t]) => how(t) && !added.includes(id)).map(([id]) => id).sort();
  return {
    base, added, deleted, touched, sig: sig.digest('hex').slice(0, 16),
    modified: ids(t => t.code || t.reworded), tests: ids(t => t.tests && !t.code && !t.reworded),
    untied: violations.filter(v => v.kind === 'untied'), violations: violations.filter(v => v.kind !== 'untied'), errors: tree.errors,
  };
}

/** Where every behavior lives: its tests and its code, from every file in the checkout that carries a tag. */
export function indexOf(repo, tree = readTree(repo)) {
  const tests = new Map(), code = new Map(), unknown = [];
  const push = (m, id, v) => (m.get(id) || m.set(id, []).get(id)).push(v);
  for (const rel of (git(repo, ['grep', '--untracked', '-l', '-I', '-z', '-e', 'behavior:', '--', '.']) || '').split('\0').filter(Boolean)) {
    if (!isCode(rel)) continue;
    let text; try { text = fs.readFileSync(path.join(repo, rel), 'utf8'); } catch { continue; }
    const s = scan(rel, text);
    if (isTest(rel)) for (const t of s.tests) { const tag = tagAt(s.tags, t.line); if (tag && tag.id !== NONE) push(tests, tag.id, { rel, line: t.line, name: t.name, e2e: isE2e(rel) }); }
    else s.tags.forEach((tag, i) => { if (tag.id !== NONE) push(code, tag.id, { rel, from: tag.line, to: (s.tags[i + 1]?.line ?? s.lines.length + 1) - 1 }); });
    for (const tag of s.tags) if (tag.id !== NONE && !tree.nodes.has(tag.id)) unknown.push({ rel, line: tag.line, id: tag.id, kind: 'unknown' });
  }
  return { tests, code, unknown };
}

/**
 * The tests a change has to pass, each with why it is there, and what the change still owes the graph
 * (`problems`, in words). A behavior's own tests; its sub-behaviors' (code tied to a feature is shared by them);
 * the end-to-end tests of the features above it; and the tests of every behavior that says it uses it.
 */
export function selectTests(tree, idx, ch) {
  const direct = [...new Set([...ch.modified, ...ch.added, ...ch.tests])].filter(id => tree.nodes.has(id));
  const why = new Map(); // rel -> Map(id -> how it is related)
  const add = (id, as) => { for (const t of idx.tests.get(id) || []) { const w = why.get(t.rel) || why.set(t.rel, new Map()).get(t.rel); if (!w.has(id)) w.set(id, as); } };
  for (const id of direct) {
    add(id, 'own');
    for (const d of descendants(tree, id)) add(d, `part of ${id}`);
    for (const a of ancestors(tree, id)) add(a, `the ${isFeature(tree, a) ? 'feature' : 'behavior'} above ${id}`);
  }
  // whatever rests on a changed behavior, or on a feature it is part of, and whatever rests on those
  const reached = new Set(direct);
  for (let grew = true; grew;) {
    grew = false;
    for (const n of tree.nodes.values()) {
      if (reached.has(n.id)) continue;
      const on = n.uses.find(u => [...reached].some(c => c === u || ancestors(tree, c).includes(u)));
      if (on) { reached.add(n.id); add(n.id, `uses ${on}`); grew = true; }
    }
  }
  const tests = [...why].map(([rel, w]) => ({ rel, e2e: isE2e(rel), why: [...w].map(([id, as]) => ({ id, as })) })).sort((a, b) => Number(a.e2e) - Number(b.e2e) || (a.rel < b.rel ? -1 : 1));
  const held = id => (idx.tests.get(id) || []).length > 0, tied = id => (idx.code.get(id) || []).length > 0, c = commentOf(tests[0]?.rel || 'x.js');
  // a behavior is held by a test of its own once it has code of its own or nothing beneath it; a feature is
  // held by its behaviors, and its end-to-end tests are extra
  const leaf = id => !tree.nodes.get(id).children.length, needsTest = id => !isFeature(tree, id) && (leaf(id) || tied(id)) && !held(id);
  const problems = [
    ...ch.errors.map(e => `${BEHAVIORS_FILE}:${e.line} ${e.say}.`),
    ...ch.violations.map(sayViolation), ...ch.untied.map(sayViolation),
    ...ch.added.filter(needsTest).map(id => `\`${id}\` is new and no test names it. Write one light test under \`${c} behavior: ${id}\`.`),
    ...ch.added.filter(id => !isFeature(tree, id) && leaf(id) && !tied(id)).map(id => `\`${id}\` is new and no code is tied to it. Put \`${c} behavior: ${id}\` above the code that implements it.`),
    ...ch.modified.filter(needsTest).map(id => `\`${id}\` changed and no test names it. Write one light test under \`${c} behavior: ${id}\`.`),
    ...idx.unknown.filter(u => ch.deleted.includes(u.id)).map(u => `${u.rel}:${u.line} still names \`${u.id}\`, which this change removed from ${BEHAVIORS_FILE}. Retag what is under it or take it out.`),
  ];
  return { direct, tests, files: tests.map(t => t.rel), problems: [...new Set(problems)] };
}

/** The command that runs exactly these test files, in the repository's own runner where one can be told. */
export function runCommand(repo, files) {
  if (!files.length) return null;
  const q = f => (/[^\w./@-]/.test(f) ? `'${f.replace(/'/g, `'\\''`)}'` : f);
  const of = re => files.filter(f => re.test(f)), parts = [];
  const js = of(/\.(?:[cm]?[jt]sx?|vue|svelte)$/i), py = of(/\.py$/i), go = of(/\.go$/i), rb = of(/\.rb$/i);
  if (js.length) {
    let pkg = {}; try { pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')); } catch {}
    const script = String(pkg.scripts?.test || ''), deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const list = js.map(q).join(' ');
    // the repository's own door where it takes files (a bare runner, or a script of the repository's); the
    // runner itself where the script already names what to run
    const bare = /^(?:node\s+--test|(?:npx\s+)?(?:jest|vitest(?:\s+run)?|mocha|ava))(?:\s+--?[\w-]+(?:=\S+)?)*\s*$/.test(script.trim());
    const own = /^(?:(?:ba|z)?sh\s+)?\.{0,2}\/?[\w./-]+\.(?:sh|[cm]?js)\s*$/.test(script.trim());
    if (script && (bare || own)) parts.push(`npm test -- ${list}`);
    else if (deps.vitest || /\bvitest\b/.test(script)) parts.push(`npx vitest run ${list}`);
    else if (deps.jest || /\bjest\b/.test(script)) parts.push(`npx jest ${list}`);
    else if (deps.mocha || /\bmocha\b/.test(script)) parts.push(`npx mocha ${list}`);
    else parts.push(`node --test ${list}`);
  }
  if (py.length) parts.push(`python -m pytest ${py.map(q).join(' ')}`);
  if (go.length) parts.push(`go test ${[...new Set(go.map(f => `./${path.dirname(f)}`))].map(q).join(' ')}`);
  if (rb.length) parts.push(`bundle exec rspec ${rb.map(q).join(' ')}`);
  return parts.length ? parts.join(' && ') : null;
}

/** The whole reading of a checkout against a base, for the hooks and the command alike. */
export function readGraph(repo, base = baseOf(repo)) {
  const tree = readTree(repo), changes = changesOf(repo, base, tree), index = indexOf(repo, tree);
  const selection = selectTests(tree, index, changes);
  return { tree, changes, index, selection, command: runCommand(repo, selection.files) };
}
