// Client adapters: how thinker is wired into each coding agent, and how hook
// input/output differs between them.
//
//   client   prompt-time injection            file-keyed (late) notes   MCP registration
//   claude   UserPromptSubmit, plain stdout   PostToolUse               .mcp.json
//   codex    UserPromptSubmit, plain stdout   PostToolUse               .codex/config.toml
//   gemini   BeforeAgent, JSON only           AfterTool                 .gemini/settings.json
//   cursor   none: beforeSubmitPrompt cannot add context, so the bundle is
//            parked there and delivered by the first postToolUse; an
//            always-applied rule points the agent at the MCP tools
//                                             postToolUse               .cursor/mcp.json
//
// Pi/OpenCode use native extensions in integrations/; Windsurf records hooks
// and retrieves through a CLI rule; Copilot parks context until postToolUse.
// See docs/agent-integrations.md for the capability matrix.
//
// Learning from sessions: Claude Code's transcript is distilled at Stop. For
// the others the hooks record the session themselves (prompt, every tool call
// with its result, the closing message) and that trace is distilled, so
// learning does not depend on the agent's transcript format.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { guidance } from './integrations/runner.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gitHookPath } from './store.js';
import { HOOKS, installGitHooks } from './git-hooks.js';

export const CLIENTS = ['claude', 'codex', 'cursor', 'gemini', 'pi', 'windsurf', 'copilot', 'opencode'];

export function mergeJson(file, patch) {
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const next = patch(cur);
  // nor one whose content is unchanged: ~/.claude.json is written by Claude Code in its own layout
  if (JSON.stringify(next) === JSON.stringify(cur)) return;
  const text = JSON.stringify(next, null, 2) + '\n';
  // an unchanged file is not touched: the prompt hook refreshes the wiring on every prompt, and a
  // client that watches its settings file would otherwise see a change each time
  try { if (fs.readFileSync(file, 'utf8') === text) return; } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const onPath = bin => (process.env.PATH || '').split(path.delimiter).some(d => d && fs.existsSync(path.join(d, bin)));
const home = (...p) => path.join(os.homedir(), ...p);

// Clients that look installed on this machine (binary on PATH or a config directory).
export function detectClients() {
  const found = [];
  if (onPath('claude') || fs.existsSync(home('.claude'))) found.push('claude');
  if (onPath('codex') || fs.existsSync(home('.codex'))) found.push('codex');
  if (onPath('cursor') || onPath('cursor-agent') || onPath('agent') || fs.existsSync(home('.cursor'))) found.push('cursor');
  if (onPath('gemini') || onPath('agy') || fs.existsSync(home('.gemini'))) found.push('gemini');
  for (const [client, dir] of [['pi', '.pi'], ['windsurf', '.codeium/windsurf'], ['copilot', '.copilot'], ['opencode', '.config/opencode']]) {
    if (onPath(client) || fs.existsSync(home(dir))) found.push(client);
  }
  return found.length ? found : ['claude'];
}

export function parseClients(value, fallback = ['claude']) {
  const v = (!value || value === true) ? fallback : value;
  if (Array.isArray(v)) return v;
  if (v === 'all') return [...CLIENTS];
  if (v === 'auto') return detectClients();
  const list = String(v).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const bad = list.filter(c => !CLIENTS.includes(c));
  if (bad.length) throw new Error(`unknown client: ${bad.join(', ')} (known: ${CLIENTS.join(', ')}, all, auto)`);
  return [...new Set(list)];
}

// Which client is calling a hook: the explicit flag wins; Cursor also runs
// Claude Code hooks it imports from .claude/settings*.json, so detect it
// (from the hook input, not the environment: Claude Code started in Cursor's
// terminal is still Claude Code).
export function hookClient(flag, ev = {}) {
  if (flag && flag !== true) return String(flag);
  if (ev.cursor_version) return 'cursor-import';
  return 'claude';
}

export const sessionOf = ev => ev.session_id || ev.conversation_id || ev.conversationId || ev.sessionId || ev.trajectory_id || 'unknown';

// Translate host payloads once, before recording or retrieving anything.
export function normalizeHookEvent(client, ev, what) {
  if (client === 'windsurf') {
    const info = ev.tool_info || {};
    const names = { post_read_code: 'Read', post_write_code: 'Edit', post_run_command: 'Bash' };
    return { ...ev, session_id: ev.trajectory_id || ev.session_id, hook_event_name: ev.agent_action_name,
      prompt: info.user_prompt, tool_name: names[ev.agent_action_name] || `MCP:${info.mcp_tool_name || ''}`,
      tool_input: { ...info, command: info.command_line }, tool_response: info.mcp_result,
      last_assistant_message: info.response };
  }
  if (client === 'copilot') {
    let input = ev.toolArgs ?? ev.tool_input;
    if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = {}; } }
    return { ...ev, session_id: ev.sessionId || ev.session_id,
      tool_name: ev.toolName || ev.tool_name, tool_input: input,
      tool_response: ev.toolResult?.textResultForLlm ?? ev.tool_result?.text_result_for_llm ?? (ev.error ? `Error: ${ev.error}` : undefined),
      hook_event_name: ev.hook_event_name || (what === 'stop' && ev.reason ? 'SessionEnd' : undefined) };
  }
  return ev;
}

// Files named by a tool call, across the clients' tool input shapes.
export function toolFiles(ev, repo) {
  const ti = ev.tool_input || {};
  const files = [];
  for (const k of ['file_path', 'absolute_path', 'target_file', 'filePath']) if (typeof ti[k] === 'string') files.push(ti[k]);
  if (typeof ti.path === 'string' && /\.\w+$/.test(ti.path)) files.push(ti.path);
  const command = typeof ti.command === 'string' ? ti.command : Array.isArray(ti.command) ? ti.command.join(' ') : typeof ev.command === 'string' ? ev.command : '';
  for (const m of command.matchAll(/(?:^|[\s'"=])((?:[\w.@-]+\/)+[\w.@-]+\.\w{1,5})(?=$|[\s'":|;)])/g)) { const f = m[1]; if (fs.existsSync(path.join(repo, f))) files.push(f); }
  return files.map(f => path.isAbsolute(f) ? path.relative(repo, f) : f).filter(f => f && !f.startsWith('..'));
}

// What the prompt hook prints: the bundle as context for the agent, and nothing for the
// user. A line at every prompt was noise; the stop hook names what the turn served once.
export function promptOutput(client, text) {
  if (client === 'windsurf') return '';
  if (client === 'gemini') return JSON.stringify({ hookSpecificOutput: { hookEventName: 'BeforeAgent', additionalContext: text } });
  return text;
}
// Notices use each host's display API without requesting another model turn.
// Pi/OpenCode consume plain text in their native extensions; Windsurf shows stdout.
// Cursor and Copilot stop outputs only control continuation, not user notices.
export function stopOutput(client, notice) {
  if (!notice) return '';
  if (['claude', 'codex', 'gemini'].includes(client)) return JSON.stringify({ systemMessage: notice });
  if (['pi', 'opencode', 'windsurf'].includes(client)) return notice;
  return '';
}
export function toolOutput(client, text) {
  if (client === 'windsurf') return '';
  if (client === 'pi' || client === 'opencode') return text;
  if (client === 'copilot') return JSON.stringify({ additionalContext: text });
  if (client === 'cursor') return JSON.stringify({ additional_context: text });
  return JSON.stringify({ hookSpecificOutput: { hookEventName: client === 'gemini' ? 'AfterTool' : 'PostToolUse', additionalContext: text } });
}

// Cursor: park the prompt-time bundle until the first tool call of the turn.
const pendingFile = (storeDir, session) => path.join(storeDir, 'state', `pending-${String(session).replace(/[^\w.-]/g, '_')}.json`);
export function parkPending(storeDir, session, text) {
  const f = pendingFile(storeDir, session);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ text, at: Date.now() }));
}
export function takePending(storeDir, session) {
  const f = pendingFile(storeDir, session);
  try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); fs.unlinkSync(f); return Date.now() - j.at < 30 * 60_000 ? j.text : ''; } catch { return ''; }
}

const CURSOR_RULE = `---
description: Use the thinker cache of notes about this repository before exploring it
alwaysApply: true
---
This repository has a cache of verified notes from earlier sessions, served by the \`thinker\` MCP server.

- At the start of a task, call the \`orient\` tool with the request before searching or reading files.
- Follow the file:symbol pointers it returns instead of re-deriving them; search only to fill gaps.
- \`orient\` takes a \`budget\` and lists the relevant notes it did not show. Before searching for something one of those titles covers, call \`lookup\` with its id.
- Use \`lookup\` for a specific question mid-task. Treat notes marked STALE as unverified.
- To see the code behind a pointer, call \`drilldown\` with it (\`path:Symbol\`): the definition with its lines, callers and callees, and the notes on it, instead of reading the file and grepping for the name.
- Context wrapped in \`<thinker-cache>\` comes from the same cache.
`;

const TOML_START = '# thinker:start (managed by thinker, do not edit)';
const TOML_END = '# thinker:end';
const tomlStr = s => JSON.stringify(String(s));
function stripTomlBlock(text) {
  const a = text.indexOf(TOML_START); if (a < 0) return text;
  const b = text.indexOf(TOML_END, a);
  return (text.slice(0, a) + (b < 0 ? '' : text.slice(b + TOML_END.length))).replace(/\n{3,}/g, '\n\n');
}

// Keep generated, machine-specific files out of commits unless the team wants them shared.
function excludeLocally(repo, entries) {
  try {
    const dir = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const file = path.join(path.resolve(repo, dir), 'info', 'exclude');
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const add = entries.filter(e => !cur.split('\n').includes(e));
    if (!add.length) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + add.join('\n') + '\n');
  } catch {}
}

const isOurs = h => JSON.stringify(h).includes('thinker');

// --- other installs of thinker wired into the same checkout ---------------------------------
// A hook runs `node "<install>/src/cli.js" hook …` and an MCP entry `node <install>/src/mcp.js`:
// the script names the copy of thinker it runs. Two copies wired into one checkout (an old
// install left behind, a smoke-test copy, a shared and a local Claude settings file) both fire on
// every prompt: notes served twice, the old copy's notice and state format back again.
const scriptOf = cmd => { const m = String(cmd || '').match(/^(?:\w+=\S*\s+)*node (?:"([^"]+)"|'([^']+)'|(\S+))(?:\s|$)/); return m ? (m[1] || m[2] || m[3]) : null; }; // env prefixes (THINKER_LOG=local node …) are allowed
const hookScript = group => scriptOf((group?.hooks ? group.hooks[0] : group)?.command);
const mcpScript = entry => entry?.command === 'node' ? (entry.args || []).map(String).find(a => /mcp\.js$/.test(a)) || null : null; // a hand-written entry (`thinker serve`) is not touched
const installRoot = script => path.resolve(path.dirname(script), '..');
function installInfo(script) {
  const root = installRoot(script);
  let version = null;
  try { version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || null; } catch {}
  return { root, version, exists: fs.existsSync(script) };
}
export function compareVersions(a, b) {
  const A = String(a || '0').split(/[.-]/).map(Number), B = String(b || '0').split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(A.length, B.length); i++) { const d = (A[i] || 0) - (B[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}
function codexTomlBlock(mcpEntry) {
  const env = Object.entries(mcpEntry.env || {});
  return [TOML_START, '[mcp_servers.thinker]', `command = ${tomlStr(mcpEntry.command)}`, `args = [${mcpEntry.args.map(tomlStr).join(', ')}]`, 'default_tools_approval_mode = "approve"',
    ...(env.length ? ['', '[mcp_servers.thinker.env]', ...env.map(([k, v]) => `${k} = ${tomlStr(v)}`)] : []), TOML_END].join('\n');
}
const EXTENSIONS = { pi: '.pi/extensions/thinker.js', opencode: '.opencode/plugins/thinker.js' };
const GENERATED_MARK = '// thinker integration: ';
// Pi, Windsurf, Copilot and OpenCode are wired into the checkout alone (an extension file, a rule
// file): nothing of theirs is machine-wide, so they take no part in scope `user` below.
const HOOK_FILES = { windsurf: ['.windsurf/hooks.json', '.devin/hooks.json'], copilot: ['.github/hooks/thinker.json'] };
const RULE_FILES = { windsurf: ['.windsurf/rules/thinker.md', '.devin/rules/thinker.md'], copilot: ['.github/instructions/thinker.instructions.md'] };
export const USER_SCOPE_CLIENTS = ['claude', 'codex', 'cursor', 'gemini'];

// --- where each client reads its wiring ----------------------------------------------------------
// Two scopes. `user` is the agent's own files, read in every checkout: ~/.claude/settings.json and
// ~/.claude.json, ~/.codex/hooks.json and config.toml, ~/.gemini/settings.json, ~/.cursor/hooks.json
// and mcp.json. `thinker connect` (and `setup`, and the installer) wires thinker there once per
// machine, so every checkout sees the hooks and the MCP server, and so do the desktop apps that read
// no project files (Codex Desktop, openai/codex#13025); where a checkout is not set up they do
// nothing. A hook at user scope names no --repo (it reads the checkout from the agent's input) and
// the MCP entry pins no THINKER_REPO (the server takes the repository from its working directory,
// or from the `repo` argument of a call). `repo` is the checkout's own files: what `setup` wrote
// until 2026-10-04, including legacy committed wiring.
export const SCOPES = ['repo', 'user'];
const codexHome = () => process.env.CODEX_HOME || home('.codex');
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || home('.claude');
export function wiringFiles(client, { scope = 'repo', repo } = {}) {
  const user = scope === 'user';
  const at = (...p) => path.join(repo, ...p);
  switch (client) {
    // Claude Code runs the hooks of both settings files; thinker's live in one of them (`shared` picks the committed one)
    case 'claude': return user
      ? { local: path.join(claudeDir(), 'settings.json'), shared: null, mcp: process.env.CLAUDE_CONFIG_DIR ? path.join(claudeDir(), '.claude.json') : home('.claude.json') }
      : { local: at('.claude', 'settings.local.json'), shared: at('.claude', 'settings.json'), mcp: at('.mcp.json') };
    case 'codex': return user ? { hooks: path.join(codexHome(), 'hooks.json'), toml: path.join(codexHome(), 'config.toml') } : { hooks: at('.codex', 'hooks.json'), toml: at('.codex', 'config.toml') };
    case 'gemini': return { settings: user ? home('.gemini', 'settings.json') : at('.gemini', 'settings.json') };
    case 'cursor': return user
      ? { hooks: home('.cursor', 'hooks.json'), mcp: home('.cursor', 'mcp.json'), rule: null }
      : { hooks: at('.cursor', 'hooks.json'), mcp: at('.cursor', 'mcp.json'), rule: at('.cursor', 'rules', 'thinker.mdc') };
    default: return {};
  }
}
// the JSON files of a client that hold hook groups or an MCP entry
function jsonWiring(client, o) {
  const f = wiringFiles(client, o);
  if (client === 'claude') return [{ file: f.local, hooks: true }, ...(f.shared ? [{ file: f.shared, hooks: true }] : []), { file: f.mcp, mcp: true }];
  if (client === 'codex') return [{ file: f.hooks, hooks: true }];
  if (client === 'gemini') return [{ file: f.settings, hooks: true, mcp: true }];
  if (client === 'cursor') return [{ file: f.hooks, hooks: true, keepVersion: true }, { file: f.mcp, mcp: true }];
  return [];
}
const allWiring = (o, clients = CLIENTS) => [...new Set(clients.flatMap(c => {
  const f = wiringFiles(c, o);
  const extra = o.scope === 'repo' ? [...(EXTENSIONS[c] ? [EXTENSIONS[c]] : []), ...(HOOK_FILES[c] || []), ...(RULE_FILES[c] || [])].map(x => path.join(o.repo, x)) : [];
  return [...jsonWiring(c, o).map(e => e.file), ...(c === 'codex' ? [f.toml] : []), ...(c === 'cursor' && f.rule ? [f.rule] : []), ...extra];
}))];
// how a file is named to the user: relative to the checkout, or under ~
const label = (file, { scope, repo }) => scope === 'user' ? file.replace(os.homedir(), '~') : path.relative(repo, file);
// a checkout file this machine wrote for itself, as against one the team commits
function isLocalFile(client, file, repo) {
  const f = wiringFiles(client, { repo });
  if (client === 'claude') return file === f.local;
  return excludedLocally(repo, path.relative(repo, file));
}

// --- keeping the wiring in step with the installed copy -------------------------------------------
// The hook and MCP entries are written once, by `thinker setup` or `connect`, in the shape that
// version knew. A later version may add an event (SessionEnd for the final distill of a session,
// say) or change a command, and nothing rewrote the entries: a checkout kept the old shape until
// setup was rerun. `refreshWiring` rewrites them from what is there. For each client it reads the
// options the wiring was installed with (inferWiring: whether hooks, late notes, learning, the MCP
// entry, and which Claude settings file), and reinstalls them for `cli` when the entries point at
// this copy (by the script's install root). Entries that point at another copy are left alone,
// whether it is alive (a development checkout, say) or gone (a deleted worktree: the benchmark
// checkouts here pointed at one, and rewriting them would have given them live hooks; the prompt
// hook's prune takes a gone copy's entries out), and so is a hand-tuned command (an env prefix, a
// --budget: what a benchmark arm writes). `thinker rewire` runs it for the user's files and every
// repository on the machine, `thinker update` after an update, and the prompt hook for its own
// checkout and the user's files.
const HOOK_COMMAND = /^node "[^"]+" hook (prompt|tool|stop)(?: --client \w+)?(?: --user)?(?: --repo "[^"]+")?(?: --late)?(?: --record)?(?: --no-distill)?$/;
const readJsonOr = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const ourGroups = (hooks, ev) => (hooks?.[ev] || []).filter(isOurs);
const commandOf = g => (g?.hooks ? g.hooks[0] : g)?.command;
const codexMcpScript = text => { const a = text.indexOf(TOML_START), b = a < 0 ? -1 : text.indexOf(TOML_END, a); if (a < 0 || b < 0) return null; const m = text.slice(a, b).match(/^args = \[(.*)\]$/m); try { return m ? JSON.parse(`[${m[1]}]`).map(String).find(x => /mcp\.js$/.test(x)) || null : null; } catch { return null; } };

// What one client's files say about how thinker was wired in, at `scope`: null when it was not.
// `scripts` are the thinker scripts the entries run; `custom` names a command the installer
// would not have written as it stands.
const hasLearningStop = (hooks, events) => events.some(event => ourGroups(hooks, event).some(group => !/ --no-distill\b/.test(commandOf(group) || '')));

export function inferWiring(repo, client, { scope = 'repo' } = {}) {
  const f = wiringFiles(client, { scope, repo });
  const scripts = new Set(), hookScripts = new Set(), custom = [];
  const see = g => { const c = commandOf(g); const sc = scriptOf(c); if (sc) { scripts.add(sc); hookScripts.add(sc); } if (c && !HOOK_COMMAND.test(String(c))) custom.push(String(c)); };
  const local = file => scope === 'repo' && excludedLocally(repo, path.relative(repo, file));
  const w = { hooks: false, learn: false, late: false, shared: false, mcp: false };
  if (client === 'claude') {
    for (const [file, shared] of [[f.local, false], [f.shared, true]]) {
      if (!file) continue;
      const hooks = readJsonOr(file, {}).hooks;
      if (!ourGroups(hooks, 'UserPromptSubmit').length) continue;
      w.hooks = true; w.shared = shared; w.learn = hasLearningStop(hooks, ['Stop', 'SessionEnd']); w.late = ourGroups(hooks, 'PostToolUse').length > 0;
      for (const ev of ['UserPromptSubmit', 'Stop', 'SessionEnd', 'PostToolUse']) ourGroups(hooks, ev).forEach(see);
      break;
    }
    const mcp = readJsonOr(f.mcp, {}).mcpServers?.thinker;
    if (mcp) { w.mcp = true; const sc = mcpScript(mcp); if (sc) scripts.add(sc); }
  }
  if (client === 'codex') {
    const hooks = readJsonOr(f.hooks, {}).hooks;
    if (ourGroups(hooks, 'UserPromptSubmit').length) {
      w.hooks = true; w.learn = hasLearningStop(hooks, ['Stop']);
      w.late = ourGroups(hooks, 'PostToolUse').some(g => / --late\b/.test(commandOf(g) || ''));
      for (const ev of ['UserPromptSubmit', 'PostToolUse', 'Stop']) ourGroups(hooks, ev).forEach(see);
    }
    const sc = codexMcpScript(readText(f.toml));
    if (sc) { w.mcp = true; scripts.add(sc); }
    w.shared = scope === 'repo' && !local(f.hooks);
  }
  if (client === 'gemini') {
    const cfg = readJsonOr(f.settings, {});
    if (ourGroups(cfg.hooks, 'BeforeAgent').length) {
      w.hooks = true; w.learn = hasLearningStop(cfg.hooks, ['AfterAgent']);
      w.late = ourGroups(cfg.hooks, 'AfterTool').some(g => / --late\b/.test(commandOf(g) || ''));
      for (const ev of ['BeforeAgent', 'AfterTool', 'AfterAgent']) ourGroups(cfg.hooks, ev).forEach(see);
    }
    if (cfg.mcpServers?.thinker) { w.mcp = true; const sc = mcpScript(cfg.mcpServers.thinker); if (sc) scripts.add(sc); }
    w.shared = scope === 'repo' && !local(f.settings);
  }
  if (client === 'cursor') {
    const hooks = readJsonOr(f.hooks, {}).hooks;
    if (ourGroups(hooks, 'beforeSubmitPrompt').length) {
      w.hooks = true; w.learn = hasLearningStop(hooks, ['stop', 'sessionEnd']);
      w.late = ourGroups(hooks, 'postToolUse').some(g => / --late\b/.test(commandOf(g) || ''));
      for (const ev of ['beforeSubmitPrompt', 'postToolUse', 'afterShellExecution', 'stop', 'sessionEnd']) ourGroups(hooks, ev).forEach(see);
    }
    const mcp = readJsonOr(f.mcp, {}).mcpServers?.thinker;
    if (mcp) { w.mcp = true; const sc = mcpScript(mcp); if (sc) scripts.add(sc); }
    w.shared = scope === 'repo' && !local(f.hooks) && !local(f.mcp);
  }
  if (EXTENSIONS[client]) {
    if (scope !== 'repo') return null;
    const text = readText(path.join(repo, EXTENSIONS[client]));
    if (!text.startsWith(GENERATED_MARK)) return null;
    try {
      const cfg = JSON.parse(text.split('\n')[0].slice(GENERATED_MARK.length));
      Object.assign(w, cfg); scripts.add(cfg.cli); hookScripts.add(cfg.cli);
      if (text !== extensionText(cfg)) custom.push('modified thinker extension');
    } catch { return null; }
  }
  if (client === 'windsurf' || client === 'copilot') {
    if (scope !== 'repo') return null;
    for (const f of HOOK_FILES[client]) {
      const h = readJsonOr(path.join(repo, f), {}).hooks || {};
      for (const groups of Object.values(h)) for (const g of groups.filter(isOurs)) {
        see(g); const cmd = commandOf(g) || '';
        w.hooks = true; w.learn ||= cmd.includes(' --record'); w.late ||= cmd.includes(' --late');
      }
    }
    w.shared = HOOK_FILES[client].every(f => !excludedLocally(repo, f));
    // Windsurf's always-on CLI rule is the retrieval route (no global MCP mutation).
    w.mcp = RULE_FILES[client].some(f => readText(path.join(repo, f)).includes('<!-- thinker -->'));
    if (w.mcp && !scripts.size) custom.push('rule-only integration; rerun setup to refresh');
  }
  if (!w.hooks && !w.mcp) return null;
  return { ...w, scripts: [...scripts], hookScripts: [...hookScripts], custom };
}
function excludedLocally(repo, entry) {
  try {
    const dir = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return readText(path.join(path.resolve(repo, dir), 'info', 'exclude')).split('\n').includes(entry);
  } catch { return false; }
}
const gitHooksOurs = repo => { try { const f = gitHookPath(repo, 'pre-commit'); const t = f ? readText(f) : ''; return t.includes('# thinker:') ? (t.match(/node '([^']+)'/) || [])[1] || null : null; } catch { return null; } };
const sameCopy = (a, b) => real(installRoot(a)) === real(installRoot(b));

// Whether the checkout's own files run thinker hooks for `client`, of any copy: set up before the
// wiring went machine-wide, with --shared, or a benchmark arm wired to a checkout of its own. The
// hook at user scope then yields to them, so a checkout's wiring is the only one that fires there.
export function repoRunsHooks(repo, client) {
  const w = inferWiring(repo, client);
  return !!(w && w.hooks);
}

// The machine-wide wiring, from the checkouts: for each agent that no user-level file wires yet
// but whose hooks in one of `repos` run this copy (a machine set up before the wiring went
// machine-wide), install the user-level entries with the options those checkouts were set up
// with (any of them learning, late notes or the MCP server: all of them). `thinker update` runs
// this through `rewire`, so an existing user gets the wiring without a step; the checkouts switch
// to it on their next prompt (`stripRepoWiring`). Codex's user hooks are marked reviewed: the
// user accepted the same hooks when setting the checkout up. Returns [{client, from, options}].
export function connectFromCheckouts(repos, { cli, mcpEntry, dry = false } = {}) {
  const done = [];
  for (const client of USER_SCOPE_CLIENTS) {
    if (inferWiring(null, client, { scope: 'user' })) continue;
    const options = { hooks: false, learn: false, late: false, mcp: false };
    let from = 0;
    for (const r of repos) {
      let w = null; try { w = inferWiring(r, client); } catch { continue; }
      if (!w || !w.hooks || !w.hookScripts.length || !w.hookScripts.every(sc => sameCopy(sc, cli))) continue;
      from++; for (const k of Object.keys(options)) options[k] ||= !!w[k];
    }
    if (!from) continue;
    if (!dry) { installClient(client, { scope: 'user', cli, mcpEntry, ...options }); if (client === 'codex') trustCodexUser(); }
    done.push({ client, from, options });
  }
  return done;
}

// Rewrite the wiring of one checkout (scope 'repo') or of the user's files (scope 'user', `repo`
// unused) for the copy of thinker at `cli`. Returns what changed:
// { changed: ['.claude/settings.local.json', …], skipped: [{client, reason}], clients: [...] }.
// With `dry` nothing is written. `mcpEntry` is this copy's MCP entry for the scope.
export function refreshWiring(repo, { cli, mcpEntry, dry = false, clients = CLIENTS, scope = 'repo' } = {}) {
  const o = { scope, repo };
  const ours = script => !script || sameCopy(script, cli);
  const where = scripts => [...new Set(scripts.filter(s => !ours(s)).map(s => `${installRoot(s)}${fs.existsSync(s) ? '' : ', no longer there'}`))].join('; ');
  const files = [...allWiring(o, clients), ...(scope === 'repo' ? HOOKS.map(h => gitHookPath(repo, h)).filter(Boolean) : [])];
  const snapshot = () => Object.fromEntries(files.map(f => [f, fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null]));
  const before = snapshot();
  const r = { changed: [], skipped: [], clients: [] };
  try {
    for (const client of clients) {
      const w = inferWiring(repo, client, { scope });
      if (!w) continue;
      if (!w.scripts.every(ours)) { r.skipped.push({ client, reason: `wired to another copy of thinker (${where(w.scripts)})` }); continue; }
      if (w.custom.length) { r.skipped.push({ client, reason: `a hook command was written by hand: ${w.custom[0]}` }); continue; }
      installClient(client, { scope, repo, cli, mcpEntry, hooks: w.hooks, learn: w.learn, late: w.late, shared: w.shared, mcp: w.mcp });
      r.clients.push(client);
    }
    if (scope === 'repo') {
      const gitCli = gitHooksOurs(repo);
      if (gitCli && ours(gitCli)) {
        const learn = /maintain/.test(readText(gitHookPath(repo, 'post-commit')));
        installGitHooks(repo, cli, learn);
      } else if (gitCli) r.skipped.push({ client: 'git', reason: `git hooks run another copy of thinker (${where([gitCli])})` });
    }
  } finally {
    const after = snapshot();
    for (const f of files) if (before[f] !== after[f]) r.changed.push(label(f, o));
    if (dry) for (const f of files) { if (before[f] === after[f]) continue; if (before[f] === null) fs.rmSync(f, { force: true }); else fs.writeFileSync(f, before[f]); }
  }
  // Codex keeps a hash of each reviewed hook: a rewritten hook needs its hash again, where the hooks were trusted before
  if (!dry && r.clients.includes('codex')) {
    const hooksFile = wiringFiles('codex', o).hooks;
    if (r.changed.includes(label(hooksFile, o))) {
      if (scope === 'repo' && readText(codexConfig()).includes(`[projects.${tomlStr(real(repo))}]`)) trustCodex(repo);
      if (scope === 'user' && readText(codexConfig()).includes(trustPrefix(hooksFile))) trustCodexUser();
    }
  }
  return r;
}

// Take thinker entries out of a client's files: those `take` names (by the script they run; it
// returns the install to record, or null to keep the entry). `mcpEntry` replaces a taken MCP entry,
// else it goes. `localOnly` touches only files the checkout keeps for itself.
// Returns what was done: [{ file, root, version, what: 'hooks' | 'mcp' }].
function pruneEntries(repo, { scope = 'repo', clients = CLIENTS, mcpEntry, take, localOnly = false }) {
  const o = { scope, repo };
  const done = [];
  const record = (file, other, what) => done.push({ file: label(file, o), root: other.root, version: other.version, what });
  const seen = new Set();
  for (const client of clients) for (const e of jsonWiring(client, o)) {
    if (seen.has(e.file)) continue; seen.add(e.file);
    if (localOnly && !isLocalFile(client, e.file, repo)) continue;
    if (!fs.existsSync(e.file)) continue;
    let cur; try { cur = JSON.parse(fs.readFileSync(e.file, 'utf8')); } catch { continue; }
    let next = cur, changed = false;
    if (e.hooks && cur.hooks && typeof cur.hooks === 'object') {
      const hooks = { ...cur.hooks };
      for (const ev of Object.keys(hooks)) {
        if (!Array.isArray(hooks[ev])) continue;
        const kept = hooks[ev].filter(g => { if (!isOurs(g)) return true; const t = take(hookScript(g)); if (t) { record(e.file, t, 'hooks'); return false; } return true; });
        if (kept.length !== hooks[ev].length) { changed = true; if (kept.length) hooks[ev] = kept; else delete hooks[ev]; }
      }
      if (changed) { next = { ...next, hooks }; if (!Object.keys(hooks).length) delete next.hooks; }
    }
    if (e.mcp && cur.mcpServers?.thinker) {
      const t = take(mcpScript(cur.mcpServers.thinker));
      if (t) {
        record(e.file, t, 'mcp'); changed = true;
        const m = { ...next.mcpServers };
        if (mcpEntry) m.thinker = mcpEntry; else delete m.thinker;
        next = { ...next, mcpServers: m }; if (!Object.keys(m).length) delete next.mcpServers;
      }
    }
    if (!changed) continue;
    if (Object.keys(next).filter(k => !(e.keepVersion && k === 'version')).length) fs.writeFileSync(e.file, JSON.stringify(next, null, 2) + '\n');
    else fs.unlinkSync(e.file);
  }
  if (clients.includes('codex')) {
    const file = wiringFiles('codex', o).toml;
    if (!localOnly || isLocalFile('codex', file, repo)) {
      const cur = readText(file);
      const a = cur.indexOf(TOML_START), b = a < 0 ? -1 : cur.indexOf(TOML_END, a);
      if (a >= 0 && b >= 0) {
        const t = take(codexMcpScript(cur));
        if (t) {
          record(file, t, 'mcp');
          const rest = stripTomlBlock(cur);
          if (mcpEntry) fs.writeFileSync(file, (rest.trim() ? rest.trimEnd() + '\n\n' : '') + codexTomlBlock(mcpEntry) + '\n');
          else if (rest.trim()) fs.writeFileSync(file, rest); else fs.unlinkSync(file);
        }
      }
    }
  }
  return done;
}

// Take the entries of other copies of thinker out of a checkout's client configuration (or, at
// scope 'user', the user's). `cli` is this copy's cli.js. Hooks of another copy are removed; an
// MCP entry of another copy is pointed at this one (`mcpEntry`) or removed. By default every other
// copy goes (an install is explicit: one copy per checkout); with `olderOnly`, only copies that
// are gone or older by their package.json than this one, so that at prompt time two copies of one
// version do not take each other out, and a newer copy is left to do the cleaning.
export function pruneInstalls(repo, { cli, mcpEntry, olderOnly = false, clients = CLIENTS, scope = 'repo' } = {}) {
  const mine = installInfo(cli);
  const mineRoots = [mine.root, mcpEntry && mcpScript(mcpEntry) ? installRoot(mcpScript(mcpEntry)) : null].filter(Boolean).map(real);
  const foreign = script => {
    if (!script) return null;
    const other = installInfo(script);
    if (mineRoots.includes(real(other.root))) return null;
    if (olderOnly && other.exists && compareVersions(other.version, mine.version) >= 0) return null;
    return other;
  };
  return pruneEntries(repo, { scope, clients, mcpEntry, take: foreign });
}
export function prunedLines(done) {
  const by = new Map();
  for (const d of done) { const k = `${d.version || 'unknown version'}|${d.root}`; (by.get(k) || by.set(k, new Set()).get(k)).add(d.file); }
  return [...by.entries()].map(([k, files]) => { const [v, root] = k.split('|'); return `removed the entries of another thinker install (${v === 'unknown version' ? 'no longer there' : `version ${v}`}, ${root}) from ${[...files].join(', ')}`; });
}

// Take this copy's own entries out of the files a checkout keeps for itself, once the user's
// files carry them: the checkout was set up before the wiring went machine-wide. Committed files
// (--shared, .mcp.json) are left to the team. Returns the files touched.
export function stripRepoWiring(repo, { cli, clients = CLIENTS } = {}) {
  const done = pruneEntries(repo, { scope: 'repo', clients, localOnly: true, take: script => script && sameCopy(script, cli) ? installInfo(script) : null });
  if (clients.includes('codex') && !fs.existsSync(wiringFiles('codex', { repo }).hooks)) untrustCodexHooks(wiringFiles('codex', { repo }).hooks);
  return [...new Set(done.map(d => d.file))];
}

// Codex keeps what the user has trusted in its own config.toml (CODEX_HOME, ~/.codex): a project,
// before it reads the project's .codex/, and each hook by a hash of its definition. The user's
// own hooks.json needs the hashes too.
const codexConfig = () => path.join(codexHome(), 'config.toml');
const real = f => { try { return fs.realpathSync(f); } catch { return f; } };
const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
function dropTomlTables(text, drop) {
  const kept = []; let skip = false;
  for (const l of text.split('\n')) {
    if (/^\s*\[/.test(l)) skip = drop(l.trim());
    if (!skip) kept.push(l);
  }
  return kept.join('\n');
}
const setTomlTable = (text, header, lines) => {
  const rest = dropTomlTables(text, h => h === header).trimEnd();
  return (rest ? rest + '\n\n' : '') + [header, ...lines].join('\n') + '\n';
};
// The hash Codex 0.157 stores for a reviewed hook: sha256 of the event and the handler, keys in order
export function codexHookHash(event, h) {
  const handler = { async: !!h.async, command: h.command, ...(h.timeout === undefined ? {} : { timeout: h.timeout }), type: h.type };
  return 'sha256:' + createHash('sha256').update(JSON.stringify({ event_name: event, hooks: [handler] })).digest('hex');
}
const snake = ev => ev.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
const trustPrefix = hooksFile => `[hooks.state.${tomlStr(real(hooksFile) + ':').slice(0, -1)}`;

// The hashes of thinker's hooks in `hooksFile` (a checkout's, with --repo `root`, or the user's),
// written into `text`. Only exact hook commands this copy generates are marked.
function trustHooksIn(text, hooksFile, root) {
  let hooks = {}; try { hooks = JSON.parse(fs.readFileSync(hooksFile, 'utf8')).hooks || {}; } catch {}
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js');
  const repoPart = root ? ` --repo "${root}"` : ' --user';
  const defs = {
    UserPromptSubmit: [['prompt', 15, ['', ' --record']]],
    PostToolUse: [['tool', 10, ['', ' --late', ' --record', ' --late --record']]],
    Stop: [['stop', 10, ['', ' --record', ' --no-distill']]],
  };
  const generated = (event, h) => h?.type === 'command' && (defs[event] || []).some(([what, timeout, suffixes]) =>
    h.timeout === timeout && suffixes.some(suffix => h.command === `node "${cli}" hook ${what} --client codex${repoPart}${suffix}`));
  let n = 0;
  for (const [ev, groups] of Object.entries(hooks)) (groups || []).forEach((g, gi) => (g.hooks || []).forEach((h, hi) => {
    if (g.matcher !== undefined || !generated(ev, h)) return;
    text = setTomlTable(text, `[hooks.state.${tomlStr(`${real(hooksFile)}:${snake(ev)}:${gi}:${hi}`)}]`, [`trusted_hash = ${tomlStr(codexHookHash(snake(ev), h))}`]);
    n++;
  }));
  return { text, n };
}
// Mark the repo as trusted and thinker's hooks in it as reviewed. Returns lines describing what was done.
export function trustCodex(repo) {
  const file = codexConfig();
  const root = real(repo);
  const { text, n } = trustHooksIn(setTomlTable(readText(file), `[projects.${tomlStr(root)}]`, ['trust_level = "trusted"']), path.join(root, '.codex', 'hooks.json'), root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return [`Codex: marked this repository as trusted${n ? ` and thinker's ${n} hooks as reviewed` : ''} in ${file}`];
}
// Mark thinker's hooks in the user's own hooks.json as reviewed.
export function trustCodexUser() {
  const file = codexConfig();
  const { text, n } = trustHooksIn(readText(file), wiringFiles('codex', { scope: 'user' }).hooks, null);
  if (!n) return [];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return [`Codex: marked thinker's ${n} hooks as reviewed in ${file}`];
}
function untrustCodexHooks(hooksFile) {
  const file = codexConfig();
  const cur = readText(file); if (!cur) return;
  const prefix = trustPrefix(hooksFile);
  const next = dropTomlTables(cur, h => h.startsWith(prefix)).replace(/\n{3,}/g, '\n\n');
  if (next !== cur) fs.writeFileSync(file, next);
}
function setHooks(hooks, events, entries) {
  const next = { ...(hooks || {}) };
  for (const ev of events) { next[ev] = (next[ev] || []).filter(h => !isOurs(h)); if (!next[ev].length) delete next[ev]; }
  for (const [ev, entry] of entries) (next[ev] ||= []).push(entry);
  return next;
}

function extensionText(config) {
  const source = pathToFileURL(path.join(path.dirname(config.cli), 'integrations', `${config.client}.js`)).href;
  const factory = config.client === 'pi' ? 'piExtension' : 'opencodePlugin';
  return GENERATED_MARK + JSON.stringify(config) + '\n' +
    `import { ${factory} } from ${JSON.stringify(source)};\n` +
    (config.client === 'pi' ? `export default pi => piExtension(pi, ${JSON.stringify(config)});\n` : `export default opencodePlugin(${JSON.stringify(config)});\n`);
}

// Wire one client in: into the repo (scope 'repo') or the user's files (scope 'user'). Returns lines describing what was done.
//   opts: scope, repo, cli (path to cli.js), mcpEntry ({command,args,env}), hooks, learn, late, shared, mcp
export function installClient(client, { scope = 'repo', repo, cli, mcpEntry, hooks, learn, late, shared, mcp }) {
  const o = { scope, repo };
  const f = wiringFiles(client, o);
  // whatever another copy of thinker left in this client's files goes first: one copy per checkout
  const done = prunedLines(pruneInstalls(repo, { scope, cli, mcpEntry: mcp ? mcpEntry : undefined, clients: [client] }));
  // a hook at user scope says so (--user): the command is otherwise the same as a checkout's, and the
  // hook must know which it is. Claude Code's checkout hooks keep their bare form (the checkout is
  // the working directory), as every checkout wired before 2026-10-04 has them.
  const cmd = (what, extra = '') => scope === 'user' ? `node "${cli}" hook ${what} --client ${client} --user${extra}`
    : client === 'claude' ? `node "${cli}" hook ${what}${extra}` : `node "${cli}" hook ${what} --client ${client} --repo "${repo}"${extra}`;
  const rel = file => label(file, o);
  const rec = learn ? ' --record' : '';
  const stopFlags = learn ? rec : ' --no-distill';
  const learned = learn ? ', sessions distilled into new notes when they end' : '';
  const localFiles = files => { if (scope === 'repo' && !shared && files.length) excludeLocally(repo, files.map(x => path.relative(repo, x))); };

  if (!USER_SCOPE_CLIENTS.includes(client) && scope !== 'repo') return done;
  if (EXTENSIONS[client] && (hooks || mcp)) {
    const file = path.join(repo, EXTENSIONS[client]);
    const before = readText(file);
    if (before && !before.startsWith(GENERATED_MARK)) throw new Error(`Refusing to overwrite ${EXTENSIONS[client]}: not a generated thinker extension`);
    const config = { client, repo, cli, hooks: !!hooks, learn: !!learn, late: !!late, shared: !!shared, mcp: !!mcp, mcpEntry };
    const text = extensionText(config);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (before !== text) fs.writeFileSync(file, text);
    if (!shared) excludeLocally(repo, [EXTENSIONS[client]]);
    done.push(`${client}: installed ${EXTENSIONS[client]}${client === 'pi' && mcp ? '; follow-up retrieval uses the CLI (no MCP dependency)' : ''}`);
  }
  if (client === 'windsurf' || client === 'copilot') {
    const generated = [];
    if (hooks) {
      const wind = client === 'windsurf';
      const file = wind && Object.keys(readJsonOr(path.join(repo, '.devin/hooks.json'), {}).hooks || {}).length ? '.devin/hooks.json' : HOOK_FILES[client][0];
      const prompt = wind ? 'pre_user_prompt' : 'userPromptSubmitted';
      const tools = wind ? ['post_read_code', 'post_write_code', 'post_run_command', 'post_mcp_tool_use'] : ['postToolUse', 'postToolUseFailure'];
      const stops = wind ? ['post_cascade_response'] : ['agentStop', 'sessionEnd'];
      const entry = (what, extra) => wind ? { command: cmd(what, extra), show_output: what === 'stop' } : { type: 'command', command: cmd(what, extra), timeoutSec: 15 };
      const entries = [[prompt, entry('prompt', rec)]];
      // Copilot delivers the parked prompt bundle on the first successful tool.
      if (learn || (!wind && (hooks || late))) for (const ev of tools) entries.push([ev, entry('tool', (!wind && late ? ' --late' : '') + rec)]);
      for (const ev of stops) entries.push([ev, entry('stop', stopFlags)]);
      mergeJson(path.join(repo, file), c => ({ ...(!wind ? { version: 1 } : {}), ...c, hooks: setHooks(c.hooks, [prompt, ...tools, ...stops], entries) }));
      generated.push(file);
      done.push(`${client}: hooks in ${file}${wind ? '; recording only, retrieval uses the always-on rule' : '; prompt notes delivered after the first tool result'}`);
    }
    if ((client === 'windsurf' && (hooks || mcp)) || (client === 'copilot' && mcp)) {
      const file = client === 'windsurf' ? (fs.existsSync(path.join(repo, '.devin/rules')) ? '.devin/rules/thinker.md' : '.windsurf/rules/thinker.md') : '.github/instructions/thinker.instructions.md';
      const front = client === 'windsurf' ? 'trigger: always_on' : 'applyTo: "**"';
      const text = `---\n${front}\n---\n<!-- thinker -->\n${guidance({ cli, repo })}\n`;
      const before = readText(path.join(repo, file));
      if (before && !before.includes('<!-- thinker -->')) throw new Error(`Refusing to overwrite ${file}`);
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      if (before !== text) fs.writeFileSync(path.join(repo, file), text);
      generated.push(file);
      done.push(`${client}: CLI retrieval guidance in ${file}; no global MCP configuration changed`);
    }
    if (client === 'copilot' && mcp) done.push('Copilot: automatic context via hooks; optional MCP can be added with /mcp add (user-level configuration)');
    if (!shared) excludeLocally(repo, generated);
  }

  if (client === 'claude') {
    if (mcp) { mergeJson(f.mcp, c => ({ ...c, mcpServers: { ...(c.mcpServers || {}), thinker: mcpEntry } })); done.push(`Claude Code: registered MCP server in ${rel(f.mcp)}`); }
    if (hooks) {
      const target = shared && f.shared ? f.shared : f.local;
      const entries = [['UserPromptSubmit', { matcher: '', hooks: [{ type: 'command', command: cmd('prompt'), timeout: 15 }] }]];
      if (late) entries.push(['PostToolUse', { matcher: 'Read|Bash|Grep|Edit|Write', hooks: [{ type: 'command', command: cmd('tool'), timeout: 10 }] }]);
      // Stop ends a turn and distills only a large backlog; SessionEnd distills what is left
      entries.push(['Stop', { matcher: '', hooks: [{ type: 'command', command: cmd('stop', learn ? '' : ' --no-distill'), timeout: 10 }] }]);
      if (learn) entries.push(
        ['SessionEnd', { matcher: '', hooks: [{ type: 'command', command: cmd('stop'), timeout: 10 }] }]);
      mergeJson(target, c => ({ ...c, hooks: setHooks(c.hooks, ['UserPromptSubmit', 'Stop', 'SessionEnd', 'PostToolUse'], entries) }));
      // Claude Code runs both files: thinker's hooks live in one of them
      const other = target === f.local ? f.shared : f.local;
      if (other && stripThinkerHooks(other)) done.push(`Claude Code: removed thinker's hooks from ${rel(other)}; they are in ${rel(target)} now`);
      done.push(`Claude Code: hooks in ${rel(target)}: notes injected on each prompt${late ? ', file-keyed notes while working' : ''}${learned}`);
    }
  }

  if (client === 'codex') {
    const generated = [];
    if (mcp) {
      const cur0 = readText(f.toml), cur = stripTomlBlock(cur0), block = codexTomlBlock(mcpEntry);
      if (/^\[mcp_servers\.thinker\]/m.test(cur)) done.push(`Codex: ${rel(f.toml)} already defines mcp_servers.thinker; left as is`);
      else {
        // the block as it stands is left where it is: Codex's own tables (trusted hooks) may follow it
        if (!cur0.includes(block)) { fs.mkdirSync(path.dirname(f.toml), { recursive: true }); fs.writeFileSync(f.toml, (cur.trim() ? cur.trimEnd() + '\n\n' : '') + block + '\n'); }
        done.push(`Codex: registered MCP server in ${rel(f.toml)}`);
        generated.push(f.toml);
      }
    }
    if (hooks) {
      const entries = [['UserPromptSubmit', { hooks: [{ type: 'command', command: cmd('prompt', rec), timeout: 15 }] }]];
      if (late || learn) entries.push(['PostToolUse', { hooks: [{ type: 'command', command: cmd('tool', (late ? ' --late' : '') + rec), timeout: 10 }] }]);
      entries.push(['Stop', { hooks: [{ type: 'command', command: cmd('stop', stopFlags), timeout: 10 }] }]);
      mergeJson(f.hooks, c => ({ ...c, hooks: setHooks(c.hooks, ['UserPromptSubmit', 'PostToolUse', 'Stop'], entries) }));
      done.push(`Codex: hooks in ${rel(f.hooks)}: notes injected on each prompt${late ? ', file-keyed notes while working' : ''}${learned}`);
      generated.push(f.hooks);
    }
    localFiles(generated);
  }

  if (client === 'gemini') {
    if (mcp || hooks) mergeJson(f.settings, c => {
      const n = { ...c };
      if (mcp) n.mcpServers = { ...(c.mcpServers || {}), thinker: mcpEntry };
      if (hooks) {
        // Gemini CLI timeouts are in milliseconds
        const entries = [['BeforeAgent', { hooks: [{ name: 'thinker-prompt', type: 'command', command: cmd('prompt', rec), timeout: 15000 }] }]];
        if (late || learn) entries.push(['AfterTool', { hooks: [{ name: 'thinker-tool', type: 'command', command: cmd('tool', (late ? ' --late' : '') + rec), timeout: 10000 }] }]);
        entries.push(['AfterAgent', { hooks: [{ name: 'thinker-learn', type: 'command', command: cmd('stop', stopFlags), timeout: 10000 }] }]);
        n.hooks = setHooks(c.hooks, ['BeforeAgent', 'AfterTool', 'AfterAgent'], entries);
      }
      return n;
    });
    if (mcp) done.push(`Gemini CLI: registered MCP server in ${rel(f.settings)}`);
    if (hooks) done.push(`Gemini CLI: hooks in ${rel(f.settings)}: notes injected on each prompt${late ? ', file-keyed notes while working' : ''}${learned}`);
    if (mcp || hooks) localFiles([f.settings]);
  }

  if (client === 'cursor') {
    const generated = [];
    // Cursor cannot take context at prompt time, so MCP is the primary route when enabled.
    if (mcp) {
      mergeJson(f.mcp, c => ({ ...c, mcpServers: { ...(c.mcpServers || {}), thinker: mcpEntry } }));
      generated.push(f.mcp);
      if (f.rule) { installCursorRule(repo); generated.push(f.rule); }
      done.push(`Cursor: registered MCP server in ${rel(f.mcp)}${f.rule ? ` and added the rule ${rel(f.rule)}` : ''}`);
    }
    if (hooks) {
      const entries = [
        ['beforeSubmitPrompt', { command: cmd('prompt', rec), timeout: 15 }],
        ['postToolUse', { command: cmd('tool', (late ? ' --late' : '') + rec), timeout: 10 }],
      ];
      // the editor ends a turn with `stop`; the CLI (agent -p) fires only sessionEnd,
      // and reports shell output in afterShellExecution
      entries.push(['stop', { command: cmd('stop', stopFlags), timeout: 10 }], ['sessionEnd', { command: cmd('stop', stopFlags), timeout: 10 }]);
      if (learn) entries.push(['afterShellExecution', { command: cmd('tool', rec), timeout: 10 }]);
      mergeJson(f.hooks, c => ({ version: 1, ...c, hooks: setHooks(c.hooks, ['beforeSubmitPrompt', 'postToolUse', 'afterShellExecution', 'stop', 'sessionEnd'], entries) }));
      done.push(`Cursor: hooks in ${rel(f.hooks)}: notes for the request are delivered after the agent's first tool call${late ? ', then file-keyed notes while working' : ''}${learned}`);
      generated.push(f.hooks);
    }
    localFiles(generated);
  }
  return done;
}

// The always-applied rule that points Cursor's agent at the MCP tools: a checkout file, since
// Cursor keeps user rules in its settings, not in a file.
export function installCursorRule(repo) {
  const rule = wiringFiles('cursor', { repo }).rule;
  fs.mkdirSync(path.dirname(rule), { recursive: true });
  if (readText(rule) !== CURSOR_RULE) fs.writeFileSync(rule, CURSOR_RULE);
  return rule;
}

// Take thinker's hook entries (and, with `mcp`, its MCP entry) out of one JSON file; the file
// goes when nothing else is in it. Returns whether anything was removed.
function stripThinkerHooks(file, { keepVersion = false, mcp = false } = {}) {
  if (!fs.existsSync(file)) return false;
  const before = fs.readFileSync(file, 'utf8');
  mergeJson(file, c => {
    const hooks = { ...(c.hooks || {}) };
    for (const ev of Object.keys(hooks)) { hooks[ev] = (hooks[ev] || []).filter(h => !isOurs(h)); if (!hooks[ev].length) delete hooks[ev]; }
    const n = { ...c, hooks };
    if (!Object.keys(hooks).length) delete n.hooks;
    if (mcp && n.mcpServers?.thinker) { n.mcpServers = { ...n.mcpServers }; delete n.mcpServers.thinker; if (!Object.keys(n.mcpServers).length) delete n.mcpServers; }
    return n;
  });
  const after = fs.readFileSync(file, 'utf8');
  const left = JSON.parse(after);
  if (!Object.keys(left).filter(k => !(keepVersion && k === 'version')).length) fs.unlinkSync(file);
  return JSON.stringify(JSON.parse(before)) !== JSON.stringify(left);
}

// Remove everything installClient wrote, at one scope: the checkout's files, or the user's.
export function uninstallWiring({ scope = 'repo', repo } = {}) {
  const o = { scope, repo };
  const claude = wiringFiles('claude', o), codex = wiringFiles('codex', o), gemini = wiringFiles('gemini', o), cursor = wiringFiles('cursor', o);
  untrustCodexHooks(codex.hooks);
  if (scope === 'repo') {
    for (const f of [...HOOK_FILES.windsurf, ...HOOK_FILES.copilot]) stripThinkerHooks(path.join(repo, f), { keepVersion: true });
    for (const f of Object.values(EXTENSIONS)) if (readText(path.join(repo, f)).startsWith(GENERATED_MARK)) fs.unlinkSync(path.join(repo, f));
    for (const f of [...RULE_FILES.windsurf, ...RULE_FILES.copilot]) {
      const rule = path.join(repo, f);
      if (readText(rule).includes('<!-- thinker -->')) fs.unlinkSync(rule);
    }
  }
  const stripHooks = (file, keepVersion) => file && stripThinkerHooks(file, { keepVersion, mcp: true });
  for (const f of [claude.local, claude.shared, codex.hooks, gemini.settings]) stripHooks(f);
  stripHooks(cursor.hooks, true);
  for (const file of [claude.mcp, cursor.mcp]) {
    if (!fs.existsSync(file)) continue;
    mergeJson(file, c => { const m = { ...(c.mcpServers || {}) }; delete m.thinker; return { ...c, mcpServers: m }; });
    const left = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Object.keys(left).length === 1 && !Object.keys(left.mcpServers).length) fs.unlinkSync(file);
  }
  if (fs.existsSync(codex.toml)) { const t = stripTomlBlock(fs.readFileSync(codex.toml, 'utf8')); if (t.trim()) fs.writeFileSync(codex.toml, t); else fs.unlinkSync(codex.toml); }
  if (cursor.rule) fs.rmSync(cursor.rule, { force: true });
}
export const uninstallClients = repo => uninstallWiring({ scope: 'repo', repo });
