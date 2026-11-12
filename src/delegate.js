// The delegation trigger: a tool call handed to a subagent on a cheaper model, deterministically, from the
// PreToolUse hook (2026-11-11, the owner's call; the two hook rules that forbade it went in #750).
//
// What it is for. A read the main model makes stays in its context for the rest of the session: written
// into its cache once at the main model's rate and read back on every later call. The stage-delegation bench
// of 2026-11-10/11 (43 paired runs, Opus inline against an Opus lead with Sonnet subagents) measured that
// handing a turn's exploration to a Sonnet explorer once its reads pass about 35k tokens saves 11-50% on
// such sessions and, replayed over this machine's 30 days, projects to about 4.6% of spend; that a nudge the
// model may ignore is not a trigger; and that the edits should stay with the main model (a builder subagent
// re-reads and re-reasons what the lead already holds). So the hook denies the read, runs the explorer
// itself, and returns the report as the denial's reason, which is what the model reads instead of the file.
// A whole-suite test run goes the same way to a verifier that reports the summary line verbatim.
//
// What it is not. It never intercepts a small read (the main model reads the lines it edits), never runs
// anything on a held-out session (the live measure is those sessions against the others), and never spends
// more than one subagent run per file per turn (a repeat read gets the cached report). THINKER_DELEGATE=off
// or `delegate: { enabled: false }` in the machine config turns it off; the hook then exits at once.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readMachineConfig } from './repo-switch.js';
import { heldOut } from './proxy.js';
import { findBin, BINS } from './llm.js';
import { sessionState, locked } from './session-state.js';

export const DELEGATE_DEFAULTS = Object.freeze({
  enabled: true,
  model: 'claude-sonnet-5-5',
  threshold: 35000,   // tokens of read results in one turn past which the rest of its exploration is delegated
  minRead: 8000,      // a read under this is never delegated: the lines the main model edits
  holdout: 0.5,       // share of sessions left alone, by hash of the session id (proxy.js:heldOut)
  timeoutMs: 240_000, // a subagent run past this is abandoned and the read allowed
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
  return o;
}

// ---- what a tool call would read ----
// A Read of a file, or a shell line whose work is to print a file (cat, sed -n, head with a large count),
// with nothing after it that would shrink the output. Anything piped into grep, head, tail, wc or awk is
// the model trimming for itself, and is left alone.
const SHRINKS = /\|\s*(grep|rg|head|tail|wc|awk|cut|sort|uniq|jq|python|node)\b/;
const READ_CMD = /^\s*(?:cat|less|more|sed\s+-n\s+(?:'[^']*'|"[^"]*"|\S+)|head\s+-n?\s*(\d+)|head\s+-c\s*\d+)\s+(.+?)\s*$/;
function splitArgs(s) { return (s.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(a => a.replace(/^["']|["']$/g, '')); }
function fileStats(file, cwd) {
  const p = path.isAbsolute(file) ? file : path.join(cwd || process.cwd(), file);
  try { const st = fs.statSync(p); if (!st.isFile()) return null; return { path: p, bytes: st.size }; } catch { return null; }
}
function linesOf(p) { try { return fs.readFileSync(p, 'utf8').split('\n').length; } catch { return 0; } }

/**
 * What this tool call would put into the context: { tokens, files }, or null when it is not a read. `readCap` is
 * the most characters the host's Read returns in one call (OpenCode truncates at about 58k and tells the model to
 * continue at an offset, so a whole file there is several reads, which the turn's tally adds up).
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
    const cmd = String(input.command || '');
    if (SHRINKS.test(cmd) || /[;&]|\|\|/.test(cmd.replace(/\|\|/g, ';'))) return null;
    const m = cmd.match(READ_CMD);
    if (!m) return null;
    const files = splitArgs(m[2]).filter(a => !a.startsWith('-')).map(f => fileStats(f, cwd)).filter(Boolean);
    if (!files.length) return null;
    let bytes = files.reduce((a, f) => a + f.bytes, 0);
    if (m[1]) bytes = Math.min(bytes, Number(m[1]) * 40);
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

// ---- the turn's tally, kept on the session's state file ----
// `prompt` is Claude Code's prompt_id, a new value for every prompt of the person's, so the tally and the
// cached reports belong to one turn. A read under minRead never fires; one at or over the threshold on its own
// fires at once (the write saving alone pays for it); anything else fires once the turn's reads have passed
// the threshold. The state carries the tally whether or not the session is held out, so a held-out session
// logs the same would-have-fired rows.
export function decide(st, { prompt, read, suite, cfg = DELEGATE_DEFAULTS }) {
  const d = st.delegate && st.delegate.prompt === prompt ? st.delegate : { prompt, readTokens: 0, reports: {} };
  st.delegate = d;
  if (suite) return { fire: true, kind: 'verify', key: 'suite:' + suite, tokens: 0, turnTokens: d.readTokens };
  if (!read || !read.tokens) return { fire: false };
  const key = read.files.join('\n');
  const before = d.readTokens;
  d.readTokens += read.tokens;
  // a host that returns a big file in chunks: the first chunk fires when the file asked for is over the threshold
  const fire = read.tokens >= cfg.threshold || (read.fileTokens || 0) >= cfg.threshold || (read.tokens >= cfg.minRead && d.readTokens >= cfg.threshold);
  if (fire) d.readTokens = before; // a delegated read never enters the context
  return { fire, kind: 'explore', key, tokens: read.tokens, turnTokens: d.readTokens };
}

// ---- the subagent ----
export const EXPLORER_PROMPT = `You explore a codebase for a lead engineer who will not read the files. Answer exactly the question in the brief. Report in at most {N} lines: each relevant function, class or section as \`path:line\` with one line on what it does and how it connects, and the exact lines to change if the brief asks. Quote at most 5 lines of code in total. Never paste a file or a long excerpt. Use the shell only for read-only commands. Never edit a file, never run tests.`;
export const VERIFIER_PROMPT = `You verify work for a lead engineer. Run exactly the command in the brief, once. Report in at most 15 lines: first the final summary line exactly as the test runner printed it, copied verbatim; then for each failing test its name, the assertion message and the file:line it points at, and one line on the likely cause. If nothing ran (a collection or import error), say so in the first line. Never paste full output. Never edit a file.`;

export function explorerBrief({ files, prompt, lastSay, cwd, lines = DELEGATE_DEFAULTS.reportLines }) {
  const list = files.map(f => path.relative(cwd || '', f) || f).join(', ');
  return [
    `Working directory: ${cwd}.`,
    `The lead engineer was about to read ${list} while working on this request from the user:`,
    '---', String(prompt || '').slice(0, 2000), '---',
    lastSay ? `The lead's last words before reaching for the file: "${String(lastSay).slice(0, 600)}"` : '',
    `Read ${list} (and whatever it points to that the request needs) and report what the lead needs from it for this request: the relevant definitions as path:line, what each does, how they connect, and the exact lines to change if the request is a change. At most ${lines} lines, at most 5 quoted lines of code.`,
  ].filter(Boolean).join('\n');
}
export function verifierBrief({ command, cwd }) {
  return `Working directory: ${cwd}.\nRun exactly this command once, from that directory: \`${command}\`\nReport the final summary line verbatim first, then the failing tests as briefed.`;
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
export function denial({ kind, report, files, cwd, model }) {
  const what = kind === 'verify' ? 'ran this test command' : `read ${files.map(f => path.relative(cwd || '', f) || f).join(', ')}`;
  const reason = `thinker ${what} through a ${model} subagent so the full output stays out of your context. Its report is below; work from it. ` +
    (kind === 'verify' ? 'Running the same command again returns this same report; run a single test file yourself to check a fix.'
      : 'Reading the same file again this turn returns this same report; read a short range (offset and limit) of the lines you need to edit, which is never delegated.') +
    `\n\n${report}`;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}

/**
 * The whole decision for one PreToolUse event. `state.update(fn)` runs fn(st) under the session's lock and saves
 * (two tool calls of one turn run their hooks at the same time); the subagent runs outside it. `run` and
 * `lastPrompt` are injected so the logic is testable without a subagent. Resolves to the hook's stdout, or null.
 */
export async function delegateTool({ ev, state, session, cwd, cfg = DELEGATE_DEFAULTS, log = () => {}, run = runSubagent, lastPrompt = () => ({}), readCap = 0, client }) {
  const read = readOf(ev.tool_name, ev.tool_input, cwd, { readCap });
  const suite = suiteCommand(ev.tool_name, ev.tool_input);
  if (!read && !suite) return null;
  let d, cached, prompt;
  state.update(st => { prompt = ev.prompt_id || st.turnNo || 0; d = decide(st, { prompt, read, suite, cfg }); cached = d.fire ? st.delegate.reports[d.key] : undefined; });
  if (!d.fire) return null;
  const held = heldOut(session, cfg.holdout);
  const files = read ? read.files : [];
  const row = { op: 'delegate', session, client, kind: d.kind, tool: ev.tool_name, files: (read ? read.files : [suite]).map(f => path.relative(cwd || '', f) || f), tokens: d.tokens, turnTokens: d.turnTokens, held };
  if (held) { log(row); return null; }
  if (cached) { log({ ...row, cached: true }); return denial({ kind: d.kind, report: cached, files, cwd, model: cfg.model }); }
  const ctx = lastPrompt() || {};
  const brief = d.kind === 'verify' ? verifierBrief({ command: suite, cwd }) : explorerBrief({ files, prompt: ctx.prompt, lastSay: ctx.lastSay, cwd, lines: cfg.reportLines });
  const r = await run({ kind: d.kind, brief, cwd, cfg });
  if (r.error) { log({ ...row, error: r.error, ms: r.ms }); return null; }
  state.update(st => { if (!st.delegate || st.delegate.prompt !== prompt) st.delegate = { prompt, readTokens: 0, reports: {} }; st.delegate.reports[d.key] = r.report; });
  log({ ...row, model: r.model, usage: r.usage, cost: r.cost, ms: r.ms, reportChars: r.report.length, subagent: r.sessionId });
  return denial({ kind: d.kind, report: r.report, files, cwd, model: r.model });
}

// The hosts with a door that can refuse a tool call and answer in its place: Claude Code's PreToolUse deny, and
// OpenCode 2's `tool.hook('execute.before')`, where a thrown error is the call's result (checked live on 2.2.7,
// 2026-11-12: the model read the report in the denial's words and answered from it; an error that read as a
// "pre-baked report" was distrusted and routed around with grep and sed, so the words matter). OpenCode names
// its tools in lower case (`read`, `shell`) and its Read takes `path`; one Read there returns at most ~58k
// characters and tells the model to continue at an offset.
export const HOSTS = Object.freeze({
  claude: { readCap: 0 },
  opencode: { readCap: 58000, tools: { read: 'Read', shell: 'Bash', bash: 'Bash' } },
});
/** A host's event in the hook's own shape: tool names as Claude Code's, `file_path` for the Read's file. */
export function hostEvent(client, ev) {
  const h = HOSTS[client];
  if (!h || !h.tools) return ev;
  const tool_name = h.tools[ev.tool_name] || ev.tool_name;
  const input = ev.tool_input || {};
  const tool_input = tool_name === 'Read' && input.path && !input.file_path ? { ...input, file_path: input.path } : input;
  return { ...ev, tool_name, tool_input };
}

/** The PreToolUse hook's body, over the repository's store and the session's state file. */
export async function preToolHook({ ev: raw, store, session, cwd, cfg = delegateConfig(), run, client = 'claude' }) {
  if (!cfg.enabled || !HOSTS[client]) return null;
  const ev = hostEvent(client, raw);
  if (!['Read', 'Bash'].includes(ev.tool_name)) return null;
  const state = { update: fn => locked(store, session, () => { const { st, save } = sessionState(store, session); fn(st); save(); }) };
  return delegateTool({ ev, state, session, cwd, cfg, run, client, readCap: HOSTS[client].readCap, log: row => store.log(row), lastPrompt: () => ev.transcript_path ? lastPromptOf(ev.transcript_path) : {} });
}

/** The current prompt and the model's last words, from the transcript's tail (written with a lag, so a best effort). */
export function lastPromptOf(transcriptPath) {
  try {
    const size = fs.statSync(transcriptPath).size, fd = fs.openSync(transcriptPath, 'r');
    const len = Math.min(size, 400_000), buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd);
    const rows = buf.toString('utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    let prompt = '', lastSay = '';
    for (const r of rows) {
      if (r.type === 'user' && typeof r.message?.content === 'string' && !/^<(task-notification|agent-message|system-reminder|command-name)/.test(r.message.content)) { prompt = r.message.content; lastSay = ''; }
      else if (r.type === 'assistant') for (const p of r.message?.content || []) if (p.type === 'text' && p.text) lastSay = p.text;
    }
    return { prompt, lastSay };
  } catch { return {}; }
}
