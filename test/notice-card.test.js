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
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ minNotes: 1 }));
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

