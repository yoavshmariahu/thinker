// Settings (settings.js): one list for the page's Settings tab and `thinker settings`. What is held here: a setting
// under a parent that is off is not shown and keeps its value; the parent is honoured where the key is read (the
// delegation rule, the profile, the notices, the learning budget), not only on the page; and there is one set, the
// machine's, with none per repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { GROUPS, settingsView, setSetting, renderSettings } from '../src/settings.js';
import { readMachineConfig, layeredConfig, isDisabledRepo } from '../src/repo-switch.js';
import { delegateConfig, decide } from '../src/delegate.js';
import { behaviorOf } from '../src/upkeep.js';
import { profileConfig } from '../src/profile.js';
import { maintainConfig } from '../src/maintain.js';
import { noticeCadence } from '../src/notice-cadence.js';
import { isTelemetryEnabled } from '../src/telemetry.js';
import { errorConsent } from '../src/error-report.js';

const tmp = p => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
function fixture(t) {
  const home = tmp('thinker-settings-home-'), dir = tmp('thinker-settings-repo-');
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true }); });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', `https://github.com/acme/${path.basename(dir)}.git`], { cwd: dir });
  return { home, dir, store: new Store(dir) };
}
const rows = v => Object.fromEntries(v.groups.flatMap(g => g.items).map(i => [i.id, i]));
const shown = v => v.groups.flatMap(g => g.items).filter(i => i.shown).map(i => i.id);
// the readers that take their home from the environment are given this test's
const withHome = async (home, fn) => { const was = process.env.THINKER_HOME; process.env.THINKER_HOME = home; try { return await fn(); } finally { if (was === undefined) delete process.env.THINKER_HOME; else process.env.THINKER_HOME = was; } };

test('a fresh machine shows every setting at the default the code that reads it has', t => {
  const { home } = fixture(t);
  const v = settingsView({ home }), r = rows(v);
  assert.deepEqual(v.groups.map(g => g.id), ['automation', 'delegation', 'learning', 'telling', 'privacy']);
  assert.equal(shown(v).length, GROUPS.flatMap(g => g.items).length, 'nothing is off, so nothing is hidden');
  const b = behaviorOf(null, { home }), d = delegateConfig({ home, env: {} });
  for (const k of ['level', 'prs', 'remove', 'tools', 'skills', 'sweep', 'minPerDay', 'batchEveryDays', 'followUp']) assert.equal(r[`upkeep.${k}`].value, b[k], `upkeep.${k}`);
  for (const k of ['enabled', 'reads', 'suites', 'threshold', 'model', 'exploreModel', 'repeats']) assert.equal(r[`delegate.${k}`].value, d[k], `delegate.${k}`);
  assert.equal(r['maintain.dailyTokens'].value, 2_000_000);
  assert.equal(r['errors'].value, false, 'error reports are sent only on a yes');
  // context cutting is not a setting of this page (the owner's call), nor are the holdouts
  assert.ok(!Object.keys(r).some(id => /^proxy\.|holdout/i.test(id)));
  // every value offered is one the list itself takes back
  for (const i of Object.values(r)) if (i.kind === 'choice') assert.ok(i.options.some(o => o.value === i.value), `${i.id} shows its own value`);
});

test('a setting under a parent that is off is not shown, has no effect, and keeps its value for when the parent is back', async t => {
  const { home } = fixture(t);
  const set = (id, v) => setSetting(id, v, { home });
  // two levels down: the size and the model of a read sit under reads, reads under the trigger
  await set('delegate.threshold', 16000);
  let v = (await set('delegate.reads', false)).view;
  assert.ok(!shown(v).includes('delegate.threshold') && !shown(v).includes('delegate.exploreModel'));
  assert.ok(shown(v).includes('delegate.suites') && shown(v).includes('delegate.model'), 'the suite run is its own switch');
  v = (await set('delegate.enabled', false)).view;
  assert.deepEqual(shown(v).filter(id => id.startsWith('delegate.')), ['delegate.enabled']);
  assert.equal(readMachineConfig(home).delegate.threshold, 16000, 'the value under it is left as it was');
  v = (await set('delegate.enabled', true)).view;
  assert.equal(rows(v)['delegate.reads'].value, false, 'back on, reads are still as the person left them');
  v = (await set('delegate.reads', true)).view;
  assert.equal(rows(v)['delegate.threshold'].value, 16000);

  // automation: what it may change sits under whether it looks at all; the cadence and the check under acting itself
  v = (await set('upkeep.prs', false)).view;
  assert.ok(!shown(v).includes('upkeep.remove'));
  v = (await set('upkeep.level', 'ask')).view;
  assert.ok(shown(v).includes('upkeep.tools') && shown(v).includes('upkeep.minPerDay'));
  assert.ok(!shown(v).includes('upkeep.batchEveryDays') && !shown(v).includes('upkeep.followUp'), 'nothing goes by itself, so there is no cadence to set');
  v = (await set('upkeep.level', 'off')).view;
  assert.deepEqual(shown(v).filter(id => id.startsWith('upkeep.')), ['upkeep.level']);
  assert.equal(behaviorOf(null, { home }).level, 'off');
  assert.equal(behaviorOf(null, { home }).prs, false, 'kept');

  // the error reports go with the usage figures
  v = (await set('telemetry', false)).view;
  assert.ok(!shown(v).includes('errors'));
});

test('the parent is honoured where the key is read: the delegation rule, the profile, the notices, the budget', async t => {
  const { home, store } = fixture(t);
  const big = { files: ['a.py'], tokens: 50_000 }, st = () => ({});
  const fires = (o) => decide(st(), { prompt: 1, cfg: delegateConfig({ home, env: {} }), ...o }).fire;
  assert.equal(fires({ read: big }), true); assert.equal(fires({ suite: 'npm test' }), true);
  await setSetting('delegate.reads', false, { home });
  assert.equal(fires({ read: big }), false, 'reads stay with the lead'); assert.equal(fires({ suite: 'npm test' }), true, 'the suite still goes');
  await setSetting('delegate.reads', true, { home }); await setSetting('delegate.suites', false, { home });
  assert.equal(fires({ read: big }), true); assert.equal(fires({ suite: 'npm test' }), false);
  await setSetting('delegate.threshold', 64000, { home });
  assert.equal(fires({ read: big }), false, 'under the size chosen');

  await withHome(home, async () => {
    assert.equal(profileConfig(store).enabled, true);
    await setSetting('learn.sessions', false, { home });
    assert.equal(profileConfig(store).enabled, false, 'no learning, so no profile is served either');
    assert.equal(layeredConfig(store, 'learn').sessions, false);
    // the week-on check says what it loses with it
    assert.match(rows(settingsView({ home }))['upkeep.followUp'].note, /Learning is off/);
    // a repository whose own file already sets the key is still honoured there, as before this page; nothing here writes it
    fs.mkdirSync(path.join(store.dir), { recursive: true });
    fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ learn: { sessions: true } }));
    assert.equal(profileConfig(store).enabled, true);
    fs.rmSync(path.join(store.dir, 'config.json'));
    await setSetting('learn.sessions', true, { home }); await setSetting('learn.profile', false, { home });
    assert.equal(profileConfig(store).enabled, false, 'learning goes on, the profile is not served');

    await setSetting('maintain.dailyTokens', 500000, { home });
    assert.equal(maintainConfig(store).dailyTokens, 500_000);
    await setSetting('notice.everyHours', 168, { home });
    assert.equal(noticeCadence(store).hours, 168);
    await setSetting('notice.enabled', false, { home });
    assert.equal(layeredConfig(store, 'notice').enabled, false);
    assert.equal(layeredConfig(store, 'notice').everyHours, 168, 'kept under the switch');

    assert.equal(isTelemetryEnabled({ home, store }), process.env.THINKER_TELEMETRY === 'off' ? false : isTelemetryEnabled({ home }));
    await setSetting('telemetry', false, { home });
    assert.equal(isTelemetryEnabled({ home, store }), false);
  });
});

test('one set of settings, the machine\'s: no scope, no repository switch, and no repository\'s file is written', async t => {
  const { home, store, dir } = fixture(t);
  const v = (await setSetting('upkeep.minPerDay', 4, { home })).view;
  assert.deepEqual(Object.keys(v), ['groups'], 'the view is the machine\'s and says nothing of a repository');
  assert.ok(!v.groups.flatMap(g => g.items).some(i => 'where' in i || 'from' in i));
  assert.equal(readMachineConfig(home).upkeep.minPerDay, 4);
  for (const id of ['learn.sessions', 'notice.enabled', 'telemetry', 'prComments', 'delegate.enabled']) await setSetting(id, false, { home });
  assert.equal(fs.existsSync(path.join(dir, '.thinker', 'config.json')), false);
  assert.equal(isDisabledRepo(dir, { home }), false);
  assert.match((await setSetting('repo.on', false, { home })).error, /no setting called/);
  void store;
});

test('only what the list offers can be set, and a block switched off the old way reads as its switch', async t => {
  const { home } = fixture(t);
  assert.match((await setSetting('proxy.trigger', 1, { home })).error, /no setting called/);
  assert.match((await setSetting('delegate.threshold', 123, { home })).error, /cannot be 123/);
  assert.match((await setSetting('delegate.enabled', 'maybe', { home })).error, /on or off/);
  assert.match((await setSetting('delegate.model', 'gpt-9', { home })).error, /claude-haiku-5-5/);
  assert.equal(fs.existsSync(path.join(home, 'config.json')), false, 'a refusal writes nothing');
  // the command's words: on and off for a switch, the value for a choice
  assert.equal(rows((await setSetting('upkeep.skills', 'on', { home })).view)['upkeep.skills'].value, true);
  assert.equal(rows((await setSetting('upkeep.batchEveryDays', '30', { home })).view)['upkeep.batchEveryDays'].value, 30);
  assert.equal(rows((await setSetting('delegate.exploreModel', 'claude-sonnet-5-5', { home })).view)['delegate.exploreModel'].value, 'claude-sonnet-5-5');
  assert.equal(rows((await setSetting('delegate.exploreModel', 'same', { home })).view)['delegate.exploreModel'].value, null);
  // error reports: a yes is recorded as consent, off as never (no reminder), and nothing is sent by the click
  await setSetting('errors', true, { home }); assert.equal(errorConsent(home), 'yes');
  await setSetting('errors', false, { home }); assert.equal(errorConsent(home), 'never');

  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ delegate: false, upkeep: false, notice: 'off', upkeep2: 1 }));
  const r = rows(settingsView({ home }));
  assert.equal(r['delegate.enabled'].value, false); assert.equal(r['upkeep.level'].value, 'off'); assert.equal(r['notice.enabled'].value, false);
  // switching one back on turns the old form into the block, and loses nothing else in the file
  await setSetting('delegate.enabled', true, { home });
  assert.deepEqual(readMachineConfig(home, { local: true }).delegate, { enabled: true });
  assert.equal(readMachineConfig(home, { local: true }).upkeep2, 1);
  // a value set another way (the chat's "more like this") is listed as it is
  await setSetting('upkeep.level', 'auto', { home });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ upkeep: { minPerDay: 3 } }));
  const m = rows(settingsView({ home }))['upkeep.minPerDay'];
  assert.equal(m.value, 3); assert.ok(m.options.some(o => o.value === 3 && o.label === '$3 a day'));
});

test('`thinker settings` prints the rows the page shows, each under the one it depends on', async t => {
  const { home } = fixture(t);
  let lines = renderSettings(settingsView({ home }));
  assert.ok(lines.includes('  How much thinker does on its own: Automatic   [upkeep.level]'));
  assert.ok(lines.includes('      Remove sections outright: on   [upkeep.remove]'), 'two levels in');
  assert.ok(lines.includes('      Reads of at least: 4k tokens   [delegate.threshold]'));
  await setSetting('delegate.enabled', false, { home });
  lines = renderSettings(settingsView({ home }));
  assert.ok(lines.includes('  Hand simple work to a cheaper model: off   [delegate.enabled]'));
  assert.ok(!lines.some(l => /delegate\.(reads|threshold|suites|model|repeats)/.test(l)), 'what is under a switch that is off is not printed');
});
