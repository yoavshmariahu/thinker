import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { createNote, lateNotes, rememberTask, completenessNudge, orient, lookup } from '../src/ops.js';

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

test('late notes on read: file-keyed, rules first, once per session', () => {
  const { dir, store, inv, cp } = setup();
  const r1 = lateNotes(store, { on: 'read', session: 's1', files: [path.join(dir, 'src/a.py')], perEvent: 1 });
  assert.deepEqual(r1.included.map(n => n.id), [inv.id]);
  const r2 = lateNotes(store, { on: 'read', session: 's1', files: ['src/a.py'], perEvent: 1 });
  assert.deepEqual(r2.included.map(n => n.id), [cp.id]);
  assert.equal(lateNotes(store, { on: 'read', session: 's1', files: ['src/a.py'] }).included.length, 0);
  assert.equal(lateNotes(store, { on: 'read', session: 's1', files: ['src/b.py'] }).included.length, 0);
  assert.equal(lateNotes(store, { on: 'read', session: 's2', files: ['src/a.py'] }).included.length, 2);
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

test('late notes: the limit of a session holds', () => {
  const { dir, store } = setup();
  for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(dir, `src/w${i}.py`), 'def f():\n    pass\n');
  for (let i = 0; i < 6; i++) createNote(store, { title: `Rule ${i} about widgets number ${i}`, kind: 'gotcha', answers: [`widget rule ${i}`], body: `src/w${i}.py:f has a trap`, deps: [{ path: `src/w${i}.py` }] });
  let served = 0;
  for (let i = 0; i < 6; i++) served += lateNotes(store, { session: 'cap', files: [`src/w${i}.py`], edited: true }).included.length;
  assert.equal(served, 3);
});

test('completeness nudge: co-change partner not touched and unseen rule, once', () => {
  const { store } = setup();
  const cc = { totals: { 'src/a.py': 10 }, pairs: { 'src/a.py': { 'src/b.py': 8 } } };
  const n = completenessNudge(store, { session: 's9', changed: ['src/a.py'], cochange: cc });
  assert.ok(n.text.includes('src/b.py'));
  assert.ok(n.text.includes('Launch must check can_edit'));
  assert.equal(completenessNudge(store, { session: 's9', changed: ['src/a.py'], cochange: cc }).text, '');
  assert.equal(completenessNudge(store, { session: 's10', changed: ['src/a.py', 'src/b.py'], cochange: { totals: {}, pairs: {} } }).text.includes('src/b.py'), false);
});

test('early modes: pointers omit prose, none injects nothing', async () => {
  const { store } = setup();
  const p = await orient(store, { task: 'launch eligibility check', early: 'pointers' });
  assert.ok(p.text.includes('src/a.py:launch') && !p.text.includes('must call'));
  const n = await orient(store, { task: 'launch eligibility check', early: 'none' });
  assert.equal(n.included.length, 0);
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
  process.env.THINKER_NO_LINKS = '1';
  const plain = (await orient(store, { task, budget: 3000, maxNotes: 5 })).included.map(n => n.id);
  delete process.env.THINKER_NO_LINKS;
  assert.deepEqual(ranked.slice(0, plain.length), plain);
  // what was not served is listed, and lookup returns a listed note by id
  assert.ok(two.more.length >= 1 && two.more.every(n => !two.included.some(i => i.id === n.id)));
  assert.deepEqual(lookup(store, { query: two.more[0].id }).included.map(n => n.id), [two.more[0].id]);
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
    body: 'src/c.py:a split mode layout rules',
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

test('lookup caps query results to 3 notes by default and respects explicit maxNotes', () => {
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
  const defaultRes = lookup(store, { query: 'view mode' });
  assert.equal(defaultRes.included.length, 3);

  // Query search with explicit maxNotes = 2
  const cappedRes = lookup(store, { query: 'view mode', maxNotes: 2 });
  assert.equal(cappedRes.included.length, 2);

  // Lookup by specific note ID returns exactly that 1 note
  const byIdRes = lookup(store, { query: created[0].id });
  assert.equal(byIdRes.included.length, 1);
  assert.equal(byIdRes.included[0].id, created[0].id);
});

