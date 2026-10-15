// Loaded by the generated project extension. No Pi SDK dependency is required.
import { hookRunner, guidance, warmupAnswer } from './runner.js';
import { WARMUP_CHOICES, OFFER_BLOCK } from '../warmup-choices.js';
export function piExtension(pi, config, run = hookRunner(config), answer = choice => warmupAnswer(config, choice)) {
  const event = (ctx, extra = {}) => ({ session_id: ctx.sessionManager.getSessionId(), ...extra });
  if (config.hooks) {
    pi.on('before_agent_start', async (e, ctx) => {
      let text = await run('prompt', event(ctx, { prompt: e.prompt }));
      // the warm-up offer (repo-onboard.js:warmupOffer) as pi's own picker, before the agent starts; without a
      // UI (print mode) the offer stays for the agent, which asks in chat
      if (ctx.hasUI && OFFER_BLOCK.test(text)) {
        text = text.replace(OFFER_BLOCK, '').trim();
        const options = WARMUP_CHOICES.map(c => `${c.label}: ${c.description}`);
        const pick = await ctx.ui.select('Warm up thinker\'s cache for this repository?', options);
        const said = await answer(WARMUP_CHOICES[options.indexOf(pick)]?.value || 'dismissed');
        if (said) ctx.ui.notify(said, 'info');
      }
      const content = [config.mcp ? guidance(config) : '', text].filter(Boolean).join('\n\n');
      if (content) return { message: { customType: 'thinker-cache', content, display: false } };
    });
    if (config.late || config.learn) pi.on('tool_result', async (e, ctx) => {
      const text = await run('tool', event(ctx, { tool_name: e.toolName, tool_input: e.input, tool_response: e.content, is_error: e.isError }));
      if (text) return { content: [...e.content, { type: 'text', text }] };
    });
    pi.on('agent_end', async (e, ctx) => {
      const last = e.messages.filter(m => m.role === 'assistant').at(-1);
      const notice = await run('stop', event(ctx, { last_assistant_message: last?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') }));
      if (notice && ctx.hasUI) ctx.ui.notify(notice, 'info');
    });
    if (config.learn) pi.on('session_shutdown', async (_e, ctx) => { await run('stop', event(ctx, { hook_event_name: 'SessionEnd' })); });
  } else if (config.mcp) {
    pi.on('before_agent_start', async () => ({ message: { customType: 'thinker-cache', content: guidance(config), display: false } }));
  }
}
