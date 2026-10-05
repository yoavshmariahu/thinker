// The cache as a whole: sharing and reviewing (share, review), moving it (export, import, sync), the
// MCP server (serve), and what it holds and did (health, stats, usage).
import path from 'node:path';
import { spawn } from 'node:child_process';
import { refresh } from '../ops.js';
import { review, renderReview, resolveScope } from '../review.js';
import { repairStaged } from '../share-repair.js';
import { share, validateShare, validatePush } from '../share.js';
import { syncConfig, syncNotes, pull as syncPull, push as syncPush, login as syncLogin, logout as syncLogout, status as syncStatus, renderStatus as renderSyncStatus } from '../sync.js';
import { subsystemForFile } from '../topology.js';
import { exportCache, importCache } from '../transfer.js';
import { summarize, renderUsage } from '../usage.js';
import { stats, renderStats } from '../stats.js';

async function shareCommand(ctx) {
  const { pos, flags, repo, store, out, readStdin } = ctx;
  if (flags['repair-staged']) {
    const actions = await repairStaged(store, { dry: !!flags.dry, model: flags.model, ...(flags.cap !== undefined ? { cap: Number(flags.cap) } : {}) });
    for (const a of actions) out(`${flags.dry ? 'would ' : ''}${a.action} ${a.id}: ${a.reason}`);
    const n = k => actions.filter(a => a.action === k).length;
    if (actions.length) out(`thinker: ${n('update')} corrected, ${n('remove')} removed from this commit${n('left') ? `, ${n('left')} left as they are for maintenance to verify` : ''}${n('deferred') ? `, ${n('deferred')} left for maintenance (--cap n changes the limit)` : ''}${n('update') + n('remove') ? '; originals saved locally' : ''}`);
  } else if (flags.check || flags['pre-push']) {
    const opts = { base: typeof flags.base === 'string' ? flags.base : undefined, ref: flags.ref || 'HEAD', strict: !!flags.strict, remote: flags.remote || 'origin' };
    const results = flags['pre-push'] ? validatePush(repo, readStdin(), opts) : [validateShare(repo, opts)];
    for (const r of results) {
      for (const w of r.warnings) out(`warning ${w.id}: ${w.message}`);
      for (const e of r.errors) out(`${flags.strict && !flags['pre-push'] ? 'error' : 'warning'} ${e.id}: ${e.message}`);
      out(`checked ${r.checked} shared notes at ${r.ref.slice(0, 10)}: ${r.errors.length} issues, ${r.warnings.length} other warnings${flags['pre-push'] ? '; push allowed' : ''}`);
    }
    if (flags.strict && !flags['pre-push'] && results.some(r => r.errors.length)) process.exitCode = 2;
  } else {
    const result = share(store, { ids: pos, all: !!flags.all, dry: !!flags.dry });
    for (const r of result.ready) out(`${flags.dry ? 'would ' : ''}${r.action} ${r.id}`);
    for (const r of result.skipped) out(`skip ${r.id}: ${r.reasons.join('; ')}`);
    for (const r of result.superseded) out(`superseded ${r.id}: a pull replaced this note while a change to it (${r.fields.join(', ')}) was unshared here; thinker show ${r.id} prints it`);
    for (const u of result.unreadable) out(`warning: ${path.relative(repo, u.file)} is not served: ${u.reason}`);
    out(`${result.ready.length} notes ${flags.dry ? 'ready to share' : 'shared; review and commit .thinker/notes/'}`);
  }
  return;
}

async function reviewCommand(ctx) {
  const { pos, flags, repo, store, out } = ctx;
  const scope = resolveScope(repo, { base: typeof flags.base === 'string' ? flags.base : undefined, staged: !!flags.staged, ref: typeof flags.ref === 'string' ? flags.ref : undefined, state: !!flags.state });
  const kinds = typeof flags.kinds === 'string' ? flags.kinds.split(',').map(k => k.trim()).filter(Boolean) : undefined;
  // the strategy flags of bench/review-eval.js (review.js:DEFAULT_STRATEGY); the default is the ensemble
  const strategy = { ...(typeof flags.mode === 'string' ? { mode: flags.mode } : {}), ...(flags['no-related'] ? { related: false } : {}), ...(flags.callers ? { callers: true } : {}), ...(flags.triage ? { triage: true } : {}), ...(flags.verify ? { verify: true } : {}), ...(flags.chunks ? { chunks: Number(flags.chunks) } : {}) };
  const r = await review(store, { scope, pr: flags.pr, paths: pos, max: flags.max ? Number(flags.max) : 12, model: flags.model, dry: !!flags.dry, strategy, kinds });
  out(flags.json ? JSON.stringify(r, null, 2) : renderReview(r, { verbose: !!flags.verbose }));
  if (flags.strict) {
    if (r.errors?.length) process.exitCode = 1;
    else if (r.counts?.error || r.behaviors?.some(b => b.mutability === 'fixed' && b.outcome === 'violated')) process.exitCode = 2;
  }
  return;
}

async function exportCommand(ctx) {
  const { pos, repo, store, out } = ctx;
  const file = path.resolve(pos[0] || `thinker-cache-${path.basename(repo)}.tgz`);
  const result = exportCache(store, file);
  out(`exported ${result.notes} notes → ${file}`);
  return;
}

async function importCommand(ctx) {
  const { pos, store, out } = ctx;
  if (!pos[0]) throw new Error('usage: thinker import <file.tgz | https://…>');
  const result = importCache(store, pos[0]);
  const notes = refresh(store, store.list());
  out(`imported ${result.notes} notes into the local cache; ${notes.filter(n => n.status === 'stale').length} are stale against this checkout`);
  return;
}

async function syncCommand(ctx) {
  const { pos, flags, repo, store, out } = ctx;
  if (pos[0] === 'login') { const c = syncLogin(store, { url: pos[1] || flags.url, token: typeof flags.token === 'string' ? flags.token : undefined, repo: typeof flags.as === 'string' ? flags.as : undefined }); out(c ? `syncing ${c.repo} with ${c.url}` : 'url saved; a token is still needed: thinker sync login <url> --token <t>'); if (c) { const r = await syncNotes(store, c); out(`pulled ${r.pulled}, pushed ${r.pushed}`); } return; }
  if (pos[0] === 'logout') { syncLogout(store); out('sync switched off for this checkout'); return; }
  if (pos[0] === 'status') { out(renderSyncStatus(await syncStatus(store))); return; }
  const cfg = syncConfig(store);
  if (!cfg) { out(renderSyncStatus(await syncStatus(store))); process.exitCode = 1; return; }
  if (flags.all) cfg.pushAll = true;
  const only = flags.pull || flags.push;
  const dry = !!flags.dry, quiet = !!flags.quiet;
  if (!only || flags.pull) { const r = await syncPull(store, cfg, { save: !dry }); if (!quiet) out(`pulled ${r.applied} ${r.applied === 1 ? 'note' : 'notes'}${r.deleted ? `, ${r.deleted} removed` : ''} (cursor ${r.seq})`); }
  if (!only || flags.push) { const r = await syncPush(store, cfg, { dry }); if (!quiet) { out(`${dry ? 'would push' : 'pushed'} ${dry ? r.planned : r.pushed}${r.retired ? `, retired ${r.retired}` : ''}${r.conflicts ? `, ${r.conflicts} taken from the server instead` : ''}${r.rejected ? `, ${r.rejected} rejected` : ''}`); if (flags.verbose) for (const s of r.skipped) out(`  held back ${s.id}: ${s.reasons.join('; ')}`); } }
  return;
}

async function serveCommand(ctx) {
  const { repo, HERE } = ctx;
  const p = spawn('node', [path.join(HERE, 'mcp.js')], { stdio: 'inherit', env: { ...process.env, THINKER_REPO: repo } });
  p.on('exit', c => process.exit(c || 0));
  return;
}

async function healthCommand(ctx) {
  const { repo, store, out } = ctx;
  const notes = store.list();
  out(`\n=== Thinker Cache Health Report for ${path.basename(repo)} ===\n`);
  out(`Total notes: ${notes.length}`);
  if (!notes.length) {
    out('The cache is empty. Run `thinker setup` to initialize.\n');
    return;
  }
  const kinds = {};
  const statusCounts = { fresh: 0, stale: 0, invalid: 0 };
  let withSays = 0;
  let brokenDeps = 0;
  const subs = {};

  const refreshed = refresh(store, notes, { persist: false });
  for (const n of refreshed) {
    kinds[n.kind] = (kinds[n.kind] || 0) + 1;
    statusCounts[n.status] = (statusCounts[n.status] || 0) + 1;
    if (n.says?.length) withSays++;
    const check = (n.deps || []).some(d => d.missing);
    if (check) brokenDeps++;
    const sub = (n.deps && n.deps[0]) ? subsystemForFile(repo, n.deps[0].path) : 'other';
    subs[sub] = (subs[sub] || 0) + 1;
  }

  out('\nKinds breakdown:');
  for (const [k, count] of Object.entries(kinds).sort((a, b) => b[1] - a[1])) {
    out(`  ${k.padEnd(14)}: ${count}`);
  }

  out('\nSubsystem coverage:');
  for (const [s, count] of Object.entries(subs).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    out(`  ${s.padEnd(28)}: ${count} notes`);
  }

  out('\nQuality metrics:');
  out(`  Status:         ${statusCounts.fresh} fresh, ${statusCounts.stale} stale, ${statusCounts.invalid} invalid`);
  out(`  Phrasing:       ${withSays}/${notes.length} (${Math.round((withSays / notes.length) * 100)}%) notes have product phrasings`);
  out(`  Broken deps:    ${brokenDeps} notes point to missing files`);

  const alerts = [];
  if (!kinds.overview && !kinds.callpath) alerts.push('Cache lacks structural overview or callpath notes');
  if (kinds.invariant > 10 && (kinds.callpath || 0) + (kinds.overview || 0) < 3) alerts.push('Cache is skewed towards micro-rules with few structural maps');
  if (withSays < notes.length * 0.5) alerts.push('More than 50% of notes lack search phrasings (run `thinker phrase`)');
  if (brokenDeps > 0) alerts.push(`${brokenDeps} notes have broken file dependencies (run \`thinker check\`)`);

  if (alerts.length) {
    out('\nHealth warnings:');
    for (const a of alerts) out(`  ⚠ ${a}`);
  } else {
    out('\nHealth status: EXCELLENT (well balanced and grounded)');
  }
  out('');
  return;
}

async function statsCommand(ctx) {
  const { flags, store, out } = ctx;
  const days = flags.days === undefined ? undefined : Number(flags.days);
  if (flags.days !== undefined && (typeof flags.days === 'boolean' || !Number.isFinite(days) || days <= 0)) {
    throw new Error('--days must be a positive number');
  }
  const result = stats(store, { here: !!flags.here, days });
  out(flags.json ? JSON.stringify(result, null, 2) : renderStats(result));
}

async function usageCommand(ctx) {
  const { flags, store, out } = ctx;
  const days = Number(flags.days) || undefined;
  const u = summarize(store, { days, all: !flags.here });
  out(flags.json ? JSON.stringify(u, null, 2) : renderUsage(u, { days }));
  return;
}

export const commands = {
  'share': shareCommand,
  'review': reviewCommand,
  'export': exportCommand,
  'import': importCommand,
  'sync': syncCommand,
  'serve': serveCommand,
  'health': healthCommand,
  'stats': statsCommand,
  'usage': usageCommand,
};
