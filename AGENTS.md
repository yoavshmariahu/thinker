<!-- thinker:workflow:start -->
## Using Thinker while working

Use the Thinker MCP tools (if they are listed as deferred, load them with the host's tool search) as a map to the code, then do the work. If they are unavailable, continue with ordinary tools.

- Read an injected <thinker-cache> bundle first: keep the notes that answer the request, ignore the rest, and check a STALE claim against the code. When none was injected, or none bears on the task, `orient` once.
- A note's file:symbol pointers say where the code is: read it there with ordinary search and reads. `lookup` answers one question a note left open.
- Then edit and test. Do not keep retrieving notes.
- Save a reusable rule, call path or gotcha with `remember` while the evidence is in context, with its reason and file:symbol deps; not a task summary. Correct a wrong note with `feedback` (its id, useful: false, the corrected body).
<!-- thinker:workflow:end -->

# thinker: internals and working context

Reference for agents and contributors working on this repository. The
user-facing summary is in `README.md`; benchmark results are in
`research/bench-history/RESULTS.md`.

```
agent session ──► distill ──► .thinker/local/notes/*.json ──► orient / lookup (MCP)
                                   │
                          deps + content hashes
                                   │
             commit / edit ──► stale ──► verify (small model) ──► fresh | updated | retired
```

## Working on this repository

**The command line and the local page stay in sync (MANDATORY RULE):**
The page (`src/ui/`) is a second door to the same commands, never a second
implementation. A default the page shows (the model, the depth, the pull-request
count, the areas a build reads, the agent) is the constant the command reads:
`DEFAULT_DISTILL_MODEL` in `src/llm.js`, `DEFAULT_DEPTH` and `DEFAULT_PRS` in
`src/setup/estimate.js`, `activityAreas` in `src/areas.js`, `buildAgent` in
`src/setup/agents.js`. A job the page queues runs the command line with the flags
the person would have typed, so `thinker setup --build --yes` and the warm-up page
build the same cache. `test/cli-ui-sync.test.js` checks both doors; a new default
or flag gets a line there before it ships.

**Pull requests in this repository (MANDATORY RULE):**
We use PRs here to keep every change reviewable in one place. This is
a contributor workflow for thinker itself, not a product requirement. Teams using
Thinker may land direct commits or use any Git workflow; setup must not install
our repository policy guard or require PRs in their repositories.
- Push task branches and open a GitHub pull request targeting `main`. Never push
  commits directly to remote `main`, including fast-forward pushes.
- **The `tests` workflow is disabled** since 2026-10-07, at the owner's request
  (`disabled_manually`; `gh workflow enable tests` reverses it). No test check will
  report on a pull request, so do not wait for one: run the full suite locally
  (`npm test`, which sets `THINKER_TEST=1`) before pushing and state the result in
  the pull request, then merge through GitHub and bring local `main` up to date
  from the merged remote branch.
- Do not bypass a pre-push guard or disable hooks to push `main`.
- GitHub server-side enforcement for this private repository requires GitHub Pro
  (the API currently returns 403 on the account's plan). Until enabled, the local
  guard and this policy enforce the workflow on this checkout, not on every client.


**Every model-backed feature works in the desktop apps (MANDATORY RULE, 2026-10-16):**
Anything thinker starts that calls a model for the person (a warm-up, learning, a
coverage build, verification, a new kind of build) must also run inside a desktop
app (Claude Desktop, the Codex app, Cursor) and wherever no agent CLI is signed in.
Those sessions have no CLI login to read through: the work goes through the
session itself, as the warm-up does (`repo-onboard.js:startSessionWarmup`,
`session-llm.js`: model calls queued in `.thinker/state`, a background subagent
answering them through `warmup_next` / `warmup_answer`). A feature that only says
"sign in a CLI" in a desktop app is not done. Tests cover the desktop-app path
(`appFn`, a missing CLI login) beside the CLI one.

**No new cache-building or serving strategy ships without an experiment (MANDATORY RULE, 2026-10-16):**
A change to what the cache is built from (a new source, a new selection of code or
history, a new note kind) or to how notes reach the agent (ranking, the
cross-encoder, floors, slots, budgets, a new serving pool) lands off by default,
behind a config switch, until an experiment shows it helps. The experiment runs
through Artemis (plan, the owner's approval, then the run), compares the strategy
with what ships on the same tasks, and is written up with its numbers and caveats.
Offline replays of retrieval against labelled targets are a first step, not the
evidence: the outcome is measured in agent sessions. Turning the switch on by
default is its own pull request that cites the experiment.

Requires Node 20+. Tests: `npm test` (`node --test test/*.test.js`).

**Releases are GitHub releases on tags (since 0.1.35):** a release is the tag
`vX.Y.Z` on a commit of `main`, with `thinker.tgz`, `version.json` (version,
commit, sha256 of the archive) and `install.sh` attached. The installer
(`install.sh`, run through `npx @zerotimedev/thinker`, the npm package that carries it) and `thinker update` (`src/update.js`)
read `releases/latest/download/version.json` and download the archive from the
same release; `thinker update vX.Y.Z` pins one. To cut a release, manually run
`bash scripts/release.sh X.Y.Z` from any checkout. The runner
(`scripts/release.mjs`) fetches `origin/main`, tests a version-only bump in a
temporary worktree and opens a PR. It waits for the user to review and merge
the PR; it never merges or pushes main itself. It tests and packages the merged
commit (`scripts/pack.sh`), tags it, publishes the GitHub release and its three
assets, verifies the public download, then publishes the npm installer at the
same version. Rerunning the same command resumes incomplete steps from the
exact tag; existing public assets and npm versions are never overwritten.
Without a version it resumes the current `origin/main` version. `--hold` publishes a version that is not latest (a GitHub pre-release, npm tag `next`), so
nothing updates to it until `bash scripts/release.sh X.Y.Z --promote`. See
`docs/releases.md` for prerequisites, authentication and `--no-wait`.
Nothing is uploaded to zerotime.dev any more; `scripts/pack.sh <base
url>` still builds a self-hosted set for anyone who wants one. Installs made
before 0.1.35 point at `zerotime.dev/dist` and move to GitHub on their first
update that runs the new code (`install.sh --update` does it by hand).

**No telemetry from tests or benchmarks (MANDATORY RULE):**
Always set `THINKER_TEST=1` when running tests, benchmarks, evaluation
harnesses, scratch experiments, or their setup/install steps (`npm test` sets it).
This single mode blocks production telemetry and automatic background work, keeps
default usage logs local, and silences machine-wide hooks. It also makes no warm-up or coverage offer
to the agent, from the hooks or from `orient` over MCP (2026-10-18: an offer in a benchmark session is noise
in its context, and the eval runner marked the session invalid for it); `THINKER_OFFERS=on` restores them,
for the tests of the offers only. `THINKER_TELEMETRY=off`
remains a valid additional telemetry-only control. Ensure every child
process inherits it. Never send these runs to the production telemetry endpoint
or count them as real usage. Telemetry-specific tests may use mocked requests or
an isolated loopback server only; they must never contact production.

**Benchmark caches come from the product's own build paths, out of the task's past (MANDATORY RULE):**
Build a benchmark cache through one of the product's own paths, and from nothing else: mining merged
changes (`mine-prs`, GitHub or `--git`), or reading the code at the anchor (`understand`: notes on how
the most changed files work, src/understand.js; added 2026-10-16 after it reached 8 of 13 mlflow
requests with an on-target note against 3 for mining). Exploration (the `seed` command, removed in 0.1.22) was never a
benchmark cache source: measured on Click on 2026-10-07 it cost 3.6M tokens for 0 notes
under Opus and 1.3M for 1 note under Sol, against 272k tokens for 9 notes by mining, so
it buys cost and not cache. Also forbidden, none of it being the product learning from
the repository's own past: synthetic agent sessions, distillation of a benchmark's own
eval traces, and hand-written notes.
Nothing from the task's future may be reachable. Build at an anchor commit at or before
the earliest task base in that repository, give each task a copy of that cache topped up
only with changes merged before its own base, and check that the fix commit is absent
from the checkout the cache was built in. Record the anchor commit, what was mined or read, source hashes, and the model and effort of every building call -- which must
match the coding arm's. A missing, failed or empty cache must stop the run before coding.
No alternative cache source and no silent fallback.
Historical session-learning experiments are not valid caches for these runs.
`research/performance-canary/guardrails.py` enforces this for that harness
(`cacheSource: recent-merged-prs`); `research/efficiency-simple/run.py` mines only.

**Matched models in comparisons (MANDATORY RULE):**
Compare arms only with the same exact model and reasoning effort for each
corresponding phase (exploration, memory building, coding and any judging). Keep
agent configuration fixed except for the declared intervention being compared.
Record them before running, disable silent provider/model fallback, and report a
model mismatch as an invalid comparison. Prefer executable tests for correctness;
keep correctness, tokens and latency separate. Results from different models or
reasoning settings belong in separate cohorts, not one ranking.

**Evals run only through Artemis, the evals platform (MANDATORY RULE):**
Run, follow and read benchmark experiments only through Artemis, its own repository
(`~/src/artemis`, started with its `bin/artemis-up`; a web app and an MCP server), following its
`run-evals` skill (`.agents/skills/run-evals/SKILL.md` there): freeze the PRs with `create_pr_set`,
build the cache through `plan_cache`/`build_cache`, plan the experiment with `plan_experiment`, get
the user's approval of each plan, start with `start_experiment`, read with `get_experiment` and
`get_session`. Do not start the task runner (`~/src/task-runner`) or a benchmark `mine-prs` by hand,
and do not report numbers hand-computed from run files. The cache-source and matched-model rules
above still apply to every experiment the platform starts.

Artemis and the task runner use thinker only as an installed program, through its CLI (`thinker
mcp`, `hook`, `guide`, `served`, `spent`, `export --dir`, `version`; `src/commands/external.js`).
Changing what those commands print or take is a change to their interface: keep them compatible, or
change Artemis in step. Which thinker an experiment tests is Artemis's setting (`~/.artemis/
config.json` `"thinker"`): point it at a worktree to test a branch.

**Agent concurrency and worktrees (MANDATORY RULE):**
All agents working on this repository MUST perform code changes, scratch experiments, and benchmark runs in isolated git worktrees to avoid collisions with other active agents or running benchmark jobs. Never edit directly in the primary working tree.
- **Create a worktree:** `git worktree add -b agent/<task-name> .worktrees/<task-name> HEAD` (gitignored).
- **Work strictly within the worktree.**
- **Destroy on completion:** Once changes are committed/pushed/merged, or if the task is aborted or cancelled, always remove the worktree:
  ```bash
  git worktree remove --force <path-to-worktree>
  git branch -D agent/<task-name> # if no longer needed
  ```

Model calls go through the Anthropic SDK when `ANTHROPIC_API_KEY` is set,
otherwise through the first installed agent CLI (`claude`, `codex`, `gemini`,
`agent`), so no extra credentials are needed. `claude -p` is run with its
system prompt replaced (`--system-prompt`, `--setting-sources ''`,
`--disable-slash-commands`; `llm.js:viaCliOnce`): appended to, Claude Code's
own prompt added ~7k tokens to every call, written to the one-hour prompt
cache at twice the input price and never read again.

| path | contents |
|---|---|
| `src/cli.js` | the `thinker` command: argument parsing, the help text, the prelude every command shares (update notice, background update and telemetry, the not-set-up check, the parser), and a table of handlers |
| `src/commands/` | one module per group of commands, each handler taking the dispatcher's context (`store`, `repo`, `flags`, `pos`, `out`, …): `notes.js` (orient, lookup, find, drilldown, system, list, show, add, rm, archive, phrase, rehash, relink), `cache.js` (review, export, import, serve, health, stats, usage), `learn.js` (learn, maintain, distill, record, outcome, verify, check, mine-prs, and the PR-mining helpers), `hooks.js` (the hook entrypoints and the background catch-up they start), `setup.js` (setup, uninstall, ast, update/upgrade/switch/branch), `telemetry.js`, `benchmark.js`, `shared.js` (helpers several of them need) |
| `src/mcp.js` | MCP server exposing `orient`, `lookup`, `find`, `drilldown`, `remember`, `feedback` |
| `src/setup.js`, `src/setup/` | the guided `setup` flow (`runSetup`), with its parts under `src/setup/`: `ui.js` (colors, boxes, the arrow-key menu), `agents.js` (which agent CLIs are installed and logged in, and the menu that picks one), `estimate.js` (what a cache build will cost), `steps.js` (wiring the clients, building the cache), `pr-benchmark.js` (the optional PR change benchmark); everything is re-exported from `setup.js` |
| `src/clients.js` | adapters for Claude Code, Codex, Gemini CLI, Cursor, Pi, Windsurf Cascade, Copilot CLI (and Copilot in VS Code), OpenCode, Factory Droid, Qwen Code, Kiro CLI, Cline, Kilo Code, Auggie and Goose: config files and hook formats; native extension handlers in `src/integrations/`; coverage in `docs/agent-integrations.md` |
| `src/transcripts.js` | session transcripts of every agent as one event form; the hook-recorded trace; finding sessions |
| `src/prs.js` | mining merged pull requests into notes |
| `src/ops.js` | core operations on notes (serve, merge, assess, link) |
| `src/deps.js` | dependency extraction and symbol-level content hashing |
| `src/ast.js` | symbol boundaries by tree-sitter (Python, JS/TS, Go, Rust), on by default: the parser and its grammars are dependencies; `deps.js` falls back to regex heuristics where they are missing, for other languages, and for a definition with a parse error |
| `src/disk-cache.js` | results kept on this machine between processes, by a key naming everything they depend on: definitions, symbol and file hashes, hashes at a commit, and what each transcript loaded and called (`harness.js:sessionHarness`, `harness-codex.js:codexSessionHarness`, by the file's size and mtime, `cachedByFiles`: the Context and Harness pages read every transcript of the window on each request, a gigabyte and five seconds on this repository before, under 0.3 s after) (`~/.thinker/cache`) |
| `src/codegraph.js` | one hop of the call graph: references and blast radius of a symbol (`fanout`), callers, callees, definitions, outlines, and `findSymbols` (the definitions carrying the words of a query); behind `find`, `drilldown` and the `[n call sites in m files]` tags on pointers. From the code graph when the checkout is indexed, else from `git grep` |
| `src/rank.js` | BM25 ranking, relevance gate, budget packing |
| `src/distill.js` | transcript → notes and per-note assessments |
| `src/maintain.js` | background maintenance: re-verify stale notes, phrase new ones, distill newly merged PRs, under a daily cap |
| `src/skills.js`, `src/commands/skills.js` | skill files (SKILL.md) as cached knowledge: one card per file, audited against the code, graded by the sessions that invoke it, duplicates settled; `thinker skills` (docs/skills.md) |
| `src/instruction-value.js`, `src/context-view.js`, `src/commands/context.js` | what each part of the agents' context is worth here: every AGENTS.md section (tokens, sessions it applied to by its triggers, and judged relevant / followed / broken), every skill (read in, rules kept, missed), every other tool; `thinker context` and the page's Context tab (see [Context view](#context-view)) |
| `src/testing.js`, `src/commands/testing.js` | test economy, off until an experiment: `thinker test -- <command>` runs a test command with colour off, keeps the whole log in `.thinker/state/tests/` and prints the counts, the failures grouped by distinct cause, and the log path; the parsers (pytest, jest, vitest, go, cargo, node --test), the cause grouping and the command classifier the `pre` hook uses |
| `src/guard.js` | anchoring guard: names identifiers in the request that the served notes do not cover |
| `src/update.js` | CLI self-update and daily automatic background updates (LaunchAgent / cron / invocation) |
| `src/usage.js` | summary of the usage log and the estimate of saved calls and tokens, in tokens (never dollars) |
| `src/store.js`, `src/llm.js` | note storage; model access through any installed agent |
| `src/server/` | `thinker-server`, the team's central cache: HTTP API (`index.js`), per-repository stores with a change journal and a clone of the repository (`repos.js`), tokens (`auth.js`), the worker that reviews the pull requests CI asks about (`worker.js`); the server learns nothing itself |
| `infra/sync/` | the server on EC2: CloudFormation stack, bootstrap script, deploy script |
| `src/change.js` | the change under review with no model call: scope, parsed diff, the definitions the hunks touched, the notes resting on them (`selectNotes`), what the changed definitions use one hop down (`usedContext`); the model-free half of the `thinker review` command removed on 2026-10-11 |
| `test/` | unit tests (`node --test`) |
| `research/bench-history/` | what the benchmarks measured before they moved out (`RESULTS.md`, serving notes); the harness, task sets and run data are in Artemis's database, the old scripts in this repository's history before 2026-10-16 |
| `.thinker/` | thinker's own notes about this repo |

Benchmarks are not in this repository: Artemis (`~/src/artemis`) holds the task sets, PR sets,
caches, runs and their data, and the task runner (`~/src/task-runner`) runs the sessions. A
`bench/` folder left in a checkout is local leftovers and ignored.

## What `setup` does

The installer (`install.sh`) installs the tool wherever it is run and wires
it into the agents on this machine (`thinker connect`, below). Every git
repository on the machine has a cache from then on:
the first hook, MCP server or cache command in a checkout starts one, empty
(`store.js:init`, kept out of `git status` through `.git/info/exclude`), and it
grows from the sessions there. Nothing is opt-in but the warm-up: building a
cache from merged pull requests, a step a person takes by hand with `thinker warmup`
or `thinker setup --build`. **Background learning was cut to the sessions on
2026-10-21 (the owner's decision: the cache's background spend was not paying for
itself, and few people were running it):** the installer no longer ends by running
`thinker warmup`, the hooks and the MCP server no longer tell the agent to offer a
warm-up (`repo-onboard.js:warmupOffersOn`; `warmup: { offer: true }` in
`.thinker/config.json` brings the offer back for a repository, and `THINKER_OFFERS=on`
for the tests), and maintenance mines no pull requests or commits, walks no area
history, reads no design documents or skill files and merges no duplicates unless
the repository's `maintain` config turns each on (`maintain.js:DEFAULTS`). What is
left on by default: the once-per-session distillation, and a maintenance run that
re-verifies at most 3 stale notes and phrases the new ones. Everything below this
paragraph about warm-ups describes the by-hand path, `thinker warmup`
(`commands/warmup.js`): browser or terminal, then the ten repositories the
agents work in (`machine.js:warmupCandidates`) with the top five picked (`setup/ui.js:multiSelect`: arrows, Space, Enter;
Esc skips; a plain Y/n without a TTY), each built
with `thinker setup --build` at full depth around the person's areas
(`setup/project.js`, `--yes`). A machine without a display (ssh,
`headless`) is offered the terminal alone: the page binds 127.0.0.1 of the
machine it runs on, and until 2026-10-12 the installer launched it blind there.
Outside a git repository there is nowhere to keep a cache: the CLI's cache
commands stop with that message (`cli.js:CACHE_COMMANDS`), the MCP server
offers no tools and says so in its instructions, and the hooks are quiet. A
prompt an empty cache has nothing for is logged as a request all the same
(`commands/hooks.js`), so `thinker usage` and the telemetry count the machine
as active; before 2026-10-12 it was not, and a machine in daily use read as
idle until its cache had learned something.

The wiring lives in the agents' own settings, once per machine, since
2026-10-04 (`clients.js:wiringFiles`, scope `user`): `~/.claude/settings.json`
and `~/.claude.json`, `~/.codex/hooks.json` and `~/.codex/config.toml`,
`~/.gemini/settings.json`, `~/.cursor/hooks.json` and `~/.cursor/mcp.json`.
`thinker connect [--clients …]` writes it and needs no repository; `setup`
runs it as its first step, and so does the installer. A hook there names no
`--repo` and reads the checkout from the agent's input (`cwd`, Cursor's
`workspace_roots`; `commands/hooks.js`); the MCP entry pins no `THINKER_REPO`
and the server takes the repository from the directory the client starts it
in, asking a client that declares MCP roots for its workspace when that
directory is not a repository (`mcp.js`). Before that, `setup` wrote the
hooks and the MCP entry into each checkout's own files, which the Codex
desktop app does not read (openai/codex#13025: it loads MCP servers from the
user's `config.toml` alone), and a fresh worktree had none of them. The
checkout's machine-local wiring of this copy is taken out by `setup` and by
the first hook at user scope that runs there (`clients.js:stripRepoWiring`),
named once at the end of the turn; committed wiring (`--shared`, `.mcp.json`)
stays, and a hook at user scope yields to a checkout whose own files run this
copy's hooks (`clients.js:repoWiredByCopy`), so nothing fires twice.
`thinker uninstall --user` removes the machine-wide wiring; the installer's
`--uninstall` does that outside a repository. A machine set up before this
needs no step: the `rewire` that `thinker update` runs wires the user's
settings for every agent the known checkouts wire to this copy, with the
options they were set up with (`clients.js:connectFromCheckouts`).

`thinker setup` connects the agents (above), adds the repository's own pieces
(git hooks, Cursor's always-applied rule, Codex's trust in the project,
`.thinker/`), and then asks whether to build
the cache from the merged pull requests, since that is the only
step that spends anything (`setup.js:confirmCacheBuild`). The question defaults
to no; `--build` answers yes without asking (so does `--yes`, or naming
`--prs`/`--pr`), `--no-build` answers no and leaves a repository that
is set up and learns from sessions. Outside a terminal the answer is no.
Declining, or having no authenticated agent, no longer stops setup: step 1 has
already run and the footer says how to build later.

The build itself (`thinker setup --build`, or the installer with `--build`):

1. distills up to 60 merged pull requests of the GitHub `origin` into fix
   records, invariants and conventions (`--prs n`; needs `gh`);
2. links the notes, writes search phrasings (eight notes per call,
   `ops.js:phraseBatches`) and drafts behaviors (four source notes per call,
   `behavior-proposals.js:generateBehaviorProposals`). Both are batched because
   `claude -p` exits 1 when an answer reaches its output cap, and a failed batch
   costs its own notes only; the retries are `thinker phrase` and
   `thinker system propose --refresh`, never a second build;
3. last and optional (`--no-docs`), reads the checked-in design documents into
   system behaviors (`behavior-docs.js`), at most eight a build
   (`setup/steps.js:DOCS_LIMIT`; maintenance reads the rest), then the skill
   files. Last since 2026-10-12 because it is the least exercised path of a
   build, so a problem there costs nothing that came before.

On a terminal the build shows one progress bar on its last line
(`setup/ui.js:progressBar`, fed by `progress.js:buildProgress`): the share
done, the time left, and the stage's counts (pull requests mined, documents
read) with the item in hand; the stage headlines and results print above it.
The page's bar reads the same model from the mining batch's file
(`ui/server.js:jobProgress`). The agents (`--clients claude,codex,cursor,gemini`, `all`,
   or `auto`, the default) were connected in step 1.

A build does not explore the code, and no command does: exploration sessions
(`thinker seed`, `setup --areas n`) were removed in 0.1.22. They cost about 400k
tokens per area against 14k per pull request and gave few notes back, and a
"skipped" exploration line read as a failed step to the agents running setup.
The build says once that its notes come from pull requests; `--areas` and
`--no-seed` from old scripts are ignored.

Both steps run through an installed agent with its own login (`--agent`
picks one). Measured on this machine's log: about 14k tokens per
pull request (`setup/estimate.js:TOKENS_PER_PR`). The estimate is printed
in tokens and minutes before anything runs, never in dollars: decided 2026-10-04,
since most agents run on subscriptions and a figure from API list prices told
people they would spend money they would not. In a terminal `setup`
asks before spending (`--yes` skips the question). The hooks and MCP entry live in the agents' own settings. Team wiring with
`--shared` is no longer supported.

To mine more pull requests later, run `thinker mine-prs` (or `thinker learn
--prs`, which distills new sessions first). With no arguments it takes the
GitHub `origin`, mines what was merged since the last run and then goes
further back in history, 20 at a time (`--limit n`). Without GitHub, or
with `--git`, it mines commits from git history; `--fixes` keeps only those
whose message says they fix something (`prs.js:FIX_LIKE`), the records a
reviewing agent draws on most; a repository whose work lands by direct commits has
few pull requests, and this one had 8 to mine against 17 fix commits. With GitHub, the
build, the warm-up and maintenance read merged pull requests alone, so a change pushed
straight to the default branch is never mined there (188 of this repository's 551
first-parent commits since 2026-09-19 name no pull request). So those commits are listed
beside the pull requests, unless `mining: { commits: false }` in `.thinker/config.json`
(or `THINKER_MINE_COMMITS=off`; the variable overrides the config) says otherwise (`prs.js:listMergedChanges`, `commitsOn`):
a pull request keeps GitHub's description and review comments, a commit is mined from
its message and diff as with `--git`. On by default without an experiment, at the
owner's decision (2026-10-19), an exception to the rule below.
A cache warmed before that read the pull requests alone, and in a repository developed
mostly by direct commits it stayed small. Maintenance finds such caches without a model
call (`commits-offer.js:scheduleCommitsOffer`, at most weekly, on a GitHub repository whose
cache has read some history): when 20 of the last 500 first-parent commits are direct,
unmined and not chores, the next prompt asks the person once ("thinker found N unmined
commits", `<thinker-unmined-commits>`) to mine them, no or never; a yes runs `thinker
mine-prs --direct` (only commits naming no pull request) in the background through their
agent's login, or the session in a desktop app (`answerCommits`, the MCP `commits` tool,
`thinker commits --answer`). No waits a month; never stops it on the machine
(`THINKER_HOME/state/commits-never`); `maintain: { commitsOffer: false }` turns the check
off. `thinker commits` prints the count. Every
pull request it
has looked at is recorded in `.thinker/prs.json`, which is committed with the
notes, so none is distilled twice, by you or by a teammate. Pull requests merged
after thinker was set up are distilled by background maintenance (see [The
learning loop](#the-learning-loop)); `mine-prs` is for history before that.

## Project cache builds

`thinker.project.json` at the repository root stores `{version: 1, name,
directories: [repo-relative paths]}`. `src/project.js` validates paths and reads
it for cache-building commands only. `thinker project init <dirs...> --name ...`
creates it without initializing a cache. Interactive setup (`src/setup/project.js`)
offers Full repo or Specify project directories before the usage estimate; `--yes`
reuses the file. `--project file` chooses another file; `--full-repo` overrides it
for one run. Choosing Full repo in the menu updates an existing default file to
`directories: ["."]`.

`planAreas` / `discoverAreas` use literal git pathspecs before clustering and
cannot widen a selected deep directory into its parent. No command calls them now
(the behavior interview that listed the main areas is removed, with `thinker system define`). Groups use
128 KiB of source (roughly 32k tokens) and 80 files as per-session working-set
heuristics, not a repository coverage limit. Small sibling groups share a session;
oversized directories split recursively, including flat directories split into
explicit file batches. A single oversized file stays intact. Every eligible
source file belongs to one group; tests are used only if no production source is
available. Size and git churn determine execution order, and an explicit cap
selects from that order. These sizing heuristics are not empirically calibrated.
Setup passes the same directories to estimates and PR mining. Scoped PR scans keep a directory-keyed
cursor; only successfully processed changes enter the global mined record, so
unrelated PRs remain available to other builds. Git history uses directory
pathspecs; GitHub uses the listed changed paths with bounded scans. All projects
share the repository's notes. Retrieval and automatic maintenance do not
load the project file; existing dependency paths provide retrieval relevance.

## Usage history

Every serving, assessment, distillation, verification and mining run is
appended to one file for the machine, `~/.thinker/log.jsonl` (under
`THINKER_HOME`). Each line names its repository by the origin in
`.git/config` (`github.com/owner/repo`), so worktrees and further clones of
a repository count as that repository; a checkout without an origin is
named by its path. `THINKER_LOG` changes
that: a path, `local` (the repository's own `.thinker/log.jsonl`) or `off`.
Runs with `THINKER_NOTES_DIR` set, which is how benchmark arms serve a
noteset, log locally by default, so experiments stay out of the machine's
history; a harness that installs real hooks should set `THINKER_LOG=local`.
The log holds the first 200 characters of each request.

`thinker usage [--here] [--days n] [--json]` summarizes it for every
repository on the machine, with a line per repository (`--here`: this
repository only). A repository's older local log is moved into the machine's
log the first time thinker runs there, and kept as
`.thinker/state/log-before-shared.jsonl`. The summary covers notes served and how, what the
sessions did with them, what was learned and what it cost, and an estimate of
the tool calls and tokens saved. The estimate counts only servings a session
was seen to act on (`confirmed`), as one read per file the note rests on (at
most 5) at the file's size (at most 6,000 tokens). It is not a measurement;
measured effects are in `research/bench-history/RESULTS.md`.

A dep that is not code a session would have read counts as nothing
(`usage.js:countsAsReading`): the agents' own configuration (`.claude/`,
`.codex/`, `.cursor/`, `.gemini/`, `.mcp.json`), git's internals, `.thinker/`
itself, and build or run output. Every note must rest on an existing file
(`ops.js:createNote`), so a note about the permission classifier or about
duplicate hooks rests on `.claude/settings.local.json` for want of anywhere
better; what it saves is a wrong action, not a read, and crediting it with the
size of that file made the turn notice claim reading nobody would have done.
Such notes keep their anchors and are ranked and served exactly as before —
only the estimate ignores them, and `cacheHitSavings` reports how many deps it
passed over as `uncounted`. The floor that gives a note whose files are missing
one read's worth is not applied when every dep was passed over this way, and
the turn notice then names the notes and stops rather than printing `~0 tokens
of code`. On this repository 29 of 754 deps stopped counting. The limit is that
nothing distinguishes a note *about* a file from a note about the behaviour
around it: a gotcha resting on a real 525-token script still counts as that
script's size.

Build and run output is refused as an anchor outright
(`deps.js:TRANSIENT`: `node_modules/`, `dist/`, `coverage/`, `.next/`,
`__pycache__/`, `bench/runs/`, `.thinker/`, `*.log`, `*.tmp`), since the next
run rewrites or removes it. One served note here rested on nothing but a
223-byte benchmark log that git ignores. The check is at creation only, so
notes already stored keep their deps — but `deps.js:checkNote` refuses to call
such a dep stale, re-hashing it in place instead: the next run rewrites the
file, so a changed hash says nothing about whether the claim still holds. The
two notes explaining that `.thinker/` files rewrite themselves were both
permanently stale, from `.thinker/` files rewriting themselves, and took a
verify slot each time. Agent configuration is a valid anchor and is not
covered: a note about what is in `.claude/settings.json` still goes stale when
that file changes; a note left with no other anchor is
refused with `no resolvable dependencies`. Agent configuration is deliberately
not refused — those notes are worth keeping.

Model work is also logged as `op: "model"`, with `purpose`, `phase` (init / learning /
maintenance), provider, resolved model, raw usage, normalized token counters and
reported cost. Input totals include provider cache reads and writes; these are separate
from thinker's own estimated savings. Operation summaries marked `metered` are not
charged again. `usage --json` exposes `spending` by phase, purpose, model and repository,
plus `saved.netAfterSpend` (estimated reading avoided minus notes injected minus reported
model tokens). Missing counters/costs stay unknown. Legacy logs lack setup exploration
and token counts, so this comparison is partial, not measured financial ROI. See
`src/model-usage.js` for provider normalization.

Nothing is given in dollars (decided 2026-10-04; `prices.js` and the dollar balance
went with it): the agents run on subscriptions as often as on metered keys, and a
figure from API list prices told most people what they would not pay. A cost the
provider itself reported stays in the log and in `usage --json` as data
(`spending.reportedCost`, `unknownCostCalls`), never estimated from tokens and never
shown. The end-of-session assessment still records the model the session ran on, read
from its transcript (`transcripts.js:parseTranscript` returns `model`: Claude Code's
`message.model`, Codex's `turn_context`, Gemini's message `model`; Cursor names none),
on the `attest` line; for assessments written before that, `usage` finds the transcript
by session id (`transcripts.js:sessionModel`); the saving is reported by model
(`saved.byModel`, `unknown` for sessions that named none). Every model answer carries
its normalized counters (`llm.js:executeProvider` adds `tokens`; `model-usage.js:tokensOf`),
which is what the commands print after a run (`~24k tokens`).

## What a note is

A note answers a recurring question, not "what this file does":

| kind       | answers                                                                 |
|------------|-------------------------------------------------------------------------|
| `map`      | where a recurring concern is handled, how control or data flows across files, the shape of a module area |
| `howto`    | how to build / test / run / lint, with the non-obvious flags            |
| `rule`     | what a change must respect: an invariant, a convention, a trap, a fix not to undo, a reason, what changes together and through which mechanism |
| `behavior` | a desired behavior of the system a person wrote; the code must uphold it (see [Desired behaviors](#desired-behaviors)) |

Until October 2026 there were eleven kinds (`location`, `callpath`, `overview`,
`invariant`, `convention`, `gotcha`, `rationale`, `fix`, `cochange`, `howto`,
`behavior`): nobody applied them consistently, the distiller included, and the
serving code had a branch for several. The old names are read as the new ones
wherever a note is read (`store.js:KIND_ALIAS`, `kindOf`), so committed notes,
benchmark notesets and a config written with them keep working; a file is
rewritten with the new kind when the note is next written. The measurements
quoted below with the old names are about those subkinds.

Each note stores: `title`, `answers` (question phrasings, for retrieval),
`body` (3–12 lines with `file:Symbol` pointers), `deps` (files/symbols it
rests on, each with a content hash), `source` (agent / human / pr / doc),
`verified`, `verifiedCommit`, `confidence`, `status` (fresh / stale / invalid).

## Dependency-keyed invalidation

- A dep is `{path, symbol?}`. With a symbol, thinker hashes just that
  definition's block; without, the whole file. A note about
  `Command.invoke` does not go stale because an unrelated function in the
  same file changed.
- The block is found by tree-sitter when its grammars are installed
  (`ast.js`; Python, JavaScript, TypeScript, Go, Rust) and otherwise by a
  language-agnostic definition regex with brace or indentation matching
  (`deps.js:findSymbol`). The regex is thrown off by braces in strings and
  regex literals and by `return foo(` lines; on this repository's own notes
  the two disagreed on 5% of symbol deps, the regex wrong each time. The
  parser is on by default since 0.1.30: `web-tree-sitter` and
  `tree-sitter-wasms` are dependencies, pinned to the versions that load each
  other, and install and update put them in place with the rest (`npm ci`).
  They were an optional `thinker ast install` into `~/.thinker/ast` before;
  that directory is still read, after thinker's own copy
  (`ast.js:astDirs`; `THINKER_AST_DIR` names another place; `thinker ast`
  shows which is in use and `thinker ast install` repairs an install without
  its dependencies; `THINKER_AST=off` disables it). An install made without
  npm has no parser and keeps the regex. A dep hashed by the parser carries
  `engine: "ast"` and, beside its hash, the regex hash of the same symbol
  (`hashRegex`). So the two kinds of checkout agree (`deps.js:checkNote`):
  where the parser arrives, a dep the regex hashed is not stale if the regex
  block is unchanged, and the parser's record replaces it (`upgraded`);
  where there is no parser, a dep a teammate's parser hashed is not stale if
  its `hashRegex` still matches, and the record is kept as it is. Installing
  the parser, or lacking it, marks no note stale.
- The parser is not believed where it failed. The grammars lag the languages
  (Go's `new(expr)`, TypeScript's `import('x').T` in a type: 5% of the
  TypeScript and 3% of the Go files behind the Grafana and PostHog notesets
  parse with errors), and the parser recovers silently, cutting a definition
  short or folding its neighbours into it. A definition with a parse error in
  or beside it is marked (`ast.js:broken`) and `astFindSymbol` returns nothing
  for it, so `locateSymbol` falls back to the regex. One name of a declaration
  group (`const ( A = 1; B = 2 )`, `const a = 1, b = 2`) is its own lines, not
  the group's. Measured over 1,359 symbol deps of five notesets on 2026-10-10:
  the engines agree on 96%; of the 53 they disagree on, the parser is right on
  about 44 (the regex takes a call site for the definition, or runs past its
  end), 8 are judgment calls (a Rust `struct` or its `impl`), and none is a
  case where the regex is right.
- What hashing works out is kept on disk between processes
  (`disk-cache.js`, under `~/.thinker/cache`): a file's definitions by its text
  (`ast.js:definitions`), a symbol's or a whole file's hash by the text
  (`deps.js:symbolRecord`, `fileHash`), and a dep's hash at a commit by the
  commit (`deps.js:hashDepAt`, which was two git processes for every dep whose
  hash had moved, on every prompt). The keys carry the text or commit and the
  hasher's own source, so an entry is never wrong, only absent; nothing there
  is a record, and deleting the directory costs one slow run. Every hook and
  command is a new process, and without this each one re-read every file every
  note points at: on this repository's 158 notes `orient` took 0.88 s with the
  regex and 1.3 s with the parser, and takes 0.36 s with either now; the check
  of all 307 Grafana notes went from 0.7 s (1.7 s with the parser) to 0.09 s.
  The suite runs without the cache unless a test names a directory
  (`setDiskCache`) or `THINKER_HOME` is set.
- Pointers written in the body (`core.py:Command.main`, `Foo.bar`,
  `types.convert_type`) are extracted automatically and added as deps, so
  the tracked set matches what the note actually claims.
- Every `orient`/`lookup` re-hashes the deps of every note against the
  working tree, so uncommitted edits are caught too. A whole-file dep on a
  file the note also points into by symbol is dropped when the note is
  created or verified (`ops.js:dropShadowedFileDeps`). A whole-file dep on
  a code file whose definitions the body names becomes those symbol deps
  when the note is created (`deps.js:narrowAtCreation`; configs, scripts
  and documents stay whole), and the distiller is told to name the
  definition for a code file. Maintenance and `thinker check` judge a
  changed whole-file dep further (`deps.js:narrowFileDep`, `checkNote` with
  `narrow`): when the body names definitions in the file, the dep becomes
  those symbol deps, the note is stale only on the ones that changed since
  `verifiedCommit` (each carrying its hash from that commit, so the change
  stays visible), and the narrowed deps are persisted whether the note is
  fresh or stale, so the next check and the verification see symbols, not
  the file; when it names none and no changed line of the diff since
  `verifiedCommit` holds a term the note uses, the dep keeps the file and
  takes the new hash. `checkNote` returns deps that are safe to store in
  either case: a dep the change altered keeps its stored record. On this
  repository (two hundred commits a week) 74 of 137 stale notes rested on
  nothing but whole-file deps on hub files (`src/cli.js` in 48), and
  neither the term rule nor a line-anchored variant could clear them, since
  a week of diff to a hub file holds every word; anchoring to definitions
  is what helps, and it helps the next time, not retroactively.
  Stale notes are ranked lower and served with a `⚠ STALE` banner listing
  exactly which deps changed and how (symbol body changed / file removed /
  symbol not found).
- The `verify` log record names the deps that triggered it (`changed`).
- `thinker check` persists statuses; `thinker verify` sends each stale note, the git diff of
  its changed deps since `verifiedCommit`, and the current text of every dep
  to a small model (Haiku by default) which answers `still_valid` (re-hash,
  bump confidence), `update` (rewrite body, keep history) or `invalid`
  (retire). The answer is the verdict and one sentence, a body only for
  `update`, capped at 1,500 tokens (`ops.js:VERIFY_SCHEMA`,
  `VERIFY_MAX_TOKENS`): a week of verify calls here averaged 2,900 output
  tokens for verdicts that were 64% `still_valid`. A rewritten body that
  starts with the framing the model was shown (`NOTE (kind=…) "title"`, or
  the title) loses that line (`ops.js:cleanBody`).

## Capture

1. **Automatic**: `thinker distill <transcript.jsonl>` condenses a session
   (prompts, tool calls with truncated results, the agent's final answer)
   and asks a model for 0–3 notes with deps (`distill.js:MAX_NOTES`; the
   prompt expects 0 or 1, and rules out news of what changed, the state of
   one machine, and what the repository's own docs say). The hooks run this
   in the background once per session (on by default; see below). The
   distiller is shown the notes already resting on the files the session
   touched, and up to four on the topic of its requests by BM25
   (`distill.js:relatedNotes`), and may return one with `extends: <id>` and
   the merged body instead of a new note. Near-duplicate notes (same kind,
   ≥0.5 Jaccard on title+answers) are merged, keeping history. The distiller
   is told that a rule about things changing together must name the
   mechanism (a generator, registry, schema, mirror or test), not list the
   files one session touched, since git history holds that already.
2. **Agent-authored**: the `remember` MCP tool, for agents that finish
   working something out.
3. **Human**: `thinker add note.json`.

## The learning loop

Each session both consumes and improves the cache:

1. `UserPromptSubmit` hook injects the orientation bundle and records which
   note ids were served in this session.
2. Once per session, the distiller sees the trace **and the injected notes**, and
   returns new notes plus one assessment per injected note:
   `confirmed` (the agent acted on the pointer, nothing contradicted it:
   confidence +0.05), `contradicted` (the trace shows a claim is wrong:
   confidence −0.25, body replaced by the correction, history kept, retired
   below 0.3) or `unused` (after five unconfirmed servings, confidence decays
   towards 0.4). No judge or gold answer is involved; the signal comes from
   the transcript.
3. New notes are linked to existing ones that share a symbol-level dep (or
   several files); `orient` pulls one linked note in beside the best hit
   when it has relevance of its own.
4. Co-change is gone (2026-10-04). Co-change notes were acted on 0 of 5
   times they were served and were archived; the git-mined index that
   replaced them (edit-hook partner hints, the end-of-session nudge, the
   `thinker cochange`, the refresh in maintenance,
   `.thinker/cochange.json`) was never shown to be followed either, and was
   removed with the module. An older cache's `cochange.json` is ignored, and
   its `cochange` notes are read as rules (`store.js:KIND_ALIAS`).

5. Archiving (`ops.js:archiveNotes`, `thinker archive`): a note that the
   sessions showed is not worth serving leaves orientation, the edit hook,
   background verification and phrasing, and stays for `drilldown`, `find`
   and `lookup` by id; `rank.js` scores it like an
   invalid note. Two rules, both free: the kinds named in the config (none
   by default since the collapse to four kinds; before it, location, fix,
   cochange and convention, which in a week on this repository were acted on
   0 of 6, 0 of 12, 0 of 5 and 0 of 3 times when served), and a note nobody
   was served in 30 days since it was made. `archived: {at, reason}` is this checkout's
   state (`store.js:LOCAL_FIELDS`), never shared or pushed; a shared note's
   committed file is untouched. Maintenance applies the rules on every run
   and names the count once; `archive` in `.thinker/config.json` sets
   `kinds` and `unservedDays` or is `false`. `thinker archive [--dry]`
   runs the rules by hand, `--list` shows the archive, `--restore [ids]`
   takes notes back, and ids archive any note by request.
5b. Duplicates by meaning (`dedupe.js`, 2026-10-19; on by default from then until 2026-10-21,
   off since with the rest of the background spend: `maintain: { dedupe: true }` or
   `THINKER_DEDUPE=on` turns it on for a repository): `saveNotes`
   merges only notes whose title and answers share half their words, so the same fact
   mined from a pull request and saved from a session in other words stayed two notes
   (0.30 by that measure) that took both serving slots. Where it is on, maintenance finds candidates for free:
   each note embedded locally from its title and search text (`dense.js:embed`,
   all-MiniLM-L6-v2, vectors kept in `.thinker/state/dedupe.json` by text), a pair being
   two notes on a file in common at a cosine of at least `dedupeThreshold` (0.75). On this
   repository's 337 notes that took 4 to 6 seconds and gave 21 pairs, 17 of them the same
   claim or two disagreeing claims about one thing (by hand labels of the top 40; recall
   below 0.75 is not measured). Up to `dedupePerRun` (3) are judged, one call each through
   the verify model (`dedupe.js:judgePair`, through the session in a desktop app), shown
   both notes and the current code of the file they share: `same` and `conflict` are
   merged into the older note (its id, servings and assessments; both notes' answers and
   deps; the old body in `history`) with the judge's title and body, a conflict keeping
   only what the code bears out, and the other is archived as `duplicate of <id>`
   (`thinker archive --restore` takes it back); `distinct` is remembered and not asked
   again until either note's text changes. Logged as `op: "dedupe"`; the end-of-turn
   notice says how many were merged. Checked before it was turned on: on mlflow's mined
   cache 14 pairs, of whose notes past sessions on its 11 tasks were shown 2, so a paired
   run there could not have told the two apart; no agent-session experiment was run.
6. Since 2026-10-21 background upkeep is small: verification is one batch every three days
   (`verifyEveryDays`), of the stale notes served in the last three days (`verifyServedDays`), at most
   50 (`verifyPerRun`); a note a session contradicted is verified at the next run. A note nobody was
   served in 14 days, made longer ago than that, is deleted (`maintain.js:deleteUnused`,
   `deleteUnusedDays`; behaviors, skill cards and notes a person wrote stay, and a note committed to the
   repository is archived instead). After an update, `thinker rewire` stops what an older version left
   running that the new defaults no longer do: a mining batch, the unmined-commits question, queued jobs
   other than distillation, catch-up and maintenance (`retire-background.js`), unless the repository's
   config turns mining on. What follows describes the run as it was before.
   Maintenance runs by itself (`maintain.js:maintain`): the catch-up run that
   the prompt hooks start at most every ten minutes ends with one maintenance
   run, and so do the git `post-commit` and `post-merge` hooks that `setup` and the
   installer put in place (`--no-git-hook` leaves it out). A batch runs at most
   once every four hours, on the next repository activity after
   it is due (including explicit `maintain`; `--dry` previews without waiting).
   Retrieval never spawns verification. By default (since 2026-10-21) a run re-verifies up
   to 3 stale notes (10 before) and writes
   phrasings for up to 8 notes that lack them, and that is all it spends on. The
   steps below run only where the repository's config turns them on: with
   `maintain: { prs: true }` a run distills up to 3 pull
   requests merged since maintenance first ran in the repository (older ones
   are `thinker mine-prs`), walks the focus areas' history (`areas.js`) and
   schedules the unmined-commits question (`commits-offer.js`). Fixes come first (`prs.js:pickPrs`): a pull
   request whose title says it fixes something qualifies without a body and
   takes up to two thirds of a run's slots when other changes wait; a
   candidate the limit passes over is not recorded as mined and is offered
   again next run (`learn.js:minePrs`, `deferred`). The record of a fix is
   what a review draws on most: on 23 real PostHog regressions every bug the
   cache caught and the diff alone missed rested on a note mined from the fix
   (`research/bench-history/RESULTS.md`, "Real bugs on PostHog"). Re-verification ahead of time is for notes served in
   the last 14 days (`verifyServedDays`; 0: all), the most served first; a
   stale note nobody is reading waits until a later batch after it is served.
   Dependency hashes and git diffs since each note was verified identify the
   affected notes; unchanged dependencies cause no verification call. A note
   re-verified 3 times in a week (`verifyChurn`; 0: never) rests on code under
   active change: it is left stale, with its ⚠ banner, and named to the user
   once (`maintain.js:pickStale`), to narrow its pointers or retire it. In the
   week this was added, 28 of 80 notes maintenance verified had not been served
   at all, and one note was rewritten 8 times. The tokens the model calls of
   learning and maintenance reported are summed from the machine's log and a run stops
   at `dailyTokens` (default 1M tokens a day with Sonnet, about 40 distillations, and 10M
   with a cheap model; 2M and 50M until 2026-10-21; until 2026-10-04
   the cap was `dailyCap` in dollars, a key now ignored except that 0 still means no
   cap). `maintain` in `.thinker/config.json`
   overrides `enabled`, `dailyTokens`, `verifyPerRun`, `verifyServedDays`,
   `verifyChurn`, `phrasePerRun`, `prs`, `prsPerRun`, `docs`, `docsPerRun`, `skills`, `skillsPerRun`,
   `dedupe` (with `docs: true` a run also reads up to
   three new or changed design documents into behaviors and reconciles the ones a changed
   document produced: `behavior-docs.js:deriveDocBehaviors`; with `skills: true` it cards up to three
   new or changed skill files, `skills.js:scanSkills`). What a run did is shown once at the end of the next turn
   (`maintain.js:maintenanceNotice`), through the same channel as the
   cache-hit notice. `thinker maintain [--dry]` is one run by hand;
   `THINKER_NO_LEARN=1` switches it off with the rest of learning.

Learning is on by default in `setup` and the installer. Evals keep
the cache fixed with `--no-learn` at install time, or `THINKER_NO_LEARN=1` in
the environment, which also silences hooks that are already installed.
`learn: {"sessions": false}` in `.thinker/config.json` switches off learning
from sessions alone (the session distill and the catch-up `learn`), while
learning from code changes goes on: pull requests and re-verification in
maintenance, `thinker distill <file>` by
hand. Each session distilled is a model call, about 10¢ with Sonnet, and in a
week on this repository 30% of them produced no note; without them there are
also no assessments, so `thinker usage` counts no servings as acted on. The
hooks skip a quiet session (`distill.js:quietSession`): nothing served in it
to assess, no edit, no failed tool call, no correcting prompt, and under eight
exploration calls; logged as `distill-skipped` with `reason: quiet`.
`learn.quietExplore` in the config moves the line (0: distill every session);
`thinker distill <file>` by hand distills regardless. The distiller is asked
only for the kinds worth a note here (`ops.js:distillKinds`): the kinds this
checkout serves, plus the kinds review reads from the archive (`REVIEW_KINDS`:
rule, behavior; behavior is never distilled). A note of a left-out kind that
comes back anyway is skipped by `saveNotes`.

Controls for experiments: `THINKER_NOTES_DIR` (a flat note store for a
benchmark arm), `THINKER_HOOKS=off` (the user's machine-wide
hooks do nothing; a checkout's own hooks are unaffected) and `THINKER_MCP=off` (the MCP server offers no
tools; the control arm of `thinker benchmark`), `THINKER_HOLDOUT`. The
switches of settled experiments were removed in October 2026 (early modes,
the router, forced or naive serving, links and co-change off, the guard off,
cover floors, pointer and snippet limits, the fanout tag, a per-model guide
above `orient`); what they measured is in `research/bench-history/RESULTS.md`, and what won is
the only behavior. A harness that needs the order alone passes `cover: {body:
0, question: 0}` to `rank` and `refreshFirst: false` to `orient`.

## Serving

- MCP server (`thinker serve`, registered in `.mcp.json` by `thinker setup`)
  with tools `orient(task, file?, budget?)`, `lookup(query)`, `remember(...)`,
  `feedback(id, useful, correction?)`, and, where a repository turned them on,
  `find(query, path?)` and `drilldown(pointer)`.
- The code tools are off by default since 2026-10-10 (`cache-guidance.js:disabledTools`,
  `thinker tools enable|disable find|drilldown`, kept as `disabledTools` in
  `.thinker/config.json`). On the held-out mitmproxy canary a Codex agent told to
  reach code through them made ten extra calls for three useful answers, and each
  call re-sends the conversation. A tool that is off is not registered by the
  server and is named nowhere the agent reads (server instructions, the bundle
  header, the workflow block, the tool intro, `find`'s own "Next:" line), so
  nothing calls it and fails. The `thinker find` and `thinker drilldown` commands
  still work by hand.
- `orient` is off by default since 2026-10-18, the release after 0.1.65 (`thinker tools enable
  orient` turns it on, kept as `enabledTools` in `.thinker/config.json`). Off, the
  server does not offer it, and the usage guide, the bundle header, the workflow
  block and the tool descriptions say to work from the code instead of calling it;
  the prompt hook serves the notes, `lookup` stays, and `lookup` makes the warm-up
  offer `orient` made to an agent with thinker's server and no hooks
  (`mcp-server.js:mcpWarmupOffer`). On the MLflow fair-11 set with GPT-6 Astra
  (Artemis `mlflow-fair11-astra-mined200-full-2026-10-18`) the orient-first arm
  called it every session, got nothing back in 12 of 22, and cost 43k input
  tokens and 2.1 tool calls more than the bare agent; the hook alone was level
  with the bare agent and 41k tokens and 2 calls under the orient arm. Existing
  installs turn it off too: a `disabledTools` list written before (0.1.65 could
  switch it) does not keep it on, only `enabledTools` does, and `rewire` on
  update rewrites the instruction files. No client is told to orient, at the
  owner's decision (the value shown is the hooks'): Windsurf, which runs no
  prompt hook, reaches notes through the CLI `lookup` alone, and Copilot CLI
  through its hook on the first successful tool call.
- Code behind the pointers: the MCP `orient` and `lookup` end with the
  definitions the served notes point at (`ops.js:codeSnippets`: up to two per
  note and four in all, each cut to 30 lines), in what is left of the note
  budget plus `SNIPPET_BUDGET` (600 tokens). The hooks do not add them
  (`thinker orient --snippets` does); `snippets: false` in
  `.thinker/config.json` turns them off. Measured
  against Qartez on click, the agent spent its advantage on reading whole
  files after orienting; this is what the snippets are for.
- When `orient` or `lookup` over MCP finds no note, its answer carries the first
  six definitions `find` returns for the request (`mcp.js:codeFallback`, logged
  as `client: "mcp-fallback"`), and the prompt hook's bundle names `find`: in
  the week before, real sessions never called `find` (Claude Code defers MCP
  tools until searched for), only the benchmark arms did. Two weeks later the
  log held 3 `find` and 2 `review` calls over MCP against hundreds of hook
  orients, and sessions reported changes done without a review. Since
  2026-10-05 the first bundle of a session carries a `<thinker-tools>` intro
  (`ops.js:sessionIntro`): what `find` and `drilldown` do, for Claude Code
  the exact `ToolSearch select:…` that loads them; logged as `intro`. Since
  2026-10-07 it comes only with the first bundle that serves a note, never on
  its own, and the workflow block that `setup` writes into the agent's
  instruction file (`cache-guidance.js:agentWorkflow`) holds the four
  decisions in four lines: on the Click canary of that day
  (`research/efficiency-simple/CANARY-2026-10-07.md`) the intro, the workflow
  text and the tool schemas were the whole cost of a session the notes did
  not help, and the block's opening sentence about `THINKER_MCP=off` and
  `.thinker/` had a Codex agent spend its first turn on `printenv` and
  `test -d .thinker`. It does
  not name `review`: with one sentence saying it existed, the agent called it at
  the end of both reruns and lost three minutes to each timed-out call. A held-out session gets
  none of it. On two Grafana tasks under Gemini (`research/bench-history/RESULTS.md`, "Tool
  intro") the intro got `find` called where it never was. It first also told
  the agent to run `review` before reporting done, with a first-edit nudge
  repeating it; both went the same day at the user's decision, a review runs
  when asked for, and those runs had shown the agent polling a slow review for
  minutes instead of working. `git grep --untracked` behind `find`,
  `drilldown` and the reference counts reads into a checkout nested under the
  repository (a benchmark's clone under `bench/runs/`): on this repository
  `find` answered with PostHog's definitions. Lines under a directory holding a
  `.git` entry are dropped (`codegraph.js:gitGrep`), as are `coverage/`,
  `__pycache__/` and `.next/`.
- `find(query, path?, limit?)` answers "where is this defined / handled" when
  no note does: the definitions whose name or body carry the words of the
  query (`codegraph.js:findSymbols`), as `path:Symbol:L12` pointers with their
  size and, for the first three, blast radius, plus the notes resting on them.
  One `git grep -c -F -i` for the words over the source files (a second or
  two on PostHog), the lines of the 50 files with most mentions attributed to
  the enclosing definition through `outline` (parser, graph, or regex; a regex definition ends where its braces or indentation close, and no later than the next definition indented no deeper, so a one-line `const` is not credited with the text below it), and the
  graph's name search added when the checkout is indexed. A word in the name
  outweighs one in the body, which outweighs one in the path; words on many
  lines weigh less; a definition covering more of the words comes first; tests
  are scaled down; bodies over 1,500 lines are dropped. Scoring is heuristic,
  not BM25 over source. Measured against codebase-memory-mcp on click, the
  agent used that server's `search_graph` and `get_code_snippet` where thinker
  left it grepping and reading file ranges; `find` and the whole-definition
  `drilldown` below are what that showed thinker lacked.
- `drilldown(pointer)` takes `path:Symbol` pointers (or a path, or a bare name,
  resolved through the notes' pointers and then the code), several at once
  separated by commas, and returns each definition whole with its lines (the
  default budget of 2,500 tokens holds about 150 lines; a class that does not
  fit is shown as its head and the outline of its members), for a single
  pointer one hop of callers (every reference, calls first) and callees
  (names the body calls that are defined in the repository), and the notes
  resting on that symbol or file
  (`ops.js:drilldown`, `codegraph.js`). Everything is answered by `git grep`
  over the language family of the file: no index, approximate by design.
  Outside a git checkout it says so.
- Blast radius: a symbol pointer is served as `path:Sym:L12 [6 call sites in
  3 files]`. The count is made when the note is created and again for the
  symbols a verification found changed (`codegraph.js:annotateFanout`;
  `thinker rehash --fanout` redoes all), stored on the dep as `fanout`, and
  not made for names under four characters or common ones (`main`, `get`).
- The code graph that was: [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp)
  (CBM), a binary that indexes a repository into a graph and answers over MCP,
  was an opt-in engine behind `drilldown`, `find` and the blast-radius counts
  for a while. Measured on click (`research/cbm-comparison/`) the graph-backed
  arm was marginally cheaper and no more accurate than thinker's own tools,
  so the engine, its `thinker cbm` command and its switches were removed in
  October 2026. CBM stayed a comparison baseline: the harness that compared
  the arms `thinker` (notes, git grep) and `cbm` (the graph alone, as the
  agent's MCP server) was `bench/cbm-*.js`, in this repository's history
  before 2026-10-16; as an arm today it is defined in Artemis; the earlier comparison
  against Qartez is in `research/qartez-comparison/`.
- The prompt hooks serve two notes. When an agent calls `orient` with its own
  `budget`, up to five are served (past the second, a note must reach 0.7 of
  the best hit's relevance), a linked note is added instead of replacing a
  hit, and relevant notes that were not served are listed by title and id;
  `lookup` takes such an id (or a query, returning up to 3 notes by default).
- Prompt-time hook: injects the orientation bundle into every prompt
 automatically (no tool call needed). See [Supported agents](#supported-agents).
- What the user sees: the stop hook sums the turn, prompt-time and late notes
 together (`🧠 thinker: 2 notes this turn (pointing at 2 files, ~7k tokens of
 code)`, `usage.js:turnNotice`). The prompt hook says nothing to the user: a
 line at every prompt was noise. Tokens are one read per file a note rests on. The notice does not say "saved": at serve time nothing
 is known about whether the agent will act on a note, and in a week on this
 repository about 30% of servings were; what was saved is counted once the
 session is assessed, in `thinker usage`. Shown through `systemMessage` in Claude Code and Gemini CLI;
 Codex and Cursor have no channel for it from a stop hook. `THINKER_NOTICE=off`
 or `notice: false` in `.thinker/config.json` turns it off.
- The Claude card (2026-10-18): the Claude desktop app shows a stop hook's
 `systemMessage` collapsed, so nobody saw the line. `thinker connect` names a Claude
 Code mod, `src/integrations/claude-card`, in `CLAUDE_CODE_PLUGIN_DIRS` in the `env`
 block of `~/.claude/settings.json` (`clients.js:installClient`, user scope; `rewire`
 points it at the new copy after an update, `uninstall --user` takes it out). The mod
 reads the notes the hooks served (the prompt's as the hook row the session appends,
 the late notes from PostToolUse's `additionalContext`) and draws a card under that
 turn's answer: `🧠 Thinker · 2 notes this turn · Estimated tokens saved: ~6k` and
 the notes' headlines, with the estimate made as `usage.js:cacheHitSavings` makes it
 (`test/claude-card.test.js` holds the constants together). The card is kept in the
 mod's store by the end of the answer's text, so it is drawn again with the transcript
 and stays in the history. The mod marks each session it runs in under
 `THINKER_HOME/state/claude-card/`, and the stop hook leaves the turn's line out of a
 marked session only (`claude-card.js:claudeCardActive`): a Claude Code without mods
 keeps the line. Its own tests run with `claude plugin test src/integrations/claude-card`.
- Ranking: BM25 over title/answers/tags/deps/body with identifier splitting,
  plus path affinity to the current file, kind priors for orientation,
  confidence, what sessions did with the note when it was served
  (`attest.confirmed` against `attest.unused`, smoothed; up to ±0.1), and a
  stale penalty; greedy packing into the token budget
  (full note, else a one-line stub).
- Coverage floors: relevance is relative to the best note, so the best of a
  poor lot scores near 1. A note is served only if it also covers a share of
  the request's term weight: 0.20 with its body and pointers, 0.05 with its
  title, answers and tags (`rank.js:MIN_COVER`; on the benchmark task sets
  the body floor separates on-target from off-target servings, 0.10 did
  not). When the agent calls `orient` itself (up to five notes, a sentence
  as the request) the body floor is 0.30 (`MIN_COVER.agentBody`): on the
  offline sets this took grafana's agent-path precision from 0.12 to 0.17 and
  mitmproxy's from 0.56 to 0.64 with no task losing its on-target note,
  posthog unchanged at 0.80; 0.35 cost posthog a task. A short query must be covered by more: the weight of about three of
  its words. A request of two or three content words must share two of them
  with the note's title, answers or tags ("run the tests"); a request of one
  content word ("status?") is a turn of conversation and is served nothing.
  Words are stemmed conservatively (`rank.js:stem`: plurals, -ing, -ed,
  -ation); the earlier suffix list cut "notes" to the stop word "not". This holds for
  the prompt hook, `orient`, `lookup` and late notes; a note on the current
  file is exempt. When nothing passes, nothing is served.
- A request of one content word is not oriented on at all: `status?`,
  `merged?`, `ok good. pushed?`, `yeah just run it` are turns of a
  conversation, and any note holding the word would cover all of it
  (`ok`, `yeah`, `please` and the like are stop words). `lookup` by one word
  is still answered, and so is a note on the current file. In one week on this
  repository such turns took 20 of 111 servings, and the note holding the
  word *status* became the most served note of the week.
- The prompt hooks serve a note once per session (`orient`'s `once`): what
  was served on an earlier turn is in the agent's context, and serving it
  again on a follow-up adds tokens and a verdict of `unused`. `orient` called
  by the agent is a fresh question and may return it again.
- Holdout: the hooks serve nothing in a share of prompts, so that what the
  notes do can be measured on the machine's own work instead of estimated.
  The unit is the turn, not the session (2026-10-12): a session is as long as
  the user keeps it, so whole sessions compared measured how long the tasks
  happened to be. The prompt hook opens each turn (`ops.js:beginTurn`): a
  counter in the session state, and the decision as a hash of the session id
  and the turn number, kept in the state so the tool and stop hooks of the
  turn agree (`ops.js:holdoutTurn`). `orient` with `holdout` ranks and packs
  as usual, logs what it would have served as `withheld` on the `orient` line
  (which carries `turn`), marks nothing served, and returns nothing; the edit
  hook serves nothing in that turn either, and the intro waits for a served
  turn. The agent's own `orient`, `lookup`, `find` and `drilldown` are not
  held out. Notes served on an earlier turn stay in context, so a held-out
  turn after a served one is partly treated: the difference is understated,
  never inflated. At every stop the hook logs the session's cost so far from
  its transcript with the turn number (`op: "session"`: tool calls, model
  turns, input tokens with cache reads and writes, model; `transcripts.js`
  `stats`, Claude Code, Cursor and Codex); a turn's cost is its line minus
  the turn before's, and a turn with either line missing is unmeasured. A
  correction-shaped prompt logs its `outcome` with the turn it corrects.
  `thinker usage` compares the two sides under "Holdout"
  (`usage.js:holdoutSummary`): cost per prompt as a ratio of sums (summed
  cost over measured prompts: a per-prompt median lands on the one-line
  follow-ups), overall and per model, the share of each side followed by a
  correction, and `saved`, (held-out per prompt − served per prompt) × served
  prompts; prompts with nothing to serve are on neither side, and under
  twenty prompts a side it says so rather than compare. Telemetry sends the
  same comparison over 30 days as sums and prompt counts per side and per
  model (`telemetry.js:holdoutMetrics`, holdout schema 2), which pool into
  averages across installations; the Holdout dashboard reads them
  (`scripts/holdout-dashboard.mjs`). The share is `holdout` in
  `.thinker/config.json` (default 0.15; 0 or false: none), `THINKER_HOLDOUT`
  overrides it (`off`, `0`, or a share; `1` holds out every prompt, for
  tests). Benchmarks pin their arms and should set it off. Once a week the
  stop hook shows the user one line from this comparison over the last 30
  days of the machine's log (`usage.js:weeklyNotice`): the saving in input
  tokens with the two per-prompt costs and counts behind it, nothing under
  the floor; the week last shown is a marker under thinker's home
  (`state/weekly-notice.json`), written only when a line was shown. Not on
  a held-out turn, and off with the other notices (`THINKER_NOTICE=off`).
- The prompt hooks serve no stale note (`orient`'s `freshOnly`). A stale
  note that would have been served is held back, logged as `held` on the
  `orient` line, and left for the next four-hour maintenance batch
  (`maintain.js:maintain`), and served on a later turn once it is fresh
  again; in the meantime it is listed by title, marked STALE, among the
  notes the agent can `lookup`. Over three days on this repository 43 of
  154 hook servings were stale: each took a slot and the tokens of a fresh
  note and put a claim in front of the agent that it had to check or ignore.
  `orient` and `lookup` called by the agent still return stale notes, with
  the ⚠ banner.
- The query: function words are dropped (`rank.js:STOP`), and so is what the
  request tells the agent not to do ("do not run the test suite"), which
  would otherwise bring up the notes on running tests (`rank.js:subject`).
- Phrasings: notes are written in the words of the code, requests in those
  of the product. A note distilled from a session comes with up to five lines
  of how a user would put it (`says`) and its `search` text, written by the
  distiller in the same call and stamped current (`distill.js:withPhrasing`,
  2026-10-21: the separate phrasing call was 1.4M tokens a week here).
  `thinker phrase` and maintenance write them, by a small model from the note
  alone, for a note without them or whose text changed since (a verification's
  rewrite, a note from before); ranking counts them with the title and answers. Notes whose text changed
  since are done again; about 3k tokens a note with Haiku.
- `rerank: "haiku"` in `.thinker/config.json` hands the
  eight best candidates to a small model, which keeps those that bear on the
  request, or none. Its choice is final: no linked note is added to it.
  Through an agent's CLI a call took 8 to 13 seconds and about $0.02, which
  is close to the 15 seconds a prompt hook is given, so it is off by default;
  with `ANTHROPIC_API_KEY` the call goes to the API directly.
- The hooks' notes go through a local cross-encoder before they are served
  (`dense.js:ceRerank`, on by default): `Xenova/ms-marco-MiniLM-L-6-v2` (23 MB,
  ONNX) reads the request, cut to its first 120 tokens, together with each of
  the eight best lexically gated candidates and gives one relevance logit per
  pair; candidates under the floor are dropped and at most `maxNotes` are
  served in its order. When nothing clears the floor, nothing is served. A
  `fallbackFloor` (a score, e.g. −1) serves the single best candidate anyway if it
  reaches it (measured 23 tasks hit against 19 at precision 0.96); it was the
  default until 2026-10-08 and is off since, so that the hooks serve only notes
  the cross-encoder is confident of. Defaults `floor: 0, maxNotes: 1,
  fallbackFloor: null` (`dense.js:CE_DEFAULTS`),
  chosen on 54 tasks labeled by a Codex judge against the merged fixes
  (`research/bench-history/RESULTS.md`, "Ranking: labels"): 94% of served notes useful, 88%
  important, nothing served when nothing fits, a quarter of the tokens; the
  price is reach, 15 of 70 important notes at prompt time against 27, which
  the edit hook recovers in part (it reaches the important notes resting on
  the files the agent opens). `ce` in `.thinker/config.json` adjusts it
  (`{ enabled, floor, maxNotes, k, queryTokens, fallbackFloor }`, or `false`);
  `THINKER_CE=on|off`, `THINKER_CE_FLOOR`, `THINKER_CE_MAX`, `THINKER_CE_K`,
  `THINKER_CE_QUERY_TOKENS`, `THINKER_CE_FALLBACK` (a score, or `off`) override
  the config. The note side is its `search` text, written by
  `phraseNotes` beside the phrasings (3–6 sentences from the note alone:
  rule, constraints, tasks, identifiers; `phraseKey` is versioned so notes
  phrased before are done again); on raw note text the cross-encoder did
  not tell important notes from irrelevant ones, on this text it did. An
  agent's own `orient` (more than two notes) and `lookup` keep the lexical
  ranking. The runtime (`@huggingface/transformers`, ONNX; most of the installed
  dependencies' size) is a dependency; the model (23 MB) is fetched into
  `~/.thinker/models` (`THINKER_MODELS_DIR`) by the installer, `thinker
  update` and `thinker setup`, and by `thinker ranker fetch`; `thinker ranker`
  says whether both are in place. When either is missing the hook logs
  `ce-error` once and serves the lexical ranking.
  The hook goes from 0.7 s to about 1.0 s. `THINKER_DENSE=minilm` (bi-encoder
  embeddings blended into the score) is the measured negative kept beside
  it. Harness arms `hook-bm25` (CE off), `hook-ce1`, `hook-ce2`, `hook-minilm`.
- Local storage: `.thinker/local/notes/` holds learned notes and is ignored by Git.
  Legacy `.thinker/notes/` files remain readable with local overlays, so upgrading
  does not discard existing notes or corrections. `transfer.js` backs up and
  restores effective notes locally. There is no note publishing or client sync.

**Understanding notes on the first sight of a file (off until an experiment, 2026-10-17).** With
`onSight: { enabled: true }` in `.thinker/config.json` (or `THINKER_ON_SIGHT=on`, for an experiment
arm), the tool hook serves understanding notes by file instead of by request (`ops.js:onSightNotes`):
when a repository file first appears in a tool's input or result (opened, edited, a search hit, a
listing; `clients.js:seenFiles`), the notes whose deps point at it are served, at most two per file
ordered by the request's lexical relevance, at most eight per session, once per file, never a note
the session already saw. Logged as a `late` serving with `on: 'sight'`. Why: on PostHog
(research/understanding-variants-2026-10) a task-blind cache's note about a file the fix changed was
served by request text for 1 of 12 tasks, while the bare agent opened such a file before its first
edit in 18 of 42 sessions and had seen its path in a search result 2.5 steps earlier in half of
them; the notes on those files stated the fix's mechanism for 3 of 8 tasks.

**Test economy: the wrapper and the pre-tool nudge (off until an experiment, 2026-10-18).**
A stage-0 diagnostic over 662 sessions and their 910 test runs says where the tokens go. Not
selection: no run was a full suite, one was a directory run, only 2 of 910 were redundant re-runs,
and agents already run one or two test files — an import-graph selector tried on a real two-file
run widened it to 93. The cost is the single catastrophic failing run: 50k–100k tokens, 80–88% of
a session's whole tool output, about 30% of it ANSI colour escapes, and 70 failures that collapse
to some 13 distinct causes. Opus already pipes such runs through `tail`, blind. So:

- `thinker test -- <command>` (`src/commands/testing.js`) runs the command with colour off
  (`NO_COLOR`/`FORCE_COLOR`/`TERM=dumb`/`COLUMNS=200` in the environment, plus `--color=no
  -p no:cacheprovider` for pytest, `--colors=false` for jest, `--no-color` for vitest, `--color
  never` for cargo), streams the log with any remaining escapes stripped to
  `.thinker/state/tests/<stamp>-<runner>.log` (out of git by `store.js:EXCLUDED`, last 20 kept),
  and prints the counts, the failures grouped by cause, the warnings as one number and the log
  path. The exit code is the test command's. A cause is the message with its numbers, hex, uuids
  and temp paths normalised away (`testing.js:causeOf`); each is printed once with its count, a
  few example test names and up to six frames in this repository's files. pytest also gets
  `-q --tb=short -rfE`: `-rfE` keeps the short summary, and the full message is read from the
  traceback, because pytest cuts the summary line to the terminal width and a cut message would
  split one cause into several. An unrecognised runner is passed through and reported by the last
  lines of its log. Parsers: pytest, jest (text and `--json`), vitest, `go test` (text and
  `-json`), cargo, `node --test` (spec and TAP).
- The `pre` hook (PreToolUse, `commands/hooks.js`) answers a shell command that is a test run with
  the same run through the wrapper, once per command per session so the re-issued command cannot
  loop. Claude Code and Codex take `updatedInput`, so the command is rewritten and no permission
  decision is returned (nothing is auto-approved); Cursor's `beforeShellExecution` cannot rewrite,
  so it is denied with the command to run in `agent_message` (`clients.js:preToolOutput`). No other
  client has a pre-tool event thinker can answer on. Logged as `test-nudge`.

Both are off: `tests: { nudge: true }` in `.thinker/config.json` turns the hook on (`tests: true`
means the same), and `tests` also carries `color`, `causes`, `examples`, `traceback`, `tail` and
`keepLogs` (`testing.js:TESTS`). No environment knobs. Deliberately not built: narrowing a run to
the tests that cover the edited files, and the state machine that would allow one full run after a
narrow one passed — the diagnostic says there is nothing there to win.

**Understanding notes as their own pool (off until an experiment, 2026-10-16).** With
`ce.understanding: { enabled: true }` in `.thinker/config.json` (or `THINKER_CE_UNDERSTANDING=on`,
for an experiment arm), the prompt hook ranks notes read from the code (`source.type: understanding`)
apart from the rest (`ops.js:orient`): the other notes are ranked, scored and capped exactly as
without it, and the understanding notes get their own lexical ranking, the cross-encoder's best of
their top eight by the best of three texts, one note, served below the floor of 0 when it scores at
least −4, in 600 tokens of its own (`dense.js:UNDERSTANDING_POOL`). Ranked together, understanding
notes would change which other notes pass the lexical gate, which weighs a word by how many notes
hold it. Why: on long bug-report requests every understanding note scores under 0, the one on target
included; offline on the mlflow harder set the pool served the target on 7 of 8 requests against 5,
and on PR-mined notes the same rule only added noise (`research/serving-understanding-2026-10` on
`agent/understanding-serving-probe`). Its cost: on a request the cache does not cover it serves one
irrelevant note where the shipped rule serves none. It stays off until an Artemis experiment shows it
helps in agent sessions.

## Context view

`thinker context` and the page's Context tab show one report (`context-view.js:contextView`): where the agents'
context goes in a repository, part by part, with what each part costs a session (its tokens × the median model
calls of a session here) and how much the sessions used it. Measurement only; nothing is served or rewritten.

- **Instruction file sections** (`instruction-value.js`): every instruction file (`instructionFiles`): the root
  AGENTS.md (or CLAUDE.md where there is none; Claude Code's sessions are left out where CLAUDE.md has text of its
  own) in every session; an AGENTS.md or CLAUDE.md in a directory below (a CLAUDE.md that is its AGENTS.md counted
  once) in the sessions that opened a file there, Claude Code's only; a `.claude/rules` file with `paths:` in those
  that opened a matching file, one without in every Claude Code session. Each is split as
  `instructions-core.js:sections` does (a file without headings is one section; ids of files other than the root
  carry their path), and a section's cost is averaged over every session, counting only those that read its
  file. A nested file or a rule takes its directory or its paths as its trigger, with no grep of the repository
  (PostHog: 72 files, 454 sections). *Applied*, free on every session: the session touched the section's files, ran the command it is about, or
  read code it names (`instruction-sections.js:deriveTriggers` / `sectionFires`, replayed from the transcript).
  *Relevant* and *Followed*, from a model call per session that reads what the session asked, ran, read and changed
  against the sections and names those relevant to the work, each followed, violated or relevant with nothing to
  show (`judgeSessionFile`, logged as `op: "instruction-value"`). Judging is by hand (`thinker context --judge n`,
  the page's button; sessions written to in the last 20 minutes are skipped) or, with `instructions: { value: {
  judge: true, share } }` in `.thinker/config.json` (`THINKER_INSTRUCTION_JUDGE`), on a share of sessions at their
  end (default 0.25), within the daily token cap and through the session in a desktop app. Off by default: it spends
  tokens. Kept per session in `.thinker/state/instruction-value.json`. Not validated against labels: the judge's
  verdicts are a model's reading of one session, and a large `##` section with many rules is one row.
- **Skills**: listed and read per session (harness.js), and from the sampled outcome check (skill-outcome.js, whose
  log line now records which checked skills the session read) the share of reading sessions that kept the skill's
  rules, and misses (broken without being read).
- **Other tools**: MCP servers, plugins, built-in tools, as `thinker harness` reads them.

The tab (Context Overview) shows the input tokens by day or week as stacked columns (instruction files, custom
tools, built-in tools, tool outputs; `tool-outputs.js` estimates the outputs: each result's tokens × the model calls
left after it), then one part at a time as cards: each section, skill or tool beside its cost, use and a waste level
(`instruction-value.js:wasteLevel`: high or medium for a part relevant to under half the sessions whose cost there is
5% or 2% of its kind's; the saving shown is that cost, at most). "All repositories" merges every repository's report
(`context-view.js:mergeViews`).

Sections are changed by the person, in the team's files, as a local diff (a rule or headingless file whose one
section is removed is deleted): picked sections are removed, or compressed
by a model asked for a third of the length (`instruction-edit.js`, `thinker instructions --remove|--compress <ids>
[--apply]`, the tab's Compress and Remove). The diff is shown first; Apply writes exactly that text to the working
tree, uncommitted, and refuses when the file changed since the preview. No commit, no pull request.

Other controls are the commands: keeping sections writes the checkout's trimmed copy (`thinker instructions --core`,
never the team's file); a skill or tool is switched off by `thinker harness --off <label>`, which since this view
takes any source a setting switches off, not only the advice's (`harness.js:switchable`; `any`), and only where
the harness is on.

**The context diet (off until an experiment, 2026-10-18).** With `diet: { enabled: true }` in
`.thinker/config.json` (or `THINKER_DIET=on`, for an experiment arm), the tool hook replaces a tool's result
before the model reads it, through Claude Code's PostToolUse `updatedToolOutput` (`diet.js:dietResult`,
`clients.js:toolOutput`; Claude Code only, checked against the tool's own output shape, so a Bash result keeps
`{stdout, stderr, interrupted}` and a Read result its `file` object). Three results are trimmed: a whole file read
through `cat`, `nl`, `sed -n '1,$p'` or Read becomes the lines around the session's recent search patterns and the
request's identifiers (kept per session by the hooks, `diet.js:rememberTerms`), each omitted range named with the
definitions it holds and a last line saying how to read a range; a test run becomes the counts and each distinct
failure cause once, the whole log kept under `.thinker/state/tests/` (`testing.js`, as `thinker test` prints it); a
search output over `searchChars` becomes its hits grouped per file. A file under `minLines`, one with no hit, or one
whose kept lines reach `cap` of it passes whole, logged as `diet-skip` with the reason; a trim is logged as `diet`
with the sizes. Claude Code numbers a Read result itself from the file's first line, so a trimmed Read keeps every
line in place (a marker then empty lines for an omitted range); a numbered text came out numbered twice and a plain
string was refused (2026-10-18 smoke sessions). Why: on a 60-call Opus session re-reading the accumulated context was
over half the bill and the fixed prefix a tenth, and nothing thinker serves ever leaves the context; replaying 442
bare sessions (research notes, 2026-10-18) the hit-centred region held the agent's next edit 20 of 23 times and every
gold hunk 149 of 166, but a third of whole-file reads had no term to centre on and most of the rest needed over half
the file, so the whole diet is worth about 15–20% of tool output, roughly a tenth of a session. The experiment has to
show the agent does not read again what was trimmed.

## Internal server

`src/server/` and `infra/sync/` remain internal infrastructure: the team's note
store, excluded from public release archives. It posted pull request reviews
until 2026-10-11 (`action/review/`, removed with `thinker review`). Client
sharing, sync, and staged-note repair were removed; old client sync settings do
nothing. Do not reintroduce team collaboration as part of the product. Personal
backup/restore remain supported.

## Skills

A skill file (SKILL.md under `.claude/skills`, `.agents/skills`, `.codex/skills`, `.cursor/skills`,
`.github/skills`, `skills/`) gets a note of kind `skill` (`skills.js:scanSkills`, one model call per
file, by a build, by `thinker skills scan`, and by maintenance where `maintain: { skills: true }` is set;
off there by default since 2026-10-21): a card that is served like a note and tells the agent to
invoke the skill, with the file and the code the skill names as deps. Staleness is `ops.js:refresh`
as for any note; the verification is `skills.js:auditSkill` (through `ops.js:verifyNote`), which
reads the skill file against the current code and answers holds or broken with the issues. A
broken skill has status `broken` (a LOCAL_FIELDS entry): not ranked (`rank.js`), not listed by
`lookup` by kind, left alone by `refresh` and `pickStale`, until its file changes (the scan rewrites
the card and clears it) or a person reviews it (`skills.js:reviewSkill`; `thinker skills review`,
the button in the UI). A card whose own file changed is left to the scan, not audited
(`maintain.js:pickStale`). Sessions grade skills: `transcripts.js` keeps the skill directory on the
Skill tool call, `skills.js:skillsInvoked` and `skillNotesFor` add the invoked skills to the notes a
distillation assesses (always assessed, `learning-evidence.js`), a contradiction is accepted at once
(`learning-pending.js`) and marks the skill broken (`ops.js:attest`), and a session older than the
skill's present text is not counted (`skillFileTime`). Duplicates: `skills.js:dedupeSkills`, with
`skills.prefer` in the config as the pin. Skill cards are never distilled (`distillSpec`,
`distillKinds`, `saveNotes`) or written through `remember`. See docs/skills.md.

**Skills suggested by the file (off until an experiment, 2026-10-19).** With `harness: { skillSuggest: true }`
in `.thinker/config.json` (or `THINKER_HARNESS_SKILL_SUGGEST=on`; `=off` wins over the config), the tool
hook of Claude Code and Codex says, the first time a file is opened or edited in a turn, which skills
past sessions here read for files like it: `<thinker-skill>Past sessions here used <name> for files like
this one: read <path></thinker-skill>`, at most two a file and six a turn, each skill once a turn
(`skill-suggest.js:skillSuggestLines`). The turn, not the session: a session can run for hours over
several requests, and an earlier turn's skill may be needed again or compacted out of the context, so a
new turn or a compaction in the transcript (`compactions`) starts the count again (2026-10-19). Why: on PostHog under GPT-6 Astra, switching the 107 skills off
cut input ~19% at equal passes, but agents then opened 0.6 skills a session against 2.9 and broke more
minor conventions (0.46 against 0.21 a session); `lookup` over the descriptions was right 42% of the time.
The evidence (`.thinker/state/skill-evidence.json`, local) is rows by (area, skill), an area being a key of
the path (`areaKeys`: two directories, the top one, `products/<p>/<layer>`, the kind of file), with organic
opens, suggested, suggested-then-opened, unread, missed and negative per row and exposures per area, each
decaying with `harness.skillSuggestHalfLifeDays` (30). The session's opens and edits are credited once,
idempotently, from the transcript the harness parses (`harness.js:sessionHarness`,
`harness-codex.js:codexSessionHarness`; `recordSessionSkills` from `commands/learn.js:distillFile`), so
`learn.sessions`, `THINKER_NO_LEARN` and the quiet skip apply as to the distillation. Scoring
(`candidates`) counts a (area, skill) only on the sessions where the skill was not read (not opened; a
suggestion the agent did not follow leaves the session unread): Beta(0.5 + misses + organic opens,
4 + (unread − misses) + negatives), the best of the file's areas, Thompson-sampled, top two above a
sample of 0.35. A session that read the skill says nothing about whether it prevents a break; counting
those as failures, as the first version did, held a skill that prevents most breaks at a 0.4 suggestion
rate the more it was followed (a simulation of the loop, 2026-10-19). A row made late counts the area's
earlier sessions as unread unless the skill was `added` to the registry since (`refreshRegistry`), so a skill
opened once in a busy area does not score as if that were its only session. Organic opens are weak evidence
of relevance (weight `organic`, 1); a skill whose description shares a word of the path gets a small prior
(0.25) only when the file's areas have no evidence-backed candidate at all: in a replay of 8 PostHog eval
tasks none of its 24 picks was a skill the agent went on to open. Misses come from a separate, sampled
outcome check (`skill-outcome.js:skillOutcomeCheck`, its own switch `harness: { skillOutcome: true }` or
`THINKER_HARNESS_SKILL_OUTCOME=on`, off by default, never in test mode unless forced by the env), modelled
on the Artemis conventions grader: once a session, on `harness.skillOutcomeShare` (0.25) of sessions by a hash
of the id, when the session edited files with candidates, within the daily token cap, one model call through
`llm.js:complete` (the session queue in a desktop app). It is shown the `git diff` of the files the session
edited from the commit before its start (plus files it created), the full text of the best three candidates
and of up to two skills a matching `.claude/rules` file names, those rule files, and the AGENTS.md text
that applies (process sections left out), and returns violations quoting the rule and its source; a skill's
break unread is a miss, read a negative, logged as `op: "skill-outcome"`. Asking the end-of-session
distillation for broken rules instead (the first version) matched the grader on 0 of 30 graded sessions. On 39
graded PostHog sessions (Sonnet, claude CLI, $0.14 a session) the first prompt found 7 of the grader's 15
skill-sourced violations by rule, and 3 of 15 clean sessions got a skill violation; the prompt shipped found 13
of 15 on the 13 sessions with one (16 found, 3 on a rule the grader did not cite); its rate on clean sessions
was not measured again. A held-out turn (`ops.js:holdoutTurn`) is told nothing and logs `withheld`; the cap of
six lines a session counts withheld lines too. First use seeds the store from the machine's recent sessions of
the repository; `thinker skills seed <transcripts...>` seeds from chosen ones (an eval: its training tasks only),
`thinker skills suggest <file>` previews. The offline checks are in
`bench/worktrees/eval-support/skill-protocol/` (local). No agent session has been run with it.

**Built-in tools in the harness question (off until an experiment, 2026-10-20).** With `harness: { builtinTools: true }`
in `.thinker/config.json` (or `THINKER_HARNESS_BUILTIN_TOOLS=on`; `=off` wins over the config), the harness counts
Claude Code's own tools as sources beside plugins, skills and MCP servers: their definitions from the transcript's
`prompt_snapshot` attachment, a call by name as a use (`harness.js:sessionHarness`, `builtinKey`). One called in under
a tenth of the sessions is offered like any source and goes off as a bare name in `permissions.deny` of
`.claude/settings.local.json`; `--undo` takes it out. Checked with `claude -p` 2.1.304 (2026-10-20): `permissions.deny`
and `--disallowedTools` both take the definition out of the prompt, Workflow, ScheduleWakeup and ReportFindings
together ~4k tokens a call. Never offered (`CORE_TOOLS`): the file and shell tools, Skill, AskUserQuestion (the question goes through it), and
ToolSearch, whose absence puts every deferred definition inline (+29k tokens a call); an allow-list (`--tools`) does the same, so the switch
is a deny list. Why: on this machine's sessions (Artemis Tokens page, waste view) Artifact (15k tokens) was called in
1 of 65 sessions that carried it, Workflow in 0 of 535. Not known: whether the desktop app's own tools (Artifact,
SendFeedback, absent from `-p`) obey the deny list.

## Desired behaviors

Every other kind of note is a claim about the code, and when code and note
disagree the note yields: verification rewrites or retires it. A `behavior` note (`behavior.js`) is the other way round: a
person writes down what the system must do and where that is upheld, and from
then on a change must conform, or be called out for not conforming. The
rule since 2026-10-04: **before a merge the behavior is the truth, after it
the code is.** A pull request that stops upholding a behavior is told so, in
full and first (a fixed behavior loudly, see Review below); once the change is
merged on the default branch the behavior is revised to match the code, with
the old text in its history. Behaviors are never evaluated against a gold set;
the review's callout and the person's decision to merge are the check. `thinker system` is the view of them; the MCP
`lookup` with `kind: "behavior"` returns them to an agent (all of them with no
query); `thinker system md` writes them as `.thinker/SYSTEM.md` for people who
read the repository without the tool. Legacy committed behaviors remain
readable; new behaviors stay local.

- **Fields.** A behavior is an ordinary note (title, body with `file:Symbol`
  pointers, answers, deps) plus `mutability`: `fixed` (a review treats a
  change that stops upholding it as an error and requests changes, with the
  behavior quoted in full) or `mutable` (the default; a warning, and a pull
  request may revise it by editing the note itself). Both follow the code
  once a change is merged. `mutability` and `revised` ({at, commit, reason},
  set when the merged code rewrote it) are shared content; `violated` is this
  checkout's state (`store.js:LOCAL_FIELDS`).
- **Who writes one.** A person: `thinker system add file.json [--fixed]`, or
  `thinker system promote <id> [--fixed]` for a note that already states a
  rule (`thinker system propose` lists the rule notes, the ones the sessions
  acted on first). An agent may save one with
  `remember` (kind `behavior`); it is listed as *proposed* until `thinker
  system accept <id>`. Distillation and PR mining are not offered the kind
  (`distill.js:distillSpec`, `prs.js`), archiving never takes one
  (`ops.js:archiveReason`).
- **Build proposals.** `thinker setup --build` drafts up to twelve
  high-signal PR/document rule notes into desired behavior
  candidates in `.thinker/local/behavior-proposals.json`. The model sees each
  note's source and current symbol code; outputs are restricted to the note's
  existing symbol deps. `thinker system propose` shows drafts and their
  provenance; `thinker system accept proposal-<note-id>` creates an active
  behavior only after a person reviews it. The draft is not served or reviewed
  as a requirement. Acceptance refuses a changed source note or code. The
  stage runs on every cache build; it returns no drafts if no suitable source
  notes exist.
- **Verification** (`ops.js:verifyBehavior`, through `verifyNote`): when a dep
  changes the question is whether the code still upholds the behavior.
  `holds` re-baselines; `moved` re-points the deps at where the behavior is
  upheld now (history kept). `broken` depends on where the code is
  (`ops.js:onDefaultBranch`: the deps' files committed, and `HEAD` reached by
  origin's default branch, or a local `main`/`master` without a remote). Not
  merged (a working tree, a branch, unpushed commits): `status: violated`
  with the commit and the reason, deps re-hashed so the note reads as
  violated rather than stale until the code changes again, text untouched,
  named at the end of the next turn (`ops.js:noteUnreported`,
  `maintain.js:maintenanceNotice`) and served with a `⚠ VIOLATED` banner.
  Merged: the model is asked for the behavior as the code upholds it now, the
  body is replaced (pointers of the new text join the deps), `revised` records
  the commit and reason, the old body goes to `history`, the verdict is
  `revised`, the notice says so and `.thinker/SYSTEM.md` is rewritten. A
  behavior is never retired by verification, and never rewritten for code
  that is not merged. On the server the clone sits at the default branch, so
  the behaviors there follow every merge and sync out.
- **Review** (`review.js:assessBehavior`, and the holistic prompt): the
  verdicts are `violation`, `consistent`, `unrelated` and `revised`; `revised`
  only for a mutable behavior whose note file the change edits
  (`review.js:noteFileChanged`, in the scope under review), otherwise it is a
  violation. A violation without a placed finding gets one at the first
  definition the change touched. A finding on a fixed behavior is an error,
  on a mutable one at least a warning, so `--strict` exits 2 in CI. The
  posted pull request review (`review-post.js:buildReview`) opens with a
  violated fixed behavior before anything else: its title, its full text
  under "What it requires", what the change does instead (the model's
  reason), and what merging means (the code becomes the truth and the
  behavior is revised to match; restore the enforcement if that is not
  meant). A violated mutable behavior gets the same block under a quieter
  heading. `renderReview` says the same in one line for the CLI. The
  holistic call may not list a behavior under `outdated`: one it does is turned
  into a finding. The report carries `behaviors`, one line per behavior in
  play (`upheld`, `violated`, `revised`, `unrelated`, or `consulted` on a dry
  run) with whether it was already violated before the change, rendered under
  "Desired behaviors" and in `--json`.
- **This repository's own** (`thinker system`, `.thinker/SYSTEM.md`), written
  2026-10-03: a review never writes to the cache; verification never rewrites
  or retires a behavior; serving and assessment never rewrite a shared note's
  committed file; `THINKER_TELEMETRY=off` and test runs send no telemetry (all
  fixed); the prompt hooks serve no stale note (mutable).
- **Serving.** A behavior is served like an invariant: at orientation with a
  small kind prior, by the edit hook when a file it rests on is edited
  (`ops.js:lateNotes`, first among the rules), and in `thinker review`'s
  consulted set with the highest kind weight.

## Review was removed (2026-10-11)

`thinker review` (a single model call over the diff, the code it touched and the
notes resting on it; later with `usedContext`, the code the change uses) was
removed, with task verification (`--run`), the pull request action, the server's
review worker and the pre-commit option. On held-out bugs, fixes withheld from
the cache, it caught no more with notes than without (mitmproxy 10-11 of 15 either
way, PostHog 5 of 8), and the user's own coding agent reviewing the same change
caught 14 of 15 with or without thinker alongside. Its one distinctive number,
recall of fixes already in the cache, is not a claim this project makes. The
measurements are in `research/regression-heldout` on the `agent/heldout-regression`
branch. What survives: `src/change.js` (the model-free change helpers) for the
diff-keyed serving of notes to a reviewing agent, and two findings for a review
built around the agent: showing the code the change uses lifted the single call
from 7 to 11 of 15, and an input-class checklist to 12 of 15.

## Supported agents

| agent | notes for the request | notes about files being edited (installed by default; `--no-late` leaves it out) | MCP tools | written to (user scope) |
|---|---|---|---|---|
| Claude Code, and the Code tab of the Claude desktop app | added to each prompt | yes | yes | `~/.claude/settings.json`, `~/.claude.json` |
| Codex CLI and the Codex desktop app | added to each prompt | yes | yes | `~/.codex/hooks.json`, `~/.codex/config.toml` |
| Gemini CLI | added to each prompt | yes | yes | `~/.gemini/settings.json` |
| Cursor | added to each prompt (`additional_context`), with first-tool fallback for `agent -p` and the `orient` tool | yes | yes (approved by setup) | `~/.cursor/hooks.json`, `~/.cursor/mcp.json`, and `.cursor/rules/thinker.mdc` in the checkout |
| Pi, Windsurf, Copilot CLI (and Copilot in VS Code), OpenCode, Factory Droid, Qwen Code, Kiro CLI, Cline, Kilo Code, Auggie, Goose | see `docs/agent-integrations.md` (Auggie has no prompt hook, Kiro's V3 engine alone reads global hooks, Goose's hooks only record) | | | each agent's own files, machine-wide |

- The desktop apps run the same engines as the CLIs and read the same user
  settings. The Claude desktop app's Code tab reads hooks and MCP servers from
  the user's and the project's files alike; the Codex desktop app reads MCP
  servers from the user's `config.toml` only (openai/codex#13025, open since
  2026-02), which is why the wiring is machine-wide. Whether it starts the MCP
  server in the thread's directory is not verified: if not, the server asks
  for MCP roots, and failing that offers nothing there.
- One copy of thinker per checkout (`clients.js:pruneInstalls`). A hook names
  the copy it runs (`node "<install>/src/cli.js" hook …`), and so does an MCP
  entry; two copies wired into one checkout (an install left behind, a smoke-test
  copy, hooks in both of Claude Code's settings files) both fire on every prompt,
  serve the notes twice and bring the old copy's notice and state format back.
  `setup` takes every other copy's hooks out of the files of the client
  they install and point its MCP entry at the new copy; for Claude Code the hooks
  live in one settings file, so installing `--local` empties the shared one and
  the other way round. The prompt hook does the same on every prompt for copies
  that are gone or older by their `package.json` than the one running
  (`olderOnly`): a copy of the same version is left, or two copies would take
  each other out, and a newer copy is left to do the cleaning. What was removed
  is logged (`op: "prune"`) and said once at the end of the turn through the
  maintenance notice. Only the entries go; the old copy's files are not deleted.
- The wiring follows the installed version (`clients.js:refreshWiring`). The
  hook and MCP entries are written in the shape the version that ran `setup`
  knew; a later version that adds an event (`SessionEnd` for the final distill
  of a session) or changes a command rewrites them from what is there:
  `inferWiring` reads from each client's files whether hooks, late notes,
  learning and the MCP entry were installed and which Claude settings file
  holds them, and `installClient` is run again with those options. Only
  entries that run this copy (by the script's install root) are rewritten;
  entries of another copy, alive (a development checkout) or gone (a deleted
  worktree: the benchmark checkouts pointed at one, and rewriting them would
  have given them live hooks), and hand-tuned commands (an env prefix, a
  `--budget`: a benchmark arm's) are left alone and named. Checkouts under the
  temp directory are not visited. Git hooks of this copy are rewritten the same way.
  `thinker update` runs `thinker rewire` from the new copy after an update, for
  every checkout the machine's log names that is still set up; the prompt hook
  runs it for its own checkout on every prompt (`mergeJson` and
  `installGitHooks` leave an unchanged file untouched, so a client watching its
  settings file sees nothing); `thinker rewire [--here] [--dry]` is the command
  by hand. Before 2026-10-04 nothing did this, and this repository ran without
  `SessionEnd` and `PostToolUse` hooks for weeks after both were added.
- Cursor's `beforeSubmitPrompt` hook returns `{"continue": true, "additional_context": "..."}`
  at prompt time (since 2026-10-15); in headless modes (`agent -p`) where `beforeSubmitPrompt`
  does not fire, `postToolUse` orients from the transcript on the first tool call. An
  always-applied rule also tells the agent to call `orient`.
- Codex reads a project's `.codex/` only once the project is trusted, runs a
  hook only once it is reviewed, and asks before each MCP tool call. `setup`
  takes care of all three: the MCP server is registered with
  `default_tools_approval_mode = "approve"`, and the project and thinker's
  hooks are marked as trusted in Codex's own `config.toml` (`CODEX_HOME`,
  `~/.codex`). In a terminal they ask first; `--yes` skips the question,
  `--no-trust` leaves it to you, and without a terminal nothing is marked
  unless `--yes` is given. The hook entry is the hash Codex 0.157 stores
  (see [What Codex stores as trust](#what-codex-stores-as-trust)); if a later
  Codex changes it, Codex asks for the review as before. `uninstall` takes the hook entries out again.
- Cursor loads an MCP server only once it is approved; `setup` does that
  through Cursor's CLI when it is installed.
- Gemini CLI also drives agent mode in Gemini Code Assist, which reads the
  same MCP configuration. Google AI Studio is a web app and cannot run local
  hooks or MCP servers, so it is not supported.

### What Codex stores as trust

Codex has no command for this and does not document the format. What follows
was read from the `config.toml` that Codex 0.157 writes after a review in its
own interface, and checked by running `codex exec` 0.157.1 on entries that
thinker wrote. All of it is in Codex's own config (`$CODEX_HOME/config.toml`,
by default `~/.codex/config.toml`), never in the repository.

A trusted project is a table named by the real path of the repository:

```toml
[projects."/Users/me/src/repo"]
trust_level = "trusted"
```

A reviewed hook is a table per handler:

```toml
[hooks.state."/Users/me/src/repo/.codex/hooks.json:user_prompt_submit:0:0"]
trusted_hash = "sha256:6118…1471"
```

- The key is `<real path of hooks.json>:<event>:<group>:<handler>`: the event
  in snake case (`UserPromptSubmit` is `user_prompt_submit`), then the index
  of the group in the event's list and of the handler in the group's `hooks`,
  both from 0. A hook that moves in the file needs a new entry.
- The hash is SHA-256, in hex, of this JSON with no whitespace, keys in
  alphabetical order, and `async` written out as `false` when the hook does
  not set it:

  ```json
  {"event_name":"user_prompt_submit","hooks":[{"async":false,"command":"…","timeout":15,"type":"command"}]}
  ```

  So any change to the command or the timeout makes the entry void, and
  Codex asks for a review again; `setup` writes new entries when it is rerun.
- Checked: handlers of type `command` with a `timeout` and no `matcher`,
  which is what thinker writes, for `UserPromptSubmit`, `PostToolUse` and
  `Stop`. Not known: how a `matcher`, a `statusMessage` or a missing
  `timeout` enter the hash. `trustCodex` leaves a group with a `matcher`
  alone, and hooks that are not thinker's are never marked.
- `codex --dangerously-bypass-hook-trust` runs hooks without these entries
  for one invocation; thinker does not use it.

The code is `clients.js:codexHookHash` and `clients.js:trustCodex`; a hash
that Codex stored is held in `test/clients.test.js`.

### Learning from any agent

Learning works with all four agents, and with others through the generic
path below. Nothing in it is tied to one vendor:

- **Sessions.** `thinker distill` reads Claude Code, Codex, Cursor and Gemini
  CLI transcripts (and the streamed output of their headless modes) and maps
  them to one event form: prompt, tool call with result, agent message. Tool
  names are mapped to one vocabulary, so `read_file`, `Read` and a shell `cat`
  are all seen as reading.
- **When.** Once per session, not per turn: each call carries the prompt,
  schema and related notes whatever the size of the trace, and on 2026-10-03
  one session was distilled 13 times. At the end of a turn (`Stop`,
  `AfterAgent`, `stop`) the hook distills only a backlog near the trace limit
  (`distill --batch`, `distill.js:batchDue`, 45,000 condensed chars); the end
  of the session (Claude Code's `SessionEnd`, Cursor's `sessionEnd`) distills
  the rest. Catch-up covers agents that fire no end: `thinker learn` finds
  every session any of these agents ran in the repository and distills what
  is new in those quiet for 20 minutes (`cli.js:LEARN_IDLE_MIN`). Hooks start
  it in the background at most every ten minutes.
- **What the agent's record leaves out.** Where an agent gives no transcript,
  the hooks record the session themselves (`.thinker/state/trace-*.jsonl`).
  Cursor records tool calls without their output; reads and searches are
  repeated against the working tree when distilling.
- **Model.** Distilling, verifying and PR mining run through whichever agent is installed, with the login it already
  has: `claude -p`, `codex exec`, `agent -p` (Cursor) or `gemini -p`. A
  session is distilled by the agent that ran it when possible. `THINKER_LLM`
  picks one (`claude`, `codex`, `cursor`, `gemini`, `anthropic`, `openai`);
  `THINKER_LLM_MODEL` names a model for the non-Claude ones;
  `THINKER_LLM_BASE_URL` is any OpenAI-compatible `/chat/completions`
  endpoint (token from the variable `THINKER_LLM_API_KEY_ENV` names), used
  before the agents; `THINKER_LLM_CMD` is any command that reads a prompt on
  stdin and prints the answer, told the tier, model and schema in
  `THINKER_TIER`, `THINKER_MODEL` and `THINKER_SCHEMA` (docs/usage.md).
- **Any other agent.** Pipe events to `thinker record <session>` as JSON lines
  (`{"t":"prompt","text":…}`, `{"t":"tool","name":…,"input":…,"result":…}`,
  `{"t":"say","text":…}`), then run `thinker learn`. Agents that speak MCP can
  also save notes with the `remember` tool.

### What was run live, on 2026-09-27

| | Claude Code | Codex CLI 0.157 | Cursor agent CLI | Gemini CLI |
|---|---|---|---|---|
| notes served in a session | yes | yes | yes | not installed here |
| session turned into notes | yes | yes (hooks, trace and distilling through Codex ran; the short test session produced no notes) | yes (4 notes from 2 sessions, distilled through Cursor) | not installed here |

Gemini support follows its documentation and is covered by unit tests on
constructed input only. Seen in the live runs:

- Codex did not run hooks from a project's `.codex/hooks.json` in
  `codex exec` with only the project marked trusted, but ran the same hooks
  from the user-level `hooks.json`. With the hooks marked as reviewed too
  (what `setup` now writes), `codex exec` 0.157.1 loaded the
  project's MCP server, called `orient` without asking and ran the project's
  hooks.
- Cursor's CLI (`agent -p`) fires `sessionStart`, `postToolUse`,
  `afterShellExecution` and `sessionEnd`, but not `beforeSubmitPrompt` or
  `stop`, and `postToolUse` carries a summary of the tool's output, not the
  output. So thinker installs both the editor's and the CLI's events, takes
  shell output from `afterShellExecution`, re-reads files when distilling,
  and `setup` approves the MCP server (`agent mcp enable thinker`) so the
  agent can call `orient` at the start and `remember` at the end. In the
  test session it did both unprompted.

## Jev, tried and removed

TypeSafe's Jev (System One: calibrated probabilities for typed questions, no
generated text) was wired into thinker between 2026-10-06 and 2026-10-08 and
taken out entirely on 2026-10-09, at the user's decision. It had ranked the
servings (a hosted proxy on AWS, a personal-key path, `thinker ranker --jev-key`),
narrowed the related notes and gated the optional steps of a review, typed the
drift surface of every note for derived verify verdicts, chosen the passages a
distillation saw, and gated what learning wrote: a catalog scan, a relation
judgment against existing notes, grounding of every claim against the source,
and a fidelity check of each search description, with a deferral queue under
`.thinker/state/learning-pending/` for what the gates held back. The
measurements are in `research/bench-history/RESULTS.md` ("Serving: Jev", "Derived verify
verdicts", "Jev capture selection", "Current Jev versus historical cached
runs") and under `research/jev-*`. What they showed: a strong offline serving
result (2.5x the important notes reached at the same precision on 54 labelled
tasks) that did not pay in live paired runs (costlier in 8 of 8 Click pairs); a
smaller review prompt with the same catches and, with verification, 86% more
tokens; archive triage and every intrinsic note facet at AUC ~0.50; capture
selection that kept 0 of 13 reference facts at three times the tokens; learning
gates whose thresholds discarded most proposals until retuned, with no paired
measurement of the gated cache against a plain one. Only the external-tool
re-baseline in verification was sound, and it covered 5% of stale notes.

What stands in its place is what was there before: the hooks rank with the
cross-encoder and the agent's `orient` and `lookup` by words; learning saves what
the distiller proposes through `saveNotes` (lexical near-duplicate merging, named
`extends` targets honoured), the distiller shown the notes resting on the files a
session or pull request touched; `phraseNotes` keeps the description the writer
returns; every stale note goes to the verify model. The deferral queue is still
written for assessments of notes a session was shown but did not discuss
(`learning-pending.js`). One daily token cap (`dailyTokens`) covers learning and
maintenance. Git holds the removed code at `0cb765c`. Do not bring Jev back
without a live paired measurement on held-out tasks; the offline labels were not
predictive of session cost.
