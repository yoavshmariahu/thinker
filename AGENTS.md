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

**CLI and local page in sync (MANDATORY):**
- `src/ui/` is a second door to the same commands, never a second implementation.
- Page defaults must use the constants the command reads: `DEFAULT_DISTILL_MODEL` (`src/llm.js`), `buildAgent` (`src/setup/agents.js`).
- Page reports must match command output: `thinker context` and Save tab; `thinker context --machine` and All repositories; `thinker report` and Report tab.
- Page actions run the CLI with the flags a person would type.
- Any new default or flag: add a line to `test/cli-ui-sync.test.js`.

**Pull requests (MANDATORY):**
- Thinker contributor workflow only. Setup must not install a repo policy guard or require PRs in user repos.
- Push task branches, open a GitHub PR to `main`. Never push `main`, including fast-forward.
- Never bypass the pre-push guard or disable hooks to push `main`.
- `tests` workflow is disabled; don't wait for it. Run `npm test` locally, state the result in the PR, merge via GitHub, then update local `main` from the merged remote.
- Until GitHub enforcement is enabled (needs Pro; API 403), the local guard and this policy are the enforcement.

**A fresh worktree needs its dependencies before the suite means anything:**
- A worktree has no `node_modules` of its own. The first `npm test` there can race whatever puts them in place and fail about 9 spawn-based tests with `ERR_MODULE_NOT_FOUND` on a real dependency (`smol-toml`, imported by `proxy-codex.js`), then pass on every later run. Seen twice on 2026-10-28, in two worktrees, with `node_modules/.package-lock.json` written in the middle of the failing run.
- Run `npm ci` in a new worktree before the suite, and treat a first run with those failures as nothing. What installed them is not confirmed; if it turns out to be a prompt hook, that breaks the rule that hooks do no installs or side work (2026-10-22), and is worth chasing.

**Test selection:**
- `npm test` runs test files reached by the change vs `origin/main` (commits since merge base, working tree, untracked).
- Changed code no test reaches is named on stderr.
- Full suite runs when `package.json`, lockfile, `scripts/test.sh` or `scripts/select-tests.mjs` changes (version-only bump excluded), when nothing changed, or with `npm test -- --all`.
- `npm test -- test/rank.test.js`: run named files as given.
- `TEST_BASE=HEAD npm test`: select against working tree only.
- `scripts/select-tests.mjs --why`: show which file selected each test.
- Use `--all` for test-runner changes or wrong selection.
- Requires Node 20+. `npm test` runs `scripts/test.sh` (`node --test`, `THINKER_TEST=1`).

**Desktop apps (MANDATORY):**
- Every model-backed feature must work in Claude Desktop, Codex app, Cursor, and anywhere no agent CLI is signed in.
- Those sessions have no CLI login: model calls queue in `.thinker/state`; a background subagent answers via `learn_next` (`session-work.js`, `session-llm.js`).
- "Sign in a CLI" alone does not finish a feature.
- Tests cover the desktop path (`appFn`, missing CLI login) beside the CLI path.

**Cache and serving changes need an experiment (MANDATORY):**
- Changes to cache sources (source, code or history selection, note kind) or note serving (ranking, cross-encoder, floors, slots, budgets, serving pool) ship off by default behind a config switch.
- Enable by default only after an Artemis experiment: plan, owner approval, run. Compare with shipped strategy on same tasks. Report numbers and caveats.
- Offline replays are not evidence. Measure outcomes in agent sessions.
- Default-on switch = its own PR citing the experiment.
- Off behind switches, awaiting an experiment (2026-10-28, `ops.js:servingConfig`, `serving` in `.thinker/config.json`): `denseFallback` (`THINKER_SERVE_DENSE_FALLBACK`) scores the notes with the local embedding model when no note shares a word with the request, serving the best above `denseFloor` (0.35, `pack`'s own `minRel`); `ceRescue` (`THINKER_SERVE_CE_RESCUE`) serves the best candidate the cross-encoder vetoed rather than nothing; `serveStale` (`THINKER_SERVE_STALE`) serves a stale match with its ⚠ banner instead of holding it back, which revises the mutable behavior "the prompt hooks serve no stale note". Environment wins over config. Each answers one measured miss reason; none is on until an Artemis experiment measures it in agent sessions.
- Owner-approved exception (2026-10-25): Codex proxy tool-output clearing is on by default via install/connect/setup/update. `proxy-codex.js` wires a managed provider without reading credentials. `/codex` routes ChatGPT-account requests to the ChatGPT backend, API-key requests to OpenAI. Custom providers stay as configured. `thinker proxy off` restores prior selection. Savings claims still need an Artemis experiment.

**The proxy never takes over someone else's route (MANDATORY, 2026-10-28):**
- Many people run Claude Code against a model server of their own (smart routing to models) through `ANTHROPIC_BASE_URL` and a token minted for it. The proxy forwards to `api.anthropic.com`, so writing its URL into such a harness sends that token to Anthropic and every model call fails ("invalid bearer token"). That happened; it must not happen again.
- Before writing, every place Claude Code can take a route from is read (`proxy-route.js:routeEvidence`): the settings' `env` block, the process environment, `~/.claude/settings.local.json`, the enterprise policy file, a project's `.claude/settings*.json`, and the shell startup files (a line naming a route variable counts, wrapper or alias included). Any route that is not thinker's own leaves Claude Code exactly as it is, with the reason named. The settings `env` block is applied over the shell's variables, so the shell case is the one that breaks; and once thinker has written its URL, a hook's own environment can no longer see the person's.
- Taking the URL out by hand is an answer (`proxy-service.js:removedByHand`): the next prompt hook stands the service down instead of writing it back, which `thinker update`'s rewire used to do the next day.
- A route that turns up after the wiring stands the service down at the next prompt, before a call fails (`routeAppeared`). A service enabled before the record existed takes what the settings hold now as its baseline, and an absence nothing explains as a removal (`trackClaude`).
- A stand-down (`standDown`) takes the URL out of every agent's file, removes the service entry, and keeps the reason. `thinker proxy on` is the only thing that turns it back on: an install, `connect` and a rewire leave it off.
- The proxy stands itself down when a request carries credentials that cannot be Anthropic's, or when the API refuses them `AUTH_REFUSALS` times running (`proxy.js:authWatch`), judged only where it forwards to `api.anthropic.com`. It forwards the request as it is either way; the API's own answer reaches the agent.
- The proxy is break-even at list prices, so when in doubt it steps aside. Never trade a person's working harness for it.
- **It can sit in front of a route of the person's own, only when they ask** (2026-10-28, the owner's call): `thinker proxy on --gateway` (and a yes to the question in `proxy-offer.js`) finds the model server this machine routes Claude Code through (`proxy-route.js:ownGateway`) and forwards there instead of `api.anthropic.com` (`proxyThrough`, kept in the service's own state; `proxy: { upstream }` in the machine config still wins). Without that, the proxy never puts itself in front of a gateway. A route it forwards to is not a blocker (`isOwnRoute`): every request still ends up where it did, with the same credentials, plus the edit.
- A gateway need not speak the API's context-management beta. On a 400 to a request carrying the edit, with an upstream that is not Anthropic's, the proxy reads the refusal before anything reaches the agent (`refusesEdit`, at most `REFUSAL_BODY`): a refusal that names the field or the beta header means the same request goes again as the agent wrote it and the edit is dropped for the rest of the proxy's life (`editRejected`, logged `proxy-edit-rejected`, rows then read `edit-unsupported`); any other 400 is passed on exactly as it came, once, and the edit is still added to the next request. Taking every 400 for a refusal switched the clearing off over an unrelated error and sent the failing request twice (LiteLLM 1.106.5 over a model name it did not know, 2026-10-28).
- Whether the answer spoke about the edit at all is recorded on the row (`editAcknowledged`), since a gateway that strips the field looks exactly like a request whose trigger was never met. Nothing is claimed from it yet: whether a conforming API always echoes `applied_edits` when it clears nothing is unverified.
- The refusal count judges the model calls alone (`MESSAGES_PATH`): an agent sends more than those through the proxy, and a 200 on one of the others reset the count, so three refusals in a row never arrived.

**Telemetry and tests (MANDATORY):**
- Set `THINKER_TEST=1` for tests, benchmarks, eval harnesses, scratch experiments, and their setup/install steps (`npm test` sets it).
- It blocks production telemetry and automatic background work, keeps usage logs local, silences machine-wide hooks, and suppresses coverage offers (hooks, `orient` over MCP).
- `THINKER_OFFERS=on`: restore offers, offer tests only.
- `THINKER_TELEMETRY=off`: extra telemetry-only control.
- Every child process must inherit these settings.
- Never send these runs to the production telemetry endpoint or count them as usage.
- Telemetry tests use mocked requests or isolated loopback only. Never contact production.

**Benchmark caches (MANDATORY):**
- Build only through product paths: `mine-prs` (GitHub or `--git`), or `understand` (`src/understand.js`).
- Forbidden: `seed`, synthetic agent sessions, distilling a benchmark's own eval traces, hand-written notes.
- Nothing from the task's future may be reachable:
  - Build at an anchor commit at or before the earliest task base in that repo.
  - Each task gets a copy, topped up only with changes merged before its own base.
  - Verify the fix commit is absent from the cache's build checkout.
- Record anchor commit, what was mined or read, source hashes, and model and effort of every building call; these must match the coding arm.
- Missing, failed or empty cache stops the run before coding. No fallback.
- Historical session-learning experiments are not valid caches.
- `research/performance-canary/guardrails.py` enforces this (`cacheSource: recent-merged-prs`). `research/efficiency-simple/run.py` mines only.

**Matched models (MANDATORY):**
- Compare arms only with the same exact model and reasoning effort per phase: exploration, memory building, coding, judging.
- Keep agent config fixed except the declared intervention.
- Record models before running. Disable silent provider/model fallback. Mismatch = invalid comparison.
- Prefer executable tests for correctness. Report correctness, tokens, latency separately.
- Different models or reasoning settings go in separate cohorts, never one ranking.

**Evals only through Artemis (MANDATORY):**
- Run, follow, read benchmarks only via Artemis (`~/src/artemis`; start with `bin/artemis-up`; web app and MCP server).
- Follow `.agents/skills/run-evals/SKILL.md`: `create_pr_set` (freeze PRs); `plan_cache` / `build_cache`; `plan_experiment`; user approves each plan; `start_experiment`; read with `get_experiment`, `get_session`.
- Never start the task runner (`~/src/task-runner`) or run `mine-prs` by hand.
- Never report numbers computed by hand from run files.
- Artemis and task runner use thinker only via CLI: `thinker mcp`, `hook`, `guide`, `served`, `spent`, `export --dir`, `version` (`src/commands/external.js`). Changing their output or input is an interface change: stay compatible or change Artemis in step.
- Artemis's `"thinker"` entry in `~/.artemis/config.json` is the tested build; point it at a worktree to test a branch.

**Worktrees (MANDATORY):**
- All code changes, scratch experiments and benchmark runs happen in an isolated worktree. Never edit the primary tree.
- Create: `git worktree add -b agent/<task-name> .worktrees/<task-name> HEAD` (gitignored). Work only inside it.
- On merge, push, abort or cancel: `git worktree remove --force <path>`; if unneeded, `git branch -D agent/<task-name>`.

**Model calls:**
- Anthropic SDK when `ANTHROPIC_API_KEY` is set. Otherwise first installed agent CLI: `claude`, `codex`, `gemini`, `agent`.
- `claude -p` uses a replaced system prompt (`--system-prompt`, `--setting-sources ''`, `--disable-slash-commands`; `llm.js:viaCliOnce`). Never append.

**Releases:**
- Release = GitHub release on tag `vX.Y.Z` on a `main` commit, assets `thinker.tgz`, `version.json` (version, commit, archive sha256), `install.sh`.
- `install.sh` (`npx @zerotimedev/thinker`) and `thinker update` (`src/update.js`) read `releases/latest/download/version.json`. `thinker update vX.Y.Z` pins.
- Cut: `bash scripts/release.sh X.Y.Z`. `scripts/release.mjs` tests a version-only bump in a temp worktree, opens a PR, waits for the user to merge. Never merges or pushes `main`.
- After merge: `scripts/pack.sh` packages the merged commit; runner tags, publishes release and three assets, verifies public download, publishes npm installer at same version.
- Rerun resumes from the exact tag. Never overwrite public assets or npm versions. No version = resume current `origin/main` version.
- `--hold`: GitHub pre-release and npm tag `next`. Promote: `bash scripts/release.sh X.Y.Z --promote`.
- Prerequisites, auth, `--no-wait`: `docs/releases.md`.
- Nothing uploads to zerotime.dev. `scripts/pack.sh <base url>` builds a self-hosted set.

**Layout:**

| path | contents |
|---|---|
| `src/cli.js` | entry: parsing, help, prelude, handler table |
| `src/commands/` | `notes.js`, `cache.js`, `learn.js`, `hooks.js`, `setup.js`, `telemetry.js`, `benchmark.js`, `shared.js` |
| `src/mcp.js` | MCP server: `context` and coverage answer tools, `learn_next` queue |
| `src/setup.js`, `src/setup/` | `runSetup`; `ui.js`, `agents.js`, `estimate.js`, `steps.js`, `pr-benchmark.js` |
| `src/clients.js`, `src/integrations/` | client adapters, extension handlers (`docs/agent-integrations.md`) |
| `src/transcripts.js` | transcripts, one event form |
| `src/prs.js` | PR mining |
| `src/ops.js` | serve, merge, assess, link |
| `src/deps.js` | dependencies, symbol hashing |
| `src/ast.js` | tree-sitter boundaries (default); regex fallback in `deps.js` |
| `src/disk-cache.js` | machine-wide results cache (`~/.thinker/cache`) |
| `src/codegraph.js` | call graph: `fanout`, callers, callees, `findSymbols` |
| `src/rank.js` | BM25, relevance gate, budget packing |
| `src/distill.js` | transcript to notes and assessments |
| `src/maintain.js` | background maintenance, daily cap |
| `src/skills.js`, `src/commands/skills.js` | SKILL.md cards; `thinker skills` (`docs/skills.md`) |
| `src/instruction-value.js`, `src/context-view.js`, `src/commands/context.js` | `thinker context`, Context tab |
| `src/testing.js`, `src/commands/testing.js` | `thinker test -- <command>` (off until experiment) |
| `src/guard.js` | anchoring guard |
| `src/update.js` | self and background updates |
| `src/usage.js` | usage log summary |
| `src/proxy*.js`, `src/commands/proxy.js` | context proxy; `thinker proxy on\|off\|status`; `proxy-route.js` leaves a routed harness alone; clearing results, call text and earlier thinking all on by default (2026-10-28), `--no-clear-inputs`, `--no-clear-thinking` off |
| `src/report.js`, `src/prices.js`, `src/commands/report.js` | Report page; `thinker report`; `prices.js` only place dollars appear |
| `src/store.js`, `src/llm.js` | note storage; model access |
| `src/server/` | `thinker-server`: `index.js`, `repos.js`, `auth.js`, `worker.js` |
| `infra/sync/` | EC2 server: CloudFormation, bootstrap, deploy |
| `src/change.js` | change review, no model call; `selectNotes`, `usedContext` |
| `test/` | unit tests (`node --test`) |
| `research/bench-history/` | old results (`RESULTS.md`) |
| `.thinker/` | notes about this repo |

Benchmarks are not in this repo. Artemis (`~/src/artemis`) holds task sets, PR sets, caches, runs, data. Task runner (`~/src/task-runner`) runs sessions. `bench/` in a checkout is ignored local leftovers.

## What `setup` does

The installer (`install.sh`) installs the tool wherever it is run and wires
it into the agents on this machine (`thinker connect`, below). Every git
repository on the machine has a cache from then on:
the first hook, MCP server or cache command in a checkout starts one, empty
(`store.js:init`, kept out of `git status` through `.git/info/exclude`), and it
grows from the sessions there. Nothing is built, and nothing is opt-in. **Background
learning was cut to the sessions on 2026-10-21 (the owner's decision: the cache's
background spend was not paying for itself, and few people were running it;
`d84af6795`):** the warm-up that read a repository's merged pull requests into the cache
went entirely (the command, the page's tab and its build queue, the offer the hooks and
the MCP server made, the installer's and setup's `--build`, which are accepted and
ignored), and maintenance mines no pull requests or commits, walks no area history,
reads no design documents or skill files and merges no duplicates unless the
repository's `maintain` config turns each on (`maintain.js:DEFAULTS`). What is left on
by default: the once-per-session distillation, and a maintenance run that re-verifies
at most 3 stale notes and phrases the new ones. `mine-prs` and `understand` stay,
unlisted in the help, for Artemis's benchmark caches alone. What the installer does
show at once is where the agents' context goes, read from their transcripts
(`context-machine.js`; the Context view below): on a terminal it asks whether to see what to cut first in the browser or there, where the suggestions are a multi-select of the actions the page's rows would take, applied through the same `approveChanges` (`setup/context-ask.js`, `thinker context --machine --ask`, 2026-10-22); in the browser the page opens on All with the same suggestions checked and their actions picked, once, for the person to review and Apply (`context-machine.js:suggestedPicks`, sent with `/api/context` as `suggested`; `page.html:preselectRows`; 2026-10-24). The paragraphs on the build below are
history: how it ran until then, kept because the mining code is still what Artemis
builds caches with. Outside a git repository there is nowhere to keep a cache: the CLI's cache
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

The build itself (`thinker setup --build`, or the installer with `--build`; history, see above):

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

To mine more pull requests later (for a benchmark cache: unlisted since 2026-10-21), run `thinker mine-prs` (`thinker learn
--prs` is gone). With no arguments it takes the
GitHub `origin`, mines what was merged since the last run and then goes
further back in history, 20 at a time (`--limit n`). Without GitHub, or
with `--git`, it mines commits from git history; `--fixes` keeps only those
whose message says they fix something (`prs.js:FIX_LIKE`), the records a
reviewing agent draws on most; a repository whose work lands by direct commits has
few pull requests, and this one had 8 to mine against 17 fix commits. With GitHub, mining
read merged pull requests alone, so a change pushed
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

History: the project file narrows the mining commands, which left the product on 2026-10-21; nothing a person runs
reads it now. `thinker.project.json` at the repository root stores `{version: 1, name,
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

The hit rate is quoted over the requests the cache was actually asked, not every prompt
(`usage.js:NOT_ATTEMPTED`): a prompt a cache below its serving threshold was never searched for
(`too-few-notes`) and a held-out turn whose notes were found and withheld (`held-out`) are both logged
as requests, so a machine in daily use does not read as idle, but neither is a retrieval failure. On
production telemetry over the ten days to 2026-10-28 they were 391 and 702 of 4,654 requests, which is
why `answered / requestsTotal` read 1.5% where the cache's own 3,561 attempts read 2.0%. `attempted` is
that denominator and `attemptedHitRate` the rate; `hitRate` keeps the old denominator so the series
stays comparable across the release. The remaining misses are what the levers above address:
`no-match` 1,983, `ranker-rejected` 949, `only-stale` 556.

A `late` serving (the edit hook, on a file coming into view) is not a request — the agent asked
nothing — and `ops.js:lateLocked` logs it only when it serves something, so it is counted in neither
side of the hit rate. It is counted as a delivery (`delivered`, `deliveredLate`, sent as
`retrieval.deliveries` and `editHookDeliveries`), because without that a device served notes by the
edit hook alone reported nothing served: on 2026-10-28 one device read 0 of 6 answered having been
given 3 notes, and on this machine 69 of 143 deliveries over ten days came that way.

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
model tokens). Missing counters/costs stay unknown. Since 2026-10-21 there is also
`saved.netAfterWeightedSpend`, with the same work as tokens of the agents' model
(`spending.weighted.agentTokens`; not on the page, whose four cards are tokens saved, cache hits, the share
acted on and active notes, since the saving is a lower bound and the upkeep every call), each call weighed by its model's relative rate per token
(`model-usage.js:relativeRate`, Opus 5.5 input = 1, from Anthropic's list; output 5×, cache reads a tenth or
less) over the input rate of the models the saving was made on, so a Haiku distillation counts for a
fortieth of an Opus read; a model without a rate counts one for one, and the purposes of removed features
(Jev, review, exploration; `retiredPurpose`) are left out. Ratios, never shown as money. Legacy logs lack setup exploration
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

## Staleness is a claim about the code, not about the note

A dep's hash moving means the code the note rests on changed. It is not evidence that the note is
wrong, and it was being used as if it were. Measured 2026-10-28: of the notes marked stale the
verifier answered `still_valid` on 53% across production (664 of 1,246) and 51% on this machine over
all history (321 of 627), with 6 of 664 of those passes later doubted — so the verdict is reliable and
about half of all staleness was never a real change.

The hash itself is right. Checked the same day: of 543 changed deps behind this repository's stale
notes, only 10 (under 2%) differed by comments or whitespace alone, so a hash that ignored cosmetic
edits would clear almost nothing. What changed is real code; what does not change is what the note
claims about it.

What followed from the mark was the problem:

- The hooks withhold every stale note (`freshOnly`). Still true. Serving it with its ⚠ banner instead
  is the `serveStale` lever, off until an experiment.
- A withheld note could never be verified. `maintain.js:pickStale` re-verifies the stale notes *served*
  recently, and a withheld note is never served: withheld → never served → never eligible → stale for
  good. On this repository that was 318 stale notes with **1** eligible. Being held back is now
  recorded (`ops.js:orient` sets `heldAt`, a `LOCAL_FIELDS` entry) and counts as the demand it is, so
  the same 318 fill the batch and clear in about three weeks.
- A withheld note was then deleted for not being served. `deleteUnused` now keeps a note wanted within
  the window, and the window is 30 days rather than 14.
- The backlog those three had already built up (318 of 440 notes here, 1,236 of 2,683 across
  production) was cleared in one step on upgrade, rather than left to drain through the verifier over
  weeks: the reset below.

### The one-time staleness reset

`stale-reset.js`, run once per repository by `thinker rewire` after an update, beside
`retire-background.js`. Every note marked stale is re-baselined: its deps re-hashed against the
working tree and the `stale` block dropped, which is exactly what a `still_valid` verdict does to the
record (`ops.js:verifyNote`). Setting the status alone would change nothing, since the next `refresh`
re-derives staleness from the stored hashes.

Statuses are brought up to date first (`refresh`, as `thinker check` does), because staleness is
worked out when a note is checked, not when the code changes: a cache holds notes that are stale and
not yet marked, and clearing only the marked ones would leave those to go stale on the next prompt.
On this repository 324 notes were marked stale on disk and 325 would clear.

It does not touch `confidence` and does not set `verified`: no model looked at these notes, and a
reset is not a verification. It records `rebaselined` (a `LOCAL_FIELDS` entry) so the notes it waved
through stay identifiable. `invalid` notes, a `violated` behavior and a `broken` skill card are left
alone; only `stale` is cleared. `RESET_VERSION` guards it per repository, and the marker file keeps the
prior record of every note it touched, so `undoStaleReset` can put them back.

**What it costs.** About half of the cleared notes were going to come back `update` or `invalid`
(53% `still_valid` across production, 51% here), and they are now served without the ⚠ STALE banner
that warned the agent. The trade: a withheld note helps nobody, and a wrong one is caught again the
next time its code changes. Owner's decision, 2026-10-28.

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
2. **Human**: `thinker add note.json`, or asking the agent in a session to
   remember something, which the distiller then keeps. The `remember` MCP tool,
   for an agent to save a note itself, was removed on 2026-10-21: no guidance
   asked for it after 2026-10-08, and the 16 notes it saved here were confirmed
   5 times in all, 11 of them stale or invalid, against what the distillation
   of the same session writes anyway.

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
   served in 30 days (14 until 2026-10-28), made longer ago than that, is deleted (`maintain.js:deleteUnused`,
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
   the last 14 days (`verifyServedDays`; 0: all), or held back from a request that recently wanted
   them (`heldAt`), the most served first; a
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

## Report

**Tabs and entry**
- Tabs: Find Savings (`--tab save`), View Report (`--tab report`). Old `tab=context|changes|cache` open replacement view.
- CLI only: `thinker list`, `show`, `archive`, `system`. Removed: `/api/usage`, `/api/cache`, `/api/behaviors`.
- `thinker ui` opens `repo=all`; `--here` opens `repo=here`; `--all` accepted.
- Page reads `repo=` (`page.html:hashRepo`). Link naming a repo id wins (`context-suggest.js:suggestionsUrl`).

**Report (`thinker report`, `report.js:reportView`)**
- Weeks: last `REPORT_WEEKS` (6), Monday–Sunday, current last.
- Unit: prompt (one model call). Week tokens over its prompts (`transcripts.js` `turns`, kept as `prompts` on cells/columns).
- `--total`: week sum. Default: per prompt.
- Per-prompt cell = ratio of sums, never mean of session means.
- Per session:
  - Model/usage: `transcripts.js:Stats`, `tool-outputs.js:sessionUsage`, state `.thinker/state/tool-outputs.json` (v8).
  - Parts joined by session id: instruction files, custom tools (skills, MCP, plugins), built-in tools. Each × session model calls. Tool outputs re-read by later calls.
  - Transcript (`transcripts.js:parseClaude`, `carried`, Claude Code only, v10): system prompt per call; tool inputs, thinking, prompts, agent text, attachments. Re-read by later calls since last compaction.
  - Thinking: `thinking_tokens`, else signature length ÷ 4.3. Kept (`clear_thinking keep: all`).
  - `instructions` attachment, when present, is exact (replaces estimate).
- Scaling: parts scaled down where sum exceeds measured input. Remainder = "Other input". Output = model output. Total = session tokens.

**Find Savings: one cost rule, per prompt (2026-10-25, the owner's ask)**
- A part sits in the prompt, so it costs its size in every model call that carries it. The table's four numbers are four readings of that, each with a **?** under forty words (the owner: if it needs more, the calculation is wrong).
- **Per prompt** (`tokens`): its size, what it adds to every prompt that carries it. **Needed** (`usedShare`): of those prompts, the share the agent acted on it in. **Over N days** (`window`): per prompt × every prompt that carried it (`prompts`). **Wasted** (`wastedWindow`; `wasted` a prompt): window × (1 − needed). The savings card leads with the window figure. `perPrompt` (window ÷ every prompt of the window) stays in the data for the tab strip, the totals and `wasteLevel`, not in the table.
- Needed is by prompts, not sessions (the owner's ask the same day; until then `used / loaded` sessions, and a judge's session verdicts for sections). Each transcript tool event carries `turn`, the model call it was made in (`transcripts.js`, Claude Code and Codex). A tool or skill: the calls that called it, `harness.js:readSessionHarness` `usedCalls` and `harness-codex.js` (a typed `/skill` or `$skill` is one), summed as `usedPrompts` capped at the session's calls; Cursor one a session. A section: the calls that fired its triggers, `instruction-value.js:appliedTurns`, over the calls of the sessions that read it since its last change (`promptsSince`; `use()` takes `prompts` and `appliedPrompts`); the judge's verdicts stay as the section's value (`valueOf`), not in the share. An output: the re-reads before the agent last used it, `tool-outputs.js` `needed` = (input − unneeded) / input. `session-harness` and `session-activity` disk caches are v2 for it.
- Real calls, not a median: `prompts` on every source is the sum of its sessions' model calls; `contextView` `viewPrompts` is the window's. A section changed inside the window costs its present size in every call that read its file; the change governs what its use is measured over, nothing else.
- All repositories merges an output row by tool, setting **and** whether that setting is the repository's current one (`mergeViews`, `outKey`): a row measured under an earlier setting is a dead period, never merged with a repository where the same setting is live. Grouping on name and level alone, past only where every repository said so, made the month before `mcp:artemis` was compressed here into a live row and the machine's top output suggestion (33M, action `uncompress`) — fixed 2026-10-26.
- A live merged row's `compression` is its own level, so the action offered and the saving beside it are the same thing in every repository it covers. An output row carries no repository: the page applies one to every repository (`page.html`).
- All repositories sums `usedPrompts`, `prompts` and `window` (`mergeViews`), never weights one repository's figure by another's sessions. `context-machine.js` and `context-suggest.js` say "needed in N% of prompts"; `SUGGEST.minSaving` is 15 a prompt (500 a session before).
- A change's `total` is the row's own window figure, never recomputed (`partChanges` carries `windowSaving`: `wastedWindow`, an output's `saveModerateWindow`). Recomputing it as `saving × prompts` divided by the window's prompts and multiplied by the part's: right only for a part every prompt carries, 0.55× for Artifact here (2026-10-26). A report without the figure falls back to the old reckoning.
- The weekly message leads per prompt, the window total beside it (`contextSuggestOffer`): a week of a 25k-token file over 7,600 calls is ~190M, true and unplaceable.
- Until then every figure was tokens × the *median* calls of a session, which weighed every session alike and mixed two denominators (a section was averaged over the sessions that read its file, a tool was not).

**Tables** (each ends on `sessionTotals`; all three sum to same figure)
1. Parts (`report.js:PARTS`): instruction files, custom tools, built-in tools, tool outputs; then **Other input** row (`otherInput`, folded, kinds via `OTHERS`); then output.
2. Models (`prices.js:providerOf`): grouped by provider; provider subtotal folds models. Each model over every prompt of week.
3. Token types (`report.js:TOKEN_TYPES`): fresh input, cache writes, cache reads, output (`transcripts.js:Stats`). Clamp cache reads/writes exceeding input.

**Toggles**
- `--share`: Values/Share (row ÷ week total, `formatShare`); whole-session total keeps value.
- `--total`: Per session/Total.
- Cost (list prices) is the default view on both doors (2026-10-26). `--tokens` / the page's Tokens: tokens instead, no bounds. `--cost` still accepted, no-op.

**Colour (parts table, cost view only)**
- Every row of the parts table (four parts, Other input and each kind, output, total) coloured by dollars per priced prompt vs `report.js:COST_THRESHOLDS`: green ≤ good, red ≥ bad, yellow between.
- Four parts: the old token bounds (12k/30k, 4k/15k, 22k/36k, 30k/72k) at ~$0.8/M input. Other rows set on this machine's two weeks to 2026-10-26; total = sum of the rows. First cut, one machine.
- Good/Bad columns beside each row. Verdict uses cost per priced prompt regardless of displayed cell (Total, Share).
- Token view: no bounds, columns or colour (owner's call 2026-10-26: models count tokens too differently; `THRESHOLDS` removed).
- No colour in the model and token-type tables. No percentage in cell; zero cell blank.
- Command prints same columns, marks ✓ · ✗.

**Sessions without usage**
- Agents with no usage report (Cursor): excluded from all columns, named as left out. Estimated parts shown only as `estimated`.

**Calibration (`report.js:CALIBRATION`, `calibrationOf`)**
- Estimates count chars/4; scaled before overshoot check: Anthropic 1.44, OpenAI and Google 1.
- Override: `calibration: {Provider: f}` in `.thinker/config.json`. Thinking not scaled. Caption names factors.

**Cache rewrites**
- `transcripts.js:cacheRewrites` names each call's cause from per-call usage.
- Causes: first call of session/subagent; after compaction; after >1h pause; after 5–60 min pause at 5m TTL; after model change; mid-conversation, no pause.
- Stored `tool-outputs.js` (v12); in view and `--json` as `rewrites`, `rewriteTotals`. Not shown on pages or print.

**Cost (default view, only place dollars appear)**
- Per session, list rates (`prices.js:listPrice`): fresh input, cache reads, cache writes, output.
- Cache writes by TTL (`prices.js:writeCost`): 1h = 2× input, 5m = 1.25×. Split from `Stats` `cacheWrite1hTokens` (v13).
- Anthropic: `model-usage.js:relativeRate` at Opus 5.5 input price. OpenAI/Google: `PRICED_ON`.
- `prices` in `.thinker/config.json` adds/overrides.
- Part cost = its share of session input cost.
- Labelled list price (metered key), not subscription.
- Unpriced model: left out of average, named, never zero.

**Decisions (not on Report)**
- Shown on Recent activity and `thinker context --history`. Columns Before, After, Saved (`report.js:actionEffect`, `itemCost`; `report-snapshot.js:historyEffects`).
- Window (`effectSpan`): until revert; merged PR from merge; until later decision on same thing.
- Costs per prompt, each side = sum over sessions ÷ their prompts:
  - Section: `context-suggest.js:sectionTokens` (0 after removal), sessions reading file.
  - Skill, MCP, plugin, built-in tool: per call in sessions loading it (`harness.js` `loaded`).
  - Tool output: `tool-outputs.js:sessionUsage` `by`; compressed key carries level.
- Saved: positive = saving, negative = cost. Share of `whole.before`. Cell shading green/red (`page.html` `shadeOf`); never coloured text.
- Caption row: prompt average (`report.js:promptAverage`, `promptAverageHere`; merged for All). `--history` prints same line first.
- No text under table; hovers explain. PR column links PR.
- `sessionRows` per measured session; not sent to page.
- Rows lent only from report this code made (`report-snapshot.js:keptRows`). Otherwise `/api/activity` returns `measuring: true`, starts background refresh; page checks every 5 s (`page.html:activityCheckBack`). `thinker context --history` says run `thinker report --refresh`.
- Cache metrics (`report.js:cacheMetrics`, `usage.js:summarize`): dollars saved first, then tokens saved, cache hits, share acted on.
- All repos = `mergeReports`.
- Output compression: `report.js:outputComparison`; tool row vs prior row (`tool-outputs.js:aggregateOutputs`). Saving green first, cost red. Same two lines under action in `thinker report`.

**Performance and kept report**
- Page never recomputes on visit.
- Kept report: `.thinker/state/report.json`, all windows under `views`. One per repo, shared by worktrees.
- `thinker report` and `--refresh` write it. Page starts `thinker report --refresh --all` in background when older than `REFRESH_MS` (10 min) or made by other code; shows "measured n min ago, updating…".
- Decisions under tables read live (`report.js:reportActions`).
- Save page: outgrown kept report shown at once, remade behind (`context-snapshot.js:lastSnapshot`). Transcripts read on visit only if no kept report or action dropped it.
- Background refreshes run one at a time (`ui/server.js:serialSpawner`).
- Note counting: `store.js:count`, no file reads. `store.js:assertSafeNotesPath` rechecked only when `.thinker` or `.thinker/local` mtime changes.
- `usage.js:parse` caches machine log per process (size, mtime). `transcripts.js:sessionModel` cached in `disk-cache.js`.
- Instruction sections read transcript once (`instruction-value.js:sessionRecord`), kept in `disk-cache.js` as `session-activity` (no output).
- Re-read only if transcript grew or sections name new code (`coversCode`).

**Page updates (`page.html:swapBody`)**
- Refreshes keep shown table on screen, swap in new one. Keep scroll, See more rows (`data-dk`), dropdown picks. Body keeps height.
- Save header shows `updating…` in `#c-asof` (fixed-height line).
- After Apply: show change at once (`patchContext`), re-read decisions, then report.
- Overtaken loads render nothing. In-place refresh error = toast, table stays.
- Spinner only on first read of tab and on repo/window change.
- `loadContext`, `loadActivity`, `loadReport` must not wipe body to "Reading…".

**Section change is a pull request**
- Diff opens in modal (`page.html:previewSections`, `openEditModal`). Button:
  - commits to new branch from default branch via temporary index (checkout untouched);
  - pushes;
  - opens PR with `gh` (`instruction-pr.js:openEditPr`).
- `prAvailable` decides (no GitHub origin, no `gh`, not logged in). If not, page offers working-tree write with reason.
- Preview from base branch text (`instruction-pr.js:baseTexts`; `runSectionJob`, `thinker instructions --pr`). Parent = commit preview read from. Checkout branch, uncommitted edits, distance behind origin do not matter.
- Preview keeps old/new (`instruction-edit.js:previewEdit`, `edits`). Applied to base file where differs (`textOnBase`); refused if section not found. `textOnBase` ignores blank-line differences.
- History records `pull request` with `pr` {number, url, branch, state} (`context-suggest.js:applyReviewed`).
- PR state refreshed on each `/api/activity` read and `thinker context --history` (`refreshPrStates`, ≤1/min).
- States:
  - **PR pending**: open; row pill linked, not pickable.
  - **Merged**.
  - **Rejected**: closed unmerged; re-suggested (`currentChanges`).
  - **Unpulled** (`changeHistory`): merged, not in checkout. Test: merge commit (`pr.mergeCommit`) not ancestor of `HEAD`; without commit, removed section still in file. No row on page. Recent activity shows yellow pull banner (`pullFrom`: PR base, else `instruction-pr.js:defaultBranch`), tints waiting decisions. `thinker context --history` prints same. Cleared when `pr.pulledAt` kept.
- **Close PR** = revert (`revertDecision`, `instruction-pr.js:closePr`): comment, close, delete branch.
- Command: `thinker instructions --compress <id> --pr`.

**Background job**
- Apply records decision at once: shared `group`, `job: {state: running, pid, startedAt}` (`context-suggest.js:startSectionJob`, `/api/changes/start`).
- Detached: `thinker instructions --compress|--remove <ids> --pr --job <group>`. Uses `--apply` where no PR (`instruction-pr.js:prAvailable`).
- Page toast says where to follow.
- `runSectionJob`: preview, then PR (recorded on every group entry, pending until merged) or working tree (files kept under group for Revert). Failure: `job.state: failed` plus reason.
- Running job with dead process, or no record after 2 min: failed on next history read (`changeHistory`, `jobDied`).
- Failed job decided nothing: re-suggested.
- **Retry** (`retryJob`, `/api/changes/retry`, `thinker context --retry <n>`) reruns over every section of change.
- Diff: in PR, or `git diff`.
- Save rows: under way shows *Compressing…*, not pickable; failed shows so, pickable.
- Save's History view removed. Decisions on third tab **Recent activity** (`#tab-activity`, `/api/activity`: history only, one repo or all; `thinker context --history` same states).
  - Top card: what needs the person.
  - Rows: Retry, Close PR, or Revert.
  - Tab badge counts incomplete items across repos (`changeHistory` `attention`: job running/failed, PR open).
  - Polls every 30 s, every 5 s while job runs (`page.html:pollActivity`).
- Report's decisions table uses `historyFigure`.
- Row kind line: `Built-in tool`, `Custom tool · MCP server`, `Custom tool · skill`, or output by tool. Second line: what it does (`part-describe.js`).
- Stored as `what`, `about` (`changeHistory` derives for older entries). `--history` prints after title.
- No See more or detail row. Pill hover explains outcome; decided cell hover shows time, action, worth.

**Changed sections are new sections**
- Sections carry last change date (`instruction-value.js:sectionAges`, `git blame -w`; uncommitted = file write time; cached by text and HEAD; `changedAtOf` = newest line, blanks ignored).
- Section changed in window (`recent`) measured only over sessions since change (`applied`, judge verdicts). Under `RARE.minSessions` → unknown: no pill, not suggested.
- Cost: present size × share of sessions reading file; over window, only sessions since change (`sessionsSince`, Over N days, savings `window`).
- Row says `changed <date>` and sessions measured. `thinker context` prints same.
- Hand edits count: a line fixed resets measurement.
- Failed change: row keeps waste pill and actions; Recent activity shows failure and Retry.

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
`distillKinds`, `saveNotes`) or written by an agent. See docs/skills.md.

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

**Built-in tools in the harness advice (off until an experiment, 2026-10-20).** With `harness: { builtinTools: true }`
in `.thinker/config.json` (or `THINKER_HARNESS_BUILTIN_TOOLS=on`; `=off` wins over the config), the harness counts
Claude Code's own tools as sources beside plugins, skills and MCP servers: their definitions from the transcript's
`prompt_snapshot` attachment, a call by name as a use (`harness.js:sessionHarness`, `builtinKey`). One called in under
a tenth of the sessions is advised like any source (`thinker harness`, the Context tab's Built-in tools, where a row
shows the tool's own description) and goes off as a bare name in `permissions.deny` of
`.claude/settings.local.json`; `--undo` takes it out. It was never an option of the harness's own in-prompt question
(2026-10-22, the owner's call: a picker's line has no room for what denying a tool costs, no subagents or no
`/loop`, and the question offered eight tools by their token counts alone), and since that question was merged
away (below) it is a Find Savings row like any other, bold and behind a confirmation. Checked with `claude -p` 2.1.304 (2026-10-20): `permissions.deny`
and `--disallowedTools` both take the definition out of the prompt, Workflow, ScheduleWakeup and ReportFindings
together ~4k tokens a call. Never offered (`CORE_TOOLS`): the file and shell tools, Skill, AskUserQuestion (the question goes through it), and
ToolSearch, whose absence puts every deferred definition inline (+29k tokens a call); an allow-list (`--tools`) does the same, so the switch
is a deny list. Why: on this machine's sessions (Artemis Tokens page, waste view) Artifact (15k tokens) was called in
1 of 65 sessions that carried it, Workflow in 0 of 535. Not known: whether the desktop app's own tools (Artifact,
SendFeedback, absent from `-p`) obey the deny list.

**The funnel, end to end (2026-10-26).** Every decision records the door it came through (`context-suggest.js:VIA`,
on the log line and the history entry): `session` (the weekly suggestion answered in the conversation it was passed on
in — the command the offer text tells the agent to run carries `--via session`), `page` (Find Savings), `setup` (the
install's multi-select), `command` (typed; also every decision from a client before 0.2.11). Telemetry counts
`offeredChanges` (what a summary actually put in a prompt, the denominator of the share accepted — a ranked row nobody
saw is not an offer), `offeredPerPrompt`, and `approvedBy` / `dismissedBy` by door (`spendMetrics`); `suggestedTokens` and `offeredTokens`
from before this carry the old `total`, so they are not comparable across the release; the dashboard reads
them in "Suggested, offered and decided", "Where a change was accepted" and "Changes dismissed, by door"
(`scripts/spend-dashboard.mjs`). Those cards count changes, so one machine deciding many times reads as uptake:
the band opens with three cards that count machines at the same stages instead ("Devices shown a suggestion,
and devices that took one", by day, and by device), the per-day one taking the newest report per installation
so a device identifier that changed between uploads is still one machine. What is still not measured: whether the agent passed the summary on at all — the
message asks it to relay in its own words and nothing records that it did, so an offered change may never have reached
the person.

**One suggestion, not three (2026-10-25, the owner's call).** What thinker puts to the person in their session is
the weekly context suggestion alone (`context-suggest.js:contextSuggestOffer`, `maintain.contextSuggest`, at most
every `SUGGEST.everyDays` = 7 days once the repository has 10 sessions to read): a short message, one line per
change with what it costs and the suggested action, and a link to Find Savings, where every part of the context is
a row. It already ranked instruction sections, skills, MCP servers, plugins, built-in tools and tool outputs
against each other by tokens saved, which is why the other two prompt questions went:
- the harness question (`harness.js:scheduleHarnessSuggestion`, `harnessOffer`, `answerHarness`, the MCP `harness`
  tool, `thinker harness --suggest/--answer/--recurring/--suggestions`, the machine's `harness-never`, the
  `/api/harness/suggest` endpoint, the small-skill bundle) was removed on 2026-10-25: a second suggestion of a
  subset of the same sources, through each agent's picker, which could not explain a section diff and never
  carried built-in tools. What stays is the advice behind the rows (`harnessAdvice`), switching off
  (`switchOffNow`, which now applies the chosen labels itself), `undoHarness`, the recall line and the report;
- the coverage question (`coverage.js`) stays off by default (`maintain.coverage`, false since it shipped) and was
  held there the same day: it was not effective enough to put to people. It is the only question the hooks can
  still emit, and only where a repository turns it on.
A new thing worth suggesting is a row and a line of the weekly message, not a question of its own.

It is a question the agent must put to the person, through its own question tool (2026-10-27, the owner's ask;
`QUESTION_TOOLS` by client, in chat where there is none and for Codex, as `coverage.js` does). Until then it was prose
the agent was asked to relay, and the three devices shown one decided nothing at all: a relayed message can be skipped
by the agent, skimmed by the person, and leaves no answer either way, so nothing told "not interested" from "never
reached them". The answer comes back through thinker's own MCP tool, `context` (`answerContextSuggestion`, registered while
`contextSuggestAwaiting`, as the harness question's tool was until 2026-10-25 and the coverage tool still is): the
agent hands in the numbers the person chose and thinker resolves them against the list it showed and makes the
changes, so nothing depends on the agent composing a command line, and a desktop app answers the same way. The
command (`--via session --approve|--dismiss all`) is the fallback where the client speaks no MCP, and the typed door.
Both answers are recorded: numbers approve, none dismisses for a month, and `context-answer` keeps whether they
answered through their agent's question tool or in chat (`actions.answers` in telemetry), so the funnel has a
denominator, a no, and evidence the question was put as one. Built-in tools are named with the page link and never offered as options
(the rule of 2026-10-22, PR #441: a picker's line has no room for what denying one costs), and with nothing else to
ask about the block is the page link alone. The accept path is that answer (`thinker context --days 7 --via session
--approve 1,3`) or a row on Find Savings. A reply's numbers are the lines the summary showed, kept as `offered` in
`<cache>/state/context-suggest.json` for `SUGGEST.answerDays` and read by `offeredChanges`; `--via session` is what
says so. Resolved against a list recomputed at reply time, as until 2026-10-27, "1" applied whatever ranked first
then — every session of the window moves each part's cost a prompt, and three sections within 3k tokens reordered on
one more session, so approving the first line compressed the third. Without `--via session` the numbers are the five
the command has just printed, which is what someone typing it is looking at; a key names a change either way
(`pickChanges`). The page sends keys, never numbers.

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
  acted on first). A build's drafts, and behaviors agents saved with the
  `remember` tool before it was removed, are listed as *proposed* until
  `thinker system accept <id>`. Distillation and PR mining are not offered the kind
  (`distill.js:distillSpec`, `prs.js`), archiving never takes one
  (`ops.js:archiveReason`).
- **Build proposals** (history: the build ran until 2026-10-21). `thinker setup --build` drafted up to twelve
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

- Three more doors to the same hooks (2026-10-22; docs/agent-integrations.md, "Plugins, the pi package and
  the proxy"): host plugins for Claude Code, Codex and Cursor under `plugins/`, each a shim running the
  installed copy's `thinker hook … --plugin`, which yields where the host's settings already run the hooks
  (`clients.js:pluginYields`), with a marketplace file per host at the repository root; the pi package
  (`npm/pi/thinker.js` in `@zerotimedev/thinker`), a pointer to the installed copy that yields to
  `connect`'s extension; and `thinker proxy --notes` (`proxy-notes.js`), the notes in the last user turn of
  an Anthropic or OpenAI chat request for an agent with no prompt hook (Goose, Aider), replayed at the same
  turn on every later request of the conversation so the prompt cache holds, off until an experiment.
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
  also correct notes with the `feedback` tool.

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
  agent can call `orient` at the start. In the
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
