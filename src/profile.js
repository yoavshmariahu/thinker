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
import { sessionState, locked, holdoutRate } from './session-state.js';

export const PROFILE = {
  ledgerDays: 60,       // an observation older than this leaves the window and the file
  firstCompileAt: 1,    // the first compile waits for this many observations (then: whenever anything new was read)
  compileBatch: 200,    // new observations one compile step is shown at most; a longer backlog takes several steps
  minSessions: 2,       // sessions a howWeWork entry needs, unless one observation states it, corrects it outright or was interrupted
  workingOnDays: 21,    // a workstream not seen in this long is no longer current
  compileHours: 24,     // a compile is due at most once a day (the owner's call, 2026-11-08): a profile patched at every session end moved several times a day here
  rebaseDays: 30,
  holdoutRate: 0.5,     // half the sessions, not the notes' 15%: see `profileHoldoutRate`
  holdoutMinObs: 200,   // exchanges a side needs before the holdout says anything: at the pre-profile recurrence of 0.116 an exchange, a halving reads at ~480 a side, and under 200 the interval is noise either way
  priorMax: 200,        // earlier statements the extractor is shown for recurrence, newest first
  holdoutMinSessions: 20, // sessions a side needs before the holdout says anything       // a full compile from nothing, this often, so wording patches have carried a long way is re-derived
  renderChars: 6000,    // about 1500 tokens at chars/4 (the owner's call, 2026-11-08; 800 then 1000 before)
  perSection: { workingOn: 6, howWeWork: 12, skills: 6 },
  textChars: 240,
  retireShown: 15,      // a line judged in this many sessions and found to bear on none leaves the served block (the owner's call, 2026-11-12)
};
// Three sections (2026-11-08, the owner's call, after reading this repository's own profile). `whatFails` went:
// it was the howWeWork rule in negative form, and the compile wrote both, so the top three rules were each paid
// for twice in the served block. A correction now feeds a howWeWork line that says what to do. `recentBugs` went
// too: the agent's own account of a fix, rendered as fact, for a session that rarely meets the symptom again.
// `whatWorks` had gone earlier the same day (one line in four that two sessions supported). `skills` stays (the
// owner's ask): which skills are run in this repository, by whom, and how it went by the person's reactions;
// 22 of 396 sessions in 60 days ran one here, so the section is often empty.
export const SECTIONS = ['workingOn', 'howWeWork', 'skills'];
export const OUTCOMES = ['accepted', 'corrected', 'redirected', 'unknown'];
// What a session did with a line of the profile it was shown. `na` is the honest default: most lines have no
// bearing on most sessions, and counting those as `ignored` would make every line look dead.
export const LINE_VERDICTS = ['followed', 'ignored', 'contradicted', 'na'];

// On by default since 2026-11-08 (the owner's call; the knowledge notes it replaced went the same day): `learn: {
// profile: false }` in .thinker/config.json turns it off for a repository, and THINKER_PROFILE=on|off wins over the
// config, for a harness. The older `learn: { mode: 'profile' }` is still read as on.
export function profileConfig(store) {
  const learn = store.config().learn || {};
  const env = process.env.THINKER_PROFILE;
  const enabled = /^(on|1|true)$/i.test(env || '') ? true : /^(off|0|false)$/i.test(env || '') ? false : learn.profile !== false && learn.sessions !== false;
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
// A skill an exchange ran, and by whom: the agent's `Skill` call, or a `/skill` the person typed (Claude Code records
// it as a command block, which `clean` strips; a prompt that is nothing but the command keeps `/name args` as its
// text). Claude Code's own commands are not skills (`BUILTIN_COMMANDS`; a typed `/clear` makes no exchange, as before).
// Two calls of one skill in one exchange are one use. opencode's call is the same tool in lowercase with the
// skill in `input.name` (checked live in a trace, 2026-11-10). Codex and Cursor sessions carry no skill calls yet.
const BUILTIN_COMMANDS = new Set(['clear', 'compact', 'model', 'login', 'logout', 'doctor', 'effort', 'permissions', 'reload-plugins', 'help', 'config', 'cost', 'status', 'resume', 'exit', 'quit', 'init', 'memory', 'agents', 'mcp', 'plugins', 'hooks', 'terminal-setup', 'vim', 'bug', 'fast', 'context', 'export', 'rewind', 'usage', 'release-notes', 'privacy-settings', 'stats', 'theme', 'add-dir', 'ide', 'install-github-app', 'review', 'upgrade', 'output-style', 'statusline', 'feedback', 'tasks', 'todos', 'branch', 'insights', 'desktop', 'chrome', 'color', 'keybindings', 'sandbox', 'teleport', 'rename', 'copy', 'diff', 'files', 'mobile', 'remote-env', 'session', 'summary', 'btw', 'fork', 'extra-usage', 'voice']);
const COMMAND = /<command-name>\s*\/?([\w.:-]+)\s*<\/command-name>(?:[\s\S]*?<command-args>([\s\S]*?)<\/command-args>)?/;
export const skillName = s => { const n = String(s || '').trim().replace(/^\//, '').toLowerCase().slice(0, 60); return /^[\w.:-]+$/.test(n) ? n : ''; };
function typedSkill(raw) {
  const m = COMMAND.exec(String(raw || '')); if (!m) return null;
  const name = skillName(m[1]); if (!name || BUILTIN_COMMANDS.has(name) || name.startsWith('thinker-')) return null;
  return { name, args: String(m[2] || '').replace(/\s+/g, ' ').trim().slice(0, 200) };
}
const addSkill = (x, k) => { if (!x.skills.some(s => s.name === k.name && s.by === k.by)) x.skills.push(k); };
// The person stopping the agent mid-turn (Esc in Claude Code, which writes "[Request interrupted by user]" as a user
// message, or refuses a tool call; Codex's `turn_aborted`). The parsers emit it as an `interrupt` event
// (transcripts.js); the marker text is matched too, for traces and older parsers. It is the sharpest correction a
// session records -- 216 of them in this checkout's transcripts -- and until 2026-11-08 it arrived as a USER line
// the extractor was told to treat as nobody speaking. It marks the exchange it cut short, never starts one.
const INTERRUPT = /^\[Request interrupted by user( for tool use)?\]$/;
export function exchanges(events) {
  const out = [];
  for (const e of events) {
    const at = Number.isFinite(e.at) && e.at > 0 ? e.at : null;
    if (e.t === 'interrupt' || (e.t === 'prompt' && INTERRUPT.test(String(e.text || '').trim()))) { if (out.length) { out.at(-1).interrupted = true; if (at && !out.at(-1).at) out.at(-1).at = at; } continue; }
    if (e.t === 'prompt') {
      const typed = typedSkill(e.text);
      let text = clean(e.text); if (!text && typed) text = `/${typed.name}${typed.args ? ' ' + typed.args : ''}`;
      if (!text || ASSESSOR_PROMPT.test(text)) continue;
      out.push({ turn: out.length + 1, prompt: text, answers: [], next: null, at, skills: typed ? [{ name: typed.name, by: 'person' }] : [] });
    }
    else if (e.t === 'say' && out.length) { const text = clean(e.text); if (text && !ASSESSOR_SAY.test(text)) out.at(-1).answers.push(text); }
    else if (e.t === 'tool' && /^skill$/i.test(e.name || '') && out.length) { const name = skillName(e.input?.skill ?? e.input?.name); if (name) addSkill(out.at(-1), { name, by: 'agent' }); }
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
    const skills = x.skills?.length ? `\n    SKILLS: ${x.skills.map(s => `/${s.name} (${s.by === 'person' ? 'typed by the person' : 'called by the agent'})`).join(', ')}` : '';
    const stopped = x.interrupted ? '\n    INTERRUPTED: the person stopped the agent here, before it finished' : '';
    return `[${x.turn}] USER: ${cut(x.prompt, Math.min(2500, per / 3))}\n    AGENT: ${cut(answers, per - Math.min(2500, per / 3) - 100) || '(no answer recorded)'}${stopped}${skills}`;
  });
  return parts.join('\n\n');
}

// The directories the session worked in, from the paths of its tool calls alone (never their content), relative
// to the repository whichever checkout of it the session ran in. A path is placed by the git checkout that holds
// it (`checkoutOf`: the nearest parent with a `.git`), and counts only when that checkout is the repository or one
// of its worktrees (`mainCheckout` follows a worktree's `.git` file home). Until 2026-11-08 the path was stripped of
// the store's own path alone, so a session in `.worktrees/<x>` or a scratch directory labelled its rows `/Users`
// or `/private` (219 and 22 of 689 rows here) and 442 rows had nothing; `relatedCited` then matched on `/Users`.
// A relative path is taken as the repository's own. A path in another repository, or outside any, is nobody's.
// A worktree removed since the session ran has no `.git` left, so its paths place under the main checkout as
// `.worktrees/<name>/...` (this repository's own convention, gitignored): that prefix is dropped, since 152 of the
// 291 paths in this checkout's last 40 sessions were in worktrees that no longer exist.
const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
function checkoutOf(dir, cache) {
  if (cache.has(dir)) return cache.get(dir);
  let d = dir, found = null;
  for (;;) { if (fs.existsSync(path.join(d, '.git'))) { found = d; break; } const up = path.dirname(d); if (up === d) break; d = up; }
  cache.set(dir, found);
  return found;
}
export function mainCheckout(top) {
  const g = path.join(top, '.git');
  try {
    if (fs.statSync(g).isDirectory()) return top;
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(g, 'utf8'));
    if (!m) return top;
    const gitdir = path.resolve(top, m[1].trim());
    const main = gitdir.replace(/[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/, '');
    return main === gitdir ? top : main;
  } catch { return top; }
}
export function sessionDirs(events, repo = '') {
  const dirs = new Set(), cache = new Map();
  const home = repo ? real(mainCheckout(checkoutOf(real(repo), cache) || real(repo))) : null;
  const rel = p => {
    p = String(p || '').replace(/^\.\//, '');
    if (!path.isAbsolute(p)) return p;
    const top = checkoutOf(path.dirname(p), cache);
    if (!top) return null;
    if (home && real(mainCheckout(top)) !== home) return null;
    return path.relative(top, p).replace(/^\.worktrees\/[^/]+\//, '');
  };
  for (const e of events) {
    if (e.t !== 'tool') continue;
    const inp = e.input || {};
    const p = inp.file_path || inp.path || inp.notebook_path;
    if (!p || !/\.\w+$/.test(String(p))) continue;
    const r = rel(p); if (!r || r.startsWith('..')) continue;
    const d = areaOf(r); if (d) dirs.add(d);
  }
  return [...dirs].sort();
}

// --- extraction -----------------------------------------------------------
export const EXTRACT_SYSTEM = `You read one session between a person and a coding agent, as the person's prompts and the agent's answers only: no tool calls, no code, no command output. You record what was asked, what the agent says it did, and how the person reacted, as evidence for a profile of this person's work that future sessions read at their start. The profile is only as good as your honesty about outcomes.

Reading an exchange:
- The outcome of exchange [n] is the person's reaction in [n+1]. The agent's own words ("done", "tests pass") never decide it.
  - accepted: the reaction approves the result without reservation, uses it, or asks for the next step of the same work. A reaction that approves one part and changes, drops or objects to another is redirected or corrected, never accepted. A question about the result is unknown unless it objects.
  - corrected: the reaction says the result is wrong, incomplete or not what was asked, or asks to undo or redo it.
  - redirected: the reaction changes the goal or the approach in response to the result, without calling it wrong.
  - unknown: no reaction yet (the last exchange), a next prompt about something else, or a reaction you cannot read. When in doubt, unknown.
- A USER line that is not the person speaking (a tool's report, a system or harness notice, a pasted log or document with no request) is neither a request nor a reaction.
- A SKILLS line names the skills run in the exchange and by whom (typed by the person, or called by the agent). The reaction to that exchange is a reaction to the skill's result too. Where the person speaks of a skill (asks for one by name, says to stop using one), put it in prefs naming the skill.
- An INTERRUPTED line means the person stopped the agent before it finished. That is a reaction in itself: the outcome is never accepted. Read the next prompt for which it is: corrected when it objects, undoes or redoes; redirected when it changes course or supplies what the agent lacked; unknown only when there is no next prompt. An interruption followed by a correction is the clearest lesson a session records: always write the lesson.
- One observation per exchange that did work or made a decision. A question answered, a greeting or a bare command produces none. Exchanges on one task may become one observation: its turn is the first, its outcome the last reaction.

Fields:
- request: what was asked, in the person's words where they are short.
- approach: what the agent says it did, in one or two lines. This is the agent's account, recorded as such.
- reaction: the person's words that decided the outcome, quoted, under 160 characters. Empty for unknown.
- lesson: one line, only from a reaction: after a correction, what should have been done; after an acceptance that followed a correction on the same work, what worked. Never from the agent's account alone. Written as an instruction for next time.
- prefs: how the person says they want work done or answers given ("never push main", "don't ask, just do it", "no headers"), near their words. Stated only, never inferred from behaviour.
- topics: one to four short tags.
- No file contents, no credentials; write a key or token as <token>.
An empty list is the right answer for a session that decided nothing.
Judging the profile the session was shown:
- You may be given the lines of a profile this session was shown at its start, each with an id. For each one, say what the session did with it. This is the measure of whether the profile is worth showing at all, so it is judged on evidence in the text, never on whether the line sounds useful.
  - followed: the agent's work or words show it acted on the line. Quote the shortest thing that shows it.
  - ignored: the line plainly applied to what was being done and the agent did not act on it. Not "the agent did not mention it" -- a line can be followed silently; the evidence must be that the agent did the thing the line told it not to do, or failed to do the thing the line asked for, in work the line clearly covered.
  - contradicted: the agent did the opposite and the person had to correct it. This is the strongest evidence a line is not working.
  - na: the line had no bearing on this session. **This is the default.** Most lines have nothing to do with most sessions, and marking those ignored would make every line look dead. Prefer na whenever you are unsure whether the line applied.
- A line the person restated in their own prompt was not followed from the profile; that is the person doing the profile's job, which is worth knowing. Mark it ignored and quote their prompt.
Recurrence -- the person saying again what they have said before:
- You may be given SAID BEFORE: things this person stated or corrected in earlier sessions, each with an id. Some are lines of the profile; most are single earlier statements. For each observation, repeats lists the ids it says again: a pref that restates one, a lesson or a correction that corrects the same thing, a request that re-asks for the same way of working. The same thing in other words is a repeat; a different thing on the same topic is not.
- This is the profile's own score. The profile exists so that the person never has to say the same thing twice, and every repeat is one time they did. Be exact: a repeat you invent charges the profile with a failure it did not make, and one you miss hides one it did.
- Whether the agent was shown the profile changes nothing here. The question is only whether the person said it again.`;

export const OBSERVATION_SCHEMA = {
  type: 'object',
  properties: {
    // Per-line use of the profile the session was shown (empty when it was shown none): the signal that says
    // whether a line is worth its place in the block at all, before any outcome metric can mean anything.
    lines: {
      type: 'array',
      description: 'one entry per profile line the session was shown, in the order given; omit entirely if no profile was shown',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'the line id exactly as given' },
          verdict: { type: 'string', enum: LINE_VERDICTS },
          evidence: { type: 'string', description: 'for followed, ignored or contradicted: the shortest quote from a prompt or an answer that shows it; empty for na' },
        },
        required: ['id', 'verdict'],
        additionalProperties: false,
      },
    },
    observations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          turn: { type: 'number', description: 'the exchange number the observation starts at' },
          request: { type: 'string' },
          approach: { type: 'string', description: 'what the agent did, as it told it, one or two lines' },
          outcome: { type: 'string', enum: OUTCOMES },
          reaction: { type: 'string', description: 'the follow-up prompt that decided the outcome, quoted short; empty for unknown' },
          lesson: { type: 'string' },
          prefs: { type: 'array', items: { type: 'string' } },
          repeats: { type: 'array', items: { type: 'string' }, description: 'ids from SAID BEFORE that this exchange\'s prefs, lesson or correction repeat: the person said or corrected the same thing again. Empty when nothing here was said before.' },
          topics: { type: 'array', items: { type: 'string' } },
        },
        required: ['turn', 'request', 'approach', 'outcome', 'reaction', 'lesson', 'prefs', 'topics'],
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
    request,
    approach: str(o.approach, 400), outcome: OUTCOMES.includes(o.outcome) ? o.outcome : 'unknown',
    reaction: str(o.reaction, 160), lesson: str(o.lesson), prefs: list(o.prefs), topics: list(o.topics, 4, 40),
    repeats: list(o.repeats, 12, 60),
  };
}

// When an observation happened: the stamp of the exchange it starts at, else the session's last stamp.
export function observationTimes(observations, xs) {
  const byTurn = new Map(xs.map(x => [x.turn, x.at]));
  const last = xs.map(x => x.at).filter(Boolean).at(-1) || null;
  return observations.map(o => { const at = byTurn.get(o.turn) || last; return at ? { ...o, at: new Date(at).toISOString() } : o; });
}

// Which skills ran under an observation, and how many times the person interrupted it: those of its exchange and
// of the exchanges up to the next observation's, since one observation may span several exchanges. Attached by
// code from the SKILLS and INTERRUPTED lines, never by the model; returned in the caller's order, each with `skills`
// (possibly empty) and `interrupts` (a count). Also what `thinker profile backfill` runs over rows read before the
// ledger recorded them.
export function observationSkills(observations, xs) {
  const turns = [...new Set(observations.map(o => Number(o.turn) || 1))].sort((a, b) => a - b);
  return observations.map(o => {
    const from = Number(o.turn) || 1, to = turns.find(t => t > from) ?? Infinity;
    const skills = []; let interrupts = 0;
    for (const x of xs) if (x.turn >= from && x.turn < to) { if (x.interrupted) interrupts++; for (const k of x.skills || []) if (!skills.some(s => s.name === k.name && s.by === k.by)) skills.push({ name: k.name, by: k.by }); }
    return { ...o, skills, interrupts };
  });
}

// One session's observations. `completeFn` is for tests; `have` and `config` pick the model ladder.
export async function extractObservations(events, { repoHint = '', ended = true, shown = [], prior = [], accounting, completeFn, have, config } = {}) {
  const xs = exchanges(events);
  if (!xs.length) return { observations: [], lines: [], exchanges: 0, tokens: null, cost: null, chars: 0 };
  const input = extractionInput(xs);
  // What this person has said before, so the same call can mark what they said again (`repeats`). Against the
  // ledger and not the profile alone: a profile that learned nothing would otherwise score perfectly, since the
  // only repeats it could see would be of lines it holds (survivorship, the owner's point, 2026-11-08).
  const said = prior.length ? `\nSAID BEFORE (${prior.length}; the profile's lines first, then single earlier statements):\n${prior.map(p => `[${p.id}] ${p.text}`).join('\n')}\n` : '';
  // The lines this session was shown, so the same call that reads the session can say what was done with each.
  // One call, not two: the extractor already has the whole session in front of it, and a second call would
  // double what a session costs to read for a signal that rides along for a few hundred tokens.
  const block = shown.length ? `\nTHE PROFILE THIS SESSION WAS SHOWN (${shown.length} lines):\n${shown.map(l => `[${l.id}] ${l.text}`).join('\n')}\n` : '';
  const prompt = `Repository: ${repoHint || '(unknown)'}\n${ended ? 'The session ended after the last exchange.' : 'The session may still be going on after the last exchange.'}\n${said}${block}\nEXCHANGES (${xs.length}):\n\n${input}\n\nReturn the observations JSON${shown.length ? ', with one `lines` entry per profile line above' : ''}${prior.length ? ', each observation\'s `repeats` naming the SAID BEFORE ids it says again' : ''}.`;
  const res = await completeProfile({ system: EXTRACT_SYSTEM, prompt, schema: OBSERVATION_SCHEMA, maxTokens: 6000, thinkingTokens: 0, structuredRetries: 1, timeoutMs: 600_000, accounting }, { have, config, completeFn });
  // a repeat names only an id that was offered, and the row keeps which kind it was: a profile line (the serving
  // failed) or a single earlier statement (the compile never learned it)
  const known = new Map(prior.map(p => [p.id, p]));
  const tag = o => { const ids = (o.repeats || []).filter(id => known.has(id)); return { ...o, repeats: { profile: ids.filter(id => known.get(id).inProfile), ledger: ids.filter(id => !known.get(id).inProfile) } }; };
  const observations = observationSkills(observationTimes((res.json?.observations || []).map(tidyObservation).filter(Boolean).map(tag), xs), xs);
  const ok = new Set(shown.map(l => l.id));
  const seen = new Set();
  // only ids that were actually shown, once each: a verdict on a line this session never saw is not evidence
  const lines = (res.json?.lines || []).filter(l => l && ok.has(l.id) && LINE_VERDICTS.includes(l.verdict) && !seen.has(l.id) && seen.add(l.id))
    .map(l => ({ id: l.id, verdict: l.verdict, evidence: String(l.evidence || '').slice(0, 300) }));
  return { observations, lines, exchanges: xs.length, tokens: tokensOf(res), cost: res.cost ?? null, chars: input.length, model: res.model };
}

// --- ledger ---------------------------------------------------------------
export const profileDir = store => path.join(store.localDir, 'profile');
const ledgerFile = store => path.join(profileDir(store), 'ledger.jsonl');
const profileFile = store => path.join(profileDir(store), 'profile.json');
const linesFile = store => path.join(profileDir(store), 'lines.jsonl');
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
// --- what this person has said before --------------------------------------
// The reference for recurrence (`repeats` on an observation): the profile's lines and, behind them, every distinct
// preference and lesson in the ledger that another session recorded. The ledger and not the profile alone, because
// the profile is what survived the compile's floors, caps and trim -- a profile that learned nothing would be
// repeated against nothing and score perfectly. Newest first, deduped on the words, capped at `priorMax` so the
// block stays a few thousand tokens; a session's own earlier rows are left out (the same session saying a thing
// twice is one session, not a recurrence across sessions).
const norm = t => String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
export function priorStatements(store, { session = null, profile = null, rows = null, max = PROFILE.priorMax, now = Date.now() } = {}) {
  const out = [], seen = new Set();
  const add = (id, text, inProfile) => { const k = norm(text); if (!k || k.length < 12 || seen.has(k)) return; seen.add(k); out.push({ id, text: String(text).slice(0, PROFILE.textChars), inProfile }); };
  const prof = profile || readProfile(store);
  // the entry's own words, not the rendered line: the count and dates on a line would keep the same words from matching
  for (const e of (prof?.sections?.howWeWork || [])) if (e.id) add(e.id, e.text, true);
  const ledger = (rows || readLedger(store, { now })).filter(r => !session || r.session !== session).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  for (const r of ledger) {
    if (out.length >= max) break;
    (r.prefs || []).forEach((t, i) => add(`${r.id}#p${i}`, t, false));
    if (r.lesson) add(`${r.id}#l`, r.lesson, false);
  }
  return out.slice(0, max);
}
// The recurrences in a set of ledger rows: how often the person said again what they had said before, per
// exchange, and of those how many were of a line the profile held (`served`: the agent had it and the person
// still had to say it) against a statement the profile never learned (`unlearned`). An observation with a
// repeat of both kinds counts once, as served. Rows from before `repeats` was extracted carry none and are
// counted as exchanges with no recurrence, which understates the rate for them: `measured` says how many
// rows could say.
export function recurrence(rows) {
  const measured = rows.filter(r => r.repeats && typeof r.repeats === 'object');
  const n = measured.length;
  const served = measured.filter(r => r.repeats.profile?.length).length;
  const unlearned = measured.filter(r => !r.repeats.profile?.length && r.repeats.ledger?.length).length;
  const any = served + unlearned;
  return { exchanges: n, measured: n, recurrences: any, served, unlearned, rate: n ? any / n : null, servedRate: n ? served / n : null, unlearnedRate: n ? unlearned / n : null };
}

// --- what a session did with the lines it was shown ----------------------
// The first question about a line is not whether it improved anything, it is whether the agent used it. A note
// was assessed that way from the start (`confirmed` / `unused` / `contradicted` per serving) and the profile had
// nothing of the kind for its first two days: a block of ten lines went into every prompt of every shown session
// and no record said whether one of them was ever read. The holdout cannot answer it either -- its measure is one
// number for the whole block, over 235 sessions, where this is one row per line per session: on a block of ten
// lines, a week of sessions here is hundreds of rows against the holdout's forty.
// Kept beside the ledger, same window, never committed.
export function readLineVerdicts(store, { days = PROFILE.ledgerDays, now = Date.now() } = {}) {
  let lines = []; try { lines = fs.readFileSync(linesFile(store), 'utf8').split('\n'); } catch { return []; }
  const out = [];
  for (const l of lines) { if (!l) continue; try { const o = JSON.parse(l); if (o?.id && o.session && Number.isFinite(Date.parse(o.at)) && dayOf(o.at, now) <= days) out.push(o); } catch {} }
  return out;
}
// One row per (session, line). A session read again replaces its own rows, as the ledger does, so re-reading a
// transcript never counts a verdict twice.
export function appendLineVerdicts(store, verdicts, { session, client, model, at, now = Date.now() } = {}) {
  if (!verdicts?.length || !session) return [];
  const when = at || new Date(now).toISOString();
  const rows = verdicts.map(v => ({ id: v.id, session, client: client || null, model: model || null, at: when, verdict: v.verdict, evidence: v.evidence || '' }));
  const kept = readLineVerdicts(store, { now }).filter(r => r.session !== session);
  writeAtomic(linesFile(store), [...kept, ...rows].map(r => JSON.stringify(r)).join('\n') + '\n');
  return rows;
}
// Per line: the sessions that were shown it, and what they did with it. `applied` is the sessions where the line
// had any bearing at all (anything but `na`) -- the denominator that matters, since a line's chance to be followed
// only comes up in a session its subject arises in. `followRate` is followed over applied, null where nothing
// applied, because 0 of 0 is not a failing line, it is an untested one.
export function lineReport(store, { days = PROFILE.ledgerDays, now = Date.now(), profile = null } = {}) {
  const rows = readLineVerdicts(store, { days, now });
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.id)) by.set(r.id, { id: r.id, shown: 0, followed: 0, ignored: 0, contradicted: 0, na: 0, evidence: [] });
    const e = by.get(r.id);
    e.shown++; e[r.verdict] = (e[r.verdict] || 0) + 1;
    if (r.verdict !== 'na' && r.evidence) e.evidence.push({ verdict: r.verdict, text: r.evidence, session: r.session });
  }
  const text = new Map();
  const prof = profile || readProfile(store);
  for (const sec of SECTIONS) for (const e of (prof?.sections?.[sec] || [])) if (e.id) text.set(e.id, { section: sec, text: line(sec, e), retired: e.retired || null });
  const out = [...by.values()].map(e => {
    const applied = e.followed + e.ignored + e.contradicted;
    const meta = text.get(e.id) || {};
    // retired: out of the served block, by the compile's mark or because the rule holds now (`retireDue`)
    return { ...e, applied, followRate: applied ? e.followed / applied : null, gone: !text.has(e.id), ...meta, retired: !!meta.retired || retireDue({ shown: e.shown, applied }) };
  });
  // worst first: a line that was shown often, applied, and not followed is the one to cut or reword
  out.sort((a, b) => (a.followRate ?? 2) - (b.followRate ?? 2) || b.applied - a.applied);
  const applied = out.reduce((a, e) => a + e.applied, 0), followed = out.reduce((a, e) => a + e.followed, 0);
  return { lines: out, sessions: new Set(rows.map(r => r.session)).size, verdicts: rows.length, applied, followed, followRate: applied ? followed / applied : null };
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
// The ledger written whole, in the rows' order (`thinker profile backfill`).
export function writeLedger(store, rows) { writeAtomic(ledgerFile(store), rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')); }
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
- howWeWork (12): how this person wants work done and answers given: process, communication, the bar for evidence, and what to do where agents went wrong here before. Each line is one rule in the imperative, saying what to do, not what failed ("Verify in the live app before calling it done", never "avoid shipping with mock tests"). Corrections weigh most: an exchange the person corrected, redirected or interrupted is the evidence a line rests on first, then a stated preference (prefs). The code ranks the section by the corrections cited behind each line and the render trims from the bottom, so cite every correction a line answers. A stated preference and a correction of the same thing are one line. Preferences that say one thing in different words become one line, near their words; where the person's own words are short and sharp, keep them. Where the instruction files already say it (their headings are listed) and agents still got it wrong, keep the line and say so ("in AGENTS.md; still missed"); where the files say it and nobody had to enforce it, leave it out. Specific to this person: a line that could be written about any repository is not a profile line.
- skills (6): one line per skill run in this repository (a skills line on an observation, or a pref naming it): what it is used for here, how it has gone by the person's reactions, and what the person has said about it. skill = the name as given, without the slash. The use counts below are computed and shown beside the line; write what they do not say. Never a skill no observation ran or named.

Rules:
- Every entry cites the observation ids it rests on (obs): up to 10, the most telling, newest first. An entry you cannot cite does not exist. Counts and dates are computed from the citations; do not write them into the text.
- approach is the agent's own account. An observation with outcome unknown can support workingOn and skills, and howWeWork through its prefs alone. An interrupted observation (the person stopped the agent) is a correction whatever its outcome says.
- Fill a section to its cap when the observations support that many lines; the code drops a line with too little evidence, so there is no need to ration. An empty patch is the right answer for observations that change nothing.
- A RETIRED list names lines that were shown to many sessions and bore on none: the code took them out of the served block. Never add a line that says what a retired one says, in any words; an update rewords a retired line but leaves it retired; a drop removes it for good.
- Lines are plain and under 200 characters. No narrative of sessions, no praise, no "the agent", no file contents, no secrets.`;

const entry = (props, required) => ({ type: 'array', items: { type: 'object', properties: { ...props, obs: { type: 'array', items: { type: 'string' } } }, required: [...required, 'obs'] } });
const FIELDS = { workingOn: ['text'], howWeWork: ['text'], skills: ['text'] };
export const PATCH_SCHEMA = {
  type: 'object',
  properties: {
    keep: { type: 'array', items: { type: 'string' } },
    update: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, obs: { type: 'array', items: { type: 'string' }, description: 'observation ids to add behind the entry' } }, required: ['id', 'obs'] } },
    drop: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id', 'reason'] } },
    add: {
      type: 'object',
      properties: {
        workingOn: entry({ text: { type: 'string' } }, ['text']),
        howWeWork: entry({ text: { type: 'string' } }, ['text']),
        skills: entry({ skill: { type: 'string', description: 'the skill\'s name, without the slash' }, text: { type: 'string' } }, ['skill', 'text']),
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
export function ledgerText(rows, { correctionsFirst = false } = {}) {
  const sorted = [...rows].sort((a, b) => (correctionsFirst ? isCorrection(b) - isCorrection(a) : 0) || Date.parse(b.at) - Date.parse(a.at));
  return sorted.map(r => {
    const head = `${r.id} | ${String(r.at).slice(0, 10)} | outcome=${r.outcome}${r.interrupts ? ` | interrupted by the person${r.interrupts > 1 ? ` x${r.interrupts}` : ''}` : ''}${r.dirs?.length ? ` | dirs=${r.dirs.slice(0, 4).join(',')}` : ''}`;
    const lines = [`  request: ${r.request}`, r.approach && `  approach: ${r.approach}`, r.reaction && `  reaction: "${r.reaction}"`, r.lesson && `  lesson: ${r.lesson}`, r.prefs?.length && `  prefs: ${r.prefs.join(' | ')}`, r.skills?.length && `  skills: ${r.skills.map(k => `/${k.name} (${k.by})`).join(', ')}`, r.topics?.length && `  topics: ${r.topics.join(', ')}`].filter(Boolean);
    return [head, ...lines].join('\n');
  }).join('\n\n');
}

// Per skill, over the window: the sessions and observations it ran in, how many the person typed, and the outcomes.
// Shown to the compile as evidence beside the observations, and read by `thinker profile show --why`.
export function skillTally(rows) {
  const by = new Map();
  for (const r of rows) for (const k of r.skills || []) {
    if (!by.has(k.name)) by.set(k.name, { skill: k.name, sessions: new Set(), observations: 0, typed: 0, outcomes: {} });
    const t = by.get(k.name); t.sessions.add(r.session || r.id); t.observations++; if (k.by === 'person') t.typed++; t.outcomes[r.outcome] = (t.outcomes[r.outcome] || 0) + 1;
  }
  return [...by.values()].map(t => ({ ...t, sessions: t.sessions.size })).sort((a, b) => b.sessions - a.sessions || b.observations - a.observations);
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
export const skillTallyText = rows => skillTally(rows).map(t => `- /${t.skill}: ${plural(t.sessions, 'session')}, ${plural(t.observations, 'observation')}${t.typed ? ` (${t.typed} typed by the person)` : ''}; ${Object.entries(t.outcomes).map(([k, n]) => `${k} ${n}`).join(', ')}`).join('\n');

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
// A how-we-work line needs two sessions, unless one observation states the preference outright (prefs), corrects
// it in so many words (a correction with its reaction), or was interrupted by the person.
//
// **Ids are stable** (2026-11-12): an entry keeps the id it came in with, and a new one takes the next number for
// its section from the counters the profile carries (`ids`; `idCounters` derives them for a profile from before).
// Until then ids were the rank (`h1` was the top line), so a line's verdicts (`lines.jsonl`, keyed on the id) were
// about whichever line held that rank when each session ran, and nothing per line could be trusted across compiles.
//
// **Corrections weigh most** (the owner's call, 2026-11-12): a how-we-work line ranks by the corrections cited
// behind it (`isCorrection`: the person corrected, redirected or interrupted the exchange, the Factory's own
// correction-loop rule), then by sessions, then by recency. The section's cap and the render's trim both take from
// the bottom, so a line that answers no correction is the first to go.
//
// **A retired entry stays, out of the block**: `retired` (a date) is carried through, the entry is not counted
// against the section's live cap and comes last, so the compile keeps seeing it and does not add it again.
const PREFIX = { workingOn: 'w', howWeWork: 'h', skills: 's' };
export const isCorrection = o => !!o && (o.interrupts > 0 || o.outcome === 'corrected' || o.outcome === 'redirected');
export function idCounters(profile) {
  const out = { w: 0, h: 0, s: 0 };
  for (const s of SECTIONS) for (const e of profile?.sections?.[s] || []) { const m = /^([whs])(\d+)$/.exec(e?.id || ''); if (m) out[m[1]] = Math.max(out[m[1]], Number(m[2])); }
  return out;
}
export function settle(sections, rows, { now = Date.now(), ids = null } = {}) {
  const next = ids || idCounters({ sections });
  const byId = new Map(rows.map(r => [r.id, r]));
  const out = {};
  const taken = new Set();
  for (const s of SECTIONS) {
    const items = [];
    for (const raw of Array.isArray(sections?.[s]) ? sections[s] : []) {
      if (!raw || typeof raw !== 'object') continue;
      const cited = [...new Set((Array.isArray(raw.obs) ? raw.obs : []).map(String))].filter(id => byId.has(id));
      if (!cited.length) continue;
      const obs = cited.map(id => byId.get(id));
      const ats = obs.map(o => Date.parse(o.at)).sort((a, b) => a - b);
      const e = { obs: cited, count: new Set(obs.map(o => o.session || o.id)).size, firstSeen: new Date(ats[0]).toISOString().slice(0, 10), lastSeen: new Date(ats.at(-1)).toISOString().slice(0, 10), corrections: obs.filter(isCorrection).length };
      if (raw.retired) e.retired = String(raw.retired).slice(0, 10);
      if (s === 'skills') {
        // the line rests on the observations that ran the skill or named it (a pref, the request, the reaction); its
        // counts are measured from those, never written by the model
        e.skill = skillName(raw.skill); e.text = str(raw.text); if (!e.skill || !e.text) continue;
        const ran = obs.filter(o => (o.skills || []).some(k => k.name === e.skill));
        const names = o => [...(o.prefs || []), o.request, o.reaction].some(t => String(t || '').toLowerCase().includes(e.skill));
        const named = obs.filter(o => !ran.includes(o) && names(o));
        if (!ran.length && !named.length) continue;
        e.count = new Set([...ran, ...named].map(o => o.session || o.id)).size;
        e.used = ran.length; e.accepted = ran.filter(o => o.outcome === 'accepted').length; e.corrected = ran.filter(o => o.outcome === 'corrected' || o.outcome === 'redirected').length;
        if (e.count < PROFILE.minSessions && !named.length) continue;
      }
      else { e.text = str(raw.text); if (!e.text) continue; }
      const age = (now - ats.at(-1)) / 86400_000;
      if (s === 'howWeWork' && e.count < PROFILE.minSessions && !obs.some(o => o.prefs?.length || o.interrupts > 0 || (['corrected', 'redirected'].includes(o.outcome) && o.reaction))) continue;
      if (s === 'workingOn' && age > PROFILE.workingOnDays) continue;
      // the entry's own id where it is this section's and not yet used here; else the next number
      const own = typeof raw.id === 'string' && raw.id.startsWith(PREFIX[s]) && /^[whs]\d+$/.test(raw.id) && !taken.has(raw.id) ? raw.id : null;
      e.id = own || `${PREFIX[s]}${++next[PREFIX[s]]}`; taken.add(e.id);
      items.push(e);
    }
    const rank = s === 'howWeWork' ? (a, b) => b.corrections - a.corrections || b.count - a.count || b.lastSeen.localeCompare(a.lastSeen)
      : s === 'skills' ? (a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen)
      : (a, b) => b.lastSeen.localeCompare(a.lastSeen) || b.count - a.count;
    const live = items.filter(e => !e.retired).sort(rank).slice(0, PROFILE.perSection[s]);
    const retired = items.filter(e => e.retired).sort(rank).slice(0, PROFILE.perSection[s]);
    out[s] = [...live, ...retired].map(({ id, ...e }) => ({ id, ...e }));
  }
  return out;
}

// The code retires what the sessions never used (the owner's call, 2026-11-12). A line shown to `retireShown`
// sessions and judged `na` in every one bore on nothing in fifteen tries and was costing its characters in every
// prompt for nothing; it leaves the served block and stays on the profile marked `retired`, so the compile sees it
// and does not add it again, and `thinker profile lines` still says what became of it. One predicate, two doors:
// `profileBlock` applies it live, so a line goes on the day its fifteenth verdict lands, and the compile writes it.
export const retireDue = stat => !!stat && stat.shown >= PROFILE.retireShown && !stat.applied;
export function retire(profile, report, { now = Date.now() } = {}) {
  if (!profile?.sections || !report?.lines?.length) return profile;
  const due = new Set(report.lines.filter(retireDue).map(l => l.id));
  if (!due.size) return profile;
  const when = dateOf(now);
  return { ...profile, sections: Object.fromEntries(SECTIONS.map(s => [s, (profile.sections[s] || []).map(e => e?.id && due.has(e.id) && !e.retired ? { ...e, retired: when } : e)])) };
}

export function readProfile(store) { return readJson(profileFile(store)); }
// A compile is due when something was read into the ledger since the last one and the last one is at least
// `compileHours` old; the first comes once `firstCompileAt` observations exist. It was once per session from
// 2026-11-08 morning to that evening: at this repository's pace (sessions in parallel across worktrees) the profile
// moved several times a day and a workstream line could say one thing at noon and its opposite by three. Once a day
// is the owner's call: the ledger still takes every session as it ends, the profile follows a day behind.
// `thinker profile compile` and `rebuild` compile by hand whenever asked.
export function compileDue(store, { now = Date.now() } = {}) {
  const rows = readLedger(store, { now });
  const p = readProfile(store);
  if (!p) return rows.length >= PROFILE.firstCompileAt;
  const since = Date.parse(p.compiledAt || 0);
  if (now - since < PROFILE.compileHours * 3600_000) return false;
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
  // what the sessions since have said of each line: a line due for retirement is marked before the model sees it
  if (previous) previous = retire(previous, lineReport(store, { now, profile: previous }), { now });
  const ids = { ...(previous?.ids || idCounters(previous)) };
  const cited = relatedCited(previous, batch, rows);
  // the observations that ran a skill, so a skills line can cite them: few (18 of 116 sessions here), and otherwise
  // out of the step's sight once they are past the batch
  const seen = new Set([...batch, ...cited].map(r => r.id));
  const ranSkill = rows.filter(r => r.skills?.length && !seen.has(r.id)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 40);
  const headings = instructionHeadings(store.repo);
  const span = a => a.length ? `${dateOf(Math.min(...a.map(r => Date.parse(r.at))))} to ${dateOf(Math.max(...a.map(r => Date.parse(r.at))))}` : '';
  const shown = previous ? Object.fromEntries(SECTIONS.map(s => [s, (previous.sections?.[s] || []).filter(e => !e.retired).map(({ id, skill, text, count, corrections, firstSeen, lastSeen, obs }) => ({ id, ...(skill ? { skill } : {}), text, sessions: count, ...(corrections ? { corrections } : {}), firstSeen, lastSeen, obs }))])) : null;
  const retired = previous ? SECTIONS.flatMap(s => (previous.sections?.[s] || []).filter(e => e.retired).map(e => `[${e.id}] ${line(s, e)} (retired ${e.retired})`)) : [];
  const tally = skillTallyText(rows);
  const corrections = batch.filter(isCorrection).length;
  const input = [
    `Repository: ${path.basename(store.repo)}\nToday: ${dateOf(now)}`,
    `INSTRUCTION FILE HEADINGS (do not repeat what these cover):\n${headings.map(h => '- ' + h).join('\n') || '(none)'}`,
    `PROFILE SO FAR (compiled ${previous?.compiledAt?.slice(0, 10) || 'never'}):\n${shown ? JSON.stringify(shown) : '(none: every entry is an add)'}`,
    retired.length ? `RETIRED (${retired.length}; shown to ${PROFILE.retireShown} or more sessions and bore on none, out of the served block):\n${retired.join('\n')}` : null,
    cited.length ? `OBSERVATIONS BEHIND THE ENTRIES THESE MIGHT TOUCH (${cited.length}):\n\n${ledgerText(cited)}` : null,
    tally ? `SKILL USE IN THE WINDOW (computed over every observation; cite the observations, not this list):\n${tally}` : null,
    ranSkill.length ? `OTHER OBSERVATIONS THAT RAN A SKILL (${ranSkill.length}):\n\n${ledgerText(ranSkill)}` : null,
    `NEW OBSERVATIONS (${batch.length}, from ${new Set(batch.map(r => r.session)).size} sessions, ${span(batch)}; the ${corrections} the person corrected, redirected or interrupted first, then the rest, newest first):\n\n${ledgerText(batch, { correctionsFirst: true })}`,
    'Return the patch JSON.',
  ].filter(Boolean).join('\n\n');
  const res = await completeProfile({ system: COMPILE_SYSTEM, prompt: input, schema: PATCH_SCHEMA, maxTokens: 16000, thinkingTokens: 0, structuredRetries: 2, timeoutMs: 600_000, accounting }, { have, config, completeFn });
  const patch = res.json || {};
  const sections = settle(applyPatch(previous, patch), rows, { now, ids });
  const ats = rows.map(r => Date.parse(r.at));
  const profile = { version: 4, compiledAt: new Date(now).toISOString(), model: res.model || null, window: { days: PROFILE.ledgerDays, observations: rows.length, sessions: new Set(rows.map(r => r.session).filter(Boolean)).size, from: dateOf(Math.min(...ats)), to: dateOf(Math.max(...ats)) }, ids, sections };
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
    // counts only, never the text: the step's size, what the patch did and what it cost (`thinker usage` sums these)
    store.log({ op: 'profile-compile', observations: rows.length, pending: batch.length, full: !previous, sessions, changes: r.changes, entries: Object.fromEntries(SECTIONS.map(s => [s, current.sections[s].length])), tokens: r.tokens, cost: r.cost, model: current.model });
  }
  // the window is the file: observations past it go with the compile
  writeAtomic(ledgerFile(store), rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  return { profile: current, tokens, cost: cost || null, observations: rows.length, pending: pending.length, steps: batches.length, sessions, changes, full: !previous };
}

// --- render ---------------------------------------------------------------
// The served line is the text and nothing else (the owner's call, 2026-11-08): the counts, the dates and the
// skills' outcome tallies were a fifth of the block and told the agent nothing it could act on. They are
// `thinker profile show --why`'s, with the evidence.
const TITLES = { workingOn: 'Working on', howWeWork: 'How this person works', skills: 'Skills' };
const line = (s, e) => s === 'skills' ? `- /${e.skill}: ${e.text}` : `- ${e.text}`;
// The block a session is shown, within renderChars. When it does not fit, the oldest workstreams go first (down to
// three), then the least-used skills (to three), then the weakest ways of working (to four), then whatever section
// is longest: the ways of working are the last thing to go.
const TRIM = [['workingOn', 3], ['skills', 3], ['howWeWork', 4]];
// What a session is actually shown: the text, and **the ids of the entries that survived the trim**. The ids are
// what makes the block measurable per line (`lines.jsonl`, `assessLines`): a line trimmed out of a session's block
// was never shown there and must not be judged on it. One function does the fitting so the text and the ids can
// never disagree; `renderProfile` is the text alone, which is what every older caller wants.
export function fitProfile(profile, { maxChars = PROFILE.renderChars } = {}) {
  if (!profile?.sections) return { text: '', ids: [] };
  const kept = Object.fromEntries(SECTIONS.map(s => [s, (profile.sections[s] || []).filter(e => e && !e.retired)]));
  const w = profile.window || {};
  const head = `About the person here, from ${plural(w.sessions || 0, 'session')} in this repository. Follow how they work; the rest is context.`;
  const text = () => [head, ...SECTIONS.filter(s => kept[s].length).map(s => `## ${TITLES[s]}\n${kept[s].map(e => line(s, e)).join('\n')}`)].join('\n\n');
  while (text().length > maxChars) {
    const s = TRIM.find(([s, floor]) => kept[s].length > floor)?.[0] || SECTIONS.filter(s => kept[s].length).sort((a, b) => kept[b].length - kept[a].length)[0];
    if (!s) break;
    kept[s].pop();
  }
  if (!SECTIONS.some(s => kept[s].length)) return { text: '', ids: [] };
  return { text: text(), ids: SECTIONS.flatMap(s => kept[s].map(e => e.id).filter(Boolean)) };
}
export function renderProfile(profile, opts = {}) { return fitProfile(profile, opts).text; }
export function profileBlock(store) {
  // the retire rule applied live: a line whose fifteenth `na` landed since the last compile is out today
  const profile = readProfile(store);
  const { text, ids } = fitProfile(profile ? retire(profile, lineReport(store, { profile })) : null);
  return { text: text ? `<thinker-profile>\n${text}\n</thinker-profile>` : '', ids };
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
// to work and the holdout is there to catch a regression; that is where this should go when it ships. The four
// cells, for a 30% change at 95%/80%: 1251 sessions as a count at 85/15, 638 as a count at 50/50, 256 as a
// proportion at 85/15, 131 as a proportion at 50/50.
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
  const { text, ids } = profileBlock(store);
  if (!text) return '';
  return locked(store, session, () => {
    const { st, save } = sessionState(store, session);
    const p = st.profile || { arm: profileArm(store, session), told: 0, compactions: 0, offset: 0 };
    let since = { count: 0, offset: p.offset || 0 };
    if (transcript && client === 'claude') { since = compactionsSince(transcript, p.offset || 0); p.compactions = (p.compactions || 0) + since.count; p.offset = since.offset; }
    const due = !p.told || p.compactions > p.toldAt;
    if (due && p.arm === 'shown') { p.told = (p.told || 0) + 1; p.toldAt = p.compactions; p.shown = [...new Set([...(p.shown || []), ...ids])]; }
    const log = due && (p.arm === 'shown' || !p.told) && !p.loggedHoldout;
    if (due && p.arm === 'holdout') p.loggedHoldout = true;
    st.profile = p; save();
    if (log) store.log({ op: 'profile-served', session, client, arm: p.arm, chars: p.arm === 'shown' ? text.length : 0, lines: p.arm === 'shown' ? ids.length : 0, afterCompaction: p.compactions > 0 && p.told > 1 ? true : undefined, at: new Date(now).toISOString() });
    return due && p.arm === 'shown' ? text : '';
  });
}
// The entry ids a session was actually shown, across its injections (a compaction can bring a changed block back).
// Neither this nor `profileArmOf` may ask `store.exists()`: that tests the **notes** directory, which the profile
// does not use, so in a profile-only checkout both would answer nothing while the state file sat there with the
// answer in it -- and `profileArmOf` answering null is every observation saved with no arm and a holdout that
// measures nothing. Reading a session's own state file needs no notes.
export function shownLines(store, session) {
  if (!session || session === 'unknown') return [];
  return sessionState(store, session).st.profile?.shown || [];
}
export function profileArmOf(store, session) {
  if (!session || session === 'unknown') return null;
  return sessionState(store, session).st.profile?.arm || null;
}
// The two arms over the ledger. **The measure is cost per exchange** (2026-11-08, the owner's call): the goal is
// to spend fewer tokens, so the metric is the tokens a unit of delivered work costs, and nothing stands in for it.
// An exchange is one prompt and the answers to it, which is the smallest unit of work the person asked for; a
// session's tokens divided by its exchanges takes the length of a session out of the comparison, which is most of
// the variance (cv 0.97 against 1.96 for a session's tokens on this machine's 111 measured sessions).
//
// Three rules it is built on, each from a measurement:
//  - **A ratio of sums, never a mean of ratios** (the Report's own rule). On this repository the ratio of sums is
//    $15.11 an exchange and the mean of the per-session ratios is $13.93: the mean weighs a cheap three-exchange
//    session like a 40-exchange one.
//  - **Stratified by model, pooled by exchanges.** The models in play differ threefold an exchange (Astra $5.99,
//    Opus 5 $18.35, Fable $19.95), so an arm that happened to draw more Astra sessions would read as a saving. A
//    within-model ratio weighted by each stratum's exchanges removes that, and it cut the bootstrap standard error
//    from 11.3% to 9.6% on the same sessions, which is a third off the sessions needed.
//  - **The interval is bootstrapped, not assumed.** A ratio of two sums has no closed-form standard error worth
//    trusting on 111 skewed sessions, so `ratioInterval` resamples sessions within each stratum.
//
// Corrections stay on the report as a diagnostic (`rate`), never as the headline: they are a proxy for cost, the
// metric here is cost, and `redirected` conflates a bad result with the person moving on to the next thing.
export function holdoutReport(rows, { sessions = new Map(), boots = 2000, seed = 1 } = {}) {
  const arms = { shown: [], holdout: [], unknown: [] };
  for (const r of rows) (arms[r.arm === 'shown' || r.arm === 'holdout' ? r.arm : 'unknown']).push(r);
  const bad = r => r.outcome === 'corrected' || r.outcome === 'redirected';
  const side = a => {
    const seen = new Set(a.map(r => r.session));
    const n = a.length;
    const share = o => n ? a.filter(r => r.outcome === o).length / n : null;
    // one entry per session that both the ledger counted exchanges for and the log priced
    const units = [...seen].map(id => ({ id, exchanges: a.filter(r => r.session === id).length, ...(sessions.get(id) || {}) })).filter(u => u.tokens > 0);
    return { sessions: seen.size, observations: n, perSession: seen.size ? n / seen.size : null, rate: n ? a.filter(bad).length / n : null, corrected: share('corrected'), redirected: share('redirected'), accepted: share('accepted'), priced: units.length, ...perExchange(units), interval: ratioInterval(units, { boots, seed }) };
  };
  const shown = { ...side(arms.shown), recurrence: recurrence(arms.shown) }, holdout = { ...side(arms.holdout), recurrence: recurrence(arms.holdout) };
  const unknown = { ...side(arms.unknown), recurrence: recurrence(arms.unknown) };
  // The lead is recurrence (2026-11-08, the owner's call): the profile exists so the person never has to say the
  // same thing twice, and `servedRate` is how often they did with the agent holding the line. `unlearnedRate` is
  // the same across arms by construction, since the agent saw the statement in neither; a gap there is the
  // extractor's, not the profile's. Cost per exchange stays as the second figure (`cost`).
  return { shown, holdout, unknown, recurrence: compareRates(shown.recurrence, holdout.recurrence), cost: compare(shown, holdout, { boots, seed }) };
}
// Two proportions over exchanges, shown less held out, with a 95% interval: negative is the profile working.
export function compareRates(a, b, { key = 'servedRate', n = 'measured', min = PROFILE.holdoutMinObs } = {}) {
  const enough = a[n] >= min && b[n] >= min;
  if (a[key] == null || b[key] == null) return { delta: null, ci: null, relative: null, enough: false, verdict: 'too-early' };
  const delta = a[key] - b[key];
  const v = (p, k) => k ? p * (1 - p) / k : 0;
  const se = Math.sqrt(v(a[key], a[n]) + v(b[key], b[n]));
  const ci = [delta - 1.96 * se, delta + 1.96 * se];
  const verdict = !enough ? 'too-early' : ci[1] < 0 ? 'fewer' : ci[0] > 0 ? 'more' : 'inconclusive';
  return { delta, ci, relative: b[key] ? delta / b[key] : null, enough, verdict, unlearned: { shown: a.unlearnedRate, holdout: b.unlearnedRate } };
}
// Tokens (and dollars, where every stratum is priced) an exchange costs: a ratio of sums inside each model, the
// strata pooled by their exchanges. `units` is one object a session: {exchanges, tokens, cost, model}.
export function perExchange(units) {
  if (!units.length) return { tokens: null, cost: null, exchanges: 0, strata: 0 };
  const by = new Map();
  for (const u of units) { const k = u.model || '?'; if (!by.has(k)) by.set(k, []); by.get(k).push(u); }
  let ex = 0, tok = 0, dol = 0, priced = true;
  for (const [, us] of by) {
    const e = us.reduce((a, u) => a + u.exchanges, 0);
    if (!e) continue;
    ex += e; tok += us.reduce((a, u) => a + u.tokens, 0);
    if (us.some(u => !(u.cost > 0))) priced = false; else dol += us.reduce((a, u) => a + u.cost, 0);
  }
  return { tokens: ex ? tok / ex : null, cost: ex && priced ? dol / ex : null, exchanges: ex, strata: by.size };
}
// The bootstrap: resample sessions within each stratum, so the interval carries the skew the sessions actually have.
export function ratioInterval(units, { boots = 2000, seed = 1, key = 'tokens' } = {}) {
  if (units.length < 2) return null;
  const by = new Map();
  for (const u of units) { const k = u.model || '?'; if (!by.has(k)) by.set(k, []); by.get(k).push(u); }
  let st = seed >>> 0 || 1;
  const rnd = () => { st ^= st << 13; st ^= st >>> 17; st ^= st << 5; st >>>= 0; return st / 0x100000000; };
  const out = [];
  for (let b = 0; b < boots; b++) {
    const draw = [];
    for (const [, us] of by) for (let i = 0; i < us.length; i++) draw.push(us[Math.floor(rnd() * us.length)]);
    const r = perExchange(draw)[key];
    if (r != null) out.push(r);
  }
  if (out.length < 2) return null;
  const mu = out.reduce((a, x) => a + x, 0) / out.length;
  const sd = Math.sqrt(out.reduce((a, x) => a + (x - mu) ** 2, 0) / out.length);
  return { se: sd, n: out.length };
}
// Shown against held out on cost per exchange. `delta` is shown less held out -- **negative is the profile paying
// for itself** -- with a 95% interval from the two sides' bootstrapped standard errors. `verdict` is what the
// interval supports and never a p-value dressed as a decision: `cheaper` (the whole interval is below zero),
// `costlier` (all above), `inconclusive` (it straddles), `too-early` (a side has too few priced sessions).
// Judged in tokens, because that is the goal and because a mixed-model arm has no honest single price; the dollar
// figure rides along where every stratum of both arms is priced.
export function compare(shown, holdout, { boots = 2000, seed = 1 } = {}) {
  const enough = shown.priced >= PROFILE.holdoutMinSessions && holdout.priced >= PROFILE.holdoutMinSessions;
  if (shown.tokens == null || holdout.tokens == null) return { delta: null, ci: null, relative: null, enough: false, verdict: 'too-early', corrections: null };
  const delta = shown.tokens - holdout.tokens;
  const a = shown.interval?.se ?? null, b = holdout.interval?.se ?? null;
  const se = a != null && b != null ? Math.sqrt(a * a + b * b) : null;
  const ci = se == null ? null : [delta - 1.96 * se, delta + 1.96 * se];
  const verdict = !enough || !ci ? 'too-early' : ci[1] < 0 ? 'cheaper' : ci[0] > 0 ? 'costlier' : 'inconclusive';
  // the proxy, kept beside the measure so a cost result can be read against it, never instead of it
  const corrections = shown.rate == null || holdout.rate == null ? null : shown.rate - holdout.rate;
  return { delta, ci, relative: holdout.tokens ? delta / holdout.tokens : null, enough, verdict, corrections };
}

// --- a session, end to end ------------------------------------------------
// Extract a session's observations into the ledger, then compile when due. The caller has parsed the transcript
// and decided the session is done with (the end hook, or the catch-up over quiet sessions).
export async function profileSession(store, events, { session, client, repoHint, ended = true, fromLine = 0, lineCount = 0, accounting = {}, completeFn, have, config, compile = true, now = Date.now() } = {}) {
  // the lines this session was shown, with the text it saw, so the same call can say what was done with each
  const prof = readProfile(store);
  const seen = new Set(shownLines(store, session));
  const shown = seen.size && prof?.sections
    ? SECTIONS.flatMap(sec => (prof.sections[sec] || []).filter(e => e.id && seen.has(e.id)).map(e => ({ id: e.id, text: line(sec, e) })))
    : [];
  const prior = priorStatements(store, { session, profile: prof, now });
  const r = await extractObservations(events, { repoHint, ended, shown, prior, accounting: { ...accounting, store, purpose: 'profile-extract', session }, completeFn, have, config });
  const dirs = sessionDirs(events, store.repo);
  const arm = profileArmOf(store, session);
  const rows = appendObservations(store, r.observations.map(o => arm ? { ...o, arm } : o), { session, client, dirs, model: r.model, now });
  const verdicts = appendLineVerdicts(store, r.lines, { session, client, model: r.model, now });
  if (session) markExtracted(store, session, { line: lineCount, observations: rows.length });
  const rec = recurrence(rows);
  store.log({ op: 'profile', session, client, exchanges: r.exchanges, observations: rows.length, repeats: rec.recurrences || undefined, repeatsServed: rec.served || undefined, repeatsUnlearned: rec.unlearned || undefined, lines: verdicts.length || undefined, followed: verdicts.filter(v => v.verdict === 'followed').length || undefined, ignored: verdicts.filter(v => v.verdict === 'ignored').length || undefined, contradicted: verdicts.filter(v => v.verdict === 'contradicted').length || undefined, outcomes: Object.fromEntries(OUTCOMES.map(o => [o, rows.filter(x => x.outcome === o).length]).filter(([, n]) => n)), chars: r.chars, tokens: r.tokens, cost: r.cost, model: r.model || null, fromLine });
  let compiled = null;
  if (compile && compileDue(store, { now })) {
    const c = await compileProfile(store, { now, accounting: { ...accounting, store, purpose: 'profile-compile' }, completeFn, have, config });
    if (c.profile) compiled = c;
  }
  return { observations: rows, lines: verdicts, exchanges: r.exchanges, tokens: (r.tokens || 0) + (compiled?.tokens || 0), compiled: compiled?.profile || null };
}
