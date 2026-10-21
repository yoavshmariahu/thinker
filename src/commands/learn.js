import { projectFromFlags, includesPath, projectRecordKey } from '../project.js';
import { learningPlan } from '../learning-evidence.js';
import { deferLearning, safeLearningAssessments, takeContradictions } from '../learning-pending.js';
// The learning loop by hand and from the hooks: distilling sessions (distill, learn, record), one
// maintenance run, verification, and mining merged pull requests (mine-prs, and understand: reading the code).
// The last two are kept for Artemis's benchmark caches only (src/commands/external.js): no product path runs
// them since 2026-10-21, and the help does not list them. The helpers take the dispatcher's context (cli.js) as their first argument.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { condense, parseTranscript, exploreCount, batchDue, distillEvents, saveNotes, transcriptsFor, injectedIds, relatedNotes, sessionStakes, QUIET_MIN_EXPLORE } from '../distill.js';
import { provider, DEFAULT_DISTILL_MODEL } from '../llm.js';
import { maintain, renderMaintain, withinDailyCap, reportCapped } from '../maintain.js';
import { formatTokens } from '../model-usage.js';
import { refresh, attest, outcome, distillKinds } from '../ops.js';
import { scanSkills, skillsInvoked, skillNotesFor } from '../skills.js';
import { batchProgress, oneLine } from '../progress.js';
import { listMergedPrs, listMergedCommits, listMergedChanges, commitsOn, distillPr, minedPrs, recordMinedPrs, nextPrs, pickPrs, mineable } from '../prs.js';
import { recordEvent, traceFile, toolName, toolInput, hydrate, findSessions } from '../transcripts.js';
import { sessionKey } from '../usage.js';
import { githubSlug, hasBin, verifyAll } from './shared.js';
import { understand, UNDERSTAND_DEFAULTS } from '../understand.js';
import { areasConfig } from '../areas.js';
import { enqueueJob, recentAppSession, runSessionWork } from '../session-work.js';
import { isWorkerPrompt } from '../session-llm.js';
import { skillSuggestOn, recordSessionSkills } from '../skill-suggest.js';
import { skillOutcomeOn, skillOutcomeCheck } from '../skill-outcome.js';
import { instructionValueCheck, valueConfig } from '../instruction-value.js';

async function learnCommand(ctx) {
  const { flags } = ctx;
  const result = await learn(ctx, { days: Number(flags.days) || 14, idleMin: flags['idle-min'] === undefined ? 2 : Number(flags['idle-min']), max: Number(flags.max) || 50, dry: !!flags.dry, quiet: !!flags.quiet });
  // A queued job must not acknowledge a batch whose per-session errors were caught below.
  if (process.env.THINKER_LLM === 'session' && result?.failed) process.exitCode = 1;
  if (flags.maintain) await runMaintain(ctx, { quiet: !!flags.quiet, dry: !!flags.dry });
  return;
}

async function maintainCommand(ctx) {
  const { flags, store, out } = ctx;
  // A repository worked in a desktop app runs no agent CLI (app-host.js): maintenance a commit starts there
  // waits for the app's own session instead (session-work.js), unless this run is that session's.
  const app = !flags.dry && process.env.THINKER_LLM !== 'session' ? recentAppSession(store) : null;
  if (app) { enqueueJob(store, 'maintain', ['maintain', '--quiet', '--repo', ctx.repo]); if (!flags.quiet) out(`maintenance queued for the next session in ${app}`); return; }
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

async function minePrsCommand(ctx) {
  const { pos, flags, repo } = ctx;
  // thinker mine-prs [owner/repo] [--limit n] [--dry]; a window by hand: --before <iso> [--after <iso>] [--again],
  // or --from <commit>: the newest --limit changes worth distilling in the git history that ends at that commit
  // --paths a,b [--paths-limit n] with --from: the history of those files first, then the newest changes
  const paths = typeof flags.paths === 'string' ? flags.paths.split(',').map(s => s.trim()).filter(Boolean) : null;
  await mineMore(ctx, { slug: pos[0], from: typeof flags.from === 'string' ? flags.from : undefined, scan: Number(flags.scan) || undefined, before: flags.before, after: flags.after, again: !!flags.again, limit: Number(flags.limit) || (flags.before || flags.after ? 60 : 20), model: flags.model, dry: !!flags.dry, fixes: !!flags.fixes, git: !!flags.git, direct: !!flags.direct, paths, pathsLimit: Number(flags['paths-limit']) || null });
  return;
}

// thinker understand [--top n] [--areas a,b | --all] [--model m] [--dry]: notes on how the most changed code
// works now (src/understand.js). In the person's focus areas when they are set, else (or with --all) the whole repository.
async function understandCommand(ctx) {
  const { flags, store, out } = ctx;
  const areas = typeof flags.areas === 'string' ? flags.areas.split(',').map(s => s.trim()).filter(Boolean) : flags.all ? [] : (areasConfig(store).directories || []);
  if (flags.whole && !areas.length) { out('--whole reads every code file of the directories named with --areas'); process.exitCode = 2; return; }
  const r = await understand(store, { top: Number(flags.top) || UNDERSTAND_DEFAULTS.top, areas, whole: !!flags.whole, maxCode: Number(flags['max-code']) || 0, batch: Number(flags.batch) || undefined, style: typeof flags.style === 'string' ? flags.style : 'default', model: typeof flags.model === 'string' ? flags.model : undefined, dry: !!flags.dry,
    onProgress: (d, n, part) => out(`${part ? part + ': ' : ''}${d}/${n} processed`) });
  const where = areas.length ? `in ${areas.join(', ')}` : 'repository-wide';
  if (flags.dry) { out(`${r.files.length} files ${where}, ${r.calls} calls, about ${Math.round(r.codeTokens / 1000)}k tokens of code`); for (const f of r.files) out('  ' + f); return; }
  out(`${r.files} files ${where} · ${r.calls} calls · ${r.notes} notes saved${r.failed ? ` · ${r.failed} failed` : ''} · ${r.views} instance views`);
  if (r.failed && r.failed / r.calls > 0.2) process.exitCode = 1;
}

// One maintenance run.
export async function runMaintain(ctx, { quiet, dry }) {
  const { repo, store, out, NO_LEARN } = ctx;
  if (NO_LEARN) { if (!quiet) out('maintenance is switched off (THINKER_NO_LEARN)'); return; }
  if (!store.exists()) return;
  const r = await maintain(store, repo, { dry, fns: {
    docs: provider() ? async ({ limit }) => (await import('../behavior-docs.js')).deriveDocBehaviors(store, { limit, phase: 'maintenance' }) : undefined,
    skills: provider() ? ({ limit }) => scanSkills(store, { limit, phase: 'maintenance' }) : undefined,
  } });
  if (!quiet || (process.env.THINKER_LLM === 'session' && r.errors)) out(renderMaintain(r));
  if (process.env.THINKER_LLM === 'session' && r.errors) process.exitCode = 1;
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
    // the sessions with something new to read, so the progress file (activity.js) counts what this run will do
    const pending = [];
    for (const s of sessions) {
      let state = {}; try { state = JSON.parse(fs.readFileSync(path.join(store.dir, 'state', path.basename(s.file).replace(/\.jsonl?$/, '') + '.json'), 'utf8')); } catch {}
      let total = 0; try { total = parseTranscript(s.file).lineCount; } catch { continue; }
      if ((state.line || 0) >= total) continue;
      pending.push({ ...s, newLines: total - (state.line || 0) });
      if (pending.length >= max) break;
    }
    let done = 0, failed = 0;
    if (dry) { for (const s of pending) out(`${s.client.padEnd(7)} ${s.session}  ${s.newLines} new lines`); return; }
    const progress = pending.length ? batchProgress({ dir: store.dir, name: 'Distilling sessions', total: pending.length, out, silent: true }) : null;
    try {
      for (const s of pending) {
        const cap = withinDailyCap(store);
        if (!cap.ok) {
          store.log({ op: 'distill-skipped', reason: 'dailyTokens', spent: cap.spent, cap: cap.cap, left: pending.length - done });
          reportCapped(store, cap);
          failed = pending.length - done;
          if (!quiet) out(`stopping: ${formatTokens(cap.spent)} of the ${formatTokens(cap.cap)} tokens learning may use a day are used (maintain.dailyTokens in .thinker/config.json)`);
          break;
        }
        if (!quiet) out(`${s.client} ${s.session}`);
        progress.start(`${s.client} ${s.session}`);
        process.env.THINKER_LLM_PREFER = s.client;
        try { await distillFile(ctx, s.file, { minExplore: 3, quiet, incremental: true, session: s.session }); done++; progress.complete({ item: s.session }); }
        catch (e) { failed++; progress.complete({ item: s.session, error: e.message }); if (!quiet || process.env.THINKER_LLM === 'session') out(`  failed: ${String(e.message).slice(0, 160)}`); }
      }
    } finally { progress?.finish(); }
    if (!quiet) out(`learned from ${done} of ${sessions.length} sessions`);
    return { done, failed };
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
  const markSeen = () => { if (incremental && !batch && !dry) { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify({ ...state, line: lineCount, at: new Date().toISOString() })); } };
  if (events.some(e => e.t === 'prompt' && isWorkerPrompt(e.text))) { markSeen(); return; }
  // the skills the session opened for the files it edited (skill-suggest.js; off unless harness.skillSuggest):
  // no model call, credited once per session whatever the distillation below decides
  if (!batch && !dry && skillSuggestOn(store)) { try { recordSessionSkills(store, file, { session }); } catch {} }
  // on a sample of sessions, which rules of those skills the change broke, and whether the skill was read
  // (skill-outcome.js; its own switch, off by default): one model call, through the session in a desktop app
  if (!batch && !dry && skillOutcomeOn(store)) { try { await skillOutcomeCheck(store, file, { session, phase }); } catch (e) { store.log({ op: 'skill-outcome', session, failed: String(e.message || e).slice(0, 160) }); } }
  // on a sample of sessions, which sections of the instruction file bore on the work and whether the agent followed
  // them (instruction-value.js; off by default): one model call, through the session in a desktop app
  if (!batch && !dry && valueConfig(store).judge) { try { await instructionValueCheck(store, file, { session, phase }); } catch (e) { store.log({ op: 'instruction-value', session, failed: String(e.message || e).slice(0, 160) }); } }
  const n = exploreCount(events);
  if (n < minExplore && !(incremental && sessionStakes(events).any)) { markSeen(); if (!quiet) out(`only ${n} exploration calls since last distill (<${minExplore}); nothing to distill`); return; }
  if (!events.some(e => e.t === 'say')) { markSeen(); if (!quiet) out('the session has no answer from the agent yet; nothing to distill'); return; }
  // notes served in this session: named in the transcript, in the hook-recorded trace (Cursor's native
  // transcript omits tool outputs, including MCP orient/lookup replies), or recorded on the note when a hook served it
  const trace = session ? traceFile(store.dir, session) : null;
  const ids = new Set(injectedIds(file, { fromLine }));
  if (trace && trace !== file && fs.existsSync(trace)) for (const id of injectedIds(trace)) ids.add(id);
  if (session) for (const n of store.list()) if ((n.servedIn || []).includes(session)) ids.add(n.id);
  let served = [...ids].filter(id => !(incremental && (state.assessed || []).includes(id))).map(id => store.get(id)).filter(Boolean);
  // the skills the agent invoked are assessed like injected notes (skills.js): the card, with an excerpt of the file
  let sessionEnd = null; try { sessionEnd = fs.statSync(file).mtimeMs; } catch {}
  for (const n of skillNotesFor(store, skillsInvoked(events), { sessionEnd })) if (!ids.has(n.id) && !(incremental && (state.assessed || []).includes(n.id))) served.push(n);
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
  plan = plan || { mode: 'full', served, discover: true, trace: condense(events) };
  // the kinds worth a note here: what is served, and the archived kinds still worth distilling (ops.js:distillKinds)
  const kinds = distillKinds(store);
  // the notes resting on the files the session touched, and up to four on the topic of its requests
  const existing = relatedNotes(store, events, { max: 12 });
  if (phase !== 'init' && !withinDailyCap(store).ok) throw new Error('daily learning token cap reached; session will retry');
  const r = await distillEvents(events, { model: model || store.config().distillModel || DEFAULT_DISTILL_MODEL, repoHint: repo, served, existing, kinds, evidence: plan.trace, discover: plan.discover, compact: plan.compact ?? !['audit', 'full'].includes(plan.mode), accounting: { ...accounting, purpose: 'distill', traceEvents: events.length, learningMode: plan.mode, evidenceChars: plan.trace.length } });
  if (dry) { failed = false; out(JSON.stringify({ notes: r.notes, assessments: r.assessments }, null, 2)); out(`(${r.notes.length} notes, ${r.tokens == null ? 'tokens not reported' : '~' + formatTokens(r.tokens) + ' tokens'}, trace ${r.traceChars} chars)`); return; }
  const source = { type: 'agent', ref: path.basename(file, '.jsonl') };
  const s = saveNotes(store, r.notes, { source, kinds });
  const assessments = safeLearningAssessments(store, r.assessments, served);
  const pending = deferLearning(store, assessments.deferred, { source, evidenceRef: path.resolve(file) });
  // the contradicted notes leave serving now and are verified first by the next maintenance
  if (pending.length) { const t = takeContradictions(store); if (t.marked.length && !quiet) out(`${t.marked.length} contradicted note${t.marked.length === 1 ? '' : 's'} held back until maintenance verifies ${t.marked.length === 1 ? 'it' : 'them'}`); }
  // under the session's id, which is what servings are logged under: a transcript's file name is
  // that id only for Claude Code (Codex adds a date, a recorded trace a prefix, Gemini another suffix)
  // with the session's model, so the reading its confirmed notes saved can be priced (usage.js)
  const applied = attest(store, assessments.accepted, { session: session || sessionKey(path.basename(file)), client: fmt === 'agy' ? 'gemini' : fmt === 'events' ? 'trace' : fmt, model: sessionModel });
  if (!quiet) for (const a of applied) out(`attest  ${a.verdict.padEnd(12)} ${a.id} → c=${Math.round(a.confidence * 100)}%`);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ line: lineCount, assessed: [...new Set([...(state.assessed || []), ...applied.map(n => n.id)])], at: new Date().toISOString() }));
  store.log({ op: 'distill', transcript: path.basename(file), explore: n, saved: s.saved.map(x => x.id), merged: s.merged.map(x => x.id), skipped: s.skipped, deferred: pending.length, contradicted: assessments.deferred.filter(d => d.assessment?.verdict === 'contradicted').map(d => d.assessment.id), cost: r.cost, metered: true, phase, learningMode: plan?.mode || 'full', traceChars: r.traceChars });
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

export async function minePrs(ctx, slug, { from, scan, before, after, again, limit = 20, model, dry, fixes = false, git = false, direct = false, repo = process.cwd(), phase = 'maintenance', directories = null, concurrency = 4, paths = null, pathsLimit = null, pathsScan = null, pathsOnly = false, onProgress = null, distillPrFn = distillPr } = {}) {
  const { flags, store, out } = ctx;
  // --git: commits from git history although GitHub is reachable (a repository whose work lands by
  // direct commits has few pull requests to mine; its fix commits are what review wants)
  const useGit = git || !!from || !slug || !hasBin('gh');
  if (from) {
    try { execFileSync('git', ['rev-parse', '--verify', '--quiet', `${from}^{commit}`], { cwd: repo, stdio: 'ignore' }); }
    catch { out(`❌ --from ${from}: not a commit in this repository`); process.exitCode = 1; return { tokens: 0, saved: 0 }; }
  }
  const recSlug = slug || 'local';
  const scopeKey = directories ? projectRecordKey(recSlug, directories) : recSlug;
  const rec = minedPrs(store, scopeKey);
  if (directories) for (const id of minedPrs(store, recSlug).mined) rec.mined.add(id);
  const fetchLimit = Math.min(Math.max(limit * 3, 60), 250);
  // --direct: only the commits that name no pull request (commits-offer.js: the ones a PR-only warm-up never read)
  const listFn = direct ? (s, o) => listMergedCommits(repo, { ...o, directories, directOnly: true })
    : useGit ? (s, o) => listMergedCommits(repo, { ...o, directories })
    : commitsOn(store.config().mining) ? listMergedChanges(repo, { directories }) : listMergedPrs;

  // without a window: what was merged since the last run, then further back; never a PR mined before
  const fresh = p => again || (!rec.mined.has(p.number) && (!p.hash || !rec.mined.has(p.hash.slice(0, 8))));
  // --from scans three times the limit and no further (--scan n: another depth): a recent cache as of
  // that commit, not a search for older fixes
  // --paths: the history of those files first (--paths-limit of the --limit, half by default), scanned
  // three times as deep among the changes touching them (pathsScan: another depth), then the newest
  // changes overall fill the rest (pathsOnly: nothing fills it; a focus area's walk, maintain.js)
  let targeted = [], history = null;
  if (from && paths?.length) {
    const want = Math.min(Math.max(1, pathsLimit || Math.ceil(limit / 2)), limit);
    const scanLimit = pathsScan || want * 3;
    const scanned = listMergedCommits(repo, { from, limit: scanLimit, directories, paths, strict: pathsOnly });
    const candidates = mineable(scanned.filter(fresh), { fixes, git: useGit });
    targeted = candidates.slice(0, want);
    if (pathsOnly) history = { scanned: scanned.length, exhausted: scanned.length < scanLimit && candidates.length <= want };
  }
  const targetedHashes = new Set(targeted.map(p => p.hash));
  const listed = from && pathsOnly ? [] : from ? listMergedCommits(repo, { from, limit: scan || limit * 3, directories }).filter(fresh).filter(p => !targetedHashes.has(p.hash)) : before || after
    ? listFn(slug, { before: before || new Date().toISOString(), after, limit: fetchLimit }).filter(p => again || (!rec.mined.has(p.number) && (!p.hash || !rec.mined.has(p.hash.slice(0, 8)))))
    : nextPrs(slug, rec, { limit: fetchLimit, list: listFn, repo });
  if (!listed.length && !targeted.length) {
    const sourceName = useGit ? 'git history' : `merged PRs of ${slug}`;
    out(`${history && !history.exhausted ? 'no unmined changes in this history window' : `no ${sourceName} left to mine`} (${rec.mined.size} mined so far)`);
    return { tokens: 0, saved: 0, processed: 0, completed: 0, ...history };
  }
  const failed = new Set();
  const scoped = listed.filter(p => !directories || (p.files || []).some(f => includesPath(directories, typeof f === 'string' ? f : f.path || '')));
  const candidates = mineable(scoped, { fixes, git: useGit });
  if (directories) out(`        ${scoped.length}/${listed.length} scanned changes touch project directories; later runs continue scanning older history.`);
  // --from: the newest changes worth distilling at that commit, in order; no ranking chooses among them
  const prs = from ? [...targeted, ...candidates.slice(0, Math.max(0, limit - targeted.length))] : pickPrs(candidates, limit);
  if (targeted.length) out(`        ${targeted.length} of them touched ${paths.length === 1 ? paths[0] : `${paths.length} given files`}.`);
  const deferred = new Set(candidates.filter(p => !prs.includes(p)).map(p => p.number)); // candidates beyond this run's limit wait for the next one
  out(`        Reviewing ${prs.length} changes ${useGit ? 'from git history' : `from ${slug}`}. Changes with no reusable notes are normal.`);
  const progress = batchProgress({ dir: store.dir, name: 'PR mining', total: prs.length, out, verbose: Boolean(flags.verbose), onProgress });
  let tokens = 0, saved = 0;
  // a few changes at once: each is one independent model call, and a setup run mines dozens
  const queue = [...prs];
  const mineOne = async pr => {
    const refId = pr.prNumber ? `${recSlug}#${pr.prNumber}` : `${recSlug}#${pr.hash ? pr.hash.slice(0, 8) : pr.number}`;
    const item = pr.hash ? `commit ${pr.hash.slice(0, 8)}` : `PR #${pr.number}`;
    progress.start(item);
    try {
      const accounting = { store, phase, pr: pr.number, dry: !!dry };
      if (phase !== 'init' && !withinDailyCap(store).ok) throw new Error('daily learning token cap reached; PR will retry');
      // the notes already resting on the files the change touched, shown as context rather than evidence
      const touched = new Set((pr.files || []).map(f => typeof f === 'string' ? f : f.path)); // git lists paths, GitHub objects
      const existing = store.list().filter(n => n.status !== 'invalid' && (n.deps || []).some(d => touched.has(d.path))).slice(0, 12);
      const r = await distillPrFn(slug, pr, { model: model || store.config().distillModel || DEFAULT_DISTILL_MODEL, repo, existing, accounting: { ...accounting, purpose: 'mine-prs' } });
      tokens += r.tokens || 0;
      if (dry) { out(`${oneLine(refId)} ${oneLine(pr.title).slice(0, 60)} → ${r.notes.map(n => n.kind).join(',') || 'no reusable notes'}`); progress.complete({ item, proposed: r.notes }); return; }
      const source = { type: 'pr', ref: refId };
      // Persist incompleteness before any note can be saved: a process interruption
      // must not let legacy note-source inference turn a partial PR into a success.
      recordMinedPrs(store, scopeKey, [], { failed: [pr] });
      if (directories) recordMinedPrs(store, recSlug, [], { failed: [pr] });
      const s2 = saveNotes(store, r.notes, { source, kinds: distillKinds(store) });
      saved += s2.saved.length + s2.merged.length;
      // mined as soon as its notes are saved, so an interrupted run does not pay for this change again
      recordMinedPrs(store, scopeKey, [pr]);
      if (directories) recordMinedPrs(store, recSlug, [pr]);
      progress.complete({ item, ref: refId, title: pr.title, notes: [...s2.saved, ...s2.merged].map(n => n.id), skipped: s2.skipped.length });
    } catch (e) { failed.add(pr.number); progress.complete({ item, ref: refId, title: pr.title, error: e.message }); }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, prs.length)) }, async () => { while (queue.length) await mineOne(queue.shift()); }));
  // PRs the filter passed over are recorded too; failed ones and candidates deferred by the limit are not, so the next run takes them again
  if (!dry) {
    const completed = listed.filter(p => !failed.has(p.number) && !deferred.has(p.number));
    recordMinedPrs(store, scopeKey, completed, { failed: prs.filter(p => failed.has(p.number)) });
    if (directories) recordMinedPrs(store, recSlug, prs.filter(p => !failed.has(p.number)), { failed: prs.filter(p => failed.has(p.number)) });
    store.log({ op: 'mine-prs', slug: recSlug, directories, prs: prs.length - failed.size, passed: listed.length - (prs.length - targeted.length) - deferred.size, deferred: deferred.size, saved, tokens, metered: true, source: useGit ? 'git' : 'github', ...(targeted.length ? { targeted: targeted.length, paths } : {}) });
  }
  progress.finish({ tokens, retry: 'Failed changes remain unmarked. Retry with: thinker mine-prs' });
  return { tokens, saved, failed: failed.size, processed: prs.length, completed: prs.length - failed.size,
    ...(history ? { ...history, exhausted: history.exhausted && !failed.size } : {}) };
}

// `thinker session-work`: queued learning of a desktop-app session, run with the session provider (session-work.js)
async function sessionWorkCommand(ctx) {
  const { store, HERE, out } = ctx;
  if (process.env.THINKER_LLM !== 'session') { out('session-work runs only as started by an app session\'s prompt hook'); process.exitCode = 2; return; }
  out(`${runSessionWork(store, { cli: path.join(HERE, 'cli.js'), out })} jobs run`);
}

export const commands = {
  'session-work': sessionWorkCommand,
  'learn': learnCommand,
  'maintain': maintainCommand,
  'distill': distillCommand,
  'record': recordCommand,
  'outcome': outcomeCommand,
  'verify': verifyCommand,
  'check': checkCommand,
  'mine-prs': minePrsCommand,
  'understand': understandCommand,
};
