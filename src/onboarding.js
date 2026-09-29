// Thinker onboarding flow: guided 3-step onboarding connecting harness CLIs,
// estimating and building the codebase cache, and running an optional PR change benchmark.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { Store, gitHead } from './store.js';
import { orient, linkNotes, phraseNotes } from './ops.js';
import { mineCochange } from './cochange.js';
import { listMergedPrs, distillPr, minedPrs, recordMinedPrs, nextPrs, stratifyPrs } from './prs.js';
import { discoverAreas } from './topology.js';
import { CLIENTS, detectClients, parseClients, installClient, trustCodex } from './clients.js';
import { available, provider, findBin, BINS } from './llm.js';
import { benchmarkAgent, benchmarkSuggestions, runBenchmarkAgent, saveBenchmark } from './benchmark.js';
import { thinkerHome } from './update.js';
import { maybeSendDailyTelemetryInBackground } from './telemetry.js';

// --- Visual & ANSI Styling ---------------------------------------------------

const isColor = () => !process.env.NO_COLOR && (Boolean(process.stdout.isTTY) || Boolean(process.env.FORCE_COLOR));

export const c = {
  bold: s => isColor() ? `\x1b[1m${s}\x1b[0m` : String(s),
  dim: s => isColor() ? `\x1b[2m${s}\x1b[0m` : String(s),
  cyan: s => isColor() ? `\x1b[36m${s}\x1b[0m` : String(s),
  green: s => isColor() ? `\x1b[32m${s}\x1b[0m` : String(s),
  yellow: s => isColor() ? `\x1b[33m${s}\x1b[0m` : String(s),
  blue: s => isColor() ? `\x1b[34m${s}\x1b[0m` : String(s),
  magenta: s => isColor() ? `\x1b[35m${s}\x1b[0m` : String(s),
  red: s => isColor() ? `\x1b[31m${s}\x1b[0m` : String(s),
  gray: s => isColor() ? `\x1b[90m${s}\x1b[0m` : String(s),
  white: s => isColor() ? `\x1b[37m${s}\x1b[0m` : String(s),
};

export const stripAnsi = s => String(s).replace(/\x1b\[[0-9;]*m/g, '');

export function box(lines, { title = '', width = 76, borderColor = 'cyan' } = {}) {
  const maxLineLen = Math.max(...lines.map(l => stripAnsi(l).length), stripAnsi(title).length + 2);
  const actualWidth = Math.max(width, maxLineLen + 6);
  const bColor = c[borderColor] || c.cyan;
  const topBorder = title
    ? `╭─ ${c.bold(title)} ${'─'.repeat(Math.max(0, actualWidth - stripAnsi(title).length - 5))}╮`
    : `╭${'─'.repeat(actualWidth - 2)}╮`;
  const bottomBorder = `╰${'─'.repeat(actualWidth - 2)}╯`;

  const innerWidth = actualWidth - 4;
  const formattedLines = lines.map(line => {
    const raw = stripAnsi(line);
    const pad = Math.max(0, innerWidth - raw.length);
    return `${bColor('│')}  ${line}${' '.repeat(pad)}${bColor('│')}`;
  });

  return [bColor(topBorder), ...formattedLines, bColor(bottomBorder)].join('\n');
}

export function banner() {
  return box([
    c.bold(c.cyan('🧠  T H I N K E R')),
    c.dim('Universal Codebase Knowledge Cache for Coding Agents'),
  ], { width: 74, borderColor: 'cyan' });
}

export function stepBanner(stepNum, totalSteps, title, subtitle = '') {
  const headerText = `STEP ${stepNum} OF ${totalSteps} · ${title}`;
  const fillLen = Math.max(4, 72 - headerText.length - 4);
  const border = '─'.repeat(fillLen);
  const header = `${c.cyan(c.bold(`─── ${headerText} `))}${c.dim(border)}`;
  return subtitle ? `\n${header}\n${c.dim(subtitle)}\n` : `\n${header}\n`;
}

export function formatDuration(sec) {
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const hasBin = b => {
  try { execFileSync(b, ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
};

export function githubSlug(repo) {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/);
    return m ? m[1] : null;
  } catch { return null; }
}

// the agent that explores: THINKER_LLM if set, else first available
export function exploreAgent() {
  const agents = available().filter(p => ['claude', 'gemini', 'codex', 'cursor'].includes(p));
  return agents.includes(process.env.THINKER_LLM) ? process.env.THINKER_LLM : agents[0] || null;
}

// --- Pre-flight Cache Estimation ---------------------------------------------

export function estimateCacheBuild(repo, { areas = 12, prs = 60, noSeed = false, noPrs = false, slug = null, agent = null } = {}) {
  let commitCount = 0;
  try {
    const raw = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    commitCount = parseInt(raw, 10) || 0;
  } catch {}

  let fileCount = 0;
  try {
    const raw = execFileSync('git', ['ls-files'], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    fileCount = raw ? raw.split('\n').filter(Boolean).length : 0;
  } catch {}

  let candidateAreas = [];
  try {
    candidateAreas = discoverAreas(repo, { limit: areas });
  } catch {}

  const canMine = Boolean(slug && !noPrs && hasBin('gh') && prs > 0);
  const canSeed = Boolean(!noSeed && agent && areas > 0 && candidateAreas.length > 0);

  // Co-change mining timing estimate
  const cochangeSec = commitCount > 500 ? 2.5 : (commitCount > 50 ? 1.5 : 0.5);

  // PR mining timing estimate (~2s per PR)
  const prsCount = canMine ? Math.min(prs, 40) : 0;
  const prsSec = canMine ? Math.round(prsCount * 2.2) : 0;

  // Area exploration timing estimate (~12s per area)
  const areasCount = canSeed ? Math.min(areas, candidateAreas.length) : 0;
  const areasSec = canSeed ? Math.round(areasCount * 12) : 0;

  const indexingSec = 3;
  const totalSec = cochangeSec + prsSec + areasSec + indexingSec;

  // Size estimates
  const estPrNotes = canMine ? Math.round(prsCount * 0.7) : 0;
  const estAreaNotes = canSeed ? Math.round(areasCount * 2.5) : 0;
  const minNotes = Math.max(5, estPrNotes + estAreaNotes + 5);
  const maxNotes = Math.max(minNotes + 8, Math.round(minNotes * 1.4));

  const cochangeBytes = Math.min(Math.max(12 * 1024, fileCount * 100), 75 * 1024);
  const prsMetaBytes = 6 * 1024;
  const minBytes = (minNotes * 2000) + cochangeBytes + prsMetaBytes;
  const maxBytes = (maxNotes * 2600) + cochangeBytes + prsMetaBytes;

  const storeDir = path.join(repo, '.thinker');

  return {
    repo,
    repoName: path.basename(repo),
    commitCount,
    fileCount,
    candidateAreasCount: candidateAreas.length,
    canMine,
    canSeed,
    timing: {
      totalSeconds: totalSec,
      formatted: formatDuration(totalSec),
      breakdown: {
        cochange: formatDuration(cochangeSec),
        prs: canMine ? formatDuration(prsSec) : 'skipped',
        exploration: canSeed ? formatDuration(areasSec) : 'skipped',
        indexing: formatDuration(indexingSec),
      },
    },
    size: {
      minNotes,
      maxNotes,
      notesRange: `~${minNotes}–${maxNotes} notes`,
      minBytes,
      maxBytes,
      bytesRange: `${formatBytes(minBytes)} – ${formatBytes(maxBytes)}`,
    },
    storage: {
      rootDir: path.relative(process.cwd(), storeDir) || '.thinker/',
      notesDir: path.relative(process.cwd(), path.join(storeDir, 'notes')) || '.thinker/notes/',
      cochangeFile: path.relative(process.cwd(), path.join(storeDir, 'cochange.json')) || '.thinker/cochange.json',
      prsFile: path.relative(process.cwd(), path.join(storeDir, 'prs.json')) || '.thinker/prs.json',
      stateDir: path.relative(process.cwd(), path.join(storeDir, 'state')) || '.thinker/state/',
    },
    costEstimate: (canSeed ? areasCount * 0.45 : 0) + (canMine ? prsCount * 0.06 : 0),
  };
}

// --- Step 1: Connect Harness CLIs --------------------------------------------

export async function stepConnectClis({ repo, cliPath, mcpEntry, clients, hooks = true, learn = true, late = false, shared = true, mcp = true, gitHook = false, noTrust = false, yes = false, out = console.log }) {
  const detected = detectClients();
  const targetClients = clients || detected;

  const clientMeta = {
    claude: { name: 'Claude Code', bin: 'claude', desc: 'Anthropic Claude Code CLI' },
    codex: { name: 'OpenAI Codex', bin: 'codex', desc: 'OpenAI Codex CLI' },
    cursor: { name: 'Cursor Agent', bin: 'agent / cursor', desc: 'Cursor Editor & Agent CLI' },
    gemini: { name: 'Gemini / Agy', bin: 'agy / gemini', desc: 'Google Antigravity & Gemini CLI' },
  };

  const results = [];

  for (const client of CLIENTS) {
    const isTarget = targetClients.includes(client);
    const isDetected = detected.includes(client);

    if (!isTarget && !isDetected) {
      results.push({ client, status: 'skipped', detail: 'Not detected on PATH' });
      continue;
    }

    if (!isTarget && isDetected) {
      results.push({ client, status: 'skipped', detail: 'Omitted from --clients selection' });
      continue;
    }

    try {
      const logs = installClient(client, {
        repo,
        cli: cliPath,
        mcpEntry,
        hooks,
        learn,
        late,
        shared,
        mcp,
      });

      // Special handling for Codex trust
      if (client === 'codex' && (hooks || mcp) && !noTrust) {
        let ok = Boolean(yes);
        if (!ok && process.stdin.isTTY) {
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const a = await rl.question(`  Codex: Mark repository as trusted and hooks as reviewed in ~/.codex/config.toml? [Y/n] `);
          rl.close();
          ok = !/^n/i.test(a.trim());
        }
        if (ok) {
          trustCodex(repo);
          logs.push('Codex: project trust & reviewed hook hashes saved in ~/.codex/config.toml');
        }
      }

      // Special handling for Cursor MCP workspace approval
      if (client === 'cursor') {
        const agentBin = findBin(['agent', 'cursor-agent']);
        if (agentBin) {
          try {
            spawnSync(agentBin, ['mcp', 'enable', 'thinker'], { cwd: repo, encoding: 'utf8', timeout: 15_000 });
            logs.push('Cursor: workspace MCP server approved via agent CLI');
          } catch {}
        }
      }

      results.push({ client, status: 'connected', logs });
    } catch (e) {
      results.push({ client, status: 'error', detail: e.message });
    }
  }

  // Display clean CLI connection statuses
  for (const res of results) {
    const meta = clientMeta[res.client];
    const clientLabel = (meta ? meta.name : res.client).padEnd(20);

    if (res.status === 'connected') {
      const cleanLog = msg => String(msg).replace(/^(Claude Code|OpenAI Codex|Codex|Cursor Agent|Cursor|Gemini CLI|Gemini):\s*/i, '');
      out(`  ${c.green('✔')} ${c.bold(clientLabel)} ${c.green('Connected')} · ${c.dim(cleanLog(res.logs[0]) || 'Hooks & MCP configured')}`);
      if (res.logs.length > 1) {
        for (const extra of res.logs.slice(1)) {
          out(`    ${c.dim('↳')} ${c.dim(cleanLog(extra))}`);
        }
      }
    } else if (res.status === 'skipped') {
      out(`  ${c.gray('○')} ${c.dim(clientLabel)} ${c.dim(`Skipped · ${res.detail}`)}`);
    } else {
      out(`  ${c.red('✖')} ${c.bold(clientLabel)} ${c.red(`Failed · ${res.detail}`)}`);
    }
  }

  if (gitHook) {
    const hook = path.join(repo, '.git', 'hooks', 'post-commit');
    if (fs.existsSync(hook) && !fs.readFileSync(hook, 'utf8').includes('thinker')) {
      out(`  ${c.yellow('⚠')} ${c.dim('Git post-commit hook skipped (existing hook is not ours)')}`);
    } else {
      fs.writeFileSync(hook, `#!/bin/sh\n# thinker: re-hash note dependencies\nnohup node "${cliPath}" check --quiet --repo "${repo}" >/dev/null 2>&1 &\n`, { mode: 0o755 });
      out(`  ${c.green('✔')} ${c.bold('Git Post-Commit'.padEnd(20))} ${c.green('Connected')} · ${c.dim('.git/hooks/post-commit')}`);
    }
  }

  const connectedCount = results.filter(r => r.status === 'connected').length;
  out(`\n  ${c.cyan('Summary:')} ${c.bold(connectedCount)} of ${CLIENTS.length} harness CLIs connected and configured.`);
  return results;
}

// --- Step 2: Build Knowledge Cache -------------------------------------------

export async function stepBuildCache({ repo, store, estimates, areas = 12, prs = 60, noSeed = false, noPrs = false, noPhrase = false, model, agent, yes = false, out = console.log, seedFn, minePrsFn }) {
  out(`  ${c.bold('Pre-flight estimates for this repository:')}`);
  out(`    • ${c.bold('Target storage:')}     ${c.cyan(estimates.storage.rootDir)} ${c.dim(`(notes in ${estimates.storage.notesDir})`)}`);
  out(`    • ${c.bold('Estimated size:')}     ${c.cyan(estimates.size.notesRange)} ${c.dim(`(${estimates.size.bytesRange} on disk)`)}`);
  out(`    • ${c.bold('Estimated build:')}    ${c.cyan(estimates.timing.formatted)} ${c.dim(`(co-change ${estimates.timing.breakdown.cochange}, PRs ${estimates.timing.breakdown.prs}, explore ${estimates.timing.breakdown.exploration})`)}`);
  if (estimates.costEstimate > 0) {
    out(`    • ${c.bold('Model usage:')}       ${c.dim(`~$${estimates.costEstimate.toFixed(2)} via your ${agent || provider()} login`)}`);
  }
  out('');

  if (!yes && estimates.timing.totalSeconds > 10 && process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const a = await rl.question(`  Proceed with building the cache? [Y/n] `);
    rl.close();
    if (/^n/i.test(a.trim())) {
      out(`  ${c.yellow('○')} Cache build skipped by user.`);
      return { skipped: true, notes: store.list() };
    }
  }

  // Stage 1: Co-change mining
  out(`  ${c.bold('[1/4] Mining co-change patterns from git history...')}`);
  try {
    const idx = mineCochange(repo, { commits: 800 });
    const pairingsCount = Object.keys(idx.totals || {}).length;
    out(`        ${c.green('✔')} Mined ${idx.commits} commits → ${pairingsCount} files indexed in ${c.dim(estimates.storage.cochangeFile)}`);
  } catch (e) {
    out(`        ${c.yellow('⚠')} Co-change mining skipped: ${e.message}`);
  }

  // Stage 2: Merged PR mining
  const slug = githubSlug(repo);
  let minedPrCount = 0;
  if (estimates.canMine && minePrsFn) {
    out(`  ${c.bold(`[2/4] Mining merged PRs from ${slug}...`)}`);
    try {
      const res = await minePrsFn(slug, { limit: prs, model });
      minedPrCount = res.saved || 0;
      out(`        ${c.green('✔')} Mined pull requests → ${minedPrCount} notes created`);
    } catch (e) {
      out(`        ${c.yellow('⚠')} PR mining skipped: ${e.message}`);
    }
  } else {
    out(`  ${c.dim('[2/4] Merged PR mining · Skipped (requires GitHub repo and gh CLI)')}`);
  }

  // Stage 3: Subsystem area exploration
  let seedCount = 0;
  if (estimates.canSeed && seedFn) {
    out(`  ${c.bold(`[3/4] Exploring architectural subsystems with ${agent}...`)}`);
    try {
      const res = await seedFn({ areas, model, agent });
      seedCount = res.ok || 0;
      out(`        ${c.green('✔')} Explored ${seedCount} subsystems → architectural notes generated`);
    } catch (e) {
      out(`        ${c.yellow('⚠')} Exploration skipped: ${e.message}`);
    }
  } else {
    out(`  ${c.dim('[3/4] Subsystem exploration · Skipped (run `thinker seed` anytime)')}`);
  }

  // Stage 4: Cross-note linking and phrasings
  out(`  ${c.bold('[4/4] Linking cross-note dependencies and search phrasings...')}`);
  const notes = store.list();
  for (const n of notes) linkNotes(store, n, notes);
  out(`        ${c.green('✔')} Linked ${notes.length} notes across symbol dependencies`);

  if (notes.length && !noPhrase && provider()) {
    try {
      await phraseNotes(store, notes, { model });
      out(`        ${c.green('✔')} Generated user-intent search phrasings`);
    } catch {}
  }

  // Final cache stats
  const finalNotes = store.list();
  let totalBytes = 0;
  try {
    const noteFiles = fs.readdirSync(store.notesDir);
    for (const f of noteFiles) {
      totalBytes += fs.statSync(path.join(store.notesDir, f)).size;
    }
  } catch {}

  out(`\n  ${c.green('✔')} ${c.bold('Knowledge cache ready:')} ${c.cyan(`${finalNotes.length} notes`)} in ${c.dim(estimates.storage.rootDir)} (${formatBytes(totalBytes)} on disk)\n`);
  return { skipped: false, notes: finalNotes, totalBytes };
}

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
  return `${prLabel}${context}\n\nTASK:\nExplain the architectural root cause and codebase implementation required for this change. Identify which specific files and symbols must be modified and what invariants, conventions, or co-change patterns must be maintained.`;
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

export async function stepPrBenchmark({ repo, store, prNumber, agent: requestedAgent, model, budget = 1500, benchmarkFlag = false, noBenchmark = false, yes = false, out = console.log }) {
  if (noBenchmark) {
    out(`  ${c.gray('○')} PR change benchmark skipped (--no-benchmark).`);
    return null;
  }

  const slug = githubSlug(repo);
  const pr = findRecentPrChange(repo, { slug, prNumber });

  if (!pr) {
    out(`  ${c.gray('○')} No recent PR or multi-file change found to benchmark.`);
    out(`    ${c.dim('You can benchmark any question later: thinker benchmark run "<repo question>"')}`);
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
    } else if (process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
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

  let selectedAgent = null;
  try {
    selectedAgent = benchmarkAgent(requestedAgent);
  } catch {}

  if (!selectedAgent) {
    out(`  ${c.yellow('⚠')} Benchmark skipped: needs an installed agent CLI (claude, codex, cursor, or gemini).`);
    return null;
  }

  const task = buildPrBenchmarkTask(pr);
  const oriented = await orient(store, {
    task: `${pr.title} ${(pr.files || []).join(' ')}`,
    budget,
    recordUsage: false,
    backgroundVerify: false,
  });

  out(`  ${c.cyan('Running paired benchmark with')} ${c.bold(selectedAgent)}...`);
  const instruction = 'Read-only repository benchmark. Answer the request from the actual code. Be concrete and cite file:symbol locations. Do not edit files, run destructive commands, or change git state.';
  const baselinePrompt = `${instruction}\n\nREQUEST:\n${task}`;
  const cachePrompt = `${instruction}\n\n<thinker-cache>\n${oriented.text}\n</thinker-cache>\n\nUse relevant pointers above to avoid re-deriving known repository structure. Verify claims against code when needed.\n\nREQUEST:\n${task}`;

  out(`  ${c.bold('[1/2] Baseline run (without cache)...')}`);
  const baseline = await runBenchmarkAgent(selectedAgent, { repo, prompt: baselinePrompt, model });
  out(`        ✔ Completed in ${(baseline.wallMs / 1000).toFixed(1)}s (${baseline.inputTokens || 0} input tokens)`);

  out(`  ${c.bold(`[2/2] Thinker run (with ${oriented.included.length} relevant notes)...`)}`);
  const cached = await runBenchmarkAgent(selectedAgent, { repo, prompt: cachePrompt, model });
  out(`        ✔ Completed in ${(cached.wallMs / 1000).toFixed(1)}s (${cached.inputTokens || 0} input tokens)`);

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

// --- Main Guided Onboarding Orchestrator -------------------------------------

export async function runOnboarding({
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
  gitHook = false,
  noTrust = false,
  exportFile = null,
  out = console.log,
  seedFn,
  minePrsFn,
}) {
  store.init();

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
  const activeAgent = agent || exploreAgent();
  const estimates = estimateCacheBuild(repo, { areas, prs, noSeed, noPrs, slug, agent: activeAgent });

  out(stepBanner(2, 3, 'Build Knowledge Cache', 'Mine co-change patterns, PR invariants, and explore codebase topology'));
  const cacheRes = await stepBuildCache({
    repo,
    store,
    estimates,
    areas,
    prs,
    noSeed,
    noPrs,
    noPhrase,
    model,
    agent: activeAgent,
    yes,
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
    agent: activeAgent,
    model,
    budget: 1500,
    benchmarkFlag: benchmark,
    noBenchmark,
    yes,
    out,
  });

  // Telemetry notification
  maybeSendDailyTelemetryInBackground({ home: thinkerHome(), cliPath, store, force: true, event: 'install' });

  // Completion footer
  out('\n' + box([
    c.bold(c.green('✔  Thinker Onboarding Complete!')),
    '',
    `Start your agent (${c.bold(activeAgent || 'claude')}) in this repository as usual.`,
    'Relevant codebase knowledge will automatically be injected into prompts.',
    '',
    `Try searching cache:    ${c.cyan('thinker lookup "<query>"')}`,
    `Test prompt retrieval:  ${c.cyan('thinker orient "<task you want to work on>"')}`,
    `Run PR benchmark:       ${c.cyan('thinker benchmark pr')}`,
  ], { width: 74, borderColor: 'green' }) + '\n');
}
