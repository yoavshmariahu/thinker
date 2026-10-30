// Local, read-only sensitivity analysis. Holds the shipped avoided-read estimate fixed.
// Request membership is observed; avoided reading and its lifetime are counterfactual.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const canonical = x => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object'
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
export const messageHash = m => sha(JSON.stringify(canonical(m)));
const lines = s => s.split('\n').flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
const key = s => String(s || '').replace(/\.jsonl?$/, '').replace(/^trace-/, '').replace(/^rollout-.*?([0-9a-f]{8}-[0-9a-f-]{27,})$/, '$1').replace(/[^\w.-]/g, '_');

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
    if (r.type === 'api-request-blob') blobs.set(r.hash, r.message);
    // The recorder omits blobs already reconstructible from ordinary transcript messages.
    // Only an exact canonical SHA-256 match can resolve a reference; no fuzzy substitutions.
    if (r.message?.role && r.message?.content) {
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
    blobs.set(messageHash(m), m);
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
  return { requests, invalid, unmatched, unresolvedRequests, responseRefs: responses.size };
}

// Only one hypothetical avoided read set per session-note. Repeated note copies still cost input.
export function estimateHit(hit, requests, clears = []) {
  const matching = requests.filter(r => r.at >= Date.parse(hit.t) && r.notes.has(hit.id));
  if (!matching.length) return null;
  const first = matching[0], firstNote = first.notes.get(hit.id).tokens;
  const noteInput = matching.reduce((s, r) => s + r.notes.get(hit.id).tokens, 0);
  // New clearing after the hit, not an old cumulative clear repeated on every response.
  const boundary = clears.find(t => t >= first.at) ?? Infinity;
  const beforeClear = matching.filter(r => r.at < boundary).length;
  const baseline = hit.est[1];
  return { id: hit.id, at: hit.t, baseline, files: hit.est[0], firstNoteTokens: firstNote,
    requestsContainingNote: matching.length, requestsBeforeNewClear: beforeClear, noteInput,
    repeatedCopyRequests: matching.filter(r => r.notes.get(hit.id).copies > 1).length,
    requestsWithUnresolvedOtherMessages: matching.filter(r => r.unresolvedMessages).length,
    noteVersions: new Set(matching.flatMap(r => [...r.notes.get(hit.id).hashes])).size,
    grossCarried: baseline * matching.length,
    netCarried: baseline * matching.length - noteInput,
    netStopAtClear: baseline * beforeClear - noteInput,
    netQuarterRead: baseline * 0.25 * matching.length - noteInput,
    netQuarterReadStopAtClear: baseline * 0.25 * beforeClear - noteInput,
    singleReadNet: baseline - firstNote,
    model: first.model, models: [...new Set(matching.map(r => r.model))],
    newClearAt: Number.isFinite(boundary) ? new Date(boundary).toISOString() : null,
    firstRequest: new Date(first.at).toISOString(), lastRequest: new Date(matching.at(-1).at).toISOString() };
}

const sum = (xs, k) => xs.reduce((s, x) => s + x[k], 0);
const median = a => { const x = [...a].sort((a, b) => a - b); return x.length ? (x[Math.floor((x.length - 1) / 2)] + x[Math.floor(x.length / 2)]) / 2 : null; };
export function totals(hits) {
  const keys = ['baseline', 'singleReadNet', 'grossCarried', 'noteInput', 'netCarried', 'netStopAtClear', 'netQuarterRead', 'netQuarterReadStopAtClear'];
  return { hits: hits.length, ...Object.fromEntries(keys.map(k => [k, sum(hits, k)])),
    meanNetCarried: hits.length ? sum(hits, 'netCarried') / hits.length : null,
    medianNetCarried: median(hits.map(x => x.netCarried)), medianCarry: median(hits.map(x => x.requestsContainingNote)),
    meanCarry: hits.length ? sum(hits, 'requestsContainingNote') / hits.length : null,
    maxCarry: hits.length ? Math.max(...hits.map(x => x.requestsContainingNote)) : null };
}

// Sensitivity only: every active note's avoided reading is nested in the largest one.
// This avoids adding overlapping file estimates, without inventing historical per-file sizes.
export function overlappingTotal(hits, requests) {
  let net = 0, netStopAtClear = 0, quarter = 0, quarterStopAtClear = 0;
  for (const r of requests) {
    const active = hits.filter(h => r.at >= Date.parse(h.at) && r.notes.has(h.id));
    if (!active.length) continue;
    const size = Math.max(...active.map(h => h.baseline));
    const retained = active.filter(h => !h.newClearAt || r.at < Date.parse(h.newClearAt));
    const sizeAfterClear = retained.length ? Math.max(...retained.map(h => h.baseline)) : 0;
    const overhead = active.reduce((s, h) => s + r.notes.get(h.id).tokens, 0);
    net += size - overhead; netStopAtClear += sizeAfterClear - overhead;
    quarter += size / 4 - overhead; quarterStopAtClear += sizeAfterClear / 4 - overhead;
  }
  return { net, netStopAtClear, quarter, quarterStopAtClear };
}

async function main() {
  if (process.env.THINKER_TEST !== '1') throw new Error('Run with THINKER_TEST=1');
  const [repo, logFile, projects, proxyFile, until = '2026-10-30T05:00:00.000Z'] = process.argv.slice(2);
  if (!repo || !logFile || !projects || !proxyFile || !Number.isFinite(Date.parse(until))) throw new Error('Expected REPO LOG CLAUDE_PROJECTS PROXY_LOG [UNTIL]');
  const end = Date.parse(until), start = end - 30 * 864e5;
  const logRaw = fs.readFileSync(logFile, 'utf8'), all = lines(logRaw);
  const origin = all.find(e => e.repo === path.resolve(repo) && e.origin)?.origin;
  if (!origin) throw new Error('Repository has no logged origin');
  const events = all.filter(e => e.origin === origin && Date.parse(e.t) >= start && Date.parse(e.t) < end).sort((a, b) => a.t.localeCompare(b.t));
  const verdicts = new Map(), sessions = new Map();
  for (const e of events) {
    const sid = key(e.session); if (!sid || sid === 'unknown') continue;
    if (!sessions.has(sid)) sessions.set(sid, new Map());
    if (e.op === 'attest') for (const a of e.applied || []) verdicts.set(sid + '|' + a.id, a.verdict);
    if (['orient', 'late', 'lookup'].includes(e.op)) (e.served || []).forEach((id, i) => {
      if (!sessions.get(sid).has(id)) sessions.get(sid).set(id, { id, t: e.t, est: e.est?.[i] });
    });
  }
  const wanted = new Map([...sessions].map(([sid, ns]) => [sid, [...ns.values()].filter(n => verdicts.get(sid + '|' + n.id) === 'confirmed')]).filter(([, ns]) => ns.length));
  const dirs = fs.readdirSync(projects, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(projects, d.name));
  const proxyRaw = fs.readFileSync(proxyFile, 'utf8'), proxy = lines(proxyRaw);
  const allHits = [], excluded = {}, provenance = [], sessionRows = [];
  const exclude = (reason, n = 1) => excluded[reason] = (excluded[reason] || 0) + n;
  for (const [sid, ns] of wanted) {
    const files = dirs.map(d => path.join(d, sid + '.jsonl')).filter(fs.existsSync);
    if (files.length !== 1) { exclude(files.length ? 'ambiguous-transcript' : 'no-claude-transcript', ns.length); continue; }
    const raw = fs.readFileSync(files[0], 'utf8'), parsed = requestsOf(lines(raw), end);
    const sessionHash = sha(sid).slice(0, 12);
    provenance.push({ sessionHash, transcriptSha256: sha(raw) });
    if (parsed.invalid) { exclude('invalid-request-reconstruction', ns.length); continue; }
    const proxyRows = proxy.filter(p => key(p.session) === sid && p.op === 'proxy' && Date.parse(p.at) < end).sort((a, b) => a.at.localeCompare(b.at));
    let previous = 0;
    const clears = [];
    for (const p of proxyRows) if (typeof p.clearedUses === 'number') {
      if (p.cleared > 0 && p.clearedUses > previous) clears.push(Date.parse(p.at));
      previous = p.clearedUses;
    }
    const hits = [];
    for (const n of ns) {
      if (!n.est || !Number.isFinite(n.est[1])) { exclude('no-logged-size'); continue; }
      const h = estimateHit(n, parsed.requests, clears);
      if (!h) { exclude('note-not-found-in-successful-request'); continue; }
      hits.push({ sessionHash, ...h });
    }
    allHits.push(...hits);
    sessionRows.push({ sessionHash, successfulRequests: parsed.requests.length, unmatchedRequests: parsed.unmatched,
      unresolvedRequests: parsed.unresolvedRequests,
      newClearBoundaries: clears.length, proxyRequests: proxyRows.length, ...totals(hits),
      completeOverlap: overlappingTotal(hits, parsed.requests) });
  }
  const group = fn => Object.fromEntries([...new Set(allHits.map(fn))].sort().map(k => [k, totals(allHits.filter(h => fn(h) === k))]));
  console.log(JSON.stringify({ origin, since: new Date(start).toISOString(), until,
    method: 'Same logged avoided-read size, observed successful client-request note presence, note text charged on every appearance; no learning costs.',
    assumptions: ['Confirmed does not prove reading avoided.', 'Hypothetical code results initially share note lifetime; stop-at-new-clear is a sensitivity scenario.', 'Client snapshots precede server-side clearing.', 'Quarter-read is a sensitivity assumption, not a measured reduction.', 'Rendered text characters / 3.6; shared hook wrapper and unrelated notes excluded.', 'Repeated copies cost input, but avoided reads credited only once per request per note.', 'Only successful main-thread Claude requests with snapshots are covered.', 'Unresolved message bodies are not guessed. Counts cover positively observed rendered note payloads; unknown bodies can contain additional note text.'],
    logSha256: sha(logRaw), proxySha256: sha(proxyRaw), confirmedHits: [...wanted.values()].reduce((s, ns) => s + ns.length, 0),
    covered: totals(allHits), excluded, byModel: group(h => h.models.length === 1 ? h.model : 'mixed-model-session'),
    completeOverlap: Object.fromEntries(['net', 'netStopAtClear', 'quarter', 'quarterStopAtClear'].map(k => [k, sessionRows.reduce((s, r) => s + r.completeOverlap[k], 0)])),
    byLifetime: group(h => h.requestsContainingNote < 20 ? 'under-20' : h.requestsContainingNote < 100 ? '20-99' : '100-plus'),
    sessions: sessionRows, hits: allHits, provenance }, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
