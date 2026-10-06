// Deployed inline by CloudFormation. No request bodies, credentials, or IPs are logged.
const { createHash, randomBytes } = require('node:crypto');
const UPSTREAM = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-1.13.0';
const hash = value => createHash('sha256').update(value).digest('hex');
const reply = (statusCode, body, extra = {}) => ({ statusCode, headers: {
  'content-type': 'application/json', 'cache-control': 'no-store', ...extra,
}, body: JSON.stringify(body) });
const failure = (status, code) => Object.assign(new Error(code), { status, code });

function createHandler({ storage, getKey, fetchImpl = fetch, now = Date.now, log = console.log,
  maxBytes = 32768, maxQuestions = 32, timeoutMs = 2500 } = {}) {
  return async event => {
    const started = now();
    let upstreamMs = 0;
    let status = 500;
    let counts = {};
    try {
      const method = event.requestContext?.http?.method;
      const route = event.rawPath;
      if (method === 'GET' && route === '/health') { status = 200; return reply(status, { status: 'ok' }); }
      if (method !== 'POST' || !['/v1/enroll', '/v1/systemone'].includes(route)) {
        throw failure(404, 'not_found');
      }
      const body = Buffer.from(event.body || '', event.isBase64Encoded ? 'base64' : 'utf8');
      if (body.length > maxBytes) throw failure(413, 'request_too_large');
      if (route === '/v1/enroll') {
        if (body.length > 128) throw failure(413, 'request_too_large');
        // Only API Gateway's source address is trusted; forwarded headers are client controlled.
        const ip = event.requestContext?.http?.sourceIp;
        if (!ip) throw failure(400, 'missing_source');
        const token = `tp_${randomBytes(32).toString('hex')}`;
        const expiresAt = Math.floor(now() / 1000) + 30 * 86400;
        await storage.enroll(hash(token), hash(`${Math.floor(now() / 86400000)}:${ip}`), expiresAt, now());
        status = 201;
        return reply(status, { token, expiresAt });
      }
      const authorization = event.headers?.authorization || event.headers?.Authorization || '';
      const match = /^Bearer (tp_[a-f0-9]{64})$/.exec(authorization);
      if (!match) throw failure(401, 'unauthorized');
      let request;
      try { request = JSON.parse(body.toString('utf8')); } catch { throw failure(400, 'invalid_json'); }
      if (!request || typeof request !== 'object' || Array.isArray(request) || request.state == null ||
        !request.questions || typeof request.questions !== 'object' || Array.isArray(request.questions)) {
        throw failure(400, 'invalid_request');
      }
      const questions = Object.values(request.questions);
      if (!questions.length || questions.length > maxQuestions || questions.some(q => !q ||
        !['noul', 'choice', 'score'].includes(q.type) || q.instructions == null)) throw failure(400, 'invalid_questions');
      if (request.model && ![MODEL, 'jev-latest'].includes(request.model)) throw failure(400, 'unsupported_model');
      // The alias is pinned server-side; rollout is explicit and comparisons use the returned model.
      const payload = { model: MODEL, state: request.state, questions: request.questions };
      await storage.consume(hash(match[1]), now());
      const key = await getKey();
      const upstreamStart = now();
      let response;
      let result;
      try {
        response = await fetchImpl(UPSTREAM, {
          method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
        });
        if (response.ok) result = await response.json();
        else await response.body?.cancel();
      } catch (error) {
        throw failure(['TimeoutError', 'AbortError'].includes(error.name) ? 504 : 502, 'upstream_unavailable');
      } finally { upstreamMs = now() - upstreamStart; }
      if (!response.ok) throw failure(response.status === 429 ? 429 : response.status === 400 ? 400 : 502, 'upstream_unavailable');
      if (result?.model !== MODEL || !result.answers || typeof result.answers !== 'object') throw failure(502, 'invalid_upstream_response');
      counts = { questions: questions.length, bytes: body.length,
        inputTokens: result.usage?.input_tokens, outputTokens: result.usage?.output_tokens };
      status = 200;
      return reply(status, { model: result.model, answers: result.answers, usage: result.usage }, {
        'server-timing': `upstream;dur=${upstreamMs}, proxy;dur=${Math.max(0, now() - started - upstreamMs)}`,
      });
    } catch (error) {
      status = error.status || 503;
      return reply(status, { error: error.code || 'service_unavailable' }, status === 429 ? { 'retry-after': '60' } : {});
    } finally {
      log(JSON.stringify({ requestId: event.requestContext?.requestId, status, durationMs: now() - started, upstreamMs, ...counts }));
    }
  };
}

// All quota reservations and the credential check commit together. Failed upstream attempts count;
// there are no automatic model retries and concurrent Lambdas cannot overspend these request caps.
function quotaUpdate(table, id, limit, ttl) {
  return { Update: { TableName: table, Key: { id: { S: id } },
    UpdateExpression: 'SET expiresAt = :ttl ADD #used :one',
    ConditionExpression: 'attribute_not_exists(#used) OR #used < :limit',
    ExpressionAttributeNames: { '#used': 'used' },
    ExpressionAttributeValues: { ':ttl': { N: String(ttl) }, ':one': { N: '1' }, ':limit': { N: String(limit) } },
  } };
}

function createStorage({ send, Transaction, table, limits }) {
  async function transact(items, auth = false) {
    try { await send(new Transaction({ TransactItems: items })); }
    catch (error) {
      if (error.name === 'TransactionCanceledException') {
        const reasons = error.CancellationReasons || [];
        if (auth && reasons[0]?.Code === 'ConditionalCheckFailed') throw failure(401, 'unauthorized');
        if (reasons.some(r => r.Code === 'ConditionalCheckFailed')) throw failure(429, 'quota_exceeded');
      }
      throw failure(503, 'service_unavailable');
    }
  }
  return {
    async enroll(tokenHash, ipHash, expiresAt, time) {
      const day = Math.floor(time / 86400000);
      const ttl = (day + 2) * 86400;
      await transact([
        quotaUpdate(table, `enroll:ip:${day}:${ipHash}`, limits.enrollIp, ttl),
        quotaUpdate(table, `enroll:all:${day}`, limits.enrollGlobal, ttl),
        { Put: { TableName: table, Item: { id: { S: `token:${tokenHash}` }, enabled: { BOOL: true }, expiresAt: { N: String(expiresAt) } },
          ConditionExpression: 'attribute_not_exists(id)' } },
      ]);
    },
    async consume(tokenHash, time) {
      const day = Math.floor(time / 86400000), minute = Math.floor(time / 60000);
      await transact([
        { ConditionCheck: { TableName: table, Key: { id: { S: `token:${tokenHash}` } },
          ConditionExpression: 'enabled = :yes AND expiresAt > :now',
          ExpressionAttributeValues: { ':yes': { BOOL: true }, ':now': { N: String(Math.floor(time / 1000)) } } } },
        quotaUpdate(table, `minute:${minute}:${tokenHash}`, limits.minute, (minute + 2) * 60),
        quotaUpdate(table, `day:${day}:${tokenHash}`, limits.day, (day + 2) * 86400),
        quotaUpdate(table, `global:${day}`, limits.global, (day + 2) * 86400),
      ], true);
    },
  };
}

let runtimeHandler;
exports.handler = async event => {
  if (!runtimeHandler) {
    // AWS SDK v3 is supplied by the Lambda Node runtime; tests inject storage and never load it.
    const { DynamoDBClient, TransactWriteItemsCommand } = require('@aws-sdk/client-dynamodb');
    const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
    const db = new DynamoDBClient({ maxAttempts: 2 });
    const secrets = new SecretsManagerClient({ maxAttempts: 2 });
    let cached;
    const getKey = async () => {
      if (!cached || cached.until < Date.now()) {
        const result = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.SECRET_ARN }));
        const key = JSON.parse(result.SecretString).apiKey;
        if (typeof key !== 'string' || !key) throw new Error('missing key');
        cached = { key, until: Date.now() + 60000 };
      }
      return cached.key;
    };
    const storage = createStorage({ send: cmd => db.send(cmd), Transaction: TransactWriteItemsCommand,
      table: process.env.TABLE_NAME, limits: { minute: 30, day: 1000, global: 10000, enrollIp: 5, enrollGlobal: 100 } });
    runtimeHandler = createHandler({ storage, getKey });
  }
  return runtimeHandler(event);
};
exports.createHandler = createHandler;
exports.createStorage = createStorage;
exports.MODEL = MODEL;
