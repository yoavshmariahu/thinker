import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { appendImpact, readImpact, impactFile, impactContext, findingId } from '../src/impact-journal.js';
import { impactReport, linkSession, decideFinding, syncImpact, renderImpact } from '../src/impact.js';
import { logModelUsage } from '../src/model-usage.js';
import { parseTranscript } from '../src/transcripts.js';
import { commands } from '../src/commands/impact.js';

const now = Date.parse('2026-10-04T12:00:00Z');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-impact-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, THINKER_TELEMETRY: 'off', THINKER_NO_LEARN: '1', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' } }).trim();
  git('init', '-q'); git('remote', 'add', 'origin', 'https://github.com/example/impact.git');
  return { store: new Store(dir).init(), dir, git };
}
const record = (s, e) => appendImpact(s, { t: '2026-10-02T12:00:00Z', ...e });
const pr = (s, number = 12, extra = {}) => record(s, { op: 'impact-pr', pr: { number, state: 'MERGED', mergedAt: '2026-10-03T12:00:00Z', updatedAt: '2026-10-03T12:00:00Z', commits: ['a', 'b'], ...extra } });
const session = (s, id = 's1', total = 1000, extra = {}) => record(s, { op: 'session', session: id, totalTokens: total, tokenCoverage: 'complete', ...extra });
const report = s => impactReport(s, { now });

test('latest cumulative session counters, model deduplication, retries and overhead', t => {
  const { store } = fixture(t);
  pr(store); session(store); session(store, 's1', 2000, { t: '2026-10-02T13:00:00Z' });
  linkSession(store, 's1', [{ pr: 12, share: 1 }]);
  record(store, { op: 'impact-review', runId: 'r1', pr: 12, findings: [], tokens: 300 });
  record(store, { op: 'impact-review', runId: 'r2', pr: 12, findings: [], tokens: 100 });
  const m = record(store, { op: 'model', impactRun: 'r1', tokens: { totalTokens: 300 } });
  store.log(m); // the same model call in the usage log and journal is counted once
  record(store, { op: 'model', purpose: 'learn', tokens: { totalTokens: 50 } });
  const r = report(store);
  assert.equal(r.summary.medianTokensPerMergedPr, 2400);
  assert.equal(r.overhead.tokens, 50);
  assert.equal(r.prs[0].reviews.length, 2);
  assert.equal(r.summary.improvement, null);
});

test('split allocation replaces earlier links and cannot inflate totals', t => {
  const { store } = fixture(t); pr(store); pr(store, 13); session(store);
  linkSession(store, 's1', [{ pr: 12, share: 1 }]);
  linkSession(store, 's1', [{ pr: 12, share: 0.4 }, { pr: 13, share: 0.6 }]);
  const r = report(store);
  assert.equal(r.summary.knownTokensOnMergedPrs, 1000);
  assert.deepEqual(r.prs.map(p => p.tokens.agent), [600, 400]);
  assert.throws(() => linkSession(store, 's1', [{ pr: 12, share: 1 }, { pr: 13, share: 1 }]), /sum to 1/);
  assert.throws(() => linkSession(store, 's1', [{ pr: 12, share: 0.5 }, { pr: 12, share: 0.5 }]), /unique/);
  assert.throws(() => linkSession(store, 'missing', [{ pr: 12, share: 1 }]), /Unknown/);
});

test('unknown and partial counters stay out of the median; old work counts for new merges', t => {
  const { store } = fixture(t); pr(store); pr(store, 13); pr(store, 14);
  session(store, 's1', null, { inputTokens: 500 }); linkSession(store, 's1', [{ pr: 12, share: 1 }]);
  session(store, 's2', 200, { tokenCoverage: 'partial' }); linkSession(store, 's2', [{ pr: 13, share: 1 }]);
  session(store, 's3', 900, { t: '2026-01-01T00:00:00Z' }); linkSession(store, 's3', [{ pr: 14, share: 1 }]);
  const r = report(store);
  assert.equal(r.summary.tokenCoverage.complete, 1);
  assert.equal(r.summary.medianTokensPerMergedPr, 900);
  assert.equal(r.summary.knownTokensOnMergedPrs, 1100);
  assert.match(renderImpact(r), /1\/3 merged PRs/);
});

test('attribution requires multiple commit observations and excludes ambiguous PRs', t => {
  const { store } = fixture(t); pr(store);
  session(store, 's1', 100, { head: 'a' }); session(store, 's1', 200, { head: 'b' });
  session(store, 's2', 100, { head: 'b', branch: 'same-branch' });
  assert.equal(report(store).prs[0].tokens.agent, 200);
  assert.equal(report(store).unassignedSessions.length, 1);
  pr(store, 13);
  assert.equal(report(store).unassignedSessions.length, 2);
});

test('findings persist across reruns and disappearances never count as fixes', t => {
  const { store } = fixture(t); pr(store);
  const f = { file: 'a.js', message: 'Missing validation', evidence: 'return input', note: 'validation' };
  const id = findingId(f);
  assert.equal(id, findingId({ ...f, line: 99 }));
  record(store, { op: 'impact-review', pr: 12, runId: 'r1', findings: [{ ...f, id }], tokens: 5 });
  record(store, { op: 'impact-review', pr: 12, runId: 'r2', findings: [{ ...f, id }], tokens: 5 });
  record(store, { op: 'impact-review', pr: 12, runId: 'r3', findings: [], tokens: 5 });
  const r = report(store);
  assert.equal(r.prs[0].findings.length, 1);
  assert.equal(r.summary.bugsCaughtAndFixed, 0);
  decideFinding(store, { pr: 12, finding: id, validity: 'confirmed', evidence: 'Reproduced with invalid input' });
  assert.equal(report(store).summary.bugsCaughtAndFixed, 0);
  assert.throws(() => decideFinding(store, { pr: 12, finding: id, validity: 'duplicate', evidence: 'same', duplicateOf: id }), /different/);
});

test('confirmed fixes require PR commit membership and premerge timing, keeping original evidence', t => {
  const { store, dir, git } = fixture(t);
  fs.writeFileSync(path.join(dir, 'a.js'), 'export const fixed = true;'); git('add', 'a.js'); git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fix');
  const sha = git('rev-parse', 'HEAD'), fixedAt = new Date(git('show', '-s', '--format=%cI', sha)).toISOString();
  const before = new Date(Date.parse(fixedAt) - 60_000).toISOString(), after = new Date(Date.parse(fixedAt) + 60_000).toISOString();
  pr(store, 12, { mergedAt: after, commits: [sha] });
  record(store, { op: 'impact-review', t: before, startedAt: before, pr: 12, runId: 'r1', tokens: 5, findings: [{ id: 'f-one', message: 'Bug', evidence: 'original code', note: 'n1' }] });
  decideFinding(store, { pr: 12, finding: 'f-one', validity: 'confirmed', resolution: 'fixed', evidence: 'Regression test added', fixCommit: sha });
  let r = impactReport(store, { pr: 12 });
  assert.equal(r.summary.bugsCaughtAndFixed, 1);
  assert.equal(r.summary.cacheSupportedFixes, 1);
  assert.equal(r.prs[0].findings[0].evidence, 'original code');
  assert.equal(r.prs[0].findings[0].confirmation, 'human-reported');
  pr(store, 12, { mergedAt: before, commits: [sha] });
  assert.equal(impactReport(store, { pr: 12 }).summary.bugsCaughtAndFixed, 0);
  assert.throws(() => decideFinding(store, { pr: 12, finding: 'f-one', validity: 'confirmed', resolution: 'fixed', evidence: 'late', fixCommit: sha }), /after.*merged/);
});

test('corrupted journal lines are visible and valid events survive', t => {
  const { store } = fixture(t); pr(store);
  fs.appendFileSync(impactFile(store), '{truncated\n');
  session(store);
  assert.equal(readImpact(store).warnings.length, 1);
  assert.equal(execFileSync('git', ['check-ignore', impactFile(store)], { cwd: store.repo, encoding: 'utf8' }).trim(), impactFile(store));
  assert.equal(report(store).unassignedSessions.length, 1);
  assert.match(renderImpact(report(store)), /Unreadable impact event/);
});

test('sync is read-only, paginates commits and preserves unknown readiness', async t => {
  const { store } = fixture(t), paths = [];
  const request = endpoint => {
    paths.push(endpoint);
    if (endpoint.includes('/commits?')) return Array.from({ length: endpoint.endsWith('page=1') ? 100 : 1 }, (_, i) => ({ sha: `${endpoint}:${i}` }));
    if (endpoint.includes('/timeline?')) return [];
    return { number: 12, state: 'closed', merged_at: '2026-10-03T00:00:00Z', updated_at: '2026-10-03T00:00:00Z', created_at: '2026-10-01T00:00:00Z', commits: 101, head: { sha: 'b', ref: 'feature' } };
  };
  assert.deepEqual(await syncImpact(store, { pr: 12, request, now }), { synced: 1 });
  const p = report(store).prs[0];
  assert.equal(p.commits.length, 101);
  assert.equal(p.commitsComplete, true);
  assert.equal(p.readyToMergeHours, null);
  assert.equal(paths.length, 4);
});

test('concurrent review accounting contexts stay distinct and include failed model calls', async t => {
  const { store } = fixture(t);
  await Promise.all(['r1', 'r2'].map((run, index) => impactContext.run({ impactRun: run, impactPr: 12 + index, calls: [] }, async () => {
    await Promise.resolve();
    logModelUsage(store, { purpose: 'review', phase: 'review' }, { provider: 'codex', model: 'test', usage: { input_tokens: 100, output_tokens: 10 }, failed: index === 1 });
    assert.equal(impactContext.getStore().calls.length, 1);
  })));
  const r = impactReport(store);
  assert.deepEqual(r.prs.map(p => p.tokens.review), [110, 110]);
  assert.equal(r.overhead.tokens, 0);
});

test('CLI import is idempotent, rejects foreign repos, and preserves review linkage', async t => {
  const { store, dir } = fixture(t);
  const event = record(store, { op: 'impact-review', runId: 'r1', pr: 12, tokens: 50, findings: [] });
  await commands.impact({ store, pos: ['link-review', 'r1'], flags: { pr: 13 }, out() {} });
  const moved = readImpact(store).events.filter(e => e.runId === 'r1').at(-1);
  assert.equal(moved.completedAt, event.t);
  const file = path.join(dir, 'review.json'); fs.writeFileSync(file, JSON.stringify({ impact: { events: [event] } }));
  let output;
  await commands.impact({ store, pos: ['import', file], flags: { json: true }, out: s => output = JSON.parse(s) });
  assert.equal(output.imported, 0);
  fs.writeFileSync(file, JSON.stringify({ events: [{ ...event, origin: 'github.com/other/repo' }] }));
  await assert.rejects(commands.impact({ store, pos: ['import', file], flags: {}, out() {} }), /mismatch/);
  assert.equal(readImpact(store).events.length, 2);
});

test('transcript totals include outputs without counting cumulative Codex snapshots twice', t => {
  const { dir } = fixture(t);
  const file = path.join(dir, 'codex.jsonl');
  fs.writeFileSync(file, [
    { type: 'session_meta', payload: { cwd: dir } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 50 } } } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 200, output_tokens: 30, cached_input_tokens: 80 } } } },
  ].map(JSON.stringify).join('\n'));
  const stats = parseTranscript(file).stats;
  assert.equal(stats.totalTokens, 230); assert.equal(stats.cacheReadTokens, 80); assert.equal(stats.tokenCoverage, 'complete');
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 20, output_tokens: 10 }, content: [{ type: 'text', text: 'done' }] } }));
  assert.equal(parseTranscript(file).stats.totalTokens, 180);
});


test('CLI reports incomplete coverage, validates flags, and does not call a model', t => {
  const { dir } = fixture(t);
  const cli = new URL('../src/cli.js', import.meta.url).pathname;
  const run = args => execFileSync(process.execPath, [cli, 'impact', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, THINKER_TELEMETRY: 'off', THINKER_NO_AUTO_UPDATE: '1', THINKER_NO_LEARN: '1', THINKER_LOG: 'local' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const r = JSON.parse(run(['--json']));
  assert.equal(r.summary.merged, 0); assert.equal(r.summary.medianTokensPerMergedPr, null);
  assert.equal(JSON.parse(run(['--json', 'export'])).schema, 1);
  assert.throws(() => run(['--days']), /positive integer/);
  assert.throws(() => run(['--pr']), /positive integer/);
});

test('repeated Claude message usage and empty Codex accounting updates do not inflate or erase totals', t => {
  const { dir } = fixture(t), file = path.join(dir, 'transcript.jsonl');
  const message = { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 100, output_tokens: 10 }, content: [{ type: 'text', text: 'hello' }] } };
  fs.writeFileSync(file, [message, message].map(JSON.stringify).join('\n'));
  assert.equal(parseTranscript(file).stats.totalTokens, 110);
  fs.writeFileSync(file, [
    { type: 'session_meta', payload: { cwd: dir } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 10 } } } },
    { type: 'event_msg', payload: { type: 'token_count', info: null } },
  ].map(JSON.stringify).join('\n'));
  assert.equal(parseTranscript(file).stats.totalTokens, 110);
});

test('transferred serving evidence supports attribution without exporting prompt text', async t => {
  const { store, dir } = fixture(t);
  pr(store); session(store); linkSession(store, 's1', [{ pr: 12, share: 1 }]);
  store.log({ op: 'orient', session: 's1', served: ['n1'], task: 'private prompt' });
  let exported;
  await commands.impact({ store, pos: ['export'], flags: {}, out: s => exported = s });
  assert.ok(!exported.includes('private prompt'));
  assert.ok(JSON.parse(exported).events.some(e => e.op === 'orient' && e.served[0] === 'n1'));
  const file = path.join(dir, 'events.json'); fs.writeFileSync(file, exported);
  await commands.impact({ store, pos: ['import', file], flags: {}, out() {} });
  assert.equal(report(store).summary.cacheAssisted, 1);
});
