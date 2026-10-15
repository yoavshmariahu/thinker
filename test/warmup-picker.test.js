import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema, ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';
import { Store } from '../src/store.js';

// Codex's own question tool is off outside plan mode, so the warm-up offer tells it to call thinker's
// `warmup` tool, and the server puts the three choices to the person through MCP elicitation
// (mcp.js:warmup, repo-onboard.js:answerWarmup). The tool is offered only while an offer may wait for its answer.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function machine(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-warmup-picker-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home'), repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true }); fs.mkdirSync(home);
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  for (let i = 0; i < 8; i++) { fs.writeFileSync(path.join(repo, 'src/a.js'), `export const n = ${i};\n`); git('add', '-A'); git('commit', '-qm', `c${i}`); }
  const env = { ...process.env, HOME: home, THINKER_HOME: path.join(home, '.thinker'), THINKER_TELEMETRY: 'off', THINKER_LOG: 'local', THINKER_NO_LEARN: '1', THINKER_REPO: repo };
  return { repo, env, home: env.THINKER_HOME, store: new Store(repo).init() };
}

async function connect(t, env, repo, { answer, root } = {}) {
  const client = new Client({ name: 'codex-mcp-client', version: '0' }, { capabilities: { ...(answer === undefined ? {} : { elicitation: {} }), ...(root ? { roots: {} } : {}) } });
  if (root) client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(root).href }] }));
  const asked = [];
  if (answer !== undefined) client.setRequestHandler(ElicitRequestSchema, async req => { asked.push(req.params); return answer; });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'src/mcp.js')], env, cwd: repo, stderr: 'ignore' }));
  t.after(() => client.close());
  return { client, asked, call: async args => (await client.callTool({ name: 'warmup', arguments: args })).content[0].text };
}
const answers = store => (fs.existsSync(path.join(store.dir, 'log.jsonl')) ? fs.readFileSync(path.join(store.dir, 'log.jsonl'), 'utf8') : '').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => e.op === 'warmup-answer');

test('a server started outside a repository registers warmup after binding by a call or roots', async t => {
  for (const viaRoots of [false, true]) {
    const { repo, env, store } = machine(t);
    const { client, call } = await connect(t, { ...env, THINKER_REPO: '', CLAUDE_PROJECT_DIR: '' }, env.HOME, { root: viaRoots ? repo : undefined });
    if (viaRoots) {
      // Root discovery completes asynchronously after initialization.
      for (let i = 0; i < 100 && !(await client.listTools()).tools.some(x => x.name === 'warmup'); i++) await new Promise(r => setTimeout(r, 10));
    } else {
      assert.ok(!(await client.listTools()).tools.some(x => x.name === 'warmup'));
      await client.callTool({ name: 'orient', arguments: { task: 'where is the API', cwd: repo } });
    }
    assert.ok((await client.listTools()).tools.some(x => x.name === 'warmup'));
    assert.match(await call({ choice: 'no' }), /no warm-up for this repository/);
    assert.equal(answers(store).length, 1);
  }
});

test('the picker shows the three choices; the answer is acted on, logged, and the tool goes away', async t => {
  const { repo, env, store } = machine(t);
  const { client, asked, call } = await connect(t, env, repo, { answer: { action: 'accept', content: { choice: 'No' } } });
  assert.ok((await client.listTools()).tools.some(x => x.name === 'warmup'), 'offered while the cold cache has no answer');
  assert.match(await call({}), /no warm-up for this repository/);
  assert.deepEqual(asked[0].requestedSchema.properties.choice.enum, ['Warm up cache', 'No', "Don't ask again"]);
  assert.deepEqual(answers(store).map(e => [e.choice, e.via, e.client]), [['no', 'picker', 'codex-mcp-client']]);
  const again = await connect(t, env, repo);
  assert.ok(!(await again.client.listTools()).tools.some(x => x.name === 'warmup'), 'answered: not offered in the next session');
});

test('closing the picker is logged as dismissed; "Don\'t ask again" stops offers on the machine', async t => {
  const { repo, env, store, home } = machine(t);
  const closed = await connect(t, env, repo, { answer: { action: 'cancel' } });
  assert.match(await closed.call({}), /^Dismissed/);
  assert.equal(answers(store)[0].choice, 'dismissed');

  const other = machine(t);
  const env2 = { ...other.env, HOME: env.HOME, THINKER_HOME: home };
  const never = await connect(t, env2, other.repo, { answer: { action: 'accept', content: { choice: "Don't ask again" } } });
  assert.match(await never.call({}), /will not offer a warm-up again in any repository/);
  assert.ok(fs.existsSync(path.join(home, 'state', 'warmup-never')));
});

test('a client without elicitation is told to ask in chat and call again with the choice', async t => {
  const { repo, env, store } = machine(t);
  const { call } = await connect(t, env, repo);
  assert.match(await call({}), /cannot show thinker's picker\. Ask the user in chat/);
  assert.equal(answers(store).length, 0, 'nothing recorded before an answer');
  assert.match(await call({ choice: 'no' }), /no warm-up for this repository/);
  assert.deepEqual(answers(store).map(e => [e.choice, e.via]), [['no', 'text']]);
});

test('an answer from the agent\'s own question tool comes through the tool as a picker answer', async t => {
  const { repo, env, store } = machine(t);
  const { call } = await connect(t, env, repo);
  assert.match(await call({ choice: 'Never', asked: 'picker' }), /will not offer a warm-up again in any repository/);
  assert.deepEqual(answers(store).map(e => [e.choice, e.via, e.client]), [['never', 'picker', 'codex-mcp-client']]);
});
