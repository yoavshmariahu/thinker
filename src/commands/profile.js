// thinker profile: the session profile by hand (profile.js). `show` prints what a session would be shown,
// `extract` reads one transcript into the ledger, `rebuild` reads the window's sessions and compiles,
// `compile` compiles what is new (`--full`: the whole window again), `ledger` lists the observations.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROFILE, SECTIONS, profileConfig, readProfile, readLedger, renderProfile, extracted, compileProfile, compileDue, profileSession, exchanges, profileModels } from '../profile.js';
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
  if (sub === 'compile') {
    const r = await compileProfile(store, { dry: !!flags.dry, full: !!flags.full, accounting: { store, phase: 'learning', purpose: 'profile-compile' }, config: cfg });
    if (r.dry) { out(`would compile ${r.pending} ${r.previous ? 'new ' : ''}observations (${r.observations} in the window, from ${r.sessions} sessions) in ${r.steps} step${r.steps === 1 ? '' : 's'} against ${r.headings} instruction headings${r.previous ? ' and the previous profile' : ''}`); return; }
    if (r.skipped) { out(`nothing to compile: ${r.skipped}`); return; }
    out(renderProfile(r.profile));
    out(`\ncompiled ${r.pending} observations in ${r.steps} step${r.steps === 1 ? '' : 's'} into a profile of ${r.observations} observations from ${r.sessions} sessions${r.tokens ? `; ~${formatTokens(r.tokens)} tokens` : ''}`);
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
      // from nothing, over the whole window: a rebuild is what a changed prompt or a redone ledger asks for
      const c = await compileProfile(store, { full: true, accounting: { store, phase: 'learning', purpose: 'profile-compile' }, config: cfg });
      if (c.profile) { out(''); out(renderProfile(c.profile)); out(`\ncompiled ${c.observations} observations from ${c.sessions} sessions in ${c.steps} step${c.steps === 1 ? '' : 's'}${c.tokens ? `; ~${formatTokens(c.tokens)} tokens` : ''}`); }
    }
    return;
  }
  out(`thinker profile [show [--why]|ledger|compile [--full]|extract <transcript>|rebuild] (sections: ${SECTIONS.join(', ')})`);
  process.exitCode = 2;
}

export const commands = { 'profile': profileCommand };
