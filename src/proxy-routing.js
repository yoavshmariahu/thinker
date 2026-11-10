// A request that names a route (`thinker/…`, providers.js) goes to the route's provider instead of the agent's own
// upstream, with the provider's credential and in the format the provider was found to speak (2026-11-10). The
// agent's own credential never leaves for another host: its auth headers are dropped, and so is `anthropic-beta`,
// which a gateway that is not Anthropic's has no use for and may refuse. A route the registry cannot answer is a 400
// to the agent, never a forward of a made-up model to Anthropic with the person's login: the subagent then fails on
// its first call with the reason in the error, which is the safe failure.
//
// The clearing runs on a routed request as on any other (proxy.js:transformRequest runs first), so what goes to a
// provider is the cut conversation; the translation to Chat (wire-chat.js), where needed, comes after it.
import { resolveRoute, authHeaders, isRouteId } from './providers.js';
import { toChat } from './wire-chat.js';

const MESSAGES_RE = /^\/v1\/messages(\/count_tokens)?(\?|$)/;
const AGENT_AUTH = ['authorization', 'x-api-key', 'anthropic-beta'];

// Whether this request names a route at all, cheaply: the body is parsed only when it holds the prefix.
export function routeOf(raw, url, reg) {
  if (!reg || !MESSAGES_RE.test(url) || !raw?.length || !raw.includes('"thinker/')) return null;
  let j; try { j = JSON.parse(raw); } catch { return null; }
  if (!isRouteId(j?.model)) return null;
  try { return resolveRoute(j.model, reg); }
  catch (e) { return { error: { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: `thinker proxy: ${e.message}` } } }, route: e.route || j.model }; }
}

// the headers that go to the provider: the agent's, less its credentials and betas, plus the provider's credential
export function routedHeaders(headers, route, env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) if (!AGENT_AUTH.includes(k)) out[k] = v;
  Object.assign(out, authHeaders(route.provider.auth, env));
  if (route.format === 'messages' && !out['anthropic-version']) out['anthropic-version'] = '2023-06-01';
  if (route.format === 'messages' && route.provider.beta) out['anthropic-beta'] = route.provider.beta;
  return out;
}

// the body that goes to the provider: the provider's model id in place of the route, Claude-only fields dropped
// unless the provider's model is itself a Claude model, and the whole translated to Chat where that is the format
export function routedBody(body, route) {
  let j; try { j = JSON.parse(body); } catch { return { body, dropped: [] }; }
  j.model = route.model;
  const claude = /claude/i.test(route.model);
  const dropped = [];
  for (const k of ['context_management', ...(claude ? [] : ['thinking', 'metadata', 'output_config'])]) if (k in j) { delete j[k]; dropped.push(k); }
  if (route.format === 'chat') {
    const t = toChat(j, { model: route.model });
    return { body: Buffer.from(JSON.stringify(t.body)), dropped: [...new Set([...dropped, ...t.dropped])], path: '/v1/chat/completions', stream: !!t.body.stream };
  }
  return { body: Buffer.from(JSON.stringify(j)), dropped, stream: !!j.stream };
}

// what the log row says about the routing, never the credential
export const routeRow = (route, extra = {}) => ({ route: route.route, provider: route.providerId, routedModel: route.model, format: route.format, ...extra });
