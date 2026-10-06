#!/usr/bin/env node
// Explicit synthetic live probe. No repository content, production telemetry or secret output.
import fs from 'node:fs';
import { parseEnv } from 'node:util';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildRequest, jevScores } from '../../src/jev.js';
if (process.env.THINKER_TEST !== '1') throw new Error('Set THINKER_TEST=1 for live probes');
const config = JSON.parse(fs.readFileSync(new URL('./production.json', import.meta.url)));
const outputs = JSON.parse(fs.readFileSync('.jev-proxy-work/outputs.json'));
const envFile = process.argv[2];
const env = envFile ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {};
const key = process.env.TYPESAFE_API_KEY || env.TYPESAFE_API_KEY || env.JEVKEY;
if (!key) throw new Error('Supply a dotenv file containing the direct Jev key for comparison');
const request = buildRequest('Where should a developer add a new CLI command?', Array.from({ length: 8 }, (_, i) => ({
  kind: 'map', title: i ? `Unrelated rendering topic ${i}` : 'CLI command dispatch',
  body: i ? 'The renderer draws text and images on a canvas.' : 'Add a command handler to commands.js and register it in dispatch.js.',
  answers: [i ? 'How does rendering work?' : 'How do I add a command?'], deps: [{ path: i ? 'renderer.js' : 'dispatch.js' }],
})), { model: 'jev-1.13.0' });
function aws(args) {
  return execFileSync('aws', ['--profile', config.profile, '--region', config.region, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AWS_PAGER: '' } });
}
async function call(endpoint, token, body = request) {
  const started = performance.now();
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
  return { response, json: await response.json(), ms: performance.now() - started };
}
const denied = await call(outputs.Endpoint, null);
assert.equal(denied.response.status, 401);
const enrolled = await call(new URL('/v1/enroll', outputs.Endpoint), null, {});
assert.equal(enrolled.response.status, 201, JSON.stringify(enrolled.json));
const credential = enrolled.json;
const tokenHash = createHash('sha256').update(credential.token).digest('hex');
const tokenKey = JSON.stringify({ id: { S: `token:${tokenHash}` } });
const samples = [];
try {
  // One first request and 20 alternating pairs; both arms use the exact pinned model, no retries.
  const first = await call(outputs.Endpoint, credential.token);
  assert.equal(first.response.status, 200, JSON.stringify(first.json));
  for (let i = 0; i < 20; i++) {
    const sample = {};
    for (const arm of i % 2 ? ['proxy', 'direct'] : ['direct', 'proxy']) {
      const result = await call(arm === 'direct' ? 'https://api.typesafe.ai/v1/systemone' : outputs.Endpoint,
        arm === 'direct' ? key : credential.token);
      assert.equal(result.response.status, 200, `${arm}: ${JSON.stringify(result.json)}`);
      assert.equal(result.json.model, request.model, 'model mismatch invalidates comparison');
      assert.deepEqual(Object.keys(result.json.answers).sort(), Object.keys(request.questions).sort());
      sample[arm] = Math.round(result.ms);
      if (arm === 'proxy') sample.serverTiming = result.response.headers.get('server-timing');
    }
    samples.push(sample);
  }
  const summarize = arm => {
    const times = samples.map(s => s[arm]).sort((a, b) => a - b);
    return { medianMs: times[Math.floor(times.length / 2)], p95Ms: times[Math.ceil(times.length * 0.95) - 1] };
  };
  // Exercise actual client credential loading in an isolated home, with an explicitly live transport.
  const prev = process.env.THINKER_HOME;
  process.env.THINKER_HOME = `${process.cwd()}/.jev-proxy-work/client-home`;
  fs.mkdirSync(process.env.THINKER_HOME, { recursive: true });
  fs.writeFileSync(`${process.env.THINKER_HOME}/jev-proxy.json`, JSON.stringify({ endpoint: outputs.Endpoint, ...credential }), { mode: 0o600 });
  try {
    const scores = await jevScores('Which module handles commands?', [{ title: 'CLI dispatch', body: 'Commands are dispatched in dispatch.js.', deps: [] }],
      { key: null, model: request.model, fetchImpl: (...args) => fetch(...args) });
    assert.equal(scores.length, 1);
  } finally { if (prev === undefined) delete process.env.THINKER_HOME; else process.env.THINKER_HOME = prev; }
  // Exhaust only this probe token's daily bucket, then verify the proxy refuses another call.
  const day = Math.floor(Date.now() / 86400000);
  aws(['dynamodb', 'put-item', '--table-name', outputs.Table, '--item', JSON.stringify({
    id: { S: `day:${day}:${tokenHash}` }, used: { N: '1000' }, expiresAt: { N: String((day + 2) * 86400) },
  })]);
  assert.equal((await call(outputs.Endpoint, credential.token)).response.status, 429);
  const report = { model: request.model, reasoningEffort: 'not applicable (typed Jev judgments)', samples: 20,
    firstProxyMs: Math.round(first.ms), direct: summarize('direct'), proxy: summarize('proxy'), timings: samples,
    checks: ['unauthenticated=401', 'enrollment=201', 'pinned model matches', 'CLI hosted scores', 'daily quota=429'] };
  fs.writeFileSync('.jev-proxy-work/latency.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, timings: undefined }, null, 2));
} finally {
  aws(['dynamodb', 'delete-item', '--table-name', outputs.Table, '--key', tokenKey]);
}
assert.equal((await call(outputs.Endpoint, credential.token)).response.status, 401);
console.log('Revoked probe credential rejected (401).');
