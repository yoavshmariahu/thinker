import { digest } from './verification-snapshot.js';

export function normalizeFailures(output, check, { exitCode, error, snapshot, artifact, truncated = false } = {}) {
  const failures = [], passedTests = [], skippedTests = [];
  let malformed = false, summary = null;
  for (const line of output.split('\n')) {
    if (!line.startsWith('THINKER_TEST_EVENT ')) continue;
    let e; try { e = JSON.parse(line.slice(19)); } catch { malformed = true; continue; }
    const d = e.data || {};
    if (e.type === 'test:summary' && !d.file) summary = d;
    if (e.type === 'test:pass') (d.skip || d.todo ? skippedTests : passedTests).push({ name: d.name, file: d.file, line: d.line });
    if (e.type !== 'test:fail') continue;
    if (d.todo || d.skip) { skippedTests.push({ name: d.name, file: d.file, line: d.line }); continue; }
    const err = d.details?.error?.cause || d.details?.error || {};
    failures.push({ id: 'failure-' + digest([check.id, d.file, d.name]).slice(7, 27), kind: 'test', test: d.name, location: { file: d.file, line: d.line, column: d.column }, expected: err.expected, actual: err.actual, message: err.message || 'Test failed', stack: err.stack,
      reproduction: { command: check.command, environment: snapshot.environment, confirmed: false, minimality: 'not-established' },
      flake: { classification: 'unknown', matchingHistoricalRuns: 0 }, suspectedCause: null, artifact });
  }
  if ((exitCode !== 0 || error) && !failures.length) failures.push({ id: 'failure-' + digest([check.id, error || exitCode]).slice(7, 27), kind: error ? 'infrastructure' : 'command', message: error || `Command exited ${exitCode}`, artifact,
    reproduction: { command: check.command, environment: snapshot.environment, confirmed: false, minimality: 'not-established' }, flake: { classification: 'unknown', matchingHistoricalRuns: 0 }, suspectedCause: null });
  const missingReport = check.reporter === 'node' && (!summary || malformed || truncated || !(summary.counts?.tests > 0));
  const incomplete = !!error || missingReport;
  return { status: incomplete ? 'incomplete' : exitCode !== 0 || failures.length || summary?.success === false ? 'failed' : 'passed', failures, passedTests, skippedTests, summary,
    ...(missingReport ? { reportError: 'Native test report missing, empty, malformed, or truncated.' } : {}), artifact, exitCode, truncated };
}
