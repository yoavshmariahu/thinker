// One model menu for terminal setup, installer warm-up and the local page.
import { DEFAULT_DISTILL_MODEL, TIER_MODELS } from '../llm.js';
import { c, selectMenu } from './ui.js';

export const MODEL_GUIDANCE = 'Recommended: Haiku, Luna or Gemini Flash. Other models are a bit more expensive.';

export function buildModels(agent) {
  if (process.env.THINKER_LLM_MODEL) return [{ tier: DEFAULT_DISTILL_MODEL, model: process.env.THINKER_LLM_MODEL,
    name: process.env.THINKER_LLM_MODEL, label: `${process.env.THINKER_LLM_MODEL} · set by THINKER_LLM_MODEL` }];
  const recommended = {
    tier: DEFAULT_DISTILL_MODEL,
    model: TIER_MODELS[DEFAULT_DISTILL_MODEL]?.[agent] || DEFAULT_DISTILL_MODEL,
    name: agent === 'codex' ? 'Luna' : agent === 'gemini' ? 'Gemini Flash' : 'Haiku',
    recommended: true,
  };
  const others = agent === 'codex'
    ? [{ tier: 'gpt-6-sol', model: 'gpt-6-sol', name: 'Sol' }, { tier: 'gpt-6-astra', model: 'gpt-6-astra', name: 'Astra' }]
    : ['claude', 'cursor', 'anthropic'].includes(agent)
      ? ['sonnet', 'opus'].map(tier => ({ tier, model: tier, name: tier[0].toUpperCase() + tier.slice(1) })) : [];
  return [recommended, ...others].map(m => ({ ...m, label: `${m.name} · ${m.recommended ? 'recommended' : 'more expensive'}` }));
}

export async function selectBuildModel({ agent, model, configModel, yes = false, out = console.log,
  stdin = process.stdin, stdout = process.stdout, selectMenuFn = selectMenu } = {}) {
  // Explicit flags and environment overrides remain usable by scripts and benchmark harnesses.
  if (process.env.THINKER_LLM_MODEL) {
    out(`  Model: ${process.env.THINKER_LLM_MODEL} (set by THINKER_LLM_MODEL)`);
    return model || configModel || DEFAULT_DISTILL_MODEL;
  }
  const current = model || configModel || DEFAULT_DISTILL_MODEL;
  const models = buildModels(agent);
  if (!models.some(m => m.tier === current)) models.push({ tier: current, model: current, label: `${current} · configured model` });
  let selected = models.find(m => m.tier === current);
  if (!model && !yes && stdin?.isTTY) {
    out(`  ${c.dim(MODEL_GUIDANCE)}`);
    const choice = await selectMenuFn({ header: `\n  ${c.bold('Choose the model for the cache build')}`,
      items: models.map(m => ({ label: `${m.label} (${m.model})`, value: m.tier })),
      defaultIndex: models.indexOf(selected), out, stdin, stdout });
    if (!choice) return null;
    selected = models.find(m => m.tier === choice.value);
  }
  out(`  Model: ${c.bold(selected.model)} ${c.dim(selected.recommended ? '(recommended)' : '(configured selection)')}\n`);
  return selected.tier;
}
