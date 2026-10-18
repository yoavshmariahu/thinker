// The definitions of a checkout, kept on disk, so a lookup reads an index instead of scanning the tree.
// Every definition lookup in codegraph.js (findDefinitions, definitionOf, outline, and the exact-match
// pass of findSymbols) runs `git grep` over the whole repository and re-parses the files it hits: on
// PostHog (53,503 tracked files, 43,454 of them code) that is seconds a call, paid again by every hook
// and every tool call. Here the same answers come from a table under `.thinker/state/symbols/`:
//
//   meta.json      what the build covered, and how long its working-tree sweep took
//   paths.json     [path, ...]            — the file index every other file refers to
//   hashes.json    [blob sha1, ...]       — parallel to paths; read only when something moved
//   n/<nn>.json    [[name, fileIdx, kind, line, end], ...]   — 64 shards by name
//   f/<nn>.json    {path: [[name, kind, line, end, parent?], ...]}  — 64 shards by path
//   delta.json     the files that changed since the build, outlined again
//
// Sharding is what keeps a lookup cheap on a large checkout: one name reads one shard (about 400 KB of
// PostHog's 25 MB name index), not the whole table. The table is never the record of anything — a
// missing, unreadable or half-built one just means the caller's `git grep` answers instead.
//
// Freshness, in three steps, none of which blocks:
//   * `git ls-files -s` gives the index blob of every tracked file in one call (26 ms on PostHog). It
//     catches every commit, checkout, pull and `git add`.
//   * a sweep (`ls-files -m` and `ls-files -o`) catches unstaged edits and new files. It stats the whole
//     tree (105 ms and 204 ms warm on PostHog, ten seconds cold), so it runs inline only once a
//     measurement says it fits in `sweepMs`, and in a background rebuild otherwise.
//   * a file named by the caller (outline, the on-sight hook) is always hashed and re-outlined here and
//     now, so the per-file answer is exact whatever the sweep last saw.
// Too much changed at once, or no table yet: a detached `thinker symbols build` is started and the
// caller is told nothing is ready, so it falls back. Off by default (`symbolTable` in .thinker/config.json).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// codegraph.js imports this file too; both sides only use the other inside a function body, which is
// what makes the cycle safe.
import { outlineText, CODE_EXT } from './codegraph.js';

const VERSION = 1;
const SHARDS = 64;
const HERE = path.dirname(fileURLToPath(import.meta.url));

// `symbolTable` in .thinker/config.json, or `true` for the defaults. No environment switch: an
// experiment is configured per repository (AGENTS.md).
export const SYMBOL_TABLE = {
  enabled: false,
  maxFiles: 60_000,      // files the build will outline before it calls itself truncated
  maxFileBytes: 400_000, // a generated blob is not where a definition is looked for
  maxSymbols: 2_000,     // per file
  buildMs: 900_000,      // the build gives up after this and reports what it covered
  refreshFiles: 200,     // files re-outlined inline on one lookup; more means a rebuild
  refreshMs: 2_000,      // and never for longer than this
  maxDelta: 400,         // changed files the delta holds before the table is rebuilt
  sweepMs: 120,          // a worktree sweep measured slower than this moves to the background
  recheckMs: 1_000,      // how long one process trusts its last freshness check (a `find` makes several lookups)
  sweep: 'auto',         // 'inline' and 'off' override that decision (tests, benchmarks)
  background: true,      // false: never start a detached build (tests)
};

const configs = new Map();
function repoConfig(repo) {
  if (!configs.has(repo)) {
    let c = {};
    try { c = JSON.parse(fs.readFileSync(path.join(repo, '.thinker', 'config.json'), 'utf8')) || {}; } catch {}
    configs.set(repo, c);
  }
  return configs.get(repo);
}
export function symbolTableConfig(repo, over = {}) {
  const c = repoConfig(repo).symbolTable;
  return { ...SYMBOL_TABLE, ...(c === true ? { enabled: true } : c && typeof c === 'object' ? c : {}), ...over };
}
// Test hook: forget the configuration and everything read from disk in this process.
export function resetSymbols() { configs.clear(); shards.clear(); loaded.clear(); reconciled.clear(); texts.clear(); }

export const tableDir = repo => path.join(repo, '.thinker', 'state', 'symbols');

// --- encoding ---------------------------------------------------------------
// Kinds are the ones ast.js and the regex outline produce; an unknown one is stored as its own string.
const KINDS = ['function', 'method', 'class', 'const', 'field', 'property', 'interface', 'type', 'enum', 'namespace', 'struct', 'trait', 'static', 'mod', 'macro', 'union', 'impl', 'var', 'module', 'definition'];
const KIND_IDX = new Map(KINDS.map((k, i) => [k, i]));
const encKind = k => (KIND_IDX.has(k) ? KIND_IDX.get(k) : String(k || 'definition'));
const decKind = k => (typeof k === 'number' ? KINDS[k] || 'definition' : k || 'definition');
const encSym = d => (d.parent ? [d.name, encKind(d.kind), d.line, d.end || 0, d.parent] : [d.name, encKind(d.kind), d.line, d.end || 0]);
const decSym = s => ({ name: s[0], parent: s[4] || null, kind: decKind(s[1]), line: s[2], end: s[3] || null });

const sha = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);
// git's own object name for the content, so a file hashed here and the same file read from the index
// through `ls-files -s` carry the same hash.
const blobHash = buf => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
function shardOf(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % SHARDS).toString(16).padStart(2, '0');
}
const isCode = p => CODE_EXT.has(String(p).split('.').pop().toLowerCase());

// --- reading ----------------------------------------------------------------
const shards = new Map();  // file -> parsed JSON, for this process
const loaded = new Map();  // repo -> { meta, paths, delta }
function readJson(file) {
  if (shards.has(file)) return shards.get(file);
  let v = null;
  try { v = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  shards.set(file, v);
  return v;
}
function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, typeof value === 'string' ? value : JSON.stringify(value));
    fs.renameSync(tmp, file);
    shards.delete(file);  // re-read on demand; the build must not hold every shard it wrote in memory
    return true;
  } catch { return false; }
}
const EMPTY_DELTA = () => ({ rev: null, sweepMs: null, files: {}, removed: {} });
function state(repo) {
  if (!loaded.has(repo)) {
    const dir = tableDir(repo);
    const meta = readJson(path.join(dir, 'meta.json'));
    loaded.set(repo, { meta: meta && meta.v === VERSION ? meta : null, delta: readJson(path.join(dir, 'delta.json')) || EMPTY_DELTA() });
  }
  return loaded.get(repo);
}
const pathsOf = repo => readJson(path.join(tableDir(repo), 'paths.json')) || [];

// Whether this checkout has a table a lookup can be answered from.
export function tableReady(repo, over = {}) {
  const cfg = symbolTableConfig(repo, over);
  return cfg.enabled && !!state(repo).meta;
}
// What the table covers, for `thinker symbols` and the tests.
export function tableStats(repo) {
  const { meta, delta } = state(repo);
  if (!meta) return null;
  return { ...meta, delta: Object.keys(delta.files).length, removed: Object.keys(delta.removed).length };
}

// --- the checkout's revision -------------------------------------------------
function gitOut(repo, args, timeout = 30_000) {
  try { return execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024, timeout }).toString(); }
  catch { return null; }
}
// Every tracked code file with the blob the index holds for it. `ls-files -s` prints
// "<mode> <object> <stage>\t<path>", and reads only the index: 26 ms for PostHog's 53,503 entries.
function indexed(repo) {
  const out = gitOut(repo, ['ls-files', '-s', '-z']);
  if (out === null) return null;
  const hashes = new Map();
  for (const row of out.split('\0')) {
    const tab = row.indexOf('\t');
    if (tab < 0) continue;
    const p = row.slice(tab + 1);
    if (isCode(p)) hashes.set(p, row.slice(7, 47));
  }
  return { hashes, rev: sha(out) };
}
// Unstaged edits and untracked files, hashed from their content. Returns null when there are more of
// them than the delta would hold (a half-finished rebase, a generated tree): the table is rebuilt instead.
function sweepWorktree(repo, hashes, { max = Infinity } = {}) {
  const t = Date.now();
  const mod = gitOut(repo, ['ls-files', '-m', '-z']), un = gitOut(repo, ['ls-files', '-o', '--exclude-standard', '-z']);
  if (mod === null || un === null) return null;
  const files = [...new Set([...mod.split('\0'), ...un.split('\0')].filter(f => f && !f.endsWith('/') && isCode(f)))];
  if (files.length > max) return null;
  const dirty = [];
  for (const f of files.sort()) {
    const h = fileHash(repo, f);
    if (h) { hashes.set(f, h); dirty.push(f + ':' + h); } else hashes.delete(f);
  }
  return { ms: Date.now() - t, dirty };
}
function fileHash(repo, file) {
  try { const s = fs.statSync(path.join(repo, file), { throwIfNoEntry: false }); if (!s || !s.isFile()) return null; } catch { return null; }
  try { return blobHash(fs.readFileSync(path.join(repo, file))); } catch { return null; }
}

// --- outlining one file -------------------------------------------------------
function outlineOne(repo, file, cfg) {
  const abs = path.join(repo, file);
  let st; try { st = fs.statSync(abs, { throwIfNoEntry: false }); } catch { return null; }
  if (!st || !st.isFile() || st.size > cfg.maxFileBytes) return null;
  let buf; try { buf = fs.readFileSync(abs); } catch { return null; }
  const defs = outlineText(buf.toString('utf8'), file, { limit: cfg.maxSymbols }) || [];
  return { h: blobHash(buf), s: defs.map(encSym) };
}

// --- keeping the table current -------------------------------------------------
// Brings the delta up to the checkout's current revision, inside the lookup's own budget. Nothing here
// waits on a rebuild: when there is more to do than the budget allows, one is started in the background
// and the caller is served from the table as it stands.
const reconciled = new Map();  // repo -> when this process last looked; a `find` makes several lookups
function reconcile(repo, cfg) {
  const s = state(repo);
  if (!s.meta) { requestBuild(repo, cfg); return false; }
  const last = reconciled.get(repo);
  if (last !== undefined && Date.now() - last < (cfg.recheckMs ?? 1000)) return true;
  reconciled.set(repo, Date.now());
  const idx = indexed(repo);
  if (!idx) return true;  // not a git checkout any more: whatever the table holds is all there is
  const inline = cfg.sweep === 'inline' || (cfg.sweep !== 'off' && Number.isFinite(s.delta.sweepMs) && s.delta.sweepMs <= cfg.sweepMs);
  let swept = null;
  if (inline) swept = sweepWorktree(repo, idx.hashes, { max: cfg.maxDelta });
  if (inline && !swept) { requestBuild(repo, cfg); return true; }
  const rev = swept ? sha(idx.rev + '\n' + swept.dirty.join('\n')) : idx.rev;
  if (s.delta.rev === rev) return true;
  const dir = tableDir(repo);
  const paths = pathsOf(repo), hashes = readJson(path.join(dir, 'hashes.json'));
  if (!hashes || hashes.length !== paths.length) { requestBuild(repo, cfg); return false; }
  const base = new Map(paths.map((p, i) => [p, hashes[i]]));
  const delta = { ...s.delta, files: { ...s.delta.files }, removed: { ...s.delta.removed } };
  const changed = [];
  for (const [p, h] of idx.hashes) {
    const have = delta.files[p] ? delta.files[p].h : base.get(p);
    if (have !== h) changed.push(p);
    if (delta.removed[p]) delete delta.removed[p];
  }
  for (const p of base.keys()) if (!idx.hashes.has(p)) { delta.removed[p] = 1; delete delta.files[p]; }
  for (const p of Object.keys(delta.files)) if (!idx.hashes.has(p)) delete delta.files[p];
  if (changed.length + Object.keys(delta.files).length > cfg.maxDelta) {
    requestBuild(repo, cfg);
    delta.rev = rev; if (swept) delta.sweepMs = swept.ms;
    persist(repo, delta);
    return true;
  }
  const until = Date.now() + cfg.refreshMs;
  let done = 0, left = false;
  for (const p of changed) {
    if (done >= cfg.refreshFiles || Date.now() > until) { left = true; break; }
    const e = outlineOne(repo, p, cfg);
    if (e) delta.files[p] = e; else { delete delta.files[p]; delta.removed[p] = 1; }
    done++;
  }
  if (left) { requestBuild(repo, cfg); } else { delta.rev = rev; if (swept) delta.sweepMs = swept.ms; }
  persist(repo, delta);
  return true;
}
function persist(repo, delta) {
  state(repo).delta = delta;
  writeJson(path.join(tableDir(repo), 'delta.json'), delta);
}
// A detached rebuild, at most one at a time per checkout. The lock is the only thing that keeps every
// lookup of a changed checkout from starting one.
export function requestBuild(repo, cfg = symbolTableConfig(repo)) {
  if (!cfg.background) return false;
  const lock = path.join(tableDir(repo), 'build.lock');
  try { const s = fs.statSync(lock, { throwIfNoEntry: false }); if (s && Date.now() - s.mtimeMs < 30 * 60_000) return false; } catch {}
  try { fs.mkdirSync(tableDir(repo), { recursive: true }); fs.writeFileSync(lock, String(Date.now())); } catch { return false; }
  try {
    const p = spawn(process.execPath, [path.join(HERE, 'cli.js'), 'symbols', 'build', '--repo', repo, '--quiet'], { cwd: repo, detached: true, stdio: 'ignore' });
    p.unref();
    return true;
  } catch { try { fs.rmSync(lock, { force: true }); } catch {} return false; }
}

// --- the answers ---------------------------------------------------------------
// The definitions of each name: Map(name -> [{path, line, end, kind, text}]), or null when this
// checkout has no table to answer from (the caller's git grep then does).
export function lookupNames(repo, names, { limit = 10, ...over } = {}) {
  const cfg = symbolTableConfig(repo, over);
  if (!cfg.enabled) return null;
  const want = [...new Set((names || []).filter(n => /^[A-Za-z_$][\w$]*$/.test(n)))];
  const out = new Map(want.map(n => [n, []]));
  if (!want.length) return out;
  if (!state(repo).meta) { requestBuild(repo, cfg); return null; }
  if (!reconcile(repo, cfg)) return null;
  const { delta } = state(repo);
  const paths = pathsOf(repo);
  const dir = tableDir(repo);
  for (const name of want) {
    const rows = readJson(path.join(dir, 'n', `${shardOf(name)}.json`)) || [];
    const hits = out.get(name);
    for (const r of rows) {
      if (r[0] !== name) continue;
      const p = paths[r[1]];
      if (!p || delta.removed[p] || delta.files[p]) continue;  // the delta has the current answer for it
      hits.push({ path: p, line: r[3], end: r[4] || null, kind: decKind(r[2]) });
    }
  }
  for (const [p, e] of Object.entries(delta.files)) {
    for (const s of e.s) {
      const hits = out.get(s[0]);
      if (hits) hits.push({ path: p, line: s[2], end: s[3] || null, kind: decKind(s[1]) });
    }
  }
  for (const [name, hits] of out) {
    hits.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    out.set(name, hits.slice(0, limit).map(h => ({ ...h, text: lineAt(repo, h.path, h.line) })));
  }
  return out;
}
// The line a definition starts on, read only for the few hits that are returned: the table would be
// half as big again if it carried the text of every definition.
const texts = new Map();
function lineAt(repo, file, line) {
  if (!texts.has(file)) {
    let lines = null;
    try { const s = fs.statSync(path.join(repo, file), { throwIfNoEntry: false }); if (s && s.size <= 4 << 20) lines = fs.readFileSync(path.join(repo, file), 'utf8').split('\n'); } catch {}
    if (texts.size > 200) texts.clear();
    texts.set(file, lines);
  }
  const lines = texts.get(file);
  return lines && lines[line - 1] !== undefined ? lines[line - 1] : '';
}

// The definitions of one file: [{name, parent, kind, line, end}], or null when there is no table or the
// file cannot be read. The file is hashed here, so this answer is exact even when the last sweep is old.
export function outlineFile(repo, file, { limit = 80, ...over } = {}) {
  const cfg = symbolTableConfig(repo, over);
  if (!cfg.enabled) return null;
  const s = state(repo);
  if (!s.meta) { requestBuild(repo, cfg); return null; }
  const h = fileHash(repo, file);
  if (!h) return null;
  const have = s.delta.files[file];
  if (have && have.h === h) return have.s.slice(0, limit).map(decSym);
  const shard = readJson(path.join(tableDir(repo), 'f', `${shardOf(file)}.json`));
  const entry = shard && shard[file];
  if (entry && entry.h === h) return entry.s.slice(0, limit).map(decSym);
  const made = outlineOne(repo, file, cfg);
  if (!made) return null;
  const delta = { ...s.delta, files: { ...s.delta.files, [file]: made }, removed: { ...s.delta.removed } };
  delete delta.removed[file];
  if (Object.keys(delta.files).length > cfg.maxDelta) requestBuild(repo, cfg);
  persist(repo, delta);
  return made.s.slice(0, limit).map(decSym);
}

// --- building -------------------------------------------------------------------
// The whole checkout outlined once, into a fresh table. Bounded by maxFiles and buildMs and reported:
// a build that ran out of either says so in meta.truncated, and the lookups it cannot answer fall back
// to git grep as before. `onProgress` is for the command line.
export function buildTable(repo, { onProgress, ...over } = {}) {
  const cfg = symbolTableConfig(repo, { ...over, enabled: true });
  const t0 = Date.now();
  const idx = indexed(repo);
  if (!idx) return { error: `${repo} is not a git checkout` };
  const swept = sweepWorktree(repo, idx.hashes);
  const files = [...idx.hashes.keys()].sort();
  const dir = tableDir(repo);
  const nameRows = Array.from({ length: SHARDS }, () => []);
  const fileRows = Array.from({ length: SHARDS }, () => []);
  const paths = [], hashes = [];
  const until = t0 + cfg.buildMs;
  let symbols = 0, skipped = 0, truncated = false;
  for (const file of files) {
    if (paths.length >= cfg.maxFiles || Date.now() > until) { truncated = true; break; }
    const e = outlineOne(repo, file, cfg);
    if (!e) { skipped++; continue; }
    const idxOf = paths.length;
    paths.push(file); hashes.push(e.h);
    fileRows[parseInt(shardOf(file), 16)].push(`${JSON.stringify(file)}:${JSON.stringify(e)}`);
    for (const s of e.s) {
      nameRows[parseInt(shardOf(s[0]), 16)].push(JSON.stringify([s[0], idxOf, s[1], s[2], s[3]]));
      symbols++;
    }
    if (onProgress && paths.length % 2000 === 0) onProgress({ files: paths.length, of: files.length, symbols });
  }
  // the old table goes, the lock stays: a lookup running now must not start a second build. While the
  // shards are being written there is no meta.json, so those lookups fall back to git grep as usual.
  for (const f of ['meta.json', 'paths.json', 'hashes.json', 'delta.json', 'n', 'f']) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  shards.clear(); loaded.delete(repo);
  for (let i = 0; i < SHARDS; i++) {
    const nn = i.toString(16).padStart(2, '0');
    writeJson(path.join(dir, 'n', `${nn}.json`), `[${nameRows[i].join(',')}]`);
    writeJson(path.join(dir, 'f', `${nn}.json`), `{${fileRows[i].join(',')}}`);
  }
  writeJson(path.join(dir, 'paths.json'), paths);
  writeJson(path.join(dir, 'hashes.json'), hashes);
  const rev = swept ? sha(idx.rev + '\n' + swept.dirty.join('\n')) : idx.rev;
  writeJson(path.join(dir, 'delta.json'), { ...EMPTY_DELTA(), rev, sweepMs: swept ? swept.ms : null });
  const meta = { v: VERSION, built: new Date().toISOString(), files: paths.length, tracked: files.length, symbols, skipped, truncated, buildMs: Date.now() - t0, sweepMs: swept ? swept.ms : null, bytes: tableBytes(dir) };
  writeJson(path.join(dir, 'meta.json'), meta);
  try { fs.rmSync(path.join(dir, 'build.lock'), { force: true }); } catch {}
  loaded.delete(repo);
  return meta;
}
function tableBytes(dir) {
  let n = 0;
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else try { n += fs.statSync(p).size; } catch {} } };
  try { walk(dir); } catch {}
  return n;
}

// Bring the table up to date without a lookup: `thinker symbols refresh`, and the tests.
export function refreshTable(repo, over = {}) {
  const cfg = symbolTableConfig(repo, { ...over, enabled: true });
  const before = Object.keys(state(repo).delta.files).length;
  const ok = reconcile(repo, cfg);
  const s = state(repo);
  return { ok, refreshed: Object.keys(s.delta.files).length - before, delta: Object.keys(s.delta.files).length, removed: Object.keys(s.delta.removed).length };
}
