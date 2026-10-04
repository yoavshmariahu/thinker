// Step 3 of the guided setup: an optional benchmark on a recent merged pull request.
import path from 'node:path';
import readlinePromises from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import { orient } from '../ops.js';
import { runBenchmarkAgent, saveBenchmark, isAuthError, cleanErrorMessage } from '../benchmark.js';
import { c, box } from './ui.js';
import { hasBin, githubSlug, getAgentDisplayName, getAgentLoginCommand, checkAgentAuth, selectAndAuthenticateAgent } from './agents.js';

// --- Step 3: Optional PR Change Benchmark ------------------------------------

export function findRecentPrChange(repo, { slug = null, prNumber = null } = {}) {
  // 1. If explicit prNumber requested
  if (prNumber) {
    if (slug) {
      try {
        const raw = execFileSync('gh', ['pr', 'view', String(prNumber), '--repo', slug, '--json', 'number,title,body,files,mergedAt,additions,deletions'], {
          cwd: repo,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const p = JSON.parse(raw);
        return {
          number: p.number,
          title: p.title,
          body: p.body || '',
          files: (p.files || []).map(f => typeof f === 'string' ? f : f.path),
          additions: p.additions || 0,
          deletions: p.deletions || 0,
          mergedAt: p.mergedAt || null,
          source: 'github',
        };
      } catch {}
    }
    try {
      const commit = execFileSync('git', ['log', `--grep=#${prNumber}`, '-n', '1', '--format=%H'], { cwd: repo, encoding: 'utf8' }).trim();
      if (commit) {
        const title = execFileSync('git', ['log', '-1', '--format=%s', commit], { cwd: repo, encoding: 'utf8' }).trim();
        const body = execFileSync('git', ['log', '-1', '--format=%b', commit], { cwd: repo, encoding: 'utf8' }).trim();
        const filesRaw = execFileSync('git', ['diff', '--name-only', `${commit}^1`, commit], { cwd: repo, encoding: 'utf8' }).trim();
        const files = filesRaw.split('\n').filter(Boolean);
        return { number: Number(prNumber), title, body, files, additions: 0, deletions: 0, mergedAt: null, source: 'git-commit' };
      }
    } catch {}
  }

  // 2. Query GitHub for recent merged PR
  if (slug && hasBin('gh')) {
    try {
      const raw = execFileSync('gh', ['pr', 'list', '--repo', slug, '--state', 'merged', '--limit', '10', '--json', 'number,title,body,files,mergedAt,additions,deletions'], {
        cwd: repo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const list = JSON.parse(raw);
      const candidates = list.filter(p => {
        if (!p.files || p.files.length === 0) return false;
        const title = p.title || '';
        return !/^(chore|deps|docs|ci|build|release)\b|bump|dependabot|renovate/i.test(title);
      });
      const pick = candidates[0] || list.find(p => p.files && p.files.length > 0);
      if (pick) {
        return {
          number: pick.number,
          title: pick.title,
          body: pick.body || '',
          files: (pick.files || []).map(f => typeof f === 'string' ? f : f.path),
          additions: pick.additions || 0,
          deletions: pick.deletions || 0,
          mergedAt: pick.mergedAt || null,
          source: 'github',
        };
      }
    } catch {}
  }

  // 3. Fallback to git log merge commits
  try {
    const raw = execFileSync('git', ['log', '--merges', '-n', '15', '--format=%H\t%s'], { cwd: repo, encoding: 'utf8' });
    const lines = raw.split('\n').filter(Boolean);
    for (const line of lines) {
      const [commit, subject] = line.split('\t');
      if (!commit || !subject) continue;
      const m = subject.match(/#(\d+)/);
      const prNum = m ? parseInt(m[1], 10) : null;
      let files = [];
      try {
        const filesRaw = execFileSync('git', ['diff', '--name-only', `${commit}^1`, commit], { cwd: repo, encoding: 'utf8' });
        files = filesRaw.split('\n').filter(Boolean);
      } catch {}
      if (files.length > 0 && !/^(chore|deps|bump|ci)\b/i.test(subject)) {
        let body = '';
        try { body = execFileSync('git', ['log', '-1', '--format=%b', commit], { cwd: repo, encoding: 'utf8' }).trim(); } catch {}
        return {
          number: prNum,
          title: subject,
          body,
          files,
          additions: 0,
          deletions: 0,
          mergedAt: null,
          source: 'git-commit',
        };
      }
    }
  } catch {}

  // 4. Fallback to latest substantial commit
  try {
    const raw = execFileSync('git', ['log', '-n', '10', '--format=%H\t%s'], { cwd: repo, encoding: 'utf8' });
    const lines = raw.split('\n').filter(Boolean);
    for (const line of lines) {
      const [commit, subject] = line.split('\t');
      if (!commit || !subject) continue;
      let files = [];
      try {
        const filesRaw = execFileSync('git', ['diff', '--name-only', `${commit}^1`, commit], { cwd: repo, encoding: 'utf8' });
        files = filesRaw.split('\n').filter(Boolean);
      } catch {}
      if (files.length >= 2 && !/^(chore|deps|bump|ci)\b/i.test(subject)) {
        let body = '';
        try { body = execFileSync('git', ['log', '-1', '--format=%b', commit], { cwd: repo, encoding: 'utf8' }).trim(); } catch {}
        const m = subject.match(/#(\d+)/);
        const prNum = m ? parseInt(m[1], 10) : null;
        return {
          number: prNum,
          title: subject,
          body,
          files,
          additions: 0,
          deletions: 0,
          mergedAt: null,
          source: 'git-commit',
        };
      }
    }
  } catch {}

  return null;
}

export function buildPrBenchmarkTask(pr) {
  const prLabel = pr.number ? `PR #${pr.number}: ${pr.title}` : `Recent Change: ${pr.title}`;
  const context = pr.body ? `\n\nCONTEXT:\n${pr.body.slice(0, 1500)}` : '';
  return `${prLabel}${context}\n\nTASK:\nExplain the architectural root cause and codebase implementation required for this change. Identify which specific files and symbols must be modified and what invariants or conventions must be maintained.`;
}

export function renderPrBenchmarkReport(record) {
  const { runs, pr, agent, model, notes = [] } = record;
  const a = runs.baseline;
  const b = runs.cache;

  const pct = (before, after) => before ? Math.round(((after - before) / before) * 100) : 0;
  const pctStr = p => `${p > 0 ? '+' : ''}${p}%`;

  const prHeader = pr?.number ? `PR #${pr.number}: ${pr.title}` : (pr?.title || record.task);

  const rows = [
    {
      metric: 'Wall Time',
      base: `${(a.wallMs / 1000).toFixed(1)}s`,
      thinker: `${(b.wallMs / 1000).toFixed(1)}s`,
      change: pctStr(pct(a.wallMs, b.wallMs)),
      impact: pct(a.wallMs, b.wallMs) < 0 ? '⚡ Faster' : '',
    },
    a.turns != null && b.turns != null ? {
      metric: 'Agent Turns',
      base: String(a.turns),
      thinker: String(b.turns),
      change: pctStr(pct(a.turns, b.turns)),
      impact: pct(a.turns, b.turns) < 0 ? '⚡ Fewer turns' : '',
    } : null,
    a.toolCalls != null && b.toolCalls != null ? {
      metric: 'Tool Calls',
      base: String(a.toolCalls),
      thinker: String(b.toolCalls),
      change: pctStr(pct(a.toolCalls, b.toolCalls)),
      impact: pct(a.toolCalls, b.toolCalls) < 0 ? '⚡ Less exploration' : '',
    } : null,
    {
      metric: 'Input Tokens',
      base: (a.inputTokens || 0).toLocaleString(),
      thinker: (b.inputTokens || 0).toLocaleString(),
      change: pctStr(pct(a.inputTokens, b.inputTokens)),
      impact: a.inputTokens > b.inputTokens ? `💰 Saved ${(a.inputTokens - b.inputTokens).toLocaleString()} tokens` : '',
    },
    {
      metric: 'Output Tokens',
      base: (a.outputTokens || 0).toLocaleString(),
      thinker: (b.outputTokens || 0).toLocaleString(),
      change: pctStr(pct(a.outputTokens, b.outputTokens)),
      impact: a.outputTokens > b.outputTokens ? `💰 Saved ${(a.outputTokens - b.outputTokens).toLocaleString()} tokens` : '',
    },
    a.targetFilesFound != null && b.targetFilesFound != null ? {
      metric: 'Target Files Found',
      base: `${a.targetFilesFound}/${a.targetFilesTotal}`,
      thinker: `${b.targetFilesFound}/${b.targetFilesTotal}`,
      change: pctStr(pct(a.targetFilesFound, b.targetFilesFound)),
      impact: b.targetFilesFound >= a.targetFilesFound ? '🎯 Accurate anchoring' : '',
    } : null,
  ].filter(Boolean);

  const totalTokensSaved = ((a.inputTokens || 0) + (a.outputTokens || 0)) - ((b.inputTokens || 0) + (b.outputTokens || 0));
  const timeSaved = ((a.wallMs - b.wallMs) / 1000).toFixed(1);

  const tableLines = [
    `  ${c.dim('Metric'.padEnd(22))} ${c.dim('Without Cache'.padStart(14))} ${c.dim('With Thinker'.padStart(16))}   ${c.dim('Impact')}`,
    `  ${'─'.repeat(70)}`,
  ];

  for (const r of rows) {
    const mStr = r.metric.padEnd(22);
    const bStr = r.base.padStart(14);
    const tStr = r.thinker.padStart(16);
    const cStr = r.change.padStart(6);
    tableLines.push(`  ${mStr} ${bStr} ${tStr}   ${cStr}  ${r.impact}`);
  }

  tableLines.push(`  ${'─'.repeat(70)}`);

  const summaryLine = totalTokensSaved > 0
    ? `  ${c.bold(c.green('Net Savings:'))} ${c.bold(totalTokensSaved.toLocaleString())} tokens saved · ${Math.abs(parseFloat(timeSaved))}s faster`
    : `  ${c.bold('Comparison Complete')} · Answers saved for human inspection`;

  const bannerBox = box([
    c.bold(c.cyan('PR Change Benchmark Results')),
    c.bold(prHeader.slice(0, 68)),
  ], { width: 74, borderColor: 'cyan' });

  return [
    bannerBox,
    '',
    `  Agent: ${c.bold(agent)}${model ? ` (${model})` : ''} · ${notes.length} relevant note${notes.length === 1 ? '' : 's'} injected into Thinker arm`,
    pr?.files?.length ? `  Target Files: ${c.dim(pr.files.slice(0, 4).join(', '))}${pr.files.length > 4 ? c.dim(` (+${pr.files.length - 4} more)`) : ''}` : '',
    '',
    ...tableLines,
    summaryLine,
    '',
    `  Artifacts preserved in: ${c.dim(record.dir || '.thinker/benchmarks/')}`,
  ].filter(Boolean).join('\n');
}

export async function stepPrBenchmark({
  repo,
  store,
  prNumber,
  agent: requestedAgent,
  model,
  budget = 1500,
  benchmarkFlag = false,
  noBenchmark = false,
  skipReason = '--no-benchmark',
  yes = false,
  out = console.log,
  checkAuthFn = checkAgentAuth,
  execFileFn = execFileSync,
  readlineFn = null,
  runBenchmarkFn = runBenchmarkAgent,
}) {
  if (noBenchmark) {
    out(`  ${c.gray('○')} PR change benchmark skipped (${skipReason}).`);
    return null;
  }

  const slug = githubSlug(repo);
  const pr = findRecentPrChange(repo, { slug, prNumber });

  if (!pr) {
    out(`  ${c.gray('○')} No recent PR or multi-file change found to benchmark.`);
    out(`    ${c.dim('You can benchmark a question the cache covers later: thinker benchmark')}`);
    return null;
  }

  out(`  ${c.bold('Recent PR change detected:')}`);
  const prTitle = pr.number ? `PR #${pr.number}: ${pr.title}` : pr.title;
  out(`    ${c.cyan(prTitle)}`);
  if (pr.files?.length) {
    out(`    Changed files: ${c.dim(pr.files.slice(0, 5).join(', '))}${pr.files.length > 5 ? c.dim(` (+${pr.files.length - 5} more)`) : ''}`);
  }
  out('');

  let shouldRun = Boolean(benchmarkFlag);
  if (!shouldRun) {
    if (yes) {
      shouldRun = true;
    } else if (readlineFn || process.stdin.isTTY) {
      const rl = readlineFn ? readlineFn() : readlinePromises.createInterface({ input: process.stdin, output: process.stdout });
      const a = await rl.question(`  Run paired benchmark on this PR change? [Y/n] `);
      rl.close();
      shouldRun = !/^n/i.test(a.trim());
    }
  }

  if (!shouldRun) {
    out(`  ${c.gray('○')} Benchmark skipped.`);
    out(`    ${c.dim(`To benchmark this PR later: thinker benchmark pr ${pr.number || ''}`)}`);
    return null;
  }

  const authRes = await selectAndAuthenticateAgent({
    requestedAgent,
    yes,
    out,
    checkAuthFn,
    execFileFn,
    readlineFn,
    purpose: 'run the benchmark',
    actionName: 'benchmark',
    allowSkip: true,
  });

  if (!authRes.ok || authRes.skip || authRes.skipExploration) {
    out(`  ${c.gray('○')} Benchmark skipped.`);
    out(`    ${c.dim(`To benchmark this PR later: thinker benchmark pr ${pr.number || ''}`)}`);
    return null;
  }

  const selectedAgent = authRes.agent;

  const task = buildPrBenchmarkTask(pr);
  const oriented = await orient(store, {
    task: `${pr.title} ${(pr.files || []).join(' ')}`,
    budget,
    recordUsage: false,
    backgroundVerify: false,
  });

  out(`  ${c.cyan('Running paired benchmark with')} ${c.bold(getAgentDisplayName(selectedAgent))} (${selectedAgent})...`);
  const instruction = 'Read-only repository benchmark. Answer the request from the actual code. Be concrete and cite file:symbol locations. Do not edit files, run destructive commands, or change git state.';
  const baselinePrompt = `${instruction}\n\nREQUEST:\n${task}`;
  const cachePrompt = `${instruction}\n\n<thinker-cache>\n${oriented.text}\n</thinker-cache>\n\nUse relevant pointers above to avoid re-deriving known repository structure. Verify claims against code when needed.\n\nREQUEST:\n${task}`;

  let baseline, cached;
  try {
    out(`  ${c.bold('[1/2] Baseline run (without cache)...')}`);
    baseline = await runBenchmarkFn(selectedAgent, { repo, prompt: baselinePrompt, model });
    out(`        ✔ Completed in ${(baseline.wallMs / 1000).toFixed(1)}s (${baseline.inputTokens || 0} input tokens)`);

    out(`  ${c.bold(`[2/2] Thinker run (with ${oriented.included.length} relevant notes)...`)}`);
    cached = await runBenchmarkFn(selectedAgent, { repo, prompt: cachePrompt, model });
    out(`        ✔ Completed in ${(cached.wallMs / 1000).toFixed(1)}s (${cached.inputTokens || 0} input tokens)`);
  } catch (err) {
    if (isAuthError(err)) {
      const loginCmd = getAgentLoginCommand(selectedAgent);
      out(`\n  ${c.yellow('⚠')} Benchmark stopped: ${c.bold(selectedAgent)} reported an authentication issue.`);
      const cleanMsg = cleanErrorMessage(err);
      if (cleanMsg) out(`    ${c.dim(cleanMsg)}`);
      out(`    Please sign in with '${c.cyan(loginCmd)}' and retry: ${c.cyan(`thinker benchmark pr ${pr.number || ''}`)}\n`);
      return null;
    }
    out(`\n  ${c.yellow('⚠')} Benchmark failed: ${cleanErrorMessage(err)}\n`);
    return null;
  }

  // Target files precision evaluation
  const targetFiles = (pr.files || []).filter(f => !f.startsWith('.') && !f.endsWith('.md') && !f.endsWith('.txt')).slice(0, 8);
  if (targetFiles.length > 0) {
    const baseHits = targetFiles.filter(f => baseline.answer.includes(f) || baseline.answer.includes(path.basename(f)));
    baseline.targetFilesFound = baseHits.length;
    baseline.targetFilesTotal = targetFiles.length;

    const cacheHits = targetFiles.filter(f => cached.answer.includes(f) || cached.answer.includes(path.basename(f)));
    cached.targetFilesFound = cacheHits.length;
    cached.targetFilesTotal = targetFiles.length;
  }

  const record = {
    version: 1,
    createdAt: new Date().toISOString(),
    repo,
    task,
    pr: {
      number: pr.number,
      title: pr.title,
      files: targetFiles,
      source: pr.source,
    },
    agent: selectedAgent,
    model: model || null,
    notes: oriented.included.map(n => n.id),
    runs: { baseline, cache: cached },
  };

  saveBenchmark(store, record);
  out('\n' + renderPrBenchmarkReport(record));
  return record;
}
