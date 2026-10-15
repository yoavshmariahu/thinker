import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { sendUninstallFeedback, messagesEndpoint } from '../src/telemetry.js';
import { askUninstallFeedback } from '../src/commands/setup.js';
import { normalizeMessage } from '../infra/metrics/messages.mjs';

test('uninstall feedback goes to /messages beside /metrics in a shape the server accepts', async () => {
  assert.equal(messagesEndpoint('https://x.example/metrics'), 'https://x.example/messages');
  assert.equal(messagesEndpoint('https://x.example/prod/metrics'), 'https://x.example/prod/messages');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-fb-'));
  let call;
  const fetchFn = async (url, init) => { call = { url, body: JSON.parse(init.body) }; return { ok: true, status: 202 }; };
  const r = await sendUninstallFeedback('  too slow on my repo  ', { home, endpoint: 'https://x.example/messages', fetchFn });
  assert.equal(r.sent, true);
  assert.equal(call.url, 'https://x.example/messages');
  const m = normalizeMessage(call.body);
  assert.equal(m.page, '/cli/uninstall');
  assert.match(m.message, /^too slow on my repo\n\n\(thinker \S+, install [0-9a-f-]{36}, \w+\)$/);
  assert.deepEqual(await sendUninstallFeedback('   ', { home, fetchFn }), { sent: false, reason: 'empty' });
});

function tty(answer) {
  const stdin = new PassThrough(); stdin.isTTY = true;
  if (answer != null) setImmediate(() => stdin.write(answer + '\n'));
  return stdin;
}

test('the uninstall question is asked only in a terminal, and only a typed reason is sent', async () => {
  const sent = [], lines = [];
  const sendFn = async m => { sent.push(m); return { sent: true }; };
  const out = l => lines.push(l);
  const stdout = new PassThrough();
  const notTty = new PassThrough();
  await askUninstallFeedback({ flags: {}, out }, { stdin: notTty, stdout, sendFn });
  await askUninstallFeedback({ flags: { yes: true }, out }, { stdin: tty(null), stdout, sendFn });
  await askUninstallFeedback({ flags: {}, out }, { stdin: tty(''), stdout, sendFn });
  assert.deepEqual(sent, []);
  await askUninstallFeedback({ flags: {}, out }, { stdin: tty('missing Zed support'), stdout, sendFn });
  assert.deepEqual(sent, ['missing Zed support']);
  assert.match(lines.at(-1), /Thank you/);
});

// Note: reportUninstall was removed in favor of direct sendTelemetry during uninstallCommand
