// thinker profile: the session profile by hand (profile.js). `show` prints what a session would be shown,
// `extract` reads one transcript into the ledger, `rebuild` reads the window's sessions and compiles,
// `compile` compiles what is new (`--full`: the whole window again), `ledger` lists the observations, `holdout` the two arms.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { listPrice } from '../prices.js';
import { PROFILE, SECTIONS, profileConfig, profileHoldoutRate, readProfile, readLedger, renderProfile, extracted, compileProfile, compileDue, profileSession, exchanges, profileModels, holdoutReport, lineReport, observationSkills, writeLedger, skillTallyText } from '../profile.js';
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
    if (!p) { out(`no profile yet${cfg.enabled ? '' : ' (the profile is off here: learn.profile is false)'}; thinker profile rebuild --days 30 builds one from this repository's recent sessions`); return; }
    const rows = readLedger(store);
    out(renderProfile(p));
    out('');
    if (flags.why) { // each entry with the observations it cites: what the person asked and said
      const byId = new Map(rows.map(r => [r.id, r]));
      for (const s of SECTIONS) for (const e of p.sections[s] || []) {
        // the counts and dates live here, not in the served block
        const tally = e.skill && e.used ? `${e.count} sessions; ${e.accepted} accepted, ${e.corrected} corrected` : e.skill ? `named in ${e.count} sessions` : `${e.count} sessions, ${e.firstSeen} to ${e.lastSeen}`;
        out(`${s}: ${e.skill ? `/${e.skill}: ${e.text}` : e.text} (${tally})`);
        for (const id of e.obs) { const r = byId.get(id); if (!r) { out(`    ${id} (not in the window)`); continue; } out(`    ${r.at.slice(0, 10)} ${r.outcome.padEnd(10)}${r.interrupts ? ' [interrupted]' : ''} ${r.request.slice(0, 110)}${r.reaction ? `\n        reaction: "${r.reaction}"` : ''}${r.lesson ? `\n        lesson: ${r.lesson}` : ''}${r.prefs?.length ? `\n        prefs: ${r.prefs.join(' | ')}` : ''}`); }
      }
      const tally = skillTallyText(rows); if (tally) out(`skill use in the window:\n${tally}`);
      out('');
    }
    out(`compiled ${p.compiledAt.slice(0, 19).replace('T', ' ')} with ${p.model || 'an unknown model'} from ${p.window.observations} observations of ${p.window.sessions} sessions · ${rows.filter(r => Date.parse(r.at) > Date.parse(p.compiledAt)).length} new since · ${compileDue(store) ? 'a compile is due' : 'no compile due'} · mode ${cfg.enabled ? 'profile' : 'notes'} · models ${profileModels({ config: cfg }).join(' → ')}`);
    return;
  }
  if (sub === 'ledger') {
    const rows = readLedger(store, { days: Number(flags.days) || PROFILE.ledgerDays }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    if (flags.json) { out(JSON.stringify(rows, null, 2)); return; }
    for (const r of rows) out(`${r.at.slice(0, 10)} ${r.id} ${r.outcome.padEnd(10)}${r.interrupts ? ' [interrupted]' : ''} ${r.request}${r.lesson ? `\n    lesson: ${r.lesson}` : ''}${r.reaction ? `\n    reaction: "${r.reaction}"` : ''}`);
    out(`${rows.length} observations from ${new Set(rows.map(r => r.session)).size} sessions in the last ${Number(flags.days) || PROFILE.ledgerDays} days`);
    return;
  }
  if (sub === 'lines') {
    // What each line of the profile was used for. The first question about a line is whether the agent read it:
    // a line nothing ever follows is costing its characters in every prompt of every session for nothing.
    const days = Number(flags.days) || PROFILE.ledgerDays;
    const rep = lineReport(store, { days });
    if (flags.json) { out(JSON.stringify(rep, null, 2)); return; }
    if (!rep.verdicts) { out(`no line verdicts yet: they are written when a session that was shown the profile is read (${days} days)`); return; }
    out(`${rep.verdicts} verdicts on ${rep.lines.length} lines from ${rep.sessions} sessions shown the profile, last ${days} days`);
    out(`followed in ${rep.followed} of the ${rep.applied} sessions a line had any bearing on${rep.followRate == null ? '' : ` (${Math.round(100 * rep.followRate)}%)`}`);
    out('');
    out(`${'line'.padEnd(6)} ${'shown'.padStart(5)} ${'applied'.padStart(7)} ${'followed'.padStart(8)} ${'ignored'.padStart(7)} ${'contra.'.padStart(7)} ${'rate'.padStart(6)}  text`);
    for (const l of rep.lines) {
      const rate = l.followRate == null ? '    –' : `${String(Math.round(100 * l.followRate)).padStart(4)}%`;
      out(`${l.id.padEnd(6)} ${String(l.shown).padStart(5)} ${String(l.applied).padStart(7)} ${String(l.followed).padStart(8)} ${String(l.ignored).padStart(7)} ${String(l.contradicted).padStart(7)} ${rate.padStart(6)}  ${l.gone ? '(no longer in the profile) ' : ''}${(l.text || '').slice(0, 70)}`);
      if (flags.why) for (const e of l.evidence.slice(0, 3)) out(`         ${e.verdict}: "${e.text.slice(0, 90)}"`);
    }
    out('');
    out('applied is the sessions the line had any bearing on; a rate of – means it has never come up, which is an');
    out('untested line and not a failing one. Worst first: a line often applied and seldom followed is the one to cut.');
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
    const report = { days, metric: 'recurrence per exchange', shown: h.shown, holdout: h.holdout, unknown: h.unknown, recurrence: h.recurrence, cost: h.cost, rate: Math.round(100 * profileHoldoutRate(store)) };
    if (flags.json) { out(JSON.stringify(report, null, 2)); return; }
    const pct = v => v == null ? '–' : `${(100 * v).toFixed(1)}%`, pp = v => v == null ? '–' : `${v > 0 ? '+' : ''}${(100 * v).toFixed(1)}pp`;
    const tk = v => v == null ? '–' : formatTokens(v), dol = v => v == null ? '–' : `$${v.toFixed(2)}`;
    const rel = c => c.relative == null ? '' : ` (${c.relative > 0 ? '+' : ''}${Math.round(100 * c.relative)}%)`;
    out(`profile holdout over ${days} days, ${report.rate}% of sessions held out (shown the profile against shown nothing)`);
    out('');
    out('RECURRENCE: the person saying again what they said before, per exchange');
    out(`${'arm'.padEnd(8)} ${'sessions'.padStart(8)} ${'exch.'.padStart(6)} ${'SAID AGAIN'.padStart(10)} ${'of a line'.padStart(10)} ${'unlearned'.padStart(10)}`);
    for (const arm of ['shown', 'holdout']) { const x = report[arm], r = x.recurrence; out(`${arm.padEnd(8)} ${String(x.sessions).padStart(8)} ${String(r.measured).padStart(6)} ${pct(r.rate).padStart(10)} ${pct(r.servedRate).padStart(10)} ${pct(r.unlearnedRate).padStart(10)}`); }
    const r = h.recurrence;
    out(`of a line the agent held, shown less held out: ${pp(r.delta)}${r.ci ? ` (95% ${pp(r.ci[0])} to ${pp(r.ci[1])})` : ''}${rel(r)}`);
    out({
      'too-early': `  too early: each side needs ${PROFILE.holdoutMinObs} measured exchanges (shown ${h.shown.recurrence.measured}, held out ${h.holdout.recurrence.measured})`,
      inconclusive: '  inconclusive: the interval straddles zero, so this window cannot tell the profile from nothing',
      fewer: '  FEWER repeats with the profile, over the whole interval: the agent holding the line spared the person saying it',
      more: '  MORE repeats with the profile, over the whole interval: something is wrong, read `thinker profile lines --why`',
    }[r.verdict]);
    out('  "unlearned" is a repeat of something no line holds: the same in both arms by construction, and the compile\'s to fix, not the serving\'s.');
    out('');
    out('COST per exchange, stratified by model');
    out(`${'arm'.padEnd(8)} ${'priced'.padStart(6)} ${'exch.'.padStart(6)} ${'tokens/exch.'.padStart(12)} ${'$/exch.'.padStart(8)} ${'corrected'.padStart(9)}`);
    for (const arm of ['shown', 'holdout']) { const x = report[arm]; out(`${arm.padEnd(8)} ${String(x.priced).padStart(6)} ${String(x.exchanges).padStart(6)} ${tk(x.tokens).padStart(12)} ${dol(x.cost).padStart(8)} ${pct(x.rate).padStart(9)}`); }
    const c = h.cost;
    out(`tokens per exchange, shown less held out: ${c.delta == null ? '–' : (c.delta > 0 ? '+' : '-') + tk(Math.abs(c.delta))}${rel(c)}${c.ci ? `, 95% ${tk(c.ci[0])} to ${tk(c.ci[1])}` : ''}; ${c.verdict}`);
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
    for (const o of r.observations) out(`${o.id} ${o.outcome.padEnd(10)}${o.interrupts ? ' [interrupted]' : ''} ${o.request}${o.lesson ? `\n    lesson: ${o.lesson}` : ''}`);
    out(`${r.observations.length} observations from ${r.exchanges} exchanges${r.tokens ? `; ~${formatTokens(r.tokens)} tokens` : ''}${r.compiled ? '; profile compiled' : ''}`);
    return;
  }
  if (sub === 'backfill') {
    // skills and interrupts onto the rows read before the ledger recorded them (2026-11-08): each session's transcript
    // is read again for its SKILLS and INTERRUPTED lines alone and the rows take theirs by turn; no model call, idempotent
    const rows = readLedger(store);
    const files = new Map(repoSessions(store, { sinceMs: (PROFILE.ledgerDays + 30) * 86400_000 }).map(s => [s.session, s]));
    const bySession = new Map(); for (const r of rows) { if (!bySession.has(r.session)) bySession.set(r.session, []); bySession.get(r.session).push(r); }
    let changed = 0, withSkills = 0, missing = 0;
    for (const [session, group] of bySession) {
      const s = files.get(session); if (!s || s.client === 'trace') { missing++; continue; }
      let xs; try { xs = exchanges(parseTranscript(s.file).events); } catch { missing++; continue; }
      const next = observationSkills(group, xs);
      group.forEach((r, i) => { if (JSON.stringify(r.skills || null) !== JSON.stringify(next[i].skills) || (r.interrupts || 0) !== next[i].interrupts) { r.skills = next[i].skills; r.interrupts = next[i].interrupts; changed++; } if (next[i].skills.length) withSkills++; });
    }
    if (changed && !flags.dry) writeLedger(store, rows);
    out(`${rows.length} observations from ${bySession.size} sessions: ${withSkills} ran a skill, ${changed} rows ${flags.dry ? 'would change' : 'changed'}${missing ? `, ${missing} sessions with no transcript to read` : ''}`);
    const tally = skillTallyText(rows); if (tally) out(tally);
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
  out(`thinker profile [show [--why]|ledger|holdout|compile [--full]|extract <transcript>|rebuild|backfill [--dry]] (sections: ${SECTIONS.join(', ')})`);
  process.exitCode = 2;
}

export const commands = { 'profile': profileCommand };
