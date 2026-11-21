// Upkeep (upkeep.js, upkeep-sweep.js): what thinker does by itself between sessions -- what it finds, what it does
// without asking and how often, and what it leaves for the person. Git here is real, in scratch repositories; no model
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
const { upkeepCheck, upkeepInbox, upkeepDo, upkeepDismiss, upkeepUndo, upkeepView, upkeepFeed, mergeUpkeepViews, renderUpkeep, behaviorOf, setBehavior, behaviorSaid, mayAct, readUpkeep, BEHAVIOR, UPKEEP } = await import('../src/upkeep.js');
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

test('how thinker behaves: it acts by itself unless told otherwise, the machine\'s settings under a repository\'s, and only what is known is kept', () => {
  freshHome();
  const r = repo();
  const { set, ...b } = behaviorOf(r.store);
  assert.deepEqual(b, BEHAVIOR);
  assert.deepEqual([b.level, b.sweep, b.prs, b.tools, b.important, b.prEveryDays, b.prsPerDay], ['auto', true, true, false, 'high', 7, 1], 'on its own, for important things, not often, and never a tool');
  assert.match(behaviorSaid(b), /^Thinker acts on its own here, for important things only: it removes merged worktrees and branches, puts up a pull request for a costly section nobody needs, at most one every 7 days\.$/);
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
  assert.equal(behaviorOf(repo({ upkeep: { level: 'yolo', prsPerDay: 'many', tools: true } }).store).level, 'auto');
  assert.equal(behaviorOf(repo({ upkeep: { tools: true } }).store).tools, true);
  assert.equal(behaviorOf(repo({ upkeep: false }).store).level, 'off');
  assert.equal(behaviorSaid(behaviorOf(repo({ upkeep: { level: 'ask' } }).store)), 'Thinker only lists what it finds here; nothing is done until you say so.');
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
const spawned = () => { const calls = []; return { calls, spawn: (cmd, args) => { calls.push(args); return { pid: process.pid, on() {}, unref() {} }; } }; };
// the functions a check is given in place of the machine: the report, whether a pull request can be opened, the sweep
const given = (sp, { canPr = true, kb = 3 * 1024 * 1024 } = {}) => ({ view, prAvailable: () => ({ ok: canPr }), spawn: sp.spawn, findMess: s => findMess(s, { now: LATER(), cwds: [], sizeOf: () => kb }), sweep: (s, m) => sweep(s, m, { now: LATER(), cwds: [] }) });

test('told to ask first, a check only lists what is important: each with one action, and nothing is done', async () => {
  freshHome();
  const r = repo({ upkeep: { level: 'ask' } });
  const done = tree(r, 'done'); r.commit('done.txt', done); mergeIn(r, 'agent/done');
  r.git(['branch', 'left-over', 'main']);
  const sp = spawned();
  const check = await upkeepCheck(r.store, { fns: given(sp) });
  assert.deepEqual(check.did, []); assert.equal(sp.calls.length, 0); assert.ok(fs.existsSync(done));
  const { items, lastCheck } = upkeepInbox(r.store);
  assert.ok(lastCheck);
  // the cheap section is not important: it is not listed here at all, it stays on Find Savings
  assert.deepEqual(items.map(i => [i.n, i.kind, i.chore, i.title]), [[1, 'pr', 'context', 'AGENTS.md · Releases'], [2, 'pr', 'context', 'AGENTS.md · Ports'], [3, 'do', 'sweep', '1 merged worktree and 1 branch can go · 3.0 GB'], [4, 'do', 'context', 'Workflow tool']]);
  assert.equal(items[0].action.label, 'Put up a PR to shorten it');
  assert.match(items[0].detail, /^Needed in 2% of prompts; ~2k tokens in every model call\. About \$20\.0 went on it unused over the last 7 days\.$/);
  assert.deepEqual(items[2].lines, ['done · worktree on agent/done · on main · 3.0 GB', 'left-over · branch · on main']);
  assert.equal(items[3].action.label, 'Create tool reference');
  const v = upkeepView(r.store);
  assert.equal(v.summary, '4 things need you.'); assert.equal(v.attention, 4); assert.equal(v.level, 'ask');
  const text = renderUpkeep(v).join('\n');
  assert.match(text, /^Recent activity · thinker last looked just now\n {2}4 things need you\.\n {2}Thinker only lists what it finds here/);
  assert.match(text, /thinker activity do 3 {3}\(Remove them\) {3}· {3}thinker activity leave 3/);
});

test('doing, leaving and taking back by hand: the sweep is undone from the activity, a context change is kept where its history is read', async () => {
  freshHome();
  const r = repo({ upkeep: { level: 'ask' } });
  const done = tree(r, 'done'); r.commit('done.txt', done); mergeIn(r, 'agent/done');
  const sp = spawned(), fns = given(sp, { kb: 600 * 1024 });
  await upkeepCheck(r.store, { fns });
  // the section: a job in the background that ends as a pull request, by the door `thinker`
  const a = await upkeepDo(r.store, 'change:section:AGENTS.md:releases', { fns, pr: true });
  assert.match(a.said, /Compressing 1 section in the background: a pull request opens/);
  assert.deepEqual(sp.calls[0].slice(1, 5), ['instructions', '--compress', 'releases', '--pr']);
  const h = changeHistory(r.store);
  assert.equal(h.length, 1); assert.equal(h[0].via, VIA.thinker); assert.equal(h[0].job.state, 'running');
  assert.deepEqual(upkeepInbox(r.store).items.map(i => i.id), ['change:section:AGENTS.md:ports', 'sweep', 'change:claude:builtin:Workflow'], 'a decided change is no longer listed');
  // the sweep, by its number
  const s = await upkeepDo(r.store, 2, { fns });
  assert.equal(s.said, 'Removed 1 merged worktree and 1 branch, 600 MB back');
  assert.ok(!fs.existsSync(done));
  // leaving the tool alone is a dismissal in the same history Find Savings reads, so it is not offered there either
  assert.match(upkeepDismiss(r.store, 'change:claude:builtin:Workflow', { fns }).said, /Workflow tool: left alone; it may come back in 7 days/);
  assert.equal(changeHistory(r.store).filter(e => e.decision === 'dismissed' && e.via === VIA.thinker).length, 1);
  upkeepDismiss(r.store, 1, { fns });
  assert.deepEqual(upkeepInbox(r.store).items, []);
  assert.equal(upkeepView(r.store).summary, 'Nothing needs you.');
  // the activity: the sweep with its undo, the job under way; a dismissal is not something that was done
  const feed = upkeepFeed(r.store);
  assert.deepEqual(feed.map(f => [f.kind, f.by, Boolean(f.undo)]).sort(), [['change', 'you', false], ['did', 'you', true]]);
  assert.match(feed.find(f => f.kind === 'change').text, /^Working on it now: AGENTS\.md · Releases$/);
  const undo = feed.find(f => f.undo).undo;
  assert.equal(upkeepUndo(r.store, undo).said, 'Put back 1 branch and 1 worktree');
  assert.ok(fs.existsSync(path.join(done, 'done.txt')));
  assert.equal(upkeepUndo(r.store, undo).error, 'already taken back');
  assert.equal(upkeepFeed(r.store).find(f => f.kind === 'did').undone, true);
  assert.match((await upkeepDo(r.store, 9)).error, /nothing that needs you is 9/);
  // what leaves the machine about all this: counts by chore, and by whom (telemetry.js:spendMetrics); the section's
  // pull request is counted where every other door's is, under its own door
  const { actions } = spendMetrics(r.store, { all: false });
  assert.deepEqual(actions.upkeep, { checks: 1, checksWithFinds: 1, done: { context: 1, sweep: 1 }, doneOnItsOwn: 0, left: { context: 2 }, undone: 1, settings: {}, chats: 0, chatActions: 0 });
  assert.deepEqual(actions.dismissedBy, { thinker: 2 });
});

test('by itself: the important things, one pull request at a time and not often, never a tool, and a look does nothing', async () => {
  freshHome();
  const r = repo();
  const done = tree(r, 'done'); r.commit('done.txt', done); mergeIn(r, 'agent/done');
  const sp = spawned(), fns = given(sp);
  const now = Date.now();
  // a look (all a visit to the page starts) finds and keeps, and does nothing
  const look = await upkeepCheck(r.store, { fns, act: false, now });
  assert.deepEqual(look.did, []); assert.equal(sp.calls.length, 0); assert.ok(fs.existsSync(done));
  // what needs the person even so: only what thinker will not do by itself
  assert.deepEqual(upkeepInbox(r.store, { now }).items.map(i => i.id), ['change:claude:builtin:Workflow']);
  assert.equal(upkeepView(r.store, { now }).summary, '1 thing needs you, 3 more changes waiting their turn.');
  // a check: the costliest section as a pull request, the sweep, and nothing else
  const check = await upkeepCheck(r.store, { fns, now });
  assert.deepEqual(check.did.map(d => d.id), ['change:section:AGENTS.md:releases', 'sweep']);
  assert.deepEqual(sp.calls.map(c => c.slice(1, 5)), [['instructions', '--compress', 'releases', '--pr']], 'the second section waits: one pull request at a time');
  assert.ok(!fs.existsSync(done));
  assert.equal(changeHistory(r.store)[0].via, VIA.thinker);
  assert.deepEqual(upkeepFeed(r.store, { now }).filter(f => ['did', 'change'].includes(f.kind)).map(f => f.by), ['thinker', 'thinker']);
  assert.match(renderUpkeep(upkeepView(r.store, { now }), { now }).join('\n'), /Removed 1 merged worktree and 1 branch, 3\.0 GB back \(on its own\)/);
  // the same day, the next week with the first still open, and a week on with it merged
  const merged = () => { const f = path.join(r.store.dir, 'state', 'context-suggest.json'), st = JSON.parse(fs.readFileSync(f, 'utf8')); for (const e of st.history) { e.job = { ...e.job, state: 'done' }; e.pr = { number: 5, state: 'merged', at: new Date(now).toISOString(), pulledAt: new Date(now).toISOString() }; } fs.writeFileSync(f, JSON.stringify(st)); };
  assert.deepEqual((await upkeepCheck(r.store, { fns, now: now + 3600_000 })).did, []);
  assert.deepEqual((await upkeepCheck(r.store, { fns, now: now + 8 * DAY })).did, [], 'never a second pull request while one is open or being made');
  merged();
  assert.deepEqual((await upkeepCheck(r.store, { fns, now: now + 3 * DAY })).did, [], 'nor inside the week');
  assert.deepEqual((await upkeepCheck(r.store, { fns, now: now + 8 * DAY })).did.map(d => d.id), ['change:section:AGENTS.md:ports']);
  assert.equal(sp.calls.length, 2);
  // the tool is still the person's, until they say otherwise
  assert.deepEqual(upkeepInbox(r.store, { now: now + 8 * DAY }).items.map(i => i.id), ['change:claude:builtin:Workflow']);
  assert.deepEqual(mayAct(r.store, { important: true, action: {}, allow: 'tools', kind: 'do', chore: 'context' }, { ...BEHAVIOR, tools: true }), { ok: true });
  assert.deepEqual(mayAct(r.store, { important: false, action: {}, allow: 'sweep', kind: 'do', chore: 'sweep' }, BEHAVIOR), { ok: false }, 'what is not important is never done by itself');
});

test('by itself, over the machine: one pull request a day however many repositories, never a file written in the working tree, and a small sweep waits', async () => {
  freshHome();
  const a = repo(), b = repo(), sp = spawned(), now = Date.now();
  const none = () => ({ worktrees: [], branches: [], kept: [] });
  assert.equal((await upkeepCheck(a.store, { fns: { ...given(sp), findMess: none }, now })).did.length, 1);
  const second = await upkeepCheck(b.store, { fns: { ...given(sp), findMess: none }, now: now + 3600_000 });
  assert.deepEqual(second.did, [], 'the machine has had its pull request for the day');
  assert.equal(second.later, 2);
  assert.equal((await upkeepCheck(b.store, { fns: { ...given(sp), findMess: none }, now: now + DAY + 3600_000 })).did.length, 1);
  // where no pull request can be opened, a section is never changed by itself: it is the person's to apply
  const c = repo(), sp2 = spawned();
  assert.deepEqual((await upkeepCheck(c.store, { fns: { ...given(sp2, { canPr: false }), findMess: none }, now: now + 3 * DAY })).did, []);
  assert.equal(sp2.calls.length, 0);
  const listed = upkeepInbox(c.store, { now: now + 3 * DAY }).items;
  assert.deepEqual(listed.map(i => [i.id, i.action.label]).slice(0, 1), [['change:section:AGENTS.md:releases', 'Change the file to shorten it']]);
  // ... and not even when a pull request could be opened at the check and cannot be now
  const d = repo(), sp3 = spawned(); let can = true;
  const flaky = { ...given(sp3), prAvailable: () => ({ ok: can }), findMess: none };
  await upkeepCheck(d.store, { fns: flaky, act: false, now: now + 5 * DAY });
  can = false;
  assert.match((await upkeepDo(d.store, 'change:section:AGENTS.md:releases', { fns: flaky, by: 'thinker', all: true, now: now + 5 * DAY })).error, /no pull request can be opened from here now/);
  assert.equal(sp3.calls.length, 0);
  // a single stray branch is not worth acting on, and not worth a line either; told that it is, thinker removes it
  const e = repo(); e.git(['branch', 'left-over', 'main']);
  const small = { ...given(spawned(), { kb: 10 }), view: () => null };
  assert.deepEqual((await upkeepCheck(e.store, { fns: small, now })).did, []);
  assert.deepEqual(upkeepInbox(e.store, { now }).items, []);
  setBehavior(e.store, 'sweepMin', 1, { scope: 'repo' });
  assert.deepEqual((await upkeepCheck(e.store, { fns: small, now })).did.map(x => x.said), ['Removed 1 merged branch']);
  freshHome();
});

test('a rule sessions keep breaking is a heads-up with what they did, counted over the verdicts of real sessions', async () => {
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
  await upkeepCheck(r.store, { fns: { view: () => null, findMess: () => ({ worktrees: [], branches: [], kept: [] }) } });
  const { items } = upkeepInbox(r.store);
  assert.equal(items.length, 1, 'broken once is not a pattern');
  assert.equal(items[0].title, 'Agents keep breaking a rule: AGENTS.md · Worktrees');
  assert.match(items[0].detail, /^Broken in 3 of the 4 sessions it came up in over the last 30 days\./);
  assert.deepEqual(items[0].lines, ['edited src/a.js in the main checkout', 'committed on main', 'no worktree was made']);
  assert.equal(items[0].action, null);
  // a heads-up is read, not done: it does not count as needing the person, and Got it puts it away for a week
  const v = upkeepView(r.store);
  assert.equal(v.attention, 0); assert.equal(v.summary, '1 heads-up.');
  assert.match((await upkeepDo(r.store, 1)).error, /there is nothing to do about it from here/);
  upkeepDismiss(r.store, 1);
  assert.deepEqual(upkeepInbox(r.store).items, []);
  assert.equal(upkeepInbox(r.store, { now: Date.now() + (UPKEEP.dismissDays + 1) * DAY }).items.length, 1);
});

test('the activity says what the offline work did, a line a day, and all repositories read as one list', () => {
  freshHome();
  const r = repo();
  const t = (d, h = 10) => { const x = new Date(Date.now() - d * DAY); x.setHours(h, 0, 0, 0); return x.toISOString(); };
  const log = [
    { t: t(1, 9), op: 'profile', observations: 2 }, { t: t(1, 15), op: 'profile', observations: 3 }, { t: t(2), op: 'profile', observations: 0 },
    { t: t(1, 16), op: 'profile-compile', changes: { kept: 9, added: 2, updated: 1, dropped: 1 } }, { t: t(3), op: 'profile-compile', changes: { kept: 9, added: 0, updated: 0, dropped: 0 } },
    { t: t(1, 11), op: 'maintain', pruned: 41 }, { t: t(2), op: 'maintain' }, { t: t(UPKEEP.feedDays + 3), op: 'profile', observations: 9 },
  ];
  assert.deepEqual(upkeepFeed(r.store, { log }).map(f => f.text), [
    'Updated your profile: 2 lines added, 1 reworded, 1 dropped', 'Read 2 sessions and noted 5 things about how you work', 'Cleared 41 stale state files', 'Read 1 session; nothing new to note',
  ]);
  const base = { level: 'auto', behavior: BEHAVIOR, behaviorSaid: 'x', later: 0 };
  const a = { ...base, lastCheck: t(0, 8), items: [{ id: 'sweep', kind: 'do', chore: 'sweep', found: t(1), title: 'a' }], feed: [{ at: t(1), text: 'x' }] };
  const b = { ...base, later: 2, lastCheck: t(2), items: [{ id: 'rule:x', kind: 'note', chore: 'rules', found: t(0), title: 'b' }, { id: 'wait:pr:3', kind: 'wait', chore: 'waiting', found: t(3), title: 'c' }], feed: [{ at: t(0), text: 'y' }] };
  const all = mergeUpkeepViews([{ repo: 'one', name: 'One', view: a }, { repo: 'two', name: 'Two', view: b }]);
  assert.deepEqual(all.items.map(i => [i.n, i.title, i.repoName]), [[1, 'c', 'Two'], [2, 'a', 'One'], [3, 'b', 'Two']], 'what waits on the person first, a heads-up last');
  assert.deepEqual(all.feed.map(f => f.text), ['y', 'x']);
  assert.equal(all.lastCheck, t(2), 'the list is as old as its oldest check');
  // a pull request waiting on a merge is counted by the decisions' own badge, not twice
  assert.equal(all.attention, 1); assert.equal(all.summary, '2 things need you, 1 heads-up, 2 more changes waiting their turn.');
  assert.equal(mergeUpkeepViews([{ repo: 'one', name: 'One', view: a }, { repo: 'three', name: 'Three', view: { ...base, lastCheck: null, items: [], feed: [] } }]).lastCheck, null, 'not looked at everywhere yet');
  assert.equal(mergeUpkeepViews([{ repo: 'one', name: 'One', view: a }, { repo: 'two', name: 'Two', view: { ...b, level: 'ask' } }]).level, 'mixed');
  // a tool is switched for the whole machine: found in two repositories it is one item, the costliest, and the
  // decision about it one line, not a line a repository
  const tool = (rank, detail) => ({ id: 'change:claude:builtin:Agent', kind: 'do', chore: 'context', machine: true, rank, title: 'Agent tool', detail, found: t(1) });
  const said = { at: t(1), kind: 'change', text: 'x MCP server: Switched off', shared: 'abc' };
  const m = mergeUpkeepViews([
    { repo: 'one', name: 'One', view: { ...a, items: [tool(100, 'small.'), { id: 'sweep', kind: 'do', chore: 'sweep', rank: 0, found: t(1), title: 'a' }], feed: [said] } },
    { repo: 'two', name: 'Two', view: { ...b, items: [tool(900, 'big.')], feed: [said] } },
  ]);
  assert.deepEqual(m.items.map(i => [i.title, i.repoName, i.repo]), [['a', 'One', 'one'], ['Agent tool', '2 repositories', 'two']], 'acted on from the repository that showed it');
  assert.equal(m.items[1].detail, 'big. The figure is the costliest of the 2 repositories it is loaded in.');
  assert.deepEqual(m.feed.map(f => f.repoName), ['All repositories']);
});

test('maintenance runs the check, says once what thinker did by itself, and `upkeep: false` stops it', async () => {
  freshHome();
  const r = repo();
  const fns = { syncPrs: async () => ({ synced: 0 }), containers: () => null, contextSuggest: async () => null };
  const m = await maintain(r.store, r.dir, { fns });
  assert.equal(m.errors, 0); assert.equal(m.upkeepFound, 0);
  assert.ok(readUpkeep(r.store).lastCheck, 'the check was kept');
  assert.match(renderMaintain({ upkeepFound: 2, upkeepDid: 1, errors: 0 }), /1 thing done on its own, 2 things need you \(`thinker activity`\)/);
  // what it did is said at the end of the next turn, once
  const q = repo();
  const did = await maintain(q.store, q.dir, { fns: { ...fns, upkeep: async () => ({ found: 0, did: [{ id: 'sweep', kind: 'do', said: 'Removed 3 merged worktrees, 1.2 GB back' }, { id: 'change:x', kind: 'pr', said: 'Compressing 1 section in the background…' }], later: 0, errors: [] }) } });
  assert.equal(did.upkeepDid, 2);
  assert.equal(maintenanceNotice(q.store), '🧠 thinker: removed 3 merged worktrees, 1.2 GB back; started a pull request for a section nobody needs (Recent activity has it)');
  assert.equal(maintenanceNotice(q.store), '');
  const off = repo({ upkeep: false });
  assert.deepEqual(await upkeepCheck(off.store), { skipped: 'off' });
  const v = upkeepView(off.store);
  assert.equal(v.level, 'off'); assert.equal(v.summary, 'Thinker is not looking after this repository.');
});
