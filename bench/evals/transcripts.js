// Session transcripts: found where each agent CLI writes them, stored gzipped in the evals database
// (they outlive the CLI's cleanup: Claude Code deletes project transcripts after its cleanup period),
// checked for contamination, and parsed into one list of steps for the session page.
//   Claude Code  ~/.claude/projects/<cwd>/<session>.jsonl
//   Codex        bench/runs/<tag>/events/<id>.jsonl (codex-run.js writes the exec event stream)
//   Gemini       ~/.gemini/antigravity-cli/brain/<session>/.system_generated/logs/transcript.jsonl
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const HOME = os.homedir();
const idOf = row => row.id.slice(row.run.length + 1);
// the folder an earlier version of the app archived transcripts into; imported, then removed
const legacyArchive = (runsDir, row) => path.join(runsDir, row.run, 'transcripts', `${idOf(row)}.jsonl.gz`);

// What a transcript must not contain: text the product shows a person, not a benchmark arm. The
// warm-up offer (repo-onboard.js) tells the agent to stop and ask the user (2026-10-15 smoke run).
const CONTAMINATION = [[/<thinker-new-repository>/, 'warm-up offer injected into the session (onboarding notice, not the cache)']];

export function claudeProjects() {
  try { return fs.readdirSync(path.join(HOME, '.claude', 'projects')); } catch { return []; }
}

// The original transcript of a result, or null. `projects` is the list of Claude Code project dirs.
export function locate(runsDir, row, raw, projects) {
  const legacy = legacyArchive(runsDir, row);
  if (fs.existsSync(legacy)) {
    let format = null; try { format = JSON.parse(fs.readFileSync(legacy.replace(/\.jsonl\.gz$/, '.source.json'), 'utf8')).format; } catch {}
    return { file: legacy, format, gz: true };
  }
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

const guessFormat = text => (/"type":"thread\.started"|"type":"item\.completed"/.test(text) ? 'codex' : /"message":\{/.test(text) ? 'claude' : 'gemini');

// Store every result's transcript that the database does not hold yet. Returns { archived, missing, flagged }.
export async function archiveAll(db, runsDir, { tried = new Set(), yieldEvery = 20 } = {}) {
  const projects = claudeProjects();
  const rows = db.all('SELECT r.id, r.run, r.invalid FROM results r LEFT JOIN transcripts t ON t.id = r.id WHERE t.id IS NULL');
  let archived = 0, missing = 0, flagged = 0, n = 0;
  for (const row of rows) {
    if (tried.has(row.id)) continue;
    tried.add(row.id);
    const src = locate(runsDir, row, db.record(row.id), projects);
    if (!src) { missing++; continue; }
    try {
      const buf = fs.readFileSync(src.file);
      const text = (src.gz ? zlib.gunzipSync(buf) : buf).toString('utf8');
      const flags = CONTAMINATION.filter(([re]) => re.test(text)).map(([, why]) => why);
      db.run('INSERT OR REPLACE INTO transcripts (id, format, data, bytes, source, archived_at, flags) VALUES (?,?,?,?,?,?,?)',
        row.id, src.format || guessFormat(text), src.gz ? buf : zlib.gzipSync(text), Buffer.byteLength(text), src.file, Date.now(), flags.length ? JSON.stringify(flags) : null);
      // a contaminated session is not a measurement: fail it closed, with the reason
      if (flags.length && !row.invalid) { db.run('UPDATE results SET invalid = ? WHERE id = ?', flags[0], row.id); flagged++; }
      if (src.gz) { fs.rmSync(src.file, { force: true }); fs.rmSync(src.file.replace(/\.jsonl\.gz$/, '.source.json'), { force: true }); try { fs.rmdirSync(path.dirname(src.file)); } catch {} }
      archived++;
    } catch { missing++; }
    if (++n % yieldEvery === 0) await new Promise(r => setImmediate(r));
  }
  if (flagged) for (const { run } of db.all('SELECT DISTINCT run FROM results WHERE invalid LIKE ?', 'warm-up offer%')) db.refreshRun(run);
  return { archived, missing, flagged };
}

export function readTranscript(db, runsDir, row, raw) {
  const t = db.get('SELECT format, data, flags FROM transcripts WHERE id = ?', row.id);
  let text = null, format = null, stored = false, flags = null;
  if (t) { text = zlib.gunzipSync(t.data).toString('utf8'); format = t.format; stored = true; flags = t.flags ? JSON.parse(t.flags) : null; }
  else {
    const src = locate(runsDir, row, raw, claudeProjects());
    if (src) { const buf = fs.readFileSync(src.file); text = (src.gz ? zlib.gunzipSync(buf) : buf).toString('utf8'); format = src.format; }
  }
  if (text == null) return null;
  const lines = text.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  format ||= guessFormat(text);
  const steps = format === 'claude' ? parseClaude(lines) : format === 'codex' ? parseCodex(lines) : parseGeneric(lines);
  return { format, archived: stored, bytes: Buffer.byteLength(text), steps, flags };
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
