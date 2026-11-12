import { delegateConfig } from '../delegate.js';
import { hookRunner } from './runner.js';

// OpenCode 2's server part. OpenCode 1 plugins returned a map of hook handlers; v2 registers everything
// inside one `setup(ctx)` and hooks take one mutable event. The shapes were checked against a real
// opencode 2.2.7 (2026-11-10): `ctx.session.hook('prompt', ev => ev.prompt.text)`,
// `ctx.tool.hook('execute.after', ev => ev.result.content)`, `ctx.event.subscribe` for the turn's end
// (`session.execution.succeeded`, where v1 said `session.idle`), `ctx.mcp.transform` for the server.
// The v1 names do not run in v2 at all, so the installer writes this wrapper beside `opencode-tui.js`
// only for a v2 binary (`clients.js:opencodeMajor`).
//
// What v2's server part cannot do: show a toast. v1's end-of-turn notice went through
// `client.tui.showToast` and the v2 plugin context exposes no client. The notice text still comes back
// from the Stop hook; the CLI writes it to `THINKER_HOME/state/notice-last.json`
// (notice-cadence.js:writeNoticeLast) and the terminal part (opencode-tui.js) toasts it there. In a
// headless `opencode run` there is no terminal part and the notice is dropped, as it was in v1.
export function opencodeV2(config, run = hookRunner(config)) {
  return {
    // `config.id` lets a checkout's copy load beside the installed one (OpenCode keeps one plugin per id)
    id: config.id || 'thinker',
    async setup(ctx) {
      const cwd = () => config.repo || ctx.location?.directory || process.cwd();
      if (config.mcp && config.mcpEntry) {
        await ctx.mcp.transform(editor => {
          editor.set('thinker', { type: 'local', command: [config.mcpEntry.command, ...config.mcpEntry.args], environment: config.mcpEntry.env || {}, enabled: true });
        });
      }
      if (config.hooks) {
        // The delegation trigger (delegate.js): a read past the turn's threshold or a whole-suite run is handed
        // to a subagent, and its report is thrown here, which v2 makes the call's result (checked live on 2.2.7:
        // the model read the report and answered from it). The CLI answers the same JSON as Claude Code's
        // PreToolUse deny; a call that goes through gets no answer and the hook returns in silence.
        // Off by default (2026-11-12); read once at setup, so switching it on needs OpenCode started again.
        if (delegateConfig().enabled) await ctx.tool.hook('execute.before', async ev => {
          if (!['read', 'shell', 'bash'].includes(ev.tool)) return;
          const text = await run('pretool', { session_id: ev.sessionID, cwd: cwd(), tool_name: ev.tool, tool_input: ev.input, agent: ev.agent });
          if (!text) return;
          let reason = '';
          try { const j = JSON.parse(text); if (j.hookSpecificOutput?.permissionDecision === 'deny') reason = j.hookSpecificOutput.permissionDecisionReason || ''; } catch {}
          if (reason) throw new Error(reason);
        });
        await ctx.session.hook('prompt', async ev => {
          const prompt = ev.prompt?.text;
          if (!prompt) return;
          const text = await run('prompt', { session_id: ev.sessionID, cwd: cwd(), prompt });
          // v1 appended to an existing text part to preserve the host's part identifiers; v2's
          // admission hook receives one owned draft and the edit becomes the canonical prompt.
          if (text) ev.prompt.text += '\n\n' + text;
        });
      }
      if (config.late || config.learn) {
        await ctx.tool.hook('execute.after', ev => {
          if (ev.status !== 'completed') return;
          const response = typeof ev.result?.output?.output === 'string' ? ev.result.output.output : JSON.stringify(ev.result?.output ?? '') ;
          run('tool', { session_id: ev.sessionID, cwd: cwd(), tool_name: ev.tool, tool_input: ev.input, tool_response: response }).then(text => {
            if (!text || !ev.result || !Array.isArray(ev.result.content)) return;
            ev.result.content.push({ type: 'text', text });
          }).catch(() => {});
        });
      }
      const controller = new AbortController();
      void (async () => {
        for await (const ev of ctx.event.subscribe({ signal: controller.signal })) {
          const type = ev?.type || '';
          // Checked live on 2.2.7: a v2 event is {id, created, type, durable, data}, and the
          // execution events carry the session in `data.sessionID` (v1 kept it in `properties`).
          const session = ev?.data?.sessionID ?? ev?.data?.info?.id ?? ev?.sessionID;
          if (type === 'session.execution.succeeded' || type === 'session.execution.failed') {
            try { await run('stop', { session_id: session, cwd: cwd() }); } catch {}
          }
          if (config.learn && (type === 'session.deleted' || type === 'session.removed')) {
            try { await run('stop', { session_id: session, cwd: cwd(), hook_event_name: 'SessionEnd' }); } catch {}
          }
        }
      })().catch(() => {});
      return () => controller.abort();
    },
  };
}
