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
const { upkeepCheck, upkeepPending, upkeepDo, upkeepDismiss, upkeepUndo, upkeepView, upkeepFeed, upkeepDetail, upkeepDelegated, delegatedTotalSaid, mergeUpkeepViews, renderUpkeep, behaviorOf, setBehavior, steerBehavior, behaviorSaid, mayAct, batchOf, readUpkeep, impactSaid, BEHAVIOR, UPKEEP } = await import('../src/upkeep.js');
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
  // the owner's answers, 2026-11-21: $1 a day is clear value, a batch once enough has piled up and at most weekly,
  // sections shortened or removed and tools switched, skills left alone
  assert.deepEqual([b.level, b.sweep, b.prs, b.remove, b.tools, b.skills, b.minPerDay, b.batchPerDay, b.batchEveryDays, b.followUp, b.followUpDays], ['auto', true, true, true, true, false, 1, 5, 7, true, 7]);
  assert.equal(behaviorSaid(b), 'Thinker acts on its own here: it removes merged worktrees and branches; shortens or removes instruction sections nobody needs in a pull request and switches off tools nobody calls, but only what saves $1.00 a day or more, together in one batch once that comes to $5.00 a day, at most every 7 days. 7 days after a change takes effect it checks it, and takes back what did not pay.');
  assert.doesNotMatch(behaviorSaid({ ...b, followUp: false }), /takes back what did not pay/);
  assert.match(behaviorSaid({ ...b, remove: false, tools: false, skills: true }), /it removes merged worktrees and branches; shortens instruction sections nobody needs in a pull request and switches off skills nobody calls, but only/);
  // two of them are not the upkeep block's: the handoffs to cheaper agents (delegate.js) and how long an answer the
  // person asked their agents for (profile.js), each read and written where that part of thinker keeps it, and the
  // machine's alone however they are asked for
  assert.deepEqual([b.delegation, b.answerWords], [true, null]);
  assert.equal(setBehavior(r.store, 'delegation', 'off', { scope: 'repo' }).said, 'delegation is now false on this machine');
  assert.equal(setBehavior(r.store, 'answerWords', '60').said, 'answerWords is now 60 on this machine');
  assert.deepEqual([behaviorOf(r.store).delegation, behaviorOf(r.store).answerWords], [false, 60]);
  const machineCfg = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
  assert.deepEqual([machineCfg.delegate, machineCfg.style, machineCfg.upkeep], [{ enabled: false }, { answerWords: 60 }, undefined]);
  assert.deepEqual(behaviorOf(r.store).set, { machine: {}, repo: {} }, 'neither was written into an upkeep block');
  assert.match(setBehavior(r.store, 'answerWords', '5').error, /answerWords cannot be "5"/);
  // the machine's wish, then one repository's over it
  assert.equal(setBehavior(r.store, 'batchEveryDays', '30').said, 'batchEveryDays is now 30 on this machine');
  assert.equal(setBehavior(r.store, 'prs', 'off', { scope: 'repo' }).said, 'prs is now false in this repository');
  const other = repo();
  assert.deepEqual([behaviorOf(r.store).prs, behaviorOf(r.store).batchEveryDays, behaviorOf(other.store).prs, behaviorOf(other.store).batchEveryDays], [false, 30, true, 30]);
  assert.deepEqual(behaviorOf(r.store).set, { machine: { batchEveryDays: 30 }, repo: { prs: false } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')).upkeep, { batchEveryDays: 30 });
  // dollars are read as a person writes them, to the cent
  assert.deepEqual([setBehavior(other.store, 'minPerDay', '$2.50', { scope: 'repo' }).value, setBehavior(other.store, 'batchPerDay', 12.345, { scope: 'repo' }).value], [2.5, 12.35]);
  // nothing unknown is written, and a hand-edited file is read the same way
  assert.match(setBehavior(r.store, 'recklessness', 'max').error, /there is no setting called recklessness/);
  assert.match(setBehavior(r.store, 'level', 'yolo').error, /level cannot be "yolo"/);
  assert.match(setBehavior(r.store, 'batchEveryDays', 0).error, /batchEveryDays cannot be 0/);
  assert.match(setBehavior(r.store, 'minPerDay', 'lots').error, /minPerDay cannot be "lots"/);
  assert.equal(behaviorOf(repo({ upkeep: { level: 'yolo', batchPerDay: 'many', tools: false } }).store).level, 'auto');
  assert.equal(behaviorOf(repo({ upkeep: { tools: false } }).store).tools, false);
  // a setting of the rules before 2026-11-21 (one pull request a week, the high-waste share) is read as nothing
  assert.deepEqual(behaviorOf(repo({ upkeep: { important: 'medium', prEveryDays: 30 } }).store).set.repo, {});
  assert.equal(behaviorOf(repo({ upkeep: false }).store).level, 'off');
  assert.equal(behaviorSaid(behaviorOf(repo({ upkeep: { level: 'ask' } }).store)), 'Thinker does nothing here until you tell it to.');
  freshHome();
});

// A kept Context report, each part by what it wasted over the week at $5 a million tokens: Releases $2.86 a day,
// Ports $1.43, Style $0.64 (under the $1 a day that is worth acting on), and the Workflow tool $1.50.
const section = (id, title, waste, wastedWindow, usedShare = 0.02) => ({ id, file: 'AGENTS.md', title, tokens: 2000, wasted: 30_000, wastedWindow, waste, usedShare, text: `About ${title}.` });
const view = () => ({
  days: 7, sessions: 40, rate: { perToken: 5e-6 },
  instructions: { sessions: 40, sections: [section('releases', 'Releases', 'high', 4_000_000), section('ports', 'Ports', 'high', 2_000_000), section('style', 'Style', 'medium', 900_000)] },
  skills: [], outputs: { tools: [] },
  tools: [{ name: 'Workflow', kind: 'tool', group: 'builtin', client: 'claude', key: 'builtin:Workflow', label: 'Workflow tool', used: 0, loaded: 40, tokens: 3000, wasted: 20_000, wastedWindow: 2_100_000, waste: 'high' }],
});
// the same report with no tool in it: a tool switch writes the agent's own settings, which no test here does
const sectionsOnly = () => ({ ...view(), tools: [] });
// its two sections worth acting on come to $4.29 a day, under the $5 a batch goes at; with a third that no prompt
// needed at all ($1.25 a day) enough has piled up: $5.54
const withSections = (...more) => ({ ...sectionsOnly(), instructions: { sessions: 40, sections: [...sectionsOnly().instructions.sections, ...more] } });
const piled = () => withSections(section('legacy', 'Legacy', 'high', 1_750_000, 0));
const WAITS = 'the changes worth making come to $4.29 a day together so far, and a batch goes at $5.00';
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
  // the cheap section is under the bar: it is not held at all, it stays in `thinker context`
  assert.deepEqual(pending.map(i => [i.id, i.kind, i.title, i.why, Boolean(i.later)]), [
    ['change:section:AGENTS.md:releases', 'pr', 'AGENTS.md · Releases', 'you asked to be asked first', false],
    ['change:section:AGENTS.md:ports', 'pr', 'AGENTS.md · Ports', 'you asked to be asked first', false],
    ['sweep', 'do', '1 merged worktree and 1 branch can go · 3.0 GB', 'you asked to be asked first', false],
    ['change:claude:builtin:Workflow', 'do', 'Workflow tool', 'you asked to be asked first', false],
  ]);
  assert.match(pending[0].detail, /^Needed in 2% of prompts; ~2k tokens in every model call\. About \$20\.0 went on it unused over the last 7 days, \$2\.86 a day\.$/);
  // neither door lists these as things to do: both say how much is held, and what was done
  const v = upkeepView(r.store);
  assert.deepEqual([v.summary, v.later, v.held, v.level], ['4 held back until you say.', 0, 4, 'ask']);
  const text = renderUpkeep(v).join('\n');
  assert.match(text, /^Recent activity · thinker last looked just now\n {2}4 held back until you say\. Thinker does nothing here until you tell it to\.\n\n {2}Nothing yet\./);
  assert.doesNotMatch(text, /Needs you|thinker activity do|Releases/);
  // a kind switched off is held for that reason; the rest go ahead
  const q = repo({ upkeep: { prs: false } });
  await upkeepCheck(q.store, { fns: { ...given(spawned()), findMess: none }, act: false });
  assert.deepEqual(upkeepPending(q.store).pending.map(i => i.why), ['pull requests are switched off here', 'pull requests are switched off here']);
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
  // "never mind the tool": left alone in the history `thinker context` reads too, and by thinker for three months
  assert.equal(upkeepDismiss(r.store, 'change:claude:builtin:Workflow', { fns }).said, 'Workflow tool: left alone for the next 90 days');
  assert.equal(changeHistory(r.store).filter(e => e.decision === 'dismissed' && e.via === VIA.thinker).length, 1);
  await upkeepCheck(r.store, { fns, now: Date.now() + 30 * DAY });
  assert.ok(!upkeepPending(r.store, { now: Date.now() + 30 * DAY }).pending.some(i => i.id === 'change:claude:builtin:Workflow'), 'still left a month on, though `thinker context` offers it again after a week');
  // the activity: a line an action, with what it came to: the disk a sweep freed; for a section still being made, what
  // the Context report expected of it, said as such
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
  // the section is flagged again by the Context report (its decision was reverted), and thinker leaves it be
  const sp = spawned();
  const check = await upkeepCheck(r.store, { fns: { ...given(sp), findMess: none }, now: now + 10 * DAY });
  assert.deepEqual(check.did, []);
  assert.deepEqual(upkeepPending(r.store, { now: now + 10 * DAY }).pending.map(i => [i.id, i.why]), [['change:section:AGENTS.md:ports', 'the changes worth making come to $1.43 a day together so far, and a batch goes at $5.00']], 'what was taken back is not counted towards the next batch');
  assert.match((await upkeepUndo(r.store, 'h:nope')).error, /no such decision/);
});

test('by itself: only what clearly pays, together as one batch and one pull request once enough has piled up, at most weekly, and a look does nothing', async () => {
  freshHome();
  const r = repo();
  const done = tree(r, 'done'); r.commit('done.txt', done); mergeIn(r, 'agent/done');
  const sp = spawned(), fns = given(sp);
  const now = Date.now();
  // a look (all a visit to the page starts) finds and keeps, and does nothing
  const look = await upkeepCheck(r.store, { fns, act: false, now });
  assert.deepEqual(look.did, []); assert.equal(sp.calls.length, 0); assert.ok(fs.existsSync(done));
  assert.deepEqual(upkeepPending(r.store, { now }).pending.map(i => [i.id, i.why, i.later]), [['change:section:AGENTS.md:releases', WAITS, true], ['change:section:AGENTS.md:ports', WAITS, true], ['sweep', 'at its next check', true]]);
  assert.deepEqual(upkeepPending(r.store, { now }).batch, { changes: 2, perDay: 30 / 7, ok: false, later: true, why: WAITS });
  assert.equal(upkeepView(r.store, { now }).summary, '2 changes worth $4.29 a day waiting for the next batch, 1 more waiting its turn.');
  // a check: the sweep goes on its own turn; the sections wait for more to pile up, and no pull request is opened
  const check = await upkeepCheck(r.store, { fns, now });
  assert.deepEqual(check.did.map(d => d.id), ['sweep']);
  assert.equal(check.pending, 2); assert.equal(sp.calls.length, 0); assert.ok(!fs.existsSync(done));
  assert.match(renderUpkeep(upkeepView(r.store, { now }), { now }).join('\n'), /Removed 1 merged worktree and 1 branch {2}3\.0 GB freed \(on its own\)/);
  // a third section crosses the bar and enough has piled up: everything worth making goes at once, as one job and
  // one pull request -- the section no prompt needed at all removed, the others shortened
  const batch = await upkeepCheck(r.store, { fns: { ...fns, view: piled }, now: now + DAY });
  assert.deepEqual(batch.did.map(d => [d.id, d.kind, d.said]), [['batch', 'batch', 'Sent a batch of 3 changes worth about $5.54 a day: a pull request that shortens 2 sections and removes 1']]);
  assert.deepEqual(sp.calls.map(c => c.slice(1)), [['instructions', '--compress', 'releases,ports', '--remove', 'legacy', '--pr', '--job', changeHistory(r.store)[0].group]]);
  const h = changeHistory(r.store);
  assert.deepEqual(h.map(e => [e.section, e.act, e.job.action, e.via]).sort(), [['legacy', 'remove', 'remove', VIA.thinker], ['ports', 'compress', 'compress', VIA.thinker], ['releases', 'compress', 'compress', VIA.thinker]]);
  assert.equal(new Set(h.map(e => e.group)).size, 1); assert.equal(new Set(h.map(e => e.batch)).size, 1); assert.ok(h[0].batch);
  assert.deepEqual(upkeepPending(r.store, { now: now + DAY }).pending, []);
  // ... and one line of the activity for all of it: what it is doing, and what was expected of it until it merges
  const lines = upkeepFeed(r.store, { now: now + DAY });
  assert.deepEqual(lines.map(f => [f.text, f.impactSaid, f.by, f.steer]), [['Batch of 3: shortening 2 sections and removing 1', 'about −90k tokens per prompt once merged', 'thinker', 'changes'], ['Removed 1 merged worktree and 1 branch', '3.0 GB freed', 'thinker', 'sweep']]);
  assert.equal(lines[0].id, `b:${h[0].batch}`); assert.deepEqual(lines[0].batch, { changes: 3, sections: 3, tools: 0 });
  // More piles up. While the first is still being made nothing is started; then the batch waits its week, and not
  // for the first one's pull request: with #5 still in review a week on, another is opened ("open another")
  const next = { ...fns, view: () => withSections(section('deploy', 'Deploy', 'high', 5_000_000), section('oncall', 'On call', 'high', 3_000_000)) };
  assert.deepEqual((await upkeepCheck(r.store, { fns: next, now: now + DAY + 3600_000 })).did, []);
  assert.deepEqual([...new Set(upkeepPending(r.store, { now: now + DAY + 3600_000 }).pending.map(i => i.why))], ['a change is still being made here']);
  const opened = () => { const f = path.join(r.store.dir, 'state', 'context-suggest.json'), st = JSON.parse(fs.readFileSync(f, 'utf8')); for (const e of st.history) { e.job = { ...e.job, state: 'done' }; e.decision = 'pull request'; e.pr = { number: 5, state: 'open', url: 'https://github.com/o/r/pull/5', branch: 'thinker/context-1', openedAt: new Date(now + DAY).toISOString() }; } fs.writeFileSync(f, JSON.stringify(st)); };
  opened();
  assert.deepEqual((await upkeepCheck(r.store, { fns: next, now: now + 3 * DAY })).did, [], 'inside the week');
  assert.deepEqual([...new Set(upkeepPending(r.store, { now: now + 3 * DAY }).pending.map(i => i.why))], ['one batch every 7 days here, and the last went 2 days ago']);
  const second = await upkeepCheck(r.store, { fns: next, now: now + 9 * DAY });
  assert.deepEqual(second.did.map(d => d.said), ['Sent a batch of 2 changes worth about $5.71 a day: a pull request that shortens 2 sections']);
  assert.deepEqual(sp.calls[1].slice(1, 5), ['instructions', '--compress', 'deploy,oncall', '--pr']);
  assert.equal(upkeepView(r.store, { now: now + 9 * DAY }).summary, 'Up to date.');
  // the line of the first batch now says where its pull request stands, and carries its link and the id that takes it back
  const first = upkeepFeed(r.store, { now: now + 9 * DAY }).find(f => f.id === `b:${h[0].batch}`);
  assert.deepEqual([first.text, first.url, first.pr, first.impactSaid, first.undo, first.kind], ['Batch of 3: PR #5 in review shortens 2 sections and removes 1', 'https://github.com/o/r/pull/5', { number: 5, state: 'open' }, 'about −90k tokens per prompt once merged', `b:${h[0].batch}`, 'pr']);
  assert.deepEqual(mayAct(r.store, { important: false, action: {}, allow: 'sweep', kind: 'do', chore: 'sweep' }, BEHAVIOR), { ok: false }, 'what is not worth doing is never done');
});

test('what a batch may hold: sections shortened or removed and tools, never a skill unless told, and each kind as its setting says', async () => {
  freshHome();
  const q = repo(), now = Date.now();
  const item = (allow, perDay) => ({ id: `change:x:${allow}`, chore: 'context', kind: allow === 'prs' || allow === 'remove' ? 'pr' : 'do', allow, important: true, perDay, action: {}, data: { key: `x:${allow}` } });
  const items = [item('prs', 3), item('remove', 2), item('tools', 2), item('skills', 9)];
  const of = b => { const x = batchOf(q.store, b, { now, items }); return [x.items.map(i => i.allow), x.perDay, x.ok]; };
  assert.deepEqual(of(BEHAVIOR), [['prs', 'remove', 'tools'], 7, true], 'skills are left alone (the owner\'s answer)');
  assert.deepEqual(of({ ...BEHAVIOR, skills: true, remove: false, tools: false }), [['prs', 'skills'], 12, true]);
  assert.deepEqual(of({ ...BEHAVIOR, prs: false }), [['tools'], 2, false], 'a removal is a pull request too');
  assert.equal(batchOf(q.store, { ...BEHAVIOR, batchPerDay: 10 }, { now, items }).why, 'the changes worth making come to $7.00 a day together so far, and a batch goes at $10.0');
  assert.deepEqual(batchOf(q.store, { ...BEHAVIOR, level: 'ask' }, { now, items }).why, 'you asked to be asked first');
  // asked of one item: its kind's setting first, then the batch it would go with
  assert.deepEqual(mayAct(q.store, items[3], BEHAVIOR, { now }), { ok: false, why: 'skills are left alone unless you say otherwise' });
  assert.deepEqual(mayAct(q.store, items[2], { ...BEHAVIOR, tools: false }, { now }), { ok: false, why: 'switching tools is switched off here' });
  assert.deepEqual(mayAct(q.store, items[1], { ...BEHAVIOR, remove: false }, { now }), { ok: false, why: 'it may shorten a section here but not remove one' });
  assert.deepEqual(mayAct(q.store, items[0], BEHAVIOR, { now, batch: batchOf(q.store, BEHAVIOR, { now, items }) }), { ok: true });
  // the tool of the report goes with the sections where they pile up together ($2.86 + $1.43 + $1.50): held as one batch
  await upkeepCheck(q.store, { fns: { ...given(spawned(), { report: view }), findMess: none }, act: false, now });
  assert.deepEqual(upkeepPending(q.store, { now }).batch, { changes: 3, perDay: (4_000_000 + 2_000_000 + 2_100_000) * 5e-6 / 7, ok: true });
  assert.equal(upkeepView(q.store, { now }).summary, '3 changes worth $5.79 a day going out in the next batch.');
  // over all repositories the tool is one change (it is switched for the machine), worth what it wastes in each
  const q2 = repo();
  await upkeepCheck(q2.store, { fns: { ...given(spawned(), { report: view }), findMess: none }, act: false, now });
  const both = mergeUpkeepViews([{ repo: 'a', name: 'o/a', view: upkeepView(q.store, { now }) }, { repo: 'b', name: 'o/b', view: upkeepView(q2.store, { now }) }]);
  assert.deepEqual([both.batch.changes, Math.round(both.batch.perDay * 100) / 100, both.summary], [5, 11.57, '5 changes worth $11.6 a day going out in the next batch.']);
  // a change kept by a check from before the bar was dollars has no figure: it is not held, and the next check prices it
  const old = repo();
  fs.mkdirSync(path.join(old.store.dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(old.store.dir, 'state', 'upkeep.json'), JSON.stringify({ lastCheck: new Date(now).toISOString(), items: [{ id: 'change:section:AGENTS.md:releases', chore: 'context', kind: 'pr', allow: 'prs', important: true, title: 'AGENTS.md · Releases', action: { label: 'x' }, data: { key: 'section:AGENTS.md:releases' } }] }));
  assert.deepEqual([upkeepPending(old.store, { now }).pending, upkeepView(old.store, { now }).summary], [[], 'Up to date.']);
  // where a section was needed at all, or by too few sessions to say, it is shortened, never removed
  const few = repo(), sp = spawned();
  await upkeepCheck(few.store, { fns: { ...given(sp, { report: () => ({ ...piled(), sessions: 4, instructions: { ...piled().instructions, sessions: 4 } }) }), findMess: none }, now });
  assert.deepEqual(sp.calls[0].slice(1, 5), ['instructions', '--compress', 'releases,ports,legacy', '--pr']);
});

test('a pull request of thinker\'s own closed without merging is a no: its sections are left alone for three months', async () => {
  freshHome();
  const r = repo(), now = Date.now(), at = new Date(now - 10 * DAY).toISOString();
  fs.mkdirSync(path.join(r.store.dir, 'state'), { recursive: true });
  const closed = (id, key, via) => ({ id, at, key, kind: 'section', title: `AGENTS.md · ${id}`, saving: 1200, act: 'compress', decision: 'pull request', via, pr: { number: 12, state: 'closed', at } });
  fs.writeFileSync(path.join(r.store.dir, 'state', 'context-suggest.json'), JSON.stringify({ history: [closed('p1', 'section:AGENTS.md:releases', 'thinker'), closed('p2', 'section:AGENTS.md:legacy', 'command')] }));
  const sp = spawned(), fns = { ...given(sp, { report: piled }), findMess: none };
  // Releases was thinker's and was turned down; Legacy was the person's own pull request, which is theirs to try again
  assert.deepEqual((await upkeepCheck(r.store, { fns, now })).did, []);
  assert.deepEqual(upkeepPending(r.store, { now }).pending.map(i => i.id), ['change:section:AGENTS.md:ports', 'change:section:AGENTS.md:legacy']);
  assert.equal(upkeepPending(r.store, { now }).batch.why, 'the changes worth making come to $2.68 a day together so far, and a batch goes at $5.00');
  // three months after it was closed it may be put up again
  const later = now + 81 * DAY;
  assert.deepEqual((await upkeepCheck(r.store, { fns, now: later })).did.map(d => d.said), ['Sent a batch of 3 changes worth about $5.54 a day: a pull request that shortens 2 sections and removes 1']);
});

test('a week on, each change of a batch is checked once: what paid is kept, what backfired is taken back, said, and not tried again', async () => {
  freshHome();
  const r = repo(), now = Date.now(), at = new Date(now - 9 * DAY).toISOString(), mergedAt = new Date(now - 8 * DAY).toISOString();
  const dir = path.join(r.store.dir, 'state');
  fs.mkdirSync(dir, { recursive: true });
  // a batch of thinker's own, nine days ago: two sections shortened by a pull request that merged a day later, three
  // tools made references at once
  const sec = (id, title) => ({ id, group: 'g1', batch: 'b1', at, via: 'thinker', key: `section:AGENTS.md:${title.toLowerCase()}`, kind: 'section', title: `AGENTS.md · ${title}`, file: 'AGENTS.md', section: title.toLowerCase(), saving: 20_000, act: 'compress', decision: 'pull request', job: { state: 'done', action: 'compress', pr: true }, pr: { number: 12, state: 'merged', url: 'https://github.com/o/r/pull/12', at: mergedAt, mergeCommit: 'abc', pulledAt: mergedAt } });
  const tool = (id, name) => ({ id, batch: 'b1', at, via: 'thinker', key: `claude:builtin:${name}`, kind: 'tool', title: `${name} tool`, saving: 3000, act: 'off', action: 'Create tool reference', decision: 'approved' });
  fs.writeFileSync(path.join(dir, 'context-suggest.json'), JSON.stringify({ history: [sec('p1', 'Releases'), sec('p2', 'Ports'), tool('t1', 'Workflow'), tool('t2', 'Agent'), tool('t3', 'Canva')] }));
  fs.writeFileSync(path.join(dir, 'upkeep.json'), JSON.stringify({ done: [{ id: 'b1', at, item: 'batch', chore: 'context', kind: 'batch', title: 'A batch of 5 changes', said: 'Sent a batch of 5 changes', by: 'thinker', kept: true, batch: { keys: [], perDay: 9 } }] }));
  // since then: sessions kept breaking the Releases rule, which they had not before; Ports came up and was followed
  const judged = (d, verdicts) => ({ judged: { at: new Date(now - d * DAY).toISOString(), verdicts } }), v = (id, verdict) => ({ [id]: { verdict, evidence: 'x' } });
  fs.writeFileSync(path.join(dir, 'instruction-value.json'), JSON.stringify({ sessions: {
    a1: judged(1, v('releases', 'violated')), a2: judged(2, v('releases', 'violated')), a3: judged(3, { ...v('releases', 'violated'), ...v('ports', 'followed') }), a4: judged(4, v('Releases', 'violated')), a5: judged(5, v('releases', 'followed')),
    b1: judged(10, v('releases', 'followed')), b2: judged(11, v('releases', 'followed')), b3: judged(12, v('releases', 'violated')),
  } }));
  // the sessions on both sides, five each: the Workflow tool's definition is gone from a prompt since; Canva's costs
  // what it did; the Agent tool was still called in 14% of prompts over the report's week
  const row = (d, sources) => ({ t: now - d * DAY, input: 1_000_000, prompts: 100, sources });
  const rows = [...[14, 13, 12, 11, 10].map(d => row(d, { 'claude:builtin:Workflow': 300_000, 'claude:builtin:Canva': 300_000 })), ...[5, 4, 3, 2, 1].map(d => row(d, { 'claude:builtin:Canva': 300_000 }))];
  const report = () => ({ ...sectionsOnly(), instructions: { sessions: 40, sections: [] }, tools: [{ name: 'Agent', kind: 'tool', group: 'builtin', client: 'claude', key: 'builtin:Agent', label: 'Agent tool', off: true, usedShare: 0.14, tokens: 100 }, { name: 'Workflow', kind: 'tool', group: 'builtin', client: 'claude', key: 'builtin:Workflow', label: 'Workflow tool', off: true, usedShare: 0.01, tokens: 100 }] });
  const calls = [], fns = { view: report, findMess: none, prAvailable: () => ({ ok: true }), report: () => ({ rows }),
    revert: async (store, id) => { calls.push(['revert', id]); return id === 't3' ? { error: 'the settings file changed since' } : { said: 'turned back on' }; },
    restore: async (store, id, o) => { calls.push(['restore', id, o.why]); return { said: 'opened', pr: { number: 31, url: 'https://github.com/o/r/pull/31' } }; } };
  // inside the week nothing is looked at
  assert.deepEqual((await upkeepCheck(r.store, { fns, now: now - 3 * DAY })).did, []);
  assert.deepEqual(readUpkeep(r.store).followed, {});
  const check = await upkeepCheck(r.store, { fns, now });
  assert.deepEqual(check.did.map(d => d.said), [
    'Opened PR #31 to put AGENTS.md · Releases back as it was: agents broke it in 4 of the 5 sessions it came up in since it was shortened (1 of 3 over as long before)',
    'Turned Agent tool back on: it was still called in 14% of prompts after it was made a reference',
  ]);
  assert.deepEqual(calls, [['restore', 'p1', 'agents broke it in 4 of the 5 sessions it came up in since it was shortened (1 of 3 over as long before)'], ['revert', 't2'], ['revert', 't3']]);
  const f = readUpkeep(r.store).followed;
  assert.deepEqual(Object.fromEntries(Object.entries(f).map(([k, x]) => [k, [x.verdict, x.why]])), {
    p1: ['undone', 'agents broke it in 4 of the 5 sessions it came up in since it was shortened (1 of 3 over as long before)'],
    t1: ['kept', 'it saves 3k tokens a prompt, over 5 sessions since'],
    t2: ['undone', 'it was still called in 14% of prompts after it was made a reference'],
    t3: ['retry', 'it saved nothing: it cost 3k tokens a prompt before and 3k since'],
  }, 'Ports is not judged yet: nothing has measured it, and it is looked at again');
  // what was taken back is not put up again, and each is a line of the activity with its link
  assert.deepEqual(Object.keys(readUpkeep(r.store).dismissed).sort(), ['change:claude:builtin:Agent', 'change:section:AGENTS.md:releases']);
  const lines = upkeepFeed(r.store, { now, log: [], report: { rows, rate: 5e-6 } }).filter(l => l.kind === 'did');
  assert.deepEqual(lines.map(l => [l.text.split(':')[0], l.url, l.by, l.steer]).sort(), [['Opened PR #31 to put AGENTS.md · Releases back as it was', 'https://github.com/o/r/pull/31', 'thinker', 'changes'], ['Turned Agent tool back on', undefined, 'thinker', 'changes']]);
  // the next checks: nothing is judged twice; the undo that failed is tried again, three times in all, then held
  calls.length = 0;
  assert.deepEqual((await upkeepCheck(r.store, { fns, now: now + 3600_000 })).did, []);
  await upkeepCheck(r.store, { fns, now: now + 2 * 3600_000 });
  assert.deepEqual(calls, [['revert', 't3'], ['revert', 't3']]);
  assert.deepEqual([readUpkeep(r.store).followed.t3.verdict, readUpkeep(r.store).followed.t3.error], ['held', 'the settings file changed since']);
  await upkeepCheck(r.store, { fns, now: now + 3 * 3600_000 });
  assert.equal(calls.length, 2);
  // a month on with nothing to measure it by, Ports is left as it is
  await upkeepCheck(r.store, { fns, now: now + 21 * DAY });
  assert.deepEqual([readUpkeep(r.store).followed.p2.verdict, readUpkeep(r.store).followed.p2.why], ['kept', 'no session since could measure it']);
  // what the chat is given about the batch says what each check found
  const facts = upkeepDetail(r.store, 'b:b1', { now, log: [], report: { rows, rate: 5e-6 } }).join('\n');
  assert.match(facts, /Workflow tool[^\n]*\n(?: {2}[^\n]*\n)* {2}Checked on [A-Z][a-z]+ \d+: kept: it saves 3k tokens a prompt, over 5 sessions since\./);
  assert.match(facts, /Agent tool[^\n]*\n(?: {2}[^\n]*\n)* {2}Checked on [A-Z][a-z]+ \d+: taken back, because it was still called in 14% of prompts after it was made a reference\./);
  // told not to, thinker checks nothing; and a change the person asked for by name is never taken back by it
  const q = repo({ upkeep: { followUp: false } });
  fs.mkdirSync(path.join(q.store.dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(q.store.dir, 'state', 'context-suggest.json'), JSON.stringify({ history: [tool('t2', 'Agent')] }));
  fs.writeFileSync(path.join(q.store.dir, 'state', 'upkeep.json'), JSON.stringify({ done: [{ id: 'b1', at, item: 'batch', chore: 'context', kind: 'batch', said: 'x', by: 'thinker', kept: true }] }));
  calls.length = 0;
  await upkeepCheck(q.store, { fns, now });
  setBehavior(q.store, 'followUp', true, { scope: 'repo' });
  fs.writeFileSync(path.join(q.store.dir, 'state', 'upkeep.json'), JSON.stringify({ done: [{ id: 'b1', at, item: 'batch', chore: 'context', kind: 'batch', said: 'x', by: 'you', kept: true }] }));
  await upkeepCheck(q.store, { fns, now });
  assert.deepEqual(calls, []);
  freshHome();
});

test('by itself: no pull request, no section; a small sweep waits; and its own failure is tried again', async () => {
  freshHome();
  const now = Date.now();
  // where no pull request can be opened a section is not thinker's to change at all: not done, not held
  const c = repo(), sp2 = spawned();
  assert.deepEqual((await upkeepCheck(c.store, { fns: { ...given(sp2, { canPr: false, report: piled }), findMess: none }, now: now + 3 * DAY })).did, []);
  assert.equal(sp2.calls.length, 0); assert.deepEqual(upkeepPending(c.store, { now: now + 3 * DAY }).pending, []);
  // a single stray branch is not worth acting on; told that it is, thinker removes it
  const e = repo(); e.git(['branch', 'left-over', 'main']);
  const small = { ...given(spawned(), { kb: 10 }), view: () => null };
  assert.deepEqual((await upkeepCheck(e.store, { fns: small, now })).did, []);
  assert.deepEqual(upkeepPending(e.store, { now }).pending, []);
  setBehavior(e.store, 'sweepMin', 1, { scope: 'repo' });
  assert.deepEqual((await upkeepCheck(e.store, { fns: small, now })).did.map(x => x.said), ['Removed 1 merged branch']);
  // a batch of its own that failed is tried again a day later, three times in all, with nobody asked: the same
  // sections by the same actions
  const f = repo(), sp3 = spawned(), fail = () => { const file = path.join(f.store.dir, 'state', 'context-suggest.json'), st = JSON.parse(fs.readFileSync(file, 'utf8')); for (const x of st.history) x.job = { ...x.job, state: 'failed', error: 'the model timed out', finishedAt: new Date(now + 20 * DAY).toISOString() }; fs.writeFileSync(file, JSON.stringify(st)); };
  const once = { ...given(sp3, { report: piled }), findMess: none };
  await upkeepCheck(f.store, { fns: once, now: now + 20 * DAY });
  assert.equal(sp3.calls.length, 1); fail();
  assert.deepEqual((await upkeepCheck(f.store, { fns: once, now: now + 20 * DAY + 3600_000 })).did, [], 'not within the day');
  assert.deepEqual(upkeepPending(f.store, { now: now + 20 * DAY + 3600_000 }).pending.filter(i => i.chore === 'waiting').map(i => [i.title, i.why]), [['Trying again: AGENTS.md · Releases', 'it is tried again a day after it failed']]);
  const again = await upkeepCheck(f.store, { fns: once, now: now + 21 * DAY + 3600_000 });
  assert.deepEqual(again.did.map(d => d.id.replace(/:[0-9a-f]+$/, '')), ['wait:job']);
  assert.deepEqual(sp3.calls[1].slice(1, 7), ['instructions', '--compress', 'releases,ports', '--remove', 'legacy', '--pr']);
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

test('a batch in the activity: one line with what all of it came to and the part still waiting on its pull request, one line over all repositories, its facts for the chat, and taken back whole', async () => {
  freshHome();
  const a = repo(), b = repo(), now = Date.now(), at = new Date(now - 3 * DAY).toISOString();
  const state = s => path.join(s.dir, 'state', 'context-suggest.json');
  const sec = (batch, id, title, saving, act) => ({ id, group: `g-${batch}`, batch, at, via: 'thinker', key: `section:AGENTS.md:${id}`, kind: 'section', title: `AGENTS.md · ${title}`, file: 'AGENTS.md', section: id, saving, act, decision: 'pull request', job: { state: 'done', action: act, pr: true }, pr: { number: 12, state: 'open', url: 'https://github.com/o/r/pull/12', branch: 'thinker/context-1', at } });
  fs.mkdirSync(path.dirname(state(a.store)), { recursive: true });
  fs.writeFileSync(state(a.store), JSON.stringify({ history: [sec('b1', 'p1', 'Releases', 20_000, 'compress'), sec('b1', 'p2', 'Legacy', 5_000, 'remove')] }));
  // the batch's tool was made a reference for the whole machine: every repository's history has it
  fs.mkdirSync(path.join(HOME, 'state', 'machine-actions'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'state', 'machine-actions', 'context-suggest.json'), JSON.stringify({ history: [{ id: 'machine-t1', scope: 'machine', batch: 'b1', at, via: 'thinker', key: 'claude:builtin:Workflow', kind: 'tool', title: 'Workflow tool', saving: 3_000, act: 'off', action: 'Create tool reference', decision: 'approved' }] }));
  // 100 prompts a day here at $5 a million tokens: 28k tokens off a prompt is $14 a day, $12.50 of it the sections'
  const report = { rows: [{ t: now - DAY, input: 1_000_000, prompts: 700, sources: {} }], rate: 5e-6 };
  const [line, ...rest] = upkeepFeed(a.store, { now, log: [], report });
  assert.deepEqual(rest, []);
  assert.deepEqual([line.id, line.kind, line.steer, line.by, line.text, line.impactSaid, line.url, line.pr, line.undo, line.batch, line.sharedIn],
    ['b:b1', 'pr', 'changes', 'thinker', 'Batch of 3: PR #12 in review shortens 1 section and removes 1; 1 tool made a reference', 'about −28k tokens per prompt · $14.0/day ($12.5/day of it once PR #12 merges)', 'https://github.com/o/r/pull/12', { number: 12, state: 'open' }, 'b:b1', { changes: 3, sections: 2, tools: 1 }, ['machine-t1']]);
  assert.match(renderUpkeep(upkeepView(a.store, { now, log: [], report }), { now }).join('\n'), /Batch of 3: PR #12 in review shortens 1 section and removes 1; 1 tool made a reference {2}about −28k tokens per prompt · \$14\.0\/day \(\$12\.5\/day of it once PR #12 merges\) \(on its own\) {2}https:\/\/github\.com\/o\/r\/pull\/12/);
  // the other repository sees the tool alone, under the same batch; read together they are one line, the fuller one,
  // with what the tool saves there added (the tokens a prompt are then the average over both repositories' prompts)
  const there = upkeepFeed(b.store, { now, log: [], report })[0];
  assert.deepEqual([there.id, there.text, there.impactSaid], ['b:b1', 'Batch of 1: 1 tool made a reference', 'about −3k tokens per prompt · $1.50/day']);
  const all = mergeUpkeepViews([{ repo: 'b', name: 'o/b', view: upkeepView(b.store, { now, log: [], report }) }, { repo: 'a', name: 'o/a', view: upkeepView(a.store, { now, log: [], report }) }]);
  assert.deepEqual(all.feed.map(f => [f.id, f.repoName, f.text, f.impactSaid]), [['b:b1', 'o/a', 'Batch of 3: PR #12 in review shortens 1 section and removes 1; 1 tool made a reference', 'about −16k tokens per prompt · $15.5/day ($12.5/day of it once PR #12 merges)']]);
  // what the chat is given about it: why these went together, each change with its own undo, the pull request
  const facts = upkeepDetail(a.store, 'b:b1', { now, log: [], report }).join('\n');
  assert.match(facts, /^A batch of 3 changes made together on [A-Z][a-z]+ \d+, by thinker itself at one of its checks\./);
  assert.match(facts, /Why a batch: thinker makes a change only when it saves \$1\.00 a day or more by itself, and sends the ones that do together once they come to \$5\.00 a day between them, at most every 7 days\./);
  assert.match(facts, /AGENTS\.md · Releases[^\n]*\n {2}Why it was picked: about 20k of its tokens[^\n]*\n {2}Not measured yet: it is not in effect until its pull request merges\.[^\n]*\n {2}It can be taken back by itself \(undo id h:p1\), which takes the rest of the pull request back with it\./);
  assert.match(facts, /Workflow tool[\s\S]*It can be taken back by itself \(undo id h:machine-t1\)\./);
  assert.match(facts, /Its pull request: #12, in review since [^\n]*https:\/\/github\.com\/o\/r\/pull\/12\./);
  assert.match(facts, /The whole batch can be taken back at once \(undo id b:b1\)\.$/);
  // once it merges nothing waits; a closed pull request counts for nothing and leaves the tool's saving
  const setPr = st => { const j = JSON.parse(fs.readFileSync(state(a.store), 'utf8')); for (const e of j.history) e.pr = { ...e.pr, state: st }; fs.writeFileSync(state(a.store), JSON.stringify(j)); };
  setPr('merged');
  assert.deepEqual([upkeepFeed(a.store, { now, log: [], report })[0].text, upkeepFeed(a.store, { now, log: [], report })[0].impactSaid], ['Batch of 3: PR #12 merged, which shortened 1 section and removed 1; 1 tool made a reference', 'about −28k tokens per prompt · $14.0/day']);
  setPr('closed');
  assert.deepEqual([upkeepFeed(a.store, { now, log: [], report })[0].text, upkeepFeed(a.store, { now, log: [], report })[0].impactSaid], ['Batch of 3: PR #12 closed without merging (2 sections); 1 tool made a reference', 'about −3k tokens per prompt · $1.50/day']);
  // taken back whole: a batch of sections alone, its pull request closed once for both, and neither is put up again
  const c = repo(), closed = [];
  fs.mkdirSync(path.dirname(state(c.store)), { recursive: true });
  fs.writeFileSync(state(c.store), JSON.stringify({ history: [sec('b2', 'q1', 'Releases', 20_000, 'compress'), sec('b2', 'q2', 'Ports', 5_000, 'compress')] }));
  const took = await upkeepUndo(c.store, 'b:b2', { now, fns: { prs: { closePr: (dir, n, o) => { closed.push([n, o.branch]); return {}; } } } });
  assert.equal(took.said, 'AGENTS.md · Releases: pull request #12 closed');
  assert.deepEqual(closed, [[12, 'thinker/context-1']]);
  const gone = upkeepFeed(c.store, { now, log: [] })[0];
  assert.deepEqual([gone.text, gone.undone, gone.undo, gone.impactSaid], ['Batch of 2: its pull request #12 was taken back', true, undefined, undefined]);
  assert.deepEqual(Object.keys(readUpkeep(c.store).dismissed).sort(), ['change:section:AGENTS.md:q1', 'change:section:AGENTS.md:q2']);
  assert.equal((await upkeepUndo(c.store, 'b:b2', { now })).error, 'already taken back');
  assert.equal((await upkeepUndo(c.store, 'b:nope', { now })).error, 'no such batch');
  freshHome();
});

test('"more like this" and "less like this": one kind of thing moved one step, for a repository or the machine, and said with what it was', () => {
  freshHome();
  const r = repo();
  // changes to what loads into a prompt (a batch, a pull request, a tool, all one bar): what a change must save a
  // day, doubled for fewer of them, in this repository alone
  assert.equal(steerBehavior(r.store, 'changes', 'less', { scope: 'repo' }).said, 'a change must now save $2.00 a day before thinker makes it in this repository (it was $1.00)');
  assert.equal(steerBehavior(r.store, 'prs', 'less', { scope: 'repo' }).said, 'a change must now save $4.00 a day before thinker makes it in this repository (it was $2.00)');
  assert.deepEqual([behaviorOf(r.store).minPerDay, behaviorOf(repo().store).minPerDay], [4, 1]);
  // more, on the machine: halved, down to a quarter a day and no further
  assert.equal(steerBehavior(r.store, 'changes', 'more').said, 'a change must now save $0.50 a day before thinker makes it on this machine (it was $1.00)');
  assert.equal(steerBehavior(null, 'tools', 'more').said, 'a change must now save $0.25 a day before thinker makes it on this machine (it was $0.50)');
  assert.match(steerBehavior(null, 'changes', 'more').error, /the bar is already as low as thinker will go \(\$0\.25 a day\)/);
  // sweeps by their size; a kind that was switched off comes back on "more", and "less" of it is nothing to do
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
    `How it was done: create tool reference, approved, on ${new Date(t(10)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, by the person, on the page. Tool reference created.`,
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
  const fns = { syncPrs: async () => ({ synced: 0 }), containers: () => null };
  const m = await maintain(r.store, r.dir, { fns });
  assert.equal(m.errors, 0); assert.equal(m.upkeepDid, undefined);
  assert.ok(readUpkeep(r.store).lastCheck, 'the check was kept');
  assert.match(renderMaintain({ upkeepDid: 1, upkeepPending: 2, errors: 0 }), /1 thing done on its own, 2 waiting their turn/);
  // what it did is said at the end of the next turn, once
  const q = repo();
  const did = await maintain(q.store, q.dir, { fns: { ...fns, upkeep: async () => ({ did: [{ id: 'sweep', kind: 'do', said: 'Removed 3 merged worktrees · 1.2 GB freed' }, { id: 'batch', kind: 'batch', said: 'Sent a batch of 3 changes worth about $5.54 a day: a pull request that shortens 2 sections and removes 1' }], pending: 0, errors: [] }) } });
  assert.equal(did.upkeepDid, 2);
  assert.equal(maintenanceNotice(q.store), '🧠 thinker: removed 3 merged worktrees · 1.2 GB freed; sent a batch of 3 changes worth about $5.54 a day: a pull request that shortens 2 sections and removes 1 (Recent activity has its link)');
  assert.equal(maintenanceNotice(q.store), '');
  const off = repo({ upkeep: false });
  assert.deepEqual(await upkeepCheck(off.store), { skipped: 'off' });
  const v = upkeepView(off.store);
  assert.equal(v.level, 'off'); assert.equal(v.summary, 'Thinker is not looking after this repository.');
});
