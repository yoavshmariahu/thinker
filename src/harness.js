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
import { codexSessionHarness, codexHarnessUsage, codexHarnessConfig, codexConfigFile, editCodexSetting } from './harness-codex.js';
import { cursorHarnessUsage, cursorSnapshots, editCursorMcp } from './harness-cursor.js';
import { findSessions } from './transcripts.js';
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
export function sessionHarness(file) {
  // what a source costs is counted once per thing listed: a session resumed or compacted lists it again
  const names = new Map(), instr = new Map(), skills = new Map(), used = new Set(), texts = new Map(), calls = new Set(), alias = new Map();
  let cwd = null, start = null;
  const once = (key, item, tokens) => { if (!names.has(key)) names.set(key, new Map()); names.get(key).set(item, tokens); };
  const files = [file];
  try { const sub = path.join(file.replace(/\.jsonl$/, ''), 'subagents'); for (const f of fs.readdirSync(sub)) if (f.endsWith('.jsonl')) files.push(path.join(sub, f)); } catch {}
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
        }
      }
      if (call) {
        for (const c of Array.isArray(j.message?.content) ? j.message.content : []) {
          if (c?.type !== 'tool_use') continue;
          const s = toolServer(c.name);
          if (s) used.add(mcpKey(s));
          else if (c.name === 'Skill' && c.input?.skill) used.add(`skill:${c.input.skill}`);
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
  return { loaded, used: usedNames, cwd, texts, start, calls: calls.size };
}

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
  return { servers, plugins, skills, overrides, key, paths: cp };
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
// Cursor's sources are the machine's (harness-cursor.js): read from every Cursor session on it, unless the
// caller names its own sessions and no Cursor snapshots.
export function harnessUsage(repo, { days = 30, home = os.homedir(), sessions, cursor, thinkerHome: tHome = thinkerHome() } = {}) {
  if (!sessions) cursor ??= cursorSnapshots(tHome, { sinceMs: days * 86400_000 });
  sessions ??= [...new Map(checkouts(repo).flatMap(r => findSessions(r, { sinceMs: days * 86400_000 })).map(s => [s.file, s])).values()];
  const claude = claudeUsage(repo, { days, home, sessions: sessions.filter(s => s.client === 'claude') });
  const codex = codexHarnessUsage(repo, sessions.filter(s => s.client === 'codex'), { home });
  const cur = cursor ? cursorHarnessUsage({ home, snapshots: cursor }) : { sessions: 0, sources: [] };
  return { ...claude, sessions: claude.sessions + codex.sessions + cur.sessions, byClient: { claude: claude.sessions, codex: codex.sessions, cursor: cur.sessions }, sources: [...claude.sources.map(s => ({ ...s, client: 'claude' })), ...codex.sources, ...cur.sources].sort((a, b) => b.tokens * (b.loaded - b.used) - a.tokens * (a.loaded - a.used)) };
}
function claudeUsage(repo, { days = 30, home = os.homedir(), sessions } = {}) {
  sessions ??= checkouts(repo).flatMap(r => findSessions(r, { sinceMs: days * 86400_000 }).filter(s => s.client === 'claude'));
  const config = claudeHarnessConfig(repo, { home });
  const rows = new Map();
  const row = key => {
    if (!rows.has(key)) rows.set(key, { key, loaded: 0, used: 0, tokens: 0, lastUsed: null, skills: new Set(), texts: {} });
    return rows.get(key);
  };
  const read = sessions.map(s => ({ s, h: sessionHarness(s.file) }));
  // the plugins the settings and the skill names name, longest first, to read a plugin server's key against
  const known = [...new Set([...config.plugins.keys(), ...read.flatMap(({ h }) => [...h.loaded.keys()].filter(k => k.startsWith('skill:')).map(k => pluginOfSkill(k.slice(6))).filter(Boolean))])].sort((a, b) => b.length - a.length);
  const group = k => {
    if (k.startsWith('mcp:plugin:')) { const rest = k.slice(11); return `plugin:${known.find(p => rest === p || rest.startsWith(`${p}_`)) || rest.split('_')[0]}`; }
    const plugin = k.startsWith('skill:') ? pluginOfSkill(k.slice(6)) : null;
    return plugin ? `plugin:${plugin}` : k;
  };
  let counted = 0;
  for (const { s, h } of read) {
    if (!h.loaded.size) continue; // written before Claude Code recorded what it loaded
    counted++;
    const tokens = new Map(), used = new Set([...h.used].map(group));
    for (const [k, t] of h.loaded) {
      tokens.set(group(k), (tokens.get(group(k)) || 0) + t);
      if (k.startsWith('skill:') && group(k) !== k) row(group(k)).skills.add(k.slice(6));
      if (h.texts.has(k)) row(group(k)).texts[k] = h.texts.get(k).slice(0, CARD_CHARS);
    }
    for (const [k, t] of tokens) {
      const r = row(k); r.loaded++; r.tokens += t;
      if (used.has(k)) { r.used++; if (!r.lastUsed || s.mtime > r.lastUsed) r.lastUsed = s.mtime; }
    }
  }
  const out = [...rows.values()].filter(r => r.loaded).map(r => ({ ...r, skills: [...r.skills].sort(), tokens: Math.round(r.tokens / r.loaded), ...describe(r.key, config, [...r.skills]) }));
  return { repo, days, sessions: counted, sources: out.sort((a, b) => b.tokens * (b.loaded - b.used) - a.tokens * (a.loaded - a.used)) };
}

// What a source is and where it is switched on, so the advice names the setting to change.
// `off`: switched off already, by a setting written since those sessions ran.
function describe(key, { servers, plugins, skills, overrides }, members) {
  const name = key.slice(key.indexOf(':') + 1);
  const hidden = n => ['off', 'user-invocable-only'].includes(overrides[n]);
  if (key.startsWith('plugin:')) {
    const p = plugins.get(name);
    return { name, kind: 'plugin', scope: p?.scope || null, id: p?.id || name, off: Boolean(p?.off) || (!p && members.length > 0 && members.every(hidden)) };
  }
  if (key.startsWith('mcp:')) {
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
// A plugin no setting names (one Claude Code brings) goes skill by skill. A claude.ai connector and a
// server no settings file names are left to /mcp.
function switchOff(s) {
  if (s.client === 'codex' || s.client === 'cursor') return s.how || null;
  if (s.scope === 'managed') return null;
  if (s.kind === 'plugin') return s.scope ? 'plugin' : s.skills?.length ? 'skills' : null;
  if (s.kind === 'mcp') return s.scope === 'project' ? 'mcpjson' : s.scope ? 'mcp' : null;
  if (s.kind === 'skill') return 'skill';
  return null;
}

// The sources worth switching off here: loaded in enough sessions, called in none or almost none,
// big enough to matter, and with a setting that switches them off for this repository.
export function harnessAdvice(usage) {
  return usage.sources
    .filter(s => switchOff(s) && !s.off && s.loaded >= MIN_SESSIONS && s.tokens >= MIN_TOKENS && s.used / s.loaded < RARE_SHARE)
    .map(s => ({ ...s, unused: s.used === 0, how: switchOff(s), action: action(s) }));
}

function action(s) {
  if (s.client === 'cursor') return `its entry taken out of ~/.cursor/mcp.json, for every repository (Cursor has no per-repository switch its editor reads; new chats; \`thinker harness --undo\` puts it back)`;
  if (s.client === 'codex') return `${s.kind === 'skill' ? `[[skills.config]] path = ${JSON.stringify(s.dir)}` : `[${s.kind === 'mcp' ? 'mcp_servers' : 'plugins'}.${JSON.stringify(s.id || s.name)}]`} enabled = false in this checkout's .codex/config.toml (trusted projects only; new sessions)`;
  switch (switchOff(s)) {
    case 'plugin': return `"enabledPlugins": {"${s.id}": false} in .claude/settings.local.json`;
    case 'skills': return `"skillOverrides" "user-invocable-only" for its ${s.skills.length} skills in .claude/settings.local.json (each still runs as /name)`;
    case 'mcp': return `"disabledMcpServers": ["${s.name}"] in this repository's entry of ~/.claude.json, for all its worktrees (what /mcp disable writes; /mcp enable undoes it)`;
    case 'mcpjson': return `"disabledMcpjsonServers": ["${s.name}"] in .claude/settings.local.json`;
    case 'skill': return `"skillOverrides": {"${s.name}": "user-invocable-only"} in .claude/settings.local.json (it still runs as /${s.name})`;
  }
}

// --- the suggestion ---------------------------------------------------------------------------------
// About once a week, the sources worth switching off, put to the person as one question with every one
// of them as an option, signed as thinker. A new way of reaching the agent: off until an experiment shows
// it helps (AGENTS.md); `maintain: { harness: true }` in .thinker/config.json turns it on, `thinker
// harness --suggest` queues one now. Claude Code and Codex; each adapter counts only what its transcripts record.
//
//   scheduleHarnessSuggestion  maintenance: at most weekly, the advice not passed on in the last month
//   harnessOffer               the prompt hook: the question, once, for the agent to put to the person
//   answerHarness              the answer (MCP `harness`, `thinker harness --answer`): switches the chosen
//                              sources off for this repository, a backup of each file first
//   undoHarness                `thinker harness --undo`: puts back what the answers switched off
//
// Local state: <cache>/state/harness.json (the pending question, answers, what was switched off);
// THINKER_HOME/state/harness-never.
export const HARNESS = {
  everyDays: 7,    // a suggestion at most this often
  max: 8,          // sources in one suggestion: two questions of four options
  bundle: 500,     // skills under this many tokens are one option together, so the question stays short
  declineDays: 30, // a source the person passed on is not suggested again for this long
  answerDays: 3,   // a question left unanswered this long is dropped
};
export const SIGNATURE = '🧠 thinker';
const DAY = 86_400_000;
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js');
const stateFile = store => path.join(store.dir, 'state', 'harness.json');
const neverFile = (home = thinkerHome()) => path.join(home, 'state', 'harness-never');
export const harnessNever = home => fs.existsSync(neverFile(home));
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
export const harnessPending = (store, { home } = {}) => harnessOn(store) && !harnessNever(home) && Boolean(readHarnessState(store).pending);

// What the question needs of a source, and nothing that could hold a secret.
const pick = s => ({ client: s.client, dir: s.dir, evidenceKeys: s.evidenceKeys, key: s.key, name: s.name, kind: s.kind, scope: s.scope, id: s.id, how: s.how, skills: s.skills, tokens: s.tokens, used: s.used, loaded: s.loaded, texts: s.texts });

// Small skills as one option: switched off together, each still runnable as /name.
const bundleOf = skills => ({
  key: `skills:${skills.map(s => s.name).join(',')}`, name: `${skills.length} rarely used skills`, kind: 'skills', how: 'skills',
  skills: skills.map(s => s.name), members: skills.map(s => s.key), tokens: skills.reduce((t, s) => t + s.tokens, 0), texts: Object.assign({}, ...skills.map(s => s.texts)),
  used: Math.max(...skills.map(s => s.used)), loaded: Math.max(...skills.map(s => s.loaded)),
});

// The options of a question: the advice with plain names, the small skills as one option, at most eight.
function pickSources(usage, keep = () => true, max = HARNESS.max) {
  const advice = harnessAdvice(usage).filter(s => keep(s) && SAFE_NAME.test(s.name) && (s.skills || []).every(n => SAFE_NAME.test(n))).map(pick);
  const small = advice.filter(s => s.client !== 'codex' && s.kind === 'skill' && s.tokens < HARNESS.bundle);
  return (small.length > 1 ? [...advice.filter(s => !small.includes(s)), bundleOf(small)] : advice).slice(0, max);
}

// Maintenance (or `thinker harness --suggest`, with force): a new question when there is something
// to ask. Returns the sources queued, or null.
export function scheduleHarnessSuggestion(store, { now = Date.now(), home, force = false, usage } = {}) {
  if (!harnessOn(store) || harnessNever(home)) return null;
  const st = readHarnessState(store);
  if (st.pending && !force) {
    // offered and not answered, or never offered (no supported prompt here since): dropped after a while
    if (now - Date.parse(st.pending.offeredAt || st.pending.at) > HARNESS.answerDays * DAY * (st.pending.offeredAt ? 1 : 2)) {
      store.log({ op: 'harness-answer', choice: 'unanswered', sources: st.pending.sources.length });
      delete st.pending; saveState(store, st);
    }
    return null;
  }
  if (!force && st.checkedAt && now - Date.parse(st.checkedAt) < HARNESS.everyDays * DAY) return null;
  usage ??= harnessUsage(store.repo);
  const recent = t => t && now - Date.parse(t) < HARNESS.declineDays * DAY;
  const picks = pickSources(usage, s => force || !recent(st.declined?.[s.key]));
  st.checkedAt = new Date(now).toISOString();
  if (picks.length) { st.pending = { at: st.checkedAt, days: usage.days, sessions: usage.sessions, byClient: usage.byClient, sources: picks }; store.log({ op: 'harness-suggest', sources: picks.length, tokens: picks.reduce((t, p) => t + p.tokens, 0) }); }
  else delete st.pending;
  saveState(store, st);
  return picks;
}

const KIND = { plugin: 'plugin', mcp: 'MCP server', skill: 'skill', skills: '' };
export const clientPrefix = c => ({ codex: 'Codex: ', cursor: 'Cursor: ' })[c] || '';
const labelOf = p => clientPrefix(p.client) + (p.kind === 'skills' ? p.name : `${p.name} ${KIND[p.kind]}`);
const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
const answerCommand = (repo, client = 'claude') => `${shq(process.execPath)} ${shq(CLI)} harness --answer '<labels|none|never>' --via picker --client ${client} --repo ${shq(repo)}`;
const optionOf = p => p.kind === 'skills'
  ? `label ${JSON.stringify(labelOf(p))}: ${p.skills.join(', ')}; ~${formatTokens(p.tokens)} tokens in every session together; each still runs as /name`
  : p.client === 'cursor'
    ? `label ${JSON.stringify(labelOf(p))}: ~${formatTokens(p.tokens)} tokens in every Cursor chat; ${p.used ? `used in ${p.used} of ${p.loaded}` : `used in none of ${p.loaded}`} Cursor chats on this machine; switched off in every repository`
    : `label ${JSON.stringify(labelOf(p))}: ~${formatTokens(p.tokens)} tokens in every session; ${p.used ? `used in ${p.used} of ${p.loaded}` : `used in none of ${p.loaded}`} sessions here`;
const ASK = {
  codex: `${SIGNATURE}: Ask the user which of the following labeled sources to switch off. Use request_user_input_async if available, otherwise ask in prose. Allow a comma-separated choice, none, or never. Do not assume a default or change settings until the user answers.`,
  cursor: `${SIGNATURE}: Before you start on the request, ask the user with your AskQuestion tool, not in prose: one question, title "🧠 Thinker", allow_multiple true, prompt "${SIGNATURE}: switch these off? They are loaded into every chat and almost never used. Each can be turned back on with \`thinker harness --undo\`." Its options are the sources below, in this order, each option's label the label given and then, in parentheses and without commas, its tokens and use from the rest of its line, plus a last option "none" and one "never (stop these suggestions on this machine)". Do not change settings until the user answers.`,
};
// a session no person is at: `claude -p`, the Agent SDK (CLAUDE_CODE_ENTRYPOINT sdk-cli, sdk-ts, sdk-py…)
const unattended = (env = process.env) => /^sdk-/.test(env.CLAUDE_CODE_ENTRYPOINT || '');
// The prompt hook: the pending question, said once, as an instruction to the agent to put it to the person.
export function harnessOffer(store, { client, home, now = Date.now(), env = process.env } = {}) {
  if (!['claude', 'codex', 'cursor'].includes(client) || !harnessOn(store) || harnessNever(home) || unattended(env)) return '';
  const st = readHarnessState(store);
  if (!st.pending || st.pending.offeredAt || !st.pending.sources.some(s => (s.client || 'claude') === client)) return '';
  st.pending.offeredAt = new Date(now).toISOString();
  saveState(store, st);
  const ps = st.pending.sources, total = ps.reduce((t, p) => t + p.tokens, 0);
  store.log({ op: 'harness-offer', client, sources: ps.length, tokens: total });
  const options = ps.map((p, i) => `${i + 1}. ${optionOf(p)}`).join('\n');
  return `<thinker-harness-suggestion>
Your agents load ${ps.length === 1 ? 'this' : 'these'} into every session in this repository, and the sessions here over the last ${st.pending.days} days almost never used ${ps.length === 1 ? 'it' : 'them'}: about ${formatTokens(total)} tokens across these source listings (the amount per session depends on the agent). thinker can switch ${ps.length === 1 ? 'it' : 'them'} off ${ps.every(p => p.client === 'cursor') ? 'in Cursor, for every repository (Cursor has no per-repository switch)' : ps.some(p => p.client === 'cursor') ? 'for this repository only (the Cursor ones in every repository: Cursor has no per-repository switch)' : 'for this repository only'}, from the next session on.
${ASK[client] || `Before you start on the request, ask the user with your AskUserQuestion tool, not in prose: one question with multiSelect true, header "🧠 Thinker", and the question "${SIGNATURE}: switch these off in this repository? About ${formatTokens(total)} tokens are loaded into every session here and almost never used. Each can be turned back on with \`thinker harness --undo\`." Its options are the sources below, in this order, each with the label given and the rest of its line as the description. If there are more than four, ask the rest in a second question of the same call, header "🧠 Thinker" and question "${SIGNATURE}: and these?". Choosing none means not now (thinker does not suggest those again for a month); "never" (Other) stops these suggestions on this machine.`}
${options}
Then call thinker's \`harness\` tool with choice set to the chosen labels exactly as given, comma-separated (or none, or never); if that tool is not available, run \`${answerCommand(store.repo, client)}\`. Then go on with the task.
</thinker-harness-suggestion>`;
}

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
  if (s.client === 'cursor') return editCursorMcp({ name: s.name, thinkerHome: home || thinkerHome(), home: userHome, write: writeTheirs });
  const local = path.join(repo, '.claude', 'settings.local.json'), claudeJson = claudePaths(userHome).json;
  const ctx = { home, now, backups }, fresh = !fs.existsSync(local);
  const done = u => { if (u.file === local && fresh) excludeFromGit(repo, local); return u; };
  if (s.how === 'plugin') { let prev; editJson(local, j => { j.enabledPlugins ||= {}; prev = j.enabledPlugins[s.id]; j.enabledPlugins[s.id] = false; }, ctx); return done({ file: local, key: 'enabledPlugins', id: s.id, prev }); }
  if (s.how === 'skills' || s.how === 'skill') {
    const names = (s.how === 'skills' ? s.skills : [s.name]).filter(n => overrides[n] === undefined);
    if (!names.length) throw new Error('its settings already say how it is listed');
    editJson(local, j => { j.skillOverrides ||= {}; for (const n of names) j.skillOverrides[n] = 'user-invocable-only'; }, ctx);
    return done({ file: local, key: 'skillOverrides', ids: names });
  }
  if (s.how === 'mcpjson') { editJson(local, j => { j.disabledMcpjsonServers = addTo(j.disabledMcpjsonServers, s.name); }, ctx); return done({ file: local, key: 'disabledMcpjsonServers', id: s.name }); }
  if (s.how === 'mcp') {
    const key = projectKey(repo);
    editJson(claudeJson, j => { const p = ((j.projects ||= {})[key] ||= {}); p.disabledMcpServers = addTo(p.disabledMcpServers, s.name); },
      { ...ctx, part: j => j.projects?.[key], check: j => (j.projects?.[key]?.disabledMcpServers || []).includes(s.name) });
    return { file: claudeJson, key: 'disabledMcpServers', project: key, id: s.name };
  }
  throw new Error(`no setting switches ${s.name} off`);
}

// Codex's per-project layer applies only to trusted projects. Never write machine-wide settings.
function applyCodex(repo, s, { home, userHome, now, backups }, undo) {
  const file = codexConfigFile(repo);
  const existing = fs.existsSync(file) ? file : path.dirname(file);
  if (fs.existsSync(existing) && !fs.realpathSync(existing).startsWith(fs.realpathSync(repo) + path.sep)) throw new Error('project Codex config points outside this checkout; left unchanged');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const inheritedSkills = s.kind === 'skill' && !undo ? [...codexHarnessConfig(repo, { home: userHome }).skills].map(([path, enabled]) => ({ path, enabled })) : undefined;
  const changed = editCodexSetting(before, { ...s, inheritedSkills }, undo);
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
    if (!before) excludeFromGit(repo, file);
  }
  return { file, key: 'codex', source: { kind: s.kind, name: s.name, id: s.id, dir: s.dir }, prev: changed.prev, created: changed.created, inherited: changed.inherited };
}

// The answer: never stops suggestions on this machine; none (or nothing that names a pending source)
// passes on them for a month; names switch those sources off here. Returns the line to tell the agent.
export function answerHarness(store, choice, { client, via = 'picker', home, userHome = os.homedir(), now = Date.now(), declineRest = true } = {}) {
  const st = readHarnessState(store), pending = st.pending?.sources || [];
  const raw = String(choice || '').trim();
  if (!st.pending && !/^never$/i.test(raw)) return `No thinker question waits for an answer in ${store.repo}; nothing changed. Go on with the task.`;
  if (/^never$/i.test(raw)) {
    const f = neverFile(home); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, new Date(now).toISOString() + '\n');
    delete st.pending; saveState(store, st);
    store.log({ op: 'harness-answer', choice: 'never', client, via, sources: pending.length });
    return 'Recorded: thinker will not suggest switching tools off again on this machine (`thinker harness` still shows the report). Go on with the task.';
  }
  // a choice names an option by its label ("rea MCP server"), its key, or its bare name where only one has it
  const said = raw.split(/[,\n]/).map(s => s.trim().replace(/^["'`]|["'`]$/g, '').toLowerCase()).filter(Boolean);
  const chosen = pending.filter(p => said.some(w => w === labelOf(p).toLowerCase() || w.startsWith(`${labelOf(p).toLowerCase()} (`) || w === String(p.key).toLowerCase() || (w === p.name.toLowerCase() && pending.filter(q => q.name.toLowerCase() === w).length === 1)));
  const at = new Date(now).toISOString();
  st.declined ||= {};
  if (declineRest) for (const p of pending) if (!chosen.includes(p)) for (const k of p.members || [p.key]) st.declined[k] = at;
  delete st.pending;
  if (!chosen.length) { saveState(store, st); store.log({ op: 'harness-answer', choice: 'none', client, via, sources: pending.length }); return 'Recorded: nothing switched off; thinker will not suggest these again for a month. Go on with the task.'; }
  const backups = new Map(), done = [], failed = [], overrides = claudeHarnessConfig(store.repo, { home: userHome }).overrides;
  for (const s of chosen) {
    try { done.push({ client: s.client || 'claude', evidenceKeys: s.evidenceKeys, key: s.key, members: s.members, name: s.name, kind: s.kind, tokens: s.tokens, at, undo: apply(store.repo, s, { userHome, home, now, backups, overrides }), cards: cardsFor(s) }); }
    catch (e) { failed.push(`${s.name} (${e.message})`); }
  }
  (st.applied ||= []).push(...done);
  saveState(store, st);
  const tokens = done.reduce((t, d) => t + d.tokens, 0);
  store.log({ op: 'harness-answer', choice: 'off', client, via, sources: pending.length, chosen: chosen.length, switched: done.length, tokens });
  const line = done.length ? `Switched off here from the next session on${done.some(d => d.client === 'cursor') ? ' (the Cursor ones in every repository)' : ''}: ${done.map(d => d.name).join(', ')}, about ${formatTokens(tokens)} tokens a session. \`thinker harness --undo\` turns them back on${backups.size ? `; what the files said before is under ${path.dirname([...backups.values()][0])}` : ''}.` : '';
  return `${line}${failed.length ? `${line ? ' ' : ''}Not switched off: ${failed.join('; ')}.` : ''} Tell the user in one line, then go on with the task.`;
}

// `thinker harness --undo`: every source the answers switched off here, turned back on.
export function undoHarness(store, { home, userHome = os.homedir(), now = Date.now(), names } = {}) {
  const st = readHarnessState(store), all = st.applied || [];
  const want = names?.length ? new Set(names.map(n => String(n).trim().toLowerCase())) : null;
  const applied = want ? all.filter(a => want.has(a.name.toLowerCase()) || want.has(a.key.toLowerCase())) : all, rest = want ? all.filter(a => !applied.includes(a)) : [];
  if (!applied.length) return want ? `Nothing switched off here by those names: ${[...want].join(', ')}.` : 'Nothing to undo: thinker has switched nothing off in this repository.';
  // each entry on its own: one file that cannot be read keeps its entry for the next try, the rest go back
  const backups = new Map(), ctx = { home, now, backups }, back = [], kept = [];
  for (const a of [...applied].reverse()) {
    const u = a.undo;
    try {
      if (u.key === 'codex') { applyCodex(store.repo, u.source, ctx, u); back.unshift(a.name); continue; }
      if (u.key === 'cursor') { editCursorMcp({ name: u.name, thinkerHome: home || thinkerHome(), home: userHome, write: writeTheirs }, true); back.unshift(a.name); continue; }
      editJson(u.file, j => {
        if (u.key === 'enabledPlugins') { if (j.enabledPlugins?.[u.id] === false) { if (u.prev === undefined) delete j.enabledPlugins[u.id]; else j.enabledPlugins[u.id] = u.prev; } }
        else if (u.key === 'skillOverrides') { for (const n of u.ids) if (j.skillOverrides?.[n] === 'user-invocable-only') delete j.skillOverrides[n]; }
        else if (u.key === 'disabledMcpjsonServers') j.disabledMcpjsonServers = (j.disabledMcpjsonServers || []).filter(n => n !== u.id);
        else if (u.key === 'disabledMcpServers') { const p = j.projects?.[u.project]; if (p) p.disabledMcpServers = (p.disabledMcpServers || []).filter(n => n !== u.id); }
      }, u.key === 'disabledMcpServers' ? { ...ctx, part: j => j.projects?.[u.project] } : ctx);
      back.unshift(a.name);
    } catch (e) { kept.push({ ...a, undoError: e.message }); }
  }
  if (kept.length || rest.length) st.applied = [...rest, ...kept]; else delete st.applied;
  delete st.recalled; saveState(store, st);
  store.log({ op: 'harness-undo', sources: back.length, failed: kept.length });
  return `${back.length ? `Turned back on, from the next session on: ${back.join(', ')}.` : ''}${kept.length ? `${back.length ? ' ' : ''}Not turned back on: ${kept.map(k => `${k.name} (${k.undoError})`).join('; ')}; \`thinker harness --undo\` tries again.` : ''}`;
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
export const recallOn = store => harnessOn(store) && (/^(1|on|true)$/i.test(process.env.THINKER_HARNESS_RECALL || '') || store.config().harness?.recall === true);

// One card per thing the person can bring back by name: a skill each (a plugin's too), a server whole.
function cardsFor(s) {
  const card = (key, name, text, back) => ({ id: key, name, text: String(text || name).slice(0, CARD_CHARS), back });
  if (s.client === 'codex') return [card(s.key, s.name, Object.values(s.texts || {}).join(' '), `\`thinker harness --undo ${s.key}\` brings it back from the next Codex session`)];
  if (s.client === 'cursor') return [card(s.key, s.name, Object.values(s.texts || {}).join(' '), `\`thinker harness --undo ${s.key}\` puts it back in ~/.cursor/mcp.json, for the next Cursor chat`)];
  if (s.kind === 'mcp') return [card(s.key, s.name, s.texts?.[`mcp:${serverKey(s.name)}`] || Object.values(s.texts || {})[0], `\`/mcp enable ${s.name}\` brings it back in this session`)];
  const back = s.how === 'plugin' ? n => `the ${s.name} plugin is off here: \`thinker harness --undo\` (or "enabledPlugins": {"${s.id}": true} in .claude/settings.local.json) brings it back from the next session` : n => `\`/${n}\` still runs it`;
  return (s.skills?.length ? s.skills : [s.name]).map(n => card(`skill:${n}`, n, s.texts?.[`skill:${n}`], back(n)));
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
  let c = null;
  try { c = await recallCard(cards.filter(x => !said.has(x.id)), prompt, { scoreFn }); } catch { return ''; }
  if (!c) return '';
  if (session && session !== 'unknown') {
    st.recalled ||= {};
    st.recalled[session] = [...said, c.id];
    const keys = Object.keys(st.recalled); for (const k of keys.slice(0, Math.max(0, keys.length - RECALL.sessions))) delete st.recalled[k];
    saveState(store, st);
  }
  store.log({ op: 'harness-recall', session: session === 'unknown' ? undefined : session, client, card: c.id, ce: c.ce == null ? undefined : Math.round(c.ce * 100) / 100 });
  // the description is the skill's own text, a third party's: a short excerpt, quoted as data, with nothing
  // that could close the block or open another
  const what = String(c.text).replace(/^\S+?(?=: | \()(\s*\([^)]*\))?:\s*/, '').replace(/[<>`\n\r]+/g, ' ').split(/(?<=\.)\s/)[0].trim().slice(0, 160);
  return `<thinker-switched-off>\n${c.name} is switched off here; its listing said: ${JSON.stringify(what)}. If this request needs it, tell the user that ${c.back}; otherwise ignore this line.\n</thinker-switched-off>`;
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
  const read = sessions.filter(s => ['claude', 'codex'].includes(s.client)).map(s => ({ ...(s.client === 'codex' ? codexSessionHarness(s.file) : sessionHarness(s.file)), client: s.client, mtime: s.mtime })).filter(h => (h.loaded.size || h.coverage?.size) && h.start && !h.parent);
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
    const has = keysOf(a), after = read.filter(h => h.client === (a.client || 'claude') && Date.parse(h.start) > Date.parse(a.at) && (h.client !== 'codex' || (a.evidenceKeys || [a.key.slice(6)]).every(k => h.coverage.has(k.split(':')[0]))));
    const still = after.filter(h => [...h.loaded.keys()].some(has));
    const absent = after.length - still.length, calls = after.filter(h => !still.includes(h)).reduce((n, h) => n + h.calls, 0);
    total += absent * a.tokens; input += calls * a.tokens;
    return { key: a.key, client: a.client || 'claude', name: a.name, kind: a.kind, at: a.at, tokensPerSession: a.tokens, sessions: after.length, absent, stillLoaded: still.length, tokens: absent * a.tokens, inputTokens: calls * a.tokens };
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
    advice: harnessAdvice(usage).map(s => ({ ...slim(s), label: labelOf(s), action: s.action })),
    settings: harnessSettings(store, { home }),
    saved: harnessSavings(store),
    pending: harnessPending(store, { home }), never: harnessNever(home), enabled: true,
  };
}

// --- the controls: `thinker harness --off/--undo/--weekly/--recall/--suggestions`, and the page's buttons ---
export function harnessSettings(store, { home } = {}) {
  return { enabled: harnessOn(store), weekly: store.config().maintain?.harness === true, recall: recallOn(store), suggestions: !harnessNever(home) };
}
// weekly: the question from maintenance (maintain.harness); recall: the switched-off lines (harness.recall),
// both in .thinker/config.json; suggestions: this machine's "never" (THINKER_HOME/state/harness-never);
// enabled: the whole feature here (harness.enabled), off by default
export function setHarnessSettings(store, { enabled, weekly, recall, suggestions } = {}, { home } = {}) {
  if (enabled !== undefined || weekly !== undefined || recall !== undefined) {
    const file = path.join(store.dir, 'config.json'), cfg = readJson(file) || {};
    if (enabled !== undefined) (cfg.harness ||= {}).enabled = Boolean(enabled);
    if (weekly !== undefined) (cfg.maintain ||= {}).harness = Boolean(weekly);
    if (recall !== undefined) (cfg.harness ||= {}).recall = Boolean(recall);
    writeJson(file, cfg, true);
  }
  if (suggestions === false) { const f = neverFile(home); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, new Date().toISOString() + '\n'); }
  if (suggestions === true) fs.rmSync(neverFile(home), { force: true });
  const now = harnessSettings(store, { home });
  store.log({ op: 'harness-settings', ...now });
  return now;
}
// Switch named sources off now, without a question: the page's checkboxes, `--off`. What is not named is
// not passed on; a question waiting here is replaced by this answer.
export function switchOffNow(store, labels, { home, userHome, now = Date.now(), via = 'cli', usage } = {}) {
  if (!harnessOn(store)) return OFF_MESSAGE;
  const picks = pickSources(usage || harnessUsage(store.repo), () => true, Infinity);
  if (!picks.length) return 'Nothing here is worth switching off; nothing changed.';
  const st = readHarnessState(store);
  st.pending = { at: new Date(now).toISOString(), days: 30, sources: picks, direct: true };
  saveState(store, st);
  return answerHarness(store, labels, { via, home, userHome, now, declineRest: false }).replace(/ Tell the user in one line, then go on with the task\.$/, '');
}
