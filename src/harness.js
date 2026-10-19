// What an agent's harness loads into every session, against what the sessions use: MCP servers,
// plugins and skills that cost context each time and are never called. "thinker loads what this
// repo needs, notes and tools alike": the notes are the cache, the tools are this report.
//
// Claude Code writes what it loaded into the session's transcript, so the cost is measured, not
// guessed from the settings: `deferred_tools_delta` names every deferred tool (mcp__<server>__<tool>)
// and the full definitions it surfaced, `mcp_instructions_delta` carries each server's instructions,
// `skill_listing` the skill list with its descriptions. What a session used is its tool calls (an MCP
// tool, the Skill tool) and the slash commands typed, its subagents' included.
// The settings are read only to say where a source is switched on, so the advice names the place to
// change it. Nothing here writes them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findSessions } from './transcripts.js';
import { estTokens } from './rank.js';

// a source loaded in this many sessions and called in none is worth switching off
export const MIN_SESSIONS = 3;
// called in fewer than this share of the sessions that loaded it: load it when needed instead
export const RARE_SHARE = 0.1;
// a source this small costs less than reading what the advice says about it
export const MIN_TOKENS = 100;

// one key for a server, whether it is named by its tools (mcp__claude_ai_Claude_Docs__) or by its
// instructions ("claude.ai Claude Docs")
export const serverKey = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const toolServer = name => (String(name).match(/^mcp__(.+?)__/) || [])[1] || null;
// a plugin's own MCP server is named mcp__plugin_<plugin>_<server>__
const pluginOfServer = s => (String(s).match(/^plugin_([^_]+)_/) || [])[1] || null;
const pluginOfSkill = s => String(s).includes(':') ? String(s).split(':')[0] : null;

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
export function sessionHarness(file) {
  const loaded = new Map(), used = new Set();
  let cwd = null;
  const add = (key, tokens) => loaded.set(key, (loaded.get(key) || 0) + tokens);
  const files = [file];
  try { const sub = path.join(file.replace(/\.jsonl$/, ''), 'subagents'); for (const f of fs.readdirSync(sub)) if (f.endsWith('.jsonl')) files.push(path.join(sub, f)); } catch {}
  files.forEach((f, fi) => {
    let text = ''; try { text = fs.readFileSync(f, 'utf8'); } catch { return; }
    for (const line of text.split('\n')) {
      const att = fi === 0 && line.includes('"attachment"'), call = line.includes('"tool_use"'), typed = line.includes('<command-name>');
      if (!att && !call && !typed && cwd) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (!cwd && typeof j.cwd === 'string') cwd = j.cwd;
      const a = j.attachment;
      if (att && a && typeof a === 'object') {
        if (a.type === 'deferred_tools_delta') {
          for (const n of a.addedNames || []) { const s = toolServer(n); if (s) add(`mcp:${serverKey(s)}`, estTokens(n + '\n')); }
          for (const d of a.surfacedDefinitions || []) { const s = toolServer(d?.name); if (s) add(`mcp:${serverKey(s)}`, estTokens(JSON.stringify(d.definition || d))); }
        } else if (a.type === 'mcp_instructions_delta') {
          (a.addedNames || []).forEach((n, i) => add(`mcp:${serverKey(n)}`, estTokens(a.addedBlocks?.[i] || '')));
        } else if (a.type === 'skill_listing') {
          for (const [n, t] of skillCosts(a.content || '', a.names || [])) add(`skill:${n}`, t);
        }
      }
      if (call) {
        for (const c of Array.isArray(j.message?.content) ? j.message.content : []) {
          if (c?.type !== 'tool_use') continue;
          const s = toolServer(c.name);
          if (s) used.add(`mcp:${serverKey(s)}`);
          else if (c.name === 'Skill' && c.input?.skill) used.add(`skill:${c.input.skill}`);
        }
      }
      if (typed) for (const m of line.matchAll(/<command-name>\/?([^<\s]+)<\/command-name>/g)) used.add(`skill:${m[1]}`);
    }
  });
  return { loaded, used, cwd };
}

// Where each source is switched on: Claude Code's settings and MCP files for this repository.
export function claudeHarnessConfig(repo, { home = os.homedir() } = {}) {
  const json = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const dirs = d => { try { return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory() || e.isSymbolicLink()).map(e => e.name); } catch { return []; } };
  const claudeJson = json(path.join(home, '.claude.json')) || {};
  const servers = new Map();
  for (const [scope, list] of [['user', claudeJson.mcpServers], ['local', claudeJson.projects?.[repo]?.mcpServers], ['project', json(path.join(repo, '.mcp.json'))?.mcpServers]]) {
    for (const name of Object.keys(list || {})) servers.set(serverKey(name), { name, scope });
  }
  const plugins = new Map();
  for (const [scope, f] of [['user', path.join(home, '.claude', 'settings.json')], ['project', path.join(repo, '.claude', 'settings.json')], ['local', path.join(repo, '.claude', 'settings.local.json')]]) {
    for (const [id, on] of Object.entries(json(f)?.enabledPlugins || {})) plugins.set(id.split('@')[0], { id, scope, on: on !== false });
  }
  const skills = new Map();
  for (const n of dirs(path.join(home, '.claude', 'skills'))) skills.set(n, { scope: 'user', dir: path.join(home, '.claude', 'skills', n) });
  for (const n of dirs(path.join(repo, '.claude', 'skills'))) skills.set(n, { scope: 'project', dir: path.join(repo, '.claude', 'skills', n) });
  return { servers, plugins, skills };
}

// The checkouts of a repository: itself and its worktrees, whose sessions are its sessions too.
function checkouts(repo) {
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    return [...new Set([repo, ...out.split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9))])];
  } catch { return [repo]; }
}

// The Claude Code sessions of a repository's checkouts over the window: what each source cost and
// how often it was called. A source is a plugin when its skills or server belong to one, so a
// plugin of eighteen skills is one line and one switch.
export function harnessUsage(repo, { days = 30, home = os.homedir(), sessions } = {}) {
  sessions ??= checkouts(repo).flatMap(r => findSessions(r, { sinceMs: days * 86400_000 }).filter(s => s.client === 'claude'));
  const config = claudeHarnessConfig(repo, { home });
  const rows = new Map();
  const row = key => {
    if (!rows.has(key)) rows.set(key, { key, loaded: 0, used: 0, tokens: 0, lastUsed: null });
    return rows.get(key);
  };
  const group = k => {
    const [kind, name] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
    const plugin = kind === 'skill' ? pluginOfSkill(name) : pluginOfServer(name);
    return plugin ? `plugin:${plugin}` : k;
  };
  let counted = 0;
  for (const s of sessions) {
    const h = sessionHarness(s.file);
    if (!h.loaded.size) continue; // written before Claude Code recorded what it loaded
    counted++;
    const tokens = new Map(), used = new Set([...h.used].map(group));
    for (const [k, t] of h.loaded) tokens.set(group(k), (tokens.get(group(k)) || 0) + t);
    for (const [k, t] of tokens) {
      const r = row(k); r.loaded++; r.tokens += t;
      if (used.has(k)) { r.used++; if (!r.lastUsed || s.mtime > r.lastUsed) r.lastUsed = s.mtime; }
    }
  }
  const out = [...rows.values()].map(r => ({ ...r, tokens: Math.round(r.tokens / r.loaded), ...describe(r.key, config) }));
  return { repo, days, sessions: counted, sources: out.sort((a, b) => b.tokens * (b.loaded - b.used) - a.tokens * (a.loaded - a.used)) };
}

// What a source is and where it is switched on, so the advice names the setting to change.
function describe(key, { servers, plugins, skills }) {
  const name = key.slice(key.indexOf(':') + 1);
  if (key.startsWith('plugin:')) {
    const p = plugins.get(name);
    return { name, kind: 'plugin', scope: p?.scope || null, id: p?.id || name };
  }
  if (key.startsWith('mcp:')) {
    if (name.startsWith('claude_ai_')) return { name: name.replace(/^claude_ai_/, ''), kind: 'connector', scope: 'claude.ai' };
    const s = servers.get(name);
    return { name: s?.name || name, kind: 'mcp', scope: s?.scope || null };
  }
  const s = skills.get(name);
  return { name, kind: 'skill', scope: s?.scope || null, dir: s?.dir };
}

// The sources worth switching off here: loaded in enough sessions, called in none or almost none,
// and switched on somewhere a person can change (a source Claude Code builds in has no setting).
export function harnessAdvice(usage) {
  return usage.sources
    .filter(s => s.scope && s.loaded >= MIN_SESSIONS && s.tokens >= MIN_TOKENS && s.used / s.loaded < RARE_SHARE)
    .map(s => ({ ...s, unused: s.used === 0, action: action(s, usage.repo) }));
}

function action(s, repo) {
  const settings = s.scope === 'user' ? '~/.claude/settings.json' : s.scope === 'project' ? '.claude/settings.json' : '.claude/settings.local.json';
  if (s.kind === 'plugin') return s.scope === 'user'
    ? `switch it off for this repository: "enabledPlugins": {"${s.id}": false} in .claude/settings.local.json (or off in ${settings}, and on in the repositories that use it)`
    : `remove "${s.id}" from "enabledPlugins" in ${settings}`;
  if (s.kind === 'connector') return 'switch it off in /mcp, and back on in a session that needs it';
  if (s.kind === 'mcp') {
    // the entry is not printed: its env can hold keys
    if (s.scope === 'user') return `move it to the repositories that use it: copy its entry from "mcpServers" in ~/.claude.json into their .mcp.json (or \`claude mcp add-json -s local ${s.name} '<entry>'\` in each), then \`claude mcp remove -s user ${s.name}\``;
    if (s.scope === 'local') return `\`claude mcp remove -s local ${s.name}\` in ${repo}`;
    return `remove "${s.name}" from .mcp.json`;
  }
  return s.scope === 'user' ? `move ${s.dir} into .claude/skills/ of the repositories that use it` : `remove ${s.dir}`;
}
