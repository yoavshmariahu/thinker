// A one-time reset of the staleness marks, run once per repository by `thinker rewire` after an
// update (the new copy runs it for every checkout it is wired into), beside retire-background.js.
//
// Why. A dep's hash moving says the code the note rests on changed. It was being read as "this note
// may be wrong", and it is not: measured 2026-10-28, of the notes marked stale the verifier answered
// `still_valid` on 53% across production (664 of 1,246) and 51% on this machine over all history,
// with 6 of 664 of those passes later doubted. Nor is the hash too twitchy - of 543 changed deps
// behind this repository's stale notes only 10 differed by comments or whitespace alone - so the mark
// is accurate and the inference from it was wrong. Meanwhile a stale note is withheld from the hooks,
// could not be verified while withheld (fixed: `heldAt`), and was deleted for not being served. Caches
// had silted up: 318 of 440 notes here, 1,236 of 2,683 across production. This clears that backlog in
// one step instead of waiting weeks for verification to work through it.
//
// What it does, per note with `status: 'stale'`: exactly what a `still_valid` verdict does to the
// record (ops.js:verifyNote) - re-hash every dep against the working tree and drop the `stale` block -
// because setting the status alone changes nothing: the next `refresh` re-derives staleness from the
// stored hashes and marks it stale again. `verifiedCommit` moves to HEAD so a later staleness diff is
// measured from here rather than from a commit weeks back.
//
// What it does not do. It does not touch `confidence`, and it does not set `verified`: no model
// looked at these notes, and a reset is not a verification. It records `rebaselined` instead (a
// LOCAL_FIELDS entry), so the notes it waved through stay identifiable afterwards. Notes that are
// `invalid`, a `violated` behavior and a `broken` skill card are left alone; only `stale` is cleared.
//
// What it costs. About half of these notes were going to come back `update` or `invalid`, and they
// are now served without the ⚠ STALE banner that used to warn the agent. That is the trade the reset
// makes: a withheld note helps nobody, and the ones that are wrong are found again the next time
// their code changes. The prior state of every note it touched is kept in the marker file, so the
// reset can be undone.
import fs from 'node:fs';
import path from 'node:path';
import { hashDep } from './deps.js';
import { gitHead } from './store.js';

// Bump to run a fresh reset on every repository; a repository already at this version is skipped.
export const RESET_VERSION = 1;
export const markerFile = store => path.join(store.dir, 'state', 'stale-reset.json');
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// { cleared, skipped } with the ids, or null where there is nothing to do or it has already run.
export function resetStaleMarks(store, { dry = false, now = () => new Date().toISOString() } = {}) {
  if (!store.exists()) return null;
  const file = markerFile(store);
  const done = readJson(file);
  if (done && Number(done.version) >= RESET_VERSION) return null;
  let notes;
  try { notes = store.list(); } catch { return null; }
  const stale = notes.filter(n => n.status === 'stale');
  if (!stale.length) {
    // nothing to clear, but the repository is still marked so the scan does not run again
    if (!dry) writeMarker(file, { at: now(), cleared: [], before: [] });
    return null;
  }
  const at = now();
  const head = gitHead(store.repo);
  const before = [], cleared = [], skipped = [];
  for (const n of stale) {
    // the prior record, enough to put the note back as it was
    const prior = { id: n.id, status: n.status, stale: n.stale, deps: n.deps, verifiedCommit: n.verifiedCommit };
    if (dry) { before.push(prior); cleared.push(n.id); continue; }
    try {
      const next = { ...n, deps: (n.deps || []).map(d => hashDep(store.repo, d)), status: 'fresh', verifiedCommit: head || n.verifiedCommit, rebaselined: { at, from: n.verifiedCommit || null } };
      delete next.stale;
      store.put(next);
      before.push(prior); cleared.push(n.id);
    } catch { skipped.push(n.id); }   // a note whose deps cannot be hashed is left stale
  }
  if (!dry) {
    writeMarker(file, { at, cleared, before });
    store.log({ op: 'stale-reset', version: RESET_VERSION, cleared: cleared.length, skipped: skipped.length });
  }
  return { cleared, skipped };
}

function writeMarker(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: RESET_VERSION, ...body }));
}

// Put back what the reset waved through, from the marker file it wrote. A note a session has since
// corrected, rewritten or retired is left as it is: the reset is not worth undoing over a note the
// cache has already moved past.
export function undoStaleReset(store, { dry = false } = {}) {
  const done = readJson(markerFile(store));
  if (!done?.before?.length) return null;
  const restored = [], left = [];
  for (const p of done.before) {
    const n = store.get(p.id);
    if (!n || n.status !== 'fresh' || !n.rebaselined) { left.push(p.id); continue; }
    if (dry) { restored.push(p.id); continue; }
    const next = { ...n, status: p.status, deps: p.deps, verifiedCommit: p.verifiedCommit };
    if (p.stale) next.stale = p.stale; else delete next.stale;
    delete next.rebaselined;
    store.put(next);
    restored.push(p.id);
  }
  if (!dry && restored.length) store.log({ op: 'stale-reset-undo', restored: restored.length, left: left.length });
  return { restored, left };
}
