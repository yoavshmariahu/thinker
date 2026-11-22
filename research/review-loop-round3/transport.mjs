// Research-only full-source transport. Same response validation as src/jev.js; no production change.
// 150 KB byte ceiling is a harness bound, not a token estimate. Provider enforces context limits.
const JEV_ENDPOINT='https://api.typesafe.ai/v1/systemone';
export async function jevEvaluate(state, questions, cfg = {}) {
  const { key, model, timeoutMs = 30000,
    fetchImpl = fetch, signal, onResponse } = cfg;
  const entries = Object.entries(questions || {});
  if (!entries.length) return { answers: {}, model, usage: null };
  if (entries.length > 32) throw new Error('jev: too many questions');
  if (entries.some(([, q]) => !['noul', 'choice'].includes(q.type))) throw new Error('jev: unsupported question type');
  const body = JSON.stringify({ model, state, questions });
  if (Buffer.byteLength(body) > 150000) throw new Error('jev: request exceeds limit');
  if (process.env.THINKER_TEST === '1' && fetchImpl === globalThis.fetch) throw new Error('jev network disabled in tests');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, ctl.signal]) : ctl.signal;
  try {
    requestSignal.throwIfAborted();
    if (!key) throw Error('Personal key required; no hosted enrollment');
    const res = await fetchImpl(JEV_ENDPOINT, {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body, signal: requestSignal, redirect: 'error',
    });
    if (!res.ok) throw new Error(`jev ${res.status}`);
    const j = await res.json();
    if (onResponse) onResponse(j);
    requestSignal.throwIfAborted();
    if (!j?.answers) throw new Error('jev: no answers');
    const probability = v => Number.isFinite(v) && v >= 0 && v <= 1;
    for (const [id, q] of entries) {
      const a = j.answers[id];
      if (!a || (a.type !== undefined && a.type !== q.type)) throw new Error(`jev: missing or invalid ${id}`);
      if (q.type === 'noul') {
        if (!probability(a.noul)) throw new Error(`jev: missing or invalid ${id}`);
      } else {
        const options = Object.keys(q.criteria || {}), ps = a.probabilities;
        if (!options.length || !options.includes(a.choice) || !ps ||
            Object.keys(ps).length !== options.length || options.some(k => !probability(ps[k])) ||
            Math.abs(options.reduce((sum, k) => sum + ps[k], 0) - 1) > 0.02 ||
            options.some(k => ps[k] > ps[a.choice] + 1e-6) ||
            (a.confidence !== undefined && !probability(a.confidence))) throw new Error(`jev: missing or invalid ${id}`);
      }
    }
    return j;
  } finally { clearTimeout(timer); }
}
