// What an agent's harness loads into every session, against what the sessions use: MCP servers,
// plugins and skills that cost context each time and are never called. "thinker loads what this
// repo needs, notes and tools alike": the notes are the cache, the tools are this report.
//
// Claude Code writes what it loaded into the session's transcript, so the cost is measured, not
// guessed from the settings: `deferred_tools_delta` names every deferred tool (mcp__<server>__<tool>)
// and the full definitions it surfaced, `mcp_instructions_delta` carries each server's instructions,
// `skill_listing` the skill list with its descriptions. What a session used is its tool calls (an MCP
// tool, the Skill tool) and the slash commands typed, its subagents' included.
// The settings are read to say where a source is switched on. Only an answer to the suggestion below
// writes them, and only for the repository it was asked in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { codexSessionHarness, codexHarnessUsage, codexHarnessConfig, codexConfigFile, editCodexSetting, partsOf } from './harness-codex.js';
import { desktopRecords, desktopSessionsDir, desktopSessionHarness, desktopUsed, DESKTOP_SECTIONS, CONNECTOR_TOOL } from './harness-desktop.js';
import { cursorHarnessUsage, cursorSnapshots, editCursorMcp } from './harness-cursor.js';
import { findSessions } from './transcripts.js';
import { diskCache, cacheKey, cachedByFiles } from './disk-cache.js';
import { Store } from './store.js';
import { estTokens } from './rank.js';
import { thinkerHome } from './update.js';
import { formatTokens } from './model-usage.js';

// a source loaded in this many sessions and called in none is worth switching off
export const MIN_SESSIONS = 3;
// called in fewer than this share of the sessions that loaded it: load it when needed instead
export const RARE_SHARE = 0.1;
// a source this small costs less than reading what the advice says about it
export const MIN_TOKENS = 100;
// what a recall card keeps of a source's own description
const CARD_CHARS = 1200;

// one key for a server, whether it is named by its tools (mcp__claude_ai_Claude_Docs__) or by its
// instructions ("claude.ai Claude Docs")
export const serverKey = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const toolServer = name => (String(name).match(/^mcp__(.+?)__/) || [])[1] || null;
// A plugin's own MCP server is named mcp__plugin_<plugin>_<server>__, and a plugin's name may hold "-" or
// "_": its key keeps the raw name (mcp:plugin:<plugin>_<server>), and which plugin it is is read against
// the plugins the sessions and settings name (harnessUsage).
const mcpKey = raw => /^plugin[_:]/.test(raw) ? `mcp:plugin:${String(raw).slice(7).replace(/:/g, '_')}` : `mcp:${serverKey(raw)}`;
const pluginOfSkill = s => String(s).includes(':') ? String(s).split(':')[0] : null;
// Built-in tools Claude Code sends in full with every call (`prompt_snapshot` records their definitions).
// Never offered: the ones every session works through, and ToolSearch, whose absence puts every deferred
// definition inline (2.1.304, 2026-10-20: denied, a `claude -p` call's input went from 25k to 55k tokens), and
// AskUserQuestion, which this question is put through.
const CORE_TOOLS = new Set(['Bash', 'Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep', 'NotebookEdit', 'ToolSearch', 'Skill', 'TodoWrite', 'AskUserQuestion']);
const builtinKey = name => !String(name).startsWith('mcp__') && !CORE_TOOLS.has(name) ? `tool:${name}` : null;
// Off until an experiment shows it helps (no-strategy-without-experiment): `harness: { builtinTools: true }`
// in .thinker/config.json, or THINKER_HARNESS_BUILTIN_TOOLS=on (=off wins over the config).
export function builtinToolsOn(repo, env = process.env) {
  const v = env.THINKER_HARNESS_BUILTIN_TOOLS || '';
  if (/^(0|off|false)$/i.test(v)) return false;
  if (/^(1|on|true)$/i.test(v)) return true;
  try { return new Store(repo, { readonly: true }).config().harness?.builtinTools === true; } catch { return false; }
}

// Claude Code's own files; CLAUDE_CONFIG_DIR moves them (clients.js:claudeDir does the same).
export function claudePaths(home = os.homedir(), env = process.env) {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  return { dir, json: env.CLAUDE_CONFIG_DIR ? path.join(dir, '.claude.json') : path.join(home, '.claude.json'), settings: path.join(dir, 'settings.json'), skills: path.join(dir, 'skills') };
}
// Claude Code keys a project's entry in .claude.json by the repository's main checkout: a session in a
// worktree reads the main checkout's entry (on this machine, 34 entries and none for any of 187 worktrees
// that ran sessions, 2026-10-18). settings.local.json is the checkout's own.
export function projectKey(repo) {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
    return path.basename(common) === '.git' ? path.dirname(common) : repo;
  } catch { return repo; }
}
// Managed settings outrank every file thinker writes: what they set is not thinker's to switch.
const MANAGED = { darwin: '/Library/Application Support/ClaudeCode/managed-settings.json', linux: '/etc/claude-code/managed-settings.json', win32: 'C:\\ProgramData\\ClaudeCode\\managed-settings.json' };
// Names put into the agent's instructions: a server's name comes from a repository's .mcp.json, which a
// clone controls, so only plain names are offered.
const SAFE_NAME = /^[\w.:@\/+-]{1,80}$/;

// The token cost of each skill in a listing: its entry, up to the next one. An entry is
// "- <name>: …" or "- <name> (<alias>): …", and a description can run over several lines.
export function skillCosts(content, names) {
  const want = new Set(names || []), out = new Map();
  for (const entry of String(content).split(/\n(?=- \S)/)) {
    const name = (entry.match(/^- (\S+?)(?=: | \()/) || [])[1];
    if (want.has(name)) out.set(name, estTokens(entry));
  }
  return out;
}

// One Claude Code transcript (and its subagents'): what it loaded, with the tokens of each source,
// and what it called. Lines are filtered by text before parsing; a transcript runs to megabytes.
// What was read is kept on this machine by the files' size and mtime (disk-cache.js:cachedByFiles): the
// Context and Harness pages read every transcript of the window on each request, a gigabyte and five
// seconds on a busy repository, and only the live session's file changes between two requests.
const HARNESS_CACHE = diskCache('session-harness', 1);
const TEXT_CHARS = 4000; // a source's text in the cache: the cards keep at most CARD_CHARS of it
const transcriptFiles = file => {
  const files = [file];
  try { const sub = path.join(file.replace(/\.jsonl$/, ''), 'subagents'); for (const f of fs.readdirSync(sub)) if (f.endsWith('.jsonl')) files.push(path.join(sub, f)); } catch {}
  return files;
};
const freezeHarness = h => ({ ...h, loaded: [...h.loaded], used: [...h.used], texts: [...h.texts].map(([k, t]) => [k, String(t).slice(0, TEXT_CHARS)]) });
const thawHarness = v => ({ ...v, loaded: new Map(v.loaded), used: new Set(v.used), texts: new Map(v.texts) });
export function sessionHarness(file) {
  const files = transcriptFiles(file);
  return cachedByFiles(HARNESS_CACHE, cacheKey('claude', file), files, () => readSessionHarness(files), { freeze: freezeHarness, thaw: thawHarness });
}
function readSessionHarness(files) {
  // what a source costs is counted once per thing listed: a session resumed or compacted lists it again
  const names = new Map(), instr = new Map(), skills = new Map(), used = new Set(), texts = new Map(), calls = new Set(), alias = new Map();
  // the files edited and the skills opened, in order (skill-suggest.js reads them)
  const edited = [], skillOpens = [];
  let cwd = null, start = null;
  const once = (key, item, tokens) => { if (!names.has(key)) names.set(key, new Map()); names.get(key).set(item, tokens); };
  files.forEach((f, fi) => {
    let text = ''; try { text = fs.readFileSync(f, 'utf8'); } catch { return; }
    for (const line of text.split('\n')) {
      const att = fi === 0 && line.includes('"attachment"'), call = line.includes('"tool_use"'), typed = line.includes('<command-name>');
      // a model call of the main session: every one reads the whole context again, what was loaded included
      const turn = fi === 0 && line.includes('"usage"') && line.includes('"assistant"');
      if (!att && !call && !typed && !turn && cwd && start) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (!cwd && typeof j.cwd === 'string') cwd = j.cwd;
      if (!start && fi === 0 && typeof j.timestamp === 'string') start = j.timestamp;
      if (turn && j.type === 'assistant' && j.message?.usage) calls.add(j.message.id || j.uuid);
      const a = j.attachment;
      if (att && a && typeof a === 'object') {
        if (a.type === 'deferred_tools_delta') {
          for (const n of a.addedNames || []) {
            const s = toolServer(n); if (!s) continue;
            once(mcpKey(s), n, estTokens(n + '\n'));
            const k = `tools:${mcpKey(s)}`, word = ` ${n.slice(n.lastIndexOf('__') + 2).replace(/_/g, ' ')}`;
            if (!String(texts.get(k) || '').includes(word)) texts.set(k, `${texts.get(k) || ''}${word}`);
          }
          for (const d of a.surfacedDefinitions || []) { const s = toolServer(d?.name); if (s) once(mcpKey(s), `def:${d.name}`, estTokens(JSON.stringify(d.definition || d))); }
        } else if (a.type === 'mcp_instructions_delta') {
          (a.addedNames || []).forEach((n, i) => { instr.set(mcpKey(n), estTokens(a.addedBlocks?.[i] || '')); texts.set(mcpKey(n), String(a.addedBlocks?.[i] || '')); });
        } else if (a.type === 'skill_listing') {
          for (const [n, t] of skillCosts(a.content || '', a.names || [])) skills.set(`skill:${n}`, Math.max(skills.get(`skill:${n}`) || 0, t));
          for (const entry of String(a.content || '').split(/\n(?=- \S)/)) {
            const m = entry.match(/^- (\S+?)(?: \(([^)\s]+)\))?: /); if (!m) continue;
            texts.set(`skill:${m[1]}`, entry.slice(2));
            if (m[2]) alias.set(m[2], m[1]); // "- gtm:00-start-here (gtm:start-here): …" runs as gtm:start-here
          }
        } else if (a.type === 'prompt_snapshot' && Array.isArray(a.tools)) {
          for (const d of a.tools) { const k = builtinKey(d?.name); if (k) { once(k, d.name, estTokens(JSON.stringify(d))); texts.set(k, String(d.description || '')); } }
        }
      }
      if (call) {
        for (const c of Array.isArray(j.message?.content) ? j.message.content : []) {
          if (c?.type !== 'tool_use') continue;
          const s = toolServer(c.name);
          if (s) used.add(mcpKey(s));
          else if (c.name === 'Skill' && c.input?.skill) used.add(`skill:${c.input.skill}`);
          if (!s && builtinKey(c.name)) used.add(builtinKey(c.name));
          if (c.name === 'Skill' && c.input?.skill) skillOpens.push({ skill: String(c.input.skill), at: j.timestamp });
          for (const m of JSON.stringify(c.input || {}).matchAll(/skills\/([\w.-]+)\/SKILL\.md/g)) skillOpens.push({ skill: m[1], at: j.timestamp });
          const f = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(c.name) && (c.input?.file_path || c.input?.notebook_path);
          if (f && !edited.includes(f)) edited.push(f);
        }
      }
      if (typed) for (const m of line.matchAll(/<command-name>\/?([^<\s]+)<\/command-name>/g)) used.add(`skill:${m[1]}`);
    }
  });
  // a server's card text: its instructions, then the names of its tools
  for (const [k, t] of texts) if (k.startsWith('tools:')) { const m = k.slice(6); texts.set(m, `${texts.get(m) || ''}\nTools:${t}`); texts.delete(k); }
  const loaded = new Map();
  const add = (k, t) => loaded.set(k, (loaded.get(k) || 0) + t);
  for (const [k, items] of names) for (const t of items.values()) add(k, t);
  for (const [k, t] of instr) add(k, t);
  for (const [k, t] of skills) add(k, t);
  const usedNames = new Set([...used].map(k => k.startsWith('skill:') && alias.has(k.slice(6)) ? `skill:${alias.get(k.slice(6))}` : k));
  return { loaded, used: usedNames, cwd, texts, start, calls: calls.size, edited, skillOpens };
}

// A Claude Code session with what the desktop app added to it, when the app ran it (harness-desktop.js):
// its connectors' always-loaded tools and its own instructions, which the transcript does not record.
export function claudeSessionHarness(file, records) {
  const h = sessionHarness(file), rec = records?.get(path.basename(file, '.jsonl'));
  if (!rec || !h.loaded.size) return { ...h, connectors: new Map(), desktop: false };
  const d = desktopSessionHarness(rec, { serverKey });
  for (const [k, t] of d.loaded) h.loaded.set(k, (h.loaded.get(k) || 0) + t);
  for (const [k, t] of d.texts) if (!h.texts.has(k)) h.texts.set(k, t);
  for (const k of desktopUsed(h.used)) h.used.add(k);
  return { ...h, connectors: d.connectors, desktop: true };
}
const desktopFor = home => desktopRecords(desktopSessionsDir(home));

// Where each source is switched on: Claude Code's settings and MCP files for this repository.
export function claudeHarnessConfig(repo, { home = os.homedir(), managedFile = MANAGED[process.platform] } = {}) {
  const json = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const dirs = d => { try { return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory() || e.isSymbolicLink()).map(e => e.name); } catch { return []; } };
  const cp = claudePaths(home), key = projectKey(repo);
  const claudeJson = json(cp.json) || {}, project = claudeJson.projects?.[key] || {};
  const managed = (managedFile && json(managedFile)) || {};
  // the settings files from the least to the most specific, so a later one's value wins
  const settings = [['user', cp.settings], ['project', path.join(repo, '.claude', 'settings.json')], ['local', path.join(repo, '.claude', 'settings.local.json')]].map(([scope, f]) => [scope, json(f) || {}]);
  const offMcp = new Set([...(project.disabledMcpServers || []), ...settings.flatMap(([, j]) => j.disabledMcpjsonServers || [])].map(serverKey));
  const servers = new Map();
  for (const [scope, list] of [['user', claudeJson.mcpServers], ['local', project.mcpServers], ['project', json(path.join(repo, '.mcp.json'))?.mcpServers]]) {
    for (const name of Object.keys(list || {})) servers.set(serverKey(name), { name, scope: managed.allowManagedMcpServersOnly ? 'managed' : scope, off: offMcp.has(serverKey(name)) });
  }
  // the scope kept is where it is switched on (the advice names that setting); a later file switching it off wins
  const plugins = new Map();
  for (const [scope, j] of settings) {
    for (const [id, on] of Object.entries(j.enabledPlugins || {})) {
      const name = id.split('@')[0], was = plugins.get(name);
      plugins.set(name, { id, scope: on !== false || !was ? scope : was.scope, off: on === false });
    }
  }
  for (const [id, on] of Object.entries(managed.enabledPlugins || {})) plugins.set(id.split('@')[0], { id, scope: 'managed', off: on === false });
  const overrides = Object.assign({}, ...settings.map(([, j]) => j.skillOverrides || {}));
  const skills = new Map();
  for (const n of dirs(cp.skills)) skills.set(n, { scope: 'user', dir: path.join(cp.skills, n) });
  for (const n of dirs(path.join(repo, '.claude', 'skills'))) skills.set(n, { scope: 'project', dir: path.join(repo, '.claude', 'skills', n) });
  for (const n of Object.keys(managed.skillOverrides || {})) skills.set(n, { scope: 'managed' });
  // a bare tool name in permissions.deny takes the tool out of the session ("Bash(rm:*)" only narrows it)
  const denied = new Set([managed, ...settings.map(([, j]) => j)].flatMap(j => j.permissions?.deny || []).filter(d => /^\w+$/.test(d)));
  return { servers, plugins, skills, overrides, denied, key, paths: cp };
}

// The middle value, or 0 for none: a session's model calls vary tenfold, and the mean follows the long ones.
export const median = xs => { const a = xs.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };

// The checkouts of a repository: itself and its worktrees, whose sessions are its sessions too.
export function checkouts(repo) {
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    return [...new Set([repo, ...out.split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9))])];
  } catch { return [repo]; }
}


// The Claude Code sessions of a repository's checkouts over the window: what each source cost and
// how often it was called. A source is a plugin when its skills or server belong to one, so a
// plugin of eighteen skills is one line and one switch.
// Cursor's sources are the machine's (harness-cursor.js): read from every Cursor session on it, unless the
// caller names its own sessions and no Cursor snapshots.
export function harnessUsage(repo, { days = 30, home = os.homedir(), sessions, cursor, thinkerHome: tHome = thinkerHome(), builtinTools = builtinToolsOn(repo) } = {}) {
  if (!sessions) cursor ??= cursorSnapshots(tHome, { sinceMs: days * 86400_000 });
  sessions ??= [...new Map(checkouts(repo).flatMap(r => findSessions(r, { sinceMs: days * 86400_000 })).map(s => [s.file, s])).values()];
  const claude = claudeUsage(repo, { days, home, sessions: sessions.filter(s => s.client === 'claude') });
  const codex = codexHarnessUsage(repo, sessions.filter(s => s.client === 'codex'), { home });
  const cur = cursor ? cursorHarnessUsage({ home, snapshots: cursor }) : { sessions: 0, sources: [] };
  return { ...claude, builtinTools, timeline: [...claude.timeline, ...(codex.timeline || [])], sessions: claude.sessions + codex.sessions + cur.sessions, byClient: { claude: claude.sessions, codex: codex.sessions, cursor: cur.sessions }, calls: { claude: claude.calls, codex: codex.calls || 0 }, prompts: (claude.prompts || 0) + (codex.prompts || 0) + cur.sessions, promptsByClient: { claude: claude.prompts || 0, codex: codex.prompts || 0, cursor: cur.sessions }, sources: [...claude.sources.map(s => ({ ...s, client: 'claude' })), ...codex.sources, ...cur.sources].sort((a, b) => b.tokens * (b.loaded - b.used) - a.tokens * (a.loaded - a.used)) };
}
function claudeUsage(repo, { days = 30, home = os.homedir(), sessions } = {}) {
  sessions ??= checkouts(repo).flatMap(r => findSessions(r, { sinceMs: days * 86400_000 }).filter(s => s.client === 'claude'));
  const config = claudeHarnessConfig(repo, { home });
  const rows = new Map();
  const row = key => {
    if (!rows.has(key)) rows.set(key, { key, loaded: 0, used: 0, prompts: 0, tokens: 0, lastUsed: null, skills: new Set(), texts: {} });
    return rows.get(key);
  };
  const records = desktopFor(home), read = sessions.map(s => ({ s, h: claudeSessionHarness(s.file, records) }));
  config.connectors = new Map(read.flatMap(({ h }) => [...h.connectors]));
  // the plugins the settings and the skill names name, longest first, to read a plugin server's key against
  const known = [...new Set([...config.plugins.keys(), ...read.flatMap(({ h }) => [...h.loaded.keys()].filter(k => k.startsWith('skill:')).map(k => pluginOfSkill(k.slice(6))).filter(Boolean))])].sort((a, b) => b.length - a.length);
  const group = k => {
    if (k.startsWith('mcp:plugin:')) { const rest = k.slice(11); return `plugin:${known.find(p => rest === p || rest.startsWith(`${p}_`)) || rest.split('_')[0]}`; }
    const plugin = k.startsWith('skill:') ? pluginOfSkill(k.slice(6)) : null;
    return plugin ? `plugin:${plugin}` : k;
  };
  let counted = 0; const calls = [], timeline = [];
  for (const { s, h } of read) {
    if (!h.loaded.size) continue; // written before Claude Code recorded what it loaded
    counted++; calls.push(h.calls);
    const tokens = new Map(), used = new Set([...h.used].map(group));
    for (const [k, t] of h.loaded) {
      tokens.set(group(k), (tokens.get(group(k)) || 0) + t);
      if (k.startsWith('skill:') && group(k) !== k) row(group(k)).skills.add(k.slice(6));
      if (h.texts.has(k)) row(group(k)).texts[k] = h.texts.get(k).slice(0, CARD_CHARS);
    }
    // `loaded`: each source's tokens a call, so the Report can cost one source a session before and since it was switched off (report.js:actionEffect)
    timeline.push({ t: s.mtime, session: s.session, client: 'claude', calls: h.calls, parts: partsOf(tokens), loaded: Object.fromEntries(tokens) });
    for (const [k, t] of tokens) {
      // `prompts`: the model calls of every session that carried it, since each call reads its tokens again
      const r = row(k); r.loaded++; r.tokens += t; r.prompts += Math.max(1, h.calls);
      if (used.has(k)) { r.used++; if (!r.lastUsed || s.mtime > r.lastUsed) r.lastUsed = s.mtime; }
    }
  }
  const out = [...rows.values()].filter(r => r.loaded).map(r => ({ ...r, skills: [...r.skills].sort(), tokens: Math.round(r.tokens / r.loaded), ...describe(r.key, config, [...r.skills]) }));
  return { repo, days, sessions: counted, calls: median(calls), prompts: calls.reduce((a, c) => a + Math.max(1, c), 0), timeline, sources: out.sort((a, b) => b.tokens * (b.loaded - b.used) - a.tokens * (a.loaded - a.used)) };
}

// What a source is and where it is switched on, so the advice names the setting to change.
// `off`: switched off already, by a setting written since those sessions ran.
function describe(key, { servers, plugins, skills, overrides, connectors, denied }, members) {
  const name = key.slice(key.indexOf(':') + 1);
  if (key.startsWith('tool:')) return { name, kind: 'tool', scope: 'builtin', off: Boolean(denied?.has(name)) };
  if (key.startsWith('desktop:')) return { name: DESKTOP_SECTIONS[key]?.name || name, kind: 'desktop', scope: 'app', where: DESKTOP_SECTIONS[key]?.where, off: false };
  const hidden = n => ['off', 'user-invocable-only'].includes(overrides[n]);
  if (key.startsWith('plugin:')) {
    const p = plugins.get(name);
    return { name, kind: 'plugin', scope: p?.scope || null, id: p?.id || name, off: Boolean(p?.off) || (!p && members.length > 0 && members.every(hidden)) };
  }
  if (key.startsWith('mcp:')) {
    const c = connectors?.get(name);
    if (c) return { name: c.name, id: c.id, kind: 'connector', scope: 'desktop', off: false };
    if (name.startsWith('claude_ai_')) return { name: name.replace(/^claude_ai_/, ''), kind: 'connector', scope: 'claude.ai', off: false };
    const s = servers.get(name);
    return { name: s?.name || name, kind: 'mcp', scope: s?.scope || null, off: Boolean(s?.off) };
  }
  const s = skills.get(name);
  return { name, kind: 'skill', scope: s?.scope || null, dir: s?.dir, off: hidden(name) };
}

// How a source is switched off for one repository, checked on Claude Code 2.1.303 (2026-10-18): a
// plugin by `enabledPlugins` in the repository's settings.local.json, which outranks the user's; an MCP
// server of the user's or local scope by `disabledMcpServers` in the repository's entry of
// ~/.claude.json (what `/mcp disable` writes), one of .mcp.json by `disabledMcpjsonServers`; a skill by
// `skillOverrides` "user-invocable-only", which takes it out of the listing and leaves `/name` working.
// Measured again 2026-10-19 by what a `claude -p` session listed and which server processes it started:
// each of these held, but a plugin's own skills ignore skillOverrides. A plugin no setting names (one the
// session brings, as the desktop app brings anthropic-skills) goes as `<name>@inline` and skill by skill
// (apply). A claude.ai connector and a
// server no settings file names are left to /mcp. A connector of the desktop app goes by the app's own
// Connectors switch, which the agent flips (harness-desktop.js); that one is for the machine, not the repository.
function switchOff(s) {
  if (s.client === 'codex' || s.client === 'cursor') return s.how || null;
  if (s.kind === 'connector' && s.scope === 'desktop' && s.id) return 'desktop-connector';
  if (s.scope === 'managed') return null;
  if (s.kind === 'plugin') return s.scope ? 'plugin' : s.skills?.length ? 'skills' : null;
  if (s.kind === 'mcp') return s.scope === 'project' ? 'mcpjson' : s.scope ? 'mcp' : null;
  if (s.kind === 'skill') return 'skill';
  if (s.kind === 'tool') return 'tool';
  return null;
}

// The sources worth switching off here: loaded in enough sessions, called in none or almost none,
// big enough to matter, and with a setting that switches them off for this repository.
export function harnessAdvice(usage) {
  return usage.sources
    .filter(s => switchable(s, usage) && s.loaded >= MIN_SESSIONS && s.tokens >= MIN_TOKENS && s.used / s.loaded < RARE_SHARE)
    .map(s => ({ ...s, unused: s.used === 0, how: switchOff(s), action: action(s) }));
}
// A source a setting here switches off, and not off already: what the person may pick by hand (the Context view,
// context-view.js), whatever the advice's thresholds say.
// A source some setting here could switch off, whether or not the harness may yet (the Context tab offers it, and
// turns the harness on when the person picks it).
export const canSwitchOff = s => Boolean(switchOff(s)) && !s.off;
export const switchable = (s, usage) => Boolean(switchOff(s)) && !s.off && (s.kind !== 'tool' || usage.builtinTools);
const anySource = usage => usage.sources.filter(s => switchable(s, usage)).map(s => ({ ...s, unused: s.used === 0, how: switchOff(s), action: action(s) }));

function action(s) {
  if (s.client === 'cursor') return `its entry taken out of ~/.cursor/mcp.json, for every repository (Cursor has no per-repository switch its editor reads; new chats; \`thinker harness --undo\` puts it back)`;
  if (s.client === 'codex') return s.kind === 'skill' ? `[[skills.config]] path = ${JSON.stringify(path.join(s.dir || '', 'SKILL.md'))} enabled = false in your Codex config (~/.codex/config.toml: Codex reads skill switches nowhere else; the path is this checkout's, so only here; new sessions)` : `[${s.kind === 'mcp' ? 'mcp_servers' : 'plugins'}.${JSON.stringify(s.id || s.name)}] enabled = false in this checkout's .codex/config.toml (trusted projects only; new sessions)`;
  switch (switchOff(s)) {
    case 'desktop-connector': return `the Connectors switch of the Claude desktop app (the + menu); the agent flips it in a desktop session, and the app keeps it off in every new session on this machine, not only this repository`;
    case 'plugin': return `"enabledPlugins": {"${s.id}": false} in .claude/settings.local.json`;
    case 'skills': return s.kind === 'plugin' ? `"enabledPlugins": {"${s.name}@inline": false} and "skillOverrides" "user-invocable-only" for its ${s.skills.length} skills in .claude/settings.local.json` : `"skillOverrides" "user-invocable-only" for its ${s.skills.length} skills in .claude/settings.local.json (each still runs as /name)`;
    case 'mcp': return `"disabledMcpServers": ["${s.name}"] in this repository's entry of ~/.claude.json, for all its worktrees (what /mcp disable writes; /mcp enable undoes it)`;
    case 'mcpjson': return `"disabledMcpjsonServers": ["${s.name}"] in .claude/settings.local.json`;
    case 'skill': return `"skillOverrides": {"${s.name}": "user-invocable-only"} in .claude/settings.local.json (it still runs as /${s.name})`;
    case 'tool': return `"permissions": {"deny": ["${s.name}"]} in .claude/settings.local.json (the tool and its definition leave new Claude Code sessions here; not verified for the desktop app's own tools, which \`claude -p\` does not carry: \`thinker harness\` reports whether a switch took effect)`;
  }
}

// --- switching a source off ------------------------------------------------------------------------
// The sources worth switching off are suggested in one place, the weekly context suggestion and the Find
// Savings page beside the instruction sections and the tool outputs (context-suggest.js, context-view.js);
// what they rank is `harnessAdvice` below. Until 2026-10-25 this file also put its own question to the
// person in their session (`scheduleHarnessSuggestion`, `harnessOffer`, `answerHarness`, the MCP `harness`
// tool, a "never" for the machine): a second suggestion of a subset of the same things, through a picker
// instead of a message, which the owner merged into the weekly one.
//
//   switchOffNow   switches named sources off here (the page's rows, `thinker harness --off`, an approved
//                  suggestion), a backup of each file first
//   undoHarness    `thinker harness --undo`: puts back what was switched off
//
// Local state: <cache>/state/harness.json (what was switched off).
export const SIGNATURE = '🧠 thinker';
const DAY = 86_400_000;
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js');
const stateFile = store => path.join(store.dir, 'state', 'harness.json');
// Off until it is tested and works for every agent that matters (2026-10-19, the owner's decision): no
// question, no recall line, no advice on the page unless `harness: { enabled: true }` in .thinker/config.json.
// `thinker harness --undo` still reverses what was switched off before.
export const harnessOn = store => store.config().harness?.enabled === true;
export const OFF_MESSAGE = 'thinker harness is off here (not yet released): `thinker harness --enabled on` turns it on for this repository.';
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, v, pretty) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.thinker-${process.pid}`;
  fs.writeFileSync(tmp, pretty ? JSON.stringify(v, null, 2) + '\n' : JSON.stringify(v) + '\n');
  fs.renameSync(tmp, f);
};
// A file of the person's (Claude Code's settings, ~/.claude.json): written where a symlink points, with the
// mode it had (~/.claude.json is 0600 and holds keys), through a file renamed into place.
function writeTheirs(f, v) {
  let target = f, mode = 0o644;
  try { target = fs.realpathSync(f); mode = fs.statSync(target).mode & 0o777; } catch {}
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.thinker-${process.pid}`;
  fs.writeFileSync(tmp, typeof v === 'string' ? v : JSON.stringify(v, null, 2) + '\n', { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, target);
}
export const readHarnessState = store => readJson(stateFile(store)) || {};
const saveState = (store, st) => writeJson(stateFile(store), st);

// What the question needs of a source, and nothing that could hold a secret.
const pick = s => ({ client: s.client, dir: s.dir, evidenceKeys: s.evidenceKeys, key: s.key, name: s.name, kind: s.kind, scope: s.scope, id: s.id, how: s.how, skills: s.skills, tokens: s.tokens, used: s.used, loaded: s.loaded, texts: s.texts });

// The sources a switch may name: the advice, or every source with a local switch (`any`: the Find Savings
// rows, which offer a switch whatever the use). Each carries the model calls of a typical session of its
// agent here, since what it costs is its tokens read again by each.
function pickSources(usage, { any = false } = {}) {
  const sources = (any ? anySource(usage) : harnessAdvice(usage)).filter(s => SAFE_NAME.test(s.name) && (s.skills || []).every(n => SAFE_NAME.test(n))).map(pick);
  return sources.map(s => ({ ...s, calls: usage.calls?.[s.client || 'claude'] || 0 }));
}

// What a source costs a session: its tokens sit in the context and every model call reads them again, mostly
// from the prompt cache. Cursor records no model calls, so it is its size alone.
export const perSession = (tokens, calls) => calls > 1 ? tokens * calls : tokens;
// What a source is, in its own words: the first sentence of its listing (a skill's description, a server's
// instructions, a tool's description), the name it opens with dropped. The text is a third party's: quoted
// as data, with nothing that could close the block or open another.
export const sentenceOf = text => String(text || '').replace(/^- /, '').replace(/^#+ \S+\s*/, '').replace(/^\S+?(?=: | \()(\s*\([^)]*\))?:\s*/, '').replace(/[<>`\n\r]+/g, ' ').split(/(?<=\.)\s/)[0].trim().slice(0, 160);
const KIND = { plugin: 'plugin', mcp: 'MCP server', connector: 'connector', skill: 'skill', skills: '', tool: 'tool' };
export const clientPrefix = c => ({ codex: 'Codex: ', cursor: 'Cursor: ' })[c] || '';
export const labelOf = p => clientPrefix(p.client) + (p.kind === 'skills' ? p.name : `${p.name} ${KIND[p.kind]}`);
// One edit of one JSON file, after a copy of what it changes as it was (THINKER_HOME/state/harness-backups/,
// 0600, the last twenty kept): of ~/.claude.json only the project's entry (`part`), never the keys and
// account it holds. `check` reads the file back: Claude Code rewrites ~/.claude.json while sessions run,
// with no lock to take, and an edit it wrote over at that moment is reported, not assumed.
const BACKUPS_KEPT = 20;
function editJson(file, fn, { home, now, backups, part, check }) {
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  let j = {}; if (before != null) { try { j = JSON.parse(before); } catch { throw new Error(`${file} is not valid JSON; left as it is`); } }
  if (before != null && !backups.has(file)) {
    const root = path.join(home || thinkerHome(), 'state', 'harness-backups'), dir = path.join(root, new Date(now).toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const copy = path.join(dir, `${backups.size}-${path.basename(file)}`);
    fs.writeFileSync(copy, part ? JSON.stringify({ file, part: part(j) ?? null }, null, 2) + '\n' : before, { mode: 0o600 });
    backups.set(file, copy);
    try { const all = fs.readdirSync(root).sort(); for (const d of all.slice(0, Math.max(0, all.length - BACKUPS_KEPT))) fs.rmSync(path.join(root, d), { recursive: true, force: true }); } catch {}
  }
  fn(j);
  writeTheirs(file, j);
  if (check) { let back = null; try { back = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {} if (!back || !check(back)) throw new Error(`${path.basename(file)} was rewritten at the same moment (a Claude Code session saving it); try again`); }
}
// A settings.local.json thinker creates is kept out of git, as .thinker is (store.js:init): an agent's
// `git add -A` would otherwise commit it.
function excludeFromGit(repo, file) {
  try {
    const rel = path.relative(repo, file);
    const r = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
    try { r('check-ignore', '-q', rel); return; } catch {}
    const ex = path.join(r('rev-parse', '--path-format=absolute', '--git-common-dir'), 'info', 'exclude');
    const cur = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : '';
    if (!cur.split('\n').includes(rel)) { fs.mkdirSync(path.dirname(ex), { recursive: true }); fs.appendFileSync(ex, `${cur && !cur.endsWith('\n') ? '\n' : ''}${rel}\n`); }
  } catch {}
}
const addTo = (list, v) => { const a = Array.isArray(list) ? list : []; return a.includes(v) ? a : [...a, v]; };

// Switch one source off; returns what to undo it with, the values it replaced included. A plugin or skill
// goes off in this checkout (its settings.local.json), an MCP server in the repository, every worktree
// with it (its entry in ~/.claude.json, keyed by the main checkout). A skill some settings file already
// overrides is left as that file says ("off" is stronger than what thinker writes).
function apply(repo, s, { userHome, home, now, backups, overrides = {} }) {
  if (s.client === 'codex') return applyCodex(repo, s, { home, userHome, now, backups });
  // the app's switch, flipped by the agent from the line the answer returns; nothing for thinker to write
  if (s.how === 'desktop-connector') return { key: 'desktop-connector', id: s.id, name: s.name };
  if (s.client === 'cursor') return editCursorMcp({ name: s.name, thinkerHome: home || thinkerHome(), home: userHome, write: writeTheirs });
  const local = path.join(repo, '.claude', 'settings.local.json'), claudeJson = claudePaths(userHome).json;
  const ctx = { home, now, backups }, fresh = !fs.existsSync(local);
  const done = u => { if (u.file === local && fresh) excludeFromGit(repo, local); return u; };
  if (s.how === 'plugin') { let prev; editJson(local, j => { j.enabledPlugins ||= {}; prev = j.enabledPlugins[s.id]; j.enabledPlugins[s.id] = false; }, ctx); return done({ file: local, key: 'enabledPlugins', id: s.id, prev }); }
  if (s.how === 'skills' || s.how === 'skill') {
    const names = (s.how === 'skills' ? s.skills : [s.name]).filter(n => overrides[n] === undefined);
    // a plugin no setting names is loaded for the session alone (--plugin-dir, as the desktop app loads its
    // anthropic-skills): Claude Code reads skillOverrides for a plugin's skills only from managed or flag
    // settings, so it goes off as `<name>@inline` too (2.1.303, 2026-10-19: with the override alone a
    // --plugin-dir plugin's skill stayed listed, as did a marketplace plugin's; with enabledPlugins
    // "<name>@inline" false it left the listing). The overrides still take the claude.ai skills synced
    // under the same prefix (~/.claude/skills/synced), which no plugin switch reaches.
    const plugin = s.kind === 'plugin' ? `${s.name}@inline` : null;
    if (!names.length && !plugin) throw new Error('its settings already say how it is listed');
    let prev;
    editJson(local, j => {
      if (names.length) { j.skillOverrides ||= {}; for (const n of names) j.skillOverrides[n] = 'user-invocable-only'; }
      if (plugin) { j.enabledPlugins ||= {}; prev = j.enabledPlugins[plugin]; j.enabledPlugins[plugin] = false; }
    }, ctx);
    return done({ file: local, key: 'skillOverrides', ids: names, ...(plugin ? { plugin: { id: plugin, prev } } : {}) });
  }
  if (s.how === 'mcpjson') { editJson(local, j => { j.disabledMcpjsonServers = addTo(j.disabledMcpjsonServers, s.name); }, ctx); return done({ file: local, key: 'disabledMcpjsonServers', id: s.name }); }
  if (s.how === 'tool') { editJson(local, j => { (j.permissions ||= {}).deny = addTo(j.permissions.deny, s.name); }, ctx); return done({ file: local, key: 'permissions.deny', id: s.name }); }
  if (s.how === 'mcp') {
    const key = projectKey(repo);
    editJson(claudeJson, j => { const p = ((j.projects ||= {})[key] ||= {}); p.disabledMcpServers = addTo(p.disabledMcpServers, s.name); },
      { ...ctx, part: j => j.projects?.[key], check: j => (j.projects?.[key]?.disabledMcpServers || []).includes(s.name) });
    return { file: claudeJson, key: 'disabledMcpServers', project: key, id: s.name };
  }
  throw new Error(`no setting switches ${s.name} off`);
}

// Servers and plugins go in Codex's per-project layer, which applies only to trusted projects. Skills cannot:
// Codex reads [[skills.config]] from the user's own config.toml alone, and only by the SKILL.md path (0.162.1,
// 2026-10-19: switched off in the project's file, all 107 of PostHog's skills stayed listed; in the user's file
// they left the prompt, 7.3k tokens to 2.8k). Each entry names this checkout's file, so it switches off only here.
const codexUserConfig = userHome => path.join(process.env.CODEX_HOME || path.join(userHome || os.homedir(), '.codex'), 'config.toml');
function applyCodex(repo, s, { home, userHome, now, backups }, undo) {
  const user = s.kind === 'skill';
  const file = user ? (undo?.file || codexUserConfig(userHome)) : codexConfigFile(repo);
  const existing = fs.existsSync(file) ? file : path.dirname(file);
  if (!user && fs.existsSync(existing) && !fs.realpathSync(existing).startsWith(fs.realpathSync(repo) + path.sep)) throw new Error('project Codex config points outside this checkout; left unchanged');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const changed = editCodexSetting(before, s, undo);
  if (before && !backups.has(file)) {
    const dir = path.join(home || thinkerHome(), 'state', 'harness-backups', new Date(now).toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const copy = path.join(dir, `${backups.size}-config.toml`);
    fs.writeFileSync(copy, before, { mode: 0o600 }); backups.set(file, copy);
    const root = path.dirname(dir), all = fs.readdirSync(root).sort();
    for (const d of all.slice(0, Math.max(0, all.length - BACKUPS_KEPT))) fs.rmSync(path.join(root, d), { recursive: true, force: true });
  }
  if (before !== changed.text) {
    // Refuse to overwrite an edit made while this operation was preparing its backup.
    if ((fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '') !== before) throw new Error('Codex config changed concurrently; try again');
    writeTheirs(file, changed.text);
    if (fs.readFileSync(file, 'utf8') !== changed.text) throw new Error('Codex config was rewritten; try again');
    if (!before && !user) excludeFromGit(repo, file);
  }
  return { file, key: 'codex', source: { kind: s.kind, name: s.name, id: s.id, dir: s.dir }, prev: changed.prev, created: changed.created, inherited: changed.inherited };
}

// `thinker harness --undo`: every source the answers switched off here, turned back on.
export function undoHarness(store, { home, userHome = os.homedir(), now = Date.now(), names } = {}) {
  const st = readHarnessState(store), all = st.applied || [];
  const want = names?.length ? new Set(names.map(n => String(n).trim().toLowerCase())) : null;
  const applied = want ? all.filter(a => want.has(a.name.toLowerCase()) || want.has(a.key.toLowerCase())) : all, rest = want ? all.filter(a => !applied.includes(a)) : [];
  if (!applied.length) return want ? `Nothing switched off here by those names: ${[...want].join(', ')}.` : 'Nothing to undo: thinker has switched nothing off in this repository.';
  // each entry on its own: one file that cannot be read keeps its entry for the next try, the rest go back
  const backups = new Map(), ctx = { home, now, backups }, back = [], kept = [], app = [];
  for (const a of [...applied].reverse()) {
    const u = a.undo;
    try {
      if (u.key === 'codex') { applyCodex(store.repo, u.source, ctx, u); back.unshift(a.name); continue; }
      if (u.key === 'desktop-connector') { app.unshift(a.name); continue; }
      if (u.key === 'cursor') { editCursorMcp({ name: u.name, thinkerHome: home || thinkerHome(), home: userHome, write: writeTheirs }, true); back.unshift(a.name); continue; }
      editJson(u.file, j => {
        if (u.key === 'enabledPlugins') { if (j.enabledPlugins?.[u.id] === false) { if (u.prev === undefined) delete j.enabledPlugins[u.id]; else j.enabledPlugins[u.id] = u.prev; } }
        else if (u.key === 'skillOverrides') {
          for (const n of u.ids) if (j.skillOverrides?.[n] === 'user-invocable-only') delete j.skillOverrides[n];
          if (u.plugin && j.enabledPlugins?.[u.plugin.id] === false) { if (u.plugin.prev === undefined) delete j.enabledPlugins[u.plugin.id]; else j.enabledPlugins[u.plugin.id] = u.plugin.prev; }
        }
        else if (u.key === 'disabledMcpjsonServers') j.disabledMcpjsonServers = (j.disabledMcpjsonServers || []).filter(n => n !== u.id);
        else if (u.key === 'permissions.deny') { if (j.permissions?.deny) j.permissions.deny = j.permissions.deny.filter(n => n !== u.id); }
        else if (u.key === 'disabledMcpServers') { const p = j.projects?.[u.project]; if (p) p.disabledMcpServers = (p.disabledMcpServers || []).filter(n => n !== u.id); }
      }, u.key === 'disabledMcpServers' ? { ...ctx, part: j => j.projects?.[u.project] } : ctx);
      back.unshift(a.name);
    } catch (e) { kept.push({ ...a, undoError: e.message }); }
  }
  if (kept.length || rest.length) st.applied = [...rest, ...kept]; else delete st.applied;
  delete st.recalled; saveState(store, st);
  store.log({ op: 'harness-undo', sources: back.length + app.length, failed: kept.length });
  return [back.length ? `Turned back on, from the next session on: ${back.join(', ')}.` : '',
    app.length ? `Turn ${app.join(', ')} back on in the Claude desktop app: the + menu → Connectors (or ask Claude there); thinker no longer counts ${app.length === 1 ? 'it' : 'them'} as off.` : '',
    kept.length ? `Not turned back on: ${kept.map(k => `${k.name} (${k.undoError})`).join('; ')}; \`thinker harness --undo\` tries again.` : ''].filter(Boolean).join(' ');
}

// --- recall: a switched-off source the request needs -------------------------------------------------
// Switching a source off takes its description out of every session; the request that needs it then has
// nothing to say the tool exists. Each source switched off keeps a card: its name, its own description as
// Claude Code listed it, and how the person brings it back. The prompt hook ranks the cards against the
// request as it ranks notes (rank.js, then the cross-encoder, dense.js:ceRerank), a pool of its own, and
// when one clears the floor tells the agent in a line, once per card in a session. Nothing is said
// otherwise. A new way of reaching the agent: off until an experiment shows it helps (AGENTS.md);
// `harness: { recall: true }` in .thinker/config.json, or THINKER_HARNESS_RECALL=on, turns it on.
export const RECALL = { floor: -2, k: 8, sessions: 50 };
// The lexical matcher (`harness: { recallMatch: 'lexical' }`, or THINKER_HARNESS_RECALL_MATCH=lexical; off until an
// experiment): a skill's one-line description shares few words with the request that needs it, and the
// cross-encoder, trained on questions and the passages that answer them, scores "use when…" text far under its
// floor: on 16 PostHog requests each written to need one skill it surfaced 0 (2026-10-19). Ranked by BM25 over the
// description and the skill file's own headings and code terms, with no floor but cover, the skill was in the top
// three for 13. Up to `max` skills are named, each covering at least `cover` of the request's term weight.
export const RECALL_LEXICAL = { cover: 0.3, max: 2, termChars: 3000 };
export const recallMatch = store => {
  const env = process.env.THINKER_HARNESS_RECALL_MATCH || '';
  return /^(lexical|ce)$/i.test(env) ? env.toLowerCase() : store?.config?.().harness?.recallMatch === 'lexical' ? 'lexical' : 'ce';
};
// what a skill file says in code terms: its headings and inline code, which name the APIs and files a request touches
export const skillTerms = md => [...new Set([...String(md).matchAll(/^#{1,4} (.+)$/gm)].map(m => m[1]).concat([...String(md).matchAll(/`([^`\n]{2,60})`/g)].map(m => m[1])))].join(' ').slice(0, RECALL_LEXICAL.termChars);
const readTerms = file => { try { return file ? skillTerms(fs.readFileSync(file, 'utf8').replace(/^---[\s\S]*?---/, '')) : ''; } catch { return ''; } };
// On with the harness (2026-10-19, the owner's decision: switching a source off is only fair if thinker
// brings it back when a request needs it); `harness: { recall: false }` or THINKER_HARNESS_RECALL=off turns it off.
export const recallOn = store => {
  if (!harnessOn(store)) return false;
  const env = process.env.THINKER_HARNESS_RECALL || '';
  if (/^(0|off|false)$/i.test(env)) return false;
  return /^(1|on|true)$/i.test(env) || store.config().harness?.recall !== false;
};

// One card per thing the person can bring back by name: a skill each (a plugin's too), a server whole.
export function cardsFor(s, { repo } = {}) {
  const card = (key, name, text, back, use, file) => ({ id: key, name, text: String(text || name).slice(0, CARD_CHARS), back, ...(use ? { use } : {}), ...(file ? { file } : {}) });
  // a Codex skill switched off is out of the listing, not out of the checkout: the agent can still read it now
  const skillFile = s.client === 'codex' && s.kind === 'skill' && s.dir && /^[^\n\r`<>]{1,400}$/.test(s.dir) ? path.join(s.dir, 'SKILL.md') : null;
  if (s.client === 'codex') return [card(s.key, s.name, Object.values(s.texts || {}).join(' '), `\`thinker harness --undo ${s.key}\` brings it back from the next Codex session`, skillFile && `read ${skillFile} and follow it`, skillFile)];
  if (s.client === 'cursor') return [card(s.key, s.name, Object.values(s.texts || {}).join(' '), `\`thinker harness --undo ${s.key}\` puts it back in ~/.cursor/mcp.json, for the next Cursor chat`)];
  if (s.kind === 'mcp') return [card(s.key, s.name, s.texts?.[`mcp:${serverKey(s.name)}`] || Object.values(s.texts || {})[0], `\`/mcp enable ${s.name}\` brings it back in this session`)];
  if (s.kind === 'tool') return [card(s.key, s.name, s.texts?.[s.key], `\`thinker harness --undo ${s.name}\` brings it back from the next session`)];
  if (s.how === 'desktop-connector') return [card(s.key, s.name, Object.values(s.texts || {}).join(' '), `the + menu → Connectors turns it back on (in the desktop app you can call ${CONNECTOR_TOOL} with connector ${JSON.stringify(s.id)} and enabled true, from the next turn)`)];
  const back = s.how === 'plugin' || (s.how === 'skills' && s.kind === 'plugin') ? n => `the ${s.name} plugin is off here: \`thinker harness --undo\` (or "enabledPlugins": {"${s.how === 'plugin' ? s.id : `${s.name}@inline`}": true} in .claude/settings.local.json) brings it back from the next session` : n => `\`/${n}\` still runs it`;
  // a skill of the repository's own keeps its file, whose headings and code terms the lexical matcher reads
  const own = n => repo && /^[\w.-]{1,100}$/.test(n) ? ['.claude', '.agents'].map(d => path.join(repo, d, 'skills', n, 'SKILL.md')).find(f => fs.existsSync(f)) : null;
  return (s.skills?.length ? s.skills : [s.name]).map(n => card(`skill:${n}`, n, s.texts?.[`skill:${n}`], back(n), null, own(n)));
}

// The cards the lexical matcher names for a request, best first: BM25 over each card's description and its skill
// file's terms, kept when the card covers enough of the request's term weight.
export async function recallLexical(cards, prompt, { cover = RECALL_LEXICAL.cover, max = RECALL_LEXICAL.max } = {}) {
  if (!cards?.length || !String(prompt || '').trim()) return [];
  const { rank } = await import('./rank.js');
  const notes = cards.map(c => ({ id: c.id, title: c.name.replace(/[:_-]+/g, ' '), answers: [c.text], body: `${c.text} ${readTerms(c.file)}`, kind: 'howto', deps: [], card: c }));
  return rank(notes, { query: prompt, loose: true, mode: 'lookup' }).filter(r => r.matched > 0 && r.cover >= cover)
    .sort((a, b) => b.score - a.score).slice(0, max).map(r => ({ ...r.note.card, cover: r.cover }));
}

// The card the request needs, if any: the hook's own lexical gate, then the cross-encoder at the floor.
export async function recallCard(cards, prompt, { floor = RECALL.floor, k = RECALL.k, scoreFn } = {}) {
  if (!cards?.length || !String(prompt || '').trim()) return null;
  const { rank } = await import('./rank.js');
  // a source's description says when to use it: it is the card's question side, where the gate looks
  const notes = cards.map(c => ({ id: c.id, title: c.name.replace(/[:_-]+/g, ' '), answers: [c.text, ...(c.says || [])], says: c.says, body: c.text, search: c.search || c.text, kind: 'howto', deps: [], card: c }));
  const rows = rank(notes, { query: prompt });
  if (!rows.length) return null;
  const { ceRerank } = await import('./dense.js');
  const kept = await (scoreFn ? scoreFn(rows, prompt, { floor, k }) : ceRerank(rows, prompt, { floor, k, maxNotes: 1 }));
  return kept[0] ? { ...kept[0].note.card, ce: kept[0].ce } : null;
}

// The prompt hook: one line about a switched-off source this request looks like it needs, once per card
// in a session, or nothing.
export async function harnessRecall(store, prompt, { session, client, scoreFn } = {}) {
  if (!recallOn(store)) return '';
  const st = readHarnessState(store), cards = (st.applied || []).filter(a => !client || (a.client || 'claude') === client).flatMap(a => a.cards || []);
  if (!cards.length) return '';
  const said = new Set(st.recalled?.[session] || []);
  const open = cards.filter(x => !said.has(x.id)), match = recallMatch(store);
  let found = [];
  try { found = match === 'lexical' && !scoreFn ? await recallLexical(open, prompt) : [await recallCard(open, prompt, { scoreFn })].filter(Boolean); } catch { return ''; }
  if (!found.length) return '';
  if (session && session !== 'unknown') {
    st.recalled ||= {};
    st.recalled[session] = [...said, ...found.map(c => c.id)];
    const keys = Object.keys(st.recalled); for (const k of keys.slice(0, Math.max(0, keys.length - RECALL.sessions))) delete st.recalled[k];
    saveState(store, st);
  }
  for (const c of found) store.log({ op: 'harness-recall', session: session === 'unknown' ? undefined : session, client, card: c.id, match, ce: c.ce == null ? undefined : Math.round(c.ce * 100) / 100, cover: c.cover == null ? undefined : Math.round(c.cover * 100) / 100 });
  // the description is the skill's own text, a third party's: a short excerpt, quoted as data, with nothing
  // that could close the block or open another
  const what = c => sentenceOf(c.text);
  const then = c => c.use ? `${c.use} (${c.back})` : `tell the user that ${c.back}`;
  if (found.length === 1) { const [c] = found; return `<thinker-switched-off>\n${c.name} is switched off here; its listing said: ${JSON.stringify(what(c))}. If this request needs it, ${then(c)}; otherwise ignore this line.\n</thinker-switched-off>`; }
  return `<thinker-switched-off>\nSwitched off here, and possibly what this request needs; if one is, ${found.some(c => c.use) ? 'follow its instruction' : 'say so'} before editing, otherwise ignore these lines:\n${found.map(c => `- ${c.name}: ${JSON.stringify(what(c))}. ${then(c)[0].toUpperCase()}${then(c).slice(1)}.`).join('\n')}\n</thinker-switched-off>`;
}

// --- switched-off skills, found by the agent ---------------------------------------------------------------
// Recall matches the person's request, and a request rarely says which skill it needs: on PostHog's 107
// skills it matched none of 28 sessions, and agents with the listing gone opened 0.6 skills a session against
// 2.9 with it (2026-10-19). The agent knows what it is about to change, so it is offered the skills two ways,
// each off until an experiment shows it helps (AGENTS.md): `lookup` searches the switched-off skills with the
// agent's own words (`harness: { skillLookup: true }`, THINKER_HARNESS_SKILL_LOOKUP=on), and an index of
// their names alone, a fraction of the listing they replace (switchedOffSkillIndex, for the guidance).
const flag = (store, key, env) => {
  if (!harnessOn(store)) return false;
  const v = process.env[env] || '';
  if (/^(0|off|false)$/i.test(v)) return false;
  return /^(1|on|true)$/i.test(v) || store.config().harness?.[key] === true;
};
export const skillLookupOn = store => flag(store, 'skillLookup', 'THINKER_HARNESS_SKILL_LOOKUP');
const skillCards = (store, client) => (readHarnessState(store).applied || [])
  .filter(a => a.kind === 'skill' || a.kind === 'skills' || /skill/.test(a.key || ''))
  .filter(a => !client || (a.client || 'claude') === client).flatMap(a => a.cards || []);
// a skill's description says when to use it, as Codex and Claude Code listed it
const purpose = c => String(c.text).replace(/^- /, '').replace(/^\S+?(?=: | \()(\s*\([^)]*\))?:\s*/, '').replace(/[<>`\n\r]+/g, ' ').split(/(?<=\.)\s/)[0].trim().slice(0, 200);
const howTo = c => c.use || c.back;

// The switched-off skills whose name and description carry the agent's words, by the hook's lexical ranking.
export async function switchedOffSkills(store, query, { client, max = 3 } = {}) {
  if (!skillLookupOn(store) || !String(query || '').trim()) return [];
  const cards = skillCards(store, client);
  if (!cards.length) return [];
  const { rank } = await import('./rank.js');
  const notes = cards.map(c => ({ id: c.id, title: c.name.replace(/[:_-]+/g, ' '), answers: [purpose(c)], body: c.text, kind: 'howto', deps: [], card: c }));
  return rank(notes, { query }).slice(0, max).map(r => r.note.card);
}
export const skillLines = cards => cards.map(c => `- ${c.name}: ${purpose(c)} (${howTo(c)})`).join('\n');

// The names of the switched-off skills alone, for the agent's instructions: what exists and where it is.
export function switchedOffSkillIndex(store, { client } = {}) {
  const cards = skillCards(store, client);
  if (!cards.length) return '';
  const dirs = [...new Set(cards.map(c => (String(c.use || '').match(/read (.+)\/[^/]+\/SKILL\.md/) || [])[1]).filter(Boolean).map(d => path.relative(store.repo, d) || '.'))];
  return `This repository's skills are not listed in your instructions. When one applies to your change, ${dirs.length === 1 ? `read ${dirs[0]}/<name>/SKILL.md` : 'read its SKILL.md'} and follow it: ${cards.map(c => c.name).join(', ')}.`;
}

// --- what switching off saved, measured -----------------------------------------------------------------
// Each source switched off here keeps what it cost a session before (the report's measure, from the
// transcripts). Every Claude Code session started here since is read for it: absent, the session saved that
// context, once in its window and again in each model call that read the window (as cache reads, mostly);
// still loaded, the switch did not take effect there (another checkout, a setting that outranks it) and it
// is counted as such, never as saved.
// A Cursor server is read against the Cursor snapshots since (harness-cursor.js): absent from a chat's
// inventory, it saved its catalog entry there; Cursor records no model calls, so it adds no input tokens.
export function harnessSavings(store, { sessions, cursor, home = os.homedir(), thinkerHome: tHome = thinkerHome() } = {}) {
  const applied = readHarnessState(store).applied || [];
  if (!applied.length) return { sources: [], sessions: 0, tokens: 0, inputTokens: 0 };
  const since = Math.min(...applied.map(a => Date.parse(a.at)));
  const days = Math.ceil((Date.now() - since) / 86400_000) + 1;
  if (!sessions) cursor ??= applied.some(a => a.client === 'cursor') ? cursorSnapshots(tHome, { sinceMs: days * 86400_000 }) : [];
  cursor ||= [];
  sessions ??= [...new Map(checkouts(store.repo).flatMap(r => findSessions(r, { sinceMs: days * 86400_000 })).map(s => [s.file, s])).values()];
  const records = applied.some(a => a.undo?.key === 'desktop-connector') ? desktopFor(home) : null;
  const read = sessions.filter(s => ['claude', 'codex'].includes(s.client)).map(s => ({ ...(s.client === 'codex' ? codexSessionHarness(s.file) : claudeSessionHarness(s.file, records)), client: s.client, mtime: s.mtime })).filter(h => (h.loaded.size || h.coverage?.size) && h.start && !h.parent);
  const keysOf = a => {
    if (a.client === 'codex') return k => (a.evidenceKeys || [a.key.slice(6)]).includes(k);
    const ks = a.members || [a.key];
    if (a.kind === 'plugin') return k => k === a.key || k.startsWith(`skill:${a.name}:`) || k === `mcp:plugin:${a.name}` || k.startsWith(`mcp:plugin:${a.name}_`);
    return k => ks.includes(k);
  };
  let total = 0, input = 0;
  const out = applied.map(a => {
    if (a.client === 'cursor') {
      const id = a.key.replace(/^cursor:mcp:/, ''), after = cursor.filter(s => Date.parse(s.at) > Date.parse(a.at)), still = after.filter(s => s.servers[id]).length;
      total += (after.length - still) * a.tokens;
      return { key: a.key, client: 'cursor', name: a.name, kind: a.kind, at: a.at, tokensPerSession: a.tokens, sessions: after.length, absent: after.length - still, stillLoaded: still, tokens: (after.length - still) * a.tokens, inputTokens: 0 };
    }
    const has = keysOf(a), after = read.filter(h => h.client === (a.client || 'claude') && Date.parse(h.start) > Date.parse(a.at) && (a.undo?.key !== 'desktop-connector' || h.desktop) && (h.client !== 'codex' || (a.evidenceKeys || [a.key.slice(6)]).every(k => h.coverage.has(k.split(':')[0]))));
    const still = after.filter(h => [...h.loaded.keys()].some(has));
    const absent = after.length - still.length, calls = after.filter(h => !still.includes(h)).reduce((n, h) => n + h.calls, 0);
    total += absent * a.tokens; input += calls * a.tokens;
    return { key: a.key, client: a.client || 'claude', name: a.name, kind: a.kind, scope: a.undo?.key === 'desktop-connector' ? 'desktop' : undefined, at: a.at, tokensPerSession: a.tokens, sessions: after.length, absent, stillLoaded: still.length, tokens: absent * a.tokens, inputTokens: calls * a.tokens };
  });
  return { sources: out, sessions: read.filter(h => Date.parse(h.start) > since).length + cursor.filter(s => Date.parse(s.at) > since).length, tokens: total, inputTokens: input };
}

// Everything the page shows (ui/server.js /api/harness) and the command prints: the report, the advice,
// what was switched off with what it saved, and whether a question waits.
export function harnessView(store, { days = 30, home } = {}) {
  if (!harnessOn(store)) return { enabled: false, days, settings: harnessSettings(store, { home }) };
  const usage = harnessUsage(store.repo, { days });
  const slim = s => ({ client: s.client, key: s.key, name: s.name, kind: s.kind, scope: s.scope, loaded: s.loaded, used: s.used, tokens: s.tokens, off: s.off });
  return {
    days, sessions: usage.sessions, byClient: usage.byClient,
    sources: usage.sources.filter(s => s.tokens >= MIN_TOKENS).map(slim),
    advice: harnessAdvice(usage).map(s => ({ ...slim(s), label: labelOf(s), action: s.action, input: perSession(s.tokens, usage.calls?.[s.client || 'claude'] || 0) })), calls: usage.calls,
    settings: harnessSettings(store, { home }),
    saved: harnessSavings(store),
    enabled: true,
  };
}

// --- the index: the names of the switched-off skills, once a session ------------------------------------
// With the listing off the agent read 15% of the skills its changes called for, against 98% with it listed
// (posthog-hard-pr-vs-pr-und-sonnet-2026-10-17, Astra), and recall surfaced none: the model judges fit well,
// it only needs to know what exists. The index gives it the names alone (~770 tokens for PostHog's 107 skills,
// against ~4.5k for Codex's listing) and where the files are, once at the start of a session. A new way of
// reaching the agent: off until an experiment shows it helps (AGENTS.md); `harness: { skillIndex: true }` in
// .thinker/config.json, or THINKER_HARNESS_INDEX=on, turns it on.
export const indexOn = store => {
  if (!harnessOn(store)) return false;
  const env = process.env.THINKER_HARNESS_INDEX || '';
  if (/^(0|off|false)$/i.test(env)) return false;
  return /^(1|on|true)$/i.test(env) || store.config().harness?.skillIndex === true;
};
// The block, or '' when it is off, already said this session, or no switched-off skill has a file to read.
export function harnessIndex(store, { session, client } = {}) {
  if (!indexOn(store)) return '';
  const st = readHarnessState(store);
  const cards = (st.applied || []).filter(a => !client || (a.client || 'claude') === client).flatMap(a => a.cards || []).filter(c => c.file);
  if (!cards.length || (session && st.indexed?.[session])) return '';
  if (session && session !== 'unknown') {
    st.indexed ||= {};
    st.indexed[session] = true;
    const keys = Object.keys(st.indexed); for (const k of keys.slice(0, Math.max(0, keys.length - RECALL.sessions))) delete st.indexed[k];
    saveState(store, st);
  }
  // one line per directory of skills: <dir>/<name>/SKILL.md, the names after it
  const rel = f => (store.repo && f.startsWith(store.repo + path.sep) ? path.relative(store.repo, f) : f);
  const byDir = new Map();
  for (const c of cards) {
    const f = rel(c.file), dir = path.basename(path.dirname(f)) === c.name ? path.dirname(path.dirname(f)) : null;
    if (!/^[^\n\r`<>]{1,400}$/.test(dir || f) || !/^[\w.:-]{1,100}$/.test(c.name)) continue;
    const k = dir ? `${dir}/<name>/SKILL.md` : f;
    byDir.set(k, [...(byDir.get(k) || []), c.name]);
  }
  if (!byDir.size) return '';
  store.log({ op: 'harness-index', session: session === 'unknown' ? undefined : session, client, skills: cards.length });
  return `<thinker-skills>\nThis repository's skills are not listed in full here, to save context. Before work one of them covers, read its file and follow it:\n${[...byDir].map(([k, names]) => `${k}: ${names.sort().join(', ')}`).join('\n')}\n</thinker-skills>`;
}

// --- the controls: `thinker harness --off/--undo/--recall/--enabled`, and the page's buttons ---
export function harnessSettings(store, { home } = {}) {
  return { enabled: harnessOn(store), recall: recallOn(store) };
}
// recall: the switched-off lines (harness.recall) and enabled: the whole feature here (harness.enabled),
// off by default, both in .thinker/config.json; builtinTools: whether the advice counts the agent's own tools
export function setHarnessSettings(store, { enabled, recall, builtinTools } = {}, { home } = {}) {
  if (enabled !== undefined || recall !== undefined || builtinTools !== undefined) {
    const file = path.join(store.dir, 'config.json'), cfg = readJson(file) || {};
    if (enabled !== undefined) (cfg.harness ||= {}).enabled = Boolean(enabled);
    if (builtinTools !== undefined) (cfg.harness ||= {}).builtinTools = Boolean(builtinTools);
    if (recall !== undefined) (cfg.harness ||= {}).recall = Boolean(recall);
    writeJson(file, cfg, true);
  }
  const now = harnessSettings(store, { home });
  store.log({ op: 'harness-settings', ...now });
  return now;
}
// Switch named sources off now: the page's checkboxes, `--off`, and the weekly suggestion's Switch off
// (context-view.js:switchSources, context-suggest.js:approveChanges). Every source thinker can switch off
// here is a candidate; what the labels do not name is left alone. `any`: a source by its label whether or
// not the advice would name it (the Context view's switches).
export function switchOffNow(store, labels, { home, userHome = os.homedir(), now = Date.now(), via = 'cli', usage, any = false } = {}) {
  if (!harnessOn(store)) return OFF_MESSAGE;
  const picks = pickSources(usage || harnessUsage(store.repo), { any });
  if (!picks.length) return 'Nothing here is worth switching off; nothing changed.';
  // a label names a source by its label ("rea MCP server"), its key, or its bare name where only one has it
  const said = String(labels || '').split(/[,\n]/).map(s => s.trim().replace(/^["'`]|["'`]$/g, '').toLowerCase()).filter(Boolean);
  const chosen = picks.filter(p => said.some(w => w === labelOf(p).toLowerCase() || w.startsWith(`${labelOf(p).toLowerCase()} (`) || w === String(p.key).toLowerCase() || (w === p.name.toLowerCase() && picks.filter(q => q.name.toLowerCase() === w).length === 1)));
  if (!chosen.length) return 'Nothing switched off: nothing here goes by those names.';
  const st = readHarnessState(store), at = new Date(now).toISOString();
  const backups = new Map(), done = [], failed = [], overrides = claudeHarnessConfig(store.repo, { home: userHome }).overrides;
  for (const s of chosen) {
    try { done.push({ client: s.client || 'claude', evidenceKeys: s.evidenceKeys, key: s.key, members: s.members, name: s.name, kind: s.kind, tokens: s.tokens, at, undo: apply(store.repo, s, { userHome, home, now, backups, overrides }), cards: cardsFor(s, { repo: store.repo }) }); }
    catch (e) { failed.push(`${s.name} (${e.message})`); }
  }
  (st.applied ||= []).push(...done);
  saveState(store, st);
  const tokens = done.reduce((t, d) => t + d.tokens, 0);
  store.log({ op: 'harness-off', via, chosen: chosen.length, switched: done.length, tokens });
  const files = done.filter(d => d.undo.key !== 'desktop-connector'), desk = done.filter(d => d.undo.key === 'desktop-connector');
  const line = files.length ? `Switched off here from the next session on${files.some(d => d.client === 'cursor') ? ' (the Cursor ones in every repository)' : ''}: ${files.map(d => d.name).join(', ')}, about ${formatTokens(files.reduce((t, d) => t + d.tokens, 0))} tokens a session. \`thinker harness --undo\` turns them back on${backups.size ? `; what the files said before is under ${path.dirname([...backups.values()][0])}` : ''}.` : '';
  // the desktop app's connectors: the agent flips the app's switch, one call each, which the user approves
  const app = desk.length ? `Now switch off the desktop app's connector${desk.length === 1 ? '' : 's'} chosen: call ${CONNECTOR_TOOL} with ${desk.map(d => `connector ${JSON.stringify(d.undo.id)} (${d.name})`).join(', ')} and enabled false, one call each. The app keeps ${desk.length === 1 ? 'it' : 'them'} off in every new session on this machine; the + menu → Connectors turns ${desk.length === 1 ? 'it' : 'them'} back on.` : '';
  return [line, app, failed.length ? `Not switched off: ${failed.join('; ')}.` : ''].filter(Boolean).join(' ');
}

