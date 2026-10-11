// Cache backup and restore (export, import), the MCP server (serve), and what the cache
// holds and did (health, stats, usage).
import path from 'node:path';
import { spawn } from 'node:child_process';
import { refresh } from '../ops.js';
import { subsystemForFile } from '../topology.js';
import { exportCache, importCache } from '../transfer.js';
import { summarize, renderUsage } from '../usage.js';
import { stats, renderStats } from '../stats.js';

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

// `thinker ui`: the local page (ui/server.js) until Ctrl+C, from any directory: usage, the caches on this machine
// with their notes and behaviors, and the warm-up page that builds caches. --from-setup is how the installer and
// setup open it (setup/steps.js:openDashboard): detached, with no terminal to press Ctrl+C in, so it opens the
// browser itself (--tab names the page to land on), shows the page's how-to-come-back hint, and exits once no
// request has come for UI_IDLE_MS and no warm-up build is queued.
const UI_IDLE_MS = 30 * 60 * 1000;
async function uiCommand(ctx) {
  const { flags, store, out } = ctx;
  const { createUiServer, openBrowser, DEFAULT_PORT } = await import('../ui/server.js');
  const { box, c } = await import('../setup/ui.js');
  const ui = createUiServer(store);
  const listening = await ui.listen(flags.port !== undefined ? Number(flags.port) : DEFAULT_PORT);
  const { port } = listening;
  const tab = typeof flags.tab === 'string' ? `&tab=${encodeURIComponent(flags.tab)}` : '';
  if (flags['from-setup']) {
    openBrowser(`${listening.url}&from=setup${tab}`);
    await new Promise(resolve => { const t = setInterval(() => { if (ui.idleMs() > UI_IDLE_MS) { clearInterval(t); resolve(); } }, 60 * 1000); });
    await ui.close();
    return;
  }
  const url = listening.url + tab;
  out('\n' + box([
    `${c.yellow('*')} ${c.magenta('~')} ${c.yellow('*')}  ${c.bold(c.cyan('Thinker'))} ${c.dim('· local')}`,
    '',
    `Usage, the caches on this machine and the warm-up page at ${c.cyan(`http://127.0.0.1:${port}`)}`,
    c.dim('On this machine only. Press Ctrl+C to stop.'),
  ], { width: 74 }) + '\n');
  if (!flags['no-open'] && process.stdout.isTTY) openBrowser(url);
  else out(`Open: ${url}`);
  await new Promise(resolve => { const stop = () => { ui.close().then(resolve); }; process.once('SIGINT', stop); process.once('SIGTERM', stop); });
}

export const commands = {
  'ui': uiCommand,
  'export': exportCommand,
  'import': importCommand,
  'serve': serveCommand,
  'health': healthCommand,
  'stats': statsCommand,
  'usage': usageCommand,
};
