// Steps 1 and 2 of the guided setup: wiring the agents' hooks and MCP entries, and building the cache.
import fs from 'node:fs';
import path from 'node:path';
import readlinePromises from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { installGitHooks } from '../git-hooks.js';
import { linkNotes, phraseNotes } from '../ops.js';
import { CLIENTS, USER_SCOPE_CLIENTS, detectClients, installClient, installCursorRule, stripRepoWiring, trustCodex, trustCodexUser } from '../clients.js';
import { available, provider, findBin } from '../llm.js';
import { cleanErrorMessage } from '../benchmark.js';
import { oneLine } from '../progress.js';
import { formatTokens } from '../model-usage.js';
import { generateBehaviorProposals } from '../behavior-proposals.js';
import { jevConfig, hostedCredential, jevAccess, jevAsked, recordAccess, saveKey, keyFile } from '../jev.js';
import { c, formatBytes, selectMenu } from './ui.js';
import { githubSlug } from './agents.js';

// --- Step 1: Connect Harness CLIs --------------------------------------------

// Wire the agents into their own settings (user scope: read in every checkout, and by the desktop
// apps that read no project files), and, when `repo` is given, the checkout's own pieces: git
// hooks, Cursor's rule and Codex's trust in the project. Setup wrote per-checkout files until 2026-10-04; this copy's machine-local
// ones are taken out of the checkout, since the user's now run there.
export async function stepConnectClis({ repo = null, cliPath, mcpEntry, userMcpEntry, clients, hooks = true, learn = true, late = false, mcp = true, gitHook = true, noTrust = false, yes = false, out = console.log }) {
  const detected = detectClients();
  const targetClients = clients || detected;
  const userEntry = userMcpEntry || { command: mcpEntry.command, args: mcpEntry.args };

  const clientMeta = {
    pi: { name: 'Pi' },
    windsurf: { name: 'Windsurf Cascade' },
    copilot: { name: 'GitHub Copilot CLI' },
    opencode: { name: 'OpenCode' },
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
      continue;
    }

    if (!isTarget && isDetected) {
      results.push({ client, status: 'skipped', detail: 'Omitted from --clients selection' });
      continue;
    }

    // Pi, Windsurf, Copilot and OpenCode are wired into the checkout alone (an extension or rule file there)
    if (!USER_SCOPE_CLIENTS.includes(client) && !repo) { results.push({ client, status: 'skipped', detail: 'wired per repository: run thinker setup inside one' }); continue; }
    try {
      const logs = USER_SCOPE_CLIENTS.includes(client)
        ? installClient(client, { scope: 'user', cli: cliPath, mcpEntry: userEntry, hooks, learn, late, mcp })
        : installClient(client, { scope: 'repo', repo, cli: cliPath, mcpEntry, hooks, learn, late, shared: false, mcp });
      if (repo && USER_SCOPE_CLIENTS.includes(client)) {
        const moved = stripRepoWiring(repo, { cli: cliPath, clients: [client] });
        if (moved.length) logs.push(`${(clientMeta[client]?.name || client)}: moved thinker's entries out of ${moved.join(', ')}: they run from your own settings now`);
        if (client === 'cursor' && mcp) installCursorRule(repo);
      }

      // Special handling for Codex trust
      if (client === 'codex' && (hooks || mcp) && !noTrust) {
        let ok = Boolean(yes);
        if (!ok && process.stdin.isTTY) {
          const rl = readlinePromises.createInterface({ input: process.stdin, output: process.stdout });
          const a = await rl.question(`  Codex: Mark ${repo ? 'this repository as trusted and ' : ''}thinker's hooks as reviewed in ~/.codex/config.toml? [Y/n] `);
          rl.close();
          ok = !/^n/i.test(a.trim());
        }
        if (ok) {
          if (repo) trustCodex(repo);
          trustCodexUser();
          logs.push(`Codex: ${repo ? 'project trust & ' : ''}reviewed hook hashes saved in ~/.codex/config.toml`);
        }
      }

      // Special handling for Cursor MCP workspace approval
      if (client === 'cursor' && mcp && repo) {
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
      out(`  ${c.green('✓')} ${c.bold(clientLabel)} Connected`);
      if (['pi', 'windsurf', 'copilot', 'opencode'].includes(res.client)) for (const line of res.logs) out(`    ${line}`);
    } else if (res.status === 'skipped') {
      out(`  ${c.gray('○')} ${c.dim(clientLabel)} ${c.dim(`Skipped · ${res.detail}`)}`);
    } else {
      out(`  ${c.red('✖')} ${c.bold(clientLabel)} ${c.red(`Failed · ${res.detail}`)}`);
    }
  }

  if (gitHook && repo) installGitHooks(repo, cliPath, learn, () => {});

  const connectedCount = results.filter(r => r.status === 'connected').length;
  out(`\n  ${c.cyan('Summary:')} ${c.bold(connectedCount)} of ${targetClients.length} selected agents connected.`);
  return results;
}

// Machine-local state in .thinker/ that no checkout should commit.
export function ignoreLocalState(dir) {
  const gi = path.join(dir, '.gitignore');
  const ignored = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const missing = ['log.jsonl', 'state/', 'benchmarks/'].filter(line => !ignored.split('\n').includes(line));
  if (missing.length) fs.writeFileSync(gi, ignored + (ignored && !ignored.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
}

function printExplorationPlan(estimates, out) {
  if (estimates.canSeed) out(`    • Exploration: ${estimates.candidateAreasCount} sessions sized to the selected source code`);
  if (estimates.omittedAreas?.length) out(`    • Area cap leaves ${estimates.omittedAreas.length} areas unexplored: ${estimates.omittedAreas.join(', ')}`);
}

// --- Step 2: Build Knowledge Cache -------------------------------------------

export async function stepBuildCache({ repo, store, estimates, areas, prs = 60, directories = null, noSeed = false, noPrs = false, noPhrase = false, model, agent, out = console.log, seedFn, minePrsFn, proposeFn = generateBehaviorProposals }) {
  let warnings = 0;
  // with neither pull requests nor exploration there is nothing to estimate: what is left
  // (linking) is free and local, and the notes come from the sessions to come
  const building = !(noSeed && noPrs);
  if (!building) {
    const notes = store.list();
    out(`  ${c.green('✓')} ${notes.length ? `Using ${notes.length} existing notes.` : 'Ready to learn from future sessions.'}`);
    return { skipped: true, notes, totalBytes: store.size(), warnings };
  }

  if (building) {
    out(`  ${c.bold('Pre-flight estimates for this repository:')}`);
    printExplorationPlan(estimates, out);
    out(`    • ${c.bold('Target storage:')}     ${c.cyan(estimates.storage.rootDir)} ${c.dim(`(notes in ${estimates.storage.notesDir})`)}`);
    out(`    • ${c.bold('Estimated size:')}     ${c.cyan(estimates.size.notesRange)} ${c.dim(`(${estimates.size.bytesRange} on disk)`)}`);
    out(`    • ${c.bold('Estimated build:')}    ${c.cyan(estimates.timing.formatted)} ${c.dim(`(PRs ${estimates.timing.breakdown.prs}, explore ${estimates.timing.breakdown.exploration})`)}`);
    if (estimates.tokenEstimate > 0) {
      out(`    • ${c.bold('Agent usage:')}       ${c.dim(`~${formatTokens(estimates.tokenEstimate)} tokens through your ${agent || provider()} login, most of them cached prompt reads`)}`);
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
      const res = await minePrsFn(slug, { limit: prs, model, repo, directories });
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
      const res = await seedFn({ areas, model, agent, directories });
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

  try {
    const result = await proposeFn(store, { model });
    out(`        ${c.green('✔')} ${result.proposals.length} behavior drafts from ${result.sources} source notes; inspect with thinker system propose`);
  } catch (e) {
    warnings++;
    out(`        ${c.yellow('⚠')} Behavior proposals failed: ${oneLine(cleanErrorMessage(e)).slice(0, 160)}. Retry with thinker setup --build`);
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

// The one question in `thinker setup` that spends the agent's usage: whether to read the repository's
// merged pull requests and explore its code now. Everything else setup does is free, and
// declining leaves a working install whose cache grows from the user's own sessions.
// Asked before the agent login flow, so nobody logs in for a step they did not want.
export async function confirmCacheBuild({ estimates, agent, out = console.log }) {
  const usage = estimates.tokenEstimate > 0 ? `, about ${c.cyan(`${formatTokens(estimates.tokenEstimate)} tokens`)} of your ${agent || 'agent'} usage` : '';
  out(`  ${c.bold('Build the cache from this repository now?')} ${c.dim('— optional')}`);
  out(`    • Mines merged pull requests and explores the code with ${c.bold(agent || 'your agent')}: ${c.cyan(estimates.timing.formatted)}${usage}`);
  printExplorationPlan(estimates, out);
  out(`    • ${c.dim('Without it thinker is still set up and working: the cache grows from your own sessions.')}`);
  out(`    • ${c.dim('You can build it any time with: thinker setup --build')}`);
  if (!process.stdin.isTTY) {
    out(`\n  ${c.yellow('○')} ${c.dim('Not a terminal, so the cache was not built (thinker setup --build builds it, --no-build asks nothing).')}`);
    return false;
  }
  try {
    const choice = await selectMenu({
      items: [
        { label: 'Learn as you work · build from future sessions', value: 'later' },
        { label: 'Build a cache now · use the estimate above', value: 'build' },
      ],
      defaultIndex: 0,
      out,
    });
    out(`  ${c.dim(choice?.value === 'build' ? 'Build a cache now' : 'Learn as you work')}`);
    return choice?.value === 'build';
  } catch {
    out(`  ${c.dim('Cache not built. Run thinker setup --build any time.')}`);
    return false;
  }
}

// How this machine reaches Jev. Asked once, in a terminal, and remembered (jev.js:recordAccess) so that
// neither setup nor update asks again. The question is put plainly because the default sends the request
// and excerpts of candidate notes off the machine, which is not what the rest of thinker does.
export async function configureJev({ store, out = console.log, hostedCredentialFn = hostedCredential,
                                     stdin = process.stdin, stdout = process.stdout, readlineFn = null, ask = true } = {}) {
  const cfg = jevConfig(store);
  if (!cfg.enabled) { out(`  ${c.dim('Jev is off; the built-in ranker chooses your notes. thinker ranker --jev-key <key> turns it on.')}`); return 'ce'; }
  if (cfg.key) { out(`  ${c.dim(`Jev uses your own key (${jevAccess()?.mode === 'key' ? keyFile() : 'from the environment'}); the built-in ranker is the fallback.`)}`); return 'direct'; }

  const already = jevAccess();
  // never block a test run on a menu, whatever stdin happens to be
  const interactive = ask && !already && Boolean(stdin?.isTTY) && !process.env.THINKER_TEST;
  if (interactive) {
    out(`  ${c.bold('How should Jev reach the model?')} ${c.dim('— asked once')}`);
    out(`    • Jev picks which of your notes you are shown. It reaches ${c.cyan('2.5x as many of the notes that matter')} as the built-in ranker.`);
    out(`    • Either way your request and short excerpts of candidate notes leave this machine. ${c.dim('Your code and your notes\' files do not.')}`);
    let choice;
    try {
      choice = (await selectMenu({
        items: [
          { label: 'Thinker hosted access · no key, nothing to sign up for (recommended)', value: 'proxy' },
          { label: 'My own TypeSafe key · requests go straight to TypeSafe, not through Thinker', value: 'key' },
          { label: 'Neither · rank locally, nothing leaves this machine', value: 'off' },
        ], defaultIndex: 0, out,
      }))?.value;
    } catch { choice = 'proxy'; }
    if (choice === 'off') { recordAccess('off'); out(`  ${c.dim('Local ranker only. thinker ranker --jev-key <key>, or THINKER_JEV=on, changes it.')}`); return 'ce'; }
    if (choice === 'key') {
      const rl = readlineFn ? readlineFn() : readlinePromises.createInterface({ input: stdin, output: stdout });
      let key = '';
      try { key = String(await rl.question(`  ${c.bold('TypeSafe API key')} ${c.dim('(blank to use hosted access instead)')}: `)).trim(); } finally { rl.close(); }
      if (key) { saveKey(key); out(`  ${c.green('✓')} Saved to ${c.dim(keyFile())} ${c.dim('(owner-readable only; never written into the repository)')}`); return 'direct'; }
      out(`  ${c.dim('No key given; using hosted access.')}`);
    }
    recordAccess('proxy');
  } else if (!already) {
    // Not a terminal, so nothing is recorded and the next interactive setup or update still asks.
    out(`  ${c.bold('Jev chooses your notes through Thinker hosted access — no API key needed.')}`);
    out(`  ${c.dim('Your request and candidate note excerpts go to Thinker\'s AWS proxy and on to TypeSafe.')}`);
    out(`  ${c.dim('thinker ranker --jev-key <key> uses your own instead; THINKER_JEV=off keeps everything local.')}`);
  }
  try {
    await hostedCredentialFn();
    out(`  ${c.green('✓')} Hosted Jev ready; the local ranker takes over on errors or after ${cfg.timeoutMs} ms.`);
    return 'hosted';
  } catch {
    out(`  ${c.yellow('○')} Hosted Jev is unavailable right now. The local ranker stays ready; a later request can retry.`);
    return 'ce';
  }
}

