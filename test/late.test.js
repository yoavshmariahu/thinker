import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { createNote, lateNotes, rememberTask, completenessNudge, orient, lookup, takeTurn } from '../src/ops.js';
import { rank } from '../src/rank.js';
import { execFileSync } from 'node:child_process';
process.env.THINKER_CE = 'off'; // these tests are about the lexical path; the cross-encoder (dense.js) has its own test

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-late-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/a.py'), 'def launch():\n    pass\n\ndef can_edit():\n    return True\n');
  fs.writeFileSync(path.join(dir, 'src/b.py'), 'def other():\n    pass\n');
  const store = new Store(dir).init();
  const inv = createNote(store, { title: 'Launch must check can_edit', kind: 'invariant', answers: ['launch eligibility'], body: 'src/a.py:launch must call src/a.py:can_edit first', deps: [{ path: 'src/a.py', symbol: 'launch' }] }).note;
  const cp = createNote(store, { title: 'Launch call path', kind: 'callpath', answers: ['how launch works'], body: 'src/a.py:launch is called from the API', deps: [{ path: 'src/a.py', symbol: 'launch' }] }).note;
  return { dir, store, inv, cp };
}

test('a turn collects what orient and the late hook served, and is emptied when taken', async () => {
  const { store, inv, cp } = setup();
  assert.deepEqual(takeTurn(store, 'u1'), []);
  const r = await orient(store, { task: 'how does launch work', session: 'u1', backgroundVerify: false });
  assert.ok(r.included.length);
  lateNotes(store, { session: 'u1', files: ['src/a.py'], edited: true });
  const ids = takeTurn(store, 'u1');
  assert.ok(ids.includes(inv.id) && ids.length === new Set(ids).size, 'each once, from both paths');
  assert.deepEqual(takeTurn(store, 'u1'), [], 'taken');
  assert.deepEqual(takeTurn(store, null), []);
  // servings without a session or usage recording are not a turn's
  await orient(store, { task: 'how does launch work', backgroundVerify: false });
  assert.deepEqual(takeTurn(store, 'u1'), []);
});

test('late notes on edit: rules only, when the file is edited and the rule bears on the request', () => {
  const { store, inv } = setup();
  const other = createNote(store, { title: 'Exports are written as CSV with a header row', kind: 'convention', answers: ['export format'], body: 'src/a.py:export writes CSV', deps: [{ path: 'src/a.py', symbol: 'export' }] }).note;
  assert.equal(lateNotes(store, { session: 'e1', files: ['src/a.py'] }).included.length, 0, 'a read serves nothing');
  // no request known: the rules on the file, and not the call path
  assert.deepEqual(lateNotes(store, { session: 'e1', files: ['src/a.py'], edited: true }).included.map(n => n.id).sort(), [inv.id, other.id].sort());
  rememberTask(store, 'e2', 'users can launch without the eligibility check');
  assert.deepEqual(lateNotes(store, { session: 'e2', files: ['src/a.py'], edited: true }).included.map(n => n.id), [inv.id]);
  assert.equal(lateNotes(store, { session: 'e2', files: ['src/a.py'], edited: true }).included.length, 0, 'once per session');
});

// The edit hook serves the rules resting on what the edits changed, not every rule on the file: a hub
// file carries many, and in the Click rerun of 2026-10-08 an edit to flag types brought a rule about
// help-option caching. A note about code is not served on an edit of its test alone.
test('late notes on edit: only the rules on definitions the edits changed; a test-only anchor of a note about code does not count', () => {
  const { dir, store, inv } = setup();
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests/test_a.py'), 'def test_launch():\n    assert True\n');
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, stdio: 'ignore' });
  git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'base');
  const edit = createNote(store, { title: 'can_edit decides who may launch', kind: 'rule', answers: ['who may launch'], body: 'src/a.py:can_edit is the only eligibility check', deps: [{ path: 'src/a.py', symbol: 'can_edit' }] }).note;
  const code = createNote(store, { title: 'launch is covered by test_launch', kind: 'rule', answers: ['launch test'], body: 'src/a.py:launch is checked by tests/test_a.py:test_launch', deps: [{ path: 'src/a.py', symbol: 'launch' }, { path: 'tests/test_a.py', symbol: 'test_launch' }] }).note;
  const onlyTests = createNote(store, { title: 'test_launch must stay a plain assert', kind: 'rule', answers: ['launch test style'], body: 'tests/test_a.py:test_launch uses a bare assert', deps: [{ path: 'tests/test_a.py', symbol: 'test_launch' }] }).note;
  // the agent changes can_edit only: the rules resting on it (the launch rule names it in its body),
  // not the rule that rests on launch alone
  fs.writeFileSync(path.join(dir, 'src/a.py'), 'def launch():\n    pass\n\ndef can_edit():\n    return False\n');
  assert.deepEqual(lateNotes(store, { session: 'p1', files: ['src/a.py'], edited: true }).included.map(n => n.id).sort(), [edit.id, inv.id].sort());
  // committed, then launch changes: the rules on launch, and no longer the one on can_edit
  git('commit', '-qam', 'can_edit');
  fs.writeFileSync(path.join(dir, 'src/a.py'), 'def launch():\n    return 1\n\ndef can_edit():\n    return False\n');
  assert.deepEqual(lateNotes(store, { session: 'p2', files: ['src/a.py'], edited: true }).included.map(n => n.id).sort(), [inv.id, code.id].sort());
  // an edit to the test file alone: the note about the tests, not the note about the code
  fs.writeFileSync(path.join(dir, 'tests/test_a.py'), 'def test_launch():\n    assert launch() == 1\n');
  assert.deepEqual(lateNotes(store, { session: 'p3', files: ['tests/test_a.py'], edited: true }).included.map(n => n.id), [onlyTests.id]);
});

test('late notes: the limit of a session holds', () => {
  const { dir, store } = setup();
  for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(dir, `src/w${i}.py`), 'def f():\n    pass\n');
  for (let i = 0; i < 6; i++) createNote(store, { title: `Rule ${i} about widgets number ${i}`, kind: 'gotcha', answers: [`widget rule ${i}`], body: `src/w${i}.py:f has a trap`, deps: [{ path: `src/w${i}.py` }] });
  let served = 0;
  for (let i = 0; i < 6; i++) served += lateNotes(store, { session: 'cap', files: [`src/w${i}.py`], edited: true }).included.length;
  assert.equal(served, 3);
});

test('completeness nudge: an unseen rule on an edited file, once', () => {
  const { store } = setup();
  const n = completenessNudge(store, { session: 's9', changed: ['src/a.py'] });
  assert.ok(n.text.includes('Launch must check can_edit'));
  assert.equal(completenessNudge(store, { session: 's9', changed: ['src/a.py'] }).text, '');
  assert.equal(completenessNudge(store, { session: 's10', changed: ['src/zzz.py'] }).text, '', 'no rule on the file: nothing');
});

test('orient with a caller budget: more notes, links add, the rest is listed; lookup takes an id', async () => {
  const { dir, store } = setup();
  fs.writeFileSync(path.join(dir, 'src/c.py'), 'def invite():\n    pass\n\ndef bulk():\n    pass\n\ndef toast():\n    pass\n\ndef modal():\n    pass\n');
  const mk = (title, kind, answers, symbol) => createNote(store, { title, kind, answers, body: `src/c.py:${symbol} handles it`, deps: [{ path: 'src/c.py', symbol }] }).note;
  mk('Existing member check on invite', 'invariant', ['where are invites to an existing member rejected'], 'invite');
  mk('Bulk invite is not atomic', 'gotcha', ['why does a bulk invite leave earlier rows saved'], 'bulk');
  mk('Invite errors surface as a toast', 'callpath', ['how does an invite error reach the toast'], 'toast');
  mk('Invite modal rows', 'location', ['where is the invite modal row rendered'], 'modal');
  const task = 'bulk invite with an existing member leaves earlier rows saved and shows an error toast in the invite modal';
  const two = await orient(store, { task, budget: 3000 });
  const many = await orient(store, { task, budget: 3000, maxNotes: 5 });
  assert.equal(two.included.length, 2);
  assert.ok(many.included.length > 2);
  // a linked note is added after the ranked hits; it does not take the place of one
  const ranked = (await orient(store, { task, budget: 3000, maxNotes: 5 })).included.map(n => n.id);
  const plain = (await orient(store, { task, budget: 3000, maxNotes: 5, links: false })).included.map(n => n.id);
  assert.deepEqual(ranked.slice(0, plain.length), plain);
  // what was not served is listed, and lookup returns a listed note by id
  assert.ok(two.more.length >= 1 && two.more.every(n => !two.included.some(i => i.id === n.id)));
  assert.deepEqual((await lookup(store, { query: two.more[0].id })).included.map(n => n.id), [two.more[0].id]);
});

test('orient with 2 slots preserves a strong second hit and only lets a link take a weak second slot', async () => {
  const { dir, store } = setup();
  fs.writeFileSync(path.join(dir, 'src/c.py'), 'def a(): pass\n');
  for (let i = 0; i < 6; i++) {
    createNote(store, { title: `Filler ${i}`, kind: 'location', answers: [`filler ${i}`], body: `src/c.py:a filler ${i}`, deps: [{ path: 'src/c.py' }] });
  }

  const n1 = createNote(store, {
    title: 'Text editor view mode state in TextNGPanel',
    kind: 'invariant',
    answers: ['where is editor view mode kept'],
    body: 'src/c.py:a keeps view mode state in TextNGPanel',
    deps: [{ path: 'src/c.py', symbol: 'a' }]
  }).note;

  const n2 = createNote(store, {
    title: 'Text panel defaults to split view on open',
    kind: 'convention',
    answers: ['default view mode for text panel'],
    body: 'src/c.py:a default is split view for all panels',
    deps: [{ path: 'src/c.py', symbol: 'a' }]
  }).note;

  const link = createNote(store, {
    title: 'Gate editor flags at render time',
    kind: 'gotcha',
    answers: ['how to gate editor feature flags'],
    body: 'src/c.py:a feature flags must be checked at render',
    deps: [{ path: 'src/c.py', symbol: 'a' }]
  }).note;

  n1.related = [link.id];
  store.put(n1);

  // Strong second hit (n2): both n1 and n2 are served; link does not evict n2
  const taskStrong = 'Text editor view mode should default to split view when opened';
  const rStrong = await orient(store, { task: taskStrong, maxNotes: 2 });
  assert.equal(rStrong.included.length, 2);
  assert.ok(rStrong.included.some(x => x.id === n1.id));
  assert.ok(rStrong.included.some(x => x.id === n2.id));
  assert.ok(!rStrong.included.some(x => x.id === link.id));

  // Weak second hit: link takes slot 2
  const link2 = createNote(store, {
    title: 'Text editor split mode layout',
    kind: 'gotcha',
    answers: ['how text editor split mode lays out'],
    body: 'src/c.py:a text editor view mode split layout rules',
    deps: [{ path: 'src/c.py', symbol: 'a' }]
  }).note;
  n1.related = [link2.id];
  store.put(n1);

  const taskWeak = 'Text editor view mode state in TextNGPanel';
  const rWeak = await orient(store, { task: taskWeak, maxNotes: 2 });
  assert.equal(rWeak.included.length, 2);
  assert.equal(rWeak.included[0].id, n1.id);
  assert.equal(rWeak.included[1].id, link2.id);
});

test('lookup caps query results to 3 notes by default and respects explicit maxNotes', async () => {
  const { dir, store } = setup();
  fs.writeFileSync(path.join(dir, 'src/c.py'), 'def a(): pass\n');
  for (let i = 0; i < 15; i++) {
    createNote(store, {
      title: `Filler note ${i}`,
      kind: 'location',
      answers: [`filler query ${i}`],
      body: `src/c.py:a filler detail ${i}`,
      deps: [{ path: 'src/c.py', symbol: 'a' }]
    });
  }
  const created = [];
  for (let i = 0; i < 6; i++) {
    created.push(createNote(store, {
      title: `View mode handler ${i}`,
      kind: 'location',
      answers: [`how does view mode handler ${i} work`],
      body: `src/c.py:a view mode detail ${i}`,
      deps: [{ path: 'src/c.py', symbol: 'a' }]
    }).note);
  }

  // Query search caps at 3 notes by default
  const defaultRes = await lookup(store, { query: 'view mode' });
  assert.equal(defaultRes.included.length, 3);

  // Query search with explicit maxNotes = 2
  const cappedRes = await lookup(store, { query: 'view mode', maxNotes: 2 });
  assert.equal(cappedRes.included.length, 2);

  // Lookup by specific note ID returns exactly that 1 note
  const byIdRes = await lookup(store, { query: created[0].id });
  assert.equal(byIdRes.included.length, 1);
  assert.equal(byIdRes.included[0].id, created[0].id);
});

test('phrasings of a note count on its question side', async () => {
  const { rank } = await import('../src/rank.js');
  const filler = Array.from({ length: 10 }, (_, i) => ({ id: 'f' + i, title: `Widget ${i} storage layout`, kind: 'location', answers: [`where widget ${i} is stored`], body: `widget ${i} rows are kept in table${i}`, deps: [{ path: `src/w${i}.py` }], confidence: 0.9, status: 'fresh' }));
  const note = { id: 'panel', title: 'setScenePanelOpen is not reset by duplicateInsight', kind: 'gotcha', answers: ['scene panel state after duplicate'], body: 'duplicateInsight redirects to the copy and leaves the actions sidebar open over the new chart', deps: [{ path: 'src/insightLogic.ts' }], confidence: 0.9, status: 'fresh' };
  const other = { id: 'chart', title: 'Chart legend is drawn after the series', kind: 'gotcha', answers: ['why is the chart legend open on a new chart'], body: 'the legend of a chart stays open over the series of the new chart until the sidebar is drawn', deps: [{ path: 'src/legend.ts' }], confidence: 0.9, status: 'fresh' };
  const request = 'After I copy a chart on my phone the actions sidebar stays open over the new chart and hides it';
  assert.equal(rank([note, other, ...filler], { query: request })[0].note.id, 'chart');
  const said = { ...note, says: ['The actions sidebar stays open after copying a chart', 'Side menu hides the new chart on a phone'] };
  assert.equal(rank([said, other, ...filler], { query: request })[0].note.id, 'panel');
});

test('a request of one content word is a turn of conversation, not a task: nothing is served on it', async () => {
  const { store, inv, cp } = setup();
  const st = createNote(store, { title: 'Note status lifecycle', kind: 'callpath', answers: ['how status changes', 'when is a note stale'], body: 'src/b.py:other sets the status', deps: [{ path: 'src/b.py', symbol: 'other' }] }).note;
  for (const task of ['status?', 'merged?', 'ok good. status?', 'yeah just run it', 'hi']) {
    assert.equal((await orient(store, { task, backgroundVerify: false, recordUsage: false })).included.length, 0, JSON.stringify(task));
  }
  // two content words are a question; a named note is still looked up; a note on the current file is still served
  assert.ok((await orient(store, { task: 'how does launch work', backgroundVerify: false, recordUsage: false })).included.some(n => n.id === cp.id));
  assert.ok((await orient(store, { task: 'status lifecycle', backgroundVerify: false, recordUsage: false })).included.some(n => n.id === st.id));
  assert.ok((await orient(store, { task: 'status?', file: 'src/a.py', backgroundVerify: false, recordUsage: false })).included.some(n => n.id === inv.id || n.id === cp.id));
  assert.ok(rank([st], { query: 'status', mode: 'lookup' }).length, 'lookup by one word is answered');
});

test('the prompt hook holds stale notes for the next batch and lists them for lookup', async () => {
  const { dir, store, cp } = setup();
  const file = path.join(dir, 'src/a.py');
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, original.replace('def launch():\n    pass', 'def launch():\n    return 1'));
  const hook = await orient(store, { task: 'how does launch work', session: 'f1', once: true, freshOnly: true, backgroundVerify: false });
  assert.equal(store.get(cp.id).status, 'stale', 'the edit made the note stale');
  assert.ok(!hook.included.some(n => n.id === cp.id), 'the stale note is not served');
  assert.deepEqual(hook.held.map(n => n.id), [cp.id], 'held back until scheduled maintenance');
  assert.ok(hook.more.some(n => n.id === cp.id), 'listed for lookup');
  assert.ok(!(store.get(cp.id).servedIn || []).includes('f1'), 'not counted as served');
  fs.writeFileSync(file, original);
  const later = await orient(store, { task: 'how does launch work', session: 'f1', once: true, freshOnly: true, backgroundVerify: false });
  assert.ok(later.included.some(n => n.id === cp.id), 'served once fresh again, in the same session');
  fs.writeFileSync(file, original.replace('def launch():\n    pass', 'def launch():\n    return 2'));
  assert.ok((await orient(store, { task: 'how does launch work', session: 'f1', backgroundVerify: false })).included.some(n => n.id === cp.id && n.status === 'stale'), 'the agent\'s own orient still gets it, with the banner');
  assert.ok((await lookup(store, { query: 'how launch works' })).included.some(n => n.id === cp.id), 'and so does lookup');
});

test('the prompt hook serves a note once per session; an explicit orient gets it again', async () => {
  const { store, cp } = setup();
  const first = await orient(store, { task: 'how does launch work', session: 'h1', once: true, backgroundVerify: false });
  assert.ok(first.included.some(n => n.id === cp.id));
  const again = await orient(store, { task: 'how does launch work', session: 'h1', once: true, backgroundVerify: false });
  assert.ok(!again.included.some(n => n.id === cp.id), 'already in the session\'s context');
  assert.ok(again.included.every(n => !first.included.includes(n)), 'what is served now is new to the session');
  let more = again; for (let i = 0; i < 3 && more.included.length; i++) more = await orient(store, { task: 'how does launch work', session: 'h1', once: true, backgroundVerify: false });
  assert.equal(more.included.length, 0, 'once every relevant note has been served, nothing is');
  assert.ok((await orient(store, { task: 'how does launch work', session: 'h2', once: true, backgroundVerify: false })).included.length, 'another session');
  assert.ok((await orient(store, { task: 'how does launch work', session: 'h1', backgroundVerify: false })).included.length, 'asked for by the agent');
});
