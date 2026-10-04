// Select evidence locally: no model is needed to decide which sessions deserve one.
import { createHash } from 'node:crypto';
import { condense, exploreCount, sessionStakes, touchedFiles } from './distill.js';

export const EVIDENCE_CHARS = 12000;
export const AUDIT_RATE = 0.05;
const clean = text => String(text || '').replace(/<thinker-cache>[\s\S]*?<\/thinker-cache>/g, '');
const significant = e => sessionStakes([{ t: 'prompt', text: '' }, e]).any;

export function learningPlan(events, { served = [], repo = '', key = '', auditRate = AUDIT_RATE, minExplore = 8 } = {}) {
  const rate = Number.isFinite(Number(auditRate)) ? Math.max(0, Math.min(1, Number(auditRate))) : AUDIT_RATE;
  const sample = createHash('sha256').update(key).digest().readUInt32BE(0) / 2 ** 32;
  const stakes = sessionStakes(events);
  const substantial = exploreCount(events) >= minExplore;
  const audit = sample < rate && (stakes.any || substantial);
  // A cache hit alone is not evidence of usefulness. Only explicit discussion of a note,
  // or a failure/correction on its dependencies, warrants a compact assessment.
  const words = events.filter(e => e.t === 'say' || e.t === 'prompt').map(e => clean(e.text)).join('\n');
  const files = new Set(touchedFiles(events, repo));
  const assess = served.filter(n => words.includes(n.id) || ((stakes.failures || stakes.corrections) && (n.deps || []).some(d => files.has(d.path)))).slice(0, 4);
  const mode = audit ? 'audit' : (stakes.any || minExplore === 0) ? 'evidence' : assess.length ? 'assessment' : 'skip';
  return { mode, served: audit ? served.slice(0, 4) : assess, discover: mode === 'audit' || mode === 'evidence',
    trace: mode === 'audit' ? condense(events) : evidencePacket(events) };
}

export function evidencePacket(events, { maxChars = EVIDENCE_CHARS } = {}) {
  const selected = new Map();
  let remaining = maxChars - 180;
  const add = (i, limit) => {
    if (i < 0 || selected.has(i) || remaining < 100) return;
    const e = events[i];
    const safe = e.t === 'prompt' || e.t === 'say' ? { ...e, text: clean(e.text) } : { ...e, result: String(e.result || '') };
    const text = condense([safe]).slice(0, Math.min(limit, remaining));
    selected.set(i, `[event ${i}] ${text}`); remaining -= text.length + 30;
  };
  add(events.findIndex(e => e.t === 'prompt'), 1000);
  const lastSay = events.findLastIndex(e => e.t === 'say');
  add(lastSay, 2400);
  // Reserve room for the first failure/correction, even in a long session, then favor
  // recent fixes and their outcomes. Preserve chronological order in the final packet.
  add(events.findIndex((e, i) => i > 0 && significant(e)), 1200);
  for (let i = events.length - 1; i >= 0; i--) if (significant(events[i])) {
    add(i, 900); if (events[i + 1]) add(i + 1, 700);
  }
  for (let i = events.length - 1; i >= 0; i--) if (events[i].t === 'tool') add(i, 700);
  return ('SELECTED EVIDENCE (omitted events are unknown, not evidence of non-use):\n' + [...selected].sort((a, b) => a[0] - b[0]).map(([, s]) => s).join('\n')).slice(0, maxChars);
}
