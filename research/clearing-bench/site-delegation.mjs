#!/usr/bin/env node
// Export a bench pair (bare against delegate) into the See-the-data explorer, subagents included.
//
// Reads the bench ledger for the two sessions of one task, each session's Claude Code transcript and the
// transcripts of the subagents it started, and writes the two files the page reads for a run:
// site/clearing-<id>.json (per-call tokens, each call with its model and, for a subagent's call, the agent)
// and site/clearing-<id>-session.json (every turn's steps, a subagent's conversation nested under the Agent
// call that started it). No model calls. Modelled on site-data.py; the nesting is the stage bench's.
//
//   node research/clearing-bench/site-delegation.mjs --tag <bench tag> --task <task> --id <page id> [--site site]
//
// What is kept out: the home path and the run's own directory (every path becomes repository-relative), and
// the contents of thinking blocks (only their length).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { listPrice } from '../../src/prices.js';

const A = Object.fromEntries(process.argv.slice(2).map((x, i, a) => x.startsWith('--') ? [x.slice(2), a[i + 1]] : null).filter(Boolean));
const ROOT = path.resolve(path.join(import.meta.dirname, '..', '..'));
const SITE = path.resolve(ROOT, A.site || 'site');
const HOME = os.homedir();
const rows = f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const ledger = rows(path.join(ROOT, 'bench', 'ledger.jsonl')).filter(r => r.tag === A.tag && r.task === A.task && r.rep === Number(A.rep || 0));
const rowOf = arm => { const r = ledger.find(x => x.arm === arm); if (!r) throw new Error(`no ${arm} row for ${A.tag} ${A.task}`); if (!r.valid) throw new Error(`${r.id} is not a valid session`); return r; };

const priceOf = model => { const p = listPrice(model); return { input: p.input, read: p.cacheRead, w1h: p.cacheWrite1h, w5m: p.cacheWrite, out: p.output }; };
const prices = {};
const strip = [];
const scrub = s => { let x = String(s); for (const p of strip) x = x.split(p + '/').join('').split(p).join('.'); return x.split(HOME).join('~').replace(/\/private\/tmp\/claude-\d+\/[^\s"'\\]+/g, '<task output file>').replace(/-Users-[A-Za-z0-9]+-/g, '-').replace(/\/Users\/[^/\s"'\\]+/g, '~').replace(/\uFFFD/g, ''); };
const textOf = c => typeof c === 'string' ? c : (c || []).map(x => x && x.text || '').join('\n');
const blobs = {};
const keep = t => { const h = crypto.createHash('sha1').update(t).digest('hex').slice(0, 12); blobs[h] = t; return h; };
// the words thinker's hook denies a call with (delegate.js:denial); a tool call answered with them was handed over
const HANDOFF = /^(?:PreToolUse:\w+ hook error: )?thinker stopped this call/;

// one conversation file -> turns (with steps) and calls
function conversation(file, { sub = null } = {}) {
  const turns = [], calls = [], seen = {}, results = [], toolById = {}; let pending = [];
  const turn = () => { if (!turns.length) turns.push({ n: 1, prompt: '', steps: [], calls: [], tools: {} }); return turns.at(-1); };
  for (const rec of rows(file)) {
    if (rec.type === 'user') {
      const c = rec.message?.content;
      if (typeof c === 'string') {
        if (rec.isMeta || c.startsWith('<')) { if (turns.length) continue; }
        turns.push({ n: turns.length + 1, prompt: scrub(c), steps: [], calls: [], tools: {} }); continue;
      }
      for (const p of c || []) {
        if (p.type === 'tool_result') {
          const s = scrub(textOf(p.content));
          const step = { kind: 'result', id: p.tool_use_id, chars: s.length, lines: s.split('\n').length, blob: keep(s), error: Boolean(p.is_error) };
          if (HANDOFF.test(s) && toolById[p.tool_use_id]) { toolById[p.tool_use_id].handoff = true; step.handoff = true; step.error = false; }
          turn().steps.push(step); pending.push(step);
        } else if (p.type === 'text' && !String(p.text || '').startsWith('<system-reminder>')) {
          if (!turns.length || sub) turns.push({ n: turns.length + 1, prompt: scrub(p.text), steps: [], calls: [], tools: {} });
          else turn().steps.push({ kind: 'user', text: scrub(p.text) });
        }
      }
    } else if (rec.type === 'assistant') {
      const m = rec.message || {}, rid = rec.requestId || m.id || rec.uuid;
      let call = seen[rid];
      if (!call) {
        const u = m.usage || {};
        call = { k: 0, t: turn().n, at: Date.parse(rec.timestamp) || 0, read: u.cache_read_input_tokens || 0, write: u.cache_creation_input_tokens || 0, write1h: u.cache_creation?.ephemeral_1h_input_tokens ?? (u.cache_creation_input_tokens || 0), write5m: u.cache_creation?.ephemeral_5m_input_tokens || 0, input: u.input_tokens || 0, out: u.output_tokens || 0, model: m.model || null, agent: sub ? sub.type : null };
        if (call.model && call.model !== '<synthetic>') prices[call.model] = priceOf(call.model);
        calls.push(call); seen[rid] = call; turn().calls.push(call); turn().steps.push({ kind: 'call', call });
        for (const st of pending) results.push({ c: st.chars, call });
        pending = [];
      } else {
        // a later block of the same request carries the final output count
        const u = m.usage || {}; if ((u.output_tokens || 0) > call.out) call.out = u.output_tokens;
      }
      for (const p of m.content || []) {
        if (p.type === 'thinking') turn().steps.push({ kind: 'thinking', chars: (p.thinking || '').length });
        else if (p.type === 'text') turn().steps.push({ kind: 'say', text: scrub(p.text || '') });
        else if (p.type === 'tool_use') {
          const step = { kind: 'tool', id: p.id, name: p.name, input: JSON.parse(scrub(JSON.stringify(p.input || {}))), call };
          toolById[p.id] = step; turn().steps.push(step); turn().tools[p.name] = (turn().tools[p.name] || 0) + 1;
        }
      }
    }
  }
  return { turns, calls: calls.filter(c => c.model !== '<synthetic>'), results };
}

function arm(row) {
  const dir = path.dirname(row.transcript), sid = row.session;
  const main = conversation(row.transcript);
  const subs = [];
  const sdir = path.join(dir, sid, 'subagents');
  if (fs.existsSync(sdir)) for (const f of fs.readdirSync(sdir).filter(x => x.endsWith('.jsonl')).sort()) {
    let meta = {}; try { meta = JSON.parse(fs.readFileSync(path.join(sdir, f.replace(/\.jsonl$/, '.meta.json')), 'utf8')); } catch {}
    const sub = { type: meta.agentType || 'agent', toolUseId: meta.toolUseId || null };
    sub.conv = conversation(path.join(sdir, f), { sub });
    if (!sub.conv.calls.length) continue;
    sub.model = sub.conv.calls.find(c => c.model)?.model || null; subs.push(sub);
  }
  // each subagent belongs to the lead's turn that holds the Agent call which started it
  const toolStep = {}, turnOfTool = {};
  for (const t of main.turns) for (const s of t.steps) if (s.kind === 'tool') { toolStep[s.id] = s; turnOfTool[s.id] = t; }
  for (const sub of subs) { sub.turn = turnOfTool[sub.toolUseId] || main.turns.at(-1); for (const c of sub.conv.calls) c.t = sub.turn.n; }
  // one numbering over every conversation, by time
  const all = [...main.calls, ...subs.flatMap(s => s.conv.calls)].sort((a, b) => a.at - b.at);
  all.forEach((c, i) => { c.k = i + 1; });
  for (const sub of subs) sub.turn.calls.push(...sub.conv.calls);
  for (const conv of [main, ...subs.map(s => s.conv)]) for (const t of conv.turns) {
    t.calls = t.calls.map(c => c.k).sort((a, b) => a - b);
    for (const s of t.steps) if (s.kind === 'call') { s.k = s.call.k; delete s.call; } else if (s.kind === 'tool') { s.k = s.call.k; delete s.call; }
  }
  for (const sub of subs) {
    const payload = { type: sub.type, model: sub.model, calls: sub.conv.calls.length, turns: sub.conv.turns };
    const st = toolStep[sub.toolUseId];
    if (st) st.sub = payload; else main.turns.at(-1).steps.push({ kind: 'tool', id: sub.toolUseId, name: 'Agent', input: { subagent_type: sub.type }, sub: payload });
  }
  const results = [...main.results, ...subs.flatMap(s => s.conv.results)].map(r => ({ c: r.c, at: r.call.k, t: r.call.t, cut: null }));
  const calls = all.map(c => ({ k: c.k, t: c.t, read: c.read, write: c.write, write1h: c.write1h, write5m: c.write - c.write1h, input: c.input, out: c.out, model: c.model, ...(c.agent ? { agent: c.agent } : {}) }));
  const plain = String(row.outcome || '').replace(/\x1b\[[0-9;]*m/g, '');
  const passed = /^PASS/.test(plain);
  const counts = (plain.match(/\d+ (?:failed|passed)/g) || []).join(', ');
  const handoffs = main.turns.flatMap(t => t.steps.filter(s => s.kind === 'tool' && s.handoff).map(s => ({ k: s.k, t: t.n, tool: s.name, file: s.input.file_path || s.input.command || null })));
  // what each handed-over read would have put in the context, from the hook's own log row for the firing
  let fired = [];
  try { fired = rows(path.join(row.cwd, '.thinker', 'log.jsonl')).filter(r => r.op === 'delegate' && r.fired !== false && !r.after && !r.held && r.tokens > 0); } catch {}
  for (const h of handoffs) { const i = fired.findIndex(r => (r.files || []).some(f => h.file && (h.file === f || h.file.endsWith('/' + f) || f.endsWith('/' + h.file)))); if (i >= 0) { h.tokens = fired[i].tokens; fired.splice(i, 1); } }
  const costOf = c => { const p = prices[c.model] || priceOf(row.model); return (c.input * p.input + c.out * p.out + c.read * p.read + c.write1h * p.w1h + (c.write - c.write1h) * p.w5m) / 1e6; };
  const agents = subs.map(s => ({ type: s.type, model: s.model, t: s.turn.n, k: toolStep[s.toolUseId]?.k ?? s.conv.calls[0].k, calls: s.conv.calls.length, cost: s.conv.calls.reduce((a, c) => a + costOf(c), 0), reportChars: (s.conv.turns.flatMap(t => t.steps).filter(x => x.kind === 'say').at(-1)?.text || '').length || null }));
  // the judge's verdict where the task had criteria written before the run (bench.mjs grade)
  let judgment = null;
  if (row.grade && !row.grade.error) {
    const crit = JSON.parse(fs.readFileSync(path.join(ROOT, row.tasksDir, row.task, 'criteria.json'), 'utf8')).criteria;
    judgment = { judge: row.grade.judge, pass: row.grade.pass, met: row.grade.met, total: row.grade.of, essentialMet: row.grade.essentialMet, essentialOf: row.grade.essentialOf, criteria: crit.map(c => ({ id: c.id, behavior: c.behavior, essential: Boolean(c.essential) })), verdicts: row.grade.verdicts.map(v => ({ id: v.id, met: Boolean(v.met), why: v.why || '' })) };
  }
  return {
    small: { sid, outcome: counts || null, passed, ...(judgment ? { judgment } : {}), elapsedMs: row.wallMs, calls, results, notes: [], turns: main.turns.map(t => ({ n: t.n, tools: t.tools, calls: t.calls })), agents, handoffs },
    session: { sid, turns: main.turns, calls },
  };
}

const bare = rowOf('bare'), del = rowOf('delegate');
strip.push(fs.realpathSync(bare.cwd), bare.cwd, fs.realpathSync(del.cwd), del.cwd);
const ctl = arm(bare), cut = arm(del);
const lead = bare.model, id = A.id;
const head = { id, price: priceOf(lead), prices, cold: 0, delegation: true, recordedTTL: true, model: 'Claude Opus 5.5', task: A.task, source: `thinker bench · ${A.tag} · ${ctl.small.turns.length} prompts · one pair` };
fs.writeFileSync(path.join(SITE, `clearing-${id}.json`), JSON.stringify({ ...head, control: ctl.small, cut: cut.small }));
fs.writeFileSync(path.join(SITE, `clearing-${id}-session.json`), JSON.stringify({ ...head, control: ctl.session, cut: cut.session, blobs }));
const usd = s => s.calls.reduce((a, c) => { const p = prices[c.model] || head.price; return a + (c.input * p.input + c.out * p.out + c.read * p.read + c.write1h * p.w1h + c.write5m * p.w5m) / 1e6; }, 0);
for (const [n, a, r] of [['bare', ctl, bare], ['delegate', cut, del]]) {
  console.error(`${id} ${n}: ${a.small.calls.filter(c => !c.agent).length} lead calls + ${a.small.calls.filter(c => c.agent).length} in ${a.small.agents.length} subagents, ${a.small.handoffs.length} handoffs, $${usd(a.small).toFixed(2)} at list (1h) against $${r.costReported.toFixed(2)} reported, ${a.small.passed ? 'PASS' : 'FAIL'} ${a.small.outcome}`);
}
