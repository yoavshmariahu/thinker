// Syncing a checkout with the team's central cache (src/server). Three flows, all from the hooks
// and maintenance, so nothing has to be run by hand once `thinker sync login` has been done:
//
//   pull      notes changed on the server since this checkout's cursor come into the local tier,
//             marked `sync: {digest, seq}`; a note the repository commits itself is left alone
//   push      local notes worth sharing (fresh, from a trusted source or confirmed by a session),
//             and synced notes whose content changed here (a verification, a correction), go up;
//             an update holds only against the content it was pulled from, else the server wins
//   sessions  what the agents did here, as the events transcripts.js reads, streamed to the
//             server for distillation there; the ids of notes served in the session go with them
//
// Configuration: the url in .thinker/config.json (`sync: {url, repo?}`, committable) or
// THINKER_SYNC_URL; the token in ~/.thinker/sync.json (THINKER_HOME) or THINKER_SYNC_TOKEN. The
// repository is named by its origin (store.js:repoId), so every clone and worktree syncs as one.
// State of this checkout: .thinker/local/sync.json. THINKER_SYNC=off disables it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repoId, LOCAL_FIELDS } from './store.js';
import { prepareContent, contentErrors } from './share.js';
import { parseTranscript, findSessions } from './transcripts.js';
import { injectedIds } from './distill.js';
import { wire, digest, REPO_ID } from './server/repos.js';

export const PULL_EVERY_MS = 5 * 60_000;
const CLIP = 6000;
const CHUNK_BYTES = 2 << 20;

const home = () => process.env.THINKER_HOME || path.join(os.homedir(), '.thinker');
const credentialsFile = () => path.join(home(), 'sync.json');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const normalizeUrl = u => String(u || '').trim().replace(/\/+$/, '');

export function readCredentials() { return readJson(credentialsFile(), {}); }
export function writeCredentials(creds) {
  fs.mkdirSync(home(), { recursive: true });
  const f = credentialsFile(), tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, f);
}

// Where this checkout syncs to; null when it does not (no url, no token, or switched off).
export function syncConfig(store) {
  if (/^(off|0|false)$/i.test(process.env.THINKER_SYNC || '')) return null;
  const c = store.config().sync || {};
  if (c.enabled === false) return null;
  const url = normalizeUrl(process.env.THINKER_SYNC_URL || c.url);
  if (!url) return null;
  const repo = String(c.repo || repoId(store.repo)).toLowerCase();
  if (!REPO_ID.test(repo)) return null;
  const token = process.env.THINKER_SYNC_TOKEN || readCredentials()[url]?.token;
  if (!token) return null;
  return { url, repo, token, pushAll: !!c.pushAll };
}

export function login(store, { url, token, repo }) {
  url = normalizeUrl(url);
  if (!/^https?:\/\//.test(url)) throw new Error('url: http(s)://host[:port]');
  if (repo && !REPO_ID.test(repo)) throw new Error('repo: github.com/owner/repo');
  const cfgFile = path.join(store.init().dir, 'config.json');
  const cfg = readJson(cfgFile, {});
  cfg.sync = { ...(cfg.sync || {}), url };
  if (repo) cfg.sync.repo = repo.toLowerCase(); else delete cfg.sync.repo;
  delete cfg.sync.enabled;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
  if (token) { const creds = readCredentials(); creds[url] = { token, at: new Date().toISOString() }; writeCredentials(creds); }
  return syncConfig(store);
}
export function logout(store) {
  const cfgFile = path.join(store.dir, 'config.json');
  const cfg = readJson(cfgFile, {});
  const url = normalizeUrl(cfg.sync?.url);
  delete cfg.sync;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
  if (url) { const creds = readCredentials(); delete creds[url]; writeCredentials(creds); }
  try { fs.unlinkSync(stateFile(store)); } catch {}
}

const stateFile = store => path.join(store.localDir, 'sync.json');
export function syncState(store) { return readJson(stateFile(store), { cursor: 0, sessions: {} }); }
function saveState(store, state) {
  fs.mkdirSync(store.localDir, { recursive: true });
  if (!fs.existsSync(path.join(store.localDir, '.gitignore'))) fs.writeFileSync(path.join(store.localDir, '.gitignore'), '*\n');
  const f = stateFile(store), tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, f);
}

export async function request(cfg, method, p, body, { timeoutMs = 30_000 } = {}) {
  const res = await fetch(`${cfg.url}${p}`, { method, headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json', 'user-agent': 'thinker-sync' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  let json = null; try { json = await res.json(); } catch {}
  if (!res.ok) { const e = new Error(`${method} ${p}: ${res.status} ${json?.error || res.statusText}`); e.status = res.status; throw e; }
  return json;
}
const repoPath = cfg => `/v1/repos/${encodeURIComponent(cfg.repo)}`;

// What of a local note goes up: its content without this checkout's state and source transcript path.
function outbound(store, note, ids) {
  const cleaned = prepareContent(note, ids);
  return wire({ ...note, ...cleaned });
}
const keepLocal = note => { const out = {}; if (!note) return out; for (const k of LOCAL_FIELDS) if (note[k] !== undefined && !['status', 'invalidReason', 'stale', 'verifying', 'history', 'attest'].includes(k)) out[k] = note[k]; return out; };

// A note as the server has it, into the local tier. The committed copy of a note wins over it;
// otherwise the server's content replaces the local one and this checkout's own state is kept.
function applyRemote(store, remote, seq) {
  if (!remote?.id || store.isShared(remote.id)) return false;
  const local = store.get(remote.id);
  const { status, invalidReason, ...content } = remote;
  const next = { ...keepLocal(local), ...content, status: status === 'invalid' ? 'invalid' : 'fresh', sync: { digest: digest(remote), seq, at: new Date().toISOString() } };
  if (status === 'invalid') next.invalidReason = invalidReason || 'retired on the server';
  // already here as the server has it (this checkout pushed it, say): nothing to do
  if (local?.sync?.digest === next.sync.digest && (local.status === 'invalid') === (next.status === 'invalid')) return false;
  store.put(next);
  return true;
}

export async function pull(store, cfg = syncConfig(store), { state = syncState(store), save = true } = {}) {
  if (!cfg) return { skipped: 'not configured' };
  const r = await request(cfg, 'GET', `${repoPath(cfg)}/notes?since=${state.cursor || 0}`);
  let applied = 0, deleted = 0;
  for (const n of r.notes || []) if (applyRemote(store, n, r.seq)) applied++;
  for (const id of r.deleted || []) { const local = store.get(id); if (local?.sync && !store.isShared(id) && store.removeLocal(id)) deleted++; }
  state.cursor = r.seq; state.pulledAt = new Date().toISOString(); state.distills = !!r.distills;
  if (r.truncated) state.cursor = state.cursor; // more than one page: the next pull starts from the new cursor and misses nothing journaled after it
  if (save) saveState(store, state);
  return { applied, deleted, seq: r.seq, received: (r.notes || []).length, distills: !!r.distills };
}

export function planPush(store, cfg = syncConfig(store) || {}) {
  const notes = store.list();
  const ids = new Set(notes.map(n => n.id));
  const items = [], skipped = [];
  for (const n of store.localNotes()) {
    // a synced note goes up as it is: it was normalized when first pushed, or came from the server
    const w = n.sync?.digest ? wire(n) : outbound(store, n, ids);
    const d = digest(w);
    if (n.sync?.digest) {
      if (d === n.sync.digest || n.sync.rejected === d) continue;
      if (n.status === 'invalid') items.push({ op: 'del', base: n.sync.digest, note: { id: n.id, invalidReason: n.invalidReason }, local: n, digest: d });
      else items.push({ op: 'put', base: n.sync.digest, note: w, local: n, digest: d });
      continue;
    }
    if (n.sync?.rejected === d) continue;
    const reasons = contentErrors(w);
    if (n.status !== 'fresh') reasons.push(`status is ${n.status || 'unknown'}`);
    if (!cfg.pushAll && !['human', 'pr', 'doc'].includes(n.source?.type) && !(n.attest?.confirmed > 0)) reasons.push('not confirmed by a session yet');
    if (reasons.length) { skipped.push({ id: n.id, reasons }); continue; }
    items.push({ op: 'put', note: w, local: n, digest: d });
  }
  return { items, skipped };
}

export async function push(store, cfg = syncConfig(store), { dry = false } = {}) {
  if (!cfg) return { skipped: 'not configured' };
  const plan = planPush(store, cfg);
  const r = { pushed: 0, retired: 0, conflicts: 0, rejected: 0, planned: plan.items.length, skipped: plan.skipped };
  if (dry || !plan.items.length) return r;
  for (let i = 0; i < plan.items.length; i += 200) {
    const batch = plan.items.slice(i, i + 200);
    const res = await request(cfg, 'POST', `${repoPath(cfg)}/notes`, { items: batch.map(({ op, base, note }) => ({ op, base, note })) });
    const byId = new Map((res.results || []).map(x => [x.id, x]));
    for (const item of batch) {
      const x = byId.get(item.note.id); if (!x) continue;
      const n = store.get(item.local.id); if (!n) continue;
      if (x.result === 'added' || x.result === 'updated') {
        // the note here takes the normalized content that went up (no transcript path, rounded confidence), so it matches the server's
        const { status: _s, invalidReason: _i, ...content } = item.note;
        store.put({ ...n, ...(item.op === 'put' ? content : {}), sync: { digest: x.digest, seq: res.seq, at: new Date().toISOString() } }); r.pushed++;
      }
      else if (x.result === 'retired') { n.sync = { digest: x.digest, seq: res.seq, at: new Date().toISOString() }; store.put(n); r.retired++; }
      else if (x.result === 'conflict' || x.result === 'exists') {
        r.conflicts++;
        try { const got = await request(cfg, 'GET', `${repoPath(cfg)}/notes/${encodeURIComponent(item.note.id)}`); applyRemote(store, got.note, got.seq); } catch {}
      } else { n.sync = { ...(n.sync || {}), rejected: item.digest, reason: x.result === 'duplicate' ? `duplicate of ${x.of}` : x.error || x.result }; store.put(n); r.rejected++; }
    }
  }
  const state = syncState(store); state.pushedAt = new Date().toISOString(); saveState(store, state);
  store.log({ op: 'sync-push', ...r, skipped: r.skipped.length });
  return r;
}

export async function syncNotes(store, cfg = syncConfig(store), opts = {}) {
  if (!cfg) return { skipped: 'not configured' };
  const pulled = await pull(store, cfg, opts);
  const pushed = await push(store, cfg, opts);
  store.log({ op: 'sync', pulled: pulled.applied, deleted: pulled.deleted, pushed: pushed.pushed, retired: pushed.retired, conflicts: pushed.conflicts, rejected: pushed.rejected });
  return { pulled: pulled.applied, deleted: pulled.deleted, pushed: pushed.pushed, retired: pushed.retired, conflicts: pushed.conflicts, rejected: pushed.rejected, distills: pulled.distills };
}

// --- sessions ---------------------------------------------------------------------------------------
const clip = s => { s = String(s ?? ''); return s.length > CLIP ? s.slice(0, CLIP) + `…[+${s.length - CLIP} chars]` : s; };
const sessionKey = s => String(s).replace(/[^\w.-]/g, '_').slice(0, 120);

// Events of a session not yet sent, from a transcript of any agent or a trace the hooks recorded.
export function sessionDelta(store, { file, session }, state) {
  const key = sessionKey(session);
  const st = state.sessions[key] || { line: 0, sent: [] };
  let parsed; try { parsed = parseTranscript(file, { fromLine: st.line || 0 }); } catch { return null; }
  const events = parsed.events.filter(e => ['prompt', 'say', 'tool'].includes(e.t)).map(e => e.t === 'tool' ? { t: 'tool', name: e.name, input: e.input, result: clip(e.result) } : { t: e.t, text: clip(e.text) });
  const ids = new Set();
  if (parsed.format !== 'gemini') for (const id of injectedIds(file, { fromLine: st.line || 0 })) ids.add(id);
  for (const n of store.list()) if ((n.servedIn || []).includes(session)) ids.add(n.id);
  const served = [...ids].filter(id => !(st.sent || []).includes(id));
  return { key, events, served, line: parsed.lineCount, st };
}

export async function pushSessions(store, cfg = syncConfig(store), { sessions, days = 2, idleMin = 0, max = 20, end = false, dry = false, client } = {}) {
  if (!cfg) return { skipped: 'not configured' };
  const state = syncState(store); state.sessions = state.sessions || {};
  const list = sessions || findSessions(store.repo, { sinceMs: days * 86400_000, storeDir: store.dir }).filter(s => Date.now() - s.mtime >= idleMin * 60_000);
  const r = { sessions: 0, events: 0, distills: state.distills };
  for (const s of list.slice(0, max)) {
    if (!s.file || !fs.existsSync(s.file)) continue;
    const d = sessionDelta(store, s, state);
    if (!d) continue;
    const ending = end && !d.st.ended;
    if (!d.events.length && !d.served.length && !ending) continue;
    if (dry) { r.sessions++; r.events += d.events.length; continue; }
    const payload = [...d.events];
    if (d.served.length) payload.push({ t: 'served', ids: d.served });
    if (ending) payload.push({ t: 'end' });
    // in chunks, so one request stays well under the server's limit
    let chunk = [], size = 0, res;
    const flush = async () => { if (!chunk.length) return; res = await request(cfg, 'POST', `${repoPath(cfg)}/sessions/${encodeURIComponent(d.key)}`, { client: client || s.client, events: chunk }, { timeoutMs: 60_000 }); chunk = []; size = 0; };
    for (const e of payload) { const len = JSON.stringify(e).length; if (size + len > CHUNK_BYTES) await flush(); chunk.push(e); size += len; }
    await flush();
    state.sessions[d.key] = { line: d.line, sent: [...new Set([...(d.st.sent || []), ...d.served])].slice(-200), ended: d.st.ended || ending, at: new Date().toISOString(), file: path.basename(s.file) };
    if (res && typeof res.distills === 'boolean') state.distills = res.distills;
    r.sessions++; r.events += d.events.length;
  }
  r.distills = state.distills;
  if (!dry) { saveState(store, state); if (r.sessions) store.log({ op: 'sync-sessions', sessions: r.sessions, events: r.events }); }
  return r;
}

// For the stop hook: stream when configured; distill here too only when the server cannot.
export function streamingPlan(store) {
  const cfg = syncConfig(store);
  if (!cfg) return { stream: false, local: true };
  const state = syncState(store);
  return { stream: true, local: state.distills === false, cfg };
}
export function pullDue(store, everyMs = PULL_EVERY_MS) {
  const state = syncState(store);
  return !state.pulledAt || Date.now() - Date.parse(state.pulledAt) > everyMs;
}

export async function status(store) {
  const cfg = syncConfig(store);
  if (!cfg) return { configured: false, url: normalizeUrl(process.env.THINKER_SYNC_URL || store.config().sync?.url) || null, repo: repoId(store.repo), reason: !normalizeUrl(process.env.THINKER_SYNC_URL || store.config().sync?.url) ? 'no url: thinker sync login <url> --token <t>' : 'no token for this url: thinker sync login <url> --token <t>' };
  const state = syncState(store);
  const plan = planPush(store, cfg);
  const synced = store.localNotes().filter(n => n.sync?.digest).length;
  let server = null, error = null;
  try { server = await request(cfg, 'GET', repoPath(cfg), undefined, { timeoutMs: 10_000 }); } catch (e) { error = e.message; }
  return { configured: true, url: cfg.url, repo: cfg.repo, cursor: state.cursor || 0, pulledAt: state.pulledAt || null, pushedAt: state.pushedAt || null, synced, toPush: plan.items.length, held: plan.skipped.length, sessions: Object.keys(state.sessions || {}).length, server, error };
}
export function renderStatus(s) {
  if (!s.configured) return `sync: off (${s.reason})`;
  const lines = [`sync: ${s.url} as ${s.repo}`, `  cursor ${s.cursor}; ${s.synced} synced notes here, ${s.toPush} to push, ${s.held} held back; ${s.sessions} sessions streamed`, `  last pull ${s.pulledAt || 'never'}, last push ${s.pushedAt || 'never'}`];
  if (s.server) lines.push(`  server: ${s.server.notes} notes (${s.server.invalid} retired), seq ${s.server.seq}, ${s.server.sessions} sessions, ${s.server.cloned ? `checkout at ${(s.server.head || '').slice(0, 8)}` : `no checkout${s.server.cloneError ? ` (${s.server.cloneError})` : ''}`}, ${s.server.distills ? 'distills sessions' : 'cannot distill (no checkout or model); sessions are distilled here'}`);
  if (s.error) lines.push(`  server unreachable: ${s.error}`);
  return lines.join('\n');
}
