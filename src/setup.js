// Thinker setup flow: connect the coding agents and fetch the ranking model. Nothing is built: the cache
// starts empty and grows from the sessions (since 2026-10-21; the warm-up that read merged pull requests
// into it is gone). The flow is `runSetup` below; its parts are under src/setup/ (ui, agents, estimate,
// steps, pr-benchmark), all re-exported here so nothing else needs to know the layout.
import { execFileSync } from 'node:child_process';
import { thinkerHome } from './update.js';
import { maybeSendDailyTelemetryInBackground } from './telemetry.js';
import { c, banner, stepBanner, finishBox, withSpinner } from './setup/ui.js';
import fs from 'node:fs';
import path from 'node:path';
import { stepConnectClis, ignoreLocalState, openDashboard } from './setup/steps.js';
export * from './setup/ui.js';
export * from './setup/agents.js';
export * from './setup/estimate.js';
export * from './setup/steps.js';
export * from './setup/pr-benchmark.js';

// --- Main Guided Setup Orchestrator -------------------------------------

export async function runSetup({
  repo,
  store,
  cliPath,
  mcpEntry,
  userMcpEntry,
  clients,
  yes = false,
  hooks = true,
  learn = true,
  late = false,
  mcp = true,
  gitHook = true,
  noTrust = false,
  proxy = true,
  exportFile = null,
  out = console.log,
  dashboard = false,
  openDashboardFn = openDashboard,
}) {
  // first time here: no .thinker/config.json yet (store.init writes it), so the local page opens at the end
  const firstSetup = !fs.existsSync(path.join(store.dir, 'config.json'));
  store.init();
  ignoreLocalState(store.dir);

  // Header Banner (the installer draws the same box before it runs setup, so not twice)
  if (!process.env.THINKER_INSTALLER) out('\n' + banner() + '\n');
  out(`  ${c.dim('Repository')}  ${repo}\n`);

  out(stepBanner(1, 1, 'Connect your agents'));
  const connections = await stepConnectClis({
    repo,
    cliPath,
    mcpEntry,
    userMcpEntry,
    clients,
    hooks,
    learn,
    late,
    mcp,
    gitHook,
    noTrust,
    yes,
    proxy,
    out,
  });

  // The ranker: the model the hooks rank notes with is fetched once here (the installer and `thinker update` do
  // it too), so the first prompt does not pay the download
  try {
    const { rankerStatus, fetchRanker } = await import('./dense.js');
    const st = await rankerStatus();
    if (st.runtime && !st.model) await withSpinner(out, 'Fetching the ranking model (about 23 MB)', () => fetchRanker());
    const now = await rankerStatus();
    out(now.runtime && now.model ? `  ${c.green('✓')} Ranking model ready ${c.dim(`(${now.modelName})`)}` : `  ${c.yellow('○')} Ranking model not in place ${c.dim(now.runtime ? '(fetch failed; thinker ranker fetch)' : '(runtime missing: npm ci in the app directory, or thinker update)')}; notes are ranked by words alone until then`);
  } catch (e) { out(`  ${c.yellow('○')} Ranking model not fetched: ${String(e.message).split('\n')[0].slice(0, 120)}`); }

  // Where the agents' context goes in this repository, from its sessions so far: the report the installer runs
  // over the machine (context-machine.js), here for the one repository, kept for the page. Nothing to build and
  // no model call; nothing is printed where no session ran yet. On a terminal it is the installer's question
  // (setup/context-ask.js): the page in the browser, or the suggestions here as a list to pick from and apply.
  let contextAsked = null;
  try {
    const { contextView } = await import('./context-view.js');
    const { recommendations } = await import('./context-machine.js');
    const { writeSnapshot } = await import('./context-snapshot.js');
    const { askMachineReport } = await import('./setup/context-ask.js');
    const view = contextView(store, { days: 30 });
    if (view.sessions) {
      writeSnapshot(store, 30, view);
      out('');
      const name = path.basename(repo), one = { repo, name, checkout: repo };
      const r = { days: 30, repos: [{ id: repo, name, checkout: repo, sessions: view.sessions }], views: [{ ...one, view }], view };
      contextAsked = await askMachineReport({ r, recs: recommendations(view), store, out, browser: Boolean(dashboard), open: () => openDashboardFn({ repo, cliPath }) });
    }
  } catch (e) { out(`  ${c.yellow('○')} Context report not made: ${String(e.message).split('\n')[0].slice(0, 120)}`); }

  // The desired behaviors come from the design documents (behavior-docs.js); setup asks the person nothing
  // about them and only counts the drafts waiting for a decision.
  const { pendingBehaviors } = await import('./behavior-workbench.js');
  const left = pendingBehaviors(store).length;

  if (exportFile) {
    execFileSync('node', [cliPath, 'export', exportFile, '--repo', repo], { stdio: 'inherit' });
  }

  maybeSendDailyTelemetryInBackground({ home: thinkerHome(), cliPath, store, force: true, event: 'install' });

  // One result and one next action, with recovery guidance beside failures above.
  const connected = connections.filter(result => result.status === 'connected');
  const needsAttention = connections.some(result => result.status === 'error') || !connected.length;
  // What was done, then the one thing to do next: a session already running loaded its hooks and tools before this.
  const names = connected.map(result => result.name || result.client).join(', ');
  const count = store.list().length;
  const done = [
    `${needsAttention ? c.yellow('!') : c.green('✓')} ${c.bold(needsAttention ? 'Setup finished with items to review.' : 'Thinker is ready.')}`,
    '',
    c.bold('What was done'),
    connected.length ? `• Connected ${names}: hooks and tools` : `• No agent connected: ${c.cyan('thinker setup --clients <agent>')}`,
    `• Cache ${count ? `has ${count} note${count === 1 ? '' : 's'}` : 'starts empty'} and grows from your sessions`,
  ];
  if (left) done.push(`• ${left} behavior draft${left === 1 ? '' : 's'} waiting for your decision`);
  done.push('');
  if (connected.length) done.push(c.bold('Restart your agent: start a new session in this repository'), c.bold('so its hooks and tools load.'), '');
  done.push(`Notes, behaviors and usage in your browser: ${c.cyan('thinker ui')}`);
  if (learn) done.push(c.dim('Ongoing learning uses your agent to save knowledge from sessions.'));
  // telemetry carries counts only (telemetry.js:buildTelemetryPayload); no note or behavior text leaves the machine
  done.push(c.dim('Notes stay on this machine in .thinker/local/, which git ignores;'), c.dim('nothing needs committing and Thinker uploads none.'));
  out('\n' + finishBox(done, { ok: !needsAttention }) + '\n');
  // the page at the end, as before, unless the person was asked above and chose (the browser opened it already, the
  // terminal was their answer)
  if (dashboard && firstSetup && !contextAsked?.mode?.match(/^(browser|terminal)$/) && openDashboardFn({ repo, cliPath })) out(`  ${c.dim(`Opening the local page in your browser; open it again any time with ${c.cyan('thinker ui')}.`)}\n`);

  return { connections };
}
