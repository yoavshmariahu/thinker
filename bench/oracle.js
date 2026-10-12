// The executable oracle and the loop counters shared by the agent harnesses (bench/MEASUREMENT.md).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const isTestPath = p => /(^|\/)(tests?|__tests__|testing|spec)\//.test(p) || /(_test\.go|\.test\.[jt]sx?|\.spec\.[jt]sx?|\/test_[^/]*\.py)$/.test(p);
export const TEST_RUN = /\b(pytest|py\.test|npm test|yarn test|pnpm test|node --test|go test|cargo test|jest|vitest|unittest)\b/;
export const TEST_FAILED = /\b(\d+ failed|\d+ errors?\b|FAILED|ERROR|error:|Error:|failed|Traceback)/;

// Was the agent's own test run green? A pytest summary line decides when there is one: under
// the Codex sandbox mlflow's pytest exits 1 after every test passed, because a plugin's teardown
// hits a PermissionError, so the exit code alone misreads a green run (mlflow-astra-v1). Without a
// summary, the exit code; without that, the failure markers.
export function testGreen(output, exitCode) {
  const o = String(output || '').replace(/\x1b\[[0-9;]*m/g, '');
  const summary = [...o.matchAll(/(?:^|\n)[=\s]*((?:\d+ (?:passed|failed|errors?|skipped|xfailed|xpassed|warnings?|deselected|rerun)[^\n]*?)) in [\d.]+s/g)].pop();
  if (summary) {
    const n = k => Number((summary[1].match(new RegExp(`(\\d+) ${k}`)) || [])[1] || 0);
    return n('passed') > 0 && n('failed') === 0 && n('error') === 0 && n('errors') === 0;
  }
  if (/no tests ran/.test(o)) return false;
  // no summary (the sandboxed run above loses it): the per-test verdict lines decide
  const verdicts = [...o.matchAll(/::\S+(?:\[[^\]]*\])? (PASSED|FAILED|ERROR|XFAIL|XPASS|SKIPPED)\b/g)].map(m => m[1]);
  if (verdicts.length) return verdicts.includes('PASSED') && !verdicts.includes('FAILED') && !verdicts.includes('ERROR');
  if (exitCode != null) return exitCode === 0;
  return !TEST_FAILED.test(o) && /passed|ok\b|PASS/.test(o);
}

// Puts a benchmark worktree back to its base between sessions. `git reset --hard` and not
// `git checkout -- .`: the oracle's `git apply --3way` stages the gold tests (--3way implies
// --index), and a checkout restores the working tree from that index, so the next sessions in the
// worktree found the answer key with `git diff --cached` (mlflow, 2026-10-11: 121 of 152 Opus
// sessions and the third and fourth Codex session of every task). `-x` also drops ignored
// leftovers such as a tracking database.
export function resetWorktree(wt) {
  execFileSync('git', ['reset', '-q', '--hard'], { cwd: wt, stdio: 'ignore' });
  execFileSync('git', ['clean', '-qfdx'], { cwd: wt, stdio: 'ignore' });
  execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: wt, stdio: 'ignore' });  // throws when anything is still staged
}

// The names of the tests the gold diff adds; a session that saw one had the answer key.
export function goldTestNames(task) {
  if (!task.goldDiff) return [];
  const diff = fs.readFileSync(path.join(HERE, '..', task.goldDiff), 'utf8');
  const hunks = diff.split(/^(?=diff --git )/m).filter(h => { const m = h.match(/^diff --git a\/(\S+) b\/(\S+)/); return m && isTestPath(m[2]); }).join('');
  // [ \t]* and not \s*: \s crosses the newline after an added blank line into the next context line
  return [...new Set([...hunks.matchAll(/^\+[ \t]*(?:async[ \t]+)?def (test_\w+)/gm)].map(m => m[1]))];
}
// The gold test names that appear in a session's transcript or event stream: [] for a clean session.
export function goldTestsSeen(task, text) {
  const t = String(text || '');
  return goldTestNames(task).filter(n => t.includes(n));
}

// The task's own tests, as the merged change left them, put into the worktree over whatever the
// agent did to those files, so the oracle is the same for every arm. Other test files the agent
// wrote stay. Hunks come from the stored gold diff.
export function installGoldTests(task, cwd) {
  if (!task.goldDiff || !task.testFiles?.length) return;
  const diff = fs.readFileSync(path.join(HERE, '..', task.goldDiff), 'utf8');
  const hunks = diff.split(/^(?=diff --git )/m).filter(h => { const m = h.match(/^diff --git a\/(\S+) b\/(\S+)/); return m && task.testFiles.includes(m[2]); }).join('');
  const existing = task.testFiles.filter(f => fs.existsSync(path.join(cwd, f)));
  try { if (existing.length) execFileSync('git', ['checkout', '-q', '--', ...existing], { cwd, stdio: 'ignore' }); } catch {}
  for (const f of task.testFiles) { try { const p = path.join(cwd, f); if (fs.existsSync(p) && !existing.includes(f)) fs.rmSync(p); } catch {} }
  const r = spawnSync('git', ['apply', '--3way', '-'], { cwd, input: hunks, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('gold tests did not apply: ' + (r.stderr || '').slice(0, 300));
}

// Runs the task's test command in the worktree: { tests: 'pass' | 'fail', testTail }.
export function runOracle(task, cwd) {
  const out = {};
  try { installGoldTests(task, cwd); } catch (e) { out.goldTests = e.message; }
  const [bin, binArgs] = Array.isArray(task.testCmd) ? [task.testCmd[0], task.testCmd.slice(1)] : ['sh', ['-c', task.testCmd]];
  try { const t = execFileSync(bin, binArgs, { cwd, encoding: 'utf8', timeout: 900_000, maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'pipe'] }); return { ...out, tests: 'pass', testTail: t.slice(-800) }; }
  catch (e) { return { ...out, tests: 'fail', testTail: String(e.stdout || '').slice(-800) + String(e.stderr || '').slice(-400) }; }
}

// The source files the merged change edited (tests left out) that the agent's diff also edited.
export function goldTouched(task, diff) {
  const gold = (task.goldFiles || []).filter(p => !isTestPath(p));
  if (!gold.length) return null;
  const touched = new Set(); for (const m of String(diff || '').matchAll(/^diff --git a\/(\S+) b\/(\S+)/gm)) touched.add(m[2]);
  const hit = gold.filter(p => touched.has(p));
  return { goldSrc: gold.length, touched: hit.length, missing: gold.filter(p => !touched.has(p)) };
}

// Loop counters from a Codex `exec --json` event stream: calls before the first edit, test runs
// before it, attempts after it up to the first green run (exit code 0, or no failure marker).
export function codexLoopStats(events) {
  const s = { callsBeforeFirstEdit: null, testRunsBeforeEdit: 0, testRunsAfterEdit: 0, attemptsToGreen: null, greenReached: false };
  let calls = 0, edited = false, attempts = 0;
  const pendingTests = new Map();  // item id → 'before' | 'after'
  for (const e of events) {
    if (e.type === 'item.started' && e.item && !['agent_message', 'reasoning'].includes(e.item.type)) {
      calls++;
      if (e.item.type === 'file_change' && !edited) { edited = true; s.callsBeforeFirstEdit = calls - 1; }
      if (e.item.type === 'command_execution' && TEST_RUN.test(e.item.command || '')) {
        if (edited) { s.testRunsAfterEdit++; if (!s.greenReached) attempts++; pendingTests.set(e.item.id, 'after'); }
        else { s.testRunsBeforeEdit++; pendingTests.set(e.item.id, 'before'); }
      }
    } else if (e.type === 'item.completed' && e.item && pendingTests.get(e.item.id) === 'after' && !s.greenReached) {
      if (testGreen(e.item.aggregated_output, e.item.exit_code)) { s.greenReached = true; s.attemptsToGreen = attempts; }
    }
  }
  if (!edited) s.callsBeforeFirstEdit = calls;
  return s;
}

// Dollars at list price from token classes, for harnesses whose client reports no cost.
export const PRICE = {
  'gpt-6-astra': { in: 10, cached: 1, out: 50 },
  'gpt-6-sol': { in: 4, cached: 0.4, out: 20 },
  'gemini-3.8-flash-high': { in: 0.75, cached: 0.075, out: 3.75 },
};
export function listCost(model, { inTokens = 0, cachedTokens = 0, outTokens = 0 }) {
  const p = PRICE[model];
  if (!p) return null;
  return ((inTokens - cachedTokens) * p.in + cachedTokens * p.cached + outTokens * p.out) / 1e6;
}
