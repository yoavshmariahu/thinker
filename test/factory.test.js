// The Factory (factory.js): a session read as a pipeline. One rule puts every model call's tokens at a stage, and the
// loops are patterns read from the events by code. These tests pin the rule, each detector, the split of a call that
// touched two stages, and the merge over repositories, on synthetic sessions whose answers are known.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bashStage, stageOfTool, sessionFactory, detectLoops, mergeFactory, callCost, STAGES, REWORK_THRESHOLDS, verdictOf, renderFactory, weeklyTally, mergeWeekly, armTally, mergeArms, armRows, renderArms, ARMS, armsOf, trust } from '../src/factory.js';
import { weekColumns } from '../src/report.js';

const PRICE = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 };
// a call of a million fresh tokens costs a dollar at this price, so costs read as call counts
const call = () => ({ fresh: 1_000_000, read: 0, write: 0, out: 0 });
const tool = (call, name, input, extra = {}) => ({ t: 'tool', name, input, result: '', call, ...extra });

test('a shell command is staged by what it does: merge, then read-only, then write, else run', () => {
  assert.equal(bashStage('git add -A && git commit -m x && git push'), 'merge');
  assert.equal(bashStage('gh pr create --title x'), 'merge');
  assert.equal(bashStage('cd /x && git status'), 'explore');
  assert.equal(bashStage('grep -rn foo src | head'), 'explore');
  assert.equal(bashStage('sed -n 1,40p src/a.js'), 'explore');
  assert.equal(bashStage('sqlite3 db.sqlite "select 1"'), 'explore');
  assert.equal(bashStage('sed -i "" s/a/b/ src/a.js'), 'build');
  assert.equal(bashStage('mkdir -p out && cp a b'), 'build');
  assert.equal(bashStage('npm ci'), 'build');
  assert.equal(bashStage('cat > x.txt <<EOF\nhi\nEOF'), 'build');
  assert.equal(bashStage('npm test'), 'verify');
  assert.equal(bashStage('THINKER_TEST=1 node --test test/a.test.js'), 'verify');
  assert.equal(bashStage('node scripts/run.js'), 'verify');
});

test('a tool is staged in the transcripts\' one vocabulary', () => {
  assert.equal(stageOfTool('Read', { file_path: 'a' }), 'explore');
  assert.equal(stageOfTool('Grep', {}), 'explore');
  assert.equal(stageOfTool('Agent', { subagent_type: 'Explore' }), 'explore');
  assert.equal(stageOfTool('Edit', {}), 'build');
  assert.equal(stageOfTool('Write', {}), 'build');
  assert.equal(stageOfTool('Skill', { skill: 'code-review' }), 'review');
  assert.equal(stageOfTool('Agent', { subagent_type: 'general-purpose', description: 'Review the diff' }), 'review');
  assert.equal(bashStage('gh pr view 12 --comments'), 'review'); assert.equal(bashStage('gh pr diff 12'), 'review');
  assert.equal(bashStage('gh pr checks 12'), 'merge');
  assert.equal(stageOfTool('Skill', { skill: 'dataviz' }), 'build');
  assert.equal(stageOfTool('TodoWrite', {}), 'think');
  assert.equal(stageOfTool('mcp__claude-in-chrome__computer', {}), 'verify');
  assert.equal(stageOfTool('mcp__artemis__get_experiment', {}), 'explore');
});

test('a call\'s tokens go to its tool\'s stage; the first call after a prompt is Prompts; no tool is Think; two stages split', () => {
  const calls = [call(), call(), call(), call(), call()];
  const events = [
    { t: 'prompt', text: 'do it' },
    tool(0, 'Read', { file_path: 'a.js' }), // the first call after the prompt: Prompts, whatever it called
    tool(1, 'Read', { file_path: 'b.js' }),
    tool(2, 'Edit', { file_path: 'b.js' }), tool(2, 'Bash', { command: 'npm test' }), // one call, two stages: half each
    { t: 'say', text: 'done' }, // call 3 made no tool: Think
    tool(4, 'Bash', { command: 'git commit -m x && git push' }),
  ];
  const r = sessionFactory({ events, calls, model: 'm' }, { price: PRICE });
  assert.equal(r.calls, 5); assert.equal(Math.round(r.cost), 5);
  assert.equal(r.stages.prompts.cost, 1);
  assert.equal(r.stages.explore.cost, 1);
  assert.equal(r.stages.build.cost, 0.5); assert.equal(r.stages.verify.cost, 0.5);
  assert.equal(r.stages.think.cost, 1);
  assert.equal(r.stages.merge.cost, 1);
  assert.equal(Object.values(r.stages).reduce((a, s) => a + s.cost, 0), 5, 'the stages add up to the session');
  assert.deepEqual(STAGES.map(([k]) => k), ['prompts', 'think', 'explore', 'build', 'verify', 'review', 'merge']);
});

test('a fix loop is a test program failing and then passing, and spans every call between', () => {
  const calls = Array.from({ length: 6 }, call);
  const events = [
    { t: 'prompt', text: 'fix' },
    tool(0, 'Bash', { command: 'npm test' }, { error: true }),
    tool(1, 'Edit', { file_path: 'a.js' }),
    tool(2, 'Bash', { command: 'npm test -- test/a.test.js' }, { result: 'ℹ fail 1\n✖ a' }), // failing again, by its output: still one loop
    tool(3, 'Edit', { file_path: 'a.js' }),
    tool(4, 'Bash', { command: 'npm test' }, { result: 'ℹ pass 12' }),
    tool(5, 'Bash', { command: 'sqlite3 x.db "select"' }, { error: true }), // a failed query is not a fix loop
  ];
  const r = sessionFactory({ events, calls }, { price: PRICE });
  const fix = r.loops.filter(L => L.kind === 'fix');
  assert.equal(fix.length, 1);
  assert.deepEqual([fix[0].from, fix[0].to, fix[0].cost], [0, 4, 5]);
  assert.equal(r.stages.verify.rework, r.stages.verify.cost, 'every verify call sat inside the loop');
  assert.equal(r.stages.build.rework, 2);
});

test('a fix loop closes at a commit, a push or a new branch, and a denial or a crashed heredoc is not a failure', () => {
  const calls = Array.from({ length: 8 }, call);
  const events = [{ t: 'prompt', text: 'x' },
    tool(0, 'Bash', { command: 'npm test' }, { error: true, result: 'Permission for this action was denied by the Claude Code auto mode classifier.' }),
    tool(1, 'Bash', { command: "python3 - <<'EOF'\np='a.js'\nEOF\nnode --test test/a.test.js" }, { error: true, result: 'Traceback (most recent call last):\n  File "<stdin>", line 2, in <module>\nSyntaxError: invalid syntax' }),
    tool(2, 'Bash', { command: 'npm test' }, { result: 'ℹ pass 3' }), // neither refusal was a failure: nothing to close
    tool(3, 'Bash', { command: 'npm test' }, { result: 'ℹ fail 1' }),
    tool(4, 'Bash', { command: 'git commit -am wip && git push' }), // the work moved on
    tool(5, 'Bash', { command: 'git worktree add -b agent/next .worktrees/next' }),
    tool(6, 'Bash', { command: 'npm test' }, { result: 'ℹ pass 3' }), // a pass in the next piece of work is not the fix
    tool(7, 'Bash', { command: 'npm test && git commit -am ok' }, { result: 'ℹ fail 1', error: true }), // the commit never ran: stays open, unresolved
  ];
  const r = sessionFactory({ events, calls }, { price: PRICE });
  assert.deepEqual(r.loops.filter(L => L.kind === 'fix'), []);
  // fixed before the commit it is a loop, and a passing `npm test && git commit` closes it
  const fixed = [{ t: 'prompt', text: 'x' }, tool(0, 'Bash', { command: 'npm test' }, { result: 'ℹ fail 1' }), tool(1, 'Edit', { file_path: 'a' }),
    tool(2, 'Bash', { command: 'npm test && git commit -am fix' }, { result: 'ℹ pass 3' }), tool(3, 'Bash', { command: 'npm test' }, { result: 'ℹ fail 1' }), tool(4, 'Bash', { command: 'npm test' }, { result: 'ℹ pass 3' })];
  const r2 = sessionFactory({ events: fixed, calls: Array.from({ length: 5 }, call) }, { price: PRICE });
  assert.deepEqual(r2.loops.filter(L => L.kind === 'fix').map(L => [L.from, L.to]), [[0, 2], [3, 4]]);
});

test('a correction is an interruption or a ledger verdict, and the loop is the exchange that redid the work', () => {
  const calls = Array.from({ length: 6 }, call);
  const events = [
    { t: 'prompt', text: 'one' }, tool(0, 'Edit', { file_path: 'a' }), tool(1, 'Edit', { file_path: 'a' }),
    { t: 'interrupt' },
    { t: 'prompt', text: 'no, the other file' }, tool(2, 'Edit', { file_path: 'b' }), tool(3, 'Bash', { command: 'npm test' }),
    { t: 'prompt', text: 'three' }, tool(4, 'Read', { file_path: 'c' }),
    { t: 'prompt', text: 'four' }, tool(5, 'Read', { file_path: 'd' }),
  ];
  // the ledger read exchange 3 as corrected: the redo is exchange 4
  const r = sessionFactory({ events, calls }, { price: PRICE, corrected: new Set([3]) });
  const c = r.loops.filter(L => L.kind === 'correction').sort((a, b) => a.exchange - b.exchange);
  assert.deepEqual(c.map(L => [L.exchange, L.from, L.to, L.note]), [[2, 2, 3, 'interrupted'], [4, 5, 5, 'corrected']]);
  assert.equal(r.exchanges, 4);
});

test('a re-read is the same file read again twenty calls later; a review catch is a review skill followed by edits', () => {
  const calls = Array.from({ length: 30 }, call);
  const events = [{ t: 'prompt', text: 'x' }, tool(0, 'Read', { file_path: 'a.js' }), tool(5, 'Read', { file_path: 'a.js' }), tool(25, 'Read', { file_path: 'a.js', offset: 10 }),
    tool(26, 'Skill', { skill: 'code-review' }), tool(27, 'Edit', { file_path: 'a.js' }), tool(28, 'Edit', { file_path: 'b.js' })];
  const r = sessionFactory({ events, calls }, { price: PRICE });
  const rr = r.loops.filter(L => L.kind === 'reread'), rc = r.loops.filter(L => L.kind === 'reviewcatch');
  assert.deepEqual(rr.map(L => [L.from, L.to]), [[25, 25]], 'five calls apart is still in view; a different range still counts');
  assert.deepEqual(rc.map(L => [L.from, L.to]), [[26, 28]]);
});

test('a change to the open pull request is a review round when the person asked, the agent\'s own follow-up otherwise, and a bare push is neither', () => {
  const calls = Array.from({ length: 16 }, call);
  const events = [{ t: 'prompt', text: 'do a' },
    tool(0, 'Bash', { command: 'git push -u origin HEAD && gh pr create --title a' }),
    tool(1, 'Bash', { command: 'git push' }), // the branch pushed again with nothing changed: not a loop (49 of 153 here were this)
    { t: 'prompt', text: 'make the cell green, not the text' }, tool(2, 'Read', { file_path: 'src/a.js' }), // the person reviewing the open PR: call 2 is Review, not Prompts
    tool(3, 'Bash', { command: "python3 - <<'EOF'\nopen('src/a.js','w').write('x')\nEOF" }), // an edit by heredoc counts as a change
    tool(4, 'Bash', { command: 'git commit -am fix' }), tool(5, 'Bash', { command: 'git push' }),
    { t: 'prompt', text: '<task-notification>agent done</task-notification>' }, // a harness event, not the person
    tool(6, 'Edit', { file_path: 'src/a.js' }), tool(7, 'Bash', { command: 'git commit -am ci && git push' }),
    tool(8, 'Bash', { command: 'git checkout -b agent/next' }), // new work: the window closes
    { t: 'prompt', text: 'now b' }, tool(9, 'Read', { file_path: 'src/b.js' }),
    tool(10, 'Edit', { file_path: 'src/b.js' }), tool(11, 'Bash', { command: 'git commit -am b' }), // no PR open: not a loop, and call 9 is Prompts
    tool(12, 'Bash', { command: 'gh pr create --title b' }),
    { t: 'prompt', text: 'merged, thanks' }, tool(13, 'Bash', { command: 'git pull' }), // nothing changed: no loop; call 13 is Review
  ];
  const r = sessionFactory({ events, calls }, { price: PRICE });
  assert.deepEqual(r.loops.filter(L => L.kind === 'sentback').map(L => [L.from, L.to, L.cost]), [[2, 5, 4]], 'from the person\'s prompt to the push');
  assert.deepEqual(r.loops.filter(L => L.kind === 'followup').map(L => [L.from, L.to, L.cost]), [[6, 7, 2]], 'from the first change to the push');
  assert.equal(r.stages.review.cost, 2, 'the two prompt calls on an open pull request (calls 2 and 13)');
  assert.equal(r.stages.prompts.cost, 3, 'calls 0, 9 and the task notification');
  // with no commit after the opening there is none
  const r2 = sessionFactory({ events: events.slice(0, 5), calls }, { price: PRICE });
  assert.equal(r2.loops.filter(L => L.kind === 'sentback' || L.kind === 'followup').length, 0);
});

test('rework counts a call once however many loops hold it, and detectLoops alone returns the spans', () => {
  const calls = Array.from({ length: 4 }, call);
  const events = [{ t: 'prompt', text: 'x' }, tool(0, 'Bash', { command: 'npm test' }, { error: true }), tool(1, 'Edit', { file_path: 'a' }), tool(2, 'Bash', { command: 'npm test' }),
    { t: 'interrupt' }, { t: 'prompt', text: 'y' }, tool(3, 'Edit', { file_path: 'a' })];
  const r = sessionFactory({ events, calls }, { price: PRICE });
  const kinds = r.loops.map(L => L.kind).sort();
  assert.deepEqual(kinds, ['correction', 'fix']);
  const rework = Object.values(r.stages).reduce((a, s) => a + s.rework, 0);
  assert.equal(rework, 4, 'all four calls sit in some loop, each counted once');
});

test('without a price the view stays in tokens, and a call\'s cost prices writes at their TTL', () => {
  const r = sessionFactory({ events: [tool(0, 'Read', { file_path: 'a' })], calls: [{ fresh: 10, read: 20, write: 30, out: 5 }] }, { price: null });
  assert.equal(r.priced, false); assert.equal(r.cost, 0); assert.equal(r.tokens, 65);
  assert.equal(callCost({ fresh: 1e6, read: 0, write: 1e6, w1h: 1e6, out: 0 }, PRICE), 3, 'a million written at the one-hour rate is two dollars here');
  assert.equal(verdictOf(REWORK_THRESHOLDS.good), 'good'); assert.equal(verdictOf(REWORK_THRESHOLDS.bad), 'bad'); assert.equal(verdictOf(0.2), 'mid'); assert.equal(verdictOf(null), null);
});

test('All repositories adds the sums, takes the shares again, joins the loop kinds and keeps each pull request\'s repository', () => {
  const stage = (key, cost, rework) => ({ key, name: key, desc: '', cost, tokens: cost * 1e6, calls: 1, rework, reworkTokens: rework * 1e6 });
  const view = (cost, rework, rows) => ({ days: 42, from: 0, to: 1, sessions: 1, conversations: 1, calls: 10, cost, tokens: cost * 1e6, priced: true, unpriced: [],
    stages: [stage('prompts', 0, 0), stage('think', 0, 0), stage('explore', cost / 2, rework / 2), stage('build', cost / 2, rework / 2), stage('verify', 0, 0), stage('review', 0, 0), stage('merge', 0, 0)],
    loops: [{ key: 'fix', name: 'Fix loop', from: 'verify', to: 'build', loops: 1, sessions: 1, cost: rework, tokens: rework * 1e6, calls: 2, share: rework / cost }],
    rework, reworkTokens: rework * 1e6, reworkShare: rework / cost, prs: { rows } });
  const m = mergeFactory([
    { repo: 'a', name: 'A', view: { factory: view(10, 1, [{ number: 1, title: 'x', mergedAt: '2026-11-01', measured: 1, firstPass: true, cost: 2, loops: {} }]) } },
    { repo: 'b', name: 'B', view: { factory: view(30, 9, [{ number: 1, title: 'y', mergedAt: '2026-11-02', measured: 1, firstPass: false, cost: 6, loops: { fix: 1 } }]) } },
    { repo: 'c', name: 'C', view: {} },
  ]);
  assert.equal(m.cost, 40); assert.equal(m.rework, 10); assert.equal(m.reworkShare, 0.25);
  assert.equal(m.loops.length, 1); assert.equal(m.loops[0].loops, 2); assert.equal(m.loops[0].share, 0.25);
  const explore = m.stages.find(s => s.key === 'explore');
  assert.equal(explore.cost, 20); assert.equal(explore.share, 0.5); assert.equal(explore.reworkShare, 0.25); assert.equal(explore.verdict, 'mid');
  assert.equal(m.prs.merged, 2); assert.equal(m.prs.yield, 0.5); assert.deepEqual(m.prs.rows.map(r => r.repo), ['b', 'a']);
  assert.equal(mergeFactory([{ repo: 'c', view: {} }]), null);
  assert.match(renderFactory(m).join('\n'), /first-pass yield 50%/);
});

test('the weekly trend places a session in the week of its last request, sums its stages and loops, and merges by column', () => {
  const now = Date.UTC(2026, 10, 9, 12), cols = weekColumns(now, 3), DAY = 86400_000;
  const r = { cost: 4, tokens: 4e6, calls: 4, stages: Object.fromEntries(STAGES.map(([k]) => [k, { cost: k === 'build' ? 4 : 0, tokens: k === 'build' ? 4e6 : 0, calls: k === 'build' ? 4 : 0, rework: k === 'build' ? 1 : 0, reworkTokens: k === 'build' ? 1e6 : 0 }])), loops: [{ kind: 'fix', cost: 1, tokens: 1e6, calls: 1 }] };
  const t = weeklyTally(cols);
  t.add(cols[2].t + DAY, r, 'a'); t.add(cols[2].t + 2 * DAY, r, 'b'); t.add(cols[0].t + DAY, r, 'c'); t.add(cols[0].t - DAY, r, 'z'); // z is before the window: dropped
  const w = t.finish();
  assert.equal(w.columns.length, 3);
  assert.deepEqual(w.totals.map(x => [x.cost, x.sessions]), [[4, 1], [0, 0], [8, 2]]);
  assert.deepEqual(w.stages.build.map(c => c.rework), [1, 0, 2]);
  assert.deepEqual(w.loops.fix.map(c => [c.loops, c.sessions]), [[1, 1], [0, 0], [2, 2]]);
  const m = mergeWeekly([w, w, null]);
  assert.deepEqual(m.totals.map(x => x.cost), [8, 0, 16]);
  assert.deepEqual(m.loops.fix.map(c => c.loops), [2, 0, 4]);
  assert.equal(mergeWeekly([null]), null);
});

test('the arms split sums by a session\'s side, leave a session with no profile arm out, count a pull request on one side only, and merge', () => {
  const r = (cost, rework, loops = []) => ({ cost, tokens: cost * 1e6, calls: 2, exchanges: 2, cacheWrite: 1, cacheRead: 9, stages: Object.fromEntries(STAGES.map(([k]) => [k, { cost: k === 'build' ? cost : 0, tokens: k === 'build' ? cost * 1e6 : 0, calls: 0, rework: k === 'build' ? rework : 0, reworkTokens: k === 'build' ? rework * 1e6 : 0 }])), loops: loops.map(kind => ({ kind, cost: 1, tokens: 1e6, calls: 1 })) });
  const t = armTally(0.15);
  t.add({ profile: 'shown', compression: 'on', cleared: true }, r(10, 1, ['fix']), 'a');
  t.add({ profile: 'holdout', compression: 'on' }, r(20, 8, ['fix', 'fix']), 'b');
  t.add({ profile: null, compression: 'holdout' }, r(30, 3), 'c'); // before the profile: on no profile side
  t.add({ profile: null, compression: null }, r(5, 0), 'd'); // never reached the trigger: on no compression side
  t.pr({ profile: 'shown', compression: 'on' }, true, 12); t.pr({ profile: null, compression: null }, false, 50);
  const a = t.finish();
  assert.equal(a.profile.shown.sessions, 1); assert.equal(a.profile.holdout.sessions, 1); assert.equal(a.compression.on.sessions, 2); assert.equal(a.compression.holdout.sessions, 1);
  assert.equal(a.compression.rate, 0.15); assert.equal(a.profile.shown.prs.firstPass, 1); assert.equal(a.compression.holdout.prs.merged, 0);
  assert.equal(a.compression.on.treated, 1, 'a session with a clear record counts as treated once'); assert.equal(a.compression.on.sessions, 2);
  assert.equal(a.profile.shown.prs.cost, 12, 'a pull request\'s cost lands on its side'); assert.equal(a.compression.holdout.prs.cost, 0);
  assert.deepEqual([a.profile.shown.loops.fix.loops, a.profile.holdout.loops.fix.loops, a.profile.holdout.loops.fix.sessions], [1, 2, 1]);
  const m = mergeArms([a, a, null]);
  assert.equal(m.compression.on.cost, 60); assert.equal(m.profile.holdout.loops.fix.loops, 4); assert.equal(m.compression.holdout.sessions, 2); assert.equal(m.compression.on.treated, 2); assert.equal(m.profile.shown.prs.cost, 24);
  const v = { cost: 60, arms: a, loops: [{ key: 'fix', name: 'Fix loop' }] }, rows = armRows(v, 'profile');
  assert.equal(rows.thin, true); assert.equal(rows.trust.level, 'none'); assert.equal(rows.rows.find(x => x.label === 'Rework share').on, 0.1); assert.equal(rows.rows.find(x => x.label === 'Rework share').off, 0.4);
  assert.equal(rows.rows.find(x => x.label === 'Cost per merged pull request').on, 12); assert.equal(rows.rows.find(x => x.label === 'Cost per merged pull request').off, null);
  assert.equal(rows.rows.find(x => x.label === 'Fix loop per session').off, 2);
  const cmp = armRows(v, 'compression'); assert.equal(cmp.rows[1].label, 'Of them actually cleared'); assert.equal(cmp.rows[1].on, 1); assert.ok(cmp.rows.some(x => x.label.startsWith('Cache writes')));
  assert.match(renderArms(v, 'profile').join('\n'), /Memory profile: shown the profile against held out/);
  assert.equal(armRows(v, 'nothing'), null); assert.deepEqual(Object.keys(ARMS), ['profile', 'compression']);
});

test('a session below the clearing\'s trigger is on neither of its sides, and one with a record counts as cleared', t => {
  const st = { dir: t.name, repo: '/nowhere', config: () => ({}), localDir: '/nowhere' };
  const a = armsOf(st, 'abc', 0.15, { peak: 10_000 });
  assert.equal(a.compression, null); assert.equal(a.cleared, false);
  const b = armsOf(st, 'abc', 0.15, { peak: 200_000 });
  assert.ok(b.compression === 'on' || b.compression === 'holdout');
  assert.equal(armsOf(st, 'abc', 0, { peak: 200_000 }).compression, null, 'no share, no split');
});

test('trust is computed from the sides\' sizes and the spread of their session costs, and a difference inside the band is flat', () => {
  const side = (n, mean, cv) => ({ sessions: n, cost: n * mean, cost2: n * (mean * mean) * (1 + cv * cv) });
  assert.equal(trust(side(5, 10, 1), side(5, 10, 1)).level, 'none');
  const low = trust(side(30, 10, 2), side(30, 10, 2)); assert.equal(low.level, 'low'); assert.ok(low.band > 0.5);
  const good = trust(side(400, 10, 1), side(400, 10, 1)); assert.equal(good.level, 'good'); assert.ok(good.band < 0.2 && good.band > 0.1);
  assert.equal(trust(side(0, 0, 0), side(10, 1, 1)).level, 'none');
  // the rows carry the verdict: a 10% gap is flat at a 14% band, a 40% gap is not
  const stages = Object.fromEntries(STAGES.map(([k]) => [k, { cost: 0, tokens: 0, rework: 0, reworkTokens: 0 }]));
  const cell = (n, mean, cv, rework) => ({ ...side(n, mean, cv), exchanges: n * 2, tokens: n * mean * 1e6, rework, reworkTokens: rework * 1e6, cacheWrite: 1, cacheRead: 9, treated: 0, stages, loops: {}, prs: { merged: 0, firstPass: 0, cost: 0 } });
  const v = { cost: 1, loops: [], arms: { profile: { rate: null, shown: cell(400, 11, 1, 1100), holdout: cell(400, 10, 1, 2000) } } };
  const t = armRows(v, 'profile');
  assert.equal(t.rows.find(x => x.label === 'Cost per session').verdict, 'flat');
  assert.equal(t.rows.find(x => x.label === 'Rework share').verdict, 'good');
  // a pull request row takes its band from its own counts: 12 pull requests a side is too few whatever the sessions say
  v.arms.profile.shown.prs = { merged: 100, firstPass: 20, cost: 1000 }; v.arms.profile.holdout.prs = { merged: 8, firstPass: 1, cost: 50 };
  assert.equal(armRows(v, 'profile').rows.find(x => x.label === 'First-pass yield').verdict, 'flat');
  assert.ok(trust(side(400, 10, 1), side(400, 10, 1)).bandFor(100, 8) > trust(side(400, 10, 1), side(400, 10, 1)).band);
});
