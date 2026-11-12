import { isTestMode } from '../test-mode.js';
import { gitContext, tryDelivery } from '../delivery-journal.js';
// The hook entrypoints the agents call (clients.js installs them): prompt, tool and stop, with the
// background catch-up they start. JSON on stdin, the client's answer on stdout.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pluginYields, pruneInstalls, prunedLines, refreshWiring, stripRepoWiring, repoRunsHooks, normalizeHookEvent, hookClient, sessionOf, toolFiles, seenFiles, seenHits, searchedIdentifier, promptOutput, toolOutput, stopOutput, parkPending, takePending, agyTurnPrompt } from '../clients.js';
import { dietConfig, dietResult, rememberTerms } from '../diet.js';
import { Store, findRepoRoot, repoId } from '../store.js';
import { isDisabledRepo } from '../repo-switch.js';
import { maintenanceNotice, reportPruned, withinDailyCap, reportCapped } from '../maintain.js';
import { beginTurn, currentTurn, isHarnessEvent } from '../session-state.js';
import { parseTranscript, subagentStats, continuedSince, recordEvent, traceFile, toolName, toolInput, textOf } from '../transcripts.js';
import { compressionNotice, formatTokens } from '../usage.js';
import { readSavings, refreshSavingsInBackground, savingsLine } from '../savings-ledger.js';
import { compressionBlock, compressionDir, markCompressionTurn, mirrorClearing } from '../compression.js';
import { profileTurn, profileArmOf } from '../profile.js';
import { retireNotes } from '../notes-retired.js';
import { recordDevinCompactions } from '../devin-compaction.js';
import { claudeCardActive } from '../claude-card.js';
import { noticeDue, noticeShown, countPrompt, holdNotice, writeNoticeLast } from '../notice-cadence.js';
import { updateNoteDue, updateNoteShown, updateNoteText } from '../update-note.js';
import { setupRepo } from '../repo-onboard.js';
import { proxyOffer } from '../proxy-offer.js';
import { containersOffer } from '../containers-offer.js';
import { errorOffer, recordError, sendErrors, errorConsent } from '../error-report.js';
import { harnessRecall, harnessIndex, harnessOn } from '../harness.js';
import { contextSuggestOffer, ensureUi, suggestionsUrl } from '../context-suggest.js';
import { snapshotCursorInventory } from '../harness-cursor.js';
import { sectionsForEvent, sectionsConfig } from '../instruction-sections.js';
import { retireTrimmedCopy } from '../trimmed-copy-retired.js';
import { thinkerHome } from '../update.js';
import { desktopApp, subagentHarness } from '../app-host.js';
import { enqueueJob, markAppSession, pendingJobs, startSessionWork } from '../session-work.js';
import { isWorkerPrompt, isWorkerTool, isWorkerLaunch } from '../session-llm.js';
import { ensureShellPath } from '../shell-path.js';
import { ensureProxy, gatewayHint } from '../proxy-service.js';

// Whether the wiring checks are due where `file` keeps their stamp: a different copy or version of thinker than the
// last check, or a day since it. The stamp is written before the check, so a check that fails waits a day too.
const WIRING_CHECK_MS = 24 * 3600_000;
export function wiringDue(file, cli, { now = Date.now() } = {}) {
  let version = ''; try { version = JSON.parse(fs.readFileSync(path.join(path.dirname(cli), '..', 'package.json'), 'utf8')).version; } catch {}
  const key = `${cli}@${version}`;
  try { const st = JSON.parse(fs.readFileSync(file, 'utf8')); if (st.key === key && now - Date.parse(st.at) < WIRING_CHECK_MS) return false; } catch {}
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ key, at: new Date(now).toISOString() })); } catch {}
  return true;
}

// The output is written to a pipe, which macOS flushes asynchronously: the exit waits for it (end's callback
// runs once every chunk written before it is out). Nothing after the output is lost: the background work the
// hook starts is detached and unref'd, and the log is appended synchronously (store.js:log).
function exitAfterOutput() { process.stdout.end(() => process.exit(0)); }

async function hookCommand(ctx) {
  const { pos, flags, readStdin, sessionLearning, HERE, NO_LEARN } = ctx;
  // Retired test-command interception: old installations may still call this entrypoint.
  // Return before reading input, initializing a cache or doing any background work.
  if (pos[0] === 'pre') return;
  let printed = false;
  const out = s => { printed = true; ctx.out(s); };
  const cli = path.join(HERE, 'cli.js');
  // the user-facing notice at the end of a turn; THINKER_NOTICE=off or `notice: false` in the config turns it off
  const noticeOn = s => process.env.THINKER_NOTICE !== 'off' && s.config().notice !== false && s.config().notice !== 'off';
  // model calls made by thinker run agents too; their hooks must do nothing
  let ev = {};
  try { ev = JSON.parse(readStdin() || '{}'); } catch {}
  const client = hookClient(flags.client, ev);
  try {
    if (process.env.THINKER_IN_LLM) return;
    ev = normalizeHookEvent(client, ev, pos[0]);
    if (process.env.THINKER_HOOK_DEBUG) fs.appendFileSync(process.env.THINKER_HOOK_DEBUG, JSON.stringify({ hook: pos[0], client, ev }) + '\n');
    // Cursor also runs the Claude Code hooks it imports; its own hooks do the work
    if (client === 'cursor-import' || client === 'devin-import') return;
    // a host plugin's hook yields to the host's own settings where they run thinker's hooks (clients.js:pluginYields)
    if (flags.plugin && pluginYields(client)) return;
    // A hook at user scope (--user: the agent's own settings, read in every checkout) takes the
    // checkout from the agent's input. Every git checkout has a cache, started here on first use;
    // outside one the hooks do nothing. Where the checkout's own files run thinker hooks too (set up
    // before the wiring went machine-wide, with --shared, or a benchmark arm's), those do the work:
    // this copy's machine-local ones are taken out here, once, and this hook yields to what is left.
    // THINKER_HOOKS=off silences the hooks outright, as THINKER_MCP=off does the server: for an
    // arm of a benchmark that must see no notes while the wiring is machine-wide.
    const userScope = Boolean(flags.user);
    if (userScope && (process.env.THINKER_HOOKS === 'off' || (isTestMode() && process.env.THINKER_HOOKS !== 'on'))) return;
    // The context proxy's base URL is in the agent's settings (proxy-service.js): when nothing listens on it (a reboot
    // with no service manager, a crash), every model call of the session would fail, so the prompt hook starts it
    // before the call. One connect when it runs, under a millisecond. The one thing a hook does beside the cache's work.
    // It also steps aside here: when the proxy's URL is gone from Claude Code's settings, someone took it out, so
    // the service goes rather than the URL being written back (proxy-service.js:removedByHand).
    if (userScope && pos[0] === 'prompt' && (!isTestMode() || process.env.THINKER_HOME)) {
      try {
        const p = await ensureProxy({ cli });
        if (p.started && ctx.store?.exists()) ctx.store.log({ op: 'proxy-start', pid: p.pid, listening: p.listening });
        if (p.stoodDown && ctx.store?.exists()) {
          ctx.store.log({ op: 'proxy-standdown', reason: p.stoodDown });
          // `proxy on` alone stands down again where the reason is a route of the person's own, so name the flag
          // that does work (gatewayHint); nothing else will tell them (2026-10-28)
          let hint = null; try { hint = gatewayHint(); } catch {}
          reportPruned(ctx.store, [`context proxy off (${p.stoodDown}): your agents call the API directly again, and thinker proxy on puts it back${hint ? `. ${hint}` : ''}`]);
        }
      } catch (e) { recordError('hook.proxy', e, { repo: ctx.repo }); }
      // consent already given: whatever was recorded since goes out, once, in the background
      if (errorConsent() === 'yes') sendErrors({ store: ctx.store }).catch(() => {});
    }
    if (userScope) {
      const cwd = ev.cwd || ev.workspace_roots?.[0] || ev.workspaceRoots?.[0] || ev.workspacePaths?.[0];
      if (cwd) { const r = findRepoRoot(cwd); if (r !== ctx.repo) { const base = ctx; ctx = { ...ctx, repo: r, store: new Store(r), mcpEntry: () => base.mcpEntry(r) }; } }
      // not a git checkout (a session in the home directory, say, where .thinker/ is thinker's own home): nothing
      if (!fs.existsSync(path.join(ctx.repo, '.git'))) return;
      const baseClient = client === 'agy' ? 'gemini' : client === 'vscode' ? 'copilot' : client;
      if (ctx.store.exists()) {
        try { const moved = stripRepoWiring(ctx.repo, { cli, clients: [baseClient] }); if (moved.length) { ctx.store.log({ op: 'prune', removed: moved.map(file => ({ file, what: 'repo-scope' })) }); reportPruned(ctx.store, [`moved thinker's hooks for ${baseClient} out of ${moved.join(', ')}: they run from your own settings now, in every repository that is set up`]); } } catch {}
        if (repoRunsHooks(ctx.repo, baseClient)) return;
      }
    }
    const { repo, store, mcpEntry } = ctx;
    if (!fs.existsSync(path.join(repo, '.git'))) return;
    // a repository turned off (repo-switch.js: sensitive content) gets nothing and has nothing written into it
    if (isDisabledRepo(repo)) return;
    if (!store.exists()) store.init();
    const session = sessionOf(ev);
    // What thinker has saved, today and over the whole log, off the kept ledger (savings-ledger.js): a
    // read of one small file, because the figure itself is a second of log and transcript reading and a
    // hook may not spend that. The Stop hook starts the refresh in the background. Nothing where the
    // notices are off: this is one of them, not a figure that follows the person around regardless.
    const moneyLine = () => {
      if (!noticeOn(store)) return '';
      try { return savingsLine(readSavings(store)); } catch { return ''; }
    };
    // Cursor has no message field at the end of a turn (clients.js:stopOutput), so what thinker has to say there
    // is asked for in the agent's own reply, once the cadence says so (notice-cadence.js).
    const cursorFootnote = () => {
      if (client !== 'cursor' || !noticeOn(store)) return '';
      if (!noticeDue(store).due) return '';
      const money = moneyLine();
      if (money) noticeShown(store);
      return money ? `\n\nEnd your reply to the user with this exact line at the very bottom: ${money}` : '';
    };
    // Do not combine unrelated sessions from unsupported/older hook payloads.
    if (['pi', 'windsurf', 'copilot', 'opencode', 'vscode', 'droid', 'qwen', 'kiro', 'cline', 'kilo', 'augment', 'goose', 'agy', 'devin'].includes(client) && session === 'unknown') return;
    // Copilot CLI, VS Code's Copilot and the Cline CLI take no context from a prompt hook: the bundle waits
    // for the turn's first tool hook (parkPending)
    const parks = client === 'copilot' || client === 'vscode' || (client === 'cline' && ev.cline_cli);
    // installed hooks carry --record; THINKER_NO_LEARN=1 switches learning off without reinstalling them
    if (NO_LEARN) flags.record = false;
    if (pos[0] === 'prompt') {
      // Antigravity (agy) fires PreInvocation before every model call in a turn and passes no prompt on stdin:
      // read the new turn's USER_INPUT from the transcript once; on later invocations in the same turn, deliver
      // any late notes parked by PostToolUse and return.
      if (client === 'agy' && !ev.prompt) {
        const p = agyTurnPrompt(store.dir, session, ev.transcript_path);
        if (!p) {
          const pending = store.exists() && session !== 'unknown' ? takePending(store.dir, session) : '';
          out(promptOutput('agy', pending));
          return;
        }
        ev.prompt = p;
      }
      // A background subagent spawned to work thinker's queue (session-llm.js:subagentPrompt) runs the host's
      // hooks too: skip orienting, recording or starting another worker for it.
      if (isWorkerPrompt(ev.prompt)) { if (client === 'cursor' || client === 'cline' || client === 'agy') out(promptOutput(client, '')); return; }
      // Cursor answers once, in JSON: {continue}, with the bundle as additional_context (clients.js:promptOutput)
      let said = '';
      await (async () => {
        if (store.exists() && session !== 'unknown') tryDelivery(store, { op: 'observation', session, client, ...gitContext(repo) });
        if (parks || client === 'cursor' || client === 'agy') takePending(store.dir, session);
        // what Cursor loaded into this chat, which its transcript does not record (harness-cursor.js)
        if (client === 'cursor' && harnessOn(store) && (!isTestMode() || process.env.THINKER_HOME)) { try { snapshotCursorInventory({ session, roots: [...(ev.workspace_roots || []), repo], transcript: ev.transcript_path, thinkerHome: thinkerHome() }); } catch {} }
        if (flags.record && store.exists()) { recordEvent(store.dir, session, { t: 'prompt', text: ev.prompt }); learnInBackground(ctx, client); }
        // The wiring checks (an older copy's entries, this copy's entries in this version's shape, thinker on PATH)
        // run once for each copy and version of thinker in a checkout, and again after a day: on every prompt they
        // were about 0.6 s of git and file reads, and the hook was being cut off at its 15 s limit on a loaded
        // machine (2026-10-22). `thinker update` runs `rewire` for every checkout as it is.
        if (store.exists() && wiringDue(path.join(store.dir, 'state', 'wiring-checked.json'), cli)) {
          // what this checkout kept of the knowledge notes goes, once (notes-retired.js); `thinker rewire` does the same for the known checkouts
          try { retireNotes(store); } catch {}
          // another, older copy of thinker still wired into this checkout fires on every prompt too: take its entries out
          try { const pruned = pruneInstalls(repo, { cli, mcpEntry: mcpEntry(), olderOnly: true }); if (pruned.length) { store.log({ op: 'prune', removed: pruned }); reportPruned(store, prunedLines(pruned)); } } catch {}
          // and the entries of this copy are rewritten when this version writes them differently (a new event, a changed command)
          try { const w = refreshWiring(repo, { cli, mcpEntry: mcpEntry() }); if (w.changed.length) { store.log({ op: 'rewire', repos: 1, files: w.changed }); reportPruned(store, [`rewrote ${w.changed.join(', ')} for this version of thinker`]); } } catch {}
          // thinker on PATH for bash too, once per machine, on an install from before the installer wrote it there (shell-path.js)
          if (!isTestMode()) { try { const d = ensureShellPath(); if (d?.length) store.log({ op: 'shell-path', files: d }); } catch {} }
        }
        // from a hook at user scope, the user's own files, checked once per copy and version for the machine
        if (store.exists() && userScope && wiringDue(path.join(thinkerHome(), 'state', 'wiring-checked-user.json'), cli)) { try { const w = refreshWiring(null, { scope: 'user', cli, mcpEntry: ctx.userMcpEntry() }); if (w.changed.length) { store.log({ op: 'rewire', scope: 'user', files: w.changed }); reportPruned(store, [`rewrote ${w.changed.join(', ')} for this version of thinker`]); } } catch {} }
        // Goose's hooks only record: what they print never reaches the model, so nothing is oriented or counted as served
        if (client === 'goose') return;
        // the session's next turn: its number is what the tool and stop hooks, the diet and the compression clock carry
        const { turn } = store.exists() ? beginTurn(store, session) : { turn: 0 };
        // the request's identifiers, for the context diet (diet.js; off until an experiment)
        if (store.exists() && client === 'claude' && dietConfig(store).enabled) rememberTerms(store, session, { prompt: ev.prompt });
        const emit = text => { if (client === 'cursor' || client === 'agy' || (client === 'cline' && !parks)) said = text; else if (parks) parkPending(store.dir, session, text); else out(promptOutput(client, text)); };
        if (!store.exists() || client === 'windsurf') return;
        // the first session in a repository: what `thinker setup` would write for it (repo-onboard.js)
        setupRepo(store, { client, cli, learn: !NO_LEARN && sessionLearning() });
        // queued learning of an app session (session-work.js): the runner starts and the agent is told to start
        // its subagent; the ancestry is walked only when jobs wait
        const work = !isTestMode() && !NO_LEARN && pendingJobs(store).length && desktopApp(subagentHarness(client)) ? startSessionWork(store, { cli, harness: subagentHarness(client) }) : '';
        // never in a benchmark or test session (THINKER_TEST=1): an offer there is noise in the agent's context and an
        // eval runner marks the session invalid for it (2026-10-18); THINKER_OFFERS=on restores them, for the tests of the offers
        const offersOn = !isTestMode() || process.env.THINKER_OFFERS === 'on';
        // a trimmed copy of AGENTS.md an older version kept for this checkout goes (trimmed-copy-retired.js): four stats
        try { retireTrimmedCopy(store); } catch {}
        // a switched-off tool this request looks like it needs (harness.js:harnessRecall). Not an offer: a line for the
        // agent, on with the harness, so it runs in test mode too.
        const harnessHere = ['claude', 'codex', 'cursor'].includes(client) && !isHarnessEvent(ev.prompt);
        const recall = harnessHere ? await harnessRecall(store, ev.prompt || '', { session, client }) : '';
        // the names of the switched-off skills, once a session (harness.js:harnessIndex; off until an experiment), not an offer either
        const index = harnessHere ? harnessIndex(store, { session, client }) : '';
        // one question a prompt: the one-off repair offer first (proxy-offer.js, the owner-approved exception of
        // 2026-10-28 to "one suggestion, not three"), then the week's context suggestion
        // what the context proxy has cleared out of this session, once the saving is old enough to mean something
        // (compression.js): not an offer and not a question, a statement of what is no longer in the context and
        // what it saved, said once a session because a block that changed every turn would rewrite the very
        // prompt cache the clearing exists to spare
        let clearing = '';
        if (offersOn) { try { clearing = compressionBlock(compressionDir(), session, turn, formatTokens); } catch {} }
        const offer = [offersOn ? (proxyOffer(store, { client }) || containersOffer(store, { client }) || errorOffer(store, { client }) || contextSuggestOffer(store, { repoId: repoId(store.repo), client })) : '', work, index, recall, clearing].filter(Boolean).join('\n\n');
        // a harness event delivered as a prompt (a background task finished, a subagent reported) is no request:
        // it opens its turn, so the turn costs stay apart, and is served nothing (session-state.js:isHarnessEvent)
        if (isHarnessEvent(ev.prompt)) { if (offer) emit(offer); return; }
        // Every git repository has a cache; a prompt is a request whether or not anything is said back, so `thinker
        // usage` and the telemetry count a machine as active by its requests (2026-10-12: seven of eight reporting
        // devices read as idle without this).
        store.log({ op: 'request', session: session === 'unknown' ? undefined : session, client, task: String(ev.prompt || '').slice(0, 200) });
        // the session profile (profile.js): what the person here is working on and how they want work done, on a
        // session's first prompt and again after a compaction, unless the session is held out. Ahead of everything
        // else the hook says: it is the orientation.
        let profile = ''; try { profile = profileTurn(store, session, { transcript: ev.transcript_path, client }); } catch {}
        const text = [profile, offer, cursorFootnote()].filter(Boolean).join('\n\n');
        if (text) emit(text);
      })();
      if (client === 'cursor' || client === 'cline' || client === 'agy') out(promptOutput(client, said));
  } else if (pos[0] === 'tool') {
    // After a tool call: the agent opened files; serve notes anchored to them, once each.
    if (!store.exists()) return;
    // The learning worker's own calls (learn_next, and the call that launches it) are not the session's work and
    // are not recorded. They used to delete the session's trace, on the assumption that a worker is its own
    // session: in Devin (and Claude Code) a background subagent's hooks carry the parent's session id, so the
    // person's own prompt and tool calls were wiped and the session distilled as nothing (seen live 2026-11-01).
    if (isWorkerTool(ev.tool_name) || isWorkerLaunch(ev.tool_input)) { if (ev.hook_event_name === 'afterShellExecution') out('{}'); return; }
    // Cursor reports a shell command's output in afterShellExecution, not in postToolUse
    if (ev.hook_event_name === 'afterShellExecution') { if (flags.record) recordEvent(store.dir, session, { t: 'tool', name: 'Bash', input: { command: ev.command }, result: ev.output }); out('{}'); return; }
    if (flags.record && !(client === 'cursor' && toolName(ev.tool_name) === 'Bash')) { const name = toolName(ev.tool_name); recordEvent(store.dir, session, { t: 'tool', name, input: toolInput(name, ev.tool_input), result: ev.tool_response ?? ev.tool_output ?? ev.output }); }
    // Copilot failure hooks require a different output/exit protocol. Record the
    // failure but keep prompt context for the next successful tool result.
    if (client === 'copilot' && ev.error) { if (flags.record) learnInBackground(ctx, client); return; }
    const parts = [];
    if (parks || client === 'cline') { const pending = takePending(store.dir, session); if (pending) parts.push(pending); }
    if (flags.record) learnInBackground(ctx, client);
    // Cursor drops context added to an MCP call's result: wait for the next tool call,
    // unless the agent asked the cache itself, in which case it has the notes already
    const mcpCall = /^MCP:/i.test(ev.tool_name || '');
    if (client === 'cursor' && mcpCall) { /* Cursor drops context added to an MCP call's result: keep it for the next call */ }
    else if (client === 'cursor') { const p = takePending(store.dir, session); if (p) parts.push(p); }
    const t = currentTurn(store, session);
    // the repository's instruction sections this tool call is about (instruction-sections.js; off until an experiment):
    // the team's own text
    if (sectionsConfig(store).enabled) {
      const name = toolName(ev.tool_name), input = toolInput(name, ev.tool_input), command = typeof input.command === 'string' ? input.command : Array.isArray(input.command) ? input.command.join(' ') : '';
      const named = toolFiles(ev, repo), patch = JSON.stringify(ev.tool_input ?? '');
      const patched = [...patch.matchAll(/\*\*\* (?:Update|Add|Delete) File: ([^\\\n"]+)/g)].map(m => path.isAbsolute(m[1]) ? path.relative(repo, m[1]) : m[1]);
      const edited = name === 'Edit' || name === 'Write' ? [...named, ...patched] : [];
      let s = '';
      try { s = sectionsForEvent(store, { session, client, files: [...named, ...edited], command, output: textOf(ev.tool_response ?? ev.tool_output ?? ev.output).slice(0, 200_000), read: name === 'Edit' || name === 'Write' ? [] : named, edited }); } catch {}
      if (s) parts.push(s);
    }
    // the context diet (diet.js; off until an experiment): the result replaced before the model reads it
    let updated, updatedMcp = false;
    const diet = client === 'claude' ? dietConfig(store) : null;
    if (diet?.enabled) {
      const name = toolName(ev.tool_name), input = toolInput(name, ev.tool_input);
      try { rememberTerms(store, session, { name, input }); } catch {}
      try { const d = dietResult(store, { session, repo, cwd: ev.cwd, name, input, response: ev.tool_response, cfg: diet, turn: t.turn || undefined, client }); if (d) { updated = d.output; updatedMcp = !!d.mcp; } } catch {}
    }
    // Antigravity's PostToolUse accepts only {} on stdout: park what there is for the next PreInvocation in the turn.
    if (client === 'agy' && parts.length && session !== 'unknown') {
      const prev = takePending(store.dir, session);
      parkPending(store.dir, session, [prev, ...parts].filter(Boolean).join('\n\n'));
    }
    if (parts.length || updated !== undefined) out(toolOutput(client, parts.join('\n\n'), { updated, mcp: updatedMcp }));
  } else if (pos[0] === 'stop') {
    if (!store.exists()) return;
    // Devin compacts by itself; what each compaction took out of the context is read from its session database
    // and recorded as the proxy's clears are (devin-compaction.js). No model call, nothing when there is none.
    if (client === 'devin') { try { await recordDevinCompactions(store, { session, dir: compressionDir() }); } catch {} }
    const workerSession = isWorkerPrompt(ev.prompt) || (() => {
      for (const f of [ev.transcript_path, traceFile(store.dir, session)]) {
        if (!f || !fs.existsSync(f)) continue;
        try { if (parseTranscript(f).events.some(e => e.t === 'prompt' && isWorkerPrompt(e.text))) return true; } catch {}
      }
      return false;
    })();
    if (workerSession) {
      try { fs.rmSync(traceFile(store.dir, session), { force: true }); } catch {}
      if (client === 'cursor') out('{}');
      return;
    }
    if (client === 'cursor') out('{}');
    if (client === 'agy') out('{"decision":"allow"}');
    if (client === 'agy' && ev.fullyIdle === false) return;
    // The savings ledger the footers read, recomputed in the background at most every REFRESH_MS
    // (savings-ledger.js): a second of log and transcript reading, so never in the hook itself, and
    // never a model call, so it runs the same inside a desktop app. Started here rather than at the
    // prompt so the figure a turn's own notes and clears belong to is in it by the next turn.
    if (noticeOn(store)) { try { refreshSavingsInBackground(store, { cli }); } catch (e) { recordError('hook.savings', e, { repo }); } }
    // what the session has cost so far, for the profile's holdout (profile.js:holdoutReport): the turn's cost is the
    // difference from the line of the turn before, so each line carries the turn number the prompt hook opened. A session
    // Claude Code continued in a new one carries the original's history in its file: the row counts from the moment it
    // was continued, found in the original's tail beside this file (transcripts.js:continuedSince)
    const t = currentTurn(store, session);
    if (session !== 'unknown' && ev.transcript_path && fs.existsSync(ev.transcript_path)) { try { const p = parseTranscript(ev.transcript_path, { since: client === 'claude' ? continuedSince(ev.transcript_path, session) : 0 }); const subs = client === 'claude' ? subagentStats(ev.transcript_path, session) : []; const record = { op: 'session', session, turn: t.turn || undefined, client, model: p.model || ev.modelName || undefined, profile: profileArmOf(store, session) || undefined, ...gitContext(repo), ...(p.stats || {}), subagents: subs.length ? subs : undefined }; store.log(record); } catch {} }
    // A clear the proxy never saw -- a desktop session's, made by the clearing mod -- lives in the card's own
    // state file, which is pruned after two days. Every window that reads a saving is longer than that, so it
    // is mirrored into the machine's log once per clear, where it lasts as long as the log
    // (compression.js:mirrorClearing). Cheap: one small file read, and a row only when the figure has grown.
    if (session !== 'unknown') { try { mirrorClearing(compressionDir(), session, row => store.log(row)); } catch {} }
    if (noticeOn(store)) {
      // where the card mod runs, the status line carries the money the whole session (claude-card.js)
      const carded = client === 'claude' && claudeCardActive(session);
      // what the context proxy's clearing left out of this session's prompts, a few turns after the clear
      // (compression.js); the card mod draws it where it runs. The clock is
      // read every turn whether or not anything is said: it counts the person's turns since the clear, and
      // starting it at the first turn a summary came due would push the figure a day further off each time.
      let cleared = null;
      try { cleared = markCompressionTurn(compressionDir(), session, t.turn); } catch {}
      // One summary every so many prompts, and at most one a day (notice-cadence.js). Maintenance is not asked
      // for its lines while a summary waits, since reading them clears its state (maintain.js:maintenanceNotice).
      countPrompt(store);
      const due = noticeDue(store);
      if (!due.due) holdNotice(store, []);
      else {
        const compression = carded ? '' : compressionNotice(cleared);
        // What changed in thinker, once per machine (update-note.js). Where the card mod runs it is a
        // card under the answer and this says nothing, as the money does: one figure, one voice per client.
        const update = !carded && updateNoteDue(store) ? updateNoteText() : '';
        // The money goes with the summary, except where the card mod runs: there the statusline keeps it
        // on screen the whole session, and saying it twice in one client is two voices for one figure.
        const money = carded ? '' : moneyLine();
        const notice = [update, money ? `🧠 thinker: ${money}` : '', compression, NO_LEARN ? '' : maintenanceNotice(store)].filter(Boolean).join('\n');
        // The floors start again only once the person has actually been told: nothing to say yet, or a
        // client with no message at the end of a turn (Cursor's is its footnote above, clients.js:stopOutput),
        // leaves the summary waiting rather than spending it on an answer nobody reads.
        const o = stopOutput(client, notice);
        // OpenCode 2's terminal part toasts it from here: its server part runs this Stop hook but has
        // no client to show a message with, so the summary lands on disk and the TUI picks it up
        // (opencode-tui.js). Every delivered notice is written, whatever the client; the file's only
        // reader is that door.
        if (o) { noticeShown(store); if (update) updateNoteShown(store); try { writeNoticeLast(store, o); } catch {} out(o); }
      }
    }
    // Claude Code: its transcript. Other agents: the trace the hooks recorded,
    // plus the agent's closing message from the hook input or its transcript.
    let source = ev.transcript_path;
    const native = ev.transcript_path && fs.existsSync(ev.transcript_path) && (() => { try { return parseTranscript(ev.transcript_path).events.some(e => e.t === 'tool'); } catch { return false; } })();
    if (flags.record && !native) {
      // Auggie has no prompt hook: its Stop hook carries the turn's prompt (clients.js:normalizeHookEvent)
      if (client === 'augment' && ev.prompt) recordEvent(store.dir, session, { t: 'prompt', text: ev.prompt });
      let last = ev.last_assistant_message || ev.prompt_response;
      if (!last && ev.transcript_path && fs.existsSync(ev.transcript_path)) { try { last = parseTranscript(ev.transcript_path).events.filter(e => e.t === 'say').pop()?.text; } catch {} }
      recordEvent(store.dir, session, { t: 'say', text: last });
      source = traceFile(store.dir, session);
    }
    // Explicit hook fixtures may inspect app jobs on disk while retaining test-mode isolation.
    // Model work and background processes remain disabled below and in learnInBackground.
    if ((isTestMode() && process.env.THINKER_HOOKS !== 'on') || flags['no-distill'] || NO_LEARN || !sessionLearning()) return;
    if (!source || !fs.existsSync(source)) return;
    // A session is read into the profile whole, when it ends (profile.js: an exchange's outcome is the prompt after
    // it). Where the agent fires no end, the catch-up run takes sessions that have gone quiet (learnInBackground).
    const ending = /^session_?end$/i.test(ev.hook_event_name || '');
    // inside a desktop app no agent CLI runs: the distill waits for the app's own session (session-work.js)
    const app = desktopApp(subagentHarness(client));
    if (app) {
      markAppSession(store, app);
      if (ending) enqueueJob(store, `distill-${session}`, ['distill', source, '--incremental', '--quiet', '--session', session, '--repo', repo]);
      if (!ending) learnInBackground(ctx, client, { maintain: false });
      return;
    }
    if (isTestMode()) return;
    if (!ending) { learnInBackground(ctx, client, { maintain: false }); return; }
    // Reading a session is a model call of its own (about 25k tokens); it draws on the same daily token cap as
    // maintenance, so a long day of work cannot run through the agent's usage
    const cap = withinDailyCap(store);
    if (!cap.ok) { store.log({ op: 'distill-skipped', reason: 'dailyTokens', spent: cap.spent, cap: cap.cap, session, client }); reportCapped(store, cap); return; }
    const child = spawn('node', [path.join(HERE, 'cli.js'), 'distill', source, '--incremental', '--quiet', '--session', session, '--repo', repo],
      { detached: true, stdio: 'ignore', env: { ...process.env, THINKER_LLM_PREFER: client === 'agy' ? 'gemini' : client } });
    child.unref();
  }
  } finally {
    if (client === 'agy' && !printed) out(pos[0] === 'stop' ? '{"decision":"allow"}' : '{}');
  }
  return;
}

// From a hook: start catch-up in the background, at most every ten minutes.
// Only sessions quiet for LEARN_IDLE_MIN minutes: one still running is read when it ends or goes quiet.
const LEARN_IDLE_MIN = 20;

export function learnInBackground(ctx, client, { maintain = true } = {}) {
  const { repo, store, sessionLearning, HERE, NO_LEARN } = ctx;
  if (isTestMode() || NO_LEARN || !sessionLearning()) return;
  const mark = path.join(store.dir, 'state', 'learn.last');
  try { if (Date.now() - fs.statSync(mark).mtimeMs < 10 * 60_000) return; } catch {}
  fs.mkdirSync(path.dirname(mark), { recursive: true }); fs.writeFileSync(mark, '');
  const args = ['learn', '--quiet', '--days', '2', '--max', '5', '--idle-min', String(LEARN_IDLE_MIN), ...(maintain ? ['--maintain'] : []), '--repo', repo];
  // inside a desktop app no agent CLI runs: the catch-up waits for the app's own session (session-work.js)
  const app = desktopApp(subagentHarness(client));
  if (app) { markAppSession(store, app); enqueueJob(store, maintain ? 'learn-maintain' : 'learn', args); return; }
  spawn('node', [path.join(HERE, 'cli.js'), 'learn', '--quiet', '--days', '2', '--max', '5', '--idle-min', String(LEARN_IDLE_MIN), ...(maintain ? ['--maintain'] : []), '--repo', repo], { detached: true, stdio: 'ignore', env: { ...process.env, THINKER_LLM_PREFER: client === 'agy' ? 'gemini' : client } }).unref();
}

export const commands = {
  'hook': hookCommand,
};
