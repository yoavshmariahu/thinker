import { test } from 'node:test';
import assert from 'node:assert/strict';
import { piExtension } from '../src/integrations/pi.js';
import { opencodePlugin } from '../src/integrations/opencode.js';
import { hookRunner } from '../src/integrations/runner.js';
import { installClient } from '../src/clients.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const config = { cli, repo: process.cwd(), client: 'pi', hooks: true, learn: true, late: true, mcp: true, mcpEntry: { command: 'node', args: ['/thinker/mcp.js'], env: { THINKER_REPO: '/repo' } } };

test('Pi native handlers preserve results and capture prompt, tools, answer and shutdown', async () => {
  const handlers = {}, calls = [];
  const run = async (what, event) => { calls.push({ what, event }); return what === 'stop' ? '' : 'cached context'; };
  piExtension({ on: (event, handler) => { handlers[event] = handler; } }, config, run);
  const ctx = { sessionManager: { getSessionId: () => 'pi-session' } };
  const prompt = await handlers.before_agent_start({ prompt: 'my task' }, ctx);
  assert.match(prompt.message.content, /cached context/); assert.equal(prompt.message.display, false);
  const original = [{ type: 'text', text: 'original output' }];
  const result = await handlers.tool_result({ toolName: 'read', input: { path: 'a.js' }, content: original, isError: false }, ctx);
  assert.deepEqual(result.content, [...original, { type: 'text', text: 'cached context' }]);
  assert.equal(original.length, 1);
  await handlers.agent_end({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }] }, ctx);
  await handlers.session_shutdown({}, ctx);
  assert.equal(calls[0].event.session_id, 'pi-session');
  assert.equal(calls[2].event.last_assistant_message, 'done');
  assert.equal(calls[3].event.hook_event_name, 'SessionEnd');
});

test('OpenCode plugin handles concurrent session IDs and augments native context/MCP', async () => {
  const calls = [];
  const handlers = await opencodePlugin({ ...config, client: 'opencode' }, async (what, event) => { calls.push({ what, event }); return 'notes'; })();
  const c = { mcp: { other: { enabled: true } } }; await handlers.config(c);
  assert.equal(c.mcp.other.enabled, true); assert.deepEqual(c.mcp.thinker.command, ['node', '/thinker/mcp.js']);
  const first = { parts: [{ id: 'part1', type: 'text', text: 'task one' }] };
  await handlers['chat.message']({ sessionID: 'one' }, first);
  await handlers['chat.message']({ sessionID: 'two' }, { parts: [{ type: 'text', text: 'task two' }] });
  assert.equal(first.parts[0].text, 'task one\n\nnotes'); assert.equal(first.parts[0].id, 'part1');
  const output = { output: 'read result' };
  await handlers['tool.execute.after']({ sessionID: 'one', tool: 'read', args: { filePath: 'a.js' } }, output);
  assert.equal(output.output, 'read result\n\nnotes'); assert.equal(calls[2].event.tool_input.filePath, 'a.js');
  await handlers.event({ event: { type: 'session.idle', properties: { sessionID: 'two' } } });
  assert.equal(calls[3].event.session_id, 'two');
});

test('generated extension modules load and option flags suppress learning handlers', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-extensions-'));
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ type: 'module' }));
  for (const client of ['pi', 'opencode']) {
    installClient(client, { ...config, repo, client, learn: false, late: false, shared: true });
    const file = client === 'pi' ? '.pi/extensions/thinker.js' : '.opencode/plugins/thinker.js';
    const loaded = await import(pathToFileURL(path.join(repo, file)).href);
    if (client === 'pi') {
      const handlers = {}; loaded.default({ on: (ev, fn) => { handlers[ev] = fn; } });
      assert.deepEqual(Object.keys(handlers), ['before_agent_start', 'agent_end']);
    } else {
      const handlers = await loaded.default({});
      assert.equal(typeof handlers.event, 'function'); assert.equal(handlers['tool.execute.after'], undefined);
    }
  }
});

test('extension subprocess failures fail open and nested thinker calls are silent', async () => {
  const run = hookRunner({ ...config, cli: '/nonexistent/thinker-cli.js' });
  assert.equal(await run('prompt', { prompt: 'task' }), '');
  const before = process.env.THINKER_IN_LLM; process.env.THINKER_IN_LLM = '1';
  try { assert.equal(await hookRunner(config)('prompt', {}), ''); }
  finally { if (before === undefined) delete process.env.THINKER_IN_LLM; else process.env.THINKER_IN_LLM = before; }
});

test('extension runner launches Node even when the host executable is not Node', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-host-runtime-'));
  const script = path.join(repo, 'cli.cjs');
  fs.writeFileSync(script, "process.stdin.resume(); process.stdin.on('end', () => console.log('node works'));\n");
  const original = process.execPath;
  process.execPath = '/not/a/node/host';
  try { assert.equal(await hookRunner({ ...config, repo, cli: script })('prompt', {}), 'node works'); }
  finally { process.execPath = original; }
});


test('native extensions display stop notices with learning disabled', async () => {
  const cfg = { ...config, learn: false };
  const handlers = {}, notices = [];
  piExtension({ on: (name, fn) => { handlers[name] = fn; } }, cfg, async () => 'cache hit');
  await handlers.agent_end({ messages: [] }, { sessionManager: { getSessionId: () => 'pi' }, hasUI: true, ui: { notify: (text, kind) => notices.push([text, kind]) } });
  assert.deepEqual(notices, [['cache hit', 'info']]);
  assert.equal(handlers.session_shutdown, undefined);
  const toasts = [];
  let text = 'cache hit';
  const oc = await opencodePlugin({ ...cfg, client: 'opencode' }, async () => text)({ client: { tui: { showToast: async event => toasts.push(event) } } });
  await oc.event({ event: { type: 'session.idle', properties: { sessionID: 'oc' } } });
  assert.deepEqual(toasts, [{ body: { message: 'cache hit', variant: 'info' } }]);
  text = '';
  await oc.event({ event: { type: 'session.idle', properties: { sessionID: 'oc' } } });
  assert.equal(toasts.length, 1, 'empty output does not display a notice');
});
