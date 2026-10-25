// Machine-wide Codex provider wiring. No credential reads or CLI login needed:
// Codex supplies its existing OpenAI auth and account headers on each request.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse, stringify } from 'smol-toml';
import { isTestMode } from './test-mode.js';

export const CODEX_PROXY_PROVIDER = 'thinker_proxy';
export const CODEX_PROXY_PATH = '/codex';
export const CODEX_UPSTREAMS = { chatgpt: 'https://chatgpt.com/backend-api/codex', api: 'https://api.openai.com/v1' };

export function codexProvider(url) {
  return {
    name: 'Thinker OpenAI proxy', base_url: `${url}${CODEX_PROXY_PATH}`, wire_api: 'responses',
    requires_openai_auth: true, supports_websockets: false, supports_standalone_web_search: true,
    env_http_headers: { 'OpenAI-Organization': 'OPENAI_ORGANIZATION', 'OpenAI-Project': 'OPENAI_PROJECT' },
    capabilities: { external_web_access: true, remote_compaction: 'v2' },
  };
}

export function wireCodexProxy(url, { home, env = process.env } = {}) {
  const dir = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const file = path.join(dir, 'config.toml');
  const stateFile = path.join(home, 'state', 'proxy-codex.json');
  const unchanged = { file, unchanged: true };
  if (isTestMode() && !env.CODEX_HOME) return url ? { file, skipped: 'test mode and CODEX_HOME is not set: the real file is left alone' } : unchanged;
  const exists = fs.existsSync(file);
  if (!exists && (!url || !fs.existsSync(dir))) return { ...unchanged, absent: true };
  const text = exists ? fs.readFileSync(file, 'utf8') : '', config = parse(text);
  let state;
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  if (state?.file !== file) state = null;
  const current = config.model_providers?.[CODEX_PROXY_PROVIDER];
  // smol-toml uses null-prototype tables; the saved JSON state uses plain objects.
  const owned = state && current && isDeepStrictEqual(JSON.parse(JSON.stringify(current)), state.provider);
  const write = () => fs.writeFileSync(file, stringify(config));
  if (!url) {
    if (!state) return unchanged;
    let changed = false;
    // Restore only a selector still pointing at our URL. A provider chosen by the person stays.
    if (config.model_provider === CODEX_PROXY_PROVIDER && current?.base_url === state.provider.base_url) {
      if (state.previous === undefined) delete config.model_provider; else config.model_provider = state.previous;
      changed = true;
    }
    if (owned) {
      delete config.model_providers[CODEX_PROXY_PROVIDER];
      if (!Object.keys(config.model_providers).length) delete config.model_providers;
      changed = true;
    }
    if (changed) { if (state.created && !Object.keys(config).length) fs.rmSync(file, { force: true }); else write(); }
    fs.rmSync(stateFile, { force: true });
    return changed ? { file, changed: true } : unchanged;
  }
  const skip = skipped => ({ file, skipped });
  if (config.model_providers && (typeof config.model_providers !== 'object' || Array.isArray(config.model_providers))) return skip('model_providers is not a table');
  if (current && !owned) return skip('model_providers.thinker_proxy was defined or edited outside thinker');
  if (config.model_provider && !['openai', CODEX_PROXY_PROVIDER].includes(config.model_provider)) return skip(`custom provider ${config.model_provider} is selected`);
  if (config.model_provider === CODEX_PROXY_PROVIDER && !owned) return skip('the selected thinker_proxy provider is not managed by this service');
  if (config.openai_base_url || config.chatgpt_base_url || env.OPENAI_BASE_URL || config.model_providers?.openai) return skip('an OpenAI base URL or built-in provider override is already configured');
  if (config.profile) return skip('a Codex configuration profile is selected; its provider is left as configured');
  const provider = codexProvider(url);
  if (owned && isDeepStrictEqual(state.provider, provider) && config.model_provider === CODEX_PROXY_PROVIDER) return unchanged;
  const nextState = { file, ...(state || { previous: config.model_provider, created: !exists }), provider };
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  // Save just the fields we own before editing, never auth or a copy of personal settings.
  fs.writeFileSync(stateFile, JSON.stringify(nextState, null, 2) + '\n');
  config.model_provider = CODEX_PROXY_PROVIDER;
  config.model_providers ||= {};
  config.model_providers[CODEX_PROXY_PROVIDER] = provider;
  write();
  return { file, changed: true };
}
