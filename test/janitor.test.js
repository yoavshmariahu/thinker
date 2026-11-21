// The janitor (janitor.js, janitor-sweep.js): what the coding agents left behind, kept as an inbox, and what was
// done about it. Git here is real, in scratch repositories; no model and no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { appendDelivery } from '../src/delivery-journal.js';
import { findMess, sweep, unsweep, listWorktrees } from '../src/janitor-sweep.js';
import { janitorRound, janitorInbox, janitorDo, janitorDismiss, janitorUndo, janitorView, janitorFeed, mergeJanitorViews, renderJanitor, janitorConfig, readJanitor, JANITOR } from '../src/janitor.js';
import { changeHistory, VIA } from '../src/context-suggest.js';
import { maintain, renderMaintain } from '../src/maintain.js';
import { spendMetrics } from '../src/telemetry.js';

const DAY = 86_400_000;
const env = { THINKER_LOG: 'local', THINKER_TELEMETRY: 'off' };
for (const [k, v] of Object.entries(env)) process.env[k] = v;

// A repository with a default branch and one commit; `git` runs in it (or in `cwd`), `commit` adds a file.
function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-janitor-')));
  const git = (args, cwd = dir) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q', '-b', 'main']);
  const commit = (file, cwd = dir, text = file) => { fs.writeFileSync(path.join(cwd, file), `${text}\n`); git(['add', '-A'], cwd); git(['commit', '-q', '-m', file], cwd); return git(['rev-parse', 'HEAD'], cwd); };
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.env\nruns/\n');
  commit('a.txt');
  return { dir, git, commit, store: new Store(dir).init() };
}
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
  // between the round and the click: somebody wrote a file in one of them
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

// a kept Context report with one section and one tool worth changing (context-suggest.test.js's fixture)
const view = () => ({
  days: 7, sessions: 40, rate: { perToken: 5e-6 },
  instructions: { sessions: 40, sections: [{ id: 'releases', file: 'AGENTS.md', title: 'Releases', tokens: 2000, wasted: 30_000, wastedWindow: 4_000_000, waste: 'high', usedShare: 0.02, text: 'How to release.' }] },
  skills: [], outputs: { tools: [] },
  tools: [{ name: 'Workflow', kind: 'tool', group: 'builtin', client: 'claude', key: 'builtin:Workflow', label: 'Workflow tool', used: 0, loaded: 40, tokens: 3000, wasted: 20_000, wastedWindow: 1_000_000, waste: 'high' }],
});
const spawned = () => { const calls = []; return { calls, spawn: (cmd, args) => { calls.push(args); return { pid: process.pid, on() {}, unref() {} }; } }; };

test('a round keeps an inbox: a sweep to do, a section as a pull request, a tool to switch, each with one action', async () => {
  const r = repo();
  const done = tree(r, 'done'); r.commit('done.txt', done); mergeIn(r, 'agent/done');
  r.git(['branch', 'left-over', 'main']);
  const fns = { view, prAvailable: () => ({ ok: true }), findMess: s => findMess(s, { now: LATER(), cwds: [], sizeOf: () => 3 * 1024 * 1024 }) };
  const round = await janitorRound(r.store, { fns });
  assert.equal(round.found, 3); assert.deepEqual(round.did, [], 'nothing is done by itself unless the person has let it');
  const { items, lastRound } = janitorInbox(r.store);
  assert.ok(lastRound);
  assert.deepEqual(items.map(i => [i.n, i.kind, i.chore]), [[1, 'pr', 'context'], [2, 'do', 'sweep'], [3, 'do', 'context']]);
  const [section, mess, tool] = items;
  assert.equal(section.title, 'AGENTS.md · Releases');
  assert.equal(section.action.label, 'Put up a PR to shorten it');
  assert.match(section.detail, /^Needed in 2% of prompts; ~2k tokens in every model call\. About \$20\.0 went on it unused over the last 7 days\.$/);
  assert.equal(mess.title, '1 merged worktree and 1 branch left behind · 3.0 GB');
  assert.deepEqual(mess.lines, ['done · worktree on agent/done · on main · 3.0 GB', 'left-over · branch · on main']);
  assert.equal(tool.action.label, 'Create tool reference');
  // only what can be put back or is a proposal may ever be done without the person
  assert.deepEqual(items.map(i => Boolean(i.auto)), [true, true, false]);
  const v = janitorView(r.store);
  assert.equal(v.mood, '3 things for you.'); assert.equal(v.attention, 3);
  const text = renderJanitor(v).join('\n');
  assert.match(text, /🧹 The janitor · last round just now/);
  assert.match(text, /thinker janitor do 2 {3}\(Sweep them\) {3}· {3}thinker janitor leave 2/);
});

test('doing, leaving and taking back: the sweep is undone from the feed, a context change is kept where Recent activity reads it', async () => {
  const r = repo();
  const done = tree(r, 'done'); r.commit('done.txt', done); mergeIn(r, 'agent/done');
  const sp = spawned();
  const fns = { view, prAvailable: () => ({ ok: true }), spawn: sp.spawn, findMess: s => findMess(s, { now: LATER(), cwds: [], sizeOf: () => 2048 }), sweep: (s, m) => sweep(s, m, { now: LATER(), cwds: [] }) };
  await janitorRound(r.store, { fns });
  // the section: a job in the background that ends as a pull request, by the door `janitor`
  const a = await janitorDo(r.store, 'change:section:AGENTS.md:releases', { fns, pr: true });
  assert.match(a.said, /Compressing 1 section in the background: a pull request opens/);
  assert.deepEqual(sp.calls[0].slice(1, 5), ['instructions', '--compress', 'releases', '--pr']);
  const h = changeHistory(r.store);
  assert.equal(h.length, 1); assert.equal(h[0].via, VIA.janitor); assert.equal(h[0].job.state, 'running');
  assert.deepEqual(janitorInbox(r.store).items.map(i => i.id), ['sweep', 'change:claude:builtin:Workflow'], 'a decided change leaves the inbox');
  // the sweep, by its number
  const s = await janitorDo(r.store, 1, { fns });
  assert.equal(s.said, 'Swept 1 worktree and 1 branch, 2 MB back');
  assert.ok(!fs.existsSync(done));
  // leaving the tool alone is a dismissal in the same history Find Savings reads, so it is not offered there either
  assert.match(janitorDismiss(r.store, 1, { fns }).said, /Workflow tool: left alone; it may come back in 7 days/);
  assert.equal(changeHistory(r.store).filter(e => e.decision === 'dismissed' && e.via === VIA.janitor).length, 1);
  assert.deepEqual(janitorInbox(r.store).items, []);
  assert.equal(janitorView(r.store).mood, 'All clean. Nothing needs you.');
  // the feed: the sweep with its undo, the job under way; a dismissal is not something that was done
  const feed = janitorFeed(r.store);
  assert.deepEqual(feed.map(f => [f.kind, f.by, Boolean(f.undo)]).sort(), [['change', 'janitor', false], ['did', 'you', true]]);
  assert.match(feed.find(f => f.kind === 'change').text, /^Working on it now: AGENTS\.md · Releases$/);
  const undo = feed.find(f => f.undo).undo;
  assert.equal(janitorUndo(r.store, undo).said, 'Put back 1 branch and 1 worktree');
  assert.ok(fs.existsSync(path.join(done, 'done.txt')));
  assert.equal(janitorUndo(r.store, undo).error, 'already taken back');
  // what leaves the machine about all this: counts by chore, and by whom (telemetry.js:spendMetrics); the section's
  // pull request is counted where every other door's is, under its own door
  const { actions } = spendMetrics(r.store, { all: false });
  assert.deepEqual(actions.janitor, { rounds: 1, roundsWithFinds: 1, autoRounds: 0, done: { context: 1, sweep: 1 }, doneOnItsOwn: 0, left: { context: 1 }, undone: 1 });
  assert.deepEqual(actions.dismissedBy, { janitor: 1 });
  assert.equal(janitorFeed(r.store).find(f => f.kind === 'did').undone, true);
  assert.match((await janitorDo(r.store, 9)).error, /nothing in the inbox is 9/);
});

test('auto: a round sweeps and puts up one pull request at a time by itself, and never switches a tool', async () => {
  const r = repo();
  fs.writeFileSync(path.join(r.store.dir, 'config.json'), JSON.stringify({ version: 1, janitor: { auto: true } }));
  assert.deepEqual(janitorConfig(r.store), { enabled: true, auto: true });
  const done = tree(r, 'done'); r.commit('done.txt', done); mergeIn(r, 'agent/done');
  const sp = spawned();
  const two = () => { const v = view(); v.instructions.sections.push({ ...v.instructions.sections[0], id: 'ports', title: 'Ports', wastedWindow: 2_000_000 }); return v; };
  const fns = { view: two, prAvailable: () => ({ ok: true }), spawn: sp.spawn, findMess: s => findMess(s, { now: LATER(), cwds: [], sizeOf: () => 2048 }), sweep: (s, m) => sweep(s, m, { now: LATER(), cwds: [] }) };
  const round = await janitorRound(r.store, { fns });
  assert.deepEqual(round.did.map(d => d.id), ['change:section:AGENTS.md:releases', 'sweep']);
  assert.equal(sp.calls.length, 1, 'the second section waits until the first pull request is merged or closed');
  assert.ok(!fs.existsSync(done));
  assert.deepEqual(janitorInbox(r.store).items.map(i => i.id), ['change:section:AGENTS.md:ports', 'change:claude:builtin:Workflow']);
  assert.equal(janitorFeed(r.store).find(f => f.kind === 'did').by, 'janitor');
  assert.match(renderJanitor(janitorView(r.store)).join('\n'), /acting on its own \(auto\)[\s\S]*Swept 1 worktree and 1 branch, 2 MB back \(on its own\)/);
  // where no pull request can be opened, a section is never changed in the working tree without the person
  const q = repo();
  fs.writeFileSync(path.join(q.store.dir, 'config.json'), JSON.stringify({ version: 1, janitor: { auto: true } }));
  const none = await janitorRound(q.store, { fns: { view, prAvailable: () => ({ ok: false }), spawn: sp.spawn, findMess: () => ({ worktrees: [], branches: [], kept: [] }) } });
  assert.deepEqual(none.did, []);
  assert.equal(janitorInbox(q.store).items[0].action.label, 'Change the file to shorten it');
});

test('a rule sessions keep breaking is a note with what they did, counted over the verdicts of real sessions', async () => {
  const r = repo();
  fs.writeFileSync(path.join(r.dir, 'AGENTS.md'), '# Rules\n\n## Worktrees\nAlways work in a worktree.\n\n## Tests\nRun the tests.\n');
  const at = d => new Date(Date.now() - d * DAY).toISOString();
  const judged = (d, verdicts) => ({ judged: { at: at(d), verdicts } });
  const broke = text => ({ worktrees: { verdict: 'violated', evidence: text } });
  fs.mkdirSync(path.join(r.store.dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(r.store.dir, 'state', 'instruction-value.json'), JSON.stringify({ sessions: {
    s1: judged(1, broke('edited src/a.js in the main checkout')), s2: judged(2, broke('committed on main')), s3: judged(3, broke('no worktree was made')),
    s4: judged(4, { worktrees: { verdict: 'followed', evidence: 'git worktree add' }, tests: { verdict: 'violated', evidence: 'no test run' } }),
    old: judged(JANITOR.ruleDays + 5, broke('long ago')), gone: judged(1, { 'left-the-file': { verdict: 'violated', evidence: 'x' } }),
  } }));
  await janitorRound(r.store, { fns: { view: () => null, findMess: () => ({ worktrees: [], branches: [], kept: [] }) } });
  const { items } = janitorInbox(r.store);
  assert.equal(items.length, 1, 'broken once is not a pattern');
  assert.equal(items[0].title, 'Agents keep breaking a rule: AGENTS.md · Worktrees');
  assert.match(items[0].detail, /^Broken in 3 of the 4 sessions it came up in over the last 30 days\./);
  assert.deepEqual(items[0].lines, ['edited src/a.js in the main checkout', 'committed on main', 'no worktree was made']);
  assert.equal(items[0].action, null);
  // a note is read, not done: it does not count as needing the person, and Got it puts it away for a week
  const v = janitorView(r.store);
  assert.equal(v.attention, 0); assert.equal(v.mood, '1 heads-up.');
  assert.match((await janitorDo(r.store, 1)).error, /there is nothing to do about it from here/);
  janitorDismiss(r.store, 1);
  assert.deepEqual(janitorInbox(r.store).items, []);
  assert.equal(janitorInbox(r.store, { now: Date.now() + (JANITOR.dismissDays + 1) * DAY }).items.length, 1);
});

test('the feed says what the offline work did, a line a day, and all repositories read as one list', () => {
  const r = repo();
  const t = (d, h = 10) => { const x = new Date(Date.now() - d * DAY); x.setHours(h, 0, 0, 0); return x.toISOString(); };
  const log = [
    { t: t(1, 9), op: 'profile', observations: 2 }, { t: t(1, 15), op: 'profile', observations: 3 }, { t: t(2), op: 'profile', observations: 0 },
    { t: t(1, 16), op: 'profile-compile', changes: { kept: 9, added: 2, updated: 1, dropped: 1 } }, { t: t(3), op: 'profile-compile', changes: { kept: 9, added: 0, updated: 0, dropped: 0 } },
    { t: t(1, 11), op: 'maintain', pruned: 41 }, { t: t(2), op: 'maintain' }, { t: t(JANITOR.feedDays + 3), op: 'profile', observations: 9 },
  ];
  const feed = janitorFeed(r.store, { log });
  assert.deepEqual(feed.map(f => f.text), [
    'Tidied your profile: 2 lines added, 1 reworded, 1 dropped', 'Read 2 sessions and noted 5 things about how you work', 'Threw out 41 stale state files', 'Read 1 session; nothing new to note',
  ]);
  const a = { enabled: true, auto: false, lastRound: t(0, 8), items: [{ id: 'sweep', kind: 'do', found: t(1), title: 'a' }], feed: [{ at: t(1), text: 'x' }] };
  const b = { enabled: true, auto: false, lastRound: t(2), items: [{ id: 'rule:x', kind: 'note', found: t(0), title: 'b' }, { id: 'wait:pr:3', kind: 'wait', found: t(3), title: 'c' }], feed: [{ at: t(0), text: 'y' }] };
  const all = mergeJanitorViews([{ repo: 'one', name: 'One', view: a }, { repo: 'two', name: 'Two', view: b }]);
  assert.deepEqual(all.items.map(i => [i.n, i.title, i.repoName]), [[1, 'c', 'Two'], [2, 'a', 'One'], [3, 'b', 'Two']], 'what waits on the person first, a note last');
  assert.deepEqual(all.feed.map(f => f.text), ['y', 'x']);
  assert.equal(all.lastRound, t(2), 'the list is as old as its oldest round');
  assert.equal(all.attention, 2); assert.equal(all.mood, '2 things for you, 1 heads-up.');
  assert.equal(mergeJanitorViews([{ repo: 'one', name: 'One', view: a }, { repo: 'three', name: 'Three', view: { enabled: true, auto: false, lastRound: null, items: [], feed: [] } }]).lastRound, null, 'not been round everywhere yet');
  // a tool is switched for the whole machine: found in two repositories it is one item, the costliest, and the
  // decision about it one line of the feed, not a line a repository
  const tool = (rank, detail) => ({ id: 'change:claude:builtin:Agent', kind: 'do', machine: true, rank, title: 'Agent tool', detail, found: t(1) });
  const said = { at: t(1), kind: 'change', text: 'x MCP server: Switched off', shared: 'abc' };
  const m = mergeJanitorViews([
    { repo: 'one', name: 'One', view: { ...a, items: [tool(100, 'small.'), { id: 'sweep', kind: 'do', rank: 0, found: t(1), title: 'a' }], feed: [said] } },
    { repo: 'two', name: 'Two', view: { ...b, items: [tool(900, 'big.')], feed: [said] } },
  ]);
  assert.deepEqual(m.items.map(i => [i.title, i.repoName, i.repo]), [['Agent tool', '2 repositories', 'two'], ['a', 'One', 'one']], 'the costliest first, acted on from the repository that showed it');
  assert.equal(m.items[0].detail, 'big. The figure is the costliest of the 2 repositories it is loaded in.');
  assert.deepEqual(m.feed.map(f => f.repoName), ['All repositories']);
});

test('maintenance sends the janitor round, and `janitor: false` stops it', async () => {
  const r = repo();
  const fns = { syncPrs: async () => ({ synced: 0 }), containers: () => null, contextSuggest: async () => null };
  const m = await maintain(r.store, r.dir, { fns });
  assert.equal(m.errors, 0); assert.equal(m.janitorFound, 0);
  assert.ok(readJanitor(r.store).lastRound, 'the round was kept');
  assert.match(renderMaintain({ janitorFound: 2, janitorDid: 1, errors: 0 }), /the janitor did 1 thing on its own, 2 in the janitor's inbox/);
  const off = repo();
  fs.writeFileSync(path.join(off.store.dir, 'config.json'), JSON.stringify({ version: 1, janitor: false }));
  assert.deepEqual(await janitorRound(off.store), { skipped: 'disabled' });
  const v = janitorView(off.store);
  assert.equal(v.enabled, false); assert.match(v.mood, /The janitor is off here/);
});
