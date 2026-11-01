// One summary, not a line under every answer (notice-cadence.js): the floors, what a held summary
// carries when it finally speaks, and that nothing is lost while it waits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { createNote } from '../src/ops.js';
import { NOTICE_PROMPTS, NOTICE_HOURS, noticeCadence, noticeDue, noticeShown, countPrompt, holdNotice, pendingNotice } from '../src/notice-cadence.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
process.env.THINKER_CE = 'off';   // ranking has its own tests; keep the cross-encoder out of the hook spawns

const PROMPT = 'add stricter rate limiting to the upload endpoint in upload.py';

function repo(t, { notice } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-cadence-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/upload.py'), 'class RateLimiter:\n    def allow(self, key):\n        return True\n\ndef upload_endpoint(request):\n    return RateLimiter().allow(request.user)\n');
  const store = new Store(dir).init();
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ ...store.config(), minNotes: 1, ...(notice ? { notice } : {}) }));
  createNote(store, { title: 'Where upload rate limiting happens', kind: 'map', answers: ['where is rate limiting for the upload endpoint', 'upload rate limiter'], body: 'Rate limiting for uploads is in src/upload.py:RateLimiter.allow, called from src/upload.py:upload_endpoint.', deps: [{ path: 'src/upload.py', symbol: 'RateLimiter.allow' }], confidence: 0.9 });
  return dir;
}

const fakeStore = dir => ({ dir: path.join(dir, '.thinker'), config: () => { try { return JSON.parse(fs.readFileSync(path.join(dir, '.thinker', 'config.json'), 'utf8')); } catch { return {}; } } });

test('a summary waits for both floors: 20 prompts and a day', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-cadence-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const prev = process.env.THINKER_HOME; process.env.THINKER_HOME = home;
  t.after(() => { if (prev === undefined) delete process.env.THINKER_HOME; else process.env.THINKER_HOME = prev; });
  const dir = repo(t), store = fakeStore(dir);
  assert.deepEqual(noticeCadence(store), { prompts: NOTICE_PROMPTS, hours: NOTICE_HOURS });

  // nothing said here yet: the first turn speaks, so a fresh cache is not silent for a day
  assert.equal(noticeDue(store).due, true);
  noticeShown(store);
  assert.equal(noticeDue(store).due, false);

  // a day of work without 20 prompts says nothing
  const day = Date.now() + 25 * 3600e3;
  for (let i = 0; i < NOTICE_PROMPTS - 1; i++) countPrompt(store);
  assert.equal(noticeDue(store, { now: day }).due, false, '19 prompts is not 20');
  // and 20 prompts within the hour say nothing either
  countPrompt(store);
  assert.equal(noticeDue(store).due, false, 'the day has not passed');
  const due = noticeDue(store, { now: day });
  assert.equal(due.due, true);
  assert.equal(due.prompts, NOTICE_PROMPTS);

  // what the held turns served is one set, and the span is the turns the summary speaks for
  holdNotice(store, ['a', 'b']); holdNotice(store, ['b', 'c']);
  assert.deepEqual(pendingNotice(store), { ids: ['a', 'b', 'c'], turns: 2 });
  noticeShown(store, { now: day });
  assert.deepEqual(pendingNotice(store), { ids: [], turns: 0 }, 'said is said');
  assert.equal(noticeDue(store, { now: day }).due, false);
});

test('the floors are the repository\'s to move, and 0 means every turn', t => {
  const dir = repo(t, { notice: { everyPrompts: 2, everyHours: 0 } });
  assert.deepEqual(noticeCadence(fakeStore(dir)), { prompts: 2, hours: 0 });
  const off = repo(t, { notice: { everyPrompts: 0, everyHours: 0 } });
  assert.deepEqual(noticeCadence(fakeStore(off)), { prompts: 0, hours: 0 });
  // `notice: false` stays the off switch it was, not a cadence (commands/hooks.js:noticeOn)
  const none = repo(t, { notice: false });
  assert.deepEqual(noticeCadence(fakeStore(none)), { prompts: NOTICE_PROMPTS, hours: NOTICE_HOURS });
});

test('the hooks say their piece once, then hold the turns until a summary comes due', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-cadence-hooks-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // two prompts is enough to show the holding; the hours floor is checked above
  const dir = repo(t, { notice: { everyPrompts: 3, everyHours: 0 } });
  const env = { ...process.env, THINKER_HOME: home, THINKER_NO_BG_VERIFY: '1', THINKER_LOG: 'local', THINKER_HOLDOUT: '0' };
  const hook = (what, ev) => execFileSync('node', [CLI, 'hook', what, '--client', 'claude', '--repo', dir, '--no-distill'], { input: JSON.stringify(ev), encoding: 'utf8', env }).trim();
  const turn = n => { hook('prompt', { session_id: `s${n}`, prompt: PROMPT, cwd: dir }); return hook('stop', { session_id: `s${n}`, cwd: dir }); };

  const first = JSON.parse(turn(1));
  assert.match(first.systemMessage, /🧠 thinker: 1 note this turn/, 'the first turn of a fresh cache speaks');
  assert.equal(turn(2), '', 'held');
  assert.equal(turn(3), '', 'held');
  const summary = JSON.parse(turn(4));
  assert.match(summary.systemMessage, /🧠 thinker: 1 note over the last 3 prompts/, 'the summary speaks for the turns it held');
  assert.equal(turn(5), '', 'and the floors start again');
});
