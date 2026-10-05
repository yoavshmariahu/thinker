// What travels between a checkout and the central cache, and the ids both sides check. Shared by
// the internal server (server/repos.js); it lives outside src/server because the
// public release archive leaves the server out (scripts/pack.sh) and the client must still load.
import crypto from 'node:crypto';
import { sharedContent } from './store.js';

export const REPO_ID = /^[a-z0-9][a-z0-9.-]*(\/[a-z0-9._-]+)+$/i;
export const NOTE_ID = /^[a-z0-9][a-z0-9-]*$/;
export const digest = content => crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16);

// What is synchronized of a note: its content (store.js:sharedContent) and what sessions anywhere
// said about it. Not a checkout's own state (uses, servedIn, staleness against its working tree).
// `status` travels beside it: a retired note is retired everywhere, a stale one only where it is stale.
export const SYNC_FIELDS = ['attest', 'history'];
export function syncContent(note) {
  const out = sharedContent(note);
  for (const k of SYNC_FIELDS) if (note[k] !== undefined && note[k] !== null) out[k] = note[k];
  return out;
}
export function wire(note) {
  const out = syncContent(note);
  if (note.status === 'invalid') { out.status = 'invalid'; if (note.invalidReason) out.invalidReason = note.invalidReason; }
  else out.status = 'fresh';
  return out;
}
