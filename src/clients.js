// Client adapters: how thinker is wired into each coding agent, and how hook
// input/output differs between them.
//
//   client   prompt-time injection            file-keyed (late) notes   MCP registration
//   claude   UserPromptSubmit, plain stdout   PostToolUse               .mcp.json
//   codex    UserPromptSubmit, plain stdout   PostToolUse               .codex/config.toml
//   gemini   BeforeAgent, JSON only           AfterTool                 .gemini/settings.json
//   cursor   beforeSubmitPrompt, JSON         postToolUse               .cursor/mcp.json
//            additional_context (undocumented; the interactive CLI reads it, 2026-10-15);
//            `agent -p` runs no prompt hook, so the first tool call orients from the
//            transcript; an always-applied rule points the agent at the MCP tools
//
// Pi/OpenCode use native extensions in integrations/; Windsurf records hooks
// and retrieves through a CLI rule; Copilot parks context until postToolUse.
//
//   droid    UserPromptSubmit, plain stdout   PostToolUse               ~/.factory/mcp.json
//   qwen     UserPromptSubmit, plain stdout   PostToolUse               ~/.qwen/settings.json
//   kiro     UserPromptSubmit, plain stdout   (output ignored)          ~/.kiro/settings/mcp.json
//            V3 engine's global hooks (~/.kiro/hooks/); V2 reads hooks only in a custom agent
//   cline    UserPromptSubmit, JSON            PostToolUse               cline_mcp_settings.json
//            contextModification; one executable per event in ~/Documents/Cline/Hooks; the CLI
//            gives a prompt hook no return channel (a bundle would wait for the first tool hook), and
//            fires it for its own [SYSTEM] nudges, not the person's prompt (3.0.73): notes on edits there
//   kilo     an OpenCode fork: the OpenCode plugin, loaded from ~/.config/kilo/plugin
//   augment  no prompt hook                    PostToolUse               ~/.augment/settings.json
//            Auggie runs scripts only: thinker writes .sh wrappers in ~/.augment/thinker
//   goose    hooks give the model nothing (stdout is a block decision): recording for learning
//            alone, notes through the MCP extension in config.yaml
//   vscode   Copilot in VS Code (Local harness) runs ~/.copilot/hooks with its own payloads
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
import { agentWorkflow, disabledTools } from './cache-guidance.js';
import { updateInstructions, hasInstructions } from './agent-instructions.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gitHookPath } from './store.js';
import { HOOKS, installGitHooks } from './git-hooks.js';
import { textOf } from './transcripts.js';
import { claudeCardDir, withCardDir, withoutCardDir, cardDirIn, CARD_ENV as CARD_LABEL } from './claude-card.js';

export const CLIENTS = ['claude', 'codex', 'cursor', 'gemini', 'pi', 'windsurf', 'copilot', 'opencode', 'droid', 'qwen', 'kiro', 'cline', 'kilo', 'augment', 'goose'];

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

// Clients that look installed on this machine (binary on PATH or a config directory); with `fallback`,
// Claude Code when none does, as the default to set up.
export function detectClients({ fallback = true } = {}) {
  const found = [];
  if (onPath('claude') || fs.existsSync(home('.claude'))) found.push('claude');
  if (onPath('codex') || fs.existsSync(home('.codex'))) found.push('codex');
  if (onPath('cursor') || onPath('cursor-agent') || onPath('agent') || fs.existsSync(home('.cursor'))) found.push('cursor');
  if (onPath('gemini') || onPath('agy') || fs.existsSync(home('.gemini'))) found.push('gemini');
  for (const [client, dir] of [['pi', '.pi'], ['windsurf', '.codeium/windsurf'], ['copilot', '.copilot'], ['opencode', '.config/opencode']]) {
    if (onPath(client) || fs.existsSync(home(dir))) found.push(client);
  }
  for (const [client, bins, dirs] of [['droid', ['droid'], [factoryDir()]], ['qwen', ['qwen'], [qwenDir()]], ['kiro', ['kiro-cli'], [kiroDir()]],
    ['cline', ['cline'], [home('.cline'), clineDocs()]], ['kilo', ['kilo'], [kiloDir()]], ['augment', ['auggie'], [augmentDir()]], ['goose', ['goose'], [gooseDir()]]]) {
    if (bins.some(onPath) || dirs.some(d => fs.existsSync(d))) found.push(client);
  }
  return found.length || !fallback ? found : ['claude'];
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

// Which client is calling a hook: the explicit flag wins, except that Cursor also runs
// the Claude Code hooks it imports from the Claude settings files, and those carry
// --client claude since the wiring went machine-wide: detect Cursor from the hook input
// (not the environment: Claude Code started in Cursor's terminal is still Claude Code).
// 2026-10-15: unguarded, every Cursor prompt was oriented twice and its turns counted twice.
// VS Code's Copilot (its Local harness) runs the Copilot CLI's hook files from ~/.copilot/hooks too, with
// payloads of its own and Claude Code's output: told apart by what only VS Code's carry, a transcript_path
// and a PascalCase event name (UserPromptSubmit, PostToolUse; the Copilot CLI's are userPromptSubmitted, postToolUse).
export function hookClient(flag, ev = {}) {
  const named = flag && flag !== true ? String(flag) : 'claude';
  if (named === 'claude' && ev.cursor_version) return 'cursor-import';
  if (named === 'copilot' && ev.transcript_path && /^[A-Z]/.test(ev.hook_event_name || '') && ev.session_id && !ev.sessionId) return 'vscode';
  return named;
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
  if (client === 'cline') {
    // the extension names the event's fields under its key (userPromptSubmit, postToolUse); the CLI's SDK
    // sends snake_case names, tool_call and tool_result, and a sessionContext
    const up = ev.userPromptSubmit || {}, pt = ev.postToolUse || {};
    const name = String(ev.hookName || '');
    return { ...ev, session_id: ev.taskId || ev.sessionContext?.rootSessionId || ev.session_id, cwd: ev.workspaceRoots?.[0] || ev.workspaceInfo?.rootPath || ev.cwd,
      prompt: up.prompt ?? ev.prompt, tool_name: pt.toolName || ev.tool_call?.name, tool_input: pt.parameters || ev.tool_call?.input,
      tool_response: pt.result ?? ev.tool_result, hook_event_name: /^session_?shutdown$/i.test(name) ? 'SessionEnd' : name || undefined, cline_cli: !!ev.sessionContext };
  }
  if (client === 'augment') {
    const conv = ev.conversation || {};
    return { ...ev, session_id: ev.conversation_id || ev.session_id, cwd: ev.workspace_roots?.[0] || ev.cwd,
      tool_response: ev.tool_output ?? ev.tool_error, prompt: conv.userPrompt, last_assistant_message: conv.agentTextResponse ?? conv.agentResponse };
  }
  if (client === 'goose') return { ...ev, prompt: ev.message ?? ev.prompt, cwd: ev.working_dir || ev.cwd, hook_event_name: ev.event || ev.hook_event_name };
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
// Files named in a tool's result: search hits, listings, the paths a read printed. Repository files only, in the
// order seen, at most `max` of them (ops.js:onSightNotes serves understanding notes on the first sight of a file).
export function seenFiles(ev, repo, { max = 40 } = {}) {
  const text = textOf(ev.tool_response ?? ev.tool_output ?? ev.output).slice(0, 200_000);
  const out = new Set();
  for (const m of text.matchAll(/(?:^|[\s'"`=:(\[])(\/?(?:[\w.@-]+\/)+[\w.@-]+\.\w{1,5})(?=$|[\s'"`:|;)\],])/gm)) {
    let f = m[1].replace(/^\.\//, '');
    if (path.isAbsolute(f)) f = path.relative(repo, f);
    if (!f || f.startsWith('..') || out.has(f)) continue;
    if (fs.existsSync(path.join(repo, f))) out.add(f);
    if (out.size >= max) break;
  }
  return [...out];
}

// The same sighting, with the lines a search hit: `path:12:` or `path-12-` is a grep hit, a bare path a
// listing. Replaying real sessions (research/understanding-variants-2026-10, 2026-10-17), the agent's
// first read of a file lands a median of one tool call after the path first appears in a tool result,
// and that first appearance is nearly always search output rather than an open — so a sighting is worth
// acting on, but `rg --files` or `ls -R` names dozens of files at once. Hits with lines are returned
// first and take the budget first, and the lines say where in the file to look (ops.js:onSightOutlines).
export function seenHits(ev, repo, { max = 40 } = {}) {
  const text = textOf(ev.tool_response ?? ev.tool_output ?? ev.output).slice(0, 200_000);
  const out = new Map();
  const add = (raw, line) => {
    let f = raw.replace(/^\.\//, '');
    if (path.isAbsolute(f)) f = path.relative(repo, f);
    if (!f || f.startsWith('..')) return;
    if (!out.has(f)) {
      if (out.size >= max || !fs.existsSync(path.join(repo, f))) return;
      out.set(f, []);
    }
    if (line) out.get(f).push(line);
  };
  for (const m of text.matchAll(/(?:^|[\s'"`=([])(\/?(?:[\w.@-]+\/)+[\w.@-]+\.\w{1,5}):(\d+)[:-]/gm)) add(m[1], Number(m[2]));
  for (const m of text.matchAll(/(?:^|[\s'"`=:(\[])(\/?(?:[\w.@-]+\/)+[\w.@-]+\.\w{1,5})(?=$|[\s'"`:|;)\],])/gm)) add(m[1]);
  return [...out].map(([file, lines]) => ({ file, lines: [...new Set(lines)].sort((a, b) => a - b).slice(0, 20) }));
}

// The one identifier a tool searched for, when the search was for a bare name: the Grep tool's pattern,
// or the pattern of a `grep`/`rg` command. Null for a phrase, a regular expression or anything else; the
// on-sight outline only says where a name is defined when the table knows exactly one definition of it.
const BARE_IDENT = /^[A-Za-z_$][\w$]{2,}$/;
export function searchedIdentifier(ev) {
  const ti = ev.tool_input || {};
  const cand = [];
  if (/grep|search|glob/i.test(String(ev.tool_name || '')) && typeof ti.pattern === 'string') cand.push(ti.pattern);
  if (typeof ti.query === 'string') cand.push(ti.query);
  const command = typeof ti.command === 'string' ? ti.command : Array.isArray(ti.command) ? ti.command.join(' ') : typeof ev.command === 'string' ? ev.command : '';
  const m = /\b(?:rg|grep|ag|ack)\b(?:\s+-{1,2}[\w-]+)*\s+(?:-e\s+)?(['"]?)([A-Za-z_$][\w$]{2,})\1(?=\s|$)/.exec(command);
  if (m) cand.push(m[2]);
  for (const c of cand) { const s = c.replace(/^\\b/, '').replace(/\\b$/, '').trim(); if (BARE_IDENT.test(s)) return s; }
  return null;
}

// What the prompt hook prints: the bundle as context for the agent, and nothing for the
// user. A line at every prompt was noise; the stop hook names what the turn served once.
export function promptOutput(client, text) {
  if (client === 'windsurf' || client === 'goose') return '';
  if (client === 'cline') return JSON.stringify(text ? { cancel: false, contextModification: text } : { cancel: false });
  if (client === 'gemini') return JSON.stringify({ hookSpecificOutput: { hookEventName: 'BeforeAgent', additionalContext: text } });
  if (client === 'cursor') return JSON.stringify(text ? { continue: true, additional_context: text } : { continue: true });
  return text;
}
// Notices use each host's display API without requesting another model turn.
// Pi/OpenCode consume plain text in their native extensions; Windsurf shows stdout.
// Cursor and Copilot stop outputs only control continuation, not user notices.
export function stopOutput(client, notice) {
  if (!notice) return '';
  if (['claude', 'codex', 'gemini', 'qwen', 'augment', 'vscode'].includes(client)) return JSON.stringify({ systemMessage: notice });
  // Droid shows a stop hook's plain stdout in the transcript
  if (['pi', 'opencode', 'kilo', 'windsurf', 'droid'].includes(client)) return notice;
  return '';
}
export function toolOutput(client, text) {
  // Kiro ignores what a PostToolUse hook prints, Goose reads it as a decision
  if (client === 'windsurf' || client === 'kiro' || client === 'goose') return '';
  if (client === 'pi' || client === 'opencode' || client === 'kilo') return text;
  if (client === 'cline') return JSON.stringify({ cancel: false, contextModification: text });
  if (client === 'copilot') return JSON.stringify({ additionalContext: text });
  if (client === 'cursor') return JSON.stringify({ additional_context: text });
  return JSON.stringify({ hookSpecificOutput: { hookEventName: client === 'gemini' ? 'AfterTool' : 'PostToolUse', additionalContext: text } });
}

// Copilot: park the prompt-time bundle until the first tool call of the turn.
const pendingFile = (storeDir, session) => path.join(storeDir, 'state', `pending-${String(session).replace(/[^\w.-]/g, '_')}.json`);
export function parkPending(storeDir, session, text) {
  const f = pendingFile(storeDir, session);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ text, at: Date.now() }));
}
// Cursor: the turns whose context is settled, by its generation id
export const orientedFile = (storeDir, turn) => path.join(storeDir, 'state', `oriented-${String(turn).replace(/[^\w.-]/g, '_')}`);
export function takePending(storeDir, session) {
  const f = pendingFile(storeDir, session);
  try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); fs.unlinkSync(f); return Date.now() - j.at < 30 * 60_000 ? j.text : ''; } catch { return ''; }
}

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

const isOurs = h => {
  if (JSON.stringify(h).includes('thinker')) return true;
  // A checkout/container may be named /workspace or anything else. Identify the
  // installed package as well as legacy hooks whose old path no longer exists.
  const script = hookScript(h);
  if (!script || !/[/\\]src[/\\]cli\.js$/.test(script)) return false;
  try { return JSON.parse(fs.readFileSync(path.join(installRoot(script), 'package.json'), 'utf8')).name === 'thinker'; }
  catch { return false; }
};

// --- other installs of thinker wired into the same checkout ---------------------------------
// A hook runs `node "<install>/src/cli.js" hook …` and an MCP entry `node <install>/src/mcp.js`:
// the script names the copy of thinker it runs. Two copies wired into one checkout (an old
// install left behind, a smoke-test copy, a shared and a local Claude settings file) both fire on
// every prompt: notes served twice, the old copy's notice and state format back again.
const scriptOf = cmd => { const m = String(cmd || '').match(/^(?:\w+=\S*\s+)*node (?:"([^"]+)"|'([^']+)'|(\S+))(?:\s|$)/); return m ? (m[1] || m[2] || m[3]) : null; }; // env prefixes (THINKER_LOG=local node …) are allowed
const hookScript = group => scriptOf(realCommand((group?.hooks ? group.hooks[0] : group)?.command));
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
// An MCP entry as each client's file takes it: Copilot's names its type and the tools it may call
const mcpServerEntry = (client, e) => {
  if (client === 'copilot') return { type: 'local', command: e.command, args: e.args, env: e.env || {}, tools: ['*'] };
  if (client === 'droid') return { type: 'stdio', command: e.command, args: e.args, env: e.env || {} };
  if (client === 'kiro' || client === 'cline') return { command: e.command, args: e.args, env: e.env || {}, disabled: false };
  return e;
};
function codexTomlBlock(mcpEntry) {
  const env = Object.entries(mcpEntry.env || {});
  return [TOML_START, '[mcp_servers.thinker]', `command = ${tomlStr(mcpEntry.command)}`, `args = [${mcpEntry.args.map(tomlStr).join(', ')}]`, 'default_tools_approval_mode = "approve"',
    ...(env.length ? ['', '[mcp_servers.thinker.env]', ...env.map(([k, v]) => `${k} = ${tomlStr(v)}`)] : []), TOML_END].join('\n');
}
const EXTENSIONS = { pi: '.pi/extensions/thinker.js', opencode: '.opencode/plugins/thinker.js' };
const GENERATED_MARK = '// thinker integration: ';
// Pi, Windsurf, Copilot and OpenCode were wired into each checkout alone (an extension file, a rule
// file) until 2026-10-15, when they joined scope `user` below: with caches started on first use and no
// `thinker setup` per repository, a checkout nobody set up had no thinker at all for them. The checkout
// files stay for checkouts set up before (they move to the user's files on the next prompt, as the
// others' did) and for --shared.
const HOOK_FILES = { windsurf: ['.windsurf/hooks.json', '.devin/hooks.json'], copilot: ['.github/hooks/thinker.json'] };
const RULE_FILES = { windsurf: ['.windsurf/rules/thinker.md', '.devin/rules/thinker.md'], copilot: ['.github/instructions/thinker.instructions.md'] };
// Copilot CLI reads an MCP server from the checkout's .github/mcp.json (once the folder is trusted), as
// it reads its hooks from .github/hooks: thinker's server goes there, pinned to the checkout, kept out
// of git status as the hooks are. Until 2026-10-15 setup only said "/mcp add" and Copilot had no tools.
const MCP_FILES = { copilot: '.github/mcp.json' };
export const USER_SCOPE_CLIENTS = ['claude', 'codex', 'cursor', 'gemini', 'pi', 'opencode', 'copilot', 'windsurf', 'droid', 'qwen', 'kiro', 'cline', 'kilo', 'augment', 'goose'];

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
// pi's global extensions (~/.pi/agent/extensions), OpenCode's global plugins and rules
// (~/.config/opencode), Copilot CLI's user hooks, MCP servers and instructions (~/.copilot, or
// COPILOT_HOME), Windsurf's (Devin Desktop's) user hooks and global rules (~/.codeium/windsurf)
const piDir = () => process.env.PI_CODING_AGENT_DIR || home('.pi', 'agent');
const opencodeDir = () => path.join(process.env.XDG_CONFIG_HOME || home('.config'), 'opencode');
const copilotHome = () => process.env.COPILOT_HOME || home('.copilot');
const windsurfDir = () => home('.codeium', 'windsurf');
// Droid (~/.factory), Qwen Code (QWEN_HOME, ~/.qwen), Kiro CLI (~/.kiro), Cline (hooks and rules under
// ~/Documents/Cline, its data and MCP servers under ~/.cline/data), Kilo (an OpenCode fork, ~/.config/kilo),
// Auggie (~/.augment), Goose (~/.config/goose, and the Open Plugins directory ~/.agents/plugins for hooks)
const factoryDir = () => home('.factory');
const qwenDir = () => process.env.QWEN_HOME || home('.qwen');
const kiroDir = () => home('.kiro');
const clineDocs = () => home('Documents', 'Cline');
const clineData = () => process.env.CLINE_DATA_DIR || path.join(process.env.CLINE_DIR || home('.cline'), 'data');
const kiloDir = () => path.join(process.env.XDG_CONFIG_HOME || home('.config'), 'kilo');
const augmentDir = () => home('.augment');
const gooseDir = () => path.join(process.env.XDG_CONFIG_HOME || home('.config'), 'goose');
const goosePlugin = () => path.join(process.env.GOOSE_PATH_ROOT || os.homedir(), '.agents', 'plugins', 'thinker');
// Droid reads ~/.factory/hooks.json, or, when there is none, the `hooks` key of its settings.json (keyed by event at the top of hooks.json)
const droidHooks = () => { const f = path.join(factoryDir(), 'hooks.json'); return fs.existsSync(f) ? f : path.join(factoryDir(), 'settings.json'); };
const flatHooks = file => path.basename(file) === 'hooks.json' && path.dirname(file) === factoryDir();
// Cline's hooks: one executable per event, named after it; the CLI's names for the end of a session too
const CLINE_EVENTS = ['UserPromptSubmit', 'PostToolUse', 'TaskComplete', 'TaskCancel', 'SessionShutdown'];
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
    // the checkout files of these four are EXTENSIONS, HOOK_FILES, RULE_FILES and MCP_FILES
    case 'pi': return user ? { ext: path.join(piDir(), 'extensions', 'thinker.js') } : {};
    case 'opencode': return user ? { ext: path.join(opencodeDir(), 'plugins', 'thinker.js') } : {};
    case 'copilot': return user ? { hooks: path.join(copilotHome(), 'hooks', 'thinker.json'), mcp: path.join(copilotHome(), 'mcp-config.json') } : {};
    case 'windsurf': return user ? { hooks: path.join(windsurfDir(), 'hooks.json') } : {};
    case 'droid': return user ? { hooks: droidHooks(), mcp: path.join(factoryDir(), 'mcp.json') } : {};
    case 'qwen': return user ? { settings: path.join(qwenDir(), 'settings.json') } : {};
    case 'kiro': return user ? { hooks: path.join(kiroDir(), 'hooks', 'thinker.json'), mcp: path.join(kiroDir(), 'settings', 'mcp.json') } : {};
    case 'cline': return user ? { hookDir: path.join(clineDocs(), 'Hooks'), mcp: path.join(clineData(), 'settings', 'cline_mcp_settings.json') } : {};
    case 'kilo': return user ? { ext: path.join(kiloDir(), 'plugin', 'thinker.js') } : {};
    case 'augment': return user ? { settings: path.join(augmentDir(), 'settings.json'), scripts: path.join(augmentDir(), 'thinker') } : {};
    case 'goose': return user ? { hooks: path.join(goosePlugin(), 'hooks', 'hooks.json'), yaml: path.join(gooseDir(), 'config.yaml') } : {};
    default: return {};
  }
}
// Candidate files include Codex's override so refresh snapshots and uninstall cover
// both. Never create an override that would hide the user's existing AGENTS.md.
function instructionFiles(client, { scope = 'repo', repo } = {}) {
  const user = scope === 'user';
  if (client === 'claude') return [user ? path.join(claudeDir(), 'CLAUDE.md') : path.join(repo, 'CLAUDE.local.md')];
  if (client === 'codex') return ['AGENTS.override.md', 'AGENTS.md'].map(f => path.join(user ? codexHome() : repo, f));
  if (client === 'gemini') return [user ? home('.gemini', 'GEMINI.md') : path.join(repo, 'GEMINI.md')];
  if (client === 'opencode') return [user ? path.join(opencodeDir(), 'AGENTS.md') : path.join(repo, '.opencode/thinker.md')];
  if (client === 'copilot' && user) return [path.join(copilotHome(), 'copilot-instructions.md')];
  if (client === 'windsurf' && user) return [path.join(windsurfDir(), 'memories', 'global_rules.md')];
  if (!user) return [];
  if (client === 'droid') return [path.join(factoryDir(), 'AGENTS.md')];
  if (client === 'qwen') return [path.join(qwenDir(), 'QWEN.md')];
  // Kiro's steering files and Cline's and Auggie's rules are whole files: thinker writes one of its own
  if (client === 'kiro') return [path.join(kiroDir(), 'steering', 'thinker.md')];
  if (client === 'cline') return [path.join(clineDocs(), 'Rules', 'thinker.md')];
  if (client === 'kilo') return [path.join(kiloDir(), 'AGENTS.md')];
  if (client === 'augment') return [path.join(augmentDir(), 'rules', 'thinker.md')];
  if (client === 'goose') return [path.join(gooseDir(), '.goosehints')];
  return [];
}

// The hook groups of a Claude-shaped hooks file: under `hooks`, or the whole file (Droid's hooks.json)
const hooksIn = (cur, flat) => (flat ? cur : cur?.hooks) || {};
const withHooks = (cur, flat, hooks) => {
  if (flat) return hooks;
  const n = { ...cur, hooks }; if (!Object.keys(hooks).length) delete n.hooks; return n;
};
// A hook command written into a wrapper script (Auggie runs only scripts, Cline one executable per event):
// the command the script runs, else the command as it stands
const WRAPPER_MARK = '# thinker hook (managed by thinker)';
function realCommand(cmd) {
  const c = String(cmd || '');
  if (!/[/\\][\w.-]+$/.test(c) || /\s/.test(c.replace(/^"|"$/g, ''))) return c;
  const text = readText(c.replace(/^"|"$/g, ''));
  if (!text.includes(WRAPPER_MARK)) return c;
  const m = text.match(/^exec (.+)$/m);
  return m ? m[1].trim() : c;
}
const wrapperText = command => `#!/bin/sh\n${WRAPPER_MARK}; \`thinker uninstall --user\` removes it\nexec ${command}\n`;
function writeWrapper(file, command) {
  const text = wrapperText(command);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (readText(file) !== text) fs.writeFileSync(file, text);
  fs.chmodSync(file, 0o755);
}
const isWrapper = file => readText(file).includes(WRAPPER_MARK);

// Goose keeps its extensions (MCP servers) in config.yaml, which it rewrites itself: thinker's entry is
// the `thinker:` key under `extensions:`, found by its key and indentation rather than by comment markers.
// Goose also records each plugin it loaded under `plugins:`, by its directory (`<home>/.agents/plugins/thinker:`).
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function gooseBlock(text, section = 'extensions', key = 'thinker') {
  const GOOSE_KEY = new RegExp(`^(\\s+)['"]?${escapeRe(key)}['"]?:\\s*$`);
  const lines = text.split('\n');
  const ext = lines.findIndex(l => new RegExp(`^${section}:\\s*$`).test(l));
  if (ext < 0) return null;
  // the extensions are the keys at the first indentation under `extensions:`
  const child = (lines.slice(ext + 1).find(l => l.trim()) || '').match(/^\s*/)[0].length;
  for (let i = ext + 1; i < lines.length && (/^\s/.test(lines[i]) || !lines[i].trim()); i++) {
    const m = lines[i].match(GOOSE_KEY); if (!m || m[1].length !== child) continue;
    let end = i + 1;
    while (end < lines.length && (!lines[end].trim() || lines[end].match(/^\s*/)[0].length > m[1].length)) end++;
    while (end > i + 1 && !lines[end - 1].trim()) end--;
    return { lines, start: i, end, indent: m[1] };
  }
  return null;
}
// the record Goose keeps of thinker's plugin, once the plugin is gone
function dropGoosePlugin(file) {
  const text = readText(file), b = gooseBlock(text, 'plugins', goosePlugin());
  if (!b) return;
  const lines = [...b.lines.slice(0, b.start), ...b.lines.slice(b.end)];
  const at = lines.findIndex(l => /^plugins:\s*$/.test(l));
  // a `plugins:` left with nothing under it goes too
  if (at >= 0 && !(lines[at + 1] || '').match(/^\s+\S/)) lines.splice(at, 1);
  fs.writeFileSync(file, lines.join('\n'));
}
const gooseMcpScript = text => { const b = gooseBlock(text); return b ? (b.lines.slice(b.start, b.end).join('\n').match(/([^\s"'\[\],]*mcp\.js)/) || [])[1] || null : null; };
function setGooseExtension(file, entry) {
  const text = readText(file);
  const b = gooseBlock(text);
  let lines = b ? [...b.lines.slice(0, b.start), ...b.lines.slice(b.end)] : text.split('\n');
  if (entry) {
    const ind = b?.indent || '  ';
    const block = [`${ind}thinker:`, ...[
      'type: stdio', 'name: thinker', 'enabled: true', `cmd: ${JSON.stringify(entry.command)}`, `args: ${JSON.stringify(entry.args)}`,
      `envs: ${JSON.stringify(entry.env || {})}`, 'env_keys: []', 'timeout: 300', 'description: "thinker: notes about the repository from earlier sessions"',
    ].map(l => ind + '  ' + l)];
    let at = lines.findIndex(l => /^extensions:\s*$/.test(l));
    if (at < 0) { while (lines.length && !lines.at(-1).trim()) lines.pop(); lines.push(...(lines.length ? [''] : []), 'extensions:'); at = lines.length - 1; }
    lines.splice(at + 1, 0, ...block);
  }
  let next = lines.join('\n'); if (next && !next.endsWith('\n')) next += '\n';
  if (next === text) return false;
  if (!next.trim() || next.trim() === 'extensions:') { if (fs.existsSync(file)) fs.unlinkSync(file); return true; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  return true;
}

// the JSON files of a client that hold hook groups or an MCP entry
function jsonWiring(client, o) {
  const f = wiringFiles(client, o);
  if (client === 'claude') return [{ file: f.local, hooks: true }, ...(f.shared ? [{ file: f.shared, hooks: true }] : []), { file: f.mcp, mcp: true }];
  if (client === 'codex') return [{ file: f.hooks, hooks: true }];
  if (client === 'gemini') return [{ file: f.settings, hooks: true, mcp: true }];
  if (client === 'cursor') return [{ file: f.hooks, hooks: true, keepVersion: true }, { file: f.mcp, mcp: true }];
  if (client === 'copilot' && f.hooks) return [{ file: f.hooks, hooks: true, keepVersion: true }, { file: f.mcp, mcp: true }];
  if (client === 'windsurf' && f.hooks) return [{ file: f.hooks, hooks: true }];
  if (client === 'droid' && f.hooks) return [{ file: f.hooks, hooks: true, flat: flatHooks(f.hooks) }, { file: f.mcp, mcp: true }];
  if ((client === 'qwen' || client === 'augment') && f.settings) return [{ file: f.settings, hooks: true, mcp: true }];
  if (client === 'goose' && f.hooks) return [{ file: f.hooks, hooks: true }];
  if ((client === 'kiro' || client === 'cline') && f.mcp) return [{ file: f.mcp, mcp: true }];
  return [];
}
// The files of a client beyond its JSON wiring: Kiro's hooks file, Cline's hook executables, Auggie's
// wrapper scripts, Goose's plugin manifest and config.yaml
function extraFiles(client, o) {
  const f = wiringFiles(client, o);
  if (client === 'kiro' && f.hooks) return [f.hooks];
  if (client === 'cline' && f.hookDir) return CLINE_EVENTS.map(e => path.join(f.hookDir, e));
  if (client === 'augment' && f.scripts) return ['tool', 'stop', 'end'].map(n => path.join(f.scripts, `${n}.sh`));
  if (client === 'goose' && f.yaml) return [f.yaml, path.join(goosePlugin(), 'plugin.json')];
  return [];
}
const allWiring = (o, clients = CLIENTS) => [...new Set(clients.flatMap(c => {
  const f = wiringFiles(c, o);
  const extra = o.scope === 'repo' ? [...(EXTENSIONS[c] ? [EXTENSIONS[c]] : []), ...(HOOK_FILES[c] || []), ...(RULE_FILES[c] || []), ...(MCP_FILES[c] ? [MCP_FILES[c]] : [])].map(x => path.join(o.repo, x)) : [];
  return [...instructionFiles(c, o), ...jsonWiring(c, o).map(e => e.file), ...(c === 'codex' ? [f.toml] : []), ...(c === 'cursor' && f.rule ? [f.rule] : []), ...(f.ext ? [f.ext] : []), ...extraFiles(c, o), ...extra];
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
const commandOf = g => { const c = (g?.hooks ? g.hooks[0] : g)?.command; return c === undefined ? c : realCommand(c); };
// The script of thinker's Codex MCP entry: the managed block, or a bare [mcp_servers.thinker] table.
// Codex rewrites config.toml when hooks are trusted and drops comments, the block's markers with
// them; the table it keeps is still thinker's server (installClient leaves such a table as it is).
const codexMcpScript = text => {
  const a = text.indexOf(TOML_START), b = a < 0 ? -1 : text.indexOf(TOML_END, a);
  let table = a >= 0 && b >= 0 ? text.slice(a, b) : null;
  if (table === null) { const m = text.match(/^\[mcp_servers\.thinker\]\s*\n((?:(?!\[).*\n?)*)/m); if (!m) return null; table = m[1]; }
  const m = table.match(/^args = \[(.*)\]$/m);
  try { return m ? JSON.parse(`[${m[1]}]`).map(String).find(x => /mcp\.js$/.test(x)) || null : null; } catch { return null; }
};

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
  if (EXTENSIONS[client] || (client === 'kilo' && scope === 'user')) {
    const text = readText(scope === 'repo' ? path.join(repo, EXTENSIONS[client]) : f.ext);
    if (!text.startsWith(GENERATED_MARK)) return null;
    try {
      const cfg = JSON.parse(text.split('\n')[0].slice(GENERATED_MARK.length));
      Object.assign(w, cfg); scripts.add(cfg.cli); hookScripts.add(cfg.cli);
      if (text !== extensionText(cfg)) custom.push('modified thinker extension');
    } catch { return null; }
  }
  if ((client === 'windsurf' || client === 'copilot') && scope !== 'repo') {
    const h = readJsonOr(f.hooks, {}).hooks || {};
    for (const groups of Object.values(h)) for (const g of (Array.isArray(groups) ? groups : []).filter(isOurs)) {
      see(g); const cmd = commandOf(g) || '';
      w.hooks = true; w.learn ||= cmd.includes(' --record'); w.late ||= cmd.includes(' --late');
    }
    const server = f.mcp && readJsonOr(f.mcp, {}).mcpServers?.thinker;
    if (server) { w.mcp = true; const sc = mcpScript(server); if (sc) scripts.add(sc); }
    // Windsurf has no MCP route from thinker: its global rules carry the command-line workflow
    if (client === 'windsurf') w.mcp = instructionFiles(client, { scope }).some(x => readText(x).includes('<!-- thinker:'));
  }
  if ((client === 'windsurf' || client === 'copilot') && scope === 'repo') {
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
    const server = MCP_FILES[client] && readJsonOr(path.join(repo, MCP_FILES[client]), {}).mcpServers?.thinker;
    if (server) { w.mcp = true; const sc = mcpScript(server); if (sc) scripts.add(sc); }
    if (w.mcp && !scripts.size) custom.push('rule-only integration; rerun setup to refresh');
  }
  // Droid, Qwen Code, Auggie and Goose: Claude Code's hook groups, in their own files
  if (['droid', 'qwen', 'augment', 'goose'].includes(client) && scope === 'user') {
    const [e] = jsonWiring(client, { scope });
    const hooks = hooksIn(readJsonOr(e.file, {}), e.flat);
    const evs = Object.keys(hooks).filter(ev => ourGroups(hooks, ev).length);
    if (evs.length) {
      w.hooks = true;
      for (const ev of evs) ourGroups(hooks, ev).forEach(see);
      const cmds = evs.flatMap(ev => ourGroups(hooks, ev).map(g => commandOf(g) || ''));
      w.learn = cmds.some(c => / --record\b/.test(c)); w.late = cmds.some(c => / --late\b/.test(c));
    }
    const mcpFile = client === 'droid' ? f.mcp : client === 'goose' ? null : f.settings;
    const server = mcpFile && readJsonOr(mcpFile, {}).mcpServers?.thinker;
    if (server) { w.mcp = true; const sc = mcpScript(server); if (sc) scripts.add(sc); }
    if (client === 'goose') { const sc = gooseMcpScript(readText(f.yaml)); if (sc) { w.mcp = true; scripts.add(sc); } }
  }
  if (client === 'kiro' && scope === 'user') {
    const items = (readJsonOr(f.hooks, {}).hooks || []).filter(h => isOurs(h.action || h));
    if (items.length) {
      w.hooks = true;
      for (const h of items) see(h.action);
      w.learn = items.some(h => / --record\b/.test(h.action?.command || ''));
    }
    const server = readJsonOr(f.mcp, {}).mcpServers?.thinker;
    if (server) { w.mcp = true; const sc = mcpScript(server); if (sc) scripts.add(sc); }
  }
  if (client === 'cline' && scope === 'user') {
    const files = CLINE_EVENTS.map(ev => path.join(f.hookDir, ev)).filter(isWrapper);
    if (files.length) {
      w.hooks = true;
      const cmds = files.map(file => realCommand(file));
      for (const command of cmds) see({ command });
      w.learn = cmds.some(c => / --record\b/.test(c)); w.late = cmds.some(c => / --late\b/.test(c));
    }
    const server = readJsonOr(f.mcp, {}).mcpServers?.thinker;
    if (server) { w.mcp = true; const sc = mcpScript(server); if (sc) scripts.add(sc); }
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
// Hooks whose copy is gone (a deleted worktree's: a benchmark arm's) run nothing, so they are not yielded
// to: the user's hook goes on, and its prune (pruneInstalls) takes them and their MCP entry out
// (2026-10-16, click: a dead .mcp.json hid the user's server and the dead hooks silenced the user's).
export function repoRunsHooks(repo, client) {
  const w = inferWiring(repo, client);
  if (!w?.hooks) return false;
  return !w.hookScripts.length || w.hookScripts.some(sc => fs.existsSync(sc));
}

// The machine-wide wiring, from the checkouts: for each agent that no user-level file wires yet
// but whose hooks in one of `repos` run this copy (a machine set up before the wiring went
// machine-wide), install the user-level entries with the options those checkouts were set up
// with (any of them learning, late notes or the MCP server: all of them). `thinker update` runs
// this through `rewire`, so an existing user gets the wiring without a step; the checkouts switch
// to it on their next prompt (`stripRepoWiring`). Codex's user hooks are marked reviewed: the
// user accepted the same hooks when setting the checkout up. Returns [{client, from, options}].
export function connectFromCheckouts(repos, { cli, mcpEntry, dry = false, clients = USER_SCOPE_CLIENTS } = {}) {
  const done = [];
  for (const client of clients) {
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

// The agents thinker has offered itself to on this machine (`home`/state/connected.json): each once, so a
// wiring the person took out, or an agent they left unticked in the installer, stays out.
const connectedFile = thinker => path.join(thinker, 'state', 'connected.json');
export function markConnected(thinker, clients) {
  const f = connectedFile(thinker), seen = readJsonOr(f, {});
  const add = clients.filter(c => !seen[c]); if (!add.length) return;
  for (const c of add) seen[c] = new Date().toISOString();
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(seen, null, 2) + '\n');
}

// An agent installed on this machine that thinker was never offered to: one installed after thinker was
// (2026-10-16: devices with caches and no cache request ever, and no wiring check ran without an update),
// or one of the four that became machine-wide on 2026-10-15. Wired into the user's files once, by `rewire`
// (after an update and on the daily run), with the options of this copy's machine-wide wiring for another
// agent (learning, late notes), else the installer's defaults; one already wired is only marked. Returns
// the clients wired.
export function connectDetected({ cli, mcpEntry, home: thinker, learn = true, dry = false, detected = detectClients({ fallback: false }), excluded = [] } = {}) {
  const seen = readJsonOr(connectedFile(thinker), {});
  const done = [], marked = [];
  const others = USER_SCOPE_CLIENTS.map(c => { try { return inferWiring(null, c, { scope: 'user' }); } catch { return null; } }).filter(w => w?.hooks && w.hookScripts.every(sc => sameCopy(sc, cli)));
  const options = others.length ? { hooks: true, learn: others.some(w => w.learn), late: others.some(w => w.late), mcp: true } : { hooks: true, learn, late: false, mcp: true };
  for (const client of USER_SCOPE_CLIENTS) {
    if (excluded.includes(client) || seen[client] || !detected.includes(client)) continue;
    marked.push(client);
    if (inferWiring(null, client, { scope: 'user' })) continue;
    if (!dry) { installClient(client, { scope: 'user', cli, mcpEntry, ...options }); if (client === 'codex') trustCodexUser(); }
    done.push(client);
  }
  if (!dry) markConnected(thinker, marked);
  return done;
}

// Rewrite the wiring of one checkout (scope 'repo') or of the user's files (scope 'user', `repo`
// unused) for the copy of thinker at `cli`. Returns what changed:
// { changed: ['.claude/settings.local.json', …], skipped: [{client, reason}], clients: [...] }.
// With `dry` nothing is written. `mcpEntry` is this copy's MCP entry for the scope.
export function refreshWiring(repo, { cli, mcpEntry, dry = false, clients = CLIENTS, scope = 'repo', repair = false } = {}) {
  const o = { scope, repo };
  const ours = script => !script || sameCopy(script, cli);
  const where = scripts => [...new Set(scripts.filter(s => !ours(s)).map(s => `${installRoot(s)}${fs.existsSync(s) ? '' : ', no longer there'}`))].join('; ');
  const files = [...new Set([...allWiring(o, clients), ...(scope === 'repo' ? HOOKS.map(h => gitHookPath(repo, h)).filter(Boolean) : []), ...(repair && clients.includes('codex') ? [codexConfig()] : [])])];
  const snapshot = () => Object.fromEntries(files.map(f => [f, fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null]));
  const before = snapshot();
  const r = { changed: [], skipped: [], clients: [] };
  try {
    for (const client of clients) {
      // Never turn an unreadable/invalid config into an empty one during automatic repair.
      if (repair) for (const file of allWiring(o, [client])) {
        if (file.endsWith('.json') && fs.existsSync(file)) JSON.parse(fs.readFileSync(file, 'utf8'));
      }
      const w = inferWiring(repo, client, { scope });
      if (!w) continue;
      if (!w.scripts.every(ours) && !(repair && w.scripts.every(sc => ours(sc) || !fs.existsSync(sc)))) { r.skipped.push({ client, reason: `wired to another copy of thinker (${where(w.scripts)})` }); continue; }
      if (w.custom.length) { r.skipped.push({ client, reason: `a hook command was written by hand: ${w.custom[0]}` }); continue; }
      installClient(client, { scope, repo, cli, mcpEntry, hooks: w.hooks, learn: w.learn, late: w.late, shared: w.shared, mcp: w.mcp });
      // An unchanged hooks.json says nothing about the prerequisite settings or reviewed hashes.
      // Do this inside the snapshot so dry runs restore it and repairs are reported as changes.
      if (repair && client === 'codex') {
        // Codex may remove our comments when saving TOML. Such an owned MCP entry must still
        // get the launcher marker and lose a repository pin at user scope; keep custom env keys.
        const file = wiringFiles('codex', o).toml, text = readText(file);
        if (w.mcp && !text.includes(TOML_START) && codexMcpScript(text) && sameCopy(codexMcpScript(text), cli)) {
          const header = '[mcp_servers.thinker.env]';
          const body = text.match(/^\[mcp_servers\.thinker\.env\]\s*\n((?:(?!\[).*\n?)*)/m)?.[1] || '';
          const kept = body.split('\n').filter(l => l.trim() && !/^\s*THINKER_(REPO|MCP_LAUNCHER)\s*=/.test(l));
          const next = setTomlTable(text, header, [...kept, ...Object.entries(mcpEntry.env || {}).map(([k, v]) => `${k} = ${tomlStr(v)}`)]);
          if (next !== text) fs.writeFileSync(file, next);
        }
        if (scope === 'user') trustCodexUser();
        else if (readText(codexConfig()).includes(`[projects.${tomlStr(real(repo))}]`)) trustCodex(repo);
      }
      r.clients.push(client);
    }
    if (scope === 'repo') {
      if (clients.includes('cursor') && !inferWiring(repo, 'cursor') && fs.existsSync(path.join(repo, '.thinker'))) {
        const w = inferWiring(null, 'cursor', { scope: 'user' });
        if (w?.mcp && w.scripts.every(ours) && !w.custom.length) installCursorRule(repo, { learn: w.learn });
      }
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
  if (!repair && !dry && r.clients.includes('codex')) {
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
    const curHooks = hooksIn(cur, e.flat);
    if (e.hooks && curHooks && typeof curHooks === 'object') {
      const hooks = { ...curHooks };
      for (const ev of Object.keys(hooks)) {
        if (!Array.isArray(hooks[ev])) continue;
        const kept = hooks[ev].filter(g => { if (!isOurs(g)) return true; const t = take(hookScript(g)); if (t) { record(e.file, t, 'hooks'); return false; } return true; });
        if (kept.length !== hooks[ev].length) { changed = true; if (kept.length) hooks[ev] = kept; else delete hooks[ev]; }
      }
      if (changed) next = withHooks(next, e.flat, hooks);
    }
    if (e.mcp && cur.mcpServers?.thinker) {
      const t = take(mcpScript(cur.mcpServers.thinker));
      if (t) {
        record(e.file, t, 'mcp'); changed = true;
        const m = { ...next.mcpServers };
        if (mcpEntry) m.thinker = mcpServerEntry(client, mcpEntry); else delete m.thinker;
        next = { ...next, mcpServers: m }; if (!Object.keys(m).length) delete next.mcpServers;
      }
    }
    if (!changed) continue;
    if (Object.keys(next).filter(k => !(e.keepVersion && k === 'version')).length || e.flat) fs.writeFileSync(e.file, JSON.stringify(next, null, 2) + '\n');
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
  if (clients.includes('claude')) for (const f of staleRepoInstructions(repo)) { try { if (updateInstructions(f, null)) done.push({ file: path.relative(repo, f) }); } catch {} }
  if (clients.includes('codex') && !fs.existsSync(wiringFiles('codex', { repo }).hooks)) untrustCodexHooks(wiringFiles('codex', { repo }).hooks);
  const files = done.map(d => d.file);
  // pi, OpenCode, Copilot and Windsurf keep theirs in files of their own (an extension, a hooks file, a
  // rule, Copilot's MCP file): the lot goes when it is this copy's and the checkout keeps it for itself
  for (const client of clients.filter(c => ['pi', 'opencode', 'copilot', 'windsurf'].includes(c))) {
    const w = inferWiring(repo, client);
    if (!w || w.shared || !w.scripts.length || !w.scripts.every(sc => sameCopy(sc, cli))) continue;
    files.push(...uninstallRepoClient(repo, client));
  }
  return [...new Set(files)];
}

// Thinker's workflow block in a checkout's own Claude file (CLAUDE.local.md, never committed) while the
// user's CLAUDE.md carries one: left by a setup from before the wiring went machine-wide, and an older
// text. Both reach every session, and they disagreed (2026-10-17 on this repository: the checkout's
// said learning is disabled, the user's asked for remember). A tracked file is the team's and stays.
export function staleRepoInstructions(repo) {
  const [local] = instructionFiles('claude', { repo }), [user] = instructionFiles('claude', { scope: 'user' });
  if (!hasInstructions(local) || !hasInstructions(user)) return [];
  try { execFileSync('git', ['ls-files', '--error-unmatch', path.basename(local)], { cwd: repo, stdio: 'ignore' }); return []; } catch {}
  return [local];
}

// Take one of the four's checkout files out (the ones thinker wrote): returns them, relative to the checkout.
function uninstallRepoClient(repo, client) {
  const gone = [];
  const ext = EXTENSIONS[client] && path.join(repo, EXTENSIONS[client]);
  if (ext && readText(ext).startsWith(GENERATED_MARK)) { fs.unlinkSync(ext); gone.push(EXTENSIONS[client]); }
  for (const f of HOOK_FILES[client] || []) if (stripThinkerHooks(path.join(repo, f), { keepVersion: true })) gone.push(f);
  for (const f of RULE_FILES[client] || []) if (readText(path.join(repo, f)).includes('<!-- thinker -->')) { fs.unlinkSync(path.join(repo, f)); gone.push(f); }
  if (MCP_FILES[client] && dropMcpEntry(path.join(repo, MCP_FILES[client]))) gone.push(MCP_FILES[client]);
  return gone;
}
// Take thinker's server out of an mcpServers file; the file goes when nothing else is left in it
function dropMcpEntry(file) {
  if (!readJsonOr(file, {}).mcpServers?.thinker) return false;
  mergeJson(file, c => { const m = { ...(c.mcpServers || {}) }; delete m.thinker; return { ...c, mcpServers: m }; });
  const left = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Object.keys(left).length === 1 && !Object.keys(left.mcpServers).length) fs.unlinkSync(file);
  return true;
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
// Codex's subagents ([features] multi_agent): a warm-up in the Codex app reads through a subagent of the
// session (repo-onboard.js:SUBAGENT_TOOLS). On by default since Codex 0.160; set outright for older versions
// and for a config that turned it off. Other keys of [features] (hooks) are kept.
export function codexSubagentsOn(text) { return /^\[features\][^\[]*^\s*multi_agent\s*=\s*true\b/m.test(text); }
export function enableCodexSubagents({ file = codexConfig() } = {}) {
  const cur = readText(file);
  if (codexSubagentsOn(cur)) return [];
  const lines = cur.split('\n'); const at = lines.findIndex(l => l.trim() === '[features]');
  let next;
  if (at < 0) next = (cur.trimEnd() ? cur.trimEnd() + '\n\n' : '') + '[features]\nmulti_agent = true\n';
  else {
    let end = lines.findIndex((l, i) => i > at && /^\s*\[/.test(l)); if (end < 0) end = lines.length;
    const key = lines.findIndex((l, i) => i > at && i < end && /^\s*multi_agent\s*=/.test(l));
    if (key >= 0) lines[key] = 'multi_agent = true'; else lines.splice(at + 1, 0, 'multi_agent = true');
    next = lines.join('\n');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  return [`Codex: turned on subagents ([features] multi_agent = true) in ${file}`];
}
// Mark thinker's hooks in the user's own hooks.json as reviewed, and turn Codex's subagents on.
export function trustCodexUser() {
  const file = codexConfig();
  const done = enableCodexSubagents({ file });
  const before = readText(file);
  const { text, n } = trustHooksIn(before, wiringFiles('codex', { scope: 'user' }).hooks, null);
  if (!n || text === before) return done;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return [...done, `Codex: marked thinker's ${n} hooks as reviewed in ${file}`];
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

// Kilo is an OpenCode fork: OpenCode's plugin, in the module shape Kilo loads ({ id, server })
function extensionText(config) {
  const source = pathToFileURL(path.join(path.dirname(config.cli), 'integrations', `${config.client === 'kilo' ? 'opencode' : config.client}.js`)).href;
  const factory = config.client === 'pi' ? 'piExtension' : 'opencodePlugin';
  const body = config.client === 'pi' ? `export default pi => piExtension(pi, ${JSON.stringify(config)});\n`
    : config.client === 'kilo' ? `export default { id: 'thinker', server: opencodePlugin(${JSON.stringify(config)}) };\n`
    : `export default opencodePlugin(${JSON.stringify(config)});\n`;
  return GENERATED_MARK + JSON.stringify(config) + '\n' + `import { ${factory} } from ${JSON.stringify(source)};\n` + body;
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
    // at scope user the extension serves every checkout: no repo in its config, the session's directory at run time
    const file = scope === 'user' ? f.ext : path.join(repo, EXTENSIONS[client]);
    const before = readText(file);
    if (before && !before.startsWith(GENERATED_MARK)) throw new Error(`Refusing to overwrite ${rel(file)}: not a generated thinker extension`);
    const config = { client, repo: scope === 'user' ? null : repo, cli, hooks: !!hooks, learn: !!learn, late: !!late, shared: !!shared, mcp: !!mcp, mcpEntry };
    const text = extensionText(config);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (before !== text) fs.writeFileSync(file, text);
    if (scope === 'repo' && !shared) excludeLocally(repo, [EXTENSIONS[client]]);
    done.push(`${client}: installed ${rel(file)}${client === 'pi' && mcp ? '; follow-up retrieval uses the CLI (no MCP dependency)' : ''}`);
  }
  if ((client === 'windsurf' || client === 'copilot') && scope === 'user') {
    if (hooks) {
      const wind = client === 'windsurf';
      const prompt = wind ? 'pre_user_prompt' : 'userPromptSubmitted';
      const tools = wind ? ['post_read_code', 'post_write_code', 'post_run_command', 'post_mcp_tool_use'] : ['postToolUse', 'postToolUseFailure'];
      const stops = wind ? ['post_cascade_response'] : ['agentStop', 'sessionEnd'];
      const entry = (what, extra) => wind ? { command: cmd(what, extra), show_output: what === 'stop' } : { type: 'command', command: cmd(what, extra), timeoutSec: 15 };
      const entries = [[prompt, entry('prompt', rec)]];
      if (learn || (!wind && (hooks || late))) for (const ev of tools) entries.push([ev, entry('tool', (!wind && late ? ' --late' : '') + rec)]);
      for (const ev of stops) entries.push([ev, entry('stop', stopFlags)]);
      mergeJson(f.hooks, c => ({ ...(!wind ? { version: 1 } : {}), ...c, hooks: setHooks(c.hooks, [prompt, ...tools, ...stops], entries) }));
      done.push(`${client}: hooks in ${rel(f.hooks)}${wind ? '; Windsurf runs them in the workspace, where they find the repository' : '; prompt notes delivered after the first tool result'}`);
    }
    if (client === 'copilot' && mcp) {
      mergeJson(f.mcp, c => ({ ...c, mcpServers: { ...(c.mcpServers || {}), thinker: mcpServerEntry('copilot', mcpEntry) } }));
      done.push(`Copilot: registered MCP server in ${rel(f.mcp)}`);
    }
  }
  if ((client === 'windsurf' || client === 'copilot') && scope === 'repo') {
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
      const text = `---\n${front}\n---\n<!-- thinker -->\n${guidance({ cli, repo, learn })}\n`;
      const before = readText(path.join(repo, file));
      if (before && !before.includes('<!-- thinker -->')) throw new Error(`Refusing to overwrite ${file}`);
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      if (before !== text) fs.writeFileSync(path.join(repo, file), text);
      generated.push(file);
      done.push(`${client}: CLI retrieval guidance in ${file}; no global MCP configuration changed`);
    }
    if (client === 'copilot' && mcp) {
      const file = MCP_FILES.copilot;
      mergeJson(path.join(repo, file), c => ({ ...c, mcpServers: { ...(c.mcpServers || {}), thinker: mcpServerEntry('copilot', mcpEntry) } }));
      generated.push(file);
      done.push(`Copilot: registered MCP server in ${file} (Copilot loads it once the folder is trusted)`);
    }
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
      // the cache-hit card under each served answer (claude-card.js); one copy's folder, the user's settings only
      if (scope === 'user') {
        const dir = claudeCardDir(cli);
        if (cardDirIn(readJsonOr(f.local, {})) !== dir) mergeJson(f.local, c => withCardDir(c, dir));
        done.push(`Claude Code: cache-hit card under each served answer (${CARD_LABEL} in ${rel(f.local)})`);
      }
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
      if (f.rule) { installCursorRule(repo, { learn }); generated.push(f.rule); }
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
      done.push(`Cursor: hooks in ${rel(f.hooks)}: notes for the request are delivered with the prompt${late ? ', then file-keyed notes while working' : ''}${learned}`);
      generated.push(f.hooks);
    }
    localFiles(generated);
  }
  // Droid, Qwen Code, Auggie, Goose: Claude Code's hook groups in their own files. Auggie has no prompt
  // hook and runs only scripts (thinker's .sh wrappers); Goose's hooks only record, for learning, since
  // what they print never reaches the model (they are left out without learning).
  const SHAPED = {
    droid: { name: 'Droid', prompt: 'UserPromptSubmit', matcher: '*', unit: 1 },
    qwen: { name: 'Qwen Code', prompt: 'UserPromptSubmit', matcher: '*', unit: 1 },
    augment: { name: 'Auggie', prompt: null, matcher: '.*', unit: 1000, scripts: true },
    goose: { name: 'Goose', prompt: 'UserPromptSubmit', matcher: '.*', unit: 1, recordOnly: true },
  };
  const shaped = scope === 'user' && SHAPED[client];
  if (shaped) {
    const [e] = jsonWiring(client, o);
    const events = ['UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd'];
    const wanted = hooks && (!shaped.recordOnly || learn);
    const command = (what, extra) => {
      if (!shaped.scripts) return cmd(what, extra);
      const file = path.join(f.scripts, `${what === 'tool' ? 'tool' : extra === ' --end' ? 'end' : 'stop'}.sh`);
      writeWrapper(file, cmd(what, extra === ' --end' ? stopFlags : extra));
      return file;
    };
    const group = (what, extra, timeout, tool = false) => ({ ...(tool ? { matcher: shaped.matcher } : {}), hooks: [{ type: 'command', command: command(what, extra), timeout: timeout * shaped.unit }] });
    const entries = [];
    if (wanted) {
      if (shaped.prompt) entries.push(['UserPromptSubmit', group('prompt', rec, 15)]);
      if (late || learn) entries.push(['PostToolUse', group('tool', (late && !shaped.recordOnly ? ' --late' : '') + rec, 10, true)]);
      // Auggie hands a Stop hook the turn's prompt and answer when asked (includeConversationData): its trace's prompt
      entries.push(['Stop', { ...group('stop', stopFlags, 10), ...(client === 'augment' ? { metadata: { includeConversationData: true } } : {}) }]);
      if (learn) entries.push(['SessionEnd', group('stop', shaped.scripts ? ' --end' : stopFlags, 10)]);
    }
    mergeJson(e.file, c => withHooks(c, e.flat, setHooks(hooksIn(c, e.flat), events, entries)));
    if (shaped.scripts && !wanted) fs.rmSync(f.scripts, { recursive: true, force: true });
    if (client === 'goose') {
      const manifest = path.join(goosePlugin(), 'plugin.json');
      if (wanted) mergeJson(manifest, c => ({ ...c, name: 'thinker', description: 'thinker: records sessions so the cache learns from them' }));
      else { fs.rmSync(goosePlugin(), { recursive: true, force: true }); dropGoosePlugin(f.yaml); }
    }
    if (wanted) done.push(`${shaped.name}: hooks in ${rel(e.file)}: ${shaped.recordOnly ? 'sessions recorded for learning (Goose gives hooks no way to add context)' : `${shaped.prompt ? 'notes injected on each prompt' : 'no prompt hook in Auggie: the rules about a file come when it edits one'}${late ? ', file-keyed notes while working' : ''}${learned}`}`);
    if (mcp && client !== 'goose') {
      const file = client === 'droid' ? f.mcp : f.settings;
      mergeJson(file, c => ({ ...c, mcpServers: { ...(c.mcpServers || {}), thinker: mcpServerEntry(client, mcpEntry) } }));
      done.push(`${shaped.name}: registered MCP server in ${rel(file)}`);
    }
    if (mcp && client === 'goose') { setGooseExtension(f.yaml, mcpEntry); done.push(`Goose: added the thinker extension to ${rel(f.yaml)}`); }
  }

  // Kiro CLI: the V3 engine's global hooks file, ours alone; the prompt hook's stdout is added to the
  // context, a PostToolUse hook's is ignored (so the tool hook only records)
  if (client === 'kiro' && scope === 'user') {
    if (hooks) {
      const item = (name, trigger, what, extra, timeout) => ({ name: `thinker-${name}`, trigger, action: { type: 'command', command: cmd(what, extra) }, timeout, enabled: true });
      const items = [item('prompt', 'UserPromptSubmit', 'prompt', rec, 15)];
      if (learn) items.push(item('tool', 'PostToolUse', 'tool', rec, 10));
      items.push(item('stop', 'Stop', 'stop', stopFlags, 10));
      if (learn) items.push(item('end', 'SessionEnd', 'stop', stopFlags, 10));
      const text = JSON.stringify({ version: 'v1', hooks: items }, null, 2) + '\n';
      fs.mkdirSync(path.dirname(f.hooks), { recursive: true });
      if (readText(f.hooks) !== text) fs.writeFileSync(f.hooks, text);
      done.push(`Kiro CLI: hooks in ${rel(f.hooks)} (the V3 engine: \`kiro-cli --v3\`, or chat.agentEngine = v3): notes injected on each prompt${learned}`);
    } else fs.rmSync(f.hooks, { force: true });
    if (mcp) { mergeJson(f.mcp, c => ({ ...c, mcpServers: { ...(c.mcpServers || {}), thinker: mcpServerEntry('kiro', mcpEntry) } })); done.push(`Kiro CLI: registered MCP server in ${rel(f.mcp)}`); }
  }

  // Cline: one executable per event in its global hooks folder. An event the person already has a hook
  // for is left to theirs (a folder holds one file per event).
  if (client === 'cline' && scope === 'user') {
    const plan = { UserPromptSubmit: ['prompt', rec], PostToolUse: (late || learn) ? ['tool', (late ? ' --late' : '') + rec] : null,
      TaskComplete: ['stop', stopFlags], TaskCancel: ['stop', stopFlags], SessionShutdown: learn ? ['stop', stopFlags] : null };
    const kept = [];
    for (const ev of CLINE_EVENTS) {
      const file = path.join(f.hookDir, ev);
      if (fs.existsSync(file) && !isWrapper(file)) { if (hooks && plan[ev]) kept.push(ev); continue; }
      if (hooks && plan[ev]) writeWrapper(file, cmd(...plan[ev])); else fs.rmSync(file, { force: true });
    }
    if (hooks) done.push(`Cline: hooks in ${rel(f.hookDir)}: notes added on each prompt in the editor (the CLI's prompt hook never sees the person's prompt)${late ? ', file-keyed notes while working' : ''}${learned}${kept.length ? `; left your own ${kept.join(', ')} hook${kept.length > 1 ? 's' : ''} in place` : ''}`);
    if (mcp) { mergeJson(f.mcp, c => ({ ...c, mcpServers: { ...(c.mcpServers || {}), thinker: mcpServerEntry('cline', mcpEntry) } })); done.push(`Cline: registered MCP server in ${rel(f.mcp)}`); }
  }

  // Kilo: OpenCode's plugin, in Kilo's global plugin folder; it registers the MCP server itself
  if (client === 'kilo' && scope === 'user' && (hooks || mcp)) {
    const before = readText(f.ext);
    if (before && !before.startsWith(GENERATED_MARK)) throw new Error(`Refusing to overwrite ${rel(f.ext)}: not a generated thinker plugin`);
    const text = extensionText({ client, repo: null, cli, hooks: !!hooks, learn: !!learn, late: !!late, shared: false, mcp: !!mcp, mcpEntry });
    fs.mkdirSync(path.dirname(f.ext), { recursive: true });
    if (before !== text) fs.writeFileSync(f.ext, text);
    done.push(`Kilo: installed ${rel(f.ext)}`);
  }

  if (hooks || mcp) {
    const candidates = instructionFiles(client, o);
    const file = candidates.find(f => fs.existsSync(f)) || candidates.at(-1);
    if (file) {
      const existed = fs.existsSync(file);
      if (updateInstructions(file, agentWorkflow({ cli, repo: scope === 'repo' ? repo : undefined, mcp: !!mcp && client !== 'windsurf', disabled: scope === 'repo' ? repoDisabledTools(repo) : undefined }))) done.push(`${client}: Thinker workflow in ${rel(file)}`);
      // Do not hide an existing user instruction file from version control.
      if (!existed) localFiles([file]);
    }
  }
  return done;
}

// The code tools a checkout has switched off (both, unless its config says otherwise). A machine-wide
// instruction file serves every repository, so it names none of them; the server's own instructions
// and the prompt hook name the ones a repository turned on.
function repoDisabledTools(repo) {
  try { return disabledTools(JSON.parse(fs.readFileSync(path.join(repo, '.thinker', 'config.json'), 'utf8'))); } catch { return disabledTools(); }
}

// The always-applied rule that points Cursor's agent at the MCP tools: a checkout file, since
// Cursor keeps user rules in its settings, not in a file.
export function installCursorRule(repo, { learn = true } = {}) {
  const rule = wiringFiles('cursor', { repo }).rule;
  const text = `---\ndescription: Use Thinker for repository exploration and learning\nalwaysApply: true\n---\n${agentWorkflow({ disabled: repoDisabledTools(repo) })}\n`;
  fs.mkdirSync(path.dirname(rule), { recursive: true });
  if (readText(rule) !== text) fs.writeFileSync(rule, text);
  return rule;
}

// Take thinker's hook entries (and, with `mcp`, its MCP entry) out of one JSON file; the file
// goes when nothing else is in it. Returns whether anything was removed.
function stripThinkerHooks(file, { keepVersion = false, mcp = false, flat = false } = {}) {
  if (!fs.existsSync(file)) return false;
  const before = fs.readFileSync(file, 'utf8');
  mergeJson(file, c => {
    const hooks = { ...hooksIn(c, flat) };
    for (const ev of Object.keys(hooks)) { if (!Array.isArray(hooks[ev])) continue; hooks[ev] = hooks[ev].filter(h => !isOurs(h)); if (!hooks[ev].length) delete hooks[ev]; }
    const n = withHooks(c, flat, hooks);
    if (mcp && n.mcpServers?.thinker) { n.mcpServers = { ...n.mcpServers }; delete n.mcpServers.thinker; if (!Object.keys(n.mcpServers).length) delete n.mcpServers; }
    return n;
  });
  const after = fs.readFileSync(file, 'utf8');
  const left = JSON.parse(after);
  // an emptied hooks.json of Droid's stays: without it Droid would read the hooks in its settings.json
  if (!flat && !Object.keys(left).filter(k => !(keepVersion && k === 'version')).length) fs.unlinkSync(file);
  return JSON.stringify(JSON.parse(before)) !== JSON.stringify(left);
}

// Remove everything installClient wrote, at one scope: the checkout's files, or the user's.
export function uninstallWiring({ scope = 'repo', repo } = {}) {
  const o = { scope, repo };
  const claude = wiringFiles('claude', o), codex = wiringFiles('codex', o), gemini = wiringFiles('gemini', o), cursor = wiringFiles('cursor', o);
  for (const file of new Set(CLIENTS.flatMap(c => instructionFiles(c, o)))) updateInstructions(file, null);
  untrustCodexHooks(codex.hooks);
  if (scope === 'repo') for (const client of ['pi', 'opencode', 'copilot', 'windsurf']) uninstallRepoClient(repo, client);
  else {
    for (const client of ['pi', 'opencode']) { const ext = wiringFiles(client, o).ext; if (readText(ext).startsWith(GENERATED_MARK)) fs.unlinkSync(ext); }
    stripThinkerHooks(wiringFiles('copilot', o).hooks, { keepVersion: true }); stripThinkerHooks(wiringFiles('windsurf', o).hooks);
    dropMcpEntry(wiringFiles('copilot', o).mcp);
    // Droid, Qwen Code, Auggie, Kiro CLI, Cline, Kilo, Goose
    const droid = wiringFiles('droid', o);
    stripThinkerHooks(droid.hooks, { flat: flatHooks(droid.hooks) }); dropMcpEntry(droid.mcp);
    for (const c of ['qwen', 'augment']) stripThinkerHooks(wiringFiles(c, o).settings, { mcp: true });
    fs.rmSync(wiringFiles('augment', o).scripts, { recursive: true, force: true });
    const kiro = wiringFiles('kiro', o);
    fs.rmSync(kiro.hooks, { force: true }); dropMcpEntry(kiro.mcp);
    const cline = wiringFiles('cline', o);
    for (const ev of CLINE_EVENTS) { const file = path.join(cline.hookDir, ev); if (isWrapper(file)) fs.unlinkSync(file); }
    dropMcpEntry(cline.mcp);
    const kilo = wiringFiles('kilo', o).ext; if (readText(kilo).startsWith(GENERATED_MARK)) fs.unlinkSync(kilo);
    fs.rmSync(goosePlugin(), { recursive: true, force: true });
    setGooseExtension(wiringFiles('goose', o).yaml, null);
    dropGoosePlugin(wiringFiles('goose', o).yaml);
  }
  const stripHooks = (file, keepVersion) => file && stripThinkerHooks(file, { keepVersion, mcp: true });
  if (scope === 'user' && cardDirIn(readJsonOr(claude.local, {}))) mergeJson(claude.local, withoutCardDir);
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
