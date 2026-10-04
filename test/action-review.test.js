import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReview, publish, MARKER } from '../action/review/post.mjs';

const report = {
  scope: 'working tree since origin/main', kinds: ['behavior'], model: 'sonnet', cost: 0.07,
  notes: { consulted: 2, assessed: 2, staleBefore: [], outdated: [], uncovered: ['src/other.js'] },
  counts: { error: 1, warning: 1, info: 0 },
  behaviors: [
    { id: 'invoke-validates', title: 'invoke validates ctx before main', mutability: 'fixed', body: 'Command.invoke calls validate before main.\nmain assumes ctx is set.', outcome: 'violated', reason: 'invoke skips validate', before: '' },
    { id: 'convert-str', title: 'convert returns str', mutability: 'mutable', outcome: 'upheld', reason: '', before: '' },
  ],
  findings: [
    { severity: 'warning', file: 'src/core.py', line: 0, message: 'behavior "x" is no longer upheld', evidence: '', confidence: 0.6, note: 'invoke-validates', notes: ['invoke-validates'], inChange: false },
    { severity: 'error', file: 'src/core.py', line: 5, message: 'Command.invoke skips validate(ctx)', evidence: '-        validate(ctx)', confidence: 0.9, note: 'invoke-validates', notes: ['invoke-validates'], inChange: true },
  ],
  errors: [],
};

test('buildReview: findings on changed lines go inline, the rest and the behaviors table go in the body; an error requests changes and fails the check', () => {
  const r = buildReview(report);
  assert.equal(r.post, true); assert.equal(r.event, 'REQUEST_CHANGES'); assert.equal(r.fail, true);
  assert.equal(r.comments.length, 1);
  assert.deepEqual([r.comments[0].path, r.comments[0].line, r.comments[0].side], ['src/core.py', 5, 'RIGHT']);
  assert.match(r.comments[0].body, /\*\*error\*\* Command.invoke skips validate\(ctx\)/);
  assert.match(r.comments[0].body, /invoke validates ctx before main \(invoke-validates\), 90%/);
  assert.ok(r.body.startsWith(MARKER));
  // a fixed behavior broken: said first, with what it requires, what the change does and what merging means
  assert.match(r.body, /^<!-- thinker-review -->\n### thinker review[^\n]*\n\n## ⛔ This change breaks a fixed behavior of the system/);
  assert.match(r.body, /\*\*invoke validates ctx before main\*\* <sub>fixed, `invoke-validates`<\/sub>\n\nWhat it requires:\n\n> Command.invoke calls validate before main\./);
  assert.match(r.body, /What this change does instead: invoke skips validate/);
  assert.match(r.body, /once it is merged on the default branch the code is the truth and this behavior is revised to match it/);
  assert.match(r.body, /\| ❌ \| invoke validates ctx before main <sub>fixed, `invoke-validates`<\/sub> \| violated: invoke skips validate \|/);
  assert.match(r.body, /\| ✅ \| convert returns str .* \| upheld \|/);
  assert.match(r.body, /Findings not on a changed line/);
  assert.match(r.body, /\*\*warning\*\* `src\/core.py` behavior "x" is no longer upheld/);
  assert.match(r.body, /no desired behavior rests on `src\/other.js`/);
  assert.match(r.body, /1 error, 1 warning, 0 info · 2 desired behaviors consulted, 2 assessed with sonnet \(\$0.07\)/);
  // fail-on
  assert.equal(buildReview(report, { failOn: 'none' }).fail, false);
  assert.equal(buildReview({ ...report, counts: { error: 0, warning: 1, info: 0 } }, { failOn: 'warning' }).fail, true);
  assert.equal(buildReview({ ...report, counts: { error: 0, warning: 1, info: 0 } }).event, 'COMMENT');
  // a mutable one broken: the quieter block
  const m = buildReview({ ...report, counts: { error: 0, warning: 1, info: 0 }, behaviors: [{ ...report.behaviors[0], mutability: 'mutable' }] });
  assert.ok(!m.body.includes('⛔')); assert.match(m.body, /#### ⚠ This change alters a behavior of the system/); assert.match(m.body, /A mutable behavior changes with the code/);
});

test('buildReview: nothing to report posts nothing when quiet, the table when not; empty, missing cache and failed reviews are said plainly', () => {
  const clean = { ...report, counts: { error: 0, warning: 0, info: 0 }, findings: [], behaviors: report.behaviors.map(b => ({ ...b, outcome: 'upheld', reason: '' })) };
  const q = buildReview(clean);
  assert.equal(q.post, false); assert.equal(q.fail, false); assert.equal(q.event, 'COMMENT');
  assert.equal(buildReview(clean, { quiet: false }).post, true);
  assert.match(buildReview(clean, { quiet: false }).body, /\| ✅ \| invoke validates ctx before main/);
  const empty = buildReview({ empty: true, scope: 'x' });
  assert.equal(empty.post, false); assert.match(empty.body, /Nothing to review/);
  const none = buildReview({ noCache: true });
  assert.equal(none.post, false); assert.match(none.body, /no `.thinker\/` cache/);
  const failed = buildReview({ error: 'no model key' });
  assert.equal(failed.post, true); assert.equal(failed.fail, false); assert.match(failed.body, /could not run: no model key/);
});

test('publish: dismisses the earlier request for changes, posts the review, and folds inline comments into the body when GitHub refuses a line', async () => {
  const calls = [];
  const fake = (responses) => async (url, init) => {
    calls.push({ method: init.method, url: url.replace('https://api.github.com', ''), body: init.body ? JSON.parse(init.body) : undefined });
    const r = responses.shift() || { status: 200, body: {} };
    return { ok: r.status < 300, status: r.status, text: async () => JSON.stringify(r.body) };
  };
  const review = buildReview(report);
  const prior = [{ id: 1, state: 'CHANGES_REQUESTED', body: MARKER + ' old' }, { id: 2, state: 'COMMENTED', body: MARKER + ' old' }, { id: 3, state: 'CHANGES_REQUESTED', body: 'a human' }];
  let res = await publish({ review, slug: 'o/r', number: 7, sha: 'abc', token: 't', fetch: fake([{ status: 200, body: prior }, { status: 200, body: {} }, { status: 200, body: { id: 9 } }]), log: () => {} });
  assert.deepEqual(res, { posted: true, dismissed: [1], id: 9, status: 200 });
  assert.deepEqual(calls.map(c => `${c.method} ${c.url}`), ['GET /repos/o/r/pulls/7/reviews?per_page=100', 'PUT /repos/o/r/pulls/7/reviews/1/dismissals', 'POST /repos/o/r/pulls/7/reviews']);
  assert.equal(calls[2].body.event, 'REQUEST_CHANGES'); assert.equal(calls[2].body.commit_id, 'abc'); assert.equal(calls[2].body.comments.length, 1);
  // a 422 on the comments: once more with everything in the body
  calls.length = 0;
  res = await publish({ review, slug: 'o/r', number: 7, sha: 'abc', token: 't', fetch: fake([{ status: 200, body: [] }, { status: 422, body: { message: 'line not in diff' } }, { status: 200, body: { id: 10 } }]), log: () => {} });
  assert.equal(res.posted, true);
  assert.equal(calls[2].body.comments.length, 0);
  assert.match(calls[2].body.body, /#### Findings on changed lines\n\n- `src\/core.py:5` \*\*error\*\* Command.invoke skips validate/);
  // a read-only token (a fork): nothing posted, no throw
  const logs = [];
  res = await publish({ review, slug: 'o/r', number: 7, sha: 'abc', token: 't', fetch: fake([{ status: 200, body: [] }, { status: 403, body: { message: 'Resource not accessible by integration' } }]), log: m => logs.push(m) });
  assert.equal(res.posted, false); assert.equal(res.status, 403); assert.match(logs[0], /read-only GITHUB_TOKEN/);
  // nothing to post: the earlier request is still dismissed (the push fixed it)
  calls.length = 0;
  res = await publish({ review: buildReview({ ...report, counts: { error: 0, warning: 0, info: 0 }, findings: [], behaviors: [] }), slug: 'o/r', number: 7, sha: 'abc', token: 't', fetch: fake([{ status: 200, body: prior }, { status: 200, body: {} }]), log: () => {} });
  assert.deepEqual(res, { posted: false, dismissed: [1] });
  assert.equal(calls.length, 2);
});
