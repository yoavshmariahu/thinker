// The local page (ui), the MCP server (serve), and what thinker did (stats, usage).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { summarize, renderUsage } from '../usage.js';
import { stats, renderStats } from '../stats.js';

async function serveCommand(ctx) {
  const { repo, HERE } = ctx;
  const p = spawn('node', [path.join(HERE, 'mcp.js')], { stdio: 'inherit', env: { ...process.env, THINKER_REPO: repo } });
  p.on('exit', c => process.exit(c || 0));
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
  if (flags.json) { out(JSON.stringify(u, null, 2)); return; }
  out(renderUsage(u, { days }));
  return;
}

// `thinker ui`: the local page (ui/server.js) until Ctrl+C, from any directory: the Save tab first (where the
// agents' context goes and the cuts, context-view.js), then Report (what a session costs here week by week, report.js).
// --from-setup is how setup opens it (setup/steps.js:openDashboard): detached, with no terminal to press Ctrl+C in, so it opens the
// browser itself (--tab names the page to land on), shows the page's how-to-come-back hint, and exits once no
// request has come for UI_IDLE_MS.
const UI_IDLE_MS = 30 * 60 * 1000;
async function uiCommand(ctx) {
  const { flags, store, out } = ctx;
  const { createUiServer, openBrowser, DEFAULT_PORT, refreshCheckouts } = await import('../ui/server.js');
  // the checkouts the page lists, looked for again (ui/server.js:refreshCheckouts); the page runs this in the background
  if (flags.refresh) { const cs = refreshCheckouts(store); if (!flags.quiet) out(`${cs.length} checkouts with a cache kept for the page.`); return; }
  const { box, c } = await import('../setup/ui.js');
  // --background (context-suggest.js:ensureUi): the page a session's hook starts, its address in
  // THINKER_HOME/state/ui.json while it runs; no browser, gone once idle
  const background = Boolean(flags.background);
  const ui = createUiServer(store);
  const listening = await ui.listen(flags.port !== undefined ? Number(flags.port) : DEFAULT_PORT);
  const { port } = listening;
  // Over every repository on the machine (2026-10-25, the owner's ask; `--all` was the flag for it and still says so):
  // `--here` opens on this checkout alone. An old --tab context|cache opens the view that replaced it.
  const parts = [typeof flags.tab === 'string' ? `tab=${encodeURIComponent(flags.tab)}` : '', flags.here && !flags.all ? 'repo=here' : 'repo=all'].filter(Boolean);
  const tab = parts.length ? `#${parts.join('&')}` : '';
  if (background) {
    const { uiFile } = await import('../context-suggest.js');
    const f = uiFile(), mine = () => { try { return JSON.parse(fs.readFileSync(f, 'utf8')).pid === process.pid; } catch { return false; } };
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ pid: process.pid, port, url: listening.url, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
    // the idle check's timer would keep the process alive after a SIGTERM: cleared on either
    await new Promise(resolve => { const done = () => { clearInterval(t); resolve(); }; const t = setInterval(() => { if (ui.idleMs() > UI_IDLE_MS) done(); }, 60 * 1000); process.once('SIGTERM', done); });
    if (mine()) fs.rmSync(f, { force: true });
    // a browser tab's open connection can hold the close: the process ends once it is done, or after 2 s at most
    setTimeout(() => process.exit(0), 2000).unref();
    await ui.close();
    process.exit(0);
  }
  if (flags['from-setup']) {
    openBrowser(`${listening.url}#from=setup${parts.length ? `&${parts.join('&')}` : ''}`);
    await new Promise(resolve => { const t = setInterval(() => { if (ui.idleMs() > UI_IDLE_MS) { clearInterval(t); resolve(); } }, 60 * 1000); });
    await ui.close();
    return;
  }
  const url = listening.url + tab;
  out('\n' + box([
    `${c.yellow('*')} ${c.magenta('~')} ${c.yellow('*')}  ${c.bold(c.cyan('Thinker'))} ${c.dim('· local')}`,
    '',
    `Find Savings (where your agents' context goes) and View Report (what a session costs here week by week), at ${c.cyan(`http://127.0.0.1:${port}`)}`,
    c.dim('On this machine only. Press Ctrl+C to stop.'),
  ], { width: 74 }) + '\n');
  if (!flags['no-open'] && process.stdout.isTTY) openBrowser(url);
  else out(`Open: ${url}`);
  await new Promise(resolve => { const stop = () => { ui.close().then(resolve); }; process.once('SIGINT', stop); process.once('SIGTERM', stop); });
}

export const commands = {
  'ui': uiCommand,
  'serve': serveCommand,
  'stats': statsCommand,
  'usage': usageCommand,
};
