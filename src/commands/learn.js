// Learning from sessions, by hand and from the hooks: a session read into the profile (distill, learn, record),
// one maintenance run, and the desktop app's queued work. The helpers take the dispatcher's context (cli.js) as
// their first argument. The note-writing path, verification, and the pull-request and code mining Artemis built
// benchmark caches with went with the knowledge notes on 2026-11-08.
import fs from 'node:fs';
import path from 'node:path';
import { maintain, renderMaintain, withinDailyCap, reportCapped } from '../maintain.js';
import { formatTokens } from '../model-usage.js';
import { batchProgress } from '../progress.js';
import { parseTranscript, recordEvent, traceFile, toolName, toolInput, hydrate, findSessions, transcriptsFor } from '../transcripts.js';
import { enqueueJob, recentAppSession, runSessionWork } from '../session-work.js';
import { isWorkerPrompt } from '../session-llm.js';
import { profileSession, exchanges } from '../profile.js';

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
  await distillFile(ctx, file, { dry: !!flags.dry, quiet: !!flags.quiet, incremental: !!flags.incremental, batch: !!flags.batch, format: flags.format, session: typeof flags.session === 'string' ? flags.session : undefined });
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

// One maintenance run.
export async function runMaintain(ctx, { quiet, dry }) {
  const { repo, store, out, NO_LEARN } = ctx;
  if (NO_LEARN) { if (!quiet) out('maintenance is switched off (THINKER_NO_LEARN)'); return; }
  if (!store.exists()) return;
  const r = await maintain(store, repo, { dry });
  // the Context tab's report made again while nobody waits for it (context-snapshot.js); no model call
  if (!dry && !r.skipped && process.env.THINKER_TEST !== '1') { try { (await import('../context-snapshot.js')).refreshSnapshots(store); } catch {} }
  if (!quiet || (process.env.THINKER_LLM === 'session' && r.errors)) out(renderMaintain(r));
  if (process.env.THINKER_LLM === 'session' && r.errors) process.exitCode = 1;
}

// Catch-up learning: works without any end-of-session hook, so it covers
// agents and modes that do not fire one (Cursor's headless mode, for one).
export async function learn(ctx, { days, idleMin, max, dry, quiet }) {
  const { repo, store, out, sessionLearning, NO_LEARN } = ctx;
  if (NO_LEARN) { if (!quiet) out('learning is switched off (THINKER_NO_LEARN)'); return; }
  if (!sessionLearning()) { if (!quiet) out('learning from sessions is off (learn.sessions in .thinker/config.json); maintenance goes on'); return; }
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
    const progress = pending.length ? batchProgress({ dir: store.dir, name: 'Reading sessions', total: pending.length, out, silent: true }) : null;
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
        try { await distillFile(ctx, s.file, { quiet, incremental: true, session: s.session }); done++; progress.complete({ item: s.session }); }
        catch (e) { failed++; progress.complete({ item: s.session, error: e.message }); if (!quiet || process.env.THINKER_LLM === 'session') out(`  failed: ${String(e.message).slice(0, 160)}`); }
      }
    } finally { progress?.finish(); }
    if (!quiet) out(`learned from ${done} of ${sessions.length} sessions`);
    return { done, failed };
  } finally { if (!dry) fs.rmSync(lock, { force: true }); }
}

// One session read into the profile's ledger (profile.js), from its prompts and answers alone. An exchange's
// outcome is the prompt after it, so a turn-end `--batch` waits for the session's end or the catch-up over quiet
// sessions. `incremental` reads from the line the last read stopped at and marks the lines read.
export async function distillFile(ctx, file, { dry, quiet, incremental, batch, format, session, phase = 'learning', completeFn } = {}) {
  const { repo, store, out } = ctx;
  const stateDir = path.join(store.dir, 'state');
  const stateFile = path.join(stateDir, path.basename(file).replace(/\.jsonl?$/, '') + '.json');
  let state = {}; try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  const fromLine = incremental ? (state.line || 0) : 0;
  const { events, lineCount, format: fmt } = parseTranscript(file, { fromLine, format });
  hydrate(events, repo, { trace: session ? traceFile(store.dir, session) : null });
  if (batch) { if (!quiet) out('a session is read whole when it ends'); return; }
  if (events.some(e => e.t === 'prompt' && isWorkerPrompt(e.text))) return;
  // a turn-end hook and a session-end hook can both ask for the same session
  const lock = stateFile + '.lock';
  if (incremental && !dry) {
    try { if (Date.now() - fs.statSync(lock).mtimeMs < 10 * 60_000) return; } catch {}
    fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(lock, String(process.pid));
  }
  try {
    if (!events.some(e => e.t === 'prompt') || !events.some(e => e.t === 'say')) { if (!quiet) out('nothing new said in the session; nothing to read into the profile'); }
    else {
      if (dry) { out(JSON.stringify({ exchanges: exchanges(events).length, fromLine }, null, 2)); return; }
      if (phase !== 'init' && !withinDailyCap(store).ok) throw new Error('daily learning token cap reached; session will retry');
      const r = await profileSession(store, events, { session: session || path.basename(file).replace(/\.jsonl?$/, ''), client: fmt === 'agy' ? 'gemini' : fmt === 'events' ? 'trace' : fmt, repoHint: repo, fromLine, lineCount, accounting: { phase, transcript: path.basename(file) }, completeFn });
      if (!quiet) { for (const o of r.observations) out(`observed ${o.kind.padEnd(13)} ${o.outcome.padEnd(10)} ${o.request}`); out(`read ${r.exchanges} exchanges → ${r.observations.length} observations${r.compiled ? '; profile compiled' : ''}${r.tokens ? `; ~${formatTokens(r.tokens)} tokens` : ''}`); }
    }
    if (incremental && !dry) { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify({ ...state, line: lineCount, at: new Date().toISOString() })); }
  } finally { if (incremental && !dry) fs.rmSync(lock, { force: true }); }
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
};
