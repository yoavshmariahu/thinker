import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { servedSummary } from '../src/commands/external.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const run = (args, opts = {}) => execFileSync('node', [CLI, ...args], { encoding: 'utf8', env: { ...process.env, THINKER_TEST: '1' }, ...opts });
const checkout = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-ext-'));
  execFileSync('git', ['init', '-q', d]);
  fs.mkdirSync(path.join(d, '.thinker'));
  return d;
};

test('served: counts what the checkout log says each hook and tool served', () => {
  const d = checkout();
  fs.writeFileSync(path.join(d, '.thinker', 'log.jsonl'), [
    { op: 'orient', session: 's1', served: ['a', 'b'] },
    { op: 'orient', served: ['c'] },
    { op: 'lookup', served: ['a'] },
    { op: 'late', served: ['d'] },
  ].map(l => JSON.stringify(l)).join('\n') + '\nnot json\n');
  assert.deepEqual(servedSummary(path.join(d, '.thinker')), { injected: ['a', 'b', 'c', 'd'], hookServed: 2, lateServed: 1, orientCalls: 1, lookupCalls: 1 });
  assert.deepEqual(JSON.parse(run(['served', '--json', '--repo', d])).injected, ['a', 'b', 'c', 'd']);
});

test('served: a checkout with no log served nothing', () => {
  assert.deepEqual(servedSummary(path.join(checkout(), '.thinker')), { injected: [], hookServed: 0, lateServed: 0, orientCalls: 0, lookupCalls: 0 });
});

test('version: the package version, and the commit from a checkout', () => {
  const v = JSON.parse(run(['version', '--json']));
  assert.equal(v.version, JSON.parse(fs.readFileSync(path.join(path.dirname(CLI), '..', 'package.json'), 'utf8')).version);
  assert.match(String(v.commit), /^[0-9a-f]{40}$/);
  assert.match(run(['--version']), /^thinker \d+\.\d+\.\d+/);
});

test('guide: prints the usage guidance an install writes', () => {
  assert.match(run(['guide', '--repo', checkout()]), /Use thinker as a map to the code/);
});

test('mcp: the server answers initialize on stdio', async () => {
  const d = checkout();
  const p = spawn('node', [CLI, 'mcp'], { env: { ...process.env, THINKER_TEST: '1', THINKER_REPO: d } });
  const reply = await new Promise((resolve, reject) => {
    let o = '';
    const timer = setTimeout(() => reject(new Error('no reply: ' + o)), 20_000);
    p.stdout.on('data', c => { o += c; if (o.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(o.split('\n')[0])); } });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) + '\n');
  }).finally(() => p.kill());
  assert.equal(reply.result.serverInfo.name, 'thinker');
});
