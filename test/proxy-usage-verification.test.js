import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { responsesUsage, verifyResponsesUsage } from '../src/proxy-responses.js';

function row(write = 0, split) {
  const usage = { input_tokens: 250, input_tokens_details: { cached_tokens: 200, cache_write_tokens: write,
    ...(split ? { cache_write_tokens_details: split } : {}) }, output_tokens: 7 };
  return { op: 'proxy', protocol: 'responses', status: 200, responseId: 'r1', model: 'test-model',
    responseModel: 'test-model', serviceTier: 'default', responseStatus: 'completed', ...responsesUsage(usage) };
}

test('accounting gate accepts explicit zero and priced lifetime splits, including compaction', () => {
  const rows = [row(), { ...row(40, { ttl_30m_tokens: 10, ttl_12h_tokens: 30 }), responseId: 'r2', reason: 'native-compaction' }];
  assert.deepEqual(verifyResponsesUsage(rows), { complete: true, requests: 2, rawUsageVerified: true, uniqueResponses: true });
});

test('accounting gate rejects missing counters, duplicate responses, and partial or altered capture', () => {
  assert.throws(() => verifyResponsesUsage([]), /No Responses/);
  assert.throws(() => verifyResponsesUsage([row(), row()]), /duplicated/);
  assert.throws(() => verifyResponsesUsage([row(20)]), /lifetime breakdown/);
  assert.throws(() => verifyResponsesUsage([row(0, { ttl_30m_tokens: 0 })]), /lifetime breakdown/);
  for (const field of ['input', 'read', 'write', 'out', 'freshInput']) {
    assert.throws(() => verifyResponsesUsage([{ ...row(), [field]: undefined }]), /differs/);
    assert.throws(() => verifyResponsesUsage([{ ...row(), [field]: 999 }]), /differs/);
  }
  for (const mutation of [
    r => { delete r.apiUsage.input_tokens_details.cache_write_tokens; },
    r => { r.apiUsage.input_tokens_details.cache_write_tokens = 51; },
    r => { delete r.apiUsage; },
    r => { r.truncated = true; },
    r => { r.usageCaptureLimited = true; },
    r => { r.status = 500; },
    r => { delete r.responseId; },
    r => { delete r.serviceTier; },
    r => { r.responseStatus = 'incomplete'; },
  ]) {
    const r = row(); mutation(r); assert.throws(() => verifyResponsesUsage([r]));
  }
  const r = row(40, { ttl_30m_tokens: 10, ttl_12h_tokens: 30 });
  r.apiUsage.input_tokens_details.cache_write_tokens_details.ttl_12h_tokens = 20;
  assert.throws(() => verifyResponsesUsage([r]), /inconsistent/);
});

test('CLI verification returns nonzero with diagnostics; ordinary reports remain compatible', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'proxy.jsonl');
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const run = (...flags) => spawnSync(process.execPath, [cli, 'proxy', 'report', '--json', ...flags], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, THINKER_TEST: '1', THINKER_HOME: dir, THINKER_PROXY_LOG: log } });
  fs.writeFileSync(log, JSON.stringify({ ...row(), body: 'private prompt', headers: { authorization: 'secret' } }));
  const good = run('--verify-usage'); assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).usageValidation.complete, true);
  const captured = JSON.parse(good.stdout).apiRequests;
  assert.deepEqual(captured[0].apiUsage, row().apiUsage);
  assert.equal(captured[0].body, undefined); assert.equal(captured[0].headers, undefined);
  const missing = row(); delete missing.apiUsage.input_tokens_details.cache_write_tokens;
  fs.writeFileSync(log, JSON.stringify(missing));
  const bad = run('--verify-usage'); assert.equal(bad.status, 1);
  assert.match(JSON.parse(bad.stdout).usageValidation.error, /write counter missing/);
  const compatible = run(); assert.equal(compatible.status, 0);
  assert.equal(JSON.parse(compatible.stdout).usageValidation, undefined);
  fs.writeFileSync(log, JSON.stringify(row()) + '\n{unfinished');
  assert.match(JSON.parse(run('--verify-usage').stdout).usageValidation.error, /malformed/);
  fs.writeFileSync(log, JSON.stringify(row()) + '\n' + JSON.stringify({ op: 'proxy-error', error: 'socket reset' }));
  assert.match(JSON.parse(run('--verify-usage').stdout).usageValidation.error, /transport errors/);
});
