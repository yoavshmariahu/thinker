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
  // the settings files from the least to the most specific, so a later one's value wins
  const settings = [['user', path.join(home, '.claude', 'settings.json')], ['project', path.join(repo, '.claude', 'settings.json')], ['local', path.join(repo, '.claude', 'settings.local.json')]].map(([scope, f]) => [scope, json(f) || {}]);
  const offMcp = new Set([...(claudeJson.projects?.[repo]?.disabledMcpServers || []), ...settings.flatMap(([, j]) => j.disabledMcpjsonServers || [])].map(serverKey));
  const servers = new Map();
  for (const [scope, list] of [['user', claudeJson.mcpServers], ['local', claudeJson.projects?.[repo]?.mcpServers], ['project', json(path.join(repo, '.mcp.json'))?.mcpServers]]) {
    for (const name of Object.keys(list || {})) servers.set(serverKey(name), { name, scope, off: offMcp.has(serverKey(name)) });
  }
  // the scope kept is where it is switched on (the advice names that setting); a later file switching it off wins
  const plugins = new Map();
  for (const [scope, j] of settings) {
    for (const [id, on] of Object.entries(j.enabledPlugins || {})) {
      const name = id.split('@')[0], was = plugins.get(name);
      plugins.set(name, { id, scope: on !== false || !was ? scope : was.scope, off: on === false });
    }
  }
  const overrides = Object.assign({}, ...settings.map(([, j]) => j.skillOverrides || {}));
  const skills = new Map();
  for (const n of dirs(path.join(home, '.claude', 'skills'))) skills.set(n, { scope: 'user', dir: path.join(home, '.claude', 'skills', n) });
  for (const n of dirs(path.join(repo, '.claude', 'skills'))) skills.set(n, { scope: 'project', dir: path.join(repo, '.claude', 'skills', n) });
  return { servers, plugins, skills, overrides };
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
    if (!rows.has(key)) rows.set(key, { key, loaded: 0, used: 0, tokens: 0, lastUsed: null, skills: new Set() });
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
    for (const [k, t] of h.loaded) {
      tokens.set(group(k), (tokens.get(group(k)) || 0) + t);
      if (k.startsWith('skill:') && group(k) !== k) row(group(k)).skills.add(k.slice(6));
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
  switch (switchOff(s)) {
    case 'plugin': return `"enabledPlugins": {"${s.id}": false} in .claude/settings.local.json`;
    case 'skills': return `"skillOverrides" "user-invocable-only" for its ${s.skills.length} skills in .claude/settings.local.json (each still runs as /name)`;
    case 'mcp': return `"disabledMcpServers": ["${s.name}"] in this repository's entry of ~/.claude.json (what /mcp disable writes; /mcp enable undoes it)`;
    case 'mcpjson': return `"disabledMcpjsonServers": ["${s.name}"] in .claude/settings.local.json`;
    case 'skill': return `"skillOverrides": {"${s.name}": "user-invocable-only"} in .claude/settings.local.json (it still runs as /${s.name})`;
  }
}

// --- the suggestion ---------------------------------------------------------------------------------
// About once a week, the sources worth switching off, put to the person as one question with every one
// of them as an option, signed as thinker. A new way of reaching the agent: off until an experiment shows
// it helps (AGENTS.md); `maintain: { harness: true }` in .thinker/config.json turns it on, `thinker
// harness --suggest` queues one now. Claude Code only, the one agent whose transcripts record what it
// loaded.
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
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, v, pretty) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.thinker-${process.pid}`;
  fs.writeFileSync(tmp, pretty ? JSON.stringify(v, null, 2) + '\n' : JSON.stringify(v) + '\n');
  fs.renameSync(tmp, f);
};
export const readHarnessState = store => readJson(stateFile(store)) || {};
const saveState = (store, st) => writeJson(stateFile(store), st);
export const harnessPending = (store, { home } = {}) => !harnessNever(home) && Boolean(readHarnessState(store).pending);

// What the question needs of a source, and nothing that could hold a secret.
const pick = s => ({ key: s.key, name: s.name, kind: s.kind, scope: s.scope, id: s.id, how: s.how, skills: s.skills, tokens: s.tokens, used: s.used, loaded: s.loaded });

// Small skills as one option: switched off together, each still runnable as /name.
const bundleOf = skills => ({
  key: `skills:${skills.map(s => s.name).join(',')}`, name: `${skills.length} rarely used skills`, kind: 'skills', how: 'skills',
  skills: skills.map(s => s.name), members: skills.map(s => s.key), tokens: skills.reduce((t, s) => t + s.tokens, 0),
  used: Math.max(...skills.map(s => s.used)), loaded: Math.max(...skills.map(s => s.loaded)),
});

// Maintenance (or `thinker harness --suggest`, with force): a new question when there is something
// to ask. Returns the sources queued, or null.
export function scheduleHarnessSuggestion(store, { now = Date.now(), home, force = false, usage } = {}) {
  if (harnessNever(home)) return null;
  const st = readHarnessState(store);
  if (st.pending && !force) {
    if (st.pending.offeredAt && now - Date.parse(st.pending.offeredAt) > HARNESS.answerDays * DAY) {
      store.log({ op: 'harness-answer', choice: 'unanswered', sources: st.pending.sources.length });
      delete st.pending; saveState(store, st);
    }
    return null;
  }
  if (!force && st.checkedAt && now - Date.parse(st.checkedAt) < HARNESS.everyDays * DAY) return null;
  usage ??= harnessUsage(store.repo);
  const recent = t => t && now - Date.parse(t) < HARNESS.declineDays * DAY;
  const advice = harnessAdvice(usage).filter(s => force || !recent(st.declined?.[s.key])).map(pick);
  const small = advice.filter(s => s.kind === 'skill' && s.tokens < HARNESS.bundle);
  const picks = (small.length > 1 ? [...advice.filter(s => !small.includes(s)), bundleOf(small)] : advice).slice(0, HARNESS.max);
  st.checkedAt = new Date(now).toISOString();
  if (picks.length) { st.pending = { at: st.checkedAt, days: usage.days, sessions: usage.sessions, sources: picks }; store.log({ op: 'harness-suggest', sources: picks.length, tokens: picks.reduce((t, p) => t + p.tokens, 0) }); }
  else delete st.pending;
  saveState(store, st);
  return picks;
}

const KIND = { plugin: 'plugin', mcp: 'MCP server', skill: 'skill', skills: '' };
const answerCommand = repo => `"${process.execPath}" "${CLI}" harness --answer <names|none|never> --via picker --client claude --repo "${repo}"`;
const optionOf = p => p.kind === 'skills'
  ? `"${p.name}" (label "${p.name}"): ${p.skills.join(', ')}; ~${formatTokens(p.tokens)} tokens in every session together; each still runs as /name`
  : `"${p.name}" (label "${p.name} ${KIND[p.kind]}"): ~${formatTokens(p.tokens)} tokens in every session; ${p.used ? `used in ${p.used} of ${p.loaded}` : `used in none of ${p.loaded}`} sessions here`;
// The prompt hook: the pending question, said once, as an instruction to the agent to put it to the person.
export function harnessOffer(store, { client, home, now = Date.now() } = {}) {
  if (client !== 'claude' || harnessNever(home)) return '';
  const st = readHarnessState(store);
  if (!st.pending || st.pending.offeredAt) return '';
  st.pending.offeredAt = new Date(now).toISOString();
  saveState(store, st);
  const ps = st.pending.sources, total = ps.reduce((t, p) => t + p.tokens, 0);
  store.log({ op: 'harness-offer', client, sources: ps.length, tokens: total });
  const options = ps.map((p, i) => `${i + 1}. ${optionOf(p)}`).join('\n');
  return `<thinker-harness-suggestion>
Claude Code loads ${ps.length === 1 ? 'this' : 'these'} into every session in this repository, and the sessions here over the last ${st.pending.days} days almost never used ${ps.length === 1 ? 'it' : 'them'}: about ${formatTokens(total)} tokens of context in each session. thinker can switch ${ps.length === 1 ? 'it' : 'them'} off for this repository only, from the next session on.
Before you start on the request, ask the user with your AskUserQuestion tool, not in prose: one question with multiSelect true, header "🧠 Thinker", and the question "${SIGNATURE}: switch these off in this repository? About ${formatTokens(total)} tokens are loaded into every session here and almost never used. Each can be turned back on with \`thinker harness --undo\`." Its options are the sources below, in this order, each with the label given and its line as the description. If there are more than four, ask the rest in a second question of the same call, header "🧠 Thinker" and question "${SIGNATURE}: and these?". Choosing none means not now (thinker does not suggest those again for a month); "never" (Other) stops these suggestions on this machine.
${options}
Then call thinker's \`harness\` tool with choice set to the chosen names exactly as quoted, comma-separated (or none, or never); if that tool is not available, run \`${answerCommand(store.repo)}\`. Then go on with the task.
</thinker-harness-suggestion>`;
}

// One edit of one JSON file, after a copy of the file as it was (THINKER_HOME/state/harness-backups/).
function editJson(file, fn, { home, now, backups }) {
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (before != null && !backups.has(file)) {
    const dir = path.join(home || thinkerHome(), 'state', 'harness-backups', new Date(now).toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const copy = path.join(dir, `${backups.size}-${path.basename(file)}`);
    fs.writeFileSync(copy, before); backups.set(file, copy);
  }
  let j = {}; if (before != null) { try { j = JSON.parse(before); } catch { throw new Error(`${file} is not valid JSON; left as it is`); } }
  fn(j);
  writeJson(file, j, true);
}
const addTo = (list, v) => { const a = Array.isArray(list) ? list : []; return a.includes(v) ? a : [...a, v]; };

// Switch one source off for this repository; returns what to undo it with.
function apply(repo, s, { userHome, home, now, backups }) {
  const local = path.join(repo, '.claude', 'settings.local.json'), claudeJson = path.join(userHome, '.claude.json');
  const ctx = { home, now, backups };
  if (s.how === 'plugin') { editJson(local, j => { (j.enabledPlugins ||= {})[s.id] = false; }, ctx); return { file: local, key: 'enabledPlugins', id: s.id }; }
  if (s.how === 'skills' || s.how === 'skill') {
    const names = s.how === 'skills' ? s.skills : [s.name];
    editJson(local, j => { j.skillOverrides ||= {}; for (const n of names) j.skillOverrides[n] = 'user-invocable-only'; }, ctx);
    return { file: local, key: 'skillOverrides', ids: names };
  }
  if (s.how === 'mcpjson') { editJson(local, j => { j.disabledMcpjsonServers = addTo(j.disabledMcpjsonServers, s.name); }, ctx); return { file: local, key: 'disabledMcpjsonServers', id: s.name }; }
  if (s.how === 'mcp') { editJson(claudeJson, j => { const p = ((j.projects ||= {})[repo] ||= {}); p.disabledMcpServers = addTo(p.disabledMcpServers, s.name); }, ctx); return { file: claudeJson, key: 'disabledMcpServers', project: repo, id: s.name }; }
  throw new Error(`no setting switches ${s.name} off`);
}

// The answer: never stops suggestions on this machine; none (or nothing that names a pending source)
// passes on them for a month; names switch those sources off here. Returns the line to tell the agent.
export function answerHarness(store, choice, { client, via = 'picker', home, userHome = os.homedir(), now = Date.now() } = {}) {
  const st = readHarnessState(store), pending = st.pending?.sources || [];
  const raw = String(choice || '').trim();
  if (/^never$/i.test(raw)) {
    const f = neverFile(home); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, new Date(now).toISOString() + '\n');
    delete st.pending; saveState(store, st);
    store.log({ op: 'harness-answer', choice: 'never', client, via, sources: pending.length });
    return 'Recorded: thinker will not suggest switching tools off again on this machine (`thinker harness` still shows the report). Go on with the task.';
  }
  const names = raw.split(/[,\n]/).map(s => s.trim().replace(/^["'`]|["'`]$/g, '').replace(/ (plugin|MCP server|skill)$/i, '')).filter(Boolean);
  const chosen = pending.filter(p => names.includes(p.name));
  const at = new Date(now).toISOString();
  st.declined ||= {};
  for (const p of pending) if (!chosen.includes(p)) for (const k of p.members || [p.key]) st.declined[k] = at;
  delete st.pending;
  if (!chosen.length) { saveState(store, st); store.log({ op: 'harness-answer', choice: 'none', client, via, sources: pending.length }); return 'Recorded: nothing switched off; thinker will not suggest these again for a month. Go on with the task.'; }
  const backups = new Map(), done = [], failed = [];
  for (const s of chosen) {
    try { done.push({ name: s.name, kind: s.kind, tokens: s.tokens, at, undo: apply(store.repo, s, { userHome, home, now, backups }) }); }
    catch (e) { failed.push(`${s.name} (${e.message})`); }
  }
  (st.applied ||= []).push(...done);
  saveState(store, st);
  const tokens = done.reduce((t, d) => t + d.tokens, 0);
  store.log({ op: 'harness-answer', choice: 'off', client, via, sources: pending.length, chosen: chosen.length, switched: done.length, tokens });
  const said = done.length ? `Switched off for this repository from the next session on: ${done.map(d => d.name).join(', ')}, about ${formatTokens(tokens)} tokens a session. \`thinker harness --undo\` turns them back on${backups.size ? `; the files as they were are under ${path.dirname([...backups.values()][0])}` : ''}.` : '';
  return `${said}${failed.length ? `${said ? ' ' : ''}Not switched off: ${failed.join('; ')}.` : ''} Tell the user in one line, then go on with the task.`;
}

// `thinker harness --undo`: every source the answers switched off here, turned back on.
export function undoHarness(store, { home, now = Date.now() } = {}) {
  const st = readHarnessState(store), applied = st.applied || [];
  if (!applied.length) return 'Nothing to undo: thinker has switched nothing off in this repository.';
  const backups = new Map(), ctx = { home, now, backups };
  for (const { undo: u } of applied) {
    editJson(u.file, j => {
      if (u.key === 'enabledPlugins') { if (j.enabledPlugins?.[u.id] === false) delete j.enabledPlugins[u.id]; }
      else if (u.key === 'skillOverrides') { for (const n of u.ids) if (j.skillOverrides?.[n] === 'user-invocable-only') delete j.skillOverrides[n]; }
      else if (u.key === 'disabledMcpjsonServers') j.disabledMcpjsonServers = (j.disabledMcpjsonServers || []).filter(n => n !== u.id);
      else if (u.key === 'disabledMcpServers') { const p = j.projects?.[u.project]; if (p) p.disabledMcpServers = (p.disabledMcpServers || []).filter(n => n !== u.id); }
    }, ctx);
  }
  delete st.applied; saveState(store, st);
  store.log({ op: 'harness-undo', sources: applied.length });
  return `Turned back on in this repository, from the next session on: ${applied.map(a => a.name).join(', ')}.`;
}
