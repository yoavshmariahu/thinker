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
// Learning from sessions (Stop hook + distill) reads Claude Code transcripts
// and is only installed for claude.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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
  if (onPath('cursor') || onPath('cursor-agent') || fs.existsSync(home('.cursor'))) found.push('cursor');
  if (onPath('gemini') || fs.existsSync(home('.gemini'))) found.push('gemini');
  return found.length ? found : ['claude'];
}

// "--clients claude,codex" | "all" | "auto" → validated list
export function parseClients(value, fallback = ['claude']) {
  if (!value || value === true) return fallback;
  if (value === 'all') return [...CLIENTS];
  if (value === 'auto') return detectClients();
  const list = String(value).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
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
export function promptOutput(client, text) {
  if (client === 'gemini') return JSON.stringify({ hookSpecificOutput: { hookEventName: 'BeforeAgent', additionalContext: text } });
  return text;
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
- Use \`lookup\` for a specific question mid-task. Treat notes marked STALE as unverified.
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

  if (client === 'claude') {
    if (mcp) { mergeJson(path.join(repo, '.mcp.json'), c => ({ ...c, mcpServers: { ...(c.mcpServers || {}), thinker: mcpEntry } })); done.push('Claude Code: registered MCP server in .mcp.json'); }
    if (hooks) {
      const target = path.join(repo, '.claude', shared ? 'settings.json' : 'settings.local.json');
      const entries = [['UserPromptSubmit', { matcher: '', hooks: [{ type: 'command', command: `node "${cli}" hook prompt`, timeout: 15 }] }]];
      if (late) entries.push(['PostToolUse', { matcher: 'Read|Bash|Grep', hooks: [{ type: 'command', command: `node "${cli}" hook tool`, timeout: 10 }] }]);
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
        const block = [TOML_START, '[mcp_servers.thinker]', `command = ${tomlStr(mcpEntry.command)}`, `args = [${mcpEntry.args.map(tomlStr).join(', ')}]`, '', '[mcp_servers.thinker.env]', ...Object.entries(mcpEntry.env || {}).map(([k, v]) => `${k} = ${tomlStr(v)}`), TOML_END].join('\n');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, (cur.trim() ? cur.trimEnd() + '\n\n' : '') + block + '\n');
        done.push('Codex: registered MCP server in .codex/config.toml');
        generated.push('.codex/config.toml');
      }
    }
    if (hooks) {
      const file = path.join(repo, '.codex', 'hooks.json');
      const entries = [['UserPromptSubmit', { hooks: [{ type: 'command', command: cmd('prompt'), timeout: 15 }] }]];
      if (late) entries.push(['PostToolUse', { matcher: 'Bash', hooks: [{ type: 'command', command: cmd('tool'), timeout: 10 }] }]);
      mergeJson(file, c => ({ ...c, hooks: setHooks(c.hooks, ['UserPromptSubmit', 'PostToolUse', 'Stop'], entries) }));
      done.push(`Codex: hooks in .codex/hooks.json: notes injected on each prompt${late ? ', file-keyed notes while working' : ''}. Codex asks you to trust the project and review new hooks before they run`);
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
        if (late) entries.push(['AfterTool', { matcher: 'read_file|run_shell_command|search_file_content', hooks: [{ name: 'thinker-tool', type: 'command', command: cmd('tool'), timeout: 10000 }] }]);
        n.hooks = setHooks(c.hooks, ['BeforeAgent', 'AfterTool', 'AfterAgent'], entries);
      }
      return n;
    });
    if (mcp) done.push('Gemini CLI: registered MCP server in .gemini/settings.json');
    if (hooks) done.push(`Gemini CLI: hooks in .gemini/settings.json: notes injected on each prompt${late ? ', file-keyed notes while working' : ''}`);
    if (!shared && (mcp || hooks)) excludeLocally(repo, ['.gemini/settings.json']);
  }

  if (client === 'cursor') {
    const generated = [];
    // Cursor cannot take context at prompt time, so the MCP server and the rule are the main route.
    mergeJson(path.join(repo, '.cursor', 'mcp.json'), c => ({ ...c, mcpServers: { ...(c.mcpServers || {}), thinker: mcpEntry } }));
    const rule = path.join(repo, '.cursor', 'rules', 'thinker.mdc');
    fs.mkdirSync(path.dirname(rule), { recursive: true });
    fs.writeFileSync(rule, CURSOR_RULE);
    done.push('Cursor: registered MCP server in .cursor/mcp.json and added the rule .cursor/rules/thinker.mdc (approve the server in Cursor when asked)');
    generated.push('.cursor/mcp.json', '.cursor/rules/thinker.mdc');
    if (hooks) {
      const file = path.join(repo, '.cursor', 'hooks.json');
      const entries = [
        ['beforeSubmitPrompt', { command: cmd('prompt'), timeout: 15 }],
        ['postToolUse', { command: cmd('tool', late ? ' --late' : ''), timeout: 10 }],
      ];
      mergeJson(file, c => ({ version: 1, ...c, hooks: setHooks(c.hooks, ['beforeSubmitPrompt', 'postToolUse', 'stop'], entries) }));
      done.push(`Cursor: hooks in .cursor/hooks.json: notes for the request are delivered after the agent's first tool call${late ? ', then file-keyed notes while working' : ''}`);
      generated.push('.cursor/hooks.json');
    }
    if (!shared) excludeLocally(repo, generated);
  }
  return done;
}

// Remove everything installClient wrote for any client.
export function uninstallClients(repo) {
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
