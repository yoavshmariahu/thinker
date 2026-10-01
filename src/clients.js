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
// Learning from sessions: Claude Code's transcript is distilled at Stop. For
// the others the hooks record the session themselves (prompt, every tool call
// with its result, the closing message) and that trace is distilled, so
// learning does not depend on the agent's transcript format.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const CLIENTS = ['claude', 'codex', 'cursor', 'gemini'];

export function mergeJson(file, patch) {
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const next = patch(cur);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
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

export const sessionOf = ev => ev.session_id || ev.conversation_id || ev.conversationId || 'unknown';

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

// What the hook prints so the client adds `text` to the model's context.
export function promptOutput(client, text, notice = '') {
  if (client === 'gemini') {
    const res = { hookSpecificOutput: { hookEventName: 'BeforeAgent', additionalContext: text } };
    if (notice) {
      res.systemMessage = notice;
      res.injectSteps = [{ ephemeralMessage: notice }];
    }
    return JSON.stringify(res);
  }
  if (client === 'claude') {
    if (notice) {
      return JSON.stringify({
        systemMessage: notice,
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text }
      });
    }
    return text;
  }
  return text;
}
// What the stop hook prints so the client shows `notice` to the user. Claude Code and
// Gemini CLI show `systemMessage` for every hook event; Codex and Cursor have no channel
// to the user from a stop hook, so nothing is printed for them.
export function stopOutput(client, notice) {
  if (!notice || !['claude', 'gemini'].includes(client)) return '';
  return JSON.stringify({ systemMessage: notice });
}
export function toolOutput(client, text) {
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

// Codex keeps what the user has trusted in its own config.toml (CODEX_HOME, ~/.codex): a project,
// before it reads the project's .codex/, and each hook by a hash of its definition.
const codexConfig = () => path.join(process.env.CODEX_HOME || home('.codex'), 'config.toml');
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

// Mark the repo as trusted and thinker's hooks in it as reviewed. Returns lines describing what was done.
export function trustCodex(repo) {
  const file = codexConfig();
  const root = real(repo);
  let text = setTomlTable(readText(file), `[projects.${tomlStr(root)}]`, ['trust_level = "trusted"']);
  const hooksFile = path.join(root, '.codex', 'hooks.json');
  let hooks = {}; try { hooks = JSON.parse(fs.readFileSync(hooksFile, 'utf8')).hooks || {}; } catch {}
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js');
  const defs = {
    UserPromptSubmit: [['prompt', 15, ['', ' --record']]],
    PostToolUse: [['tool', 10, ['', ' --late', ' --record', ' --late --record']]],
    Stop: [['stop', 10, ['', ' --record']]],
  };
  const generated = (event, h) => h?.type === 'command' && (defs[event] || []).some(([what, timeout, suffixes]) =>
    h.timeout === timeout && suffixes.some(suffix => h.command === `node "${cli}" hook ${what} --client codex --repo "${root}"${suffix}`));
  let n = 0;
  for (const [ev, groups] of Object.entries(hooks)) (groups || []).forEach((g, gi) => (g.hooks || []).forEach((h, hi) => {
    // Trust only exact Codex hook commands this Thinker version generates.
    if (g.matcher !== undefined || !generated(ev, h)) return;
    text = setTomlTable(text, `[hooks.state.${tomlStr(`${hooksFile}:${snake(ev)}:${gi}:${hi}`)}]`, [`trusted_hash = ${tomlStr(codexHookHash(snake(ev), h))}`]);
    n++;
  }));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return [`Codex: marked this repository as trusted${n ? ` and thinker's ${n} hooks as reviewed` : ''} in ${file}`];
}
function untrustCodexHooks(repo) {
  const file = codexConfig();
  const cur = readText(file); if (!cur) return;
  const prefix = `[hooks.state.${tomlStr(path.join(real(repo), '.codex', 'hooks.json') + ':').slice(0, -1)}`;
  const next = dropTomlTables(cur, h => h.startsWith(prefix)).replace(/\n{3,}/g, '\n\n');
  if (next !== cur) fs.writeFileSync(file, next);
}
function setHooks(hooks, events, entries) {
  const next = { ...(hooks || {}) };
  for (const ev of events) { next[ev] = (next[ev] || []).filter(h => !isOurs(h)); if (!next[ev].length) delete next[ev]; }
  for (const [ev, entry] of entries) (next[ev] ||= []).push(entry);
  return next;
}

// Wire one client into the repo. Returns lines describing what was done.
//   opts: repo, cli (path to cli.js), mcpEntry ({command,args,env}), hooks, learn, late, shared, mcp
export function installClient(client, { repo, cli, mcpEntry, hooks, learn, late, shared, mcp }) {
  const done = [];
  const cmd = (what, extra = '') => `node "${cli}" hook ${what} --client ${client} --repo "${repo}"${extra}`;
  const rel = f => path.relative(repo, f);
  const rec = learn ? ' --record' : '';
  const learned = learn ? ', sessions distilled into new notes when they end' : '';

  if (client === 'claude') {
    if (mcp) { mergeJson(path.join(repo, '.mcp.json'), c => ({ ...c, mcpServers: { ...(c.mcpServers || {}), thinker: mcpEntry } })); done.push('Claude Code: registered MCP server in .mcp.json'); }
    if (hooks) {
      const target = path.join(repo, '.claude', shared ? 'settings.json' : 'settings.local.json');
      const entries = [['UserPromptSubmit', { matcher: '', hooks: [{ type: 'command', command: `node "${cli}" hook prompt`, timeout: 15 }] }]];
      if (late) entries.push(['PostToolUse', { matcher: 'Read|Bash|Grep|Edit|Write', hooks: [{ type: 'command', command: `node "${cli}" hook tool`, timeout: 10 }] }]);
      if (learn) entries.push(['Stop', { matcher: '', hooks: [{ type: 'command', command: `node "${cli}" hook stop`, timeout: 10 }] }]);
      mergeJson(target, c => ({ ...c, hooks: setHooks(c.hooks, ['UserPromptSubmit', 'Stop', 'PostToolUse'], entries) }));
      done.push(`Claude Code: hooks in ${rel(target)}: notes injected on each prompt${late ? ', file-keyed notes while working' : ''}${learn ? ', sessions distilled into new notes when they end' : ''}`);
    }
  }

  if (client === 'codex') {
    const generated = [];
    if (mcp) {
      const file = path.join(repo, '.codex', 'config.toml');
      const cur = fs.existsSync(file) ? stripTomlBlock(fs.readFileSync(file, 'utf8')) : '';
      if (/^\[mcp_servers\.thinker\]/m.test(cur)) done.push('Codex: .codex/config.toml already defines mcp_servers.thinker; left as is');
      else {
        const block = [TOML_START, '[mcp_servers.thinker]', `command = ${tomlStr(mcpEntry.command)}`, `args = [${mcpEntry.args.map(tomlStr).join(', ')}]`, 'default_tools_approval_mode = "approve"', '', '[mcp_servers.thinker.env]', ...Object.entries(mcpEntry.env || {}).map(([k, v]) => `${k} = ${tomlStr(v)}`), TOML_END].join('\n');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, (cur.trim() ? cur.trimEnd() + '\n\n' : '') + block + '\n');
        done.push('Codex: registered MCP server in .codex/config.toml');
        generated.push('.codex/config.toml');
      }
    }
    if (hooks) {
      const file = path.join(repo, '.codex', 'hooks.json');
      const entries = [['UserPromptSubmit', { hooks: [{ type: 'command', command: cmd('prompt'), timeout: 15 }] }]];
      entries[0][1].hooks[0].command = cmd('prompt', rec);
      if (late || learn) entries.push(['PostToolUse', { hooks: [{ type: 'command', command: cmd('tool', (late ? ' --late' : '') + rec), timeout: 10 }] }]);
      if (learn) entries.push(['Stop', { hooks: [{ type: 'command', command: cmd('stop', rec), timeout: 10 }] }]);
      mergeJson(file, c => ({ ...c, hooks: setHooks(c.hooks, ['UserPromptSubmit', 'PostToolUse', 'Stop'], entries) }));
      done.push(`Codex: hooks in .codex/hooks.json: notes injected on each prompt${late ? ', file-keyed notes while working' : ''}${learned}`);
      generated.push('.codex/hooks.json');
    }
    if (!shared && generated.length) excludeLocally(repo, generated);
  }

  if (client === 'gemini') {
    const file = path.join(repo, '.gemini', 'settings.json');
    if (mcp || hooks) mergeJson(file, c => {
      const n = { ...c };
      if (mcp) n.mcpServers = { ...(c.mcpServers || {}), thinker: mcpEntry };
      if (hooks) {
        // Gemini CLI timeouts are in milliseconds
        const entries = [['BeforeAgent', { hooks: [{ name: 'thinker-prompt', type: 'command', command: cmd('prompt'), timeout: 15000 }] }]];
        entries[0][1].hooks[0].command = cmd('prompt', rec);
        if (late || learn) entries.push(['AfterTool', { hooks: [{ name: 'thinker-tool', type: 'command', command: cmd('tool', (late ? ' --late' : '') + rec), timeout: 10000 }] }]);
        if (learn) entries.push(['AfterAgent', { hooks: [{ name: 'thinker-learn', type: 'command', command: cmd('stop', rec), timeout: 10000 }] }]);
        n.hooks = setHooks(c.hooks, ['BeforeAgent', 'AfterTool', 'AfterAgent'], entries);
      }
      return n;
    });
    if (mcp) done.push('Gemini CLI: registered MCP server in .gemini/settings.json');
    if (hooks) done.push(`Gemini CLI: hooks in .gemini/settings.json: notes injected on each prompt${late ? ', file-keyed notes while working' : ''}${learned}`);
    if (!shared && (mcp || hooks)) excludeLocally(repo, ['.gemini/settings.json']);
  }

  if (client === 'cursor') {
    const generated = [];
    // Cursor cannot take context at prompt time, so MCP is the primary route when enabled.
    if (mcp) {
      mergeJson(path.join(repo, '.cursor', 'mcp.json'), c => ({ ...c, mcpServers: { ...(c.mcpServers || {}), thinker: mcpEntry } }));
      const rule = path.join(repo, '.cursor', 'rules', 'thinker.mdc');
      fs.mkdirSync(path.dirname(rule), { recursive: true });
      fs.writeFileSync(rule, CURSOR_RULE);
      done.push('Cursor: registered MCP server in .cursor/mcp.json and added the rule .cursor/rules/thinker.mdc');
      generated.push('.cursor/mcp.json', '.cursor/rules/thinker.mdc');
    }
    if (hooks) {
      const file = path.join(repo, '.cursor', 'hooks.json');
      const entries = [
        ['beforeSubmitPrompt', { command: cmd('prompt', rec), timeout: 15 }],
        ['postToolUse', { command: cmd('tool', (late ? ' --late' : '') + rec), timeout: 10 }],
      ];
      // the editor ends a turn with `stop`; the CLI (agent -p) fires only sessionEnd,
      // and reports shell output in afterShellExecution
      if (learn) entries.push(['afterShellExecution', { command: cmd('tool', rec), timeout: 10 }], ['stop', { command: cmd('stop', rec), timeout: 10 }], ['sessionEnd', { command: cmd('stop', rec), timeout: 10 }]);
      mergeJson(file, c => ({ version: 1, ...c, hooks: setHooks(c.hooks, ['beforeSubmitPrompt', 'postToolUse', 'afterShellExecution', 'stop', 'sessionEnd'], entries) }));
      done.push(`Cursor: hooks in .cursor/hooks.json: notes for the request are delivered after the agent's first tool call${late ? ', then file-keyed notes while working' : ''}${learned}`);
      generated.push('.cursor/hooks.json');
    }
    if (!shared) excludeLocally(repo, generated);
  }
  return done;
}

// Remove everything installClient wrote for any client.
export function uninstallClients(repo) {
  untrustCodexHooks(repo);
  const stripHooks = (file, keepVersion) => {
    if (!fs.existsSync(file)) return;
    mergeJson(file, c => {
      const hooks = { ...(c.hooks || {}) };
      for (const ev of Object.keys(hooks)) { hooks[ev] = (hooks[ev] || []).filter(h => !isOurs(h)); if (!hooks[ev].length) delete hooks[ev]; }
      const n = { ...c, hooks };
      if (!Object.keys(hooks).length) delete n.hooks;
      if (n.mcpServers?.thinker) { n.mcpServers = { ...n.mcpServers }; delete n.mcpServers.thinker; if (!Object.keys(n.mcpServers).length) delete n.mcpServers; }
      return n;
    });
    const left = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Object.keys(left).filter(k => !(keepVersion && k === 'version')).length) fs.unlinkSync(file);
  };
  for (const f of ['.claude/settings.json', '.claude/settings.local.json', '.codex/hooks.json', '.gemini/settings.json']) stripHooks(path.join(repo, f));
  stripHooks(path.join(repo, '.cursor', 'hooks.json'), true);
  for (const f of ['.mcp.json', '.cursor/mcp.json']) {
    const file = path.join(repo, f); if (!fs.existsSync(file)) continue;
    mergeJson(file, c => { const m = { ...(c.mcpServers || {}) }; delete m.thinker; return { ...c, mcpServers: m }; });
    const left = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Object.keys(left).length === 1 && !Object.keys(left.mcpServers).length) fs.unlinkSync(file);
  }
  const toml = path.join(repo, '.codex', 'config.toml');
  if (fs.existsSync(toml)) { const t = stripTomlBlock(fs.readFileSync(toml, 'utf8')); if (t.trim()) fs.writeFileSync(toml, t); else fs.unlinkSync(toml); }
  fs.rmSync(path.join(repo, '.cursor', 'rules', 'thinker.mdc'), { force: true });
}
