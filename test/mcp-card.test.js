import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Store } from '../src/store.js';
import { CACHE_CARD_URI, withCacheCard } from '../src/mcp-card.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function fixture(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-card-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repo, 'code.js'), 'x'.repeat(3600));
  fs.mkdirSync(path.join(repo, '.codex'));
  fs.writeFileSync(path.join(repo, '.codex', 'config.toml'), 'x'.repeat(3600));
  return repo;
}

test('card uses deduplicated notes and existing code-size accounting, never claims measured savings', t => {
  const repo = fixture(t), text = { content: [{ type: 'text', text: 'cached context' }] };
  const n = { id: 'one', title: '<script>untrusted</script>', deps: [{ path: 'code.js' }] };
  const r = withCacheCard(text, repo, [n, n, { id: 'two', title: 'Two', deps: n.deps }]);
  assert.equal(r.content, text.content);
  assert.equal(r.structuredContent.thinkerCacheHit.notes.length, 2);
  assert.equal(r.structuredContent.thinkerCacheHit.files, 1);
  assert.equal(r.structuredContent.thinkerCacheHit.codeTokens, 1000);
  assert.equal(withCacheCard(text, repo, []), text);
  assert.equal(withCacheCard(text, repo, [{ id: 'config', deps: [{ path: '.codex/config.toml' }] }]).structuredContent.thinkerCacheHit.codeTokensLabel, '');
});

test('real MCP server advertises an inline card and serves its HTML and actual lookup data', async t => {
  const repo = fixture(t);
  const store = new Store(repo).init();
  store.put({ id: 'cache-card-fixture', kind: 'rule', title: 'Card fixture', body: 'Code is here.', deps: [{ path: 'code.js' }] });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src/mcp-server.js')], cwd: repo,
    env: { ...process.env, THINKER_TEST: '1', THINKER_REPO: repo, THINKER_CACHE_CARD: '1', THINKER_LOG: 'off' }, stderr: 'pipe' });
  const client = new Client({ name: 'card-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  for (const name of ['orient', 'lookup']) {
    assert.equal(tools.find(t => t.name === name)._meta.ui.resourceUri, CACHE_CARD_URI);
    assert.equal(tools.find(t => t.name === name)._meta['openai/ui'].preferredModelDisplayMode, 'inline');
  }
  const resource = await client.readResource({ uri: CACHE_CARD_URI });
  assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.match(resource.contents[0].text, /ui\/notifications\/tool-result/);
  const result = await client.callTool({ name: 'lookup', arguments: { query: 'cache-card-fixture' } });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.thinkerCacheHit.notes[0].id, 'cache-card-fixture');
  assert.equal(result.structuredContent.thinkerCacheHit.codeTokens, 1000);
});


test('card resources and metadata are absent unless explicitly enabled', async t => {
  const repo = fixture(t);
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src/mcp-server.js')], cwd: repo,
    env: { ...process.env, THINKER_TEST: '1', THINKER_REPO: repo, THINKER_CACHE_CARD: '0', THINKER_LOG: 'off' }, stderr: 'pipe' });
  const client = new Client({ name: 'card-disabled-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal(client.getServerCapabilities().resources, undefined);
  for (const tool of (await client.listTools()).tools) assert.equal(tool._meta?.ui?.resourceUri, undefined);
});
