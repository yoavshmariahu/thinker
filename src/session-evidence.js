// What the sessions themselves show: the evidence the chat reads when it is asked why (the owner, 2026-11-22: "the
// thinker chat needs to have access to historical sessions to answer questions like 'why was there so much rework in
// the merge step lately'"). Until this the chat had the Factory's sums alone, which say where the rework is and never
// why, and it was told to say so.
//
// One question, three parts, each optional: a stage of the Factory, a kind of loop, and how far back. The sessions
// of that window are ranked by what they spent inside loops -- at that stage, or of that kind -- from the Factory's
// own record of each (factory.js:sessionRecord, the cache the Factory tab fills), and the few with the most are read
// again for what happened inside those loops (factory.js:loopDetail): the prompt that opened the exchange and who
// wrote it, the commands run with the first telling line a failing one printed, the files edited, and the last thing
// the agent said. That is what a person would look for if they opened the transcripts themselves.
//
// No model is called here and nothing is kept: the transcripts are read where they lie, a handful of them, by the
// same parser and the same loop rules as the Factory, so a figure here is never a second opinion on one there. What
// comes back is the person's own prompts and commands, shown to the model that answers them through their own login,
// as the profile's read of a session is; the log row about it carries counts and never words.
import { parseTranscript } from './transcripts.js';
import { listPrice, formatDollars } from './prices.js';
import { formatTokens } from './model-usage.js';
import { STAGES, LOOP_KINDS, sessionRecord, windowSessions, loopDetail } from './factory.js';

export const EVIDENCE = {
  days: 14,      // "lately", where the question gives no window
  maxDays: 60,   // as far back as the ledger and the report go
  sessions: 6,   // sessions read for one answer, the ones with the most rework in what was asked about
  loops: 2,      // loops shown of one session, the costliest
  steps: 6,      // steps shown of one loop
  chars: 16_000, // about what the evidence may come to in the prompt
};
const DAY = 86_400_000;
const STAGE_KEYS = STAGES.map(([k]) => k);
export const stageName = k => STAGES.find(([x]) => x === k)?.[1] || null;
const sum = (xs, f) => xs.reduce((a, x) => a + (f(x) || 0), 0);

// What was asked about, held to what exists: an unknown stage or loop is no filter, and the window is clamped.
export function evidenceQuery({ stage, loop, days } = {}) {
  const s = STAGE_KEYS.includes(String(stage || '').toLowerCase()) ? String(stage).toLowerCase() : null;
  const l = Object.hasOwn(LOOP_KINDS, String(loop || '')) ? String(loop) : null;
  const d = Number(days);
  return { stage: s, loop: l, days: Number.isFinite(d) && d >= 1 ? Math.min(EVIDENCE.maxDays, Math.round(d)) : EVIDENCE.days };
}

// What one conversation spent inside loops within the question, from its kept record: [dollars, tokens].
function reworkOf(r, { stage, loop }) {
  if (loop) { const ls = r.loops.filter(L => L.kind === loop); return [sum(ls, L => L.cost), sum(ls, L => L.tokens)]; }
  if (stage) return [r.stages[stage]?.rework || 0, r.stages[stage]?.reworkTokens || 0];
  return [sum(r.loops, L => L.cost), sum(r.loops, L => L.tokens)];
}

// The evidence for one repository. `sessions`, `parse`: given by tests.
export function sessionEvidence(store, q = {}, { now = Date.now(), max = EVIDENCE.sessions, sessions, parse = parseTranscript } = {}) {
  const { stage, loop, days } = evidenceQuery(q), from = now - days * DAY;
  const { all, corrected, config } = windowSessions(store, { from, days, now, sessions });
  const rows = [];
  let cost = 0, tokens = 0;
  for (const s of all) {
    const r = sessionRecord(s, { corrected, config });
    if (!r) continue;
    cost += r.cost; tokens += r.tokens;
    const [c, t] = reworkOf(r, { stage, loop });
    rows.push({ s, r, c, t });
  }
  const money = cost > 0, key = x => (money ? x.c : x.t);
  const hit = rows.filter(x => key(x) > 0).sort((a, b) => key(b) - key(a));
  const out = [];
  // how the rework splits by the kind of loop, so the few loops shown can be weighed against the rest: where a stage
  // is named, over the sessions read (only a transcript says which loops had a call at that stage, and what part of
  // each was the stage's); else over every session of the window, from their kept records
  const kinds = new Map();
  const tally = (L, c, t) => { const k = kinds.get(L.kind) || { kind: L.kind, name: LOOP_KINDS[L.kind]?.name || L.kind, loops: 0, cost: 0, tokens: 0 }; k.loops++; k.cost += c || 0; k.tokens += t || 0; kinds.set(L.kind, k); };
  if (!stage) for (const x of hit) for (const L of x.r.loops) if (!loop || L.kind === loop) tally(L, L.cost, L.tokens);
  for (const x of hit.slice(0, max)) {
    let d = null;
    try { const p = parse(x.s.file, { since: x.s.since || 0 }); d = loopDetail(p, { price: listPrice(p.model, { config }), corrected: corrected.get(x.s.session) || new Set(), stage, kind: loop, maxSteps: EVIDENCE.steps }); } catch { d = null; }
    if (!d?.loops.length) continue;
    if (stage) for (const L of d.loops) tally(L, L.stageCost, L.stageTokens);
    out.push({ id: x.s.session, at: new Date(x.s.mtime).toISOString(), sub: Boolean(x.s.parent), title: d.title, model: d.model, cost: d.cost, tokens: d.tokens, rework: x.c, reworkTokens: x.t, loops: d.loops.slice(0, EVIDENCE.loops), moreLoops: Math.max(0, d.loops.length - EVIDENCE.loops) });
  }
  return {
    stage, loop, days, money, measured: rows.length, hit: hit.length,
    cost, tokens, rework: sum(hit, x => x.c), reworkTokens: sum(hit, x => x.t),
    kinds: [...kinds.values()].sort((a, b) => (money ? b.cost - a.cost : b.tokens - a.tokens)),
    sessions: out,
  };
}

const dateSaid = t => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const about = ({ stage, loop }) => (stage && loop ? `${LOOP_KINDS[loop].name.toLowerCase()} loops at the ${stageName(stage)} stage` : stage ? `rework at the ${stageName(stage)} stage` : loop ? `${LOOP_KINDS[loop].name.toLowerCase()} loops` : 'rework of every kind');
// In a sentence, for the line under the reply that says what was read.
export const evidenceSaid = (ev, where) => (ev.sessions.length
  ? `read ${ev.sessions.length} of the ${ev.hit} session${ev.hit === 1 ? '' : 's'} with ${about(ev)} in ${where}, the last ${ev.days} days`
  : `looked through ${ev.measured} session${ev.measured === 1 ? '' : 's'} of the last ${ev.days} days in ${where}: none had ${about(ev)}`);

// The evidence as the model is shown it. `where`: the repository's name.
export function evidenceLines(ev, where) {
  const amt = (c, t) => (ev.money ? formatDollars(c) : `${formatTokens(Math.round(t))} tokens`);
  if (!ev.sessions.length) return [`${where}, the last ${ev.days} days: ${ev.measured} sessions measured, and none had ${about(ev)}.`];
  const out = [`${where}, the last ${ev.days} days, ${about(ev)}: ${amt(ev.rework, ev.reworkTokens)} over ${ev.hit} of the ${ev.measured} sessions measured (${amt(ev.cost, ev.tokens)} spent in all). ${ev.stage && !ev.loop ? 'A stage\'s rework is what its calls cost inside any loop. ' : ''}The ${ev.sessions.length} with the most are below, read from their transcripts.`];
  if (ev.kinds.length) out.push(ev.stage
    ? `In the ${ev.sessions.length} read, the loops with a call at ${stageName(ev.stage)}, by kind, with what each kind put on that stage: ${ev.kinds.map(k => `${k.name} ×${k.loops} ${amt(k.cost, k.tokens)}`).join(' · ')}.`
    : `The loops in those ${ev.hit} sessions by kind: ${ev.kinds.map(k => `${k.name} ×${k.loops} ${amt(k.cost, k.tokens)}`).join(' · ')}.`);
  let size = out.join('\n').length;
  for (const s of ev.sessions) {
    const lines = [`- ${dateSaid(s.at)} · ${s.sub ? 'a subagent\'s conversation, given: ' : 'the session began: '}"${s.title || '(no prompt kept)'}"${s.model ? ` · ${s.model}` : ''} · ${amt(s.cost, s.tokens)} in all, ${amt(s.rework, s.reworkTokens)} of it ${about(ev)}`];
    for (const L of s.loops) {
      lines.push(`  · ${L.name} (${L.sub}${L.note && !/^(asked by the person|unasked|corrected|interrupted)$/.test(L.note) ? `: ${L.note}` : ''}), ${L.calls} model call${L.calls === 1 ? '' : 's'}, ${amt(L.cost, L.tokens)}${ev.stage ? `, ${amt(L.stageCost, L.stageTokens)} of it at ${stageName(ev.stage)}` : ''}.`);
      if (L.prompt) lines.push(`    The exchange opened with ${L.person ? 'the person writing' : 'a task notification or the harness, not the person'}: "${L.prompt}"`);
      if (L.steps.length) lines.push(`    Inside the loop: ${L.steps.join(' → ')}${L.more ? ` (and ${L.more} more step${L.more === 1 ? '' : 's'})` : ''}`);
      if (L.said) lines.push(`    The agent's last words in that exchange: "${L.said}"`);
    }
    if (s.moreLoops) lines.push(`  · and ${s.moreLoops} smaller loop${s.moreLoops === 1 ? '' : 's'} in this session`);
    const add = lines.join('\n').length + 1;
    if (size + add > EVIDENCE.chars && out.length > 2) { out.push(`- (${ev.sessions.length - ev.sessions.indexOf(s)} more sessions were read and are left out for length)`); break; }
    out.push(...lines); size += add;
  }
  return out;
}
