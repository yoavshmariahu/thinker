// Model providers and routes: the integration layer for models outside the agent's own login (2026-11-10, the
// owner's ask: "a flexible integration layer that will allow us to bring in models from other providers").
//
// There is no standard gateway interface; there are three wire formats, and that is enough. OpenAI's Chat
// Completions is spoken by every gateway (LiteLLM, OpenRouter, Portkey, Bifrost, Cloudflare, Vercel, Kong);
// Anthropic's Messages API is what Claude Code speaks and some gateways offer; OpenAI's Responses API is what
// Codex speaks. The one near-standard beside them is `GET /v1/models`. So a provider here is a base URL, a
// credential, and the formats it was *found* to speak -- never what the person says it speaks: `probeProvider`
// lists its models and sends a one-token request in each format, and records what answered 200. A registry
// entry is evidence, and `thinker models probe` renews it.
//
// Where it lives: `<THINKER_HOME>/providers.json`, the machine's, since a key is the person's and not a
// repository's. The credential is never in the file: `auth` names an environment variable or a private file
// (mode 600, as proxy-bedrock.js:bedrockToken requires), read at request time, so a rotated key needs no change
// here and a dump of the registry carries no secret.
//
// A route is how a request names a model outside its login: `thinker/<alias>` for an alias this registry holds,
// or `thinker/<provider>/<model id>`. Claude Code sends an unrecognised model id upstream unchanged (checked live
// 2026-11-10, Claude Code 2.1.319, `--model thinker/gateway/gpt-6-sol` arrived as sent, logged
// `unrecognized_model` on its side), which is what lets a subagent file name one (model-agents.js) and the proxy
// forward it (proxy-routing.js). An alias is the lever the routing turns on: re-pointing `explore` moves every
// subagent that names it, with no file rewritten and no session restarted.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { thinkerHome } from './update.js';

export const ROUTE_PREFIX = 'thinker/';
export const FORMATS = ['messages', 'chat'];   // the formats the proxy can forward: Anthropic Messages as it came, Chat Completions translated (wire-chat.js)
const VERSION = 1;
export const PROBE_TIMEOUT_MS = 20_000;

export const registryFile = (home = thinkerHome()) => path.join(home, 'providers.json');
const keysDir = home => path.join(home, 'keys');

export function readRegistry(home = thinkerHome()) {
  let j = null;
  try { j = JSON.parse(fs.readFileSync(registryFile(home), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw Error(`providers.json is not valid JSON: ${e.message}`); }
  const r = j && typeof j === 'object' ? j : {};
  return { version: VERSION, providers: isObj(r.providers) ? r.providers : {}, routes: isObj(r.routes) ? r.routes : {}, agents: isObj(r.agents) ? r.agents : {} };
}
export function writeRegistry(reg, home = thinkerHome()) {
  const f = registryFile(home);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, providers: reg.providers || {}, routes: reg.routes || {}, agents: reg.agents || {} }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, f);
  priceStatAt = 0; // a price written here is read by the next registryPrices, throttle or not
  return f;
}
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

// A reader for the proxy: the file re-read when its mtime moves, never on every request.
export function registryReader(home = thinkerHome()) {
  let cached = null, stamp = null;
  return () => {
    let st = null; try { st = fs.statSync(registryFile(home)); } catch {}
    const now = st ? `${st.mtimeMs}:${st.size}` : 'absent';
    if (now !== stamp) { stamp = now; try { cached = readRegistry(home); } catch { cached = { version: VERSION, providers: {}, routes: {}, agents: {} }; } }
    return cached;
  };
}

// --- base URL and credential -----------------------------------------------------------------------------------------

// The base the paths are added to: `/v1/messages`, `/v1/chat/completions` and `/v1/models` all start with `/v1`,
// so a URL given with it (as OpenAI's and OpenRouter's docs write them) is stored without.
export function normalizeBase(url) {
  let u; try { u = new URL(String(url)); } catch { throw Error(`not a URL: ${url}`); }
  if (!['http:', 'https:'].includes(u.protocol)) throw Error('a provider URL must be http(s)');
  u.search = ''; u.hash = '';
  u.pathname = u.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  return u.toString().replace(/\/+$/, '');
}
export const isProviderId = id => /^[a-z][a-z0-9-]{0,39}$/.test(String(id || ''));

// The key, read at request time; never stored in the registry, never logged. `{ env }` names a variable of the
// proxy's own environment (the service runs under launchd, so a shell export does not reach it: `thinker models
// add --key` writes the private file instead); `{ file }` is a private file holding one token.
export function readCredential(auth, env = process.env) {
  if (!auth || typeof auth !== 'object') throw Error('the provider has no credential');
  if (auth.env) { const v = env[auth.env]; if (!v || !String(v).trim()) throw Error(`${auth.env} is not set in the proxy's environment`); return String(v).trim(); }
  if (auth.file) {
    let token;
    try {
      const st = fs.statSync(auth.file);
      if (!st.isFile() || st.size > 65536 || (process.platform !== 'win32' && (st.mode & 0o077))) throw Error();
      token = fs.readFileSync(auth.file, 'utf8').trim();
    } catch { throw Error(`the key file ${auth.file} must be readable, private (chmod 600) and at most 64 KiB`); }
    if (!token || /[^\x21-\x7e]/.test(token)) throw Error(`the key file ${auth.file} must hold one non-empty ASCII token`);
    return token;
  }
  if (auth.none) return null;
  throw Error('the provider credential names neither an environment variable nor a file');
}
// `--key <value>` lands in a private file under the home, so the value itself is nowhere but there
export function storeKey(id, value, home = thinkerHome()) {
  const v = String(value || '').trim();
  if (!v || /[^\x21-\x7e]/.test(v)) throw Error('a key is one non-empty ASCII token');
  const dir = keysDir(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = path.join(dir, id);
  fs.writeFileSync(f, v + '\n', { mode: 0o600 });
  fs.chmodSync(f, 0o600);
  return f;
}
// what a request to the provider carries: both headers, since a gateway reads one or the other and the extra is ignored
export function authHeaders(auth, env = process.env) {
  const key = readCredential(auth, env);
  return key ? { authorization: `Bearer ${key}`, 'x-api-key': key } : {};
}

// --- probing -------------------------------------------------------------------------------------------------------------

// What `GET /v1/models` says, in the shapes seen in the field: OpenAI's `data[].id`; OpenRouter's `pricing.prompt` /
// `completion` in dollars a token; Vercel's `pricing.input` / `output`; LiteLLM's `/model/info` with
// `model_info.input_cost_per_token`. Dollars a token become dollars a million, which is what prices.js counts in.
export function parseModelList(j) {
  const rows = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : Array.isArray(j) ? j : [];
  const out = {};
  for (const r of rows) {
    const id = typeof r === 'string' ? r : r?.id || r?.model_name || r?.name;
    if (!id || typeof id !== 'string') continue;
    const m = { source: 'provider' };
    const p = r?.pricing || r?.model_info || null;
    const perToken = (...keys) => { for (const k of keys) { const v = Number(p?.[k]); if (Number.isFinite(v) && v >= 0) return v; } return null; };
    const input = perToken('prompt', 'input', 'input_cost_per_token'), output = perToken('completion', 'output', 'output_cost_per_token');
    // OpenRouter's list (read live 2026-11-10: 465 models, 457 priced) carries the cache read, the five-minute and the one-hour
    // write a token, which is exactly the four prices.js counts in; a million of them, rounded past the float noise
    const M = v => v == null ? null : Math.round(v * 1e6 * 1e6) / 1e6;
    if (input != null && output != null) m.price = { input: M(input), output: M(output), ...(perToken('input_cache_read', 'cache_read_input_token_cost') != null ? { cacheRead: M(perToken('input_cache_read', 'cache_read_input_token_cost')) } : {}), ...(perToken('input_cache_write', 'cache_creation_input_token_cost') != null ? { cacheWrite: M(perToken('input_cache_write', 'cache_creation_input_token_cost')) } : {}), ...(perToken('input_cache_write_1h') != null ? { cacheWrite1h: M(perToken('input_cache_write_1h')) } : {}) };
    // what the provider says the model takes: tools and structured output are what a subagent needs
    if (Array.isArray(r?.supported_parameters)) m.supports = r.supported_parameters.filter(x => ['tools', 'tool_choice', 'structured_outputs', 'response_format', 'reasoning'].includes(x));
    const ctx = Number(r?.context_length ?? r?.context_window ?? p?.max_input_tokens ?? r?.max_context_length);
    if (Number.isFinite(ctx) && ctx > 0) m.context = ctx;
    out[id] = m;
  }
  return out;
}

const withTimeout = async (fetchFn, url, init, ms) => {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try { return await fetchFn(url, { ...init, signal: ac.signal }); } finally { clearTimeout(timer); }
};
const readJson = async res => { const text = await res.text(); try { return { status: res.status, json: JSON.parse(text), text }; } catch { return { status: res.status, json: null, text }; } };

// Ask the provider what it is. Returns what was found; stores nothing. `model` names the model the format probes
// use; without one the first listed model is sent, and a provider that lists none is probed with the request alone.
export async function probeProvider(provider, { fetch: fetchFn = globalThis.fetch, env = process.env, model = null, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const base = normalizeBase(provider.url);
  const auth = authHeaders(provider.auth, env);
  const found = { url: base, probedAt: new Date().toISOString(), formats: [], models: {}, checks: {} };
  // 1. the list
  try {
    const r = await readJson(await withTimeout(fetchFn, `${base}/v1/models`, { headers: { ...auth, accept: 'application/json' } }, timeoutMs));
    found.checks.models = r.status;
    if (r.status === 200 && r.json) found.models = parseModelList(r.json);
    else if (r.status === 401 || r.status === 403) found.checks.auth = 'refused';
  } catch (e) { found.checks.models = `error: ${e.name === 'AbortError' ? 'timed out' : e.message}`; }
  const probeModel = model || Object.keys(found.models)[0] || null;
  if (!probeModel) { found.checks.format = 'no model to probe with (name one with --model)'; return found; }
  found.probeModel = probeModel;
  // 2. one token in each format
  const tries = [
    ['messages', '/v1/messages', { model: probeModel, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }, { 'anthropic-version': '2023-06-01' }],
    ['chat', '/v1/chat/completions', { model: probeModel, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }, {}],
  ];
  for (const [format, p, body, extra] of tries) {
    try {
      const r = await readJson(await withTimeout(fetchFn, base + p, { method: 'POST', headers: { ...auth, ...extra, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) }, timeoutMs));
      found.checks[format] = r.status;
      // a 200 with the format's own shape: a gateway that answers every path with its own JSON is not speaking it
      if (r.status === 200 && (format === 'messages' ? r.json?.type === 'message' || Array.isArray(r.json?.content) : Array.isArray(r.json?.choices))) found.formats.push(format);
    } catch (e) { found.checks[format] = `error: ${e.name === 'AbortError' ? 'timed out' : e.message}`; }
  }
  return found;
}

// --- routes --------------------------------------------------------------------------------------------------------------

export const isRouteId = model => typeof model === 'string' && model.startsWith(ROUTE_PREFIX);

// `thinker/<alias>` or `thinker/<provider>/<model id>` to the provider, the model and the format the proxy will use;
// null for a model that is not a route; an Error for a route the registry cannot answer, which the proxy turns into
// a 400 rather than forwarding a made-up model to anyone (proxy-routing.js).
export function resolveRoute(model, reg) {
  if (!isRouteId(model)) return null;
  const rest = model.slice(ROUTE_PREFIX.length);
  const fail = why => Object.assign(Error(why), { route: model });
  let providerId, modelId, alias = null;
  const direct = rest.indexOf('/');
  if (direct < 0 || !reg.providers?.[rest.slice(0, direct)]) {
    const r = reg.routes?.[rest];
    if (!r) throw fail(direct < 0 ? `no route named ${rest} (thinker models route ${rest} <provider>/<model> adds one)` : `no provider named ${rest.slice(0, direct)}`);
    alias = rest; providerId = r.provider; modelId = r.model;
  } else { providerId = rest.slice(0, direct); modelId = rest.slice(direct + 1); }
  const provider = reg.providers?.[providerId];
  if (!provider) throw fail(`route ${rest} names a provider that is not registered: ${providerId}`);
  if (!modelId) throw fail(`route ${rest} names no model`);
  const formats = Array.isArray(provider.formats) ? provider.formats.filter(f => FORMATS.includes(f)) : [];
  const format = reg.routes?.[alias]?.format && formats.includes(reg.routes[alias].format) ? reg.routes[alias].format : formats.includes('messages') ? 'messages' : formats[0];
  if (!format) throw fail(`provider ${providerId} speaks no format the proxy can forward (thinker models probe ${providerId})`);
  return { route: model, alias, providerId, provider: { id: providerId, ...provider, url: normalizeBase(provider.url) }, model: modelId, format, known: !!provider.models?.[modelId] };
}

// --- the registry's edits -----------------------------------------------------------------------------------------------

export function addProvider(reg, { id, url, auth, label }) {
  if (!isProviderId(id)) throw Error('a provider id is lowercase letters, digits and dashes, 40 characters at most');
  const base = normalizeBase(url);
  const cur = reg.providers[id] || {};
  reg.providers[id] = { ...cur, url: base, auth: auth || cur.auth || { none: true }, ...(label ? { label } : {}), addedAt: cur.addedAt || new Date().toISOString() };
  return reg.providers[id];
}
export function recordProbe(reg, id, found) {
  const p = reg.providers[id]; if (!p) throw Error(`no provider ${id}`);
  // models the probe did not list stay, marked as the person's own, so a hand-named model survives a listing that omits it
  const models = { ...Object.fromEntries(Object.entries(p.models || {}).filter(([, m]) => m?.source === 'manual')), ...found.models };
  reg.providers[id] = { ...p, formats: found.formats, models, probedAt: found.probedAt, checks: found.checks, ...(found.probeModel ? { probeModel: found.probeModel } : {}) };
  return reg.providers[id];
}
export function removeProvider(reg, id) {
  if (!reg.providers[id]) throw Error(`no provider ${id}`);
  delete reg.providers[id];
  for (const [a, r] of Object.entries(reg.routes)) if (r.provider === id) delete reg.routes[a];
  return reg;
}
export const isAlias = a => /^[a-z][a-z0-9-]{0,39}$/.test(String(a || ''));
export function setRoute(reg, alias, target, { format } = {}) {
  if (!isAlias(alias)) throw Error('a route alias is lowercase letters, digits and dashes, 40 characters at most');
  if (reg.providers[alias]) throw Error(`${alias} is a provider id; an alias cannot shadow one`);
  const i = String(target || '').indexOf('/');
  if (i <= 0) throw Error('a route target is <provider>/<model id>');
  const providerId = target.slice(0, i), model = target.slice(i + 1);
  const p = reg.providers[providerId];
  if (!p) throw Error(`no provider ${providerId} (thinker models add ${providerId} <url> ...)`);
  if (format && !FORMATS.includes(format)) throw Error(`format is one of ${FORMATS.join(', ')}`);
  if (format && !(p.formats || []).includes(format)) throw Error(`${providerId} was not found to speak ${format} (thinker models probe ${providerId})`);
  if (!p.models?.[model]) { p.models ||= {}; p.models[model] = { source: 'manual' }; }
  reg.routes[alias] = { provider: providerId, model, ...(format ? { format } : {}), at: new Date().toISOString() };
  return reg.routes[alias];
}
export function dropRoute(reg, alias) { if (!reg.routes[alias]) throw Error(`no route ${alias}`); delete reg.routes[alias]; }

// The prices the registry knows, for prices.js alone (the one door dollars go through): dollars a million per
// provider model id, as the provider reported them or as `thinker models price` set them.
// The file is stat'd at most every STAT_MS: prices.js:listPrice is called once per priced row of a report, which on
// this machine is 18,640 times for one repository's Report -- four tenths of a second of nothing but stat calls on an
// unchanged file (2026-11-10). A price written while a report is being worked out is read on the next one.
let priceCache = null, priceStamp = null, priceStatAt = 0;
const STAT_MS = 1000;
export function registryPrices(home = thinkerHome(), { now: clock = Date.now() } = {}) {
  if (priceCache && priceStamp?.startsWith(`${home}:`) && clock - priceStatAt < STAT_MS) return priceCache;
  priceStatAt = clock;
  let st = null; try { st = fs.statSync(registryFile(home)); } catch {}
  const now = st ? `${home}:${st.mtimeMs}:${st.size}` : `${home}:absent`;
  if (now === priceStamp) return priceCache;
  priceStamp = now; priceCache = {};
  if (!st) return priceCache;
  try {
    const reg = readRegistry(home);
    for (const p of Object.values(reg.providers)) for (const [id, m] of Object.entries(p.models || {})) if (m?.price && Number.isFinite(m.price.input)) priceCache[id.toLowerCase()] = m.price;
  } catch {}
  return priceCache;
}

// the person's home for the key files, named in messages
export const keyFileFor = (id, home = thinkerHome()) => path.join(keysDir(home), id).replace(os.homedir(), '~');
