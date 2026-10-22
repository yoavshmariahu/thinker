import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import thinkerPackage, { findCli, INSTALL_HINT } from '../npm/pi/thinker.js';

const cli = path.resolve('src/cli.js');
const fakePi = () => { const handlers = {}; return { handlers, on: (ev, fn) => { handlers[ev] = fn; } }; };

test('the pi package registers the four events and serves them through the installed extension module', async () => {
  const pi = fakePi();
  thinkerPackage(pi, { cli, yieldTo: false });
  assert.deepEqual(Object.keys(pi.handlers), ['before_agent_start', 'tool_result', 'agent_end', 'session_shutdown']);
  // a user-scope hook in test mode serves nothing: the event goes through to the module and comes back empty
  const ctx = { sessionManager: { getSessionId: () => 'pi-pkg' }, cwd: process.cwd(), hasUI: false };
  assert.equal(await pi.handlers.before_agent_start({ prompt: 'task' }, ctx), undefined);
  assert.equal(await pi.handlers.session_shutdown({}, ctx), undefined);
});

test('the pi package yields to the extension thinker connect wrote, and says once where thinker is missing', async () => {
  const quiet = fakePi();
  thinkerPackage(quiet, { cli, yieldTo: true });
  assert.deepEqual(Object.keys(quiet.handlers), []);
  const missing = fakePi();
  thinkerPackage(missing, { cli: null, yieldTo: false });
  assert.deepEqual(Object.keys(missing.handlers), ['before_agent_start']);
  const notices = [];
  const ctx = { hasUI: true, ui: { notify: (text, kind) => notices.push([text, kind]) } };
  await missing.handlers.before_agent_start({ prompt: 'a' }, ctx);
  await missing.handlers.before_agent_start({ prompt: 'b' }, ctx);
  assert.deepEqual(notices, [[INSTALL_HINT, 'warning']]);
});

test('findCli reads THINKER_CLI, then THINKER_HOME/app', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-pi-home-'));
  assert.equal(findCli({ THINKER_CLI: cli }), cli);
  assert.equal(findCli({ THINKER_CLI: path.join(home, 'nope.js') }), null);
  const prev = process.env.THINKER_HOME; process.env.THINKER_HOME = home;
  try {
    assert.equal(findCli({}), null);
    fs.mkdirSync(path.join(home, 'app', 'src'), { recursive: true });
    fs.writeFileSync(path.join(home, 'app', 'src', 'cli.js'), '');
    assert.equal(findCli({}), path.join(home, 'app', 'src', 'cli.js'));
  } finally { if (prev === undefined) delete process.env.THINKER_HOME; else process.env.THINKER_HOME = prev; }
});
