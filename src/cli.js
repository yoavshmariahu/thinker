#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync, execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, findRepoRoot, gitHead } from './store.js';
import { maintain, maintenanceNotice, renderMaintain } from './maintain.js';
import { orient, HOOK_BUDGET, rememberTask, phraseNotes, phraseKey, lookup, drilldown, find, createNote, refresh, verifyNote, renderNote, attest, linkNotes, outcome, looksLikeCorrection, lateNotes, completenessNudge, takeTurn } from './ops.js';
import { initAst, astStatus, astDirs, AST_PACKAGES, GRAMMAR_NAMES } from './ast.js';
import { annotateFanout } from './codegraph.js';
import { installCbm, cbmBin, cbmDir, cbmIndex, cbmForget, cbmStatus, CBM_VERSION } from './cbm.js';
import { listMergedPrs, listMergedCommits, distillPr, minedPrs, recordMinedPrs, nextPrs, stratifyPrs } from './prs.js';
import { discoverAreas, subsystemForFile } from './topology.js';
import { loadCochange } from './cochange.js';
import { mineCochange, partners } from './cochange.js';
import { hashDep } from './deps.js';
import { CLIENTS, parseClients, installClient, uninstallClients, trustCodex, hookClient, sessionOf, toolFiles, promptOutput, toolOutput, stopOutput, parkPending, takePending } from './clients.js';
import { recordEvent, traceFile, toolName, toolInput, hydrate, findSessions } from './transcripts.js';
import { available, provider, findBin, resolveModel, FALLBACK_ORDER, BINS } from './llm.js';
import { logModelUsage, streamModelUsage } from './model-usage.js';
import { summarize, renderUsage, sessionKey, cacheHitNotice, turnNotice } from './usage.js';
import { parseTranscript, exploreCount, distillEvents, saveNotes, transcriptsFor, injectedIds, relatedNotes } from './distill.js';
import { MORE_NOTES_INTRO } from './cache-guidance.js';
import { benchmarkAgent, coveredBenchmarkQuestions, latestBenchmark, renderBenchmarkReport, runBenchmarkAgent, saveBenchmark, isAuthError, cleanErrorMessage } from './benchmark.js';
import { thinkerHome, detectInstall, checkUpdate, applyUpdate, scheduleDaily, unscheduleDaily, isScheduled, maybeCheckDailyUpdateInBackground, checkPendingNotice, getLaunchAgentPath } from './update.js';
import { isTelemetryEnabled, getTelemetryEndpoint, buildTelemetryPayload, sendTelemetry, maybeSendTelemetryInBackground, maybeSendDailyTelemetryInBackground, scheduleTelemetry, unscheduleTelemetry, isTelemetryScheduled, getTelemetryLaunchAgentPath } from './telemetry.js';
import { runSetup, stepPrBenchmark, selectAndAuthenticateAgent, selectMenu, getAgentLoginCommand, getAgentDisplayName, c } from './setup.js';
import { batchProgress, oneLine } from './progress.js';
import { installGitHooks, uninstallGitHooks } from './git-hooks.js';
import { share, validateShare, validatePush } from './share.js';
import { repairStaged } from './share-repair.js';
import { exportCache, importCache } from './transfer.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const cmd = argv.shift();
const flags = {}; const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const boolean = cmd === 'share' && ['all', 'dry', 'check', 'strict', 'pre-push', 'repair-staged'].includes(k); const v = !boolean && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; flags[k] = v; }
  else pos.push(argv[i]);
}
const repo = findRepoRoot(flags.repo || process.env.THINKER_REPO || process.cwd());
const store = new Store(repo);
const out = s => process.stdout.write(s + '\n');
const readStdin = () => fs.readFileSync(0, 'utf8');

// Learning from sessions is on unless switched off, which evals do to keep the cache fixed.
const NO_LEARN = /^(1|true|yes)$/i.test(process.env.THINKER_NO_LEARN || '');
const learnOn = () => !NO_LEARN && !flags['no-learn'] && !flags['serve-only'];
// Learning from sessions (the end-of-turn distill and the catch-up `learn`) is a model call per
// session, about 10¢ with Sonnet, and in a week on this repository 30% of them produced no note.
// `learn: {sessions: false}` in .thinker/config.json keeps it off while learning from code changes
// goes on: pull requests and verification in maintenance, `share --repair-staged` at commit.
// `thinker distill <file>` by hand is still answered. THINKER_NO_LEARN=1 switches off everything.
const sessionLearning = () => store.config().learn?.sessions !== false;

const mcpEntry = () => ({ command: 'node', args: [path.join(HERE, 'mcp.js')], env: { THINKER_REPO: repo } });

const HELP = `thinker — knowledge cache for coding agents

  setup [--clients list|all|auto] [--agent a] [--areas n] [--prs n] [--pr <num>] [--benchmark] [--no-benchmark] [--no-git-hook] [--yes] [--verbose]
                                 guided 3-step setup: connect harness CLIs, build the knowledge cache with
                                 pre-flight estimates (time, size, location), and run an optional PR change benchmark;
                                 --verbose includes per-item diagnostic details
  init [--no-learn] [--no-hooks] [--no-late] [--local] [--no-git-hook] [--no-mcp] [--no-trust] [--yes] [--clients list|all|auto]
                                 set up .thinker/, hooks and the MCP server for this repo (clients: claude, codex, cursor, gemini; default claude)
  uninstall [--purge]            remove hooks and MCP registration (notes are kept unless --purge)
  share [ids…] [--all] [--dry]    promote eligible local notes for review and commit
  share --check [--base ref]      report issues in committed notes (exit 0)
  share --repair-staged           repair or remove invalid staged notes before commit
                                 --strict makes manual/CI checks fail on issues
                                 --ref commit (default HEAD); --pre-push reads git stdin
  export [file.tgz]              pack this repo's cache for delivery
  import <file.tgz|url>          unpack a delivered cache and check it against this checkout
  serve                          run the MCP server (stdio)
  orient "<task>" [--file f] [--budget n] [--snippets]
  lookup "<query>" [--snippets]  (--snippets: inline the code behind the pointers, as the MCP tools do)
  find "<words|Identifier>" [--path p] [--limit n]
                                 the definitions whose name or body carry the words, as pointers with their lines
  drilldown <pointer…> [--budget n]
                                 each definition whole with its lines (path:Symbol, path, or Symbol; several at once),
                                 one hop of callers and callees for a single pointer, and the notes on the code
  ast [status|install]           symbol boundaries by tree-sitter instead of regex heuristics: install puts
                                 web-tree-sitter and its grammars (Python, JS/TS, Go, Rust; ~55 MB) under ~/.thinker/ast
  cbm [status|install|index|forget]
                                 codebase-memory-mcp as the code graph behind drilldown and the blast-radius counts:
                                 install puts the binary (~40 MB) under ~/.thinker/cbm, index builds its graph of this
                                 checkout (and maintenance keeps it current); without it, git grep answers
  list [--stale] [--all]         list notes
  show <id>                      print a note
  rm <id>
  add [file.json]                add a human-written note (JSON on stdin or file)
  check                          re-hash dependencies, mark stale notes
  rehash [--fanout]              re-baseline every note's hashes without verification (--fanout: count references again)
  cochange [file]                mine co-change edges from git history / show partners of a file
  relink                         recompute cross-note links
  verify [ids...] [--model m]    re-verify stale notes with a small model
  maintain [--dry]               one background maintenance run: re-verify stale notes, phrase new ones, refresh
                                 co-change, distill newly merged PRs; runs by itself from the hooks, under a daily cap
  phrase [ids...] [--model m] [--force]
                                 add to each note how a user would put it, in the words of the product (for retrieval)
  distill [transcript] [--format auto|claude|codex|cursor|gemini|events] [--min-explore n] [--dry] [--model m]
                                 turn a session into notes; reads any of these agents' transcripts, or a plain event trace
  learn [--days n] [--max n] [--idle-min n] [--prs [n]] [--maintain] [--dry]
                                 distill every session any supported agent ran in this repo that has not been distilled yet;
                                 --prs also mines merged pull requests that were not mined before (default 20)
  record <session>               append events (JSON lines on stdin: {t:prompt|say|tool, ...}) to a session trace, for agents without hooks
  seed [--areas n] [--prompts f.json] [--agent a] [--dry]   bootstrap coverage: one exploration session per source area
  outcome <session> good|bad [reason]           apply an outcome signal to the notes served in a session
  mine-prs [owner/repo] [--limit n] [--dry]
                                 distill merged PRs into fix / invariant / convention notes: those merged since the last run,
                                 then older ones; mined PRs are recorded in .thinker/prs.json and never distilled twice
                                 (default repo: the GitHub origin; --before <iso> [--after <iso>] [--again] picks a window by hand)
  hook <prompt|tool|stop [--nudge]> [--client c]   hook entrypoints (JSON on stdin): prompt = early injection, tool = late file-keyed injection, stop = nudge + distill
  usage [--here] [--days n] [--json]
                                 how the cache has been used on this machine, in every repository: notes served, what sessions
                                 did with them, build/distillation tokens and reported cost, and estimated savings
                                 (--here: this repository only; history is kept in ~/.thinker/log.jsonl)
  benchmark pr [number] [--agent a] [--model m] [--budget n]
                                 run a paired benchmark on a recent PR change with vs without the cache
  benchmark [run ["<repo question>"]] [--agent a] [--model m] [--budget n]
                                 run a paired, read-only setup benchmark without and with relevant cached notes;
                                 with no question, offers questions the cache covers (picks the first outside a terminal)
  benchmark report              show the latest comparison (answers are saved for human quality review)
  update [branch] [--branch b] [--check] [--force] [--quiet] [--schedule] [--unschedule] [--status]
                                 update thinker CLI or switch to a branch version; --schedule / --unschedule manages daily background updates
  switch <branch>                switch thinker CLI to a specific branch version
  branch                         show current branch or ref
  upgrade                        alias for update
  stats
  telemetry [--send] [--json] [--force] [--event name] [--schedule] [--unschedule] [--status]
                                 cache effectiveness and size metrics sent to the metrics service;
                                 --schedule / --unschedule manages hourly background telemetry
`;

async function main() {
  if (process.stderr.isTTY && !['update', 'upgrade', 'switch', 'branch', 'hook', 'serve'].includes(cmd) && !process.env.THINKER_LOG) {
    const notice = checkPendingNotice(thinkerHome());
    if (notice) process.stderr.write(`[thinker] ${notice}\n`);
  }
  if (!['update', 'upgrade', 'switch', 'branch', 'telemetry', 'setup', 'init', 'share'].includes(cmd) && !flags.background) {
    maybeCheckDailyUpdateInBackground({ home: thinkerHome(), cliPath: path.join(HERE, 'cli.js') });
    maybeSendTelemetryInBackground({ home: thinkerHome(), cliPath: path.join(HERE, 'cli.js'), store });
  }
  // symbol boundaries by tree-sitter where its grammars are installed (`thinker ast install`), else by regex
  if (!['update', 'upgrade', 'switch', 'branch', 'serve', 'ast', 'cbm', 'usage', 'stats', 'telemetry', 'help', undefined].includes(cmd)) await initAst();

  switch (cmd) {
    case 'ast': {
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
        break;
      }
      const st = await initAst();
      out(st.available ? `tree-sitter: on (${st.dir}); grammars: ${st.grammars.join(', ')}` : `tree-sitter: off (regex heuristics in use)${st.error ? `: ${st.error}` : ''}\nlooked in: ${astDirs().join(', ')}\ninstall with: thinker ast install   (grammars: ${GRAMMAR_NAMES.join(', ')})`);
      break;
    }
    case 'cbm': {
      if (pos[0] === 'install') {
        const have = cbmBin();
        if (have && !have.startsWith(flags.dir || cbmDir()) && !flags.force) { out(`codebase-memory-mcp is already installed at ${have}; thinker uses it (a second copy would compete for its daemon). --force installs anyway.`); break; }
        const bin = await installCbm({ dir: flags.dir || undefined, log: out });
        out(`codebase-memory-mcp ${CBM_VERSION} installed at ${bin}. Next: thinker cbm index`);
        break;
      }
      if (pos[0] === 'index') {
        if (!cbmBin()) { out('codebase-memory-mcp is not installed: thinker cbm install'); process.exit(1); }
        out(`indexing ${store.repo} with codebase-memory-mcp…`);
        const r = cbmIndex(store.repo, { name: flags.name, stdio: ['ignore', 'pipe', 'inherit'] });
        if (r.error) { out('error: ' + r.error); process.exit(1); }
        out(`indexed as ${r.project}: ${r.nodes} nodes, ${r.edges} edges${r.parse_partial_count ? ` (${r.parse_partial_count} files parsed partially)` : ''}. drilldown and fanout now come from the graph; maintenance re-indexes when HEAD moves.`);
        break;
      }
      if (pos[0] === 'forget') { const r = cbmForget(store.repo); out(r.error ? 'error: ' + r.error : 'index removed; git grep answers again'); break; }
      const st = cbmStatus(store.repo);
      if (!st.bin) out(`codebase-memory-mcp: not installed (git grep answers)\nlooked in: THINKER_CBM_BIN, ~/.local/bin, PATH, ${cbmDir()}\ninstall with: thinker cbm install`);
      else out(`codebase-memory-mcp ${st.version || '?'} at ${st.bin}\nthis checkout: ${st.project ? `indexed as ${st.project}` : 'not indexed (thinker cbm index)'}; ${st.projects ?? '?'} project${st.projects === 1 ? '' : 's'} indexed on this machine\nengine for drilldown and fanout: ${st.engine}${process.env.THINKER_CODEGRAPH ? ` (THINKER_CODEGRAPH=${process.env.THINKER_CODEGRAPH})` : ''}`);
      break;
    }
    case 'drilldown': {
      const r = drilldown(store, { pointer: pos.join(' '), client: flags.client || 'cli', budget: Number(flags.budget) || 2500 });
      if (r.error) { out('error: ' + r.error); process.exit(1); }
      out(r.text);
      break;
    }
    case 'find': {
      const r = find(store, { query: pos.join(' '), path: flags.path || undefined, limit: Number(flags.limit) || 12, client: flags.client || 'cli' });
      if (r.error) { out('error: ' + r.error); process.exit(1); }
      out(r.text);
      break;
    }
    case 'switch':
    case 'branch':
    case 'update':
    case 'upgrade': {
      const home = thinkerHome();
      const install = detectInstall(path.resolve(HERE, '..'), home);
      const targetRef = flags.branch || flags.ref || (pos[0] && !pos[0].startsWith('-') ? pos[0] : null);

      if (cmd === 'branch' && !targetRef) {
        if (install.type === 'git') {
          out(`On branch ${install.branch || 'detached'} (${install.commit ? install.commit.slice(0, 7) : 'unknown'})`);
        } else {
          out(`On ref ${install.ref || 'main'} (${install.commit ? install.commit.slice(0, 7) : 'unknown'})`);
        }
        break;
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
        break;
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
        break;
      }

      if (flags.unschedule) {
        const res = unscheduleDaily({ home });
        if (res.unscheduled) out('Removed scheduled daily auto-update for thinker.');
        else out('No scheduled daily auto-update was found.');
        break;
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
              const noticeFile = path.join(home, 'state', 'update-notice.json');
              fs.writeFileSync(noticeFile, JSON.stringify({ from: res.from, to: res.to, version: res.version, at: new Date().toISOString() }));
              store.log({ op: 'update', from: res.from, to: res.to, version: res.version, auto: true });
            }
          }
        } catch {}
        finally {
          try { fs.rmSync(lock, { force: true }); } catch {}
        }
        break;
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
        break;
      }

      if (!chk.available && !flags.force) {
        if (!flags.quiet) {
          out(`thinker is already up to date on ${chk.branch || chk.ref || 'main'} (${chk.currentCommit ? chk.currentCommit.slice(0, 7) : 'v' + chk.version}).`);
          if (!isScheduled(home)) {
            out('Tip: Run `thinker update --schedule` to enable daily automatic background updates.');
          }
        }
        break;
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
          if (!isScheduled(home)) {
            out('Tip: Run `thinker update --schedule` to enable daily automatic background updates.');
          }
        }
        store.log({ op: 'update', from: res.from, to: res.to, version: res.version, branch: res.branch || res.ref, auto: false });
      } catch (e) {
        out(`Update failed: ${e.message}`);
        process.exit(1);
      }
      break;
    }
    case 'init': {
      // hooks serve notes and learn from sessions by default. flags: --no-learn (serve only, for evals; --serve-only is
      //        the older name), --no-hooks (MCP server only), --late (file-keyed notes),
      //        --local (write .claude/settings.local.json, not shared), --no-git-hook, --no-mcp, --clients,
      //        --no-trust (leave Codex's trust in the project and the hooks to the user), --yes (do not ask)
      await init({ clients: parseClients(flags.clients, 'auto'), hooks: !flags['no-hooks'], learn: !flags['no-hooks'] && learnOn(), late: !flags['no-late'], shared: !flags.local, mcp: !flags['no-mcp'], gitHook: !flags['no-git-hook'] });
      maybeSendDailyTelemetryInBackground({ home: thinkerHome(), cliPath: path.join(HERE, 'cli.js'), store, force: true, event: 'install' });
      break;
    }
    case 'setup': {
      await setup();
      break;
    }
    case 'uninstall': {
      // remove hooks, MCP registration and scheduled daily updates; notes stay unless --purge
      unscheduleDaily({ home: thinkerHome() });
      unscheduleTelemetry({ home: thinkerHome() });
      uninstallClients(repo);
      uninstallGitHooks(repo);
      if (flags.purge) fs.rmSync(store.dir, { recursive: true, force: true });
      out(`removed thinker hooks and MCP registration from ${repo}${flags.purge ? ' and deleted .thinker/' : ' (notes kept in .thinker/)'}`);
      break;
    }
    case 'share': {
      if (flags['repair-staged']) {
        const actions = await repairStaged(store, { dry: !!flags.dry, model: flags.model });
        for (const a of actions) out(`${flags.dry ? 'would ' : ''}${a.action} ${a.id}: ${a.reason}`);
        if (actions.length) out(`thinker: ${actions.filter(a => a.action === 'update').length} corrected, ${actions.filter(a => a.action === 'remove').length} removed from this commit; originals saved locally`);
      } else if (flags.check || flags['pre-push']) {
        const opts = { base: typeof flags.base === 'string' ? flags.base : undefined, ref: flags.ref || 'HEAD', strict: !!flags.strict, remote: flags.remote || 'origin' };
        const results = flags['pre-push'] ? validatePush(repo, readStdin(), opts) : [validateShare(repo, opts)];
        for (const r of results) {
          for (const w of r.warnings) out(`warning ${w.id}: ${w.message}`);
          for (const e of r.errors) out(`${flags.strict && !flags['pre-push'] ? 'error' : 'warning'} ${e.id}: ${e.message}`);
          out(`checked ${r.checked} shared notes at ${r.ref.slice(0, 10)}: ${r.errors.length} issues, ${r.warnings.length} other warnings${flags['pre-push'] ? '; push allowed' : ''}`);
        }
        if (flags.strict && !flags['pre-push'] && results.some(r => r.errors.length)) process.exitCode = 2;
      } else {
        const result = share(store, { ids: pos, all: !!flags.all, dry: !!flags.dry });
        for (const r of result.ready) out(`${flags.dry ? 'would ' : ''}${r.action} ${r.id}`);
        for (const r of result.skipped) out(`skip ${r.id}: ${r.reasons.join('; ')}`);
        for (const r of result.superseded) out(`superseded ${r.id}: a pull replaced this note while a change to it (${r.fields.join(', ')}) was unshared here; thinker show ${r.id} prints it`);
        for (const u of result.unreadable) out(`warning: ${path.relative(repo, u.file)} is not served: ${u.reason}`);
        out(`${result.ready.length} notes ${flags.dry ? 'ready to share' : 'shared; review and commit .thinker/notes/'}`);
      }
      break;
    }
    case 'export': {
      const file = path.resolve(pos[0] || `thinker-cache-${path.basename(repo)}.tgz`);
      const result = exportCache(store, file);
      out(`exported ${result.notes} notes → ${file}`);
      break;
    }
    case 'import': {
      if (!pos[0]) throw new Error('usage: thinker import <file.tgz | https://…>');
      const result = importCache(store, pos[0]);
      const notes = refresh(store, store.list());
      out(`imported ${result.notes} notes into the local cache; ${notes.filter(n => n.status === 'stale').length} are stale against this checkout`);
      break;
    }
    case 'serve': {
      const p = spawn('node', [path.join(HERE, 'mcp.js')], { stdio: 'inherit', env: { ...process.env, THINKER_REPO: repo } });
      p.on('exit', c => process.exit(c || 0));
      break;
    }
    case 'orient': {
      const r = await orient(store, { task: pos.join(' '), file: flags.file, client: flags.client || 'cli', budget: Number(flags.budget) || 1000, snippets: !!flags.snippets });
      out(r.included.length ? r.text : '(no matching notes)');
      break;
    }
    case 'lookup': {
      const r = lookup(store, { query: pos.join(' '), client: flags.client || 'cli', budget: Number(flags.budget) || 2500, maxNotes: flags.n ? Number(flags.n) : 3, snippets: !!flags.snippets });
      out(r.included.length ? r.text : '(nothing cached about that)');
      break;
    }
    case 'list': {
      let notes = refresh(store, store.list());
      if (flags.stale) notes = notes.filter(n => n.status === 'stale');
      if (!flags.all) notes = notes.filter(n => n.status !== 'invalid');
      for (const n of notes) out(`${(store.isShared(n.id) ? 'repo' : 'local').padEnd(5)} ${n.status.padEnd(7)} ${String(n.kind).padEnd(10)} ${n.id.padEnd(45)} c=${Math.round((n.confidence ?? 0.7) * 100)}% uses=${n.uses || 0}  ${n.title}`);
      for (const u of store.unreadable()) out(`warning: ${path.relative(repo, u.file)} is not served: ${u.reason}`);
      out(`${notes.length} notes`);
      break;
    }
    case 'show': {
      const n = store.get(pos[0]); if (!n) { out('no such note'); process.exit(1); }
      out(flags.json ? JSON.stringify(n, null, 2) : renderNote(n) + `\nsource: ${JSON.stringify(n.source)}  verified: ${n.verified}  status: ${n.status}  attest: ${JSON.stringify(n.attest || {})}  related: ${(n.related || []).join(', ') || '-'}`);
      const sup = store.superseded(pos[0]);
      if (sup && !flags.json) out(`\nsuperseded: a pull replaced this note while this checkout had an unshared change to it (${Object.keys(sup.pending).join(', ')}). Kept in .thinker/local/shared/${pos[0]}.json; put it back with feedback or remember if it still holds.` + (sup.pending.body ? `\n--- unshared body ---\n${sup.pending.body}` : ''));
      break;
    }
    case 'rm': { out(store.remove(pos[0]) ? 'removed' : 'no such note'); break; }
    case 'add': {
      const input = JSON.parse(pos[0] ? fs.readFileSync(pos[0], 'utf8') : readStdin());
      const r = createNote(store, input, { source: { type: flags.source || 'human' } });
      if (r.error) { out('error: ' + r.error); process.exit(1); }
      out(`saved ${r.note.id}` + (r.dropped.length ? ` (dropped: ${JSON.stringify(r.dropped)})` : ''));
      break;
    }
    case 'cochange': {
      if (pos[0]) { const idx = JSON.parse(fs.readFileSync(path.join(store.dir, 'cochange.json'), 'utf8')); for (const p of partners(idx, pos[0], { minSupport: 2, minConf: 0.3 })) out(`${p.file}  ${Math.round(p.conf * 100)}%  n=${p.support}`); break; }
      const idx = mineCochange(repo, { commits: Number(flags.commits) || 800 });
      out(`mined ${idx.commits} commits, ${Object.keys(idx.totals).length} files → ${store.dir}/cochange.json`);
      break;
    }
    case 'relink': { const notes = store.list(); for (const n of notes) linkNotes(store, n, notes); out(`linked ${notes.length} notes`); break; }
    case 'rehash': {
      // Re-baseline every note's dependency hashes against the current tree
      // without LLM verification (use after upgrading thinker's hashing).
      let n = 0;
      for (const note of store.list()) { note.deps = (note.deps || []).map(d => ({ ...hashDep(store.repo, d), ...(d.fanout ? { fanout: d.fanout } : {}) })).filter(d => !d.missing); if (flags.fanout) note.deps = annotateFanout(store.repo, note.deps, { max: 12 }); note.status = note.status === 'invalid' ? 'invalid' : 'fresh'; delete note.stale; delete note.verifying; store.put(note); n++; }
      out(`rehashed ${n} notes${flags.fanout ? ' and counted their references' : ''}`);
      break;
    }
    case 'check': {
      const notes = refresh(store, store.list(), { narrow: true });
      const stale = notes.filter(n => n.status === 'stale');
      if (!flags.quiet) {
        for (const n of stale) out(`stale  ${n.id}: ${n.stale.changed.map(c => `${c.path}${c.symbol ? ':' + c.symbol : ''} (${c.reason})`).join(', ')}`);
        for (const u of store.unreadable()) out(`warning: ${path.relative(repo, u.file)} is not served: ${u.reason}`);
        out(`${stale.length}/${notes.length} notes stale`);
      }
      if (flags.verify && stale.length) await verifyAll(stale);
      break;
    }
    case 'phrase': {
      // how a user would put what each note is about; notes that have it for their present text are left (--force)
      let notes = store.list().filter(n => n.status !== 'invalid' && (!pos.length || pos.includes(n.id)));
      if (!flags.force) notes = notes.filter(n => !n.says?.length || n.saysFor !== phraseKey(n));
      const per = 8, conc = Number(flags.conc) || 4;
      const groups = []; for (let i = 0; i < notes.length; i += per) groups.push(notes.slice(i, i + per));
      let n = 0, cost = 0;
      await Promise.all(Array.from({ length: conc }, async () => {
        while (groups.length) {
          const g = groups.shift();
          try { const r = await phraseNotes(store, g, { model: flags.model }); n += r.done.length; cost += r.cost || 0; }
          catch (e) { out(`phrase: ${g.length} notes skipped (${String(e.message).slice(0, 120)})`); }
        }
      }));
      out(`phrasings written for ${n} of ${notes.length} notes${cost ? ` ($${cost.toFixed(2)})` : ''}`);
      break;
    }
    case 'verify': {
      let notes = refresh(store, store.list());
      notes = pos.length ? notes.filter(n => pos.includes(n.id)) : notes.filter(n => n.status === 'stale');
      await verifyAll(notes);
      break;
    }
    case 'distill': {
      let file = pos[0];
      if (!file) { file = transcriptsFor(repo)[0]; if (!file) { out('no transcript found for ' + repo); process.exit(1); } }
      await distillFile(file, { minExplore: Number(flags['min-explore']) || 1, dry: !!flags.dry, model: flags.model, quiet: !!flags.quiet, incremental: !!flags.incremental, format: flags.format, session: typeof flags.session === 'string' ? flags.session : undefined });
      break;
    }
    case 'hook': {
      // the user-facing notice on cache hits; THINKER_NOTICE=off or `notice: false` in the config turns it off
      const noticeOn = s => process.env.THINKER_NOTICE !== 'off' && s.config().notice !== false && s.config().notice !== 'off';
      // model calls made by thinker run agents too; their hooks must do nothing
      if (process.env.THINKER_IN_LLM) break;
      const ev = JSON.parse(readStdin() || '{}');
      const client = hookClient(flags.client, ev);
      if (process.env.THINKER_HOOK_DEBUG) fs.appendFileSync(process.env.THINKER_HOOK_DEBUG, JSON.stringify({ hook: pos[0], client, ev }) + '\n');
      // Cursor also runs the Claude Code hooks it imports; its own hooks do the work
      if (client === 'cursor-import') break;
      const session = sessionOf(ev);
      // installed hooks carry --record; THINKER_NO_LEARN=1 switches learning off without reinstalling them
      if (NO_LEARN) flags.record = false;
      if (pos[0] === 'prompt') {
        if (client === 'cursor') out(JSON.stringify({ continue: true })); // cannot add context here; see clients.js
        if (flags.record && store.exists()) { recordEvent(store.dir, session, { t: 'prompt', text: ev.prompt }); learnInBackground(client); }
        if (!store.exists() || !store.list().length) break;
        // outcome signal: a correction-shaped follow-up counts against the notes served earlier in this session
        if (session !== 'unknown' && looksLikeCorrection(ev.prompt)) outcome(store, { session, positive: false, reason: 'correction prompt: ' + String(ev.prompt).slice(0, 80) });
        if (session !== 'unknown') rememberTask(store, session, ev.prompt);
        const r = await orient(store, { task: ev.prompt || '', session: session === 'unknown' ? undefined : session, client, budget: Number(flags.budget) || HOOK_BUDGET, once: true });
        if (!r.included.length) break;
        const notice = noticeOn(store) ? cacheHitNotice(store.repo, r.included) : '';
        const more = r.more?.length ? `\n\n${MORE_NOTES_INTRO}\n${r.more.map(n => `- [${n.kind}] ${n.title}  (id: ${n.id})`).join('\n')}` : '';
        const noticeHeader = notice ? `${notice}\n\n` : '';
        const text = `<thinker-cache>\n${noticeHeader}Notes about this repo from earlier sessions. Their tracked code dependencies were re-hashed just now${r.included.some(n => n.status === 'stale') ? '; check notes marked STALE against code' : ' and match the working tree'}. Use matching pointers to reach the code; ignore neighboring topics. A fresh note is a map, not a complete plan for this change. Look up only a specific missing answer, then edit and verify.\n\n${r.text}${more}\n</thinker-cache>`;
        if (client === 'cursor') parkPending(store.dir, session, text);
        else out(promptOutput(client, text, notice));
      } else if (pos[0] === 'tool') {
        // After a tool call: the agent opened files; serve notes anchored to them, once each.
        if (!store.exists()) break;
        // Cursor reports a shell command's output in afterShellExecution, not in postToolUse
        if (ev.hook_event_name === 'afterShellExecution') { if (flags.record) recordEvent(store.dir, session, { t: 'tool', name: 'Bash', input: { command: ev.command }, result: ev.output }); out('{}'); break; }
        if (flags.record && !(client === 'cursor' && toolName(ev.tool_name) === 'Bash')) { const name = toolName(ev.tool_name); recordEvent(store.dir, session, { t: 'tool', name, input: toolInput(name, ev.tool_input), result: ev.tool_response ?? ev.tool_output ?? ev.output }); }
        const parts = [];
        if (flags.record) learnInBackground(client);
        // Cursor drops context added to an MCP call's result: wait for the next tool call,
        // unless the agent asked the cache itself, in which case it has the notes already
        const mcpCall = /^MCP:/i.test(ev.tool_name || '');
        if (client === 'cursor' && mcpCall && !/orient|lookup/i.test(ev.tool_name)) { /* keep the bundle for the next call */ }
        else if (client === 'cursor') {
          let p = takePending(store.dir, session);
          // the prompt hook does not run in every Cursor mode: orient from the transcript's request instead
          const turn = path.join(store.dir, 'state', `oriented-${String(ev.generation_id || session).replace(/[^\w.-]/g, '_')}`);
          if (!p && !mcpCall && !fs.existsSync(turn) && ev.transcript_path && fs.existsSync(ev.transcript_path) && store.list().length) {
            const task = parseTranscript(ev.transcript_path).events.filter(e => e.t === 'prompt').pop()?.text;
            if (task) { const r = await orient(store, { task, session, client: 'cursor', budget: Number(flags.budget) || HOOK_BUDGET, once: true }); if (r.included.length) p = `<thinker-cache>\nNotes about this repo from earlier sessions; their code dependencies were re-hashed just now.\n\n${r.text}\n</thinker-cache>`; }
          }
          fs.mkdirSync(path.dirname(turn), { recursive: true }); fs.writeFileSync(turn, '');
          if (p && !mcpCall) parts.push(p);
        }
        if (client === 'claude' || flags.late) {
          const name = toolName(ev.tool_name), command = toolInput(name, ev.tool_input).command || '';
          // an edit tool, or a shell command that writes a file in place
          const edited = name === 'Edit' || name === 'Write' || (name === 'Bash' && /\b(sed|perl)\s+(-\w+\s+)*-\w*i\b|\btee\s|>{1,2}\s*[\w./-]+\.\w+/.test(command));
          const r = lateNotes(store, { session, client, files: toolFiles(ev, repo), edited });
          if (r.text) parts.push(r.text);
        }
        if (parts.length) out(toolOutput(client, parts.join('\n\n')));
      } else if (pos[0] === 'stop') {
        if (!store.exists()) break;
        // completeness nudge (once per session, never when already continuing from a stop hook)
        if (flags.nudge && !ev.stop_hook_active) {
          let changed = [];
          try { changed = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo }).toString().split('\n').map(l => l.slice(3).trim()).filter(f => f && !f.startsWith('.thinker') && !f.startsWith('.mcp.json') && !f.startsWith('.claude/')); } catch {}
          const n = completenessNudge(store, { session, changed, cochange: loadCochange(repo) });
          if (n.text) { out(JSON.stringify({ decision: 'block', reason: n.text })); break; }
        }
        if (client === 'cursor') out('{}');
        // what the turn's servings saved, for the user; the ids are cleared so the next turn starts from none
        const served = takeTurn(store, session !== 'unknown' ? session : null);
        if (noticeOn(store)) {
          const notice = [served.length ? turnNotice(store.repo, served.map(id => store.get(id)).filter(Boolean)) : '', NO_LEARN ? '' : maintenanceNotice(store)].filter(Boolean).join('\n');
          const o = stopOutput(client, notice); if (o) out(o);
        }
        // Claude Code: its transcript. Other agents: the trace the hooks recorded,
        // plus the agent's closing message from the hook input or its transcript.
        let source = ev.transcript_path;
        const native = ev.transcript_path && fs.existsSync(ev.transcript_path) && (() => { try { return parseTranscript(ev.transcript_path).events.some(e => e.t === 'tool'); } catch { return false; } })();
        if (flags.record && !native) {
          let last = ev.last_assistant_message || ev.prompt_response;
          if (!last && ev.transcript_path && fs.existsSync(ev.transcript_path)) { try { last = parseTranscript(ev.transcript_path).events.filter(e => e.t === 'say').pop()?.text; } catch {} }
          recordEvent(store.dir, session, { t: 'say', text: last });
          source = traceFile(store.dir, session);
        }
        if (flags['no-distill'] || NO_LEARN || !sessionLearning()) break;
        if (!source || !fs.existsSync(source)) break;
        const child = spawn('node', [path.join(HERE, 'cli.js'), 'distill', source, '--incremental', '--quiet', '--session', session, '--repo', repo],
          { detached: true, stdio: 'ignore', env: { ...process.env, THINKER_LLM_PREFER: client } });
        child.unref();
      }
      break;
    }
    case 'learn': {
      await learn({ days: Number(flags.days) || 14, idleMin: flags['idle-min'] === undefined ? 2 : Number(flags['idle-min']), max: Number(flags.max) || 50, dry: !!flags.dry, quiet: !!flags.quiet });
      if (flags.prs) await mineMore({ limit: flags.prs === true ? 20 : Number(flags.prs) || 20, model: flags.model, dry: !!flags.dry });
      if (flags.maintain) await runMaintain({ quiet: !!flags.quiet, dry: !!flags.dry });
      break;
    }
    case 'maintain': {
      // one run of what the hooks do in the background; --dry counts without model calls
      await runMaintain({ quiet: !!flags.quiet, dry: !!flags.dry });
      break;
    }
    case 'record': {
      // thinker record <session>: events as JSON lines on stdin; then `thinker distill <printed file>`
      let f = traceFile(store.init().dir, pos[0] || 'manual'), n = 0;
      for (const l of readStdin().split('\n')) { let j; try { j = JSON.parse(l); } catch { continue; } if (!['prompt', 'say', 'tool'].includes(j.t)) continue; if (j.t === 'tool') { j.name = toolName(j.name); j.input = toolInput(j.name, j.input); } recordEvent(store.dir, pos[0] || 'manual', j); n++; }
      out(`recorded ${n} events in ${f}`);
      break;
    }
    case 'mine-prs': {
      // thinker mine-prs [owner/repo] [--limit n] [--dry]; a window by hand: --before <iso> [--after <iso>] [--again]
      await mineMore({ slug: pos[0], before: flags.before, after: flags.after, again: !!flags.again, limit: Number(flags.limit) || (flags.before || flags.after ? 60 : 20), model: flags.model, dry: !!flags.dry });
      break;
    }
    case 'outcome': {
      // thinker outcome <session-id> good|bad [reason]  — for CI / external integrations
      const r = outcome(store, { session: pos[0], positive: pos[1] !== 'bad', reason: pos.slice(2).join(' ') });
      out(`${r.length} notes updated: ${r.map(x => `${x.id} c=${Math.round(x.confidence * 100)}%`).join(', ') || '-'}`);
      break;
    }
    case 'seed': {
      // Bootstrap coverage: one exploration session per source area, distilled.
      const r = await seed({ areas: Number(flags.areas) || 12, model: flags.model, dry: !!flags.dry, prompts: flags.prompts, agent: typeof flags.agent === 'string' ? flags.agent : undefined });
      if (r && r.ok === 0 && !flags.dry) process.exitCode = 1;
      break;
    }
    case 'usage': {
      const days = Number(flags.days) || undefined;
      const u = summarize(store, { days, all: !flags.here });
      out(flags.json ? JSON.stringify(u, null, 2) : renderUsage(u, { days }));
      break;
    }
    case 'telemetry': {
      const home = thinkerHome();
      const endpoint = getTelemetryEndpoint({ home });
      const enabled = isTelemetryEnabled({ home, store });

      if (flags.schedule || flags.hourly) {
        const install = detectInstall(path.resolve(HERE, '..'), home);
        try {
          const res = scheduleTelemetry({ home, binPath: install.binPath });
          out(`Scheduled hourly telemetry for thinker (${res.type === 'launchd' ? 'LaunchAgent: ' + res.path : 'cron: ' + res.line}).`);
        } catch (e) {
          out(`Failed to schedule hourly telemetry: ${e.message}`);
        }
        break;
      }

      if (flags.unschedule) {
        const res = unscheduleTelemetry({ home });
        if (res.unscheduled) out('Removed scheduled hourly telemetry for thinker.');
        else out('No scheduled hourly telemetry was found.');
        break;
      }

      if (flags.background) {
        if (!enabled) return;
        await sendTelemetry({ home, store, endpoint, force: !!flags.force, event: flags.event });
        return;
      }

      if (flags.send || flags.force) {
        const res = await sendTelemetry({ home, store, endpoint, force: !!flags.force, event: flags.event });
        if (!flags.quiet) {
          if (res.sent) {
            out(`Telemetry sent successfully to ${endpoint}${res.key ? ` (s3: ${res.key})` : ''}.`);
          } else {
            out(`Telemetry not sent: ${res.reason || res.error || 'unknown'}`);
            if (res.lastSent) out(`Last sent: ${new Date(res.lastSent).toLocaleString()}`);
          }
        }
        break;
      }

      const payload = buildTelemetryPayload(store, { home, days: 1, all: !flags.here, event: flags.event });
      if (flags.json) {
        out(JSON.stringify(payload, null, 2));
        break;
      }

      out('Thinker telemetry:');
      out(`  Status:       ${enabled ? 'enabled' : 'disabled (THINKER_TELEMETRY=off or config)'}`);
      const sched = isTelemetryScheduled(home);
      out(`  Schedule:     ${sched ? (process.platform === 'darwin' ? 'active (LaunchAgent: ' + getTelemetryLaunchAgentPath() + ')' : 'active (cron)') : 'inactive'}`);
      out(`  Endpoint:     ${endpoint}`);
      if (payload.event) out(`  Event:        ${payload.event}`);
      const stamp = path.join(home, 'state', 'telemetry.last');
      let lastSent = 'never';
      try {
        const st = fs.statSync(stamp);
        lastSent = new Date(st.mtimeMs).toLocaleString();
      } catch {}
      out(`  Last sent:    ${lastSent}`);
      out(`  Install ID:   ${payload.installId}`);
      out(`  Cache size:   ${payload.cacheSize.totalNotes} notes, ${(payload.cacheSize.totalBytes / 1024).toFixed(1)} KB across ${payload.cacheSize.repositoriesCount} repositories`);
      out(`  Effectiveness:${payload.effectiveness.requestsTotal} requests, ${payload.effectiveness.requestsAnswered} answered (${(payload.effectiveness.hitRate * 100).toFixed(1)}% hit rate)`);
      out(`  Confirmed:    ${payload.effectiveness.assessed.confirmed} of ${(payload.effectiveness.assessed.confirmed + payload.effectiveness.assessed.contradicted + payload.effectiveness.assessed.unused)} assessed (${(payload.effectiveness.assessed.confirmationRate * 100).toFixed(1)}%)`);
      out(`  Net tokens:   ${payload.effectiveness.estimatedSavings.netTokensSaved >= 0 ? '+' : ''}${payload.effectiveness.estimatedSavings.netTokensSaved.toLocaleString()} tokens saved (estimate)`);
      if (payload.clients?.detected?.length) {
        const activeSummary = Object.entries(payload.clients.activeRequests || {}).filter(([_, n]) => n > 0).map(([c, n]) => `${c}:${n}`).join(', ') || 'none';
        out(`  Clients:      detected: ${payload.clients.detected.join(', ')}; active requests: ${activeSummary}`);
      }
      if (payload.retrieval) {
        out(`  Retrieval:    ${payload.retrieval.staleNotesServed} stale served, ${payload.retrieval.guardTriggeredCount} guard triggers${payload.retrieval.averageDurationMs ? `, ${payload.retrieval.averageDurationMs}ms avg latency` : ''}`);
      }
      out('\nUse `thinker telemetry --send` to transmit, `--schedule` to enable hourly sending, or `--json` to view full payload.');
      break;
    }
    case 'benchmark': {
      const sub = pos.shift();
      if (sub === 'report') {
        out(renderBenchmarkReport(latestBenchmark(store)));
        break;
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
        break;
      }
      // `thinker benchmark "<question>"` is taken as `run`
      if (sub && sub !== 'run') pos.unshift(sub);
      let task = pos.join(' ').trim();
      if (!task) {
        // First run: nobody knows yet what the cache covers, so offer questions it does
        const questions = await coveredBenchmarkQuestions(store);
        if (!questions.length) { out('There are no usable benchmark topics in the cache yet. Build it first with `thinker setup`, then try again, or benchmark a recent PR change with `thinker benchmark pr`.'); process.exitCode = 1; break; }
        if (process.stdin.isTTY) {
          out('Benchmark thinker on a question the cache covers (two read-only agent calls: without and with thinker):\n');
          questions.forEach((q, i) => out(`  ${i + 1}. ${q}`));
          const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
          const a = await rl.question(`\nPick 1-${questions.length}, type your own question, or q to quit [1]: `).then(x => x.trim(), () => 'q'); rl.close(); // Ctrl-D quits
          if (/^q(uit)?$/i.test(a)) { out('To benchmark a recent PR change instead: thinker benchmark pr [number]'); break; }
          task = !a ? questions[0] : /^\d+$/.test(a) && questions[Number(a) - 1] ? questions[Number(a) - 1] : a;
        } else if (sub === 'run') {
          task = questions[0];
          out(`No question given; using one the cache covers: ${task}`);
        } else {
          const quote = text => `'${text.replaceAll("'", `'"'"'`)}'`;
          out('Run a benchmark in this repository on a question the cache covers:');
          for (const q of questions) out(`  thinker benchmark run ${quote(q)}`);
          out('\nOther benchmarks:\n  thinker benchmark pr [number]   paired benchmark on a recent PR change\n  thinker benchmark report        show the latest benchmark result\n\n`thinker benchmark run` with no question uses the first above. Each benchmark makes two read-only agent calls; answers are saved for review.');
          break;
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
      if (!authRes.ok || !authRes.agent || authRes.skip || authRes.skipExploration) {
        process.exitCode = 1;
        break;
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
        process.exitCode = 1; break;
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
          break;
        }
        out(`\nBenchmark failed: ${cleanErrorMessage(err)}\n`);
        process.exitCode = 1;
        break;
      }
      const record = { version: 1, createdAt: new Date().toISOString(), repo, task, agent: selected, model: typeof flags.model === 'string' ? flags.model : null, notes: oriented.included.map(n => n.id), runs: { baseline, cache: cached } };
      saveBenchmark(store, record);
      out('\n' + renderBenchmarkReport(record));
      break;
    }
    case 'stats': {
      const notes = store.list();
      const by = {}; for (const n of notes) by[n.status] = (by[n.status] || 0) + 1;
      const kinds = {}; for (const n of notes) kinds[n.kind] = (kinds[n.kind] || 0) + 1;
      out(JSON.stringify({ repo, notes: notes.length, status: by, kinds, uses: notes.reduce((s, n) => s + (n.uses || 0), 0) }, null, 2));
      break;
    }
    case 'health': {
      const notes = store.list();
      out(`\n=== Thinker Cache Health Report for ${path.basename(repo)} ===\n`);
      out(`Total notes: ${notes.length}`);
      if (!notes.length) {
        out('The cache is empty. Run `thinker setup` to initialize.\n');
        break;
      }
      const kinds = {};
      const statusCounts = { fresh: 0, stale: 0, invalid: 0 };
      let withSays = 0;
      let brokenDeps = 0;
      const subs = {};

      const refreshed = refresh(store, notes, { persist: false });
      for (const n of refreshed) {
        kinds[n.kind] = (kinds[n.kind] || 0) + 1;
        statusCounts[n.status] = (statusCounts[n.status] || 0) + 1;
        if (n.says?.length) withSays++;
        const check = (n.deps || []).some(d => d.missing);
        if (check) brokenDeps++;
        const sub = (n.deps && n.deps[0]) ? subsystemForFile(repo, n.deps[0].path) : 'other';
        subs[sub] = (subs[sub] || 0) + 1;
      }

      out('\nKinds breakdown:');
      for (const [k, count] of Object.entries(kinds).sort((a, b) => b[1] - a[1])) {
        out(`  ${k.padEnd(14)}: ${count}`);
      }

      out('\nSubsystem coverage:');
      for (const [s, count] of Object.entries(subs).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
        out(`  ${s.padEnd(28)}: ${count} notes`);
      }

      out('\nQuality metrics:');
      out(`  Status:         ${statusCounts.fresh} fresh, ${statusCounts.stale} stale, ${statusCounts.invalid} invalid`);
      out(`  Phrasing:       ${withSays}/${notes.length} (${Math.round((withSays / notes.length) * 100)}%) notes have product phrasings`);
      out(`  Broken deps:    ${brokenDeps} notes point to missing files`);

      const alerts = [];
      if (!kinds.overview && !kinds.callpath) alerts.push('Cache lacks structural overview or callpath notes');
      if (kinds.invariant > 10 && (kinds.callpath || 0) + (kinds.overview || 0) < 3) alerts.push('Cache is skewed towards micro-rules with few structural maps');
      if (withSays < notes.length * 0.5) alerts.push('More than 50% of notes lack search phrasings (run `thinker phrase`)');
      if (brokenDeps > 0) alerts.push(`${brokenDeps} notes have broken file dependencies (run \`thinker check\`)`);

      if (alerts.length) {
        out('\nHealth warnings:');
        for (const a of alerts) out(`  ⚠ ${a}`);
      } else {
        out('\nHealth status: EXCELLENT (well balanced and grounded)');
      }
      out('');
      break;
    }
    default: out(HELP);
  }
}

async function init({ clients, hooks, learn, late, shared, mcp, gitHook }) {
  store.init();
  out(`initialized ${store.dir}`);
  for (const c of clients) for (const line of installClient(c, { repo, cli: path.join(HERE, 'cli.js'), mcpEntry: mcpEntry(), hooks, learn, late, shared, mcp })) out(line);
  if (clients.includes('codex') && (hooks || mcp) && !flags['no-trust']) {
    // Codex reads a project's .codex/ only once the project is trusted, and runs a hook only once it is reviewed
    let ok = !!flags.yes;
    if (!ok && process.stdin.isTTY) {
      const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
      const a = await rl.question(`Codex: mark this repository as trusted${hooks ? " and thinker's hooks as reviewed" : ''} in your Codex config, so Codex uses them without asking? [Y/n] `); rl.close();
      ok = !/^n/i.test(a.trim());
    }
    if (ok) for (const line of trustCodex(repo)) out(line);
    else out('Codex: not marked as trusted; Codex asks you to trust the project and review the hooks before they run (--yes does it here without asking)');
  }
  if (clients.includes('cursor') && mcp) {
    // Cursor loads an MCP server only once it is approved for the workspace
    const agentBin = findBin(['agent', 'cursor-agent']);
    const r = agentBin ? spawnSync(agentBin, ['mcp', 'enable', 'thinker'], { cwd: repo, encoding: 'utf8', timeout: 60_000 }) : null;
    if (r && r.status === 0) out('Cursor: approved the thinker MCP server for this workspace');
    else out('Cursor: approve the thinker MCP server when Cursor asks (Settings → MCP), or run: agent mcp enable thinker');
  }
  if (gitHook) installGitHooks(repo, path.join(HERE, 'cli.js'), learn, out);
  if (!fs.existsSync(path.join(store.dir, 'cochange.json'))) { try { const idx = mineCochange(repo); out(`mined co-change edges from ${idx.commits} commits`); } catch {} }
  const gi = path.join(repo, '.thinker', '.gitignore');
  const ignored = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const missing = ['log.jsonl', 'state/', 'benchmarks/'].filter(line => !ignored.split('\n').includes(line));
  if (missing.length) fs.writeFileSync(gi, ignored + (ignored && !ignored.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
}

// owner/name of the GitHub repository behind `origin`, or null
function githubSlug() {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/);
    return m ? m[1] : null;
  } catch { return null; }
}
const hasBin = b => { try { execFileSync(b, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } };

// One step for a new repo: build the cache, then wire it into the clients.
async function setup() {
  const clients = parseClients(flags.clients, parseClients('auto'));
  const num = (v, d) => v === undefined || v === true || Number.isNaN(Number(v)) ? d : Number(v);
  const areas = flags['no-seed'] ? 0 : num(flags.areas, 12);
  const slug = flags['no-prs'] ? null : (typeof flags.slug === 'string' ? flags.slug : githubSlug());
  const prs = flags['no-prs'] ? 0 : num(flags.prs, 60);
  const agent = typeof flags.agent === 'string' ? flags.agent : (process.env.THINKER_LLM || null);

  await runSetup({
    repo,
    store,
    cliPath: path.join(HERE, 'cli.js'),
    mcpEntry: mcpEntry(),
    clients,
    areas,
    prs,
    prNumber: flags.pr ? Number(flags.pr) : null,
    benchmark: Boolean(flags.benchmark),
    noBenchmark: Boolean(flags['no-benchmark']),
    noSeed: Boolean(flags['no-seed']),
    noPrs: Boolean(flags['no-prs']),
    noPhrase: Boolean(flags['no-phrase']),
    model: flags.model,
    agent,
    yes: Boolean(flags.yes),
    hooks: !flags['no-hooks'],
    learn: learnOn(),
    late: !flags['no-late'],
    shared: Boolean(flags.shared),
    mcp: !flags['no-mcp'],
    gitHook: !flags['no-git-hook'],
    noTrust: Boolean(flags['no-trust']),
    exportFile: typeof flags.export === 'string' ? flags.export : null,
    out,
    seedFn: async (opts) => seed(opts),
    minePrsFn: async (slug, opts) => minePrs(slug, { ...opts, repo, phase: 'init' }),
  });
}

// mine-prs and learn --prs: the repo defaults to the GitHub origin, and what is needed is checked first
async function mineMore({ slug, ...opts }) {
  slug = slug || githubSlug();
  if (!slug && !hasBin('gh')) {
    out('ℹ️  GitHub remote/gh CLI unavailable; falling back to local git history...');
  }
  if (!provider()) { out('❌ merged PRs: needs an agent CLI (claude, gemini, or codex) or ANTHROPIC_API_KEY'); process.exitCode = 1; return; }
  store.init();
  return minePrs(slug, { ...opts, repo });
}

async function minePrs(slug, { before, after, again, limit = 20, model, dry, repo = process.cwd(), phase = 'maintenance' } = {}) {
  const useGit = !slug || !hasBin('gh');
  const recSlug = slug || 'local';
  const rec = minedPrs(store, recSlug);
  const fetchLimit = Math.min(Math.max(limit * 3, 60), 250);
  const listFn = useGit ? (s, o) => listMergedCommits(repo, o) : listMergedPrs;

  // without a window: what was merged since the last run, then further back; never a PR mined before
  const listed = before || after
    ? listFn(slug, { before: before || new Date().toISOString(), after, limit: fetchLimit }).filter(p => again || !rec.mined.has(p.number))
    : nextPrs(slug, rec, { limit: fetchLimit, list: listFn, repo });
  if (!listed.length) {
    const sourceName = useGit ? 'git history' : `merged PRs of ${slug}`;
    out(`no ${sourceName} left to mine (${rec.mined.size} mined so far)`);
    return { cost: 0, saved: 0 };
  }
  const failed = new Set();
  const filtered = listed
    .filter(p => !/^(chore|deps|docs|revert|ci|build|test)\b|\bbump\b|dependabot|renovate|snapshot/i.test(p.title) &&
      (p.body || '').length > (useGit ? 10 : 120) && p.additions <= 800 && p.additions >= 3);
  const candidates = filtered.length ? filtered : listed.filter(p => !/^(chore|deps|bump)\b/i.test(p.title) && p.additions <= 1000 && p.additions >= 1);
  const prs = stratifyPrs(candidates, limit);
  out(`        Reviewing ${prs.length} changes ${useGit ? 'from git history' : `from ${slug}`}. Changes with no reusable notes are normal.`);
  const progress = batchProgress({ dir: store.dir, name: 'PR mining', total: prs.length, out, verbose: Boolean(flags.verbose) });
  let cost = 0, saved = 0;
  for (const pr of prs) {
    const refId = pr.prNumber ? `${recSlug}#${pr.prNumber}` : `${recSlug}#${pr.hash ? pr.hash.slice(0, 8) : pr.number}`;
    progress.start(pr.hash ? `commit ${pr.hash.slice(0, 8)}` : `PR #${pr.number}`);
    try {
      const r = await distillPr(slug, pr, { model: model || store.config().distillModel || 'sonnet', repo, accounting: { store, purpose: 'mine-prs', phase, pr: pr.number, dry: !!dry } });
      cost += r.cost || 0;
      if (dry) { out(`${oneLine(refId)} ${oneLine(pr.title).slice(0, 60)} → ${r.notes.map(n => n.kind).join(',') || 'no reusable notes'}`); progress.complete({ proposed: r.notes }); continue; }
      const s2 = saveNotes(store, r.notes, { source: { type: 'pr', ref: refId } });
      saved += s2.saved.length + s2.merged.length;
      progress.complete({ ref: refId, title: pr.title, notes: [...s2.saved, ...s2.merged].map(n => n.id), skipped: s2.skipped.length });
    } catch (e) { failed.add(pr.number); progress.complete({ ref: refId, title: pr.title, error: e.message }); }
  }
  // PRs passed over by the filter are recorded too; failed ones are not, so the next run takes them again
  if (!dry) {
    recordMinedPrs(store, recSlug, listed.filter(p => !failed.has(p.number)));
    store.log({ op: 'mine-prs', slug: recSlug, prs: prs.length - failed.size, passed: listed.length - prs.length, saved, cost, metered: true, source: useGit ? 'git' : 'github' });
  }
  progress.finish({ cost, retry: 'Failed changes remain unmarked. Retry with: thinker mine-prs' });
  return { cost, saved, failed: failed.size, processed: prs.length };
}

function sourceAreas(limit) {
  return discoverAreas(repo, { limit });
}

// Asynchronous child collection lets progress updates continue during long explorations.
function exploreCommand(bin, args, { input, ...opts }) {
  return new Promise(resolve => {
    const child = execFile(bin, args, opts, (error, stdout, stderr) => {
      resolve({ status: error ? (error.code || 1) : 0, stdout, stderr: stderr || error?.message || '' });
    });
    child.stdin.on('error', () => {}); // the agent can exit before consuming stdin
    child.stdin.end(input);
  });
}

// One read-only exploration session with the given agent; returns the file
// holding its transcript (the agent's own, or its streamed output).
async function explore(agent, prompt, model) {
  let response = { provider: agent, model: resolveModel(agent, model), usage: null, cost: null };
  let result;
  try {
    result = await exploreOnce(agent, prompt, model, fields => { response = { ...response, ...fields }; });
    return result;
  } finally {
    logModelUsage(store, { purpose: 'explore', phase: 'init' }, { ...response, failed: !result || !!result.error });
  }
}

async function exploreOnce(agent, prompt, model, onUsage) {
  const env = { ...process.env, THINKER_IN_LLM: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', IS_SANDBOX: '1' };
  const opts = { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28, env };
  const bin = findBin(BINS[agent] || []);
  if (!bin) return { error: `the ${agent} CLI was not found` };
  const stream = path.join(store.dir, 'state', `explore-${Date.now()}.jsonl`);
  fs.mkdirSync(path.dirname(stream), { recursive: true });
  const m = resolveModel(agent, model);
  if (agent === 'claude') {
    const r = await exploreCommand(bin, ['-p', '--model', m || 'sonnet', '--output-format', 'json', '--permission-mode', 'plan', '--tools', 'Read,Glob,Grep', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--max-turns', '40'], { ...opts, input: prompt });
    if (r.status !== 0 && !String(r.stdout).trim()) return { error: (r.stderr || `claude exited ${r.status}`).slice(0, 200) };
    let j; try { j = JSON.parse(r.stdout); } catch { return { error: (r.stderr || r.stdout || '').slice(0, 200) }; }
    onUsage({ usage: j.usage || j.stats || null, cost: j.total_cost_usd ?? null, model: j.model || m });
    if (j.is_error) return { error: String(j.result || j.error || 'claude error').slice(0, 200) };
    const transcript = transcriptsFor(repo).find(f => f.includes(j.session_id));
    return transcript ? { transcript, cost: j.total_cost_usd || 0, turns: j.num_turns } : { error: 'no transcript found' };
  }
  if (path.basename(bin) === 'agy') {
    const agyArgs = ['-p', prompt, '--model', m || 'gemini-3.8-flash-high', '--output-format', 'json', '--mode=plan'];
    const r = await exploreCommand(bin, agyArgs, { ...opts, cwd: repo });
    if (r.status !== 0 && !String(r.stdout).trim()) return { error: (r.stderr || `agy exited ${r.status}`).slice(0, 200) };
    let j; try { j = JSON.parse(r.stdout); } catch { return { error: (r.stderr || r.stdout || '').slice(0, 200) }; }
    onUsage({ usage: j.usage || j.stats || null, cost: j.total_cost_usd ?? null, model: j.model || m });
    if (j.is_error) return { error: String(j.result || j.error || 'agy error').slice(0, 200) };
    const convId = j.conversation_id;
    if (convId) {
      const transcript = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
      if (fs.existsSync(transcript)) return { transcript, cost: 0, turns: j.num_turns };
    }
    return { error: 'agy transcript not found: ' + (r.stderr || r.stdout || '').slice(0, 200) };
  }
  let r;
  if (agent === 'codex') r = await exploreCommand(bin, ['exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--sandbox', 'read-only', ...(m ? ['--model', m] : ['--model', 'gpt-6-luna']), '--cd', repo, '-'], { ...opts, input: prompt });
  else if (agent === 'cursor') r = await exploreCommand(bin, ['-p', '--output-format', 'stream-json', '--mode', 'ask', '--trust', ...(m ? ['--model', m] : []), '--workspace', repo, prompt], opts);
  else r = await exploreCommand(bin, ['--output-format', 'stream-json', '--approval-mode=plan', ...(m ? ['-m', m] : ['-m', 'gemini-3.8-flash-high'])], { ...opts, input: prompt });
  if (r.status !== 0 && !String(r.stdout).trim()) return { error: (r.stderr || '').slice(0, 200) };
  onUsage(streamModelUsage(agent, r.stdout));
  // failures these CLIs report inside their output (usage limits, auth)
  for (const l of String(r.stdout).split('\n')) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (j.type === 'turn.failed' || (j.type === 'result' && j.is_error)) return { error: String(j.error?.message || j.result || j.message || 'failed').slice(0, 200) };
  }
  fs.writeFileSync(stream, r.stdout);
  return { transcript: stream, temp: true };
}

async function seed({ areas, model, dry, prompts, agent }) {
  const areaList = discoverAreas(repo, { limit: areas });
  const list = prompts ? JSON.parse(fs.readFileSync(prompts, 'utf8')).map(p => ({ prompt: p })) : areaList.map(a => {
    if (a.isFile) {
      return {
        dir: a.dir, n: a.n,
        prompt: `Orient a new contributor in ${a.dir}: what this module is responsible for, its primary classes and functions (cite file:symbol), how control and data flow into and out of it, the key invariants and conventions a newcomer would get wrong, and how it is tested. Read the actual code; be concrete and cite file:symbol.`
      };
    }
    return {
      dir: a.dir, n: a.n,
      prompt: `Orient a new contributor in ${a.dir}/ (${a.n} source files): what this subsystem is responsible for, its main entry points and how control flows into and out of it (cite file:symbol), the two or three things that must change together when extending it, local conventions a newcomer would get wrong, and how it is tested. Read the actual code; be concrete and cite file:symbol.`
    };
  });
  if (dry) { for (const a of list) out(`${(a.dir || '-').padEnd(40)} ${a.n || ''}`); return; }
  let activeAgent = agent || exploreAgent();
  if (!activeAgent) {
    out('\n❌ cache init failed: no agent CLI found to explore with (claude, gemini, codex, or cursor).');
    process.exitCode = 1;
    return { ok: 0, total: list.length, cost: 0, agent: null, failures: [{ area: 'all', error: 'no agent CLI found' }] };
  }

  let cost = 0, ok = 0;
  const failures = [];
  const progress = batchProgress({ dir: store.dir, name: 'Exploration', total: list.length, out, every: 1, verbose: Boolean(flags.verbose) });
  for (const a of list) {
    const label = a.dir || a.prompt.slice(0, 40);
    progress.start(label);
    let r = await explore(activeAgent, a.prompt, model);

    if (r.error) {
      progress.pause();
      progress.detail({ area: label, agent: activeAgent, error: r.error });
      const otherAgents = available().filter(ag => ag !== activeAgent && ['claude', 'gemini', 'codex', 'cursor'].includes(ag));
      if (process.stdin.isTTY && !flags.yes && otherAgents.length) {
        out(`        ${getAgentDisplayName(activeAgent)} failed: ${oneLine(cleanErrorMessage(r.error)).slice(0, 120)}`);
        const items = [
          ...otherAgents.map((ag, idx) => ({
            label: getAgentDisplayName(ag),
            value: ag,
            key: String(idx + 1),
            name: getAgentDisplayName(ag),
          })),
          {
            label: 'Exit',
            value: 'exit',
            key: 'e',
            name: 'Exit',
          },
        ];
        const selected = await selectMenu({
          header: '        Choose another agent to retry this area, or exit:',
          hint: 'Use ↑/↓ to navigate, Enter to select:',
          items,
          defaultIndex: 0,
          out,
        });
        const chosen = selected && selected.value !== 'exit' ? selected.value : null;
        if (chosen) {
          activeAgent = chosen;
          process.env.THINKER_LLM = chosen;
          out(`        Retrying with ${getAgentDisplayName(chosen)}…`);
          progress.start(label);
          r = await explore(activeAgent, a.prompt, model);
        }
      }
      if (r.error) {
        failures.push({ area: label, error: r.error });
        progress.complete({ error: r.error });
        break;
      }
    }

    cost += r.cost || 0;
    try {
      const result = await distillFile(r.transcript, { minExplore: 1, dry: false, model: undefined, quiet: true, incremental: false, phase: 'init' });
      cost += result?.cost || 0;
      ok++;
      progress.complete({ notes: result?.notes || [], agent: activeAgent });
    } catch (e) {
      failures.push({ area: label, error: e.message });
      progress.complete({ error: e.message });
    } finally {
      if (r.temp) fs.rmSync(r.transcript, { force: true });
    }
  }
  const result = progress.finish({ cost, retry: 'Check your agent login, then retry with: thinker seed (or thinker seed --agent <name>).' });
  if (ok === 0 && list.length > 0) process.exitCode = 1;
  return { ok, total: list.length, saved: result.saved, cost, agent: activeAgent, failures };
}
// the agent that explores: THINKER_LLM if it names one, else the first installed in fallback order (claude, gemini, codex, cursor)
function exploreAgent() {
  const agents = available().filter(p => ['claude', 'gemini', 'codex', 'cursor'].includes(p));
  return agents.includes(process.env.THINKER_LLM) ? process.env.THINKER_LLM : agents[0] || null;
}

// One maintenance run, with PR mining wired to this repository's origin.
async function runMaintain({ quiet, dry }) {
  if (NO_LEARN) { if (!quiet) out('maintenance is switched off (THINKER_NO_LEARN)'); return; }
  if (!store.exists()) return;
  const slug = githubSlug();
  const canMine = provider() && (slug ? hasBin('gh') : true);
  const r = await maintain(store, repo, { dry, fns: {
    minePrs: canMine ? ({ after, limit }) => minePrs(slug, { after, before: new Date().toISOString(), limit, repo, phase: 'maintenance' }) : undefined,
  } });
  if (!quiet) out(renderMaintain(r));
}

async function verifyAll(notes) {
  let cost = 0;
  for (const n of notes) {
    try {
      const r = await verifyNote(store, n, { model: flags.model });
      cost += r.cost || 0;
      out(`${r.verdict.padEnd(12)} ${n.id}: ${r.reason}`);
    } catch (e) { out(`error        ${n.id}: ${e.message}`); }
  }
  out(`verified ${notes.length} notes ($${cost.toFixed(3)})`);
}

// Catch-up learning: works without any end-of-session hook, so it covers
// agents and modes that do not fire one (Cursor's headless mode, for one).
async function learn({ days, idleMin, max, dry, quiet }) {
  if (NO_LEARN) { if (!quiet) out('learning is switched off (THINKER_NO_LEARN)'); return; }
  if (!sessionLearning()) { if (!quiet) out('learning from sessions is off (learn.sessions in .thinker/config.json); maintenance and pull requests go on'); return; }
  const lock = path.join(store.init().dir, 'state', 'learn.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try { if (Date.now() - fs.statSync(lock).mtimeMs < 15 * 60_000) { if (!quiet) out('another learn run is in progress'); return; } } catch {}
  if (!dry) fs.writeFileSync(lock, String(process.pid));
  try {
    const sessions = findSessions(repo, { sinceMs: days * 86400_000, storeDir: store.dir }).filter(s => Date.now() - s.mtime >= idleMin * 60_000);
    let done = 0;
    for (const s of sessions) {
      let state = {}; try { state = JSON.parse(fs.readFileSync(path.join(store.dir, 'state', path.basename(s.file).replace(/\.jsonl?$/, '') + '.json'), 'utf8')); } catch {}
      let total = 0; try { total = parseTranscript(s.file).lineCount; } catch { continue; }
      if ((state.line || 0) >= total) continue;
      if (done >= max) break;
      if (dry) { out(`${s.client.padEnd(7)} ${s.session}  ${total - (state.line || 0)} new lines`); continue; }
      if (!quiet) out(`${s.client} ${s.session}`);
      process.env.THINKER_LLM_PREFER = s.client;
      try { await distillFile(s.file, { minExplore: 3, quiet, incremental: true, session: s.session }); done++; } catch (e) { if (!quiet) out(`  failed: ${String(e.message).slice(0, 160)}`); }
    }
    if (!quiet && !dry) out(`learned from ${done} of ${sessions.length} sessions`);
  } finally { if (!dry) fs.rmSync(lock, { force: true }); }
}
// From a hook: start catch-up in the background, at most every ten minutes.
function learnInBackground(client) {
  if (NO_LEARN) return;
  const mark = path.join(store.dir, 'state', 'learn.last');
  try { if (Date.now() - fs.statSync(mark).mtimeMs < 10 * 60_000) return; } catch {}
  fs.mkdirSync(path.dirname(mark), { recursive: true }); fs.writeFileSync(mark, '');
  spawn('node', [path.join(HERE, 'cli.js'), 'learn', '--quiet', '--days', '2', '--max', '5', '--maintain', '--repo', repo], { detached: true, stdio: 'ignore', env: { ...process.env, THINKER_LLM_PREFER: client } }).unref();
}

async function distillFile(file, { minExplore, dry, model, quiet, incremental, format, session, phase = 'learning' }) {
  const stateDir = path.join(store.dir, 'state');
  const stateFile = path.join(stateDir, path.basename(file).replace(/\.jsonl?$/, '') + '.json');
  let state = {}; try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  const fromLine = incremental ? (state.line || 0) : 0;
  const { events, lineCount, model: sessionModel, format: fmt } = parseTranscript(file, { fromLine, format });
  hydrate(events, repo, { trace: session ? traceFile(store.dir, session) : null });
  // a turn-end hook and a session-end hook can both ask for the same session
  const lock = stateFile + '.lock';
  if (incremental && !dry) {
    try { if (Date.now() - fs.statSync(lock).mtimeMs < 10 * 60_000) return; } catch {}
    fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(lock, String(process.pid));
  }
  try { return await distillEventsToNotes(); } finally { if (incremental && !dry) fs.rmSync(lock, { force: true }); }
  async function distillEventsToNotes() {
  const n = exploreCount(events);
  if (n < minExplore) { if (!quiet) out(`only ${n} exploration calls since last distill (<${minExplore}); nothing to distill`); return; }
  if (!events.some(e => e.t === 'say')) { if (!quiet) out('the session has no answer from the agent yet; nothing to distill'); return; }
  // notes served in this session: named in the transcript, or recorded on the note when a hook served it
  const ids = new Set(injectedIds(file, { fromLine }));
  if (session) for (const n of store.list()) if ((n.servedIn || []).includes(session)) ids.add(n.id);
  const served = [...ids].filter(id => !(incremental && (state.assessed || []).includes(id))).map(id => store.get(id)).filter(Boolean);
  const started = performance.now();
  let failed = true;
  try {
  const r = await distillEvents(events, { model: model || store.config().distillModel || 'sonnet', repoHint: repo, served, existing: relatedNotes(store, events), accounting: { store, purpose: 'distill', phase, transcript: path.basename(file), session, traceEvents: events.length, dry: !!dry } });
  if (dry) { failed = false; out(JSON.stringify({ notes: r.notes, assessments: r.assessments }, null, 2)); out(`(${r.notes.length} notes, cost ${r.cost == null ? 'unknown' : '$' + r.cost.toFixed(3)}, trace ${r.traceChars} chars)`); return; }
  const s = saveNotes(store, r.notes, { source: { type: 'agent', ref: path.basename(file, '.jsonl') } });
  // under the session's id, which is what servings are logged under: a transcript's file name is
  // that id only for Claude Code (Codex adds a date, a recorded trace a prefix, Gemini another suffix)
  // with the session's model, so the reading its confirmed notes saved can be priced (usage.js)
  const applied = attest(store, r.assessments, { session: session || sessionKey(path.basename(file)), client: fmt === 'agy' ? 'gemini' : fmt === 'events' ? 'trace' : fmt, model: sessionModel });
  if (!quiet) for (const a of applied) out(`attest  ${a.verdict.padEnd(12)} ${a.id} → c=${Math.round(a.confidence * 100)}%`);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ line: lineCount, assessed: [...new Set([...(state.assessed || []), ...served.map(n => n.id)])], at: new Date().toISOString() }));
  store.log({ op: 'distill', transcript: path.basename(file), explore: n, saved: s.saved.map(x => x.id), merged: s.merged.map(x => x.id), skipped: s.skipped, cost: r.cost, metered: true, phase, traceChars: r.traceChars });
  if (!quiet) {
    for (const x of s.saved) out(`saved   ${x.id}  [${x.kind}] ${x.title}`);
    for (const x of s.merged) out(`merged  ${x.id}  [${x.kind}] ${x.title}`);
    for (const x of s.skipped) out(`skipped ${x.title}: ${x.reason}`);
    out(`distilled ${events.length} events (${n} exploration calls) → ${s.saved.length} new, ${s.merged.length} merged${r.cost ? `; cost $${r.cost.toFixed(3)}` : ""}`);
  }
  failed = false;
  return { notes: [...s.saved, ...s.merged].map(n => n.id), cost: r.cost || 0 };
  } finally {
    // One outcome for the whole run, including retries/fallbacks and persistence.
    // Skipped sessions never reach this block. Abrupt process kills remain unknown.
    store.log({ op: 'distill-run', phase, dry: !!dry, failed,
      durationMs: Math.max(0, Math.round(performance.now() - started)) });
  }
  }
}

main().catch(e => {
  const hook = cmd === 'share' && (flags['pre-push'] || flags['repair-staged']);
  console.error(hook ? `thinker: note check unavailable; Git can continue (${e.message || e})` : e);
  process.exit(hook ? 0 : 1);
});
