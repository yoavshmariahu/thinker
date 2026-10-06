// What would have to change for a note to become wrong, and what follows from that.
//
// It is stored on the note by background maintenance and used for one decision: a note whose truth
// rests on a tool outside this repository is re-baselined in code when its deps change, because no
// change here can falsify it and no model reading a diff of this repository can settle it.
//
// A derived verdict may only ever be `still_valid`. `update` needs a rewritten body, which no check can
// produce, and a wrong `still_valid` leaves a false note serving, so anything a check cannot settle
// falls through to the model. Deriving it from the numbers a note states was tried and rejected
// (bench/RESULTS.md, "Derived verify verdicts"): the matches were incidental numbers in prose while the
// note's real claims went unexamined.
import { createHash } from 'crypto';
import { jevConfig, jevEvaluate } from './jev.js';

export const DRIFT_SURFACES = {
  a_symbol_moving: 'A named function, constant or class it depends on is renamed, moved or removed.',
  a_number_changing: 'A threshold, default, limit or version number it states is changed.',
  a_path_changing: 'A file or directory path it names is moved or renamed.',
  a_flag_or_env_var_changing: 'A command-line flag or environment variable name it states is renamed or dropped.',
  an_external_tool_changing: 'A tool or service outside this repository changes its behaviour.',
};
export const DRIFT_VERSION = 1;
// Retype when the note's own text changes, as phraseKey does for the search description.
export const driftKey = n => `${DRIFT_VERSION}:${createHash('sha1').update(`${n.kind}\u0000${n.title}\u0000${n.body || ''}`).digest('hex').slice(0, 16)}`;
export const driftStale = n => !n.drift || n.drift.key !== driftKey(n);
export const externalSurface = n => n.drift?.surface === 'an_external_tool_changing';

// Which one surface is most likely: a Choice, since the surfaces are exclusive and the answer carries
// its own confidence. Batched, under jevEvaluate's limits (32 questions, 30 KB), so a run of 36 notes is
// three calls rather than one per note. Returns [{id, surface, confidence, key}]; throws for the caller.
export const DRIFT_BATCH = 12;
export async function typeDrift(store, notes, cfg = {}) {
  if (!notes.length) return [];
  const c = { ...jevConfig(store), ...cfg };
  const out = [];
  for (let i = 0; i < notes.length; i += DRIFT_BATCH) {
    const batch = notes.slice(i, i + DRIFT_BATCH);
    const state = { candidate_notes: batch.map((n, k) => ({ index: k, kind: n.kind, title: n.title,
      claim: (n.body || '').split('\n').filter(Boolean).slice(0, 4).join(' ').slice(0, 500),
      points_at: (n.deps || []).map(d => (d.symbol ? `${d.path}:${d.symbol}` : d.path)).slice(0, 4) })) };
    const questions = Object.fromEntries(batch.map((n, k) => [`d${k}`, { type: 'choice',
      instructions: `Which ONE change is the most likely way the note at \`candidate_notes[${k}]\` becomes wrong? Name the most specific surface, not the broadest.`,
      criteria: DRIFT_SURFACES }]));
    const res = await jevEvaluate(state, questions, c);
    batch.forEach((n, k) => {
      const a = res.answers[`d${k}`];
      if (a?.choice) out.push({ id: n.id, surface: a.choice, confidence: Number((a.confidence ?? 0).toFixed(3)), key: driftKey(n) });
    });
  }
  return out;
}

// A verdict the code established on its own, or null to let the model decide. Only `still_valid`.
export function derivedVerdict(repo, note, { minConfidence = 0.6 } = {}) {
  const surface = note.drift?.surface;
  if (!surface || (note.drift.confidence ?? 0) < minConfidence) return null;
  if (driftStale(note)) return null;                       // the note was edited since it was typed
  const changed = note.stale?.changed || [];
  if (!changed.length) return null;
  // a vanished symbol or file is exactly what the note could not survive; the model should see it
  if (changed.some(c => c.reason === 'file removed' || c.reason === 'symbol not found')) return null;
  // Nothing in this repository can falsify a claim about a tool outside it, so a changed dep is not
  // evidence against the note: re-baseline it in code. Sending it to a model would spend a call on a
  // diff that cannot answer the question, and leaving it stale would bench it, since the prompt hooks
  // serve no stale note. What such a note really wants is re-checking on a schedule, which is not built.
  if (surface === 'an_external_tool_changing') {
    return { verdict: 'still_valid', reason: 'rests on the behaviour of a tool outside this repository, which a change here cannot falsify', noBump: true };
  }
  // No other surface is safely derivable. Checking the numbers a note states was tried and measured
  // unsafe: of 147 stale notes only 12 had every stated number still bound to the same name, and
  // reading those showed the matches were incidental prose ("cover: {body: 0, question: 0}") while the
  // note's real claims went unexamined — one would have passed with five of its symbols changed. A
  // symbol whose body changed, a path that still exists and a flag still referenced prove just as
  // little. See bench/RESULTS.md, "Derived verify verdicts".
  return null;
}
