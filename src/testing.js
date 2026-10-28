// Test economy: what a failing test run costs an agent in context.
//
// Stage-0 diagnostic over 662 real sessions (910 test runs): test *selection* is not the problem.
// None of the 910 runs was a full suite, one was a directory run, and only 2 were redundant
// re-runs: agents already run one or two test files. The tokens are in the single catastrophic
// failing run — 50k to 100k tokens, 80-88% of a session's whole tool output — of which about 30%
// is ANSI colour escapes, and whose 70 failures collapse to some 13 distinct causes. Opus already
// pipes such runs through `tail`, blind.
//
// So `thinker test -- <command>` runs the command with colour off, streams the log (ANSI stripped)
// to a file under .thinker/state/tests/ — already out of git, store.js:EXCLUDED — and prints the
// counts, the failures grouped by distinct cause (each cause once, with a count, a few example
// test names and a few frames that point at repository files), the warnings as one number, and
// the log path for the rest. The `pre` hook (PreToolUse) asks for a test command to go through it.
//
// Everything here is model-free: colour flags, output parsing and grouping. No model call, no note.
//
// On by default since 2026-10-29, at the owner's decision. What the saving rests on: the agent is
// already paying the loss. Opus pipes such a run through `tail` and throws away 12 of the 13 causes
// to keep its context; this hands it all 13 for a fraction of what one truncated log costs. Measured
// on this repository: a 13-failure run reads 10,493 bytes raw and 513 through the wrapper, both
// causes kept. No model call, so there is nothing to meter and no judge to trust.
// `tests: { nudge: false }` in .thinker/config.json turns the rewrite off; the command stays.
import fs from 'node:fs';
import path from 'node:path';

// Read like the other switches (ops.js:onSightConfig): the config, or the options a caller
// passes. No environment knobs.
export const TESTS = {
  nudge: true,       // the pre hook answers a shell test command with the wrapped one (on by default, 2026-10-29)
  color: true,       // run the command with colour off (and strip what still comes through)
  causes: 10,        // distinct causes printed
  examples: 10,      // test names shown per cause
  traceback: 6,      // frames printed per cause
  tail: 40,          // lines of the log printed for a runner with no parser
  keepLogs: 20,      // log files kept under .thinker/state/tests/
};
export function testsConfig(store, over = {}) {
  const c = store?.config?.().tests;
  return { ...TESTS, ...(c === true ? { nudge: true } : c && typeof c === 'object' ? c : {}), ...over };
}

// --- colour ----------------------------------------------------------------

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][B0]|\x1b[=>]/g;
export const stripAnsi = s => String(s).replace(ANSI, '');
// Strip ANSI from a stream chunk by chunk. An escape sequence can be split across two chunks, so
// a trailing partial one is carried over instead of being written half-stripped.
export function ansiStripper() {
  let carry = '';
  return {
    push(chunk) {
      const text = carry + chunk;
      const at = text.lastIndexOf('\x1b');
      // a trailing \x1b with no terminator yet: hold back from there
      const cut = at >= 0 && !/[A-Za-z\x07]/.test(text.slice(at + 1)) && text.length - at < 64 ? at : text.length;
      carry = text.slice(cut);
      return stripAnsi(text.slice(0, cut));
    },
    end() { const rest = stripAnsi(carry); carry = ''; return rest; },
  };
}
// The environment a test command runs in with colour off. Honoured by pytest, jest, vitest,
// cargo and most libraries; the per-runner flags below cover the ones that colour anyway.
// COLUMNS: pytest cuts each line of its short summary to the terminal width (80 off a terminal),
// and a cut message splits one cause into several.
export const NO_COLOR_ENV = { NO_COLOR: '1', FORCE_COLOR: '0', CLICOLOR: '0', CLICOLOR_FORCE: '0', TERM: 'dumb', COLUMNS: '200' };

// --- runners ---------------------------------------------------------------

const lines = s => stripAnsi(s).split('\n');

// Split a shell command into words, keeping a quoted run together. Enough to read the program a
// command starts; a command with substitutions or a chain is not classified in the first place.
export function tokenize(command) {
  const out = [];
  for (const m of String(command).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
// Runners are reached through these, so the word after one is still the program.
const WRAPPERS = /^(env|time|sudo|nice|xvfb-run|npx|pnpx|poetry|uv|uvx|pipenv|hatch|rye|bundle|dotenv|exec|command|run)$/;

// A shell line is not one command. Agents write `cd packages/web && pytest tests/x.py`,
// `pytest tests/x.py | tail -50`, `npm test 2>&1 | head -100`, and judging the whole line as one
// program recognised none of them: the first word is `cd` or the runner's output goes through a
// pager. So the line is split on its separators and each piece judged on its own. The separator
// is kept with the piece that follows it, so the line can be put back together exactly.
const SEPARATORS = ['&&', '||', ';', '|', '&'];
export function shellSegments(command) {
  const text = String(command || '');
  const segs = [];
  let buf = '', sep = '', quote = '';
  const push = () => { if (buf.trim()) segs.push({ sep, text: buf.trim() }); buf = ''; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { buf += c; if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; buf += c; continue; }
    if (c === '\\') { buf += c + (text[i + 1] || ''); i++; continue; }
    const two = text.slice(i, i + 2);
    if (two === '&&' || two === '||') { push(); sep = two; i++; continue; }
    // `2>&1` is a redirection, not a background `&`; `|&` is not split either
    if (c === '|' && text[i + 1] !== '&') { push(); sep = '|'; continue; }
    if (c === ';') { push(); sep = ';'; continue; }
    if (c === '&' && text[i - 1] !== '>' && text[i + 1] !== '>') { push(); sep = '&'; continue; }
    buf += c;
  }
  push();
  return segs;
}
export const renderSegments = segs => segs.reduce((line, s, i) => i === 0 ? s.text : line + (s.sep === ';' ? '; ' : ` ${s.sep} `) + s.text, '');

// A line thinker will not take apart: a substitution or a group can put a runner somewhere that
// rewriting the text would change what runs, and a mangled test command costs the agent its run.
export const tooIntricate = command => /\$\(|`|\(\s|\)\s*$|\{\s/.test(String(command || ''));

// Which test runner a shell command invokes, judged from the program it runs rather than from any
// word in the line: `echo pytest` and `node src/cli.js list` are not test runs. Only the runners
// with a parser below are named; anything else runs unchanged and is reported by its tail.
export function detectRunner(command) {
  for (const seg of shellSegments(command)) {
    const r = runnerOfSegment(seg.text);
    if (r) return r;
  }
  return null;
}
function runnerOfSegment(command) {
  const toks = tokenize(command);
  const after = i => toks.slice(i + 1);
  const arg = i => after(i).find(t => !t.startsWith('-') && !t.startsWith('+'));
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i], base = t.split('/').pop();
    if (t.startsWith('-') || /^[A-Za-z_]\w*=/.test(t) || WRAPPERS.test(base)) continue;
    if (/^(pytest|py\.test)$/.test(base)) return 'pytest';
    if (base === 'vitest') return 'vitest';
    if (base === 'jest') return 'jest';
    if (/^python[\d.]*$/.test(base)) return after(i)[0] === '-m' && after(i)[1] === 'pytest' ? 'pytest' : null;
    if (base === 'go') return arg(i) === 'test' ? 'go' : null;
    if (base === 'cargo') return ['test', 'nextest'].includes(arg(i)) ? 'cargo' : null;
    if (base === 'node') return after(i).includes('--test') ? 'node' : null;
    // a package script: which runner it starts is unknown until its output is parsed
    if (/^(npm|pnpm|yarn)$/.test(base)) {
      const sub = after(i).filter(x => !x.startsWith('-'));
      return sub[0] === 'test' || (sub[0] === 'run' && /^test([:.]|$)/.test(sub[1] || '')) ? 'script' : null;
    }
    return null; // some other program
  }
  return null;
}

// The runner a log came from, when the command did not say (an `npm test` script).
export function runnerOfOutput(text) {
  const t = stripAnsi(String(text || '')).slice(0, 200_000);
  if (/^Test Files\s+\d|⎯+\s*Failed Tests/m.test(t)) return 'vitest';
  if (/^Test Suites:\s/m.test(t) || /"numTotalTestSuites"/.test(t)) return 'jest';
  if (/^(ℹ|#) (pass|fail) \d+$/m.test(t) || /^TAP version 13$/m.test(t)) return 'node';
  if (/^=+ (FAILURES|short test summary info) =+$/m.test(t) || /^\d+ (passed|failed).*\sin [\d.]+s$/m.test(t)) return 'pytest';
  if (/^(--- (FAIL|PASS|SKIP):|ok\s+\S+\s+[\d.]+s$)/m.test(t)) return 'go';
  if (/^test result: (ok|FAILED)\./m.test(t)) return 'cargo';
  return null;
}

// Colour off, and machine-readable output where it is free. pytest: `-q --tb=short` is its terse
// traceback and `-rfE` keeps the short summary, one `FAILED path::test - message` line per
// failure, the cheapest place to read a failure's name and message from. The other runners are
// parsed from their default text; a command that already asks for JSON (`go test -json`,
// `jest --json`) is parsed from that. Rewriting someone else's command further is not worth the
// ways it breaks. A flag the command already carries is never added twice.
export function machineReadable(command, runner = detectRunner(command), { color = true } = {}) {
  const c = String(command);
  const add = [];
  const has = re => re.test(` ${c} `);
  if (runner === 'pytest') {
    if (!has(/\s-(q|v+|-quiet|-verbose)\s/)) add.push('-q');
    if (!has(/\s--tb[= ]/)) add.push('--tb=short');
    if (!has(/\s-r[a-zA-Z]+\s/)) add.push('-rfE');
    if (color && !has(/\s--color[= ]/)) add.push('--color=no');
    if (color && !has(/\s-p\s+no:cacheprovider\s/)) add.push('-p no:cacheprovider');
  }
  if (color && runner === 'jest' && !has(/\s--(no-)?colors?[= ]?/)) add.push('--colors=false');
  if (color && runner === 'vitest' && !has(/\s--(no-)?color\b/)) add.push('--no-color');
  if (color && runner === 'cargo' && !has(/\s--color[= ]/)) add.push('--color never');
  return add.length ? `${c} ${add.join(' ')}` : c;
}

// --- output parsers --------------------------------------------------------
// Each returns { runner, passed, failed, skipped, warnings, failures: [{ name, message, frames }] }.
// A count the runner's output does not state is null, never a guess.

const EMPTY = { passed: null, failed: null, skipped: null, warnings: null, failures: [] };
const WARN = /\b(DeprecationWarning|UserWarning|RuntimeWarning|FutureWarning|PendingDeprecationWarning|ExperimentalWarning)\b|^\s*(warning|warn):/i;
const countWarnings = ls => ls.filter(l => WARN.test(l)).length;

const frame = (file, line, fn) => ({ file, line: Number(line), fn: fn || '' });
// Keep only frames that point at this repository's own files.
const inRepo = (repo, f) => {
  if (!f) return false;
  if (/node_modules|site-packages|dist-packages|^node:|(^|\/)internal\//.test(f)) return false;
  if (/^\/(usr|opt|Library|System)\//.test(f)) return false;
  if (!repo) return true;
  const rel = path.isAbsolute(f) ? path.relative(repo, f) : f;
  return !rel.startsWith('..');
};
const relative = (repo, f) => (repo && path.isAbsolute(f) ? path.relative(repo, f) : f).replace(/^\.\//, '');

export function parsePytest(text) {
  const ls = lines(text);
  const out = { ...EMPTY, runner: 'pytest', failures: [] };
  // the closing line: "3 failed, 2 passed, 1 skipped, 1 warning in 0.04s"
  const tail = [...ls].reverse().find(l => /\d+ (passed|failed|error|skipped|xfailed|deselected)\b/.test(l) && /\sin\s[\d.]+s/.test(l)) || '';
  const count = re => { const m = tail.match(re); return m ? Number(m[1]) : null; };
  out.failed = (count(/(\d+) failed/) ?? 0) + (count(/(\d+) errors?\b/) ?? 0);
  out.passed = count(/(\d+) passed/) ?? 0;
  out.skipped = count(/(\d+) skipped/) ?? 0;
  out.warnings = count(/(\d+) warnings?/) ?? countWarnings(ls);
  // "FAILED tests/x.py::test_y - AssertionError: ..." from the short summary (-rfE)
  const named = new Map();
  for (const l of ls) {
    const m = l.match(/^(FAILED|ERROR)\s+(\S+?)(?:\s+-\s+(.*))?$/);
    if (m) named.set(m[2], { name: m[2], message: (m[3] || '').trim(), frames: [] });
  }
  // the FAILURES section: "____ test_y ____", then "path:12: in fn" frames and "E   message".
  // Its "E   …" line carries the whole message; the short summary's is cut to the terminal width
  // ("ConnectionError: could not reach th…"), which would split one cause into several.
  let cur = null;
  const taken = new Set(), full = new Set();
  for (const l of ls) {
    const head = l.match(/^_{3,}\s+(.+?)\s+_{3,}$/);
    if (head) {
      const short = head[1].trim();
      cur = [...named.values()].find(f => !taken.has(f) && (f.name.endsWith(`::${short}`) || f.name.endsWith(short))) || null;
      if (!cur) { cur = { name: short, message: '', frames: [] }; named.set(short, cur); }
      taken.add(cur);
      continue;
    }
    if (/^=+ .* =+$/.test(l)) { cur = null; continue; }
    if (!cur) continue;
    const f = l.match(/^(\S+?):(\d+): in (\S+)\s*$/);
    if (f) { cur.frames.push(frame(f[1], f[2], f[3])); continue; }
    const e = l.match(/^E\s{3}(.*)$/);
    if (e && !full.has(cur)) { cur.message = e[1].trim(); full.add(cur); }
  }
  out.failures = [...named.values()];
  if (!tail) { out.failed = out.failures.length; out.passed = null; out.skipped = null; }
  return out;
}

export function parseJest(text) {
  const t = stripAnsi(String(text || ''));
  const j = jestJson(t);
  if (j) return j;
  const ls = t.split('\n');
  const out = { ...EMPTY, runner: 'jest', failures: [] };
  const summary = [...ls].reverse().find(l => /^Tests:\s/.test(l)) || '';
  const count = re => { const m = summary.match(re); return m ? Number(m[1]) : null; };
  out.failed = count(/(\d+) failed/) ?? 0;
  out.passed = summary ? count(/(\d+) passed/) ?? 0 : null;
  out.skipped = summary ? (count(/(\d+) skipped/) ?? 0) + (count(/(\d+) todo/) ?? 0) : null;
  out.warnings = countWarnings(ls);
  let cur = null;
  for (const l of ls) {
    const head = l.match(/^\s{2}●\s+(.+?)\s*$/);
    if (head) {
      if (/^Console$/.test(head[1])) { cur = null; continue; }
      cur = { name: head[1].replace(/\s+›\s+/g, ' > '), message: '', frames: [] };
      out.failures.push(cur);
      continue;
    }
    if (/^(Test Suites|Tests|Snapshots|Time|Ran all):/.test(l)) { cur = null; continue; }
    if (!cur) continue;
    const at = l.match(/^\s+at\s+(?:.*?\()?([^()\s]+?):(\d+):(\d+)\)?\s*$/);
    if (at) { cur.frames.push(frame(at[1], at[2], '')); continue; }
    const body = l.trim();
    if (body && !cur.message && !/^[>\s]*\d+\s\|/.test(body) && !/^\|?\s*\^+$/.test(body)) cur.message = body;
  }
  if (!summary) out.failed = out.failures.length;
  return out;
}

// jest --json: the payload is one object, printed among the normal report
function jestJson(text) {
  const at = text.indexOf('{"numFailedTestSuites"');
  const start = at >= 0 ? at : (/^\s*\{\s*"num/.test(text) ? text.indexOf('{') : -1);
  if (start < 0) return null;
  let j; try { j = JSON.parse(text.slice(start, text.lastIndexOf('}') + 1)); } catch { return null; }
  if (typeof j?.numTotalTests !== 'number') return null;
  const out = { runner: 'jest', passed: j.numPassedTests ?? null, failed: j.numFailedTests ?? null,
    skipped: (j.numPendingTests || 0) + (j.numTodoTests || 0), warnings: countWarnings(text.split('\n')), failures: [] };
  for (const r of j.testResults || []) for (const a of r.assertionResults || []) {
    if (a.status !== 'failed') continue;
    const msg = stripAnsi(String((a.failureMessages || [])[0] || ''));
    const frames = [];
    for (const m of msg.matchAll(/^\s+at\s+(?:.*?\()?([^()\s]+?):(\d+):(\d+)\)?\s*$/gm)) frames.push(frame(m[1], m[2], ''));
    out.failures.push({ name: a.fullName || a.title || '', message: (msg.split('\n')[0] || '').replace(/^Error:\s*/, '').trim(), frames });
  }
  return out;
}

export function parseVitest(text) {
  const ls = lines(text);
  const out = { ...EMPTY, runner: 'vitest', failures: [] };
  const summary = [...ls].reverse().find(l => /^\s*Tests\s+\S/.test(l)) || '';
  const count = re => { const m = summary.match(re); return m ? Number(m[1]) : null; };
  out.failed = count(/(\d+) failed/) ?? 0;
  out.passed = summary ? count(/(\d+) passed/) ?? 0 : null;
  out.skipped = summary ? (count(/(\d+) skipped/) ?? 0) + (count(/(\d+) todo/) ?? 0) : null;
  out.warnings = countWarnings(ls);
  // the "Failed Tests" section: " FAIL  file > suite > name", the error, then "❯ file:line:col"
  let cur = null, inFailed = false;
  for (const l of ls) {
    if (/Failed Tests \d+/.test(l)) { inFailed = true; continue; }
    if (!inFailed) continue;
    const head = l.match(/^\s*FAIL\s+(.+?)\s*$/);
    if (head) { cur = { name: head[1].replace(/\s*>\s*/g, ' > '), message: '', frames: [] }; out.failures.push(cur); continue; }
    if (!cur) continue;
    const at = l.match(/^\s*❯\s+(?:\S+\s+)?([^\s]+?):(\d+):(\d+)\s*$/);
    if (at) { cur.frames.push(frame(at[1], at[2], '')); continue; }
    const body = l.trim();
    if (body && !cur.message && !/^[-+]/.test(body) && !/^\d+\|/.test(body) && !/\|\s*\^/.test(body) && !/^⎯+/.test(body)) cur.message = body;
  }
  if (!summary) out.failed = out.failures.length;
  return out;
}

export function parseGo(text) {
  const t = stripAnsi(String(text || ''));
  if (/^\s*\{"(Time|Action)"/m.test(t)) return parseGoJson(t);
  const ls = t.split('\n');
  const out = { ...EMPTY, runner: 'go', failures: [] };
  // without -v, `go test` prints nothing for a passing test: the count is unknown, not zero
  const pass = ls.filter(l => /^\s*--- PASS:/.test(l)).length;
  out.passed = pass || (/^\s*--- (PASS|SKIP):/m.test(t) ? 0 : null);
  out.skipped = ls.filter(l => /^\s*--- SKIP:/.test(l)).length;
  out.warnings = countWarnings(ls);
  let cur = null;
  for (const l of ls) {
    const head = l.match(/^\s*--- FAIL:\s+(\S+)/);
    if (head) { cur = { name: head[1], message: '', frames: [] }; out.failures.push(cur); continue; }
    if (/^(ok|FAIL|PASS|===|---|\?)\b/.test(l) || /^\s*--- (PASS|SKIP):/.test(l)) { cur = null; continue; }
    if (!cur) continue;
    const f = l.match(/^\s+(\S+\.go):(\d+):\s*(.*)$/);
    if (f) { cur.frames.push(frame(f[1], f[2], '')); if (!cur.message && f[3]) cur.message = f[3].trim(); continue; }
    const panic = l.match(/^\s*panic:\s*(.*)$/);
    if (panic && !cur.message) cur.message = panic[1].trim();
  }
  out.failed = out.failures.length;
  return out;
}

function parseGoJson(text) {
  const out = { ...EMPTY, runner: 'go', passed: 0, failed: 0, skipped: 0, warnings: 0, failures: [] };
  const say = new Map();
  for (const l of text.split('\n')) {
    if (!l.startsWith('{')) continue;
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (!e.Test) continue;
    const key = `${e.Package}.${e.Test}`;
    if (e.Action === 'output') { const a = say.get(key) || []; a.push(e.Output || ''); say.set(key, a.slice(-40)); }
    if (e.Action === 'pass') out.passed++;
    if (e.Action === 'skip') out.skipped++;
    if (e.Action === 'fail') {
      out.failed++;
      const body = (say.get(key) || []).join('');
      const f = body.match(/^\s+(\S+\.go):(\d+):\s*(.*)$/m);
      out.failures.push({ name: e.Test, message: f ? f[3].trim() : (body.split('\n').find(x => x.trim() && !/^(=== RUN|--- FAIL)/.test(x.trim())) || '').trim(),
        frames: [...body.matchAll(/^\s+(\S+\.go):(\d+):/gm)].map(m => frame(m[1], m[2], '')) });
    }
  }
  out.warnings = countWarnings(text.split('\n'));
  return out;
}

export function parseCargo(text) {
  const ls = lines(text);
  const out = { ...EMPTY, runner: 'cargo', passed: 0, failed: 0, skipped: 0, failures: [] };
  let any = false;
  for (const l of ls) {
    const m = l.match(/^test result: \w+\.\s*(\d+) passed; (\d+) failed; (\d+) ignored/);
    if (!m) continue;
    any = true; out.passed += Number(m[1]); out.failed += Number(m[2]); out.skipped += Number(m[3]);
  }
  out.warnings = countWarnings(ls);
  let cur = null;
  for (const l of ls) {
    const head = l.match(/^---- (\S+) stdout ----\s*$/);
    if (head) { cur = { name: head[1], message: '', frames: [] }; out.failures.push(cur); continue; }
    if (/^(failures|successes):\s*$/.test(l) || /^test result:/.test(l)) { cur = null; continue; }
    if (!cur) continue;
    const p = l.match(/^thread '.*?' panicked at ([^\s:]+(?:\/[^\s:]+)*):(\d+):(\d+):?\s*$/);
    if (p) { cur.frames.push(frame(p[1], p[2], '')); continue; }
    const at = l.match(/^\s+(?:at\s+)?([\w./-]+\.rs):(\d+)(?::\d+)?\s*$/);
    if (at) { cur.frames.push(frame(at[1], at[2], '')); continue; }
    const body = l.trim();
    if (body && !cur.message && !/^note:/.test(body)) cur.message = body;
  }
  if (!any) { out.passed = null; out.skipped = null; out.failed = out.failures.length; }
  return out;
}

export function parseNode(text) {
  const ls = lines(text);
  const out = { ...EMPTY, runner: 'node', failures: [] };
  const count = re => { for (const l of [...ls].reverse()) { const m = l.match(re); if (m) return Number(m[1]); } return null; };
  out.passed = count(/^[ℹ#]\s*pass (\d+)$/);
  out.failed = count(/^[ℹ#]\s*fail (\d+)$/);
  out.skipped = count(/^[ℹ#]\s*skipped (\d+)$/);
  out.warnings = countWarnings(ls);
  const spec = ls.findIndex(l => /^✖ failing tests:/.test(l.trim()));
  if (spec < 0 && /^TAP version 13$/m.test(stripAnsi(text))) {
    let cur = null, inStack = false;
    for (const l of ls) {
      const head = l.match(/^\s*not ok \d+ - (.+?)\s*$/);
      if (head) { cur = { name: head[1], message: '', frames: [] }; out.failures.push(cur); inStack = false; continue; }
      if (/^\s*(ok \d+|# Subtest:|1\.\.\d+)/.test(l)) { cur = null; inStack = false; continue; }
      if (!cur) continue;
      const err = l.match(/^\s*error:\s*(?:'(.*)'|"(.*)"|(.*))$/);
      if (err && !cur.message) { cur.message = (err[1] ?? err[2] ?? err[3] ?? '').trim(); continue; }
      if (/^\s*stack:\s*\|-?\s*$/.test(l)) { inStack = true; continue; }
      if (/^\s*\.\.\.\s*$/.test(l)) { inStack = false; cur = null; continue; }
      if (inStack) { const m = l.match(/^\s*(?:async\s+)?(?:(\S+)\s+)?\(?(?:file:\/\/)?(\/?[^\s()]+?):(\d+):(\d+)\)?\s*$/); if (m) cur.frames.push(frame(m[2], m[3], m[1] || '')); }
    }
    return out;
  }
  if (spec < 0) { if (out.failed === null) out.failed = 0; return out; }
  // the spec reporter's "✖ failing tests:" section
  let cur = null;
  for (const l of ls.slice(spec + 1)) {
    if (/^test at /.test(l.trim())) { cur = null; continue; }
    const head = l.match(/^✖ (.+?)(?:\s+\([\d.]+ms\))?\s*$/);
    if (head) { cur = { name: head[1], message: '', frames: [] }; out.failures.push(cur); continue; }
    if (!cur) continue;
    const f = l.match(/^\s+at\s+(?:async\s+)?(?:(\S+)\s+)?\(?(?:file:\/\/)?(\/?[^\s()]+?):(\d+):(\d+)\)?\s*$/);
    if (f) { cur.frames.push(frame(f[2], f[3], f[1] || '')); continue; }
    const body = l.trim();
    if (body && !cur.message) cur.message = body;
  }
  return out;
}

const PARSERS = { pytest: parsePytest, jest: parseJest, vitest: parseVitest, go: parseGo, cargo: parseCargo, node: parseNode };

// Parse a run's output. `runner` may be unknown ('script', null): the output says which it was.
export function parseTestOutput(text, { runner } = {}) {
  const r = PARSERS[runner] ? runner : runnerOfOutput(text);
  if (!PARSERS[r]) return null;
  const parsed = PARSERS[r](text);
  // no counts and no failures: the output was not a test report after all (`pytest --version`),
  // so the caller falls back to the tail of the log rather than printing an empty summary
  const useful = parsed && (parsed.failures.length > 0 || parsed.passed !== null || (parsed.failed ?? 0) > 0);
  return useful ? parsed : null;
}

// --- grouping failures by cause --------------------------------------------

// What two failures have in common when they are the same bug: the exception type and the message
// with the values in it normalised away (numbers, hex, uuids, durations, temp paths). On the run
// the diagnostic looked at, 70 failures came to 13 of these.
export function causeOf(failure) {
  const first = String(failure?.message || '').split('\n')[0].trim();
  if (!first) return '(no message)';
  return first
    .replace(/0x[0-9a-fA-F]+/g, '0xX')
    .replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, 'UUID')
    .replace(/\b[0-9a-fA-F]{12,}\b/g, 'HASH')
    .replace(/\/(tmp|var\/folders|private\/var)\/\S+/g, '/TMP')
    .replace(/\b\d+(\.\d+)?(ms|s|us|ns)?\b/g, 'N')
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}
// Failures grouped by cause, most common first, each keeping the first failure's frames.
export function groupCauses(failures = []) {
  const by = new Map();
  for (const f of failures) {
    const key = causeOf(f);
    const g = by.get(key) || { cause: key, count: 0, names: [], message: String(f.message || '').split('\n')[0].trim(), frames: f.frames || [] };
    g.count++;
    if (f.name) g.names.push(f.name);
    if (!g.frames.length && f.frames?.length) g.frames = f.frames;
    by.set(key, g);
  }
  return [...by.values()].sort((a, b) => b.count - a.count);
}

// --- the summary the agent reads -------------------------------------------

export function summarize(parsed, { repo, logPath, logLines, exitCode, command, cfg = TESTS, tail = '' } = {}) {
  const where = logPath ? `full log${logLines ? ` (${logLines} lines)` : ''}: ${logPath}` : '';
  if (!parsed) {
    const last = stripAnsi(String(tail || '')).split('\n').filter(l => l.trim()).slice(-cfg.tail);
    return [`${command ? `${command}: ` : ''}exit ${exitCode}${last.length ? `, last ${last.length} lines of output` : ''}`,
      ...last, where].filter(Boolean).join('\n');
  }
  const counts = [
    parsed.failed !== null ? `${parsed.failed} failed` : null,
    parsed.passed !== null ? `${parsed.passed} passed` : null,
    parsed.skipped ? `${parsed.skipped} skipped` : null,
  ].filter(Boolean).join(', ');
  const out = [`${parsed.runner}: ${counts || 'no counts in the output'} — exit ${exitCode}`];
  const groups = groupCauses(parsed.failures);
  if (groups.length) {
    out.push(`${groups.length} distinct cause${groups.length === 1 ? '' : 's'} in ${parsed.failures.length} failing test${parsed.failures.length === 1 ? '' : 's'}:`);
    for (const g of groups.slice(0, cfg.causes)) {
      out.push(`${g.count}× ${(g.message || g.cause).slice(0, 500)}`);
      const shown = g.names.slice(0, cfg.examples);
      if (shown.length) out.push(`    ${shown.join(', ')}${g.names.length > shown.length ? `, … +${g.names.length - shown.length} more` : ''}`);
      for (const fr of g.frames.filter(f => inRepo(repo, f.file)).slice(0, cfg.traceback)) {
        out.push(`    ${relative(repo, fr.file)}:${fr.line}${fr.fn ? ` in ${fr.fn}` : ''}`);
      }
    }
    if (groups.length > cfg.causes) out.push(`… ${groups.length - cfg.causes} more causes in the log`);
  }
  if (parsed.warnings) out.push(`${parsed.warnings} warning${parsed.warnings === 1 ? '' : 's'}`);
  if (where) out.push(where);
  return out.join('\n');
}

// --- the command classifier (the pre hook) ---------------------------------

// Is this shell command a test run? Selection is deliberately not attempted: the diagnostic found
// agents already run one or two test files, and an import-graph selector widened a real two-file
// run to 93. The hook's whole job is to put the run through the wrapper.
export function classifyTestCommand(command) {
  const raw = String(command || '').trim();
  if (!raw) return null;
  if (/\bthinker\b[^|&;]*\btest\b/.test(raw)) return null; // already wrapped
  if (tooIntricate(raw)) return null; // not taken apart: a mangled command costs the agent its run
  const runner = detectRunner(raw);
  return runner ? { runner, command: raw } : null;
}

// How a shell reaches the wrapper: the `thinker` the installer puts on PATH (shell-path.js),
// else this copy's cli.js by path, so the hook's suggestion runs wherever it is pasted.
export function wrapperBin(cli, env = process.env) {
  const onPath = String(env.PATH || '').split(path.delimiter).some(d => d && fs.existsSync(path.join(d, 'thinker')));
  return onPath ? 'thinker' : `node ${JSON.stringify(cli)}`;
}
// What an agent pipes a test run into to cut it down. thinker's summary is already the short form of
// the run, so a `| tail -50` on top of it hides the very summary it just made: those stages are
// dropped. A stage that does something else (`tee`), or one carrying a redirection another command
// may read, is kept and applies to the summary instead.
const TRUNCATING = /^(tail|head|less|more|grep|egrep|fgrep|rg|ag|sed|awk|cut|wc|sort|uniq|tr|fold|column|jq)$/;

// The command the hook asks for instead: the same run, through the wrapper. Only the piece that
// holds the runner is wrapped -- prefixing the whole line put the wrapper before `cd packages/web &&`
// and left the agent's `| tail` cutting thinker's own output down to nothing.
export function wrappedCommand(command, bin = 'thinker') {
  const raw = String(command).trim();
  const segs = shellSegments(raw);
  const at = segs.findIndex(s => runnerOfSegment(s.text));
  if (at < 0) return `${bin} test -- ${raw}`;
  const kept = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (i === at) { kept.push({ sep: s.sep, text: `${bin} test -- ${s.text}` }); continue; }
    const head = (tokenize(s.text)[0] || '').split('/').pop();
    if (i > at && s.sep === '|' && TRUNCATING.test(head) && !/[<>]/.test(s.text)) continue;
    kept.push(s);
  }
  return renderSegments(kept);
}
export const NUDGE_REASON = command =>
  `run this instead: ${command}\nthinker test runs the same command with colour off, keeps the full log in a file, and prints the counts, each distinct failure cause once with a few frames, and the log path.`;

// --- logs ------------------------------------------------------------------

export const logDir = store => path.join(store.dir, 'state', 'tests');
export function logPathFor(store, runner, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  return path.join(logDir(store), `${stamp}-${runner || 'run'}.log`);
}
// Keep the last `keep` logs; a test log is scratch output, never kept beyond that.
export function pruneLogs(store, keep = TESTS.keepLogs) {
  try {
    const d = logDir(store);
    const files = fs.readdirSync(d).filter(f => f.endsWith('.log')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) { try { fs.unlinkSync(path.join(d, f)); } catch {} }
  } catch {}
}
