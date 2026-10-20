// What tool results cost a session: a result stays in the conversation, so every model call after it reads it
// again. Per session and per tool (Read, Bash, Grep, an MCP server…): the calls, the tokens the results added, and
// the input tokens they cost, each result's tokens times the model calls left after it. An estimate: tokens are
// characters / 4, the calls left are the tool calls left scaled to the session's model calls (several tool calls can
// share one), and a compaction, which drops old results, is not seen. For the Context tab (context-view.js).
// Kept per session in .thinker/state/tool-outputs.json, by the transcript's size.
import fs from 'node:fs';
import path from 'node:path';
import { parseTranscript } from './transcripts.js';

const KEEP = 1000, VERSION = 2;
// one row per tool, an MCP server's tools as one
export const toolKey = name => { const m = String(name).match(/^mcp__(.+?)__/); return m ? `mcp:${m[1]}` : String(name || 'unknown'); };

// `turns`: the session's model calls, when the transcript counts them; the calls left after a result are its share of
// those (agents make several tool calls in one model call), else one a tool call
export function sessionOutputs(events, turns = 0) {
  const tools = events.filter(e => e.t === 'tool'), n = tools.length, by = {};
  const scale = turns > 0 && n > 0 ? Math.min(1, turns / (n + 1)) : 1;
  tools.forEach((e, i) => {
    const tokens = Math.ceil(String(e.result || '').length / 4), r = (by[toolKey(e.name)] ||= { calls: 0, tokens: 0, input: 0 });
    r.calls++; r.tokens += tokens; r.input += Math.round(tokens * Math.max(1, (n - i) * scale));
  });
  return by;
}

const stateFile = store => path.join(store.dir, 'state', 'tool-outputs.json');
export function toolOutputs(store, sessions) {
  let st = {}; try { st = JSON.parse(fs.readFileSync(stateFile(store), 'utf8')); } catch {}
  const recs = [];
  let changed = false;
  for (const s of sessions) {
    let size = 0; try { size = fs.statSync(s.file).size; } catch { continue; }
    let r = st[s.session];
    if (!r || r.size !== size || r.v !== VERSION) {
      let parsed; try { parsed = parseTranscript(s.file); } catch { continue; }
      r = st[s.session] = { v: VERSION, size, mtime: s.mtime, by: sessionOutputs(parsed.events, parsed.stats?.turns || 0) };
      changed = true;
    }
    if (Object.keys(r.by).length) recs.push({ ...r, t: s.mtime });
  }
  if (changed) {
    const ids = Object.keys(st).sort((a, b) => (st[a].mtime || 0) - (st[b].mtime || 0));
    for (const id of ids.slice(0, Math.max(0, ids.length - KEEP))) delete st[id];
    try { fs.mkdirSync(path.dirname(stateFile(store)), { recursive: true }); fs.writeFileSync(stateFile(store), JSON.stringify(st)); } catch {}
  }
  // per tool, averaged over the sessions that made any tool call
  const n = recs.length, rows = new Map();
  for (const r of recs) for (const [k, x] of Object.entries(r.by)) {
    const row = rows.get(k) || { name: k, sessions: 0, calls: 0, tokens: 0, input: 0 };
    row.sessions++; row.calls += x.calls; row.tokens += x.tokens; row.input += x.input; rows.set(k, row);
  }
  const tools = [...rows.values()].map(r => ({ name: r.name, usedIn: r.sessions, calls: r.calls / (n || 1), tokens: Math.round(r.tokens / (n || 1)), perSession: Math.round(r.input / (n || 1)), perCall: Math.round(r.tokens / (r.calls || 1)) })).sort((a, b) => b.perSession - a.perSession);
  return {
    sessions: n, tools,
    tokens: tools.reduce((a, t) => a + t.tokens, 0), perSession: tools.reduce((a, t) => a + t.perSession, 0),
    timeline: recs.map(r => ({ t: r.t, outputs: Object.values(r.by).reduce((a, x) => a + x.input, 0) })),
  };
}
