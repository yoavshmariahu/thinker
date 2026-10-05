#!/usr/bin/env node
import { isTestMode } from './test-mode.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, findRepoRoot } from './store.js';
import { initAst } from './ast.js';
import { thinkerHome, maybeCheckDailyUpdateInBackground, checkPendingNotice } from './update.js';
import { maybeSendTelemetryInBackground } from './telemetry.js';
import { commands as noteCommands } from './commands/notes.js';
import { commands as impactCommands } from './commands/impact.js';
import { commands as cacheCommands } from './commands/cache.js';
import { commands as learnCommands } from './commands/learn.js';
import { commands as hookCommands } from './commands/hooks.js';
import { commands as setupCommands } from './commands/setup.js';
import { commands as telemetryCommands } from './commands/telemetry.js';
import { commands as benchmarkCommands } from './commands/benchmark.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const cmd = argv.shift();
const flags = {}; const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const boolean = (cmd === 'impact' && ['json'].includes(k)) || (cmd === 'share' && ['all', 'dry', 'check', 'strict', 'pre-push', 'repair-staged'].includes(k)) || (cmd === 'review' && ['staged', 'state', 'dry', 'json', 'strict', 'verbose', 'post', 'no-related', 'callers', 'triage', 'verify'].includes(k)) || (cmd === 'system' && ['fixed', 'mutable', 'all', 'json'].includes(k)); const v = !boolean && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; flags[k] = v; }
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

// The MCP entry for a checkout's own files pins the repository; the user's machine-wide entry
// pins none, and the server takes the repository from the directory the client starts it in.
const mcpEntry = (r = repo) => ({ command: 'node', args: [path.join(HERE, 'mcp.js')], env: { THINKER_REPO: r } });
const userMcpEntry = () => ({ command: 'node', args: [path.join(HERE, 'mcp.js')] });

const HELP = `thinker — knowledge cache for coding agents

  setup [--build | --no-build] [--clients list|all|auto] [--agent a] [--areas n] [--prs n] [--pr <num>]
        [--benchmark | --no-benchmark] [--no-learn] [--no-hooks] [--no-late] [--shared] [--no-mcp] [--no-git-hook]
        [--no-trust] [--yes] [--verbose]
                                 the one command that sets a repository up: connect the agent CLIs (hooks and the MCP
                                 server, clients claude, codex, cursor, gemini, pi, windsurf, copilot, opencode; default auto), then offer to build the
                                 knowledge cache from the code and merged pull requests with pre-flight estimates, and
                                 an optional PR change benchmark. --build builds without asking, --no-build only wires
                                 things up and lets the cache grow from your sessions; --verbose adds per-item details
  connect [--clients list|all|auto] [--no-hooks] [--no-late] [--no-learn] [--no-mcp] [--no-trust] [--yes]
                                 wire the agents on this machine into their own settings, once: hooks and the MCP
                                 server, for every repository that is set up (elsewhere thinker does nothing);
                                 setup runs it first, and so does the installer
  uninstall [--purge] [--user]   remove this repository's hooks and MCP registration (notes are kept unless --purge);
                                 --user also removes the machine-wide wiring from your agent settings
  share [ids…] [--all] [--dry]    promote eligible local notes for review and commit
  share --check [--base ref]      report issues in committed notes (exit 0)
  share --repair-staged [--cap n] repair or remove invalid staged notes before commit (at most n model checks, default 25)
                                 --strict makes manual/CI checks fail on issues
                                 --ref commit (default HEAD); --pre-push reads git stdin
  review [paths…] [--staged | --base ref | --ref commit | --state] [--model m] [--max n] [--kinds k,…] [--dry] [--json]
        [--strict] [--verbose] [--pr n] [--post]
                                 review a change against the cache: two model calls, one with the diff and the code it touched
                                 and one with the notes resting on or bearing on the change, report bugs and violations with
                                 file, line and evidence; the cache's own staleness is reported, not trusted; plus removed
                                 symbols still referenced. --kinds behavior: the desired behaviors alone, one call per behavior
                                 in play (what the pull request action asks the server for). Default: the working
                                 tree against HEAD; --base: the branch since its merge base; --ref: one commit; --state: the
                                 current code of the paths, with no change; --dry: no model calls; --strict: exit 2 on an
                                 error-severity finding (for CI); --post --pr n: post the report as a PR comment using gh
                                 authentication; --pr alone only links usage history; --post cannot be used with --dry
  export [file.tgz]              pack this repo's cache for delivery
  import <file.tgz|url>          unpack a delivered cache and check it against this checkout
  serve                          run the MCP server (stdio)
  orient "<task>" [--file f] [--budget n] [--snippets] [--session id]
  lookup "<query>" [--kind k] [--snippets] [--session id]
                                 (--kind behavior with no query: every desired behavior; --snippets: inline the code
                                 behind the pointers, as the MCP tools do)
  system [--all] [--json]        the desired behaviors of the system (notes of kind behavior) and whether the code
                                 upholds each: holds, violated since a commit, unverified; a review checks a change
                                 against them (fixed: never revised, a violation is an error; mutable: revised only by
                                 a change that edits the note)
  system add [file.json] [--fixed | --mutable]
                                 write one (JSON as for add: title, body with file:Symbol pointers, answers, deps)
  system promote <id…> [--fixed | --mutable]
                                 make a note that states a rule (invariant, convention, gotcha) a desired behavior
  system accept <id…> [--fixed | --mutable]
                                 accept a behavior an agent proposed (remember with kind behavior)
  system propose                 the notes that state rules, as candidates for promote
  system md                      write .thinker/SYSTEM.md, the behaviors as a document in the repository
  find "<words|Identifier>" [--path p] [--limit n]
                                 the definitions whose name or body carry the words, as pointers with their lines
  drilldown <pointer…> [--budget n]
                                 each definition whole with its lines (path:Symbol, path, or Symbol; several at once),
                                 one hop of callers and callees for a single pointer, and the notes on the code
  ranker [status|fetch]          the cross-encoder the hooks rank notes with: status says whether its runtime and
                                 model are in place; fetch gets the model (~23 MB, under ~/.thinker/models)
  ast [status|install]           symbol boundaries by tree-sitter instead of regex heuristics: install puts
                                 web-tree-sitter and its grammars (Python, JS/TS, Go, Rust; ~55 MB) under ~/.thinker/ast
  list [--stale] [--all]         list notes
  show <id>                      print a note
  rm <id>
  add [file.json]                add a human-written note (JSON on stdin or file)
  check                          re-hash dependencies, mark stale notes
  archive [--dry] [--list] [--restore] [ids...] [--kinds a,b] [--days n]
                                 take notes out of serving and upkeep, keeping them for review: the kinds named in the
                                 config (none by default) and notes unserved for 30 days; maintenance applies the same rules
  rehash [--fanout]              re-baseline every note's hashes without verification (--fanout: count references again)
  relink                         recompute cross-note links
  verify [ids...] [--model m]    re-verify stale notes with a small model
  maintain [--dry]               one background maintenance run: re-verify stale notes, phrase new ones, refresh
                                 distill newly merged PRs; runs by itself from the hooks, under a daily cap
  phrase [ids...] [--model m] [--force]
                                 add to each note how a user would put it, in the words of the product (for retrieval)
  distill [transcript] [--format auto|claude|codex|cursor|gemini|events] [--min-explore n] [--incremental [--batch]] [--evidence] [--dry] [--model m]
                                 turn a session into notes; reads any of these agents' transcripts, or a plain event trace;
                                 --batch (end of a turn) leaves a small backlog for the end of the session
  learn [--days n] [--max n] [--idle-min n] [--prs [n]] [--maintain] [--dry]
                                 learn from new session evidence (edits, failures, corrections), with sampled full-trace audits;
                                 --prs also mines merged pull requests that were not mined before (default 20)
  record <session>               append events (JSON lines on stdin: {t:prompt|say|tool, ...}) to a session trace, for agents without hooks
  seed [--areas n] [--prompts f.json] [--agent a] [--dry]   bootstrap coverage: one exploration session per source area
  outcome <session> good|bad [reason]           apply an outcome signal to the notes served in a session
  mine-prs [owner/repo] [--limit n] [--dry] [--git] [--fixes]
                                 distill merged PRs into fix / invariant / convention notes: those merged since the last run,
                                 then older ones; mined PRs are recorded in .thinker/prs.json and never distilled twice;
                                 without GitHub, or with --git, commits from git history (--fixes: only those whose message says they fix something)
                                 (default repo: the GitHub origin; --before <iso> [--after <iso>] [--again] picks a window by hand)
  hook <prompt|tool|stop [--nudge]> [--client c]   hook entrypoints (JSON on stdin): prompt = notes for the request, tool = notes about files being edited, stop = nudge + distill
  impact [--days n] [--pr n] [--json]   delivery outcomes: tokens per PR and confirmed bugs fixed before merge
  impact sync [--days n] [--pr n]      read PR lifecycle and commits through gh (no posting)
  impact link --session id --pr n     attribute a session; --split 12:0.4,13:0.6 splits its tokens
  impact export | impact import <file.json>   transfer evidence from CI or another machine
  impact link-review <run-id> --pr n   attach an earlier local review to its PR
  impact finding <id> --pr n --validity confirmed|dismissed|duplicate|pending --evidence reason
         [--resolution fixed|open|accepted-risk|not-applicable] [--fix sha] [--duplicate-of id]
  usage [--here] [--days n] [--json]
                                 how the cache has been used on this machine, in every repository: notes served, what sessions
                                 did with them, build/distillation tokens, and estimated savings
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
  rewire [--here] [--dry]        rewrite the hooks and MCP entries of your agent settings and of every checkout set up
                                 on this machine for this version, and wire thinker into your settings for the agents
                                 the checkouts wire (update runs it; the prompt hook does it for its own checkout)
  stats [--here] [--days n] [--json]
                                 machine-wide overview: activity, agents, learning, tokens and repositories; current checkout cache details
  telemetry [--send] [--json] [--force] [--event name] [--schedule] [--unschedule] [--status]
                                 cache effectiveness and size metrics sent to the metrics service;
                                 --schedule / --unschedule manages hourly background telemetry
`;

// Commands that read or maintain an existing cache. Not `setup`, `seed`, `mine-prs`, `import`,
// `add`, `record`, `distill`: those build one. Not `hook`: the hooks are quiet where there is no cache.
const CACHE_COMMANDS = ['orient', 'lookup', 'system', 'list', 'show', 'rm', 'check', 'archive', 'verify', 'phrase', 'learn', 'maintain', 'review', 'share', 'sync', 'export', 'health', 'relink', 'rehash', 'outcome'];

// One handler per command, in src/commands/; each gets the context below and nothing else of this file.
const COMMANDS = { ...noteCommands, ...cacheCommands, ...impactCommands, ...learnCommands, ...hookCommands, ...setupCommands, ...telemetryCommands, ...benchmarkCommands };

async function main() {
  if (!isTestMode() && process.stderr.isTTY && !['update', 'upgrade', 'switch', 'branch', 'hook', 'serve'].includes(cmd) && !process.env.THINKER_LOG) {
    const notice = checkPendingNotice(thinkerHome());
    if (notice) process.stderr.write(`[thinker] ${notice}\n`);
  }
  if (!['update', 'upgrade', 'switch', 'branch', 'telemetry', 'setup', 'share'].includes(cmd) && !flags.background) {
    maybeCheckDailyUpdateInBackground({ home: thinkerHome(), cliPath: path.join(HERE, 'cli.js') });
    maybeSendTelemetryInBackground({ home: thinkerHome(), cliPath: path.join(HERE, 'cli.js'), store });
  }
  // the cache is used only where `thinker setup` has run: a repository without .thinker/
  // is served nothing and learns nothing. Commands that build or add to a cache create it themselves.
  if (CACHE_COMMANDS.includes(cmd) && !store.exists()) {
    process.stderr.write(`thinker: not set up in this repository (${repo}). Run \`thinker setup\` there to set it up.\n`);
    process.exit(1);
  }
  // symbol boundaries by tree-sitter where its grammars are installed (`thinker ast install`), else by regex
  if (!['update', 'upgrade', 'switch', 'branch', 'serve', 'ast', 'usage', 'impact', 'stats', 'telemetry', 'help', undefined].includes(cmd)) await initAst();

  const handler = COMMANDS[cmd];
  if (!handler) { out(HELP); return; }
  await handler({ cmd, pos, flags, repo, store, out, readStdin, learnOn, sessionLearning, mcpEntry, userMcpEntry, HERE, NO_LEARN });
}

main().catch(e => {
  const hook = cmd === 'share' && (flags['pre-push'] || flags['repair-staged']);
  console.error(hook ? `thinker: note check unavailable; Git can continue (${e.message || e})` : e);
  process.exit(hook ? 0 : 1);
});

