import { isTestMode } from '../test-mode.js';
import { gitContext, tryImpact } from '../impact-journal.js';
// The hook entrypoints the agents call (clients.js installs them): prompt, tool and stop, with the
// background catch-up they start. JSON on stdin, the client's answer on stdout.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { MORE_NOTES_INTRO, CACHE_LEARNING_GUIDE, cacheBundleIntro, disabledTools } from '../cache-guidance.js';
import { pruneInstalls, prunedLines, refreshWiring, stripRepoWiring, repoRunsHooks, normalizeHookEvent, hookClient, sessionOf, toolFiles, promptOutput, toolOutput, stopOutput, parkPending, takePending } from '../clients.js';
import { parseTranscript } from '../distill.js';
import { Store, findRepoRoot } from '../store.js';
import { maintenanceNotice, reportPruned, withinDailyCap, reportCapped } from '../maintain.js';
import { orient, HOOK_BUDGET, rememberTask, outcome, looksLikeCorrection, lateNotes, completenessNudge, takeTurn, holdoutSession, sessionIntro } from '../ops.js';
import { recordEvent, traceFile, toolName, toolInput } from '../transcripts.js';
import { turnNotice } from '../usage.js';

async function hookCommand(ctx) {
  const { pos, flags, out, readStdin, sessionLearning, HERE, NO_LEARN } = ctx;
  const cli = path.join(HERE, 'cli.js');
  // the user-facing notice at the end of a turn; THINKER_NOTICE=off or `notice: false` in the config turns it off
  const noticeOn = s => process.env.THINKER_NOTICE !== 'off' && s.config().notice !== false && s.config().notice !== 'off';
  // model calls made by thinker run agents too; their hooks must do nothing
  if (process.env.THINKER_IN_LLM) return;
  let ev = JSON.parse(readStdin() || '{}');
  const client = hookClient(flags.client, ev);
  ev = normalizeHookEvent(client, ev, pos[0]);
  if (process.env.THINKER_HOOK_DEBUG) fs.appendFileSync(process.env.THINKER_HOOK_DEBUG, JSON.stringify({ hook: pos[0], client, ev }) + '\n');
  // Cursor also runs the Claude Code hooks it imports; its own hooks do the work
  if (client === 'cursor-import') return;
  // A hook at user scope (--user: the agent's own settings, read in every checkout) takes the
  // checkout from the agent's input. A checkout that is not set up is served nothing and learns
  // nothing (`store.exists()` below). Where the checkout's own files run thinker hooks too (set up
  // before the wiring went machine-wide, with --shared, or a benchmark arm's), those do the work:
  // this copy's machine-local ones are taken out here, once, and this hook yields to what is left.
  // THINKER_HOOKS=off silences the hooks outright, as THINKER_MCP=off does the server: for an
  // arm of a benchmark that must see no notes while the wiring is machine-wide.
  const userScope = Boolean(flags.user);
  if (userScope && (process.env.THINKER_HOOKS === 'off' || (isTestMode() && process.env.THINKER_HOOKS !== 'on'))) return;
  if (userScope) {
    const cwd = ev.cwd || ev.workspace_roots?.[0] || ev.workspaceRoots?.[0];
    if (cwd) { const r = findRepoRoot(cwd); if (r !== ctx.repo) { const base = ctx; ctx = { ...ctx, repo: r, store: new Store(r), mcpEntry: () => base.mcpEntry(r) }; } }
    // not a git checkout (a session in the home directory, say, where .thinker/ is thinker's own home): nothing
    if (!fs.existsSync(path.join(ctx.repo, '.git'))) return;
    if (ctx.store.exists()) {
      try { const moved = stripRepoWiring(ctx.repo, { cli, clients: [client] }); if (moved.length) { ctx.store.log({ op: 'prune', removed: moved.map(file => ({ file, what: 'repo-scope' })) }); reportPruned(ctx.store, [`moved thinker's hooks for ${client} out of ${moved.join(', ')}: they run from your own settings now, in every repository that is set up`]); } } catch {}
      if (repoRunsHooks(ctx.repo, client)) return;
    }
  }
  const { repo, store, mcpEntry } = ctx;
  const session = sessionOf(ev);
  // Do not combine unrelated sessions from unsupported/older hook payloads.
  if (['pi', 'windsurf', 'copilot', 'opencode'].includes(client) && session === 'unknown') return;
  // installed hooks carry --record; THINKER_NO_LEARN=1 switches learning off without reinstalling them
  if (NO_LEARN) flags.record = false;
  if (pos[0] === 'prompt') {
    if (store.exists() && session !== 'unknown') tryImpact(store, { op: 'impact-observation', session, ...gitContext(repo) });
    if (client === 'copilot' || client === 'cursor') takePending(store.dir, session);
    if (client === 'cursor') out(JSON.stringify({ continue: true })); // cannot add context here; see clients.js
    if (flags.record && store.exists()) { recordEvent(store.dir, session, { t: 'prompt', text: ev.prompt }); learnInBackground(ctx, client); }
    // another, older copy of thinker still wired into this checkout fires on every prompt too: take its entries out
    if (store.exists()) { try { const pruned = pruneInstalls(repo, { cli, mcpEntry: mcpEntry(), olderOnly: true }); if (pruned.length) { store.log({ op: 'prune', removed: pruned }); reportPruned(store, prunedLines(pruned)); } } catch {} }
    // and the entries of this copy are rewritten when this version writes them differently (a new event, a changed command):
    // the checkout's, and, from a hook at user scope, the user's own
    if (store.exists()) { try { const w = refreshWiring(repo, { cli, mcpEntry: mcpEntry() }); if (w.changed.length) { store.log({ op: 'rewire', repos: 1, files: w.changed }); reportPruned(store, [`rewrote ${w.changed.join(', ')} for this version of thinker`]); } } catch {} }
    if (store.exists() && userScope) { try { const w = refreshWiring(null, { scope: 'user', cli, mcpEntry: ctx.userMcpEntry() }); if (w.changed.length) { store.log({ op: 'rewire', scope: 'user', files: w.changed }); reportPruned(store, [`rewrote ${w.changed.join(', ')} for this version of thinker`]); } } catch {} }
    // Once per session, what the code tools are and how to reach them: only with the first bundle that
    // serves a note. A session the cache has nothing for gets nothing at all (2026-10-07: on the Click
    // canary the intro, the workflow text and the schemas were the whole cost of the arm the notes did
    // not help). A held-out session gets neither the intro nor the nudges: the holdout compares
    // sessions with thinker's help against sessions without.
    const introOk = store.exists() && !['windsurf', 'pi', 'copilot'].includes(client) && !holdoutSession(store, session);
    const emit = text => { if (client === 'cursor' || client === 'copilot') parkPending(store.dir, session, text); else out(promptOutput(client, text)); };
    if (!store.exists() || !store.list().length || client === 'windsurf') return;
    // outcome signal: a correction-shaped follow-up counts against the notes served earlier in this session
    if (session !== 'unknown' && looksLikeCorrection(ev.prompt)) outcome(store, { session, positive: false, reason: 'correction prompt: ' + String(ev.prompt).slice(0, 80) });
    if (session !== 'unknown') rememberTask(store, session, ev.prompt);
    // a held-out session is served nothing by the hooks, and what it would have been served is logged (ops.js:holdoutSession)
    const r = await orient(store, { task: ev.prompt || '', session: session === 'unknown' ? undefined : session, client, budget: Number(flags.budget) || HOOK_BUDGET, once: true, freshOnly: true, holdout: holdoutSession(store, session) });
    if (!r.included.length) return;
    const intro = introOk ? sessionIntro(store, { session, client }) : '';
    const more = r.more?.length ? `\n\n${MORE_NOTES_INTRO}\n${r.more.map(n => `- [${n.kind}] ${n.title}${n.status === 'stale' ? ' ⚠ STALE' : ''}  (id: ${n.id})`).join('\n')}` : '';
    const header = cacheBundleIntro({ stale: r.included.some(n => n.status === 'stale'), disabled: disabledTools(store.config()) });
    const text = `<thinker-cache>\n${header}\n\n${r.text}${more}${!NO_LEARN && sessionLearning() && !['windsurf', 'pi', 'copilot'].includes(client) ? '\n\n' + CACHE_LEARNING_GUIDE : ''}\n</thinker-cache>`;
    emit(intro ? `${intro}\n\n${text}` : text);
  } else if (pos[0] === 'tool') {
    // After a tool call: the agent opened files; serve notes anchored to them, once each.
    if (!store.exists()) return;
    // Cursor reports a shell command's output in afterShellExecution, not in postToolUse
    if (ev.hook_event_name === 'afterShellExecution') { if (flags.record) recordEvent(store.dir, session, { t: 'tool', name: 'Bash', input: { command: ev.command }, result: ev.output }); out('{}'); return; }
    if (flags.record && !(client === 'cursor' && toolName(ev.tool_name) === 'Bash')) { const name = toolName(ev.tool_name); recordEvent(store.dir, session, { t: 'tool', name, input: toolInput(name, ev.tool_input), result: ev.tool_response ?? ev.tool_output ?? ev.output }); }
    // Copilot failure hooks require a different output/exit protocol. Record the
    // failure but keep prompt context for the next successful tool result.
    if (client === 'copilot' && ev.error) { if (flags.record) learnInBackground(ctx, client); return; }
    const parts = [];
    if (client === 'copilot') { const pending = takePending(store.dir, session); if (pending) parts.push(pending); }
    if (flags.record) learnInBackground(ctx, client);
    // Cursor drops context added to an MCP call's result: wait for the next tool call,
    // unless the agent asked the cache itself, in which case it has the notes already
    const mcpCall = /^MCP:/i.test(ev.tool_name || '');
    if (client === 'cursor' && mcpCall && !/orient|lookup/i.test(ev.tool_name)) { /* keep the bundle for the next call */ }
    else if (client === 'cursor') {
      let p = takePending(store.dir, session);
      // the prompt hook does not run in every Cursor mode: orient from the transcript's request instead
      const turn = path.join(store.dir, 'state', `oriented-${String(ev.generation_id || session).replace(/[^\w.-]/g, '_')}`);
      if (!p && !mcpCall && !fs.existsSync(turn) && ev.transcript_path && fs.existsSync(ev.transcript_path) && store.list().length) {
        const task = parseTranscript(ev.transcript_path).events.filter(e => e.t === 'prompt').pop()?.text;
        if (task) { const r = await orient(store, { task, session, client: 'cursor', budget: Number(flags.budget) || HOOK_BUDGET, once: true, freshOnly: true, holdout: holdoutSession(store, session) }); if (r.included.length) p = `<thinker-cache>\nNotes about this repo from earlier sessions; their code dependencies were re-hashed just now.\n\n${r.text}\n</thinker-cache>`; }
      }
      fs.mkdirSync(path.dirname(turn), { recursive: true }); fs.writeFileSync(turn, '');
      if (p && !mcpCall) parts.push(p);
    }
    if ((client === 'claude' || flags.late) && !holdoutSession(store, session)) {
      const name = toolName(ev.tool_name), command = toolInput(name, ev.tool_input).command || '';
      // an edit tool, or a shell command that writes a file in place
      const edited = name === 'Edit' || name === 'Write' || (name === 'Bash' && /\b(sed|perl)\s+(-\w+\s+)*-\w*i\b|\btee\s|>{1,2}\s*[\w./-]+\.\w+/.test(command));
      const r = lateNotes(store, { session, client, files: toolFiles(ev, repo), edited });
      if (r.text) parts.push(r.text);
    }
    if (parts.length) out(toolOutput(client, parts.join('\n\n')));
  } else if (pos[0] === 'stop') {
    if (!store.exists()) return;
    // completeness nudge (once per session, never when already continuing from a stop hook)
    if (flags.nudge && !ev.stop_hook_active) {
      let changed = [];
      try { changed = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo }).toString().split('\n').map(l => l.slice(3).trim()).filter(f => f && !f.startsWith('.thinker') && !f.startsWith('.mcp.json') && !f.startsWith('.claude/')); } catch {}
      const n = completenessNudge(store, { session, changed });
      if (n.text) { out(JSON.stringify({ decision: 'block', reason: n.text })); return; }
    }
    if (client === 'cursor') out('{}');
    // what the turn's servings saved, for the user; the ids are cleared so the next turn starts from none
    const served = takeTurn(store, session !== 'unknown' ? session : null);
    // what the session has cost so far, for the holdout comparison (usage.js); the last line per session counts
    if (session !== 'unknown' && ev.transcript_path && fs.existsSync(ev.transcript_path)) { try { const p = parseTranscript(ev.transcript_path); const record = { op: 'session', session, client, model: p.model || undefined, holdout: holdoutSession(store, session) || undefined, ...gitContext(repo), ...(p.stats || {}) }; store.log(record); tryImpact(store, record); } catch {} }
    if (noticeOn(store)) {
      const notice = [served.length ? turnNotice(store.repo, served.map(id => store.get(id)).filter(Boolean)) : '', NO_LEARN ? '' : maintenanceNotice(store)].filter(Boolean).join('\n');
      const o = stopOutput(client, notice); if (o) out(o);
    }
    // Claude Code: its transcript. Other agents: the trace the hooks recorded,
    // plus the agent's closing message from the hook input or its transcript.
    let source = ev.transcript_path;
    const native = ev.transcript_path && fs.existsSync(ev.transcript_path) && (() => { try { return parseTranscript(ev.transcript_path).events.some(e => e.t === 'tool'); } catch { return false; } })();
    if (flags.record && !native) {
      let last = ev.last_assistant_message || ev.prompt_response;
      if (!last && ev.transcript_path && fs.existsSync(ev.transcript_path)) { try { last = parseTranscript(ev.transcript_path).events.filter(e => e.t === 'say').pop()?.text; } catch {} }
      recordEvent(store.dir, session, { t: 'say', text: last });
      source = traceFile(store.dir, session);
    }
    if (isTestMode() || flags['no-distill'] || NO_LEARN || !sessionLearning()) return;
    if (!source || !fs.existsSync(source)) return;
    // Sessions are distilled locally through the agent's own login.
    // Distilling a session is a model call of its own (about 25k tokens); it draws on the same
    // daily token cap as maintenance, so a long day of work cannot run through the agent's usage
    const cap = withinDailyCap(store);
    if (!cap.ok) { store.log({ op: 'distill-skipped', reason: 'dailyTokens', spent: cap.spent, cap: cap.cap, session, client }); reportCapped(store, cap); return; }
    // One distill per session, not per turn: each call carries a fixed prompt, so at the end of a turn
    // only a backlog near the trace limit is distilled (`--batch`). The session's end distills the
    // rest; where the agent fires no end, the catch-up run takes sessions that have gone quiet.
    const ending = /^session_?end$/i.test(ev.hook_event_name || '');
    const child = spawn('node', [path.join(HERE, 'cli.js'), 'distill', source, '--incremental', '--quiet', '--session', session, '--repo', repo, ...(ending ? [] : ['--batch'])],
      { detached: true, stdio: 'ignore', env: { ...process.env, THINKER_LLM_PREFER: client } });
    child.unref();
    if (!ending) learnInBackground(ctx, client, { maintain: false });
  }
  return;
}

// From a hook: start catch-up in the background, at most every ten minutes.
// Only sessions quiet for LEARN_IDLE_MIN minutes: one still running is distilled when it ends or goes quiet.
const LEARN_IDLE_MIN = 20;

export function learnInBackground(ctx, client, { maintain = true } = {}) {
  const { repo, store, sessionLearning, HERE, NO_LEARN } = ctx;
  if (isTestMode() || NO_LEARN || !sessionLearning()) return;
  const mark = path.join(store.dir, 'state', 'learn.last');
  try { if (Date.now() - fs.statSync(mark).mtimeMs < 10 * 60_000) return; } catch {}
  fs.mkdirSync(path.dirname(mark), { recursive: true }); fs.writeFileSync(mark, '');
  spawn('node', [path.join(HERE, 'cli.js'), 'learn', '--quiet', '--days', '2', '--max', '5', '--idle-min', String(LEARN_IDLE_MIN), ...(maintain ? ['--maintain'] : []), '--repo', repo], { detached: true, stdio: 'ignore', env: { ...process.env, THINKER_LLM_PREFER: client } }).unref();
}

export const commands = {
  'hook': hookCommand,
};
