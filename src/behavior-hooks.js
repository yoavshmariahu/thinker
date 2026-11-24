// The agent's state, held by the hooks (2026-11-23, the owner's design; behaviors.js is the graph it reads).
//
// "I don't think rules are sufficient for determinism. We need this to be at the hook level." So nothing here
// is a line in an instruction file that a model may or may not recall. A session is in one of three modes, and
// the hooks move it between them on what the agent does, not on what it says:
//
//   explore --first edit of a code or test file--> EDIT --first test run--> VERIFY --tests green--> explore
//                                                    ^----------- an edit after a run ------------'
//
//   - Entering EDIT, the agent is handed the structure to build around (`EDIT_RULES`) and what the file it is
//     about to change holds. It arrives with the edit's own result, so it is the newest thing in the context
//     at the moment it matters. Every edit after that is checked as it would land (`checkFile` over the lines
//     it changes) and refused, with the fix, where it breaks a rule: a test that names no behavior, code tied
//     to none, an id that is not in BEHAVIORS.md yet. That last one makes the order of work a fact: the
//     behavior is named first, then its code, then its test.
//   - Entering VERIFY, the agent is handed what its edits did to the graph (behaviors modified, added, deleted)
//     and the tests that hold them, as one command. A whole-suite run is refused in favour of that command.
//   - At the end of the turn the hook reads for itself whether those tests passed after the last edit (the
//     transcript's own result of the very call it saw start), and holds the turn until they have and nothing
//     is owed to the graph. It holds once for any one reason: an agent that cannot do it says so and stops.
//
// The injection is deterministic and what the agent does with it is not, which is why each mode has a check on
// the way out. Claude Code only so far (its PreToolUse can refuse a call or add to its result, its Stop can
// hold a turn). Silent in a repository with no BEHAVIORS.md, and off until `behaviors: { enabled: true }`.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readMachineConfig } from './repo-switch.js';
import { sessionState, locked } from './session-state.js';
import { suiteCommand } from './delegate.js';
import { BEHAVIORS_FILE, PLUMBING, parseTree, readTree, isCode, isTest, scan, tagAt, checkFile, sayViolation, editOf, changedLines, baseOf, readGraph, commentOf } from './behaviors.js';

export const BEHAVIORS_DEFAULTS = Object.freeze({ enabled: false });
export function behaviorsConfig({ home } = {}) {
  let c; try { c = readMachineConfig(home).behaviors; } catch {}
  if (typeof c === 'boolean') c = { enabled: c };
  return { ...BEHAVIORS_DEFAULTS, ...(c && typeof c === 'object' ? c : {}) };
}
/** The tools the PreToolUse entry has to see for this, beside whatever else is wired on it (clients.js). */
export const BEHAVIORS_TOOLS = ['Edit', 'Write', 'MultiEdit', 'Bash'];
const RUNS_KEPT = 30;

// ---- the words. On a door that can only refuse or add a note, the words are the mechanism (delegate.js) ----
export const EDIT_RULES = `thinker: this repository is built around named behaviors (${BEHAVIORS_FILE}). Hold to that structure while you edit:
- Code sits under the behavior it implements. A comment line \`behavior: <id>\` covers everything beneath it until the next one; \`behavior: none\` marks plumbing that is no behavior.
- A top-level id in ${BEHAVIORS_FILE} is a feature; everything beneath one is a behavior, and a behavior may have sub-behaviors.
- A new behavior is named in ${BEHAVIORS_FILE} first, as \`- feature.behavior: one sentence\` beneath its parent. Then its code goes under its id, then one light test.
- A test proves exactly one behavior, named by the same comment line above it. A test that runs a whole feature is an end-to-end test: it names the feature and lives under e2e/.
- A behavior you remove comes out of ${BEHAVIORS_FILE} together with its code and its tests.
An edit that breaks these is refused with the fix. When you run tests, thinker names the ones this change needs.`;
const REFUSED_EDIT = `thinker did not make this edit: it breaks the repository's behavior structure (${BEHAVIORS_FILE}).`;
const REFUSED_SUITE = 'thinker did not run the whole suite: this change is verified by the behaviors it touched.';
const VERIFY_LEAD = 'thinker: verify this change by the behaviors it touched.';
const HELD = 'thinker: this turn is not finished.';

/** What a file holds, in a line or two: the behaviors its code sits under, or the ones its tests prove. */
export function fileMap(rel, text, tree) {
  if (rel === BEHAVIORS_FILE) return '';
  const s = scan(rel, text), c = commentOf(rel);
  if (!s.tags.length) return `${rel} ${isTest(rel) ? 'names no behavior yet: each test' : 'is tied to no behavior yet: the code'} you write or change there needs a \`${c} behavior: <id>\` line above it.`;
  let head;
  if (isTest(rel)) {
    const n = new Map(); for (const t of s.tests) { const tag = tagAt(s.tags, t.line); if (tag) n.set(tag.id, (n.get(tag.id) || 0) + 1); }
    head = `${rel} proves: ${[...n].map(([id, k]) => `${id} (${k} test${k === 1 ? '' : 's'})`).join(', ') || 'nothing yet'}.`;
  } else {
    // code above the first tag belongs to nothing; imports and comments there are nobody's and go unsaid
    const first = s.lines.findIndex(l => l.trim() && !PLUMBING.test(l)) + 1;
    head = `${rel} holds: ${s.tags.map((t, i) => `${t.id} (lines ${t.line}-${(s.tags[i + 1]?.line ?? s.lines.length + 1) - 1})`).join(', ')}.`
      + (first && first < s.tags[0].line ? ` The code above line ${s.tags[0].line} is under no behavior.` : '');
  }
  const said = [...new Set(s.tags.map(t => t.id))].filter(id => tree.nodes.has(id)).slice(0, 6).map(id => `  ${id}: ${tree.nodes.get(id).text}`);
  return [head, ...said].join('\n');
}

/** What the agent is told on entering VERIFY, on a refused suite run and on a held turn: one set of words. */
export function verifyWords(g, { lead = VERIFY_LEAD, state = '' } = {}) {
  const { changes: ch, selection: sel } = g, L = [lead];
  if (state) L.push(state);
  const rows = [
    ...ch.modified.map(id => `  modified       ${id}  (${[...ch.touched.get(id).files].join(', ')})`),
    ...ch.added.map(id => `  added          ${id}`), ...ch.deleted.map(id => `  deleted        ${id}`),
    ...ch.tests.map(id => `  tests changed  ${id}`),
  ];
  if (rows.length) L.push('This session\'s edits did this to the behaviors:', ...rows);
  if (sel.tests.length) {
    L.push('The tests that hold them:', ...sel.tests.map(t => `  ${t.rel}${t.e2e ? '  [end-to-end]' : ''}  ${t.why.map(w => (w.as === 'own' ? w.id : `${w.id} (${w.as})`)).join('; ')}`));
    L.push('Run exactly:', `  ${g.command || sel.files.join(' ')}`, 'Run it bare, with no pipe and no `|| true`: thinker reads the runner\'s own result. The rest of the suite is not needed for this change.');
  } else if (rows.length) L.push('No test names any of them yet.');
  if (sel.problems.length) L.push('Owed before this turn can end:', ...sel.problems.map(p => `  - ${p}`));
  L.push(sel.tests.length ? 'The turn ends once these tests have passed with no edit after them.' : 'The turn ends once nothing is owed.');
  return L.join('\n');
}

// ---- recognising a test run ----
const RUNNER = /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::[\w:-]+)?\b|(?:(?:npx|bunx|pnpm\s+exec|yarn)\s+)?(?:jest|vitest|mocha|ava)\b|(?:npx\s+)?playwright\s+test\b|node\s+(?:\S+\s+)*?--test\b|(?:uv\s+run\s+)?(?:\S*\/)?(?:python[\d.]*\s+-m\s+)?pytest\b|go\s+test\b|cargo\s+(?:nextest\s+run|test)\b|deno\s+test\b|dotnet\s+test\b|swift\s+test\b|(?:bundle\s+exec\s+)?rspec\b|(?:\.\/)?gradlew?\s+\S*[tT]est\b|mvn\s+\S*test\b|make\s+(?:test|check)\b|phpunit\b)/;
const unquoted = cmd => cmd.replace(/(['"])(?:\\.|(?!\1)[^\\])*\1/g, m => m[0] + '_'.repeat(Math.max(0, m.length - 2)) + m[0]);
const stripped = seg => seg.trim().replace(/^(?:(?:env|time|command)\s+)*(?:\w+=\S*\s+)*/, '');
// a line's commands, each as it was typed (`text`) and with its quoted text blanked (`plain`), so that a `;` or
// a `|` inside a string is not taken for the shell's own
function segments(cmd) {
  const plain = unquoted(cmd), cuts = [];
  let from = 0;
  for (const m of plain.matchAll(/&&|;|\n/g)) { cuts.push([from, m.index]); from = m.index + m[0].length; }
  cuts.push([from, plain.length]);
  return cuts.map(([x, y]) => ({ plain: plain.slice(x, y), text: cmd.slice(x, y) })).filter(g => g.plain.trim());
}
/**
 * A shell line that runs tests: `{ suite, own, args, cd }`, or null. `suite` is the whole suite with no path of
 * its own (delegate.js's own detector); `own` is whether the line's exit code is the runner's, which a pipe, an
 * `||` or a command after it takes away -- and a result that is not the runner's cannot count as a pass. `args`
 * is what follows the runner's own words, and `cd` the directory the line moved to first.
 */
export function testRunOf(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return null;
  const segs = segments(cmd), i = segs.findIndex(g => RUNNER.test(stripped(g.plain)));
  if (i < 0) return null;
  const text = stripped(segs[i].text), cd = segs.slice(0, i).map(g => g.text.trim().match(/^cd\s+(.+)$/)).filter(Boolean).pop();
  return {
    suite: Boolean(suiteCommand('Bash', { command: cmd })),
    // `2>&1` sends the errors along and changes no exit code; a pipe, an `||` or a `&` after it does
    own: i === segs.length - 1 && !/[|&]/.test(segs[i].plain.replace(/\d*>&\d+|&>>?/g, '')),
    args: text.slice(text.match(RUNNER)[0].length).replace(/\s*(?:\d*>&\d+|[|&>]).*$/s, ''),
    cd: cd ? cd[1].trim().replace(/^(['"])(.*)\1$/, '$2') : null,
  };
}
/** Which of `files` a test run names, as a path or as a directory above one, from wherever the line runs. */
export function namedIn(run, files, repo, cwd = repo) {
  const from = run.cd ? path.resolve(cwd, run.cd) : cwd;
  const words = run.args.split(/\s+/).map(w => w.replace(/^['"]|['"]$/g, '').replace(/\/\.\.\.$/, '')).filter(w => w && !w.startsWith('-'))
    .map(w => path.relative(repo, path.resolve(from, w)).split(path.sep).join('/'));
  return files.filter(f => words.some(w => w === f || (w && !w.startsWith('..') && f.startsWith(`${w}/`))));
}

/** The results of the tool calls named, read from the tail of Claude Code's transcript: id -> { error }. */
export function resultsOf(transcript, ids, { tail = 8e6 } = {}) {
  const out = new Map();
  if (!transcript || !ids.size) return out;
  let text = '';
  try {
    const fd = fs.openSync(transcript, 'r');
    try { const size = fs.fstatSync(fd).size, from = Math.max(0, size - tail), buf = Buffer.alloc(size - from); fs.readSync(fd, buf, 0, buf.length, from); text = buf.toString('utf8'); } finally { fs.closeSync(fd); }
  } catch { return out; }
  for (const line of text.split('\n')) {
    if (!line.includes('tool_result')) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const content = j?.message?.content;
    if (Array.isArray(content)) for (const b of content) if (b?.type === 'tool_result' && ids.has(b.tool_use_id)) out.set(b.tool_use_id, { error: b.is_error === true });
  }
  return out;
}
/**
 * Whether the selected tests have passed since the last edit. A run counts when the hook saw it start with
 * the files exactly as they are now (`sig`), its exit code was the runner's own, and the transcript says it
 * did not fail. Several runs may cover the selection between them.
 */
export function verified(runs = [], sig, files, transcript) {
  const mine = runs.filter(r => r.sig === sig && r.id);
  const res = resultsOf(transcript, new Set(mine.map(r => r.id)));
  const green = mine.filter(r => r.own && res.get(r.id)?.error === false);
  const covered = new Set(green.flatMap(r => r.files));
  const missing = files.filter(f => !covered.has(f));
  return { ok: !missing.length, missing, red: mine.filter(r => res.get(r.id)?.error === true).length, piped: mine.filter(r => !r.own).length, ran: mine.length };
}

const allow = context => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } });
const deny = reason => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
const countsOf = g => ({ modified: g.changes.modified.length, added: g.changes.added.length, deleted: g.changes.deleted.length, tests: g.selection.files.length, owed: g.selection.problems.length });
const on = ({ cfg, client, session, repo }) => cfg.enabled && client === 'claude' && session && session !== 'unknown' && fs.existsSync(path.join(repo, BEHAVIORS_FILE));
// one look at the session's state under its lock; `fn` gets the behaviors block and the turn it is in
function withState(store, session, ev, fn) {
  return locked(store, session, () => {
    const { st, save } = sessionState(store, session);
    const b = st.behaviors || (st.behaviors = { mode: 'explore' });
    const out = fn(b, ev.prompt_id || st.turnNo || 0);
    save();
    return out;
  });
}

/**
 * PreToolUse. An edit of a code file, a test file or BEHAVIORS.md is checked as it would land and refused where
 * it breaks the structure; the first one of a turn enters EDIT and carries the rules. A test run enters VERIFY
 * and is told, or refused in favour of, the tests the session's edits need. Returns the host's JSON, or null
 * where the call simply goes through.
 */
export function behaviorsPreTool({ ev, store, session, repo, cfg = behaviorsConfig(), client = 'claude', log = row => store.log(row) }) {
  const tool = ev.tool_name, input = ev.tool_input || {};
  if (!BEHAVIORS_TOOLS.includes(tool) || !on({ cfg, client, session, repo })) return null;
  const who = ev.agent_id || ev.agent_type || '';
  return withState(store, session, ev, (b, turnNo) => {
    // what the session's changes are counted from: the commit it started on, taken before its first edit lands
    if (!b.base) b.base = baseOf(repo);
    const row = r => log({ op: 'behaviors', session, client, ...r });
    if (tool === 'Bash') {
      const run = testRunOf(input.command);
      if (!run) return null;
      const g = readGraph(repo, b.base), sel = g.selection;
      if (!sel.direct.length && !sel.problems.length) return null; // the edits touched no behavior: the run is the agent's own
      const from = b.mode; b.mode = 'verify';
      if (run.suite && sel.files.length) { row({ at: 'test', decision: 'deny', from, ...countsOf(g) }); return deny(verifyWords(g, { lead: REFUSED_SUITE })); }
      if (run.suite) return null; // nothing to narrow it to
      const named = namedIn(run, sel.files, repo, ev.cwd || repo);
      b.runs = [...(b.runs || []), { id: ev.tool_use_id || null, sig: g.changes.sig, files: named, own: run.own }].slice(-RUNS_KEPT);
      const key = `${g.changes.sig}#${who}`;
      // said once for a state of the files; not at all to an agent already running the whole selection right
      if (b.toldVerify === key || (run.own && named.length === sel.files.length && !sel.problems.length)) { b.toldVerify = key; return null; }
      b.toldVerify = key;
      row({ at: 'test', decision: 'allow', from, ...countsOf(g) });
      return allow(verifyWords(g));
    }
    const e = editOf(tool, input, ev.cwd || repo);
    if (!e) return null;
    const rel = path.relative(repo, e.abs).split(path.sep).join('/');
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const isTree = rel === BEHAVIORS_FILE;
    if (!isTree && !isCode(rel)) return null;
    const tree = isTree ? parseTree(e.after) : readTree(repo);
    const found = isTree ? [] : checkFile(rel, e.after, tree, { lines: changedLines(e.before, e.after, { edges: isTest(rel) }) });
    const wrong = isTree ? tree.errors.map(x => `${BEHAVIORS_FILE}:${x.line} ${x.say}.`) : found.map(sayViolation);
    if (wrong.length) {
      row({ at: 'edit', decision: 'deny', from: b.mode, kinds: isTree ? ['file'] : [...new Set(found.map(v => v.kind))] });
      return deny([REFUSED_EDIT, ...wrong.map(w => `- ${w}`), 'Make the edit again with that in it.'].join('\n'));
    }
    const from = b.mode; b.mode = 'edit';
    const turn = `${turnNo}#${who}`, first = b.told?.turn !== turn;
    if (first) b.told = { turn, files: [] };
    if (b.told.files.includes(rel)) return null;
    b.told.files.push(rel);
    row({ at: 'edit', decision: 'allow', from, told: first ? 'rules' : 'file' });
    const words = [first ? EDIT_RULES : '', fileMap(rel, e.after, tree)].filter(Boolean).join('\n\n');
    return words ? allow(words) : null;
  });
}

/**
 * Stop. Holds the turn (Claude Code's `decision: "block"`) while the session's edits owe the graph something or
 * the tests that hold the touched behaviors have not passed since the last edit. Null lets the turn end.
 */
export function behaviorsStop({ ev, store, session, repo, cfg = behaviorsConfig(), client = 'claude', log = row => store.log(row) }) {
  if (!on({ cfg, client, session, repo })) return null;
  return withState(store, session, ev, (b, turnNo) => {
    if (!b.base) return null; // the hooks saw no tool call here: nothing was edited through them
    const g = readGraph(repo, b.base), sel = g.selection, row = r => log({ op: 'behaviors', session, client, at: 'stop', from: b.mode, ...countsOf(g), ...r });
    if (!sel.direct.length && !sel.problems.length) { b.mode = 'explore'; return null; }
    const v = verified(b.runs, g.changes.sig, sel.files, ev.transcript_path);
    if (v.ok && !sel.problems.length) { if (b.green !== g.changes.sig) row({ decision: 'pass' }); b.green = g.changes.sig; b.mode = 'explore'; return null; }
    const state = v.ok ? '' : v.red ? 'The tests that hold the touched behaviors failed on their last run.'
      : v.piped ? 'A test run whose result was piped or masked does not count: its exit code was not the runner\'s.'
        : v.ran ? `These test files have not run since the last edit: ${v.missing.join(', ')}.` : sel.files.length ? 'The tests that hold the touched behaviors have not run since the last edit.' : '';
    const reason = verifyWords(g, { lead: HELD, state });
    // the same reason is given once a turn: an agent that cannot meet it says so, and the person reads that
    // (for one state of the files: the same words after another edit are a new reason)
    const key = crypto.createHash('sha1').update(`${g.changes.sig}\n${reason}`).digest('hex').slice(0, 12), same = b.held?.turn === turnNo;
    if (same && b.held.keys.includes(key)) { row({ decision: 'let-go' }); return null; }
    b.held = { turn: turnNo, keys: [...(same ? b.held.keys : []), key] };
    b.mode = v.ok || !sel.files.length ? 'edit' : 'verify';
    row({ decision: 'hold', why: sel.problems.length ? 'owed' : v.red ? 'red' : 'not-run' });
    return JSON.stringify({ decision: 'block', reason });
  });
}
