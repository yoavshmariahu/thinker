// The delegation trigger: a tool call handed to a subagent on a cheaper model, deterministically, from the
// PreToolUse hook (2026-11-11, the owner's call; the two hook rules that forbade it went in #750).
//
// What it is for. A read the main model makes stays in its context for the rest of the session: written
// into its cache once at the main model's rate and read back on every later call. The stage-delegation bench
// of 2026-11-10/11 (43 paired runs, Opus inline against an Opus lead with Sonnet subagents) measured that
// handing a turn's exploration to a Sonnet explorer once its reads pass about 35k tokens saves 11-50% on
// such sessions and, replayed over this machine's 30 days, projects to about 4.6% of spend; that a nudge the
// model may ignore is not a trigger; and that the edits should stay with the main model (a builder subagent
// re-reads and re-reasons what the lead already holds). So the hook denies the read, and the denial's words
// are what the model reads instead of the file. A whole-suite test run goes the same way to a verifier that
// reports the summary line verbatim.
//
// WHO RUNS THE SUBAGENT (2026-11-12, the owner's call: "delegation is not supposed to happen this way. we
// need to use native subagents in every harness"). The **host's own** subagent machinery runs it. The rule
// below is thinker's and the execution is the host's: the hook denies the call and the denial tells the model
// to call its own subagent tool, by name, with a brief thinker has already written (`handoff` mode). What a
// PreToolUse-style door can do is deny with a reason, and nothing more -- it cannot invoke the host's
// subagent itself -- so the words are the mechanism, and `denial()` is the one copy of them.
//
// Why not a subagent of thinker's own. Until today the hook spawned `claude -p` itself (`runSubagent`,
// kept below as a named fallback, off by default). That is a second billing path and a second credential
// requirement, invisible to the host and to its transcript, and simply dead where no `claude` CLI and no
// Anthropic key exist -- a vendor's cloud OpenCode harness running the vendor's own models, which is the
// case this has to work in. A handoff has none of those: the work is billed, shown and recorded by the host
// like any other subagent, and on Claude Code thinker already prices a subagent conversation at its own
// model in the Report (`tool-outputs.js:sessionUsage`), so the measure gets better rather than worse.
//
// What it is not. It never intercepts a small read (the main model reads the lines it edits), never runs
// anything on a held-out session (the live measure is those sessions against the others), and never spends
// more than one subagent run per file per turn (a repeat read gets the cached report). It is on by default
// (2026-11-16, a quarter of the sessions held out): THINKER_DELEGATE=off or `delegate: false` in the machine config
// turns it off, and the hook's entry is
// only written into the agent's settings while it is on (connect/rewire read the same switch), since a hook that
// exits at once is still one node process per tool call.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readMachineConfig } from './repo-switch.js';
import { heldOut } from './proxy.js';
import { findBin, BINS } from './llm.js';
import { sessionState, locked } from './session-state.js';
import { claudeCardActive } from './claude-card.js';
import { traceFile } from './transcripts.js';
import { shellRead } from './shell-read.js';
import { keepPatterns, keepMatcher, namedIn } from './keep.js';
import { isWorkerLaunch } from './session-llm.js';
export { shellRead };

// the mark the mod leaves for each session it decides reads in (<THINKER_HOME>/state/claude-delegate/<session>)
export const DELEGATE_SESSION_MARK = 'claude-delegate';

export const DELEGATE_DEFAULTS = Object.freeze({
  enabled: true,      // on (the owner's call, 2026-11-16; off from 2026-11-12 until then): THINKER_DELEGATE=off or `delegate: false` switches it off
  handoff: true,      // the host's own subagent does the work; the denial names it (the only path, 2026-11-12)
  fallback: false,    // thinker's own `claude -p` subagent where the host has none. Off: it is a second billing
                      // path, a second credential and invisible to the host. `delegate: { fallback: true }` asks for it.
  model: 'claude-haiku-5-5', // the model thinker pins the host's agent definition to where the host lets it
  threshold: 8000,    // a read of this many tokens or more is delegated, and nothing else is: a smaller read is the
                      // lines the main model edits. The whole rule since 2026-11-17 (the owner's call); until then
                      // it was a tally of the turn's reads against 35000 with a per-read floor of 8000 (`minRead`).
                      // A Haiku explorer costs under a cent, so a read of 8k pays for it on the cache write alone
  holdout: 0.25,      // share of sessions left alone, by hash of the session id (proxy.js:heldOut); 0.5 until 2026-11-16
  families: true,     // on a host whose models come from a gateway, the explorer is the lead's own family's cheap
                      // model (EXPLORER_FAMILIES); `delegate: { families: false }` keeps it on the session's model
  handoffsPerTurn: 5, // reads handed over per turn (the owner's call, 2026-11-15; 1 until then). A file is handed
                      // over once a turn and a suite run once a turn whatever this says (see `decide`)
  timeoutMs: 240_000, // a fallback subagent run past this is abandoned and the read allowed
  agentHooks: [],     // Claude Code's agent hooks (`agentHookEntries`): the mechanism without a rule to fire it
  subagentModel: null, // the model the lead's own subagents start on when the lead names none (`subagentCall`,
                      // SUBAGENT_TYPES): `delegate: { subagentModel: 'sonnet' }`. Off until the owner's call. An alias,
                      // because Claude Code's Agent tool refuses a full id (live on 2.1.329, 2026-11-19)
  reportLines: 25,
});
// tokens per character of a tool result, measured on 265 real results (proxy.js:RESULT_TOKENS_PER_CHAR)
export const TOKENS_PER_CHAR = 0.445;
// Claude Code's Read tool prefixes every line with its number and a tab
const READ_LINE_OVERHEAD = 7;

const OFF = /^(off|false|0|no)$/i, ON = /^(on|true|1|yes)$/i;
export function delegateConfig({ env = process.env, home } = {}) {
  let cfg = {};
  try { cfg = readMachineConfig(home).delegate; } catch {}
  if (cfg === false) cfg = { enabled: false };
  if (!cfg || typeof cfg !== 'object') cfg = {};
  const o = { ...DELEGATE_DEFAULTS, ...cfg };
  const raw = env.THINKER_DELEGATE;
  if (raw !== undefined && raw !== '') {
    if (OFF.test(raw)) o.enabled = false;
    else if (ON.test(raw)) o.enabled = true;
    else { o.enabled = true; o.model = raw.trim(); }
  }
  if (env.THINKER_DELEGATE_THRESHOLD) o.threshold = Number(env.THINKER_DELEGATE_THRESHOLD) || o.threshold;
  if (env.THINKER_DELEGATE_HOLDOUT !== undefined) o.holdout = OFF.test(env.THINKER_DELEGATE_HOLDOUT) ? 0 : Number(env.THINKER_DELEGATE_HOLDOUT);
  if (env.THINKER_DELEGATE_HANDOFF !== undefined && env.THINKER_DELEGATE_HANDOFF !== '') o.handoff = !OFF.test(env.THINKER_DELEGATE_HANDOFF);
  if (env.THINKER_DELEGATE_FALLBACK !== undefined && env.THINKER_DELEGATE_FALLBACK !== '') o.fallback = !OFF.test(env.THINKER_DELEGATE_FALLBACK);
  return o;
}

// ---- what a tool call would read ----
// A Read of a file, or a shell line whose work is to print a file (cat, sed -n, head with a large count),
// with nothing after it that would shrink the output. Anything piped into grep, head, tail, wc or awk is
// the model trimming for itself, and is left alone. A line range (`sed -n 10,60p`, `head -n 40`) is sized
// by the lines it asks for, as a ranged Read is: it is the model reading the lines it edits, and the denial
// sends it there, so it may not be the thing that fires.
function fileStats(file, cwd) {
  const p = path.isAbsolute(file) ? file : path.join(cwd || process.cwd(), file);
  try { const st = fs.statSync(p); if (!st.isFile()) return null; return { path: p, bytes: st.size }; } catch { return null; }
}
function linesOf(p) { try { return fs.readFileSync(p, 'utf8').split('\n').length; } catch { return 0; } }

/**
 * What this tool call would put into the context: { tokens, files }, or null when it is not a read. `readCap` is
 * the most characters the host's Read returns in one call (OpenCode truncates at about 58k and tells the model to
 * continue at an offset, so a whole file there is several reads; `fileTokens` carries the file's size to the rule).
 */
export function readOf(toolName, input = {}, cwd, { readCap = 0 } = {}) {
  if (toolName === 'Read') {
    const st = input.file_path && fileStats(input.file_path, cwd);
    if (!st) return null;
    let bytes = st.bytes, n;
    if (input.limit || input.offset) {
      const lines = linesOf(st.path) || 1;
      n = Math.max(0, Math.min(Number(input.limit) || lines, lines - (Number(input.offset) || 0)));
      bytes = Math.round(st.bytes * n / lines);
    } else n = Math.max(1, Math.round(bytes / 40));
    const fileTokens = Math.round((bytes + n * READ_LINE_OVERHEAD) * TOKENS_PER_CHAR);
    if (readCap && bytes > readCap) { n = Math.round(n * readCap / bytes); bytes = readCap; }
    // `fileTokens` is what the read asks for; `tokens` what the host returns in this call (the rest follows)
    return { tokens: Math.round((bytes + n * READ_LINE_OVERHEAD) * TOKENS_PER_CHAR), fileTokens, files: [st.path] };
  }
  if (toolName === 'Bash') {
    const r = shellRead(input.command);
    if (!r) return null;
    const files = r.files.map(f => fileStats(f, cwd)).filter(Boolean);
    if (!files.length) return null;
    let bytes = files.reduce((a, f) => a + f.bytes, 0);
    if (r.lines) bytes = Math.min(bytes, r.lines * 40);
    return { tokens: Math.round(bytes * TOKENS_PER_CHAR), files: files.map(f => f.path) };
  }
  return null;
}

// A whole-suite run: the test program with no path of its own. A single file's run is the main model
// checking the lines it edited and stays with it.
const SUITE = [
  /^(?:\S*\/)?(?:python3?|\.venv\/bin\/python3?)\s+-m\s+pytest(?:\s+-[a-zA-Z]+|\s+--?[\w-]+(?:=\S+)?)*\s*$/,
  /^(?:\S*\/)?pytest(?:\s+-[a-zA-Z]+|\s+--?[\w-]+(?:=\S+)?)*\s*$/,
  /^(?:npm|pnpm|yarn)\s+(?:run\s+)?test(?::\w+)?(?:\s+--?[\w-]+)*\s*$/,
  /^go\s+test\s+(?:\.\/\.\.\.|\.\.\.)(?:\s+-\S+)*\s*$/,
  /^cargo\s+test(?:\s+--?[\w-]+)*\s*$/,
  /^node\s+--test(?:\s+--?[\w-]+)*\s*$/,
];
// A pipe into tail, head, grep or wc only hides the suite's output; the whole suite still runs (the first live
// e2e, 2026-11-12: Opus ran `pytest -q 2>&1 | tail -5` and the verifier never fired). The verifier gets the bare
// command and does the trimming itself in its report.
const TRIM_TAIL = /(?:\s+2>&1)?(?:\s*\|\s*(?:tail|head|grep|wc|cat)\b(?:"[^"]*"|'[^']*'|[^|"'])*)*\s*$/;
export function suiteCommand(toolName, input = {}) {
  if (toolName !== 'Bash') return null;
  const cmd = String(input.command || '').trim();
  const bare = cmd.replace(TRIM_TAIL, '').trim();
  if (/\|/.test(bare)) return null;
  const parts = bare.split(/\s*(?:&&|;)\s*/);
  const head = parts[0].startsWith('cd ') && parts.length === 2 ? parts[1] : parts[0];
  return parts.length <= 2 && SUITE.some(r => r.test(head)) ? bare : null;
}

// ---- the rule, and the turn's handoffs, kept on the session's state file ----
// The rule is one comparison: a read of `threshold` tokens or more fires, and no other read does. Nothing is
// added up across a turn. `prompt` is Claude Code's prompt_id, a new value for every prompt of the person's,
// so the handoff budget and the cached reports belong to one turn. The decision is made whether or not the
// session is held out, so a held-out session logs the same would-have-fired rows.
// `spent` is the handoff guard, and it is what keeps a handoff from ever becoming a loop. Once the turn's
// exploration has been handed to the host's subagent, that subagent reads the files itself -- in the same
// turn, and on some hosts in a child session with an id of its own -- and those reads must go through. A
// turn hands over at most `handoffsPerTurn` reads (5), after which every read is allowed; the suite run has a
// budget of its own, of one. Counted only for a real handoff, so a held-out session never spends it.
// Five and not one since 2026-11-15: over 30 days of this machine's sessions the budget of one turned away
// 42.5M read tokens, 4.5 times what the rule delegated, and the loop it stood guard over is closed by
// `fromSubagent` before this is ever asked. What one did that five must still do is let the model through when
// it insists: a file already handed over this turn is never denied twice (`handed`), or a lead that wants the
// file itself would be refused it five times running.
// `handed` says which of the two let the read through, because the two are not the same event and were logged
// as one `after: 'handoff'` row until 2026-11-19: this very file has a report of its own, which is the lead
// reading it anyway (and then nothing was kept out -- report-savings.js drops the saving on it), against the
// turn's budget being spent on other files, which says nothing about this read at all.
export function decide(st, { prompt, read, suite, cfg = DELEGATE_DEFAULTS, handoff = false }) {
  const d = st.delegate && st.delegate.prompt === prompt ? st.delegate : { prompt, reports: {}, handoffs: {} };
  if (!d.handoffs) d.handoffs = {};
  st.delegate = d;
  const spentOn = kind => handoff && (d.handoffs[kind] || 0) >= (kind === 'explore' ? cfg.handoffsPerTurn ?? 5 : 1);
  const handedOver = key => Boolean(handoff && d.handed && d.handed[key]);
  if (suite) {
    const key = 'suite:' + suite, handed = handedOver(key);
    const spent = spentOn('verify') || handed;
    return { fire: !spent, spent, handed, kind: 'verify', key, tokens: 0 };
  }
  if (!read || !read.tokens) return { fire: false };
  const key = read.files.join('\n');
  // `fileTokens` is the read on a host that returns a big file in chunks (OpenCode): the first chunk is sized
  // by the file asked for, since the model would read the rest anyway. Elsewhere it equals `tokens`.
  const over = Math.max(read.tokens, read.fileTokens || 0) >= cfg.threshold;
  const handed = over && handedOver(key);
  const spent = over && (spentOn('explore') || handed);
  return { fire: over && !spent, spent, handed, kind: 'explore', key, tokens: read.tokens };
}
/** Record that this turn's `kind` has been handed to the host's subagent. Runs under the session's lock. */
export function noteHandoff(st, prompt, kind, key) {
  const d = st.delegate && st.delegate.prompt === prompt ? st.delegate : (st.delegate = { prompt, reports: {}, handoffs: {} });
  if (!d.handoffs) d.handoffs = {};
  d.handoffs[kind] = (d.handoffs[kind] || 0) + 1;
  if (key) { if (!d.handed) d.handed = {}; d.handed[key] = true; }
}

/**
 * The session's real handoffs, kept in its state for the end of the turn: delegated.js reads them against the
 * transcript (what the read would have cost in every later call, whether the lead read the file anyway, which
 * subagent did the reading), as rereads.js does for the clearing's cuts. The log row is the record; this is the
 * copy the Stop hook can reach without reading the machine's log. Capped, since a state file is read on every hook.
 */
export function noteFiring(st, f) {
  if (!f || !(f.tokens > 0)) return;
  if (!Array.isArray(st.delegated)) st.delegated = [];
  st.delegated.push(f);
  if (st.delegated.length > 200) st.delegated = st.delegated.slice(-200);
}

// ---- the subagent ----
export const EXPLORER_PROMPT = `You explore a codebase for a lead engineer who will not read the files. Answer exactly the question in the brief. Report in at most {N} lines: each relevant function, class or section as \`path:line\` with one line on what it does and how it connects, and the exact lines to change if the brief asks. Quote at most 5 lines of code in total. Never paste a file or a long excerpt. Use the shell only for read-only commands. Never edit a file, never run tests.`;
export const VERIFIER_PROMPT = `You verify work for a lead engineer. Run exactly the command in the brief, once. Report in at most 15 lines: first the final summary line exactly as the test runner printed it, copied verbatim; then for each failing test its name, the assertion message and the file:line it points at, and one line on the likely cause. If nothing ran (a collection or import error), say so in the first line. Never paste full output. Never edit a file.`;

// `rules` puts the kind's standing instructions into the brief itself. The fallback subagent gets them as a
// system prompt (`runSubagent`), but a handoff goes to an agent of the host's whose system prompt thinker does
// not own -- Claude Code's built-in `general-purpose`, say -- so there the brief has to carry them. One copy of
// each prompt either way.
export function explorerBrief({ files, prompt, lastSay, cwd, lines = DELEGATE_DEFAULTS.reportLines, rules = false }) {
  const list = files.map(f => path.relative(cwd || '', f) || f).join(', ');
  return [
    rules ? EXPLORER_PROMPT.replace('{N}', String(lines)) + '\n' : '',
    `Working directory: ${cwd}.`,
    `The lead engineer was about to read ${list} while working on this request from the user:`,
    '---', String(prompt || '').slice(0, 2000), '---',
    lastSay ? `The lead's last words before reaching for the file: "${String(lastSay).slice(0, 600)}"` : '',
    `Read ${list} (and whatever it points to that the request needs) and report what the lead needs from it for this request: the relevant definitions as path:line, what each does, how they connect, and the exact lines to change if the request is a change. At most ${lines} lines, at most 5 quoted lines of code.`,
  ].filter(Boolean).join('\n');
}
export function verifierBrief({ command, cwd, rules = false }) {
  return (rules ? VERIFIER_PROMPT + '\n\n' : '')
    + `Working directory: ${cwd}.\nRun exactly this command once, from that directory: \`${command}\`\nReport the final summary line verbatim first, then the failing tests as briefed.`;
}

const READ_ONLY_BASH = ['cat', 'sed', 'head', 'tail', 'grep', 'rg', 'ls', 'find', 'wc', 'git log', 'git show', 'git diff', 'git blame', 'git grep', 'tree', 'file', 'stat'].map(c => `Bash(${c}:*)`);
/** Run the subagent through the claude CLI; resolves to { report, usage, cost, ms, sessionId, model } or { error }. */
export function runSubagent({ kind, brief, cwd, cfg = DELEGATE_DEFAULTS, env = process.env, bin }) {
  const tools = kind === 'explore' ? ['Read', 'Grep', 'Glob', ...READ_ONLY_BASH] : ['Bash', 'Read', 'Grep', 'Glob'];
  const args = ['-p', brief, '--model', cfg.model, '--output-format', 'json', '--no-session-persistence', '--setting-sources', '',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands',
    '--append-system-prompt', (kind === 'explore' ? EXPLORER_PROMPT : VERIFIER_PROMPT).replace('{N}', String(cfg.reportLines)),
    '--allowedTools', ...tools, '--disallowedTools', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task', 'WebFetch', 'WebSearch'];
  const command = bin || env.THINKER_DELEGATE_BIN || findBin(BINS.claude) || 'claude';
  const t0 = Date.now();
  return new Promise(resolve => {
    let out = '', err = '', done = false;
    const finish = r => { if (!done) { done = true; resolve({ ...r, ms: Date.now() - t0 }); } };
    let child;
    try {
      child = spawn(command, args, { cwd, env: { ...env, THINKER_IN_LLM: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return finish({ error: `spawn: ${e.message}` }); }
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} finish({ error: 'timeout' }); }, cfg.timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); finish({ error: `spawn: ${e.message}` }); });
    child.on('close', code => {
      clearTimeout(timer);
      let j = null; try { j = JSON.parse(out); } catch {}
      if (!j || typeof j.result !== 'string' || !j.result.trim()) return finish({ error: `exit ${code}: ${(err || out).trim().slice(0, 300)}` });
      finish({ report: j.result.trim(), usage: j.usage, cost: j.total_cost_usd, sessionId: j.session_id, model: j.model || cfg.model });
    });
  });
}

// ---- what the model reads instead of the result ----
//
// The one copy of the words, for every host and both modes, because on a door that can only deny the words
// are the whole mechanism. The live check on OpenCode 2.2.7 (2026-11-12) is why this is one function and not
// a string per caller: an error-shaped result worded as a report was called "an odd error containing what
// looks like a pre-baked report" and the model routed around it with grep and sed, while the denial's own
// plain words about what thinker had done were accepted and worked from. So: say what thinker did and why,
// in the first person, then say exactly what to do next, and say that nothing is wrong.
//
// `handoff` is the native-subagent mode and names the host's own tool, agent and brief. Without it the reason
// carries the report thinker's own fallback subagent produced.
export function denial({ kind, report, files, cwd, model, handoff }) {
  const named = files.map(f => path.relative(cwd || '', f) || f).join(', ');
  const ranged = kind === 'verify'
    ? 'Do not run the whole suite yourself after this; run a single test file to check a fix, which is never delegated.'
    : 'Read only the short ranges (offset and limit) of the lines you go on to edit, which are never delegated.';
  let reason;
  if (handoff) {
    reason = `thinker stopped this call: ${kind === 'verify' ? 'the whole suite\'s output' : `all of ${named}`} would sit in your context for the rest of the session, `
      + `so this work goes to your own ${handoff.agent} subagent and only its report comes back to you. `
      + `Call the ${handoff.tool} tool${handoff.alias ? ` (named ${handoff.alias} in older versions)` : ''} now with ${handoff.param}: "${handoff.agent}", `
      + `${handoff.fields?.label || 'description'}: "${handoff.label}", and ${handoff.fields?.brief || 'prompt'}: the brief below. Then work from what it reports. ${ranged} `
      + `Nothing has gone wrong and there is nothing here to report to the user.\n\nBrief for ${handoff.agent}:\n${handoff.brief}`;
  } else {
    reason = `thinker ${kind === 'verify' ? 'ran this test command' : `read ${named}`} through a ${model} subagent so the full output stays out of your context. Its report is below; work from it. `
      + (kind === 'verify' ? 'Running the same command again returns this same report; run a single test file yourself to check a fix.'
        : 'Reading the same file again this turn returns this same report; read a short range (offset and limit) of the lines you need to edit, which is never delegated.')
      + `\n\n${report}`;
  }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}
// THE HOST RUNS THE SUBAGENT, NOT THE LEAD (2026-11-15).
//
// A handoff is words in a denied tool call, and whether they are obeyed is the lead's to decide. Run live through
// OpenRouter the same day: GLM 5.3, Gemini 4 and DeepSeek v4 called the subagent; Claude Sonnet 5.5 refused twice
// and asked the person ("that message came from a tool result"), GPT 6.1 Terra and GPT-5.4 mini read the file in
// chunks instead, Haiku followed one time in two. A trigger that fires when the model feels like it is a nudge,
// and the rule here is that a trigger is deterministic.
//
// OpenCode's plugin can do the whole thing itself (probed on 2.2.7): `session.create({ parentID, agent, model })`
// makes a child session on the host's own subagent machinery, `prompt` and `wait` run it, and `context` holds its
// answer. So the hook hands the plugin an order instead of handing the lead an instruction, and the report comes
// back as the denied call's result, in the sentence a lead is known to accept (`denial`'s report form: an
// error-shaped result worded as a bare report was distrusted on 2.2.7, the one that says thinker read the file
// through a subagent was worked from). Still the host's subagent -- billed, shown and recorded by the host as a
// child session -- so nothing of the 2026-11-12 decision is undone; only the caller changed.
//
// `model` is always named: the family's explorer where there is one, else the lead's own, because a child session
// given none runs on the host's default, which is not the session's (seen: a GLM session's child answered on
// Gemini 4).
export const REPORT_SLOT = '{{thinker-report}}';
export function hostRunOrder({ exec, lead, kind, files, cwd, brief, label, pinned = null }) {
  const [providerID, ...rest] = exec.model ? exec.model.split('/') : [];
  const model = exec.model ? { providerID, id: rest.join('/') } : lead?.id ? { providerID: lead.providerID, id: lead.id } : null;
  // `pinned`: the model the host's agent definition is held to (Claude Code's Explore.md), named in the sentence
  // though the host is not told it -- its Agent tool takes a family alias and refuses a full id
  const named = model ? model.id.split('/').pop() : pinned || exec.agent;
  const wrap = JSON.parse(denial({ kind, report: REPORT_SLOT, files, cwd, model: named })).hookSpecificOutput.permissionDecisionReason;
  return { agent: exec.agent, model, title: label, prompt: brief, wrap, kind };
}

/** The short label the host's subagent tool wants beside the brief ("A short 3-5 word label", OpenCode). */
export function handoffLabel(kind, files = [], cwd) {
  if (kind === 'verify') return 'Run the test suite';
  const names = files.map(f => path.basename(f));
  if (!names.length) return 'Explore the codebase';
  return `Read ${names.slice(0, 2).join(' and ')}${names.length > 2 ? ` and ${names.length - 2} more` : ''}`.slice(0, 60);
}

// CLAUDE CODE RUNS THE SUBAGENT TOO: THE AGENT HOOK (2026-11-15, the owner's call).
//
// Claude Code has no plugin that can start a child session, but it has a hook that is one: a PreToolUse handler
// of `type: "agent"` makes the harness spawn a subagent of its own on every matched call, and when that
// subagent answers `ok: false` its `reason` is the denied call's result. So the lead has no say, nothing is
// spawned by thinker, and the run is on the host's login -- what `hostRunOrder` is for OpenCode.
// Run live on 2.1.325 with the entry below: a Read of a 600-line file was answered by the Haiku subagent in
// 12 s for $0.005, the lead worked from the report, and its ranged read went through in 3 s. The harness puts
// "PreToolUse:<tool> hook error: Agent hook condition was not met:" in front of the reason whatever it says, so
// the words after it are again the mechanism: a bare report was distrusted and the lead read the file again
// through the shell, one that opened by saying thinker read the file through a subagent was worked from.
// The subagent has to be told it is the one that sentence names (Haiku, not told, wrote that no subagent had
// read the file), and it lets a ranged Read through itself, since the pattern cannot see a range: one model
// call for every matched read, ranged or not.
//
// What it cannot do: the entry is static settings, matched on the tool's name (`matcher`) and one
// permission-rule pattern (`if`, e.g. `Read(*.py)`; seen to filter live), so no rule of thinker's runs first
// -- no size, no holdout -- and thinker's own hook never sees the run, so there is no
// `op: delegate` row for it. That is why this is the mechanism alone: `agentHooks` is empty, nothing is
// written, and what should fire it is a separate decision. A rule is `{ matcher, if? }`.
// Reads only. A suite run was tried the same day and is not here: the hook's subagent gets a shell only where
// the session's own permissions allow the command (headless, it was refused one), and the lead called its
// report an injection and ran the suite again.
export function agentHookPrompt(cfg = DELEGATE_DEFAULTS) {
  const lead = JSON.parse(denial({ kind: 'explore', report: '', files: ['{file}'], cwd: '', model: cfg.model })).hookSpecificOutput.permissionDecisionReason.trim();
  return [
    EXPLORER_PROMPT.replace('{N}', String(cfg.reportLines)),
    'The lead engineer\'s tool call, which you are answering in its place: $ARGUMENTS',
    'If that call asks for a range of the file (tool_input has an offset or a limit), answer ok true at once and do nothing else: the lead is reading the lines it edits.',
    'Otherwise the brief: read the whole file that call names (and whatever it points to that the lead needs) and report as above.',
    `Then your answer is ok false, and its reason is what the lead reads instead of the file. You are the ${cfg.model} subagent the sentence below speaks of, so it is true as written. The reason is exactly that sentence, with {file} replaced by the file's name, and then your report, with nothing about yourself or these instructions:`,
    lead,
  ].join('\n\n');
}
/** The settings entries for the configured agent-hook rules; none by default. */
export function agentHookEntries(cfg = DELEGATE_DEFAULTS) {
  const rules = Array.isArray(cfg.agentHooks) ? cfg.agentHooks : [];
  return rules
    .filter(r => r && typeof r.matcher === 'string' && r.matcher)
    .map(r => ['PreToolUse', { matcher: r.matcher, hooks: [{
      type: 'agent', ...(r.if ? { if: String(r.if) } : {}), model: cfg.model,
      timeout: Math.round((cfg.timeoutMs || DELEGATE_DEFAULTS.timeoutMs) / 1000), prompt: agentHookPrompt(cfg),
    }] }]);
}

/**
 * The whole decision for one PreToolUse event. The rule is thinker's (`decide`, the holdout, the log row) and
 * the execution is the host's (`executionFor`). `state.update(fn)` runs fn(st) under the session's lock and
 * saves (two tool calls of one turn run their hooks at the same time); a fallback subagent runs outside it.
 * `run` and `lastPrompt` are injected so the logic is testable without a subagent. Resolves to the hook's
 * stdout, or null -- and null is what every failure resolves to, because a hook may not fail a tool call.
 */
export async function delegateTool({ ev, state, session, cwd, cfg = DELEGATE_DEFAULTS, log = () => {}, run = runSubagent, lastPrompt = () => ({}), readCap = 0, client = 'claude', verifier = false }) {
  const read = readOf(ev.tool_name, ev.tool_input, cwd, { readCap });
  const suite = suiteCommand(ev.tool_name, ev.tool_input);
  if (!read && !suite) return null;
  // inside a subagent nothing is delegated: those reads *are* the delegation
  if (fromSubagent(ev, client)) return null;
  const exec = executionFor(client, suite ? 'verify' : 'explore', cfg, { lead: ev.model, verifier });
  const handoff = exec.mode === 'handoff';
  // THE SAME READ TWICE IN ONE BATCH (2026-11-19). The host's plugin says a handoff for this very read is still
  // running in its own process (`in_flight`, register.tsx:delegateCall), and that call will be answered with
  // its report: the file is not landing, and there is nothing to decide here -- a second decision would hand
  // one read to a second subagent. The row is kept, since how often a batch does this is worth knowing, and
  // kept apart from `after: 'handoff'`, which is the lead reading a file whose report it already has.
  if (ev.in_flight) {
    log({
      op: 'delegate', session, client, kind: suite ? 'verify' : 'explore', tool: ev.tool_name,
      files: (read ? read.files : [suite]).map(f => path.relative(cwd || '', f) || f),
      tokens: read ? read.tokens : 0, mode: exec.mode, fired: false, after: 'in-flight',
    });
    return null;
  }
  // the model the host's agent is held to by its definition: Explore.md, and the suite run's own agent where it is installed
  const pinnedTo = HOSTS[client]?.subagent?.pins && (suite ? exec.pinned : true) ? cfg.model : null;
  let d, cached, prompt;
  state.update(st => { prompt = ev.prompt_id || st.turnNo || 0; d = decide(st, { prompt, read, suite, cfg, handoff }); cached = d.fire && !handoff ? st.delegate.reports[d.key] : undefined; });
  // A read the rule declined still leaves a row, because without one "the hook never ran" and "the hook
  // ran and the read was under the threshold" are the same silence -- and on 2026-11-14 a whole
  // PostHog pair could not be read for exactly that reason: 31 reads, no denial, no row, no way to tell
  // which. Only a sized read is logged (`d.tokens` is a number), so an ordinary shell call stays quiet
  // and a session's rows number its reads, not its tool calls. `tokens` against `threshold` is then
  // the answer to "how close did this read come".
  if (!d.fire && !d.spent) {
    if (typeof d.tokens === 'number') log({
      op: 'delegate', session, client, kind: d.kind, tool: ev.tool_name,
      files: (read ? read.files : []).map(f => path.relative(cwd || '', f) || f),
      tokens: d.tokens, threshold: cfg.threshold,
      mode: exec.mode, fired: false, declined: 'below-threshold',
    });
    return null;
  }
  // A kept file is read by the model itself, whatever its size (keep.js): the person's notes (`*.md`), what the
  // profile learned they point at, a file they named in the prompt this turn answers. A report of such a file
  // is the harm the keep list exists for -- the model working from a summary of the one file it was told to
  // read. Decided before the holdout, so both sides read it alike and the row says why nothing fired.
  let ctx = null;
  if (d.kind === 'explore' && d.fire) {
    const match = keepMatcher(cfg.keepPatterns || keepPatterns());
    let why = read.files.some(match) ? 'pattern' : null;
    if (!why) { ctx = lastPrompt() || {}; if (read.files.some(namedIn([ctx.prompt || '']))) why = 'named'; }
    if (why) {
      log({ op: 'delegate', session, client, kind: d.kind, tool: ev.tool_name, files: read.files.map(f => path.relative(cwd || '', f) || f), tokens: d.tokens, threshold: cfg.threshold, mode: exec.mode, fired: false, declined: 'kept', kept: why });
      return null;
    }
  }
  const held = heldOut(session, cfg.holdout);
  const files = read ? read.files : [];
  const row = { op: 'delegate', session, client, kind: d.kind, tool: ev.tool_name, files: (read ? read.files : [suite]).map(f => path.relative(cwd || '', f) || f), tokens: d.tokens, held, mode: exec.mode };
  if (held) { log(row); return null; }
  // the turn's handoff of this kind has already been made: the call goes through, and the row says which one
  // let it through. `after: 'handoff'` is this file's own report already in the lead's hands, so it is the one
  // free signal of whether the model obeyed (see AGENTS.md); `after: 'budget'` is the turn's five spent on
  // other files, which says nothing about the model at all and used to be counted as if it did.
  if (d.spent) { log({ ...row, fired: false, after: d.handed ? 'handoff' : 'budget' }); return null; }
  // a host with no subagent of its own and no fallback asked for: read as before, and say why in the log
  if (exec.mode === 'none') { log({ ...row, fired: false, skipped: exec.reason }); return null; }
  ctx = ctx || lastPrompt() || {};
  const brief = d.kind === 'verify'
    ? verifierBrief({ command: suite, cwd, rules: handoff })
    : explorerBrief({ files, prompt: ctx.prompt, lastSay: ctx.lastSay, cwd, lines: cfg.reportLines, rules: handoff });
  if (handoff) {
    // The host runs it. Nothing is spawned here, so the hook answers at once, and the subagent's cost is the
    // host's to bill and to show -- which is also how it is measured (the Report prices a subagent
    // conversation at its own model). The budget is spent before the denial goes out, so a second read of the
    // turn cannot be denied even if its hook runs at the same moment as this one.
    state.update(st => { noteHandoff(st, prompt, d.kind, d.key); if (d.kind === 'explore') noteFiring(st, { t: Date.now(), tokens: d.tokens, files, agent: exec.agent }); });
    // `model` where the host's agent is pinned to one (Claude Code's Explore.md and thinker-verify.md, `pins`):
    // the saving nets the lead's write against the same read at this model's rate
    // (report-savings.js:delegationSavings). Where nothing is pinned the subagent runs on a model thinker does
    // not choose, and the row names none.
    log({ ...row, agent: exec.agent, handoffTool: exec.tool, briefChars: brief.length, ...(exec.model ? { model: exec.model, family: exec.family } : pinnedTo ? { model: pinnedTo } : {}) });
    const label = handoffLabel(d.kind, files, cwd);
    const words = denial({ kind: d.kind, files, cwd, handoff: { ...exec, brief, label } });
    // A host whose plugin can run the subagent itself says so (`host_runs`, OpenCode: opencode-v2.js:hostRun), and
    // gets what it needs to do it beside the words: the agent, the model, the brief, and the sentence the report
    // comes back inside. The words stay, for the run that fails -- they are then all there is, as before.
    if (!ev.host_runs) return words;
    return JSON.stringify({ ...JSON.parse(words), thinkerRun: hostRunOrder({ exec, lead: ev.model, kind: d.kind, files, cwd, brief, label, pinned: pinnedTo }) });
  }
  if (cached) { log({ ...row, cached: true }); return denial({ kind: d.kind, report: cached, files, cwd, model: cfg.model }); }
  const r = await run({ kind: d.kind, brief, cwd, cfg });
  if (r.error) { log({ ...row, error: r.error, ms: r.ms }); return null; }
  state.update(st => { if (!st.delegate || st.delegate.prompt !== prompt) st.delegate = { prompt, reports: {}, handoffs: {} }; st.delegate.reports[d.key] = r.report; });
  if (d.kind === 'explore') state.update(st => noteFiring(st, { t: Date.now(), tokens: d.tokens, files }));
  log({ ...row, model: r.model, usage: r.usage, cost: r.cost, ms: r.ms, reportChars: r.report.length, subagent: r.sessionId });
  return denial({ kind: d.kind, report: r.report, files, cwd, model: r.model });
}

// ---- the hosts, their door, and their own subagent ----
//
// A host is here when it has a door that can refuse a tool call and answer in its place: Claude Code's
// PreToolUse deny, and OpenCode 2's `tool.hook('execute.before')`, where a thrown error is the call's result
// (checked live on 2.2.7, 2026-11-12: the model read the denial's words and answered from them; an error that
// read as a "pre-baked report" was distrusted and routed around with grep and sed, so the words matter).
// OpenCode names its tools in lower case (`read`, `shell`) and its Read takes `path`; one Read there returns
// at most ~58k characters and tells the model to continue at an offset.
//
// `subagent` is how the model hands the work on, per kind, and it is read straight off each host:
//
// - Claude Code 2.1.x: the `Agent` tool (`Task` in versions before 2.1.63), parameter `subagent_type`.
//   `Explore` and `general-purpose` are built in and always there, so a handoff needs nothing installed;
//   a user-scope `agents/Explore.md` overrides the built-in `Explore` and pins its model, which is what
//   explore-agent.js writes while the trigger is on (`pins: true`). A subagent's own tool call carries
//   `agent_type` and `agent_id` in the hook input, which is the loop guard.
// - OpenCode 2.2.7 (read out of the binary, 2026-11-12): the `subagent` tool, parameter `agent`, beside
//   `description` (a 3-5 word label) and `prompt` (the task). An unknown name is "Unknown agent", an agent
//   whose mode is `primary` "cannot run as a subagent", and `experimental.subagent_depth` is 1, so a
//   subagent cannot spawn one -- all the more reason the guard must hold. Nothing is built in: the agents
//   come from `{agent,agents}/**/*.md` under the config directories, so thinker installs the two it names
//   (delegate-agents.js). `pins: false`: OpenCode's model is `providerID/modelID` from the person's own
//   providers, and on a vendor's cloud harness with the vendor's models thinker has no business naming one.
//   `primary` lists the agents a prompt runs as there, so anything else is a subagent and never delegates.
export const OPENCODE_EXPLORE = 'thinker-explore', OPENCODE_VERIFY = 'thinker-verify';
// THE SUITE RUN HAS AN AGENT OF ITS OWN ON CLAUDE CODE (2026-11-19).
//
// A handed-over suite run went to the built-in `general-purpose`, which has no model of its own: it ran on the
// lead's, with every tool the session has in its prompt. Read out of this machine's transcripts, ten such runs
// were billed $0.55 each (a start-up context of about 52k tokens, written at the lead's rate); the lead running
// the suite itself in one call comes to about $0.10 at the same prices, so the handoff was the dearer of the two.
// So thinker writes one agent for it (delegate-agents.js:installClaudeVerifier), pinned by its full id to
// `delegate.model` as Explore.md is, with a shell and the three reading tools and nothing else. The name is
// handed out only while that file is there (`claudeVerifierReady`): nothing built in stands behind it, and an
// agent that does not resolve is a failed handoff, so without the file the run goes to `general-purpose` as before.
export const CLAUDE_VERIFY = 'thinker-verify';
export const claudeAgentsDir = (env = process.env) => path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'agents');
export const claudeVerifierFile = (dir = claudeAgentsDir()) => path.join(dir, `${CLAUDE_VERIFY}.md`);
export const claudeVerifierReady = (dir = claudeAgentsDir()) => { try { return fs.statSync(claudeVerifierFile(dir)).isFile(); } catch { return false; } };

// THE EXPLORER IS THE LEAD'S OWN FAMILY'S CHEAP MODEL (2026-11-15, the owner's ask: "keep the pairs within the
// family e.g. opus/fable to haiku, astra/sol to luna").
//
// OpenRouter fronts every provider behind one key, so a session there can run its subagent on a model the lead
// does not use -- which is the half of the saving an unpinned OpenCode subagent gave up (it ran on the session's
// own model: the read stayed out of the lead's context, and was paid for at the lead's price). The pair stays in
// the family because the cheap model of a family is the one a person on that family has already accepted the
// terms and the behaviour of, and because it is the one comparison that is not a bet on another vendor.
//
// Each explorer was run as the pinned subagent of one lead (GLM 5.3 flashx, which follows the handoff) on one
// 118 KB file, asked for the line a function starts and ends on and the 13 names it compares against. What it
// cost, how long it took, and what came back right (2026-11-15, OpenRouter list prices):
//
//   anthropic  claude-haiku-5.5       $0.018  22 s  all right      leads $2-10 a million in, this $0.10
//   openai     gpt-6-luna             $0.010  17 s  all right      leads $1-10, this $0.10
//   zai        glm-5.3-flash          $0.018  20 s  all right      leads $0.37-2.80, this $0.04
//   deepseek   deepseek-v4.1-flash    $0.016   9 s  all right      lead $0.90, this $0.05 (v4-flash: $0.007, 34 s)
//   qwen       qwen3.8-flash          $0.016  38 s  all right      leads $1.50-4, this $0.15
//   mistral    mistral-small-2603     $0.016  24 s  all right      leads $0.70-1.50, this $0.15
//   google     gemini-3.5-flash-lite  $0.04    9 s  11, 13 and 12 of the 13 names over three runs, one end line wrong
//
// Google is the one weak row and it is there on the arithmetic: gemini-3.8-flash got everything right for $0.27,
// which is more than a Gemini 4 lead pays to read the file itself ($0.057 for the write), so the accurate
// explorer cannot pay and the cheap one is slightly lossy. Three families have no pair and stay on the session's
// model: xAI (grok-4.3 is the cheapest with tools, 37% under the lead), Moonshot (Kimi's cheap input comes with
// $8-16 a million out) and MiniMax (the lead is $0.30 already; m3.1-flash cost more than the lead's own read).
//
// `skip` is the lead that is already its family's cheap tier: it keeps the unpinned agent, since handing a
// Haiku session's read to Haiku under another name changes nothing. The ids are OpenRouter's. A model that
// leaves the catalogue makes its row's agent fail to resolve, so the table is checked against
// `https://openrouter.ai/api/v1/models` when it is touched, and `delegate: { families: false }` is the switch.
export const EXPLORER_FAMILIES = Object.freeze([
  { family: 'anthropic', lead: /^anthropic\/claude-/, skip: /haiku/, explorer: 'anthropic/claude-haiku-5.5' },
  { family: 'openai', lead: /^openai\/(gpt-|o\d|codex-)/, skip: /luna|mini|nano/, explorer: 'openai/gpt-6-luna' },
  { family: 'google', lead: /^google\/gemini-/, skip: /flash|lite/, explorer: 'google/gemini-3.5-flash-lite' },
  { family: 'zai', lead: /^z-ai\/glm-/, skip: /-flash$/, explorer: 'z-ai/glm-5.3-flash' },
  { family: 'deepseek', lead: /^deepseek\/deepseek-/, skip: /flash/, explorer: 'deepseek/deepseek-v4.1-flash' },
  { family: 'qwen', lead: /^qwen\/qwen/, skip: /flash/, explorer: 'qwen/qwen3.8-flash' },
  { family: 'mistral', lead: /^mistralai\/mistral-/, skip: /small|nemo/, explorer: 'mistralai/mistral-small-2603' },
]);
// the gateways whose model ids are `<vendor>/<model>` and whose one key reaches every vendor
export const FAMILY_PROVIDERS = Object.freeze(['openrouter']);
export const familyAgent = family => `${OPENCODE_EXPLORE}-${family}`;
/**
 * The explorer for a lead, or null: `{ family, agent, model }`, the model in the host's own `provider/model`
 * form. `lead` is what the host says the session runs on (`{ providerID, id }`, OpenCode's `session.get`).
 * Null for a provider that is not a gateway, a family with no pair, and a lead that is already the cheap one.
 */
export function explorerFor(lead) {
  const provider = lead?.providerID, raw = typeof lead?.id === 'string' ? lead.id : '';
  if (!FAMILY_PROVIDERS.includes(provider) || !raw) return null;
  // OpenRouter's moving aliases are `~vendor/model-latest`, and a variant rides after a colon (`:thinking`)
  const id = raw.replace(/^~/, '').split(':')[0];
  const f = EXPLORER_FAMILIES.find(x => x.lead.test(id));
  if (!f || f.skip.test(id) || id === f.explorer) return null;
  return { family: f.family, agent: familyAgent(f.family), model: `${provider}/${f.explorer}` };
}
export const HOSTS = Object.freeze({
  claude: {
    readCap: 0,
    subagent: { tool: 'Agent', alias: 'Task', param: 'subagent_type', explore: 'Explore', verify: 'general-purpose', verifyPinned: CLAUDE_VERIFY, pins: true },
  },
  opencode: {
    readCap: 58000,
    tools: { read: 'Read', shell: 'Bash', bash: 'Bash' },
    subagent: { tool: 'subagent', param: 'agent', explore: OPENCODE_EXPLORE, verify: OPENCODE_VERIFY, pins: false, families: true, primary: ['build', 'plan'] },
  },
  // Devin (CLI 3000.11.234, probed live 2026-11-16 on swe-2-high and swe-2-medium). Its PreToolUse hook takes
  // Claude Code's own payload and answer: `tool_name` is `read` / `exec` (clients.js:normalizeHookEvent renames
  // them), `tool_input` is `{ file_path, offset, limit }` / `{ command }`, `prompt_id` names the turn, and a
  // `permissionDecision: "deny"` is shown to the model with its reason ("Hook block"). Both models then called
  // `run_subagent` with `profile: "subagent_explore"`, its `title` and its `task` -- the handoff, in Devin's
  // words -- and answered right from the report, with ranged reads of the lines they needed.
  // What Devin does NOT give: any mark of a subagent's own call. The subagent's reads arrive under the lead's
  // session id and prompt id, with the same fields and the same environment, and no SubagentStop fired. So the
  // subagent's calls are known by when they happen (`window`): from the PreToolUse of `run_subagent` to its
  // PostToolUse, which Devin sends when the subagent has answered, every call goes through.
  devin: {
    readCap: 0,
    subagent: { tool: 'run_subagent', param: 'profile', explore: 'subagent_explore', verify: 'subagent_general', pins: false, fields: { label: 'title', brief: 'task' }, window: true },
  },
});

// A subagent that never reported back (a crash, a background run whose PostToolUse never came) may not hold the
// window open for the rest of the session: past this the next read is the lead's again.
export const SUBAGENT_WINDOW_MS = 15 * 60_000;
/** The host's subagent is running: between its launch and its answer, on a host that does not mark its calls. */
export function subagentRunning(st, now = Date.now()) {
  const w = st?.delegateWindow;
  return Boolean(w && w.open > 0 && now - (w.at || 0) < SUBAGENT_WINDOW_MS);
}
/** PreToolUse (`open`) and PostToolUse (close) of the host's subagent tool. Runs under the session's lock. */
export function noteSubagent(st, open, now = Date.now()) {
  const w = st.delegateWindow && now - (st.delegateWindow.at || 0) < SUBAGENT_WINDOW_MS ? st.delegateWindow : { open: 0, at: now };
  w.open = Math.max(0, (w.open || 0) + (open ? 1 : -1));
  if (open) w.at = now;
  st.delegateWindow = w;
}
/** Is this the subagent tool of a host whose subagent calls are told apart by the window alone? */
export const windowTool = (client, toolName) => Boolean(HOSTS[client]?.subagent?.window && toolName === HOSTS[client].subagent.tool);

/**
 * Is this tool call a subagent's own? Then nothing is delegated: the subagent is the delegation, its reads are
 * the work, and a second denial would either loop or hand it an instruction it cannot carry out (OpenCode
 * refuses a nested subagent outright). Claude Code names the agent in `agent_type`; OpenCode's hook event
 * carries `agent` on every call, so there a call is the main conversation's only while the agent is a primary
 * one -- an unknown name is treated as a subagent, which fails closed into reading the file as before.
 */
export function fromSubagent(ev = {}, client = 'claude') {
  const sub = HOSTS[client]?.subagent;
  const agent = ev.agent_type || ev.agent || ev.subagent_type;
  if (!agent || !sub) return false;
  if (sub.primary) return !sub.primary.includes(String(agent));
  return true;
}

/**
 * Who runs this one, and how the model is told: `{ mode: 'handoff', tool, param, agent }` for the host's own
 * subagent, `{ mode: 'report' }` for thinker's own fallback, `{ mode: 'none', reason }` where there is neither
 * and the call goes through untouched.
 */
export function executionFor(client, kind, cfg = DELEGATE_DEFAULTS, { lead = null, verifier = false } = {}) {
  const sub = HOSTS[client]?.subagent;
  // `verifier`: thinker's own pinned agent for the suite run is installed (Claude Code, `claudeVerifierReady`)
  const pinned = Boolean(kind === 'verify' && verifier && sub?.verifyPinned);
  const agent = sub && (kind === 'verify' ? (pinned ? sub.verifyPinned : sub.verify) : sub.explore);
  // An exploration on a gateway goes to the lead's family's cheap model (EXPLORER_FAMILIES). A suite run there
  // stays on the session's model: no pair was measured for it.
  const pair = kind !== 'verify' && sub?.families && cfg.families !== false ? explorerFor(lead) : null;
  if (cfg.handoff && agent) return { mode: 'handoff', tool: sub.tool, alias: sub.alias, param: sub.param, ...(sub.fields ? { fields: sub.fields } : {}), agent: pair ? pair.agent : agent, ...(pair ? { model: pair.model, family: pair.family } : {}), ...(pinned ? { pinned: true } : {}) };
  if (cfg.fallback) return { mode: 'report' };
  return { mode: 'none', reason: agent ? 'handoff-off' : 'no-native-subagent' };
}
/** A host's event in the hook's own shape: tool names as Claude Code's, `file_path` for the Read's file. */
export function hostEvent(client, ev) {
  const h = HOSTS[client];
  if (!h || !h.tools) return ev;
  const tool_name = h.tools[ev.tool_name] || ev.tool_name;
  const input = ev.tool_input || {};
  const tool_input = tool_name === 'Read' && input.path && !input.file_path ? { ...input, file_path: input.path } : input;
  return { ...ev, tool_name, tool_input };
}

// ---- the lead's own subagents, on a cheaper model (2026-11-19, the owner's ask) ----
//
// A subagent the lead starts itself -- a survey, a web page read, an end-to-end run -- has no model of its own
// and runs on the lead's. Over 30 days of this machine's sessions that was 55 runs of `general-purpose`, `claude`
// and `web-fetch` billed $156 on Opus and Fable, and the same tokens at Sonnet's list rates are $39. Nothing has to
// be handed over, because the lead has already done the handing: the trigger is its own Agent call, and all the
// hook does is name the model, which the harness takes as if the lead had (`updatedInput`; live on 2.1.329, a
// `haiku` lead's call came back on Sonnet with nothing else changed). It is an alias, never a full id -- the
// Agent tool refuses one ("an invalid value", the same run) -- so the model is the person's own `sonnet`.
//
// What it leaves alone, each for a reason:
//  - a call that names a model: the lead, or the person through it, chose;
//  - any other agent type: Explore and thinker's own agents are pinned by their definitions, a person's agent may
//    be, and the call's model outranks a definition's (the same run: Explore.md's Haiku lost to the call's
//    `sonnet`), so naming one there would undo a choice; a fork runs on its parent's model by design;
//  - thinker's own queue worker (session-llm.js:isWorkerLaunch): its answers are the profile, on the model the
//    profile was measured on;
//  - a subagent's own Agent call: it inherits what its parent already runs on;
//  - a lead that is not on a dearer model, or whose model the transcript does not show yet: Sonnet for a Haiku
//    session would be the trigger raising the price.
// Every decided call is a row (`kind: 'subagent'`), a held-out session's too, and the Report prices each
// subagent conversation at the model it ran on, so the two sides are read off what already exists.
export const SUBAGENT_TYPES = Object.freeze(['general-purpose', 'claude', 'web-fetch']);
const DEARER_LEAD = /opus|fable|mythos/i;
/** The model of the lead's newest answer, from the transcript's tail, or null. */
export function leadModelOf(transcriptPath, tail = TRANSCRIPT_TAIL) {
  try {
    const size = fs.statSync(transcriptPath).size;
    const rows = transcriptRows(transcriptPath, size, Math.min(size, tail));
    for (let i = rows.length - 1; i >= 0; i--) {
      const m = rows[i].type === 'assistant' && !rows[i].isSidechain ? rows[i].message?.model : null;
      if (typeof m === 'string' && m && !m.startsWith('<')) return m;
    }
  } catch {}
  return null;
}
/** One Agent call of the lead's: the hook's stdout that names the model, or null when the call goes as it came. */
export function subagentCall({ ev, session, cfg = DELEGATE_DEFAULTS, log = () => {}, leadModel = () => null, client = 'claude' }) {
  const to = typeof cfg.subagentModel === 'string' ? cfg.subagentModel.trim() : '';
  if (!to || fromSubagent(ev, client)) return null;
  const input = ev.tool_input && typeof ev.tool_input === 'object' ? ev.tool_input : {};
  const agent = String(input[HOSTS[client]?.subagent?.param || 'subagent_type'] || 'general-purpose');
  if (!SUBAGENT_TYPES.includes(agent)) return null;
  const row = { op: 'delegate', session, client, kind: 'subagent', tool: ev.tool_name, agent };
  if (input.model) { log({ ...row, fired: false, declined: 'model-named', named: String(input.model).slice(0, 60) }); return null; }
  if (isWorkerLaunch(input)) { log({ ...row, fired: false, declined: 'thinker-worker' }); return null; }
  const lead = leadModel() || null;
  if (!lead || !DEARER_LEAD.test(lead)) { log({ ...row, fired: false, declined: 'lead', lead }); return null; }
  const held = heldOut(session, cfg.holdout);
  log({ ...row, held, lead, ...(held ? {} : { model: to }) });
  if (held) return null;
  // no permission decision: the call is asked about, or not, exactly as it would have been
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input, model: to } } });
}

/** The PreToolUse hook's body, over the repository's store and the session's state file. */
export async function preToolHook({ ev: raw, store, session, cwd, cfg = delegateConfig(), run, client = 'claude', verifier = client === 'claude' && claudeVerifierReady() }) {
  if (!cfg.enabled || !HOSTS[client]) return null;
  // The lead's own subagent call, moved to a cheaper model (`subagentCall`). No mod decides this one, so it is
  // answered here whether or not a mod marked the session.
  const sub = HOSTS[client].subagent;
  if (client === 'claude' && sub && (raw.tool_name === sub.tool || raw.tool_name === sub.alias)) {
    return subagentCall({ ev: raw, session, cfg, client, log: row => store.log(row), leadModel: () => raw.transcript_path ? leadModelOf(raw.transcript_path) : null });
  }
  // Claude Code's mod asks for itself, from inside the harness, and runs the subagent (`host_runs`,
  // claude-clear:delegateCall). In a session it marked, the settings hook's copy of the same call stands down,
  // or one read would be decided twice.
  if (client === 'claude' && !raw.host_runs && claudeCardActive(session, { name: DELEGATE_SESSION_MARK })) return null;
  const ev = hostEvent(client, raw);
  const state = { update: fn => locked(store, session, () => { const { st, save } = sessionState(store, session); fn(st); save(); }) };
  // a host that does not mark its subagent's calls: the launch opens the window, and inside it nothing is decided
  if (windowTool(client, ev.tool_name)) { state.update(st => noteSubagent(st, true)); return null; }
  if (!['Read', 'Bash'].includes(ev.tool_name)) return null;
  if (HOSTS[client].subagent?.window) { let running = false; state.update(st => { running = subagentRunning(st); }); if (running) return null; }
  return delegateTool({ ev, state, session, cwd, cfg, run, client, verifier, readCap: HOSTS[client].readCap, log: row => store.log(row), // what the person asked: Claude Code's transcript holds it; a host with no transcript to read says it itself
    // (`user_prompt`, OpenCode's plugin). Without it the brief asks an explorer to report on a file for a
    // request it was never shown, and the report is a summary of whatever it read first.
    // A host with neither keeps a trace of its own through thinker's hooks (transcripts.js:recordEvent): the
    // newest prompt and the model's last words are read from there.
    lastPrompt: () => ev.transcript_path ? lastPromptOf(ev.transcript_path) : typeof ev.user_prompt === 'string' && ev.user_prompt ? { prompt: ev.user_prompt } : lastPromptOfTrace(traceFile(store.dir, session)) });
}

/** The newest prompt and the model's last words after it, from the trace thinker's own hooks record. */
export function lastPromptOfTrace(file) {
  let prompt, lastSay;
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.t === 'prompt' && e.text) { prompt = e.text; lastSay = undefined; } else if (e.t === 'say' && e.text) lastSay = e.text;
    }
  } catch { return {}; }
  return prompt ? { prompt, ...(lastSay ? { lastSay } : {}) } : {};
}

const TRANSCRIPT_TAIL = 400_000;
/**
 * The current prompt and the model's last words, from the transcript's tail (written with a lag, so a best effort).
 * One prompt and a hundred tool calls is a 1.5 MB transcript with the person's words at the top of it, so when the
 * tail holds no prompt the whole file is read: a brief with an empty request gets a map of the file back instead of
 * an answer (seen live on 2026-11-12, three firings), and the read costs 12 ms for 1.5 MB beside a subagent that
 * runs for ten seconds.
 */
export function lastPromptOf(transcriptPath, tail = TRANSCRIPT_TAIL) {
  try {
    const size = fs.statSync(transcriptPath).size;
    const near = scanTranscript(transcriptRows(transcriptPath, size, Math.min(size, tail)));
    if (near.prompt || size <= tail) return near;
    const all = scanTranscript(transcriptRows(transcriptPath, size, size));
    return { prompt: all.prompt, lastSay: near.lastSay || all.lastSay };
  } catch { return {}; }
}
function transcriptRows(transcriptPath, size, len) {
  const fd = fs.openSync(transcriptPath, 'r'), buf = Buffer.alloc(len);
  try { fs.readSync(fd, buf, 0, len, size - len); } finally { fs.closeSync(fd); }
  return buf.toString('utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function scanTranscript(rows) {
  let prompt = '', lastSay = '';
  for (const r of rows) {
    if (r.type === 'user' && typeof r.message?.content === 'string' && !/^<(task-notification|agent-message|system-reminder|command-name)/.test(r.message.content)) { prompt = r.message.content; lastSay = ''; }
    else if (r.type === 'assistant') for (const p of r.message?.content || []) if (p.type === 'text' && p.text) lastSay = p.text;
  }
  return { prompt, lastSay };
}
