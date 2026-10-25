import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import { wireCodexProxy, CODEX_PROXY_PROVIDER, codexProvider } from '../src/proxy-codex.js';
import { wireAgents, serviceArgs } from '../src/proxy-service.js';

function machine(t, config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-codex-wiring-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { CODEX_HOME: path.join(dir, 'codex') }, home = path.join(dir, 'thinker');
  fs.mkdirSync(env.CODEX_HOME);
  const file = path.join(env.CODEX_HOME, 'config.toml');
  fs.writeFileSync(file, stringify(config));
  return { dir, home, env, file, read: () => JSON.parse(JSON.stringify(parse(fs.readFileSync(file, 'utf8')))) };
}
const url = 'http://127.0.0.1:6901';

test('default service wires Codex with native auth, preserves settings, and restores the previous provider', t => {
  for (const previous of [undefined, 'openai']) {
    const original = { model: 'gpt-6-astra', model_reasoning_effort: 'high', ...(previous ? { model_provider: previous } : {}), mcp_servers: { own: { command: 'own-server' } }, hooks: { state: { trusted: { trusted_hash: 'keep' } } } };
    const m = machine(t, original);
    const wired = wireAgents(url, { ...m, agents: ['codex'] });
    assert.equal(wired.changed[0].agent, 'codex');
    assert.deepEqual(m.read(), { ...original, model_provider: CODEX_PROXY_PROVIDER, model_providers: { [CODEX_PROXY_PROVIDER]: codexProvider(url) } });
    assert.equal(m.read().model_providers[CODEX_PROXY_PROVIDER].requires_openai_auth, true);
    assert.equal(wireCodexProxy(url, m).unchanged, true);
    assert.ok(serviceArgs(m.home, { port: 6901 }).includes('--codex'));
    assert.equal(wireCodexProxy(null, m).changed, true);
    assert.deepEqual(m.read(), original);
    assert.equal(wireCodexProxy(null, m).unchanged, true);
    assert.equal(fs.existsSync(path.join(m.env.CODEX_HOME, 'auth.json')), false, 'no CLI login or credentials required, including desktop-only installs');
  }
});

test('custom gateways, selected profiles, provider collisions and environment routing stay untouched', t => {
  for (const original of [{ model_provider: 'gateway' }, { openai_base_url: 'https://custom.example/v1' }, { chatgpt_base_url: 'https://custom.example' }, { model_providers: { openai: { base_url: 'https://custom.example' } } }, { profile: 'work' }, { model_providers: { thinker_proxy: { name: 'mine' } } }, { model_provider: 'thinker_proxy' }, { model_providers: [] }]) {
    const m = machine(t, original), before = fs.readFileSync(m.file, 'utf8');
    assert.ok(wireCodexProxy(url, m).skipped);
    assert.equal(fs.readFileSync(m.file, 'utf8'), before);
    assert.equal(wireCodexProxy(null, m).unchanged, true);
  }
  const m = machine(t);
  assert.ok(wireCodexProxy(url, { ...m, env: { ...m.env, OPENAI_BASE_URL: 'https://custom.example' } }).skipped);
});

test('port updates and Codex reserialization retain ownership; off keeps user edits', t => {
  const m = machine(t, { model: 'test' });
  wireCodexProxy(url, m);
  const config = m.read();
  config.model_providers.thinker_proxy = Object.fromEntries(Object.entries(config.model_providers.thinker_proxy).reverse());
  fs.writeFileSync(m.file, stringify(config));
  assert.equal(wireCodexProxy(`${url}0`, m).changed, true);
  const changed = m.read(); changed.model = 'new-model'; changed.model_provider = 'other'; changed.model_providers.other = { name: 'my-gateway' };
  fs.writeFileSync(m.file, stringify(changed));
  wireCodexProxy(null, m);
  assert.deepEqual(m.read(), { model: 'new-model', model_provider: 'other', model_providers: { other: { name: 'my-gateway' } } });
});

test('edited managed provider is not overwritten; off restores the selector and keeps edited table', t => {
  const m = machine(t);
  wireCodexProxy(url, m);
  const config = m.read(); config.model_providers.thinker_proxy.stream_max_retries = 7;
  fs.writeFileSync(m.file, stringify(config));
  assert.ok(wireCodexProxy(url, m).skipped);
  wireCodexProxy(null, m);
  assert.equal(m.read().model_provider, undefined);
  assert.equal(m.read().model_providers.thinker_proxy.stream_max_retries, 7);
});

test('no Codex install is left alone; an existing empty Codex home is wired and cleanly unwired', t => {
  const m = machine(t);
  fs.rmSync(m.file);
  assert.equal(wireCodexProxy(url, m).changed, true);
  wireCodexProxy(null, m);
  assert.equal(fs.existsSync(m.file), false);
  fs.rmdirSync(m.env.CODEX_HOME);
  assert.equal(wireCodexProxy(url, m).absent, true);
});
