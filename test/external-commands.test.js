import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { servedSummary, spentSummary } from '../src/commands/external.js';

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
  assert.match(run(['guide', '--repo', checkout()]), /Use thinker's notes as a map to the code/);
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

test('spent: sums the model calls a checkout logged, and what mining and understanding did', () => {
  const d = checkout();
  fs.mkdirSync(path.join(d, '.thinker', 'state'));
  fs.writeFileSync(path.join(d, '.thinker', 'log.jsonl'), [
    { op: 'model', tokens: { inputTokens: 100, cacheReadTokens: 40, outputTokens: 10 } },
    { op: 'mine-prs', prs: 5, saved: 3 },
  ].map(l => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(path.join(d, '.thinker', 'state', 'log.jsonl'), JSON.stringify({ op: 'understand', files: 7, saved: 2 }) + '\n' + JSON.stringify({ op: 'model', tokens: { inputTokens: 1, outputTokens: 1 } }) + '\n');
  assert.deepEqual(spentSummary(path.join(d, '.thinker')), { tokens: 112, input: 101, cached: 40, output: 11, calls: 2, mined: 5, files: 7, saved: 5 });
  assert.equal(JSON.parse(run(['spent', '--json', '--repo', d])).calls, 2);
});

test('export --dir: every note whole, one file each', () => {
  const d = checkout();
  fs.writeFileSync(path.join(d, 'a.py'), 'def f():\n    return 1\n');
  execFileSync('git', ['-C', d, 'add', '-A']);
  execFileSync('git', ['-C', d, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base']);
  run(['add', '--repo', d], { input: JSON.stringify({ title: 'f returns one', body: 'a.py:f returns 1.', kind: 'howto', deps: [{ path: 'a.py' }] }) });
  const out = path.join(d, '..', path.basename(d) + '-notes');
  assert.match(run(['export', '--dir', out, '--repo', d]), /exported 1 notes/);
  const files = fs.readdirSync(out);
  assert.equal(files.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, files[0]), 'utf8')).title, 'f returns one');
});
