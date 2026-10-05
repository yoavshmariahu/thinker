import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Store } from '../src/store.js';
import { renderNote, estTokens } from '../src/rank.js';
import { createNote, orient, lookup, drilldown, find, lateNotes } from '../src/ops.js';
import { beginPrompt, currentPrompt, promptScope, withPromptDelivery } from '../src/prompt-delivery.js';

Object.assign(process.env, { THINKER_TELEMETRY: 'off', THINKER_NO_LEARN: '1', THINKER_NO_AUTO_UPDATE: '1', THINKER_NO_BG_VERIFY: '1', THINKER_LOG: 'local', THINKER_CE: 'off' });
const body = 'Unique delivery evidence: src/a.js:inviteMember validates organization member email before creating an invitation.';
function fixture(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-prompt-delivery-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', repo]);
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/a.js'), 'export function inviteMember(email) { return email.trim(); }\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  const store = new Store(repo).init(); fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ ce: false, snippets: false }));
  const n = createNote(store, { kind: 'rule', title: 'Organization invitation member email validation', answers: ['organization invitation member email validation'], body, deps: [{ path: 'src/a.js', symbol: 'inviteMember' }] });
  assert.ok(n.note, JSON.stringify(n));
  return { store, repo, note: n.note };
}
const query = 'organization invitation member email validation';
const call = (store, id, fn) => withPromptDelivery(store, id, fn);

test('orient then lookup/drilldown does not resend a body; next prompt and changed body do', async t => {
  const { store, note } = fixture(t), id = beginPrompt(store, 's');
  const r = await call(store, id, delivery => orient(store, { task: query, maxNotes: 5, delivery }));
  assert.match(r.text, /Unique delivery evidence/);
  assert.equal((await call(store, id, delivery => lookup(store, { query: note.id, delivery }))).included.length, 0);
  assert.doesNotMatch((await call(store, id, delivery => drilldown(store, { pointer: 'src/a.js:inviteMember', delivery }))).text, /Unique delivery evidence/);
  const next = beginPrompt(store, 's'); assert.notEqual(next, id); assert.equal(currentPrompt(store, 's'), next);
  assert.match((await call(store, next, delivery => lookup(store, { query: note.id, delivery }))).text, /Unique delivery evidence/);
  store.put({ ...store.get(note.id), body: body + '\nNew rule: retain the original casing.' });
  assert.match((await call(store, next, delivery => lookup(store, { query: note.id, delivery }))).text, /New rule/);
});

test('find titles and a too-small budget do not consume a note; drilldown body does', async t => {
  const { store, note } = fixture(t), id = beginPrompt(store, 's');
  await call(store, id, delivery => find(store, { query: 'inviteMember', delivery }));
  const tiny = await call(store, id, delivery => lookup(store, { query: note.id, budget: 1, delivery }));
  assert.equal(tiny.included.length, 0);
  const d = await call(store, id, delivery => drilldown(store, { pointer: 'src/a.js:inviteMember', delivery, budget: 8000 }));
  assert.match(d.text, /Unique delivery evidence/);
  assert.equal((await call(store, id, delivery => lookup(store, { query: note.id, delivery }))).included.length, 0);
});

test('parallel calls share a ledger, while separate prompts and connections are isolated', async t => {
  const { store, note } = fixture(t), id = beginPrompt(store, 's');
  const results = await Promise.all(Array.from({ length: 4 }, () => call(store, id, async delivery => { await new Promise(r => setTimeout(r, 15)); return lookup(store, { query: note.id, delivery }); })));
  assert.equal(results.reduce((n, r) => n + r.included.length, 0), 1);
  assert.equal(promptScope(store, id, 'connection1'), id);
  assert.notEqual(promptScope(store, 'turn1', 'connection1'), promptScope(store, 'turn1', 'connection2'));
  assert.equal((await call(store, beginPrompt(store, 'other-session'), delivery => lookup(store, { query: note.id, delivery }))).included.length, 1);
  await assert.rejects(call(store, 'failure', () => { throw new Error('failed delivery'); }), /failed delivery/);
  assert.equal((await call(store, 'failure', delivery => lookup(store, { query: note.id, delivery }))).included.length, 1);
});

test('MCP tools share the hook delivery scope and reset for a later user prompt', async t => {
  const { store, repo, note } = fixture(t);
  const hook = execFileSync(process.execPath, [new URL('../src/cli.js', import.meta.url).pathname, 'hook', 'prompt', '--client', 'codex', '--repo', repo], {
    cwd: repo, env: { ...process.env, THINKER_HOME: path.join(repo, 'home') }, input: JSON.stringify({ session_id: 'hook-session', prompt: query }), encoding: 'utf8',
  });
  assert.match(hook, /Unique delivery evidence/);
  const id = hook.match(/Thinker prompt_id: ([\w-]+)/)?.[1]; assert.ok(id);
  const transport = new StdioClientTransport({ command: process.execPath, args: [new URL('../src/mcp.js', import.meta.url).pathname], cwd: repo, env: { ...process.env, THINKER_REPO: repo, THINKER_HOME: path.join(repo, 'home') }, stderr: 'pipe' });
  const client = new Client({ name: 'delivery-test', version: '1' });
  t.after(async () => { await client.close(); });
  await client.connect(transport);
  const ask = async (name, args, prompt_id = id) => (await client.callTool({ name, arguments: { ...args, prompt_id } })).content.map(c => c.text || '').join('\n');
  assert.match(await ask('lookup', { query: note.id }), /already in your context/);
  const drilled = await ask('drilldown', { pointer: 'src/a.js:inviteMember', budget: 14000 });
  assert.doesNotMatch(drilled, /Unique delivery evidence|Input validation error/);
  assert.match(drilled, /function inviteMember/);
  const next = beginPrompt(store, 'hook-session');
  const [a, b] = await Promise.all([ask('orient', { task: query, budget: 3000 }, next), ask('lookup', { query: note.id }, next)]);
  assert.equal([a, b].filter(s => s.includes('Unique delivery evidence')).length, 1);
  // A miss still carries a new boundary rather than silently reusing the previous prompt.
  const miss = execFileSync(process.execPath, [new URL('../src/cli.js', import.meta.url).pathname, 'hook', 'prompt', '--client', 'codex', '--repo', repo], { cwd: repo, env: process.env, input: JSON.stringify({ session_id: 'hook-session', prompt: 'hello' }), encoding: 'utf8' });
  assert.match(miss, /Thinker prompt_id:/); assert.doesNotMatch(miss, /Unique delivery evidence/);
});

test('edit-time hooks also omit notes already delivered by MCP', async t => {
  const { store, repo, note } = fixture(t), id = beginPrompt(store, 's');
  await call(store, id, delivery => lookup(store, { query: note.id, delivery }));
  const r = await call(store, id, delivery => lateNotes(store, { session: 's', files: [path.join(repo, 'src/a.js')], edited: true, delivery }));
  assert.equal(r.included.length, 0);
});

// A budget-truncated preview must not block a later request for the missing body.
test('a short preview can be expanded once, without repeating the full note later', async t => {
  const { store, note } = fixture(t), id = beginPrompt(store, 's');
  const long = { ...note, body: body + '\n' + 'More essential details. '.repeat(200) }; store.put(long);
  const previewBudget = estTokens(renderNote(long, { full: false })) + 1;
  const preview = await call(store, id, delivery => lookup(store, { query: note.id, budget: previewBudget, delivery }));
  assert.equal(preview.included.length, 1); assert.equal(preview.complete.length, 0);
  const full = await call(store, id, delivery => lookup(store, { query: note.id, budget: 8000, delivery }));
  assert.match(full.text, /More essential details/);
  assert.equal((await call(store, id, delivery => lookup(store, { query: note.id, budget: 8000, delivery }))).included.length, 0);
});
