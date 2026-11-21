// Upkeep (upkeep.js, upkeep-sweep.js): what thinker does by itself between sessions -- what it finds, what it does
// and how often, and what it says it did. Nothing is left for the person to do by hand. Git here is real, in scratch repositories; no model
// and no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// the machine's own settings and its daily count live under thinker's home: a scratch one, so the tests neither read
// nor write the person's
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-upkeep-home-')));
for (const [k, v] of Object.entries({ THINKER_LOG: 'local', THINKER_TELEMETRY: 'off', THINKER_HOME: HOME })) process.env[k] = v;

const { Store } = await import('../src/store.js');
const { appendDelivery } = await import('../src/delivery-journal.js');
const { findMess, sweep, unsweep, listWorktrees } = await import('../src/upkeep-sweep.js');
const { upkeepCheck, upkeepPending, upkeepDo, upkeepDismiss, upkeepUndo, upkeepView, upkeepFeed, upkeepDetail, upkeepDelegated, delegatedTotalSaid, mergeUpkeepViews, renderUpkeep, behaviorOf, setBehavior, steerBehavior, behaviorSaid, mayAct, readUpkeep, impactSaid, BEHAVIOR, UPKEEP } = await import('../src/upkeep.js');
const { delegationBySession } = await import('../src/report-savings.js');
const { delegateConfig, DELEGATE_DEFAULTS } = await import('../src/delegate.js');
const { changeHistory, VIA } = await import('../src/context-suggest.js');
const { maintain, renderMaintain, maintenanceNotice } = await import('../src/maintain.js');
const { spendMetrics } = await import('../src/telemetry.js');

const DAY = 86_400_000;
// A repository with a default branch and one commit; `git` runs in it (or in `cwd`), `commit` adds a file.
function repo(config = null) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-upkeep-')));
  const git = (args, cwd = dir) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q', '-b', 'main']);
  const commit = (file, cwd = dir, text = file) => { fs.writeFileSync(path.join(cwd, file), `${text}\n`); git(['add', '-A'], cwd); git(['commit', '-q', '-m', file], cwd); return git(['rev-parse', 'HEAD'], cwd); };
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.env\nruns/\n');
  commit('a.txt');
  const store = new Store(dir).init();
  if (config) fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ version: 1, ...config }));
  return { dir, git, commit, store };
}
// the machine's settings and counts start empty for a test that reads them
const freshHome = () => { fs.rmSync(path.join(HOME, 'config.json'), { force: true }); fs.rmSync(path.join(HOME, 'state'), { recursive: true, force: true }); };
// nothing in a scratch repository is a day old: the rules are asked as of two days from now
const LATER = () => Date.now() + 2 * DAY;
const tree = (r, name) => { const p = path.join(r.dir, '.worktrees', name); r.git(['worktree', 'add', '-q', '-b', `agent/${name}`, p, 'main']); return p; };
// merge a worktree's branch into main the way GitHub does when it keeps the commits
const mergeIn = (r, branch) => r.git(['merge', '-q', '--no-ff', '-m', `merge ${branch}`, branch]);
const pr = (r, number, branch, head, state = 'MERGED') => appendDelivery(r.store, { op: 'pr', pr: { number, branch, head, state, title: branch } });

test('the sweep finds what is merged, by ancestry or by a merged pull request with this exact head, and nothing else', () => {
  const r = repo();
  const done = tree(r, 'done'); r.commit('done.txt', done); mergeIn(r, 'agent/done');
  // a squash merge: the commits are on main under another hash, so only the pull request's head can say it merged
  const squashed = tree(r, 'squashed'); const head = r.commit('squashed.txt', squashed); pr(r, 7, 'agent/squashed', head);
  const open = tree(r, 'open'); r.commit('open.txt', open);
  // a pull request merged, then one more commit on the branch: that commit is nowhere else
  const moved = tree(r, 'moved'); const old = r.commit('moved.txt', moved); pr(r, 8, 'agent/moved', old); r.commit('moved-more.txt', moved);
  r.git(['branch', 'left-over', 'main']); // a bare branch at main: nothing of its own
  r.git(['branch', 'release/1.0', 'main']);
  const m = findMess(r.store, { now: LATER(), cwds: [], sizeOf: () => 2048 });
  assert.deepEqual(m.worktrees.map(w => [path.basename(w.path), w.why, w.kb]).sort(), [['done', 'on main', 2048], ['squashed', 'PR #7 merged', 2048]]);
  assert.deepEqual(m.branches.map(b => [b.name, b.why]), [['left-over', 'on main']], 'the default branch and a release branch are never listed');
  assert.deepEqual(m.kept.map(k => [path.basename(k.path), k.why]).sort(), [['moved', 'not merged'], ['open', 'not merged']]);
});

test('a worktree stays, with its reason, when anything in it could be lost or somebody is in it', () => {
  const r = repo();
  const names = ['dirty', 'secret', 'runs', 'modules', 'busy', 'here', 'fresh'];
  const at = Object.fromEntries(names.map(n => [n, tree(r, n)]));
  fs.writeFileSync(path.join(at.dirty, 'notes.txt'), 'not committed\n');
  fs.writeFileSync(path.join(at.secret, '.env'), 'KEY=1\n');
  fs.mkdirSync(path.join(at.runs, 'runs')); fs.writeFileSync(path.join(at.runs, 'runs', 'r1.json'), '{}');
  fs.mkdirSync(path.join(at.modules, 'node_modules')); fs.writeFileSync(path.join(at.modules, 'node_modules', 'x.js'), '');
  r.git(['worktree', 'add', '-q', '--detach', path.join(r.dir, '.worktrees', 'detached'), 'main']);
  const m = findMess(r.store, { now: LATER(), cwds: [path.join(at.busy, 'src')], here: at.here, sizeOf: () => null });
  const why = Object.fromEntries(m.kept.map(k => [path.basename(k.path), k.why]));
  assert.equal(why.dirty, 'has uncommitted work');
  assert.match(why.secret, /holds files git ignores \(\.env\)/);
  assert.match(why.runs, /holds files git ignores \(runs\)/);
  assert.equal(why.busy, 'a process is running in it');
  assert.equal(why.here, 'you are in it');
  assert.equal(why.detached, 'no branch (detached)');
  // node_modules is written again by an install: a worktree holding only that loses nothing
  assert.deepEqual(m.worktrees.map(w => path.basename(w.path)).sort(), ['fresh', 'modules']);
  // made a moment ago, as of now: nothing changed in the last day is called abandoned
  const now = findMess(r.store, { cwds: [], here: at.here, sizeOf: () => null });
  assert.deepEqual(now.worktrees, []);
  assert.equal(now.kept.find(k => path.basename(k.path) === 'fresh').why, 'changed in the last day');
  // where the machine cannot say which directories are in use, nothing is known to be free
  assert.equal(findMess(r.store, { now: LATER(), cwds: null, sizeOf: () => null }).worktrees.length, 0);
});

test('a sweep removes what was found, checks each again as it goes, and can be put back', () => {
  const r = repo();
  const done = tree(r, 'done'); r.commit('done.txt', done); mergeIn(r, 'agent/done');
  const squashed = tree(r, 'squashed'); const head = r.commit('squashed.txt', squashed); pr(r, 7, 'agent/squashed', head);
  const late = tree(r, 'late'); r.commit('late.txt', late); mergeIn(r, 'agent/late');
  r.git(['branch', 'left-over', 'main']);
  const opts = { now: LATER(), cwds: [] };
  const mess = findMess(r.store, { ...opts, sizeOf: () => 1024 });
  assert.equal(mess.worktrees.length, 3);
  // between the check and the removal: somebody wrote a file in one of them
  fs.writeFileSync(path.join(late, 'wip.txt'), 'new work\n');
  const s = sweep(r.store, mess, opts);
  assert.deepEqual(s.worktrees.map(w => path.basename(w.path)).sort(), ['done', 'squashed']);
  assert.deepEqual(s.branches.map(b => b.name).sort(), ['agent/done', 'agent/squashed', 'left-over']);
  assert.equal(s.kb, 2048);
  assert.deepEqual(s.skipped.map(x => [path.basename(x.path), x.why]), [['late', 'changed since it was found']]);
  assert.ok(fs.existsSync(late) && !fs.existsSync(done) && !fs.existsSync(squashed));
  assert.deepEqual(listWorktrees(r.dir).map(w => w.branch).sort(), ['agent/late', 'main']);
  // the squash-merged branch is on main under another hash: only its name and commit bring it back
  const back = unsweep(r.store, { branches: s.branches, worktrees: s.worktrees });
  assert.deepEqual(back.failed, []);
  assert.equal(r.git(['rev-parse', 'agent/squashed']), head);
  assert.ok(fs.existsSync(path.join(squashed, 'squashed.txt')));
  // and putting back twice says so instead of forcing anything
  assert.equal(unsweep(r.store, { branches: s.branches, worktrees: s.worktrees }).failed.length, 5);
});

test('a branch that moved after it was found is not deleted', () => {
  const r = repo();
  r.git(['branch', 'left-over', 'main']);
  const opts = { now: LATER(), cwds: [] };
  const mess = findMess(r.store, { ...opts, sizeOf: () => null });
  assert.deepEqual(mess.branches.map(b => b.name), ['left-over']);
  r.git(['checkout', '-q', 'left-over']); r.commit('more.txt'); r.git(['checkout', '-q', 'main']);
  const s = sweep(r.store, mess, { ...opts, now: Date.now() + 4 * DAY });
  assert.deepEqual(s.branches, []);
  assert.ok(r.git(['rev-parse', 'left-over']));
});

test('how thinker behaves: it does its work itself unless told otherwise, the machine\'s settings under a repository\'s, and only what is known is kept', () => {
  freshHome();
  const r = repo();
  const { set, ...b } = behaviorOf(r.store);
  assert.deepEqual(b, BEHAVIOR);
  assert.deepEqual([b.level, b.sweep, b.prs, b.tools, b.important, b.prEveryDays, b.prsPerDay, b.toolEveryDays], ['auto', true, true, true, 'high', 7, 1, 1], 'on its own, for important things, and not often');
  assert.equal(behaviorSaid(b), 'Thinker acts on its own here, for important things only: it removes merged worktrees and branches, puts up a pull request for a costly section nobody needs, at most one every 7 days, switches off costly tools nobody calls.');
  // the machine's wish, then one repository's over it
  assert.equal(setBehavior(r.store, 'prEveryDays', '30').said, 'prEveryDays is now 30 on this machine');
  assert.equal(setBehavior(r.store, 'prs', 'off', { scope: 'repo' }).said, 'prs is now false in this repository');
  const other = repo();
  assert.deepEqual([behaviorOf(r.store).prs, behaviorOf(r.store).prEveryDays, behaviorOf(other.store).prs, behaviorOf(other.store).prEveryDays], [false, 30, true, 30]);
  assert.deepEqual(behaviorOf(r.store).set, { machine: { prEveryDays: 30 }, repo: { prs: false } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')).upkeep, { prEveryDays: 30 });
  // nothing unknown is written, and a hand-edited file is read the same way
  assert.match(setBehavior(r.store, 'recklessness', 'max').error, /there is no setting called recklessness/);
  assert.match(setBehavior(r.store, 'level', 'yolo').error, /level cannot be "yolo"/);
  assert.match(setBehavior(r.store, 'prEveryDays', 0).error, /prEveryDays cannot be 0/);
  assert.equal(behaviorOf(repo({ upkeep: { level: 'yolo', prsPerDay: 'many', tools: false } }).store).level, 'auto');
  assert.equal(behaviorOf(repo({ upkeep: { tools: false } }).store).tools, false);
  assert.equal(behaviorOf(repo({ upkeep: false }).store).level, 'off');
  assert.equal(behaviorSaid(behaviorOf(repo({ upkeep: { level: 'ask' } }).store)), 'Thinker does nothing here until you tell it to.');
  freshHome();
});

// a kept Context report: a costly section, a second one, a cheap one, and a tool, each as Find Savings flags them
const section = (id, title, waste, wastedWindow) => ({ id, file: 'AGENTS.md', title, tokens: 2000, wasted: 30_000, wastedWindow, waste, usedShare: 0.02, text: `About ${title}.` });
const view = () => ({
  days: 7, sessions: 40, rate: { perToken: 5e-6 },
  instructions: { sessions: 40, sections: [section('releases', 'Releases', 'high', 4_000_000), section('ports', 'Ports', 'high', 2_000_000), section('style', 'Style', 'medium', 900_000)] },
  skills: [], outputs: { tools: [] },
  tools: [{ name: 'Workflow', kind: 'tool', group: 'builtin', client: 'claude', key: 'builtin:Workflow', label: 'Workflow tool', used: 0, loaded: 40, tokens: 3000, wasted: 20_000, wastedWindow: 1_000_000, waste: 'high' }],
});
// the same report with no tool in it: a tool switch writes the agent's own settings, which no test here does
const sectionsOnly = () => ({ ...view(), tools: [] });
const spawned = () => { const calls = []; return { calls, spawn: (cmd, args) => { calls.push(args); return { pid: process.pid, on() {}, unref() {} }; } }; };
// the functions a check is given in place of the machine: the report, whether a pull request can be opened, the sweep
const given = (sp, { canPr = true, kb = 3 * 1024 * 1024, report = sectionsOnly } = {}) => ({ view: report, prAvailable: () => ({ ok: canPr }), spawn: sp.spawn, findMess: s => findMess(s, { now: LATER(), cwds: [], sizeOf: () => kb }), sweep: (s, m) => sweep(s, m, { now: LATER(), cwds: [] }) });
const none = () => ({ worktrees: [], branches: [], kept: [] });

test('told to wait for the person\'s word, a check does nothing: what is important is held, with why, for the chat to speak of', async () => {
  freshHome();
  const r = repo({ upkeep: { level: 'ask' } });
  const done = tree(r, 'done'); r.commit('done.txt', done); mergeIn(r, 'agent/done');
  r.git(['branch', 'left-over', 'main']);
  const sp = spawned();
  const check = await upkeepCheck(r.store, { fns: given(sp, { report: view }) });
  assert.deepEqual(check.did, []); assert.equal(check.pending, 4); assert.equal(sp.calls.length, 0); assert.ok(fs.existsSync(done));
  const { pending, notes, lastCheck } = upkeepPending(r.store);
  assert.ok(lastCheck); assert.deepEqual(notes, []);
  // the cheap section is not important: it is not held at all, it stays on Find Savings
  assert.deepEqual(pending.map(i => [i.id, i.kind, i.title, i.why, Boolean(i.later)]), [
    ['change:section:AGENTS.md:releases', 'pr', 'AGENTS.md · Releases', 'you asked to be asked first', false],
    ['change:section:AGENTS.md:ports', 'pr', 'AGENTS.md · Ports', 'you asked to be asked first', false],
    ['sweep', 'do', '1 merged worktree and 1 branch can go · 3.0 GB', 'you asked to be asked first', false],
    ['change:claude:builtin:Workflow', 'do', 'Workflow tool', 'you asked to be asked first', false],
  ]);
  assert.match(pending[0].detail, /^Needed in 2% of prompts; ~2k tokens in every model call\. About \$20\.0 went on it unused over the last 7 days\.$/);
  // neither door lists these as things to do: both say how much is held, and what was done
  const v = upkeepView(r.store);
  assert.deepEqual([v.summary, v.later, v.held, v.level], ['4 held back until you say.', 0, 4, 'ask']);
  const text = renderUpkeep(v).join('\n');
  assert.match(text, /^Recent activity · thinker last looked just now\n {2}4 held back until you say\. Thinker does nothing here until you tell it to\.\n\n {2}Nothing yet\./);
  assert.doesNotMatch(text, /Needs you|thinker activity do|Releases/);
  // a kind switched off is held for that reason; the rest go ahead
  const q = repo({ upkeep: { prs: false } });
  await upkeepCheck(q.store, { fns: { ...given(spawned()), findMess: none }, act: false });
  assert.deepEqual(upkeepPending(q.store).pending.map(i => i.why), ['you told it not to (prs is off)', 'you told it not to (prs is off)']);
});

test('on the person\'s word (the chat\'s do, leave and undo): done at once whatever the limits, left for three months, and what is taken back stays back', async () => {
  freshHome();
  const r = repo({ upkeep: { level: 'ask' } });
  const done = tree(r, 'done'); r.commit('done.txt', done); mergeIn(r, 'agent/done');
  const sp = spawned(), fns = given(sp, { kb: 600 * 1024, report: view });
  await upkeepCheck(r.store, { fns });
  // the section: a job in the background that ends as a pull request, by the door `thinker`
  const a = await upkeepDo(r.store, 'change:section:AGENTS.md:releases', { fns });
  assert.match(a.said, /Compressing 1 section in the background: a pull request opens/);
  assert.deepEqual(sp.calls[0].slice(1, 5), ['instructions', '--compress', 'releases', '--pr'], 'a section only ever as a pull request');
  const h = changeHistory(r.store);
  assert.equal(h.length, 1); assert.equal(h[0].via, VIA.thinker); assert.equal(h[0].job.state, 'running');
  assert.deepEqual(upkeepPending(r.store).pending.map(i => i.id), ['change:section:AGENTS.md:ports', 'sweep', 'change:claude:builtin:Workflow'], 'a decided change is no longer held');
  // ... and never by writing the file, even on the person's word, where no pull request can be opened
  assert.match((await upkeepDo(r.store, 'change:section:AGENTS.md:ports', { fns: { ...fns, prAvailable: () => ({ ok: false }) } })).error, /no pull request can be opened from here now/);
  assert.equal(sp.calls.length, 1);
  // the sweep
  const s = await upkeepDo(r.store, 'sweep', { fns });
  assert.equal(s.said, 'Removed 1 merged worktree and 1 branch · 600 MB freed');
  assert.ok(!fs.existsSync(done));
  // "never mind the tool": left alone in the history Find Savings reads too, and by thinker for three months
  assert.equal(upkeepDismiss(r.store, 'change:claude:builtin:Workflow', { fns }).said, 'Workflow tool: left alone for the next 90 days');
  assert.equal(changeHistory(r.store).filter(e => e.decision === 'dismissed' && e.via === VIA.thinker).length, 1);
  await upkeepCheck(r.store, { fns, now: Date.now() + 30 * DAY });
  assert.ok(!upkeepPending(r.store, { now: Date.now() + 30 * DAY }).pending.some(i => i.id === 'change:claude:builtin:Workflow'), 'still left a month on, though Find Savings offers it again after a week');
  // the activity: a line an action, with what it came to: the disk a sweep freed; for a section still being made, what
  // Find Savings expected of it, said as such
  const feed = upkeepFeed(r.store);
  assert.deepEqual(feed.map(f => [f.text, f.impactSaid, f.by]).sort(), [['Removed 1 merged worktree and 1 branch', '600 MB freed', 'you'], ['Shortening AGENTS.md · Releases', 'about −30k tokens per prompt once merged', 'you']]);
  // taking the sweep back: put back, and never swept again
  const undo = feed.find(f => f.undo).undo;
  assert.equal((await upkeepUndo(r.store, undo)).said, 'Put back 1 branch and 1 worktree');
  assert.ok(fs.existsSync(path.join(done, 'done.txt')));
  assert.equal((await upkeepUndo(r.store, undo)).error, 'already taken back');
  const taken = upkeepFeed(r.store).find(f => f.kind === 'did');
  assert.equal(taken.undone, true); assert.equal(taken.impactSaid, undefined, 'what was put back freed nothing');
  await upkeepCheck(r.store, { fns, now: Date.now() + DAY });
  assert.ok(!upkeepPending(r.store, { now: Date.now() + DAY }).pending.some(i => i.id === 'sweep'), 'what the person had put back is theirs to keep');
  assert.match((await upkeepDo(r.store, 'nope')).error, /nothing is waiting under nope/);
  // what leaves the machine about all this: counts by chore, and by whom (telemetry.js:spendMetrics)
  const { actions } = spendMetrics(r.store, { all: false });
  assert.deepEqual(actions.upkeep, { checks: 3, checksWithFinds: 0, done: { context: 1, sweep: 1 }, doneOnItsOwn: 0, left: { context: 1 }, undone: 1, settings: {}, chats: 0, chatActions: 0 });
  assert.deepEqual(actions.dismissedBy, { thinker: 1 });
});

test('a decision is taken back where its history is kept, its pull request closed, and thinker does not put it up again', async () => {
  freshHome();
  const r = repo(), now = Date.now(), at = new Date(now - DAY).toISOString();
  fs.mkdirSync(path.join(r.store.dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(r.store.dir, 'state', 'context-suggest.json'), JSON.stringify({ history: [
    { id: 'p1', at, key: 'section:AGENTS.md:releases', kind: 'section', title: 'AGENTS.md · Releases', saving: 1200, act: 'compress', decision: 'pull request', via: 'thinker', pr: { number: 12, state: 'open', url: 'https://github.com/o/r/pull/12', branch: 'thinker/releases', at } },
  ] }));
  // the line about a pull request says where it stands and carries its link, and the id that takes it back
  const [line] = upkeepFeed(r.store, { now, log: [] });
  assert.deepEqual([line.text, line.url, line.pr, line.impactSaid, line.undo], ['PR #12 in review: shortens AGENTS.md · Releases', 'https://github.com/o/r/pull/12', { number: 12, state: 'open' }, 'about −1.2k tokens per prompt once merged', 'h:p1']);
  assert.match(renderUpkeep(upkeepView(r.store, { now, log: [] }), { now }).join('\n'), /PR #12 in review: shortens AGENTS\.md · Releases {2}about −1\.2k tokens per prompt once merged {2}https:\/\/github\.com\/o\/r\/pull\/12/);
  const closed = [];
  const said = await upkeepUndo(r.store, line.undo, { now, fns: { prs: { closePr: (repoDir, n, o) => { closed.push([n, o.branch]); return {}; } } } });
  assert.equal(said.said, 'AGENTS.md · Releases: pull request #12 closed');
  assert.deepEqual(closed, [[12, 'thinker/releases']]);
  const after = upkeepFeed(r.store, { now, log: [] })[0];
  assert.deepEqual([after.text, after.undone, after.url, after.impactSaid], ['PR #12 closed without merging: AGENTS.md · Releases', true, 'https://github.com/o/r/pull/12', undefined]);
  // the section is flagged again by Find Savings (its decision was reverted), and thinker leaves it be
  const sp = spawned();
  const check = await upkeepCheck(r.store, { fns: { ...given(sp), findMess: none }, now: now + 10 * DAY });
  assert.deepEqual(check.did.map(d => d.id), ['change:section:AGENTS.md:ports']);
  assert.match((await upkeepUndo(r.store, 'h:nope')).error, /no such decision/);
});

test('by itself: the important things, one pull request at a time and not often, and a look does nothing', async () => {
  freshHome();
  const r = repo();
  const done = tree(r, 'done'); r.commit('done.txt', done); mergeIn(r, 'agent/done');
  const sp = spawned(), fns = given(sp);
  const now = Date.now();
  // a look (all a visit to the page starts) finds and keeps, and does nothing
  const look = await upkeepCheck(r.store, { fns, act: false, now });
  assert.deepEqual(look.did, []); assert.equal(sp.calls.length, 0); assert.ok(fs.existsSync(done));
  assert.deepEqual(upkeepPending(r.store, { now }).pending.map(i => [i.id, i.why, i.later]), [['change:section:AGENTS.md:releases', 'at its next check', true], ['change:section:AGENTS.md:ports', 'at its next check', true], ['sweep', 'at its next check', true]]);
  assert.equal(upkeepView(r.store, { now }).summary, '3 changes waiting their turn.');
  // a check: the costliest section as a pull request, the sweep, and nothing else
  const check = await upkeepCheck(r.store, { fns, now });
  assert.deepEqual(check.did.map(d => d.id), ['change:section:AGENTS.md:releases', 'sweep']);
  assert.equal(check.pending, 1);
  assert.deepEqual(sp.calls.map(c => c.slice(1, 5)), [['instructions', '--compress', 'releases', '--pr']], 'the second section waits: one pull request at a time');
  assert.ok(!fs.existsSync(done));
  assert.equal(changeHistory(r.store)[0].via, VIA.thinker);
  assert.deepEqual(upkeepFeed(r.store, { now }).filter(f => ['did', 'change'].includes(f.kind)).map(f => f.by), ['thinker', 'thinker']);
  assert.match(renderUpkeep(upkeepView(r.store, { now }), { now }).join('\n'), /Removed 1 merged worktree and 1 branch {2}3\.0 GB freed \(on its own\)/);
  assert.deepEqual(upkeepPending(r.store, { now }).pending.map(i => [i.id, i.why]), [['change:section:AGENTS.md:ports', 'one pull request every 7 days here']]);
  // the same day, the next week with the first still open, and a week on with it merged
  const merged = () => { const f = path.join(r.store.dir, 'state', 'context-suggest.json'), st = JSON.parse(fs.readFileSync(f, 'utf8')); for (const e of st.history) { e.job = { ...e.job, state: 'done' }; e.pr = { number: 5, state: 'merged', at: new Date(now).toISOString(), pulledAt: new Date(now).toISOString() }; } fs.writeFileSync(f, JSON.stringify(st)); };
  assert.deepEqual((await upkeepCheck(r.store, { fns, now: now + 3600_000 })).did, []);
  assert.deepEqual((await upkeepCheck(r.store, { fns, now: now + 8 * DAY })).did, [], 'never a second pull request while one is open or being made');
  merged();
  assert.deepEqual((await upkeepCheck(r.store, { fns, now: now + 3 * DAY })).did, [], 'nor inside the week');
  assert.deepEqual((await upkeepCheck(r.store, { fns, now: now + 8 * DAY })).did.map(d => d.id), ['change:section:AGENTS.md:ports']);
  assert.equal(sp.calls.length, 2);
  assert.equal(upkeepView(r.store, { now: now + 8 * DAY }).summary, 'Up to date.');
  assert.deepEqual(mayAct(r.store, { important: false, action: {}, allow: 'sweep', kind: 'do', chore: 'sweep' }, BEHAVIOR), { ok: false }, 'what is not important is never done');
});

test('by itself, over the machine: a tool a day and a pull request a day however many repositories, a small sweep waits, and its own failure is tried again', async () => {
  freshHome();
  const a = repo(), b = repo(), sp = spawned(), now = Date.now();
  assert.equal((await upkeepCheck(a.store, { fns: { ...given(sp), findMess: none }, now })).did.length, 1);
  const second = await upkeepCheck(b.store, { fns: { ...given(sp), findMess: none }, now: now + 3600_000 });
  assert.deepEqual(second.did, [], 'the machine has had its pull request for the day');
  assert.deepEqual(upkeepPending(b.store, { now: now + 3600_000 }).pending.map(i => i.why), ['1 pull request a day over the machine', '1 pull request a day over the machine']);
  assert.equal((await upkeepCheck(b.store, { fns: { ...given(sp), findMess: none }, now: now + DAY + 3600_000 })).did.length, 1);
  // a tool is thinker's to switch too, one a day over the machine (asked of mayAct: doing it would write the agent's settings)
  const tool = { id: 'change:claude:builtin:Workflow', important: true, action: {}, allow: 'tools', kind: 'do', chore: 'context' };
  assert.deepEqual(mayAct(a.store, tool, BEHAVIOR, { now }), { ok: true });
  fs.writeFileSync(path.join(HOME, 'state', 'upkeep.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(HOME, 'state', 'upkeep.json'), 'utf8')), tools: [new Date(now).toISOString()] }));
  assert.deepEqual(mayAct(b.store, tool, BEHAVIOR, { now: now + 3600_000 }), { ok: false, later: true, why: 'one tool every 1 day over the machine' });
  assert.equal(mayAct(b.store, tool, { ...BEHAVIOR, toolEveryDays: 4 }, { now: now + 3 * DAY }).ok, false, 'steered to less: one every four days');
  assert.deepEqual(mayAct(b.store, tool, BEHAVIOR, { now: now + DAY + 3600_000 }), { ok: true });
  assert.deepEqual(mayAct(a.store, tool, { ...BEHAVIOR, tools: false }, { now }), { ok: false, why: 'you told it not to (tools is off)' });
  // where no pull request can be opened a section is not thinker's to change at all: not done, not held
  const c = repo(), sp2 = spawned();
  assert.deepEqual((await upkeepCheck(c.store, { fns: { ...given(sp2, { canPr: false }), findMess: none }, now: now + 3 * DAY })).did, []);
  assert.equal(sp2.calls.length, 0); assert.deepEqual(upkeepPending(c.store, { now: now + 3 * DAY }).pending, []);
  // a single stray branch is not worth acting on; told that it is, thinker removes it
  const e = repo(); e.git(['branch', 'left-over', 'main']);
  const small = { ...given(spawned(), { kb: 10 }), view: () => null };
  assert.deepEqual((await upkeepCheck(e.store, { fns: small, now })).did, []);
  assert.deepEqual(upkeepPending(e.store, { now }).pending, []);
  setBehavior(e.store, 'sweepMin', 1, { scope: 'repo' });
  assert.deepEqual((await upkeepCheck(e.store, { fns: small, now })).did.map(x => x.said), ['Removed 1 merged branch']);
  // a change of its own that failed is tried again a day later, three times in all, with nobody asked
  const f = repo(), sp3 = spawned(), fail = () => { const file = path.join(f.store.dir, 'state', 'context-suggest.json'), st = JSON.parse(fs.readFileSync(file, 'utf8')); for (const x of st.history) x.job = { ...x.job, state: 'failed', error: 'the model timed out', finishedAt: new Date(now + 20 * DAY).toISOString() }; fs.writeFileSync(file, JSON.stringify(st)); };
  const once = { ...given(sp3), findMess: none };
  await upkeepCheck(f.store, { fns: once, now: now + 20 * DAY });
  assert.equal(sp3.calls.length, 1); fail();
  assert.deepEqual((await upkeepCheck(f.store, { fns: once, now: now + 20 * DAY + 3600_000 })).did, [], 'not within the day');
  assert.deepEqual(upkeepPending(f.store, { now: now + 20 * DAY + 3600_000 }).pending.filter(i => i.chore === 'waiting').map(i => [i.title, i.why]), [['Trying again: AGENTS.md · Releases', 'it is tried again a day after it failed']]);
  const again = await upkeepCheck(f.store, { fns: once, now: now + 21 * DAY + 3600_000 });
  assert.deepEqual(again.did.map(d => d.id.replace(/:[0-9a-f]+$/, '')), ['wait:job']);
  assert.deepEqual(sp3.calls[1].slice(1, 5), ['instructions', '--compress', 'releases', '--pr']);
  freshHome();
});

test('a rule sessions keep breaking is worth knowing, counted over the verdicts of real sessions, and is nothing to do', async () => {
  freshHome();
  const r = repo();
  fs.writeFileSync(path.join(r.dir, 'AGENTS.md'), '# Rules\n\n## Worktrees\nAlways work in a worktree.\n\n## Tests\nRun the tests.\n');
  const at = d => new Date(Date.now() - d * DAY).toISOString();
  const judged = (d, verdicts) => ({ judged: { at: at(d), verdicts } });
  const broke = text => ({ worktrees: { verdict: 'violated', evidence: text } });
  fs.mkdirSync(path.join(r.store.dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(r.store.dir, 'state', 'instruction-value.json'), JSON.stringify({ sessions: {
    s1: judged(1, broke('edited src/a.js in the main checkout')), s2: judged(2, broke('committed on main')), s3: judged(3, broke('no worktree was made')),
    s4: judged(4, { worktrees: { verdict: 'followed', evidence: 'git worktree add' }, tests: { verdict: 'violated', evidence: 'no test run' } }),
    old: judged(UPKEEP.ruleDays + 5, broke('long ago')), gone: judged(1, { 'left-the-file': { verdict: 'violated', evidence: 'x' } }),
  } }));
  await upkeepCheck(r.store, { fns: { view: () => null, findMess: none } });
  const { notes, pending } = upkeepPending(r.store);
  assert.deepEqual(pending, []);
  assert.equal(notes.length, 1, 'broken once is not a pattern');
  assert.equal(notes[0].title, 'Agents keep breaking a rule: AGENTS.md · Worktrees');
  assert.match(notes[0].detail, /^Broken in 3 of the 4 sessions it came up in over the last 30 days\./);
  assert.deepEqual(notes[0].lines, ['edited src/a.js in the main checkout', 'committed on main', 'no worktree was made']);
  // it is the chat's to say when asked: no line of the activity, nothing held, nothing to do
  const v = upkeepView(r.store);
  assert.deepEqual([v.summary, v.feed.length, v.notes.length], ['Up to date.', 0, 1]);
  assert.match((await upkeepDo(r.store, 'rule:worktrees')).error, /there is nothing thinker can do about it/);
});

test('the activity is a line an action with what it came to, never thinker\'s own housekeeping, and all repositories read as one list', () => {
  freshHome();
  const r = repo();
  const now = Date.now(), t = (d, h = 10) => { const x = new Date(now - d * DAY); x.setHours(h, 0, 0, 0); return x.toISOString(); };
  // what thinker does to work -- the sessions it read, the state files it cleared -- is not something done for the
  // person, and is not listed (the owner, 2026-11-21); the profile it updated is
  const log = [
    { t: t(1, 9), op: 'profile', observations: 2 }, { t: t(1, 15), op: 'profile', observations: 3 }, { t: t(1, 11), op: 'maintain', pruned: 41 },
    { t: t(1, 16), op: 'profile-compile', changes: { kept: 9, added: 2, updated: 1, dropped: 1 } }, { t: t(0, 1), op: 'profile-compile', changes: { kept: 9, added: 0, updated: 0, dropped: 0 } },
    { t: t(4), op: 'profile-compile', changes: { added: 5 } }, { t: t(UPKEEP.feedDays + 3), op: 'profile-compile', changes: { added: 9 } },
  ];
  // one line for the profile, its last update that changed anything: a line a day would crowd out what was done
  assert.deepEqual(upkeepFeed(r.store, { log, now }).map(f => [f.text, f.impactSaid]), [['Updated your profile: 2 lines added, 1 reworded, 1 dropped', undefined]]);
  // a decision's impact: the tokens it took off a prompt, measured over the sessions before it against those since, and
  // what that is a day at this repository's pace (the last week's prompts) and input rate
  const key = 'claude:builtin:Workflow';
  fs.mkdirSync(path.join(r.store.dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(r.store.dir, 'state', 'context-suggest.json'), JSON.stringify({ history: [
    { id: 'a1', at: t(10), key, kind: 'tool', title: 'Workflow tool', saving: 2500, action: 'Create tool reference', act: 'off', decision: 'approved', result: 'Tool reference created', via: 'page' },
    { id: 'a2', at: new Date(now - 3600_000).toISOString(), key: 'claude:mcp:artemis', kind: 'tool', title: 'artemis MCP server', saving: 1000, action: 'Switch off', act: 'off', decision: 'approved', result: 'Switched off', via: 'thinker' },
    { id: 'a3', at: t(4), key: 'section:AGENTS.md:ports', kind: 'section', title: 'AGENTS.md · Ports', saving: 1200, act: 'remove', decision: 'pull request', pr: { number: 12, state: 'open', url: 'https://github.com/o/r/pull/12', at: t(4) }, via: 'thinker' },
    { id: 'a4', at: t(3), key: 'x', kind: 'tool', title: 'Old tool', saving: 5000, act: 'off', decision: 'dismissed' },
  ] }));
  const before = { t: Date.parse(t(12)), input: 1_000_000, prompts: 100, sources: { [key]: 300_000 } }, after = { t: Date.parse(t(1)), input: 500_000, prompts: 70, sources: {} };
  const lines = report => upkeepFeed(r.store, { log: [], now, report }).map(f => [f.text, f.impactSaid, f.by]);
  assert.deepEqual(lines({ rows: [before, after], rate: 5e-6 }), [
    ['Switched off artemis MCP server', 'about −1k tokens per prompt · $0.05/day', 'you'],
    ['PR #12 in review: removes AGENTS.md · Ports', 'about −1.2k tokens per prompt · $0.06/day once merged', 'you'],
    ['Made Workflow tool a tool reference', '−3k tokens per prompt · $0.15/day', 'you'],
  ], 'measured where sessions on both sides can say, expected until then (an hour ago, no session since), and a dismissal is not something done');
  // nothing priced here: tokens alone, never a guessed dollar; no report kept: what was expected
  assert.equal(lines({ rows: [before, after], rate: null })[2][1], '−3k tokens per prompt');
  assert.equal(lines({ rows: [], rate: 5e-6 })[2][1], 'about −2.5k tokens per prompt');
  assert.deepEqual([impactSaid({ kb: 2 * 1024 * 1024 }), impactSaid({ perPrompt: 10_000, perDay: 45, measured: true }), impactSaid({ perPrompt: -2000, perDay: -1.1, measured: true }), impactSaid(null), impactSaid({ perPrompt: 0 })],
    ['2.0 GB freed', '−10k tokens per prompt · $45.0/day', '+2k tokens per prompt · $1.10/day more', '', '']);
  const base = { level: 'auto', behavior: BEHAVIOR, behaviorSaid: 'x', later: 0, pending: [], notes: [] };
  const a = { ...base, lastCheck: t(0, 8), pending: [{ id: 'sweep', kind: 'do', chore: 'sweep', later: true, found: t(1), title: 'a' }], feed: [{ at: t(1), text: 'x' }] };
  const b = { ...base, lastCheck: t(2), pending: [{ id: 'change:section:AGENTS.md:x', kind: 'pr', chore: 'context', found: t(3), title: 'c' }], notes: [{ id: 'rule:x', kind: 'note', chore: 'rules', found: t(0), title: 'b' }], feed: [{ at: t(0), text: 'y' }] };
  const all = mergeUpkeepViews([{ repo: 'one', name: 'One', view: a }, { repo: 'two', name: 'Two', view: b }]);
  assert.deepEqual(all.pending.map(i => [i.title, i.repoName]), [['c', 'Two'], ['a', 'One']], 'a pull request first');
  assert.deepEqual(all.notes.map(i => [i.title, i.repoName]), [['b', 'Two']]);
  assert.deepEqual(all.feed.map(f => f.text), ['y', 'x']);
  assert.equal(all.lastCheck, t(2), 'the list is as old as its oldest check');
  assert.deepEqual([all.later, all.held, all.summary], [1, 1, '1 change waiting its turn, 1 held back until you say.']);
  assert.equal(mergeUpkeepViews([{ repo: 'one', name: 'One', view: a }, { repo: 'three', name: 'Three', view: { ...base, lastCheck: null, feed: [] } }]).lastCheck, null, 'not looked at everywhere yet');
  assert.equal(mergeUpkeepViews([{ repo: 'one', name: 'One', view: a }, { repo: 'two', name: 'Two', view: { ...b, level: 'ask' } }]).level, 'mixed');
  // a tool is switched for the whole machine: found in two repositories it is one thing, the costliest, and the
  // decision about it one line, not a line a repository
  const tool = (rank, detail) => ({ id: 'change:claude:builtin:Agent', kind: 'do', chore: 'context', machine: true, later: true, rank, title: 'Agent tool', detail, found: t(1) });
  // ... and its saving the dollars of both a day, the tokens a prompt averaged over their prompts
  const said = (perPrompt, perDay, promptsPerDay) => ({ at: t(1), kind: 'change', text: 'Switched off x MCP server', shared: 'abc', impact: { perPrompt, perDay, promptsPerDay, measured: true } });
  const m = mergeUpkeepViews([
    { repo: 'one', name: 'One', view: { ...a, pending: [tool(100, 'small.'), { id: 'sweep', kind: 'do', chore: 'sweep', rank: 0, found: t(1), title: 'a' }], feed: [said(1000, 0.5, 100)] } },
    { repo: 'two', name: 'Two', view: { ...b, pending: [tool(900, 'big.')], feed: [said(4000, 6, 300)] } },
  ]);
  assert.deepEqual(m.pending.map(i => [i.title, i.repoName, i.repo, i.detail]), [['a', 'One', 'one', undefined], ['Agent tool', '2 repositories', 'two', 'big.']], 'acted on from the repository that showed it');
  assert.deepEqual(m.feed.map(f => [f.repoName, f.impactSaid]), [['All repositories', '−3.3k tokens per prompt · $6.50/day']]);
  // the profiles of several repositories are one line too
  const prof = (at, added) => ({ at, kind: 'profile', by: 'thinker', text: 'x', profile: { added, reworded: 1, dropped: 0 } });
  const p = mergeUpkeepViews([{ repo: 'one', name: 'One', view: { ...a, feed: [prof(t(2), 2)] } }, { repo: 'two', name: 'Two', view: { ...b, feed: [prof(t(1), 3)] } }]);
  assert.deepEqual(p.feed.map(f => [f.text, f.at]), [['Updated your profile in 2 repositories: 5 lines added, 2 reworded', t(1)]]);
  assert.equal(mergeUpkeepViews([{ repo: 'one', name: 'One', view: { ...a, feed: [prof(t(2), 2)] } }]).feed[0].repoName, 'One');
});

test('"more like this" and "less like this": one kind of thing moved one step, for a repository or the machine, and said with what it was', () => {
  freshHome();
  const r = repo();
  // pull requests: half as often, then half again, in this repository alone
  assert.equal(steerBehavior(r.store, 'prs', 'less', { scope: 'repo' }).said, 'a pull request at most every 14 days now in this repository (it was every 7)');
  assert.equal(steerBehavior(r.store, 'prs', 'less', { scope: 'repo' }).said, 'a pull request at most every 28 days now in this repository (it was every 14)');
  assert.deepEqual([behaviorOf(r.store).prEveryDays, behaviorOf(repo().store).prEveryDays], [28, 7]);
  // more, on the machine: twice as often, down to every day and no further
  assert.equal(steerBehavior(r.store, 'prs', 'more').said, 'a pull request at most every 4 days now on this machine (it was every 7)');
  assert.equal(steerBehavior(null, 'prs', 'more').said, 'a pull request at most every 2 days now on this machine (it was every 4)');
  steerBehavior(null, 'prs', 'more');
  assert.match(steerBehavior(null, 'prs', 'more').error, /a pull request is already as often as thinker will go \(every 1 day\)/);
  // tools and sweeps the same way; a kind that was switched off comes back on "more", and "less" of it is nothing to do
  assert.equal(steerBehavior(null, 'tools', 'less').said, 'a tool at most every 2 days now on this machine (it was every 1)');
  assert.equal(steerBehavior(null, 'sweep', 'less').said, 'merged worktrees and branches are now removed from 6 things or 1000 MB on this machine (it was 3 or 500 MB)');
  assert.equal(steerBehavior(null, 'sweep', 'more').said, 'merged worktrees and branches are now removed from 3 things or 500 MB on this machine (it was 6 or 1000 MB)');
  setBehavior(r.store, 'tools', false);
  assert.match(steerBehavior(null, 'tools', 'less').error, /thinker already does none of that on this machine/);
  assert.equal(steerBehavior(null, 'tools', 'more').said, 'thinker does that again on this machine');
  assert.equal(behaviorOf(r.store).tools, true);
  // work handed to cheaper agents is the delegation trigger's own setting: the size a read must be, the machine's alone
  assert.equal(delegateConfig({ home: HOME, env: {} }).threshold, DELEGATE_DEFAULTS.threshold);
  assert.equal(steerBehavior(r.store, 'delegation', 'more', { scope: 'repo' }).said, 'a read is now handed to a cheaper agent from 2k tokens on this machine (it was 4k)');
  assert.equal(delegateConfig({ home: HOME, env: {} }).threshold, 2000);
  assert.match(steerBehavior(null, 'delegation', 'more').error, /reads are already handed over as readily as thinker will go \(from 2k tokens\)/);
  assert.equal(steerBehavior(null, 'delegation', 'less').said, 'a read is now handed to a cheaper agent from 4k tokens on this machine (it was 2k)');
  // the other settings of the trigger are not touched, and nothing unknown is steered
  const kept = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
  assert.deepEqual(kept.delegate, { threshold: 4000 });
  assert.match(steerBehavior(null, 'chaos', 'more').error, /there is no kind of thing called chaos/);
  assert.match(steerBehavior(null, 'prs', 'sideways').error, /more or less/);
  freshHome();
});

test('per session: what was handed to cheaper agents and what that saved, the Report\'s own figure added by session', () => {
  freshHome();
  const r = repo(), now = Date.now(), at = (h, m = 0) => new Date(now - h * 3600_000 + m * 60_000).toISOString();
  const config = { prices: { lead: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, cacheWrite1h: 20 }, cheap: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 } } };
  fs.writeFileSync(path.join(r.store.dir, 'config.json'), JSON.stringify({ version: 1, ...config }));
  const fire = (session, h, over = {}) => ({ t: at(h), op: 'delegate', session, client: 'claude', kind: 'explore', tool: 'Read', files: ['src/big.js'], tokens: 100_000, held: false, mode: 'handoff', model: 'cheap', ...over });
  const log = [
    { t: at(30), op: 'request', session: 's1', task: '<thinker-profile>x</thinker-profile>fix the flaky proxy test and say why it was flaky in the first place, at length' },
    { t: at(30), op: 'request', session: 's1', task: 'a later prompt of the same session' },
    fire('s1', 29), fire('s1', 28, { files: ['src/other.js'], tokens: 50_000 }),
    fire('s1', 27, { kind: 'verify', tool: 'Bash', files: ['npm test'], tokens: 0, model: 'cheap' }),
    { t: at(26), op: 'session', session: 's1', model: 'lead' },
    // the lead read this one itself afterwards: nothing was kept out, so it is no handoff and no saving
    fire('s2', 20, { files: ['src/a.js'] }), fire('s2', 19, { files: ['src/a.js'], fired: false, after: 'handoff' }),
    // held out, failed, and below the threshold: not handed over
    fire('s3', 10, { held: true }), fire('s3', 9, { error: 'timeout' }), fire('s3', 8, { fired: false, declined: 'below-threshold' }),
    // a model with no list price: the handoff is counted, its dollars are not guessed
    { t: at(5), op: 'request', session: 's4', task: 'read it all' }, fire('s4', 4, { model: undefined }), { t: at(3), op: 'session', session: 's4', model: 'nobody-prices-this' },
    fire('old', 24 * (UPKEEP.feedDays + 2)),
  ];
  // one later call of the lead in s1 would have read both files back
  const compression = [{ op: 'proxy', session: 's1', at: at(28, 30), model: 'lead', status: 200, out: 10, input: 1000, read: 0, write: 0, turn: 3 }, { op: 'proxy', session: 's1', at: at(27, 30), model: 'lead', status: 200, out: 10, input: 1000, read: 0, write: 0, turn: 4 }];
  const rows = delegationBySession({ events: log, compression, config, since: now - UPKEEP.feedDays * DAY });
  assert.deepEqual(rows.map(d => [d.session, d.reads, d.runs, d.handed, d.models, d.saved == null ? null : Math.round(d.saved * 100) / 100]), [
    ['s4', 1, 0, 100_000, [], null],
    // the writes not made (150k at $20/M) less the same reads at the cheaper model ($2/M): $2.70; plus the reads back
    // avoided, both files on the two later calls of the lead (300k at $1/M): $0.30
    ['s1', 2, 1, 150_000, ['cheap'], 3],
  ]);
  assert.equal(rows[1].title.slice(0, 40), '<thinker-profile>x</thinker-profile>fix ');
  const d = upkeepDelegated(r.store, { now, log, compression });
  assert.deepEqual(d.total, { sessions: 2, reads: 3, runs: 1, handed: 250_000, saved: rows[1].saved, unpriced: 1 });
  assert.deepEqual(d.sessions.map(x => [x.text, x.impactSaid, x.title, x.steer]), [
    ['Handed 1 read to cheaper agents', '100k tokens handed over', 'read it all', 'delegation'],
    ['Handed 2 reads and 1 test run to cheap', '150k tokens handed over · $3.00 saved', 'fix the flaky proxy test and say why it was flaky in the first place,…', 'delegation'],
  ]);
  assert.equal(delegatedTotalSaid(d), '2 sessions over 14 days: 3 reads and 1 test run handed to cheaper agents, 250k tokens · $3.00 saved (1 session left out: no price known for its model)');
  // both doors: the view carries it, the command prints a line a session under the actions
  const v = upkeepView(r.store, { now, log, compression });
  assert.deepEqual(v.delegated, d);
  const text = renderUpkeep(v, { now }).join('\n');
  assert.match(text, /\nDelegated to cheaper agents · 2 sessions over 14 days: 3 reads and 1 test run handed to cheaper agents, 250k tokens · \$3\.00 saved \(1 session left out: no price known for its model\)\n[^\n]*Handed 1 read to cheaper agents {2}100k tokens handed over {2}“read it all”\n[^\n]*Handed 2 reads and 1 test run to cheap {2}150k tokens handed over · \$3\.00 saved {2}“fix the flaky/);
  // every repository's as one: the sessions newest first, the totals added
  const all = mergeUpkeepViews([{ repo: 'one', name: 'One', view: v }, { repo: 'two', name: 'Two', view: { ...v, delegated: { days: 14, total: { sessions: 1, reads: 4, runs: 0, handed: 9, saved: 1, unpriced: 0 }, sessions: [{ at: at(1), text: 'Handed 4 reads to cheap', reads: 4, runs: 0 }] } } }]);
  assert.deepEqual(all.delegated.total, { sessions: 3, reads: 7, runs: 1, handed: 250_009, saved: rows[1].saved + 1, unpriced: 1 });
  assert.deepEqual(all.delegated.sessions.map(x => [x.text, x.repoName]), [['Handed 4 reads to cheap', 'Two'], ['Handed 1 read to cheaper agents', 'One'], ['Handed 2 reads and 1 test run to cheap', 'One']]);
  assert.equal(delegatedTotalSaid({ days: 14, total: { sessions: 0 } }), '');
});

test('what is known about one line, for somebody asking about it: what it was, why, how it measured, where its pull request stands, whether it comes back', async () => {
  freshHome();
  const r = repo(), now = Date.now(), t = d => new Date(now - d * DAY).toISOString();
  const key = 'claude:builtin:Workflow';
  fs.mkdirSync(path.join(r.store.dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(r.store.dir, 'state', 'context-suggest.json'), JSON.stringify({ history: [
    { id: 'a1', at: t(10), key, kind: 'tool', title: 'Workflow tool', what: 'Built-in tool', about: 'Runs a workflow script.', saving: 2500, total: 9_000_000, days: 7, action: 'Create tool reference', act: 'off', decision: 'approved', result: 'Tool reference created', via: 'page' },
    { id: 'a3', at: t(4), key: 'section:AGENTS.md:ports', kind: 'section', title: 'AGENTS.md · Ports', what: 'Instruction section', saving: 1200, tokens: { before: 2000, after: 0 }, act: 'remove', action: 'Remove', decision: 'pull request', pr: { number: 12, state: 'open', url: 'https://github.com/o/r/pull/12', at: t(4) }, via: 'thinker' },
  ] }));
  const before = { t: Date.parse(t(12)), input: 1_000_000, prompts: 100, sources: { [key]: 300_000 } }, after = { t: Date.parse(t(1)), input: 500_000, prompts: 70, sources: {} };
  const report = { rows: [before, after], rate: 5e-6 };
  // every line of the activity names itself, so a card can be looked up
  assert.deepEqual(upkeepFeed(r.store, { log: [], now, report }).map(f => f.id), ['h:a3', 'h:a1']);
  assert.deepEqual(upkeepDetail(r.store, 'h:a1', { now, report }), [
    'Workflow tool (built-in tool). It begins: "Runs a workflow script."',
    '  Why it was picked: about 2.5k of its tokens in an average prompt were going where they were not needed, 9M tokens over the 7 days before.',
    '  Measured: it cost 3k tokens a prompt before (1 session, 100 prompts) and 0 since (1 session, 70 prompts): 3k fewer a prompt, 30% of what a whole prompt cost before; 210k tokens saved over the 70 prompts since. Under five sessions on one side, so the figure is early.',
    `How it was done: create tool reference, approved, on ${new Date(t(10)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, by the person, on Find Savings. Tool reference created.`,
    'How the dollars a day are reckoned: the tokens off a prompt, times the 10 prompts a day this repository ran over the last week, at $5.00 a million input tokens (what input cost here, cache reads and writes as they were).',
    'It can be taken back (undo id h:a1).',
  ]);
  const pr = upkeepDetail(r.store, 'h:a3', { now, report });
  assert.equal(pr[1], '  Its size: 2k tokens before the change, 0 after. It is read again by every model call of every session that loads the file.');
  assert.equal(pr[3], '  Not measured yet: it is not in effect until its pull request merges. The figure given is what was expected when it was picked.');
  assert.match(pr[5], /^Its pull request: #12, in review since [A-Z][a-z]+ \d+, https:\/\/github\.com\/o\/r\/pull\/12\. It is the team's to review and merge; the change is not in effect until then\.$/);
  // something done here: what was removed, why it was safe, what it freed, how it comes back
  const done = tree(r, 'done'); r.commit('done.txt', done); mergeIn(r, 'agent/done');
  setBehavior(r.store, 'level', 'ask', { scope: 'repo' });
  const fns = { view: () => null, findMess: s => findMess(s, { now: LATER(), cwds: [], sizeOf: () => 2 * 1024 * 1024 }), sweep: (s, m) => sweep(s, m, { now: LATER(), cwds: [] }) };
  await upkeepCheck(r.store, { fns, now });
  const did = await upkeepDo(r.store, 'sweep', { fns, now });
  const swept = upkeepDetail(r.store, `d:${did.done}`, { now });
  assert.match(swept[0], /^Removed 1 merged worktree and 1 branch, on [A-Z][a-z]+ \d+, on the person's word in the chat\.$/);
  assert.deepEqual(swept.slice(1), ['  A worktree: done, on the branch agent/done.', 'Why: each one\'s work was already on the default branch, by its history or by a merged pull request with that exact commit, it had no uncommitted or untracked files, nobody was working in it, and it had not changed in a day.', 'What it freed: 2.0 GB of disk.', `It can be put back: each branch at its commit, and the worktrees on them (undo id ${did.done}).`]);
  // a session's delegated work: what was handed over and to whom, why, and how the saving is reckoned
  const config = { prices: { lead: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, cacheWrite1h: 20 }, cheap: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 } } };
  fs.writeFileSync(path.join(r.store.dir, 'config.json'), JSON.stringify({ version: 1, upkeep: { level: 'ask' }, ...config }));
  const log = [
    { t: t(2), op: 'request', session: 's1', task: 'fix the flaky proxy test' },
    { t: t(1.9), op: 'delegate', session: 's1', kind: 'explore', files: ['../../deep/down/src/big.js'], tokens: 100_000, held: false, mode: 'handoff', model: 'cheap' },
    { t: t(1.8), op: 'delegate', session: 's1', kind: 'explore', files: ['src/a.js'], tokens: 9000, held: false, mode: 'handoff' }, { t: t(1.7), op: 'delegate', session: 's1', kind: 'explore', files: ['src/a.js'], tokens: 9000, fired: false, after: 'handoff' },
    { t: t(1.6), op: 'session', session: 's1', model: 'lead' },
  ];
  assert.deepEqual(upkeepDetail(r.store, 's:s1', { now, log, compression: [] }), [
    'The session began: "fix the flaky proxy test". Its own model was lead.',
    `  A read handed over on ${new Date(t(1.9)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}: src/big.js, 100k tokens, to cheap.`,
    '1 more handoff the lead went on to read itself anyway: nothing was kept out by that one, so it is counted nowhere.',
    'Why it is handed over: a large read is only needed for what it says, so a cheaper agent reads the file and reports back, and the lead works from the report. The file never enters the lead\'s context.',
    'The saving, $1.80: the lead did not write those tokens into its cache at its own rate, less what the cheaper agent paid for the same reading, and did not read them back on its later calls (100k tokens not paid for in all). It is an estimate, the same one the Report\'s "Reads delegated" shows.',
  ]);
  // a line that is gone, or names nothing known, has nothing behind it
  assert.deepEqual([upkeepDetail(r.store, 'h:nope', { now, report }), upkeepDetail(r.store, 'd:nope'), upkeepDetail(r.store, 's:nope', { log, compression: [] }), upkeepDetail(r.store, 'profile'), upkeepDetail(r.store, '')], [[], [], [], [], []]);
});

test('maintenance runs the check, says once what thinker did by itself, and `upkeep: false` stops it', async () => {
  freshHome();
  const r = repo();
  const fns = { syncPrs: async () => ({ synced: 0 }), containers: () => null, contextSuggest: async () => null };
  const m = await maintain(r.store, r.dir, { fns });
  assert.equal(m.errors, 0); assert.equal(m.upkeepDid, undefined);
  assert.ok(readUpkeep(r.store).lastCheck, 'the check was kept');
  assert.match(renderMaintain({ upkeepDid: 1, upkeepPending: 2, errors: 0 }), /1 thing done on its own, 2 waiting their turn/);
  // what it did is said at the end of the next turn, once
  const q = repo();
  const did = await maintain(q.store, q.dir, { fns: { ...fns, upkeep: async () => ({ did: [{ id: 'sweep', kind: 'do', said: 'Removed 3 merged worktrees · 1.2 GB freed' }, { id: 'change:x', kind: 'pr', said: 'Compressing 1 section in the background…' }], pending: 0, errors: [] }) } });
  assert.equal(did.upkeepDid, 2);
  assert.equal(maintenanceNotice(q.store), '🧠 thinker: removed 3 merged worktrees · 1.2 GB freed; started a pull request for a section nobody needs (Recent activity has its link)');
  assert.equal(maintenanceNotice(q.store), '');
  const off = repo({ upkeep: false });
  assert.deepEqual(await upkeepCheck(off.store), { skipped: 'off' });
  const v = upkeepView(off.store);
  assert.equal(v.level, 'off'); assert.equal(v.summary, 'Thinker is not looking after this repository.');
});
