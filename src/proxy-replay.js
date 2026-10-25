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
//
// Since 2026-10-25 (research/cost-levers-2026-10-25.md) the replay also prices each session at its model's list rates
// (prices.js: on Fable a cache read is 2.5% of an input token and a 1h write 200%, so a clear that is worth it in the
// billed-equivalent weights above, read 0.1, can be break-even in dollars: the shipped policy was, -0.1% over this
// machine's six weeks), and two more things a clear can take: `inputs` (the edit's clear_tool_inputs, the text of the
// agent's own calls going with their results) and `thinking: 'piggyback'` (the thinking of the earlier turns, cleared
// only on a request that clears results, proxy.js:thinkingEdit; cleared on its own schedule it was negative, and a
// sliding keep cost 190%). The cache model is positional: a clear invalidates the cache from the first item it removes,
// what came before it (the system prompt and the instruction files, the prompts and results still kept) is still read.
import fs from 'node:fs';
import { imageTokensOf, parseTranscript } from './transcripts.js';
import { sessionOutputs } from './tool-outputs.js';
import { listPrice } from './prices.js';

export const WEIGHTS = { read: 0.1, write: 2, out: 5 };
// what a text block costs the model, as the Report counts it (report.js:CALIBRATION, four characters are 1.44 tokens)
const TOKENS_PER_CHAR = 1.44 / 4;
// the policies compared by default: what ships (proxy.js:PROXY_DEFAULTS), the same with the agent's tool inputs, and with
// the thinking of the earlier turns cleared alongside; the turn policy at a lower trigger
export const POLICIES = {
  shipped: { keep: 'turn', keepMin: 3, trigger: 100000, clearAtLeast: 80000 },
  inputs: { keep: 'turn', keepMin: 3, trigger: 100000, clearAtLeast: 80000, inputs: true },
  'inputs-thinking': { keep: 'turn', keepMin: 3, trigger: 100000, clearAtLeast: 80000, inputs: true, thinking: 'piggyback' },
  'count-3': { keep: 3, trigger: 100000, clearAtLeast: 80000 },
  turn: { keep: 'turn', keepMin: 3, trigger: 60000, clearAtLeast: 60000 },
};
// `name=keep:3,trigger:100000,clear:80000;turn=keep:turn,trigger:60000,clear:60000,inputs:on,thinking:piggyback`
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
      else if (k === 'inputs') p.inputs = /^(1|on|true|yes)$/i.test(v);
      else if (k === 'thinking') { if (v === 'piggyback') p.thinking = 'piggyback'; else if (/^(0|off|none|no)$/i.test(v)) delete p.thinking; else throw new Error(`policy ${name}: thinking is piggyback or off`); }
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
// Since 2026-10-25 a result carries `input`, the tokens of the tool call that fetched it (for `inputs`); a request its
// model (for the price), `think`, the thinking tokens the call wrote (kept in the context from then on), and `text`,
// the agent's text; a turn the person's text (`tokens`); every text at TOKENS_PER_CHAR.
export function readSession(file) {
  const items = [], seen = new Set(), uses = new Map();
  const est = n => Math.round(n * TOKENS_PER_CHAR);
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type === 'system' && j.subtype === 'compact_boundary') { items.push({ t: 'compact' }); continue; }
    if (j.type === 'user') {
      const c = j.message?.content, blocks = Array.isArray(c) ? c : typeof c === 'string' ? [{ type: 'text', text: c }] : [];
      const results = blocks.filter(b => b?.type === 'tool_result');
      if (results.length) for (const b of results) items.push({ t: 'result', tokens: est(textLen(b.content)) + (imageTokensOf(b.content)?.imageTokens || 0), input: uses.get(b.tool_use_id) || 0 });
      else if (!j.isMeta && blocks.some(b => b?.type === 'text')) items.push({ t: 'turn', tokens: est(textLen(blocks)) });
      continue;
    }
    if (j.type === 'assistant' && j.message) {
      let text = 0;
      for (const b of Array.isArray(j.message.content) ? j.message.content : []) {
        if (b.type === 'tool_use') uses.set(b.id, est(JSON.stringify(b.input ?? {}).length));
        else if (b.type === 'text') text += est(String(b.text || '').length);
      }
      const u = j.message.usage; if (!u) continue;
      const id = j.message.id || `row-${items.length}`;
      if (seen.has(id)) { if (text && items.at(-1)?.t === 'request') items.at(-1).text += text; continue; }
      seen.add(id);
      const think = u.output_tokens_details?.thinking_tokens ?? Math.ceil((j.message.content || []).filter(b => b.type === 'thinking').reduce((a, b) => a + String(b.signature || '').length, 0) / 4.3);
      items.push({ t: 'request', input: u.input_tokens || 0, read: u.cache_read_input_tokens || 0, write: u.cache_creation_input_tokens || 0, out: u.output_tokens || 0, model: j.message.model || null, think, text });
    }
  }
  return items;
}

export const billedOf = r => r.input + WEIGHTS.read * r.read + WEIGHTS.write * r.write + WEIGHTS.out * r.out;
// the same request in dollars at its model's list rates; null where the model has no price
const priceCache = new Map();
const priceOf = model => { if (!priceCache.has(model)) priceCache.set(model, listPrice(model)); return priceCache.get(model); };
// a cache write at the one-hour rate, twice the input (prices.js lists the five-minute write, 1.25 times): Claude Code and
// pi, the agents the proxy serves, write every breakpoint at 1h (Claude Code's messages breakpoint at 5m aside)
export const dollarsOf = r => { const p = priceOf(r.model); return p ? (r.input * p.input + r.read * p.cacheRead + r.write * (p.cacheWrite1h ?? 2 * p.input) + r.out * p.output) / 1e6 : null; };

// One session under one policy (null: as it was). Returns the requests, the bill as recorded (`base`), the bill
// under the policy (`billed`), the same in dollars at list (`baseUsd`, `usd`; null where the model is unpriced), and the
// clears: of results, of the agent's tool inputs (`inputs`), of thinking (`thinkingClears`, `thinking`).
// The context is kept as a log of what entered it since the last compaction, in order: the person's turns, the results
// with their call's input, the agent's text and its thinking per request. A clear invalidates the cache from the first
// item it removes: what sits before it (the first request's prefix, the system prompt and instruction files, and every
// item still kept) is read, the rest written again at the write weight.
export function simulate(items, policy) {
  let log = [], turnUses = 0, turnStart = 0, turnThink = 0, cleared = 0, base = 0, billed = 0, baseUsd = 0, usd = 0, priced = true, clears = 0, clearedTokens = 0, inputsCleared = 0, thinkingClears = 0, thinkingCleared = 0, requests = 0, prefix = null;
  const reset = () => { log = []; cleared = 0; turnUses = 0; turnStart = 0; turnThink = 0; prefix = null; };
  for (const it of items) {
    if (it.t === 'compact') { reset(); continue; }
    if (it.t === 'turn') { turnUses = 0; turnThink = 0; turnStart = log.length; log.push({ k: 'turn', tokens: it.tokens || 0, cleared: false }); continue; }
    if (it.t === 'result') { log.push({ k: 'result', tokens: it.tokens, input: it.input || 0, cleared: false, inputCleared: false }); turnUses++; continue; }
    requests++;
    base += billedOf(it);
    const d = dollarsOf(it); if (d == null) priced = false; else baseUsd += d;
    // the system prompt and the first request: written once at the start, read from the cache through every clear
    if (prefix === null) prefix = it.read + it.write;
    let read = Math.max(0, it.read - cleared), write = it.write, invalidateAt = null;
    if (policy && it.input + read + write >= policy.trigger) {
      const keep = policy.keep === 'turn' ? Math.max(policy.keepMin ?? 0, turnUses) : policy.keep;
      const results = log.filter(x => x.k === 'result');
      const cand = results.slice(0, Math.max(0, results.length - keep)).filter(r => !r.cleared);
      const sum = cand.reduce((a, r) => a + r.tokens, 0), inputs = policy.inputs ? cand.reduce((a, r) => a + r.input, 0) : 0;
      if (sum + inputs >= policy.clearAtLeast) {
        for (const r of cand) { r.cleared = true; if (policy.inputs) r.inputCleared = true; }
        cleared += sum + inputs; clearedTokens += sum; inputsCleared += inputs; clears++;
        invalidateAt = log.indexOf(cand[0]);
        // the thinking of the turns before this one goes with the results (proxy.js:thinkingEdit)
        if (policy.thinking === 'piggyback') {
          const th = log.slice(0, turnStart).filter(x => x.k === 'think' && !x.cleared);
          if (th.length) { const t = th.reduce((a, x) => a + x.tokens, 0); for (const x of th) x.cleared = true; cleared += t; thinkingCleared += t; thinkingClears++; invalidateAt = Math.min(invalidateAt, log.indexOf(th[0])); }
        }
      }
    }
    if (invalidateAt != null) {
      // what this request's clear removed is read no more; of the rest, the cache holds up to the first removed item
      read = Math.max(0, it.read - cleared);
      const before = log.slice(0, invalidateAt).reduce((a, x) => a + (x.cleared ? 0 : x.tokens) + (x.k === 'result' && !x.inputCleared ? x.input : 0), 0);
      const kept = Math.min(read, prefix + before);
      write = it.write + Math.max(0, read - kept); read = kept;
    }
    billed += billedOf({ input: it.input, read, write, out: it.out });
    const d2 = dollarsOf({ ...it, read, write }); if (d2 != null) usd += d2;
    log.push({ k: 'text', tokens: it.text || 0, cleared: false }); log.push({ k: 'think', tokens: it.think || 0, cleared: false }); turnThink++;
  }
  return { requests, base, billed, baseUsd: priced ? baseUsd : null, usd: priced ? usd : null, clears, cleared: clearedTokens, inputs: inputsCleared, thinkingClears, thinking: thinkingCleared };
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
    const s = { file, requests: as.requests, base: as.base, baseUsd: as.baseUsd, policies: {} };
    for (const [name, p] of Object.entries(policies)) { const r = simulate(items, p); s.policies[name] = { billed: r.billed, usd: r.usd, clears: r.clears, cleared: r.cleared, inputs: r.inputs, thinkingClears: r.thinkingClears, thinking: r.thinking }; }
    try {
      const p = parseTranscript(file);
      const by = sessionOutputs(p.events, p.stats?.turns || 0, p.compactions || []);
      s.unneeded = Object.values(by).reduce((a, x) => a + (x.unneeded || 0), 0);
    } catch { s.unneeded = 0; }
    sessions.push(s);
  }
  const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
  const total = xs => {
    const base = sum(xs, s => s.base), pricedXs = xs.filter(s => s.baseUsd != null), baseUsd = sum(pricedXs, s => s.baseUsd);
    const out = { sessions: xs.length, base: Math.round(base), priced: pricedXs.length, baseUsd: Math.round(baseUsd * 100) / 100, ceiling: base ? sum(xs, s => s.unneeded * WEIGHTS.read) / base : 0, policies: {} };
    for (const name of Object.keys(policies)) {
      const billed = sum(xs, s => s.policies[name].billed), usd = sum(pricedXs, s => s.policies[name].usd);
      out.policies[name] = { billed: Math.round(billed), saving: base ? (base - billed) / base : 0, usd: Math.round(usd * 100) / 100, usdSaving: baseUsd ? (baseUsd - usd) / baseUsd : 0, costlier: xs.filter(s => s.policies[name].billed > s.base).length, costlierUsd: pricedXs.filter(s => s.policies[name].usd > s.baseUsd * 1.001).length, clears: sum(xs, s => s.policies[name].clears), cleared: sum(xs, s => s.policies[name].cleared), inputs: sum(xs, s => s.policies[name].inputs), thinkingClears: sum(xs, s => s.policies[name].thinkingClears), thinking: sum(xs, s => s.policies[name].thinking) };
    }
    return out;
  };
  return { policies, all: total(sessions), byLength: Object.fromEntries(BUCKETS.map(([name, f]) => [name, total(sessions.filter(s => f(s.requests)))])) };
}

const pct = x => `${(100 * x).toFixed(1)}%`;
export function renderReplay(r, fmt = n => String(n)) {
  const lines = [];
  const usd = x => `$${Number(x || 0).toFixed(0)}`;
  const block = (title, t) => {
    lines.push(`${title}: ${t.sessions} sessions, ${fmt(t.base)} billed-equivalent tokens as recorded${t.priced ? `, ${usd(t.baseUsd)} at list over the ${t.priced} priced` : ''}; ceiling (reads after last use, at the cache-read weight) ${pct(t.ceiling)}`);
    for (const [name, p] of Object.entries(t.policies)) {
      const pol = r.policies[name];
      lines.push(`  ${name.padEnd(16)} keep ${String(pol.keep === 'turn' ? `turn (min ${pol.keepMin ?? 0})` : pol.keep).padEnd(13)} trigger ${fmt(pol.trigger).padStart(5)} clear ${fmt(pol.clearAtLeast).padStart(5)}${pol.inputs ? ' +inputs' : ''}${pol.thinking ? ' +thinking' : ''}: saves ${pct(p.saving).padStart(6)} billed-eq${t.priced ? `, ${pct(p.usdSaving).padStart(6)} at list (${p.costlierUsd} costlier)` : ''}, ${p.costlier} sessions costlier, ${p.clears} clears, ${fmt(p.cleared)} results${p.inputs ? ` + ${fmt(p.inputs)} inputs` : ''}${p.thinkingClears ? ` + ${fmt(p.thinking)} thinking` : ''} cleared`);
    }
  };
  block('All', r.all);
  for (const [name, t] of Object.entries(r.byLength)) if (t.sessions) block(name, t);
  return lines.join('\n');
}
