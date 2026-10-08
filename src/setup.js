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
import { githubSlug, exploreAgent, checkAgentAuth, selectAndAuthenticateAgent } from './setup/agents.js';
import { estimateCacheBuild, depthLimits } from './setup/estimate.js';
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
  areas,
  projectFlags = {},
  chooseProjectFn = chooseProject,
  prs = 60,
  prNumber = null,
  benchmark = false,
  noBenchmark = false,
  build = null,
  depth = null,
  noSeed = false,
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
  seedFn,
  minePrsFn,
  checkAuthFn = checkAgentAuth,
}) {
  // Validate explicit/saved selections before setup writes agent settings.
  projectFromFlags(repo, projectFlags);
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

  const project = await chooseProjectFn({ repo, flags: { ...projectFlags, yes }, out, interactive: !!process.stdin.isTTY && build !== false && !(noSeed && noPrs) });
  const directories = project?.directories || null;

  let activeAgent = agent || exploreAgent();
  let agentAuthed = false;
  let buildError = null;

  // --no-seed --no-prs leaves nothing to spend on, so there is nothing to ask about
  let building = (noSeed && noPrs) ? false : build;
  if (building === null) {
    const shallowLimits = depthLimits(repo, { depth: 'shallow', areas, prs, directories });
    const answer = yes ? (depth || 'full') : await confirmCacheBuild({
      estimates: estimateCacheBuild(repo, { areas, prs, directories, noSeed, noPrs, slug, agent: activeAgent }),
      shallow: estimateCacheBuild(repo, { ...shallowLimits, directories, noSeed, noPrs, slug, agent: activeAgent }),
      agent: activeAgent,
      out,
    });
    building = Boolean(answer);
    if (answer) depth = answer;
    if (building) out('');
  }
  // a shallow build is 30% of the full one: the first areas and pull requests of the same order
  if (building && depth === 'shallow') ({ areas, prs } = depthLimits(repo, { depth, areas, prs, directories }));
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

  const estimates = estimateCacheBuild(repo, { areas, prs, directories, noSeed: effectiveNoSeed, noPrs: effectiveNoPrs, slug, agent: activeAgent });

  const cacheRes = await stepBuildCache({
    repo,
    store,
    estimates,
    directories,
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
  const done = [
    `${needsAttention ? c.yellow('!') : c.green('✓')} ${c.bold(needsAttention ? 'Setup finished with items to review.' : 'Thinker is ready.')}`,
    '',
    connected.length ? 'Start a new agent session in this repository.' : `Connect an agent with: ${c.cyan('thinker setup --clients <agent>')}`,
    `Review a change against the cache: ${c.cyan('thinker review')}`,
  ];
  if (!building) done.push(`Build from existing code later: ${c.cyan('thinker setup --build')}`);
  if (learn) done.push(c.dim('Ongoing learning uses your agent to save knowledge from sessions.'));
  out('\n' + finishBox(done, { ok: !needsAttention }) + '\n');

  return { built: building, warnings: cacheRes.warnings || 0, error: buildError };
}
