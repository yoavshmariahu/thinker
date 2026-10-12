import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { batchProgress, buildProgress, BUILD_SECONDS } from '../src/progress.js';

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

test('a batch with an onProgress listener tells it every start and completion, and draws no heartbeat of its own', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const dir = temp(t), lines = [], seen = [];
  const p = batchProgress({ dir, name: 'PR mining', total: 3, out: s => lines.push(s), onProgress: x => seen.push({ ...x }) });
  p.start('PR #1'); p.complete({ notes: ['a'] }); p.start('PR #2');
  t.mock.timers.tick(120_000);
  assert.deepEqual(seen.map(x => [x.completed, x.total, x.current, x.saved]), [[0, 3, 'PR #1', 0], [1, 3, 'PR #1', 1], [1, 3, 'PR #2', 1]]);
  assert.ok(!lines.some(l => /working on/.test(l)), 'no heartbeat lines: the bar shows the item');
  p.complete({ notes: [] }); p.start('PR #3'); p.complete({ notes: ['b'] }); p.finish();
  assert.equal(seen.at(-1).completed, 3);
});

test('the build progress model: stage budgets, a counted stage at its own pace, skipped stages, and the text', () => {
  let t = 0; const now = () => t * 1000;
  const prog = buildProgress({ mineSeconds: 400, docs: 8, now });
  // nothing started: everything ahead
  assert.deepEqual(prog.now(), { fraction: 0, left: 400 + BUILD_SECONDS.finish + 8 * BUILD_SECONDS.perDoc, text: '' });
  prog.stage('mine', { total: 10, text: 'Mining merged pull requests' });
  t = 40; prog.update({ done: 2, current: '#3 Area warming' });
  let p = prog.now();
  assert.equal(p.text, 'Mining merged pull requests 2/10 · #3 Area warming');
  assert.equal(p.left, 160 + 75 + 48, 'the batch at its pace, then the budgets of the stages ahead');
  assert.ok(p.fraction > 0.14 && p.fraction < 0.16, String(p.fraction));
  // the finish stage has no count: it creeps and never reaches its budget
  t = 400; prog.stage('finish', { text: 'Linking notes' });
  t = 470; p = prog.now();
  assert.ok(p.fraction > 0.85 && p.fraction < 0.95, String(p.fraction)); assert.equal(p.left, 5 + 48); assert.equal(p.text, 'Linking notes');
  // the documents, counted
  t = 480; prog.stage('docs', { text: 'Reading design documents' }); prog.update({ total: 8, current: 'README.md' });
  t = 492; prog.update({ done: 2 });
  p = prog.now();
  assert.equal(p.text, 'Reading design documents 2/8 · README.md'); assert.equal(p.left, 36);
  assert.ok(p.fraction > 0.9 && p.fraction < 1, String(p.fraction));
  // a skipped stage costs nothing
  const quick = buildProgress({ mineSeconds: 100, docs: 0, now }); quick.skip('mine'); quick.stage('finish', { text: 'x' });
  assert.equal(quick.now().left, 75);
});
