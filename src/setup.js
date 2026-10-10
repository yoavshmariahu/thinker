// Thinker setup flow: connect coding agents, choose a cache build,
// estimating and building the codebase cache, and running an optional PR change benchmark.
// The flow is `runSetup` below; its parts are under src/setup/ (ui, agents, estimate, steps, pr-benchmark),
// all re-exported here so nothing else needs to know the layout.
import { chooseProject } from './setup/project.js';
import { projectFromFlags } from './project.js';
import { execFileSync } from 'node:child_process';
import { thinkerHome } from './update.js';
import { maybeSendDailyTelemetryInBackground } from './telemetry.js';
import { c, banner, stepBanner, finishBox, withSpinner } from './setup/ui.js';
import { githubSlug, buildAgent, checkAgentAuth, selectAndAuthenticateAgent } from './setup/agents.js';
import { estimateCacheBuild, depthLimits } from './setup/estimate.js';
import fs from 'node:fs';
import path from 'node:path';
import { stepConnectClis, ignoreLocalState, stepBuildCache, confirmCacheBuild, openDashboard } from './setup/steps.js';
import { stepPrBenchmark } from './setup/pr-benchmark.js';
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
  projectFlags = {},
  chooseProjectFn = chooseProject,
  prs = 60,
  prNumber = null,
  benchmark = false,
  noBenchmark = false,
  build = null,
  depth = null,
  behaviors = null,
  defineFn = null,
  noPrs = false,
  noPhrase = false,
  model,
  agent,
  yes = false,
  hooks = true,
  learn = true,
  late = false,
  mcp = true,
  gitHook = true,
  noTrust = false,
  exportFile = null,
  out = console.log,
  minePrsFn,
  checkAuthFn = checkAgentAuth,
  dashboard = false,
  openDashboardFn = openDashboard,
}) {
  // Validate explicit/saved selections before setup writes agent settings.
  projectFromFlags(repo, projectFlags);
  // first time here: no .thinker/config.json yet (store.init writes it), so the local page opens at the end
  const firstSetup = !fs.existsSync(path.join(store.dir, 'config.json'));
  store.init();
  ignoreLocalState(store.dir);

  // Header Banner (the installer draws the same box before it runs setup, so not twice)
  if (!process.env.THINKER_INSTALLER) out('\n' + banner() + '\n');
  out(`  ${c.dim('Repository')}  ${repo}\n`);

  out(stepBanner(1, 2, 'Connect your agents'));
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

  // Step 2: Build Knowledge Cache
  const slug = githubSlug(repo);

  out(stepBanner(2, 2, 'Choose how to start'));

  const project = await chooseProjectFn({ repo, flags: { ...projectFlags, yes }, out, interactive: !!process.stdin.isTTY && build !== false && !noPrs });
  const directories = project?.directories || null;

  let activeAgent = agent || buildAgent();
  let agentAuthed = false;
  let buildError = null;

  // --no-prs leaves nothing to spend on, so there is nothing to ask about
  let building = noPrs ? false : build;
  if (building === null) {
    const shallowLimits = depthLimits({ depth: 'shallow', prs });
    const answer = yes ? (depth || 'full') : await confirmCacheBuild({
      estimates: estimateCacheBuild(repo, { prs, directories, noPrs, slug, agent: activeAgent }),
      shallow: estimateCacheBuild(repo, { ...shallowLimits, directories, noPrs, slug, agent: activeAgent }),
      agent: activeAgent,
      out,
    });
    building = Boolean(answer);
    if (answer) depth = answer;
    if (building) out('');
  }
  // a shallow build is 30% of the full one: the first pull requests of the same order
  if (building && depth === 'shallow') ({ prs } = depthLimits({ depth, prs }));
  let effectiveNoPrs = noPrs || !building;

  if (!effectiveNoPrs) {
    const authResult = await selectAndAuthenticateAgent({
      requestedAgent: agent || null,
      clients,
      yes,
      out,
      purpose: 'build the knowledge cache',
      actionName: 'PR mining',
      allowSkip: false,
    checkAuthFn,
    });
    if (!authResult.ok) {
      // the repository is already wired up by step 1: say what was not built, and go on
      out(`\n  ${c.yellow('○')} ${c.bold('Cache not built here:')} reading the merged pull requests needs an authenticated agent.`);
      out(`    Run '${c.cyan(authResult.loginCmd || 'claude auth login')}', then: ${c.cyan('thinker setup --build')}`);
      out(`    ${c.dim('thinker is set up either way; without a built cache it grows from your own sessions.')}\n`);
      buildError = authResult.error;
      building = false;
      effectiveNoPrs = true;
    } else {
      activeAgent = authResult.agent;
      agentAuthed = true;
    }
  }

  if (activeAgent && agentAuthed) {
    if (!process.env.THINKER_LLM) process.env.THINKER_LLM_PREFER = activeAgent;
    process.env.THINKER_LLM = activeAgent;
  }

  const estimates = estimateCacheBuild(repo, { prs, directories, noPrs: effectiveNoPrs, slug, agent: activeAgent });

  const cacheRes = await stepBuildCache({
    repo,
    store,
    estimates,
    directories,
    prs,
    noPrs: effectiveNoPrs,
    noPhrase,
    model,
    agent: activeAgent,
    out,
    minePrsFn,
  });

  // The desired behaviors, written down with the person's own coding agent: setup prints the prompt
  // that starts the interview (setup/define.js) and does not run it. --no-behaviors leaves it out.
  const { pendingBehaviors } = await import('./behavior-workbench.js');
  const waiting = () => pendingBehaviors(store).length;
  const defineNow = behaviors !== false;
  if (defineNow) (defineFn || (await import('./setup/define.js')).printBehaviorSession)(store, { out });

  if (exportFile) {
    execFileSync('node', [cliPath, 'export', exportFile, '--repo', repo], { stdio: 'inherit' });
  }

  if (!noBenchmark && (benchmark || prNumber)) {
    out(`\n${c.bold('Compare agent performance')}\n`);
    await stepPrBenchmark({
      repo, store, prNumber,
      agent: agentAuthed ? activeAgent : (agent || null),
      model,
      budget: 1500,
      benchmarkFlag: benchmark,
      yes, out, checkAuthFn,
    });
  }

  // Telemetry notification
  maybeSendDailyTelemetryInBackground({ home: thinkerHome(), cliPath, store, force: true, event: 'install' });

  // One result and one next action, with recovery guidance beside failures above.
  const connected = connections.filter(result => result.status === 'connected');
  const needsAttention = cacheRes.warnings || connections.some(result => result.status === 'error') || !connected.length;
  const done = [
    `${needsAttention ? c.yellow('!') : c.green('✓')} ${c.bold(needsAttention ? 'Setup finished with items to review.' : 'Thinker is ready.')}`,
    '',
    connected.length ? 'Start a new agent session in this repository.' : `Connect an agent with: ${c.cyan('thinker setup --clients <agent>')}`,
    `Review a change against the cache: ${c.cyan('thinker review')}`,
  ];
  if (!building) done.push(`Build from existing code later: ${c.cyan('thinker setup --build')}`);
  const left = waiting();
  done.push(left ? `${left} behavior${left === 1 ? '' : 's'} waiting for your decision: ${c.cyan('thinker ui')}` : `Usage and behaviors in your browser: ${c.cyan('thinker ui')}`);
  if (!defineNow) done.push(`Define behaviors with your agent: ${c.cyan('thinker system define')}`);
  if (learn) done.push(c.dim('Ongoing learning uses your agent to save knowledge from sessions.'));
  // telemetry carries counts only (telemetry.js:buildTelemetryPayload); no note or behavior text leaves the machine
  done.push(c.dim('Notes and behaviors stay in .thinker/ here; Thinker uploads none.'));
  out('\n' + finishBox(done, { ok: !needsAttention }) + '\n');
  if (dashboard && firstSetup && openDashboardFn({ repo, cliPath })) out(`  ${c.dim(`Opening the local page in your browser; open it again any time with ${c.cyan('thinker ui')}.`)}\n`);

  return { built: building, warnings: cacheRes.warnings || 0, error: buildError };
}
