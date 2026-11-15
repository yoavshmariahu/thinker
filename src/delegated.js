// What the delegation trigger kept out of a session's context, read back out of the session's own transcript when
// a turn ends (2026-11-15, the owner's call: "systematic post-processing on the session like we do for context
// cuts"). The clearing has rereads.js for this; a delegated read had only the firing's log row, a count of later
// calls taken from the proxy's log (nothing where the proxy is not in the path: a desktop app, a bench arm), and a
// guess at what the subagent paid (the same tokens at its write rate). All three are in the transcript.
//
// One rule: a delegated read saves its write once and its read on every later call of the lead, until a cut or a
// compaction would have taken it out anyway, less what the subagent that read it cost.
//
// Never overstated, so each doubt is settled against the figure:
//  - a firing whose file the lead then read whole itself kept nothing out, and counts nothing (`ignored`);
//  - the first later call is the one that would have written the read into the cache, so the reads start at the
//    second;
//  - the counting stops at the first cut after the firing, though the policy protects the newest results from that
//    cut: with the clearing on, the read would have left the prompt about then, and what leaves is the clearing's
//    to count, never both;
//  - the subagent is the host's own, found by its type and its start (the first one of the firing's agent type the
//    turn started after the denial); all of it is charged, its output and its own re-reads included. A subagent
//    the lead started unprompted is not delegation's cost and is not charged; nor is what it kept out counted.
import { RESULT_TOKENS_PER_CHAR } from './proxy.js';
import { filesReadBy, sameFile, resultChars } from './rereads.js';

const ms = v => (typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) || 0 : 0);

/**
 * `firings` are the session's real handoffs as the hook noted them (delegate.js:noteFiring: `{ t, tokens, files,
 * agent }`); `cuts` the clearing's cut times (rereads.js:cutTimesFor); `subagents` the session's own
 * (transcripts.js:subagentStats, each with the `at` it started). Returns null where nothing fired, else
 * `{ reads, tokens, laterTokens, ignored, agents }`: `tokens` is what was never written, `laterTokens` each read's
 * tokens times the calls it would have been read back on, `agents` the ids of the subagents that did the reading.
 */
export function delegatedOf({ events = [], calls = [] } = {}, firings = [], { cuts = [], subagents = [] } = {}) {
  const fired = (firings || []).filter(f => f && f.tokens > 0 && ms(f.t)).sort((a, b) => ms(a.t) - ms(b.t));
  if (!fired.length) return null;
  const lead = calls.filter(c => (c.agent || 'main') === 'main' && ms(c.t)).sort((a, b) => ms(a.t) - ms(b.t));
  // when a read would have left the prompt with no delegation at all: a cut, or the call after a compaction
  const ends = [...(cuts || []).map(ms), ...lead.filter(c => c.compaction).map(c => ms(c.t))].filter(Boolean).sort((a, b) => a - b);
  const prompts = events.filter(e => e.t === 'prompt' && ms(e.at)).map(e => ms(e.at));
  const reads = events.filter(e => e.t === 'tool' && ms(e.at)).map(e => ({ at: ms(e.at), files: filesReadBy(e.name, e.input), tokens: Math.round(resultChars(e.result) * RESULT_TOKENS_PER_CHAR) })).filter(r => r.files.length);
  const subs = (subagents || []).filter(s => s && ms(s.at)).sort((a, b) => ms(a.at) - ms(b.at));
  const claimed = new Set();
  const out = { reads: 0, tokens: 0, laterTokens: 0, ignored: 0, agents: [] };
  for (const f of fired) {
    const t = ms(f.t), files = f.files || [];
    // the lead read it whole anyway: a result at least half the file's size (a ranged read is the lines it edits)
    if (reads.some(r => r.at > t && r.tokens >= f.tokens / 2 && r.files.some(a => files.some(b => sameFile(a, b) || sameFile(b, a))))) { out.ignored++; continue; }
    const end = ends.find(e => e > t) ?? Infinity;
    const later = lead.filter(c => ms(c.t) > t && ms(c.t) < end).length;
    out.reads++; out.tokens += f.tokens; out.laterTokens += f.tokens * Math.max(0, later - 1);
    const turnEnd = prompts.find(p => p > t) ?? Infinity;
    const sub = subs.find(s => !claimed.has(s.agent) && ms(s.at) > t && ms(s.at) < turnEnd && (!f.agent || !s.type || s.type === f.agent));
    if (sub) { claimed.add(sub.agent); out.agents.push(sub.agent); }
  }
  return out;
}
