import { projectFromFlags, includesPath, projectRecordKey } from '../project.js';
import { learningPlan, refineLearningPlan } from '../learning-evidence.js';
import { selectLearningNotes, prepareNotes } from '../note-learning.js';
import { deferLearning, safeLearningAssessments } from '../learning-pending.js';
// The learning loop by hand and from the hooks: distilling sessions (distill, learn, record), one
// maintenance run, verification, the exploration sessions of setup (seed), and mining merged pull
// requests (mine-prs). The helpers take the dispatcher's context (cli.js) as their first argument.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { cleanErrorMessage } from '../benchmark.js';
import { condense, parseTranscript, exploreCount, batchDue, distillEvents, saveNotes, transcriptsFor, injectedIds, relatedNotes, sessionStakes, QUIET_MIN_EXPLORE } from '../distill.js';
import { available, provider, findBin, resolveModel, BINS } from '../llm.js';
import { maintain, renderMaintain, withinDailyCap, reportCapped } from '../maintain.js';
import { logModelUsage, streamModelUsage, normalizeModelUsage, formatTokens } from '../model-usage.js';
import { refresh, attest, outcome, distillKinds } from '../ops.js';
import { batchProgress, oneLine } from '../progress.js';
import { FIX_LIKE, listMergedPrs, listMergedCommits, distillPr, minedPrs, recordMinedPrs, nextPrs, pickPrs } from '../prs.js';
import { selectMenu, getAgentDisplayName } from '../setup.js';
import { planAreas, parseAreaLimit } from '../topology.js';
import { recordEvent, traceFile, toolName, toolInput, hydrate, findSessions } from '../transcripts.js';
import { sessionKey } from '../usage.js';
import { githubSlug, hasBin, verifyAll } from './shared.js';

async function learnCommand(ctx) {
  const { flags } = ctx;
  await learn(ctx, { days: Number(flags.days) || 14, idleMin: flags['idle-min'] === undefined ? 2 : Number(flags['idle-min']), max: Number(flags.max) || 50, dry: !!flags.dry, quiet: !!flags.quiet });
  if (flags.prs) await mineMore(ctx, { limit: flags.prs === true ? 20 : Number(flags.prs) || 20, model: flags.model, dry: !!flags.dry });
  if (flags.maintain) await runMaintain(ctx, { quiet: !!flags.quiet, dry: !!flags.dry });
  return;
}

async function maintainCommand(ctx) {
  const { flags } = ctx;
  // one run of what the hooks do in the background; --dry counts without model calls
  await runMaintain(ctx, { quiet: !!flags.quiet, dry: !!flags.dry });
  return;
}

async function distillCommand(ctx) {
  const { pos, flags, repo, out } = ctx;
  let file = pos[0];
  if (!file) { file = transcriptsFor(repo)[0]; if (!file) { out('no transcript found for ' + repo); process.exit(1); } }
  await distillFile(ctx, file, { minExplore: Number(flags['min-explore']) || 1, dry: !!flags.dry, model: flags.model, quiet: !!flags.quiet, incremental: !!flags.incremental, evidenceOnly: !!flags.evidence, batch: !!flags.batch, format: flags.format, session: typeof flags.session === 'string' ? flags.session : undefined });
  return;
}

async function recordCommand(ctx) {
  const { pos, store, out, readStdin } = ctx;
  // thinker record <session>: events as JSON lines on stdin; then `thinker distill <printed file>`
  let f = traceFile(store.init().dir, pos[0] || 'manual'), n = 0;
  for (const l of readStdin().split('\n')) { let j; try { j = JSON.parse(l); } catch { continue; } if (!['prompt', 'say', 'tool'].includes(j.t)) continue; if (j.t === 'tool') { j.name = toolName(j.name); j.input = toolInput(j.name, j.input); } recordEvent(store.dir, pos[0] || 'manual', j); n++; }
  out(`recorded ${n} events in ${f}`);
  return;
}

async function outcomeCommand(ctx) {
  const { pos, store, out } = ctx;
  // thinker outcome <session-id> good|bad [reason]  — for CI / external integrations
  const r = outcome(store, { session: pos[0], positive: pos[1] !== 'bad', reason: pos.slice(2).join(' ') });
  out(`${r.length} notes updated: ${r.map(x => `${x.id} c=${Math.round(x.confidence * 100)}%`).join(', ') || '-'}`);
  return;
}

async function verifyCommand(ctx) {
  const { pos, store } = ctx;
  let notes = refresh(store, store.list());
  notes = pos.length ? notes.filter(n => pos.includes(n.id)) : notes.filter(n => n.status === 'stale');
  await verifyAll(ctx, notes);
  return;
}

async function checkCommand(ctx) {
  const { flags, repo, store, out } = ctx;
  const notes = refresh(store, store.list(), { narrow: true });
  const stale = notes.filter(n => n.status === 'stale');
  if (!flags.quiet) {
    for (const n of stale) out(`stale  ${n.id}: ${n.stale.changed.map(c => `${c.path}${c.symbol ? ':' + c.symbol : ''} (${c.reason})`).join(', ')}`);
    for (const u of store.unreadable()) out(`warning: ${path.relative(repo, u.file)} is not served: ${u.reason}`);
    out(`${stale.length}/${notes.length} notes stale`);
  }
  if (flags.verify && stale.length) await verifyAll(ctx, stale);
  return;
}

async function seedCommand(ctx) {
  const { flags } = ctx;
  // Bootstrap coverage: one exploration session per source area, distilled.
  const project = projectFromFlags(ctx.repo, flags, { save: !flags.dry });
  if (project) ctx.out(`Cache build: ${project.name} (${project.directories.join(', ')})`);
  const r = await seed(ctx, { directories: project?.directories || null, areas: parseAreaLimit(flags.areas), model: flags.model, dry: !!flags.dry, prompts: flags.prompts, agent: typeof flags.agent === 'string' ? flags.agent : undefined });
  if (r && r.ok === 0 && !r.skipped && !flags.dry) process.exitCode = 1;
  return;
}

async function minePrsCommand(ctx) {
  const { pos, flags, repo } = ctx;
  // thinker mine-prs [owner/repo] [--limit n] [--dry]; a window by hand: --before <iso> [--after <iso>] [--again]
  await mineMore(ctx, { slug: pos[0], before: flags.before, after: flags.after, again: !!flags.again, limit: Number(flags.limit) || (flags.before || flags.after ? 60 : 20), model: flags.model, dry: !!flags.dry, fixes: !!flags.fixes, git: !!flags.git });
  return;
}

// One maintenance run, with PR mining wired to this repository's origin.
export async function runMaintain(ctx, { quiet, dry }) {
  const { repo, store, out, NO_LEARN } = ctx;
  if (NO_LEARN) { if (!quiet) out('maintenance is switched off (THINKER_NO_LEARN)'); return; }
  if (!store.exists()) return;
  const slug = githubSlug(repo);
  const canMine = provider() && (slug ? hasBin('gh') : true);
  const r = await maintain(store, repo, { dry, fns: {
    minePrs: canMine ? ({ after, limit }) => minePrs(ctx, slug, { after, before: new Date().toISOString(), limit, repo, phase: 'maintenance' }) : undefined,
  } });
  if (!quiet) out(renderMaintain(r));
}

// Catch-up learning: works without any end-of-session hook, so it covers
// agents and modes that do not fire one (Cursor's headless mode, for one).
export async function learn(ctx, { days, idleMin, max, dry, quiet }) {
  const { repo, store, out, sessionLearning, NO_LEARN } = ctx;
  if (NO_LEARN) { if (!quiet) out('learning is switched off (THINKER_NO_LEARN)'); return; }
  if (!sessionLearning()) { if (!quiet) out('learning from sessions is off (learn.sessions in .thinker/config.json); maintenance and pull requests go on'); return; }
  const lock = path.join(store.init().dir, 'state', 'learn.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try { if (Date.now() - fs.statSync(lock).mtimeMs < 15 * 60_000) { if (!quiet) out('another learn run is in progress'); return; } } catch {}
  if (!dry) fs.writeFileSync(lock, String(process.pid));
  try {
    const sessions = findSessions(repo, { sinceMs: days * 86400_000, storeDir: store.dir }).filter(s => Date.now() - s.mtime >= idleMin * 60_000);
    let done = 0;
    for (const s of sessions) {
      const cap = withinDailyCap(store);
      if (!dry && !cap.ok) {
        store.log({ op: 'distill-skipped', reason: 'dailyTokens', spent: cap.spent, cap: cap.cap, left: sessions.length - done });
        reportCapped(store, cap);
        if (!quiet) out(`stopping: ${formatTokens(cap.spent)} of the ${formatTokens(cap.cap)} tokens learning may use a day are used (maintain.dailyTokens in .thinker/config.json)`);
        break;
      }
      let state = {}; try { state = JSON.parse(fs.readFileSync(path.join(store.dir, 'state', path.basename(s.file).replace(/\.jsonl?$/, '') + '.json'), 'utf8')); } catch {}
      let total = 0; try { total = parseTranscript(s.file).lineCount; } catch { continue; }
      if ((state.line || 0) >= total) continue;
      if (done >= max) break;
      if (dry) { out(`${s.client.padEnd(7)} ${s.session}  ${total - (state.line || 0)} new lines`); continue; }
      if (!quiet) out(`${s.client} ${s.session}`);
      process.env.THINKER_LLM_PREFER = s.client;
      try { await distillFile(ctx, s.file, { minExplore: 3, quiet, incremental: true, session: s.session }); done++; } catch (e) { if (!quiet) out(`  failed: ${String(e.message).slice(0, 160)}`); }
    }
    if (!quiet && !dry) out(`learned from ${done} of ${sessions.length} sessions`);
  } finally { if (!dry) fs.rmSync(lock, { force: true }); }
}

export async function distillFile(ctx, file, { minExplore, dry, model, quiet, incremental, evidenceOnly, batch, format, session, phase = 'learning' }) {
  const { repo, store, out } = ctx;
  const stateDir = path.join(store.dir, 'state');
  const stateFile = path.join(stateDir, path.basename(file).replace(/\.jsonl?$/, '') + '.json');
  let state = {}; try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  const fromLine = incremental ? (state.line || 0) : 0;
  const { events, lineCount, model: sessionModel, format: fmt } = parseTranscript(file, { fromLine, format });
  hydrate(events, repo, { trace: session ? traceFile(store.dir, session) : null });
  // decided before the lock, so a session-end distill right after is not turned away by it
  if (batch && !batchDue(events)) { if (!quiet) out('a small backlog since last distill; left for the end of the session'); return; }
  // a turn-end hook and a session-end hook can both ask for the same session
  const lock = stateFile + '.lock';
  if (incremental && !dry) {
    try { if (Date.now() - fs.statSync(lock).mtimeMs < 10 * 60_000) return; } catch {}
    fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(lock, String(process.pid));
  }
  try { return await distillEventsToNotes(); } finally { if (incremental && !dry) fs.rmSync(lock, { force: true }); }
  async function distillEventsToNotes() {
  const n = exploreCount(events);
  if (n < minExplore && !(incremental && sessionStakes(events).any)) { if (!quiet) out(`only ${n} exploration calls since last distill (<${minExplore}); nothing to distill`); return; }
  if (!events.some(e => e.t === 'say')) { if (!quiet) out('the session has no answer from the agent yet; nothing to distill'); return; }
  // notes served in this session: named in the transcript, or recorded on the note when a hook served it
  const ids = new Set(injectedIds(file, { fromLine }));
  if (session) for (const n of store.list()) if ((n.servedIn || []).includes(session)) ids.add(n.id);
  let served = [...ids].filter(id => !(incremental && (state.assessed || []).includes(id))).map(id => store.get(id)).filter(Boolean);
  // Separate discovery from assessment: a serving alone warrants neither a model call
  // nor a usefulness verdict. Unselected evidence stays unknown.
  const config = store.config().learn || {};
  let plan = incremental || evidenceOnly ? learningPlan(events, { served, repo, key: session || path.basename(file),
    auditRate: evidenceOnly ? 0 : config.auditRate, minExplore: config.quietExplore ?? QUIET_MIN_EXPLORE }) : null;
  if (plan?.mode === 'skip') {
    store.log({ op: 'distill-skipped', reason: 'no-learning-evidence', transcript: path.basename(file), explore: n, session });
    if (!dry) {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ ...state, line: lineCount, at: new Date().toISOString() }));
    }
    if (!quiet) out('no learning evidence; no model call');
    return;
  }
  const started = performance.now();
  let failed = true;
  try {
  const accounting = { store, phase, transcript: path.basename(file), session, dry: !!dry };
  plan = await refineLearningPlan(store, events, plan || { mode: 'full', served, discover: true, trace: condense(events) }, { accounting });
  served = plan.served;
  // the kinds worth a note here: what is served, and what review reads from the archive (ops.js:distillKinds)
  const kinds = distillKinds(store);
  const catalog = plan.discover ? await selectLearningNotes(store, { requests: events.filter(e => e.t === 'prompt').map(e => e.text || '').join('\n').slice(0, 3000), evidence: plan.trace.slice(0, 12000) }, { max: 12, accounting }) : { status: 'ok', notes: [] };
  if (catalog.status === 'unavailable') throw new Error(`note catalog unavailable; session will retry: ${catalog.reason}`);
  const existing = catalog.status === 'ok' ? catalog.notes : relatedNotes(store, events, { max: 12 });
  if (phase !== 'init' && !withinDailyCap(store).ok) throw new Error('daily learning token cap reached; session will retry');
  const r = await distillEvents(events, { model: model || store.config().distillModel || 'sonnet', repoHint: repo, served, existing, kinds, evidence: plan.trace, discover: plan.discover, compact: plan.compact ?? !['audit', 'full'].includes(plan.mode), accounting: { ...accounting, purpose: 'distill', traceEvents: events.length, learningMode: plan.mode, evidenceChars: plan.trace.length } });
  if (dry) { failed = false; out(JSON.stringify({ notes: r.notes, assessments: r.assessments }, null, 2)); out(`(${r.notes.length} notes, ${r.tokens == null ? 'tokens not reported' : '~' + formatTokens(r.tokens) + ' tokens'}, trace ${r.traceChars} chars)`); return; }
  const source = { type: 'agent', ref: path.basename(file, '.jsonl') };
  const prepared = await prepareNotes(store, r.notes, { evidence: r.evidence, source, kinds, accounting });
  const s = saveNotes(store, prepared.notes, { source, kinds, reconciled: prepared.reconciled });
  s.skipped.push(...prepared.skipped);
  const assessments = safeLearningAssessments(store, r.assessments, served);
  const pending = deferLearning(store, [...prepared.deferred, ...(s.deferred || []), ...assessments.deferred], { source, evidenceRef: path.resolve(file) });
  if (pending.length && !quiet) out(`deferred ${pending.length} findings for investigation: ${path.join(stateDir, 'learning-pending')}`);
  // under the session's id, which is what servings are logged under: a transcript's file name is
  // that id only for Claude Code (Codex adds a date, a recorded trace a prefix, Gemini another suffix)
  // with the session's model, so the reading its confirmed notes saved can be priced (usage.js)
  const applied = attest(store, assessments.accepted, { session: session || sessionKey(path.basename(file)), client: fmt === 'agy' ? 'gemini' : fmt === 'events' ? 'trace' : fmt, model: sessionModel });
  if (!quiet) for (const a of applied) out(`attest  ${a.verdict.padEnd(12)} ${a.id} → c=${Math.round(a.confidence * 100)}%`);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ line: prepared.retryable || s.retryable ? fromLine : lineCount, assessed: [...new Set([...(state.assessed || []), ...applied.map(n => n.id)])], at: new Date().toISOString() }));
  store.log({ op: 'distill', transcript: path.basename(file), explore: n, saved: s.saved.map(x => x.id), merged: s.merged.map(x => x.id), skipped: s.skipped, deferred: pending.length, retryable: prepared.retryable || !!s.retryable, evidenceSelection: plan.evidenceSelection, cost: r.cost, metered: true, phase, learningMode: plan?.mode || 'full', traceChars: r.traceChars });
  if (!quiet) {
    for (const x of s.saved) out(`saved   ${x.id}  [${x.kind}] ${x.title}`);
    for (const x of s.merged) out(`merged  ${x.id}  [${x.kind}] ${x.title}`);
    for (const x of s.skipped) out(`skipped ${x.title}: ${x.reason}`);
    out(`distilled ${events.length} events (${n} exploration calls) → ${s.saved.length} new, ${s.merged.length} merged${r.tokens ? `; ~${formatTokens(r.tokens)} tokens` : ''}`);
  }
  failed = false;
  return { notes: [...s.saved, ...s.merged].map(n => n.id), cost: r.cost || 0, tokens: r.tokens || 0 };
  } finally {
    // One outcome for the whole run, including retries/fallbacks and persistence.
    // Skipped sessions never reach this block. Abrupt process kills remain unknown.
    store.log({ op: 'distill-run', phase, dry: !!dry, failed,
      durationMs: Math.max(0, Math.round(performance.now() - started)) });
  }
  }
}

export async function seed(ctx, { areas, model, dry, prompts, agent, directories = null }) {
  const { flags, repo, store, out } = ctx;
  if (prompts && directories) throw new Error('--prompts cannot be combined with a project selection; use --full-repo for custom prompts.');
  const { areas: areaList, omitted } = planAreas(repo, { limit: areas, directories });
  const list = prompts ? JSON.parse(fs.readFileSync(prompts, 'utf8')).map(p => ({ prompt: p })) : areaList.map(a => {
    if (a.isFile) {
      return {
        dir: a.label, n: a.n, files: a.files,
        prompt: `Orient a new contributor in ${a.dir}: what this module is responsible for, its primary classes and functions (cite file:symbol), how control and data flow into and out of it, the key invariants and conventions a newcomer would get wrong, and how it is tested. Read the actual code; be concrete and cite file:symbol.`
      };
    }
    return {
      dir: a.label, n: a.n, files: a.files,
      prompt: `Orient a new contributor in ${a.dir}/ (${a.n} source files): what this subsystem is responsible for, its main entry points and how control flows into and out of it (cite file:symbol), the two or three things that must change together when extending it, local conventions a newcomer would get wrong, and how it is tested. Read the actual code; be concrete and cite file:symbol.`
    };
  });
  if (!prompts && omitted.length) out(`Exploring ${areaList.length} of ${areaList.length + omitted.length} areas (--areas ${areas}); omitted: ${omitted.map(a => a.label).join(', ')}`);
  for (const a of list) if (a.files) a.prompt += `\nSource files assigned to this session:\n${a.files.map(f => JSON.stringify(f)).join('\n')}\nFocus on these files; follow other files only as needed to explain their dependencies.`;
  if (!list.length) { out(areas === 0 ? 'Exploration skipped (--areas 0).' : 'No source areas found in the selected directories.'); return { ok: 0, total: 0, tokens: 0, failures: [], skipped: areas === 0 }; }
  if (directories) for (const a of list) a.prompt += `\nCache project directories: ${directories.join(', ')}. Focus on this area; follow dependencies outside these directories only when needed to explain it. Use repository-relative file:symbol pointers.`;
  if (dry) {
    for (const a of list) {
      out(`${(a.dir || '-').padEnd(40)} ${a.n || ''}`);
      if (a.files) for (const file of a.files) out(`  ${JSON.stringify(file)}`);
    }
    return;
  }
  let activeAgent = agent || exploreAgent();
  if (!activeAgent) {
    out('\n❌ cache init failed: no agent CLI found to explore with (claude, gemini, codex, or cursor).');
    process.exitCode = 1;
    return { ok: 0, total: list.length, tokens: 0, agent: null, failures: [{ area: 'all', error: 'no agent CLI found' }] };
  }

  let tokens = 0, ok = 0;
  const failures = [];
  const progress = batchProgress({ dir: store.dir, name: 'Exploration', total: list.length, out, every: 1, verbose: Boolean(flags.verbose) });
  for (const a of list) {
    const label = a.dir || a.prompt.slice(0, 40);
    progress.start(label);
    let r = await explore(ctx, activeAgent, a.prompt, model);

    if (r.error) {
      progress.pause();
      progress.detail({ area: label, agent: activeAgent, error: r.error });
      const otherAgents = available().filter(ag => ag !== activeAgent && ['claude', 'gemini', 'codex', 'cursor'].includes(ag));
      if (process.stdin.isTTY && !flags.yes && otherAgents.length) {
        out(`        ${getAgentDisplayName(activeAgent)} failed: ${oneLine(cleanErrorMessage(r.error)).slice(0, 120)}`);
        const items = [
          ...otherAgents.map((ag, idx) => ({
            label: getAgentDisplayName(ag),
            value: ag,
            key: String(idx + 1),
            name: getAgentDisplayName(ag),
          })),
          {
            label: 'Exit',
            value: 'exit',
            key: 'e',
            name: 'Exit',
          },
        ];
        const selected = await selectMenu({
          header: '        Choose another agent to retry this area, or exit:',
          hint: 'Use ↑/↓ to navigate, Enter to select:',
          items,
          defaultIndex: 0,
          out,
        });
        const chosen = selected && selected.value !== 'exit' ? selected.value : null;
        if (chosen) {
          activeAgent = chosen;
          process.env.THINKER_LLM = chosen;
          out(`        Retrying with ${getAgentDisplayName(chosen)}…`);
          progress.start(label);
          r = await explore(ctx, activeAgent, a.prompt, model);
        }
      }
      if (r.error) {
        failures.push({ area: label, error: r.error });
        progress.complete({ error: r.error });
        break;
      }
    }

    tokens += r.tokens || 0;
    try {
      const result = await distillFile(ctx, r.transcript, { minExplore: 1, dry: false, model: undefined, quiet: true, incremental: false, phase: 'init' });
      tokens += result?.tokens || 0;
      ok++;
      progress.complete({ notes: result?.notes || [], agent: activeAgent });
    } catch (e) {
      failures.push({ area: label, error: e.message });
      progress.complete({ error: e.message });
    } finally {
      if (r.temp) fs.rmSync(r.transcript, { force: true });
    }
  }
  const result = progress.finish({ tokens, retry: 'Check your agent login, then retry with: thinker seed (or thinker seed --agent <name>).' });
  if (ok === 0 && list.length > 0) process.exitCode = 1;
  return { ok, total: list.length, saved: result.saved, tokens, agent: activeAgent, failures };
}

// the agent that explores: THINKER_LLM if it names one, else the first installed in fallback order (claude, gemini, codex, cursor)
export function exploreAgent() {
  const agents = available().filter(p => ['claude', 'gemini', 'codex', 'cursor'].includes(p));
  return agents.includes(process.env.THINKER_LLM) ? process.env.THINKER_LLM : agents[0] || null;
}

// One read-only exploration session with the given agent; returns the file
// holding its transcript (the agent's own, or its streamed output).
export async function explore(ctx, agent, prompt, model) {
  const { store } = ctx;
  let response = { provider: agent, model: resolveModel(agent, model), usage: null, cost: null };
  let result;
  try {
    result = await exploreOnce(ctx, agent, prompt, model, fields => { response = { ...response, ...fields }; });
    if (result && !result.error) result.tokens = normalizeModelUsage(agent, response.usage).totalTokens || 0;
    return result;
  } finally {
    logModelUsage(store, { purpose: 'explore', phase: 'init' }, { ...response, failed: !result || !!result.error });
  }
}

export async function exploreOnce(ctx, agent, prompt, model, onUsage) {
  const { repo, store } = ctx;
  const env = { ...process.env, THINKER_IN_LLM: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', IS_SANDBOX: '1' };
  const opts = { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28, env };
  const bin = findBin(BINS[agent] || []);
  if (!bin) return { error: `the ${agent} CLI was not found` };
  const stream = path.join(store.dir, 'state', `explore-${Date.now()}.jsonl`);
  fs.mkdirSync(path.dirname(stream), { recursive: true });
  const m = resolveModel(agent, model);
  if (agent === 'claude') {
    const r = await exploreCommand(bin, ['-p', '--model', m || 'sonnet', '--output-format', 'json', '--permission-mode', 'plan', '--tools', 'Read,Glob,Grep', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--max-turns', '40'], { ...opts, input: prompt });
    if (r.status !== 0 && !String(r.stdout).trim()) return { error: (r.stderr || `claude exited ${r.status}`).slice(0, 200) };
    let j; try { j = JSON.parse(r.stdout); } catch { return { error: (r.stderr || r.stdout || '').slice(0, 200) }; }
    onUsage({ usage: j.usage || j.stats || null, cost: j.total_cost_usd ?? null, model: j.model || m });
    if (j.is_error) return { error: String(j.result || j.error || 'claude error').slice(0, 200) };
    const transcript = transcriptsFor(repo).find(f => f.includes(j.session_id));
    return transcript ? { transcript, cost: j.total_cost_usd || 0, turns: j.num_turns } : { error: 'no transcript found' };
  }
  if (path.basename(bin) === 'agy') {
    const agyArgs = ['-p', prompt, '--model', m || 'gemini-3.8-flash-high', '--output-format', 'json', '--mode=plan'];
    const r = await exploreCommand(bin, agyArgs, { ...opts, cwd: repo });
    if (r.status !== 0 && !String(r.stdout).trim()) return { error: (r.stderr || `agy exited ${r.status}`).slice(0, 200) };
    let j; try { j = JSON.parse(r.stdout); } catch { return { error: (r.stderr || r.stdout || '').slice(0, 200) }; }
    onUsage({ usage: j.usage || j.stats || null, cost: j.total_cost_usd ?? null, model: j.model || m });
    if (j.is_error) return { error: String(j.result || j.error || 'agy error').slice(0, 200) };
    const convId = j.conversation_id;
    if (convId) {
      const transcript = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
      if (fs.existsSync(transcript)) return { transcript, cost: 0, turns: j.num_turns };
    }
    return { error: 'agy transcript not found: ' + (r.stderr || r.stdout || '').slice(0, 200) };
  }
  let r;
  if (agent === 'codex') r = await exploreCommand(bin, ['exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--sandbox', 'read-only', ...(m ? ['--model', m] : ['--model', 'gpt-6-luna']), '--cd', repo, '-'], { ...opts, input: prompt });
  else if (agent === 'cursor') r = await exploreCommand(bin, ['-p', '--output-format', 'stream-json', '--mode', 'ask', '--trust', ...(m ? ['--model', m] : []), '--workspace', repo, prompt], opts);
  else r = await exploreCommand(bin, ['--output-format', 'stream-json', '--approval-mode=plan', ...(m ? ['-m', m] : ['-m', 'gemini-3.8-flash-high'])], { ...opts, input: prompt });
  if (r.status !== 0 && !String(r.stdout).trim()) return { error: (r.stderr || '').slice(0, 200) };
  onUsage(streamModelUsage(agent, r.stdout));
  // failures these CLIs report inside their output (usage limits, auth)
  for (const l of String(r.stdout).split('\n')) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (j.type === 'turn.failed' || (j.type === 'result' && j.is_error)) return { error: String(j.error?.message || j.result || j.message || 'failed').slice(0, 200) };
  }
  fs.writeFileSync(stream, r.stdout);
  return { transcript: stream, temp: true };
}

// Asynchronous child collection lets progress updates continue during long explorations.
export function exploreCommand(bin, args, { input, ...opts }) {
  return new Promise(resolve => {
    const child = execFile(bin, args, opts, (error, stdout, stderr) => {
      resolve({ status: error ? (error.code || 1) : 0, stdout, stderr: stderr || error?.message || '' });
    });
    child.stdin.on('error', () => {}); // the agent can exit before consuming stdin
    child.stdin.end(input);
  });
}

// mine-prs and learn --prs: the repo defaults to the GitHub origin, and what is needed is checked first
export async function mineMore(ctx, { slug, ...opts }) {
  const { repo, store, out } = ctx;
  const project = projectFromFlags(repo, ctx.flags, { save: !opts.dry });
  if (project) out(`Cache build: ${project.name} (${project.directories.join(', ')})`);
  opts.directories = project?.directories || null;
  slug = slug || githubSlug(repo);
  if (!slug && !hasBin('gh')) {
    out('ℹ️  GitHub remote/gh CLI unavailable; falling back to local git history...');
  }
  if (!provider()) { out('❌ merged PRs: needs an agent CLI (claude, gemini, or codex) or ANTHROPIC_API_KEY'); process.exitCode = 1; return; }
  store.init();
  return minePrs(ctx, slug, { ...opts, repo });
}

export async function minePrs(ctx, slug, { before, after, again, limit = 20, model, dry, fixes = false, git = false, repo = process.cwd(), phase = 'maintenance', directories = null } = {}) {
  const { flags, store, out } = ctx;
  // --git: commits from git history although GitHub is reachable (a repository whose work lands by
  // direct commits has few pull requests to mine; its fix commits are what review wants)
  const useGit = git || !slug || !hasBin('gh');
  const recSlug = slug || 'local';
  const scopeKey = directories ? projectRecordKey(recSlug, directories) : recSlug;
  const rec = minedPrs(store, scopeKey);
  if (directories) for (const id of minedPrs(store, recSlug).mined) rec.mined.add(id);
  const fetchLimit = Math.min(Math.max(limit * 3, 60), 250);
  const listFn = useGit ? (s, o) => listMergedCommits(repo, { ...o, directories }) : listMergedPrs;

  // without a window: what was merged since the last run, then further back; never a PR mined before
  const listed = before || after
    ? listFn(slug, { before: before || new Date().toISOString(), after, limit: fetchLimit }).filter(p => again || (!rec.mined.has(p.number) && (!p.hash || !rec.mined.has(p.hash.slice(0, 8)))))
    : nextPrs(slug, rec, { limit: fetchLimit, list: listFn, repo });
  if (!listed.length) {
    const sourceName = useGit ? 'git history' : `merged PRs of ${slug}`;
    out(`no ${sourceName} left to mine (${rec.mined.size} mined so far)`);
    return { tokens: 0, saved: 0 };
  }
  const failed = new Set();
  const scoped = listed.filter(p => !directories || (p.files || []).some(f => includesPath(directories, typeof f === 'string' ? f : f.path || '')));
  const filtered = scoped
    .filter(p => !/^(chore|deps|docs|revert|ci|build|test)\b|\bbump\b|dependabot|renovate|snapshot/i.test(p.title) &&
      (fixes || FIX_LIKE.test(p.title) || (p.body || '').length > (useGit ? 10 : 120)) && p.additions <= 800 && p.additions >= 3); // a fix's subject is its record; most have no body
  let candidates = filtered.length ? filtered : scoped.filter(p => !/^(chore|deps|bump)\b/i.test(p.title) && p.additions <= 1000 && p.additions >= 1);
  // --fixes: only changes whose message says they fix something (git history has no labels; a repository
  // developed by direct commits has no pull requests to mine, and its fix commits are what review wants)
  if (fixes) candidates = candidates.filter(p => FIX_LIKE.test(`${p.title}\n${(p.body || '').slice(0, 400)}`));
  if (directories) out(`        ${scoped.length}/${listed.length} scanned changes touch project directories; later runs continue scanning older history.`);
  const prs = pickPrs(candidates, limit);
  const deferred = new Set(candidates.filter(p => !prs.includes(p)).map(p => p.number)); // candidates beyond this run's limit wait for the next one
  out(`        Reviewing ${prs.length} changes ${useGit ? 'from git history' : `from ${slug}`}. Changes with no reusable notes are normal.`);
  const progress = batchProgress({ dir: store.dir, name: 'PR mining', total: prs.length, out, verbose: Boolean(flags.verbose) });
  let tokens = 0, saved = 0;
  for (const pr of prs) {
    const refId = pr.prNumber ? `${recSlug}#${pr.prNumber}` : `${recSlug}#${pr.hash ? pr.hash.slice(0, 8) : pr.number}`;
    progress.start(pr.hash ? `commit ${pr.hash.slice(0, 8)}` : `PR #${pr.number}`);
    try {
      const accounting = { store, phase, pr: pr.number, dry: !!dry };
      const catalog = await selectLearningNotes(store, { title: pr.title, description: (pr.body || '').slice(0, 5000), files: (pr.files || []).slice(0, 100) }, { max: 12, accounting });
      if (catalog.status === 'unavailable') throw new Error(`note catalog unavailable: ${catalog.reason}`);
      if (phase !== 'init' && !withinDailyCap(store).ok) throw new Error('daily learning token cap reached; PR will retry');
      const r = await distillPr(slug, pr, { model: model || store.config().distillModel || 'sonnet', repo, existing: catalog.notes || [], accounting: { ...accounting, purpose: 'mine-prs' } });
      tokens += r.tokens || 0;
      if (dry) { out(`${oneLine(refId)} ${oneLine(pr.title).slice(0, 60)} → ${r.notes.map(n => n.kind).join(',') || 'no reusable notes'}`); progress.complete({ proposed: r.notes }); continue; }
      const source = { type: 'pr', ref: refId };
      // Persist incompleteness before any note can be saved: a process interruption
      // must not let legacy note-source inference turn a partial PR into a success.
      recordMinedPrs(store, scopeKey, [], { failed: [pr] });
      if (directories) recordMinedPrs(store, recSlug, [], { failed: [pr] });
      let prepared = await prepareNotes(store, r.notes, { evidence: r.evidence, source, kinds: distillKinds(store), accounting, repair: true });
      const s2 = saveNotes(store, prepared.notes, { source, kinds: distillKinds(store), reconciled: prepared.reconciled });
      s2.skipped.push(...prepared.skipped);
      // One bounded revision of new discoveries, using the exact same PR evidence/model: unsupported
      // claims to drop, and extensions to merge or keep separate (note-learning.js carries the target
      // in the diagnostics). Never retry an unavailable judge as a content repair or rewrite an
      // existing note to resolve a contradiction. No revised claim bypasses grounding/reconciliation.
      const repairable = prepared.deferred.filter(d => d.status === 'uncertain' && d.diagnostics);
      if (repairable.length && (phase === 'init' || withinDailyCap(store).ok)) {
        try {
          const revised = await distillPr(slug, pr, { model: model || store.config().distillModel || 'sonnet', repo,
            existing: store.list(), repair: { evidence: r.evidence, findings: repairable },
            accounting: { ...accounting, purpose: 'mine-prs-repair' } });
          tokens += revised.tokens || 0;
          const checked = await prepareNotes(store, revised.notes, { evidence: r.evidence, source, kinds: distillKinds(store), accounting, repair: true, repaired: true });
          const savedRevision = saveNotes(store, checked.notes, { source, kinds: distillKinds(store), reconciled: checked.reconciled });
          s2.saved.push(...savedRevision.saved); s2.merged.push(...savedRevision.merged);
          s2.skipped.push(...checked.skipped, ...savedRevision.skipped);
          s2.deferred.push(...(savedRevision.deferred || []));
          s2.retryable ||= savedRevision.retryable;
          // An unavailable recheck remains retryable even if other notes were saved.
          prepared = { ...prepared, deferred: [...prepared.deferred.filter(d => !repairable.includes(d)), ...checked.deferred],
            retryable: prepared.retryable || checked.retryable };
          store.log({ op: 'mine-prs-repair', pr: pr.number, proposed: revised.notes.length,
            saved: savedRevision.saved.length + savedRevision.merged.length, deferred: checked.deferred.length,
            metered: true, phase });
        } catch (error) {
          failed.add(pr.number);
          store.log({ op: 'mine-prs-repair', pr: pr.number, failed: true, error: String(error.message).slice(0, 300), phase });
        }
      }
      const pending = deferLearning(store, [...prepared.deferred, ...(s2.deferred || [])], { source, evidenceRef: pr.url || refId });
      if (pending.length) out(`        Deferred ${pending.length} findings: ${path.join(store.dir, 'state', 'learning-pending')}`);
      if (prepared.retryable || s2.retryable) failed.add(pr.number);
      saved += s2.saved.length + s2.merged.length;
      progress.complete({ ref: refId, title: pr.title, ...(failed.has(pr.number) ? { error: 'PR learning incomplete; failed checks remain retryable' } : {}), deferred: pending.length, notes: [...s2.saved, ...s2.merged].map(n => n.id), skipped: s2.skipped.length });
    } catch (e) { failed.add(pr.number); progress.complete({ ref: refId, title: pr.title, error: e.message }); }
  }
  // PRs the filter passed over are recorded too; failed ones and candidates deferred by the limit are not, so the next run takes them again
  if (!dry) {
    const completed = listed.filter(p => !failed.has(p.number) && !deferred.has(p.number));
    recordMinedPrs(store, scopeKey, completed, { failed: prs.filter(p => failed.has(p.number)) });
    if (directories) recordMinedPrs(store, recSlug, prs.filter(p => !failed.has(p.number)), { failed: prs.filter(p => failed.has(p.number)) });
    store.log({ op: 'mine-prs', slug: recSlug, directories, prs: prs.length - failed.size, passed: listed.length - prs.length - deferred.size, deferred: deferred.size, saved, tokens, metered: true, source: useGit ? 'git' : 'github' });
  }
  progress.finish({ tokens, retry: 'Failed changes remain unmarked. Retry with: thinker mine-prs' });
  return { tokens, saved, failed: failed.size, processed: prs.length };
}

export const commands = {
  'learn': learnCommand,
  'maintain': maintainCommand,
  'distill': distillCommand,
  'record': recordCommand,
  'outcome': outcomeCommand,
  'verify': verifyCommand,
  'check': checkCommand,
  'seed': seedCommand,
  'mine-prs': minePrsCommand,
};
