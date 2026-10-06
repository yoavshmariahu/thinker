import { jevConfig, jevEvaluate } from './jev.js';
import { logModelUsage } from './model-usage.js';

// Learning decisions share serving's credentials and test guard. Disabled is distinct from
// unavailable: callers may retain the explicit local-only workflow, but must not mistake
// a failed check for approval. No payload is written to the usage log.
export async function judgeWithJev(store, { state, questions, purpose, phase = 'learning', ...context }, overrides = {}) {
  const cfg = { ...jevConfig(store), ...overrides };
  if (!cfg.enabled) return { status: 'disabled', reason: 'jev disabled' };
  let response;
  try {
    if (phase !== 'init') {
      // Deferred import avoids the maintenance -> phrase -> judgment cycle.
      const { withinDailyCap } = await import('./maintain.js');
      if (!withinDailyCap(store).ok) return { status: 'unavailable', reason: 'dailyTokens' };
    }
    response = await jevEvaluate(state, questions, {
      ...cfg, timeoutMs: cfg.learningTimeoutMs ?? cfg.searchTimeoutMs ?? cfg.timeoutMs,
      onResponse: r => { response = r; },
    });
    logModelUsage(store, { ...context, purpose, phase }, { ...response, provider: 'typesafe' });
    return { ...response, status: 'ok' };
  } catch (error) {
    logModelUsage(store, { ...context, purpose, phase }, {
      provider: 'typesafe', model: response?.model || cfg.model, usage: response?.usage, failed: true,
    });
    return { status: 'unavailable', reason: String(error.message).slice(0, 160) };
  }
}
