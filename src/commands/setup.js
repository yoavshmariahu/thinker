// Setting a repository and this machine up: setup, uninstall, the tree-sitter parser (ast), and
// updating thinker itself (update, upgrade, switch, branch).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { initAst, astDirs, AST_PACKAGES, GRAMMAR_NAMES } from '../ast.js';
import { parseClients, uninstallClients, uninstallWiring, refreshWiring, connectFromCheckouts } from '../clients.js';
import { uninstallGitHooks } from '../git-hooks.js';
import { runSetup, stepConnectClis } from '../setup.js';
import { unscheduleTelemetry } from '../telemetry.js';
import { thinkerHome, detectInstall, checkUpdate, applyUpdate, scheduleDaily, unscheduleDaily, isScheduled, getLaunchAgentPath } from '../update.js';
import { githubSlug } from './shared.js';
import { seed, minePrs } from './learn.js';
import { readLog } from '../usage.js';

async function initCommand(ctx) {
  // `init` and `setup` were two ways to set a repository up, and the difference was never clear.
  process.stderr.write('thinker: `thinker init` was replaced by `thinker setup`, the one command that sets a repository up.\n  thinker setup              wire up the agents, then offer to build the cache from the code\n  thinker setup --no-build   wire up the agents only (what `init` did)\n');
  process.exit(1);
}

async function setupCommand(ctx) {
  const { repo } = ctx;
  if (!fs.existsSync(path.join(repo, '.git'))) { process.stderr.write(`thinker: ${repo} is not a git repository. Run \`thinker setup\` from inside the repository to set it up.\n`); process.exit(1); }
  await setup(ctx);
  return;
}

// Wire the agents on this machine into their own settings, once: hooks and the MCP server, for
// every repository that is set up (a repository that is not is served nothing and learns nothing).
// No repository is needed; `setup` runs this as its first step, and so does the installer.
async function connectCommand(ctx) {
  const { flags, out, HERE, learnOn, mcpEntry, userMcpEntry } = ctx;
  const clients = parseClients(flags.clients, parseClients('auto'));
  await stepConnectClis({
    repo: null, cliPath: path.join(HERE, 'cli.js'), mcpEntry: mcpEntry(), userMcpEntry: userMcpEntry(), clients,
    hooks: !flags['no-hooks'], learn: !flags['no-hooks'] && learnOn(), late: !flags['no-late'], mcp: !flags['no-mcp'],
    noTrust: Boolean(flags['no-trust']), yes: Boolean(flags.yes), out,
  });
  out(`\n  thinker runs in every repository set up with \`thinker setup\`; elsewhere it does nothing.`);
}

async function uninstallCommand(ctx) {
  const { flags, repo, store, out } = ctx;
  // remove hooks, MCP registration and scheduled daily updates; notes stay unless --purge
  unscheduleDaily({ home: thinkerHome() });
  unscheduleTelemetry({ home: thinkerHome() });
  uninstallClients(repo);
  uninstallGitHooks(repo);
  if (flags.purge) fs.rmSync(store.dir, { recursive: true, force: true });
  // --user: the machine-wide wiring in the agents' own settings goes too
  if (flags.user) uninstallWiring({ scope: 'user' });
  out(`removed thinker hooks and MCP registration from ${repo}${flags.user ? ' and from your own agent settings' : ''}${flags.purge ? ' and deleted .thinker/' : ' (notes kept in .thinker/)'}`);
  return;
}

// thinker ranker [status|fetch]: the cross-encoder the hooks rank with (dense.js). The installer, `thinker update`
// and `thinker setup` fetch it; this is the by-hand path and the check.
async function rankerCommand(ctx) {
  const { pos, flags, out } = ctx;
  const { rankerStatus, fetchRanker, CE_DEFAULTS } = await import('../dense.js');
  if (pos[0] === 'fetch') {
    const before = await rankerStatus();
    if (!before.runtime) { out(`the ranking runtime (@huggingface/transformers) is not installed: ${before.error || ''}\nrun \`npm ci --omit=dev --ignore-scripts\` in thinker's app directory, or \`thinker update\``); process.exitCode = 1; return; }
    if (!before.model && !flags.quiet) out(`fetching ${before.modelName} (about 23 MB) into ${before.dir}…`);
    try { const st = await fetchRanker(); if (!flags.quiet) out(`ranker ready: ${st.modelName} in ${st.dir}`); }
    catch (e) { out(`the ranking model could not be fetched: ${String(e.message).split('\n')[0].slice(0, 200)}\nnotes are ranked by words alone until it is; run \`thinker ranker fetch\` again when online`); process.exitCode = 1; }
    return;
  }
  const st = await rankerStatus();
  out(`ranker: ${st.runtime && st.model ? 'on' : 'off'} (${st.modelName}; floor ${CE_DEFAULTS.floor}, ${CE_DEFAULTS.maxNotes} note${CE_DEFAULTS.maxNotes === 1 ? '' : 's'}, request cut to ${CE_DEFAULTS.queryTokens} tokens, fallback ${CE_DEFAULTS.fallbackFloor == null ? 'off' : 'best note at ≥ ' + CE_DEFAULTS.fallbackFloor}; \`ce\` in .thinker/config.json adjusts)`);
  out(`runtime: ${st.runtime ? 'installed' : 'missing' + (st.error ? ` (${st.error})` : '')}\nmodel: ${st.model ? 'present' : 'not fetched (thinker ranker fetch)'} in ${st.dir}`);
  if (!(st.runtime && st.model)) out('until both are there the hooks rank by words alone');
}

async function astCommand(ctx) {
  const { pos, flags, out } = ctx;
  const dir = flags.dir || process.env.THINKER_AST_DIR || path.join(thinkerHome(), 'ast');
  if (pos[0] === 'install') {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(path.join(dir, 'package.json'))) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'thinker-ast', private: true, description: 'tree-sitter parser and grammars for thinker' }, null, 2) + '\n');
    out(`installing ${AST_PACKAGES.join(' and ')} into ${dir} (about 55 MB)…`);
    const r = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--silent', '--ignore-scripts', ...AST_PACKAGES], { cwd: dir, stdio: 'inherit' });
    if (r.status !== 0) { out('npm install failed'); process.exit(1); }
    const st = await initAst({ dir });
    if (!st.available) { out(`installed, but the parser did not load: ${st.error || 'unknown error'}`); process.exit(1); }
    out(`tree-sitter ready: ${st.grammars.join(', ')}. Symbol hashes are upgraded in place as notes are served; \`thinker rehash\` does them all now.`);
    return;
  }
  const st = await initAst();
  out(st.available ? `tree-sitter: on (${st.dir}); grammars: ${st.grammars.join(', ')}` : `tree-sitter: off (regex heuristics in use)${st.error ? `: ${st.error}` : ''}\nlooked in: ${astDirs().join(', ')}\ninstall with: thinker ast install   (grammars: ${GRAMMAR_NAMES.join(', ')})`);
  return;
}

// The checkouts thinker has been wired into on this machine: every path the machine's log names
// that still exists and is set up, and the current one. The log is the only record there is.
// The checkouts set up on this machine: git checkouts with a .thinker/, as this one and the log name
// them. A directory under the temp directory is not one (a test's), and neither is the home
// directory, where .thinker/ is thinker's own home (THINKER_HOME) and not a cache: taken for a
// checkout, its "wiring" was the user's own files, rewritten in the checkout's form on every rewire.
export function knownRepos(store, repo) {
  const seen = new Map();
  const tmp = [os.tmpdir(), '/tmp', '/private/tmp', '/private/var/folders', '/var/folders'].map(d => { try { return fs.realpathSync(d); } catch { return d; } });
  const add = p => { try { const r = fs.realpathSync(p); if (tmp.some(t => r.startsWith(t + path.sep))) return; if (fs.existsSync(path.join(r, '.git')) && fs.existsSync(path.join(r, '.thinker'))) seen.set(r, true); } catch {} };
  if (store.exists()) add(repo);
  try { for (const e of readLog(store, { all: true })) if (e.repo && typeof e.repo === 'string') add(e.repo); } catch {}
  return [...seen.keys()];
}

// Rewrite the hook and MCP entries of every known checkout (or this one, --here) for this copy of
// thinker: clients.js:refreshWiring. `thinker update` runs it after an update; the prompt hook does
// the same for its own checkout; this is the command for doing it by hand.
async function rewireCommand(ctx) {
  const { flags, repo, store, out, HERE } = ctx;
  const cli = path.join(HERE, 'cli.js');
  const repos = flags.here ? (store.exists() ? [repo] : []) : knownRepos(store, repo);
  const dry = !!flags.dry, quiet = !!flags.quiet;
  const summary = { repos: 0, changed: 0, files: [] };
  // the user's own settings first: the machine-wide wiring
  try {
    const u = refreshWiring(null, { scope: 'user', cli, mcpEntry: ctx.userMcpEntry(), dry });
    if (u.changed.length) { summary.changed++; summary.files.push(...u.changed); if (!quiet) out(`your settings: ${dry ? 'would rewrite' : 'rewrote'} ${u.changed.join(', ')}`); }
    if (!quiet) for (const s of u.skipped) out(`your settings: ${s.client} left alone: ${s.reason}`);
  } catch (e) { if (!quiet) out(`your settings: ${e.message}`); }
  for (const r of repos) {
    let res;
    try { res = refreshWiring(r, { cli, mcpEntry: { command: 'node', args: [path.join(HERE, 'mcp.js')], env: { THINKER_REPO: r } }, dry }); } catch (e) { if (!quiet) out(`${r}: ${e.message}`); continue; }
    summary.repos++;
    if (res.changed.length) { summary.changed++; summary.files.push(...res.changed.map(f => path.join(r, f))); }
    if (quiet) continue;
    if (res.changed.length) out(`${r}: ${dry ? 'would rewrite' : 'rewrote'} ${res.changed.join(', ')}`);
    for (const s of res.skipped) out(`${r}: ${s.client} left alone: ${s.reason}`);
  }
  if (!dry && summary.changed) store.log({ op: 'rewire', repos: summary.changed, files: summary.files.length });
  // agents the checkouts wire but the user's own settings do not yet: wired there now (clients.js:connectFromCheckouts)
  if (!flags.here) {
    try {
      summary.connected = connectFromCheckouts(repos, { cli, mcpEntry: ctx.userMcpEntry(), dry }).map(c => c.client);
      if (summary.connected.length && !dry) store.log({ op: 'connect', clients: summary.connected, from: 'rewire' });
      if (summary.connected.length && !quiet) out(`your settings: ${dry ? 'would wire' : 'wired'} thinker in for ${summary.connected.join(', ')}; the checkouts switch to it on their next prompt`);
    } catch (e) { if (!quiet) out(`your settings: ${e.message}`); }
  }
  if (flags.json) { out(JSON.stringify(summary)); return; }
  if (!quiet) out(summary.changed ? `${dry ? 'would rewire' : 'rewired'} ${summary.changed} of ${summary.repos} checkouts` : `${summary.repos} checkouts checked; the wiring is current`);
}

// After an update the new copy rewrites the hooks of every checkout it is wired into, so a new
// event or command reaches them without `thinker setup` being rerun. The new code knows the new
// shape, so it is the new cli that runs, not this process.
function rewireAfterUpdate(newCli, { quiet }) {
  if (!fs.existsSync(newCli)) return null;
  const r = spawnSync('node', [newCli, 'rewire', '--json', '--quiet'], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, THINKER_TELEMETRY: process.env.THINKER_TELEMETRY || 'off' } });
  let summary = null; try { summary = JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch {}
  if (summary && !quiet && summary.changed) process.stdout.write(`Rewired the hooks of ${summary.changed} ${summary.changed === 1 ? 'checkout' : 'checkouts'} for the new version.\n`);
  if (summary?.connected?.length && !quiet) process.stdout.write(`Wired thinker into your own settings for ${summary.connected.join(', ')} (it runs in every repository that is set up); your checkouts switch to it on their next prompt.\n`);
  return summary;
}
const newCliOf = (install, home) => install.type === 'git' ? path.join(install.path, 'src', 'cli.js') : path.join(home, 'app', 'src', 'cli.js');

async function updateCommand(ctx) {
  const { cmd, pos, flags, store, out, HERE } = ctx;
  const home = thinkerHome();
  const install = detectInstall(path.resolve(HERE, '..'), home);
  const targetRef = flags.branch || flags.ref || (pos[0] && !pos[0].startsWith('-') ? pos[0] : null);

  if (cmd === 'branch' && !targetRef) {
    if (install.type === 'git') {
      out(`On branch ${install.branch || 'detached'} (${install.commit ? install.commit.slice(0, 7) : 'unknown'})`);
    } else {
      out(`On ref ${install.ref || 'main'} (${install.commit ? install.commit.slice(0, 7) : 'unknown'})`);
    }
    return;
  }

  if (flags.status) {
    out('Thinker installation:');
    out(`  Type:         ${install.type === 'git' ? 'git checkout' : 'archive'}`);
    out(`  Path:         ${install.path}`);
    out(`  Version:      ${install.version}`);
    if (install.type === 'git') {
      out(`  Branch:       ${install.branch || 'detached'}`);
      out(`  Commit:       ${install.commit ? install.commit.slice(0, 7) : 'unknown'}`);
    } else {
      out(`  Repository:   ${install.ghrepo || 'yoavshmariahu/thinker'}`);
      out(`  Ref:          ${install.ref || 'main'}`);
      out(`  Commit:       ${install.commit ? install.commit.slice(0, 7) : 'unknown'}`);
    }
    const sched = isScheduled(home);
    out('Auto-updates:');
    out(`  Schedule:     ${sched ? (process.platform === 'darwin' ? 'active (LaunchAgent: ' + getLaunchAgentPath() + ')' : 'active (cron)') : 'inactive'}`);
    const stamp = path.join(home, 'state', 'update.last');
    let lastCheck = 'never';
    try {
      const st = fs.statSync(stamp);
      lastCheck = new Date(st.mtimeMs).toLocaleString();
    } catch {}
    out(`  Last check:   ${lastCheck}`);
    return;
  }

  if (flags.schedule || flags.daily) {
    try {
      const res = scheduleDaily({ home, binPath: install.binPath });
      if (res.type === 'invocation') {
        out(`Daily OS scheduling unavailable (${res.reason}); thinker will check for updates when invoked, at most once a day, unless auto-updates are disabled.`);
      } else {
        out(`Scheduled daily auto-update for thinker (${res.type === 'launchd' ? 'LaunchAgent: ' + res.path : 'cron: ' + res.line}).`);
      }
    } catch (e) {
      out(`Failed to schedule daily auto-update: ${e.message}`);
      process.exit(1);
    }
    return;
  }

  if (flags.unschedule) {
    const res = unscheduleDaily({ home });
    if (res.unscheduled) out('Removed scheduled daily auto-update for thinker.');
    else out('No scheduled daily auto-update was found.');
    return;
  }

  if (flags.background) {
    const lock = path.join(home, 'state', 'update.lock');
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs < 15 * 60_000) return;
    } catch {}
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, String(process.pid));
    try {
      const chk = await checkUpdate({ home, install });
      if (chk.available) {
        const res = await applyUpdate({ home, install, quiet: true, background: true });
        if (res.updated) {
          const rewired = rewireAfterUpdate(newCliOf(install, home), { quiet: true });
          const noticeFile = path.join(home, 'state', 'update-notice.json');
          fs.writeFileSync(noticeFile, JSON.stringify({ from: res.from, to: res.to, version: res.version, rewired: rewired?.changed || 0, at: new Date().toISOString() }));
          store.log({ op: 'update', from: res.from, to: res.to, version: res.version, auto: true });
        }
      }
    } catch {}
    finally {
      try { fs.rmSync(lock, { force: true }); } catch {}
    }
    return;
  }

  if (!flags.quiet) {
    if (targetRef && (install.branch !== targetRef && install.ref !== targetRef)) {
      out(`Checking branch ${targetRef}...`);
    } else {
      out('Checking for updates...');
    }
  }

  let chk;
  try {
    chk = await checkUpdate({ home, install, ghrepo: flags.repo, ref: targetRef });
  } catch (e) {
    out(`Update check failed: ${e.message}`);
    process.exit(1);
  }

  if (flags.check) {
    if (chk.available) {
      const target = chk.targetBranch || chk.targetRef || targetRef || '';
      out(`Update available${target ? ` for ${target}` : ''}: ${chk.currentCommit ? chk.currentCommit.slice(0, 7) : 'v' + chk.version} → ${chk.latestCommit ? chk.latestCommit.slice(0, 7) : 'latest'}`);
      if (chk.commitMessage) out(`  ${chk.commitMessage}`);
    } else {
      out(`thinker is already up to date on ${chk.branch || chk.ref || 'main'} (${chk.currentCommit ? chk.currentCommit.slice(0, 7) : 'v' + chk.version}).`);
    }
    return;
  }

  if (!chk.available && !flags.force) {
    if (!flags.quiet) {
      out(`thinker is already up to date on ${chk.branch || chk.ref || 'main'} (${chk.currentCommit ? chk.currentCommit.slice(0, 7) : 'v' + chk.version}).`);
      if (!isScheduled(home)) {
        out('Tip: Run `thinker update --schedule` to enable daily automatic background updates.');
      }
    }
    return;
  }

  if (!flags.quiet) {
    if (chk.switchingBranch || chk.switchingRef) {
      out(`Switching thinker to ${chk.targetBranch || chk.targetRef} (${chk.currentCommit ? chk.currentCommit.slice(0, 7) : 'current'} → ${chk.latestCommit ? chk.latestCommit.slice(0, 7) : 'latest'})...`);
    } else {
      out(`Updating thinker (${chk.currentCommit ? chk.currentCommit.slice(0, 7) : 'v' + chk.version} → ${chk.latestCommit ? chk.latestCommit.slice(0, 7) : 'latest'})...`);
    }
  }

  try {
    const res = await applyUpdate({ home, install, force: !!flags.force, quiet: !!flags.quiet, ghrepo: flags.repo, ref: targetRef });
    if (!flags.quiet) {
      const branchInfo = res.branch ? ` on branch ${res.branch}` : (res.ref ? ` on ref ${res.ref}` : '');
      out(`Updated thinker${branchInfo} to ${res.to ? res.to.slice(0, 7) : res.version} (v${res.version || 'latest'}).`);
    }
    rewireAfterUpdate(newCliOf(install, home), { quiet: !!flags.quiet });
    if (!flags.quiet) {
      if (!isScheduled(home)) {
        out('Tip: Run `thinker update --schedule` to enable daily automatic background updates.');
      }
    }
    store.log({ op: 'update', from: res.from, to: res.to, version: res.version, branch: res.branch || res.ref, auto: false });
  } catch (e) {
    out(`Update failed: ${e.message}`);
    process.exit(1);
  }
  return;
}

// The one command that sets a repository up: wire it into the agents, then offer to build the
// cache from its code and merged pull requests. The offer is the only step that spends anything,
// so it is a question (--build answers yes, --no-build answers no and leaves the wiring alone).
export async function setup(ctx) {
  const { flags, repo, store, out, learnOn, mcpEntry, HERE } = ctx;
  const clients = parseClients(flags.clients, parseClients('auto'));
  const num = (v, d) => v === undefined || v === true || Number.isNaN(Number(v)) ? d : Number(v);
  const areas = flags['no-seed'] ? 0 : num(flags.areas, 12);
  const slug = flags['no-prs'] ? null : (typeof flags.slug === 'string' ? flags.slug : githubSlug(repo));
  const prs = flags['no-prs'] ? 0 : num(flags.prs, 60);
  const agent = typeof flags.agent === 'string' ? flags.agent : (process.env.THINKER_LLM || null);
  // asking for a size is asking for the build; --no-build (or both --no-seed and --no-prs) is a no
  const askedToBuild = Boolean(flags.build) || flags.areas !== undefined || flags.prs !== undefined || Boolean(flags['propose-behaviors']);
  const build = flags['no-build'] || (flags['no-seed'] && flags['no-prs']) ? false : (askedToBuild ? true : null);

  await runSetup({
    repo,
    store,
    cliPath: path.join(HERE, 'cli.js'),
    mcpEntry: mcpEntry(),
    userMcpEntry: ctx.userMcpEntry(),
    clients,
    areas,
    prs,
    prNumber: flags.pr ? Number(flags.pr) : null,
    build,
    benchmark: Boolean(flags.benchmark),
    noBenchmark: Boolean(flags['no-benchmark']),
    noSeed: Boolean(flags['no-seed']) || build === false,
    noPrs: Boolean(flags['no-prs']) || build === false,
    noPhrase: Boolean(flags['no-phrase']),
    proposeBehaviors: Boolean(flags['propose-behaviors']),
    model: flags.model,
    agent,
    yes: Boolean(flags.yes),
    hooks: !flags['no-hooks'],
    learn: !flags['no-hooks'] && learnOn(),
    late: !flags['no-late'],
    mcp: !flags['no-mcp'],
    gitHook: !flags['no-git-hook'],
    noTrust: Boolean(flags['no-trust']),
    exportFile: typeof flags.export === 'string' ? flags.export : null,
    out,
    seedFn: async (opts) => seed(ctx, opts),
    minePrsFn: async (slug, opts) => minePrs(ctx, slug, { ...opts, repo, phase: 'init' }),
  });
}

export const commands = {
  'init': initCommand,
  'setup': setupCommand,
  'connect': connectCommand,
  'uninstall': uninstallCommand,
  'ast': astCommand,
  'ranker': rankerCommand,
  'switch': updateCommand,
  'rewire': rewireCommand,
  'branch': updateCommand,
  'update': updateCommand,
  'upgrade': updateCommand,
};
