import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { complete, getFallbackOrder, resetFallback, openaiModel } from '../src/llm.js';

const ENV = ['THINKER_LLM', 'THINKER_LLM_BASE_URL', 'THINKER_LLM_API_KEY_ENV', 'THINKER_LLM_API_KEY', 'THINKER_LLM_MODEL', 'THINKER_LLM_CMD', 'THINKER_LLM_PREFER', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CORP_GATEWAY_TOKEN', 'PATH'];
function withEnv(vars, fn) {
  const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.PATH = saved.PATH;
  Object.assign(process.env, vars);
  resetFallback();
  const restore = () => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } resetFallback(); };
  const r = fn();
  return r && typeof r.then === 'function' ? r.finally(restore) : (restore(), r);
}

// a gateway that records the request and answers like /chat/completions
function gateway(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      const r = { url: req.url, headers: req.headers, body: JSON.parse(body) };
      seen.push(r);
      const out = handler(r);
      res.writeHead(out.status || 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ seen, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise(r => server.close(r)) })));
}

test('an OpenAI-compatible endpoint wins over the CLIs and takes THINKER_LLM=openai', () => {
  withEnv({ THINKER_LLM_BASE_URL: 'http://gateway.local/v1', ANTHROPIC_API_KEY: 'k' }, () => {
    const order = getFallbackOrder();
    assert.equal(order[0], 'openai');
    assert.ok(order.indexOf('openai') < order.indexOf('anthropic'));
  });
  withEnv({ THINKER_LLM_BASE_URL: 'http://gateway.local/v1', THINKER_LLM_CMD: 'cat' }, () => {
    assert.deepEqual(getFallbackOrder().slice(0, 2), ['command', 'openai']);
  });
  withEnv({ THINKER_LLM: 'openai' }, () => assert.deepEqual(getFallbackOrder(), ['openai']));
  withEnv({ THINKER_LLM_BASE_URL: 'http://gateway.local/v1', THINKER_LLM_PREFER: 'claude' }, () => {
    assert.equal(getFallbackOrder()[0], 'openai', 'the hook preference for the running agent does not beat an explicit endpoint');
  });
});

test('the gateway model must be named: a tier alone is an error that says what to set', () => {
  withEnv({ THINKER_LLM_BASE_URL: 'http://gateway.local/v1' }, () => {
    assert.throws(() => openaiModel('haiku'), /THINKER_LLM_MODEL.*distillModel/);
    assert.equal(openaiModel('corp-gpt-small'), 'corp-gpt-small');
  });
  withEnv({ THINKER_LLM_BASE_URL: 'http://gateway.local/v1', THINKER_LLM_MODEL: 'corp-gpt' }, () => assert.equal(openaiModel('sonnet'), 'corp-gpt'));
});

test('a schema call goes to /chat/completions with the named token, and the usage counts cached input', async () => {
  const gw = await gateway(() => ({ json: {
    id: 'x', model: 'corp-gpt-2026', choices: [{ message: { role: 'assistant', content: 'Sure:\n```json\n{"answer": "ok", "n": 2}\n```' } }],
    usage: { prompt_tokens: 120, completion_tokens: 9, total_tokens: 129, prompt_tokens_details: { cached_tokens: 100 } },
  } }));
  try {
    await withEnv({ THINKER_LLM: 'openai', THINKER_LLM_BASE_URL: gw.url + '/', THINKER_LLM_API_KEY_ENV: 'CORP_GATEWAY_TOKEN', CORP_GATEWAY_TOKEN: 'secret-1', THINKER_LLM_MODEL: 'corp-gpt' }, async () => {
      const r = await complete({ system: 'You are terse.', prompt: 'Say ok.', schema: { type: 'object', properties: { answer: { type: 'string' }, n: { type: 'number' } } }, maxTokens: 50, timeoutMs: 5000 });
      assert.deepEqual(r.json, { answer: 'ok', n: 2 });
      assert.equal(r.provider, 'openai');
      assert.equal(r.model, 'corp-gpt-2026', 'the model the gateway reports');
      assert.deepEqual(r.tokens, { inputTokens: 120, outputTokens: 9, cacheReadTokens: 100, cacheWriteTokens: null, totalTokens: 129 });
    });
    assert.equal(gw.seen.length, 1);
    const [req] = gw.seen;
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer secret-1');
    assert.equal(req.body.model, 'corp-gpt');
    assert.equal(req.body.max_tokens, 50);
    assert.deepEqual(req.body.messages.map(m => m.role), ['system', 'user']);
    assert.match(req.body.messages[1].content, /JSON Schema/);
    assert.equal(req.body.response_format, undefined, 'gateways support response_format unevenly; the schema travels in the prompt');
  } finally { await gw.close(); }
});

test('a 401 from the gateway names the status, the token variables, and the body', async () => {
  const gw = await gateway(() => ({ status: 401, json: { error: { message: 'invalid api key' } } }));
  try {
    await withEnv({ THINKER_LLM: 'openai', THINKER_LLM_BASE_URL: gw.url, THINKER_LLM_MODEL: 'corp-gpt', OPENAI_API_KEY: 'wrong' }, async () => {
      await assert.rejects(complete({ prompt: 'hi', timeoutMs: 5000 }), /401.*THINKER_LLM_API_KEY_ENV.*invalid api key/);
    });
  } finally { await gw.close(); }
});

test('a token variable that is named but unset is reported before any request is made', async () => {
  await withEnv({ THINKER_LLM: 'openai', THINKER_LLM_BASE_URL: 'http://127.0.0.1:9/v1', THINKER_LLM_MODEL: 'corp-gpt', THINKER_LLM_API_KEY_ENV: 'MISSING_TOKEN_VAR' }, async () => {
    await assert.rejects(complete({ prompt: 'hi', timeoutMs: 5000 }), /MISSING_TOKEN_VAR, which is not set/);
  });
});

test('codex keeps the user config (model_providers) and switches MCP servers, plugins, hooks and project docs off by name', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-fake-codex-'));
  const argsFile = path.join(dir, 'args.json');
  const bin = path.join(dir, 'codex');
  fs.writeFileSync(bin, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdin.resume(); process.stdin.on('end', () => {\n  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"ok":true}' } }));\n  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } }));\n});\n`, { mode: 0o755 });
  try {
    await withEnv({ THINKER_LLM: 'codex', PATH: dir }, async () => {
      const r = await complete({ prompt: 'hi', schema: { type: 'object' }, timeoutMs: 10_000 });
      assert.deepEqual(r.json, { ok: true });
    });
    const args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.ok(!args.includes('--ignore-user-config'), `--ignore-user-config drops the gateway's model_providers: ${args.join(' ')}`);
    assert.ok(args.includes('--ephemeral') && args.includes('--ignore-rules'));
    const overrides = args.flatMap((a, i) => a === '-c' ? [args[i + 1]] : []);
    assert.deepEqual(overrides, ['mcp_servers={}', 'plugins={}', 'features.hooks=false', 'project_doc_max_bytes=0']);
    assert.deepEqual(args.slice(-1), ['-']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
