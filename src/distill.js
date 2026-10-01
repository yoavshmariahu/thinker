// Distill an agent session (any transcript format transcripts.js reads) into notes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { complete } from './llm.js';
import { createNote, KINDS } from './ops.js';
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
- cochange: things that must be changed together (e.g. "adding a param type requires editing A, registering in B, and a test in C").
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

export async function distillEvents(events, { model = 'sonnet', repoHint = '', served = [], accounting } = {}) {
  const trace = condense(events);
  let prompt = `Repository: ${repoHint}\n\nSESSION TRACE (tool calls with truncated results):\n\n${trace}`;
  let system = DISTILL_SYSTEM, schema = NOTE_SCHEMA;
  if (served.length) {
    system += ASSESS_RULES; schema = ASSESS_SCHEMA;
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

// Save distilled notes, merging near-duplicates (same topic → keep higher confidence, refresh deps).
export function saveNotes(store, notes, { source }) {
  const existing = store.list();
  const saved = [], merged = [], skipped = [];
  for (const n of notes) {
    const key = tokenize(n.title + ' ' + (n.answers || []).join(' '));
    const dup = existing.find(e => jaccard(key, tokenize(e.title + ' ' + (e.answers || []).join(' '))) >= 0.5 && e.kind === n.kind);
    if (dup) {
      if ((n.confidence ?? 0.7) >= (dup.confidence ?? 0.7) - 0.1 || dup.status !== 'fresh') {
        const r = createNote(store, { ...n, id: dup.id }, { source, reuseId: true });
        if (r.error) { skipped.push({ title: n.title, reason: r.error }); store.put(dup); continue; }
        r.note.uses = dup.uses || 0; r.note.created = dup.created; r.note.history = [...(dup.history || []), { at: new Date().toISOString(), reason: 'merged from new session', prevBody: dup.body }].slice(-5);
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
