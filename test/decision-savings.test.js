// Which decisions count toward the savings, and where a section's stops once its text is edited
// (src/decision-savings.js): the half of the `decisions` series that reads the history and git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { decisionsOf, sectionEnds, ancestry, decisionInputs, machineDecisions } from '../src/decision-savings.js';
import { DECISION_DAYS } from '../src/report-savings.js';
import { Store, repoId } from '../src/store.js';
import { sections } from '../src/instruction-value.js';

const DAY = 86400_000;
const tmp = t => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-decisions-'))); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const body = n => Array.from({ length: n }, (_, i) => `- rule ${i} that says a thing worth forty characters.`).join('\n');
const doc = parts => Object.entries(parts).map(([title, text]) => `## ${title}\n\n${text}\n`).join('\n');

// A repository whose AGENTS.md is committed version by version, each commit dated a day after the last.
function repoOf(t, versions, { start = Date.parse('2026-10-01T00:00:00Z') } = {}) {
  const repo = tmp(t), g = (args, env = {}) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...env } }).trim();
  g(['init', '-q', '-b', 'main']);
  const commits = versions.map((parts, i) => {
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), doc(parts));
    const date = new Date(start + i * DAY).toISOString();
    g(['add', '-A']); g(['commit', '-q', '-m', `v${i}`], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    return { sha: g(['rev-parse', 'HEAD']), t: start + i * DAY };
  });
  return { repo, commits, git: g };
}
// a section's size as the edit records it: the heading and the body, four characters a token
const size = n => Math.ceil(sections(doc({ Build: body(n), Test: 'x' }))[0].text.length / 4);
const merged = (c, extra = {}) => ({ id: 'e1', at: new Date(c.t - 3600_000).toISOString(), key: 'section:AGENTS.md:build', kind: 'section', file: 'AGENTS.md', act: 'compress', decision: 'pull request', saving: 100, job: { state: 'done' }, pr: { state: 'merged', at: new Date(c.t).toISOString(), mergeCommit: c.sha }, ...extra });

test('what counts: a merged change of the root file and a machine-wide switch off, each for a month at most', t => {
  const { repo, commits } = repoOf(t, [{ Build: body(40), Test: body(5) }, { Build: body(10), Test: body(5) }]);
  const store = new Store(repo).init(), c = commits[1], now = c.t + 100 * DAY, at = new Date(c.t).toISOString();
  const tokens = { before: size(40), after: size(10) };
  const of = history => decisionsOf(store, { now, history });
  const [d] = of([merged(c, { tokens })]);
  assert.equal(d.tokens, size(40) - size(10));
  assert.equal(d.origin, repoId(repo)); assert.equal(d.commit, c.sha); assert.equal(d.section, 'build');
  assert.equal(d.from, c.t); assert.equal(d.to, c.t + DECISION_DAYS * DAY, 'the horizon, however long ago');
  assert.deepEqual(d.notClients, [], 'no CLAUDE.md of its own: every agent reads AGENTS.md');
  // what does not: no merge commit to ask a checkout about, a working-tree write, a pull request still open, a
  // dismissal, a file below the root, an edit that recorded no sizes or took nothing out
  for (const not of [{ pr: { state: 'merged', at } }, { pr: undefined, decision: 'approved' }, { pr: { state: 'open' } }, { decision: 'dismissed' },
    { file: 'docs/AGENTS.md', key: 'section:docs/AGENTS.md:build' }, { tokens: undefined }, { tokens: { before: 10, after: 10 } }]) {
    assert.equal(of([merged(c, { tokens, ...not })]).length, 0, JSON.stringify(not));
  }
  // a revert ends a merged change, and a later decision on the same section takes over from its own merge
  assert.equal(of([merged(c, { tokens, revertedAt: new Date(c.t + 2 * DAY).toISOString() })])[0].to, c.t + 2 * DAY);
  const again = merged({ sha: 'f'.repeat(40), t: c.t + 5 * DAY }, { id: 'e2', tokens: { before: 90, after: 40 } });
  assert.equal(of([again, merged(c, { tokens })]).find(x => x.id === 'e1').to, c.t + 5 * DAY);
  // switches: machine-wide and off counts, for its own agent everywhere; a checkout's own, one turned back on, and a
  // tool's output (the clearing's tokens) do not
  const sw = { id: 's1', at, key: 'claude:tool:Artifact', kind: 'tool', act: 'off', decision: 'approved', saving: 2500, scope: 'machine' };
  assert.deepEqual(of([sw]).map(x => [x.origin, x.tokens, x.onlyClients, x.commit]), [[null, 2500, ['claude'], undefined]]);
  for (const not of [{ scope: undefined }, { act: 'on' }, { saving: 0 }, { kind: 'output', key: 'output:Bash:sed', act: 'compress' }]) assert.equal(of([{ ...sw, ...not }]).length, 0, JSON.stringify(not));
  // a CLAUDE.md with text of its own is what Claude Code reads instead
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# other\n');
  assert.deepEqual(of([merged(c, { tokens })])[0].notClients, ['claude']);
});

test('an edited saving is no saving: watched by the lines, so a rename or an addition changes nothing', t => {
  const kept = body(10), extra = '- a paragraph somebody added beside the compressed lines.';
  const { repo, commits } = repoOf(t, [
    { Build: body(40), Test: body(5) },                       // before
    { Build: kept, Test: body(5) },                           // the decision merges: 40 -> 10
    { Build: kept, Test: body(9) },                           // another section changes
    { Build: `${kept}\n${extra}`, Test: body(9) },            // a paragraph added beside them
    { 'Building it': `${kept}\n${extra}`, Test: body(9) },    // renamed
    { Test: body(9), 'Building it': `${extra}\n${kept}` },    // moved
    { Test: body(9), 'Building it': `${extra}\n${kept.replace('rule 9 that', 'rule 9, which')}` }, // one line edited (rule 9: the other section has no such line)
    { Test: body(9), 'Building it': kept },
  ]);
  const store = new Store(repo).init(), c = commits[1], now = commits[7].t + DAY, dir = tmp(t);
  const [d] = decisionsOf(store, { now, history: [merged(c, { tokens: { before: size(40), after: size(10) } })] });
  const [x] = sectionEnds([d], dir, { now });
  assert.equal(x.from, c.t); assert.equal(x.to, commits[6].t, 'through the addition, the rename and the move, to the edit');
  assert.equal(x.tokens, d.tokens, 'the edit\'s own figure while it stands');
  // kept: answered again without git, and an ended decision is never looked at again
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'decision-sections.json'), 'utf8')).e1.end, commits[6].t);
  assert.equal(sectionEnds([{ ...d, repo: '/nowhere' }], dir, { now })[0].to, commits[6].t);
  // an edit after the decision's own end is not its business
  assert.equal(sectionEnds([{ ...d, id: 'e7', to: commits[5].t }], tmp(t), { now })[0].to, commits[5].t);
  // a removal ends when a line it took out is back, under whatever heading
  const gone = repoOf(t, [{ Build: body(40), Test: body(5) }, { Test: body(5) }, { Test: body(5), Notes: '- a note of its own, nothing the section ever said.' }, { Test: body(5), Notes: '- rule 7 that says a thing worth forty characters.' }]);
  const gs = new Store(gone.repo).init(), gc = gone.commits[1];
  const [r] = decisionsOf(gs, { now, history: [merged(gc, { act: 'remove', tokens: { before: size(40), after: 0 } })] });
  assert.deepEqual(sectionEnds([r], tmp(t), { now }).map(y => [y.from, y.to, y.tokens]), [[gc.t, gone.commits[3].t, size(40)]]);
  // an edit git cannot show, and one that left nothing to watch: not counted
  assert.deepEqual(sectionEnds([{ ...d, id: 'e9', repo: '/nowhere' }], tmp(t), { now }), []);
  assert.deepEqual(sectionEnds([{ ...d, id: 'e8', section: 'no-such-section' }], tmp(t), { now }), []);
  // a switch passes through untouched
  const sw = { id: 's', kind: 'tool', origin: null, from: 1, to: 2, tokens: 5 };
  assert.deepEqual(sectionEnds([sw], tmp(t), { now }), [sw]);
});

test('a checkout holds a change when its head contains the merge: asked of git once a head, and kept', t => {
  const { repo, commits, git } = repoOf(t, [{ Build: body(4) }, { Build: body(3) }, { Build: body(2) }, { Build: body(1) }]);
  const dir = tmp(t), ds = [{ commit: commits[1].sha, repo }, { commit: commits[2].sha, repo }];
  const has = ancestry(dir, ds);
  assert.equal(has(ds[0], commits[3].sha), true);
  assert.equal(has(ds[0], commits[1].sha), true, 'the merge itself');
  assert.equal(has(ds[0], commits[0].sha), false, 'a worktree branched before it');
  assert.equal(has(ds[1], commits[1].sha), false);
  assert.equal(has(ds[0], 'e'.repeat(40)), null, 'a head git does not know');
  assert.equal(has(ds[0], 'not a sha'), null);
  // a side branch off the first commit never got it
  git(['checkout', '-q', '-b', 'side', commits[0].sha]); fs.writeFileSync(path.join(repo, 'x'), 'x'); git(['add', '-A']); git(['commit', '-q', '-m', 'side']);
  assert.equal(has(ds[0], git(['rev-parse', 'HEAD'])), false);
  has.save();
  // answered from the file alone: the other commit of the batch too, and nothing unknown was kept
  const again = ancestry(dir, []);
  assert.equal(again({ commit: commits[2].sha, repo: '/nowhere' }, commits[3].sha), true);
  assert.equal(again({ commit: commits[1].sha, repo: '/nowhere' }, commits[0].sha), false);
  assert.equal(again({ commit: commits[1].sha, repo: '/nowhere' }, 'e'.repeat(40)), null);
});

test('the machine: each decision once, from every checkout the log names', t => {
  const { repo, commits } = repoOf(t, [{ Build: body(40) }, { Build: body(10) }]);
  const store = new Store(repo).init(), c = commits[1], now = c.t + DAY;
  fs.mkdirSync(path.join(store.dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(store.dir, 'state', 'context-suggest.json'), JSON.stringify({ history: [merged(c, { tokens: { before: size(40), after: size(10) } })] }));
  const events = [{ repo }, { repo }, { repo: path.join(repo, 'gone') }, {}];
  const ds = machineDecisions(events, { now });
  assert.deepEqual(ds.map(d => d.id), ['e1']);
  const { decisions, has } = decisionInputs(ds, tmp(t), { now });
  assert.equal(decisions.length, 1); assert.equal(has(decisions[0], c.sha), true);
});
