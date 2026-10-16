// Session transcripts: found where each agent CLI writes them, copied (gzipped) into the run's own
// folder so they outlive the CLI's cleanup (Claude Code deletes project transcripts after its cleanup
// period), and parsed into one list of steps for the session page.
//   Claude Code  ~/.claude/projects/<cwd>/<session>.jsonl
//   Codex        bench/runs/<tag>/events/<id>.jsonl (codex-run.js writes the exec event stream)
//   Gemini       ~/.gemini/antigravity-cli/brain/<session>/.system_generated/logs/transcript.jsonl
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const HOME = os.homedir();
export const archivePath = (runsDir, run, id) => path.join(runsDir, run, 'transcripts', `${id}.jsonl.gz`);
const idOf = row => row.id.slice(row.run.length + 1);

// The original transcript of a result, or null. `projects` is the list of Claude Code project dirs.
export function locate(runsDir, row, raw, projects) {
  const session = raw?.session || raw?.session_id;
  const events = path.join(runsDir, row.run, 'events', idOf(row) + '.jsonl');
  if (fs.existsSync(events)) return { file: events, format: 'codex' };
  if (!session) return null;
  for (const p of projects) {
    const f = path.join(HOME, '.claude', 'projects', p, session + '.jsonl');
    if (fs.existsSync(f)) return { file: f, format: 'claude' };
  }
  const g = path.join(HOME, '.gemini', 'antigravity-cli', 'brain', session, '.system_generated', 'logs', 'transcript.jsonl');
  if (fs.existsSync(g)) return { file: g, format: 'gemini' };
  return null;
}

export function claudeProjects() {
  try { return fs.readdirSync(path.join(HOME, '.claude', 'projects')); } catch { return []; }
}

// Copy every result's transcript that is not archived yet. Returns { archived, missing }.
export async function archiveAll(runsDir, rows, readRaw, { tried = new Set(), yieldEvery = 20 } = {}) {
  const projects = claudeProjects();
  let archived = 0, missing = 0, n = 0;
  for (const row of rows) {
    if (tried.has(row.id)) continue;
    const dest = archivePath(runsDir, row.run, idOf(row));
    if (fs.existsSync(dest)) { tried.add(row.id); continue; }
    const src = locate(runsDir, row, readRaw(row), projects);
    tried.add(row.id);
    if (!src) { missing++; continue; }
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = dest + '.tmp';
      fs.writeFileSync(tmp, zlib.gzipSync(fs.readFileSync(src.file)));
      fs.writeFileSync(dest.replace(/\.jsonl\.gz$/, '.source.json'), JSON.stringify({ format: src.format, from: src.file, archived_at: Date.now() }) + '\n');
      fs.renameSync(tmp, dest);
      archived++;
    } catch { missing++; }
    if (++n % yieldEvery === 0) await new Promise(r => setImmediate(r));
  }
  return { archived, missing };
}

export function readTranscript(runsDir, row, raw) {
  const dest = archivePath(runsDir, row.run, idOf(row));
  let text = null, format = null, archived = false;
  if (fs.existsSync(dest)) {
    text = zlib.gunzipSync(fs.readFileSync(dest)).toString('utf8'); archived = true;
    try { format = JSON.parse(fs.readFileSync(dest.replace(/\.jsonl\.gz$/, '.source.json'), 'utf8')).format; } catch {}
  } else {
    const src = locate(runsDir, row, raw, claudeProjects());
    if (src) { text = fs.readFileSync(src.file, 'utf8'); format = src.format; }
  }
  if (text == null) return null;
  const lines = text.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  format ||= lines.some(l => l.type === 'thread.started' || l.type === 'item.completed') ? 'codex' : lines.some(l => l.message?.content) ? 'claude' : 'gemini';
  const steps = format === 'claude' ? parseClaude(lines) : format === 'codex' ? parseCodex(lines) : parseGeneric(lines);
  return { format, archived, bytes: Buffer.byteLength(text), steps };
}

const MAX = 6000;
const clip = s => { const t = typeof s === 'string' ? s : JSON.stringify(s, null, 1); return t && t.length > MAX ? t.slice(0, MAX) + `\n… (${t.length - MAX} more characters)` : t; };
const isThinker = s => /thinker|<thinker-cache>|Cached notes about|Cached knowledge for this task/.test(s || '');
const blockText = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : '')).join('\n') : '');

// Steps: { kind: user | assistant | thinking | tool | system, name?, text?, input?, output?, error?, ts?, thinker?, usage? }
export function parseClaude(lines) {
  const steps = [], byId = new Map();
  for (const l of lines) {
    const ts = l.timestamp ? Date.parse(l.timestamp) : null;
    if (l.type === 'assistant' && Array.isArray(l.message?.content)) {
      const usage = l.message.usage ? { in: (l.message.usage.input_tokens || 0) + (l.message.usage.cache_read_input_tokens || 0) + (l.message.usage.cache_creation_input_tokens || 0), out: l.message.usage.output_tokens || 0 } : null;
      let first = true;
      for (const b of l.message.content) {
        const u = first ? usage : null; first = false;
        if (b.type === 'text' && b.text?.trim()) steps.push({ kind: 'assistant', text: clip(b.text), ts, usage: u });
        else if (b.type === 'thinking' && b.thinking?.trim()) steps.push({ kind: 'thinking', text: clip(b.thinking), ts, usage: u });
        else if (b.type === 'tool_use') {
          const s = { kind: 'tool', name: b.name, input: clip(b.input), ts, usage: u, thinker: /thinker/.test(b.name) };
          steps.push(s); byId.set(b.id, s);
        }
      }
    } else if (l.type === 'user' && l.message) {
      const c = l.message.content;
      if (Array.isArray(c) && c.some(b => b.type === 'tool_result')) {
        for (const b of c.filter(x => x.type === 'tool_result')) {
          const s = byId.get(b.tool_use_id), out = blockText(b.content);
          if (s) { s.output = clip(out); s.error = Boolean(b.is_error); if (isThinker(out)) s.thinker = true; }
        }
      } else {
        const text = blockText(c);
        if (text.trim()) steps.push({ kind: l.isMeta ? 'system' : 'user', text: clip(text), ts, thinker: isThinker(text) });
      }
    } else if (l.type === 'attachment' || l.type === 'system') {
      const text = l.attachment?.content ?? l.attachment?.text ?? l.content;
      if (typeof text === 'string' && text.trim()) steps.push({ kind: 'system', name: l.attachment?.type || l.subtype || 'system', text: clip(text), ts, thinker: isThinker(text) });
    }
  }
  return steps;
}

export function parseCodex(lines) {
  const steps = [];
  for (const l of lines) {
    if (l.type === 'turn.completed' && l.usage) { steps.push({ kind: 'system', name: 'turn completed', text: `input ${l.usage.input_tokens ?? '?'} (cached ${l.usage.cached_input_tokens ?? 0}) · output ${l.usage.output_tokens ?? '?'}` }); continue; }
    if (l.type === 'error' || l.type === 'turn.failed') { steps.push({ kind: 'system', name: l.type, text: clip(l.message || l.error), error: true }); continue; }
    if (l.type !== 'item.completed' || !l.item) continue;
    const it = l.item;
    if (it.type === 'agent_message') steps.push({ kind: 'assistant', text: clip(it.text) });
    else if (it.type === 'reasoning') steps.push({ kind: 'thinking', text: clip(it.text) });
    else if (it.type === 'command_execution') steps.push({ kind: 'tool', name: 'shell', input: clip(it.command), output: clip(it.aggregated_output), error: it.exit_code ? true : false });
    else if (it.type === 'mcp_tool_call') steps.push({ kind: 'tool', name: `${it.server}.${it.tool}`, input: clip(it.arguments), output: clip(blockText(it.result?.content) || it.error), error: Boolean(it.error), thinker: it.server === 'thinker' });
    else if (it.type === 'file_change') steps.push({ kind: 'tool', name: 'edit', input: clip((it.changes || []).map(c => `${c.kind} ${c.path}`).join('\n')) });
    else steps.push({ kind: 'system', name: it.type, text: clip(it) });
  }
  return steps;
}

export function parseGeneric(lines) {
  return lines.map(l => {
    const text = l.text || l.content || l.message?.content;
    return typeof text === 'string' ? { kind: /model|assistant/i.test(l.role || l.type || '') ? 'assistant' : 'system', name: l.type || l.role, text: clip(text), thinker: isThinker(text) }
      : { kind: 'system', name: l.type || 'event', text: clip(l) };
  });
}

// High-level figures for the session sidebar, from the steps.
export function stepStats(steps) {
  const tools = steps.filter(s => s.kind === 'tool');
  const byTool = {};
  for (const t of tools) byTool[t.name] = (byTool[t.name] || 0) + 1;
  const firstEdit = tools.findIndex(t => /^(Edit|Write|MultiEdit|edit|replace_file_content|write_to_file|NotebookEdit)$/.test(t.name));
  const ts = steps.map(s => s.ts).filter(Boolean);
  return {
    steps: steps.length, tool_calls: tools.length, tool_errors: tools.filter(t => t.error).length, by_tool: byTool,
    calls_before_first_edit: firstEdit < 0 ? null : firstEdit, thinker_steps: steps.filter(s => s.thinker).length,
    assistant_messages: steps.filter(s => s.kind === 'assistant').length, span_ms: ts.length > 1 ? Math.max(...ts) - Math.min(...ts) : null,
  };
}
