// A changed dependency is a request to verify, not evidence that the note is wrong.
export const needsVerification = note => note.status === 'pending' || note.status === 'stale';
export const verificationChanges = note => note.recheck?.changed || note.stale?.changed || [];
export const missingAnchor = changes => changes.some(c => c.reason === 'file removed' || c.reason === 'symbol not found');

// Missing anchors and reported contradictions stay withheld even from explicit lookups or
// the experimental serveStale path. A pending note remains eligible while verification waits.
export function canServe(note, { allowStale = false } = {}) {
  return !['invalid', 'broken'].includes(note.status) && !note.contradicted
    && !missingAnchor(verificationChanges(note)) && (allowStale || note.status !== 'stale');
}
