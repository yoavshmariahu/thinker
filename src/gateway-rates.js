// The cut decision's rates, resolved per model instead of assumed Anthropic's (the owner's ask,
// 2026-11-10: dynamic costs, "critical for deciding cost-effective cuts").
//
// The payback arithmetic (cutting.js:priceCut) needs two ratios to an input token: what a cache
// write costs (Anthropic 1h: 2.0) and what a cache read costs (Anthropic: 0.1). Across gateways
// neither holds: implicit-cache providers (OpenAI, Google) charge full input price for the
// rewrite and discount reads to a half or a quarter, and Anthropic-through-OpenRouter writes at
// 1.25 -- so the old constants over-refuse every cut there. Three sources, best first:
//
//   1. config      `proxy: { rates: { '<model>': { read, write }, '*': … } }` in the machine
//                  config -- the person's word beats everything.
//   2. measured    OpenRouter answers every call with the account's own `cost` beside the token
//                  split. Fit the per-token prices across the answers the proxy has already seen
//                  (least squares, no network, no model call) and read the ratios off the fit.
//                  A provider that never reports cache-write tokens leaves the coefficient
//                  unidentified; there the rewrite costs full input price (1.0), which is what
//                  implicit caching charges -- named on the rates (`assumed`), never silent.
//   3. default     the Anthropic constants, as before. `source` names which one priced a
//                  decision, so every cut in the log is auditable against its rates.

// Fit the per-token prices from observed answers: cost ~= f*fresh + r*read + w*write + o*out.
// Ordinary least squares on the normal equations; a feature that never varied in the window is
// dropped and named unidentified, because a fit that cannot see a coefficient must not be read
// as one that measured it at zero.
const FEATURES = ['fresh', 'read', 'write', 'out'];
const MIN_OBSERVATIONS = 8;

function solve(x, features) {
  // a feature that never varied has no price to fit: drop it and name it, so a fit that cannot
  // see a coefficient is never read as one that measured it at zero
  const norm = f => Math.sqrt(x.reduce((s, r) => s + r[f] * r[f], 0));
  const zeroed = features.filter(f => norm(f) === 0);
  const live = features.filter(f => norm(f) > 0);
  const n = live.length;
  if (!n) return { coeffs: {}, unidentified: [...zeroed] };
  // normal equations: a[i][j] = sum(x_i * x_j), a[i][n] = sum(x_i * cost)
  const a = Array.from({ length: n }, (_, i) => Array.from({ length: n + 1 }, (_, j) =>
    j < n ? x.reduce((s, r) => s + r[live[i]] * r[live[j]], 0)
          : x.reduce((s, r) => s + r[live[i]] * r.cost, 0)));
  // a relative ridge, so a repeated row cannot make the solve explode without hiding a zero column
  for (let i = 0; i < n; i++) a[i][i] *= 1 + 1e-12;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[piv][c])) piv = r;
    if (Math.abs(a[piv][c]) < 1e-12) {
      if (n === 1) return { coeffs: {}, unidentified: [...zeroed, live[0]] };
      const rest = solve(x, live.filter((_, i) => i !== c));
      return rest && { ...rest, unidentified: [...(rest.unidentified || []), ...zeroed, live[c]] };
    }
    [a[c], a[piv]] = [a[piv], a[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r][c] / a[c][c];
      for (let k = c; k <= n; k++) a[r][k] -= f * a[c][k];
    }
  }
  // a negative price is noise, never a credit; a price below a billionth of an input token is the
  // ridge's own noise, not a measurement
  const coeffs = Object.fromEntries(live.map((f, i) => {
    const v = a[i][n] / a[i][i];
    return [f, v < 1e-9 ? 0 : Math.max(0, v)];
  }));
  return { coeffs: { ...Object.fromEntries(zeroed.map(f => [f, 0])), ...coeffs }, unidentified: zeroed };
}

export function fitPrices(rows) {
  const obs = rows.filter(r => FEATURES.every(f => Number.isFinite(r[f]) && r[f] >= 0)
    && Number.isFinite(r.cost) && r.cost >= 0
    && FEATURES.some(f => r[f] > 0));
  if (obs.length < MIN_OBSERVATIONS) return null;
  const r = solve(obs, FEATURES);
  return { ...r.coeffs, unidentified: r.unidentified, observations: obs.length };
}

// Keeps the last KEEP observations per model; the fit is solved at most once per new
// observation (a 4x4 solve), and every decision reads the fit for its model's current count.
const KEEP = 200;
export function rateTracker() {
  const seen = new Map();
  const fits = new Map();   // model -> { count, fit }
  return {
    observe(model, usage) {
      if (!model || !usage || !Number.isFinite(usage.cost)) return;
      const fresh = (usage.input || 0) - (usage.read || 0) - (usage.write || 0);
      const list = seen.get(model) || [];
      list.push({ fresh, read: usage.read || 0, write: usage.write || 0, out: usage.out || 0, cost: usage.cost });
      if (list.length > KEEP) list.shift();
      seen.set(model, list);
    },
    fit(model) {
      const list = seen.get(model);
      if (!list) return null;
      const cached = fits.get(model);
      if (cached && cached.count === list.length) return cached.fit;
      const fit = fitPrices(list);
      fits.set(model, { count: list.length, fit });
      return fit;
    },
  };
}

// The ratios priceCut prices with, per model: { read, write, source, assumed? }. Scale-free:
// read and write are in units of one fresh input token, which is 1.0 by definition. null sends
// the caller to cutting.js's Anthropic defaults, as before this existed.
export function makeRatesResolver({ tracker = null, configured = null, prices = null } = {}) {
  const valid = r => r && Number.isFinite(r.read) && r.read >= 0 && Number.isFinite(r.write) && r.write >= 0;
  const config = model => {
    if (!configured || typeof configured !== 'object') return null;
    const hit = valid(configured[model]) ? configured[model] : valid(configured['*']) ? configured['*'] : null;
    return hit ? { read: hit.read, write: hit.write, source: 'config' } : null;
  };
  const round = v => Math.round(v * 1000) / 1000;
  return model => {
    const c = config(model);
    if (c) return c;
    const fit = tracker?.fit(model);
    if (fit && fit.fresh > 0) {
      const rates = { read: round(fit.read / fit.fresh), source: 'measured' };
      // identified-at-zero (the gateway reports writes and they carry no charge) and unidentified
      // (it never reports them; the rewrite there costs full input price) are different facts
      const identified = !(fit.unidentified || []).includes('write');
      rates.write = identified ? round(fit.write / fit.fresh) : 1;
      if (!identified) rates.assumed = ['write'];
      return rates;
    }
    // 4. the price list, where the provider's cache prices are stated (prices.js:statedRates). The fit above
    //    needs a gateway that reports its own cost; a direct provider route never does, and leaving it on
    //    Anthropic's ratios prices its cuts wrong by the full ratio between the two providers.
    if (typeof prices === 'function') {
      let listed = null; try { listed = prices(model); } catch { listed = null; }
      if (valid(listed)) return { read: listed.read, write: listed.write, source: listed.source || 'price-list' };
    }
    return null;
  };
}
