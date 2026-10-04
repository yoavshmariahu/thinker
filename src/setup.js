// Thinker setup flow: connect coding agents, choose a cache build,
// estimating and building the codebase cache, and running an optional PR change benchmark.
// The flow is `runSetup` below; its parts are under src/setup/ (ui, agents, estimate, steps, pr-benchmark),
// all re-exported here so nothing else needs to know the layout.
import { execFileSync } from 'node:child_process';
import { thinkerHome } from './update.js';
import { maybeSendDailyTelemetryInBackground } from './telemetry.js';
import { c, banner, stepBanner } from './setup/ui.js';
import { githubSlug, exploreAgent, checkAgentAuth, selectAndAuthenticateAgent } from './setup/agents.js';
import { estimateCacheBuild } from './setup/estimate.js';
import { stepConnectClis, ignoreLocalState, stepBuildCache, confirmCacheBuild } from './setup/steps.js';
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
  areas = 12,
  prs = 60,
  prNumber = null,
  benchmark = false,
  noBenchmark = false,
  build = null,
  noSeed = false,
  noPrs = false,
  noPhrase = false,
  model,
  agent,
  yes = false,
  hooks = true,
  learn = true,
  late = false,
  shared = false,
  mcp = true,
  gitHook = true,
  noTrust = false,
  exportFile = null,
  out = console.log,
  seedFn,
  minePrsFn,
  checkAuthFn = checkAgentAuth,
}) {
  store.init();
  ignoreLocalState(store.dir);

  // Header Banner
  out('\n' + banner() + '\n');
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
    shared,
    mcp,
    gitHook,
    noTrust,
    yes,
    out,
  });

  // Step 2: Build Knowledge Cache
  const slug = githubSlug(repo);

  out(stepBanner(2, 2, 'Choose how to start'));

  let activeAgent = agent || exploreAgent();
  let agentAuthed = false;
  let buildError = null;

  // --no-seed --no-prs leaves nothing to spend on, so there is nothing to ask about
  let building = (noSeed && noPrs) ? false : build;
  if (building === null) {
    building = yes || await confirmCacheBuild({
      estimates: estimateCacheBuild(repo, { areas, prs, noSeed, noPrs, slug, agent: activeAgent }),
      agent: activeAgent,
      out,
    });
    if (building) out('');
  }
  let effectiveNoSeed = noSeed || !building;
  let effectiveNoPrs = noPrs || !building;

  if (!effectiveNoSeed || !effectiveNoPrs) {
    const authResult = await selectAndAuthenticateAgent({
      requestedAgent: agent || null,
      clients,
      yes,
      out,
      purpose: 'build the knowledge cache',
      actionName: 'subsystem exploration',
      allowSkip: false,
    checkAuthFn,
    });
    if (!authResult.ok) {
      // the repository is already wired up by step 1: say what was not built, and go on
      out(`\n  ${c.yellow('○')} ${c.bold('Cache not built here:')} reading the code and the merged pull requests needs an authenticated agent.`);
      out(`    Run '${c.cyan(authResult.loginCmd || 'claude auth login')}', then: ${c.cyan('thinker setup --build')}`);
      out(`    ${c.dim('thinker is set up either way; without a built cache it grows from your own sessions.')}\n`);
      buildError = authResult.error;
      building = false;
      effectiveNoSeed = effectiveNoPrs = true;
    } else {
      activeAgent = authResult.agent;
      agentAuthed = true;
    }
  }

  if (activeAgent && agentAuthed) {
    if (!process.env.THINKER_LLM) process.env.THINKER_LLM_PREFER = activeAgent;
    process.env.THINKER_LLM = activeAgent;
  }

  const estimates = estimateCacheBuild(repo, { areas, prs, noSeed: effectiveNoSeed, noPrs: effectiveNoPrs, slug, agent: activeAgent });

  const cacheRes = await stepBuildCache({
    repo,
    store,
    estimates,
    areas,
    prs,
    noSeed: effectiveNoSeed,
    noPrs: effectiveNoPrs,
    noPhrase,
    model,
    agent: activeAgent,
    out,
    seedFn,
    minePrsFn,
  });

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
  out(`\n  ${needsAttention ? c.yellow('!') : c.green('✓')} ${c.bold(needsAttention ? 'Setup finished with items to review.' : 'Thinker is ready.')}\n`);
  if (connected.length) out('  Start a new agent session in this repository.');
  else out('  Connect an agent with: thinker setup --clients <agent>');
  if (learn) out(`  ${c.dim('Ongoing learning uses your agent to save knowledge from sessions.')}`);
  if (!building) out(`\n  Build from existing code later: ${c.cyan('thinker setup --build')}`);
  out('');

  return { built: building, warnings: cacheRes.warnings || 0, error: buildError };
}
