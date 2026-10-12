// Skills as cached knowledge. A skill is a file (SKILL.md) an agent pulls into its context by name;
// its instructions rest on code that moves, so it decays like any note. Each skill file in the
// checkout gets a `skill` note: a short card (what the skill is for, when to invoke it, what it
// prescribes) whose deps are the file itself and the code the file talks about. Staleness then
// comes for free (ops.js:refresh), and a stale card is audited against the current code
// (auditSkill). A skill found out of date is `broken`: its issues are recorded on the note, it is
// not served, and it is not audited again until the file changes (a person updated it) or a person
// reviews it (reviewSkill). Nothing here edits a skill file.
//
// Where a skill is strong or weak comes from the sessions: an invoked skill (transcripts.js records
// the Skill call and its directory) is assessed by the distillation like an injected note, and a
// contradiction recorded there marks the skill broken too (ops.js:attest). Among skills that do the
// same thing (dedupeSkills), the one with the best evidence is served and the others are archived as
// its duplicates; a person can pin one (`skills.prefer` in the config). How-to notes stay what they
// are: the cache's own, automatically built skills.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { complete } from './llm.js';
import { tokensOf } from './model-usage.js';
import { createNote, extractDeps, resolveDeps, noteUnreported, gitDiffFor } from './ops.js';
import { tokenize } from './rank.js';
import { gitHead } from './store.js';
import { symbolText, hashDep, repoFile } from './deps.js';

// Where the agents look for a repository's skills: Claude Code, the agent-skills convention (Codex and
// others), Cursor, Copilot, and a plain skills/ directory. Only directories holding a SKILL.md count.
export const SKILL_ROOTS = ['.claude/skills', '.agents/skills', '.codex/skills', '.cursor/skills', '.github/skills', 'skills'];
export const CARD_CHARS = 20000;   // of the skill file shown to the card writer
export const AUDIT_CHARS = 16000;  // of the skill file shown to the audit
export const EVIDENCE_CHARS = 3500; // of the skill file shown to a session's assessment
export const MAX_CODE_DEPS = 10;    // code deps per card, symbol pointers first, documents last
export const AUDIT_FILE_LINES = 400; // of a whole-file dep shown to the audit (a definition: 120)

export const hashOf = text => createHash('sha256').update(text).digest('hex').slice(0, 16);

// name and description from the YAML front matter; the body after it
export function parseSkill(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const meta = {};
  if (m) {
    let key = null;
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
      if (kv) { key = kv[1]; meta[key] = kv[2].replace(/^(["'])(.*)\1$/, '$2').replace(/^[>|]-?$/, '').trim(); }
      else if (key && /^\s+\S/.test(line)) meta[key] = (meta[key] + ' ' + line.trim()).trim();
    }
  }
  return { name: meta.name || '', description: meta.description || '', body: m ? text.slice(m[0].length) : text, meta };
}

// The skill files of a checkout: { name, file, dir, root, description }.
export function findSkills(repo, { roots = SKILL_ROOTS } = {}) {
  const out = [];
  for (const root of roots) {
    const abs = repoFile(repo, root);
    if (!abs) continue;
    let entries = []; try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const file = path.posix.join(root, e.name, 'SKILL.md');
      const fileAbs = repoFile(repo, file);
      if (!fileAbs || !fs.existsSync(fileAbs)) continue;
      let text; try { text = fs.readFileSync(fileAbs, 'utf8'); } catch { continue; }
      const p = parseSkill(text);
      out.push({ name: p.name || e.name, dir: e.name, file, root, description: p.description, text, hash: hashOf(text) });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

export const isSkill = n => n?.kind === 'skill';
const skillNotes = store => store.list().filter(isSkill);
const noteFor = (notes, s) => notes.find(n => n.skill?.file === s.file) || null;
// a skill moved between roots keeps its note when its name is unique
const movedNoteFor = (notes, s, found) => found.filter(f => f.name === s.name).length === 1 ? notes.find(n => n.skill?.name === s.name && !found.some(f => f.file === n.skill?.file)) || null : null;

// The code a skill names: path:Symbol pointers and paths of any kind in backticks or prose.
export function skillDepsFromText(repo, text) {
  const deps = extractDeps(repo, text, []);
  const seen = new Set(deps.map(d => d.path));
  for (const m of text.matchAll(/(?:^|[\s(`'"*])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,8})(?=[\s)`'",.:;]|$)/g)) {
    const p = m[1].replace(/^\.\//, '');
    if (seen.has(p) || /^https?:/.test(p) || p.includes('..')) continue;
    const abs = repoFile(repo, p);
    if (abs && fs.existsSync(abs) && fs.statSync(abs).isFile()) { seen.add(p); deps.push({ path: p }); }
  }
  return deps;
}

const CARD_SCHEMA = {
  type: 'object',
  properties: {
    body: { type: 'string', description: '3-8 lines of markdown: what the skill is for, when to invoke it, and what it prescribes that an agent could not guess (commands, files, rules), with path:Symbol pointers at the code it talks about' },
    applies: { type: 'string', description: 'one line: when to reach for this skill, and when not' },
    answers: { type: 'array', items: { type: 'string' }, description: '3-5 short question phrasings a future agent might ask that this skill answers' },
    deps: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, symbol: { type: 'string' } }, required: ['path'] }, description: 'the code the skill\'s instructions rest on: paths from the list of resolved files, with the definition (symbol) when the skill names one' },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['body', 'applies', 'answers', 'deps', 'tags'],
};
export const CARD_SYSTEM = `You write the index card of a skill file for a cache of notes about this repository. Agents read the card at the start of a task to decide whether to invoke the skill, so it says what the skill is for, when to use it, and what it prescribes that an agent could not guess, pointing at the code it talks about as path:Symbol. The card is not a copy of the skill: 3-8 dense lines, present tense, no narrative. deps: the code files the skill's instructions rest on, taken from the resolved files listed (never a path that is not listed), with the symbol when the skill names a definition in it; a config, script or document is a whole-file dep. Leave out files the skill mentions only in passing. answers: 3-5 question phrasings. Return the JSON alone.`;

// One model call: the card of a skill file, as createNote input (deps resolved to the checkout).
export async function skillCard(store, skill, { model, completeFn = complete, phase = 'maintenance' } = {}) {
  const repo = store.repo;
  const extracted = skillDepsFromText(repo, skill.text);
  const files = [...new Set(extracted.map(d => d.path))];
  const prompt = `SKILL ${skill.name} (${skill.file})\nDescription: ${skill.description || '(none)'}\n\nRESOLVED FILES THE SKILL NAMES (the only paths deps may use${files.length ? '' : ': none; deps may then be empty'}):\n${files.map(f => `- ${f}`).join('\n') || '(none)'}\n\nSKILL FILE:\n${skill.text.slice(0, CARD_CHARS)}`;
  const res = await completeFn({ system: CARD_SYSTEM, prompt, model, schema: CARD_SCHEMA, maxTokens: 3000, thinkingTokens: 0, structuredRetries: 1, accounting: { store, purpose: 'skill-card', phase } });
  const j = res.json || {};
  const allowed = new Set(files);
  // the model's choice of files is the dep list (it was told to leave out passing mentions); every path
  // the skill names is the fallback when it chose none. Capped: a card resting on twenty files is stale
  // every week and audited for nothing, and a whole-file dep on a document is the worst of them.
  const chosen = (Array.isArray(j.deps) ? j.deps : []).filter(d => d && allowed.has(String(d.path).replace(/^\.\//, ''))).map(d => ({ path: String(d.path).replace(/^\.\//, ''), symbol: d.symbol ? String(d.symbol) : undefined }));
  const code = (chosen.length ? chosen : extracted).sort((x, y) => (y.symbol ? 1 : 0) - (x.symbol ? 1 : 0) || (/\.(md|mdx|rst|txt|json)$/i.test(x.path) ? 1 : 0) - (/\.(md|mdx|rst|txt|json)$/i.test(y.path) ? 1 : 0)).slice(0, MAX_CODE_DEPS);
  const deps = [{ path: skill.file }, ...code];
  const body = String(j.body || '').trim() || `${skill.description || skill.name}\nInvoke the skill \`${skill.name}\` (${skill.file}) for the full instructions.`;
  return {
    input: { title: `Skill: ${skill.name}`, kind: 'skill', skill: { name: skill.name, file: skill.file, root: skill.root, description: String(skill.description || '').slice(0, 500) }, body, applies: String(j.applies || skill.description || '').trim() || undefined,
      answers: [...new Set([...(Array.isArray(j.answers) ? j.answers : []).map(String), skill.description].filter(Boolean))].slice(0, 6),
      tags: ['skill', ...(Array.isArray(j.tags) ? j.tags.map(String) : [])].slice(0, 8), deps, confidence: 0.8 },
    tokens: tokensOf(res), cost: res.cost,
  };
}

// Read the skill files that are new or changed since their card was written, one model call each;
// retire the cards of removed files; then settle duplicates. A changed file clears `broken`: the
// person updated the skill, and the card goes back into serving and audit.
export async function scanSkills(store, { model, limit = 3, again = false, dry = false, completeFn = complete, phase = 'maintenance', conc = 3, onSkill } = {}) {
  const repo = store.repo, found = findSkills(repo), notes = skillNotes(store);
  model = model || store.config().distillModel || 'haiku';
  const res = { found: found.length, skills: [], read: 0, saved: [], updated: [], removed: [], aliases: [], failed: 0, lastError: null, tokens: 0, remaining: 0, duplicates: [] };
  const pending = [];
  // the same file under two roots (a symlink, or a copy kept for a second agent) is one skill: the
  // first root gets the card, the other is an alias and costs nothing
  const byHash = new Map();
  for (const s of found) { if (byHash.has(s.hash)) res.aliases.push({ file: s.file, of: byHash.get(s.hash).file }); else byHash.set(s.hash, s); }
  const aliased = new Set(res.aliases.map(a => a.file));
  for (const s of found) {
    if (aliased.has(s.file)) continue;
    const n = noteFor(notes, s) || movedNoteFor(notes, s, found);
    if (n && n.status !== 'invalid' && n.source?.hash === s.hash && n.skill?.file === s.file && !again) continue;
    pending.push({ skill: s, note: n });
  }
  // a card whose file is gone is retired, free
  const files = new Set(found.filter(s => !aliased.has(s.file)).map(s => s.file));
  for (const n of notes) {
    if (n.status === 'invalid' || files.has(n.skill?.file) || pending.some(p => p.note?.id === n.id)) continue;
    const copyOf = res.aliases.find(a => a.file === n.skill?.file)?.of;
    res.removed.push({ id: n.id, title: n.title, file: n.skill?.file, copyOf });
    if (!dry) { store.put({ ...n, status: 'invalid', invalidReason: copyOf ? `a copy of ${copyOf}, which has the card` : 'skill file removed', verified: new Date().toISOString() }); store.log({ op: 'skill', id: n.id, action: 'removed', file: n.skill?.file, copyOf }); }
  }
  const batch = pending.slice(0, limit);
  res.skills = batch.map(p => p.skill.file); res.remaining = pending.length - batch.length;
  if (dry) return res;
  const readOne = async ({ skill, note }) => {
    onSkill?.(skill.file);
    let card;
    try { card = await skillCard(store, skill, { model, completeFn, phase }); res.tokens += card.tokens || 0; }
    catch (e) { res.failed++; res.lastError = e; return; }
    const source = { type: 'skill', ref: skill.file, hash: skill.hash };
    const now = new Date().toISOString();
    if (note) {
      const r = createNote(store, { ...card.input, id: note.id }, { source, reuseId: true });
      if (r.error) { res.failed++; res.lastError = new Error(r.error); store.put(note); return; }
      const next = { ...r.note, uses: note.uses || 0, created: note.created || r.note.created, attest: note.attest, outcomes: note.outcomes, servedIn: note.servedIn, lastUsed: note.lastUsed,
        history: [...(note.history || []), { at: now, reason: note.broken ? 'skill file changed; the issues recorded are left to the next audit' : 'skill file changed', prevBody: note.body, ...(note.broken ? { broken: note.broken } : {}) }].slice(-5) };
      delete next.broken; delete next.archived; delete next.invalidReason;
      store.put(next);
      res.updated.push({ id: next.id, title: next.title, file: skill.file, wasBroken: !!note.broken });
      store.log({ op: 'skill', id: next.id, action: 'updated', file: skill.file, wasBroken: !!note.broken });
    } else {
      const r = createNote(store, card.input, { source });
      if (r.error) { res.failed++; res.lastError = new Error(r.error); return; }
      res.saved.push({ id: r.note.id, title: r.note.title, file: skill.file });
      store.log({ op: 'skill', id: r.note.id, action: 'saved', file: skill.file });
    }
    res.read++;
  };
  const queue = [...batch];
  await Promise.all(Array.from({ length: Math.min(conc, queue.length) }, async () => { while (queue.length) await readOne(queue.shift()); }));
  if (res.read || res.removed.length) res.duplicates = dedupeSkills(store);
  if (res.failed && !res.read && batch.length) throw res.lastError;
  return res;
}

// --- audit ---------------------------------------------------------------------------------------
const AUDIT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['holds', 'broken'] },
    reason: { type: 'string', description: 'one sentence' },
    issues: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string', description: 'what the skill states, quoted or closely paraphrased' }, actual: { type: 'string', description: 'what the code shows instead' }, pointer: { type: 'string', description: 'path:Symbol the issue rests on' } }, required: ['claim', 'actual'] }, description: 'only when verdict=broken: every claim of the skill the code contradicts' },
  },
  required: ['verdict', 'reason', 'issues'],
};
export const AUDIT_SYSTEM = `You audit a skill file (instructions an agent follows for a kind of task in this repository) against the current code, after code it talks about changed. Answer broken only when the skill states something the code shown contradicts: a path or definition the skill names that is marked removed or missing, a command, flag, option or script that the code shown no longer has or that works differently, a procedure whose steps the code no longer supports, or a rule the code now does the opposite of. List every such issue: the claim (quoted or closely paraphrased from the skill), what the code shows instead, and the path:Symbol it rests on. A skill that is merely incomplete, silent about a recent change, stylistic, or about things not shown is NOT broken; answer holds. The code of each dependency is shown as an excerpt (its head, marked when cut): that a sentence, section or name is absent from an excerpt is not evidence of anything; only a dependency marked removed or missing, or what the excerpt or the diff positively shows, is. Be exact: a wrong "broken" takes a working skill away from every agent. Return the JSON alone.`;

// Verification of a skill card (ops.js:verifyNote dispatches here): the question is whether the skill
// file still holds against the code, not whether the card does. holds re-baselines the deps; broken
// records the issues and takes the skill out of serving and audit until the file changes or a
// person reviews it.
export async function auditSkill(store, note, { model, completeFn = complete } = {}) {
  const repo = store.repo;
  model = model || store.config().verifyModel || 'haiku';
  const file = note.skill?.file;
  const abs = file && repoFile(repo, file);
  const now = new Date().toISOString();
  if (!abs || !fs.existsSync(abs)) {
    const next = { ...note, status: 'invalid', invalidReason: 'skill file removed', verified: now }; delete next.stale; delete next.verifying;
    store.put(next); store.log({ op: 'verify', id: note.id, kind: 'skill', verdict: 'invalid' });
    return { note: next, verdict: 'invalid', reason: 'skill file removed', tokens: 0 };
  }
  const text = fs.readFileSync(abs, 'utf8');
  const changed = (note.stale?.changed || []).filter(c => c.path !== file);
  const code = (note.deps || []).filter(d => d.path !== file);
  const paths = [...new Set(changed.map(c => c.path))];
  const diff = gitDiffFor(repo, note.verifiedCommit, paths);
  // a whole file is shown further than a definition: a skill points at a README's section or a script's
  // options, which sit past its head (one audit read a section as gone from a README cut at 120 lines)
  const removed = new Set(changed.filter(c => c.reason === 'file removed').map(c => c.path));
  const excerpt = d => {
    if (removed.has(d.path)) return '(REMOVED: the file is gone from the checkout)';
    const max = d.symbol ? 120 : AUDIT_FILE_LINES;
    const text = symbolText(repo, d, max + 1);
    if (text == null) return '(missing)';
    const lines = text.split('\n');
    return lines.length > max ? lines.slice(0, max).join('\n') + `\n… (cut after ${max} lines; the rest is not shown)` : text;
  };
  const current = code.map(d => `--- ${d.path}${d.symbol ? ' :: ' + d.symbol : ''} ---\n${excerpt(d)}`).join('\n\n');
  const prompt = `SKILL ${note.skill.name} (${file})\n${text.slice(0, AUDIT_CHARS)}\n\nCODE THE SKILL TALKS ABOUT THAT CHANGED SINCE THE LAST AUDIT: ${changed.map(c => `${c.path}${c.symbol ? ':' + c.symbol : ''} (${c.reason})`).join(', ') || 'unknown'}\n\nGIT DIFF SINCE THEN (may be empty if changes are uncommitted):\n${(diff || '(no diff available)').slice(0, 30000)}\n\nCURRENT CODE OF EACH DEPENDENCY:\n${current.slice(0, 40000)}`;
  const res = await completeFn({ system: AUDIT_SYSTEM, prompt, model, schema: AUDIT_SCHEMA, maxTokens: 2000, thinkingTokens: 0, structuredRetries: 1, accounting: { store, purpose: 'verify', kind: 'skill' } });
  const v = res.json || {};
  const issues = (Array.isArray(v.issues) ? v.issues : []).filter(i => i && String(i.claim || '').trim()).map(i => ({ claim: String(i.claim).trim().slice(0, 400), actual: String(i.actual || '').trim().slice(0, 400), ...(i.pointer ? { pointer: String(i.pointer).slice(0, 200) } : {}) }));
  const verdict = v.verdict === 'broken' && issues.length ? 'broken' : 'holds';
  let next;
  if (verdict === 'broken') next = markSkillBroken(store, note, { reason: String(v.reason || '').trim(), issues, source: 'audit', changed });
  else {
    next = { ...note, deps: rehash(repo, note.deps), status: 'fresh', verified: now, verifiedCommit: gitHead(repo), confidence: Math.min(1, (note.confidence ?? 0.8) + 0.05) };
    delete next.stale; delete next.verifying;
    store.put(next);
  }
  store.log({ op: 'verify', id: note.id, kind: 'skill', verdict, issues: issues.length || undefined, cost: res.cost, metered: true, changed: changed.map(c => `${c.path}${c.symbol ? ':' + c.symbol : ''} (${c.reason})`) });
  return { note: next, verdict, reason: v.reason, issues, cost: res.cost, tokens: tokensOf(res) };
}

const rehash = (repo, deps) => (deps || []).map(d => hashDep(repo, d)).filter(d => !d.missing);

// Take a skill out of serving and audit, with what is wrong recorded on the note. The deps are
// re-baselined so the note reads as broken, not stale, until the file changes or a person reviews it.
export function markSkillBroken(store, note, { reason = '', issues = [], source = 'audit', changed = [], session } = {}) {
  const now = new Date().toISOString(), head = gitHead(store.repo);
  const prior = note.broken?.issues || [];
  const next = { ...note, deps: rehash(store.repo, note.deps), status: 'broken', verified: now, verifiedCommit: head,
    broken: { at: note.broken?.at || now, commit: head, reason: reason || note.broken?.reason || '', source, ...(session ? { session } : {}),
      issues: [...prior, ...issues.map(i => ({ ...i, at: now, source }))].slice(-12),
      changed: changed.map(c => `${c.path}${c.symbol ? ':' + c.symbol : ''} (${c.reason})`) } };
  delete next.stale; delete next.verifying;
  store.put(next);
  noteUnreported(store, 'brokenSkills', { id: note.id, title: note.title, name: note.skill?.name, file: note.skill?.file, reason: next.broken.reason, issues: next.broken.issues.length });
  store.log({ op: 'skill', id: note.id, action: 'broken', source, session, issues: issues.length, reason: String(reason).slice(0, 200) });
  return next;
}

// A person looked at the skill (and fixed it, or found the issues wrong): back into serving and audit.
export function reviewSkill(store, id) {
  const n = store.get(id);
  if (!n) return { error: 'no such note' };
  if (!isSkill(n)) return { error: `${id} is not a skill card` };
  const now = new Date().toISOString();
  const next = { ...n, deps: rehash(store.repo, n.deps), status: 'fresh', verified: now, verifiedCommit: gitHead(store.repo),
    history: [...(n.history || []), { at: now, reason: 'reviewed by a person', ...(n.broken ? { broken: n.broken } : {}) }].slice(-5) };
  delete next.broken; delete next.stale; delete next.verifying; delete next.invalidReason;
  if (next.archived?.reason?.startsWith('duplicate of')) delete next.archived;
  store.put(next);
  store.log({ op: 'skill', id, action: 'reviewed' });
  return { note: next };
}

// --- duplicates ----------------------------------------------------------------------------------
// Skills that do the same thing: the same name in two roots, or a description and a card whose words
// mostly coincide (the card alone is not enough: cards are written to one pattern and two skills of
// one area share most of its words).
// One is served; the others are archived as its duplicates (restored when the choice changes).
// The choice, in order: a person's pin (`skills.prefer` in the config), not broken, more confirmed
// than contradicted by sessions, the root the agents look in first (SKILL_ROOTS order), the newer file.
export const DUP_JACCARD = 0.6, DUP_DESC_JACCARD = 0.5;
const normName = s => String(s || '').toLowerCase().replace(/^\d+[-_.]/, '');
function jaccard(a, b) { const A = new Set(a), B = new Set(b); let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i || 1); }
export function skillClusters(notes) {
  const live = notes.filter(n => isSkill(n) && n.status !== 'invalid');
  const parent = new Map(live.map(n => [n.id, n.id]));
  const find = x => { while (parent.get(x) !== x) x = parent.get(x); return x; };
  const union = (a, b) => parent.set(find(a), find(b));
  const words = new Map(live.map(n => [n.id, tokenize(`${normName(n.skill?.name).replace(/[-_]/g, ' ')} ${n.applies || ''} ${n.body || ''}`)]));
  const desc = new Map(live.map(n => [n.id, tokenize(`${normName(n.skill?.name).replace(/[-_]/g, ' ')} ${n.skill?.description || n.title || ''}`)]));
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
    const a = live[i], b = live[j];
    if (normName(a.skill?.name) === normName(b.skill?.name) || (jaccard(desc.get(a.id), desc.get(b.id)) >= DUP_DESC_JACCARD && jaccard(words.get(a.id), words.get(b.id)) >= DUP_JACCARD)) union(a.id, b.id);
  }
  const groups = new Map();
  for (const n of live) { const r = find(n.id); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(n); }
  return [...groups.values()].filter(g => g.length > 1);
}
export function preferSkill(group, { prefer = [], repo } = {}) {
  const mtime = n => { try { return fs.statSync(repoFile(repo, n.skill.file)).mtimeMs; } catch { return 0; } };
  const rootRank = n => { const i = SKILL_ROOTS.indexOf(n.skill?.root); return i < 0 ? SKILL_ROOTS.length : i; };
  const net = n => (n.attest?.confirmed || 0) - (n.attest?.contradicted || 0);
  return [...group].sort((a, b) => (prefer.includes(b.id) - prefer.includes(a.id)) || ((a.status === 'broken') - (b.status === 'broken')) || (net(b) - net(a)) || (rootRank(a) - rootRank(b)) || (repo ? mtime(b) - mtime(a) : 0) || a.id.localeCompare(b.id))[0];
}
export function dedupeSkills(store, { dry = false } = {}) {
  const prefer = store.config().skills?.prefer || [];
  const notes = skillNotes(store), out = [];
  const dupOf = n => n.archived?.reason?.startsWith('duplicate of ') ? n.archived.reason.slice('duplicate of '.length) : null;
  const inCluster = new Set();
  for (const group of skillClusters(notes)) {
    const kept = preferSkill(group, { prefer, repo: store.repo });
    const dropped = group.filter(n => n.id !== kept.id);
    out.push({ kept: kept.id, dropped: dropped.map(n => n.id) });
    for (const n of group) inCluster.add(n.id);
    if (dry) continue;
    const now = new Date().toISOString();
    if (dupOf(kept)) { const next = { ...kept }; delete next.archived; store.put(next); }
    for (const n of dropped) {
      if (dupOf(n) === kept.id) continue;
      if (n.archived && !dupOf(n)) continue; // archived for another reason: leave it
      store.put({ ...n, archived: { at: now, reason: `duplicate of ${kept.id}` }, related: [...new Set([kept.id, ...(n.related || [])])].slice(0, 4) });
    }
  }
  // a note archived as a duplicate whose twin is gone comes back
  if (!dry) for (const n of notes) if (dupOf(n) && !inCluster.has(n.id)) { const next = { ...n }; delete next.archived; store.put(next); }
  if (out.length && !dry) store.log({ op: 'skill', action: 'dedupe', clusters: out });
  return out;
}

// --- sessions ------------------------------------------------------------------------------------
// The skills a session invoked (transcripts.js attaches the skill directory to the Skill tool call).
export function skillsInvoked(events) {
  const out = [];
  for (const e of events || []) {
    if (e.t !== 'tool' || e.name !== 'Skill') continue;
    const raw = String(e.input?.skill || e.input?.name || '').trim();
    if (!raw) continue;
    out.push({ name: raw.split(':').pop(), raw, dir: e.skillDir || null });
  }
  return out;
}
// When the content of a skill file last changed: its last commit, else the file's modification time.
export function skillFileTime(repo, file) {
  try { const t = Number(execFileSync('git', ['log', '-1', '--format=%ct', '--', file], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); if (t) return t * 1000; } catch {}
  try { return fs.statSync(repoFile(repo, file)).mtimeMs; } catch { return 0; }
}

// The cards of the invoked skills that are in serving, with an excerpt of the file for the assessment.
// sessionEnd: when the session ended. A session older than the skill's present text saw another
// version of it and cannot judge this one: two codervibes sessions that ran `fly deploy` under the
// skill of their day read as contradicting today's skill, which says the host is on AWS.
export function skillNotesFor(store, invoked, { chars = EVIDENCE_CHARS, sessionEnd = null } = {}) {
  if (!invoked?.length) return [];
  const notes = skillNotes(store).filter(n => n.status !== 'invalid' && n.status !== 'broken' && !n.archived);
  const out = [];
  for (const inv of invoked) {
    const dirName = inv.dir ? path.basename(inv.dir) : null;
    const n = notes.find(n => n.skill?.name === inv.name || n.skill?.name === inv.raw) || (dirName && notes.find(n => path.basename(path.dirname(n.skill?.file || '')) === dirName));
    if (!n || out.some(o => o.id === n.id)) continue;
    if (sessionEnd && skillFileTime(store.repo, n.skill.file) > sessionEnd) continue;
    let text = ''; try { text = fs.readFileSync(repoFile(store.repo, n.skill.file), 'utf8'); } catch {}
    out.push({ ...n, text: text.slice(0, chars) });
  }
  return out;
}

// --- report --------------------------------------------------------------------------------------
export function skillRows(store) {
  const notes = skillNotes(store);
  return notes.map(n => ({
    id: n.id, name: n.skill?.name || '', file: n.skill?.file || '', title: n.title,
    status: n.status === 'invalid' ? 'retired' : n.status === 'broken' ? 'broken' : n.archived ? 'archived' : n.status,
    duplicateOf: n.archived?.reason?.startsWith('duplicate of ') ? n.archived.reason.slice('duplicate of '.length) : null,
    archivedReason: n.archived?.reason || null,
    confidence: n.confidence ?? 0.8, uses: n.uses || 0, lastUsed: n.lastUsed || null,
    confirmed: n.attest?.confirmed || 0, contradicted: n.attest?.contradicted || 0, unused: n.attest?.unused || 0,
    broken: n.broken ? { at: n.broken.at, reason: n.broken.reason, source: n.broken.source, issues: n.broken.issues || [] } : null,
    verified: n.verified || null, invalidReason: n.invalidReason || null,
  })).sort((a, b) => (a.status === 'broken' ? 0 : 1) - (b.status === 'broken' ? 0 : 1) || a.name.localeCompare(b.name));
}
export function renderSkills(rows) {
  if (!rows.length) return 'no skill cards yet: thinker skills scan reads the SKILL.md files of this checkout';
  const lines = [];
  for (const r of rows) {
    const st = r.status === 'broken' ? 'OUT OF DATE' : r.status === 'archived' ? (r.duplicateOf ? `duplicate of ${r.duplicateOf}` : `archived: ${r.archivedReason}`) : r.status;
    lines.push(`${st.padEnd(14)} ${r.name.padEnd(36)} c=${Math.round(r.confidence * 100)}% served=${r.uses} ok=${r.confirmed} bad=${r.contradicted}  ${r.file}  (id: ${r.id})`);
    if (r.broken) for (const i of r.broken.issues) lines.push(`    - ${i.claim}${i.actual ? ` → ${i.actual}` : ''}${i.pointer ? ` [${i.pointer}]` : ''}`);
    if (r.broken) lines.push(`    not served or audited until ${r.file} changes or: thinker skills review ${r.id}`);
  }
  const broken = rows.filter(r => r.status === 'broken').length;
  lines.push(`${rows.length} skill${rows.length === 1 ? '' : 's'}${broken ? `, ${broken} out of date` : ''}`);
  return lines.join('\n');
}
export function skillsLine(r) {
  if (!r.found) return 'no skill files (SKILL.md under .claude/skills, .agents/skills, ...) in this checkout';
  if (!r.skills.length && !r.removed.length) return `${r.found} skill file${r.found === 1 ? '' : 's'}, all carded already`;
  const bits = [];
  if (r.saved.length) bits.push(`${r.saved.length} new skill card${r.saved.length === 1 ? '' : 's'}`);
  if (r.updated.length) bits.push(`${r.updated.length} updated${r.updated.some(u => u.wasBroken) ? ` (${r.updated.filter(u => u.wasBroken).length} back from out of date)` : ''}`);
  if (r.removed.length) bits.push(`${r.removed.length} retired (file removed)`);
  if (r.aliases?.length) bits.push(`${r.aliases.length} ${r.aliases.length === 1 ? 'copy' : 'copies'} of another skill file, not carded`);
  if (r.duplicates.length) bits.push(`${r.duplicates.length} duplicate ${r.duplicates.length === 1 ? 'group' : 'groups'} settled`);
  if (r.failed) bits.push(`${r.failed} not read (${String(r.lastError?.message || '').slice(0, 100)})`);
  if (r.remaining) bits.push(`${r.remaining} more to read: thinker skills scan`);
  return bits.join('; ') || `${r.found} skill files`;
}
