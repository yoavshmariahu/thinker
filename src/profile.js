// The session profile: what the person here is working on and how it goes, learned from the prompts
// and the agent's answers alone, compiled into one local document and loaded at the start of a session.
//
// Two stages, one ledger between them (the owner's choice, 2026-11-07):
//
//   session ──► exchanges (prompt, answers, the next prompt) ──► extract ──► ledger.jsonl (60 days)
//                                                                               │
//                                             profile.json ◄── patch ◄── new rows + profile so far
//
// The extraction never sees a tool call's content: the outcome of an exchange is read from the prompt
// that follows it, and the agent's own "done" is a claim. Tool-call *paths* alone label an observation
// with the directories the session worked in (`dirs`), for the per-directory profiles to come.
// Every profile entry cites the observations it rests on, so an entry the window no longer supports is
// dropped by code, not by the model; counts and dates are recomputed from the citations, never trusted.
//
// The profile is this machine's and never leaves it: `.thinker/local/profile/`, under the local
// directory git ignores, and no telemetry payload carries its text.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { complete, available, providerOfModel } from './llm.js';
import { tokensOf } from './model-usage.js';
import { areaOf } from './areas.js';
import { sessionState, locked, holdoutRate } from './ops.js';

export const PROFILE = {
  ledgerDays: 60,       // an observation older than this leaves the window and the file
  firstCompileAt: 1,    // the first compile waits for this many observations (then: whenever anything new was read)
  compileBatch: 200,    // new observations one compile step is shown at most; a longer backlog takes several steps
  minSessions: 2,       // sessions a howWeWork or whatFails entry needs, unless one observation states or corrects it outright
  workingOnDays: 21,    // a workstream not seen in this long is no longer current
  recentBugDays: 14,
  rebaseDays: 30,
  holdoutRate: 0.5,     // half the sessions, not the notes' 15%: see `profileHoldoutRate`
  holdoutMinObs: 380,   // observations a side needs before the holdout says anything (a 30% change at this rate)
  holdoutMinSessions: 20, // sessions a side needs before the holdout says anything       // a full compile from nothing, this often, so wording patches have carried a long way is re-derived
  renderChars: 6000,    // about 1500 tokens at chars/4 (the owner's call, 2026-11-08; 800 then 1000 before)
  perSection: { workingOn: 6, howWeWork: 10, whatFails: 10, recentBugs: 6 },
  textChars: 240,
};
// whatWorks was a fifth section until 2026-11-08: "an approach accepted after a correction" is the `instead` of a
// whatFails entry, and on its own it held one line in four that two sessions supported. Folded.
export const SECTIONS = ['workingOn', 'howWeWork', 'whatFails', 'recentBugs'];
export const OUTCOMES = ['accepted', 'corrected', 'redirected', 'unknown'];
export const KINDS = ['feature', 'fix', 'investigation', 'refactor', 'release', 'ops', 'docs', 'other'];

// `learn: { mode: 'profile' }` in .thinker/config.json turns the profile on in place of the notes;
// THINKER_PROFILE=on|off wins over the config, for a harness.
export function profileConfig(store) {
  const learn = store.config().learn || {};
  const env = process.env.THINKER_PROFILE;
  const enabled = /^(on|1|true)$/i.test(env || '') ? true : /^(off|0|false)$/i.test(env || '') ? false : learn.mode === 'profile';
  return { enabled, model: typeof learn.profileModel === 'string' ? learn.profileModel : null };
}

// --- models ---------------------------------------------------------------
// Opus and nothing else for now (the owner's call, 2026-11-07, after the first build fell down a ladder of Opus,
// GPT-SOL and Gemini on one session that timed out: a profile built by three models is not one profile). Each id
// names its provider, so `complete` pins it there rather than taking the tier table's fallback (Luna on Codex).
// `learn.profileModel` pins another model. A longer ladder was tried and taken out the same day.
export const PROFILE_MODELS = [
  ['claude', 'claude-opus-5-5'],
  ['anthropic', 'claude-opus-5-5'],
];
export function profileModels({ have = available(), config = {} } = {}) {
  if (config.model) return [config.model];
  if (process.env.THINKER_LLM) return process.env.THINKER_LLM === 'session' ? ['session'] : [PROFILE_MODELS.find(([p]) => p === process.env.THINKER_LLM)?.[1] || 'opus'];
  const out = [];
  for (const [p, m] of PROFILE_MODELS) if (have.includes(p) && !out.includes(m)) out.push(m);
  return out;
}
export async function completeProfile(opts, { have, config, completeFn = complete } = {}) {
  const models = profileModels({ have, config });
  if (!models.length) throw new Error('no model available for the profile: sign in the claude CLI or set ANTHROPIC_API_KEY, or set learn.profileModel');
  let last = null;
  for (const [i, model] of models.entries()) {
    try { return await completeFn({ ...opts, model: model === 'session' ? 'opus' : model }); }
    catch (e) {
      last = e;
      if (models[i + 1] && !process.env.THINKER_QUIET) process.stderr.write(`[thinker] profile: ${model} failed (${String(e.message || e).slice(0, 100)}), trying ${models[i + 1]}\n`);
    }
  }
  throw last;
}

// --- exchanges ------------------------------------------------------------
// What the hooks put into a prompt is not what anyone said.
const INJECTED = /<(thinker-[\w-]+|system[-_]reminder|command-name|command-message|command-args|local-command-stdout|local-command-caveat)>[\s\S]*?<\/\1>/g;
export const clean = text => String(text || '').replace(INJECTED, '').replace(/\n{3,}/g, '\n\n').trim();
// Codex runs an approval assessor beside a session, a rollout of its own in the same cwd whose "prompts" are the
// agent's history and whose "answers" are a risk verdict in JSON (79 of 79 in one such file here, 845k chars of
// prompts). Nobody said any of it.
const ASSESSOR_PROMPT = /^The following is the Codex agent history/;
const ASSESSOR_SAY = /^\s*\{\s*"risk_level"/;
const cut = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, Math.ceil(n * 0.6)) + ` …[${s.length - n} chars cut]… ` + s.slice(-Math.floor(n * 0.4)) : s; };

// A prompt with the agent's answers until the next prompt, and that next prompt, which is where the
// outcome is read. `turn` counts the prompts from 1. `at` (ms) is when the prompt was made: the prompt's own
// stamp, else the first stamped event after it, else the last one before it; null where the transcript has none.
export function exchanges(events) {
  const out = [];
  for (const e of events) {
    const at = Number.isFinite(e.at) && e.at > 0 ? e.at : null;
    if (e.t === 'prompt') { const text = clean(e.text); if (!text || ASSESSOR_PROMPT.test(text)) continue; out.push({ turn: out.length + 1, prompt: text, answers: [], next: null, at }); }
    else if (e.t === 'say' && out.length) { const text = clean(e.text); if (text && !ASSESSOR_SAY.test(text)) out.at(-1).answers.push(text); }
    if (at && out.length && !out.at(-1).at) out.at(-1).at = at;
  }
  for (let i = 0; i < out.length; i++) { if (i) out[i - 1].next = out[i].prompt; if (!out[i].at && i) out[i].at = out[i - 1].at; }
  return out.filter(x => x.answers.length || x.next);
}

// The text the extraction reads: every exchange, numbered, within maxChars; long answers lose their middle.
export function extractionInput(xs, { maxChars = 120_000 } = {}) {
  const per = Math.max(1500, Math.floor(maxChars / Math.max(1, xs.length)));
  const parts = xs.map(x => {
    const answers = x.answers.join('\n---\n');
    return `[${x.turn}] USER: ${cut(x.prompt, Math.min(2500, per / 3))}\n    AGENT: ${cut(answers, per - Math.min(2500, per / 3) - 100) || '(no answer recorded)'}`;
  });
  return parts.join('\n\n');
}

// The directories the session worked in, from the paths of its tool calls alone (never their content).
export function sessionDirs(events, repo = '') {
  const dirs = new Set();
  const rel = p => { p = String(p || ''); if (repo && p.startsWith(repo + '/')) p = p.slice(repo.length + 1); return p.replace(/^\.\//, ''); };
  for (const e of events) {
    if (e.t !== 'tool') continue;
    const inp = e.input || {};
    const p = inp.file_path || inp.path || inp.notebook_path;
    if (p && /\.\w+$/.test(String(p))) { const d = areaOf(rel(p)); if (d) dirs.add(d); }
  }
  return [...dirs].sort();
}

// --- extraction -----------------------------------------------------------
export const EXTRACT_SYSTEM = `You read one session between a person and a coding agent, as the person's prompts and the agent's answers only: no tool calls, no code, no command output. You record what was asked, what the agent says it did, and how the person reacted, as evidence for a profile of this person's work that future sessions read at their start. The profile is only as good as your honesty about outcomes.

Reading an exchange:
- The outcome of exchange [n] is the person's reaction in [n+1]. The agent's own words ("done", "tests pass") never decide it.
  - accepted: the reaction approves the result, uses it, or asks for the next step of the same work.
  - corrected: the reaction says the result is wrong, incomplete or not what was asked, or asks to undo or redo it.
  - redirected: the reaction changes the goal or the approach in response to the result, without calling it wrong.
  - unknown: no reaction yet (the last exchange), a next prompt about something else, or a reaction you cannot read. When in doubt, unknown.
- A USER line that is not the person speaking (a tool's report, a system or harness notice, a pasted log or document with no request) is neither a request nor a reaction.
- One observation per exchange that did work or made a decision. A question answered, a greeting or a bare command produces none. Exchanges on one task may become one observation: its turn is the first, its outcome the last reaction.

Fields:
- request: what was asked, in the person's words where they are short. kind: the closest label.
- approach: what the agent says it did, in one or two lines. This is the agent's account, recorded as such.
- reaction: the person's words that decided the outcome, quoted, under 160 characters. Empty for unknown.
- lesson: one line, only from a reaction: after a correction, what should have been done; after an acceptance that followed a correction on the same work, what worked. Never from the agent's account alone. Written as an instruction for next time.
- prefs: how the person says they want work done or answers given ("never push main", "don't ask, just do it", "no headers"), near their words. Stated only, never inferred from behaviour.
- bug: for a fix, the symptom and, where told, the cause and the fix, in one line. Empty otherwise.
- topics: one to four short tags.
- No file contents, no credentials; write a key or token as <token>.
An empty list is the right answer for a session that decided nothing.`;

export const OBSERVATION_SCHEMA = {
  type: 'object',
  properties: {
    observations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          turn: { type: 'number', description: 'the exchange number the observation starts at' },
          request: { type: 'string' },
          kind: { type: 'string', enum: KINDS },
          approach: { type: 'string', description: 'what the agent did, as it told it, one or two lines' },
          outcome: { type: 'string', enum: OUTCOMES },
          reaction: { type: 'string', description: 'the follow-up prompt that decided the outcome, quoted short; empty for unknown' },
          lesson: { type: 'string' },
          prefs: { type: 'array', items: { type: 'string' } },
          topics: { type: 'array', items: { type: 'string' } },
          bug: { type: 'string' },
        },
        required: ['turn', 'request', 'kind', 'approach', 'outcome', 'reaction', 'lesson', 'prefs', 'topics', 'bug'],
      },
    },
  },
  required: ['observations'],
};

const str = (s, n = PROFILE.textChars) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const list = (a, n = 5, len = 160) => [...new Set((Array.isArray(a) ? a : []).map(x => str(x, len)).filter(Boolean))].slice(0, n);
// A model's observation, in the ledger's shape; null when it says nothing.
export function tidyObservation(o) {
  if (!o || typeof o !== 'object') return null;
  const request = str(o.request); if (!request) return null;
  return {
    turn: Number.isFinite(Number(o.turn)) ? Math.max(1, Math.round(Number(o.turn))) : 1,
    request, kind: KINDS.includes(o.kind) ? o.kind : 'other',
    approach: str(o.approach, 400), outcome: OUTCOMES.includes(o.outcome) ? o.outcome : 'unknown',
    reaction: str(o.reaction, 160), lesson: str(o.lesson), prefs: list(o.prefs), topics: list(o.topics, 4, 40), bug: str(o.bug, 300),
  };
}

// When an observation happened: the stamp of the exchange it starts at, else the session's last stamp.
export function observationTimes(observations, xs) {
  const byTurn = new Map(xs.map(x => [x.turn, x.at]));
  const last = xs.map(x => x.at).filter(Boolean).at(-1) || null;
  return observations.map(o => { const at = byTurn.get(o.turn) || last; return at ? { ...o, at: new Date(at).toISOString() } : o; });
}

// One session's observations. `completeFn` is for tests; `have` and `config` pick the model ladder.
export async function extractObservations(events, { repoHint = '', ended = true, accounting, completeFn, have, config } = {}) {
  const xs = exchanges(events);
  if (!xs.length) return { observations: [], exchanges: 0, tokens: null, cost: null, chars: 0 };
  const input = extractionInput(xs);
  const prompt = `Repository: ${repoHint || '(unknown)'}\n${ended ? 'The session ended after the last exchange.' : 'The session may still be going on after the last exchange.'}\n\nEXCHANGES (${xs.length}):\n\n${input}\n\nReturn the observations JSON.`;
  const res = await completeProfile({ system: EXTRACT_SYSTEM, prompt, schema: OBSERVATION_SCHEMA, maxTokens: 6000, thinkingTokens: 0, structuredRetries: 1, timeoutMs: 600_000, accounting }, { have, config, completeFn });
  const observations = observationTimes((res.json?.observations || []).map(tidyObservation).filter(Boolean), xs);
  return { observations, exchanges: xs.length, tokens: tokensOf(res), cost: res.cost ?? null, chars: input.length, model: res.model };
}

// --- ledger ---------------------------------------------------------------
export const profileDir = store => path.join(store.localDir, 'profile');
const ledgerFile = store => path.join(profileDir(store), 'ledger.jsonl');
const profileFile = store => path.join(profileDir(store), 'profile.json');
const historyFile = store => path.join(profileDir(store), 'history.jsonl');
const extractedFile = store => path.join(profileDir(store), 'extracted.json');
function writeAtomic(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}`; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); }
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const dayOf = (at, now) => Math.floor((now - Date.parse(at)) / 86400_000);
// `at` is when the observation happened (the session's own clock); `seen` is when it was read into the ledger.
// The window and every date in the profile go by `at`; whether a compile is due goes by `seen`, since a session
// read a week after it ran is still news to the profile. Rows from before `seen` existed read as seen when they happened.
const seenOf = r => Date.parse(r.seen || r.at);

export function readLedger(store, { days = PROFILE.ledgerDays, now = Date.now() } = {}) {
  let lines = []; try { lines = fs.readFileSync(ledgerFile(store), 'utf8').split('\n'); } catch { return []; }
  const out = [];
  for (const l of lines) { if (!l) continue; try { const o = JSON.parse(l); if (o?.id && Number.isFinite(Date.parse(o.at)) && dayOf(o.at, now) <= days) out.push(o); } catch {} }
  return out;
}
// Observations are appended with their session and the session's directories; the file is cut to the window
// as it is written, so it never grows past what the compile reads. `at` is the time for an observation that
// carries none of its own (a transcript without stamps).
export function appendObservations(store, observations, { session, client, at, dirs = [], model, now = Date.now() } = {}) {
  const seen = new Date(now).toISOString(), fallback = at || seen;
  const rows = observations.map(o => { const when = o.at || fallback; return { id: 'obs-' + createHash('sha256').update(`${session}|${o.turn}|${o.request}|${when}`).digest('hex').slice(0, 10), at: when, seen, session: session || null, client: client || null, dirs, model: model || null, ...o, at: when }; });
  if (!rows.length) return [];
  const kept = readLedger(store, { now }).filter(r => !(session && r.session === session && rows.some(n => n.turn === r.turn && n.request === r.request)));
  writeAtomic(ledgerFile(store), [...kept, ...rows].map(r => JSON.stringify(r)).join('\n') + '\n');
  return rows;
}
// Which sessions were extracted, and up to which transcript line (a resumed session is extracted from there).
export function extracted(store) { return readJson(extractedFile(store)) || {}; }
export function markExtracted(store, session, { line = 0, at = new Date().toISOString(), observations = 0 } = {}) {
  const all = extracted(store); all[session] = { line, at, observations: (all[session]?.observations || 0) + observations };
  writeAtomic(extractedFile(store), JSON.stringify(all));
}

// --- compile --------------------------------------------------------------
// The compile is a patch (2026-11-08, after the first steady-state look): the model is shown the profile as it
// stands, each entry with an id, the new observations, and the observations behind the entries those might touch,
// and returns keep / update / drop / add. An entry it does not mention is kept, so nothing is lost by silence; a
// drop needs a reason; code merges the patch and `settle` applies the floors and the window. A full compile
// (nothing to start from) is the same step with an empty profile, in batches. This replaced a step that rewrote the
// whole profile each time: for ten new observations it sent the profile and up to 200 cited rows and wrote every
// entry again (~60k tokens, twice the sessions' own extraction), and each rewrite could lose or drift an entry with
// no new evidence behind the change.
export const COMPILE_SYSTEM = `You maintain a profile of one person's work in one repository from observations of their sessions with a coding agent. A future agent reads it at the start of every session, so that it knows what this person is in the middle of, how they want work done, and what has gone wrong here before. Write what would change what that agent does; leave out what would not.

You are given the profile as it stands, each entry with an id; the observations new since it was compiled; and, for the entries those might touch, the observations already behind them. Return a patch, not a profile:
- keep: ids to carry unchanged. An id you do not mention is kept too; nothing is lost by silence.
- update: an entry the new observations sharpen, extend or bring up to date: only the fields that change, and the new observation ids to add behind it. New evidence for a line that exists goes here, never into a near-duplicate entry.
- drop: an entry the observations now contradict, or that says what another entry says, with the reason. Never for age: the code retires what the window no longer supports.
- add: new entries, by section. One entry over several observations beats several entries.

Sections, and the most lines each may have:
- workingOn (6): the lines of work the person is in the middle of: seen in more than one exchange or session, or said to be ongoing. One line each: what it is and where it stands by the person's last reaction, not by the agent's account of finishing it. A decision the person took about the product's design belongs here while the work is current, not in howWeWork.
- howWeWork (10): how this person wants work done and answers given: process, communication, the bar for evidence. The strongest evidence is a stated preference (prefs), then a correction repeated across sessions. Preferences that say one thing in different words become one line, near their words. Where the instruction files already say it (their headings are listed) and agents still got it wrong, keep the line and say so ("in AGENTS.md; still missed"); where the files say it and nobody had to enforce it, leave it out. One line, one rule: a stated preference and an instruction-file rule are two lines, never one. Imperative and specific to this person: a line that could be written about any repository is not a profile line.
- whatFails (10): "when <kind of work>: avoid <this>", with the person's reaction quoted short in avoid, and instead = what the person then accepted, where a later approach to the same work was. From corrections and redirects. What recurs comes first; one sharp correction is enough when its lesson is specific.
- recentBugs (6): one line each: the symptom, the cause where told, and whether the fix was accepted. For a session that meets the symptom again.

Rules:
- Every entry cites the observation ids it rests on (obs): up to 10, the most telling, newest first. An entry you cannot cite does not exist. Counts and dates are computed from the citations; do not write them into the text.
- approach is the agent's own account. An observation with outcome unknown can support workingOn and recentBugs, and howWeWork through its prefs; it never supports whatFails.
- Fill a section to its cap when the observations support that many lines; the code drops a line with too little evidence, so there is no need to ration. An empty patch is the right answer for observations that change nothing.
- Lines are plain and under 200 characters. No narrative of sessions, no praise, no "the agent", no file contents, no secrets.`;

const entry = (props, required) => ({ type: 'array', items: { type: 'object', properties: { ...props, obs: { type: 'array', items: { type: 'string' } } }, required: [...required, 'obs'] } });
const FIELDS = { whatFails: ['when', 'avoid', 'instead'], workingOn: ['text'], howWeWork: ['text'], recentBugs: ['text'] };
export const PATCH_SCHEMA = {
  type: 'object',
  properties: {
    keep: { type: 'array', items: { type: 'string' } },
    update: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, when: { type: 'string' }, avoid: { type: 'string' }, instead: { type: 'string' }, obs: { type: 'array', items: { type: 'string' }, description: 'observation ids to add behind the entry' } }, required: ['id', 'obs'] } },
    drop: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id', 'reason'] } },
    add: {
      type: 'object',
      properties: {
        workingOn: entry({ text: { type: 'string' } }, ['text']),
        howWeWork: entry({ text: { type: 'string' } }, ['text']),
        whatFails: entry({ when: { type: 'string' }, avoid: { type: 'string' }, instead: { type: 'string', description: 'what was accepted afterwards, where known; else empty' } }, ['when', 'avoid']),
        recentBugs: entry({ text: { type: 'string' } }, ['text']),
      },
      required: SECTIONS,
    },
  },
  required: ['keep', 'update', 'drop', 'add'],
};

// The headings of the repository's instruction files: what the profile must not repeat.
export function instructionHeadings(repo, { max = 80 } = {}) {
  const files = ['AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md', 'GEMINI.md', '.github/copilot-instructions.md'];
  try { for (const f of fs.readdirSync(path.join(repo, '.cursor', 'rules'))) if (f.endsWith('.mdc') || f.endsWith('.md')) files.push(path.join('.cursor', 'rules', f)); } catch {}
  const out = [];
  for (const f of files) {
    let text; try { text = fs.readFileSync(path.join(repo, f), 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/^#{1,3} +(.+?)\s*$/gm)) { out.push(`${f}: ${m[1].replace(/[*`]/g, '').slice(0, 100)}`); if (out.length >= max) return out; }
  }
  return out;
}

// Observations as the compile reads them: newest first.
export function ledgerText(rows) {
  const sorted = [...rows].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return sorted.map(r => {
    const head = `${r.id} | ${String(r.at).slice(0, 10)} | ${r.kind} | outcome=${r.outcome}${r.dirs?.length ? ` | dirs=${r.dirs.slice(0, 4).join(',')}` : ''}`;
    const lines = [`  request: ${r.request}`, r.approach && `  approach: ${r.approach}`, r.reaction && `  reaction: "${r.reaction}"`, r.lesson && `  lesson: ${r.lesson}`, r.prefs?.length && `  prefs: ${r.prefs.join(' | ')}`, r.bug && `  bug: ${r.bug}`, r.topics?.length && `  topics: ${r.topics.join(', ')}`].filter(Boolean);
    return [head, ...lines].join('\n');
  }).join('\n\n');
}

// The patch merged into the profile as it stands: raw sections for `settle`. An entry not named is kept; an update
// replaces the fields it names and adds its observations; a drop removes; adds come last.
export function applyPatch(previous, patch) {
  const prev = previous?.sections || {};
  const updates = new Map((Array.isArray(patch?.update) ? patch.update : []).filter(u => u && typeof u === 'object').map(u => [String(u.id), u]));
  const drops = new Set((Array.isArray(patch?.drop) ? patch.drop : []).map(d => String(d?.id)));
  const out = {};
  for (const s of SECTIONS) {
    out[s] = [];
    for (const e of Array.isArray(prev[s]) ? prev[s] : []) {
      if (!e?.id || drops.has(e.id)) continue;
      const u = updates.get(e.id);
      if (!u) { out[s].push(e); continue; }
      const next = { ...e, obs: [...new Set([...(e.obs || []), ...(Array.isArray(u.obs) ? u.obs : []).map(String)])] };
      for (const f of FIELDS[s]) if (typeof u[f] === 'string' && u[f].trim()) next[f] = u[f];
      out[s].push(next);
    }
    for (const a of Array.isArray(patch?.add?.[s]) ? patch.add[s] : []) out[s].push(a);
  }
  return out;
}

// What the patch left, held to the ledger: citations the window does not hold are dropped, an entry with none
// goes, counts and dates come from the cited observations, the evidence floors apply, and each section is capped.
// A how-we-work or what-fails line needs two sessions, unless one observation states the preference outright
// (prefs) or corrects it in so many words (a correction with its reaction). Entries come out with ids for the
// next patch (`w1`, `h2`, `f3`, `b4`).
const PREFIX = { workingOn: 'w', howWeWork: 'h', whatFails: 'f', recentBugs: 'b' };
export function settle(sections, rows, { now = Date.now() } = {}) {
  const byId = new Map(rows.map(r => [r.id, r]));
  const out = {};
  for (const s of SECTIONS) {
    const items = [];
    for (const raw of Array.isArray(sections?.[s]) ? sections[s] : []) {
      if (!raw || typeof raw !== 'object') continue;
      const cited = [...new Set((Array.isArray(raw.obs) ? raw.obs : []).map(String))].filter(id => byId.has(id));
      if (!cited.length) continue;
      const obs = cited.map(id => byId.get(id));
      const ats = obs.map(o => Date.parse(o.at)).sort((a, b) => a - b);
      const e = { obs: cited, count: new Set(obs.map(o => o.session || o.id)).size, firstSeen: new Date(ats[0]).toISOString().slice(0, 10), lastSeen: new Date(ats.at(-1)).toISOString().slice(0, 10) };
      if (s === 'whatFails') { e.when = str(raw.when, 120); e.avoid = str(raw.avoid); if (str(raw.instead)) e.instead = str(raw.instead, 160); if (!e.when || !e.avoid) continue; }
      else { e.text = str(raw.text); if (!e.text) continue; }
      const age = (now - ats.at(-1)) / 86400_000;
      if (s === 'howWeWork' && e.count < PROFILE.minSessions && !obs.some(o => o.prefs?.length)) continue;
      if (s === 'whatFails' && e.count < PROFILE.minSessions && !obs.some(o => ['corrected', 'redirected'].includes(o.outcome) && o.reaction)) continue;
      if (s === 'workingOn' && age > PROFILE.workingOnDays) continue;
      if (s === 'recentBugs' && age > PROFILE.recentBugDays) continue;
      items.push(e);
    }
    items.sort(s === 'howWeWork' || s === 'whatFails' ? (a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen) : (a, b) => b.lastSeen.localeCompare(a.lastSeen) || b.count - a.count);
    out[s] = items.slice(0, PROFILE.perSection[s]).map((e, i) => ({ id: `${PREFIX[s]}${i + 1}`, ...e }));
  }
  return out;
}

export function readProfile(store) { return readJson(profileFile(store)); }
// A compile is due when anything was read into the ledger since the last one (the end of a session, in practice),
// and first once `firstCompileAt` observations exist. It was ten observations or three days while a compile rewrote
// the whole profile; a patch is cheap enough to run per session, which is where a profile built from few sessions
// pays: the next session's first turn says what the last one did.
export function compileDue(store, { now = Date.now() } = {}) {
  const rows = readLedger(store, { now });
  const p = readProfile(store);
  if (!p) return rows.length >= PROFILE.firstCompileAt;
  const since = Date.parse(p.compiledAt || 0);
  return rows.some(r => seenOf(r) > since);
}

const dateOf = ms => new Date(ms).toISOString().slice(0, 10);
const chunk = (a, n) => { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };
const words = r => new Set([...(r.topics || []).map(t => t.toLowerCase()), ...(r.dirs || [])]);

// The observations behind the entries a batch might touch: those sharing a topic or a directory with a new row,
// newest first, at most `max`. The rest of an entry's evidence stays valid through its citations.
export function relatedCited(previous, batch, rows, { max = 40 } = {}) {
  if (!previous) return [];
  const byId = new Map(rows.map(r => [r.id, r])), inBatch = new Set(batch.map(r => r.id));
  const fresh = new Set(batch.flatMap(r => [...words(r)]));
  const ids = [...new Set(SECTIONS.flatMap(s => (previous.sections?.[s] || []).flatMap(e => e.obs || [])))];
  return ids.map(id => byId.get(id)).filter(r => r && !inBatch.has(r.id) && [...words(r)].some(w => fresh.has(w))).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, max);
}

// One compile step: the profile so far, a batch of new observations and the related evidence in; a patch out,
// merged and settled.
async function compileStep(store, previous, batch, rows, { now, accounting, completeFn, have, config }) {
  // a profile written before entries carried ids (version 2) gets them here, so a patch can name its entries
  if (previous) previous = { ...previous, sections: Object.fromEntries(SECTIONS.map(s => [s, (previous.sections?.[s] || []).map((e, i) => e.id ? e : { id: `${PREFIX[s]}${i + 1}`, ...e })])) };
  const cited = relatedCited(previous, batch, rows);
  const headings = instructionHeadings(store.repo);
  const span = a => a.length ? `${dateOf(Math.min(...a.map(r => Date.parse(r.at))))} to ${dateOf(Math.max(...a.map(r => Date.parse(r.at))))}` : '';
  const shown = previous ? Object.fromEntries(SECTIONS.map(s => [s, (previous.sections?.[s] || []).map(({ id, text, when, avoid, instead, count, firstSeen, lastSeen, obs }) => ({ id, ...(text ? { text } : { when, avoid, ...(instead ? { instead } : {}) }), sessions: count, firstSeen, lastSeen, obs }))])) : null;
  const input = [
    `Repository: ${path.basename(store.repo)}\nToday: ${dateOf(now)}`,
    `INSTRUCTION FILE HEADINGS (do not repeat what these cover):\n${headings.map(h => '- ' + h).join('\n') || '(none)'}`,
    `PROFILE SO FAR (compiled ${previous?.compiledAt?.slice(0, 10) || 'never'}):\n${shown ? JSON.stringify(shown) : '(none: every entry is an add)'}`,
    cited.length ? `OBSERVATIONS BEHIND THE ENTRIES THESE MIGHT TOUCH (${cited.length}):\n\n${ledgerText(cited)}` : null,
    `NEW OBSERVATIONS (${batch.length}, from ${new Set(batch.map(r => r.session)).size} sessions, ${span(batch)}, newest first):\n\n${ledgerText(batch)}`,
    'Return the patch JSON.',
  ].filter(Boolean).join('\n\n');
  const res = await completeProfile({ system: COMPILE_SYSTEM, prompt: input, schema: PATCH_SCHEMA, maxTokens: 16000, thinkingTokens: 0, structuredRetries: 2, timeoutMs: 600_000, accounting }, { have, config, completeFn });
  const patch = res.json || {};
  const sections = settle(applyPatch(previous, patch), rows, { now });
  const ats = rows.map(r => Date.parse(r.at));
  const profile = { version: 3, compiledAt: new Date(now).toISOString(), model: res.model || null, window: { days: PROFILE.ledgerDays, observations: rows.length, sessions: new Set(rows.map(r => r.session).filter(Boolean)).size, from: dateOf(Math.min(...ats)), to: dateOf(Math.max(...ats)) }, sections };
  const changes = { kept: (patch.keep || []).length, updated: (patch.update || []).length, dropped: (patch.drop || []).length, added: SECTIONS.reduce((n, s) => n + (patch.add?.[s]?.length || 0), 0) };
  return { profile, tokens: tokensOf(res) || 0, cost: res.cost ?? null, chars: input.length, changes };
}

// A compile: the observations seen since the last one, patched into the profile, in steps of `compileBatch` when the
// backlog is longer; the previous profile goes to history. `full` starts from nothing over the whole window (a changed
// prompt, or `thinker profile rebuild`). `dry` returns what would be sent without a call. The profile is written
// after every step, so a step that fails loses its own work alone. The output is the long side of the call (a
// 200-row step came back with no `sections` object at 8k tokens), so it gets 16k and a second attempt.
export async function compileProfile(store, { now = Date.now(), accounting, completeFn, have, config, dry = false, full = false } = {}) {
  const rows = readLedger(store, { now });
  const onDisk = readProfile(store);
  // the monthly full compile (`rebaseDays`): from nothing, so an entry patches have reworded for weeks is derived again
  if (!full && onDisk && now - Date.parse(onDisk.rebasedAt || onDisk.compiledAt || 0) > PROFILE.rebaseDays * 86400_000) full = true;
  const previous = full ? null : onDisk;
  const since = previous ? Date.parse(previous.compiledAt || 0) : 0;
  const pending = rows.filter(r => seenOf(r) > since).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const batches = chunk(pending, PROFILE.compileBatch);
  const sessions = new Set(rows.map(r => r.session).filter(Boolean)).size;
  if (dry) return { dry: true, observations: rows.length, pending: pending.length, steps: batches.length, sessions, headings: instructionHeadings(store.repo).length, previous: !!previous };
  if (!rows.length) return { skipped: 'no observations' };
  if (!pending.length) return { skipped: 'nothing new since the last compile (--full compiles the whole window again)' };
  let current = previous, tokens = 0, cost = 0, landed = 0;
  const changes = { kept: 0, updated: 0, dropped: 0, added: 0 };
  const rebasedAt = full || !previous?.rebasedAt ? new Date(now).toISOString() : previous.rebasedAt;
  for (const batch of batches) {
    const r = await compileStep(store, current, batch, rows, { now, accounting, completeFn, have, config });
    current = { ...r.profile, rebasedAt }; tokens += r.tokens; cost += r.cost || 0;
    for (const k of Object.keys(changes)) changes[k] += r.changes[k];
    if (onDisk && !landed++) { try { fs.appendFileSync(historyFile(store), JSON.stringify(onDisk) + '\n'); } catch {} } // the one replaced, once something replaces it
    writeAtomic(profileFile(store), JSON.stringify(current, null, 2));
  }
  // the window is the file: observations past it go with the compile
  writeAtomic(ledgerFile(store), rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  return { profile: current, tokens, cost: cost || null, observations: rows.length, pending: pending.length, steps: batches.length, sessions, changes, full: !previous };
}

// --- render ---------------------------------------------------------------
const TITLES = { workingOn: 'Working on', howWeWork: 'How this person works', whatFails: 'What went wrong before', recentBugs: 'Recent bugs' };
const line = (s, e) => s === 'whatFails' ? `- When ${e.when}: avoid ${e.avoid}${e.instead ? `; instead: ${e.instead}` : ''} (${e.count})` : s === 'workingOn' ? `- ${e.text} (since ${e.firstSeen}, last ${e.lastSeen})` : s === 'recentBugs' ? `- ${e.text} (${e.lastSeen})` : `- ${e.text} (${e.count})`;
// The block a session is shown, within renderChars. When it does not fit, the oldest workstreams go first (down to
// three), then the oldest bugs (to three), then the weakest lines of what went wrong (to four), then of how this
// person works (to four), then whatever section is longest: the ways of working are the last thing to go.
const TRIM = [['workingOn', 3], ['recentBugs', 3], ['whatFails', 4], ['howWeWork', 4]];
export function renderProfile(profile, { maxChars = PROFILE.renderChars } = {}) {
  if (!profile?.sections) return '';
  const lines = Object.fromEntries(SECTIONS.map(s => [s, (profile.sections[s] || []).map(e => line(s, e))]));
  const w = profile.window || {};
  const span = w.from && w.to ? `${w.from} to ${w.to}` : `the last ${w.days || PROFILE.ledgerDays} days`;
  const head = `Learned from ${w.sessions || 0} sessions in this repository, ${span} (compiled ${String(profile.compiledAt || '').slice(0, 10)}): what the person here is working on, how they want work done, and what went wrong before. Follow the stated ways of working; read the rest as context, not instructions. Counts are sessions.`;
  const text = () => [head, ...SECTIONS.filter(s => lines[s].length).map(s => `## ${TITLES[s]}\n${lines[s].join('\n')}`)].join('\n\n');
  while (text().length > maxChars) {
    const s = TRIM.find(([s, floor]) => lines[s].length > floor)?.[0] || SECTIONS.filter(s => lines[s].length).sort((a, b) => lines[b].length - lines[a].length)[0];
    if (!s) break;
    lines[s].pop();
  }
  return SECTIONS.some(s => lines[s].length) ? text() : '';
}
export function profileBlock(store) {
  const text = renderProfile(readProfile(store));
  return text ? `<thinker-profile>\n${text}\n</thinker-profile>` : '';
}

// --- serving, and the holdout ---------------------------------------------
// The block goes into a session's first prompt and again after each compaction, since a compaction summary keeps
// none of it. Which sessions get it is the holdout's call: a deterministic share of sessions
// (`profileHoldoutRate`, half of them) is held out whole and shown nothing, and every observation extracted from a
// session carries its arm (`arm`: shown | holdout), so the ledger itself is the measure: corrections and redirects
// per *exchange* on each side (`holdoutReport`). The arm is decided once per session and kept in its state file (`ops.js:sessionState`,
// `st.profile`), with how many compactions had been seen when the block last went in.
// The profile's own holdout share, which is not the notes' (`PROFILE.holdoutRate`, 0.5; `learn: { profileHoldout }`
// in .thinker/config.json, `THINKER_PROFILE_HOLDOUT` over it, `THINKER_HOLDOUT` over both so a harness that turns
// every holdout off still does). Half, not the notes' 15%, because the two are measured differently and the
// profile's measure is the weaker one: a note is held out per turn and judged on the turn it was served, while the
// profile is one injection the whole session reads, so a session is the unit and there is no pairing to lean on.
// Measured on this repository's first ledger (680 observations, 116 sessions, 2026-11-08): corrections run at
// 0.313 of exchanges with an ICC of ~0 inside a session, so the unit that matters is the exchange and 15% of
// sessions on the small side wastes most of the information. At 85/15 a 30% change needs ~1000 sessions here
// (7 months at 5 a day); at 50/50, ~130 (26 days). An unbalanced split only makes sense once the thing is known
// to work and the holdout is there to catch a regression; that is where this should go when it ships.
export function profileHoldoutRate(store) {
  const env = process.env.THINKER_HOLDOUT;
  if (env !== undefined && env !== '') return holdoutRate(store);
  const own = process.env.THINKER_PROFILE_HOLDOUT;
  const raw = own !== undefined && own !== '' ? own : (store.config().learn || {}).profileHoldout;
  if (raw === undefined || raw === null) return PROFILE.holdoutRate;
  if (raw === false || /^(off|no|false)$/i.test(String(raw))) return 0;
  const r = Number(raw);
  return Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : PROFILE.holdoutRate;
}
export function profileArm(store, session) {
  if (!session || session === 'unknown') return null;
  const rate = profileHoldoutRate(store);
  if (rate <= 0) return 'shown';
  const h = parseInt(createHash('sha1').update(`profile#${session}`).digest('hex').slice(0, 8), 16) / 0x100000000;
  return h < rate ? 'holdout' : 'shown';
}
// Compaction boundaries written to a Claude Code transcript since `offset` bytes, and the file's size now.
export function compactionsSince(file, offset = 0) {
  try {
    const size = fs.statSync(file).size;
    if (size <= offset) return { count: 0, offset: size };
    const fd = fs.openSync(file, 'r');
    try { const buf = Buffer.alloc(size - offset); fs.readSync(fd, buf, 0, buf.length, offset); return { count: (buf.toString('utf8').match(/"subtype":"compact_boundary"/g) || []).length, offset: size }; }
    finally { fs.closeSync(fd); }
  } catch { return { count: 0, offset }; }
}
// What the prompt hook puts in: the block on the first prompt of a shown session and after a compaction, else ''.
// Logged `op: profile-served` once per injection with the arm and whether a compaction brought it; a held-out
// session is logged once, on its first prompt, so the arms can be counted from the log too.
export function profileTurn(store, session, { transcript = null, client = null, now = Date.now() } = {}) {
  if (!session || session === 'unknown' || !profileConfig(store).enabled) return '';
  const text = profileBlock(store);
  if (!text) return '';
  return locked(store, session, () => {
    const { st, save } = sessionState(store, session);
    const p = st.profile || { arm: profileArm(store, session), told: 0, compactions: 0, offset: 0 };
    let since = { count: 0, offset: p.offset || 0 };
    if (transcript && client === 'claude') { since = compactionsSince(transcript, p.offset || 0); p.compactions = (p.compactions || 0) + since.count; p.offset = since.offset; }
    const due = !p.told || p.compactions > p.toldAt;
    if (due && p.arm === 'shown') { p.told = (p.told || 0) + 1; p.toldAt = p.compactions; }
    const log = due && (p.arm === 'shown' || !p.told) && !p.loggedHoldout;
    if (due && p.arm === 'holdout') p.loggedHoldout = true;
    st.profile = p; save();
    if (log) store.log({ op: 'profile-served', session, client, arm: p.arm, chars: p.arm === 'shown' ? text.length : 0, afterCompaction: p.compactions > 0 && p.told > 1 ? true : undefined, at: new Date(now).toISOString() });
    return due && p.arm === 'shown' ? text : '';
  });
}
export function profileArmOf(store, session) {
  if (!session || session === 'unknown' || !store.exists()) return null;
  return sessionState(store, session).st.profile?.arm || null;
}
// The two arms over the ledger. **The measure is corrections per exchange, not per session** (2026-11-08): an
// exchange is the unit the profile acts on, every exchange carries an outcome, and measured on this repository's
// first ledger the corrections inside one session are independent of each other (ICC ~0 over 680 observations in
// 116 sessions), so a count per session throws the information away and keeps the variance. The numbers: a 30%
// change needs ~380 observations a side as a proportion (26 days here) against ~320 sessions a side as a count
// (127 days). `rate` is (corrected + redirected) / observations, and `delta` is the shown side's rate less the
// held-out side's -- negative is the profile working -- with a 95% interval from the two-proportion standard error,
// so a reader sees at once whether the window can carry a conclusion at all. Two guardrails sit beside it, because
// the rate is a ratio and a profile could improve it by making exchanges smaller and more numerous: `perSession`
// (exchanges per session) and the caller's tokens per session. Break-even is a 3-12% drop depending on how much of
// a corrected exchange is wasted work, which is below what any window here can resolve -- so this report rules out
// harm, and does not try to prove the gain.
export function holdoutReport(rows) {
  const arms = { shown: [], holdout: [], unknown: [] };
  for (const r of rows) (arms[r.arm === 'shown' || r.arm === 'holdout' ? r.arm : 'unknown']).push(r);
  const bad = r => r.outcome === 'corrected' || r.outcome === 'redirected';
  const side = a => {
    const sessions = new Set(a.map(r => r.session)).size, n = a.length;
    const share = o => n ? a.filter(r => r.outcome === o).length / n : null;
    return { sessions, observations: n, perSession: sessions ? n / sessions : null, rate: n ? a.filter(bad).length / n : null, corrected: share('corrected'), redirected: share('redirected'), accepted: share('accepted') };
  };
  const shown = side(arms.shown), holdout = side(arms.holdout);
  return { shown, holdout, unknown: side(arms.unknown), ...compare(shown, holdout) };
}
// Shown against held out on the primary rate: the difference, its 95% interval, and whether the window carries it.
// `enough` is the floor both sides must clear (`PROFILE.holdoutMinObs`); `verdict` is what the interval supports,
// never a p-value dressed up as a decision: `harm` (the whole interval is above zero), `better` (all below),
// `inconclusive` (it straddles), `too-early` (a side is under the floor).
export function compare(shown, holdout) {
  const enough = shown.observations >= PROFILE.holdoutMinObs && holdout.observations >= PROFILE.holdoutMinObs;
  if (shown.rate == null || holdout.rate == null) return { delta: null, ci: null, enough, verdict: 'too-early' };
  const delta = shown.rate - holdout.rate;
  const v = (p, n) => n ? p * (1 - p) / n : 0;
  const se = Math.sqrt(v(shown.rate, shown.observations) + v(holdout.rate, holdout.observations));
  const ci = [delta - 1.96 * se, delta + 1.96 * se];
  const verdict = !enough ? 'too-early' : ci[1] < 0 ? 'better' : ci[0] > 0 ? 'harm' : 'inconclusive';
  return { delta, ci, relative: holdout.rate ? delta / holdout.rate : null, enough, verdict };
}

// --- a session, end to end ------------------------------------------------
// Extract a session's observations into the ledger, then compile when due. The caller has parsed the transcript
// and decided the session is done with (the end hook, or the catch-up over quiet sessions).
export async function profileSession(store, events, { session, client, repoHint, ended = true, fromLine = 0, lineCount = 0, accounting = {}, completeFn, have, config, compile = true, now = Date.now() } = {}) {
  const r = await extractObservations(events, { repoHint, ended, accounting: { ...accounting, store, purpose: 'profile-extract', session }, completeFn, have, config });
  const dirs = sessionDirs(events, store.repo);
  const arm = profileArmOf(store, session);
  const rows = appendObservations(store, r.observations.map(o => arm ? { ...o, arm } : o), { session, client, dirs, model: r.model, now });
  if (session) markExtracted(store, session, { line: lineCount, observations: rows.length });
  store.log({ op: 'profile', session, client, exchanges: r.exchanges, observations: rows.length, outcomes: Object.fromEntries(OUTCOMES.map(o => [o, rows.filter(x => x.outcome === o).length]).filter(([, n]) => n)), chars: r.chars, tokens: r.tokens, cost: r.cost, model: r.model || null, fromLine });
  let compiled = null;
  if (compile && compileDue(store, { now })) {
    const c = await compileProfile(store, { now, accounting: { ...accounting, store, purpose: 'profile-compile' }, completeFn, have, config });
    if (c.profile) { compiled = c; store.log({ op: 'profile-compile', observations: c.observations, pending: c.pending, steps: c.steps, changes: c.changes, sessions: c.sessions, entries: Object.fromEntries(SECTIONS.map(s => [s, c.profile.sections[s].length])), tokens: c.tokens, cost: c.cost, model: c.profile.model }); }
  }
  return { observations: rows, exchanges: r.exchanges, tokens: (r.tokens || 0) + (compiled?.tokens || 0), compiled: compiled?.profile || null };
}
