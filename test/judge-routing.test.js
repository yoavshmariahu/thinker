import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { providerOfModel } from '../src/llm.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a model id names its provider; a tier name does not', () => {
  assert.equal(providerOfModel('gpt-6-luna'), 'codex');
  assert.equal(providerOfModel('gemini-3.8-flash-high'), 'gemini');
  assert.equal(providerOfModel('claude-sonnet-5-5'), 'claude');
  for (const tier of ['sonnet', 'haiku', 'opus', 'fable', undefined]) assert.equal(providerOfModel(tier), null);
});

test('a model id is answered by its provider or not at all: no other CLI grades under its name', () => {
  // fake claude and codex CLIs, first on PATH (llm.js:findBin looks there before any install location)
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-bin-'));
  for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho called > ${path.join(bin, name + '.called')}\nexit 1\n`, { mode: 0o755 });
  const script = `import('${ROOT}/src/llm.js').then(m => m.complete({ model: 'gpt-6-luna', prompt: 'x' })).then(() => console.log('answered'), e => console.log('refused: ' + e.message))`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: bin, THINKER_TEST: '1', THINKER_QUIET: '1' }, encoding: 'utf8' });
  assert.match(out, /^refused: codex/);
  assert.equal(fs.existsSync(path.join(bin, 'codex.called')), true, 'codex was asked');
  assert.equal(fs.existsSync(path.join(bin, 'claude.called')), false, 'and when it failed, the claude CLI was not asked instead');
  fs.rmSync(bin, { recursive: true, force: true });
});
