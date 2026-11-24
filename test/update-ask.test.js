// A new release of thinker is asked about before it is installed (src/update-ask.js; the owner's call of
// 2026-11-24). Held here: that the check nobody watches installs nothing and keeps what it found, that the person
// is asked once and not again inside the week, what each answer does, and that installing unasked is a setting
// they chose. Nothing reaches the network, replaces an install or starts a process: the check, the install and
// the process an answer would start are handed in.
import { tmp } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { UPDATE_ASK, updateSettings, updateAskFile, keepAvailable, dropAvailable, updateOfferDue, updateOfferPending, updateOfferWaiting, updateOffer, answerUpdateOffer, startUpdate, availableNotice } from '../src/update-ask.js';
import { updateInstallCommand } from '../src/commands/setup.js';
import { scheduleDaily, scheduledRun, checkPendingNotice } from '../src/update.js';
import { settingsView, setSetting } from '../src/settings.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-24T10:00:00Z');
const FOUND = { available: true, version: '1.0.0', latestVersion: '1.1.0', latestCommit: 'abcdef1234567' };
const state = home => { try { return JSON.parse(fs.readFileSync(updateAskFile(home), 'utf8')); } catch { return {}; } };
const config = (home, cfg) => { fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg)); };
const logOf = () => { const rows = []; return { rows, log: r => rows.push(r) }; };
const at = { version: '1.0.0', env: {} };   // the copy that is installed, and a session a person is at

// The update command as the check on use and the OS job run it, with what it would reach handed in
async function run(home, flags, { found = FOUND, level } = {}) {
  if (level) config(home, { update: { level } });
  const calls = { checked: 0, installed: 0, rewired: 0 }, store = logOf();
  const was = process.env.THINKER_HOME;
  process.env.THINKER_HOME = home;
  try {
    await updateInstallCommand({ cmd: 'update', pos: [], flags, store, out: () => {}, HERE: new URL('../src/', import.meta.url).pathname }, {
      checkFn: async () => { calls.checked++; return found; },
      applyFn: async () => { calls.installed++; return { updated: true, from: 'aaaaaaa1', to: 'abcdef1234567', version: '1.1.0' }; },
      rewireFn: () => { calls.rewired++; return { changed: 2 }; },
      telemetryFn: () => {},
    });
  } finally { if (was === undefined) delete process.env.THINKER_HOME; else process.env.THINKER_HOME = was; }
  return { ...calls, rows: store.rows };
}

test('the check on use finds a release, installs nothing and keeps it for the question', async () => {
  const home = tmp('home');
  const r = await run(home, { background: true, quiet: true });
  assert.deepEqual([r.checked, r.installed], [1, 0], 'looked, and left the install as it was');
  assert.equal(r.rewired, 1, 'the wiring is checked all the same');
  assert.deepEqual({ version: state(home).available.version, from: state(home).available.from }, { version: '1.1.0', from: '1.0.0' });
  assert.deepEqual(r.rows.map(x => x.op), ['update-available']);
  assert.equal((await run(home, { background: true, quiet: true })).rows.length, 0, 'the same release found again is not news');
  assert.ok(!fs.existsSync(path.join(home, 'state', 'update.lock')), 'the lock is given back');
});

test('the OS job installs nothing either, under its new words or the old ones launchd still runs', async () => {
  const home = tmp('home');
  assert.equal((await run(home, { scheduled: true, quiet: true })).installed, 0);
  assert.ok(state(home).available);
  // a schedule written before `--scheduled` runs `update --quiet`: known by launchd's mark on its own job
  const env = { XPC_SERVICE_NAME: 'com.thinker.update' };
  assert.equal(scheduledRun({ flags: { quiet: true }, env, platform: 'darwin' }), true);
  assert.equal(scheduledRun({ flags: { quiet: true }, env: {}, platform: 'darwin' }), false, 'a person or their script saying `update --quiet` still installs');
  assert.equal(scheduledRun({ flags: { quiet: true }, plain: false, env, platform: 'darwin' }), false, 'as does an update to a named release');
  assert.equal(scheduledRun({ flags: {}, env, platform: 'darwin' }), false);
  assert.equal(scheduledRun({ flags: { quiet: true }, env: {}, platform: 'linux', tty: true, home }), false, 'at a terminal it is a person');
});

test('the schedule thinker writes says its run is the job\'s own', { skip: process.platform !== 'darwin' }, () => {
  const home = tmp('home'), plistPath = path.join(home, 'job.plist');
  scheduleDaily({ home, plistPath, skipLaunchctl: true });
  assert.match(fs.readFileSync(plistPath, 'utf8'), /update --scheduled --quiet</);
});

test('thinker update, typed, installs the release and nothing waits afterwards', async () => {
  const home = tmp('home');
  await run(home, { background: true, quiet: true });
  const r = await run(home, { quiet: true });
  assert.equal(r.installed, 1);
  assert.equal(state(home).available, undefined);
  assert.deepEqual(r.rows.map(x => [x.op, x.auto]), [['update', false]]);
});

test('a person who chose automatic updates gets them as before, and one who chose off is not looked for', async () => {
  const auto = tmp('home');
  const a = await run(auto, { background: true, quiet: true }, { level: 'auto' });
  assert.equal(a.installed, 1);
  assert.deepEqual(a.rows.map(x => [x.op, x.auto]), [['update', true]]);
  assert.match(checkPendingNotice(auto), /^auto-updated to abcdef1 \(v1\.1\.0\)/);
  assert.equal(updateOffer(null, { home: auto, now: NOW, ...at }), '', 'and is asked nothing');

  const off = tmp('home');
  keepAvailable(FOUND, { home: off, now: NOW });
  const o = await run(off, { background: true, quiet: true }, { level: 'off' });
  assert.deepEqual([o.checked, o.installed, o.rewired], [0, 0, 1], 'no check, and the wiring is still looked after');
  assert.equal(state(off).available, undefined, 'what an earlier check found is not kept for a question nobody will be asked');
  assert.equal(updateSettings(off).level, 'off');
  const whole = tmp('home'); config(whole, { update: false });
  assert.equal(updateSettings(whole).level, 'off', 'the whole block switched off reads as off');
});

test('the question is put once, through the agent\'s own question tool, and not again inside the week', () => {
  const home = tmp('home'), store = logOf();
  assert.equal(updateOffer(store, { client: 'claude', home, now: NOW, ...at }), '', 'nothing found, nothing asked');
  keepAvailable(FOUND, { home, now: NOW });
  assert.equal(updateOfferWaiting({ home, now: NOW, version: '1.0.0' }), true, 'the answer\'s tool is offered to a session that starts before the question is put');
  const block = updateOffer(store, { client: 'claude', home, now: NOW, ...at });
  assert.match(block, /^<thinker-update>\nthinker 1\.1\.0 is out and this machine runs 1\.0\.0\. Nothing has been installed/);
  assert.match(block, /your AskUserQuestion tool, not in prose: "thinker 1\.1\.0 is out \(this machine runs 1\.0\.0\)\. Update now\?" \(header "thinker"\)/);
  assert.match(block, /"Update now", "Not now" and "Always update automatically"/);
  assert.match(block, /call thinker's `update` tool with choice yes, no or always; if that tool is not offered, run `.*update --answer <yes\|no\|always>`/);
  assert.deepEqual(store.rows, [{ op: 'update-offer', version: '1.1.0', client: 'claude' }]);
  assert.equal(updateOfferPending({ home, now: NOW }), true);

  assert.equal(updateOffer(store, { client: 'claude', home, now: NOW + 60_000, ...at }), '', 'the next prompt is not asked again');
  keepAvailable({ ...FOUND, latestVersion: '1.2.0', latestCommit: 'fedcba9' }, { home, now: NOW + DAY });
  assert.equal(updateOffer(store, { client: 'claude', home, now: NOW + 2 * DAY, ...at }), '', 'nor is a release that comes out inside the week');
  assert.match(updateOffer(store, { client: 'claude', home, now: NOW + UPDATE_ASK.askEveryDays * DAY + 1, ...at }), /thinker 1\.2\.0 is out/, 'a week on, the newest release is asked about');
  assert.match(updateOffer(null, { client: 'codex', home: (() => { const h = tmp('home'); keepAvailable(FOUND, { home: h, now: NOW }); return h; })(), now: NOW, ...at }),
    /ask the user in chat, in a line opening "🧠 thinker:"/, 'an agent with no question tool asks in the chat');
});

test('how often the question may come is the person\'s setting', () => {
  const home = tmp('home');
  config(home, { update: { askEveryDays: 1 } });
  keepAvailable(FOUND, { home, now: NOW });
  assert.ok(updateOffer(null, { home, now: NOW, ...at }));
  assert.equal(updateOfferDue({ home, now: NOW + DAY - 1, version: '1.0.0' }), null);
  assert.ok(updateOfferDue({ home, now: NOW + DAY, version: '1.0.0' }));
});

test('nobody is asked where nobody is at the session, or about the release they already run', () => {
  const home = tmp('home');
  keepAvailable(FOUND, { home, now: NOW });
  assert.equal(updateOffer(null, { home, now: NOW, version: '1.0.0', env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' } }), '');
  assert.equal(state(home).asked, undefined, 'and the question is still there for a session with a person at it');
  assert.equal(updateOffer(null, { home, now: NOW, version: '1.1.0', env: {} }), '', 'installed since by hand: nothing to ask');
  assert.equal(availableNotice({ home, version: '1.1.0' }), '');
});

test('not now changes nothing and starts nothing', () => {
  const home = tmp('home'), store = logOf();
  keepAvailable(FOUND, { home, now: NOW });
  updateOffer(null, { home, now: NOW, ...at });
  let started = 0;
  const said = answerUpdateOffer('Not now', { store, client: 'claude', home, now: NOW + 1000, version: '1.0.0', startFn: () => { started++; return { started: true }; } });
  assert.equal(said, 'Recorded: thinker stays on 1.0.0. It asks again in a week if a release still waits; `thinker update` installs the latest at any time.');
  assert.equal(started, 0);
  assert.equal(updateSettings(home).level, 'ask');
  assert.equal(updateOfferPending({ home, now: NOW + 2000 }), false, 'answered: the tool is no longer offered');
  assert.deepEqual(store.rows, [{ op: 'update-answer', choice: 'no', version: '1.1.0', client: 'claude' }]);
  assert.ok(state(home).available, 'the release still waits, for `thinker update` or next week\'s question');
});

test('yes starts the update in a process of its own, and always also stops the asking', () => {
  const home = tmp('home');
  keepAvailable(FOUND, { home, now: NOW });
  const started = [];
  const startFn = o => { started.push(o); return { started: true }; };
  assert.equal(answerUpdateOffer('yes', { home, now: NOW, version: '1.0.0', startFn }),
    'Updating thinker to 1.1.0 in the background; it takes about a minute. Restart open desktop apps afterwards to load changed settings.');
  assert.equal(started.length, 1);
  assert.equal(updateSettings(home).level, 'ask', 'a yes is for this release');

  assert.match(answerUpdateOffer('Always update automatically', { home, now: NOW, version: '1.0.0', startFn }), /^Updating thinker to 1\.1\.0 .* From now on thinker installs new releases itself; `thinker settings set update\.level ask` has it ask again\.$/);
  assert.equal(started.length, 2);
  assert.equal(updateSettings(home).level, 'auto');

  assert.match(answerUpdateOffer('yes', { home, now: NOW, version: '1.0.0', startFn: () => ({ started: false, reason: 'no node' }) }), /^The update could not be started \(no node\); run `thinker update`\./);
  // what a yes starts: the background run told to install, which a test run never does
  const spawned = [];
  assert.deepEqual(startUpdate({ cli: '/x/cli.js', testMode: false, env: {}, spawnFn: (bin, args, o) => { spawned.push([args, o.detached, o.env.THINKER_BACKGROUND_UPDATE]); return { unref() {} }; } }), { started: true });
  assert.deepEqual(spawned, [[['/x/cli.js', 'update', '--background', '--apply', '--quiet'], true, '1']]);
  assert.equal(startUpdate({ spawnFn: () => { throw new Error('a test started an update'); } }).started, false);
});

test('the update a person said yes to installs under any setting, and is not called automatic', async () => {
  const home = tmp('home');
  keepAvailable(FOUND, { home, now: NOW });
  const r = await run(home, { background: true, apply: true, quiet: true });
  assert.equal(r.installed, 1);
  assert.deepEqual(r.rows, [{ op: 'update', from: 'aaaaaaa1', to: 'abcdef1234567', version: '1.1.0', auto: false, asked: true }]);
  assert.equal(state(home).available, undefined);
  assert.match(checkPendingNotice(home), /^updated to abcdef1 \(v1\.1\.0\); the hooks of 2 checkouts were rewritten/);
});

test('a terminal is told a release is out once a release', () => {
  const home = tmp('home');
  assert.equal(availableNotice({ home, version: '1.0.0' }), '');
  keepAvailable(FOUND, { home, now: NOW });
  assert.equal(availableNotice({ home, version: '1.0.0' }), 'thinker 1.1.0 is out (this machine runs 1.0.0); `thinker update` installs it');
  assert.equal(availableNotice({ home, version: '1.0.0' }), '');
  keepAvailable({ ...FOUND, latestVersion: '1.2.0' }, { home, now: NOW });
  assert.match(availableNotice({ home, version: '1.0.0' }), /^thinker 1\.2\.0 is out/);
  dropAvailable({ home });
  assert.equal(availableNotice({ home, version: '1.0.0' }), '');
});

test('the settings show how a release is handled, asked first unless the person says otherwise', async () => {
  const home = tmp('home');
  const row = id => settingsView({ home }).groups.find(g => g.id === 'updates').items.find(i => i.id === id);
  assert.deepEqual([row('update.level').value, row('update.level').options.map(o => o.value)], ['ask', ['ask', 'auto', 'off']]);
  assert.deepEqual([row('update.askEveryDays').value, row('update.askEveryDays').shown], [7, true]);
  assert.equal((await setSetting('update.level', 'auto', { home })).said, 'When a new release is out: Automatic');
  assert.equal(updateSettings(home).level, 'auto');
  assert.equal(row('update.askEveryDays').shown, false, 'how often to ask is not a question where nothing is asked');
  await setSetting('update.level', 'ask', { home });
  await setSetting('update.askEveryDays', '3', { home });
  assert.deepEqual(updateSettings(home), { level: 'ask', askEveryDays: 3 });
});
