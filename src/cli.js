#!/usr/bin/env node
import { isTestMode } from './test-mode.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, findRepoRoot, isGitCheckout } from './store.js';
import { initAst } from './ast.js';
import { thinkerHome, maybeCheckDailyUpdateInBackground, checkPendingNotice } from './update.js';
import { recordError } from './error-report.js';
import { ensureTelemetryScheduled, reportTelemetrySchedule } from './telemetry-schedule.js';
import { maybeSendTelemetryInBackground } from './telemetry.js';
import { commands as projectCommands } from './commands/project.js';
import { commands as noteCommands } from './commands/notes.js';
import { commands as impactCommands } from './commands/impact.js';
import { commands as cacheCommands } from './commands/cache.js';
import { commands as skillsCommands } from './commands/skills.js';
import { commands as learnCommands } from './commands/learn.js';
import { commands as hookCommands } from './commands/hooks.js';
import { commands as setupCommands } from './commands/setup.js';
import { commands as telemetryCommands } from './commands/telemetry.js';
import { commands as benchmarkCommands } from './commands/benchmark.js';
import { commands as doctorCommands } from './commands/doctor.js';
import { commands as coverageCommands } from './commands/coverage.js';
import { commands as symbolsCommands } from './commands/symbols.js';
import { commands as switchCommands } from './commands/repo-switch.js';
import { commands as externalCommands } from './commands/external.js';
import { commands as harnessCommands } from './commands/harness.js';
import { commands as instructionsCommands } from './commands/instructions.js';
import { commands as contextCommands } from './commands/context.js';
import { commands as explainCommands } from './commands/explain.js';
import { commands as reportCommands } from './commands/report.js';
import { commands as proxyCommands } from './commands/proxy.js';
import { commands as errorCommands } from './commands/errors.js';
import { commands as testingCommands } from './commands/testing.js';
import { isDisabledRepo, OFF_MESSAGE } from './repo-switch.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const cmd = argv.shift();
// Everything after a bare `--` is a command line of its own, taken as given: `thinker test --
// pytest -q tests/x.py` must not read pytest's flags as thinker's.
const dashdash = argv.indexOf('--');
const after = dashdash >= 0 ? argv.splice(dashdash).slice(1) : [];
const flags = {}; const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const boolean = ['full-repo'].includes(k) || (cmd === 'proxy' && k === 'codex') || (cmd === 'impact' && ['json'].includes(k)) || (cmd === 'system' && ['fixed', 'mutable', 'all', 'json', 'dry', 'again'].includes(k)); const v = !boolean && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; flags[k] = v; }
  else pos.push(argv[i]);
}
// A process can be left in a directory that no longer exists: a worktree removed under it, a build directory
// swept, or -- until install.sh ran its `npm ci` in a subshell -- the installer's own shell sitting in
// ~/.thinker/app while an update replaced it. `process.cwd()` throws ENOENT (uv_cwd) then, here, at import,
// before any command has a chance to run, so every thinker invocation died with a stack trace.
const workingDir = () => { try { return process.cwd(); } catch { return process.env.HOME || '/'; } };
const repo = findRepoRoot(flags.repo || process.env.THINKER_REPO || workingDir());
const store = new Store(repo);
const out = s => process.stdout.write(s + '\n');
out.stream = process.stdout; // the spinners and the build's progress bar draw on it (setup/ui.js:onTerminal)
const readStdin = () => fs.readFileSync(0, 'utf8');

// Learning from sessions is on unless switched off, which evals do to keep the cache fixed.
const NO_LEARN = /^(1|true|yes)$/i.test(process.env.THINKER_NO_LEARN || '');
const learnOn = () => !NO_LEARN && !flags['no-learn'] && !flags['serve-only'];
// Learning from sessions (the end-of-turn distill and the catch-up `learn`) is a model call per
// session, about 10¢ with Sonnet, and in a week on this repository 30% of them produced no note.
// `learn: {sessions: false}` in .thinker/config.json keeps it off; verification in maintenance goes on.
// `thinker distill <file>` by hand is still answered. THINKER_NO_LEARN=1 switches off everything.
const sessionLearning = () => store.config().learn?.sessions !== false;

// The MCP entry for a checkout's own files pins the repository; the user's machine-wide entry
// pins none, and the server takes the repository from the directory the client starts it in.
// THINKER_MCP_LAUNCHER marks an entry written since mcp.js became the launcher that carries updates to a running
// server. Its arrival changes the entry once, and an app that watches its MCP file (Cursor: a server restarted
// within seconds of an edit, 2026-10-16) replaces a server started before then; the entry stays the same after.
const mcpEntry = (r = repo) => ({ command: 'node', args: [path.join(HERE, 'mcp.js')], env: { THINKER_REPO: r, THINKER_MCP_LAUNCHER: '1' } });
const userMcpEntry = () => ({ command: 'node', args: [path.join(HERE, 'mcp.js')], env: { THINKER_MCP_LAUNCHER: '1' } });

const HELP = `thinker — knowledge cache for coding agents

  setup [--clients list|all|auto] [--no-learn] [--no-hooks] [--no-late] [--no-mcp] [--no-git-hook] [--no-trust] [--no-proxy] [--yes] [--no-ui]
                                 the one command that sets a repository up: connect the agent CLIs (hooks and the MCP
                                 server, clients claude, codex, cursor, gemini, pi, windsurf, copilot, opencode; default auto)
                                 and fetch the ranking model. Nothing is built: the cache starts empty and grows from your
                                 sessions. The first setup of a repository opens the local page (thinker ui) in the browser,
                                 --no-ui leaves it closed
  connect [--clients list|all|auto] [--no-hooks] [--no-late] [--no-learn] [--no-mcp] [--no-trust] [--no-proxy] [--yes]
                                 wire the agents on this machine into their own settings, once: hooks and the MCP
                                 server. Thinker then runs in every git repository: a cache starts with the first
                                 session there and grows from the sessions. Codex's hook-review
                                 marks are written without asking (--no-trust leaves them). The installer runs this.
  doctor [--fix] [--json]        check that thinker is installed and wired correctly: Node, dependencies, PATH, the
                                 agents' hooks and MCP server, this checkout's setup and git hooks, the MCP server
                                 starting, the ranking model, the model that answers thinker's calls; --fix repairs what it can and checks again
  disable | enable [--repo dir]  switch thinker off for this repository, machine-wide, or back on: for a repository with
                                 sensitive content. Off, the hooks and the MCP server do nothing there, no session is
                                 distilled, nothing is written into it
  uninstall [--purge] [--user]   remove this repository's hooks and MCP registration (notes are kept unless --purge);
                                 --user also removes the machine-wide wiring from your agent settings
  system [--all] [--json]        the desired behaviors of the system (notes of kind behavior) and whether the code
                                 upholds each: holds, violated since a commit, unverified (fixed: never revised;
                                 mutable: revised when merged code changes it)
  system add [file.json] [--fixed | --mutable]
                                 write one (JSON as for add: title, body with file:Symbol pointers, answers, deps)
  system edit <id> [file.json] [--title "…"] [--body "…"] [--fixed | --mutable]
                                 change one: its words (JSON with title and/or body, or the flags) and whether a
                                 change that breaks it is blocked; the old text is kept in its history
  system rm <id…>                remove one; one read from a design document stays out when the document changes
  system promote <id…> [--fixed | --mutable]
                                 make a note that states a rule (invariant, convention, gotcha) a desired behavior
  system accept <id…> [--fixed | --mutable]
                                 accept a proposed behavior (a build draft, or one an agent saved)
  system propose [--refresh]     review behavior drafts and rule notes that could be promoted; --refresh drafts them again
  system docs [--dry] [--again] [--limit n]
                                 read the design documents checked into the repository (READMEs beside the code,
                                 design and docs/ files) and save the rules they state as mutable behaviors, each
                                 quoting the document and pointing at the code that upholds it; a cache build starts
                                 with this. A document is read once per content (--again: read all again); --dry
                                 lists the documents without a model call; --limit n documents per run (default 12)
  system md                      write .thinker/SYSTEM.md, the behaviors as a document in the repository
  symbols [build|refresh] [--max-files n] [--build-ms n] [--quiet]
                                 the definition index this checkout keeps under .thinker/state/symbols, so a
                                 definition lookup reads a table instead of scanning the tree. Off until
                                 symbolTable {"enabled": true} is in .thinker/config.json; build is also what a
                                 lookup starts in the background when the table is missing or too far behind
  tools [enable|disable orient|find|drilldown …]
                                 which tools the server offers agents in this repository: all three are off unless enabled,
                                 and a tool that is off is neither offered nor mentioned to the agent (the commands below still work)
  find "<words|Identifier>" [--path p] [--limit n]
                                 the definitions whose name or body carry the words, as pointers with their lines
  drilldown <pointer…> [--budget n]
                                 each definition whole with its lines (path:Symbol, path, or Symbol; several at once),
                                 one hop of callers and callees for a single pointer, and the notes on the code
  ranker [status|fetch]          the cross-encoder the hooks choose notes with: status says whether its runtime and
                                 model are in place; fetch downloads the model
  ast [status|install]           symbol boundaries by tree-sitter (Python, JS/TS, Go, Rust), on by default: it comes with
                                 thinker's dependencies; install repairs an install that lacks them
  list [--stale] [--all] [--json]  list notes; JSON includes unreadable-note warnings
  show <id>                      print a note
  rm <id>
  feedback [file.json]           report note accuracy (JSON: id, useful, optional correction; stdin or file)
  add [file.json]                add a human-written note (JSON on stdin or file)
  check                          re-hash dependencies, mark stale notes
  archive [--dry] [--list] [--restore] [ids...] [--kinds a,b] [--days n]
                                 take notes out of serving and upkeep, keeping them for lookup by id: the kinds named in the
                                 config (none by default) and notes unserved for 30 days; maintenance applies the same rules
  rehash [--fanout]              re-baseline every note's hashes without verification (--fanout: count references again)
  relink                         recompute cross-note links
  verify [ids...] [--model m]    re-verify stale notes with a small model
  maintain [--dry]               run maintenance if four hours have elapsed (--dry previews): re-verify stale notes,
                                 phrase new ones; runs by itself from the hooks, under a daily cap
  phrase [ids...] [--model m] [--force]
                                 add to each note how a user would put it, in the words of the product (for retrieval)
  distill [transcript] [--format auto|claude|codex|cursor|gemini|events] [--min-explore n] [--incremental [--batch]] [--evidence] [--dry] [--model m]
                                 turn a session into notes; reads any of these agents' transcripts, or a plain event trace;
                                 --batch (end of a turn) leaves a small backlog for the end of the session
  learn [--days n] [--max n] [--idle-min n] [--maintain] [--dry]
                                 learn from new session evidence (edits, failures, corrections), with sampled full-trace audits
  record <session>               append events (JSON lines on stdin: {t:prompt|say|tool, ...}) to a session trace, for agents without hooks
  outcome <session> good|bad [reason]           apply an outcome signal to the notes served in a session
  coverage [--answer <dirs|none|never>] [--via picker|text] [--client c]
                                 the directories your sessions work in and how much of each the cache covers; --answer takes
                                 the reply to a coverage suggestion (directories, comma-separated) and builds the chosen ones
  mcp [--enable orient,…]        the MCP server on stdio, for an agent's MCP settings (THINKER_REPO pins the repository;
                                 --enable offers tools this checkout switched off, for this server only)
  version [--json]               the version this thinker runs, and its commit when it runs from a checkout
  served [--json]                what this checkout's own log says was served: prompt-hook and file-hook notes, orient and lookup calls
  spent [--json]                 what this checkout's own log says its model calls spent
  harness [--days n] [--json] [--verbose] [--off <labels>] [--undo [names]] [--recall on|off] [--enabled on|off]
                                 off by default, not yet released: --enabled on turns it on for this repository (--undo works either way);
                                 what Claude Code, Codex and Cursor record loading here (MCP servers, plugins, skills, with their tokens) against
                                 what the sessions use, and the ones worth switching off; the report changes nothing. --off switches named ones
                                 off here; --undo turns them (or the named ones) back on; --recall sets the line a request gets when it needs a
                                 switched-off tool (on with the harness). What is worth switching off is suggested with the rest of the context,
                                 once a week in a session and on the Find Savings page (\`thinker context\`), not as a question of its own
  instructions [--remove <id> | --compress <id> [--pr | --apply] [--job <id>]]
                                 the sections of AGENTS.md and their tokens;
                                 --remove / --compress <section id> show the diff of taking a section out or having a model shorten it;
                                 --pr opens a pull request with it (a branch pushed to the origin; the Find Savings page's Apply runs
                                 this in the background and follows it under Recent activity, --job naming the decision it recorded),
                                 --apply writes it to AGENTS.md in the working tree, uncommitted
  context [--days n] [--json] [--verbose] [--refresh] [--judge n] [--switch-off <labels> [--builtin]] [--switch-on <keys>] [--output-compression <tools> --level high|moderate|off]
          [--machine [--repos n] [--top n] [--ask [--no-browser]]]
                                 where the agents' context goes here and what each part is worth: every section of AGENTS.md (its
                                 tokens, the sessions it applied to, and the judged share it bore on and was followed), every skill
                                 (read in, kept its rules), every other tool loaded; --judge n judges n recent sessions now (model
                                 calls); a 25% sample is judged as sessions end (instructions: { value: { judge: false, share } } in .thinker/config.json)
                                 --refresh keeps the report for the page, which reads it instead of the transcripts (it runs this in the background)
                                 --switch-off turns the harness on here and switches those tools off (--builtin: built-in tools too);
                                 --switch-on turns them back on; --output-compression sets how much of a tool's results Claude Code keeps
                                 --machine, from any directory: the same report over the repositories the agents worked in lately (the
                                 5 most active, --repos n), merged, with what to cut first (5 suggestions, --top n); the installer runs
                                 it, from the sessions that ran before thinker was installed, and keeps each report for the page;
                                 --ask (a terminal) asks whether to see it in the browser or here, where the suggestions are a list
                                 to pick from and apply at once (--no-browser: the terminal without the question)
                                 the top changes with their suggested actions: --approve 1,3|all (3:remove picks another action),
                                 --dismiss 2, --history lists the decisions (a change under way, failed, or a pull request to merge
                                 is said so; reverted ones only with --reverted), --revert <n> takes one back, --retry <n> runs a
                                 failed change again; the page's Find Savings lists every part with its actions, and Recent
                                 activity the decisions with what needs you. Once a week the next prompt passes the five on with a link to that page
                                 (maintain.contextSuggest in .thinker/config.json; false turns it off)
  report [--weeks n] [--tokens] [--total] [--share] [--json] [--refresh [--all]]   the Report page in the terminal: the average cost of a prompt here at list prices, week by week over the
                                 last 6, by token type (fresh input, cache writes, cache reads, output), by part of the context
                                 (instruction files, custom and built-in tools, tool outputs, the rest) and by model under its provider, each part-table row against good and bad bounds in dollars; --tokens the same in tokens, without bounds, --total each week's
                                 sum instead of the average, --share each row as its share of the whole session (the totals stay);
                                 a cell up or down 5% against the first week is marked; then the decisions
                                 taken on the Find Savings page in the window and the cache's numbers, its saving in dollars first
                                 --refresh keeps the report for the page, which reads it instead of the log and the transcripts (it runs
                                 this in the background; --all for every repository the page lists, in one run)
  guide                          the cache usage guidance an install writes into an agent's instructions
  export [file.tgz] [--dir d]    back the cache up to a .tgz; --dir writes every note whole, one <id>.json each, into d
  hook <prompt|pre|tool|stop [--nudge]> [--client c]   hook entrypoints (JSON on stdin): prompt = notes for the request,
                                 pre = a test command rewritten to run through thinker test (off unless the config
                                 says tests.nudge), tool = notes about files being edited, stop = nudge + distill
  test -- <command>              run the test command with colour off, keep the whole log in a file under
                                 .thinker/state/tests/, and print only what a reader needs: the counts, the
                                 failures grouped by distinct cause (each once, with example test names and a
                                 few frames in this repository's files), the warnings as one number, and the
                                 log path. The exit code is the test command's. pytest, jest, vitest, go test,
                                 cargo test and node --test are parsed; any other runner is passed through and
                                 reported by the last lines of its log
  impact [--days n] [--pr n] [--json]   delivery outcomes: tokens per PR and confirmed bugs fixed before merge
  impact sync [--days n] [--pr n]      read PR lifecycle and commits through gh (no posting)
  impact link --session id --pr n     attribute a session; --split 12:0.4,13:0.6 splits its tokens
  impact export | impact import <file.json>   transfer evidence from CI or another machine
  impact finding <id> --pr n --validity confirmed|dismissed|duplicate|pending --evidence reason
         [--resolution fixed|open|accepted-risk|not-applicable] [--fix sha] [--duplicate-of id]
  ui [--port n] [--no-open] [--tab save|report|activity] [--here] [--refresh]
                                 open the local page, from any directory, over every repository on the machine (--here: this
                                 checkout alone), on Find Savings (--tab save): where the agents' context goes in each
                                 repository and what each part is worth, with the cuts (thinker context); then View Report (--tab report), what a
                                 session costs here week by week, by part and by model, in tokens or at list prices (thinker report);
                                 127.0.0.1 only, Ctrl+C stops it; --refresh looks for the repositories again and keeps the list the
                                 page reads (it runs this itself)
  skills [list|scan|audit <id>|review <id>|prefer <id>|dedupe] [--dry] [--again] [--limit n] [--json]
                                 the skill files (SKILL.md) of this checkout as the cache sees them: each has a card that is
                                 served like a note and audited against the code; a skill found out of date is listed with
                                 its issues and is neither served nor audited again until the file changes or a review;
                                 scan cards new or changed files (maintenance does this too), prefer picks one of
                                 several skills that do the same thing
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
  update [tag] [--check] [--force] [--quiet] [--schedule] [--unschedule] [--status]
                                 update thinker to the latest GitHub release, or to the release tagged <tag>; --schedule / --unschedule manages background updates every 4 hours
  switch <tag>                   switch thinker to the release tagged <tag> (a git checkout: to that branch); main or latest returns to the latest
  branch                         show the installed release tag, or the branch of a git checkout
  upgrade                        alias for update
  rewire [--here] [--dry]        rewrite the hooks and MCP entries of your agent settings and of every checkout set up
                                 on this machine for this version, and wire thinker into your settings for the agents
                                 the checkouts wire (update runs it; the prompt hook does it for its own checkout)
  stats [--here] [--days n] [--json]
                                 machine-wide overview: activity, agents, learning, tokens and repositories; current checkout cache details
  errors [--list] [--send] [--answer yes|no|never] [--json]
                                what thinker itself has failed at on this machine, exactly as it would be
                                 sent to its developers. Nothing is sent until you answer yes; never stops
                                 the question coming back
  proxy on [--gateway] [--upstream url] | off | status
                                the context proxy as a service of this machine (on by default from connect/setup; --no-proxy
                                 there leaves it off): clears older tool results for Claude Code, pi, OpenCode and Codex.
                                 Codex uses its existing OpenAI login through HTTP/SSE; custom providers stay as configured.
                                 Off restores the previous provider; status also prints the report of the last 30 days
  proxy [serve] --port n [--codex] [--protocol anthropic|responses] [--upstream url] [--notes] [--repo path] [--trigger n] [--keep n|turn] [--keep-min n] [--clear-at-least n] [--no-clear-inputs] [--no-clear-thinking] [--holdout share]
                                 the proxy in the foreground (what the service runs; --keep turn, the default: only the
                                 results of earlier turns are cleared; --keep n: all but the newest n);
                                 --notes serves this checkout's notes to an agent with no prompt hook (Goose, Aider: Anthropic
                                 and OpenAI chat requests; off until an experiment); proxy report [--days n] [--json] sums its
                                 log; proxy replay [--days n] [--policies spec] [--json] costs the policies over this
                                 checkout's Claude Code sessions with no model call
                                 --codex: serve Codex at /codex alongside Anthropic (enabled by the managed service).
                                 --protocol responses: a standalone OpenAI tool-output clearing proxy; requires --upstream,
                                 --keep turn and HTTP/SSE; preserves the current turn. Thresholds estimate tokens as bytes/4.
                                 Codex is wired by connect/setup/update by default. Setup and limits: docs/codex-proxy.md
  telemetry [--send] [--json] [--force] [--event name] [--schedule] [--unschedule] [--status]
                                 cache effectiveness and size metrics sent to the metrics service;
                                 --schedule / --unschedule manages hourly background telemetry
`;

// --help on any command prints this before anything runs. A flag the command does not take is refused
// for the commands that write agent settings, repository files and git hooks (a typo would otherwise
// run a setup); their flags are the ones HELP lists plus the few every command takes. The other
// commands keep taking any flag.
const COMMON_FLAGS = ['repo', 'dry', 'json', 'quiet', 'yes', 'verbose', 'background', 'no-learn', 'serve-only', 'help'];
// setup still takes the flags of the cache build it no longer runs (2026-10-21), so an old script does not stop on them
const UNLISTED_FLAGS = { setup: ['export', 'build', 'no-build', 'depth', 'agent', 'prs', 'pr', 'no-docs', 'benchmark', 'no-benchmark', 'no-prs', 'slug', 'no-phrase', 'model', 'project', 'directories', 'full-repo', 'areas', 'no-seed'], rewire: ['quiet', 'json'] };
const STRICT_COMMANDS = ['setup', 'connect', 'uninstall', 'rewire', 'doctor'];
function helpFlags(c, help = HELP) {
  const lines = help.split('\n');
  const start = lines.findIndex(l => new RegExp(`^  ${c}( |$)`).test(l));
  if (start < 0) return null;
  const block = [lines[start]];
  for (let i = start + 1; i < lines.length && !/^  \S/.test(lines[i]); i++) block.push(lines[i]);
  return [...new Set((block.join('\n').match(/--[a-z][a-z-]*/g) || []).map(f => f.slice(2)))];
}
function unknownFlags(c, given, help = HELP) {
  if (!STRICT_COMMANDS.includes(c)) return [];
  const known = new Set([...(helpFlags(c, help) || []), ...(UNLISTED_FLAGS[c] || []), ...COMMON_FLAGS]);
  return Object.keys(given).filter(f => !known.has(f));
}

// Commands that read or maintain a cache, and so need a git checkout to keep it in. Not `setup`,
// `mine-prs`, `import`, `add`, `record`, `distill`: those build one. Not `hook` (quiet outside a
// checkout) and not `ui`, the machine-wide page.
const CACHE_COMMANDS = ['tools', 'symbols', 'orient', 'lookup', 'system', 'list', 'show', 'rm', 'check', 'archive', 'verify', 'phrase', 'learn', 'maintain', 'session-work', 'export', 'health', 'relink', 'rehash', 'outcome', 'feedback', 'skills', 'instructions', 'context', 'explain', 'report', 'test'];

// One handler per command, in src/commands/; each gets the context below and nothing else of this file.
const COMMANDS = { ...projectCommands, ...noteCommands, ...cacheCommands, ...skillsCommands, ...impactCommands, ...learnCommands, ...hookCommands, ...testingCommands, ...setupCommands, ...telemetryCommands, ...benchmarkCommands, ...doctorCommands, ...coverageCommands, ...symbolsCommands, ...switchCommands, ...externalCommands, ...harnessCommands, ...instructionsCommands, ...contextCommands, ...explainCommands, ...reportCommands, ...proxyCommands, ...errorCommands };
// Commands that still answer in a repository thinker is switched off for (repo-switch.js): the machine-wide
// ones, the ones about the install itself, and the switch. `hook` keeps quiet by itself.
const OFF_COMMANDS = ['version', 'enable', 'disable', 'ui', 'help', 'update', 'upgrade', 'switch', 'branch', 'connect', 'doctor', 'uninstall', 'telemetry', 'usage', 'stats', 'ast', 'ranker', 'hook', 'serve', 'proxy', 'errors', undefined];

async function main() {
  if (flags.help || ['help', '--help', '-h'].includes(cmd)) { out(HELP); return; }
  // the server owns stdout from its first byte, and checks for a switched-off repository itself
  if (cmd === 'mcp') { await import('./mcp.js'); return; }
  if (cmd === '--version') { await COMMANDS.version({ flags, out, HERE }); return; }
  if (cmd === 'share' || cmd === 'sync' || flags.shared) {
    console.error('thinker: team sharing is no longer supported; notes and learning stay local.');
    process.exitCode = cmd === 'share' && (flags['pre-push'] || flags['repair-staged']) ? 0 : 1;
    return;
  }
  const unknown = unknownFlags(cmd, flags);
  if (unknown.length) {
    process.stderr.write(`thinker: ${cmd} does not take ${unknown.map(f => '--' + f).join(', ')} (\`thinker help\` lists its flags); nothing was run\n`);
    process.exit(2);
  }
  // Also runs in the new CLI that an older updater launches (`ranker fetch`).
  // `telemetry` manages its own schedule; uninstall/dry runs must not recreate it.
  if (cmd && !['uninstall', 'telemetry'].includes(cmd) && !flags.dry) {
    try { reportTelemetrySchedule(ensureTelemetryScheduled({ rootDir: path.resolve(HERE, '..') })); }
    catch (e) { reportTelemetrySchedule({ error: e.message }); }
  }
  if (!OFF_COMMANDS.includes(cmd) && isGitCheckout(repo) && isDisabledRepo(repo)) { process.stderr.write(`thinker: ${OFF_MESSAGE}\n`); process.exit(1); }
  if (!isTestMode() && process.stderr.isTTY && !['update', 'upgrade', 'switch', 'branch', 'hook', 'serve'].includes(cmd) && !process.env.THINKER_LOG) {
    const notice = checkPendingNotice(thinkerHome());
    if (notice) process.stderr.write(`[thinker] ${notice}\n`);
  }
  if (!['update', 'upgrade', 'switch', 'branch', 'telemetry', 'setup'].includes(cmd) && !flags.background) {
    maybeCheckDailyUpdateInBackground({ home: thinkerHome(), cliPath: path.join(HERE, 'cli.js') });
    maybeSendTelemetryInBackground({ home: thinkerHome(), cliPath: path.join(HERE, 'cli.js'), store });
  }
  // every git repository has a cache: one is started on first use (store.init keeps it out of git
  // status). Outside a git repository there is nowhere to keep one.
  // `context --machine` reads the repositories the agents worked in, from any directory
  // `context --machine` and `report --refresh --all` work over the repositories the page lists, from any directory
  if (CACHE_COMMANDS.includes(cmd) && !(cmd === 'context' && flags.machine) && !(cmd === 'report' && flags.refresh && flags.all)) {
    if (!isGitCheckout(repo)) { process.stderr.write(`thinker: ${repo} is not a git repository, so there is no cache here. Run thinker inside a git checkout.\n`); process.exit(1); }
    if (!store.exists()) store.init();
  }
  // symbol boundaries by tree-sitter where its grammars are installed (`thinker ast install`), else by regex
  if (!['update', 'upgrade', 'switch', 'branch', 'serve', 'ast', 'usage', 'impact', 'stats', 'telemetry', 'help', 'version', 'served', 'spent', 'guide', 'proxy', 'test', 'report', undefined].includes(cmd)) await initAst();

  const handler = COMMANDS[cmd];
  if (!handler) { out(HELP); return; }
  await handler({ cmd, pos, after, flags, repo, store, out, readStdin, learnOn, sessionLearning, mcpEntry, userMcpEntry, HERE, NO_LEARN });
}

main().catch(e => {
  // thinker's own failures were invisible: a stack on a terminal nobody reads again. The record is
  // local, scrubbed and sent only with the person's consent (error-report.js).
  try { recordError(`cli.${process.argv[2] || 'none'}`, e); } catch {}
  console.error(e);
  process.exit(1);
});
