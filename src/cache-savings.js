// Observed note lifetime, hypothetical avoided reading. No model call or provider login.
// Only request payloads positively containing rendered notes earn repeated-read credit.
// Other clients / missing evidence retain a one-read estimate. Results are cached by transcript stamp.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { diskCache, cacheKey, cachedByFiles } from './disk-cache.js';
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const canonical = x => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object'
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
export const messageHash = m => sha(JSON.stringify(canonical(m)));
const rows = raw => raw.split('\n').flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
export function sections(content) {
  const texts = typeof content === 'string' ? [content] : (content || []).flatMap(b =>
    b.type === 'text' ? [b.text || ''] : b.type === 'tool_result' ? textsOf(b.content) : []);
  const found = [];
  for (const text of texts) {
    // Real rendered notes, not bare mentions of ids or JSON-escaped transcript dumps.
    const headers = [...text.matchAll(/^### \[[^\]\n]+\] [^\n]*?\(id: ([^,\s)]+), confidence [^\n]+\)/gm)];
    headers.forEach((m, i) => {
      let part = text.slice(m.index, headers[i + 1]?.index ?? text.length);
      // The pointer line is the end of a rendered note, including compact renderings.
      const end = part.match(/\n→(?: pointers:)?[^\n]*/);
      if (!end) return;
      part = part.slice(0, end.index + end[0].length);
      found.push({ id: m[1], tokens: Math.ceil(part.length / 3.6), textHash: sha(part) });
    });
  }
  return found;
}
function textsOf(c) {
  return typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter(b => b?.type === 'text').map(b => b.text || '') : [];
}

export function requestsOf(rows, until = Infinity) {
  const blobs = new Map(), responses = new Map(), assistantBlocks = new Map();
  for (const r of rows) {
    if (r.type === 'api-request-blob' && sections(r.message?.content).length) blobs.set(r.hash, r.message);
    // The recorder omits blobs already reconstructible from ordinary transcript messages.
    // Only an exact canonical SHA-256 match can resolve a reference; no fuzzy substitutions.
    if (r.message?.role && sections(r.message?.content).length) {
      const m = { role: r.message.role, content: r.message.content };
      blobs.set(messageHash(m), m);
    }
    if (r.type === 'assistant' && r.message?.id && Array.isArray(r.message.content)) {
      const blocks = assistantBlocks.get(r.message.id) || new Map();
      r.message.content.forEach((b, i) => {
        const wire = b.type === 'tool_use' && r.wireToolInputs?.[b.id];
        blocks.set((r.apiBlockIndex ?? blocks.size) + i, wire ? { ...b, input: wire } : b);
      });
      assistantBlocks.set(r.message.id, blocks);
    }
    if (r.type === 'assistant' && !r.isSidechain && r.requestRef && r.message?.usage) {
      const u = r.message.usage;
      if ((u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) > 0)
        responses.set(r.requestRef, { model: r.message.model, usage: u });
    }
  }
  for (const blocks of assistantBlocks.values()) {
    const m = { role: 'assistant', content: [...blocks].sort(([a], [b]) => a - b).map(([, b]) => b) };
    if (sections(m.content).length) blobs.set(messageHash(m), m);
  }
  let previous = [], invalid = 0, unmatched = 0, unresolvedRequests = 0;
  const requests = [], seen = new Set(), parsed = new Map(), sequences = new Map();
  for (const r of rows) {
    if (r.type !== 'api-request') continue;
    const base = r.base ? sequences.get(r.base) : previous;
    if (!base || !Number.isInteger(r.keep) || r.keep < 0 || r.keep > base.length || !Array.isArray(r.tail)) {
      previous = []; invalid++; continue;
    }
    previous = base.slice(0, r.keep).concat(r.tail);
    sequences.set(r.id, previous);
    const unresolvedMessages = previous.filter(h => !blobs.has(h)).length;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    if (r.querySource !== 'repl_main_thread' || !(Date.parse(r.timestamp) < until)) continue;
    const response = responses.get(r.id);
    if (!response) { unmatched++; continue; }
    if (unresolvedMessages) unresolvedRequests++;
    const notes = new Map();
    for (const h of previous) {
      if (!blobs.has(h)) continue;
      if (!parsed.has(h)) parsed.set(h, sections(blobs.get(h)?.content));
      for (const n of parsed.get(h)) {
        const p = notes.get(n.id) || { tokens: 0, copies: 0, hashes: new Set() };
        p.tokens += n.tokens; p.copies++; p.hashes.add(n.textHash); notes.set(n.id, p);
      }
    }
    requests.push({ id: r.id, at: Date.parse(r.timestamp), model: response.model,
      input: (response.usage.input_tokens || 0) + (response.usage.cache_read_input_tokens || 0) + (response.usage.cache_creation_input_tokens || 0), unresolvedMessages, notes });
  }
  return { requests, invalid, unmatched };
}

const CACHE = diskCache('cache-lifetime', 1);
// Persist only request times and rendered-note sizes, never the source text or message graph.
export function lifetimeRequests(file) {
  if (!file) return [];
  try {
    return cachedByFiles(CACHE, cacheKey(file), [file], () => {
      const p = requestsOf(rows(fs.readFileSync(file, 'utf8')));
      // A broken base/prefix could falsely retain notes, so use the single-read fallback.
      return p.invalid ? [] : p.requests.filter(r => r.notes.size).map(r => ({ at: r.at,
        notes: Object.fromEntries([...r.notes].map(([id, n]) => [id, n.tokens])) }));
    });
  } catch { return []; }
}

// A cumulative clear is echoed on later responses. Only an increase is a new boundary.
// Align it to the request that triggered it, whose start precedes the proxy response.
export function clearBoundaries(records, session, requests) {
  let previous = 0;
  const times = [];
  for (const r of records.filter(r => r.op === 'proxy' && r.session === session).sort((a, b) => a.at.localeCompare(b.at))) {
    if (!Number.isFinite(r.clearedUses)) continue;
    if (r.cleared > 0 && r.clearedUses > previous) {
      const end = Date.parse(r.at);
      const start = requests.filter(q => q.at <= end).at(-1)?.at;
      // Don't assign a clear to a request hours before it merely because other calls had no notes.
      times.push(start != null && end - start < 5 * 60_000 ? start : end);
    }
    previous = r.clearedUses;
  }
  return times;
}

const PROXY_CACHE = diskCache('cache-clears', 1);
let proxyMemo;
export function sessionClears(session, requests) {
  if (process.env.THINKER_TEST === '1' && !process.env.THINKER_HOME) return [];
  const file = path.join(process.env.THINKER_HOME || path.join(os.homedir(), '.thinker'), 'state', 'proxy.jsonl');
  try {
    const stat = fs.statSync(file), stamp = `${file}:${stat.size}:${stat.mtimeMs}`;
    if (proxyMemo?.stamp === stamp) return clearBoundaries(proxyMemo.records, session, requests);
    const records = cachedByFiles(PROXY_CACHE, cacheKey(file), [file], () => rows(fs.readFileSync(file, 'utf8'))
      .filter(r => r.op === 'proxy' && r.session && Number.isFinite(r.clearedUses))
      .map(({ at, session, cleared, clearedUses }) => ({ op: 'proxy', at, session, cleared, clearedUses })));
    proxyMemo = { stamp, records };
    return clearBoundaries(records, session, requests);
  } catch { return []; }
}

// Records are deduplicated by session-note by the caller. Historical records without file
// sizes share one conservative reading bucket: their largest estimate, not a sum of overlaps.
export function inputSavings(notes, requests = [], { clears = [], until = Date.now() } = {}) {
  const hits = notes.map(n => ({ ...n, requests: requests.filter(r => r.at >= Date.parse(n.at) && r.at <= until && Number.isFinite(r.notes[n.id])) }));
  const covered = hits.filter(h => h.requests.length);
  const fallback = hits.filter(h => !h.requests.length);
  let gross = 0, overhead = 0, calls = 0;
  const stop = new Map(covered.map(h => [h.id, clears.find(t => t >= h.requests[0].at) ?? Infinity]));
  for (const r of requests) {
    if (r.at > until) continue;
    const active = covered.filter(h => r.at >= Date.parse(h.at) && Number.isFinite(r.notes[h.id]));
    if (!active.length) continue;
    calls++;
    const files = new Map(); let legacy = 0;
    for (const h of active) {
      overhead += r.notes[h.id];
      if (r.at >= stop.get(h.id)) continue;
      if (h.files?.length) for (const [file, tokens] of h.files) files.set(file, Math.max(files.get(file) || 0, tokens));
      else legacy = Math.max(legacy, h.tokens || 0);
    }
    // Legacy anchors may overlap the newer recorded ones too.
    gross += Math.max(legacy, [...files.values()].reduce((a, b) => a + b, 0));
  }
  const once = fallback.reduce((s, h) => s + (h.tokens || 0) - (h.noteTokens || 0), 0);
  return { tokens: Math.round(gross - overhead + once), gross, overhead, fallbackTokens: Math.round(once),
    covered: covered.length, fallback: fallback.length, sessions: covered.length ? 1 : 0, requests: calls };
}

// Stop hooks can be retried without another model call. A running total is said only
// when it changes; a fresh delivery can still have its ordinary turn notice.
export function inputNoticeChanged(storeDir, session, input) {
  const dir = path.join(storeDir, 'state', 'input-savings-notices');
  const file = path.join(dir, sha(String(session)) + '.json');
  const text = JSON.stringify({ tokens: input.tokens, requests: input.requests });
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return false;
    fs.mkdirSync(dir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, text); fs.renameSync(temp, file);
  } catch {} // Reporting must not break the session.
  return true;
}
