// Replay of the proxy's clearing policies over Claude Code transcripts, with no model call: what each session
// cost, and what it would have cost had the API cleared old tool results as a policy asks (proxy.js). The first
// step of the experiment (stage-gated: an offline mechanism check before an agent run through Artemis), and the
// way to compare policies before one is run live. `thinker proxy replay`.
//
// How a session is costed: every request's usage as the transcript recorded it, in billed-equivalent tokens
// (WEIGHTS: a cache read a tenth of an input token, a one-hour cache write twice, an output token five times).
// Under a policy, a request whose context reaches `trigger` clears the tool results before the kept ones when
// they amount to `clearAtLeast`; that request writes the cache again from the first cleared result on, with the
// system prompt before it still read from the cache (the pilot of 2026-10-20, PostHog PR106936 under Opus: the
// request before the clear read 192.8k, the clear read 11.8k and wrote 104.2k, 80.5k cleared; the system prompt is
// taken as the session's first cache write), and every later request reads the cleared tokens no more. A
// compaction empties the slate: the results before it are gone from the agent's own context already. What the
// replay cannot see: the model's reaction to the placeholders (reading a file again), which is what the live
// experiment measures.
//
// `ceiling`: the cost of reading results after the agent last used them (tool-outputs.js:sessionOutputs), at
// the cache-read weight, as a share of the session's bill: what a perfect policy with no cache penalty would
// save, the Context tab's Wasted in billed terms.
import fs from 'node:fs';
import { imageTokensOf, parseTranscript } from './transcripts.js';
import { sessionOutputs } from './tool-outputs.js';

export const WEIGHTS = { read: 0.1, write: 2, out: 5 };
// the policies compared by default: what ships (proxy.js:PROXY_DEFAULTS), and the turn policy at two triggers
export const POLICIES = {
  shipped: { keep: 3, trigger: 100000, clearAtLeast: 80000 },
  turn: { keep: 'turn', keepMin: 3, trigger: 60000, clearAtLeast: 60000 },
  'turn-100k': { keep: 'turn', keepMin: 3, trigger: 100000, clearAtLeast: 80000 },
};
// `name=keep:3,trigger:100000,clear:80000;turn=keep:turn,trigger:60000,clear:60000`
export function parsePolicies(spec) {
  if (!spec) return POLICIES;
  const out = {};
  for (const part of String(spec).split(';')) {
    const [name, rest] = part.includes('=') ? part.split('=', 2) : [part, part];
    const p = { ...POLICIES[name.trim()] };
    for (const kv of String(rest).split(',')) {
      const [k, v] = kv.split(':').map(s => s.trim());
      if (!k || v == null) continue;
      if (k === 'keep') p.keep = v === 'turn' ? 'turn' : Number(v);
      else if (k === 'keepMin' || k === 'keep-min') p.keepMin = Number(v);
      else if (k === 'trigger') p.trigger = Number(v);
      else if (k === 'clear' || k === 'clearAtLeast') p.clearAtLeast = Number(v);
    }
    if (p.keep == null || !p.trigger || !p.clearAtLeast) throw new Error(`policy ${name}: needs keep, trigger and clear`);
    out[name.trim()] = p;
  }
  return out;
}

const textLen = c => typeof c === 'string' ? c.length : Array.isArray(c) ? c.reduce((a, b) => a + (typeof b?.text === 'string' ? b.text.length : 0), 0) : 0;

// A session as the sequence the proxy sees: each request with its usage, the tool results that entered the
// context before it, the start of each of the person's turns, and the compactions. Claude Code writes one row
// per content block of an assistant message, all with the message's usage, so a request is counted once by id.
export function readSession(file) {
  const items = [], seen = new Set();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type === 'system' && j.subtype === 'compact_boundary') { items.push({ t: 'compact' }); continue; }
    if (j.type === 'user') {
      const c = j.message?.content, blocks = Array.isArray(c) ? c : typeof c === 'string' ? [{ type: 'text', text: c }] : [];
      const results = blocks.filter(b => b?.type === 'tool_result');
      if (results.length) for (const b of results) items.push({ t: 'result', tokens: Math.ceil(textLen(b.content) / 4) + (imageTokensOf(b.content)?.imageTokens || 0) });
      else if (!j.isMeta && blocks.some(b => b?.type === 'text')) items.push({ t: 'turn' });
      continue;
    }
    if (j.type === 'assistant' && j.message?.usage) {
      const id = j.message.id || `row-${items.length}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const u = j.message.usage;
      items.push({ t: 'request', input: u.input_tokens || 0, read: u.cache_read_input_tokens || 0, write: u.cache_creation_input_tokens || 0, out: u.output_tokens || 0 });
    }
  }
  return items;
}

export const billedOf = r => r.input + WEIGHTS.read * r.read + WEIGHTS.write * r.write + WEIGHTS.out * r.out;

// One session under one policy (null: as it was). Returns the requests, the bill as recorded (`base`), the bill
// under the policy (`billed`), and the clears.
export function simulate(items, policy) {
  let results = [], turnUses = 0, cleared = 0, base = 0, billed = 0, clears = 0, clearedTokens = 0, requests = 0, prefix = null;
  for (const it of items) {
    if (it.t === 'compact') { results = []; cleared = 0; turnUses = 0; prefix = null; continue; }
    if (it.t === 'turn') { turnUses = 0; continue; }
    if (it.t === 'result') { results.push({ tokens: it.tokens, cleared: false }); turnUses++; continue; }
    requests++;
    base += billedOf(it);
    // the system prompt and the first request: written once at the start, read from the cache through every clear
    if (prefix === null) prefix = it.read + it.write;
    let read = Math.max(0, it.read - cleared), write = it.write;
    if (policy && it.input + read + write >= policy.trigger) {
      const keep = policy.keep === 'turn' ? Math.max(policy.keepMin ?? 0, turnUses) : policy.keep;
      const cand = results.slice(0, Math.max(0, results.length - keep)).filter(r => !r.cleared);
      const sum = cand.reduce((a, r) => a + r.tokens, 0);
      if (sum >= policy.clearAtLeast) { for (const r of cand) r.cleared = true; cleared += sum; clearedTokens += sum; clears++; const kept = Math.min(read, prefix); write = Math.max(0, read + write - sum - kept); read = kept; }
    }
    billed += billedOf({ input: it.input, read, write, out: it.out });
  }
  return { requests, base, billed, clears, cleared: clearedTokens };
}

const BUCKETS = [['under 60 requests', r => r < 60], ['60 to 119', r => r >= 60 && r < 120], ['120 and over', r => r >= 120]];

// Every session under every policy: the bill as recorded, each policy's bill, saving and the sessions it made
// costlier, in all and by session length; and the ceiling (see above).
export function replay(files, policies = POLICIES) {
  const sessions = [];
  for (const file of files) {
    let items; try { items = readSession(file); } catch { continue; }
    const as = simulate(items, null);
    if (!as.requests) continue;
    const s = { file, requests: as.requests, base: as.base, policies: {} };
    for (const [name, p] of Object.entries(policies)) { const r = simulate(items, p); s.policies[name] = { billed: r.billed, clears: r.clears, cleared: r.cleared }; }
    try {
      const p = parseTranscript(file);
      const by = sessionOutputs(p.events, p.stats?.turns || 0, p.compactions || []);
      s.unneeded = Object.values(by).reduce((a, x) => a + (x.unneeded || 0), 0);
    } catch { s.unneeded = 0; }
    sessions.push(s);
  }
  const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
  const total = xs => {
    const base = sum(xs, s => s.base), out = { sessions: xs.length, base: Math.round(base), ceiling: base ? sum(xs, s => s.unneeded * WEIGHTS.read) / base : 0, policies: {} };
    for (const name of Object.keys(policies)) {
      const billed = sum(xs, s => s.policies[name].billed);
      out.policies[name] = { billed: Math.round(billed), saving: base ? (base - billed) / base : 0, costlier: xs.filter(s => s.policies[name].billed > s.base).length, clears: sum(xs, s => s.policies[name].clears), cleared: sum(xs, s => s.policies[name].cleared) };
    }
    return out;
  };
  return { policies, all: total(sessions), byLength: Object.fromEntries(BUCKETS.map(([name, f]) => [name, total(sessions.filter(s => f(s.requests)))])) };
}

const pct = x => `${(100 * x).toFixed(1)}%`;
export function renderReplay(r, fmt = n => String(n)) {
  const lines = [];
  const block = (title, t) => {
    lines.push(`${title}: ${t.sessions} sessions, ${fmt(t.base)} billed-equivalent tokens as recorded; ceiling (reads after last use, at the cache-read weight) ${pct(t.ceiling)}`);
    for (const [name, p] of Object.entries(t.policies)) {
      const pol = r.policies[name];
      lines.push(`  ${name.padEnd(10)} keep ${String(pol.keep === 'turn' ? `turn (min ${pol.keepMin ?? 0})` : pol.keep).padEnd(13)} trigger ${fmt(pol.trigger).padStart(5)} clear ${fmt(pol.clearAtLeast).padStart(5)}: saves ${pct(p.saving).padStart(6)}, ${p.costlier} sessions costlier, ${p.clears} clears, ${fmt(p.cleared)} cleared`);
    }
  };
  block('All', r.all);
  for (const [name, t] of Object.entries(r.byLength)) if (t.sessions) block(name, t);
  return lines.join('\n');
}
