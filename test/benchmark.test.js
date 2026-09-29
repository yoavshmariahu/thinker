import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { createNote, orient } from '../src/ops.js';
import { benchmarkSuggestions, latestBenchmark, renderBenchmarkReport, runBenchmarkAgent, saveBenchmark } from '../src/benchmark.js';

const record = dir => ({
  version: 1, createdAt: '2026-09-28T00:00:00.000Z', repo: dir,
  task: 'explain uploads', agent: 'codex', model: null, notes: ['uploads'],
  runs: {
    baseline: { answer: 'baseline answer', wallMs: 10_000, turns: 4, toolCalls: 8, inputTokens: 1000, outputTokens: 200 },
    cache: { answer: 'cached answer', wallMs: 7_000, turns: 3, toolCalls: 5, inputTokens: 800, outputTokens: 180 },
  },
});

test('benchmark report compares paired runs without claiming correctness', () => {
  const text = renderBenchmarkReport(record('/repo/.thinker/benchmarks/run'));
  assert.match(text, /wall time\s+10s\s+7s\s+-30%/);
  assert.match(text, /tool calls\s+8\s+5\s+-37%/);
  assert.match(text, /rather than correctness/i);
});

test('benchmark artifacts preserve both answers and latest report', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-benchmark-'));
  const store = new Store(dir).init();
  const r = record(dir);
  saveBenchmark(store, r);
  assert.equal(latestBenchmark(store).task, r.task);
  assert.equal(fs.readFileSync(path.join(r.dir, 'baseline.md'), 'utf8'), 'baseline answer\n');
  assert.equal(fs.readFileSync(path.join(r.dir, 'thinker.md'), 'utf8'), 'cached answer\n');
  assert.match(fs.readFileSync(path.join(r.dir, 'report.txt'), 'utf8'), /input tokens/);
  assert.match(fs.readFileSync(path.join(store.dir, '.gitignore'), 'utf8'), /benchmarks\//);
});

test('Codex benchmark runner parses agent events and forces the read-only arm environment', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-benchmark-agent-'));
  const bin = path.join(dir, 'codex');
  fs.writeFileSync(bin, `#!/bin/sh
prompt=$(sed -n '1,200p')
case "$prompt" in *thinker-cache*) tokens=80 ;; *) tokens=100 ;; esac
printf '%s\n' '{"type":"item.started","item":{"type":"command_execution"}}'
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"answer"}}'
printf '{"type":"turn.completed","usage":{"input_tokens":%s,"cached_input_tokens":10,"output_tokens":20}}\n' "$tokens"
`, { mode: 0o755 });
  const old = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${old}`;
  try {
    const result = await runBenchmarkAgent('codex', { repo: dir, prompt: '<thinker-cache>note</thinker-cache>' });
    assert.equal(result.answer, 'answer');
    assert.equal(result.toolCalls, 1);
    assert.equal(result.inputTokens, 80);
    assert.equal(result.cachedInputTokens, 10);
  } finally { process.env.PATH = old; }
});

test('benchmark orientation does not count a serving or schedule stale-note verification', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-benchmark-orient-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/upload.js'), 'export function upload() { return true; }\n');
  const store = new Store(dir).init();
  const made = createNote(store, { title: 'Upload call path', kind: 'callpath', answers: ['how uploads work'], body: 'Uploads run through src/upload.js:upload.', deps: [{ path: 'src/upload.js', symbol: 'upload' }] });
  fs.writeFileSync(path.join(dir, 'src/upload.js'), 'export function upload() { return false; }\n');
  const result = await orient(store, { task: 'explain how uploads work', recordUsage: false, backgroundVerify: false });
  assert.equal(result.included.length, 1);
  const note = store.get(made.note.id);
  assert.equal(note.uses, 0);
  assert.equal(note.verifying, undefined);
  assert.equal(note.status, 'stale');
});

test('benchmark suggestions turn cached questions into alternative commands', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-benchmark-suggest-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/upload.js'), 'export function upload() { return true; }\n');
  const store = new Store(dir).init();
  createNote(store, { title: 'Upload request path', kind: 'callpath', answers: ['How does an upload move from authorization to persistence?'], body: 'Uploads run through src/upload.js:upload.', deps: [{ path: 'src/upload.js', symbol: 'upload' }], confidence: 0.8 });
  createNote(store, { title: 'Upload naming rule', kind: 'convention', answers: ['Which names should upload helpers use?'], body: 'The rule rests on src/upload.js:upload.', deps: [{ path: 'src/upload.js', symbol: 'upload' }], confidence: 0.9 });
  assert.deepEqual(benchmarkSuggestions(store, 2), [
    'How does an upload move from authorization to persistence?',
    'Which names should upload helpers use?',
  ]);
});
