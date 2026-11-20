import { delegateConfig, REPORT_SLOT, DELEGATE_DEFAULTS } from '../delegate.js';
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

// The delegated run, on the host's own subagent machinery (delegate.js:hostRunOrder; probed on 2.2.7, 2026-11-15).
// `session.create({ parentID, agent, model })` is a child session OpenCode bills, draws and records like any
// subagent of its own; `prompt` starts it, `wait` returns when it is idle, and `context` is its messages, the last
// assistant one holding the report as `text` parts. `agent` and `model` belong on `create`: given to `prompt`
// they are accepted and ignored, and the child answers as `build` on the host's default model.
// Resolves to the report, or '' -- and '' lets the read through, since a hook may not fail a tool call.
export const canRun = ctx => ['create', 'prompt', 'wait', 'context'].every(f => typeof ctx?.session?.[f] === 'function');
export async function hostRun(ctx, parentID, order, { timeoutMs = DELEGATE_DEFAULTS.timeoutMs } = {}) {
  let child = null, timer = null;
  try {
    child = await ctx.session.create({ parentID, title: order.title || 'thinker', agent: order.agent, ...(order.model ? { model: order.model } : {}) });
    if (!child?.id) return '';
    await ctx.session.prompt({ sessionID: child.id, text: order.prompt });
    const late = new Promise(resolve => { timer = setTimeout(() => resolve('late'), timeoutMs); });
    if (await Promise.race([ctx.session.wait({ sessionID: child.id }), late]) === 'late') {
      try { await ctx.session.interrupt?.({ sessionID: child.id }); } catch { /* it is abandoned either way */ }
      return '';
    }
    const messages = await ctx.session.context({ sessionID: child.id });
    const last = (Array.isArray(messages) ? messages : []).filter(m => m?.type === 'assistant').pop();
    return (Array.isArray(last?.content) ? last.content : []).filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n').trim();
  } catch { return ''; } finally { clearTimeout(timer); }
}
// One report a file a turn, and one run however many calls ask for it: a whole read (no range) of a file already
// reported gets the same report back, and from 2026-11-19 so does one still being reported on another call of the
// same batch. The entry is the run itself, keyed before the first `await` below, because a batch's calls all reach
// this hook before the lead has seen any of their answers: the rule can only tell them the file was handed over
// already, which lets it through on purpose (a lead that insists), and the file then landed in the context the
// handoff had just kept it out of. What `register.tsx:flight` is for Claude Code's mod, where it was measured.
const reports = new Map();
// `run` resolves to `{ result, keep }`: the call's result, and whether it is this file's report, which the turn
// keeps (`keep`). Words asking the lead to run the subagent itself are answered to every call of the batch and
// then dropped, so the lead that insists a call later is still never denied the same file twice.
async function once(key, run) {
  const flight = key ? reports.get(key) : null;
  if (flight) return flight;
  if (!key) return (await run()).result;
  let settle = () => {};
  reports.set(key, new Promise(done => { settle = done; }));
  const done = (result, keep) => { settle(result || null); if (!result || !keep) reports.delete(key); };
  try { const { result, keep } = await run(); done(result, keep); return result; }
  catch (err) { done(null, false); throw err; }
}
// the person's last prompt a session, for the brief (delegate.js:preToolHook reads it as `user_prompt`)
const prompts = new Map();
const whole = ev => ev.tool === 'read' && ev.input && ev.input.offset == null && ev.input.limit == null;
const reportKey = ev => `${ev.sessionID}\n${ev.input?.path ?? ev.input?.file_path ?? ''}`;

// The one line the screens draw for what thinker served; the block itself is the model's to read.
export const SYNTHETIC_NOTE = 'thinker context';

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
        // The delegation trigger (delegate.js): a read of the threshold's size or more, or a whole-suite run is handed
        // to a subagent, and its report is thrown here, which v2 makes the call's result (checked live on 2.2.7:
        // the model read the report and answered from it). The CLI answers the same JSON as Claude Code's
        // PreToolUse deny; a call that goes through gets no answer and the hook returns in silence.
        // On by default (2026-11-16). The switch is read at each call, not once at setup (2026-11-18): an OpenCode
        // left open for days keeps the plugin it loaded, and a switch read at its start would hold it to the setting
        // of that day. The decision itself was always the installed CLI's (`hook pretool`), so an open session runs
        // the current release's rule, as it does for the cuts, which the proxy makes.
        await ctx.tool.hook('execute.before', async ev => {
          if (!['read', 'shell', 'bash'].includes(ev.tool)) return;
          if (!delegateConfig().enabled) return;
          // a whole read of a file this turn already has a report for, or is getting one for on another call of
          // the same batch: that report, and no second run (`once`)
          const result = await once(whole(ev) ? reportKey(ev) : '', async () => {
            // The lead's model, which neither hook event carries: `session.get({ sessionID })` answers
            // `model: { id, providerID, variant }` (probed live on 2.2.7, 2026-11-15). The trigger reads it to
            // hand the read to the lead's own family's cheap model on a gateway (delegate.js:EXPLORER_FAMILIES);
            // a host that will not say gets the plain agent, as before.
            let model = null;
            try { const s = await ctx.session?.get?.({ sessionID: ev.sessionID }); if (s?.model?.id) model = { id: s.model.id, providerID: s.model.providerID }; } catch { /* the read is never held up for it */ }
            const text = await run('pretool', { session_id: ev.sessionID, cwd: cwd(), tool_name: ev.tool, tool_input: ev.input, agent: ev.agent, ...(model ? { model } : {}), host_runs: canRun(ctx), ...(prompts.has(ev.sessionID) ? { user_prompt: prompts.get(ev.sessionID) } : {}) });
            if (!text) return { result: null };
            let reason = '', order = null;
            try { const j = JSON.parse(text); if (j.hookSpecificOutput?.permissionDecision === 'deny') reason = j.hookSpecificOutput.permissionDecisionReason || ''; order = j.thinkerRun || null; } catch {}
            if (!reason) return { result: null };
            // The plugin runs the subagent and the report is the call's result (delegate.js:hostRunOrder). A run
            // that fails or runs out of time lets the read through, as a failed subagent always has: the words
            // alone are what Claude and GPT leads were seen not to follow, so falling back to them is no fallback.
            if (!order) return { result: reason };
            const report = await hostRun(ctx, ev.sessionID, order);
            return report ? { result: order.wrap.replace(REPORT_SLOT, report), keep: true } : { result: null };
          });
          if (result) throw new Error(result);
        });
        await ctx.session.hook('prompt', async ev => {
          for (const k of reports.keys()) if (k.startsWith(ev.sessionID + '\n')) reports.delete(k);   // a new turn
          const prompt = ev.prompt?.text;
          if (!prompt) return;
          // kept for the delegation brief: the hook has no transcript to read the request from here
          prompts.set(ev.sessionID, prompt.slice(0, 4000)); if (prompts.size > 200) prompts.delete(prompts.keys().next().value);
          const text = await run('prompt', { session_id: ev.sessionID, cwd: cwd(), prompt });
          if (!text) return;
          // Never on the person's own message. v1 pushed a `synthetic: true` text part beside it (#742);
          // v2's admission hook holds a draft (`text`, `files`, `agents`, `skills`) with no parts of its
          // own, so an edit there *is* the prompt and the profile block was drawn in the conversation.
          // The host's own door for context the model reads and the screens do not is a synthetic
          // message (`session.synthetic`, exposed to plugins on 2.2.7): opencode's plan-mode reminders
          // and its subagent and shell notices ride it, the TUI draws `description` alone as one muted
          // notice line and never the text, and an export reads it as `[Synthetic context]`.
          // `resume: false` keeps it from starting a turn of its own. Where the call is refused the
          // bundle still goes on the draft: served in sight beats not served.
          try {
            await ctx.session.synthetic({ sessionID: ev.sessionID, text, description: SYNTHETIC_NOTE, resume: false });
          } catch {
            ev.prompt.text += '\n\n' + text;
          }
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
