// Loaded by the generated project extension. No Pi SDK dependency is required.
import { hookRunner } from './runner.js';
export function piExtension(pi, config, run = hookRunner(config)) {
  const event = (ctx, extra = {}) => ({ session_id: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, ...extra });
  if (config.hooks) {
    pi.on('before_agent_start', async (e, ctx) => {
      const text = await run('prompt', event(ctx, { prompt: e.prompt }));
      if (text) return { message: { customType: 'thinker-cache', content: text, display: false } };
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
  }
}
