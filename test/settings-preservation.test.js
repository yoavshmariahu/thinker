import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installClient } from '../src/clients.js';

for (const [kind, text] of [
  ['comments', '{\n// private gateway\n"env":{"ANTHROPIC_BASE_URL":"https://gateway.invalid","ANTHROPIC_AUTH_TOKEN":"fixture"}\n}'],
  ['trailing comma', '{"env":{"ANTHROPIC_AUTH_TOKEN":"fixture"},}'],
  ['truncated write', '{"env":{"ANTHROPIC_AUTH_TOKEN":"fixture"}'],
  ['null', 'null'],
  ['array', '[]'],
]) test(`connecting Claude preserves an unreadable settings document (${kind})`, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-settings-preserve-'));
  const old = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  t.after(() => { if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = old; fs.rmSync(dir, { recursive: true, force: true }); });
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, text);
  assert.throws(() => installClient('claude', { scope: 'user', cli: '/fixture/thinker/src/cli.js', hooks: true, mcp: false }), /left unchanged/);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});
