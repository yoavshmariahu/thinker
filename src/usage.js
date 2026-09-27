// Usage history: a summary of .thinker/log.jsonl, the append-only record of what was
// served, learned, verified and mined in this checkout, with an estimate of the
// exploration the served notes saved.
//
// The estimate counts only servings that the end-of-session assessment marked
// `confirmed` (the agent acted on the note and nothing contradicted it). For each,
// it takes one read per file the note rests on (at most 5) and the tokens those
// reads would have returned (each file capped at what one read returns). Searches
// to find the files, and the re-reading of earlier output on every later model
// call, are left out. It is an estimate of reading avoided, not a measurement.
import fs from 'node:fs';
import path from 'node:path';
import { estTokens } from './rank.js';

const FILE_CAP = 6000;   // tokens one read of a large file returns (about 2000 lines)
const MAX_FILES = 5;

export function savingOf(repo, note) {
  let calls = 0, tokens = 0;
  for (const f of [...new Set((note?.deps || []).map(d => d.path).filter(Boolean))].slice(0, MAX_FILES)) {
    try { const st = fs.statSync(path.join(repo, f)); if (!st.isFile()) continue; calls++; tokens += Math.min(Math.ceil(st.size / 3.6), FILE_CAP); } catch {}
  }
  return { calls, tokens };
}

// fields added to a serving's log line
export const servedFields = (store, notes, text) => ({ tokens: estTokens(text || ''), est: notes.map(n => { const s = savingOf(store.repo, n); return [s.calls, s.tokens]; }) });

export function readLog(store) {
  let raw = ''; try { raw = fs.readFileSync(path.join(store.dir, 'log.jsonl'), 'utf8'); } catch {}
  return raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(e => e && e.t && e.op);
}

export function summarize(store, { days } = {}) {
  const since = days ? new Date(Date.now() - days * 86400_000).toISOString() : '';
  const events = readLog(store).filter(e => e.t >= since);
  const u = {
    from: events[0]?.t || null, to: events[events.length - 1]?.t || null, events: events.length,
    requests: 0, answered: 0, sessions: 0,
    servings: { prompt: 0, file: 0, lookup: 0 }, notesServed: 0, tokensServed: 0,
    assessed: { confirmed: 0, contradicted: 0, unused: 0, pending: 0 },
    learned: { sessions: 0, notes: 0, merged: 0, prs: 0, prNotes: 0 },
    verified: { still_valid: 0, update: 0, invalid: 0 },
    feedback: { useful: 0, notUseful: 0 }, corrections: 0,
    spent: 0, saved: { calls: 0, tokens: 0, servings: 0 }, top: [],
  };
  const sessions = new Map();   // session → Map(note id → [calls, tokens])
  const verdicts = new Map();   // session → Map(note id → verdict)
  const count = new Map();
  let anon = 0;
  for (const e of events) {
    if (typeof e.cost === 'number') u.spent += e.cost;
    if (e.op === 'orient' || e.op === 'late' || e.op === 'lookup') {
      const ids = e.served || [];
      if (e.op !== 'late') { u.requests++; if (ids.length) u.answered++; }
      if (!ids.length) continue;
      u.servings[e.op === 'orient' ? 'prompt' : e.op === 'late' ? 'file' : 'lookup'] += ids.length;
      // lines written before the estimate was recorded: the note's text and files as they are now
      u.tokensServed += typeof e.tokens === 'number' ? e.tokens : ids.reduce((s, id) => s + estTokens(store.get(id)?.body || ''), 0);
      const key = e.session && e.session !== 'unknown' ? e.session : `?${anon++}`;
      if (!sessions.has(key)) sessions.set(key, new Map());
      ids.forEach((id, i) => {
        count.set(id, (count.get(id) || 0) + 1);
        if (!sessions.get(key).has(id)) sessions.get(key).set(id, e.est?.[i] || Object.values(savingOf(store.repo, store.get(id))));
      });
    } else if (e.op === 'attest') {
      if (!verdicts.has(e.session)) verdicts.set(e.session, new Map());
      for (const a of e.applied || []) verdicts.get(e.session).set(a.id, a.verdict);
    } else if (e.op === 'distill') { u.learned.sessions++; u.learned.notes += (e.saved || []).length; u.learned.merged += (e.merged || []).length; }
    else if (e.op === 'mine-prs') { u.learned.prs += e.prs || 0; u.learned.prNotes += e.saved || 0; }
    else if (e.op === 'verify') { if (e.verdict in u.verified) u.verified[e.verdict]++; }
    else if (e.op === 'feedback') { u.feedback[e.useful ? 'useful' : 'notUseful']++; }
    else if (e.op === 'outcome' && !e.positive) u.corrections++;
  }
  u.sessions = [...sessions.keys()].filter(k => !k.startsWith('?')).length;
  const distinct = new Set();
  for (const [key, notes] of sessions) for (const [id, est] of notes) {
    distinct.add(id);
    const v = verdicts.get(key)?.get(id);
    if (v === 'confirmed') { u.assessed.confirmed++; u.saved.servings++; u.saved.calls += est[0] || 0; u.saved.tokens += est[1] || 0; }
    else if (v === 'contradicted') u.assessed.contradicted++;
    else if (v) u.assessed.unused++;
    else u.assessed.pending++;
  }
  u.notesServed = distinct.size;
  u.saved.net = u.saved.tokens - u.tokensServed;
  u.spent = Math.round(u.spent * 100) / 100;
  u.top = [...count].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, n]) => ({ id, served: n, title: store.get(id)?.title || '(removed)' }));
  return u;
}

const num = n => Math.round(n).toLocaleString('en-US');
export function renderUsage(u, { repo, notes, days }) {
  if (!u.events) return `No usage recorded for ${repo}${days ? ` in the last ${days} days` : ''}. thinker records it in .thinker/log.jsonl as notes are served.`;
  const L = [];
  const servings = u.servings.prompt + u.servings.file + u.servings.lookup;
  const assessed = u.assessed.confirmed + u.assessed.contradicted + u.assessed.unused;
  L.push(`thinker usage for ${repo}, ${u.from.slice(0, 10)} to ${u.to.slice(0, 10)}${days ? ` (last ${days} days)` : ''}`, '');
  L.push('Served');
  L.push(`  requests        ${num(u.requests)}, ${num(u.answered)} answered with notes${u.sessions ? `, in ${num(u.sessions)} sessions` : ''}`);
  L.push(`  notes served    ${num(servings)} (${num(u.servings.prompt)} with the request, ${num(u.servings.file)} on opening a file, ${num(u.servings.lookup)} by lookup); ${num(u.notesServed)} different notes of ${num(notes)}`);
  L.push(`  tokens added    ${num(u.tokensServed)}`);
  L.push('', 'What the sessions showed');
  L.push(`  acted on        ${num(u.assessed.confirmed)}${assessed ? ` of ${num(assessed)} assessed` : ''}`);
  L.push(`  not used        ${num(u.assessed.unused)}`);
  L.push(`  contradicted    ${num(u.assessed.contradicted)} (corrected from the session)`);
  L.push(`  not assessed    ${num(u.assessed.pending)} (no session id, session not distilled yet, or learning off)`);
  if (u.corrections || u.feedback.useful || u.feedback.notUseful) L.push(`  feedback        ${num(u.feedback.useful)} useful, ${num(u.feedback.notUseful)} not useful, ${num(u.corrections)} follow-up corrections`);
  L.push('', 'Learned');
  L.push(`  sessions        ${num(u.learned.sessions)} distilled: ${num(u.learned.notes)} new notes, ${num(u.learned.merged)} merged into existing ones`);
  L.push(`  pull requests   ${num(u.learned.prs)} mined: ${num(u.learned.prNotes)} notes`);
  L.push(`  re-verified     ${num(u.verified.still_valid + u.verified.update + u.verified.invalid)} stale notes: ${num(u.verified.still_valid)} still valid, ${num(u.verified.update)} rewritten, ${num(u.verified.invalid)} retired`);
  L.push(`  model cost      $${u.spent.toFixed(2)} where the agent reported it`);
  L.push('', 'Estimated saving');
  if (!u.saved.servings) L.push(`  none counted yet: only notes a session is seen to act on are counted, and none has been assessed so far`);
  else {
    L.push(`  tool calls      about ${num(u.saved.calls)} reads avoided`);
    L.push(`  tokens          about ${num(u.saved.tokens)} of file reading avoided; ${num(Math.abs(u.saved.net))} ${u.saved.net >= 0 ? 'more than' : 'less than'} the ${num(u.tokensServed)} the notes added`);
    L.push(`  basis           ${num(u.saved.servings)} servings the agent acted on: one read per file a note rests on (at most ${MAX_FILES}),`);
    L.push(`                  at the file's size (at most ${num(FILE_CAP)} tokens). Searches and re-read context are not counted. An estimate, not a measurement.`);
  }
  if (u.top.length) { L.push('', 'Most served'); for (const t of u.top) L.push(`  ${String(t.served).padStart(4)}  ${t.title.slice(0, 90)}`); }
  return L.join('\n');
}
