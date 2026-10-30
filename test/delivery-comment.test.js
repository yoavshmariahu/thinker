import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { deliveryFile } from '../src/delivery-journal.js';
import { commentOnPr, commentMarker } from '../src/delivery-comment.js';

const now = Date.now();
const at = days => new Date(now - days * 86400_000).toISOString();

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-comment-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'], { cwd: dir });
  const store = new Store(dir).init(), home = path.join(dir, 'home');
  store.log({ op: 'orient', t: at(2), session: 'private-session-id', branch: 'fix', head: 'commit1', served: ['private-note'], est: [[2, 9000]] });
  store.log({ op: 'attest', t: at(1), session: 'private-session-id', applied: [{ id: 'private-note', verdict: 'confirmed' }] });
  fs.mkdirSync(path.join(home, 'state', 'compression'), { recursive: true });
  fs.writeFileSync(path.join(home, 'state', 'compression', 'private-session-id.json'), JSON.stringify({ saved: 120000 }));
  const pull = { number: 42, state: 'closed', created_at: at(5), updated_at: at(1), merged_at: at(1), head: { ref: 'fix', sha: 'commit1' }, base: { sha: 'base' } };
  const reads = [], writes = [], comments = [];
  const request = async (endpoint, options) => {
    reads.push({ endpoint, options });
    if (endpoint.startsWith('repos/owner/repo/pulls?')) return [pull];
    if (endpoint === 'repos/owner/repo/pulls/42') return pull;
    if (endpoint.includes('/commits?')) return [[{ sha: 'commit1' }]];
    if (endpoint === 'user') return { id: 7 };
    if (endpoint.includes('/comments?')) return [[], comments]; // marker can be on a later page
    throw new Error(`Unexpected read: ${endpoint}`);
  };
  const write = async (endpoint, options) => {
    writes.push({ endpoint, ...options });
    const old = comments.find(c => endpoint.endsWith(`/comments/${c.id}`));
    if (old) old.body = options.body;
    else comments.push({ id: 99, user: { id: 7 }, body: options.body, html_url: 'https://github.com/owner/repo/pull/42#issuecomment-99' });
    return old || comments.at(-1);
  };
  const options = { pr: 42, now, home, request, write };
  return { dir, store, home, pull, reads, writes, comments, options };
}

test('preview refreshes the PR but publishes nothing, and discloses evidence without private details', async t => {
  const f = fixture(t);
  const result = await commentOnPr(f.store, { ...f.options, dry: true });
  assert.equal(result.action, 'preview');
  assert.equal(f.writes.length, 0);
  assert.equal(f.reads.length, 3);
  assert.match(result.body, /120,000 prompt tokens.*measured/);
  assert.match(result.body, /9,000 file-reading tokens.*estimated/);
  assert.match(result.body, /1 linked session.*last 30 days/);
  assert.match(result.body, /session totals attributed to this PR/);
  assert.match(result.body, /rewrite costs are not deducted/);
  for (const secret of [f.dir, os.hostname(), 'private-session-id', 'private-note', 'commit1']) assert.ok(!result.body.includes(secret), secret);
});

test('posting, identical rerun and later savings use one paginated comment with POST then PATCH', async t => {
  const f = fixture(t);
  const first = await commentOnPr(f.store, f.options);
  assert.equal(first.action, 'posted');
  assert.equal(f.writes[0].endpoint, 'repos/owner/repo/issues/42/comments');
  assert.equal(f.writes[0].method, 'POST');
  assert.equal((await commentOnPr(f.store, f.options)).action, 'unchanged');
  assert.equal(f.writes.length, 1);
  fs.writeFileSync(path.join(f.home, 'state', 'compression', 'private-session-id.json'), JSON.stringify({ saved: 150000 }));
  const updated = await commentOnPr(f.store, f.options);
  assert.equal(updated.action, 'updated');
  assert.match(updated.body, /150,000 prompt tokens/);
  assert.equal(f.writes[1].endpoint, 'repos/owner/repo/issues/comments/99');
  assert.equal(f.writes[1].method, 'PATCH');
  assert.equal(f.comments.length, 1);
  assert.ok(f.reads.filter(r => r.endpoint.includes('/comments?')).every(r => r.options.paginate));
});

test('never edits a different author or a different machine comment', async t => {
  const f = fixture(t);
  f.comments.push({ id: 1, user: { id: 8 }, body: commentMarker(f.home) + '\nexisting' });
  f.comments.push({ id: 2, user: { id: 7 }, body: commentMarker(path.join(f.home, 'other')) + '\nexisting' });
  assert.equal((await commentOnPr(f.store, f.options)).action, 'posted');
  assert.equal(f.comments[0].body, commentMarker(f.home) + '\nexisting');
  assert.equal(f.comments[1].body, commentMarker(path.join(f.home, 'other')) + '\nexisting');
});

test('open, closed-unmerged, absent sessions, zero savings and damaged records cannot publish', async t => {
  const f = fixture(t);
  for (const state of ['open', 'closed']) {
    f.pull.state = state; f.pull.merged_at = null;
    await assert.rejects(commentOnPr(f.store, f.options), /not merged/);
  }
  f.pull.merged_at = at(1);
  f.pull.head = { ref: 'unrelated', sha: 'other' };
  const withoutCommits = async (endpoint, opts) => endpoint.includes('/commits?') ? [[]] : f.options.request(endpoint, opts);
  await assert.rejects(commentOnPr(f.store, { ...f.options, request: withoutCommits }), /No recorded sessions/);
  f.pull.head = { ref: 'fix', sha: 'commit1' };
  f.store.log({ op: 'attest', t: at(0), session: 'private-session-id', applied: [{ id: 'private-note', verdict: 'unused' }] });
  fs.writeFileSync(path.join(f.home, 'state', 'compression', 'private-session-id.json'), JSON.stringify({ saved: 0 }));
  await assert.rejects(commentOnPr(f.store, f.options), /No savings recorded/);
  fs.appendFileSync(deliveryFile(f.store), 'broken record\n');
  await assert.rejects(commentOnPr(f.store, f.options), /incomplete delivery records/);
  assert.equal(f.writes.length, 0);
});

test('missing PR and invalid window fail before GitHub; wider windows include older sessions', async t => {
  const f = fixture(t);
  await assert.rejects(commentOnPr(f.store, { ...f.options, pr: undefined }), /requires --pr/);
  await assert.rejects(commentOnPr(f.store, { ...f.options, days: true }), /positive integer/);
  assert.equal(f.reads.length, 0);
  const later = now + 60 * 86400_000;
  await assert.rejects(commentOnPr(f.store, { ...f.options, now: later }), /No recorded sessions/);
  const preview = await commentOnPr(f.store, { ...f.options, now: later, days: 90, dry: true });
  assert.match(preview.body, /last 90 days/);
});

test('concurrent runs refuse a held lock and errors release it for retry', async t => {
  const f = fixture(t);
  const lock = `${deliveryFile(f.store)}.comment-42.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, 'held');
  await assert.rejects(commentOnPr(f.store, f.options), /holds .*lock/);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'held');
  fs.unlinkSync(lock);
  await assert.rejects(commentOnPr(f.store, { ...f.options, write: () => { throw new Error('permission denied'); } }), /permission denied/);
  assert.equal(fs.existsSync(lock), false);
  assert.equal((await commentOnPr(f.store, f.options)).action, 'posted');
});

test('CLI parses dry before the subcommand, previews JSON and sends the exact body through gh stdin', t => {
  const f = fixture(t);
  const bin = path.join(f.dir, 'bin'); fs.mkdirSync(bin);
  const calls = path.join(f.dir, 'gh-calls.jsonl');
  const stub = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = args.includes('--input') ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({args,input}) + '\\n');
const endpoint = args.find(a => a.startsWith('repos/'));
let result;
if (args.includes('--method')) result = { html_url: 'https://github.com/owner/repo/pull/42#issuecomment-99' };
else if (args.includes('user')) result = { id: 7 };
else if (endpoint?.includes('/comments?')) result = [[]];
else if (endpoint?.includes('/commits?')) result = [[{sha:'commit1'}]];
else if (endpoint?.includes('/pulls?')) result = [${JSON.stringify(f.pull)}];
else if (endpoint?.endsWith('/pulls/42')) result = ${JSON.stringify(f.pull)};
else process.exit(3);
process.stdout.write(JSON.stringify(result));
`;
  fs.writeFileSync(path.join(bin, 'gh'), stub, { mode: 0o755 });
  const cli = path.resolve('src/cli.js');
  const run = args => spawnSync(process.execPath, [cli, 'prs', ...args], {
    cwd: f.dir, encoding: 'utf8', env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
      THINKER_HOME: f.home, THINKER_LOG: path.join(f.store.dir, 'log.jsonl'), THINKER_TEST: '1', THINKER_TELEMETRY: 'off' },
  });
  const preview = run(['--dry', 'comment', '--pr', '42', '--days', '90', '--json']);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).action, 'preview');
  assert.ok(!fs.readFileSync(calls, 'utf8').includes('--method'));
  const posted = run(['comment', '--pr', '42', '--days', '90', '--json']);
  assert.equal(posted.status, 0, posted.stderr);
  const result = JSON.parse(posted.stdout);
  assert.equal(result.action, 'posted');
  const mutation = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse).find(c => c.args.includes('--method'));
  assert.deepEqual(mutation.args, ['api', '--method', 'POST', 'repos/owner/repo/issues/42/comments', '--input', '-']);
  assert.equal(JSON.parse(mutation.input).body, result.body);
});
