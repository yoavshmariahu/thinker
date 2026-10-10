import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { batchProgress } from '../src/progress.js';

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-progress-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('batch output is bounded, keeps diagnostics, and stops heartbeat after completion', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const dir = temp(t), lines = [];
  const progress = batchProgress({ dir, name: 'PR mining', total: 12, out: s => lines.push(s) });
  progress.start('PR #1');
  t.mock.timers.tick(30_000);
  assert.match(lines.at(-1), /0\/12 processed.*still working on PR #1/);
  progress.complete({ notes: ['internal-note-id'] });
  for (let i = 2; i <= 12; i++) {
    progress.start(`PR #${i}`);
    progress.complete(i < 4 ? { error: '\x1b[31magy timed out\nraw details' } : {});
  }
  assert.deepEqual(progress.finish({ retry: 'Retry: thinker mine-prs' }), { saved: 1, failed: 2, processed: 12, empty: 9 });
  const text = lines.join('\n');
  assert.match(text, /12\/12 processed · 1 note saved · 9 with no new notes · 2 failed/);
  assert.match(text, /Warning: agent timed out \(2\)/);
  assert.doesNotMatch(text, /internal-note-id|raw details|\x1b/);
  assert.ok(lines.length < 12);
  const count = lines.length;
  t.mock.timers.tick(60_000);
  assert.equal(lines.length, count);
  const records = fs.readFileSync(lines.at(-1).trim().slice('Details: '.length), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.filter(r => r.event === 'complete').length, 12);
  assert.ok(records.some(r => r.notes?.includes('internal-note-id')));
  assert.ok(records.some(r => r.error?.includes('raw details')));
});

test('verbose output includes details and an empty batch has a readable log', t => {
  const dir = temp(t), lines = [];
  const p = batchProgress({ dir, name: 'PR mining', total: 0, out: s => lines.push(s), verbose: true });
  p.detail({ diagnostic: 'full detail' });
  p.finish();
  assert.match(lines.join('\n'), /full detail/);
  assert.ok(fs.existsSync(lines.at(-1).trim().slice('Details: '.length)));
});

test('mine-prs summarizes mixed outcomes and leaves failures unmarked', t => {
  const dir = temp(t);
  execFileSync('git', ['init', '-q', dir]);
  fs.writeFileSync(path.join(dir, 'source.js'), 'export function handle() { return true; }\n');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const prs = [23, 22, 21].map(number => ({ number, title: `Fix issue ${number}`, body: 'Detailed explanation of the fix. '.repeat(6), additions: 10, files: [{ path: 'source.js' }], mergedAt: `2026-01-${number}T00:00:00Z` }));
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}\nconst args = process.argv.slice(2); console.log(args.includes('list') ? ${JSON.stringify(JSON.stringify(prs))} : args.includes('api') ? '[]' : 'diff');\n`, { mode: 0o755 });
  const note = { title: 'Handle requests safely', kind: 'convention', body: 'Use source.js:handle for requests.', answers: ['How should requests be handled?'], applies: 'requests', deps: [{ path: 'source.js' }], tags: [], confidence: 0.9 };
  const model = path.join(bin, 'model');
  fs.writeFileSync(model, `#!${process.execPath}\nlet s = ''; for await (const chunk of process.stdin) s += chunk; if(s.includes('PR #23:')) { console.error('agy timed out\\nraw diagnostic'); process.exit(1); } console.log(JSON.stringify({ notes: s.includes('PR #21:') ? [${JSON.stringify(note)}] : [] }));\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, THINKER_LLM: 'command', THINKER_LLM_CMD: model, THINKER_LOG: 'off', THINKER_TELEMETRY: 'off', THINKER_HOME: path.join(dir, 'home') };
  const output = execFileSync(process.execPath, [path.resolve('src/cli.js'), 'mine-prs', 'owner/repo', '--repo', dir, '--limit', '3'], { env, encoding: 'utf8' });
  assert.match(output, /3\/3 processed · 1 note saved · 1 with no new notes · 1 failed/);
  assert.match(output, /Retry with: thinker mine-prs/);
  assert.doesNotMatch(output, /raw diagnostic|handle-requests-safely|Fix issue/);
  const registry = JSON.parse(fs.readFileSync(path.join(dir, '.thinker', 'prs.json'), 'utf8'));
  assert.deepEqual(registry['owner/repo'].mined, [21, 22]);
  const details = fs.readFileSync(output.split('\n').find(l => l.includes('Details:')).trim().slice('Details: '.length), 'utf8');
  assert.match(details, /raw diagnostic/);
  assert.match(details, /handle-requests-safely/);
});
