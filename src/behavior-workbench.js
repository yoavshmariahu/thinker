// Defining the desired behaviors of a system together with a person: what is waiting for a decision,
// and the decisions. Two things wait: drafts the build wrote from the strongest rule notes
// (behavior-proposals.js, a file beside the notes) and behaviors an agent saved with `remember`
// (behavior.js:proposed). Neither is a requirement until a person accepts it, as written or
// edited. `thinker system define` (the terminal) and `thinker ui` (the local page) are the two ways
// in; both call only what is here.
import { listBehaviors, isBehavior, proposed, promoteBehavior, writeSystemMarkdown } from './behavior.js';
import { listBehaviorProposals, acceptBehaviorProposal, discardBehaviorProposal } from './behavior-proposals.js';
import { createNote, MUTABILITY } from './ops.js';

const pointers = deps => (deps || []).map(d => `${d.path}${d.symbol ? ':' + d.symbol : ''}`);

// Everything a person can decide on, drafts first (they carry their evidence), then agent proposals.
export function pendingBehaviors(store) {
  const drafts = listBehaviorProposals(store).map(p => ({
    id: p.id, origin: 'draft', title: p.title, body: p.body, mutability: p.mutability || 'mutable',
    reason: p.reason, evidence: p.source?.ref || p.source?.type || p.sourceId, sourceId: p.sourceId, pointers: pointers(p.deps),
  }));
  const agent = store.list().filter(n => isBehavior(n) && proposed(n) && n.status !== 'invalid').map(n => ({
    id: n.id, origin: 'agent', title: n.title, body: n.body, mutability: n.mutability || 'mutable',
    reason: 'Saved by an agent during a session', evidence: n.source?.session ? `session ${String(n.source.session).slice(0, 8)}` : (n.source?.type || 'agent'), pointers: pointers(n.deps),
  }));
  return [...drafts, ...agent];
}

// The behaviors in force, with what a person needs to judge them.
export function activeBehaviors(store) {
  return listBehaviors(store).filter(r => !r.proposed).map(({ note, ...r }) => ({
    ...r, body: note.body, applies: note.applies || '', pointers: pointers(note.deps),
    origin: note.source?.proposedFrom ? 'accepted draft' : note.source?.promoted ? `promoted ${note.source.promoted}` : 'written by a person',
  }));
}

// Accept a pending behavior, optionally rewritten. `edit`: { title, body }.
export function acceptPending(store, id, { mutability = 'mutable', edit = null } = {}) {
  if (!MUTABILITY.includes(mutability)) return { error: `mutability must be one of ${MUTABILITY.join(', ')}` };
  if (String(id).startsWith('proposal-')) return acceptBehaviorProposal(store, id, { fixed: mutability === 'fixed', edit });
  const n = store.get(id);
  if (!n || !isBehavior(n) || !proposed(n)) return { error: 'no such proposed behavior' };
  if (edit && (edit.title || edit.body)) {
    const r = createNote(store, { ...n, title: (edit.title || n.title).trim(), body: (edit.body || n.body).trim() }, { source: n.source, reuseId: true });
    if (r.error) return r;
  }
  return promoteBehavior(store, id, { mutability });
}

export function discardPending(store, id) {
  if (String(id).startsWith('proposal-')) return discardBehaviorProposal(store, id);
  const n = store.get(id);
  if (!n || !isBehavior(n) || !proposed(n)) return { error: 'no such proposed behavior' };
  store.remove(id);
  store.log({ op: 'behavior', id, action: 'discard-proposal' });
  writeSystemMarkdown(store);
  return { discarded: id };
}

// A person edits a behavior in force: its words, its pointers (written into the body) or whether it
// is fixed. It stays theirs; the old text goes to the note's history.
export function editBehavior(store, id, { title, body, mutability } = {}) {
  const n = store.get(id);
  if (!n || !isBehavior(n)) return { error: 'no such behavior' };
  if (mutability && !MUTABILITY.includes(mutability)) return { error: `mutability must be one of ${MUTABILITY.join(', ')}` };
  const changedText = (title && title.trim() !== n.title) || (body && body.trim() !== n.body);
  // only fixed/mutable changed: the note is otherwise untouched, its hashes and its stale or violated
  // status included, so switching it never passes for having checked the code
  if (!changedText) {
    const m = mutability || n.mutability || 'mutable';
    if (m !== (n.mutability || 'mutable')) { store.put({ ...n, mutability: m }); store.log({ op: 'behavior', id, action: 'edit', mutability: m }); writeSystemMarkdown(store); }
    return { note: store.get(id) };
  }
  // new words are the person's, written against the code as it is now: the note is re-anchored there
  const next = { ...n, title: (title || n.title).trim(), body: (body || n.body).trim(), mutability: mutability || n.mutability || 'mutable' };
  next.history = [...(n.history || []), { at: new Date().toISOString(), title: n.title, body: n.body, reason: 'edited by a person' }];
  const r = createNote(store, next, { source: n.source?.type === 'human' ? n.source : { type: 'human', from: n.source }, reuseId: true });
  if (r.error) return r;
  store.put({ ...r.note, history: next.history });
  store.log({ op: 'behavior', id, action: 'edit', mutability: next.mutability });
  writeSystemMarkdown(store);
  return { note: store.get(id) };
}

