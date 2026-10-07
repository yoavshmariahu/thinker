import { jevConfig, jevEvaluate } from './jev.js';
import { logModelUsage } from './model-usage.js';

// Learning decisions share serving's credentials and test guard. Disabled is distinct from
// unavailable: callers may retain the explicit local-only workflow, but must not mistake
// a failed check for approval. No payload is written to the usage log.
export async function judgeWithJev(store, { state, questions, purpose, phase = 'learning', ...context }, overrides = {}) {
  const cfg = { ...jevConfig(store), ...overrides };
  if (!cfg.enabled) return { status: 'disabled', reason: 'jev disabled' };
  // Retry transient transport/schema failures once with the identical model and request.
  // A valid negative/uncertain judgment is never retried to seek a different answer.
  const attempts = cfg.learningAttempts === 1 ? 1 : 2;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response;
    try {
      if (phase !== 'init') {
        // The Jev budget, not the generative one: a day of distillation must not stop the checks
        // that decide whether a note may be written (maintain.js:withinJevDailyCap).
        const { withinJevDailyCap } = await import('./maintain.js');
        if (!withinJevDailyCap(store).ok) return { status: 'unavailable', reason: 'dailyJevTokens' };
      }
      response = await jevEvaluate(state, questions, {
        ...cfg, timeoutMs: cfg.learningTimeoutMs ?? cfg.searchTimeoutMs ?? cfg.timeoutMs,
        onResponse: r => { response = r; },
      });
      logModelUsage(store, { ...context, purpose, phase, attempt }, { ...response, provider: 'typesafe' });
      return { ...response, status: 'ok', attempts: attempt };
    } catch (error) {
      logModelUsage(store, { ...context, purpose, phase, attempt, errorCode: error.code,
        errorQuestion: error.question, errorReason: error.reason || String(error.message).slice(0, 160) }, {
        provider: 'typesafe', model: response?.model || cfg.model, usage: response?.usage, failed: true,
      });
      const transient = error.retryable || ['AbortError', 'TimeoutError'].includes(error.name) || error.message === 'fetch failed';
      if (attempt === attempts || !transient || cfg.signal?.aborted) {
        return { status: 'unavailable', reason: String(error.message).slice(0, 160), attempts: attempt,
          errorCode: error.code, question: error.question };
      }
    }
  }
}
