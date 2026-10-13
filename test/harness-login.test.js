import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { complete, resetFallback, claudeLoginSettings } from '../src/llm.js';

const KEYS = ['THINKER_LLM', 'THINKER_LLM_CMD', 'THINKER_LLM_MODEL', 'THINKER_LLM_BASE_URL', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'PATH', 'HOME', 'THINKER_QUIET'];
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  process.env.PATH = saved.PATH; process.env.HOME = saved.HOME;
  Object.assign(process.env, vars); resetFallback();
  try { return await fn(); } finally { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } resetFallback(); }
}
// a claude that records its argv and answers like `claude -p --output-format json`
function fakeClaude(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-fakeclaude-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const argsFile = path.join(dir, 'args.json');
  fs.writeFileSync(path.join(dir, 'claude'), `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ result: 'ok', usage: { input_tokens: 1, output_tokens: 1 }, model: 'claude-haiku-5-5' })));\n`, { mode: 0o755 });
  return { bin: dir, args: () => JSON.parse(fs.readFileSync(argsFile, 'utf8')) };
}
const USER_SETTINGS = {
  env: { ANTHROPIC_BASE_URL: 'https://llm-gateway.corp.example/anthropic', ANTHROPIC_AUTH_TOKEN: 'corp-token', CLAUDE_CODE_USE_BEDROCK: '0', HTTPS_PROXY: 'http://proxy.corp.example:3128', NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel.corp.example', CLAUDE_CODE_ENABLE_TELEMETRY: '1', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-5-5' },
  apiKeyHelper: '/usr/local/bin/corp-token',
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] },
  permissions: { allow: ['Bash(git *)'] },
  enabledPlugins: { 'x@y': true },
  model: 'opus',
};

test('the login side of the user settings is read: where the model is and how to authenticate, apiKeyHelper, the AWS helpers; nothing else', t => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-claude-cfg-'));
  t.after(() => fs.rmSync(cfg, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify(USER_SETTINGS));
  assert.deepEqual(claudeLoginSettings(cfg), {
    env: { ANTHROPIC_BASE_URL: 'https://llm-gateway.corp.example/anthropic', ANTHROPIC_AUTH_TOKEN: 'corp-token', CLAUDE_CODE_USE_BEDROCK: '0', HTTPS_PROXY: 'http://proxy.corp.example:3128', NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem' },
    apiKeyHelper: '/usr/local/bin/corp-token',
  }, 'telemetry exporters, model aliases and per-call limits are not login');
  fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ hooks: {}, env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1', OTEL_METRICS_EXPORTER: 'otlp' } }));
  assert.equal(claudeLoginSettings(cfg), null, 'nothing about the login: nothing passed');
  fs.writeFileSync(path.join(cfg, 'settings.json'), '{not json');
  assert.equal(claudeLoginSettings(cfg), null);
  assert.equal(claudeLoginSettings(path.join(cfg, 'missing')), null);
});

test('claude -p still runs without setting sources, and gets the login back through --settings', async t => {
  const claude = fakeClaude(t);
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-claude-cfg-'));
  t.after(() => fs.rmSync(cfg, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify(USER_SETTINGS));
  await withEnv({ PATH: claude.bin, THINKER_LLM: 'claude', CLAUDE_CONFIG_DIR: cfg, THINKER_QUIET: '1' }, async () => {
    const r = await complete({ prompt: 'hi', model: 'haiku', timeoutMs: 20_000 });
    assert.equal(r.text, 'ok');
    const args = claude.args();
    assert.equal(args[args.indexOf('--setting-sources') + 1], '', 'hooks, permissions, plugins and skills stay out');
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
    assert.equal(settings.env.ANTHROPIC_BASE_URL, 'https://llm-gateway.corp.example/anthropic');
    assert.equal(settings.apiKeyHelper, '/usr/local/bin/corp-token');
    assert.equal(settings.hooks, undefined);
    assert.equal(settings.permissions, undefined);
    assert.equal(settings.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, undefined, 'thinker sets the output limit per call');
  });
  // a machine with no login in its settings passes no --settings at all
  fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ hooks: USER_SETTINGS.hooks }));
  await withEnv({ PATH: claude.bin, THINKER_LLM: 'claude', CLAUDE_CONFIG_DIR: cfg, THINKER_QUIET: '1' }, async () => {
    await complete({ prompt: 'hi', model: 'haiku', timeoutMs: 20_000 });
    assert.ok(!claude.args().includes('--settings'));
  });
});

// findBin also looks in ~/.local/bin and the brew dirs: HOME points at the temp dir so only the fake is found
function fakeBin(t, name, reply) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-fake-' + name + '-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const argsFile = path.join(dir, 'args.json');
  fs.writeFileSync(path.join(dir, name), `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(JSON.stringify(reply))}));\n`, { mode: 0o755 });
  return { dir, args: () => JSON.parse(fs.readFileSync(argsFile, 'utf8')) };
}

test('gemini runs with extensions and MCP servers off, keeping its own login', async t => {
  const gemini = fakeBin(t, 'gemini', { response: 'ok', stats: {} });
  await withEnv({ PATH: gemini.dir, HOME: gemini.dir, THINKER_LLM: 'gemini', THINKER_QUIET: '1' }, async () => {
    const r = await complete({ prompt: 'hi', model: 'haiku', timeoutMs: 20_000 });
    assert.equal(r.text, 'ok');
    const args = gemini.args();
    assert.equal(args[args.indexOf('-e') + 1], 'none');
    assert.equal(args[args.indexOf('--allowed-mcp-server-names') + 1], 'none');
    assert.ok(!args.some(a => /ignore|no-config|setting-sources/.test(a)), 'nothing that drops the login');
  });
  const agy = fakeBin(t, 'agy', { response: 'ok', usage: {} });
  await withEnv({ PATH: agy.dir, HOME: agy.dir, THINKER_LLM: 'gemini', THINKER_QUIET: '1' }, async () => {
    await complete({ prompt: 'hi', model: 'haiku', timeoutMs: 20_000 });
    const args = agy.args();
    assert.ok(args.includes('--mode=plan') && args.includes('--disable-slash-commands'), args.join(' '));
  });
});
