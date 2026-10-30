// List prices per million tokens, for the Report page's cost view alone (report.js): what a session's tokens would
// cost at the provider's published API rates, so sessions on different models can be compared on one scale and a
// switch of model shows in the trend. The rest of the product counts tokens, never dollars (decided 2026-10-04: most
// agents run on subscriptions, and a price from the list told people what they would not pay); the Report page says
// so under the toggle. Anthropic's rates are the ratios of model-usage.js:relativeRate at Opus 5.5's input price,
// one table; the other providers' are listed here (OpenAI and Google, as published on 2026-10-22). A model nobody
// priced is `null`, and the report names it as unpriced rather than counting it at zero or at another model's rate.
// `prices` in .thinker/config.json adds or overrides one: {"gpt-7": {"input": 2, "output": 8}} (dollars per million;
// cacheRead defaults to a tenth of input, cacheWrite to 1.25 times it, cacheWrite1h to twice it). A cache write is priced by
// its TTL since 2026-10-25: Claude Code and pi write every breakpoint at one hour (Claude Code's messages breakpoint at five
// minutes aside), twice the input rate, and the usage says which (`cache_creation.ephemeral_1h_input_tokens`,
// transcripts.js:Stats `cacheWrite1hTokens`); until then every write was priced at the five-minute rate, a third under.
import { relativeRate } from './model-usage.js';

export const OPUS_INPUT = 4; // Claude Opus 5.5, dollars per million input tokens (relativeRate's unit)
export const PRICED_ON = '2026-10-22';
const OTHER = [
  [/gpt-6[.-]?1?-?astra|gpt-6-astra/, { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }],
  [/gpt-6[.-]?1?-?sol/, { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }],
  [/gpt-6[.-]?1?-?luna/, { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }],
  [/gemini-3\.[78]-flash/, { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.9375 }],
  [/gemini-3\.[01]-pro|gemini-3-pro/, { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 }],
  [/gemini-3\.5-flash-lite/, { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.375 }],
];

const fill = p => ({ input: p.input, output: p.output ?? p.input * 5, cacheRead: p.cacheRead ?? p.input / 10, cacheWrite: p.cacheWrite ?? p.input * 1.25, cacheWrite1h: p.cacheWrite1h ?? p.input * 2 });
// dollars per million tokens of the four kinds, or null for a model without a price
export function listPrice(model, { config } = {}) {
  const m = String(model || '').toLowerCase().replace(/^(claude|anthropic|cursor|openai|google)\//, '');
  if (!m) return null;
  const own = config?.prices && typeof config.prices === 'object' ? Object.entries(config.prices).find(([k]) => k.toLowerCase() === m || m.startsWith(k.toLowerCase())) : null;
  if (own && own[1] && Number.isFinite(own[1].input)) return fill(own[1]);
  const other = OTHER.find(([re]) => re.test(m));
  if (other) return other[1];
  const r = relativeRate(m);
  return r ? { input: r.input * OPUS_INPUT, output: r.output * OPUS_INPUT, cacheRead: r.cacheRead * OPUS_INPUT, cacheWrite: r.cacheWrite * OPUS_INPUT, cacheWrite1h: r.cacheWrite1h * OPUS_INPUT } : null;
}

// The provider a model name belongs to, for the Report's grouping; the client is the fallback for an alias
export function providerOf(model, client) {
  const m = String(model || '').toLowerCase();
  if (/claude|anthropic|^(opus|sonnet|haiku|fable|mythos)\b/.test(m)) return 'Anthropic';
  if (/gpt|^o\d|codex|openai/.test(m)) return 'OpenAI';
  if (/gemini|google/.test(m)) return 'Google';
  return { claude: 'Anthropic', codex: 'OpenAI', gemini: 'Google', cursor: 'Cursor' }[client] || 'Other';
}

// Dollars for a session's tokens: fresh input at the input rate (inputTokens includes the cache reads and writes,
// model-usage.js:normalizeModelUsage), cache reads and writes at theirs, output at the output rate. null without a price.
// cache writes at their TTL's rate: the one-hour writes (at most all of them) at cacheWrite1h, the rest at the five-minute rate
export const writeCost = (write, write1h, price) => { const w1 = Math.min(Math.max(0, write1h || 0), write); return w1 * (price.cacheWrite1h ?? price.cacheWrite) + (write - w1) * price.cacheWrite; };
export function costOf(usage, price) {
  if (!price || !usage) return null;
  const n = k => Number.isFinite(usage[k]) ? usage[k] : 0;
  const read = n('cacheRead'), write = n('cacheWrite'), fresh = Math.max(0, n('input') - read - write);
  return (fresh * price.input + read * price.cacheRead + writeCost(write, n('cacheWrite1h'), price) + n('output') * price.output) / 1e6;
}

// Signed input savings allocated to the observed request's input mix (cache-savings.js).
// Unlike billed usage, net savings can be negative after carried note text is subtracted.
export function costOfInputSavings(s, price) {
  if (!price) return null;
  return ((s.fresh || 0) * price.input + (s.cacheRead || 0) * price.cacheRead
    + ((s.cacheWrite || 0) - (s.cacheWrite1h || 0)) * price.cacheWrite
    + (s.cacheWrite1h || 0) * (price.cacheWrite1h ?? price.cacheWrite)) / 1e6;
}

// A dollar figure for people: $0.42, $3.80, $127, $1.2k
export function formatDollars(d) {
  if (d == null || !Number.isFinite(d)) return '–';
  const a = Math.abs(d), s = d < 0 ? '−' : '';
  if (a >= 10000) return `${s}$${(a / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (a >= 100) return `${s}$${Math.round(a)}`;
  if (a >= 10) return `${s}$${a.toFixed(1)}`;
  if (a >= 0.01 || a === 0) return `${s}$${a.toFixed(2)}`;
  return `${s}$${a.toFixed(3)}`;
}
