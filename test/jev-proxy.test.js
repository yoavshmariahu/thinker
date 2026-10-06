import { test } from 'node:test';
import assert from 'node:assert/strict';
import proxy from '../infra/jev-proxy/handler.cjs';
import { template } from '../infra/jev-proxy/template.mjs';
const { createHandler, createStorage, MODEL } = proxy;
const token = `tp_${'a'.repeat(64)}`;
const payload = { model: 'jev-latest', state: 'private source', questions: { q: { type: 'noul', instructions: 'private question' } } };
const event = (route = '/v1/systemone', body = payload) => ({ rawPath: route, body: JSON.stringify(body),
  headers: { authorization: `Bearer ${token}` }, requestContext: { requestId: 'id', http: { method: 'POST', sourceIp: '192.0.2.1' } } });
function fixture(over = {}) {
  const calls = [], logs = [];
  const handler = createHandler({
    storage: { enroll: async (...args) => calls.push(['enroll', ...args]), consume: async (...args) => calls.push(['consume', ...args]) },
    getKey: async () => 'upstream-secret', log: s => logs.push(s),
    fetchImpl: async (url, options) => {
      calls.push(['fetch', url, options]);
      return { ok: true, json: async () => ({ model: MODEL, answers: { q: { noul: 0.9 } }, usage: { input_tokens: 10 } }) };
    }, ...over,
  });
  return { handler, calls, logs };
}
test('proxy authenticates, reserves quota, replaces client credentials and pins the model', async () => {
  const f = fixture();
  const result = await f.handler(event());
  assert.equal(result.statusCode, 200);
  assert.equal(f.calls[0][0], 'consume');
  assert.match(f.calls[0][1], /^[a-f0-9]{64}$/);
  const [, url, opts] = f.calls[1];
  assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(opts.headers.authorization, 'Bearer upstream-secret');
  assert.equal(JSON.parse(opts.body).model, MODEL);
  assert.equal(opts.redirect, 'error');
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.match(result.headers['server-timing'], /upstream;dur=/);
  assert.doesNotMatch(f.logs.join(''), /private|upstream-secret|tp_|192\.0\.2/);
});
test('no credential, oversized input and unapproved models never reach Jev', async () => {
  for (const modify of [e => { e.headers = {}; }, e => { e.body = 'x'.repeat(32769); },
    e => { e.body = JSON.stringify({ ...payload, model: 'other' }); },
    e => { e.body = '{'; }, e => { e.body = JSON.stringify({ ...payload, questions: {} }); }]) {
    const f = fixture(), e = event(); modify(e);
    assert.ok((await f.handler(e)).statusCode >= 400);
    assert.equal(f.calls.length, 0);
  }
});
test('automatic enrollment only stores hashes and trusts API Gateway source IP', async () => {
  const f = fixture();
  const e = event('/v1/enroll', {}); e.headers['x-forwarded-for'] = 'attacker-supplied';
  const result = await f.handler(e), body = JSON.parse(result.body);
  assert.equal(result.statusCode, 201);
  assert.match(body.token, /^tp_[a-f0-9]{64}$/);
  assert.ok(body.expiresAt > Date.now() / 1000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], 'enroll');
  assert.match(f.calls[0][1], /^[a-f0-9]{64}$/);
  assert.match(f.calls[0][2], /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(f.calls), /192\.0\.2|attacker-supplied|tp_/);
});
test('quota, auth and storage failures fail closed without fetching secrets or calling Jev', async () => {
  for (const status of [401, 429, 503]) {
    let touched = false;
    const f = fixture({ storage: { consume: async () => { throw Object.assign(new Error('sensitive'), { status, code: 'denied' }); } },
      getKey: async () => { touched = true; } });
    const r = await f.handler(event());
    assert.equal(r.statusCode, status); assert.equal(touched, false); assert.equal(f.calls.length, 0);
    assert.doesNotMatch(r.body + f.logs.join(''), /sensitive/);
  }
});
test('upstream errors and timeouts return safe errors, never provider bodies or headers', async () => {
  for (const [fetchImpl, status] of [
    [async () => ({ ok: false, status: 429, body: { cancel: async () => {} } }), 429],
    [async () => ({ ok: false, status: 401 }), 502],
    [async () => { throw Object.assign(new Error('secret'), { name: 'TimeoutError' }); }, 504],
    [async () => ({ ok: true, json: async () => ({ model: 'wrong', answers: {} }) }), 502],
  ]) {
    const f = fixture({ fetchImpl }), r = await f.handler(event());
    assert.equal(r.statusCode, status); assert.doesNotMatch(r.body + f.logs.join(''), /secret/);
  }
});
class Transaction { constructor(input) { Object.assign(this, input); } }
const limits = { minute: 30, day: 1000, global: 10000, enrollIp: 5, enrollGlobal: 100 };
test('storage reserves all quota windows together and checks revocation and expiry in the same transaction', async () => {
  let tx;
  const storage = createStorage({ send: async command => { tx = command; }, Transaction, table: 'table', limits });
  await storage.consume('hash', 100000);
  assert.equal(tx.TransactItems.length, 4);
  assert.match(tx.TransactItems[0].ConditionCheck.ConditionExpression, /enabled.*expiresAt/);
  assert.deepEqual(tx.TransactItems.slice(1).map(t => t.Update.ExpressionAttributeValues[':limit'].N), ['30', '1000', '10000']);
  for (const item of tx.TransactItems.slice(1)) assert.match(item.Update.ConditionExpression, /#used < :limit/);
  await storage.enroll('hash', 'ip-hash', 999999, 100000);
  assert.equal(tx.TransactItems.length, 3);
  assert.equal(tx.TransactItems[2].Put.Item.id.S, 'token:hash');
});
test('transaction cancellations distinguish revoked token, quota and infrastructure failure', async () => {
  for (const [index, expected] of [[0, 401], [1, 429], [-1, 503]]) {
    const storage = createStorage({ send: async () => { throw { name: 'TransactionCanceledException',
      CancellationReasons: Array.from({ length: 4 }, (_, i) => ({ Code: i === index ? 'ConditionalCheckFailed' : 'None' })) }; },
    Transaction, table: 'table', limits });
    await assert.rejects(storage.consume('hash', 100000), error => error.status === expected);
  }
});
test('infrastructure bounds concurrency and grants only scoped secret/table access', () => {
  const t = template(), f = t.Resources.Function.Properties;
  assert.equal(f.ReservedConcurrentExecutions, 5);
  assert.equal(t.Resources.Stage.Properties.DefaultRouteSettings.ThrottlingRateLimit, 10);
  const statements = t.Resources.Role.Properties.Policies[0].PolicyDocument.Statement;
  assert.ok(statements.every(s => s.Resource !== '*'));
  assert.ok(!JSON.stringify(t).includes('upstream-secret'));
});
