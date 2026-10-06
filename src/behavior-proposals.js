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

// One bounded model call after mining and exploration. The source note and current definitions are
// evidence, but the model may return no proposal where they do not establish an enduring rule.
export async function generateBehaviorProposals(store, { model, limit = 12, completeFn = complete } = {}) {
  const notes = candidates(store, limit);
  if (!notes.length) {
    fs.mkdirSync(store.localDir, { recursive: true });
    fs.writeFileSync(fileOf(store), JSON.stringify({ generatedAt: new Date().toISOString(), proposals: [] }, null, 2) + '\n');
    return { proposals: [], sources: 0, skipped: 0 };
  }
  const existing = store.list().filter(n => n.kind === 'behavior').map(n => n.title).slice(0, 30);
  const prompt = `EXISTING BEHAVIORS (do not duplicate): ${existing.join('; ') || '(none)'}\n\n` + notes.map(n => {
    const code = n.deps.filter(d => d.symbol).slice(0, 2).map(d =>
      `${d.path}:${d.symbol}\n${String(symbolText(store.repo, d, 35) || '(unavailable)').slice(0, 3500)}`).join('\n\n');
    return `SOURCE ID: ${n.id}\nSOURCE: ${n.source?.ref || n.source?.type}\nTITLE: ${n.title}\nNOTE:\n${n.body}\nCODE:\n${code}`;
  }).join('\n\n---\n\n');
  const system = `Draft at most one desired system behavior per source note. A behavior says what future changes must preserve, in product terms, and names the code definitions enforcing it. Use only claims supported by the source note and code shown. Return none for a local convention, implementation detail, ambiguous claim, or a fix whose intended behavior cannot be stated independently. Do not treat current code alone as proof of intent. Keep each body 2-5 sentences with path:Symbol pointers. Each dep must be one of the source note's symbol deps. State why the PR or document supports the requirement in reason. Do not claim a test exists unless the source explicitly names it. All candidates are drafts for human review, never automatically active requirements.`;
  const r = await completeFn({ system, prompt, model, schema: SCHEMA, maxTokens: 4500,
    accounting: { store, purpose: 'behavior-proposals', phase: 'init' } });
  const byId = new Map(notes.map(n => [n.id, n]));
  const proposals = [], seen = new Set();
  for (const raw of r.json?.proposals || []) {
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
  return { proposals, sources: notes.length, skipped: (r.json?.proposals || []).length - proposals.length };
}

export function acceptBehaviorProposal(store, id, { fixed = false } = {}) {
  const proposals = listBehaviorProposals(store);
  const p = proposals.find(x => x.id === id);
  if (!p) return { error: 'no such behavior proposal' };
  const source = store.get(p.sourceId);
  if (!source) return { error: 'source note is missing; regenerate proposals' };
  if (sourceHash(source) !== p.sourceHash || checkNote(store.repo, source).changed.length) return { error: 'source note or code changed; regenerate proposals' };
  const allowed = new Set((source.deps || []).filter(d => d.symbol).map(d => `${d.path}|${d.symbol}`));
  if (!p.deps?.length || p.deps.some(d => !allowed.has(`${d.path}|${d.symbol}`)) ||
    !p.deps.some(d => p.body.includes(`${d.path}:${d.symbol}`))) return { error: 'source anchors changed; regenerate proposals' };
  if (extractDeps(store.repo, p.body, p.deps).some(d => !allowed.has(`${d.path}|${d.symbol || ''}`))) return { error: 'proposal cites code outside its source; regenerate proposals' };
  const r = addBehavior(store, { title: p.title, body: p.body, answers: p.answers, deps: p.deps },
    { mutability: fixed ? 'fixed' : 'mutable', source: { type: 'human', proposedFrom: p.sourceId, evidence: p.source } });
  if (r.error) return r;
  fs.writeFileSync(fileOf(store), JSON.stringify({ generatedAt: new Date().toISOString(),
    proposals: proposals.filter(x => x.id !== id) }, null, 2) + '\n');
  return r;
}
