// Steps 1 and 2 of the guided setup: wiring the agents' hooks and MCP entries, and building the cache.
import fs from 'node:fs';
import path from 'node:path';
import readlinePromises from 'node:readline/promises';
import { spawn, spawnSync } from 'node:child_process';
import { installGitHooks } from '../git-hooks.js';
import { linkNotes, phraseBatches } from '../ops.js';
import { CLIENTS, USER_SCOPE_CLIENTS, detectClients, installClient, installCursorRule, stripRepoWiring, trustCodex, trustCodexUser } from '../clients.js';
import { available, provider, findBin } from '../llm.js';
import { cleanErrorMessage } from '../benchmark.js';
import { oneLine } from '../progress.js';
import { formatTokens } from '../model-usage.js';
import { generateBehaviorProposals } from '../behavior-proposals.js';
import { deriveDocBehaviors, docBehaviorsLine } from '../behavior-docs.js';
import { c, formatBytes, selectMenu, withSpinner } from './ui.js';
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
        if (client === 'cursor' && mcp) installCursorRule(repo, { learn });
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
// The local page, opened once when setup first sets a repository up: a detached `thinker ui --from-setup`
// (commands/cache.js:uiCommand) that opens the browser itself and exits when nobody has used it for a while,
// so setup still finishes and returns the terminal (or the agent's command) at once.
export function openDashboard({ repo, cliPath, spawnFn = spawn }) {
  try {
    spawnFn(process.execPath, [cliPath, 'ui', '--from-setup', '--repo', repo], { cwd: repo, detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch { return false; }
}

export function ignoreLocalState(dir) {
  const gi = path.join(dir, '.gitignore');
  const ignored = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const missing = ['log.jsonl', 'state/', 'benchmarks/'].filter(line => !ignored.split('\n').includes(line));
  if (missing.length) fs.writeFileSync(gi, ignored + (ignored && !ignored.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
}

// --- Step 2: Build Knowledge Cache -------------------------------------------

export async function stepBuildCache({ repo, store, estimates, prs = 60, directories = null, noPrs = false, noPhrase = false, model, agent, out = console.log, minePrsFn, proposeFn = generateBehaviorProposals, docsFn = deriveDocBehaviors, phraseFn = phraseBatches }) {
  let warnings = 0;
  // without pull requests there is nothing to estimate: what is left (linking) is free and local,
  // and the notes come from the sessions to come
  const building = !noPrs;
  if (!building) {
    const notes = store.list();
    out(`  ${c.green('✓')} ${notes.length ? `Using ${notes.length} existing notes.` : 'Ready to learn from future sessions.'}`);
    return { skipped: true, notes, totalBytes: store.size(), warnings };
  }

  if (building) {
    out(`  ${c.bold('Pre-flight estimates for this repository:')}`);
    out(`    • ${c.bold('Target storage:')}     ${c.cyan(estimates.storage.rootDir)} ${c.dim(`(notes in ${estimates.storage.notesDir})`)}`);
    out(`    • ${c.bold('Estimated size:')}     ${c.cyan(estimates.size.notesRange)} ${c.dim(`(${estimates.size.bytesRange} on disk)`)}`);
    out(`    • ${c.bold('Source:')}             ${c.dim('design documents (READMEs) for the system behaviors, merged pull requests for the notes; a build does not explore the code')}`);
    out(`    • ${c.bold('Estimated build:')}    ${c.cyan(estimates.timing.formatted)}`);
    if (estimates.tokenEstimate > 0) {
      out(`    • ${c.bold('Agent usage:')}       ${c.dim(`~${formatTokens(estimates.tokenEstimate)} tokens through your ${agent || provider()} login`)}`);
    }
    // notes are saved, and each change marked mined, as it finishes (src/commands/learn.js:minePrs)
    out(`    • ${c.bold('Stop any time:')}      ${c.dim('Ctrl-C keeps every note saved so far, and the cache works with whatever it has.')}`);
    out(`      ${c.dim('It keeps growing as you work, from your sessions and a few merged PRs per background run;')}`);
    out(`      ${c.dim('thinker mine-prs continues the mining where it stopped.')}`);
  } else {
    out(`  ${c.bold('Not reading the pull requests now.')} ${c.dim('thinker setup --build does that.')}`);
    out(`    • ${c.bold('Target storage:')}     ${c.cyan(estimates.storage.rootDir)} ${c.dim(`(notes in ${estimates.storage.notesDir})`)}`);
  }
  out('');

  // Stage 1: the system behaviors the checked-in design documents state (behavior-docs.js). First, so
  // they are there while the pull requests are still being read.
  out(`  ${c.bold('[1/3] Reading design documents for system behaviors...')}`);
  try {
    const result = await withSpinner(out, 'Reading the READMEs and design documents', () => docsFn(store, { model, directories }), { indent: '        ' });
    if (result.failed) warnings++;
    out(`        ${result.failed ? c.yellow('⚠') : c.green('✔')} ${docBehaviorsLine(result)}${result.saved.length ? '; see them with thinker system' : ''}`);
  } catch (e) {
    warnings++;
    out(`        ${c.yellow('⚠')} Design documents not read: ${oneLine(cleanErrorMessage(e)).slice(0, 160)}. Retry this step alone: thinker system docs`);
  }

  // Stage 2: Merged PR mining
  const slug = githubSlug(repo);
  let minedPrCount = 0;
  if (estimates.canMine && minePrsFn) {
    if (estimates.mineSource === 'github') {
      out(`  ${c.bold(`[2/3] Mining merged PRs from ${slug}...`)}`);
    } else {
      out(`  ${c.bold(`[2/3] Mining merged changes from git history (GitHub CLI unavailable)...`)}`);
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
    out(`  ${c.dim(`[2/3] Merged PR mining · Skipped (${reason})`)}`);
  }

  // Last stage: cross-note linking, phrasings and behavior drafts
  out(`  ${c.bold('[3/3] Linking notes, search phrasings and behavior drafts...')}`);
  const notes = store.list();
  for (const n of notes) linkNotes(store, n, notes);
  out(`        ${c.green('✔')} Linked ${notes.length} notes across symbol dependencies`);

  if (notes.length && !noPhrase && provider()) {
    try {
      const res = await withSpinner(out, `Generating search phrasings for ${notes.length} notes`, () => phraseFn(store, notes, { model, phase: 'init' }), { indent: '        ' });
      if (res.failed) {
        warnings++;
        out(`        ${c.yellow('⚠')} Search phrasings generated for ${res.done.length}/${notes.length} notes (${oneLine(cleanErrorMessage(res.lastError)).slice(0, 120)}). Retry the rest: thinker phrase`);
      } else out(`        ${c.green('✔')} Search phrasings generated for ${res.done.length}/${notes.length} notes`);
    } catch (e) {
      warnings++;
      out(`        ${c.yellow('⚠')} Search phrasings failed: ${oneLine(cleanErrorMessage(e)).slice(0, 160)}. Retry: thinker phrase`);
    }
  }

  try {
    const result = await withSpinner(out, 'Drafting desired behaviors from the strongest rules', () => proposeFn(store, { model }), { indent: '        ' });
    if (result.failed) {
      warnings++;
      out(`        ${c.yellow('⚠')} ${result.proposals.length} behavior drafts; ${result.failed} of ${result.sources} source notes not read (${oneLine(cleanErrorMessage(result.lastError)).slice(0, 120)}). Retry: thinker system propose --refresh`);
    } else out(`        ${c.green('✔')} ${result.proposals.length} behavior drafts from ${result.sources} source notes; inspect with thinker system propose`);
  } catch (e) {
    // the retry is this step alone: thinker setup --build would mine the pull requests again
    warnings++;
    out(`        ${c.yellow('⚠')} Behavior drafts failed: ${oneLine(cleanErrorMessage(e)).slice(0, 160)}. Retry this step alone: thinker system propose --refresh`);
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
// merged pull requests now. Everything else setup does is free, and
// declining leaves a working install whose cache grows from the user's own sessions.
// Asked before the agent login flow, so nobody logs in for a step they did not want.
// Returns 'full', 'shallow' (30% of the full build, its most valuable part) or false.
export async function confirmCacheBuild({ estimates, shallow = null, agent, out = console.log }) {
  const cost = e => `${e.timing.formatted}${e.tokenEstimate > 0 ? `, ~${formatTokens(e.tokenEstimate)} tokens` : ''}`;
  const usage = estimates.tokenEstimate > 0 ? `, about ${c.cyan(`${formatTokens(estimates.tokenEstimate)} tokens`)} of your ${agent || 'agent'} usage` : '';
  out(`  ${c.bold('Build the cache from this repository now?')} ${c.dim('— optional')}`);
  out(`    • Full: reads merged pull requests with ${c.bold(agent || 'your agent')}: ${c.cyan(estimates.timing.formatted)}${usage}`);
  if (shallow) out(`    • Shallow: the most valuable 30% of that (the newest pull requests): ${c.cyan(cost(shallow))}`);
  out(`    • ${c.dim('The notes come from pull requests; the code itself is not explored.')}`);
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
        { label: `Full build · ${cost(estimates)}`, value: 'full' },
        ...(shallow ? [{ label: `Shallow build · about 30% · ${cost(shallow)}`, value: 'shallow' }] : []),
      ],
      defaultIndex: 0,
      out,
    });
    const picked = choice?.value === 'full' || choice?.value === 'shallow' ? choice.value : false;
    out(`  ${c.dim(picked === 'full' ? 'Full build' : picked === 'shallow' ? 'Shallow build' : 'Learn as you work')}`);
    return picked;
  } catch {
    out(`  ${c.dim('Cache not built. Run thinker setup --build any time.')}`);
    return false;
  }
}
