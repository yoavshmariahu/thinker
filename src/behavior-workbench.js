// Defining the desired behaviors of a system together with a person: what is waiting for a decision,
// and the decisions. Two things wait: drafts the build wrote from the strongest rule notes
// (behavior-proposals.js, a file beside the notes) and behaviors an agent saved with `remember`
// (behavior.js:proposed). Neither is a requirement until a person accepts it, as written or
// edited. A person may also describe a behavior in their own words, and the agent drafts it against
// the code (draftFromDescription), for the person to accept. `thinker system define` (the terminal)
// and `thinker ui` (the local page) are the two ways in; both call only what is here.
import { listBehaviors, isBehavior, proposed, addBehavior, promoteBehavior, writeSystemMarkdown } from './behavior.js';
import { listBehaviorProposals, acceptBehaviorProposal, discardBehaviorProposal } from './behavior-proposals.js';
import { createNote, MUTABILITY } from './ops.js';
import { findSymbols } from './codegraph.js';
import { symbolText } from './deps.js';
import { complete } from './llm.js';

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

const DRAFT_SCHEMA = { type: 'object', properties: {
  title: { type: 'string' }, body: { type: 'string' }, answers: { type: 'array', items: { type: 'string' } },
  deps: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, symbol: { type: 'string' } }, required: ['path'] } },
  question: { type: 'string' },
}, required: ['title', 'body', 'deps'] };

// The person says what the system must do; the agent finds where the code does it and writes the
// behavior as a draft, anchored to definitions that exist. Nothing is saved here: the person accepts
// it (acceptDraft) as written or edited. `question` is set when the code does not show where the
// rule is upheld, for the person to answer before it can be anchored.
export async function draftFromDescription(store, description, { model, completeFn = complete } = {}) {
  const found = findSymbols(store.repo, description, { limit: 8 })?.hits || [];
  const existing = activeBehaviors(store).map(b => b.title).slice(0, 30);
  const code = found.slice(0, 6).map(h => `${h.path}:${h.symbol}\n${String(symbolText(store.repo, { path: h.path, symbol: h.symbol }, 40) || '').slice(0, 2500)}`).join('\n\n---\n\n');
  const system = `A person is writing down a desired behavior of their system: something every future change must keep true. Turn their words into one behavior note. The title states the requirement in product terms. The body is 2-5 sentences: the requirement, why it matters if they said so, and where the code upholds it as path:Symbol pointers. Use only definitions from the CODE shown, and list each one you cite in deps. Do not invent intent beyond what the person said. If none of the code shown upholds it, return deps empty and ask, in question, which code does.`;
  const prompt = `THE PERSON'S WORDS:\n${description}\n\nBEHAVIORS ALREADY IN FORCE (do not duplicate):\n${existing.join('; ') || '(none)'}\n\nCODE:\n${code || '(no matching definitions found)'}`;
  const r = await completeFn({ system, prompt, model, schema: DRAFT_SCHEMA, maxTokens: 1500, accounting: { store, purpose: 'behavior-define', phase: 'learning' } });
  const raw = r.json || {};
  const allowed = new Set(found.map(h => `${h.path}|${h.symbol}`));
  const deps = (raw.deps || []).filter(d => d.symbol && allowed.has(`${d.path}|${d.symbol}`)).map(d => ({ path: d.path, symbol: d.symbol }));
  return { title: String(raw.title || '').trim(), body: String(raw.body || '').trim(), answers: (raw.answers || []).map(String), deps, question: deps.length ? '' : String(raw.question || 'Which code upholds this?').trim(), candidates: found.map(h => `${h.path}:${h.symbol}`) };
}

export function acceptDraft(store, draft, { mutability = 'mutable' } = {}) {
  return addBehavior(store, { title: draft.title, body: draft.body, answers: draft.answers || [], deps: draft.deps || [] }, { mutability, source: { type: 'human', defined: true } });
}
