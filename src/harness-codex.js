// Codex records the visible skill catalog and deferred MCP namespace descriptions, not always
// the full tool schemas. Count only recorded text; settings are control metadata, never load evidence.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import { estTokens } from './rank.js';

const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
export const codexConfigFile = repo => path.join(repo, '.codex', 'config.toml');
export function codexHarnessConfig(repo, { home = os.homedir(), env = process.env } = {}) {
  const user = path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml');
  const parents = []; for (let d = repo; ; d = path.dirname(d)) { parents.unshift(codexConfigFile(d)); if (path.dirname(d) === d) break; }
  const servers = new Map(), plugins = new Map(), skills = new Map();
  for (const file of [...new Set(['/etc/codex/config.toml', user, ...parents])]) {
    const text = readText(file); if (!text) continue;
    // An invalid layer makes the effective configuration unknown. Do not offer edits against it.
    const j = parse(text), scope = file === user ? 'user' : 'project';
    for (const [name, s] of Object.entries(j.mcp_servers || {})) servers.set(name, { name, scope, off: s.enabled === undefined ? (servers.get(name)?.off || false) : s.enabled === false });
    for (const [id, p] of Object.entries(j.plugins || {})) plugins.set(id, { id, name: id.split('@')[0], scope, off: p.enabled === undefined ? (plugins.get(id)?.off || false) : p.enabled === false });
    if (j.skills?.config) skills.clear(); // TOML config arrays replace the inherited array.
    for (const s of j.skills?.config || []) if (s.path) skills.set(path.resolve(path.dirname(file), s.path), s.enabled);
  }
  return { servers, plugins, skills };
}

export function codexSessionHarness(file) {
  const loaded = new Map(), used = new Set(), texts = new Map(), skillPaths = new Map(), coverage = new Set(), calls = new Set();
  let cwd, start, id, parent, excluded = false;
  const put = (key, text) => { loaded.set(key, Math.max(loaded.get(key) || 0, estTokens(text))); texts.set(key, text); };
  const catalog = text => {
    // Only the catalog, never a skill example in a tool result or quoted user text.
    const section = String(text).match(/### Available skills\r?\n([\s\S]*?)(?=\n#|<\/skills_instructions>|$)/)?.[1];
    if (section === undefined) return;
    coverage.add('skill');
    const roots = Object.fromEntries([...String(text).matchAll(/^- `([^`]+)` = `([^`]+)`/gm)].map(m => [m[1], m[2]]));
    for (const m of section.matchAll(/^- ([^\s]+): ([\s\S]*?)(?=\n- |$)/gm)) {
      const key = `skill:${m[1]}`; put(key, m[0]);
      const ref = m[2].match(/\(file: (.+?)\)/)?.[1];
      if (ref) { const [root, ...rest] = ref.split('/'); const f = roots[root] ? path.join(roots[root], ...rest) : ref; if (path.isAbsolute(f)) skillPaths.set(key, f); }
    }
  };
  const namespaces = (tools, complete = true) => {
    if (!tools || typeof tools !== 'object' || Array.isArray(tools)) return;
    if (complete) coverage.add('mcp');
    for (const [name, desc] of Object.entries(tools)) if (name.startsWith('mcp__') && typeof desc === 'string') {
      // A deferred namespace can itself contain __ (codex_apps__pets). Keep its exact identity.
      put(`mcp:${name.slice(5)}`, `${name}: ${desc}`);
    }
  };
  // the files a patch edited and the skills opened, in order (skill-suggest.js reads them)
  const inputs = [], edited = [], skillOpens = [];
  for (const line of readText(file).split('\n')) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    const p = j.payload || {};
    if (j.type === 'session_meta') {
      cwd = p.cwd; start = p.timestamp || j.timestamp; id = p.id || p.session_id; parent = p.parent_thread_id;
      excluded = /guardian|review/i.test(p.thread_source || '') || /guardian/i.test(JSON.stringify(p.source));
      if (excluded) break;
    }
    if (j.type === 'world_state') {
      if (p.state?.host_skills?.includeInstructions !== false) catalog(p.state?.host_skills?.body || '');
      namespaces(p.state?.tools, p.full !== false);
    }
    if (j.type === 'token_usage_record' && p.response_id) calls.add(p.response_id);
    if (j.type !== 'response_item') continue;
    if (p.type === 'message' && p.role === 'developer') {
      const text = (p.content || []).map(c => c.text || '').join('\n'); catalog(text);
      const section = text.match(/Deferred tool namespaces:\s*\n([\s\S]*?)(?=<\/tools>|\n\n|$)/)?.[1];
      if (section !== undefined) namespaces(Object.fromEntries([...section.matchAll(/^- (mcp__[^\s:]+)(?:: (.*))?$/gm)].map(m => [m[1], m[2] || ''])));
    }
    if (['function_call', 'custom_tool_call'].includes(p.type)) {
      const text = `${p.name || ''}\n${typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments || '')}\n${p.input || ''}`;
      inputs.push(text);
      for (const m of text.matchAll(/skills\/([\w.-]+)\/SKILL\.md/g)) skillOpens.push({ skill: m[1], at: j.timestamp });
      for (const m of text.replace(/\\n/g, '\n').matchAll(/^\*\*\* (?:Update|Add|Delete) File: ([^\n"\\]+)/gm)) { const f = m[1].trim(); if (!edited.includes(f)) edited.push(f); }
    }
    if (p.type === 'message' && p.role === 'user') for (const c of p.content || []) for (const m of String(c.text || '').matchAll(/\$([\w:.-]+)/g)) used.add(`skill:${m[1]}`);
  }
  const input = inputs.join('\n');
  // Includes calls dispatched through functions.exec and skill files read through the shell.
  for (const m of input.matchAll(/mcp__([\w-]+(?:__[\w-]+)+)/g)) {
    const name = m[1]; let matched = false;
    for (const key of loaded.keys()) if (key.startsWith('mcp:') && (name === key.slice(4) || name.startsWith(`${key.slice(4)}__`))) { used.add(key); matched = true; }
    if (!matched) used.add(`mcp:${name.split('__')[0]}`);
  }
  for (const [key, file] of skillPaths) if (input.includes(file) || input.includes(JSON.stringify(file).slice(1, -1)) || input.includes(`/${path.basename(path.dirname(file))}/SKILL.md`)) used.add(key);
  const skillReads = new Set([...input.matchAll(/[^\s"'`\\]+\/SKILL\.md/g)].map(m => m[0]));
  if (excluded) { skillReads.clear(); loaded.clear(); coverage.clear(); used.clear(); edited.length = 0; skillOpens.length = 0; }
  return { loaded, used, texts, skillPaths, skillReads, coverage, cwd, start, id, parent, calls: calls.size, client: 'codex', edited, skillOpens };
}

// Local plugin manifests establish ownership even when tool and plugin names differ. Never print
// server definitions: they may include credentials. Multiple cached versions contribute names only.
function pluginTools(dir) {
  const servers = new Set(); let known = false;
  for (const name of ['plugin.json', '.codex-plugin/plugin.json']) {
    try {
      const manifest = JSON.parse(readText(path.join(dir, name)));
      const extension = manifest.extensions?.['com.openai'] || manifest;
      const ref = extension.mcpServers ?? manifest.mcpServers;
      let definitions = typeof ref === 'object' ? ref : null;
      if (typeof ref === 'string' && ref.startsWith('./') && !ref.split('/').includes('..')) definitions = JSON.parse(readText(path.join(dir, ref)));
      const conventional = ['mcp.json', '.mcp.json'].find(f => fs.existsSync(path.join(dir, f)));
      if (!definitions && conventional) definitions = JSON.parse(readText(path.join(dir, conventional)));
      known = !extension.apps && (!ref || !!definitions);
      for (const server of Object.keys(definitions?.mcpServers || definitions || {})) servers.add(server.replace(/[^a-zA-Z0-9_]/g, '_'));
      break;
    } catch { /* Missing or malformed ownership remains unknown. */ }
  }
  return { servers, known };
}

export function codexHarnessUsage(repo, sessions, options = {}) {
  let config, valid = true; try { config = codexHarnessConfig(repo, options); } catch { valid = false; config = { servers: new Map(), plugins: new Map(), skills: new Map() }; }
  const read = sessions.map(s => ({ s, h: codexSessionHarness(s.file) }));
  const plugins = [...config.plugins.values()].map(p => {
    const [name, market] = p.id.split('@');
    const dir = path.join(process.env.CODEX_HOME || path.join(options.home || os.homedir(), '.codex'), 'plugins/cache', market || '', name);
    let versions = []; try { versions = fs.readdirSync(dir); } catch {}
    const metadata = versions.map(v => pluginTools(path.join(dir, v)));
    return { ...p, servers: new Set(metadata.flatMap(m => [...m.servers])), toolsKnown: metadata.length > 0 && metadata.every(m => m.known) };
  });
  const pluginFor = (key, h) => {
    if (key.startsWith('mcp:')) { const owners = plugins.filter(p => p.servers.has(key.slice(4))); return owners.length === 1 ? owners[0] : null; }
    const file = h.skillPaths.get(key);
    // Local plugin identity is established by both its installed path and a config entry.
    return file && plugins.find(p => file.includes(`/plugins/cache/`) && file.includes(`/${p.name}/`) && key.startsWith(`skill:${p.name}:`));
  };
  const rows = new Map(); let counted = 0; const calls = [];
  for (const { s, h } of read) {
    if (!h.loaded.size || h.parent) continue;
    counted++; calls.push(h.calls);
    const descendants = new Set(h.id ? [h.id] : []); let size;
    do { size = descendants.size; for (const r of read) if (r.h.parent && descendants.has(r.h.parent)) descendants.add(r.h.id); } while (size !== descendants.size);
    const used = new Set(read.filter(r => descendants.has(r.h.id)).flatMap(r => [...r.h.used]));
    for (const k of h.used) used.add(k);
    const reads = read.filter(r => descendants.has(r.h.id)).flatMap(r => [...r.h.skillReads]);
    for (const [key, file] of h.skillPaths) if (reads.some(p => p === file || p.endsWith(`/${path.basename(path.dirname(file))}/SKILL.md`))) used.add(key);
    // A plugin may supply tools under an unrelated namespace. If its installed manifest names
    // them, count those calls as plugin use even when only its skills were catalogued.
    const usedPlugins = new Set();
    for (const plugin of plugins) {
      const toolUsed = [...used].some(k => k.startsWith('mcp:') && (plugin.servers.has(k.slice(4)) || !plugin.toolsKnown));
      if (toolUsed) usedPlugins.add(plugin.id);
    }
    const grouped = new Map();
    for (const [key, tokens] of h.loaded) {
      const plugin = pluginFor(key, h), raw = key.slice(key.indexOf(':') + 1), kind = plugin ? 'plugin' : key.split(':')[0];
      const k = `codex:${plugin ? `plugin:${plugin.id}` : key}`;
      if (!grouped.has(k)) grouped.set(k, { key: k, client: 'codex', kind, name: plugin?.name || raw, id: plugin?.id, tokens: 0, used: false, skills: [], texts: {}, evidenceKeys: [], dir: h.skillPaths.get(key) && path.dirname(h.skillPaths.get(key)) });
      const g = grouped.get(k); g.tokens += tokens; g.used ||= used.has(key) || (plugin && usedPlugins.has(plugin.id)); g.texts[key] = h.texts.get(key)?.slice(0, 1200); g.evidenceKeys.push(key);
      if (kind === 'plugin' && key.startsWith('skill:')) g.skills.push(raw);
    }
    for (const [key, g] of grouped) {
      if (!rows.has(key)) rows.set(key, { ...g, tokens: 0, loaded: 0, used: 0, lastUsed: null });
      const r = rows.get(key); r.loaded++; r.tokens += g.tokens; if (g.used) { r.used++; r.lastUsed = Math.max(r.lastUsed || 0, s.mtime); }
      r.texts = { ...r.texts, ...g.texts }; r.evidenceKeys = [...new Set([...r.evidenceKeys, ...g.evidenceKeys])];
    }
  }
  const sorted = calls.sort((x, y) => x - y);
  return { sessions: counted, calls: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0, sources: [...rows.values()].map(r => {
    const setting = r.kind === 'mcp' ? config.servers.get(r.name) : r.kind === 'plugin' ? config.plugins.get(r.id) : null;
    const skill = r.dir && !r.dir.includes('/.system/') && !r.dir.includes('/plugins/cache/') && fs.existsSync(path.join(r.dir, 'SKILL.md'));
    return { ...r, tokens: Math.round(r.tokens / r.loaded), scope: setting?.scope || (skill ? 'project' : null), off: setting?.off || (r.dir && (config.skills.get(r.dir) === false || config.skills.get(path.join(r.dir, 'SKILL.md')) === false)), how: valid && (setting || skill) ? `codex-${r.kind}` : null };
  }) };
}

// Only enabled booleans in this checkout's config are changed. A full TOML parser preserves unrelated
// values (including quoted keys, inline tables and arrays). The harness owns backups and atomic writes.
export function editCodexSetting(text, source, undo) {
  const j = text ? parse(text) : {}, kind = source.kind;
  let target, created = false, inherited;
  if (kind === 'skill') {
    j.skills ||= {};
    if (!j.skills.config && !undo) { inherited = source.inheritedSkills || []; j.skills.config = structuredClone(inherited); }
    j.skills.config ||= [];
    target = j.skills.config.find(s => s.path === source.dir || s.path === path.join(source.dir, 'SKILL.md'));
    if (!target && undo) return { text, prev: undefined };
    // Codex matches a skill switch by its SKILL.md path, not its directory
    if (!target) { created = true; j.skills.config.push(target = { path: path.join(source.dir, 'SKILL.md') }); }
  } else { const group = kind === 'mcp' ? 'mcp_servers' : 'plugins'; j[group] ||= {}; target = j[group][source.id || source.name] ||= {}; }
  const prev = target.enabled;
  if (undo) { if (target.enabled !== false) return { text, prev }; if (undo.created && kind === 'skill' && Object.keys(target).every(k => ['path', 'enabled'].includes(k))) j.skills.config = j.skills.config.filter(s => s !== target); else if (undo.prev === undefined) delete target.enabled; else target.enabled = undo.prev; }
  else target.enabled = false;
  if (undo?.inherited && JSON.stringify(j.skills?.config) === JSON.stringify(undo.inherited)) delete j.skills.config;
  if (j.skills && !Object.keys(j.skills).length) delete j.skills;
  return { text: stringify(j), prev, created, inherited };
}
