// `thinker benchmark`: a paired, read-only comparison of an agent without and with the cache.
import { coveredBenchmarkQuestions, latestBenchmark, renderBenchmarkReport, runBenchmarkAgent, saveBenchmark, isAuthError, cleanErrorMessage } from '../benchmark.js';
import { orient } from '../ops.js';
import { stepPrBenchmark, selectAndAuthenticateAgent, getAgentLoginCommand } from '../setup.js';

async function benchmarkCommand(ctx) {
  const { pos, flags, repo, store, out } = ctx;
  const sub = pos.shift();
  if (sub === 'report') {
    out(renderBenchmarkReport(latestBenchmark(store)));
    return;
  }
  if (sub === 'pr') {
    const prNum = pos[0] && !pos[0].startsWith('-') ? Number(pos.shift()) : (flags.pr ? Number(flags.pr) : null);
    await stepPrBenchmark({
      repo,
      store,
      prNumber: prNum,
      agent: typeof flags.agent === 'string' ? flags.agent : undefined,
      model: typeof flags.model === 'string' ? flags.model : undefined,
      budget: Number(flags.budget) || 1500,
      benchmarkFlag: true,
      yes: Boolean(flags.yes),
      out,
    });
    return;
  }
  // `thinker benchmark "<question>"` is taken as `run`
  if (sub && sub !== 'run') pos.unshift(sub);
  let task = pos.join(' ').trim();
  if (!task) {
    // First run: nobody knows yet what the cache covers, so offer questions it does
    const questions = await coveredBenchmarkQuestions(store);
    if (!questions.length) { out('There are no usable benchmark topics in the cache yet. Build it first with `thinker setup`, then try again, or benchmark a recent PR change with `thinker benchmark pr`.'); process.exitCode = 1; return; }
    if (process.stdin.isTTY) {
      out('Benchmark thinker on a question the cache covers (two read-only agent calls: without and with thinker):\n');
      questions.forEach((q, i) => out(`  ${i + 1}. ${q}`));
      const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
      const a = await rl.question(`\nPick 1-${questions.length}, type your own question, or q to quit [1]: `).then(x => x.trim(), () => 'q'); rl.close(); // Ctrl-D quits
      if (/^q(uit)?$/i.test(a)) { out('To benchmark a recent PR change instead: thinker benchmark pr [number]'); return; }
      task = !a ? questions[0] : /^\d+$/.test(a) && questions[Number(a) - 1] ? questions[Number(a) - 1] : a;
    } else if (sub === 'run') {
      task = questions[0];
      out(`No question given; using one the cache covers: ${task}`);
    } else {
      const quote = text => `'${text.replaceAll("'", `'"'"'`)}'`;
      out('Run a benchmark in this repository on a question the cache covers:');
      for (const q of questions) out(`  thinker benchmark run ${quote(q)}`);
      out('\nOther benchmarks:\n  thinker benchmark pr [number]   paired benchmark on a recent PR change\n  thinker benchmark report        show the latest benchmark result\n\n`thinker benchmark run` with no question uses the first above. Each benchmark makes two read-only agent calls; answers are saved for review.');
      return;
    }
  }
  const authRes = await selectAndAuthenticateAgent({
    requestedAgent: typeof flags.agent === 'string' ? flags.agent : undefined,
    yes: Boolean(flags.yes),
    out,
    purpose: 'run the benchmark',
    actionName: 'benchmark',
    allowSkip: false,
  });
  if (!authRes.ok || !authRes.agent || authRes.skip) {
    process.exitCode = 1;
    return;
  }
  const selected = authRes.agent;
  const oriented = await orient(store, { task, budget: Number(flags.budget) || 1000, recordUsage: false, backgroundVerify: false });
  if (!oriented.included.length) {
    const suggestions = await coveredBenchmarkQuestions(store);
    out('Benchmark stopped: the cache does not have sufficiently relevant notes for that question. No agent calls were made, so no model usage was spent.');
    if (suggestions.length) {
      const quote = text => `'${text.replaceAll("'", `'"'"'`)}'`;
      out('\nTry a question the cache can cover instead:');
      for (const suggestion of suggestions) out(`  thinker benchmark run ${quote(suggestion)}`);
      out('\nSee every cached topic with `thinker list`.');
    } else out('\nThere are no usable benchmark topics in the cache yet. Build it first with `thinker setup`, then try again.');
    process.exitCode = 1; return;
  }
  const instruction = 'Read-only repository benchmark. Answer the request from the actual code. Be concrete and cite file:symbol locations. Do not edit files, run destructive commands, or change git state.';
  const baselinePrompt = `${instruction}\n\nREQUEST:\n${task}`;
  const cachePrompt = `${instruction}\n\n<thinker-cache>\n${oriented.text}\n</thinker-cache>\n\nUse relevant pointers above to avoid re-deriving known repository structure. Verify claims against code when needed.\n\nREQUEST:\n${task}`;
  out(`Running two read-only ${selected} calls for the same question (first without thinker, then with ${oriented.included.length} relevant notes).`);
  let baseline, cached;
  try {
    baseline = await runBenchmarkAgent(selected, { repo, prompt: baselinePrompt, model: typeof flags.model === 'string' ? flags.model : undefined, timeoutMs: Number(flags.timeout) ? Number(flags.timeout) * 1000 : undefined });
    out(`  no cache: ${Math.round(baseline.wallMs / 1000)}s${baseline.inputTokens ? `, ${baseline.inputTokens} input tokens` : ''}`);
    cached = await runBenchmarkAgent(selected, { repo, prompt: cachePrompt, model: typeof flags.model === 'string' ? flags.model : undefined, timeoutMs: Number(flags.timeout) ? Number(flags.timeout) * 1000 : undefined });
    out(`  thinker:  ${Math.round(cached.wallMs / 1000)}s${cached.inputTokens ? `, ${cached.inputTokens} input tokens` : ''}`);
  } catch (err) {
    if (isAuthError(err)) {
      const loginCmd = getAgentLoginCommand(selected);
      out(`\nBenchmark failed: ${selected} reported an authentication issue.`);
      const cleanMsg = cleanErrorMessage(err);
      if (cleanMsg) out(`  ${cleanMsg}`);
      out(`  Please sign in with '${loginCmd}' and retry.\n`);
      process.exitCode = 1;
      return;
    }
    out(`\nBenchmark failed: ${cleanErrorMessage(err)}\n`);
    process.exitCode = 1;
    return;
  }
  const record = { version: 1, createdAt: new Date().toISOString(), repo, task, agent: selected, model: typeof flags.model === 'string' ? flags.model : null, notes: oriented.included.map(n => n.id), runs: { baseline, cache: cached } };
  saveBenchmark(store, record);
  out('\n' + renderBenchmarkReport(record));
  return;
}

export const commands = {
  'benchmark': benchmarkCommand,
};
