// Cursor's transcripts hold the prompts, the agent's text and its tool calls, and nothing of what the
// session loaded. The editor writes the MCP servers its agent has into the project's folder
// (~/.cursor/projects/<slug>/mcps/<identifier>/: SERVER_METADATA.json, INSTRUCTIONS.md, tools/*.json) when the
// window loads them, which matches the namespace catalog the agent is shown. The prompt hook copies that
// inventory once per session (snapshotCursorInventory), and the copy is the load evidence; the agent CLI
// writes no inventory, so its sessions are not counted (checked on agent 2026.10.16, Cursor 3.25.9).
//
// Cursor has no per-repository switch the editor reads: it keeps its MCP toggles in its own storage, and for a
// user's server only machine-wide (`mcp_profile_scoped_global_disabled_state`); `agent mcp disable` writes
// mcp-disabled.json, which only the CLI reads; skills have only `disable-model-invocation` in their own file.
// So a Cursor source is switched off machine-wide, by taking its entry out of ~/.cursor/mcp.json (read by the
// editor and the CLI alike), and the evidence for it is every Cursor session on the machine, not one repository's.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { estTokens } from './rank.js';

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const ls = d => { try { return fs.readdirSync(d); } catch { return []; } };
const DAY = 86_400_000;
// thinker's own server is what the hooks and this report run through
const KEEP = new Set(['thinker']);

const cursorData = (home = os.homedir(), env = process.env) => env.CURSOR_DATA_DIR?.trim() || path.join(home, '.cursor');
export const cursorSlug = p => String(p).replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
export const cursorProjectDir = (root, { home, env } = {}) => path.join(cursorData(home, env), 'projects', cursorSlug(root));
export const cursorMcpFile = (home = os.homedir(), env = process.env) => path.join(env.CURSOR_CONFIG_DIR?.trim() || path.join(home, '.cursor'), 'mcp.json');
const snapshotDir = thinkerHome => path.join(thinkerHome, 'state', 'cursor-inventory');

// The servers in a project's inventory, each with the text the agent's catalog carries for it: its
// identifier, its tools' names and its instructions (the tool schemas are deferred until looked up).
export function cursorInventory(projectDir) {
  const out = {};
  for (const id of ls(path.join(projectDir, 'mcps'))) {
    const dir = path.join(projectDir, 'mcps', id), meta = readJson(path.join(dir, 'SERVER_METADATA.json')) || {};
    let instructions = ''; try { instructions = fs.readFileSync(path.join(dir, 'INSTRUCTIONS.md'), 'utf8'); } catch {}
    const tools = ls(path.join(dir, 'tools')).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort();
    const text = `${id}: tools ${tools.join(', ')}\n${instructions}`;
    out[meta.serverIdentifier || id] = { name: String(meta.serverName || id), tokens: estTokens(text), text: text.slice(0, 1200) };
  }
  return out;
}

// The prompt hook: the inventory as the session sees it, once per session, under thinker's home. Nothing is
// written when the project has no inventory.
export function snapshotCursorInventory({ session, roots = [], transcript, thinkerHome, home, env, now = Date.now() }) {
  if (!session || session === 'unknown' || !thinkerHome) return null;
  const file = path.join(snapshotDir(thinkerHome), `${String(session).replace(/[^\w.-]/g, '_')}.json`);
  if (fs.existsSync(file)) return null;
  for (const root of roots.filter(Boolean)) {
    const servers = cursorInventory(cursorProjectDir(root, { home, env }));
    if (!Object.keys(servers).length) continue;
    const snap = { session, at: new Date(now).toISOString(), root, transcript: transcript || null, servers };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(snap) + '\n');
    for (const f of ls(path.dirname(file))) { const p = path.join(path.dirname(file), f); try { if (now - fs.statSync(p).mtimeMs > 90 * DAY) fs.rmSync(p); } catch {} }
    return snap;
  }
  return null;
}
export function cursorSnapshots(thinkerHome, { sinceMs = 30 * DAY, now = Date.now() } = {}) {
  return ls(snapshotDir(thinkerHome)).map(f => readJson(path.join(snapshotDir(thinkerHome), f))).filter(s => s?.servers && now - Date.parse(s.at) <= sinceMs);
}

// The servers a Cursor transcript's tool calls reached: CallDynamicTool and GetDynamicTools name the namespace
// (the inventory's identifier, `user-thinker`; earlier transcripts the bare name, `thinker`).
export function cursorSessionUse(file) {
  const used = new Set();
  let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch { return used; }
  for (const line of text.split('\n')) {
    if (!line.includes('DynamicTool')) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    for (const c of Array.isArray(j.message?.content) ? j.message.content : []) {
      if (c?.type === 'tool_use' && /^(Call|Get)DynamicTools?$/.test(c.name) && c.input?.namespace) used.add(String(c.input.namespace));
    }
  }
  return used;
}

// The user's servers in ~/.cursor/mcp.json: the ones a machine-wide switch can take out.
export function cursorHarnessConfig({ home = os.homedir(), env = process.env } = {}) {
  const file = cursorMcpFile(home, env), j = readJson(file);
  return { file, valid: j !== null || !fs.existsSync(file), servers: new Set(Object.keys(j?.mcpServers || {})) };
}
// a server of ~/.cursor/mcp.json is listed as user-<name>; built-in (cursor-*), project and plugin servers have no file switch
const userName = (id, { name }, servers) => !id.startsWith('user-') ? null : servers.has(id.slice(5)) ? id.slice(5) : servers.has(name) ? name : null;

// Every Cursor session on the machine with a snapshot, against what its transcript called.
export function cursorHarnessUsage({ thinkerHome, home = os.homedir(), env = process.env, days = 30, snapshots } = {}) {
  snapshots ??= cursorSnapshots(thinkerHome, { sinceMs: days * DAY });
  const config = cursorHarnessConfig({ home, env }), rows = new Map();
  let counted = 0;
  for (const snap of snapshots) {
    if (!snap.transcript || !fs.existsSync(snap.transcript)) continue;
    counted++;
    const used = cursorSessionUse(snap.transcript), mtime = (() => { try { return fs.statSync(snap.transcript).mtimeMs; } catch { return null; } })();
    for (const [id, s] of Object.entries(snap.servers)) {
      const key = `cursor:mcp:${id}`;
      if (!rows.has(key)) rows.set(key, { key, client: 'cursor', kind: 'mcp', id, name: s.name, tokens: 0, loaded: 0, used: 0, prompts: 0, usedPrompts: 0, lastUsed: null, texts: {} });
      // Cursor records no model calls, so a session counts as one prompt: its size alone, as before
      const r = rows.get(key); r.loaded++; r.tokens += s.tokens; r.prompts += 1; r.texts[key] = s.text;
      if (used.has(id) || used.has(s.name)) { r.used++; r.usedPrompts++; r.lastUsed = Math.max(r.lastUsed || 0, mtime || 0); }
    }
  }
  return { sessions: counted, sources: [...rows.values()].map(r => {
    const name = userName(r.id, r, config.servers);
    return { ...r, name: name || r.name, tokens: Math.round(r.tokens / r.loaded), scope: name ? 'machine' : null, off: false, how: config.valid && name && !KEEP.has(name) ? 'cursor-mcp' : null };
  }) };
}

// Take a server's entry out of ~/.cursor/mcp.json, kept whole (it can hold tokens) in a 0600 file under
// thinker's home for undo; `put` returns it. The JSON file thinker writes is not the person's formatting,
// so nothing but the one entry changes.
const stashFile = thinkerHome => path.join(thinkerHome, 'state', 'cursor-mcp-off.json');
export function editCursorMcp({ name, thinkerHome, home, env, write }, undo) {
  const file = cursorMcpFile(home, env), stash = stashFile(thinkerHome);
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  let j; try { j = JSON.parse(before ?? '{}'); } catch { throw new Error(`${file} is not valid JSON; left as it is`); }
  const kept = readJson(stash) || {};
  const save = () => { fs.mkdirSync(path.dirname(stash), { recursive: true, mode: 0o700 }); fs.writeFileSync(stash, JSON.stringify(kept, null, 2) + '\n', { mode: 0o600 }); fs.chmodSync(stash, 0o600); };
  if (undo) {
    if (!kept[name]) throw new Error('its entry was not kept');
    // an entry the person added back by hand since stays as they wrote it
    if (!j.mcpServers?.[name]) { (j.mcpServers ||= {})[name] = kept[name]; write(file, j); }
    delete kept[name]; save();
  } else {
    if (!j.mcpServers?.[name]) throw new Error(`no entry named ${name} in ${file}`);
    kept[name] = j.mcpServers[name]; delete j.mcpServers[name];
    save(); write(file, j);
  }
  return { file, key: 'cursor', name };
}
