#!/usr/bin/env node
// Which test files a change reaches. `npm test` runs these instead of the whole suite
// (2026-10-24: 116 files, several minutes of every core, on every small change).
//
// The graph: every JavaScript file of the repository (outside node_modules, .worktrees,
// bench and research) with an edge for each relative `import … from`, `export … from`,
// `import()`, `require()` and `new URL(…, import.meta.url)`, and, for a test file, each
// string literal that names an existing repository file by a path with a directory in it
// (`'src/cli.js'`, `'../site/index.html'`: the tests spawn the command and read assets
// by path) or a `join(x, '..', 'install.sh')` reaching up from the test or src directory.
// A bare name (`'AGENTS.md'`, `'package.json'`) is not an edge: the tests write those
// files into scratch repositories far more often than they read the repository's own.
// A test file runs when its closure holds a changed file, or it changed itself. Files that
// change what every test runs under (package.json, the lockfile, scripts/test.sh, this
// script) select the whole suite; so does a clean tree on the base, where nothing is
// selected against. A changed file no test reaches is named, so that a gap is seen.
//
//   scripts/select-tests.mjs [--base ref] [--list] [--why] [--json]
//
// Exported for the test: `buildGraph`, `selectTests`, `changedFiles`.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TEST_GLOB_DIR = 'test';
// A change to one of these changes the run itself, not one module: the whole suite runs.
export const RUN_EVERYTHING = new Set(['package.json', 'package-lock.json', 'scripts/test.sh', 'scripts/select-tests.mjs', '.nvmrc']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.worktrees', '.thinker', '.tmp', 'bench', 'research', 'docker', 'dist', 'coverage']);
const CODE = /\.(mjs|cjs|js)$/;

export function isTestFile(rel) { return /^test\/[^/]+\.test\.js$/.test(rel); }

function* walk(dir, root) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(p, root); }
    else if (CODE.test(e.name)) yield path.relative(root, p);
  }
}

const SPECIFIER = /(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]|(?:^|[^.\w])import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)|new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g;
const LITERAL = /(['"])((?:\.\.\/)*(?:[\w.-]+\/)+[\w.-]+|[\w.-]+\.(?:sh|html|json|md|py|txt|toml|yaml|yml))\1/g;
const UPWARD_JOIN = /\b(?:join|resolve)\(\s*[\w.]+\s*,\s*'\.\.'((?:\s*,\s*'[^']+')+)\s*\)/g;

function exists(root, rel) {
  if (!rel || rel.startsWith('..')) return false;
  try { return fs.statSync(path.join(root, rel)).isFile(); } catch { return false; }
}

function resolveRel(root, from, spec) {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null;
  const abs = spec.startsWith('/') ? spec : path.resolve(root, path.dirname(from), spec);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..')) return null;
  for (const cand of [rel, `${rel}.js`, `${rel}/index.js`, `${rel}.mjs`]) if (exists(root, cand)) return cand;
  return path.extname(rel) ? rel : `${rel}.js`; // gone: the tests importing it still run on its removal
}

// Edges of one file. Specifiers from every file; path literals from test files alone.
export function edgesOf(root, rel, text = fs.readFileSync(path.join(root, rel), 'utf8')) {
  const deps = new Set();
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const m of stripped.matchAll(SPECIFIER)) {
    const spec = m[1] || m[2] || m[3] || m[4] || m[5];
    const dep = resolveRel(root, rel, spec);
    if (dep && dep !== rel) deps.add(dep);
  }
  if (isTestFile(rel) || rel.startsWith(`${TEST_GLOB_DIR}/`)) {
    for (const m of stripped.matchAll(LITERAL)) {
      const lit = m[2];
      if (!lit.includes('/')) continue;
      const fromTest = resolveRel(root, rel, lit.startsWith('.') ? lit : `./${lit}`);
      const fromRoot = lit.startsWith('.') ? null : (exists(root, lit) ? lit : null);
      for (const dep of [fromRoot, fromTest]) if (dep && dep !== rel && exists(root, dep)) deps.add(dep);
    }
    for (const m of stripped.matchAll(UPWARD_JOIN)) {
      const segs = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
      for (const base of [path.dirname(rel), 'src']) {
        const dep = path.normalize(path.join(base, '..', ...segs));
        if (exists(root, dep) && dep !== rel) deps.add(dep);
      }
    }
  }
  return deps;
}

export function buildGraph(root = ROOT) {
  const graph = new Map();
  for (const rel of walk(root, root)) graph.set(rel, edgesOf(root, rel));
  return graph;
}

// Every file a test file reaches, by its edges, transitively.
export function closure(graph, start) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const f = queue.pop();
    for (const d of graph.get(f) || []) if (!seen.has(d)) { seen.add(d); queue.push(d); }
  }
  return seen;
}

// The files a change touches: committed since the merge base with `base`, the working tree, and untracked.
export function changedFiles(root = ROOT, base = defaultBase(root)) {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const files = new Set();
  const add = (out) => { for (const l of out.split('\n')) if (l.trim()) files.add(l.trim()); };
  if (base) {
    try { add(git('diff', '--name-only', `${git('merge-base', base, 'HEAD').trim()}`)); } catch { /* no base: working tree alone */ }
  } else add(git('diff', '--name-only', 'HEAD'));
  add(git('ls-files', '--others', '--exclude-standard'));
  const since = base ? (() => { try { return git('merge-base', base, 'HEAD').trim(); } catch { return 'HEAD'; } })() : 'HEAD';
  return [...files].filter(f => !f.startsWith('.thinker/') && !versionBumpOnly(git, since, f)).sort();
}

// A release bumps the version in package.json and the lockfile and changes nothing a test runs under.
function versionBumpOnly(git, since, file) {
  if (file !== 'package.json' && file !== 'package-lock.json') return false;
  try {
    const diff = git('diff', '-U0', since, '--', file);
    const lines = diff.split('\n').filter(l => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
    return lines.length > 0 && lines.every(l => /^[+-]\s*"version":/.test(l));
  } catch { return false; }
}

export function defaultBase(root = ROOT) {
  for (const ref of ['origin/main', 'main']) {
    try { execFileSync('git', ['-C', root, 'rev-parse', '--verify', '-q', ref], { stdio: 'ignore' }); return ref; } catch { /* next */ }
  }
  return null;
}

// Which test files to run for `changed`. `all: true` with the reason when the whole suite runs.
export function selectTests(graph, changed, { testFiles = [...graph.keys()].filter(isTestFile).sort() } = {}) {
  const everything = changed.filter(f => RUN_EVERYTHING.has(f));
  if (everything.length) return { all: true, reason: `${everything.join(', ')} changed`, tests: testFiles, why: new Map(), unreached: [] };
  if (!changed.length) return { all: true, reason: 'nothing changed against the base', tests: testFiles, why: new Map(), unreached: [] };
  const changedSet = new Set(changed);
  const why = new Map();
  const reached = new Set();
  for (const t of testFiles) {
    const hits = [...closure(graph, t)].filter(f => changedSet.has(f));
    if (hits.length) { why.set(t, hits.sort()); for (const h of hits) reached.add(h); }
  }
  const unreached = changed.filter(f => !reached.has(f) && CODE.test(f) && graph.has(f) && !f.startsWith('test/'));
  return { all: false, reason: null, tests: [...why.keys()].sort(), why, unreached, total: testFiles.length };
}

function main(argv) {
  const flags = new Set(argv.filter(a => a.startsWith('--') && !a.startsWith('--base')));
  const baseArg = argv.findIndex(a => a === '--base');
  const base = baseArg >= 0 ? argv[baseArg + 1] : defaultBase();
  const graph = buildGraph();
  const changed = changedFiles(ROOT, base);
  const sel = selectTests(graph, changed);
  if (flags.has('--json')) { process.stdout.write(JSON.stringify({ ...sel, why: Object.fromEntries(sel.why), changed, base }, null, 2) + '\n'); return; }
  if (flags.has('--why')) {
    for (const [t, hits] of sel.why) process.stderr.write(`${t}  <- ${hits.join(', ')}\n`);
  }
  if (flags.has('--list') || !flags.has('--why')) process.stdout.write(sel.tests.join('\n') + (sel.tests.length ? '\n' : ''));
  const n = sel.tests.length;
  const head = sel.all ? `thinker tests: the whole suite (${n} files): ${sel.reason}`
    : `thinker tests: ${n} of ${sel.total} files reached by ${changed.length} changed file${changed.length === 1 ? '' : 's'} against ${base} (npm test -- --all runs the whole suite)`;
  process.stderr.write(head + '\n');
  if (sel.unreached.length) process.stderr.write(`  no test file reaches: ${sel.unreached.join(', ')}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
