import { hookRunner } from './runner.js';
export function opencodePlugin(config, run = hookRunner(config)) {
  // installed machine-wide (no config.repo): the session's checkout is the plugin's worktree. No instructions are
  // added: the workflow file this pointed OpenCode at went on 2026-10-22, with the agent's MCP tools.
  return async ({ client, directory, worktree } = {}) => { const cwd = config.repo || worktree || directory || process.cwd(); return {
    ...((config.mcp || config.hooks) ? { config: async c => {
      if (config.mcp) c.mcp = { ...c.mcp, thinker: { type: 'local', command: [config.mcpEntry.command, ...config.mcpEntry.args], environment: config.mcpEntry.env || {}, enabled: true } };
    } } : {}),
    ...(config.hooks ? {
      'chat.message': async (input, output) => {
        const prompt = output.parts.filter(p => p.type === 'text' && !p.synthetic).map(p => p.text).join('\n');
        if (!prompt) return;
        const text = await run('prompt', { session_id: input.sessionID, cwd, prompt });
        // Append to an existing text part to preserve the host's part identifiers.
        if (text) output.parts.find(p => p.type === 'text' && !p.synthetic).text += '\n\n' + text;
      },
      ...((config.late || config.learn) ? { 'tool.execute.after': async (input, output) => {
        const text = await run('tool', { session_id: input.sessionID, cwd, tool_name: input.tool, tool_input: input.args, tool_response: output.output });
        if (text) output.output += '\n\n' + text;
      } } : {}),
      event: async ({ event }) => {
        if (event.type === 'session.idle') {
          const notice = await run('stop', { session_id: event.properties.sessionID, cwd });
          if (notice) {
            try { await client?.tui?.showToast({ body: { message: notice, variant: 'info' } }); } catch {}
          }
        }
        if (config.learn && event.type === 'session.deleted') await run('stop', { session_id: event.properties.info.id, cwd, hook_event_name: 'SessionEnd' });
      },
    } : {}),
  }; };
}
