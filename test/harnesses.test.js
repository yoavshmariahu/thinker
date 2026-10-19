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
