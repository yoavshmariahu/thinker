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
import { normalizeModelUsage } from './model-usage.js';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const TOOL_NAMES = [
  [/^(read|read_file|read_many_files|view|view_file|cat|readfile)$/i, 'Read'],
  [/^(grep|search_file_content|grep_search|rg|search|codebase_search|semanticsearch)$/i, 'Grep'],
  [/^(glob|list_directory|ls|list_dir|file_search|find)$/i, 'Glob'],
  [/^(bash|shell|run_shell_command|exec|exec_command|local_shell|run_terminal_cmd|run_command|command_execution|terminal)$/i, 'Bash'],
  [/^(edit|replace|replace_file_content|str_replace|strreplace|apply_patch|search_replace|multiedit|file_change|edit_file)$/i, 'Edit'],
  [/^(write|write_file|write_to_file|create_file|create)$/i, 'Write'],
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
  const file = first(input, ['file_path', 'absolute_path', 'AbsolutePath', 'path', 'target_file', 'TargetFile', 'filePath', 'file']);
  if (file && typeof file === 'string') out.file_path = file.replace(/^"|"$/g, '');
  const cmd = first(input, ['command', 'CommandLine', 'cmd', 'script']);
  if (cmd) out.command = (Array.isArray(cmd) ? cmd.join(' ') : String(cmd)).replace(/^"|"$/g, '');
  const pat = first(input, ['pattern', 'query', 'glob_pattern', 'regex']);
  if (pat) out.pattern = String(pat);
  if (name === 'Glob' && !out.pattern && file) out.pattern = file;
  if (name === 'Edit') { out.old_string ??= first(input, ['old_string', 'TargetContent', 'old_str', 'old_text']) ?? ''; out.new_string ??= first(input, ['new_string', 'ReplacementContent', 'new_str', 'new_text', 'patch', 'input']) ?? ''; }
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
    if (j.type === 'USER_INPUT' || j.type === 'PLANNER_RESPONSE') return 'agy';
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

// The model the session ran on, as the agent wrote it: the one most of its turns name. Counted
// over the whole file, not from `fromLine`, since a session's model rarely changes. Cursor's
// transcripts do not name one.
class ModelTally {
  constructor() { this.n = new Map(); }
  add(m) { if (typeof m === 'string' && m && m !== '<synthetic>') this.n.set(m, (this.n.get(m) || 0) + 1); }
  get model() { return [...this.n].sort((a, b) => b[1] - a[1])[0]?.[0] || null; }
}
// What the session cost, over the whole file: tool calls, model turns and the input tokens of every
// turn as the agent reported them (Claude Code and Cursor: message.usage; Codex: token_count
// events). Read by the stop hook into the `session` log line, for the holdout comparison in usage.js.
class Stats {
  constructor() { this.toolCalls = 0; this.turns = 0; this.inputTokens = null; this.outputTokens = null; this.cacheReadTokens = null; this.cacheWriteTokens = null; this.covered = 0; this.measured = 0; this.cumulative = false; }
  turn(usage, provider = 'anthropic') {
    this.turns++;
    if (!usage || typeof usage !== 'object') return;
    const t = normalizeModelUsage(provider, usage);
    this.measured++;
    if (t.totalTokens !== null) this.covered++;
    for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) if (t[k] !== null) this[k] = (this[k] || 0) + t[k];
  }
  total(usage) {
    const t = normalizeModelUsage('codex', usage);
    if (t.inputTokens === null && t.totalTokens === null) return;
    for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) this[k] = t[k];
    this.cumulative = true; this.measured = 1; this.covered = t.totalTokens !== null ? 1 : 0;
  }
  get value() {
    const complete = this.cumulative ? this.covered === 1 : this.turns > 0 && this.covered === this.turns;
    const totalTokens = this.inputTokens !== null && this.outputTokens !== null ? this.inputTokens + this.outputTokens : null;
    return { toolCalls: this.toolCalls, turns: this.turns, inputTokens: this.inputTokens, outputTokens: this.outputTokens, cacheReadTokens: this.cacheReadTokens, cacheWriteTokens: this.cacheWriteTokens, totalTokens, tokenCoverage: complete ? 'complete' : 'partial' };
  }
}

// Claude Code and Cursor share the Anthropic message shape; Cursor puts the role at the top level.
function parseMessages(rows, fromLine) {
  const events = [], results = new Map(), models = new ModelTally(), stats = new Stats(), messageUsage = new Map();
  let cwd = null;
  rows.forEach((j, i) => {
    if (!j) return;
    if (j.type === 'assistant' || j.role === 'assistant') models.add(j.message?.model ?? j.model);
    if (j.type === 'assistant' || j.role === 'assistant') { messageUsage.set(j.message?.id || j.id || `row-${i}`, j.message?.usage ?? j.usage); for (const b of Array.isArray(j.message?.content) ? j.message.content : []) if (b.type === 'tool_use') stats.toolCalls++; }
    if (i < fromLine) return;
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
  for (const usage of messageUsage.values()) stats.turn(usage);
  return { events: attachResults(events, results), cwd, model: models.model, stats: stats.value };
}

function parseCodex(rows, fromLine) {
  const events = [], results = new Map(), models = new ModelTally(), stats = new Stats();
  let cwd = null;
  const seenPrompts = new Set();
  const prompt = text => { const t = cleanPrompt(text); if (t && !seenPrompts.has(t)) { seenPrompts.add(t); events.push({ t: 'prompt', text: t }); } };
  rows.forEach((j, i) => {
    if (!j) return;
    const p = j.payload || {};
    if (j.type === 'session_meta' && p.cwd) cwd = p.cwd;
    if (j.type === 'turn_context' || j.type === 'session_meta') models.add(p.model);
    if (j.type === 'thread.started' || j.type === 'turn.started') models.add(j.model ?? j.thread?.model);
    if (j.type === 'turn.completed') stats.turn(j.usage, 'codex');
    if (j.type === 'event_msg' && p.type === 'token_count') stats.total(p.info?.total_token_usage);
    if (j.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call')) stats.toolCalls++;
    if (j.type === 'response_item' && p.type === 'message' && p.role === 'assistant') stats.turns++;
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
  return { events: attachResults(events, results), cwd, model: models.model, stats: stats.value };
}

function parseGemini(j, fromLine) {
  const events = [], models = new ModelTally(), stats = new Stats();
  const msgs = j.messages || j.history || [];
  models.add(j.model);
  msgs.forEach((m, i) => {
    const role = m.type || m.role;
    if (role !== 'user') { models.add(m.model); stats.turn(m.tokens || m.usage, 'gemini'); stats.toolCalls += (m.toolCalls || []).length; }
    if (i < fromLine) return;
    const text = textOf(m.content ?? m.parts ?? m.text);
    if (role === 'user') { const t = cleanPrompt(text); if (t) events.push({ t: 'prompt', text: t }); }
    else {
      for (const c of m.toolCalls || []) events.push(tool(c.name, c.args ?? c.input, c.result ?? c.resultDisplay ?? c.output, c.id));
      if (text) events.push({ t: 'say', text });
    }
  });
  return { events, cwd: j.projectPath || j.cwd || null, count: msgs.length, model: models.model, stats: stats.value };
}

function parseEvents(rows, fromLine) {
  const events = [], models = new ModelTally();
  let cwd = null;
  rows.forEach((j, i) => {
    if (!j) return;
    if (j.cwd && !cwd) cwd = j.cwd;
    models.add(j.model);
    if (i < fromLine) return;
    if (j.t === 'prompt') { const t = cleanPrompt(j.text); if (t) events.push({ t: 'prompt', text: t }); }
    else if (j.t === 'say' && j.text) events.push({ t: 'say', text: String(j.text) });
    else if (j.t === 'tool') events.push(tool(j.name, j.input, j.result));
  });
  return { events, cwd, model: models.model };
}

function parseAgy(rows, fromLine = 0) {
  const events = [];
  let pendingTool = null;
  let cwd = null;
  rows.forEach((j, i) => {
    if (!j) return;
    if (i < fromLine) return;
    if (j.type === 'USER_INPUT') {
      const clean = (j.content || '').replace(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/, '$1').replace(/<[^>]+>/g, '').trim();
      if (clean) events.push({ t: 'prompt', text: cleanPrompt(clean) });
    } else if (j.type === 'PLANNER_RESPONSE') {
      if (j.content) events.push({ t: 'say', text: String(j.content) });
      if (j.tool_calls && j.tool_calls.length) {
        for (const tc of j.tool_calls) {
          const ev = tool(tc.name, tc.args || {}, '');
          events.push(ev);
          pendingTool = ev;
        }
      }
    } else if (pendingTool && j.content) {
      pendingTool.result = String(j.content || '').slice(0, 6000);
      pendingTool = null;
    }
  });
  return { events, cwd };
}

// fromLine counts lines (or messages, for Gemini's single JSON document);
// lineCount is where the next incremental read should start. `model` is the model the
// session ran on when the transcript names it (Claude Code, Codex, Gemini), else null.
export function parseTranscript(file, { fromLine = 0, format } = {}) {
  const text = fs.readFileSync(file, 'utf8');
  const fmt = format && format !== 'auto' ? format : detectFormat(text);
  if (fmt === 'gemini') { let j = {}; try { j = JSON.parse(text); } catch {} const r = parseGemini(j, fromLine); return { events: r.events, lineCount: r.count, cwd: r.cwd, model: r.model, format: fmt }; }
  const lines = text.split('\n');
  const rows = jsonLines(text);
  const r = fmt === 'agy' ? parseAgy(rows, fromLine) : fmt === 'codex' ? parseCodex(rows, fromLine) : fmt === 'events' ? parseEvents(rows, fromLine) : parseMessages(rows, fromLine);
  return { model: null, ...r, lineCount: lines.length, format: fmt };
}

// The model of a session whose assessment did not record one (written before that was logged):
// found by its id among the agents' transcripts of the checkout. One listing per checkout.
const sessionIndex = new Map();
export function sessionModel(repo, session, { sinceMs = 90 * 86400_000 } = {}) {
  if (!repo || !session) return null;
  if (!sessionIndex.has(repo)) {
    const m = new Map();
    try { for (const s of findSessions(repo, { sinceMs })) m.set(String(s.session), s.file); } catch {}
    sessionIndex.set(repo, m);
  }
  const key = String(session).replace(/\.jsonl?$/, '').replace(/^trace-/, '');
  const file = sessionIndex.get(repo).get(key) || sessionIndex.get(repo).get((key.match(/([0-9a-f]{8}-[0-9a-f-]{27,})$/) || [])[1]);
  if (!file) return null;
  try { return parseTranscript(file).model; } catch { return null; }
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
