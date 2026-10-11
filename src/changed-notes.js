// Notes resting on the code the working tree changes. The prompt hook keys its bundle on the request,
// which for a review ("look at this diff for bugs") names no code: on the held-out review benchmark the
// hook and the agent's own orient served nothing in 15 of 15 sessions while the cache held notes on the
// changed file in 10. A session that starts with a change in progress is served the notes review itself
// would consult first (review.js:selectNotes, the `direct` notes), whatever the request says.
import { resolveScope, collectChange, makeReader, selectNotes } from './review.js';
import { renderNote } from './rank.js';

const NONE = { text: '', included: [], files: [] };

export function changedCodeNotes(store, { session, client, max = 3, exclude = new Set() } = {}) {
  if (!store.exists() || store.config().changedNotes === false) return NONE;
  let change, reader;
  try {
    const scope = resolveScope(store.repo);
    change = collectChange(store.repo, scope);
    if (!change.files?.length) return NONE;
    reader = makeReader(store.repo, scope);
  } catch { return NONE; }
  const live = store.list().filter(n => n.status !== 'invalid' && !n.archived && !exclude.has(n.id) && !(session && (n.servedIn || []).includes(session)));
  if (!live.length) return NONE;
  const { direct } = selectNotes(live, change, reader);   // sorted: symbol-level deps the change altered first
  const pick = direct.slice(0, max);
  if (!pick.length) return NONE;
  if (session) for (const n of pick) { n.uses = (n.uses || 0) + 1; n.servedIn = [...(n.servedIn || []), session].slice(-30); store.put(n); }
  const files = [...new Set(change.files.map(f => f.path))];
  const shown = files.slice(0, 6).join(', ') + (files.length > 6 ? `, and ${files.length - 6} more` : '');
  const intro = `Notes from earlier sessions about code the working tree changes (${shown}). They state what this code was made to do; check the change against them, and keep reading what the change needs.`;
  const text = `<thinker-cache>\n${intro}\n\n${pick.map(n => renderNote(n)).join('\n\n')}\n</thinker-cache>`;
  store.log({ op: 'changed', session, client: client || 'cli', files, served: pick.map(n => n.id) });
  return { text, included: pick, files };
}
