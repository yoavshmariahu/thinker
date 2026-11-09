// The Factory (2026-11-08, the owner's direction): a session read as a pipeline. Every model call is a unit of work at
// one of six stations -- Prompts, Think, Explore, Build, Verify, Merge -- and what it cost is the station's. Where work
// came back to an earlier station is a loop, found in the transcript by code and never by a model. The page's Factory
// tab and `thinker factory` are two doors to factoryView; the Report keeps it (report.js:reportView `factory`).
//
// One rule attributes tokens, and it has to fit in a sentence: a call's tokens go to the stage of the tool it called;
// the first call after a prompt is Prompts; a call with no tool is Think. A call that made tools of several stages is
// split evenly between them. Verify is any check of the work before it merges, by running it (tests, builds, probes)
// or by reading it (the review skills, a reviewer subagent): with no human reviewer a Review stage would measure the
// agent's own tokens and call them a review, so there is none; a change to a pull request after it was opened is a
// loop out of Merge instead.
//
// Loops are data, not a fixed set: a kind is defined by a detector over the session's events, and the view carries
// every kind that fired, so a new detector shows up on the page with no change there. Each kind says the rule that
// finds it. A loop's cost is the cost of the calls it spans, and a stage's rework is the cost of its calls inside
// any loop, counted once however many loops hold the call.
import { parseTranscript, subagentSessions, continuations, afterContinuation } from './transcripts.js';
import { bashProgram } from './tool-outputs.js';
import { listPrice, writeCost } from './prices.js';
import { findRepoSessions } from './instruction-value.js';
import { readLedger, profileArmOf } from './profile.js';
import { heldOut, PROXY_DEFAULTS } from './proxy.js';
import fs from 'node:fs';
import path from 'node:path';
import { SERVICE_HOLDOUT } from './proxy-service.js';
import { readMachineConfig } from './repo-switch.js';
import { thinkerHome } from './update.js';
import { deliveryReport } from './delivery.js';
import { diskCache, cacheKey, cachedByFiles } from './disk-cache.js';
import { weekColumns, REPORT_WEEKS } from './report.js';

export const STAGES = [
  ['prompts', 'Prompts', 'what the person typed, and the first call that reads it'],
  ['think', 'Think', 'plans, reasoning and answers: calls with no tool'],
  ['explore', 'Explore', 'reads, searches and exploring subagents'],
  ['build', 'Build', 'edits and writes'],
  ['verify', 'Verify', 'tests, builds and live probes, and the agent reading its own diff'],
  ['merge', 'Merge', 'commit, push, open the pull request, read its checks, merge'],
];
const STAGE_KEYS = STAGES.map(([k]) => k);
// a stage is judged on the share of its cost spent inside loops (first cut, this machine, 2026-11-08)
export const REWORK_THRESHOLDS = { good: 0.10, bad: 0.35 };
export const verdictOf = share => share == null ? null : share <= REWORK_THRESHOLDS.good ? 'good' : share >= REWORK_THRESHOLDS.bad ? 'bad' : 'mid';

// --- stages ----------------------------------------------------------------------------------------------------------
const REVIEW_SKILLS = /^(code-review|simplify|security-review|review)$/i;
const MERGE_RE = /\bgit\s+(?:-C\s+\S+\s+)?(commit|push|merge|rebase|tag|cherry-pick|worktree|add|checkout\s+-b|switch\s+-c)\b|\bgh\s+(pr|release|api|repo)\b/;
const EXPLORE_PROGS = new Set(['sqlite3', 'psql', 'mysql', 'redis-cli', 'ls', 'cat', 'head', 'tail', 'less', 'grep', 'rg', 'ag', 'find', 'fd', 'wc', 'du', 'df', 'tree', 'stat', 'file', 'which', 'type', 'env', 'printenv', 'pwd', 'awk', 'jq', 'sort', 'uniq', 'cut', 'tr', 'column', 'echo', 'printf', 'date', 'whoami', 'uname', 'sw_vers', 'ps', 'lsof', 'open', 'diff', 'comm', 'od', 'xxd', 'strings', 'realpath', 'readlink', 'basename', 'dirname']);
const EXPLORE_SUB = new Set(['git status', 'git diff', 'git log', 'git show', 'git blame', 'git grep', 'git branch', 'git remote', 'git rev-parse', 'git describe', 'git ls-files', 'git stash', 'gh issue', 'gh run', 'npm ls', 'npm view', 'npm outdated', 'pip show', 'pip list', 'docker ps', 'docker images', 'kubectl get', 'kubectl describe', 'kubectl logs']);
const BUILD_RE = /\bsed\s+-i\b|\b(mv|mkdir|cp|rm|touch|chmod|chown|ln|tee|patch|rsync)\b|\b(npm|pnpm|yarn|bun)\s+(install|ci|i|add|uninstall|update|link)\b|\bpip3?\s+install\b|\bbrew\s+install\b|\bcargo\s+add\b|\bgo\s+(get|mod)\b|>>?\s*[\w./~"'$-]|<<\s*-?\s*'?"?\w+/;
// the program a segment runs and the test or build programs (`node --test`, `npm test`, `pytest` …), keyed finely enough
// that `node -e` and `node script.js` are not `node --test`
const progOf = seg => { const p = bashProgram(seg); if (p === 'node' && /\bnode\s+(--test|--check)\b/.test(seg)) return 'node ' + seg.match(/--(test|check)/)[0]; if (/^python3?$/.test(p) && /-m\s+pytest\b/.test(seg)) return 'pytest'; return p; };
export const TEST_RE = /^(npm test|npm run (test|build|lint|typecheck|check|e2e)[\w:-]*|pnpm (test|build|lint)|yarn (test|build|lint)|bun test|node --test|node --check|pytest|jest|vitest|mocha|tsc|eslint|ruff|mypy|cargo (test|build|check|clippy)|go (test|build|vet)|make|gradle|mvn|dotnet (test|build)|swift (test|build)|xcodebuild|npx|claude plugin test)$/;
// a shell command's stage, by its strongest segment: a commit or push makes the line Merge whatever else it does, a test
// or build program makes it Verify (`echo start && npm test` is a test run, not an echo), a line that writes is Build, a
// line of read-only programs is Explore, and anything else is running something to see what happens: Verify
export function bashStage(command) {
  const c = String(command || '');
  if (MERGE_RE.test(c)) return 'merge';
  const segs = c.split(/&&|\|\||;|\n/).map(x => x.trim()).filter(x => x && !/^(cd|export|source|\.)\s/.test(x) && !/^\w+=\S*$/.test(x));
  const progs = segs.map(progOf);
  if (progs.some(p => TEST_RE.test(p))) return 'verify';
  // a read-only program that writes its output to a file (`cat > x <<EOF`, `grep … > list.txt`) is writing
  if (/>\s*(?!&)[\w./~"'$-]|<<\s*-?\s*['"]?\w+/.test(c) && !/>\s*\/dev\/null/.test(c)) return 'build';
  if (BUILD_RE.test(c)) return 'build';
  const readOnly = p => EXPLORE_PROGS.has(p) || EXPLORE_SUB.has(p) || (p === 'sed' && /\bsed\s+-n\b/.test(c)) || (/^(python3?|node)$/.test(p) && /\s-[ce]\s+['"]?(import|print|console|JSON|require|const|let)/.test(c));
  if (progs.length && progs.every(readOnly)) return 'explore';
  return 'verify';
}
// the stage of one tool call, in the transcripts' one vocabulary (transcripts.js:toolName)
export function stageOfTool(name, input) {
  const n = String(name || '');
  if (n === 'Bash') return bashStage(input?.command);
  if (n === 'Skill') return REVIEW_SKILLS.test(String(input?.skill || '')) || /^run$/i.test(String(input?.skill || '')) ? 'verify' : 'build';
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(n)) return 'build';
  if (/^(Read|Grep|Glob|LS|WebFetch|WebSearch|ToolSearch|NotebookRead|Agent|Task)$/.test(n)) return 'explore';
  if (/^(TodoWrite|TodoRead|AskUserQuestion|EnterPlanMode|ExitPlanMode|EnterWorktree|ExitWorktree)$/.test(n)) return 'think';
  if (/^(Monitor|ReportFindings)$/.test(n)) return 'verify';
  if (/^mcp__claude-in-chrome__/.test(n)) return 'verify';
  if (/^mcp__/.test(n)) return 'explore';
  return 'build';
}

// dollars for one call at its model's list price, null without one; tokens are every token the call carried
export const callTokens = c => (c.fresh || 0) + (c.read || 0) + (c.write || 0) + (c.out || 0);
export const callCost = (c, price) => !price ? null : ((c.fresh || 0) * price.input + (c.read || 0) * price.cacheRead + writeCost(c.write || 0, c.w1h || 0, price) + (c.out || 0) * price.output) / 1e6;

// --- loops -----------------------------------------------------------------------------------------------------------
// Each detector reads the session's events (with the index of the model call each was made in) and returns the loops it
// found: {from, to} call indices, inclusive, the exchange the loop belongs to, and a note. The kinds carry the route the
// page draws and the rule in words. `sessions` on the view counts the sessions a kind fired in.
export const LOOP_KINDS = {
  fix: { name: 'Fix loop', from: 'verify', to: 'build', sub: 'a failing run to the run that passes', rule: 'A test or build program (npm test, node --test, pytest, tsc …) fails and the same program passes within the same or the next exchange, before any commit, push or new branch; the loop is every call between.' },
  reviewcatch: { name: 'Review catch', from: 'verify', to: 'build', sub: 'a reading found something', rule: 'A review skill or a reviewer subagent ran, and edits followed before the next prompt.' },
  correction: { name: 'Correction', from: 'build', to: 'prompts', sub: 'the person corrected, redirected or interrupted', rule: 'The person interrupted the agent, or the profile ledger read their next prompt as a correction or a redirection; the loop is the exchange that redid the work.' },
  reread: { name: 'Re-read', from: 'explore', to: 'explore', sub: 'a file read again', rule: 'A file read again, whatever the range, twenty or more calls after it was last read.' },
  sentback: { name: 'Sent back', from: 'merge', to: 'build', sub: 'the pull request changed after it was opened', rule: 'A commit or a push after the session opened a pull request; the loop runs from the first edit after the opening to the last push.' },
};
const REREAD_GAP = 20;
const FAIL_RE = /\b(exit code:? [1-9]\d*|command failed|npm err!|error: command|failing [1-9]\d*|fail [1-9]\d*|\d+ failed\b|FAILED|AssertionError|Traceback \(most recent call last\)|SyntaxError|ReferenceError|TypeError:|Error: Cannot find module|not ok \d+)|✖/;
// Claude Code refusing to run the line, and a heredoc script of the agent's own crashing before the test program ran
// (python names such a script `<stdin>`): the run did not fail, it did not happen (21 of 467 loops here, 2026-11-09)
const DENIED_RE = /^Permission (?:for this (?:action|command)|to use \S+) (?:was|has been) denied\b|^The user doesn't want to (?:proceed|take this action)/m;
const SCRIPT_CRASH = /File "<stdin>", line \d+/;
const failed = e => {
  const head = String(e.result || '').slice(0, 4000);
  if (e.name === 'Bash' && (DENIED_RE.test(head) || SCRIPT_CRASH.test(head))) return false;
  return e.error === true || (e.name === 'Bash' && FAIL_RE.test(head));
};
// a commit, a push, a new branch or a pull request opened: the work moved on, and a failure still open is not fixed by a
// pass of the same program in the next piece of work (48 of 467 loops ran past one here, $201 of $647, 2026-11-09)
const BOUNDARY_RE = /\bgit\s+(?:-C\s+\S+\s+)?(?:commit|push|worktree\s+add|checkout\s+-b|switch\s+-c)\b|\bgh\s+pr\s+create\b/;
const isBoundary = e => e.name === 'Bash' && BOUNDARY_RE.test(String(e.input?.command || ''));

// the exchanges a session's prompts cut it into, and the model call each event belongs to; a call with no event takes
// the exchange of the call before it
function timeline(events, calls) {
  const n = calls.length, exchangeOf = new Array(n).fill(null), stagesOf = Array.from({ length: n }, () => new Set()), prompts = new Set(), tools = [];
  let exchange = 0, pending = false, interrupts = [];
  const indexOf = e => { const c = Number.isInteger(e.call) ? e.call : Number.isInteger(e.turn) ? e.turn - 1 : null; return c != null && c >= 0 && c < n ? c : null; };
  for (const e of events) {
    if (e.t === 'prompt') { exchange++; pending = true; continue; }
    if (e.t === 'interrupt') { interrupts.push(exchange); continue; }
    const ci = indexOf(e); if (ci == null) continue;
    if (pending) { prompts.add(ci); pending = false; }
    if (exchangeOf[ci] == null) exchangeOf[ci] = exchange;
    if (e.t === 'tool') { stagesOf[ci].add(stageOfTool(e.name, e.input)); tools.push({ ...e, ci, exchange }); }
  }
  for (let i = 0, last = 1; i < n; i++) { if (exchangeOf[i] == null) exchangeOf[i] = last; else last = exchangeOf[i]; }
  return { exchangeOf, stagesOf, prompts, tools, interrupts, exchanges: exchange };
}
// the calls of an exchange, as a [from, to] span of call indices, or null where it made none
const spanOf = (exchangeOf, x) => { let from = -1, to = -1; exchangeOf.forEach((e, i) => { if (e === x) { if (from < 0) from = i; to = i; } }); return from < 0 ? null : [from, to]; };

export function detectLoops(tl, { corrected = new Set() } = {}) {
  const out = [];
  // fix loops: a failing run and the later pass of the same command; failures of the same command before the pass are one loop
  const open = new Map();
  for (const e of tl.tools) {
    if (e.name !== 'Bash' || !e.input?.command) continue;
    const key = String(e.input.command).split(/&&|\|\||;|\n/).map(progOf).find(p => TEST_RE.test(p));
    // a failure the next exchange has not resolved is not this loop any more: the work moved on
    for (const [k, f] of open) if (e.exchange > f.exchange + 1) open.delete(k);
    const fail = key ? failed(e) : false;
    if (key && fail) { if (!open.has(key)) open.set(key, e); }
    else if (key && open.has(key)) { const f = open.get(key); open.delete(key); out.push({ kind: 'fix', from: f.ci, to: e.ci, exchange: e.exchange, note: key }); }
    // past a commit, a push or a new branch nothing open is this loop; a failing `npm test && git commit` never reached its commit
    if (isBoundary(e) && !fail) open.clear();
  }
  // review catch: a review skill or subagent, then edits before the next prompt
  for (const e of tl.tools) {
    const isReview = (e.name === 'Skill' && REVIEW_SKILLS.test(String(e.input?.skill || ''))) || ((e.name === 'Agent' || e.name === 'Task') && /review/i.test(String(e.input?.subagent_type || e.input?.description || '')));
    if (!isReview) continue;
    const edits = tl.tools.filter(x => x.ci > e.ci && x.exchange === e.exchange && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(x.name));
    if (edits.length) out.push({ kind: 'reviewcatch', from: e.ci, to: edits.at(-1).ci, exchange: e.exchange, note: String(e.input?.skill || e.input?.subagent_type || 'review') });
  }
  // corrections: an interruption, or a ledger verdict on the exchange before; the loop is the exchange that redid the work
  const redo = new Set([...tl.interrupts.map(x => x + 1), ...[...corrected].map(x => x + 1)]);
  for (const x of redo) { const s = spanOf(tl.exchangeOf, x); if (s) out.push({ kind: 'correction', from: s[0], to: s[1], exchange: x, note: tl.interrupts.includes(x - 1) ? 'interrupted' : 'corrected' }); }
  // re-reads: the same Read, the same arguments, far enough apart to have left the agent's attention
  const seen = new Map();
  for (const e of tl.tools) {
    if (e.name !== 'Read' || !e.input?.file_path) continue;
    const key = String(e.input.file_path);
    if (seen.has(key) && e.ci - seen.get(key) >= REREAD_GAP) out.push({ kind: 'reread', from: e.ci, to: e.ci, exchange: e.exchange, note: String(e.input.file_path).replace(/^.*\//, '') });
    seen.set(key, e.ci);
  }
  // sent back: the pull request opened, then a commit or a push on it. A session here often goes on to the next piece of
  // work, so the window closes at the next branch (checkout -b, switch -c, worktree add) or the next pull request opened.
  const isCommit = x => x.name === 'Bash' && /\bgit\s+(?:-C\s+\S+\s+)?(commit|push)\b/.test(String(x.input?.command || ''));
  const isBranch = x => x.name === 'Bash' && /\bgit\s+(?:-C\s+\S+\s+)?(checkout\s+-b|switch\s+-c|worktree\s+add)\b/.test(String(x.input?.command || ''));
  const isOpen = x => x.name === 'Bash' && /\bgh\s+pr\s+create\b/.test(String(x.input?.command || ''));
  let win = null; // { opened, edits, commits }
  const closeWin = () => { if (win?.commits.length) out.push({ kind: 'sentback', from: (win.edits[0] || win.commits[0]).ci, to: win.commits.at(-1).ci, exchange: win.commits.at(-1).exchange, note: 'after gh pr create' }); win = null; };
  for (const e of tl.tools) {
    if (isOpen(e)) { closeWin(); win = { opened: e, edits: [], commits: [] }; continue; }
    if (!win) continue;
    if (isBranch(e)) { closeWin(); continue; }
    if (isCommit(e)) win.commits.push(e);
    else if (!win.commits.length && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(e.name)) win.edits.push(e);
  }
  closeWin();
  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}

// --- one session ------------------------------------------------------------------------------------------------------
// `corrected`: the exchanges (1-based, by prompt) the profile ledger read as corrected or redirected
export function sessionFactory({ events = [], calls = [], model = null } = {}, { price = null, corrected = new Set() } = {}) {
  const tl = timeline(events, calls);
  const cost = calls.map(c => callCost(c, price)), tokens = calls.map(callTokens);
  const stages = Object.fromEntries(STAGE_KEYS.map(k => [k, { cost: 0, tokens: 0, calls: 0, rework: 0, reworkTokens: 0 }]));
  const alloc = calls.map((_, i) => tl.prompts.has(i) ? ['prompts'] : tl.stagesOf[i].size ? [...tl.stagesOf[i]] : ['think']);
  const loops = detectLoops(tl, { corrected });
  const inLoop = new Array(calls.length).fill(false);
  for (const L of loops) for (let i = L.from; i <= L.to; i++) inLoop[i] = true;
  calls.forEach((c, i) => {
    const share = 1 / alloc[i].length;
    for (const k of alloc[i]) { const s = stages[k]; s.calls += share; s.tokens += tokens[i] * share; if (cost[i] != null) s.cost += cost[i] * share; if (inLoop[i]) { s.reworkTokens += tokens[i] * share; if (cost[i] != null) s.rework += cost[i] * share; } }
  });
  const sum = (from, to, xs) => { let a = 0; for (let i = from; i <= to; i++) a += xs[i] || 0; return a; };
  return {
    model, priced: Boolean(price), calls: calls.length, exchanges: tl.exchanges,
    cost: cost.reduce((a, b) => a + (b || 0), 0), tokens: tokens.reduce((a, b) => a + b, 0),
    // the largest context a call carried, and the cache traffic: what the clearing is judged by (its arm needs both)
    peak: Math.max(0, ...calls.map(c => (c.fresh || 0) + (c.read || 0) + (c.write || 0))),
    cacheWrite: calls.reduce((a, c) => a + (c.write || 0), 0), cacheRead: calls.reduce((a, c) => a + (c.read || 0), 0),
    stages,
    loops: loops.map(L => ({ ...L, cost: sum(L.from, L.to, cost), tokens: sum(L.from, L.to, tokens), calls: L.to - L.from + 1 })),
  };
}

// --- by week ------------------------------------------------------------------------------------------------------------
// The trend a stage or a loop is read on (the page's modal, the command's weekly table): the Report's own columns, Monday to
// Sunday with the current week last, a session placed in the week of its last request as the Report places it. Sums add
// across sessions and across repositories; shares are taken again over each week's total.
const wcell = () => ({ cost: 0, tokens: 0, calls: 0, rework: 0, reworkTokens: 0 });
const lcell = () => ({ loops: 0, cost: 0, tokens: 0, calls: 0, sessions: 0 });
export function weeklyTally(cols) {
  const stages = Object.fromEntries(STAGE_KEYS.map(k => [k, cols.map(wcell)]));
  const loops = {}, loopSessions = {}, totals = cols.map(() => ({ cost: 0, tokens: 0, calls: 0, sessions: new Set() }));
  const week = t => cols.findIndex(c => t >= c.t && t < c.end);
  return {
    add(t, r, sessionId) {
      const w = week(t); if (w < 0) return;
      const tot = totals[w]; tot.cost += r.cost; tot.tokens += r.tokens; tot.calls += r.calls; tot.sessions.add(sessionId);
      for (const k of STAGE_KEYS) { const c = stages[k][w], x = r.stages[k]; for (const f of Object.keys(c)) c[f] += x[f] || 0; }
      for (const L of r.loops) {
        loops[L.kind] ||= cols.map(lcell); loopSessions[L.kind] ||= cols.map(() => new Set());
        const c = loops[L.kind][w]; c.loops++; c.cost += L.cost; c.tokens += L.tokens; c.calls += L.calls; loopSessions[L.kind][w].add(sessionId);
      }
    },
    finish() {
      for (const k in loops) loops[k].forEach((c, w) => { c.sessions = loopSessions[k][w].size; });
      return { columns: cols.map(c => ({ t: c.t, end: c.end })), totals: totals.map(t => ({ ...t, sessions: t.sessions.size })), stages, loops };
    },
  };
}
// All repositories: the same columns (every view is made against the same clock), the cells summed by column start
export function mergeWeekly(list) {
  const ws = list.filter(Boolean); if (!ws.length) return null;
  const columns = ws[0].columns, at = (w, t) => w.columns.findIndex(c => c.t === t);
  const sum = (pick, make) => columns.map((col, i) => { const out = make(); for (const w of ws) { const j = at(w, col.t); const c = j < 0 ? null : pick(w)?.[j]; if (c) for (const f of Object.keys(out)) out[f] += c[f] || 0; } return out; });
  const loopKeys = [...new Set(ws.flatMap(w => Object.keys(w.loops)))];
  return { columns, totals: sum(w => w.totals, () => ({ cost: 0, tokens: 0, calls: 0, sessions: 0 })), stages: Object.fromEntries(STAGE_KEYS.map(k => [k, sum(w => w.stages[k], wcell)])), loops: Object.fromEntries(loopKeys.map(k => [k, sum(w => w.loops[k], lcell)])) };
}

// --- by arm -------------------------------------------------------------------------------------------------------------
// The Factory split by a feature's two sides (2026-11-09, the owner's ask: "see diff by"): the sessions the feature reached
// against the ones held out from it, on the same mix of work. Two features carry a per-session arm: the session profile
// (`profile.js:profileArm`, recorded on the session's state file at its start; a session from before the profile shipped
// has none and is left out) and the clearing (`proxy.js:heldOut`, a hash of the session id against the service's share,
// so every session has a side). Raw sums per side; every ratio is taken where it is shown, as a ratio of sums, so All
// repositories can add the sides up. Sessions are the person's: a subagent conversation takes its parent's arm.
export const ARMS = {
  profile: { name: 'Memory profile', on: 'shown', off: 'holdout', onLabel: 'shown the profile', offLabel: 'held out' },
  compression: { name: 'Compression', on: 'on', off: 'holdout', onLabel: 'on the clearing', offLabel: 'held out', eligible: 'past the clearing\'s trigger' },
};
const armCell = () => ({ sessions: new Set(), costBy: new Map(), cost2: 0, exchanges: 0, calls: 0, cost: 0, tokens: 0, rework: 0, reworkTokens: 0, cacheWrite: 0, cacheRead: 0, treated: 0, stages: Object.fromEntries(STAGE_KEYS.map(k => [k, { cost: 0, tokens: 0, rework: 0, reworkTokens: 0 }])), loops: {}, loopSessions: {}, prs: { merged: 0, firstPass: 0, cost: 0 } });
export function armTally(share) {
  const t = { profile: { rate: null, shown: armCell(), holdout: armCell() }, compression: { rate: share, on: armCell(), holdout: armCell() } };
  const sideOf = (feature, arms) => arms[feature] ? t[feature][arms[feature]] : null;
  return {
    add(arms, r, sessionId) {
      for (const feature of Object.keys(ARMS)) {
        const c = sideOf(feature, arms); if (!c) continue;
        c.sessions.add(sessionId); c.exchanges += r.exchanges || 0; c.calls += r.calls; c.cost += r.cost; c.tokens += r.tokens; c.cacheWrite += r.cacheWrite || 0; c.cacheRead += r.cacheRead || 0;
        c.costBy.set(sessionId, (c.costBy.get(sessionId) || 0) + (r.cost > 0 ? r.cost : r.tokens / 1e6));
        if (feature === 'compression' && arms.cleared && !c.sessions.has(sessionId + '#t')) { c.treated++; c.sessions.add(sessionId + '#t'); }
        for (const k of STAGE_KEYS) { const x = r.stages[k], d = c.stages[k]; d.cost += x.cost; d.tokens += x.tokens; d.rework += x.rework; d.reworkTokens += x.reworkTokens; c.rework += x.rework; c.reworkTokens += x.reworkTokens; }
        for (const L of r.loops) { const d = c.loops[L.kind] ||= { loops: 0, cost: 0, tokens: 0, sessions: 0 }; d.loops++; d.cost += L.cost; d.tokens += L.tokens; (c.loopSessions[L.kind] ||= new Set()).add(sessionId); }
      }
    },
    pr(arms, firstPass, cost = 0) { for (const feature of Object.keys(ARMS)) { const c = sideOf(feature, arms); if (!c) continue; c.prs.merged++; c.prs.cost += cost || 0; if (firstPass) c.prs.firstPass++; } },
    finish() {
      // `cost2`, the sum of squared session costs, is what the trust level reads the spread from (armRows:trust)
      const fin = c => { for (const k in c.loops) c.loops[k].sessions = c.loopSessions[k].size; const { loopSessions, costBy, ...rest } = c; return { ...rest, cost2: [...costBy.values()].reduce((a, x) => a + x * x, 0), sessions: [...c.sessions].filter(x => !String(x).endsWith('#t')).length }; };
      return Object.fromEntries(Object.entries(t).map(([f, sides]) => [f, Object.fromEntries(Object.entries(sides).map(([k, v]) => [k, k === 'rate' ? v : fin(v)]))]));
    },
  };
}
export function mergeArms(list) {
  const as = list.filter(Boolean); if (!as.length) return null;
  const addCell = (a, b) => { for (const f of ['sessions', 'exchanges', 'calls', 'cost', 'tokens', 'rework', 'reworkTokens', 'cacheWrite', 'cacheRead', 'treated', 'cost2']) a[f] += b[f] || 0; for (const k of STAGE_KEYS) for (const f of Object.keys(a.stages[k])) a.stages[k][f] += b.stages[k]?.[f] || 0; for (const k in b.loops) { a.loops[k] ||= { loops: 0, cost: 0, tokens: 0, sessions: 0 }; for (const f of Object.keys(a.loops[k])) a.loops[k][f] += b.loops[k][f] || 0; } a.prs.merged += b.prs?.merged || 0; a.prs.firstPass += b.prs?.firstPass || 0; a.prs.cost += b.prs?.cost || 0; };
  const out = {};
  for (const feature of Object.keys(ARMS)) {
    const sides = { rate: as[0][feature]?.rate ?? null };
    for (const side of [ARMS[feature].on, ARMS[feature].off]) { const c = { ...armCell(), sessions: 0 }; delete c.loopSessions; delete c.costBy; for (const a of as) if (a[feature]?.[side]) addCell(c, a[feature][side]); sides[side] = c; }
    out[feature] = sides;
  }
  return out;
}
// what the clearing's share is on this machine (the service's flag, from the machine config)
function clearingShare() { try { const cfg = readMachineConfig(thinkerHome()).proxy || {}; return cfg.holdout == null ? SERVICE_HOLDOUT : Number(cfg.holdout) || 0; } catch { return SERVICE_HOLDOUT; } }
// a session's two arms: the profile's from its state file (null where none was recorded); the clearing's from the hash,
// and only for a session that reached the trigger (`peak`), since below it neither side is touched and the split would
// compare two samples of untouched sessions (2026-11-09: 230 of 249 "cleared" sessions had never had a clear). `cleared`
// says whether a clear actually happened, read off the proxy's record of the session (compression.js:noteCompression).
export const CLEARING_TRIGGER = PROXY_DEFAULTS.trigger;
export function armsOf(store, session, share, { peak = Infinity, home = null } = {}) {
  let profile = null; try { profile = profileArmOf(store, session); } catch {}
  const eligible = share > 0 && peak >= CLEARING_TRIGGER;
  let cleared = false; if (eligible && home) { try { cleared = fs.statSync(path.join(home, 'state', 'compression', `${session}.json`)).size > 2; } catch {} }
  return { profile: profile === 'shown' || profile === 'holdout' ? profile : null, compression: eligible ? (heldOut(session, share) ? 'holdout' : 'on') : null, cleared };
}

// --- the view ---------------------------------------------------------------------------------------------------------
// the cache key carries the detectors' version: a changed rule must read every session again, not serve the old loops
export const RULES_VERSION = 7; // 7: a fix loop closes at a commit, a denial or a crashed heredoc is no failure, a continuation's copied history is dropped
const CACHE = diskCache('factory-session', 1);
const parentOf = s => s.parent || s.session;
// the ledger's corrected and redirected exchanges, by session (profile.js: a row's `turn` is the exchange it observed,
// and the correction arrived as the prompt after it)
function correctedBySession(store, { days, now }) {
  const by = new Map();
  let rows = []; try { rows = readLedger(store, { days, now }); } catch { return by; }
  for (const r of rows) if (['corrected', 'redirected'].includes(r.outcome) && r.session && Number.isInteger(r.turn)) { if (!by.has(r.session)) by.set(r.session, new Set()); by.get(r.session).add(r.turn); }
  return by;
}

export function factoryView(store, { weeks, days, now = Date.now(), sessions, onSession } = {}) {
  weeks ??= days ? Math.max(1, Math.ceil(days / 7)) : REPORT_WEEKS;
  const cols = weekColumns(now, weeks), from = cols[0].t;
  days = Math.ceil((now - from) / 86400_000) + 1;
  const weekly = weeklyTally(cols), share = clearingShare(), arms = armTally(share), armOf = new Map();
  sessions ??= findRepoSessions(store.repo, days);
  sessions = sessions.filter(s => s.mtime >= from);
  const all = sessions.concat(subagentSessions(sessions).filter(s => s.mtime >= from));
  const continued = continuations(all); // a session continued in a new one: the copy's history is read once, as the original's
  const config = (() => { try { return store.config(); } catch { return {}; } })();
  const corrected = correctedBySession(store, { days, now });
  const stages = Object.fromEntries(STAGE_KEYS.map(k => [k, { cost: 0, tokens: 0, calls: 0, rework: 0, reworkTokens: 0 }]));
  const kinds = new Map(), perSession = new Map();
  let cost = 0, tokens = 0, calls = 0, measured = 0, unpriced = new Set();
  for (const s of all) {
    let r;
    try {
      r = cachedByFiles(CACHE, cacheKey('factory', String(RULES_VERSION), s.file, s.parent || '', [...(corrected.get(s.session) || [])].join(','), String(continued.get(s.session)?.at || '')), [s.file], () => {
        let p = parseTranscript(s.file);
        if (continued.has(s.session)) p = afterContinuation(p, continued.get(s.session).at);
        if (!p.calls?.length || /auto-review/i.test(String(p.model || ''))) return null;
        const price = listPrice(p.model, { config });
        return { ...sessionFactory(p, { price, corrected: corrected.get(s.session) || new Set() }), model: p.model || null };
      });
    } catch { r = null; }
    onSession?.(s);
    if (!r) continue;
    measured++; calls += r.calls; cost += r.cost; tokens += r.tokens;
    weekly.add(s.mtime, r, parentOf(s));
    if (!s.parent) armOf.set(s.session, armsOf(store, s.session, share, { peak: r.peak, home: thinkerHome() }));
    if (armOf.has(parentOf(s))) arms.add(armOf.get(parentOf(s)), r, parentOf(s));
    if (!r.priced) unpriced.add(r.model || 'unknown');
    for (const k of STAGE_KEYS) for (const f of ['cost', 'tokens', 'calls', 'rework', 'reworkTokens']) stages[k][f] += r.stages[k][f];
    const id = parentOf(s), agg = perSession.get(id) || { id, t: s.mtime, cost: 0, tokens: 0, calls: 0, loops: {}, model: r.model };
    agg.cost += r.cost; agg.tokens += r.tokens; agg.calls += r.calls; agg.t = Math.max(agg.t, s.mtime);
    for (const L of r.loops) {
      agg.loops[L.kind] = (agg.loops[L.kind] || 0) + 1;
      const k = kinds.get(L.kind) || { key: L.kind, ...LOOP_KINDS[L.kind], loops: 0, cost: 0, tokens: 0, calls: 0, sessionIds: new Set() };
      k.loops++; k.cost += L.cost; k.tokens += L.tokens; k.calls += L.calls; k.sessionIds.add(id); kinds.set(L.kind, k);
    }
    perSession.set(id, agg);
  }
  const total = cost > 0 ? cost : tokens, of = x => total ? x / total : null;
  const stageRows = STAGES.map(([key, name, desc]) => { const s = stages[key]; const base = cost > 0 ? s.cost : s.tokens, rw = cost > 0 ? s.rework : s.reworkTokens; return { key, name, desc, ...s, calls: Math.round(s.calls), share: of(base), reworkShare: base > 0 ? rw / base : null, verdict: verdictOf(base > 0 ? rw / base : null) }; });
  const loops = [...kinds.values()].map(k => ({ ...k, sessionIds: undefined, sessions: k.sessionIds.size, share: of(cost > 0 ? k.cost : k.tokens) })).sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
  const rework = loops.reduce((a, k) => a + k.cost, 0), reworkTokens = loops.reduce((a, k) => a + k.tokens, 0);
  // the pull requests: merged in the window with a session here, first pass when none of their sessions looped
  let prs = null;
  try {
    const d = deliveryReport(store, { days, now });
    const rows = d.prs.filter(p => p.mergedAt && p.mergedAt >= new Date(from).toISOString() && p.sessions.length).map(p => {
      const mine = p.sessions.map(x => ({ ...x, f: perSession.get(x.id) })).filter(x => x.f);
      const loopsBy = {}; for (const x of mine) for (const [k, n] of Object.entries(x.f.loops)) loopsBy[k] = (loopsBy[k] || 0) + n;
      const n = Object.values(loopsBy).reduce((a, b) => a + b, 0);
      const prArms = {}; for (const feature of Object.keys(ARMS)) { const sides = new Set(mine.map(x => armOf.get(x.id)?.[feature]).filter(Boolean)); prArms[feature] = sides.size === 1 ? [...sides][0] : null; }
      const prCost = mine.reduce((a, x) => a + x.f.cost * (x.share ?? 1), 0);
      if (mine.length) arms.pr(prArms, n === 0, prCost);
      return { number: p.number, title: p.title || '', url: p.url || null, mergedAt: p.mergedAt, hours: p.hoursToMerge ?? null, sessions: p.sessions.length, measured: mine.length, cost: prCost, loops: loopsBy, loopCount: n, firstPass: mine.length > 0 && n === 0 };
    }).sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt)));
    const first = rows.filter(r => r.firstPass), looped = rows.filter(r => r.measured && !r.firstPass);
    const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    prs = { merged: rows.length, measured: rows.filter(r => r.measured).length, firstPass: first.length, yield: rows.filter(r => r.measured).length ? first.length / rows.filter(r => r.measured).length : null, meanCost: mean(rows.filter(r => r.measured).map(r => r.cost)), meanCostFirstPass: mean(first.map(r => r.cost)), meanCostLooped: mean(looped.map(r => r.cost)), rows };
  } catch { prs = null; }
  return {
    days, from, to: now, sessions: perSession.size, conversations: measured, calls, cost, tokens, priced: unpriced.size === 0, unpriced: [...unpriced],
    stages: stageRows, loops, rework, reworkTokens, reworkShare: of(cost > 0 ? rework : reworkTokens), thresholds: REWORK_THRESHOLDS,
    prs,
    weekly: weekly.finish(),
    arms: arms.finish(),
  };
}

// All repositories: sums add (a call belongs to one repository), the shares and verdicts are taken again over the sum,
// the loop kinds join by key, and the pull request rows concatenate with their repository on them
export function mergeFactory(list) {
  const views = list.map(x => ({ v: x.view?.factory, repo: x.repo, name: x.name })).filter(x => x.v);
  if (!views.length) return null;
  const sum = f => views.reduce((a, x) => a + (f(x.v) || 0), 0);
  const cost = sum(v => v.cost), tokens = sum(v => v.tokens), total = cost > 0 ? cost : tokens, of = x => total ? x / total : null;
  const stages = STAGES.map(([key, name, desc]) => {
    const s = { cost: 0, tokens: 0, calls: 0, rework: 0, reworkTokens: 0 };
    for (const x of views) { const r = x.v.stages.find(z => z.key === key); if (r) for (const f of Object.keys(s)) s[f] += r[f] || 0; }
    const base = cost > 0 ? s.cost : s.tokens, rw = cost > 0 ? s.rework : s.reworkTokens;
    return { key, name, desc, ...s, share: of(base), reworkShare: base > 0 ? rw / base : null, verdict: verdictOf(base > 0 ? rw / base : null) };
  });
  const kinds = new Map();
  for (const x of views) for (const k of x.v.loops) { const m = kinds.get(k.key) || { ...k, loops: 0, cost: 0, tokens: 0, calls: 0, sessions: 0 }; m.loops += k.loops; m.cost += k.cost; m.tokens += k.tokens; m.calls += k.calls; m.sessions += k.sessions; kinds.set(k.key, m); }
  const loops = [...kinds.values()].map(k => ({ ...k, share: of(cost > 0 ? k.cost : k.tokens) })).sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
  const rework = loops.reduce((a, k) => a + k.cost, 0), reworkTokens = loops.reduce((a, k) => a + k.tokens, 0);
  const rows = views.flatMap(x => (x.v.prs?.rows || []).map(r => ({ ...r, repo: x.repo, repoName: x.name }))).sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt)));
  const measured = rows.filter(r => r.measured), first = measured.filter(r => r.firstPass), looped = measured.filter(r => !r.firstPass);
  const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  const first_ = views[0].v;
  return {
    all: true, days: first_.days, from: Math.min(...views.map(x => x.v.from)), to: Math.max(...views.map(x => x.v.to)),
    sessions: sum(v => v.sessions), conversations: sum(v => v.conversations), calls: sum(v => v.calls), cost, tokens, priced: views.every(x => x.v.priced), unpriced: [...new Set(views.flatMap(x => x.v.unpriced))],
    stages, loops, rework, reworkTokens, reworkShare: of(cost > 0 ? rework : reworkTokens), thresholds: REWORK_THRESHOLDS,
    prs: views.some(x => x.v.prs) ? { merged: rows.length, measured: measured.length, firstPass: first.length, yield: measured.length ? first.length / measured.length : null, meanCost: mean(measured.map(r => r.cost)), meanCostFirstPass: mean(first.map(r => r.cost)), meanCostLooped: mean(looped.map(r => r.cost)), rows } : null,
    weekly: mergeWeekly(views.map(x => x.v.weekly)),
    arms: mergeArms(views.map(x => x.v.arms)),
    repos: views.map(x => ({ repo: x.repo, name: x.name })),
  };
}

// --- the command's print ------------------------------------------------------------------------------------------------
const pct = x => x == null ? '–' : `${Math.round(100 * x)}%`;
const money = d => d == null ? '–' : d >= 100 ? `$${Math.round(d)}` : d >= 10 ? `$${d.toFixed(1)}` : `$${d.toFixed(2)}`;
const k = n => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n));
export function renderFactory(v, opts = {}) {
  if (!v) return ['No factory view yet: run thinker report to make one.'];
  const dollars = v.cost > 0, amount = s => dollars ? money(s.cost) : `${k(s.tokens)} tokens`;
  const out = [];
  out.push(`Software factory · ${v.sessions} sessions, ${k(v.calls)} model calls over ${v.days} days${dollars ? `, ${money(v.cost)} at list prices` : `, ${k(v.tokens)} tokens`}${v.unpriced?.length ? ` (unpriced: ${v.unpriced.join(', ')})` : ''}`);
  if (v.prs) out.push(`Merged pull requests: ${v.prs.merged} · first-pass yield ${pct(v.prs.yield)} (${v.prs.firstPass} of ${v.prs.measured} measured) · ${money(v.prs.meanCostFirstPass)} a first-pass PR, ${money(v.prs.meanCostLooped)} a looped one`);
  out.push(`Rework: ${dollars ? money(v.rework) : `${k(v.reworkTokens)} tokens`}, ${pct(v.reworkShare)} of all tokens, in ${v.loops.length} loop kind${v.loops.length === 1 ? '' : 's'}`, '');
  out.push('Stage          Cost      Share   Rework   Verdict   Calls');
  for (const s of v.stages) out.push(`${s.name.padEnd(14)} ${amount(s).padStart(9)} ${pct(s.share).padStart(7)} ${pct(s.reworkShare).padStart(8)}   ${(s.verdict === 'mid' ? 'watch' : s.verdict || '–').padEnd(8)} ${String(s.calls).padStart(6)}`);
  out.push('', 'Loops detected: work that came back to an earlier stage after something failed; rework is what they cost');
  if (!v.loops.length) out.push('  none in this window');
  for (const L of v.loops) out.push(`  ${L.name.padEnd(13)} ${L.from} → ${L.to}`.padEnd(40) + ` ${String(L.loops).padStart(4)} loops in ${String(L.sessions).padStart(3)} sessions ${(dollars ? money(L.cost) : `${k(L.tokens)} tokens`).padStart(10)} ${pct(L.share).padStart(5)}   ${L.rule}`);
  if (v.weekly?.columns?.length) {
    const wk = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    out.push('', 'By week (the trend the page opens on a stage or a loop): cost, then its rework share');
    out.push('Stage'.padEnd(14) + v.weekly.columns.map(c => wk(c.t).padStart(14)).join(''));
    for (const [key, name] of STAGES) out.push(name.padEnd(14) + v.weekly.stages[key].map(c => { const base = dollars ? c.cost : c.tokens, rw = dollars ? c.rework : c.reworkTokens; return `${dollars ? money(c.cost) : k(c.tokens)} ${base > 0 ? pct(rw / base) : '–'}`.padStart(14); }).join(''));
    for (const L of v.loops) if (v.weekly.loops[L.key]) out.push(L.name.padEnd(14) + v.weekly.loops[L.key].map(c => `${c.loops} loops ${dollars ? money(c.cost) : k(c.tokens)}`.padStart(14)).join(''));
  }
  if (opts.diff && v.arms?.[opts.diff]) out.push('', ...renderArms(v, opts.diff));
  if (v.prs?.rows?.length) {
    out.push('', 'Pull requests, newest first (a loop count per kind)');
    for (const r of v.prs.rows.slice(0, 12)) out.push(`  #${String(r.number).padEnd(5)} ${(r.title || '').slice(0, 54).padEnd(54)} ${money(r.cost).padStart(8)}  ${r.firstPass ? 'first pass' : Object.entries(r.loops).map(([kind, n]) => `${n} ${LOOP_KINDS[kind]?.name?.toLowerCase() || kind}`).join(', ') || (r.measured ? '' : 'no transcript measured')}`);
    if (v.prs.rows.length > 12) out.push(`  … ${v.prs.rows.length - 12} more; thinker ui --tab factory lists them`);
  }
  out.push('', "A call's tokens go to the stage of the tool it called; the first call after a prompt is Prompts; a call with no tool is Think. Rework is the cost of the calls inside a loop, spent after a failure. A stage is good at or under 10% rework, bad at or over 35%.");
  return out;
}

// How far to trust a difference between the two sides (the owner, 2026-11-09: "thin" said too little). The sides are
// random samples of sessions, so the question is how much two means would differ by chance: the relative standard error
// of a ratio of the two means is sqrt(cv_on²/n_on + cv_off²/n_off), with each side's coefficient of variation read from
// its session costs (`cost2`), and the noise band is twice that. A row whose difference sits inside the band is shown
// as flat, whatever its sign. The level is the band: under 20% good, under 50% fair, else low; under ten sessions on a
// side, too few to read at all. Session cost is the spread used for every row, since the loop and rework figures are
// not carried per session; it is the widest of them, so the band errs on the side of doubt.
export function trust(on, off) {
  const n = Math.min(on.sessions, off.sessions);
  const cv = c => { if (!c.sessions) return null; const mean = c.cost / c.sessions; if (!mean) return null; const varr = Math.max(0, c.cost2 / c.sessions - mean * mean); return Math.sqrt(varr) / mean; };
  const a = cv(on), b = cv(off);
  const se = a == null || b == null ? null : Math.sqrt((a * a) / on.sessions + (b * b) / off.sessions);
  const band = se == null ? null : 2 * se;
  const level = n < 10 || band == null ? 'none' : band < 0.2 ? 'good' : band < 0.5 ? 'fair' : 'low';
  // a row over fewer units than the sessions (the pull requests) takes its band from its own counts, the same spread
  const bandFor = (nOn, nOff) => a == null || b == null || !nOn || !nOff ? null : 2 * Math.sqrt((a * a) / nOn + (b * b) / nOff);
  return { level, band, smaller: n, cv: { on: a, off: b }, bandFor };
}
export const TRUST_WORDS = { none: 'too few sessions to read', low: 'low: a direction at most', fair: 'fair', good: 'good' };
// the two sides of a feature, as the page's comparison table: ratios of sums, the held-out side second, the difference last
export function armRows(v, feature) {
  const spec = ARMS[feature], a = v.arms?.[feature]; if (!spec || !a) return null;
  const on = a[spec.on], off = a[spec.off], dollars = v.cost > 0;
  const r = (num, den) => den ? num / den : null;
  const rows = [
    { label: spec.eligible ? `Sessions ${spec.eligible}` : 'Sessions', on: on.sessions, off: off.sessions, kind: 'count' },
    ...(feature === 'compression' ? [{ label: 'Of them actually cleared', on: on.treated, off: off.treated, kind: 'count' }] : []),
    { label: dollars ? 'Cost per exchange' : 'Tokens per exchange', on: r(dollars ? on.cost : on.tokens, on.exchanges), off: r(dollars ? off.cost : off.tokens, off.exchanges), kind: dollars ? 'money' : 'tokens', lowerIsBetter: true },
    { label: 'Cache writes, share of cache traffic', on: r(on.cacheWrite, on.cacheWrite + on.cacheRead), off: r(off.cacheWrite, off.cacheWrite + off.cacheRead), kind: 'pct', lowerIsBetter: true },
    { label: dollars ? 'Cost per session' : 'Tokens per session', on: r(dollars ? on.cost : on.tokens, on.sessions), off: r(dollars ? off.cost : off.tokens, off.sessions), kind: dollars ? 'money' : 'tokens', lowerIsBetter: true },
    { label: 'Rework share', on: r(dollars ? on.rework : on.reworkTokens, dollars ? on.cost : on.tokens), off: r(dollars ? off.rework : off.reworkTokens, dollars ? off.cost : off.tokens), kind: 'pct', lowerIsBetter: true },
    { label: dollars ? 'Cost per merged pull request' : 'Tokens per merged pull request', on: r(on.prs.cost, on.prs.merged), off: r(off.prs.cost, off.prs.merged), kind: dollars ? 'money' : 'tokens', lowerIsBetter: true, n: [on.prs.merged, off.prs.merged], note: `${on.prs.merged} and ${off.prs.merged} merged pull requests whose sessions were all on one side` },
    { label: 'First-pass yield', on: r(on.prs.firstPass, on.prs.merged), off: r(off.prs.firstPass, off.prs.merged), kind: 'pct', lowerIsBetter: false, n: [on.prs.merged, off.prs.merged] },
  ];
  for (const [key, name] of STAGES) rows.push({ label: `${name} rework`, group: 'stages', key, on: r(dollars ? on.stages[key].rework : on.stages[key].reworkTokens, dollars ? on.stages[key].cost : on.stages[key].tokens), off: r(dollars ? off.stages[key].rework : off.stages[key].reworkTokens, dollars ? off.stages[key].cost : off.stages[key].tokens), kind: 'pct', lowerIsBetter: true });
  for (const L of v.loops) rows.push({ label: `${L.name} per session`, group: 'loops', key: L.key, on: r(on.loops[L.key]?.loops || 0, on.sessions), off: r(off.loops[L.key]?.loops || 0, off.sessions), kind: 'rate', lowerIsBetter: true });
  const t = trust(on, off);
  for (const row of rows) { const d = row.lowerIsBetter == null || row.on == null || row.off == null || !row.off ? null : (row.on - row.off) / row.off, band = row.n ? t.bandFor(row.n[0], row.n[1]) : t.band; row.diff = d; row.band = band; row.verdict = d == null ? null : (band == null || (row.n && Math.min(...row.n) < 10)) ? 'flat' : Math.abs(d) < band ? 'flat' : (d < 0) === row.lowerIsBetter ? 'good' : 'bad'; }
  return { feature, name: spec.name, onLabel: spec.onLabel, offLabel: spec.offLabel, rate: a.rate, rows, trust: t, thin: t.level === 'none' };
}
export function renderArms(v, feature) {
  const t = armRows(v, feature); if (!t) return [];
  const f = (x, kind) => x == null ? '–' : kind === 'money' ? money(x) : kind === 'pct' ? pct(x) : kind === 'rate' ? x.toFixed(2) : kind === 'tokens' ? k(x) : String(Math.round(x));
  const out = [`${t.name}: ${t.onLabel} against ${t.offLabel}${t.rate != null ? ` (${pct(t.rate)} of sessions held out)` : ''}`];
  out.push(`Trust: ${TRUST_WORDS[t.trust.level]}. The smaller side has ${t.trust.smaller} sessions${t.trust.band != null ? `; a difference under ±${Math.round(100 * t.trust.band)}% is within what two random samples of these sessions would show, and is marked flat` : ''}.`);
  out.push(''.padEnd(26) + t.onLabel.padStart(14) + t.offLabel.padStart(14) + 'difference'.padStart(13));
  for (const r of t.rows) { const d = r.diff; out.push(r.label.padEnd(26) + f(r.on, r.kind).padStart(14) + f(r.off, r.kind).padStart(14) + (d == null ? '–' : `${d > 0 ? '+' : ''}${Math.round(100 * d)}%${r.verdict === 'flat' ? ' ~' : r.verdict === 'good' ? ' ✓' : ' ✗'}`).padStart(15) + (r.note ? `   ${r.note}` : '')); }
  return out;
}
