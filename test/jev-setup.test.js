import { test, beforeEach, afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { configureJev } from '../src/setup/steps.js';

const names = ['THINKER_HOME', 'THINKER_JEV_KEY', 'JEV_API_KEY', 'TYPESAFE_API_KEY', 'THINKER_JEV', 'THINKER_JEV_TIMEOUT'];
let saved, home;
beforeEach(() => {
  saved = Object.fromEntries(names.map(k => [k, process.env[k]]));
  for (const k of names) delete process.env[k];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-setup-'));
  process.env.THINKER_HOME = home;
});
afterEach(() => {
  for (const k of names) saved[k] === undefined ? delete process.env[k] : process.env[k] = saved[k];
  fs.rmSync(home, { recursive: true, force: true });
});

test('setup enables hosted Jev without prompting for a key and explains the local fallback', async () => {
  const lines = []; let calls = 0;
  const result = await configureJev({ store: { config: () => ({ jev: { enabled: true, key: null } }) }, out: line => lines.push(line),
    hostedCredentialFn: async () => { calls++; } });
  assert.equal(result, 'hosted'); assert.equal(calls, 1);
  assert.match(lines.join('\n'), /no API key needed/);
  assert.match(lines.join('\n'), /1500 ms/);
  assert.match(lines.join('\n'), /candidate note excerpts/);
  assert.doesNotMatch(lines.join('\n'), /paste|API key:/);
});
test('unavailable hosted enrollment does not prevent setup', async () => {
  const result = await configureJev({ store: { config: () => ({ jev: { enabled: true } }) }, out: () => {}, hostedCredentialFn: async () => { throw new Error('offline'); } });
  assert.equal(result, 'ce');
});
test('local-only configuration performs no registration', async () => {
  const result = await configureJev({ store: { config: () => ({ jev: false }) }, out: () => {},
    hostedCredentialFn: async () => { assert.fail('must not enroll'); } });
  assert.equal(result, 'ce');
});
