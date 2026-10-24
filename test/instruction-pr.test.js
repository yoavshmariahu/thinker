// A previewed section change made a pull request (instruction-pr.js): the commit on a branch of its own from the default
// branch, pushed to the origin, the checkout untouched; GitHub stands in through a fake gh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.js';
import { previewEdit, editRecord } from '../src/instruction-edit.js';
import { openEditPr, textOnBase, prState, closePr, prAvailable, defaultBranch } from '../src/instruction-pr.js';

const tmp = p => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const AGENTS = '# A\n\n## Releases\n\nlong text about releases\nand more of it\n\n## Ports\n\nreserve a port first\n\n## Tests\n\nnpm test\n';
// a checkout with AGENTS.md committed on main and a bare origin it is pushed to
function checkout() {
  const r = tmp('thinker-ipr-'), origin = tmp('thinker-ipr-origin-');
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  git(r, 'init', '-q', '-b', 'main');
  git(r, 'config', 'user.email', 't@t'); git(r, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(r, 'AGENTS.md'), AGENTS);
  git(r, 'add', '.'); git(r, 'commit', '-q', '-m', 'start');
  git(r, 'remote', 'add', 'origin', origin); git(r, 'push', '-q', '-u', 'origin', 'main'); git(r, 'remote', 'set-head', 'origin', 'main');
  const store = new Store(r); store.init();
  return { store, r, origin };
}
// gh as the tests see it: every call kept, a pull request address answered
const fakeGh = (over = {}) => { const calls = []; return { calls, run: (args) => { calls.push(args); if (args[0] === 'pr' && args[1] === 'create') return 'Creating pull request\nhttps://github.com/o/r/pull/12\n'; if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify(over.view || { state: 'OPEN', url: 'https://github.com/o/r/pull/12' }); if (args[0] === 'pr' && args[1] === 'close') return ''; return ''; } }; };
const short = () => ({ text: '## Releases\n\n- short' });

test('openEditPr: the previewed change is one commit on a new branch from origin/main, pushed, and a pull request; the checkout is untouched', async () => {
  const { store, r, origin } = checkout();
  // the working tree is on another branch with an unrelated uncommitted file: neither reaches the pull request
  git(r, 'checkout', '-q', '-b', 'feature'); fs.writeFileSync(path.join(r, 'scratch.txt'), 'x');
  const p = await previewEdit(store, 'releases', 'compress', { completeFn: short });
  assert.equal(p.error, undefined);
  assert.deepEqual(editRecord(store, 'releases').files[0].edits.map(e => e.title), ['Releases']);
  const gh = fakeGh();
  const pr = await openEditPr(store, 'releases', { gh, slug: 'o/r', changes: [{ saving: 1200, total: 36_000, days: 30 }], now: Date.parse('2026-10-24T10:00:00Z') });
  assert.equal(pr.error, undefined, pr.error);
  assert.equal(pr.number, 12); assert.equal(pr.url, 'https://github.com/o/r/pull/12'); assert.equal(pr.base, 'main');
  assert.match(pr.branch, /^thinker\/context-20261024-[0-9a-f]{6}$/);
  assert.equal(pr.title, 'AGENTS.md: compress Releases');
  // the pull request's branch is on the origin with the one commit on top of main
  assert.equal(git(origin, 'rev-parse', pr.branch), pr.commit);
  assert.equal(git(origin, 'rev-parse', `${pr.branch}^`), git(origin, 'rev-parse', 'main'));
  assert.equal(git(origin, 'show', `${pr.branch}:AGENTS.md`), '# A\n\n## Releases\n\n- short\n\n## Ports\n\nreserve a port first\n\n## Tests\n\nnpm test');
  assert.deepEqual(git(origin, 'diff', '--name-only', 'main', pr.branch).split('\n'), ['AGENTS.md']);
  // the commit's message carries what the pull request says
  assert.match(git(origin, 'log', '-1', '--format=%B', pr.branch), /Saves ~1\.2k input tokens a session, ~36k over the 30 days/);
  // gh was asked for exactly this pull request
  const create = gh.calls.find(a => a[1] === 'create');
  assert.deepEqual(create.slice(0, 8), ['pr', 'create', '--repo', 'o/r', '--head', pr.branch, '--base', 'main']);
  assert.match(create[create.indexOf('--body') + 1], /\| Releases \| ~\d+ → ~\d+ \|/);
  assert.match(create[create.indexOf('--body') + 1], /Closing it without merging leaves the file as it is/);
  // nothing here moved: the branch, the file, the uncommitted file, the index
  assert.equal(git(r, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature');
  assert.equal(fs.readFileSync(path.join(r, 'AGENTS.md'), 'utf8'), AGENTS);
  assert.equal(git(r, 'status', '--porcelain'), '?? scratch.txt');
  assert.equal(editRecord(store, 'releases'), null, 'the preview is spent');
  assert.match((await openEditPr(store, 'releases', { gh, slug: 'o/r' })).error, /preview the change first/);
});

test('openEditPr: a file that differs on main from the working tree gets the section replacement applied to main\'s text; a section not on main is refused', async () => {
  const { store, r, origin } = checkout();
  // an uncommitted line in another section of the working tree
  fs.writeFileSync(path.join(r, 'AGENTS.md'), AGENTS.replace('npm test\n', 'npm test\nnot committed\n'));
  const p = await previewEdit(store, 'ports', 'remove');
  const gh = fakeGh();
  const pr = await openEditPr(store, 'ports', { gh, slug: 'o/r' });
  assert.equal(pr.error, undefined, pr.error);
  assert.equal(git(origin, 'show', `${pr.branch}:AGENTS.md`), '# A\n\n## Releases\n\nlong text about releases\nand more of it\n\n## Tests\n\nnpm test', 'main\'s text less the section, without the uncommitted line');
  // a section whose text is not on main: refused, and no branch is made
  fs.writeFileSync(path.join(r, 'AGENTS.md'), AGENTS.replace('reserve a port first', 'changed here'));
  await previewEdit(store, 'ports', 'remove');
  const bad = await openEditPr(store, 'ports', { gh, slug: 'o/r' });
  assert.match(bad.error, /AGENTS\.md differs on the base branch around "Ports"/);
  assert.equal(git(origin, 'branch', '--list', 'thinker/*').trim().split('\n').filter(Boolean).length, 1, 'only the first branch');
  assert.ok(editRecord(store, 'ports'), 'the preview is kept for the working-tree write');
});

test('textOnBase: the preview\'s text where the base is what it was made from, else each replacement, once', () => {
  const from = s => ({ from: createHash('sha256').update(s).digest('hex').slice(0, 16), text: 'NEW', edits: [{ title: 'B', old: '## B\n\nb', next: '## B\n\n- b' }] });
  assert.deepEqual(textOnBase('# A\n\n## B\n\nb\n', from('# A\n\n## B\n\nb\n')), { text: 'NEW' });
  assert.deepEqual(textOnBase('# A\n\n## B\n\nb\n\n## C\n\nc\n', from('other')), { text: '# A\n\n## B\n\n- b\n\n## C\n\nc\n' });
  assert.deepEqual(textOnBase('# A\n\n## B\n\nb\n\n## C\n\nc\n', { ...from('other'), edits: [{ title: 'B', old: '## B\n\nb', next: '' }] }), { text: '# A\n\n## C\n\nc\n' }, 'removed');
  assert.match(textOnBase('# A\n\n## B\n\nb\n\n## B\n\nb\n', from('other')).error, /around "B"/, 'found twice');
  assert.match(textOnBase(null, from('other')).error, /not on the base branch/);
  assert.match(textOnBase('x', { from: 'abc', text: 'y', edits: null }).error, /differs on the base branch/, 'a whole-file preview with no replacements');
});

test('prState and closePr through gh; prAvailable names why not', () => {
  const { store, r } = checkout();
  assert.deepEqual(prState(r, 12, { gh: fakeGh({ view: { state: 'MERGED', mergedAt: '2026-10-24T12:00:00Z', url: 'u' } }), slug: 'o/r' }), { state: 'merged', at: '2026-10-24T12:00:00Z', url: 'u' });
  assert.deepEqual(prState(r, 12, { gh: fakeGh({ view: { state: 'CLOSED', closedAt: '2026-10-24T13:00:00Z', url: 'u' } }), slug: 'o/r' }), { state: 'closed', at: '2026-10-24T13:00:00Z', url: 'u' });
  assert.equal(prState(r, 12, { gh: fakeGh(), slug: 'o/r' }).state, 'open');
  assert.equal(prState(r, 12, { gh: { run: () => { throw new Error('no network'); } }, slug: 'o/r' }), null, 'unknown keeps the state');
  const gh = fakeGh();
  git(r, 'branch', 'thinker/context-x');
  assert.deepEqual(closePr(r, 12, { gh, slug: 'o/r', branch: 'thinker/context-x' }), { ok: true });
  assert.deepEqual(gh.calls[0].slice(0, 6), ['pr', 'close', '12', '--repo', 'o/r', '--delete-branch']);
  assert.equal(git(r, 'branch', '--list', 'thinker/context-x'), '', 'the local branch is gone too');
  assert.equal(defaultBranch(r), 'main');
  // this checkout's origin is a directory, not GitHub
  assert.match(prAvailable(r, { gh }).reason, /not on GitHub/);
  void store;
});
