// Local cache review, backup and restore (export, import), the
// MCP server (serve), and what it holds and did (health, stats, usage).
import path from 'node:path';
import fs from 'node:fs';
import { startVerification, prepareVerification, executeVerification, readVerification, renderVerification, taskContext } from '../verification.js';
import { spawn } from 'node:child_process';
import { refresh } from '../ops.js';
import { review, renderReview, resolveScope } from '../review.js';
import { postComment } from '../review-post.js';
import { subsystemForFile } from '../topology.js';
import { exportCache, importCache } from '../transfer.js';
import { summarize, renderUsage } from '../usage.js';
import { stats, renderStats } from '../stats.js';

async function reviewCommand(ctx) {
  const { pos, flags, repo, store, out } = ctx;
  if (flags.post && !/^[1-9]\d*$/.test(String(flags.pr || ''))) throw new Error('--post requires --pr <number>');
  if (flags.post && flags.dry) throw new Error('--post cannot be combined with --dry');
  const task = typeof flags.task === 'string' ? JSON.parse(fs.readFileSync(path.resolve(flags.task), 'utf8')) : undefined;
  if (flags.run || flags.start || flags.status) {
    if (pos.length || flags.state || flags.staged && flags.ref) throw new Error('Verification checks the full snapshot; paths/state and staged+ref are not supported');
    const opts = { task, base: typeof flags.base === 'string' ? flags.base : undefined, ref: typeof flags.ref === 'string' ? flags.ref : undefined, staged: !!flags.staged, previous: typeof flags.previous === 'string' ? flags.previous : undefined, model: flags.model, dry: !!flags.dry };
    let result;
    if (flags.status) result = readVerification(repo, flags.status);
    else if (flags.start) result = await startVerification(store, opts);
    else { const run = prepareVerification(store, opts); await executeVerification(repo, run.id); result = readVerification(repo, run.id); }
    if (flags.post) result.comment = postComment({}, { repo, pr: flags.pr, markdown: renderVerification(result, { portable: true }) });
    out(flags.json ? JSON.stringify(result, null, 2) : renderVerification(result));
    if (result.comment && !flags.json) out(`Posted PR comment: ${result.comment.url}`);
    if (flags.strict && (result.status !== 'passed' || result.freshness?.status !== 'current')) process.exitCode = result.status === 'failed' || result.status === 'needs-review' ? 2 : 1;
    return;
  }
  const scope = resolveScope(repo, { base: typeof flags.base === 'string' ? flags.base : undefined, staged: !!flags.staged, ref: typeof flags.ref === 'string' ? flags.ref : undefined, state: !!flags.state });
  const kinds = typeof flags.kinds === 'string' ? flags.kinds.split(',').map(k => k.trim()).filter(Boolean) : undefined;
  // the strategy flags of bench/review-eval.js (review.js:DEFAULT_STRATEGY); the default is the ensemble
  const strategy = { ...(typeof flags.mode === 'string' ? { mode: flags.mode } : {}), ...(flags['no-related'] ? { related: false } : {}), ...(flags.callers ? { callers: true } : {}), ...(typeof flags.context === 'string' ? { context: flags.context === 'none' ? null : flags.context } : {}), ...(flags.triage ? { triage: true } : {}), ...(flags.verify ? { verify: true } : {}), ...(flags.chunks ? { chunks: Number(flags.chunks) } : {}) };
  const r = await review(store, { scope, task: taskContext(task), pr: flags.pr, paths: pos, max: flags.max ? Number(flags.max) : 12, model: flags.model, dry: !!flags.dry, strategy, kinds });
  if (flags.post) r.comment = postComment(r, { repo, pr: flags.pr });
  out(flags.json ? JSON.stringify(r, null, 2) : renderReview(r, { verbose: !!flags.verbose }));
  if (r.comment && !flags.json) out(`Posted PR comment: ${r.comment.url}`);
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

// `thinker ui`: the local page (ui/server.js) until Ctrl+C. Usage, the notes in the cache, and the desired behaviors with the
// ones waiting for a decision. --from-setup is how setup opens it (setup/steps.js:openDashboard): detached, with no
// terminal to press Ctrl+C in, so it opens the browser itself, shows the page's how-to-come-back hint, and exits once
// no request has come for UI_IDLE_MS.
const UI_IDLE_MS = 30 * 60 * 1000;
async function uiCommand(ctx) {
  const { flags, store, out } = ctx;
  const { createUiServer, openBrowser, DEFAULT_PORT } = await import('../ui/server.js');
  const { box, c } = await import('../setup/ui.js');
  const ui = createUiServer(store);
  const listening = await ui.listen(flags.port !== undefined ? Number(flags.port) : DEFAULT_PORT);
  const { port } = listening;
  if (flags['from-setup']) {
    openBrowser(`${listening.url}&from=setup`);
    await new Promise(resolve => { const t = setInterval(() => { if (ui.idleMs() > UI_IDLE_MS) { clearInterval(t); resolve(); } }, 60 * 1000); });
    await ui.close();
    return;
  }
  const { url } = listening;
  out('\n' + box([
    `${c.yellow('*')} ${c.magenta('~')} ${c.yellow('*')}  ${c.bold(c.cyan('Thinker'))} ${c.dim('· local')}`,
    '',
    `Usage, cache and system behaviors at ${c.cyan(`http://127.0.0.1:${port}`)}`,
    c.dim('On this machine only. Press Ctrl+C to stop.'),
  ], { width: 74 }) + '\n');
  if (!flags['no-open'] && process.stdout.isTTY) openBrowser(url);
  else out(`Open: ${url}`);
  await new Promise(resolve => { const stop = () => { ui.close().then(resolve); }; process.once('SIGINT', stop); process.once('SIGTERM', stop); });
}

export const commands = {
  'ui': uiCommand,
  'review': reviewCommand,
  'export': exportCommand,
  'import': importCommand,
  'serve': serveCommand,
  'health': healthCommand,
  'stats': statsCommand,
  'usage': usageCommand,
};
