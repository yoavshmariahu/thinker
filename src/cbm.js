// codebase-memory-mcp (CBM, github.com/DeusData/codebase-memory-mcp) as the code-graph engine:
// a single binary that indexes a repository with tree-sitter into a SQLite graph and answers over
// MCP. thinker keeps its own notes, hashes and snippets (deps.js, ast.js) and asks CBM only what a
// text search answers badly: who calls a symbol, what it calls, what a file defines. The binary
// runs once per process as a child MCP server held by a worker thread (cbm-worker.js), and the
// main thread waits on it synchronously, so codegraph.js keeps its synchronous API; the first
// question costs the start of the binary (about 2.5 s), the rest milliseconds.
//
// Opt-in: `thinker cbm install` (or THINKER_CBM_BIN / a `codebase-memory-mcp` on PATH) and
// `thinker cbm index`. Without the binary or an index of the checkout, codegraph.js uses git grep.
// THINKER_CODEGRAPH=git forces that; =cbm refuses the fallback (unknown instead of approximate).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';

export const CBM_VERSION = process.env.THINKER_CBM_VERSION || '0.11.0';
export const CBM_REPO = 'DeusData/codebase-memory-mcp';
const FIRST_CALL_MS = 15_000, CALL_MS = 10_000, PROJECTS_TTL = 60_000, MEMO_TTL = 30_000;

const home = () => process.env.THINKER_HOME || path.join(os.homedir(), '.thinker');
export const cbmDir = () => path.join(home(), 'cbm');
const exe = process.platform === 'win32' ? 'codebase-memory-mcp.exe' : 'codebase-memory-mcp';

// Where the binary may be, in order: THINKER_CBM_BIN, CBM's default install, PATH, thinker's own
// install. An install the user already has comes first: every copy of the binary on a machine
// shares one coordination daemon, and a copy that cannot reach the daemon of another waits
// 30 s before giving up, so thinker's copy is for machines that have none.
export function cbmCandidates() {
  const onPath = (process.env.PATH || '').split(path.delimiter).filter(Boolean).map(d => path.join(d, exe));
  return [...new Set([process.env.THINKER_CBM_BIN, path.join(os.homedir(), '.local', 'bin', exe), ...onPath, path.join(cbmDir(), exe)].filter(Boolean))];
}
export function cbmBin() {
  if (process.env.THINKER_CBM === 'off' || process.env.THINKER_CODEGRAPH === 'git') return null;
  for (const c of cbmCandidates()) { try { fs.accessSync(c, fs.constants.X_OK); if (fs.statSync(c).isFile()) return c; } catch { /* next */ } }
  return null;
}

// --- the synchronous bridge --------------------------------------------------------------------
const state = { worker: null, bin: null, sab: null, flag: null, buf: null, seq: 0, calls: 0, dead: null, projects: null, projectsAt: 0, memo: new Map() };

function worker() {
  const bin = cbmBin();
  if (!bin) return null;
  if (state.worker && state.bin === bin) return state.worker;
  if (state.worker) { state.worker.terminate(); state.worker = null; }
  state.sab = new SharedArrayBuffer(8 + 8 * 1024 * 1024);
  state.flag = new Int32Array(state.sab, 0, 2); state.buf = new Uint8Array(state.sab, 8);
  state.bin = bin; state.calls = 0; state.dead = null;
  state.worker = new Worker(new URL('./cbm-worker.js', import.meta.url), { workerData: { bin, sab: state.sab } });
  state.worker.on('error', e => { state.dead = String(e?.message || e); });
  state.worker.on('exit', () => { state.worker = null; });
  state.worker.unref();
  return state.worker;
}

// One MCP tool call, waited for: the parsed JSON result, or null when CBM cannot be asked
// (no binary, start failed, timeout) and {error} when CBM answered with one.
export function cbmCall(name, args, { timeout } = {}) {
  const w = worker();
  if (!w || state.dead) return null;
  const id = ++state.seq;
  const ms = timeout || (state.calls === 0 ? FIRST_CALL_MS : CALL_MS);
  const deadline = Date.now() + ms;
  Atomics.store(state.flag, 0, 0);
  w.postMessage({ id, name, args });
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0 || Atomics.wait(state.flag, 0, 0, left) === 'timed-out') { state.dead = `${name} did not answer in ${ms} ms`; return null; }
    let r; try { r = JSON.parse(Buffer.from(state.buf.subarray(0, Atomics.load(state.flag, 1))).toString()); } catch { return null; }
    state.calls++;
    if (r.id !== id) { Atomics.store(state.flag, 0, 0); continue; } // a late answer to an earlier, abandoned question
    if (!r.ok) { if (/ENOENT|spawn|closed|connect/i.test(r.error)) state.dead = r.error; return null; }
    try { return JSON.parse(r.text); } catch { return r.isError ? { error: r.text } : null; }
  }
}
// Test hook: forget the connection and the caches.
export function resetCbm() { if (state.worker) state.worker.terminate(); Object.assign(state, { worker: null, bin: null, dead: null, calls: 0, projects: null, projectsAt: 0, memo: new Map() }); }

// --- projects ------------------------------------------------------------------------------------
const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

export function cbmProjects({ fresh = false } = {}) {
  if (!fresh && state.projects && Date.now() - state.projectsAt < PROJECTS_TTL) return state.projects;
  const r = cbmCall('list_projects', { limit: 200 });
  if (!r || r.error) return state.projects || null;
  state.projects = r.projects || []; state.projectsAt = Date.now();
  return state.projects;
}
// The CBM project that indexes this checkout (its root, not a parent or a worktree of it), or null.
export function cbmProject(repo, opts) {
  const ps = cbmProjects(opts); if (!ps) return null;
  const root = real(repo);
  return ps.find(p => real(p.root_path) === root)?.name || null;
}

// Which engine codegraph.js should use for this repository: 'cbm' or 'git'.
export function codegraphEngine(repo) {
  const want = process.env.THINKER_CODEGRAPH || 'auto';
  if (want === 'git' || !cbmBin()) return 'git';
  if (want === 'cbm') return 'cbm';
  return cbmProject(repo) ? 'cbm' : 'git';
}

export function cbmStatus(repo) {
  const bin = cbmBin();
  const out = { bin, engine: codegraphEngine(repo), project: null, projects: null, version: null };
  if (!bin) return out;
  try { out.version = execFileSync(bin, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 }).toString().trim().split(/\s+/).pop(); } catch { /* unknown */ }
  const ps = cbmProjects({ fresh: true });
  out.projects = ps ? ps.length : null;
  out.project = repo && ps ? cbmProject(repo) : null;
  return out;
}

// --- indexing (through the CLI: progress on stderr, one JSON result on stdout) -------------------
const cli = (bin, args, { stdio = ['ignore', 'pipe', 'pipe'], timeout = 30 * 60_000 } = {}) => {
  const r = spawnSync(bin, ['cli', '--quiet', ...args], { stdio, timeout, maxBuffer: 64 * 1024 * 1024 });
  const text = (r.stdout || '').toString().trim();
  let json = null; try { json = JSON.parse(text.slice(text.lastIndexOf('\n{') + 1)); } catch { /* not JSON */ }
  return { status: r.status, json, text, stderr: (r.stderr || '').toString() };
};

// Index (or re-index) the checkout. Returns CBM's result ({project, nodes, edges, status, …}) or {error}.
export function cbmIndex(repo, { name, stdio } = {}) {
  const bin = cbmBin(); if (!bin) return { error: 'codebase-memory-mcp is not installed (thinker cbm install)' };
  const root = real(repo);
  let project = name || cbmProject(repo, { fresh: true });
  if (!project) { // a new project: the directory's name, unless another checkout already has it
    const base = path.basename(root).replace(/[^\w.-]+/g, '-') || 'repo';
    const taken = (cbmProjects() || []).some(p => p.name === base && real(p.root_path) !== root);
    project = taken ? `${base}-${crypto.createHash('sha1').update(root).digest('hex').slice(0, 6)}` : base;
  }
  const r = cli(bin, ['index_repository', '--repo-path', root, '--name', project], { stdio });
  state.projects = null; state.memo.clear();
  if (r.json?.project || r.json?.status) return r.json;
  return { error: r.json?.error || r.stderr.trim().split('\n').pop() || `index_repository exited with ${r.status}` };
}
export function cbmForget(repo) {
  const bin = cbmBin(); const project = bin && cbmProject(repo, { fresh: true });
  if (!project) return { error: 'this checkout is not indexed' };
  const r = cli(bin, ['delete_project', '--project', project]);
  state.projects = null; state.memo.clear();
  return r.json || { error: r.stderr.trim() || `delete_project exited with ${r.status}` };
}

// --- questions about the graph -------------------------------------------------------------------
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SKIP_LABELS = new Set(['Branch', 'File', 'Folder', 'Module', 'Package', 'Repository']);
const firstLine = lines => { const m = /^(\d+)/.exec(String(lines || '')); return m ? Number(m[1]) : null; };
const lastLine = lines => { const m = /-(\d+)$/.exec(String(lines || '')); return m ? Number(m[1]) : firstLine(lines); };

// Every definition named by the pattern: [{name, qn, qn_prefix, label, path, line, end, in, out}].
export function cbmSearch(project, pattern, { limit = 100 } = {}) {
  const r = cbmCall('search_graph', { project, name_pattern: pattern, limit });
  return !r || r.error ? null : parseSearch(r);
}
export function parseSearch(r) {
  const out = [];
  for (const g of r.groups || []) for (const [name, label, lines, inn, outt] of g.rows || []) {
    if (SKIP_LABELS.has(label) || !g.file || g.file === '{}') continue;
    out.push({ name, qn: g.qn_prefix ? `${g.qn_prefix}.${name}` : name, qn_prefix: g.qn_prefix || '', label, path: g.file, line: firstLine(lines), end: lastLine(lines), in: inn, out: outt });
  }
  return out;
}

// The graph node of a dep's symbol in its file: `Class.method` must sit under `Class`. Null when
// the graph has no such definition (a const the grammar skipped, a file CBM did not index).
export function cbmNode(project, dep) {
  const parts = String(dep.symbol || '').split('.').filter(Boolean); if (!parts.length) return null;
  const name = parts.pop(), parent = parts.pop();
  const hits = cbmSearch(project, `^${escRe(name)}$`, { limit: 200 }); if (!hits) return null;
  const inFile = hits.filter(h => h.path === dep.path);
  return (parent ? inFile.find(h => h.qn_prefix.endsWith('.' + parent)) : null) || inFile[0] || null;
}

// One hop around a symbol: {node, callers: [{name, qn, path?, line?}], callees: [...]} or null.
// Memoized for a few seconds, so fanout, callers and callees of one drilldown are one set of calls.
export function cbmNeighbors(project, dep, { repo } = {}) {
  const key = `${project}|${dep.path}|${dep.symbol}`;
  const hit = state.memo.get(key); if (hit && Date.now() - hit.at < MEMO_TTL) return hit.value;
  const value = neighbors(project, dep, repo);
  state.memo.set(key, { at: Date.now(), value }); if (state.memo.size > 200) state.memo.delete(state.memo.keys().next().value);
  return value;
}
function neighbors(project, dep, repo) {
  const node = cbmNode(project, dep); if (!node) return null;
  const t = cbmCall('trace_path', { project, function_name: node.qn, direction: 'both', depth: 1 });
  if (!t || t.error || t.status === 'ambiguous') return null;
  const rows = side => (side?.groups || []).flatMap(g => (g.rows || []).map(([name]) => ({ name, qn: g.qn_prefix ? `${g.qn_prefix}.${name}` : name, qn_prefix: g.qn_prefix || '' })));
  const callers = rows(t.callers), callees = rows(t.callees);
  // where those live: one search for all the names, matched back by qualified name
  const names = [...new Set([...callers, ...callees].map(r => r.name))].slice(0, 60);
  if (names.length) {
    const defs = cbmSearch(project, `^(${names.map(escRe).join('|')})$`, { limit: 400 }) || [];
    const byQn = new Map(defs.map(d => [d.qn, d]));
    const byName = new Map(); for (const d of defs) if (!byName.has(d.name)) byName.set(d.name, d);
    for (const r of [...callers, ...callees]) { const d = byQn.get(r.qn) || byName.get(r.name); if (d) { r.path = d.path; r.line = d.line; r.label = d.label; } }
  }
  // a call at module level is attributed to the file itself: name the file
  for (const r of callers) if (!r.path) { const p = pathFromQn(repo, project, r.qn); if (p) { r.path = p; r.name = '(module level)'; r.line = null; } }
  return { node, callers, callees, callersTotal: t.callers_total ?? callers.length, calleesTotal: t.callees_total ?? callees.length };
}

// `project.src.foo.test` names src/foo.test.<ext>: the longest tail of the qualified name that is
// a file stem in the checkout. Null when no file fits.
export function pathFromQn(repo, project, qn) {
  if (!repo || !qn.startsWith(project + '.')) return null;
  const parts = qn.slice(project.length + 1).split('.');
  for (let k = 1; k <= parts.length; k++) {
    const dir = parts.slice(0, k - 1).join('/'), stem = parts.slice(k - 1).join('.');
    let entries; try { entries = fs.readdirSync(path.join(repo, dir), { withFileTypes: true }); } catch { continue; }
    const hit = entries.find(e => e.isFile() && (e.name === stem || e.name.startsWith(stem + '.')));
    if (hit) return dir ? `${dir}/${hit.name}` : hit.name;
  }
  return null;
}

// What a file defines, from the graph: [{name, parent, kind, line, end}] or null.
// CBM pages the outline 200 rows at a time; a larger limit is read in pages.
export function cbmOutline(project, file, { limit = 80 } = {}) {
  const page = Math.min(200, limit); let offset = 0, rows = [], first = null;
  for (;;) {
    const r = cbmCall('get_file_outline', { project, file_path: file, limit: page, ...(offset ? { offset } : {}) });
    if (!r || r.error) return offset ? parseOutline({ ...first, rows }, { limit }) : null;
    first = first || r; rows = rows.concat(r.rows || []); offset += (r.rows || []).length;
    if (!r.has_more || !(r.rows || []).length || rows.length >= limit) break;
  }
  return parseOutline({ ...first, rows }, { limit });
}
export function parseOutline(r, { limit = 80 } = {}) {
  const rows = (r.rows || []).filter(([, label]) => !SKIP_LABELS.has(label));
  const prefix = rows.map(([name, , , qn]) => String(qn || '').slice(0, -(name.length + 1))).sort((a, b) => a.length - b.length)[0] || '';
  return rows.slice(0, limit).map(([name, label, lines, qn]) => {
    const inner = String(qn || '').startsWith(prefix + '.') ? String(qn).slice(prefix.length + 1, -(name.length + 1)) : '';
    return { name, parent: inner ? inner.split('.').pop() : null, kind: label.toLowerCase(), line: firstLine(lines), end: lastLine(lines) };
  });
}

// --- install -------------------------------------------------------------------------------------
export function cbmAsset() {
  const os_ = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null;
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64' : null;
  return os_ && arch ? `codebase-memory-mcp-${os_}-${arch}.tar.gz` : null;
}
// Downloads the release for this platform into ~/.thinker/cbm, checks the published SHA-256 and
// unpacks the binary there. Touches no agent configuration (CBM's own installer would).
export async function installCbm({ dir = cbmDir(), version = CBM_VERSION, log = () => {} } = {}) {
  const asset = cbmAsset(); if (!asset) throw new Error(`no codebase-memory-mcp build for ${process.platform}/${process.arch}`);
  const base = `https://github.com/${CBM_REPO}/releases/download/v${version}/`;
  fs.mkdirSync(dir, { recursive: true });
  const get = async name => { const res = await fetch(base + name, { redirect: 'follow' }); if (!res.ok) throw new Error(`${res.status} downloading ${base + name}`); return Buffer.from(await res.arrayBuffer()); };
  log(`downloading ${asset} v${version} (about 40 MB)…`);
  const [tgz, sums] = await Promise.all([get(asset), get('checksums.txt')]);
  const want = sums.toString().split('\n').map(l => l.trim().split(/\s+/)).find(([, n]) => n === asset)?.[0];
  const have = crypto.createHash('sha256').update(tgz).digest('hex');
  if (!want) throw new Error(`${asset} is not in checksums.txt`);
  if (want !== have) throw new Error(`checksum mismatch for ${asset}: expected ${want}, got ${have}`);
  const tmp = path.join(dir, asset); fs.writeFileSync(tmp, tgz);
  const r = spawnSync('tar', ['xzf', tmp, '-C', dir, exe], { stdio: 'ignore' });
  fs.rmSync(tmp, { force: true });
  if (r.status !== 0) throw new Error('could not unpack the archive (tar)');
  fs.chmodSync(path.join(dir, exe), 0o755);
  fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version, asset, sha256: have, installedAt: new Date().toISOString() }, null, 2) + '\n');
  return path.join(dir, exe);
}
