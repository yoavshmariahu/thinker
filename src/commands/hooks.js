import { isTestMode } from '../test-mode.js';
import { gitContext, tryImpact } from '../impact-journal.js';
// The hook entrypoints the agents call (clients.js installs them): prompt, tool and stop, with the
// background catch-up they start. JSON on stdin, the client's answer on stdout.
import { noticeCard } from '../notice-card.js';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { cacheBundleIntro, disabledTools } from '../cache-guidance.js';
import { pluginYields, pruneInstalls, prunedLines, refreshWiring, stripRepoWiring, repoRunsHooks, normalizeHookEvent, hookClient, sessionOf, toolFiles, seenFiles, seenHits, searchedIdentifier, promptOutput, toolOutput, stopOutput, preToolOutput, rewritesCommands, PRE_TOOL_CLIENTS, parkPending, takePending, orientedFile } from '../clients.js';
import { testsConfig, classifyTestCommand, wrappedCommand, wrapperBin, NUDGE_REASON } from '../testing.js';
import { dietConfig, dietResult, rememberTerms } from '../diet.js';
import { parseTranscript, batchDue } from '../distill.js';
import { Store, findRepoRoot, repoId } from '../store.js';
import { isDisabledRepo } from '../repo-switch.js';
import { maintenanceNotice, reportPruned, withinDailyCap, reportCapped } from '../maintain.js';
import { codeForRequest, orient, HOOK_BUDGET, servesNotes, rememberTask, outcome, looksLikeCorrection, lateNotes, onSightNotes, onSightConfig, onSightOutlines, onSightOutlineConfig, completenessNudge, nudgedForTest, peekTurn, takeTurn, beginTurn, holdoutTurn, isHarnessEvent } from '../ops.js';
import { recordEvent, traceFile, toolName, toolInput, textOf } from '../transcripts.js';
import { turnNotice, turnFooterMarkdown, weeklyNotice } from '../usage.js';
import { claudeCardActive } from '../claude-card.js';
import { setupRepo } from '../repo-onboard.js';
import { coverageOffer, recordAccess } from '../coverage.js';
import { harnessOffer, harnessRecall, harnessIndex, harnessOn } from '../harness.js';
import { contextSuggestOffer } from '../context-suggest.js';
import { skillSuggestOn, skillSuggestLines, hookSkillFacts } from '../skill-suggest.js';
import { snapshotCursorInventory } from '../harness-cursor.js';
import { sectionsForEvent, sectionsConfig } from '../instruction-sections.js';
import { syncCore } from '../instructions-core.js';
import { thinkerHome } from '../update.js';
import { desktopApp, subagentHarness } from '../app-host.js';
import { enqueueJob, markAppSession, pendingJobs, startSessionWork } from '../session-work.js';
import { isWorkerPrompt, isWorkerTool } from '../session-llm.js';
import { ensureShellPath } from '../shell-path.js';

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
  // a host plugin's hook yields to the host's own settings where they run thinker's hooks (clients.js:pluginYields)
  if (flags.plugin && pluginYields(client)) return;
  // the pre hook runs before every shell command: it decides as early as it can
  if (pos[0] === 'pre' && !PRE_TOOL_CLIENTS.includes(client)) return;
  // A hook at user scope (--user: the agent's own settings, read in every checkout) takes the
  // checkout from the agent's input. Every git checkout has a cache, started here on first use;
  // outside one the hooks do nothing. Where the checkout's own files run thinker hooks too (set up
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
  if (!fs.existsSync(path.join(repo, '.git'))) return;
  // a repository turned off (repo-switch.js: sensitive content) gets nothing and has nothing written into it
  if (isDisabledRepo(repo)) return;
  if (!store.exists()) store.init();
  const session = sessionOf(ev);
  // Cursor's stop hook has no user-facing message field (clients.js:stopOutput); when notes are served in
  // Cursor, ask the agent to end its reply with a Markdown table card box.
  const cursorFootnote = notes => {
    if (client !== 'cursor' || !noticeOn(store)) return '';
    const footer = turnFooterMarkdown(store.repo, notes);
    return footer ? `\n\nEnd your reply to the user with this exact Markdown table at the very bottom (do not wrap it in a code block):\n${footer}` : '';
  };
  // Do not combine unrelated sessions from unsupported/older hook payloads.
  if (['pi', 'windsurf', 'copilot', 'opencode', 'vscode', 'droid', 'qwen', 'kiro', 'cline', 'kilo', 'augment', 'goose'].includes(client) && session === 'unknown') return;
  // Copilot CLI, VS Code's Copilot and the Cline CLI take no context from a prompt hook: the bundle waits
  // for the turn's first tool hook (parkPending)
  const parks = client === 'copilot' || client === 'vscode' || (client === 'cline' && ev.cline_cli);
  // installed hooks carry --record; THINKER_NO_LEARN=1 switches learning off without reinstalling them
  if (NO_LEARN) flags.record = false;
  if (pos[0] === 'prompt') {
    // A background subagent spawned to work thinker's queue (session-llm.js:subagentPrompt) runs the host's
    // hooks too: skip orienting, recording or starting another worker for it.
    if (isWorkerPrompt(ev.prompt)) { if (client === 'cursor' || client === 'cline') out(promptOutput(client, '')); return; }
    // Cursor answers once, in JSON: {continue}, with the bundle as additional_context (clients.js:promptOutput)
    let said = '';
    await (async () => {
      if (store.exists() && session !== 'unknown') tryImpact(store, { op: 'impact-observation', session, ...gitContext(repo) });
      if (parks || client === 'cursor') takePending(store.dir, session);
      // the turn's prompt hook ran: the tool hook's fallback for Cursor modes without one stays out of it
      if (client === 'cursor') { const f = orientedFile(store.dir, ev.generation_id || session); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, ''); }
      // what Cursor loaded into this chat, which its transcript does not record (harness-cursor.js)
      if (client === 'cursor' && harnessOn(store) && (!isTestMode() || process.env.THINKER_HOME)) { try { snapshotCursorInventory({ session, roots: [...(ev.workspace_roots || []), repo], transcript: ev.transcript_path, thinkerHome: thinkerHome() }); } catch {} }
      if (flags.record && store.exists()) { recordEvent(store.dir, session, { t: 'prompt', text: ev.prompt }); learnInBackground(ctx, client); }
      // The wiring checks (an older copy's entries, this copy's entries in this version's shape, thinker on PATH)
      // run once for each copy and version of thinker in a checkout, and again after a day: on every prompt they
      // were about 0.6 s of git and file reads, and the hook was being cut off at its 15 s limit on a loaded
      // machine (2026-10-22). `thinker update` runs `rewire` for every checkout as it is.
      if (store.exists() && wiringDue(path.join(store.dir, 'state', 'wiring-checked.json'), cli)) {
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
      // Once per session, what the code tools are and how to reach them: only with the first bundle that
      // serves a note. A session the cache has nothing for gets nothing at all (2026-10-07: on the Click
      // canary the intro, the workflow text and the schemas were the whole cost of the arm the notes did
      // not help). A held-out turn gets neither the intro nor the notes (ops.js:beginTurn): the holdout
      // compares turns with thinker's help against turns without; the intro waits for a served turn.
      const { turn, holdout } = store.exists() ? beginTurn(store, session) : { turn: 0, holdout: false };
      // the request's identifiers, for the context diet (diet.js; off until an experiment)
      if (store.exists() && client === 'claude' && dietConfig(store).enabled) rememberTerms(store, session, { prompt: ev.prompt });
      const emit = text => { if (client === 'cursor' || (client === 'cline' && !parks)) said = text; else if (parks) parkPending(store.dir, session, text); else out(promptOutput(client, text)); };
      if (!store.exists() || client === 'windsurf') return;
      // the first session in a repository: what `thinker setup` would write for it (repo-onboard.js)
      setupRepo(store, { client, cli, learn: !NO_LEARN && sessionLearning() });
      // queued learning of an app session (session-work.js): the runner starts and the agent is told to start
      // its subagent; the ancestry is walked only when jobs wait
      const work = !isTestMode() && !NO_LEARN && pendingJobs(store).length && desktopApp(subagentHarness(client)) ? startSessionWork(store, { cli, harness: subagentHarness(client) }) : '';
      // a weekly suggestion of directories to cover (coverage.js)
      // never in a benchmark or test session (THINKER_TEST=1): an offer there is noise in the agent's context and an
      // eval runner marks the session invalid for it (2026-10-18); THINKER_OFFERS=on restores them, for the tests of the offers
      const offersOn = !isTestMode() || process.env.THINKER_OFFERS === 'on';
      // the trimmed AGENTS.md follows the team's file (instructions-core.js): rewritten when AGENTS.md changed, for the
      // next session (Codex reads it when a session starts); a hash comparison when nothing did
      try { syncCore(store); } catch {}
      // a switched-off tool this request looks like it needs (harness.js:harnessRecall). Not an offer: a line for the
      // agent, on with the harness, so it runs in test mode too. Gated as an offer, an eval arm had to turn every
      // offer back on to measure it, and the warm-up offer then reached the agent (2026-10-19: a PostHog session
      // stopped to ask about warming its empty cache, because offerStore reads the main checkout's answered mark)
      const harnessHere = ['claude', 'codex', 'cursor'].includes(client) && !isHarnessEvent(ev.prompt);
      const recall = harnessHere ? await harnessRecall(store, ev.prompt || '', { session, client }) : '';
      // the names of the switched-off skills, once a session (harness.js:harnessIndex; off until an experiment), not an offer either
      const index = harnessHere ? harnessIndex(store, { session, client }) : '';
      // the week's five highest-leverage context changes, with the local page started and its link (context-suggest.js)
      const offer = [offersOn ? (coverageOffer(store, { client }) || harnessOffer(store, { client }) || contextSuggestOffer(store, { repoId: repoId(store.repo) })) : '', work, index, recall].filter(Boolean).join('\n\n');
      // Every git repository has a cache, started on first use and empty until it learns; the hooks serve
      // from it once it holds a few notes (ops.js:SERVE_MIN_NOTES). A prompt served nothing is still a
      // request: `thinker usage` and the telemetry count a machine as active by its requests, and a cache in
      // daily use that has not learned yet must not read as a machine thinker never ran on (2026-10-12: seven
      // of eight reporting devices read as idle for exactly this). Nothing is said.
      // with `find` on, the definitions the request names come with the prompt, notes or not (ops.js:codeForRequest);
      // a held-out turn gets none, like the notes
      const codeFor = notes => {
        if (holdout || disabledTools(store.config()).has('find')) return '';
        try { const c = codeForRequest(store, ev.prompt || '', { notes }); if (c.items.length) store.log({ op: 'code', session: session === 'unknown' ? undefined : session, client, served: c.items.map(i => `${i.path}:${i.symbol}`), tokens: c.tokens }); return c.text; } catch { return ''; }
      };
      // a harness event delivered as a prompt (a background task finished, a subagent reported) is no request:
      // it opens its turn, so the turn costs stay apart, and is served and logged nothing (ops.js:isHarnessEvent),
      // in a cache under the serving threshold too: until 2026-10-19 that one logged it as an unanswered request first
      if (isHarnessEvent(ev.prompt)) { if (offer) emit(offer); return; }
      if (!servesNotes(store)) {
        store.log({ op: 'orient', session: session === 'unknown' ? undefined : session, client, task: String(ev.prompt || '').slice(0, 200), served: [], empty: 'too-few-notes' });
        const code = codeFor([]); if (offer || code) emit([offer, code].filter(Boolean).join('\n\n')); return; }
      // outcome signal: a correction-shaped follow-up counts against the notes served earlier in this session
      if (session !== 'unknown' && looksLikeCorrection(ev.prompt)) outcome(store, { session, turn: turn > 1 ? turn - 1 : undefined, positive: false, reason: 'correction prompt: ' + String(ev.prompt).slice(0, 80) });
      if (session !== 'unknown') rememberTask(store, session, ev.prompt);
      // a held-out turn is served nothing by the hooks, and what it would have been served is logged (ops.js:beginTurn)
      const r = await orient(store, { task: ev.prompt || '', session: session === 'unknown' ? undefined : session, client, budget: Number(flags.budget) || HOOK_BUDGET, once: true, freshOnly: true, holdout, turn: turn || undefined });
      if (!r.included.length) { const code = codeFor([]); if (offer || code) emit([offer, code].filter(Boolean).join('\n\n')); return; }
      // the titles of the notes not served went with lookup, which took their ids (2026-10-22)
      const text = `<thinker-cache>\n${cacheBundleIntro()}\n\n${r.text}${cursorFootnote(r.included)}\n</thinker-cache>`;
      const card = noticeCard(store, { client, session, turn, holdout, notes: r.included });
      emit([offer, text, codeFor(r.included), card].filter(Boolean).join('\n\n'));
    })();
    if (client === 'cursor' || client === 'cline') out(promptOutput(client, said));
  } else if (pos[0] === 'pre') {
    // Before a shell command runs: a test run is answered with the same run through `thinker test`,
    // which keeps the log in a file and prints the failures grouped by cause (testing.js). Off
    // unless `tests: { nudge: true }` in .thinker/config.json. The hook must never fail a tool
    // call, so everything here is inside a try and nothing is printed on an error.
    try {
      if (!store.exists() || !PRE_TOOL_CLIENTS.includes(client)) return;
      if (!testsConfig(store).nudge) return;
      // shell commands only (Codex also fires this event for apply_patch and its MCP calls);
      // Cursor's beforeShellExecution names no tool and carries the command at the top level
      const name = toolName(ev.tool_name);
      if (name && name !== 'Bash') return;
      const command = toolInput(name, ev.tool_input).command || (typeof ev.command === 'string' ? ev.command : '');
      if (!command) return;
      if (!classifyTestCommand(command)) return;
      // once per command per session: the agent re-issues what it was given, and answering that
      // again would loop
      if (nudgedForTest(store, session, command)) return;
      const suggestion = wrappedCommand(command, wrapperBin(cli));
      store.log({ op: 'test-nudge', session: session === 'unknown' ? undefined : session, client,
        command: command.slice(0, 300), suggest: suggestion.slice(0, 300), how: rewritesCommands(client) ? 'rewrite' : 'deny' });
      const o = preToolOutput(client, { command: suggestion, reason: NUDGE_REASON(suggestion) });
      if (o) out(o);
    } catch { /* a pre-tool hook never blocks the tool call */ }
  } else if (pos[0] === 'tool') {
    // After a tool call: the agent opened files; serve notes anchored to them, once each.
    if (!store.exists()) return;
    if (isWorkerTool(ev.tool_name)) { try { fs.rmSync(traceFile(store.dir, session), { force: true }); } catch {} if (ev.hook_event_name === 'afterShellExecution') out('{}'); return; }
    // Cursor reports a shell command's output in afterShellExecution, not in postToolUse
    if (ev.hook_event_name === 'afterShellExecution') { if (flags.record) recordEvent(store.dir, session, { t: 'tool', name: 'Bash', input: { command: ev.command }, result: ev.output }); out('{}'); return; }
    if (flags.record && !(client === 'cursor' && toolName(ev.tool_name) === 'Bash')) { const name = toolName(ev.tool_name); recordEvent(store.dir, session, { t: 'tool', name, input: toolInput(name, ev.tool_input), result: ev.tool_response ?? ev.tool_output ?? ev.output }); }
    // which directories the session works in, counted for the weekly coverage suggestion (coverage.js)
    try { recordAccess(store, session, toolFiles(ev, repo)); } catch {}
    // Copilot failure hooks require a different output/exit protocol. Record the
    // failure but keep prompt context for the next successful tool result.
    if (client === 'copilot' && ev.error) { if (flags.record) learnInBackground(ctx, client); return; }
    const parts = [];
    if (parks || client === 'cline') { const pending = takePending(store.dir, session); if (pending) parts.push(pending); }
    if (flags.record) learnInBackground(ctx, client);
    // Cursor drops context added to an MCP call's result: wait for the next tool call,
    // unless the agent asked the cache itself, in which case it has the notes already
    const mcpCall = /^MCP:/i.test(ev.tool_name || '');
    if (client === 'cursor' && mcpCall && !/orient|lookup/i.test(ev.tool_name)) { /* keep the bundle for the next call */ }
    else if (client === 'cursor') {
      let p = takePending(store.dir, session);
      // the prompt hook does not run in every Cursor mode (`agent -p`): orient from the transcript's request
      // instead, once per turn; the prompt hook marks the turns it ran for, and the first of parallel tool calls
      // claims the rest (2026-10-15: unmarked, a held-out or empty turn was oriented again on every tool call)
      const turn = orientedFile(store.dir, ev.generation_id || session);
      const claim = () => { try { fs.mkdirSync(path.dirname(turn), { recursive: true }); fs.writeFileSync(turn, '', { flag: 'wx' }); return true; } catch { return false; } };
      if (!p && !mcpCall && ev.transcript_path && fs.existsSync(ev.transcript_path) && servesNotes(store) && claim()) {
        const task = parseTranscript(ev.transcript_path).events.filter(e => e.t === 'prompt').pop()?.text;
        if (task && !isWorkerPrompt(task)) { const { turn, holdout } = beginTurn(store, session); const r = await orient(store, { task, session, client: 'cursor', budget: Number(flags.budget) || HOOK_BUDGET, once: true, freshOnly: true, holdout, turn: turn || undefined }); if (r.included.length) p = `<thinker-cache>\nNotes about this repo from earlier sessions; their code dependencies were re-hashed just now.\n\n${r.text}${cursorFootnote(r.included)}\n</thinker-cache>`; }
      }
      if (p && !mcpCall) parts.push(p);
    }
    const t = holdoutTurn(store, session);
    // the repository's instruction sections this tool call is about (instruction-sections.js; off until an experiment):
    // the team's own text, not notes, so neither the notes' holdout nor an empty cache holds them back
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
    if ((client === 'claude' || flags.late) && !t.holdout && servesNotes(store)) {
      const name = toolName(ev.tool_name), command = toolInput(name, ev.tool_input).command || '';
      // an edit tool, or a shell command that writes a file in place
      const edited = name === 'Edit' || name === 'Write' || (name === 'Bash' && /\b(sed|perl)\s+(-\w+\s+)*-\w*i\b|\btee\s|>{1,2}\s*[\w./-]+\.\w+/.test(command));
      const r = lateNotes(store, { session, client, files: toolFiles(ev, repo), edited, turn: t.turn || undefined });
      if (r.text) parts.push(r.text);
      // understanding notes on the first sight of a file (ops.js:onSightNotes; off until an experiment)
      let sightedNotes = [];
      if (onSightConfig(store).enabled) {
        const s = onSightNotes(store, { session, client, files: [...toolFiles(ev, repo), ...seenFiles(ev, repo)], turn: t.turn || undefined });
        if (s.text) { parts.push(s.text); sightedNotes = s.included || []; }
      }
      if (client === 'cursor' && (r.included?.length || sightedNotes.length)) {
        const turnNotes = peekTurn(store, session !== 'unknown' ? session : null).map(id => store.get(id)).filter(Boolean);
        const fn = cursorFootnote(turnNotes.length ? turnNotes : [...(r.included || []), ...sightedNotes]);
        if (fn) parts.push(fn.trim());
      }
      // and the file's own outline, from the symbol table (ops.js:onSightOutlines; off until an experiment)
      if (onSightOutlineConfig(store).enabled) {
        const sighted = [...toolFiles(ev, repo).map(file => ({ file, lines: [] })), ...seenHits(ev, repo)];
        const o = onSightOutlines(store, { session, client, sighted, identifier: searchedIdentifier(ev), turn: t.turn || undefined });
        if (o.text) parts.push(o.text);
      }
    }
    // the skills past sessions here opened for files like the one first opened or edited (skill-suggest.js; off
    // unless harness.skillSuggest): a held-out turn logs what it withheld and says nothing
    if ((client === 'claude' || client === 'codex') && skillSuggestOn(store)) {
      try { const f = hookSkillFacts(ev, repo, toolFiles(ev, repo)); const line = skillSuggestLines(store, { session, client, files: f.files, opened: f.opened, holdout: t.holdout, turn: t.turn || undefined, transcript: ev.transcript_path }); if (line) parts.push(line); } catch {}
    }
    const card = noticeCard(store, { client, session, ...t, notes: peekTurn(store, session).map(id => store.get(id)).filter(Boolean) });
    if (card) parts.push(card);
    if (parts.length || updated !== undefined) out(toolOutput(client, parts.join('\n\n'), { updated, mcp: updatedMcp }));
  } else if (pos[0] === 'stop') {
    if (!store.exists()) return;
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
    // completeness nudge (once per session, never when already continuing from a stop hook)
    if (flags.nudge && !ev.stop_hook_active) {
      let changed = [];
      try { changed = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo }).toString().split('\n').map(l => l.slice(3).trim()).filter(f => f && !f.startsWith('.thinker') && !f.startsWith('.mcp.json') && !f.startsWith('.claude/')); } catch {}
      const n = completenessNudge(store, { session, changed });
      if (n.text) { out(JSON.stringify({ decision: 'block', reason: n.text })); return; }
    }
    if (client === 'cursor') out('{}');
    // what the turn's servings saved, for the user; the ids are cleared so the next turn starts from none
    noticeCard(store, { client, session, ...holdoutTurn(store, session), notes: peekTurn(store, session).map(id => store.get(id)).filter(Boolean), updateOnly: true });
    const served = takeTurn(store, session !== 'unknown' ? session : null);
    // what the session has cost so far, for the holdout comparison (usage.js:holdoutOf): the turn's cost is the
    // difference from the line of the turn before, so each line carries the turn number the prompt hook opened
    const t = holdoutTurn(store, session);
    if (session !== 'unknown' && ev.transcript_path && fs.existsSync(ev.transcript_path)) { try { const p = parseTranscript(ev.transcript_path); const record = { op: 'session', session, turn: t.turn || undefined, client, model: p.model || undefined, holdout: t.holdout || undefined, ...gitContext(repo), ...(p.stats || {}) }; store.log(record); tryImpact(store, record); } catch {} }
    if (noticeOn(store)) {
      // once a week, what the notes saved over the last 30 days (usage.js:weeklyNotice); not on a held-out turn
      // where the card mod runs, the turn's notes are its card under the answer (claude-card.js)
      const carded = client === 'claude' && claudeCardActive(session);
      const notice = [served.length && !carded ? turnNotice(store.repo, served.map(id => store.get(id)).filter(Boolean)) : '', NO_LEARN ? '' : maintenanceNotice(store), t.holdout ? '' : weeklyNotice(store)].filter(Boolean).join('\n');
      const o = stopOutput(client, notice); if (o) out(o);
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
    // One distill per session, not per turn: each call carries a fixed prompt, so at the end of a turn
    // only a backlog near the trace limit is distilled (`--batch`). The session's end distills the
    // rest; where the agent fires no end, the catch-up run takes sessions that have gone quiet.
    const ending = /^session_?end$/i.test(ev.hook_event_name || '');
    // inside a desktop app no agent CLI runs: the distill waits for the app's own session (session-work.js)
    const app = desktopApp(subagentHarness(client));
    if (app) {
      markAppSession(store, app);
      const due = ending || (() => {
        try {
          const sf = path.join(store.dir, 'state', path.basename(source).replace(/\.jsonl?$/, '') + '.json');
          const fromLine = fs.existsSync(sf) ? (JSON.parse(fs.readFileSync(sf, 'utf8')).line || 0) : 0;
          return batchDue(parseTranscript(source, { fromLine }).events);
        } catch { return false; }
      })();
      if (due) enqueueJob(store, `distill-${session}`, ['distill', source, '--incremental', '--quiet', '--session', session, '--repo', repo]);
      if (!ending) learnInBackground(ctx, client, { maintain: false });
      return;
    }
    if (isTestMode()) return;
    // Sessions are distilled locally through the agent's own login.
    // Distilling a session is a model call of its own (about 25k tokens); it draws on the same
    // daily token cap as maintenance, so a long day of work cannot run through the agent's usage
    const cap = withinDailyCap(store);
    if (!cap.ok) { store.log({ op: 'distill-skipped', reason: 'dailyTokens', spent: cap.spent, cap: cap.cap, session, client }); reportCapped(store, cap); return; }
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
  const args = ['learn', '--quiet', '--days', '2', '--max', '5', '--idle-min', String(LEARN_IDLE_MIN), ...(maintain ? ['--maintain'] : []), '--repo', repo];
  // inside a desktop app no agent CLI runs: the catch-up waits for the app's own session (session-work.js)
  const app = desktopApp(subagentHarness(client));
  if (app) { markAppSession(store, app); enqueueJob(store, maintain ? 'learn-maintain' : 'learn', args); return; }
  spawn('node', [path.join(HERE, 'cli.js'), 'learn', '--quiet', '--days', '2', '--max', '5', '--idle-min', String(LEARN_IDLE_MIN), ...(maintain ? ['--maintain'] : []), '--repo', repo], { detached: true, stdio: 'ignore', env: { ...process.env, THINKER_LLM_PREFER: client } }).unref();
}

export const commands = {
  'hook': hookCommand,
};
