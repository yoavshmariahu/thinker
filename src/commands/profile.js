// thinker profile: the session profile by hand (profile.js). `show` prints what a session would be shown,
// `extract` reads one transcript into the ledger, `rebuild` reads the window's sessions and compiles,
// `compile` compiles what is new (`--full`: the whole window again), `ledger` lists the observations, `holdout` the two arms.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { listPrice } from '../prices.js';
import { PROFILE, SECTIONS, profileConfig, profileHoldoutRate, readProfile, readLedger, renderProfile, extracted, compileProfile, compileDue, profileSession, exchanges, profileModels, holdoutReport } from '../profile.js';
import { readLog } from '../usage.js';
import { parseTranscript, hydrate, findSessions, traceFile } from '../transcripts.js';
import { withinDailyCap, reportCapped } from '../maintain.js';
import { formatTokens } from '../model-usage.js';
import { isWorkerPrompt } from '../session-llm.js';
import { batchProgress } from '../progress.js';

// The cache is the main checkout's and so is the profile, so a rebuild reads the sessions of every worktree of
// the repository (each has a transcript folder of its own), then the hook-recorded traces of sessions none of them
// has a transcript for.
export function repoSessions(store, { sinceMs }) {
  const roots = new Set([store.repo, store.home]);
  try { for (const l of execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: store.home, stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\n')) if (l.startsWith('worktree ')) roots.add(l.slice(9)); } catch {}
  const out = new Map();
  for (const r of roots) for (const s of findSessions(r, { sinceMs })) if (!out.has(s.session)) out.set(s.session, s);
  for (const s of findSessions(store.home, { sinceMs, storeDir: store.dir })) if (s.client === 'trace' && !out.has(s.session)) out.set(s.session, s);
  return [...out.values()];
}

async function profileCommand(ctx) {
  const { pos, flags, repo, store, out } = ctx;
  const sub = pos[0] || 'show';
  const cfg = profileConfig(store);
  if (sub === 'show') {
    const p = readProfile(store);
    if (flags.json) { out(JSON.stringify(p, null, 2)); return; }
    if (!p) { out(`no profile yet${cfg.enabled ? '' : ' (learn.mode is not "profile": the sessions here are distilled into notes)'}; thinker profile rebuild --days 30 builds one from this repository's recent sessions`); return; }
    const rows = readLedger(store);
    out(renderProfile(p));
    out('');
    if (flags.why) { // each entry with the observations it cites: what the person asked and said
      const byId = new Map(rows.map(r => [r.id, r]));
      for (const s of SECTIONS) for (const e of p.sections[s] || []) {
        out(`${s}: ${e.text || `when ${e.when}: avoid ${e.avoid}${e.instead ? `; instead: ${e.instead}` : ''}`}`);
        for (const id of e.obs) { const r = byId.get(id); if (!r) { out(`    ${id} (not in the window)`); continue; } out(`    ${r.at.slice(0, 10)} ${r.outcome.padEnd(10)} ${r.request.slice(0, 110)}${r.reaction ? `\n        reaction: "${r.reaction}"` : ''}${r.lesson ? `\n        lesson: ${r.lesson}` : ''}${r.prefs?.length ? `\n        prefs: ${r.prefs.join(' | ')}` : ''}`); }
      }
      out('');
    }
    out(`compiled ${p.compiledAt.slice(0, 19).replace('T', ' ')} with ${p.model || 'an unknown model'} from ${p.window.observations} observations of ${p.window.sessions} sessions · ${rows.filter(r => Date.parse(r.at) > Date.parse(p.compiledAt)).length} new since · ${compileDue(store) ? 'a compile is due' : 'no compile due'} · mode ${cfg.enabled ? 'profile' : 'notes'} · models ${profileModels({ config: cfg }).join(' → ')}`);
    return;
  }
  if (sub === 'ledger') {
    const rows = readLedger(store, { days: Number(flags.days) || PROFILE.ledgerDays }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    if (flags.json) { out(JSON.stringify(rows, null, 2)); return; }
    for (const r of rows) out(`${r.at.slice(0, 10)} ${r.id} ${r.kind.padEnd(13)} ${r.outcome.padEnd(10)} ${r.request}${r.lesson ? `\n    lesson: ${r.lesson}` : ''}${r.reaction ? `\n    reaction: "${r.reaction}"` : ''}`);
    out(`${rows.length} observations from ${new Set(rows.map(r => r.session)).size} sessions in the last ${Number(flags.days) || PROFILE.ledgerDays} days`);
    return;
  }
  if (sub === 'holdout') {
    // Cost per exchange, shown against held out. The sessions' tokens and dollars come from the log's own
    // `session` rows (the last one of each session carries the totals), the exchange counts from the ledger.
    const days = Number(flags.days) || PROFILE.ledgerDays;
    const rows = readLedger(store, { days });
    const since = Date.now() - days * 86400_000;
    const last = new Map();
    for (const e of readLog(store, { all: true })) if (e.op === 'session' && e.profile && Date.parse(e.t) >= since) last.set(e.session, e);
    const cfg = store.config();
    const sessions = new Map();
    for (const [id, e] of last) {
      const cr = e.cacheReadTokens || 0, cw = e.cacheWriteTokens || 0, out = e.outputTokens || 0;
      const fresh = Math.max(0, (e.inputTokens || 0) - cr - cw);
      const tokens = fresh + cr + cw + out;
      const p = listPrice(e.model, { config: cfg });
      const cost = p ? fresh * p.input / 1e6 + cr * p.cacheRead / 1e6 + cw * (p.cacheWrite1h ?? p.cacheWrite) / 1e6 + out * p.output / 1e6 : 0;
      sessions.set(id, { tokens, cost, model: e.model || '?', prompts: e.turns || 0 });
    }
    const h = holdoutReport(rows, { sessions });
    const report = { days, metric: 'tokens per exchange', shown: h.shown, holdout: h.holdout, unknown: h.unknown, delta: h.delta, ci: h.ci, relative: h.relative, corrections: h.corrections, enough: h.enough, verdict: h.verdict, rate: Math.round(100 * profileHoldoutRate(store)) };
    if (flags.json) { out(JSON.stringify(report, null, 2)); return; }
    const pct = v => v == null ? '–' : `${Math.round(v * 100)}%`, num = (v, d = 1) => v == null ? '–' : v.toFixed(d);
    const tk = v => v == null ? '–' : formatTokens(v), dol = v => v == null ? '–' : `$${v.toFixed(2)}`;
    out(`profile holdout over ${days} days, ${report.rate}% of sessions held out (shown the profile against shown nothing)`);
    out('');
    out(`${'arm'.padEnd(8)} ${'sessions'.padStart(8)} ${'priced'.padStart(6)} ${'exch.'.padStart(6)} ${'TOKENS/EXCHANGE'.padStart(15)} ${'$/exch.'.padStart(8)} ${'corrected'.padStart(9)}`);
    for (const arm of ['shown', 'holdout']) { const x = report[arm]; out(`${arm.padEnd(8)} ${String(x.sessions).padStart(8)} ${String(x.priced).padStart(6)} ${String(x.exchanges).padStart(6)} ${tk(x.tokens).padStart(15)} ${dol(x.cost).padStart(8)} ${pct(x.rate).padStart(9)}`); }
    out('');
    const rel = h.relative == null ? '' : ` (${h.relative > 0 ? '+' : ''}${Math.round(100 * h.relative)}%)`;
    out(`tokens per exchange, shown less held out: ${h.delta == null ? '–' : (h.delta > 0 ? '+' : '-') + tk(Math.abs(h.delta))}${rel}`);
    if (h.ci) out(`  95% interval: ${h.delta > 0 ? '' : ''}${tk(h.ci[0])} to ${tk(h.ci[1])} (bootstrapped within each model)`);
    const says = {
      'too-early': `too early: each side needs ${PROFILE.holdoutMinSessions} priced sessions (shown ${h.shown.priced}, held out ${h.holdout.priced})`,
      inconclusive: 'inconclusive: the interval straddles zero, so this window cannot tell the profile from nothing',
      cheaper: 'CHEAPER per exchange with the profile, over the whole interval',
      costlier: 'COSTLIER per exchange with the profile, over the whole interval: stop serving it',
    };
    out(says[h.verdict]);
    out('');
    out(`the profile costs about ${tk(PROFILE.renderChars / 4)} a call, so it pays for itself only by making the work`);
    out('shorter. corrections per exchange is beside the measure as a diagnostic, never instead of it.');
    if (h.corrections != null) out(`corrections, shown less held out: ${(h.corrections > 0 ? '+' : '') + (100 * h.corrections).toFixed(1)}pp`);
    if (h.unknown.observations) out(`\n${h.unknown.observations} observations from ${h.unknown.sessions} sessions carry no arm (read before the profile was served, or by hand)`);
    return;
  }
  if (sub === 'compile') {
    const r = await compileProfile(store, { dry: !!flags.dry, full: !!flags.full, accounting: { store, phase: 'learning', purpose: 'profile-compile' }, config: cfg });
    if (r.dry) { out(`would compile ${r.pending} ${r.previous ? 'new ' : ''}observations (${r.observations} in the window, from ${r.sessions} sessions) in ${r.steps} step${r.steps === 1 ? '' : 's'} against ${r.headings} instruction headings${r.previous ? ' and the previous profile' : ''}`); return; }
    if (r.skipped) { out(`nothing to compile: ${r.skipped}`); return; }
    out(renderProfile(r.profile));
    out(`\ncompiled ${r.pending} observations in ${r.steps} step${r.steps === 1 ? '' : 's'} into a profile of ${r.observations} observations from ${r.sessions} sessions (${r.changes.added} added, ${r.changes.updated} updated, ${r.changes.dropped} dropped)${r.tokens ? `; ~${formatTokens(r.tokens)} tokens` : ''}`);
    return;
  }
  if (sub === 'extract') {
    const file = pos[1];
    if (!file || !fs.existsSync(file)) { out('thinker profile extract <transcript> [--session id] [--dry]'); process.exitCode = 2; return; }
    const { events, lineCount } = parseTranscript(file);
    const session = typeof flags.session === 'string' ? flags.session : path.basename(file).replace(/\.jsonl?$/, '');
    hydrate(events, repo, { trace: traceFile(store.dir, session) });
    if (flags.dry) {
      const xs = exchanges(events);
      for (const x of xs) out(`[${x.turn}] ${x.prompt.slice(0, 100).replace(/\n/g, ' ')}  → ${x.answers.length} answer${x.answers.length === 1 ? '' : 's'}${x.next ? `; next: ${x.next.slice(0, 60).replace(/\n/g, ' ')}` : '; (last)'}`);
      out(`${xs.length} exchanges; no model call (--dry)`);
      return;
    }
    const r = await profileSession(store, events, { session, client: 'claude', repoHint: repo, lineCount, accounting: { phase: 'learning' }, config: cfg });
    for (const o of r.observations) out(`${o.id} ${o.kind.padEnd(13)} ${o.outcome.padEnd(10)} ${o.request}${o.lesson ? `\n    lesson: ${o.lesson}` : ''}`);
    out(`${r.observations.length} observations from ${r.exchanges} exchanges${r.tokens ? `; ~${formatTokens(r.tokens)} tokens` : ''}${r.compiled ? '; profile compiled' : ''}`);
    return;
  }
  if (sub === 'rebuild') {
    const days = Number(flags.days) || 30, max = Number(flags.max) || 60;
    const done = flags.again ? {} : extracted(store);
    const sessions = repoSessions(store, { sinceMs: days * 86400_000 }).filter(s => !done[s.session]).sort((a, b) => a.mtime - b.mtime).slice(-max);
    if (flags.dry) {
      let chars = 0;
      for (const s of sessions) { try { const { events } = parseTranscript(s.file); const xs = exchanges(events); const c = xs.reduce((a, x) => a + x.prompt.length + x.answers.join('').length, 0); chars += c; out(`${s.client.padEnd(7)} ${s.session}  ${xs.length} exchanges, ${Math.round(c / 1000)}k chars`); } catch {} }
      out(`${sessions.length} sessions to extract (${Math.round(chars / 1000)}k chars of prompts and answers), then one compile; no model call (--dry)`);
      return;
    }
    const progress = sessions.length ? batchProgress({ dir: store.dir, name: 'Reading sessions', total: sessions.length, out, silent: true }) : null;
    let n = 0, obs = 0, tokens = 0, failed = 0;
    try {
      for (const s of sessions) {
        const cap = withinDailyCap(store);
        if (!cap.ok) { reportCapped(store, cap); out(`stopping: ${formatTokens(cap.spent)} of the ${formatTokens(cap.cap)} tokens learning may use a day are used`); break; }
        progress.start(s.session);
        try {
          const { events, lineCount } = parseTranscript(s.file);
          hydrate(events, repo, { trace: traceFile(store.dir, s.session) });
          if (events.some(e => e.t === 'prompt' && isWorkerPrompt(e.text))) { progress.complete({ item: s.session }); continue; }
          // the compile waits for the end of the rebuild: one compile over the whole window, not one every ten sessions
          const r = await profileSession(store, events, { session: s.session, client: s.client, repoHint: repo, lineCount, accounting: { phase: 'learning' }, config: cfg, compile: false });
          n++; obs += r.observations.length; tokens += r.tokens || 0;
          if (!flags.quiet) out(`${s.client.padEnd(7)} ${s.session}  ${r.observations.length} observations`);
          progress.complete({ item: s.session });
        } catch (e) { failed++; progress.complete({ item: s.session, error: e.message }); out(`  failed: ${String(e.message).slice(0, 160)}`); }
      }
    } finally { progress?.finish(); }
    out(`read ${n} sessions → ${obs} observations${failed ? `, ${failed} failed` : ''}${tokens ? `; ~${formatTokens(tokens)} tokens` : ''}`);
    if (readLedger(store).length) {
      // the sessions read are patched into the profile as a session's end would patch its own; --full starts from nothing
      const c = await compileProfile(store, { full: !!flags.full, accounting: { store, phase: 'learning', purpose: 'profile-compile' }, config: cfg });
      if (c.skipped) out(`nothing to compile: ${c.skipped}`);
      if (c.profile) { out(''); out(renderProfile(c.profile)); out(`\ncompiled ${c.pending} observations in ${c.steps} step${c.steps === 1 ? '' : 's'} into a profile of ${c.observations} observations from ${c.sessions} sessions (${c.changes.added} added, ${c.changes.updated} updated, ${c.changes.dropped} dropped)${c.tokens ? `; ~${formatTokens(c.tokens)} tokens` : ''}`); }
    }
    return;
  }
  out(`thinker profile [show [--why]|ledger|holdout|compile [--full]|extract <transcript>|rebuild] (sections: ${SECTIONS.join(', ')})`);
  process.exitCode = 2;
}

export const commands = { 'profile': profileCommand };
