import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { beginTurn, trackTurn, peekTurn, createNote } from '../src/ops.js';
import { noticeCard, noticeCardOn } from '../src/notice-card.js';
import { dayKey } from '../src/savings-ledger.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env, THINKER_TEST: '1', THINKER_NOTICE_CARD: '1', THINKER_LOG: 'off', THINKER_NO_BG_VERIFY: '1' };
const ref = text => JSON.parse(text.match(/visualize(.*?)/s)[1]).path;
function fixture(t) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-notice-card-')));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'code.js'), 'x'.repeat(3600));
  fs.mkdirSync(path.join(repo, '.codex'));
  fs.writeFileSync(path.join(repo, '.codex/config.toml'), 'x'.repeat(3600));
  const store = new Store(repo).init();
  // no floors on the notices: these tests are about the card itself, a turn at a time, and the cadence
  // that holds a new card back until a summary is due has its own test below and in notice-cadence.test.js
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ minNotes: 1, notice: { everyPrompts: 0, everyHours: 0 } }));
  return store;
}
function enable(t) {
  const before = process.env.THINKER_NOTICE_CARD;
  process.env.THINKER_NOTICE_CARD = '1';
  t.after(() => { if (before === undefined) delete process.env.THINKER_NOTICE_CARD; else process.env.THINKER_NOTICE_CARD = before; });
}
const one = { id: 'one', title: '<script>untrusted</script>', deps: [{ path: 'code.js' }], status: 'stale' };
const two = { id: 'two', title: 'Another note', deps: one.deps };

test('one card per turn deduplicates notes and files, escapes titles and preserves past cards', t => {
  enable(t); const store = fixture(t);
  const args = { client: 'codex', session: 'a/../b', turn: 1, notes: [one, one] };
  const first = ref(noticeCard(store, args));
  assert.ok(first.startsWith(path.join(store.dir, 'state/notice-cards')));
  assert.equal(noticeCard(store, { ...args, notes: [one, two] }), '', 'update does not reinject the reference');
  const html = fs.readFileSync(first, 'utf8');
  assert.match(html, /2 notes this turn · 1 file · Estimated tokens saved: ~1k/);
  assert.match(html, /&lt;script&gt;untrusted&lt;\/script&gt;/);
  assert.match(html, /verify before use/);
  assert.match(html, /actual token savings are not measured/);
  assert.doesNotMatch(html, /<script>|<!doctype|<html|<body/);
  const second = ref(noticeCard(store, { ...args, turn: 2 }));
  assert.notEqual(first, second);
  assert.equal(fs.readFileSync(first, 'utf8'), html, 'new turn leaves the prior card intact');
  assert.notEqual(first, ref(noticeCard(store, { ...args, session: 'another-chat' })));
  const config = ref(noticeCard(store, { client: 'codex', notes: [{ id: 'cfg', deps: [{ path: '.codex/config.toml' }] }] }));
  assert.doesNotMatch(fs.readFileSync(config, 'utf8'), /Estimated tokens saved|file ·|this turn/);
});

test('a new card waits for the next summary; one already referenced is kept up to date', t => {
  enable(t); const store = fixture(t);
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ minNotes: 1 }));   // the real floors
  const args = { client: 'codex', session: 'held', turn: 1, notes: [one] };
  const first = ref(noticeCard(store, args));   // nothing said here yet: the first card is drawn
  assert.equal(noticeCard(store, { ...args, notes: [one, two] }), '', 'the drawn card is still updated');
  assert.match(fs.readFileSync(first, 'utf8'), /2 notes this turn/);
  assert.equal(noticeCard(store, { ...args, turn: 2 }), '', 'the next turn draws nothing: 20 prompts and a day away');
  assert.deepEqual(fs.readdirSync(path.join(store.dir, 'state/notice-cards')), [path.basename(first)], 'one card, not one a turn');
});

test('misses, holdouts, disabled notices and write failures leave retrieval alone', t => {
  enable(t); const store = fixture(t);
  const args = { client: 'codex', session: 's', turn: 1, notes: [one] };
  for (const extra of [{ notes: [] }, { holdout: true }, { updateOnly: true }, { client: 'claude' }]) assert.equal(noticeCard(store, { ...args, ...extra }), '');
  assert.ok(!fs.existsSync(path.join(store.dir, 'state/notice-cards')));
  fs.writeFileSync(path.join(store.dir, 'config.json'), '{"notice":false}');
  assert.equal(noticeCard(store, args), '');
  fs.writeFileSync(path.join(store.dir, 'config.json'), '{}');
  fs.mkdirSync(path.join(store.dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(store.dir, 'state/notice-cards'), 'not a directory');
  assert.equal(noticeCard(store, args), '');
});

test('repository opt-in is desktop only and obeys both off switches', t => {
  const store = fixture(t);
  const options = { env: {}, app: () => 'the Codex app' };
  assert.equal(noticeCardOn(store, 'codex', options), false);
  fs.writeFileSync(path.join(store.dir, 'config.json'), '{"noticeCard":true}');
  assert.equal(noticeCardOn(store, 'codex', options), true);
  assert.equal(noticeCardOn(store, 'mcp', options), true);
  assert.equal(noticeCardOn(store, 'cursor', options), false);
  assert.equal(noticeCardOn(store, 'codex', { ...options, app: () => null }), false);
  for (const e of [{ THINKER_NOTICE: 'off' }, { THINKER_NOTICE_CARD: 'off' }, { THINKER_NOTICE_CARD: '0' }]) assert.equal(noticeCardOn(store, 'codex', { ...options, env: e }), false);
});

test('normal Codex prompt supplies the reference; tools update it and stop never requests continuation', t => {
  const store = fixture(t), session_id = 'ordinary-chat';
  const n = createNote(store, { title: 'Upload rate limiting', kind: 'rule', body: 'Upload rate limiting happens in code.js.', answers: ['upload rate limiting'], deps: [{ path: 'code.js' }], confidence: 0.95 });
  const hook = (what, extra = {}) => execFileSync(process.execPath, [path.join(root, 'src/cli.js'), 'hook', what, '--client', 'codex', '--repo', store.repo, '--no-distill'], { encoding: 'utf8', input: JSON.stringify({ cwd: store.repo, session_id, ...extra }), env });
  const output = hook('prompt', { prompt: 'Where does upload rate limiting happen?' });
  const file = ref(output);
  assert.match(output, /<thinker-cache>/);
  store.put(two); trackTurn(store, session_id, [two.id, n.id]);
  assert.doesNotMatch(hook('tool', { tool_name: 'Read', tool_input: { file_path: 'code.js' } }), /visualize/);
  assert.match(fs.readFileSync(file, 'utf8'), /2 notes this turn/);
  assert.equal(JSON.parse(hook('stop')).decision, undefined);
  assert.deepEqual(peekTurn(store, session_id), []);
  assert.ok(fs.existsSync(file));
  trackTurn(store, session_id, [n.id]); // simulate a prior stop that was missed
  beginTurn(store, session_id);
  assert.deepEqual(peekTurn(store, session_id), []);
  assert.doesNotMatch(hook('tool', { tool_name: 'Read', tool_input: { file_path: 'code.js' } }), /visualize/);
});


test('the Codex desktop card carries the money, its split and its caveat', t => {
  enable(t); const store = fixture(t);
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-card-home-')));
  const before = process.env.THINKER_HOME;
  process.env.THINKER_HOME = home;
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); if (before === undefined) delete process.env.THINKER_HOME; else process.env.THINKER_HOME = before; });
  const day = dayKey(Date.now());
  const ledger = { at: Date.now(), day, today: { cost: 3.65, tokens: 5_636_787, cache: { cost: 3.65, tokens: 5_636_787 }, cleared: { cost: 0, tokens: 0 } },
    lifetime: { cost: 849.2, tokens: 1_339_960_865, cache: { cost: 21.7, tokens: 37_961_726 }, cleared: { cost: 827.5, tokens: 1_301_999_139 } } };
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(home, 'state', 'savings.json'), JSON.stringify(ledger));
  const file = ref(noticeCard(store, { client: 'codex', session: 's1', turn: 1, notes: [two] }));
  const html = fs.readFileSync(file, 'utf8');
  assert.match(html, /saved today \$3\.65 · lifetime \$849/);
  assert.match(html, /Today: cache hits \$3\.65/);
  assert.match(html, /Lifetime: cache hits \$21\.7 .*context cleared \$828/);
  assert.match(html, /not measured billing/);
  assert.match(html, /gross of the cache rewrite/, 'the Report\'s own caveat travels with the figure');
  assert.match(html, /thinker savings/, 'the card points at the command that prints it in full');
  // no ledger: the cards are drawn exactly as they were before
  fs.rmSync(path.join(home, 'state', 'savings.json'));
  const plain = fs.readFileSync(ref(noticeCard(store, { client: 'codex', session: 's2', turn: 1, notes: [two] })), 'utf8');
  assert.doesNotMatch(plain, /lifetime/);
});
