// Session transcripts from any agent, normalized to the events the distiller
// reads:
//   { t: 'prompt', text } | { t: 'say', text } | { t: 'tool', name, input, result }
// Tool names and inputs are mapped to one vocabulary (Read, Grep, Glob, Bash,
// Edit, Write; file_path, pattern, command), whatever the agent calls them.
//
// Formats, detected from the content:
//   events  thinker's own trace, one event per line (written by the hooks, or
//           by any integration: see recordEvent). Works for every agent.
//   claude  Claude Code session JSONL
//   codex   Codex rollout JSONL (~/.codex/sessions/...), and `codex exec --json` output
//   cursor  Cursor agent transcript JSONL (tool calls without their results)
//   gemini  Gemini CLI session JSON
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const TOOL_NAMES = [
  [/^(read|read_file|read_many_files|view|cat|readfile)$/i, 'Read'],
  [/^(grep|search_file_content|grep_search|rg|search|codebase_search|semanticsearch)$/i, 'Grep'],
  [/^(glob|list_directory|ls|list_dir|file_search|find)$/i, 'Glob'],
  [/^(bash|shell|run_shell_command|exec|exec_command|local_shell|run_terminal_cmd|run_command|command_execution|terminal)$/i, 'Bash'],
  [/^(edit|replace|str_replace|strreplace|apply_patch|search_replace|multiedit|file_change|edit_file)$/i, 'Edit'],
  [/^(write|write_file|create_file)$/i, 'Write'],
];
export function toolName(name) {
  const n = String(name || '');
  for (const [re, canon] of TOOL_NAMES) if (re.test(n)) return canon;
  return n.replace(/^mcp_+thinker_+/, 'mcp__thinker__');
}

const first = (o, keys) => { for (const k of keys) if (o[k] != null && o[k] !== '') return o[k]; };
export function toolInput(name, input) {
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = name === 'Bash' ? { command: input } : { input }; } }
  if (!input || typeof input !== 'object') return {};
  const out = { ...input };
  const file = first(input, ['file_path', 'absolute_path', 'path', 'target_file', 'filePath', 'file']);
  if (file && typeof file === 'string') out.file_path = file;
  const cmd = first(input, ['command', 'cmd', 'script']);
  if (cmd) out.command = Array.isArray(cmd) ? cmd.join(' ') : String(cmd);
  const pat = first(input, ['pattern', 'query', 'glob_pattern', 'regex']);
  if (pat) out.pattern = String(pat);
  if (name === 'Glob' && !out.pattern && file) out.pattern = file;
  if (name === 'Edit') { out.old_string ??= first(input, ['old_string', 'old_str', 'old_text']) ?? ''; out.new_string ??= first(input, ['new_string', 'new_str', 'new_text', 'patch', 'input']) ?? ''; }
  return out;
}
export function textOf(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(textOf).filter(Boolean).join('\n');
  if (typeof v === 'object') {
    const t = first(v, ['text', 'output', 'stdout', 'aggregated_output', 'content', 'result', 'llmContent', 'returnDisplay', 'message']);
    if (t != null) return textOf(t);
    return JSON.stringify(v);
  }
  return String(v);
}
const tool = (name, input, result, id) => { const n = toolName(name); return { t: 'tool', id, name: n, input: toolInput(n, input), result: textOf(result) }; };
// what agents wrap around the user's words
const cleanPrompt = s => String(s || '').replace(/<(timestamp|environment_context|system-reminder|thinker-cache)>[\s\S]*?<\/\1>/g, '').replace(/<\/?user_query>/g, '').trim();

function jsonLines(text) {
  return text.split('\n').map(l => { if (!l.trim()) return null; try { return JSON.parse(l); } catch { return null; } });
}

export function detectFormat(text) {
  const head = text.trimStart();
  if (head.startsWith('{') && !/^\{.*\}\s*$/m.test(head.split('\n')[0])) { try { const j = JSON.parse(text); if (j && (j.messages || j.history)) return 'gemini'; } catch {} }
  for (const j of jsonLines(text.slice(0, 200_000)).filter(Boolean).slice(0, 40)) {
    if (j.t === 'prompt' || j.t === 'say' || j.t === 'tool') return 'events';
    if (j.type === 'session_meta' || j.type === 'response_item' || j.type === 'event_msg' || j.type === 'thread.started' || /^(item|turn)\./.test(j.type || '')) return 'codex';
    if ((j.type === 'user' || j.type === 'assistant') && j.message) return 'claude';
    if (j.type === 'message' && j.role) return 'claude';
    if ((j.role === 'user' || j.role === 'assistant') && j.message) return 'cursor';
    if (j.messages || j.history) return 'gemini';
  }
  return 'claude';
}

function attachResults(events, results) {
  for (const e of events) if (e.t === 'tool' && !e.result && e.id != null) e.result = results.get(e.id) || '';
  return events;
}

// Claude Code and Cursor share the Anthropic message shape; Cursor puts the role at the top level.
function parseMessages(rows, fromLine) {
  const events = [], results = new Map();
  let cwd = null;
  rows.forEach((j, i) => {
    if (!j || i < fromLine) return;
    if (j.cwd && !cwd) cwd = j.cwd;
    // streamed output of headless runs: Cursor `agent -p`, Gemini `gemini -p`
    if (j.type === 'tool_call' && j.tool_call) {
      if (j.subtype !== 'completed') return;
      const [key, call] = Object.entries(j.tool_call).find(([, v]) => v && typeof v === 'object' && ('args' in v || 'result' in v)) || [];
      if (key) events.push(tool(key.replace(/ToolCall$/, ''), call.args, call.result?.success ?? call.result?.error ?? call.result));
      return;
    }
    if (j.type === 'tool_use' && (j.tool_name || j.name)) { events.push(tool(j.tool_name || j.name, j.parameters ?? j.input, '', j.tool_id ?? j.id)); return; }
    if (j.type === 'tool_result') { results.set(j.tool_id ?? j.tool_use_id, textOf(j.output ?? j.content)); return; }
    if (j.type === 'message' && typeof j.content === 'string') {
      if (j.role === 'user') events.push({ t: 'prompt', text: cleanPrompt(j.content) });
      else if (j.delta && events.at(-1)?.t === 'say') events.at(-1).text += j.content;
      else events.push({ t: 'say', text: j.content });
      return;
    }
    const role = j.type === 'user' || j.type === 'assistant' ? j.type : j.role;
    if (role !== 'user' && role !== 'assistant') return;
    const c = j.message?.content;
    if (typeof c === 'string') { if (role === 'user' && !j.isMeta) events.push({ t: 'prompt', text: cleanPrompt(c) }); else if (role === 'assistant') events.push({ t: 'say', text: c }); return; }
    if (!Array.isArray(c)) return;
    for (const b of c) {
      if (b.type === 'text' && role === 'user' && !j.isMeta) events.push({ t: 'prompt', text: cleanPrompt(b.text) });
      else if (b.type === 'text' && role === 'assistant') events.push({ t: 'say', text: b.text });
      else if (b.type === 'tool_use') events.push(tool(b.name, b.input, '', b.id));
      else if (b.type === 'tool_result') results.set(b.tool_use_id, textOf(b.content));
    }
  });
  return { events: attachResults(events, results), cwd };
}

function parseCodex(rows, fromLine) {
  const events = [], results = new Map();
  let cwd = null;
  const seenPrompts = new Set();
  const prompt = text => { const t = cleanPrompt(text); if (t && !seenPrompts.has(t)) { seenPrompts.add(t); events.push({ t: 'prompt', text: t }); } };
  rows.forEach((j, i) => {
    if (!j) return;
    const p = j.payload || {};
    if (j.type === 'session_meta' && p.cwd) cwd = p.cwd;
    if (i < fromLine) return;
    // rollout files
    if (j.type === 'event_msg' && p.type === 'item_completed' && p.item?.type === 'UserMessage') prompt(textOf(p.item.content));
    else if (j.type === 'event_msg' && p.type === 'user_message') prompt(p.message);
    else if (j.type === 'response_item') {
      if (p.type === 'message' && p.role === 'assistant') { const t = textOf(p.content); if (t) events.push({ t: 'say', text: t }); }
      else if (p.type === 'message' && p.role === 'user') { const t = textOf(p.content); if (!/^<(environment_context|user_instructions|skills_instructions)/.test(t.trim())) prompt(t); }
      else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
        const input = p.arguments ?? p.input ?? p.action ?? {};
        if (p.name === 'wait' || p.name === 'update_plan') return;
        events.push(tool(p.name || 'shell', input, '', p.call_id));
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output' || p.type === 'local_shell_call_output') results.set(p.call_id, textOf(p.output));
    }
    // `codex exec --json` stream
    else if (j.type === 'item.completed' && j.item) {
      const it = j.item;
      if (it.type === 'agent_message') events.push({ t: 'say', text: it.text || '' });
      else if (it.type === 'command_execution') events.push(tool('shell', { command: it.command }, it.aggregated_output ?? it.output));
      else if (it.type === 'file_change') events.push(tool('apply_patch', { file_path: (it.changes || []).map(c => c.path).join(', ') }, it.status));
      else if (it.type === 'mcp_tool_call') events.push(tool(`mcp__${it.server}__${it.tool}`, it.arguments, it.result ?? it.error));
    }
  });
  return { events: attachResults(events, results), cwd };
}

function parseGemini(j, fromLine) {
  const events = [];
  const msgs = j.messages || j.history || [];
  msgs.forEach((m, i) => {
    if (i < fromLine) return;
    const role = m.type || m.role;
    const text = textOf(m.content ?? m.parts ?? m.text);
    if (role === 'user') { const t = cleanPrompt(text); if (t) events.push({ t: 'prompt', text: t }); }
    else {
      for (const c of m.toolCalls || []) events.push(tool(c.name, c.args ?? c.input, c.result ?? c.resultDisplay ?? c.output, c.id));
      if (text) events.push({ t: 'say', text });
    }
  });
  return { events, cwd: j.projectPath || j.cwd || null, count: msgs.length };
}

function parseEvents(rows, fromLine) {
  const events = [];
  let cwd = null;
  rows.forEach((j, i) => {
    if (!j) return;
    if (j.cwd && !cwd) cwd = j.cwd;
    if (i < fromLine) return;
    if (j.t === 'prompt') { const t = cleanPrompt(j.text); if (t) events.push({ t: 'prompt', text: t }); }
    else if (j.t === 'say' && j.text) events.push({ t: 'say', text: String(j.text) });
    else if (j.t === 'tool') events.push(tool(j.name, j.input, j.result));
  });
  return { events, cwd };
}

// fromLine counts lines (or messages, for Gemini's single JSON document);
// lineCount is where the next incremental read should start.
export function parseTranscript(file, { fromLine = 0, format } = {}) {
  const text = fs.readFileSync(file, 'utf8');
  const fmt = format && format !== 'auto' ? format : detectFormat(text);
  if (fmt === 'gemini') { let j = {}; try { j = JSON.parse(text); } catch {} const r = parseGemini(j, fromLine); return { events: r.events, lineCount: r.count, cwd: r.cwd, format: fmt }; }
  const lines = text.split('\n');
  const rows = jsonLines(text);
  const r = fmt === 'codex' ? parseCodex(rows, fromLine) : fmt === 'events' ? parseEvents(rows, fromLine) : parseMessages(rows, fromLine);
  return { ...r, lineCount: lines.length, format: fmt };
}

// --- thinker's own trace -------------------------------------------------------
// One JSON event per line in .thinker/state/trace-<session>.jsonl. The hooks
// write it, so learning does not depend on any agent's transcript format.
const CAP = 6000;
const clip = s => { s = textOf(s); return s.length > CAP ? s.slice(0, CAP) + `…[+${s.length - CAP} chars]` : s; };
export const traceFile = (storeDir, session) => path.join(storeDir, 'state', `trace-${String(session).replace(/[^\w.-]/g, '_')}.jsonl`);
export function recordEvent(storeDir, session, ev) {
  const f = traceFile(storeDir, session);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const e = ev.t === 'tool' ? { t: 'tool', name: ev.name, input: ev.input, result: clip(ev.result) } : { t: ev.t, text: clip(ev.text) };
  if (e.t !== 'tool' && !e.text) return f;
  // the same final message can arrive from several hook events
  if (e.t === 'say') { try { const last = fs.readFileSync(f, 'utf8').trimEnd().split('\n').pop(); if (last && JSON.parse(last).text === e.text) return f; } catch {} }
  fs.appendFileSync(f, JSON.stringify({ ...e, at: new Date().toISOString() }) + '\n');
  return f;
}

// --- results the agent's record leaves out ----------------------------------------
// Cursor records tool calls without their output. Reads and searches can be
// repeated against the working tree, so the distiller still sees what the
// agent saw (as of now; a file edited since then shows its current text).
export function hydrate(events, repo, { trace } = {}) {
  // shell output the hooks recorded for this session, by command
  const shell = new Map();
  if (trace && fs.existsSync(trace)) for (const j of jsonLines(fs.readFileSync(trace, 'utf8'))) if (j?.t === 'tool' && j.name === 'Bash' && j.input?.command && j.result) shell.set(j.input.command, j.result);
  const inRepo = f => { const abs = path.resolve(repo, f); return abs.startsWith(path.resolve(repo) + path.sep) ? abs : null; };
  for (const e of events) {
    // only where the record has no output, or a summary of it in place of the output
    if (e.t !== 'tool' || (e.result && !/^\{".*"(content_length|success)":/.test(e.result))) continue;
    try {
      if (e.name === 'Bash' && shell.has(e.input.command)) { e.result = shell.get(e.input.command); e.hydrated = true; }
      else if (e.name === 'Read' && e.input.file_path) {
        const abs = inRepo(e.input.file_path); if (!abs || !fs.statSync(abs).isFile()) continue;
        const lines = fs.readFileSync(abs, 'utf8').split('\n');
        const from = Math.max(0, Number(e.input.offset ?? e.input.start_line ?? 1) - 1);
        e.result = lines.slice(from, from + Math.min(Number(e.input.limit) || 120, 120)).join('\n');
        e.hydrated = true;
      } else if (e.name === 'Grep' && e.input.pattern) {
        const dir = inRepo(e.input.file_path || '.') || path.resolve(repo);
        const r = spawnSync('git', ['grep', '-n', '-I', '-E', '--max-count', '8', '-e', e.input.pattern, '--', path.relative(repo, dir) || '.'], { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 24, timeout: 5000 });
        if (r.stdout) { e.result = r.stdout.split('\n').slice(0, 30).join('\n'); e.hydrated = true; }
      }
    } catch {}
  }
  return events;
}

// --- finding sessions ----------------------------------------------------------------
// Sessions any supported agent ran in this repository, newest first, plus
// traces recorded by the hooks for sessions that have no transcript.
export function findSessions(repo, { sinceMs = 14 * 86400_000, storeDir } = {}) {
  const home = os.homedir(), cutoff = Date.now() - sinceMs, out = [];
  const add = (client, file, session) => { try { const st = fs.statSync(file); if (st.isFile() && st.mtimeMs >= cutoff) out.push({ client, file, session, mtime: st.mtimeMs }); } catch {} };
  const ls = d => { try { return fs.readdirSync(d); } catch { return []; } };
  const real = (() => { try { return fs.realpathSync(repo); } catch { return repo; } })();
  for (const r of new Set([repo, real])) {
    const claude = path.join(home, '.claude', 'projects', r.replace(/[\/.]/g, '-'));
    for (const f of ls(claude)) if (f.endsWith('.jsonl')) add('claude', path.join(claude, f), f.slice(0, -6));
    const gemini = path.join(home, '.gemini', 'tmp', crypto.createHash('sha256').update(r).digest('hex'), 'chats');
    for (const f of ls(gemini)) if (f.endsWith('.json')) add('gemini', path.join(gemini, f), f.slice(0, -5));
  }
  // Cursor names project folders after the path (shortened with a hash when long);
  // the folder records the workspace it belongs to
  const roots = new Set([repo, real]);
  const slug = r => r.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const cursorRoot = path.join(home, '.cursor', 'projects');
  for (const d of ls(cursorRoot)) {
    let ws = null; try { ws = JSON.parse(fs.readFileSync(path.join(cursorRoot, d, '.workspace-trusted'), 'utf8')).workspacePath; } catch {}
    if (!(ws ? roots.has(ws) : [...roots].some(r => slug(r) === d))) continue;
    for (const id of ls(path.join(cursorRoot, d, 'agent-transcripts'))) add('cursor', path.join(cursorRoot, d, 'agent-transcripts', id, id + '.jsonl'), id);
  }
  // Codex files are by date, not by project: read the first line for the cwd
  const codexRoot = path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'sessions');
  for (let d = 0; d * 86400_000 <= sinceMs; d++) {
    const t = new Date(Date.now() - d * 86400_000);
    const dir = path.join(codexRoot, String(t.getFullYear()), String(t.getMonth() + 1).padStart(2, '0'), String(t.getDate()).padStart(2, '0'));
    for (const f of ls(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const fd = fs.openSync(path.join(dir, f), 'r'); const buf = Buffer.alloc(4096); const n = fs.readSync(fd, buf, 0, 4096, 0); fs.closeSync(fd);
        const cwd = (buf.toString('utf8', 0, n).match(/"cwd":"((?:[^"\\]|\\.)*)"/) || [])[1];
        const id = (f.match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/) || [])[1] || f.slice(0, -6);
        if (cwd && [repo, real].some(r => cwd === r || cwd.startsWith(r + '/'))) add('codex', path.join(dir, f), id);
      } catch {}
    }
  }
  if (storeDir) {
    const known = new Set(out.map(s => s.session));
    for (const f of ls(path.join(storeDir, 'state'))) { const m = f.match(/^trace-(.+)\.jsonl$/); if (m && !known.has(m[1])) add('trace', path.join(storeDir, 'state', f), m[1]); }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
