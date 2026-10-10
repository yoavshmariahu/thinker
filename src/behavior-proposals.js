// Optional build output: candidate requirements, never active review rules until accepted.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { complete } from './llm.js';
import { checkNote, symbolText } from './deps.js';
import { extractDeps, refresh, resolveDeps } from './ops.js';
import { addBehavior } from './behavior.js';

const fileOf = store => path.join(store.localDir, 'behavior-proposals.json');
const sourceHash = note => createHash('sha256').update(JSON.stringify([note.title, note.body, note.deps])).digest('hex');
export function listBehaviorProposals(store) {
  try { return JSON.parse(fs.readFileSync(fileOf(store), 'utf8')).proposals || []; }
  catch { return []; }
}

const SCHEMA = { type: 'object', properties: { proposals: { type: 'array', items: {
  type: 'object', properties: {
    sourceId: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' },
    answers: { type: 'array', items: { type: 'string' } },
    deps: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, symbol: { type: 'string' } }, required: ['path'] } },
    reason: { type: 'string' },
  }, required: ['sourceId', 'title', 'body', 'answers', 'deps', 'reason'],
} } }, required: ['proposals'] };

function candidates(store, limit) {
  return refresh(store).filter(n => n.kind === 'rule' && n.status === 'fresh' &&
    ['pr', 'doc'].includes(n.source?.type) && (n.deps || []).some(d => d.symbol))
    .sort((a, b) => (b.attest?.confirmed || 0) - (a.attest?.confirmed || 0) ||
      (b.confidence || 0) - (a.confidence || 0) || a.id.localeCompare(b.id)).slice(0, limit);
}

// A few bounded model calls after mining, PER_CALL source notes each: twelve notes with their code in
// one call could ask for more output than the call may write, which fails the whole stage (the
// agent CLI exits 1 past its cap). A call that fails costs its own notes only; all of them failing throws.
// The source note and current definitions are
// evidence, but the model may return no proposal where they do not establish an enduring rule.
const PER_CALL = 4;
export async function generateBehaviorProposals(store, { model, limit = 12, completeFn = complete } = {}) {
  const notes = candidates(store, limit);
  if (!notes.length) {
    fs.mkdirSync(store.localDir, { recursive: true });
    fs.writeFileSync(fileOf(store), JSON.stringify({ generatedAt: new Date().toISOString(), proposals: [] }, null, 2) + '\n');
    return { proposals: [], sources: 0, skipped: 0 };
  }
  const existing = store.list().filter(n => n.kind === 'behavior').map(n => n.title).slice(0, 30);
  const promptFor = batch => `EXISTING BEHAVIORS (do not duplicate): ${existing.join('; ') || '(none)'}\n\n` + batch.map(n => {
    const code = n.deps.filter(d => d.symbol).slice(0, 2).map(d =>
      `${d.path}:${d.symbol}\n${String(symbolText(store.repo, d, 35) || '(unavailable)').slice(0, 3500)}`).join('\n\n');
    return `SOURCE ID: ${n.id}\nSOURCE: ${n.source?.ref || n.source?.type}\nTITLE: ${n.title}\nNOTE:\n${n.body}\nCODE:\n${code}`;
  }).join('\n\n---\n\n');
  const system = `Draft at most one desired system behavior per source note. A behavior says what future changes must preserve, in product terms, and names the code definitions enforcing it. Use only claims supported by the source note and code shown. Return none for a local convention, implementation detail, ambiguous claim, or a fix whose intended behavior cannot be stated independently. Do not treat current code alone as proof of intent. Keep each body 2-5 sentences with path:Symbol pointers. Each dep must be one of the source note's symbol deps. State why the PR or document supports the requirement in reason. Do not claim a test exists unless the source explicitly names it. All candidates are drafts for human review, never automatically active requirements.`;
  const drafted = []; let failed = 0, lastError = null;
  for (let i = 0; i < notes.length; i += PER_CALL) {
    const batch = notes.slice(i, i + PER_CALL);
    try {
      const r = await completeFn({ system, prompt: promptFor(batch), model, schema: SCHEMA, maxTokens: 4500,
        accounting: { store, purpose: 'behavior-proposals', phase: 'init' } });
      drafted.push(...(r.json?.proposals || []));
    } catch (e) { failed += batch.length; lastError = e; }
  }
  if (failed === notes.length) throw lastError;
  const byId = new Map(notes.map(n => [n.id, n]));
  const proposals = [], seen = new Set();
  for (const raw of drafted) {
    const source = byId.get(raw.sourceId);
    if (!source || seen.has(source.id) || !raw.title?.trim() || !raw.body?.trim() || !raw.reason?.trim()) continue;
    const allowed = new Set(source.deps.filter(d => d.symbol).map(d => `${d.path}|${d.symbol}`));
    const deps = (raw.deps || []).filter(d => d.symbol && allowed.has(`${d.path}|${d.symbol}`));
    if (!deps.length || deps.length !== (raw.deps || []).length ||
      !deps.some(d => raw.body.includes(`${d.path}:${d.symbol}`))) continue;
    if (resolveDeps(store.repo, deps).deps.length !== deps.length) continue;
    const bodyDeps = extractDeps(store.repo, raw.body, deps);
    if (bodyDeps.some(d => !allowed.has(`${d.path}|${d.symbol || ''}`))) continue;
    seen.add(source.id);
    proposals.push({ id: `proposal-${source.id}`, sourceId: source.id, sourceHash: sourceHash(source), source: source.source,
      title: raw.title.trim(), body: raw.body.trim(), answers: (raw.answers || []).map(s => String(s).trim()).filter(Boolean),
      deps, reason: raw.reason.trim(), mutability: 'mutable' });
  }
  fs.mkdirSync(store.localDir, { recursive: true });
  fs.writeFileSync(fileOf(store), JSON.stringify({ generatedAt: new Date().toISOString(), proposals }, null, 2) + '\n');
  return { proposals, sources: notes.length, skipped: drafted.length - proposals.length, failed, lastError };
}

// `edit`: the person's own title and body. A draft accepted as written must still stand on its source
// note and code; one a person rewrote is theirs, so it needs only to point at code that exists.
export function acceptBehaviorProposal(store, id, { fixed = false, edit = null } = {}) {
  const proposals = listBehaviorProposals(store);
  const p = proposals.find(x => x.id === id);
  if (!p) return { error: 'no such behavior proposal' };
  const edited = edit && ((edit.title && edit.title.trim() !== p.title) || (edit.body && edit.body.trim() !== p.body));
  if (edited) {
    const r = addBehavior(store, { title: (edit.title || p.title).trim(), body: (edit.body || p.body).trim(), answers: p.answers, deps: p.deps },
      { mutability: fixed ? 'fixed' : 'mutable', source: { type: 'human', proposedFrom: p.sourceId, evidence: p.source, edited: true } });
    if (r.error) return r;
    writeProposals(store, proposals.filter(x => x.id !== id));
    return r;
  }
  const source = store.get(p.sourceId);
  if (!source) return { error: 'source note is missing; draft them again with thinker system propose --refresh' };
  if (sourceHash(source) !== p.sourceHash || checkNote(store.repo, source).changed.length) return { error: 'source note or code changed; draft them again with thinker system propose --refresh' };
  const allowed = new Set((source.deps || []).filter(d => d.symbol).map(d => `${d.path}|${d.symbol}`));
  if (!p.deps?.length || p.deps.some(d => !allowed.has(`${d.path}|${d.symbol}`)) ||
    !p.deps.some(d => p.body.includes(`${d.path}:${d.symbol}`))) return { error: 'source anchors changed; draft them again with thinker system propose --refresh' };
  if (extractDeps(store.repo, p.body, p.deps).some(d => !allowed.has(`${d.path}|${d.symbol || ''}`))) return { error: 'proposal cites code outside its source; draft them again with thinker system propose --refresh' };
  const r = addBehavior(store, { title: p.title, body: p.body, answers: p.answers, deps: p.deps },
    { mutability: fixed ? 'fixed' : 'mutable', source: { type: 'human', proposedFrom: p.sourceId, evidence: p.source } });
  if (r.error) return r;
  writeProposals(store, proposals.filter(x => x.id !== id));
  return r;
}

function writeProposals(store, proposals) {
  fs.mkdirSync(store.localDir, { recursive: true });
  fs.writeFileSync(fileOf(store), JSON.stringify({ generatedAt: new Date().toISOString(), proposals }, null, 2) + '\n');
}

// A person decided a draft is not a requirement: it leaves the list and is not drafted again until
// the build drafts afresh.
export function discardBehaviorProposal(store, id) {
  const proposals = listBehaviorProposals(store);
  if (!proposals.some(x => x.id === id)) return { error: 'no such behavior proposal' };
  writeProposals(store, proposals.filter(x => x.id !== id));
  store.log({ op: 'behavior', id, action: 'discard-draft' });
  return { discarded: id };
}
