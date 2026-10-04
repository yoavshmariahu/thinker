// Steps 1 and 2 of the guided setup: wiring the agents' hooks and MCP entries, and building the cache.
import fs from 'node:fs';
import path from 'node:path';
import readlinePromises from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { installGitHooks } from '../git-hooks.js';
import { linkNotes, phraseNotes } from '../ops.js';
import { CLIENTS, detectClients, installClient, trustCodex } from '../clients.js';
import { available, provider, findBin } from '../llm.js';
import { cleanErrorMessage } from '../benchmark.js';
import { oneLine } from '../progress.js';
import { c, formatBytes } from './ui.js';
import { githubSlug } from './agents.js';

// --- Step 1: Connect Harness CLIs --------------------------------------------

export async function stepConnectClis({ repo, cliPath, mcpEntry, clients, hooks = true, learn = true, late = false, shared = true, mcp = true, gitHook = true, noTrust = false, yes = false, out = console.log }) {
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
          const rl = readlinePromises.createInterface({ input: process.stdin, output: process.stdout });
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
      if (client === 'cursor' && mcp) {
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

  if (gitHook) installGitHooks(repo, cliPath, learn, out);

  const connectedCount = results.filter(r => r.status === 'connected').length;
  out(`\n  ${c.cyan('Summary:')} ${c.bold(connectedCount)} of ${CLIENTS.length} harness CLIs connected and configured.`);
  return results;
}

// Machine-local state in .thinker/ that no checkout should commit.
export function ignoreLocalState(dir) {
  const gi = path.join(dir, '.gitignore');
  const ignored = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const missing = ['log.jsonl', 'state/', 'benchmarks/'].filter(line => !ignored.split('\n').includes(line));
  if (missing.length) fs.writeFileSync(gi, ignored + (ignored && !ignored.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
}

// --- Step 2: Build Knowledge Cache -------------------------------------------

export async function stepBuildCache({ repo, store, estimates, areas = 12, prs = 60, noSeed = false, noPrs = false, noPhrase = false, model, agent, out = console.log, seedFn, minePrsFn }) {
  let warnings = 0;
  // with neither pull requests nor exploration there is nothing to estimate: what is left
  // (linking) is free and local, and the notes come from the sessions to come
  const building = !(noSeed && noPrs);
  if (building) {
    out(`  ${c.bold('Pre-flight estimates for this repository:')}`);
    out(`    • ${c.bold('Target storage:')}     ${c.cyan(estimates.storage.rootDir)} ${c.dim(`(notes in ${estimates.storage.notesDir})`)}`);
    out(`    • ${c.bold('Estimated size:')}     ${c.cyan(estimates.size.notesRange)} ${c.dim(`(${estimates.size.bytesRange} on disk)`)}`);
    out(`    • ${c.bold('Estimated build:')}    ${c.cyan(estimates.timing.formatted)} ${c.dim(`(PRs ${estimates.timing.breakdown.prs}, explore ${estimates.timing.breakdown.exploration})`)}`);
    if (estimates.costEstimate > 0) {
      out(`    • ${c.bold('Model usage:')}       ${c.dim(`~$${estimates.costEstimate.toFixed(2)} via your ${agent || provider()} login`)}`);
    }
  } else {
    out(`  ${c.bold('Not reading the code or the pull requests now.')} ${c.dim('thinker setup --build does that.')}`);
    out(`    • ${c.bold('Target storage:')}     ${c.cyan(estimates.storage.rootDir)} ${c.dim(`(notes in ${estimates.storage.notesDir})`)}`);
  }
  out('');

  // Stage 1: Merged PR mining
  const slug = githubSlug(repo);
  let minedPrCount = 0;
  if (estimates.canMine && minePrsFn) {
    if (estimates.mineSource === 'github') {
      out(`  ${c.bold(`[1/3] Mining merged PRs from ${slug}...`)}`);
    } else {
      out(`  ${c.bold(`[1/3] Mining merged changes from git history (GitHub CLI unavailable)...`)}`);
    }
    try {
      const res = await minePrsFn(slug, { limit: prs, model, repo });
      minedPrCount = res.saved || 0;
      const label = estimates.mineSource === 'github' ? 'pull requests' : 'git history changes';
      if (res.failed) warnings++;
      // The CLI miner already prints its counted summary. Keep support for other callers.
      if (res.processed === undefined) out(`        ${c.green('✔')} Mined ${label} → ${minedPrCount} notes created`);
    } catch (e) {
      warnings++;
      out(`        ${c.yellow('⚠')} PR mining stopped: ${oneLine(cleanErrorMessage(e)).slice(0, 160)}. Retry: thinker mine-prs`);
    }
  } else {
    const reason = !building
      ? 'not building the cache now'
      : noPrs ? '--no-prs requested'
      : (!estimates.canMine ? 'insufficient git history' : 'requires GitHub repo and gh CLI');
    out(`  ${c.dim(`[1/3] Merged PR mining · Skipped (${reason})`)}`);
  }

  // Stage 3: Subsystem area exploration
  let seedCount = 0;
  if (estimates.canSeed && seedFn) {
    out(`  ${c.bold(`[2/3] Exploring architectural subsystems with ${agent}...`)}`);
    try {
      const res = await seedFn({ areas, model, agent });
      seedCount = res.ok || 0;
      if (res.failures?.length) warnings++;
      if (res.saved !== undefined) {
        if (seedCount < res.total) out(`        ${c.yellow('⚠')} ${seedCount}/${res.total} areas completed. Retry unfinished exploration with: thinker seed`);
      } else if (seedCount > 0) {
        out(`        ${c.green('✔')} Explored ${seedCount} subsystems → architectural notes generated`);
      } else {
        out(`        ${c.yellow('⚠')} Subsystem exploration produced 0 notes`);
      }
    } catch (e) {
      warnings++;
      out(`        ${c.yellow('⚠')} Exploration stopped: ${oneLine(cleanErrorMessage(e)).slice(0, 160)}. Retry: thinker seed`);
    }
  } else {
    const reason = !building
      ? 'not building the cache now'
      : noSeed ? '--no-seed requested'
      : (!agent ? 'no authenticated agent available' : 'run `thinker seed` any time');
    out(`  ${c.dim(`[2/3] Subsystem exploration · Skipped (${reason})`)}`);
  }

  // Stage 4: Cross-note linking and phrasings
  out(`  ${c.bold('[3/3] Linking cross-note dependencies and search phrasings...')}`);
  const notes = store.list();
  for (const n of notes) linkNotes(store, n, notes);
  out(`        ${c.green('✔')} Linked ${notes.length} notes across symbol dependencies`);

  if (notes.length && !noPhrase && provider()) {
    try {
      out('        Generating search phrasings…');
      const res = await phraseNotes(store, notes, { model, phase: 'init' });
      out(`        ${c.green('✔')} Search phrasings generated for ${res.done.length}/${notes.length} notes`);
    } catch (e) {
      warnings++;
      out(`        ${c.yellow('⚠')} Search phrasings failed: ${oneLine(cleanErrorMessage(e)).slice(0, 160)}. Retry: thinker phrase`);
    }
  }

  // Final cache stats
  const finalNotes = store.list();
  const totalBytes = store.size();

  const status = !building
    ? (finalNotes.length ? 'Cache left as it is:' : 'Set up with an empty cache, which grows from your sessions:')
    : warnings ? 'Cache build finished with warnings:' : finalNotes.length ? 'Knowledge cache ready:' : 'Cache build finished without notes:';
  const bad = building && (warnings || !finalNotes.length);
  out(`\n  ${bad ? c.yellow('⚠') : c.green('✔')} ${c.bold(status)} ${c.cyan(`${finalNotes.length} notes`)} in ${c.dim(estimates.storage.rootDir)} (${formatBytes(totalBytes)} on disk)\n`);
  return { skipped: false, notes: finalNotes, totalBytes, warnings };
}

// The one question in `thinker setup` that can cost money: whether to read the repository's
// merged pull requests and explore its code now. Everything else setup does is free, and
// declining leaves a working install whose cache grows from the user's own sessions.
// Asked before the agent login flow, so nobody logs in for a step they did not want.
export async function confirmCacheBuild({ estimates, agent, out = console.log }) {
  const cost = estimates.costEstimate > 0 ? `, about ${c.cyan(`$${estimates.costEstimate.toFixed(2)}`)} of your ${agent || 'agent'} usage` : '';
  out(`  ${c.bold('Build the cache from this repository now?')} ${c.dim('— optional, and the only step that spends anything')}`);
  out(`    • Mines merged pull requests and explores the code with ${c.bold(agent || 'your agent')}: ${c.cyan(estimates.timing.formatted)}${cost}`);
  out(`    • ${c.dim('Without it thinker is still set up and working: the cache grows from your own sessions.')}`);
  out(`    • ${c.dim('You can build it any time with: thinker setup --build')}`);
  if (!process.stdin.isTTY) {
    out(`\n  ${c.yellow('○')} ${c.dim('Not a terminal, so the cache was not built (thinker setup --build builds it, --no-build asks nothing).')}`);
    return false;
  }
  const rl = readlinePromises.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = await rl.question(`\n  Build it now? [y/N] `);
    return /^y/i.test(a.trim());
  } catch {
    out(`\n  ${c.yellow('○')} ${c.dim('No answer, so the cache was not built.')}`);
    return false; // Ctrl+D or a stdin that closed under us: not an answer to spend money on
  } finally {
    rl.close();
  }
}
