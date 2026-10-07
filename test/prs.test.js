import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { minedPrs, recordMinedPrs, nextPrs, listMergedCommits, pickPrs } from '../src/prs.js';

const day = n => `2026-01-${String(n).padStart(2, '0')}T00:00:00Z`;
const ALL = Array.from({ length: 12 }, (_, i) => ({ number: i + 1, mergedAt: day(i + 1) }));
// stands in for the GitHub search: newest first, within the window, cut at the limit
const list = (slug, { before, after, limit }) => ALL.filter(p => p.mergedAt < before && (!after || p.mergedAt >= after)).reverse().slice(0, limit);
const store = () => new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-prs-'))).init();
const nums = prs => prs.map(p => p.number);

test('mined pull requests are recorded and not taken again', () => {
  const s = store();
  const first = nextPrs('o/r', minedPrs(s, 'o/r'), { limit: 3, now: day(11), list });
  assert.deepEqual(nums(first), [10, 9, 8]);
  recordMinedPrs(s, 'o/r', first);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.dir, 'prs.json'), 'utf8'))['o/r'], { mined: [8, 9, 10], latest: day(10), oldest: day(8) });

  // two were merged since; the rest of the limit goes further back
  const second = nextPrs('o/r', minedPrs(s, 'o/r'), { limit: 4, now: day(13), list });
  assert.deepEqual(nums(second), [12, 11, 7, 6]);
  recordMinedPrs(s, 'o/r', second);

  const third = nextPrs('o/r', minedPrs(s, 'o/r'), { limit: 20, now: day(13), list });
  assert.deepEqual(nums(third), [5, 4, 3, 2, 1]);
  recordMinedPrs(s, 'o/r', third);
  assert.deepEqual(nextPrs('o/r', minedPrs(s, 'o/r'), { limit: 20, now: day(13), list }), []);
  assert.equal(minedPrs(s, 'other/repo').mined.size, 0);
});

test('a cache built before the record existed: notes name the pull requests they came from', () => {
  const s = store();
  fs.writeFileSync(path.join(s.notesDir, 'a.json'), JSON.stringify({ id: 'a', kind: 'fix', title: 't', body: 'b', source: { type: 'pr', ref: 'o/r#12' } }));
  const rec = minedPrs(s, 'o/r');
  assert.ok(rec.mined.has(12));
  assert.deepEqual(nums(nextPrs('o/r', rec, { limit: 2, now: day(13), list })), [11, 10]);
});

function createMockPrRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-git-prs-')));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Thinker Test'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@thinker.dev'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  execFileSync('git', ['checkout', '-b', 'main', '-q'], { cwd: dir });

  // Initial commit on main
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test Repo\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'chore: initial commit', '-q'], { cwd: dir });

  // Feature 1 on branch, merged with merge commit
  execFileSync('git', ['checkout', '-b', 'feature-auth', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'auth.js'), 'export function verifyToken() { return true; }\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'feat(auth): implement token verification\n\nAdds JWT authentication guard to protect API routes.', '-q'], { cwd: dir });

  execFileSync('git', ['checkout', 'main', '-q'], { cwd: dir });
  execFileSync('git', ['merge', '--no-ff', 'feature-auth', '-m', 'Merge branch feature-auth (#101)', '-q'], { cwd: dir });

  // Feature 2: direct commit on main with PR number
  fs.writeFileSync(path.join(dir, 'db.js'), 'export function connectDb() { return null; }\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'fix(db): add retry logic to database connection (#102)\n\nPrevents connection timeouts on startup.', '-q'], { cwd: dir });

  return dir;
}

test('listMergedCommits extracts commits, merge titles, bodies, and numstats', () => {
  const dir = createMockPrRepo();
  try {
    const commits = listMergedCommits(dir);
    assert.ok(commits.length >= 3);

    // 1. Direct commit #102
    const c102 = commits.find(c => c.prNumber === 102);
    assert.ok(c102);
    assert.match(c102.title, /fix\(db\): add retry logic/);
    assert.match(c102.body, /Prevents connection timeouts on startup/);
    assert.ok(c102.additions >= 1);
    assert.deepEqual(c102.files, ['db.js']);
    assert.equal(c102.isGitCommit, true);
    assert.ok(c102.hash);

    // 2. Merge commit #101 should extract feature title from branch commit, not generic merge subject
    const c101 = commits.find(c => c.prNumber === 101);
    assert.ok(c101);
    assert.match(c101.title, /feat\(auth\): implement token verification/);
    assert.match(c101.body, /Adds JWT authentication guard/);
    assert.ok(c101.additions >= 1);
    assert.ok(c101.files.includes('auth.js'));

    // 3. Initial commit
    const initial = commits.find(c => c.title.includes('initial commit'));
    assert.ok(initial);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('nextPrs with listMergedCommits handles git history and tracks mined commits in local store', () => {
  const dir = createMockPrRepo();
  const s = store();
  try {
    const rec = minedPrs(s, 'local');
    const first = nextPrs('local', rec, { limit: 1, list: listMergedCommits, repo: dir });
    assert.equal(first.length, 1);
    assert.equal(first[0].prNumber, 102);

    recordMinedPrs(s, 'local', first);
    const updatedRec = minedPrs(s, 'local');
    assert.ok(updatedRec.mined.has(102));

    // Next query skips already mined commit
    const second = nextPrs('local', updatedRec, { limit: 1, list: listMergedCommits, repo: dir });
    assert.equal(second.length, 1);
    assert.equal(second[0].prNumber, 101);

    // Commit hashes can be tracked as note sources
    fs.writeFileSync(path.join(s.notesDir, 'h1.json'), JSON.stringify({
      id: 'h1', kind: 'convention', title: 't', body: 'b',
      source: { type: 'pr', ref: 'local#abc12345' },
    }));
    const recWithNote = minedPrs(s, 'local');
    assert.ok(recWithNote.mined.has('abc12345'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pickPrs takes fixes first, leaves a share for other changes, and never more than the limit', () => {
  const pr = (n, title, dir = 'a') => ({ number: n, title, body: '', mergedAt: `2026-09-${String(n).padStart(2, '0')}`, files: [`${dir}/x/${n}.py`] });
  const fixes = [pr(1, 'fix(a): null guard'), pr(2, 'fix(b): race in the worker', 'b'), pr(3, 'Correct the wrong total', 'c')];
  const feats = [pr(4, 'feat(a): new page'), pr(5, 'feat(b): export', 'b'), pr(6, 'perf: faster query', 'c')];
  const picked = pickPrs([...feats, ...fixes], 3);
  assert.equal(picked.length, 3);
  assert.ok(picked.slice(0, 2).every(p => /fix|correct/i.test(p.title)) && !/fix|correct/i.test(picked[2].title), 'fixes first, one slot for the rest');
  assert.deepEqual(pickPrs(fixes, 2).map(p => /fix|correct/i.test(p.title)), [true, true], 'only fixes: all slots are fixes');
  assert.deepEqual(pickPrs(feats, 2).length, 2);
  assert.equal(pickPrs([...feats, ...fixes], 10).length, 6);
  const many = [...Array.from({ length: 8 }, (_, i) => pr(10 + i, `fix: thing ${i}`)), pr(30, 'feat: one feature')];
  assert.equal(pickPrs(many, 6).length, 6, 'a lone non-fix does not leave fix slots idle');
  assert.equal(pickPrs(many, 6).filter(p => /^fix/.test(p.title)).length, 5);
});

test('partial PR failures override note-source inference until a later successful receipt', t => {
  const s = store(); t.after(() => fs.rmSync(s.repo, { recursive:true, force:true }));
  const pr = {number:123,mergedAt:day(5)};
  fs.writeFileSync(path.join(s.notesDir,'partial.json'),JSON.stringify({id:'partial',kind:'rule',title:'Partial',body:'Saved before a later failed check.',source:{type:'pr',ref:'o/r#123'}}));
  recordMinedPrs(s,'o/r',[],{failed:[pr]});
  assert.equal(minedPrs(s,'o/r').mined.has(123),false);
  recordMinedPrs(s,'o/r',[{number:124,mergedAt:day(6)}]);
  assert.equal(minedPrs(s,'o/r').mined.has(123),false,'other successes preserve the retry marker');
  recordMinedPrs(s,'o/r',[pr]);
  assert.equal(minedPrs(s,'o/r').mined.has(123),true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(s.notesDir),'prs.json')))['o/r'].retry,undefined);
});


test('retry markers also suppress numeric-looking commit hashes inferred from notes', t => {
  const s = store(); t.after(() => fs.rmSync(s.repo, {recursive:true,force:true}));
  const pr = {number:1,hash:'12345678abcdef',mergedAt:day(5)};
  fs.writeFileSync(path.join(s.notesDir,'partial.json'),JSON.stringify({id:'partial',kind:'rule',title:'Partial',body:'Partial',source:{type:'pr',ref:'local#12345678'}}));
  recordMinedPrs(s,'local',[],{failed:[pr]});
  assert.equal(minedPrs(s,'local').mined.has(12345678),false);
  assert.equal(minedPrs(s,'local').mined.has('12345678'),false);
  recordMinedPrs(s,'local',[pr]);
  assert.equal(minedPrs(s,'local').mined.has('12345678'),true);
});
