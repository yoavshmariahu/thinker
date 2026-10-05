// A prompt's delivery ledger is shared by its hook and MCP server. The opaque ID travels in
// the hook context and tool arguments; never infer the active prompt from repository-global
// "most recent session" state, which mixes concurrent agents.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const digest = s => createHash('sha256').update(s).digest('hex');
const fingerprint = n => digest(JSON.stringify([n.title, n.kind, n.body, n.applies, n.status, n.stale, n.violated, n.mutability, (n.deps || []).map(d => [d.path, d.symbol, d.hash])]));
const directory = store => path.join(store.dir, 'state', 'prompt-delivery');
const stateFile = (store, id) => path.join(directory(store), digest(id) + '.json');
const sessionFile = (store, session) => path.join(directory(store), 'session-' + digest(session) + '.json');
export const promptHint = id => `Thinker prompt_id: ${id}. Pass this prompt_id to every Thinker retrieval tool in this user prompt. For a later user prompt use its new ID, or choose a fresh unique ID if none is supplied.`;

export function beginPrompt(store, session) {
  const id = randomUUID(), dir = directory(store);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFile(store, id), JSON.stringify({ seen: {} }));
  if (session && session !== 'unknown') fs.writeFileSync(sessionFile(store, session), JSON.stringify({ id }));
  // Short-lived bookkeeping, never shared notes. Keep enough history for long-running prompts.
  const cutoff = Date.now() - 7 * 86400_000;
  for (const file of fs.readdirSync(dir)) if (file.endsWith('.json')) {
    try { const p = path.join(dir, file); if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch {}
  }
  return id;
}
export function currentPrompt(store, session) {
  if (!session || session === 'unknown') return null;
  try { return JSON.parse(fs.readFileSync(sessionFile(store, session), 'utf8')).id; } catch { return null; }
}

// Explicit IDs from hooks can cross connections. Agent-chosen IDs without a hook are local
// to this MCP connection, so two agents choosing "turn-1" cannot suppress each other's notes.
export function promptScope(store, id, connection) {
  if (fs.existsSync(stateFile(store, id))) return id;
  return `${connection}:${id}`;
}

export async function withPromptDelivery(store, id, fn) {
  if (!id) return fn(undefined);
  fs.mkdirSync(directory(store), { recursive: true });
  const file = stateFile(store, id), lock = file + '.lock', deadline = Date.now() + 30_000;
  let fd;
  while (fd === undefined) {
    try { fd = fs.openSync(lock, 'wx'); fs.writeFileSync(fd, String(process.pid)); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { const pid = Number(fs.readFileSync(lock, 'utf8')); if (pid) process.kill(pid, 0); }
      catch (e) { if (e.code === 'ESRCH') { try { fs.unlinkSync(lock); } catch {} continue; } }
      if (Date.now() > deadline) throw new Error('Timed out waiting for this prompt’s note delivery; retry the tool.');
      await sleep(10);
    }
  }
  try {
    let seen = {};
    try { seen = JSON.parse(fs.readFileSync(file, 'utf8')).seen || {}; } catch {}
    const delivery = {
      suppressed: new Set(),
      filter(notes) { return notes.filter(n => { if (seen[n.id] !== fingerprint(n)) return true; this.suppressed.add(n.id); return false; }); },
      mark(notes) { for (const n of notes) seen[n.id] = fingerprint(n); },
    };
    const result = await fn(delivery);
    const tmp = file + `.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ seen })); fs.renameSync(tmp, file);
    return result;
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
