// Steps 1 and 2 of the guided setup: wiring the agents' hooks and MCP entries, and building the cache.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { installGitHooks } from '../git-hooks.js';
import { linkNotes, phraseBatches } from '../ops.js';
import { CLIENTS, USER_SCOPE_CLIENTS, detectClients, installClient, installCursorRule, stripRepoWiring, trustCodex, trustCodexUser } from '../clients.js';
import { available, provider, findBin } from '../llm.js';
import { cleanErrorMessage } from '../benchmark.js';
import { oneLine, buildProgress } from '../progress.js';
import { formatTokens } from '../model-usage.js';
import { generateBehaviorProposals } from '../behavior-proposals.js';
import { deriveDocBehaviors, docBehaviorsLine } from '../behavior-docs.js';
import { scanSkills, skillsLine } from '../skills.js';
import { c, formatBytes, selectMenu, withSpinner, progressBar, onTerminal, terminalStream, spinnerEnabled } from './ui.js';
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

      // Codex runs no hook it has not marked reviewed: the marks are written without asking (the
      // hooks are thinker's own, just installed); --no-trust leaves them to the person
      if (client === 'codex' && (hooks || mcp) && !noTrust) {
        if (repo) trustCodex(repo);
        trustCodexUser();
        logs.push(`Codex: ${repo ? 'project trust & ' : ''}reviewed hook hashes saved in ~/.codex/config.toml`);
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

      results.push({ client, status: 'connected', name: clientMeta[client]?.name || client, logs });
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

  // a hook that is not thinker's is left alone, and said so: the doctor then names the line to add to it
  if (gitHook && repo) installGitHooks(repo, cliPath, learn, l => { if (l.startsWith('skipped git')) out(`  ${c.gray('○')} ${c.dim(`git hook · ${l.replace(/^skipped git /, '')}`)}`); });

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

// How many design documents one build reads; maintenance reads the rest over time (behavior-docs.js).
export const DOCS_LIMIT = 8;

export async function stepBuildCache({ repo, store, estimates, prs = 60, directories = null, noPrs = false, noPhrase = false, docs = true, model, agent, out = console.log, minePrsFn, proposeFn = generateBehaviorProposals, docsFn = deriveDocBehaviors, skillsFn = scanSkills, phraseFn = phraseBatches }) {
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

  // One progress bar for the whole build on the last line of the terminal: the share done, the time
  // left and the stage's counts (progress.js:buildProgress). The stage headlines and results print
  // above it. Off a terminal, or from a test's collecting `out`, there is no bar and each stage with a
  // single model call runs under withSpinner as before.
  const bar = progressBar({ stream: terminalStream(out), enabled: onTerminal(out) && spinnerEnabled(terminalStream(out)) });
  const prog = buildProgress({ mineSeconds: estimates.timing?.totalSeconds || 0, docs: docs ? DOCS_LIMIT : 0 });
  const tick = () => bar.set(prog.now());
  const ticker = setInterval(tick, 500); ticker.unref?.();
  const run = (label, fn) => { if (!bar.active) return withSpinner(out, label, fn, { indent: '        ' }); prog.update({ text: label, current: '', done: 0, total: 0 }); tick(); return fn(); };
  tick();
  try {
  // Stage 1: merged PR mining, the bulk of the build; its batch reports every start and completion
  const slug = githubSlug(repo);
  let minedPrCount = 0;
  if (estimates.canMine && minePrsFn) {
    if (estimates.mineSource === 'github') {
      out(`  ${c.bold(`[1/3] Mining merged PRs from ${slug}`)}`);
    } else {
      out(`  ${c.bold(`[1/3] Mining merged changes from git history (GitHub CLI unavailable)`)}`);
    }
    prog.stage('mine', { text: estimates.mineSource === 'github' ? 'Mining merged pull requests' : 'Mining merged changes' });
    try {
      const onProgress = bar.active ? ({ completed, total, current }) => { prog.update({ done: completed, total, current: completed < total ? current : '' }); tick(); } : null;
      const res = await minePrsFn(slug, { limit: prs, model, repo, directories, ...(onProgress ? { onProgress } : {}) });
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
    prog.skip('mine');
  }

  // Stage 2: cross-note linking, phrasings and behavior drafts
  out(`  ${c.bold('[2/3] Linking notes, search phrasings and behavior drafts')}`);
  prog.stage('finish', { text: 'Linking notes' });
  const notes = store.list();
  for (const n of notes) linkNotes(store, n, notes);
  out(`        ${c.green('✔')} Linked ${notes.length} notes across symbol dependencies`);

  if (notes.length && !noPhrase && provider()) {
    try {
      const res = await run(`Generating search phrasings for ${notes.length} notes`, () => phraseFn(store, notes, { model, phase: 'init' }));
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
    const result = await run('Drafting desired behaviors from the strongest rules', () => proposeFn(store, { model }));
    if (result.failed) {
      warnings++;
      out(`        ${c.yellow('⚠')} ${result.proposals.length} behavior drafts; ${result.failed} of ${result.sources} source notes not read (${oneLine(cleanErrorMessage(result.lastError)).slice(0, 120)}). Retry: thinker system propose --refresh`);
    } else out(`        ${c.green('✔')} ${result.proposals.length} behavior drafts from ${result.sources} source notes; inspect with thinker system propose`);
  } catch (e) {
    // the retry is this step alone: thinker setup --build would mine the pull requests again
    warnings++;
    out(`        ${c.yellow('⚠')} Behavior drafts failed: ${oneLine(cleanErrorMessage(e)).slice(0, 160)}. Retry this step alone: thinker system propose --refresh`);
  }

  // Stage 3, last and optional (--no-docs): the system behaviors the checked-in design documents state
  // (behavior-docs.js), at most DOCS_LIMIT of them a build, the newest-touched first; the rest wait for
  // maintenance. Last because it is the least exercised path of a build (2026-10-12), so a problem there
  // costs nothing that came before. Then the skill files of the checkout, one card each (skills.js), free
  // when there are none.
  out(`  ${c.bold(docs ? '[3/3] Reading design documents for system behaviors' : '[3/3] Design documents skipped (--no-docs); reading skill files')}`);
  if (docs) {
    prog.stage('docs', { text: 'Reading design documents' });
    try {
      const counts = bar.active ? {
        onDoc: (file, { total }) => { prog.update({ total, current: path.basename(file) }); tick(); },
        onRead: (read, total) => { prog.update({ done: read, total, current: read < total ? undefined : '' }); tick(); },
      } : {};
      const result = await run('Reading the READMEs and design documents', () => docsFn(store, { model, directories, limit: DOCS_LIMIT, ...counts }));
      if (result.failed) warnings++;
      out(`        ${result.failed ? c.yellow('⚠') : c.green('✔')} ${docBehaviorsLine(result)}${result.saved.length ? '; see them with thinker system' : ''}`);
    } catch (e) {
      warnings++;
      out(`        ${c.yellow('⚠')} Design documents not read: ${oneLine(cleanErrorMessage(e)).slice(0, 160)}. Retry this step alone: thinker system docs`);
    }
  } else prog.skip('docs');
  try {
    const result = await run('Reading the skill files (SKILL.md)', () => skillsFn(store, { model, limit: 60, phase: 'init' }));
    if (result.failed) warnings++;
    if (result.found) out(`        ${result.failed ? c.yellow('⚠') : c.green('✔')} ${skillsLine(result)}`);
  } catch (e) {
    warnings++;
    out(`        ${c.yellow('⚠')} Skill files not read: ${oneLine(cleanErrorMessage(e)).slice(0, 160)}. Retry this step alone: thinker skills scan`);
  }
  } finally { clearInterval(ticker); bar.stop(); }

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
