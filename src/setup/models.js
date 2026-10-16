// Harness selection determines the model in terminal setup, warm-up and the local page.
import { DEFAULT_DISTILL_MODEL, resolveModel } from '../llm.js';
import { c } from './ui.js';

export function buildModel(agent, { model, configModel } = {}) {
  const tier = model || configModel || DEFAULT_DISTILL_MODEL;
  const resolved = resolveModel(agent, tier);
  const automatic = !model && !configModel && !process.env.THINKER_LLM_MODEL;
  const name = agent === 'session' ? 'your session\'s model' : automatic ? (agent === 'codex' ? 'Luna' : agent === 'gemini' ? 'Gemini Flash' : 'Sonnet') : resolved;
  return { tier, model: resolved, name, automatic };
}

export function useBuildModel({ agent, model, configModel, out = console.log } = {}) {
  const selected = buildModel(agent, { model, configModel });
  out(`  Model: ${c.bold(selected.name)} ${c.dim(selected.automatic ? '(automatic)' : '(configured)')}\n`);
  return selected.tier;
}
