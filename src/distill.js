// Distill an agent session (any transcript format transcripts.js reads) into notes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { complete } from './llm.js';
import { tokensOf } from './model-usage.js';
import { createNote, KINDS, kindOf, looksLikeCorrection } from './ops.js';
import { tokenize, rank } from './rank.js';

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

// At the end of a turn a session is distilled only once its undistilled part nears the trace limit
// (`condense`, 70,000 chars, past which the middle is cut): a call carries the prompt, the schema and
// the related notes whatever the trace, and on 2026-10-03 one session was distilled 13 times.
export const BATCH_CHARS = 45000;
export function batchDue(events, { chars = BATCH_CHARS } = {}) {
  return condense(events, { maxChars: Infinity }).length >= chars;
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

// At most this many notes from one distill. In a week on this repository 158 distills made 328 notes,
// of which 190 of the cache's 300 were never served; most sessions establish one thing worth keeping.
export const MAX_NOTES = 3;
const NOTE_SCHEMA = {
  type: 'object',
  properties: {
    notes: {
      type: 'array',
      maxItems: MAX_NOTES,
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

Write a note ONLY for understanding that (a) took the agent real effort to establish (several greps/reads/traces), (b) is likely to be needed again by a different task, and (c) is stated concretely enough to act on. Four kinds:
- rule: what a change in this area must respect. An invariant (a permission or ownership check, a status or eligibility guard, feature-flag gating, fields or stores that must stay in sync, an ordering), a local convention an agent would otherwise violate (naming, error handling, where tests go, how config is threaded), a trap the agent fell into (two similarly named functions, an order dependency, a cache that must be cleared), a bug that was fixed and must not come back (Symptom as a user would report it, Root cause with file:symbol, Fix pattern, Constraints), why something is the way it is (rejected approaches, incident-driven constraints; only with evidence in the transcript), or things that must change together because of a mechanism the trace shows (a generator to rerun, a registry or enum to extend, a schema and the code that maps it, a test that asserts two places agree): name the mechanism and point at it. NOT the list of files one session happened to touch: git history records that by itself. State the rule, where it is enforced (file:symbol), and what breaks if it is skipped. These are the most valuable notes for an agent that has found the code and is deciding what the change must include.
- map: where a recurring concern is handled (not "what a file does", but "if you need to change X, it is in file:symbol, and Y is in ..."), how control or data flows across files for an operation (the hops as file:symbol → file:symbol), or a compact map of a module area the agent had to assemble from many files.
- howto: exactly how to build/test/run/lint this repo, including the non-obvious flags, env, or fixtures.

Rules:
- Do NOT write "this file contains ..." summaries. Do NOT restate the task or what the agent changed in this session unless that reveals a reusable rule.
- Every claim must be grounded in what the agent actually observed in the trace (file contents, grep hits, command output), not in what it assumed.
- Bodies are 3-12 lines of markdown, dense, with \`path:Symbol\` pointers. Prefer symbol pointers over line numbers. State claims as present-tense facts about the code ("X does Y; Z must run before W"), never as a narrative of this session ("the session found", "in this run", "the agent then"): a future reader checks claims against code, and a story about one run cannot be checked. A claim that held only in this run is left out.
- deps: list every file the note's claims rest on, and for a code file name the definition (symbol) the claim rests on. A dep on a whole code file is almost never right: the file changes with every unrelated commit and the note goes stale for nothing; whole-file deps are for configs, scripts and documents. The cache hashes these to detect staleness, so be precise and do not list files the note does not depend on.
- applies: for rule notes, one line stating when the rule applies and when it does not (e.g. "only for options with multiple=True; arguments use a different path"). Generic lessons without such constraints are useless.
- answers: 2-5 short question phrasings a future agent might ask that this note answers (used for retrieval).
- confidence: 0.9+ only when the agent read the actual code; 0.6-0.8 for things inferred from grep hits or partial reads.
- Typical yield is 0 or 1 note; 2-3 only when the session clearly established distinct things, never more than 3. Most turns of a session only apply what is already known: 0 notes is the right answer for them. When in doubt, leave it out: a missing note costs one search later, a weak one is served to every later task it resembles.
- Not news: do not write what changed ("X now does Y", "merged to main", "was added in this session"). Write the rule or the map a later task needs, in the present tense, as if it had always been so.
- Not the state of one machine or one day: which copy is installed, a leftover file or hook, a credential, what a log or a dashboard showed, how the agent's own harness asked for permission. These are not facts about the repository's code.
- Not what the repository's own docs already say (README, AGENTS.md, CLAUDE.md and the like): agents read those at the start of every session. A note is for what the docs leave out or get wrong.
- The agent's final answer is usually the best-synthesized source; mine it, but only keep claims backed by the trace.`;

export const ASSESS_RULES = `

ASSESSING INJECTED NOTES: the session started with cached notes injected (listed below with ids). For each, judge from the trace only:
- confirmed: the agent acted on the note's pointers (read/grepped/edited what it names) and nothing it observed contradicted the note's claims.
- contradicted: something the agent observed (code it read, a failed command, a symbol it could not find) shows a claim in the note is wrong or the note misdirected the agent. Provide the corrected full body.
- unused: the note played no visible role.
Be strict about "contradicted": only when the trace shows evidence, not when the note was merely incomplete for this task.`;

export const EXISTING_RULES = `

EXISTING NOTES: the cache already holds notes on the files this session touched or on the topic it worked on (listed below with ids). Do not write a note that restates one of them, even in other words. When the session establishes something that completes or corrects one of them, return that note with \`extends\` set to its id and the full merged body (its claims that still hold, plus the new ones, same length rules). Prefer extending to writing a new note on a neighbouring topic. A new note is for understanding none of them holds.`;

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
// Then the notes on the topic of the session's requests, which share no file with it when the session
// ran commands rather than reading code: of the howto notes on running this repository's tests, five
// were written by five sessions, none shown the others.
export function relatedNotes(store, events, { max = 12, topical = 4 } = {}) {
  const files = new Set(touchedFiles(events, store.repo));
  const live = store.list().filter(n => n.status !== 'invalid');
  const byFile = !files.size ? [] : live
    .map(n => ({ n, hit: new Set((n.deps || []).map(d => d.path).filter(p => files.has(p))).size }))
    .filter(x => x.hit > 0)
    .sort((a, b) => b.hit - a.hit || (b.n.uses || 0) - (a.n.uses || 0))
    .map(x => x.n);
  const query = events.filter(e => e.t === 'prompt').map(e => String(e.text || '').replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ')).join('\n').slice(0, 2000);
  const byTopic = query.trim() ? rank(live, { query, mode: 'lookup' }).filter(r => r.rel > 0).map(r => r.note) : [];
  const out = byFile.slice(0, max - Math.min(topical, byTopic.length));
  for (const n of byTopic) { if (out.length >= max) break; if (!out.includes(n)) out.push(n); }
  for (const n of byFile) { if (out.length >= max) break; if (!out.includes(n)) out.push(n); }
  return out;
}

// kinds: what the distiller may produce. The caller leaves out the kinds this checkout archives
// (ops.js:archiveConfig): a note of a kind that is never served is a model call for nothing, and
// what a location note would say is found by code search.
export function distillSpec({ kinds = KINDS } = {}) {
  // a desired behavior (behavior.js) is a person's rule, never distilled; the model is not even offered the kind
  kinds = kinds.filter(k => k !== 'behavior');
  const left = KINDS.filter(k => k !== 'behavior' && !kinds.includes(k));
  const schema = JSON.parse(JSON.stringify(NOTE_SCHEMA));
  schema.properties.notes.items.properties.kind.enum = KINDS.filter(k => kinds.includes(k));
  if (!left.length) return { system: DISTILL_SYSTEM, schema };
  const system = DISTILL_SYSTEM + `\n\nDo not produce notes of these kinds: ${left.join(', ')}. This repository does not serve them (code search and git history answer what they would say); fold anything of theirs that matters into a note of another kind, or leave it out.`;
  return { system, schema };
}
export async function distillEvents(events, { model = 'sonnet', repoHint = '', served = [], existing = [], kinds = KINDS, accounting, evidence, discover = true, compact = false } = {}) {
  const trace = evidence ?? condense(events);
  let prompt = `Repository: ${repoHint}\n\nSESSION TRACE (tool calls with truncated results):\n\n${trace}`;
  let { system, schema } = distillSpec({ kinds });
  if (compact) {
    system += '\nThe trace is selected evidence, not the full session. Omission never proves a note was unused. Return assessments only for explicit supporting evidence; omit unknown notes. Do not infer facts from missing context. Keep the response concise.';
  }
  if (!discover) {
    system = 'Assess cached notes against the supplied evidence. Do not discover or write new notes. Return notes: []. Omission is not non-use; omit assessments without explicit evidence.';
    schema.properties.notes.maxItems = 0;
  }
  const servedIds = new Set(served.map(n => n.id));
  const shown = (discover ? existing : []).filter(n => !servedIds.has(n.id));
  if (shown.length) {
    system += EXISTING_RULES;
    prompt += `\n\nEXISTING NOTES RELEVANT TO THIS SESSION:\n` + shown.map(n => `id=${n.id} [${n.kind}] ${n.title}\n${n.body || ''}\nApplies: ${n.applies || '(unspecified)'}`).join('\n\n');
  }
  if (served.length) {
    system += ASSESS_RULES; schema = { ...ASSESS_SCHEMA, properties: { ...ASSESS_SCHEMA.properties, notes: schema.properties.notes } };
    prompt += `\n\nINJECTED NOTES TO ASSESS:\n` + served.map(n => `id=${n.id} [${n.kind}] ${n.title}\n${compact ? (n.body || '').slice(0, 1200) : n.body}`).join('\n\n');
    prompt += compact
      ? `\n\nReturn ${discover ? 'reusable notes, if any,' : 'notes: [],'} and only assessments supported by explicit evidence. Omit unknown notes; never infer unused from this selection.`
      : `\n\nProduce the notes JSON and one assessment per injected note.`;
  } else prompt += `\n\nProduce the notes JSON.`;
  const res = await complete({ system, prompt, model, schema, maxTokens: compact ? (discover ? 3000 : 1500) : 6000, thinkingTokens: 0, structuredRetries: 1, accounting });
  const notes = (discover ? (res.json?.notes || []) : []).slice().sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0)).slice(0, MAX_NOTES);
  return { notes, assessments: (res.json?.assessments || []).filter(a => servedIds.has(a.id) && ['confirmed', 'contradicted', 'unused'].includes(a.verdict) && (!compact || (['confirmed', 'contradicted'].includes(a.verdict) && String(a.evidence || '').trim()))), cost: res.cost, tokens: tokensOf(res), usage: res.usage, traceChars: trace.length, evidence: trace };
}

function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  let i = 0; for (const x of A) if (B.has(x)) i++;
  return i / (A.size + B.size - i || 1);
}


// Save distilled notes, merging near-duplicates (same topic → keep higher confidence, refresh deps).
export function saveNotes(store, notes, { source, kinds = KINDS, reconciled = false }) {
  const existing = store.list();
  const saved = [], merged = [], skipped = [], deferred = [];
  for (const candidate of notes) {
    const { learningTarget, ...n } = candidate;
    if (kindOf(n.kind) === 'behavior') { skipped.push({ title: n.title, reason: 'human behaviors cannot be created by automatic learning' }); continue; }
    if (KINDS.includes(kindOf(n.kind)) && !kinds.includes(kindOf(n.kind))) { skipped.push({ title: n.title, reason: `kind ${kindOf(n.kind)} is not served in this repository (archived by thinker archive)` }); continue; }
    const key = tokenize(n.title + ' ' + (n.answers || []).join(' '));
    const named = n.extends && existing.find(e => e.id === n.extends);
    if (named && kindOf(named.kind) === 'behavior') { skipped.push({ title: n.title, reason: 'human behaviors cannot be overwritten by automatic learning' }); continue; }
    if (reconciled && n.extends && (!named || learningTarget !== JSON.stringify({ id: named.id, kind: kindOf(named.kind), title: named.title, body: named.body, applies: named.applies || '' }))) { deferred.push({ title: n.title, note: n, reason: 'extension target changed after reconciliation', status: 'unavailable' }); continue; }
    const dup = named || (!reconciled && existing.find(e => jaccard(key, tokenize(e.title + ' ' + (e.answers || []).join(' '))) >= 0.5 && kindOf(e.kind) === kindOf(n.kind)));
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
  return { saved, merged, skipped, deferred, retryable: deferred.length > 0 };
}

export function transcriptsFor(cwd) {
  const enc = cwd.replace(/[\/.]/g, '-');
  const dir = path.join(os.homedir(), '.claude', 'projects', enc);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}
