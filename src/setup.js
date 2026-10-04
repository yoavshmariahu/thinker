// Thinker setup flow: guided 3-step setup connecting harness CLIs,
// estimating and building the codebase cache, and running an optional PR change benchmark.
// The flow is `runSetup` below; its parts are under src/setup/ (ui, agents, estimate, steps, pr-benchmark),
// all re-exported here so nothing else needs to know the layout.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitHead } from './store.js';
import { orient } from './ops.js';
import { thinkerHome } from './update.js';
import { maybeSendDailyTelemetryInBackground } from './telemetry.js';
import { c, box, banner, stepBanner } from './setup/ui.js';
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
  shared = true,
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
  out(`  ${c.bold('Repository:')} ${repo}`);
  const head = gitHead(repo);
  if (head) out(`  ${c.bold('Git Commit:')} ${c.dim(String(head).slice(0, 10))}`);
  out(`  ${c.bold('Storage:')}    ${path.relative(process.cwd(), store.dir) || '.thinker/'}\n`);

  // Step 1: Connect Harness CLIs
  out(stepBanner(1, 3, 'Connect Harness CLIs', 'Detect and configure hooks & MCP server across coding agents'));
  await stepConnectClis({
    repo,
    cliPath,
    mcpEntry,
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

  out(stepBanner(2, 3, 'Build Knowledge Cache', 'Mine PR invariants and explore codebase topology'));

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

  // Step 3: Optional PR Change Benchmark
  out(stepBanner(3, 3, 'Optional PR Change Benchmark', 'Measure agent efficiency on a real PR change with vs without Thinker'));
  await stepPrBenchmark({
    repo,
    store,
    prNumber,
    agent: agentAuthed ? activeAgent : (agent || null),
    model,
    budget: 1500,
    benchmarkFlag: benchmark,
    // the benchmark compares an agent with and without the cache, so an unbuilt cache has
    // nothing to show — unless this run was asked for a benchmark by name
    noBenchmark: noBenchmark || (!building && !benchmark && !prNumber),
    skipReason: !noBenchmark && !building ? 'nothing to compare until the cache is built' : '--no-benchmark',
    yes,
    out,
    checkAuthFn,
});

  // Telemetry notification
  maybeSendDailyTelemetryInBackground({ home: thinkerHome(), cliPath, store, force: true, event: 'install' });

  // Completion footer
  out('\n' + box([
    cacheRes.warnings ? c.bold(c.yellow('⚠  Thinker configured; cache build had warnings.')) : c.bold(c.green('✔  Thinker setup complete!')),
    '',
    `Start your agent (${c.bold(activeAgent || 'claude')}) in this repository as usual.`,
    'Relevant codebase knowledge will automatically be injected into prompts.',
    ...(building ? [] : ['', `Build the cache from the code now: ${c.cyan('thinker setup --build')}`]),
    '',
    `Try searching cache:    ${c.cyan('thinker lookup "<query>"')}`,
    `Test prompt retrieval:  ${c.cyan('thinker orient "<task you want to work on>"')}`,
    `Benchmark a question:   ${c.cyan('thinker benchmark')}`,
    `Run PR benchmark:       ${c.cyan('thinker benchmark pr')}`,
  ], { width: 74, borderColor: 'green' }) + '\n');

  return { built: building, warnings: cacheRes.warnings || 0, error: buildError };
}
