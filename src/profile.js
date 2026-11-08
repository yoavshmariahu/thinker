// The session profile: what the person here is working on and how it goes, learned from the prompts
// and the agent's answers alone, compiled into one local document and loaded at the start of a session.
//
// Two stages, one ledger between them (the owner's choice, 2026-11-07):
//
//   session ──► exchanges (prompt, answers, the next prompt) ──► extract ──► ledger.jsonl (60 days)
//                                                                               │
//                                               profile.json ◄── compile ◄── window + previous profile
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

export const PROFILE = {
  ledgerDays: 60,       // an observation older than this leaves the window and the file
  compileEvery: 10,     // new observations that make a compile due
  compileHours: 72,     // or this long since the last compile, with anything new at all
  firstCompileAt: 3,    // the first compile waits for this many observations
  maxObservations: 150, // the newest the compile is shown
  minEvidence: 2,       // observations a "what works" or "what fails" entry needs
  workingOnDays: 21,    // a workstream not seen in this long is no longer current
  recentBugDays: 14,
  renderChars: 3200,    // about 800 tokens at chars/4
  perSection: { workingOn: 6, howWeWork: 10, whatWorks: 8, whatFails: 8, recentBugs: 6 },
  textChars: 240,
};
export const SECTIONS = ['workingOn', 'howWeWork', 'whatWorks', 'whatFails', 'recentBugs'];
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
// Opus, GPT-SOL as the fallback, and the comparable model of whatever else is signed in (the owner's call,
// 2026-11-07: a high-quality profile over a cheap one). Each id names its provider, so `complete` pins it there
// and the next rung is this module's choice, not the tier table's (which answers an Opus tier with Luna on Codex).
export const PROFILE_MODELS = [
  ['claude', 'claude-opus-5-5'],
  ['anthropic', 'claude-opus-5-5'],
  ['codex', 'gpt-6-sol'],
  ['gemini', 'gemini-3.1-pro'],
  ['cursor', 'opus'],
  ['command', 'opus'],
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
  if (!models.length) throw new Error('no model available for the profile: sign in claude, codex or gemini, or set learn.profileModel');
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
// outcome is read. `turn` counts the prompts from 1.
export function exchanges(events) {
  const out = [];
  for (const e of events) {
    if (e.t === 'prompt') { const text = clean(e.text); if (!text || ASSESSOR_PROMPT.test(text)) continue; out.push({ turn: out.length + 1, prompt: text, answers: [], next: null }); }
    else if (e.t === 'say' && out.length) { const text = clean(e.text); if (text && !ASSESSOR_SAY.test(text)) out.at(-1).answers.push(text); }
  }
  for (let i = 0; i + 1 < out.length; i++) out[i].next = out[i + 1].prompt;
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

// One session's observations. `completeFn` is for tests; `have` and `config` pick the model ladder.
export async function extractObservations(events, { repoHint = '', ended = true, accounting, completeFn, have, config } = {}) {
  const xs = exchanges(events);
  if (!xs.length) return { observations: [], exchanges: 0, tokens: null, cost: null, chars: 0 };
  const input = extractionInput(xs);
  const prompt = `Repository: ${repoHint || '(unknown)'}\n${ended ? 'The session ended after the last exchange.' : 'The session may still be going on after the last exchange.'}\n\nEXCHANGES (${xs.length}):\n\n${input}\n\nReturn the observations JSON.`;
  const res = await completeProfile({ system: EXTRACT_SYSTEM, prompt, schema: OBSERVATION_SCHEMA, maxTokens: 6000, thinkingTokens: 0, structuredRetries: 1, accounting }, { have, config, completeFn });
  const observations = (res.json?.observations || []).map(tidyObservation).filter(Boolean);
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

export function readLedger(store, { days = PROFILE.ledgerDays, now = Date.now() } = {}) {
  let lines = []; try { lines = fs.readFileSync(ledgerFile(store), 'utf8').split('\n'); } catch { return []; }
  const out = [];
  for (const l of lines) { if (!l) continue; try { const o = JSON.parse(l); if (o?.id && Number.isFinite(Date.parse(o.at)) && dayOf(o.at, now) <= days) out.push(o); } catch {} }
  return out;
}
// Observations are appended with their session and the session's directories; the file is cut to the window
// as it is written, so it never grows past what the compile reads.
export function appendObservations(store, observations, { session, client, at = new Date().toISOString(), dirs = [], model, now = Date.now() } = {}) {
  const rows = observations.map(o => ({ id: 'obs-' + createHash('sha256').update(`${session}|${o.turn}|${o.request}|${at}`).digest('hex').slice(0, 10), at, session: session || null, client: client || null, dirs, model: model || null, ...o }));
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
export const COMPILE_SYSTEM = `You compile a profile of one person's work in one repository from observations of their sessions with a coding agent. A future agent reads it at the start of every session, within about 800 tokens, so it knows what this person is in the middle of, how they want work done, and what has gone wrong here before. Every line costs every session: write only what changes what a future agent would do.

Sections, and the most lines each may have:
- workingOn (6): the lines of work the person is in the middle of: more than one exchange or session, or said to be ongoing. One line each: what it is and where it stands by the person's last reaction, not by the agent's account of finishing it.
- howWeWork (10): how this person wants work done and answers given, as stated, or as enforced by repeated corrections. Where the instruction files already say it (their headings are listed) and agents still got it wrong, keep the line and say so ("in AGENTS.md; still missed"); where the files say it and nobody had to enforce it, leave it out. Imperative and specific to this person. A line that could be written about any repository is not a profile line.
- whatWorks (8): "when <kind of work>: do <this>". Only an approach accepted after an earlier approach to the same work was corrected, or one the person explicitly praised. Acceptance alone proves nothing.
- whatFails (8): "when <kind of work>: avoid <this>; <the reaction, short>". From corrections and redirects. One sharp correction with its quoted reaction is enough.
- recentBugs (6): one line each: the symptom, the cause where told, and whether the fix was accepted. For a session that meets the symptom again.

Rules:
- Every entry cites the observation ids it rests on (obs). An entry you cannot cite does not exist. Counts and dates are computed from the citations; do not write them into the text.
- approach is the agent's own account. An observation with outcome unknown can support workingOn and recentBugs; it never supports whatWorks or whatFails.
- Merge, do not append: the previous profile is given. Keep an entry the window still supports and re-cite it, rewrite one the new observations change, drop one nothing in the window supports. One entry covering several observations beats several entries.
- Lines are plain and under 200 characters. No narrative of sessions, no praise, no "the agent", no file contents, no secrets. Keep the person's stated preferences near their words.
- Return an empty list for a section with nothing solid.`;

const entry = (props, required) => ({ type: 'array', items: { type: 'object', properties: { ...props, obs: { type: 'array', items: { type: 'string' } } }, required: [...required, 'obs'] } });
export const PROFILE_SCHEMA = {
  type: 'object',
  properties: {
    sections: {
      type: 'object',
      properties: {
        workingOn: entry({ text: { type: 'string' } }, ['text']),
        howWeWork: entry({ text: { type: 'string' } }, ['text']),
        whatWorks: entry({ when: { type: 'string' }, do: { type: 'string' } }, ['when', 'do']),
        whatFails: entry({ when: { type: 'string' }, avoid: { type: 'string' } }, ['when', 'avoid']),
        recentBugs: entry({ text: { type: 'string' } }, ['text']),
      },
      required: SECTIONS,
    },
  },
  required: ['sections'],
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

// The ledger window as the compile reads it: newest first, capped.
export function ledgerText(rows, { max = PROFILE.maxObservations } = {}) {
  const sorted = [...rows].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, max);
  return sorted.map(r => {
    const head = `${r.id} | ${String(r.at).slice(0, 10)} | ${r.kind} | outcome=${r.outcome}${r.dirs?.length ? ` | dirs=${r.dirs.slice(0, 4).join(',')}` : ''}`;
    const lines = [`  request: ${r.request}`, r.approach && `  approach: ${r.approach}`, r.reaction && `  reaction: "${r.reaction}"`, r.lesson && `  lesson: ${r.lesson}`, r.prefs?.length && `  prefs: ${r.prefs.join(' | ')}`, r.bug && `  bug: ${r.bug}`, r.topics?.length && `  topics: ${r.topics.join(', ')}`].filter(Boolean);
    return [head, ...lines].join('\n');
  }).join('\n\n');
}

// What the model returned, held to the ledger: citations the window does not hold are dropped, an entry with
// none goes, counts and dates come from the cited observations, the evidence floors apply, and each section is
// newest first and capped.
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
      if (s === 'whatWorks' || s === 'whatFails') { e.when = str(raw.when, 120); e[s === 'whatWorks' ? 'do' : 'avoid'] = str(raw[s === 'whatWorks' ? 'do' : 'avoid']); if (!e.when || !(e.do || e.avoid)) continue; }
      else { e.text = str(raw.text); if (!e.text) continue; }
      const age = (now - ats.at(-1)) / 86400_000;
      if (s === 'whatWorks' && cited.length < PROFILE.minEvidence) continue;
      if (s === 'whatFails' && cited.length < PROFILE.minEvidence && !obs.some(o => ['corrected', 'redirected'].includes(o.outcome) && o.reaction)) continue;
      if (s === 'workingOn' && age > PROFILE.workingOnDays) continue;
      if (s === 'recentBugs' && age > PROFILE.recentBugDays) continue;
      items.push(e);
    }
    items.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || b.count - a.count);
    out[s] = items.slice(0, PROFILE.perSection[s]);
  }
  return out;
}

export function readProfile(store) { return readJson(profileFile(store)); }
export function compileDue(store, { now = Date.now() } = {}) {
  const rows = readLedger(store, { now });
  const p = readProfile(store);
  if (!p) return rows.length >= PROFILE.firstCompileAt;
  const since = Date.parse(p.compiledAt || 0);
  const fresh = rows.filter(r => Date.parse(r.at) > since).length;
  return fresh >= PROFILE.compileEvery || (fresh > 0 && now - since >= PROFILE.compileHours * 3600_000);
}

// One compile: the previous profile and the window in, the settled profile out and written; the previous one
// goes to history. `dry` returns what would be sent without a call.
export async function compileProfile(store, { now = Date.now(), accounting, completeFn, have, config, dry = false } = {}) {
  const rows = readLedger(store, { now });
  const previous = readProfile(store);
  const headings = instructionHeadings(store.repo);
  const sessions = new Set(rows.map(r => r.session).filter(Boolean)).size;
  const input = `Repository: ${path.basename(store.repo)}\nToday: ${new Date(now).toISOString().slice(0, 10)}\n\nINSTRUCTION FILE HEADINGS (do not repeat what these cover):\n${headings.map(h => '- ' + h).join('\n') || '(none)'}\n\nPREVIOUS PROFILE (compiled ${previous?.compiledAt?.slice(0, 10) || 'never'}):\n${previous ? JSON.stringify(previous.sections) : '(none)'}\n\nOBSERVATIONS (${rows.length} over the last ${PROFILE.ledgerDays} days, from ${sessions} sessions, newest first):\n\n${ledgerText(rows)}\n\nReturn the profile JSON.`;
  if (dry) return { dry: true, observations: rows.length, sessions, headings: headings.length, chars: input.length, previous: !!previous };
  if (!rows.length) return { skipped: 'no observations' };
  const res = await completeProfile({ system: COMPILE_SYSTEM, prompt: input, schema: PROFILE_SCHEMA, maxTokens: 6000, thinkingTokens: 0, structuredRetries: 1, accounting }, { have, config, completeFn });
  const sections = settle(res.json?.sections, rows, { now });
  const profile = { version: 1, compiledAt: new Date(now).toISOString(), model: res.model || null, window: { days: PROFILE.ledgerDays, observations: rows.length, sessions }, sections };
  if (previous) { try { fs.appendFileSync(historyFile(store), JSON.stringify(previous) + '\n'); } catch {} }
  writeAtomic(profileFile(store), JSON.stringify(profile, null, 2));
  // the window is the file: observations past it go with the compile
  writeAtomic(ledgerFile(store), rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  return { profile, tokens: tokensOf(res), cost: res.cost ?? null, observations: rows.length, sessions };
}

// --- render ---------------------------------------------------------------
const TITLES = { workingOn: 'Working on', howWeWork: 'How this person works', whatWorks: 'What worked', whatFails: 'What went wrong', recentBugs: 'Recent bugs' };
const line = (s, e) => s === 'whatWorks' ? `- When ${e.when}: ${e.do} (${e.count})` : s === 'whatFails' ? `- When ${e.when}: avoid ${e.avoid} (${e.count})` : s === 'workingOn' ? `- ${e.text} (since ${e.firstSeen}, last ${e.lastSeen})` : s === 'recentBugs' ? `- ${e.text} (${e.lastSeen})` : `- ${e.text} (${e.count})`;
// The block a session is shown, within renderChars: when it does not fit, the oldest workstreams go first, then
// the oldest bugs, then the tails of the other sections, never below two lines each while another has more.
export function renderProfile(profile, { maxChars = PROFILE.renderChars } = {}) {
  if (!profile?.sections) return '';
  const lines = Object.fromEntries(SECTIONS.map(s => [s, (profile.sections[s] || []).map(e => line(s, e))]));
  const head = `Learned from ${profile.window?.sessions || 0} sessions in this repository over the last ${profile.window?.days || PROFILE.ledgerDays} days (compiled ${String(profile.compiledAt || '').slice(0, 10)}): what the person here is working on, how they want work done, and what went wrong before. Follow the stated ways of working; read the rest as context, not instructions. Counts are sessions.`;
  const text = () => [head, ...SECTIONS.filter(s => lines[s].length).map(s => `## ${TITLES[s]}\n${lines[s].join('\n')}`)].join('\n\n');
  const order = ['workingOn', 'recentBugs', 'howWeWork', 'whatWorks', 'whatFails'];
  while (text().length > maxChars) {
    const s = order.find(s => lines[s].length > 2) || SECTIONS.filter(s => lines[s].length).sort((a, b) => lines[b].length - lines[a].length)[0];
    if (!s) break;
    lines[s].pop();
  }
  return SECTIONS.some(s => lines[s].length) ? text() : '';
}
export function profileBlock(store) {
  const text = renderProfile(readProfile(store));
  return text ? `<thinker-profile>\n${text}\n</thinker-profile>` : '';
}

// --- a session, end to end ------------------------------------------------
// Extract a session's observations into the ledger, then compile when due. The caller has parsed the transcript
// and decided the session is done with (the end hook, or the catch-up over quiet sessions).
export async function profileSession(store, events, { session, client, repoHint, ended = true, fromLine = 0, lineCount = 0, accounting = {}, completeFn, have, config, compile = true, now = Date.now() } = {}) {
  const r = await extractObservations(events, { repoHint, ended, accounting: { ...accounting, store, purpose: 'profile-extract', session }, completeFn, have, config });
  const dirs = sessionDirs(events, store.repo);
  const rows = appendObservations(store, r.observations, { session, client, dirs, model: r.model, now });
  if (session) markExtracted(store, session, { line: lineCount, observations: rows.length });
  store.log({ op: 'profile', session, client, exchanges: r.exchanges, observations: rows.length, outcomes: Object.fromEntries(OUTCOMES.map(o => [o, rows.filter(x => x.outcome === o).length]).filter(([, n]) => n)), chars: r.chars, tokens: r.tokens, cost: r.cost, model: r.model || null, fromLine });
  let compiled = null;
  if (compile && compileDue(store, { now })) {
    const c = await compileProfile(store, { now, accounting: { ...accounting, store, purpose: 'profile-compile' }, completeFn, have, config });
    if (c.profile) { compiled = c; store.log({ op: 'profile-compile', observations: c.observations, sessions: c.sessions, entries: Object.fromEntries(SECTIONS.map(s => [s, c.profile.sections[s].length])), tokens: c.tokens, cost: c.cost, model: c.profile.model }); }
  }
  return { observations: rows, exchanges: r.exchanges, tokens: (r.tokens || 0) + (compiled?.tokens || 0), compiled: compiled?.profile || null };
}
