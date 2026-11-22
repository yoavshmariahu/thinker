// Trimming the repository's instruction file: what each section costs against how often it bore on the work, the
// ranking that follows from it, and the change itself -- previewed, never written silently, opened as a pull request
// that leaves the checkout alone, followed to its fate, and undone without losing the person's own later edits.
import { tmp, git, repo } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.js';
import { sections, sectionId, sessionActivity, appliedTurns, instructionValue, use, RARE } from '../src/instruction-value.js';
import { deriveTriggers, sectionFires } from '../src/instruction-sections.js';
import { locate, previewEdit, applyEdit, editRecord } from '../src/instruction-edit.js';
import { baseTexts, openEditPr, textOnBase } from '../src/instruction-pr.js';
import { topChanges, currentChanges, decidedKeys, dismissChanges, approveChanges, startSectionJob, runSectionJob,
  retryJob, changeHistory, refreshPrStates, revertDecision, SUGGEST } from '../src/context-suggest.js';

const AT = '2026-10-01T00:00:00Z';          // when the instruction file was committed
const T = Date.parse('2026-10-20T12:00:00Z');
const DAY = 86_400_000;
const ROOT = { kind: 'root', file: 'AGENTS.md' };
// a file whose sections name nothing: no trigger is derived from it, so nothing greps the repository
const AG = '# Scratch\n\n## Releases\n\nTag the release, then announce it. Never push to main directly.\n\n## Ports\n\nReserve a port from the tool before starting any server here.\n';
const SHORT = '## Releases\n\n- tag, announce, never push main';

const store = dir => { const s = new Store(dir); s.init(); return s; };
const read = dir => fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
const say = text => () => ({ text });                                   // a model that answers with `text`
const spy = () => { const calls = []; return { calls, spawnFn: (_e, args, opts) => { calls.push({ args, opts }); return { pid: process.pid, on() {}, unref() {} }; } }; };
const dead = () => ({ pid: null, on() {}, unref() {} });                // a job whose process never started
const gh = () => { const calls = []; return { calls, run(a) { calls.push(a); return a[1] === 'create' ? 'https://github.com/o/r/pull/12' : ''; } }; };
const editFns = () => ({ previewEdit: (s, ids, a, o) => previewEdit(s, ids, a, { ...o, completeFn: say(SHORT) }), applyEdit });
// the pull request side, with GitHub standing still: a base that is the working tree, one address, one fate
const prFns = (dir, state, commit) => ({
  baseTexts: () => ({ commit: 'base', branch: 'main', textOf: f => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return null; } } }),
  openEditPr: async () => ({ number: 7, url: 'https://x/pull/7', branch: 'b7', commit: 'c7', base: 'main', said: 'opened' }),
  prState: () => ({ state, at: '2026-10-21T00:00:00Z', url: 'https://x/pull/7', ...(commit ? { commit } : {}) }),
});
const change = id => ({ kind: 'section', key: `section:AGENTS.md:${id}`, id, file: 'AGENTS.md', title: `AGENTS.md · ${id}`,
  saving: 400, total: 12_000, days: 30, default: { act: 'compress', text: 'Compress' },
  options: [{ act: 'compress', text: 'Compress' }, { act: 'remove', text: 'Remove' }] });
const row = id => ({ id, file: 'AGENTS.md', title: id, tokens: 2000, prompts: 10, wasted: 400, wastedWindow: 4000, waste: 'high', usedShare: 0, text: '' });
const viewOf = (...rows) => ({ days: 30, instructions: { sessions: 10, sections: rows }, skills: [], tools: [], outputs: { tools: [] } });
// a session as thinker records one itself: prompt, tool calls, the agent's last word
const session = (id, rows, at) => ({ session: id, client: 'claude', mtime: at, file: (() => { const f = path.join(tmp('sess'), `${id}.jsonl`); fs.writeFileSync(f, rows.map(x => JSON.stringify(x)).join('\n') + '\n'); return f; })() });
const touches = file => [{ t: 'prompt', text: 'go' }, { t: 'tool', name: 'Edit', input: { file_path: file }, result: 'ok', turn: 1 }];

// --- what a section is, and when it bore on the work ---------------------------------------------------------

test('a section keeps its name when the text around it changes, and a section with subsections owns only its own prose', () => {
  const text = '# Title\n\nintro\n\n## Releases\n\ntag it\n\n## Ports\n\nreserve one\n\n### Reserving\n\nask the tool\n\n## Tests\n\nrun them\n';
  const ids = sections(text).map(s => sectionId(ROOT, s));
  assert.deepEqual(ids, ['releases', 'ports', 'ports-reserving', 'tests']);
  const ports = sections(text).find(s => s.title === 'Ports');
  assert.ok(!ports.text.includes('ask the tool'), 'the subsection is not part of it');
  assert.ok(ports.text.includes('reserve one'), 'its own prose is');
  const loc = locate(text, 'ports');
  assert.equal(loc.hasChildren, true);
  assert.ok(!loc.lines.slice(loc.start, loc.end).join('\n').includes('ask the tool'), 'and a change to it stops before the subsection');
  // the prose before it and a sibling's body are rewritten: every name is the same
  const moved = text.replace('intro', 'intro, at more length\n\nand then some').replace('tag it', 'tag it, then announce it');
  assert.deepEqual(sections(moved).map(s => sectionId(ROOT, s)), ids, 'the names survive the text around them');
});

test('a section is counted as used when the work does what it is about, and a turn counts once however many calls it made', () => {
  const dir = repo({ 'AGENTS.md': AG, 'src/app/main.py': 'def go():\n    pass\n' }, { at: AT });
  const prs = deriveTriggers(dir, { title: 'Pull requests', text: 'Open one for every change.' });
  const port = deriveTriggers(dir, { title: 'Ports', text: 'Reserve one, and keep `src/app/main.py` in step.' });
  for (const [what, triggers, call, want] of [
    ['a commit is what the pull-request section is about', prs, { command: 'git commit -m x' }, 'cmd'],
    ['so is opening one', prs, { command: 'gh pr create --fill' }, 'cmd'],
    ['listing a directory is not', prs, { command: 'ls -l' }, null],
    ['the section that names a file fires when that file is touched', port, { files: ['src/app/main.py'] }, 'path'],
    ['another file does not fire it', port, { files: ['src/app/other.py'] }, null],
  ]) assert.equal(sectionFires({ triggers }, call), want, what);
  const activity = sessionActivity(dir, [
    { t: 'tool', name: 'Read', input: { file_path: 'src/app/main.py' }, result: '', turn: 4 },
    { t: 'tool', name: 'Edit', input: { file_path: 'src/app/main.py' }, result: 'ok', turn: 4 },
    { t: 'tool', name: 'Read', input: { file_path: 'src/app/main.py' }, result: '', turn: 7 },
  ]);
  assert.deepEqual(appliedTurns([{ id: 'ports', triggered: true, triggers: port }], activity), { ports: 2 }, 'two turns, three calls');
});

// --- what it costs, and the ranking --------------------------------------------------------------------------

const MEASURED = {
  'AGENTS.md': `# Scratch\n\n## Pull requests\n\n${'Open a pull request for every change, and never push to main. '.repeat(16)}\n\n## Ports\n\nReserve a port before starting a server, as \`src/app/main.py\` does.\n`,
  'src/app/main.py': 'def go():\n    pass\n',
};

test('a section wastes what it costs in the prompts that did not need it, and the most wasteful is what thinker offers to change', () => {
  const dir = repo(MEASURED, { at: AT }), s = store(dir);
  // six sessions, every one of them editing the file the Ports section names, none of them committing
  const sessions = [1, 2, 3, 4, 5, 6].map(i => session(`s${i}`, touches('src/app/main.py'), T - i * DAY));
  const iv = instructionValue(s, { days: 30, sessions, prompts: sessions.length });
  const by = id => iv.sections.find(x => x.id === id);
  assert.equal(by('ports').usedShare, 1, 'the section about the file every session touched was needed in every prompt');
  assert.equal(by('ports').wasted, 0);
  assert.equal(by('pull-requests').usedShare, 0, 'the one about commits was needed in none');
  assert.equal(by('pull-requests').wasted, by('pull-requests').perPrompt, 'so it wastes its whole cost on a prompt');
  assert.equal(by('pull-requests').wastedWindow, by('pull-requests').window, 'and its whole cost over the window');
  assert.deepEqual(use({ sessions: 6, prompts: 10, appliedPrompts: 4, triggered: true }, 100, 1000),
    { usedShare: 0.4, usedBy: 'prompts', wasted: 60, wastedWindow: 600 }, 'the share not needed times the cost, both ways');
  const top = topChanges({ ...viewOf(), instructions: iv, sessions: 6 });
  assert.deepEqual(top.map(c => c.id), ['pull-requests'], 'only the wasteful one is offered');
  assert.equal(top[0].total, by('pull-requests').wastedWindow, "and what it is worth is the row's own figure");
});

test('a section changed lately is measured afresh, and is not offered until enough sessions have read it since', () => {
  const dir = repo(MEASURED, { at: AT }), s = store(dir), file = path.join(dir, 'AGENTS.md');
  // the Ports section rewritten by hand, dated: its lines are new, the rest of the file is as old as the commit
  fs.writeFileSync(file, read(dir).replace('Reserve a port before', 'Reserve a port from the tool before'));
  const at = Date.parse('2026-10-10T00:00:00Z');
  fs.utimesSync(file, at / 1000, at / 1000);
  const before = [session('old', touches('src/app/main.py'), at - DAY)];
  const since = n => Array.from({ length: n }, (_, i) => session(`new${n}-${i}`, touches('src/app/main.py'), at + (i + 1) * 3600_000));
  const thin = instructionValue(s, { days: 30, sessions: [...before, ...since(RARE.minSessions - 3)], prompts: 10 });
  const ports = thin.sections.find(x => x.id === 'ports');
  assert.equal(ports.recent, true, 'it reads as a new section');
  assert.equal(ports.sessionsSince, RARE.minSessions - 3);
  assert.equal(ports.usedShare, null, 'too few sessions since the change to say whether it is needed');
  assert.equal(ports.waste, 'unknown');
  assert.equal(thin.sections.find(x => x.id === 'pull-requests').recent, false, 'the section nobody touched is not new');
  assert.ok(!topChanges({ ...viewOf(), instructions: thin, sessions: 4 }).some(c => c.id === 'ports'), 'and it is not offered');
  const enough = instructionValue(s, { days: 30, sessions: [...before, ...since(RARE.minSessions + 1)], prompts: 10 });
  const after = enough.sections.find(x => x.id === 'ports');
  assert.equal(after.sessionsSince, RARE.minSessions + 1);
  assert.equal(after.usedShare, 1, 'with enough sessions since the change it is measured again');
});

test('a change decided lately is not offered again, and a change whose job failed comes back', () => {
  const s = store(repo({ 'AGENTS.md': AG }, { at: AT }));
  const [left] = currentChanges(s, viewOf(row('releases')), { now: T });
  assert.equal(left.key, 'section:AGENTS.md:releases');
  dismissChanges(s, [left], { now: T });
  assert.equal(currentChanges(s, viewOf(row('releases')), { now: T + 1000 }).length, 0, 'left alone just now');
  assert.equal(currentChanges(s, viewOf(row('releases')), { now: T + (SUGGEST.dismissedDays + 1) * DAY }).length, 1, 'offered again once the dismissal runs out');
  const [started] = currentChanges(s, viewOf(row('ports')), { now: T });
  startSectionJob(s, [started], 'compress', { pr: false, spawnFn: dead, cliPath: '/cli.js', now: T });
  assert.equal(currentChanges(s, viewOf(row('ports')), { now: T + 60_000 }).length, 0, 'a change being made is not offered');
  assert.equal(currentChanges(s, viewOf(row('ports')), { now: T + 5 * 60_000 }).length, 1, 'a job that failed decided nothing');
});

// --- the change ----------------------------------------------------------------------------------------------

test('a preview writes nothing, and keeps what each section said and what it would say', async () => {
  const dir = repo({ 'AGENTS.md': AG }, { at: AT }), s = store(dir), before = read(dir);
  const p = await previewEdit(s, 'releases', 'compress', { completeFn: say(SHORT) });
  assert.equal(p.error, undefined);
  assert.equal(read(dir), before, 'the file in the working tree is as it was');
  assert.equal(git(dir, 'status', '--porcelain'), '', 'and git sees nothing to review');
  const kept = editRecord(s, p.key);
  assert.equal(kept.files.length, 1);
  const [one] = kept.files[0].edits;
  assert.ok(one.old.includes('announce it'), 'the section as it stands');
  assert.ok(one.next.includes('never push main'), 'and as it would stand');
  assert.ok(kept.files[0].text.includes('never push main'), 'with the whole file as it would be');
  assert.ok(p.tokensAfter < p.tokensBefore, 'shorter than it was');
});

test('a compress keeps the heading even when the model drops it, and a rewrite that is not shorter is asked for once more, not for ever', async () => {
  const s = store(repo({ 'AGENTS.md': AG }, { at: AT }));
  const asked = [];
  const stubborn = ({ prompt }) => { asked.push(prompt); return { text: `every rule kept and nothing dropped. ${'and more of it. '.repeat(30)}` }; };
  const p = await previewEdit(s, 'releases', 'compress', { completeFn: stubborn });
  assert.equal(p.error, undefined);
  assert.equal(asked.length, 2, 'asked again once, and then left alone');
  const next = editRecord(s, p.key).files[0].edits[0].next;
  assert.ok(next.startsWith('## Releases'), 'the heading the model left out is put back');
  assert.ok(next.includes('every rule kept'), 'with what the model wrote under it');
});

test('apply writes exactly what was previewed, and refuses a file that changed since', async () => {
  const dir = repo({ 'AGENTS.md': AG }, { at: AT }), s = store(dir);
  const p = await previewEdit(s, 'releases', 'compress', { completeFn: say(SHORT) });
  const planned = editRecord(s, p.key).files[0].text;
  const done = applyEdit(s, p.key);
  assert.equal(done.error, undefined);
  assert.equal(read(dir), planned, 'what was written is what was shown');
  const stale = await previewEdit(s, 'ports', 'remove', {});
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), `${read(dir)}\n## By hand\n\nsomething the person added\n`);
  const refused = applyEdit(s, stale.key);
  assert.match(refused.error, /changed since/);
  assert.equal(editRecord(s, stale.key), null, 'and the preview that no longer fits is gone');
  assert.ok(read(dir).includes('something the person added'), 'the hand edit stands');
});

test('opening a pull request leaves the checkout alone and carries the change made from the default branch', async () => {
  const dir = repo({ 'AGENTS.md': AG }, { at: AT, origin: true }), s = store(dir);
  const origin = git(dir, 'remote', 'get-url', 'origin');
  git(dir, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(dir, 'scratch.txt'), 'work in progress');
  const base = baseTexts(dir);
  assert.equal(base.branch, 'main');
  const p = await previewEdit(s, 'releases', 'compress', { completeFn: say(SHORT), texts: base.textOf, base });
  const cli = gh();
  const pr = await openEditPr(s, p.key, { gh: cli, slug: 'o/r', changes: [{ saving: 400, total: 12_000, days: 30 }], now: T });
  assert.equal(pr.error, undefined);
  assert.equal(pr.number, 12);
  assert.equal(pr.base, 'main');
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature', 'still on the branch the person was on');
  assert.equal(git(dir, 'status', '--porcelain'), '?? scratch.txt', 'their unfinished work untouched');
  assert.equal(read(dir), AG, 'and the file as it was here');
  assert.equal(git(origin, 'rev-parse', pr.branch), pr.commit, 'the branch is on the origin');
  assert.equal(git(origin, 'rev-parse', `${pr.branch}^`), git(origin, 'rev-parse', 'main'), 'one commit on top of the default branch');
  assert.ok(git(origin, 'show', `${pr.branch}:AGENTS.md`).includes('never push main'), 'holding the change');
  assert.deepEqual(git(origin, 'diff', '--name-only', 'main', pr.branch).split('\n'), ['AGENTS.md'], 'and nothing else');
  assert.equal(editRecord(s, p.key), null, 'the preview is spent');
});

test('a pull request is refused when the default branch no longer holds the section, or holds it twice', () => {
  const base = '# A\n\n## Ports\n\nreserve one\n\n## Tests\n\nrun them\n';
  const planned = { from: 'a-hash-of-another-text', text: 'unused here', edits: [{ title: 'Ports', old: '## Ports\n\nreserve one', next: '' }] };
  const fine = textOnBase(base, planned);
  assert.equal(fine.error, undefined, 'the section is there once: the change applies to what the branch holds');
  assert.ok(!fine.text.includes('reserve one'), 'and takes it out');
  assert.match(textOnBase(base.replace('## Ports', '## Harbours'), planned).error, /differs on the base/, 'the section is not there any more');
  assert.match(textOnBase(base + '## Ports\n\nreserve one\n', planned).error, /differs on the base/, 'the section is there twice');
  assert.match(textOnBase(null, planned).error, /not on the base/, 'the file is not there at all');
});

// --- the decision, its job, its fate and its undo ------------------------------------------------------------

test('approving a section records the decision before anything is made and hands it to one job, writing nothing itself', async () => {
  const dir = repo({ 'AGENTS.md': AG }, { at: AT }), s = store(dir), run = spy();
  await approveChanges(s, [change('releases')], { pr: true, spawnFn: run.spawnFn, cliPath: '/cli.js', now: T });
  const [entry] = changeHistory(s, { now: T });
  assert.equal(entry.decision, 'pull request');
  assert.equal(entry.running, true, 'written down as under way before the model is asked anything');
  assert.equal(entry.attention, 'running');
  assert.equal(run.calls.length, 1, 'one job');
  assert.ok(run.calls[0].args.includes('--pr') && run.calls[0].args.includes('--compress'));
  assert.equal(run.calls[0].opts.detached, true);
  assert.equal(read(dir), AG, 'approving wrote nothing');
  const plain = repo({ 'AGENTS.md': AG }, { at: AT }), other = spy();
  await approveChanges(store(plain), [change('releases')], { pr: false, spawnFn: other.spawnFn, cliPath: '/cli.js', now: T });
  assert.ok(other.calls[0].args.includes('--apply'), 'where no pull request can be opened the job writes the working tree for review');
  assert.equal(changeHistory(store(plain), { now: T })[0].decision, 'applied');
});

test('a job whose process died reads as failed once, with its reason, and a retry runs every section of it again', () => {
  const s = store(repo({ 'AGENTS.md': AG }, { at: AT }));
  startSectionJob(s, [change('releases'), change('ports')], 'compress', { pr: false, spawnFn: dead, cliPath: '/cli.js', now: T });
  assert.equal(changeHistory(s, { now: T + 60_000 }).filter(e => e.running).length, 2, 'still running while it may yet start');
  const failed = changeHistory(s, { now: T + 5 * 60_000 });
  assert.equal(failed.filter(e => e.failed && e.retryable).length, 2, 'both sections of the change failed');
  assert.ok(failed[0].job.error.length > 0, 'with a reason to show');
  const stamps = failed.map(e => e.job.finishedAt);
  assert.deepEqual(changeHistory(s, { now: T + 10 * 60_000 }).map(e => e.job.finishedAt), stamps, 'marked failed once, not again at every reading');
  const again = spy();
  const r = retryJob(s, failed[0].id, { now: T + 11 * 60_000, spawnFn: again.spawnFn, cliPath: '/cli.js' });
  assert.equal(r.error, undefined);
  const args = again.calls[0].args;
  assert.deepEqual(args[args.indexOf('--compress') + 1].split(',').sort(), ['ports', 'releases'], 'the same command, both sections');
  assert.equal(changeHistory(s, { now: T + 11 * 60_000 }).filter(e => e.running).length, 2);
});

test('a pull request is followed to its fate: merged is done, merged but not pulled says so, closed is offered again', async () => {
  const dir = repo({ 'AGENTS.md': AG }, { at: AT }), s = store(dir), edit = editFns();
  const open = async id => { const j = startSectionJob(s, [change(id)], 'compress', { pr: true, spawnFn: spy().spawnFn, cliPath: '/cli.js', now: T });
    return runSectionJob(s, { group: j.group, ids: [id], action: 'compress', pr: true }, { now: T, edit, prs: prFns(dir, 'open') }); };
  assert.equal((await open('releases')).error, undefined);
  const pending = changeHistory(s, { now: T })[0];
  assert.equal(pending.pending, true);
  assert.equal(pending.attention, 'pr');
  assert.equal(read(dir), AG, 'a change that became a pull request never touched the working tree');
  assert.equal(await refreshPrStates(s, { prs: prFns(dir, 'merged', 'the-merge'), force: true, now: T }), 1);
  const notPulled = changeHistory(s, { now: T, git: () => false })[0];
  assert.equal(notPulled.pending, false);
  assert.equal(notPulled.unpulled, true, 'merged, and this checkout does not have it yet');
  assert.equal(notPulled.pullFrom, 'main', 'which branch to pull');
  const pulled = changeHistory(s, { now: T, git: () => true })[0];
  assert.equal(pulled.unpulled, undefined);
  assert.ok(pulled.pr.pulledAt, 'once the merge is here it is done');
  await open('ports');
  await refreshPrStates(s, { prs: prFns(dir, 'closed'), force: true, now: T + 1000 });
  const rejected = changeHistory(s, { now: T + 1000 }).find(e => e.section === 'ports');
  assert.equal(rejected.rejected, true, 'closed without merging');
  assert.ok(!decidedKeys(s, { now: T + 1000 }).has('section:AGENTS.md:ports'), 'so the section is offered again');
});

test('an undo never discards what the person wrote afterwards, and a pull request still open is undone by closing it', async () => {
  const dir = repo({ 'AGENTS.md': AG }, { at: AT }), s = store(dir), edit = editFns(), file = path.join(dir, 'AGENTS.md');
  const written = startSectionJob(s, [change('releases')], 'compress', { pr: false, spawnFn: spy().spawnFn, cliPath: '/cli.js', now: T });
  await runSectionJob(s, { group: written.group, ids: ['releases'], action: 'compress', pr: false }, { now: T, edit });
  assert.ok(read(dir).includes('never push main'), 'the change is in the working tree');
  fs.writeFileSync(file, `${read(dir)}\n## By hand\n\na section the person added after\n`);
  const refused = await revertDecision(s, changeHistory(s, { now: T })[0].id, { now: T });
  assert.match(refused.error, /changed since/);
  assert.ok(read(dir).includes('a section the person added after'), 'their own work stands');
  const opened = startSectionJob(s, [change('ports')], 'compress', { pr: true, spawnFn: spy().spawnFn, cliPath: '/cli.js', now: T });
  await runSectionJob(s, { group: opened.group, ids: ['ports'], action: 'compress', pr: true }, { now: T, edit, prs: prFns(dir, 'open') });
  const closed = [];
  const taken = await revertDecision(s, changeHistory(s, { now: T }).find(e => e.section === 'ports').id,
    { now: T, prs: { closePr: (_r, n, opts) => { closed.push({ n, branch: opts.branch }); return { ok: true }; } } });
  assert.equal(taken.error, undefined);
  assert.deepEqual(closed, [{ n: 7, branch: 'b7' }], 'the pull request is closed and its branch deleted');
  const entry = changeHistory(s, { now: T }).find(e => e.section === 'ports');
  assert.equal(entry.pr.state, 'closed');
  assert.ok(entry.revertedAt);
  assert.equal(entry.revertible, false, 'nothing left to take back');
});
