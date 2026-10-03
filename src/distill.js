// Distill an agent session (any transcript format transcripts.js reads) into notes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { complete } from './llm.js';
import { createNote, KINDS, looksLikeCorrection } from './ops.js';
import { tokenize } from './rank.js';

const EXPLORE_TOOLS = new Set(['Grep', 'Glob', 'Read', 'Bash', 'Agent', 'Task', 'LS', 'WebFetch']);

export { parseTranscript } from './transcripts.js';

// Note ids that were injected into this transcript (hook or MCP orient output).
export function injectedIds(file, { fromLine = 0 } = {}) {
  const ids = new Set();
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let i = fromLine; i < lines.length; i++) for (const m of lines[i].matchAll(/\(id: ([\w-]+), confidence \d+%\)/g)) ids.add(m[1]);
  return [...ids];
}

export function exploreCount(events) {
  return events.filter(e => e.t === 'tool' && EXPLORE_TOOLS.has(e.name)).length;
}

// What a session put at stake: edits made, tool calls that failed, prompts that corrected the
// agent. A session with none of these and little exploration is a question answered, and in a
// week on this repository distilling such sessions was a model call (about 10¢ with Sonnet) that
// in 30% of runs saved no note; with nothing served in it there is no assessment to make either.
// The hooks skip it below QUIET_MIN_EXPLORE exploration calls (`learn.quietExplore` in the
// config; 0 distills every session as before).
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch']);
const WRITES_FILE = /\b(sed|perl)\s+(-\w+\s+)*-\w*i\b|\btee\s|>{1,2}\s*[\w./-]+\.\w+/;
const FAILED = /\b(\w*error\w*|exception|traceback|failed|failing|fatal|cannot|denied)\b|not found|✖/i;
export const QUIET_MIN_EXPLORE = 8;
export function sessionStakes(events) {
  const s = { edits: 0, failures: 0, corrections: 0 };
  let prompts = 0;
  for (const e of events) {
    if (e.t === 'prompt') { if (prompts++ && looksLikeCorrection(e.text)) s.corrections++; continue; }
    if (e.t !== 'tool') continue;
    if (EDIT_TOOLS.has(e.name) || (e.name === 'Bash' && WRITES_FILE.test(String(e.input?.command || '')))) s.edits++;
    if (FAILED.test(String(e.result || '').slice(0, 400))) s.failures++;
  }
  s.any = s.edits + s.failures + s.corrections > 0;
  return s;
}
export function quietSession(events, { served = 0, minExplore = QUIET_MIN_EXPLORE } = {}) {
  if (served || minExplore <= 0) return false;
  return exploreCount(events) < minExplore && !sessionStakes(events).any;
}

function short(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + `…[+${s.length - n} chars]` : s; }

export function condense(events, { maxChars = 70000 } = {}) {
  const parts = [];
  const lastSay = events.map((e, i) => e.t === 'say' ? i : -1).filter(i => i >= 0).pop();
  for (const [i, e] of events.entries()) {
    if (e.t === 'prompt') parts.push(`USER: ${short(e.text.replace(/<[^>]+>/g, '').trim(), 1500)}`);
    else if (e.t === 'say') parts.push(`AGENT${i === lastSay ? ' (final answer)' : ''}: ${short(e.text, i === lastSay ? 6000 : 700)}`);
    else if (e.t === 'tool') {
      const inp = e.input || {};
      let head;
      if (e.name === 'Bash') head = `$ ${short(inp.command, 300)}`;
      else if (e.name === 'Read') head = `READ ${inp.file_path}${inp.offset ? ` (from line ${inp.offset})` : ''}`;
      else if (e.name === 'Grep') head = `GREP /${inp.pattern}/ in ${inp.path || '.'}${inp.glob ? ' glob=' + inp.glob : ''}`;
      else if (e.name === 'Glob') head = `GLOB ${inp.pattern}`;
      else if (e.name === 'Edit') head = `EDIT ${inp.file_path}: ${short(inp.old_string, 120)} -> ${short(inp.new_string, 120)}`;
      else if (e.name === 'Write') head = `WRITE ${inp.file_path}`;
      else if (/^mcp__thinker__/.test(e.name)) head = `${e.name.replace('mcp__thinker__', 'thinker.')}(${short(JSON.stringify(inp), 200)})`;
      else head = `${e.name} ${short(JSON.stringify(inp), 300)}`;
      const resLimit = e.name === 'Read' ? 900 : e.name === 'Grep' || e.name === 'Glob' ? 700 : e.name === 'Bash' ? 700 : 300;
      parts.push(`${head}\n  => ${short(e.result.replace(/\s+/g, ' '), resLimit)}`);
    }
  }
  let text = parts.join('\n');
  if (text.length > maxChars) {
    // keep head and tail; middle exploration is usually the most redundant
    const keep = maxChars / 2;
    text = text.slice(0, keep) + '\n...[trace truncated]...\n' + text.slice(-keep);
  }
  return text;
}

const NOTE_SCHEMA = {
  type: 'object',
  properties: {
    notes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          kind: { type: 'string', enum: KINDS },
          answers: { type: 'array', items: { type: 'string' } },
          body: { type: 'string' },
          applies: { type: 'string', description: 'when this note applies and when it does not (constraints that tie it to its context); empty if not needed' },
          deps: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, symbol: { type: 'string' } }, required: ['path'] } },
          tags: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'number' },
          extends: { type: 'string', description: 'id of an existing note this one completes or corrects; the body is then the full merged text. Empty for a new note.' },
        },
        required: ['title', 'kind', 'answers', 'body', 'deps', 'tags', 'confidence'],
      },
    },
  },
  required: ['notes'],
};
const ASSESS_SCHEMA = {
  type: 'object',
  properties: {
    notes: NOTE_SCHEMA.properties.notes,
    assessments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['confirmed', 'contradicted', 'unused'] },
          evidence: { type: 'string', description: 'what in the trace supports the verdict, one line' },
          correction: { type: 'string', description: 'when contradicted: the full corrected note body (same length, keep file:symbol pointers); else empty' },
        },
        required: ['id', 'verdict', 'evidence', 'correction'],
      },
    },
  },
  required: ['notes', 'assessments'],
};

export const DISTILL_SYSTEM = `You distill a coding agent's session into a small number of reusable notes for a "knowledge cache" about this repository. A future agent will read these notes at the start of a task instead of re-grepping and re-reading files.

Write a note ONLY for understanding that (a) took the agent real effort to establish (several greps/reads/traces), (b) is likely to be needed again by a different task, and (c) is stated concretely enough to act on. Kinds, in order of value:
- callpath: how control/data flows across files for some operation (list the hops as file:symbol → file:symbol).
- location: where a recurring concern is handled (not "what a file does", but "if you need to change X, it is in file:symbol, and Y is in ...").
- cochange: things that must be changed together because of a mechanism the trace shows: a generator to rerun, a registry or enum to extend, a schema and the code that maps it, a test that asserts two places agree, a mirror that must stay identical. Name the mechanism and point at it (file:symbol). NOT the list of files one session happened to touch: git history records what changed together by itself, and such a list is served from it.
- howto: exactly how to build/test/run/lint this repo, including the non-obvious flags, env, or fixtures.
- convention: local rules an agent would otherwise violate (naming, error handling, where tests go, how config is threaded).
- gotcha: a trap the agent fell into or discovered (e.g. two similarly named functions, an order dependency, a cache that must be cleared).
- rationale: WHY something is the way it is: rejected approaches, incident-driven constraints, deliberate limitations. Only if the transcript contains evidence for it.
- overview: a compact map of the module structure relevant to a whole area, only when the agent had to assemble it from many files.
- invariant: a condition any change in this area must respect: permission or ownership checks, status/eligibility guards, feature-flag gating, fields or stores that must stay in sync, ordering requirements. State the rule, where it is enforced (file:symbol), and what breaks if it is skipped. These are the most valuable notes for an agent that has already found the code and is deciding what the change must include.
- fix: a record of a bug that was fixed, in four parts: Symptom (as a user would report it), Root cause (file:symbol), Fix pattern (what kind of change resolved it), Constraints (when the pattern applies and when it does not).

Rules:
- Do NOT write "this file contains ..." summaries. Do NOT restate the task or what the agent changed in this session unless that reveals a reusable rule.
- Every claim must be grounded in what the agent actually observed in the trace (file contents, grep hits, command output), not in what it assumed.
- Bodies are 3-12 lines of markdown, dense, with \`path:Symbol\` pointers. Prefer symbol pointers over line numbers.
- deps: list every file the note's claims rest on; add the symbol when the claim is about a specific function/class. The cache hashes these to detect staleness, so be precise and do not list files the note does not depend on.
- applies: for gotcha / convention / rationale / cochange notes, one line stating when the rule applies and when it does not (e.g. "only for options with multiple=True; arguments use a different path"). Generic lessons without such constraints are useless.
- answers: 2-5 short question phrasings a future agent might ask that this note answers (used for retrieval).
- confidence: 0.9+ only when the agent read the actual code; 0.6-0.8 for things inferred from grep hits or partial reads.
- Typical yield is 1-4 notes: the main callpath/location the session established, plus any gotcha, convention, cochange rule or howto the trace shows. Split distinct topics into separate notes rather than one long note. 0 notes is fine for a trivial session.
- The agent's final answer is usually the best-synthesized source; mine it, but only keep claims backed by the trace.`;

export const ASSESS_RULES = `

ASSESSING INJECTED NOTES: the session started with cached notes injected (listed below with ids). For each, judge from the trace only:
- confirmed: the agent acted on the note's pointers (read/grepped/edited what it names) and nothing it observed contradicted the note's claims.
- contradicted: something the agent observed (code it read, a failed command, a symbol it could not find) shows a claim in the note is wrong or the note misdirected the agent. Provide the corrected full body.
- unused: the note played no visible role.
Be strict about "contradicted": only when the trace shows evidence, not when the note was merely incomplete for this task.`;

export const EXISTING_RULES = `

EXISTING NOTES: the cache already holds notes on the files this session touched (listed below with ids). Do not write a note that restates one of them, even in other words. When the session establishes something that completes or corrects one of them, return that note with \`extends\` set to its id and the full merged body (its claims that still hold, plus the new ones, same length rules). A new note is for understanding none of them holds.`;

// Files the session read, searched or edited, from the tool events.
export function touchedFiles(events, repo = '') {
  const out = new Set();
  const rel = p => { p = String(p || ''); if (repo && p.startsWith(repo + '/')) p = p.slice(repo.length + 1); return p.replace(/^\.\//, ''); };
  for (const e of events) {
    if (e.t !== 'tool') continue;
    const inp = e.input || {};
    if (['Read', 'Edit', 'Write', 'MultiEdit'].includes(e.name) && inp.file_path) out.add(rel(inp.file_path));
    else if (e.name === 'Grep' && inp.path && /\.\w+$/.test(inp.path)) out.add(rel(inp.path));
  }
  return [...out];
}

// Notes resting on files the session touched, most overlapping first: what the distiller is shown
// so it extends what is there instead of writing it again (189 notes from 109 sessions merged twice).
export function relatedNotes(store, events, { max = 12 } = {}) {
  const files = new Set(touchedFiles(events, store.repo));
  if (!files.size) return [];
  return store.list().filter(n => n.status !== 'invalid')
    .map(n => ({ n, hit: new Set((n.deps || []).map(d => d.path).filter(p => files.has(p))).size }))
    .filter(x => x.hit > 0)
    .sort((a, b) => b.hit - a.hit || (b.n.uses || 0) - (a.n.uses || 0))
    .slice(0, max).map(x => x.n);
}

// kinds: what the distiller may produce. The caller leaves out the kinds this checkout archives
// (ops.js:archiveConfig): a note of a kind that is never served is a model call for nothing, and
// what location and cochange notes would say is found by code search and git history.
export function distillSpec({ kinds = KINDS } = {}) {
  const left = KINDS.filter(k => !kinds.includes(k));
  if (!left.length) return { system: DISTILL_SYSTEM, schema: NOTE_SCHEMA };
  const schema = JSON.parse(JSON.stringify(NOTE_SCHEMA));
  schema.properties.notes.items.properties.kind.enum = KINDS.filter(k => kinds.includes(k));
  const system = DISTILL_SYSTEM + `\n\nDo not produce notes of these kinds: ${left.join(', ')}. This repository does not serve them (code search and git history answer what they would say); fold anything of theirs that matters into a note of another kind, or leave it out.`;
  return { system, schema };
}
export async function distillEvents(events, { model = 'sonnet', repoHint = '', served = [], existing = [], kinds = KINDS, accounting } = {}) {
  const trace = condense(events);
  let prompt = `Repository: ${repoHint}\n\nSESSION TRACE (tool calls with truncated results):\n\n${trace}`;
  let { system, schema } = distillSpec({ kinds });
  const servedIds = new Set(served.map(n => n.id));
  const shown = existing.filter(n => !servedIds.has(n.id));
  if (shown.length) {
    system += EXISTING_RULES;
    prompt += `\n\nEXISTING NOTES ON THE FILES THIS SESSION TOUCHED:\n` + shown.map(n => `id=${n.id} [${n.kind}] ${n.title}\n${(n.body || '').split('\n').slice(0, 3).join('\n').slice(0, 400)}`).join('\n\n');
  }
  if (served.length) {
    system += ASSESS_RULES; schema = { ...ASSESS_SCHEMA, properties: { ...ASSESS_SCHEMA.properties, notes: schema.properties.notes } };
    prompt += `\n\nINJECTED NOTES TO ASSESS:\n` + served.map(n => `id=${n.id} [${n.kind}] ${n.title}\n${n.body}`).join('\n\n');
    prompt += `\n\nProduce the notes JSON (new notes for reusable understanding this session established that the injected notes do not already cover) and one assessment per injected note.`;
  } else prompt += `\n\nProduce the notes JSON.`;
  const res = await complete({ system, prompt, model, schema, maxTokens: 12000, accounting });
  return { notes: res.json?.notes || [], assessments: res.json?.assessments || [], cost: res.cost, usage: res.usage, traceChars: trace.length };
}

function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  let i = 0; for (const x of A) if (B.has(x)) i++;
  return i / (A.size + B.size - i || 1);
}

// A co-change note that is one session's edit set, not a rule: a title that counts files, or four or
// more whole files as its only deps and no word in the body for why they move together. Git history
// already holds which files changed together (cochange.js); the edit hook serves it from there.
const MECHANISM = /\b(generat\w*|regenerat\w*|codegen|registr\w*|regist\w*|enum\w*|schema\w*|migration\w*|mirror\w*|assert\w*|in sync|derive[sd]?|template\w*|lockstep|serializ\w*|validat\w*|snapshot\w*|fixture\w*|manifest\w*|barrel|export\w*|import\w*|entry|matching|match\w*)\b/i;
export function cochangeMechanism(n) {
  if (n.kind !== 'cochange') return true;
  if (/\b\d+\s+(?:\w+\s+)?files?\b/i.test(n.title || '')) return false;   // "touches 8 files", "7 files + 3 test files"
  const deps = n.deps || [];
  if (deps.some(d => d.symbol) || deps.length < 4) return true;
  return MECHANISM.test(`${n.title}\n${n.body}\n${n.applies || ''}`);
}

// Save distilled notes, merging near-duplicates (same topic → keep higher confidence, refresh deps).
export function saveNotes(store, notes, { source, kinds = KINDS }) {
  const existing = store.list();
  const saved = [], merged = [], skipped = [];
  for (const n of notes) {
    if (KINDS.includes(n.kind) && !kinds.includes(n.kind)) { skipped.push({ title: n.title, reason: `kind ${n.kind} is not served in this repository (archived by thinker archive)` }); continue; }
    if (!cochangeMechanism(n)) { skipped.push({ title: n.title, reason: 'co-change without a mechanism: git history already records which files changed together' }); continue; }
    const key = tokenize(n.title + ' ' + (n.answers || []).join(' '));
    const named = n.extends && existing.find(e => e.id === n.extends);
    const dup = named || existing.find(e => jaccard(key, tokenize(e.title + ' ' + (e.answers || []).join(' '))) >= 0.5 && e.kind === n.kind);
    if (dup) {
      if (named || (n.confidence ?? 0.7) >= (dup.confidence ?? 0.7) - 0.1 || dup.status !== 'fresh') {
        const r = createNote(store, { ...n, id: dup.id }, { source, reuseId: true });
        if (r.error) { skipped.push({ title: n.title, reason: r.error }); store.put(dup); continue; }
        r.note.uses = dup.uses || 0; r.note.created = dup.created; r.note.attest = dup.attest; r.note.history = [...(dup.history || []), { at: new Date().toISOString(), reason: named ? 'extended by a new session' : 'merged from new session', prevBody: dup.body }].slice(-5);
        store.put(r.note); merged.push(r.note);
      } else skipped.push({ title: n.title, reason: `duplicate of ${dup.id}` });
      continue;
    }
    const r = createNote(store, n, { source });
    if (r.error) skipped.push({ title: n.title, reason: r.error });
    else { saved.push(r.note); existing.push(r.note); }
  }
  return { saved, merged, skipped };
}

export function transcriptsFor(cwd) {
  const enc = cwd.replace(/[\/.]/g, '-');
  const dir = path.join(os.homedir(), '.claude', 'projects', enc);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}
