// Settings an operator sets for a fleet (src/managed.js). The three rules that matter: the person's file is
// never written, only the allow-list may be set, and a machine can always take itself out of the fleet's hands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitize, mergeManaged, applyManaged, readManaged, managedBlock, MANAGED_FILE } from '../src/managed.js';
import { readMachineConfig, updateMachineConfig } from '../src/repo-switch.js';

function home(t, config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-managed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (config) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
  return dir;
}

test('only the allow-list may be set, and each value is held to its own bounds', () => {
  const { config, dropped } = sanitize({
    proxy: { trigger: '90000', holdout: 0.25, upstream: 'http://somewhere-else.example' },
    delegate: { enabled: 'true', threshold: 40_000 },
    prices: { 'claude-opus-5': { input: 0 } },
    disabledRepos: [],
  });
  assert.deepEqual(config.proxy, { trigger: 90_000, holdout: 0.25 }, 'coerced, and the route is not settable from a server');
  assert.deepEqual(config.delegate, { enabled: true, threshold: 40_000 });
  assert.equal(config.prices, undefined, 'a sink may not move what a token costs');
  assert.ok(dropped.includes('proxy.upstream') && dropped.includes('prices') && dropped.includes('disabledRepos'));

  // out of bounds is dropped, not clamped: a trigger of 10 would cut on every call and nobody asked for that
  const bad = sanitize({ proxy: { trigger: 10, holdout: 7 } });
  assert.deepEqual(bad.config, {});
  assert.deepEqual(bad.dropped.sort(), ['proxy.holdout', 'proxy.trigger']);
});

test('a managed setting wins over the machine config, and null hands it back', t => {
  const dir = home(t, { proxy: { trigger: 140_000, keep: 3 }, delegate: { enabled: false } });
  applyManaged({ rev: 1, config: { proxy: { trigger: 90_000 }, delegate: { enabled: true } } }, { home: dir, env: {} });

  const cfg = readMachineConfig(dir);
  assert.equal(cfg.proxy.trigger, 90_000, "the fleet's figure, not the file's");
  assert.equal(cfg.proxy.keep, 3, "a setting nobody managed is still the machine's own");
  assert.equal(cfg.delegate.enabled, true);
  assert.equal(readMachineConfig(dir, { local: true }).proxy.trigger, 140_000, 'the file itself is untouched');

  applyManaged({ rev: 2, config: { proxy: { trigger: null } } }, { home: dir, env: {} });
  assert.equal(readMachineConfig(dir).proxy.trigger, 140_000, 'unset is back to the machine, never to zero');
});

test("a write reads the file alone, so a central setting is never baked into the person's file", t => {
  const dir = home(t, { proxy: { trigger: 140_000 } });
  applyManaged({ rev: 1, config: { proxy: { trigger: 90_000 } } }, { home: dir, env: {} });

  updateMachineConfig(dir, cfg => ({ ...cfg, agents: { explore: true } }));

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(onDisk.proxy.trigger, 140_000, 'the fleet\'s 90k did not get written into their file');
  assert.equal(onDisk.agents.explore, true, 'and what was being set was');
  assert.equal(readMachineConfig(dir).proxy.trigger, 90_000, 'still run with the fleet\'s figure');
});

test('an older revision never walks a setting back, and the same one is not rewritten', t => {
  const dir = home(t, {});
  assert.equal(applyManaged({ rev: 3, config: { proxy: { trigger: 90_000 } } }, { home: dir, env: {} }), 3);
  assert.equal(applyManaged({ rev: 2, config: { proxy: { trigger: 200_000 } } }, { home: dir, env: {} }), 3, 'an answer from behind is refused');
  assert.equal(readManaged(dir).rev, 3);
  assert.equal(readMachineConfig(dir).proxy.trigger, 90_000);
  assert.equal(applyManaged({ rev: 3, config: { proxy: { trigger: 1 } } }, { home: dir, env: {} }), 3, 'already running it');
  assert.equal(applyManaged(null, { home: dir, env: {} }), null, 'rubbish is no revision, and never a throw');
  assert.equal(applyManaged({ rev: 'soon' }, { home: dir, env: {} }), null);
});

test('a machine can always take itself out of the fleet\'s hands, and a server cannot put it back', t => {
  const dir = home(t, { managed: false, proxy: { trigger: 140_000 } });
  assert.equal(applyManaged({ rev: 1, config: { proxy: { trigger: 90_000 } } }, { home: dir, env: {} }), null);
  assert.equal(fs.existsSync(MANAGED_FILE(dir)), false, 'nothing was even written');
  assert.deepEqual(managedBlock({ home: dir, env: {} }), { managed: { rev: null, off: true } }, 'and the event says so');

  // `managed` is not a settable path, so no payload can turn central control back on
  assert.deepEqual(sanitize({ managed: true }).config, {});

  // the environment is the container's own switch, over a file that says yes
  const on = home(t, { proxy: { trigger: 140_000 } });
  applyManaged({ rev: 1, config: { proxy: { trigger: 90_000 } } }, { home: on, env: {} });
  assert.equal(mergeManaged(readMachineConfig(on, { local: true }), { home: on, env: { THINKER_MANAGED: 'off' } }).proxy.trigger, 140_000);
});

test('the event carries the revision the machine is running, which is how a page knows it took', t => {
  const dir = home(t, {});
  assert.deepEqual(managedBlock({ home: dir, env: {} }), {}, 'a machine nobody has set says nothing');
  applyManaged({ rev: 4, config: { delegate: { enabled: true } } }, { home: dir, env: {} });
  assert.equal(managedBlock({ home: dir, env: {} }).managed.rev, 4);
});
