import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectHarnesses, editorStorageDirs } from '../src/harnesses.js';

const DAY = 864e5;
const touch = (p, daysAgo) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, ''); const t = new Date(Date.now() - daysAgo * DAY); fs.utimesSync(p, t, t); };
const age = (p, daysAgo) => { const t = new Date(Date.now() - daysAgo * DAY); fs.utimesSync(p, t, t); };

test('detectHarnesses names every agent found, supported or not, with the days since it was last used', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-harness-home-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-harness-bin-'));
  try {
    touch(path.join(home, '.claude', 'settings.json'), 1); age(path.join(home, '.claude'), 1);
    touch(path.join(home, '.cline', 'state.json'), 3); age(path.join(home, '.cline'), 3);
    touch(path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'state.vscdb'), 12);
    age(path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline'), 12);
    fs.writeFileSync(path.join(bin, 'aider'), ''); // a binary alone: found, age unknown
    const found = detectHarnesses({ home, platform: 'darwin', env: { PATH: bin } });
    assert.deepEqual(found, {
      claude: { supported: true, lastUsedDays: 1 },
      cline: { supported: true, lastUsedDays: 3 },
      roo: { supported: false, lastUsedDays: 12 },
      aider: { supported: false, lastUsedDays: null },
    });
    assert.deepEqual(detectHarnesses({ home: path.join(home, 'nothing-here'), platform: 'linux', env: { PATH: '' } }), {});
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(bin, { recursive: true, force: true }); }
});

test('editor storage is looked up per platform', () => {
  assert.ok(editorStorageDirs({ home: '/h', platform: 'linux', env: {} }).includes('/h/.config/Code/User/globalStorage'));
  assert.ok(editorStorageDirs({ home: '/h', platform: 'darwin', env: {} }).includes('/h/Library/Application Support/Cursor/User/globalStorage'));
  assert.ok(editorStorageDirs({ home: 'C:\\u', platform: 'win32', env: { APPDATA: 'C:\\u\\AppData\\Roaming' } })[0].includes('AppData'));
});

test('how long ago an agent was used ignores the files thinker writes into its home', async () => {
  const { detectHarnesses } = await import('../src/harnesses.js');
  const { wiringFiles } = await import('../src/clients.js');
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-harness-age-'));
  const saved = process.env.HOME;
  try {
    process.env.HOME = h;
    const claude = path.join(h, '.claude');
    fs.mkdirSync(claude, { recursive: true });
    const theirs = path.join(claude, 'history.jsonl');
    const ours = wiringFiles('claude', { scope: 'user' }).local;
    assert.equal(path.dirname(ours), claude, 'the settings file thinker writes lives in the agent\'s home');
    // the person last worked with Claude Code ten days ago, and thinker had already wired it by then
    fs.writeFileSync(theirs, '{}'); fs.writeFileSync(ours, '{}');
    const old = new Date(Date.now() - 10 * 864e5);
    for (const f of [theirs, ours, claude]) fs.utimesSync(f, old, old);
    // today the hook's daily wiring check rewrote thinker's own entry in place, as it does
    fs.writeFileSync(ours, '{"hooks":{}}');
    const age = detectHarnesses({ home: h, env: { PATH: '' }, now: Date.now() }).claude.lastUsedDays;
    assert.equal(age, 10, 'thinker\'s own write must not read as the person using the agent today');
  } finally { if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved; fs.rmSync(h, { recursive: true, force: true }); }
});
